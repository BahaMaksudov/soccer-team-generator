import { z } from "zod";
import { assertCapacity, TRIAL_DAYS } from "@/lib/entitlements";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SPORTS, SPORT_KEYS } from "@/lib/sports";
import { requireRole, type OrganizationContext } from "@/lib/tenantContext";

/**
 * M5 — self-service workspace creation: Organization + the creator's
 * OWNER membership + first Group + its initial GroupSetting, in ONE
 * transaction (no half-created Organization if any step fails). Used by
 * both first-time onboarding and "Create organization" for Users who
 * already belong to other Organizations.
 *
 * The owner is always the authenticated session User passed in by the
 * caller — never a client-supplied user id.
 *
 * Duplicate protection (refresh, double-submit, retry after a lost
 * response): each User's creations are serialized with a transaction-
 * scoped advisory lock, and an identical request (same Organization +
 * Group name) repeated by the same OWNER within REPLAY_WINDOW_MS returns
 * the workspace it already created instead of a second copy.
 *
 * Slugs: generated server-side; the database's unique constraint is the
 * final authority — a concurrent collision is retried with the next
 * free suffix (name, name-2, name-3, …).
 */

/** M7 — every sport in the registry (src/lib/sports); arbitrary strings are rejected. */
export const SUPPORTED_SPORTS = SPORTS.map((s) => ({ key: s.key, label: s.label }));
export const DEFAULT_TIMEZONE = "America/New_York";
const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const MAX_SLUG_ATTEMPTS = 5;
const SLUG_MAX_LENGTH = 48;
const TEAM_NAME_KEY = "teamName";

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}


