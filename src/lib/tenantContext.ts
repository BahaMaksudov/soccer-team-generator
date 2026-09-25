/**
 * Phase 2D.1 — canonical tenant-context foundation.
 *
 * This module is the one place server code resolves "who is logged in,
 * and which Organization/Group may they operate on." It does not
 * change authentication (still env-based Credentials login, see
 * src/lib/authOptions.ts) and it is not wired into any existing route
 * yet — this phase only establishes the primitive.
 *
 * Not marked with the `server-only` package on purpose: that package's
 * client/server split relies on Next.js's webpack export-condition
 * resolution, which plain Vitest/Node does not apply — importing it
 * here would risk breaking `resolveTenantContextForEmail`'s unit
 * tests without extra test-runner configuration. This module is
 * already unusable from a "use client" file regardless, since it
 * imports Prisma and next-auth's server APIs, neither of which can be
 * bundled for the browser — Next.js's build fails loudly on that
 * mistake with or without the `server-only` marker.
 *
 * Testability boundary (Section 15): session acquisition
 * (getServerSession) is kept to the single small function
 * `requireTenantContext()`. All the actual resolution logic lives in
 * `resolveTenantContextForEmail()`, which takes a plain email string
 * and a minimal data-source interface — no NextAuth, no global Prisma
 * singleton — so it's directly unit-testable with fixtures.
 */

import { getServerSession } from "next-auth";
import type { OrgRole } from "@prisma/client";
import { authOptions } from "@/lib/authOptions";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------

/** Safe, minimal DTO — never includes passwordHash or any other
 * sensitive/internal field. Built field-by-field (allow-list), never
 * by spreading a raw Prisma row, so a future schema field added to
 * User/Organization/Group can never leak through here by accident. */
export type TenantContext = {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  membership: {
    id: string;
    role: OrgRole;
  };
  groups: Array<{
    id: string;
    name: string;
    slug: string;
    sportKey: string;
    timezone: string;
  }>;
  activeGroup: {
    id: string;
    name: string;
    slug: string;
    sportKey: string;
    timezone: string;
  };
};

export type TenantContextErrorCode =
  | "UNAUTHENTICATED"
  | "USER_NOT_FOUND"
  | "NO_ORGANIZATION_MEMBERSHIP"
  | "MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION"
  | "NO_GROUP"
  | "MULTIPLE_GROUPS_REQUIRE_SELECTION"
  | "INSUFFICIENT_ROLE";

/**
 * Deterministic, typed failure for every way tenant resolution can
 * fail closed. Never carries database internals in its message —
 * safe to log, safe to summarize to a client (never expose `.message`
 * verbatim to an end user; map `.code` to an HTTP status instead, see
 * tenantContextErrorStatus()).
 */
export class TenantContextError extends Error {
  readonly code: TenantContextErrorCode;
  constructor(code: TenantContextErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TenantContextError";
    this.code = code;
  }
}

/**
 * Maps a TenantContextError code to the HTTP status a future route
 * should respond with. Not applied to any route in this phase —
 * provided so Phase 2D.2+ has a single, consistent mapping to reuse
 * instead of each route inventing its own.
 */
export function tenantContextErrorStatus(code: TenantContextErrorCode): 401 | 403 | 409 {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "USER_NOT_FOUND":
    case "NO_ORGANIZATION_MEMBERSHIP":
    case "INSUFFICIENT_ROLE":
      return 403;
    case "MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION":
    case "NO_GROUP":
    case "MULTIPLE_GROUPS_REQUIRE_SELECTION":
      return 409;
  }
}

// ---------------------------------------------------------------
// Testable data-source contract
// ---------------------------------------------------------------

type MembershipWithOrgAndGroups = {
  id: string;
  role: OrgRole;
  organization: {
    id: string;
    name: string;
    slug: string;
    groups: Array<{
      id: string;
      name: string;
      slug: string;
      sportKey: string;
      timezone: string;
      isActive: boolean;
    }>;
  };
};

/**
 * The minimal slice of Prisma this resolver needs. Real usage passes
 * the actual `prisma` client (which structurally satisfies this);
 * tests pass a small hand-written fixture — no PrismaClient, no
 * database, no mocking framework required.
 */
export interface TenantDataSource {
  user: {
    findUnique(args: {
      where: { email: string };
    }): Promise<{ id: string; email: string; name: string | null } | null>;
  };
  organizationMembership: {
    findMany(args: {
      where: { userId: string };
      include: { organization: { include: { groups: true } } };
    }): Promise<MembershipWithOrgAndGroups[]>;
  };
}

// ---------------------------------------------------------------
// Pure resolver — no session, no global Prisma import used directly
// ---------------------------------------------------------------

/**
 * Resolves the full TenantContext for an already-authenticated email
 * address, or throws a TenantContextError. This is the core
 * authorization logic and is deliberately framework-free:
 *
 *   email → User (by unique email)
 *         → OrganizationMembership (the sole authority for org access —
 *           never inferred from Player/TelegramChat/email domain/env vars)
 *         → Organization → Group[] (via the Organization.groups relation;
 *           there is no GroupMembership model in the current schema, so
 *           group access is derived, not independently stored)
 *         → activeGroup (fail-closed unless exactly one active Group exists)
 *
 * Every ambiguous or missing step fails closed with a distinct error
 * code — this function never guesses (no "pick the first org", no
 * "pick the newest group").
 */
export async function resolveTenantContextForEmail(
  email: string | null | undefined,
  db: TenantDataSource
): Promise<TenantContext> {
  if (!email || !email.trim()) {
    throw new TenantContextError("UNAUTHENTICATED", "No email present on the session.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new TenantContextError("USER_NOT_FOUND", "No User row matches the authenticated identity.");
  }

  // OrganizationMembership is the sole authority for organization
  // access (Phase 2D.1 rule #7) — never derived from Player,
  // TelegramChat, Group, email domain, or ADMIN_EMAIL.
  const memberships = await db.organizationMembership.findMany({
    where: { userId: user.id },
    include: { organization: { include: { groups: true } } },
  });

  if (memberships.length === 0) {
    throw new TenantContextError("NO_ORGANIZATION_MEMBERSHIP", "User has no OrganizationMembership.");
  }
  if (memberships.length > 1) {
    // Fail closed rather than silently picking one — no active-
    // organization selection mechanism exists yet (Phase 2D.1 rule #8).
    throw new TenantContextError(
      "MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION",
      `User belongs to ${memberships.length} organizations; explicit selection is not yet implemented.`
    );
  }

  const membership = memberships[0];
  const organization = membership.organization;

  // isActive filters out soft-disabled groups (a distinct concept from
  // the "active group" selection below — a disabled Group should never
  // become anyone's active group).
  const groups = organization.groups.filter((g) => g.isActive);

  if (groups.length === 0) {
    throw new TenantContextError("NO_GROUP", "Organization has no active Group.");
  }
  if (groups.length > 1) {
    // Fail closed rather than silently picking first/newest/oldest/
    // alphabetical — no persistent group-selection mechanism exists
    // yet (Phase 2D.1 rule #6). This is intentional, not a gap.
    throw new TenantContextError(
      "MULTIPLE_GROUPS_REQUIRE_SELECTION",
      `Organization has ${groups.length} active groups; explicit selection is not yet implemented.`
    );
  }

  const activeGroup = groups[0];

  return {
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    membership: { id: membership.id, role: membership.role },
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      sportKey: g.sportKey,
      timezone: g.timezone,
    })),
    activeGroup: {
      id: activeGroup.id,
      name: activeGroup.name,
      slug: activeGroup.slug,
      sportKey: activeGroup.sportKey,
      timezone: activeGroup.timezone,
    },
  };
}

// ---------------------------------------------------------------
// Canonical server entry point (acquires the session)
// ---------------------------------------------------------------