export const createWorkspaceSchema = z.object({
  organizationName: z.string().trim().min(2, "Organization name is required.").max(80, "Organization name is too long."),
  groupName: z.string().trim().min(1, "Group name is required.").max(80, "Group name is too long."),
  sportKey: z.enum(SPORT_KEYS),
  timezone: z.string().trim().refine(isValidTimeZone, "Choose a valid timezone."),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

/** "Boston Pickup Soccer" → "boston-pickup-soccer". Never empty. */
export function slugify(name: string, fallback = "workspace"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** First free slug among base, base-2, base-3, … given the slugs already taken. */
export function nextAvailableSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type CreatedWorkspace = {
  organization: { id: string; name: string; slug: string };
  group: { id: string; name: string; slug: string };
  href: string;
  replayed: boolean;
};

const workspaceHref = (orgSlug: string, groupSlug: string) =>
  `/admin/o/${encodeURIComponent(orgSlug)}/g/${encodeURIComponent(groupSlug)}`;

const isSlugCollision = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  e.code === "P2002" &&
  JSON.stringify(e.meta?.target ?? "").includes("slug");

export async function createOrganizationWorkspace(
  ownerUserId: string,
  input: CreateWorkspaceInput,
  now: Date = new Date()
): Promise<CreatedWorkspace> {
  const baseSlug = slugify(input.organizationName, "organization");
  const groupSlug = slugify(input.groupName, "group");

  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Serialize this User's workspace creations (released at COMMIT/ROLLBACK).
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"workspace:" + ownerUserId}))`;

        const recent = await tx.organization.findFirst({
          where: {
            name: input.organizationName,
            createdAt: { gt: new Date(now.getTime() - REPLAY_WINDOW_MS) },
            memberships: { some: { userId: ownerUserId, role: "OWNER" } },
            groups: { some: { name: input.groupName } },
          },
          select: { id: true, name: true, slug: true, groups: { where: { name: input.groupName }, select: { id: true, name: true, slug: true }, take: 1 } },
          orderBy: { createdAt: "desc" },
        });
        if (recent && recent.groups.length === 1) {
          const g = recent.groups[0];
          return {
            organization: { id: recent.id, name: recent.name, slug: recent.slug },
            group: g,
            href: workspaceHref(recent.slug, g.slug),
            replayed: true,
          };
        }

        const taken = await tx.organization.findMany({
          where: { slug: { startsWith: baseSlug } },
          select: { slug: true },
        });
        const slug = nextAvailableSlug(baseSlug, taken.map((t) => t.slug));

        const organization = await tx.organization.create({
          data: { name: input.organizationName, slug },
          select: { id: true, name: true, slug: true },
        });
        await tx.organizationMembership.create({
          data: { userId: ownerUserId, organizationId: organization.id, role: "OWNER" },
        });
        // M11.1 — the introductory Pro trial: once per verified User, claimed atomically
        // (conditional update; concurrent creations are also serialized by the lock above).
        const claimed = await tx.user.updateMany({ where: { id: ownerUserId, trialUsedAt: null, emailVerifiedAt: { not: null } }, data: { trialUsedAt: now } });
        if (claimed.count === 1) {
          const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
          await tx.organization.update({ where: { id: organization.id }, data: { trialStartedAt: now, trialEndsAt } });
          await tx.entitlementEvent.create({
            data: { organizationId: organization.id, action: "TRIAL_STARTED", fromPlan: "FREE", toPlan: "FREE", trialEndsAt, reason: `Introductory ${TRIAL_DAYS}-day Pro trial (first Organization of this User).`, actor: `user:${ownerUserId}` },
          });
        }
        const group = await tx.group.create({
          data: {
            organizationId: organization.id,
            name: input.groupName,
            slug: groupSlug,
            sportKey: input.sportKey,
            timezone: input.timezone,
            // M6-A: privacy-conscious default — players view via a share link.
            visibility: "LINK",
          },
          select: { id: true, name: true, slug: true },
        });
        // Public header/branding reads this Group's own teamName; start
        // it as the Organization name (editable later in Settings).
        await tx.groupSetting.create({
          data: { groupId: group.id, key: TEAM_NAME_KEY, value: organization.name },
        });

        return { organization, group, href: workspaceHref(organization.slug, group.slug), replayed: false };
      });
    } catch (e) {
      if (isSlugCollision(e) && attempt < MAX_SLUG_ATTEMPTS) continue;
      throw e;
    }
  }
}

// ---------------------------------------------------------------
// M7 — Add Group to an existing Organization
// ---------------------------------------------------------------

/**
 * Group name, sport and timezone only. The Organization comes from the
 * URL-resolved OrganizationContext; any organizationId/groupId/slug in
 * the body is stripped. The sport must be a registry key and can never
 * be changed afterwards (there is no update path for Group.sportKey).
 */
export const createGroupSchema = z.object({
  groupName: z.string().trim().min(1, "Group name is required.").max(80, "Group name is too long."),
  sportKey: z.enum(SPORT_KEYS),
  timezone: z.string().trim().refine(isValidTimeZone, "Choose a valid timezone."),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export type CreatedGroup = {
  group: { id: string; name: string; slug: string; sportKey: string };
  href: string;
  replayed: boolean;
};

/** OWNER/ADMIN of the Organization (same managers as Players/claims/Telegram identity). */
export const GROUP_CREATOR_ROLES = ["OWNER", "ADMIN"] as const;

/**
 * Creates a Group (+ its initial teamName GroupSetting, as onboarding
 * does) inside the context's Organization. Serialized per Organization;
 * an identical request (same name and sport) within REPLAY_WINDOW_MS
 * returns the Group it already created (refresh/double-submit). Slugs are
 * unique per Organization: name, name-2, … with the DB constraint as the
 * final authority.
 */
export async function createGroupInOrganization(
  context: OrganizationContext,
  input: CreateGroupInput,
  now: Date = new Date()
): Promise<CreatedGroup> {
  requireRole(context, [...GROUP_CREATOR_ROLES]);
  const organizationId = context.organization.id;
  const baseSlug = slugify(input.groupName, "group");

  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"group-create:" + organizationId}))`;

        const recent = await tx.group.findFirst({
          where: {
            organizationId,
            name: input.groupName,
            sportKey: input.sportKey,
            createdAt: { gt: new Date(now.getTime() - REPLAY_WINDOW_MS) },
          },
          select: { id: true, name: true, slug: true, sportKey: true },
          orderBy: { createdAt: "desc" },
        });
        if (recent) {
          return { group: recent, href: workspaceHref(context.organization.slug, recent.slug), replayed: true };
        }

        // M11.1 — plan limit on active Groups (same transaction; Organization-locked).
        await assertCapacity(tx, organizationId, "activeGroups", now);
        const taken = await tx.group.findMany({
          where: { organizationId, slug: { startsWith: baseSlug } },
          select: { slug: true },
        });
        const group = await tx.group.create({
          data: {
            organizationId,
            name: input.groupName,
            slug: nextAvailableSlug(baseSlug, taken.map((t) => t.slug)),
            sportKey: input.sportKey,
            timezone: input.timezone,
            // Same privacy-conscious default as onboarding.
            visibility: "LINK",
          },
          select: { id: true, name: true, slug: true, sportKey: true },
        });
        await tx.groupSetting.create({
          data: { groupId: group.id, key: TEAM_NAME_KEY, value: context.organization.name },
        });
        return { group, href: workspaceHref(context.organization.slug, group.slug), replayed: false };
      });
    } catch (e) {
      if (isSlugCollision(e) && attempt < MAX_SLUG_ATTEMPTS) continue;
      throw e;
    }
  }
}