/**
 * The one function server code (Route Handlers, Server Components)
 * should call. Acquires the current NextAuth session and resolves
 * tenant context from it, or throws TenantContextError.
 *
 * Bridges the legacy env-based admin login to the new tenant tables
 * via `session.user.email` — NOT `session.user.id`, which is not
 * reliably present: authOptions.ts defines no custom jwt/session
 * callback, so NextAuth v4's default session callback only copies
 * `name`/`email`/`image` onto `session.user`, never an id. This is a
 * deliberate, temporary bridge (Phase 2D.1 rule #9) — authentication
 * itself is unchanged; only authorization/tenant resolution is new.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const session = await getServerSession(authOptions);
  return resolveTenantContextForEmail(session?.user?.email, prisma);
}

// ---------------------------------------------------------------
// Phase 2D.6B — URL-bound tenant resolution (additive)
// ---------------------------------------------------------------

/**
 * Resolves TenantContext from an explicit (organizationSlug, groupSlug)
 * pair instead of failing closed on ambiguity. This is the primitive
 * the future URL-explicit Admin routes (/admin/o/[organizationSlug]/
 * g/[groupSlug]/...) will use — the URL supplies SELECTION input only,
 * never authorization proof: every field of the returned TenantContext
 * is still derived exclusively from OrganizationMembership, re-checked
 * fresh on every call, exactly like resolveTenantContextForEmail().
 *
 * Deliberately reuses the exact same TenantDataSource shape (no new
 * data-source method) by fetching all of the user's memberships and
 * locating the requested organization/group with `.find()` rather than
 * a separate "does this org exist" lookup. This is not just a style
 * choice: it means "the organization slug doesn't exist" and "the
 * organization exists but this User has no membership in it" are
 * structurally the same code path, producing the identical
 * NO_ORGANIZATION_MEMBERSHIP outcome — there is no separate branch
 * that could leak which case occurred. The same applies to
 * unknown-group-slug / foreign-Organization-group / inactive-group,
 * which all collapse to the identical NO_GROUP outcome. No new
 * TenantContextError code was needed for this (Phase 2D.6B report §E).
 *
 * `groups` in the returned context lists every ACTIVE Group in the
 * selected Organization (not merely the selected one) — a future
 * selector/header needs to enumerate the other Groups available
 * within that Organization, and OrganizationMembership already grants
 * access to all of them (Phase 2D.6A report §D/§Y). `activeGroup` is
 * exactly the URL-selected Group; `membership` is the membership row
 * for the URL-selected Organization specifically, so a user who is
 * OWNER of one Organization and MEMBER of another gets the correct
 * role for whichever one the URL names.
 *
 * Never queries "first" anything (no `[0]`), never falls back to a
 * user's only Organization/Group, never accepts organizationId/
 * groupId/membershipId as input — only slugs, always re-validated.
 */
export async function resolveTenantContextForSlugs(
  params: {
    email: string | null | undefined;
    organizationSlug: string;
    groupSlug: string;
  },
  db: TenantDataSource
): Promise<TenantContext> {
  const { email, organizationSlug, groupSlug } = params;

  if (!email || !email.trim()) {
    throw new TenantContextError("UNAUTHENTICATED", "No email present on the session.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new TenantContextError("USER_NOT_FOUND", "No User row matches the authenticated identity.");
  }

  const memberships = await db.organizationMembership.findMany({
    where: { userId: user.id },
    include: { organization: { include: { groups: true } } },
  });

  const membership = memberships.find((m) => m.organization.slug === organizationSlug);
  if (!membership) {
    throw new TenantContextError(
      "NO_ORGANIZATION_MEMBERSHIP",
      "No OrganizationMembership matches the requested organization."
    );
  }

  const organization = membership.organization;
  const activeGroups = organization.groups.filter((g) => g.isActive);

  const activeGroup = activeGroups.find((g) => g.slug === groupSlug);
  if (!activeGroup) {
    throw new TenantContextError(
      "NO_GROUP",
      "No active Group matches the requested group within this organization."
    );
  }

  return {
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    membership: { id: membership.id, role: membership.role },
    groups: activeGroups.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      sportKey: g.sportKey,
      timezone: g.timezone,
    })),
    activeGroup: {
      id: activeGroup.id,
      name: activeGroup.name,
      slug: activeGroup.slug,
      sportKey: activeGroup.sportKey,
      timezone: activeGroup.timezone,
    },
  };
}

/**
 * Session-acquiring wrapper for resolveTenantContextForSlugs(), mirroring
 * requireTenantContext()'s own shape exactly (same email bridge, same
 * reasoning documented on that function). Not wired into any route or
 * UI yet — Phase 2D.6C/2D.6D do that.
 */
export async function requireTenantContextForSlugs(params: {
  organizationSlug: string;
  groupSlug: string;
}): Promise<TenantContext> {
  const session = await getServerSession(authOptions);
  return resolveTenantContextForSlugs(
    {
      email: session?.user?.email,
      organizationSlug: params.organizationSlug,
      groupSlug: params.groupSlug,
    },
    prisma
  );
}

/** Safe, minimal DTO for the accessible-tenant listing primitive —
 * built field-by-field, same allow-list discipline as TenantContext. */
export type AccessibleOrganization = {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  groups: Array<{
    id: string;
    name: string;
    slug: string;
    sportKey: string;
    timezone: string;
  }>;
};

/**
 * Lists every Organization the authenticated email can access, with
 * that Organization's role and active Groups — the primitive a future
 * bare-`/admin` redirect and tenant selector will use. Unlike
 * resolveTenantContextForSlugs()/resolveTenantContextForEmail(), this
 * is a LISTING operation, not a "give me one active tenant" operation:
 * zero memberships is a valid result ([]), not a fail-closed error —
 * authentication itself still fails closed (UNAUTHENTICATED/
 * USER_NOT_FOUND), but "you belong to nothing" is just an empty list,
 * not an exception, since a caller may reasonably want to render "you
 * have no access yet" rather than catch a thrown error.
 *
 * An Organization with zero active Groups is still included, with
 * `groups: []` — this lets a future UI distinguish "you belong to
 * this Organization, but it has no active Groups yet" from "you don't
 * belong to any Organization at all" (Phase 2D.6A report §12).
 */
export async function listAccessibleTenantsForEmail(
  email: string | null | undefined,
  db: TenantDataSource
): Promise<AccessibleOrganization[]> {
  if (!email || !email.trim()) {
    throw new TenantContextError("UNAUTHENTICATED", "No email present on the session.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new TenantContextError("USER_NOT_FOUND", "No User row matches the authenticated identity.");
  }

  const memberships = await db.organizationMembership.findMany({
    where: { userId: user.id },
    include: { organization: { include: { groups: true } } },
  });

  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
    groups: m.organization.groups
      .filter((g) => g.isActive)
      .map((g) => ({
        id: g.id,
        name: g.name,
        slug: g.slug,
        sportKey: g.sportKey,
        timezone: g.timezone,
      })),
  }));
}

/** Session-acquiring wrapper for listAccessibleTenantsForEmail(). Not
 * exposed as an API route and not wired into any UI yet — server-side
 * infrastructure only (Phase 2D.6B §10). */
export async function listAccessibleTenants(): Promise<AccessibleOrganization[]> {
  const session = await getServerSession(authOptions);
  return listAccessibleTenantsForEmail(session?.user?.email, prisma);
}

// ---------------------------------------------------------------
// Role primitives (Section 12) — only actual schema OrgRole values
// ---------------------------------------------------------------

export function hasOrgRole(context: TenantContext, allowed: OrgRole[]): boolean {
  return allowed.includes(context.membership.role);
}

/** Throws TenantContextError("INSUFFICIENT_ROLE") if the context's
 * role is not one of `allowed`. Does not (yet) express a full
 * authorization matrix — later phases build on this primitive. */
export function requireRole(context: TenantContext, allowed: OrgRole[]): void {
  if (!hasOrgRole(context, allowed)) {
    throw new TenantContextError(
      "INSUFFICIENT_ROLE",
      `Role ${context.membership.role} is not permitted; requires one of: ${allowed.join(", ")}.`
    );
  }
}
