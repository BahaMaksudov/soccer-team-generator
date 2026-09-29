/**
 * Phase 2D.1 — canonical tenant-context foundation.
 *
 * This module is the one place server code resolves "who is logged in,
 * and which Organization/Group may they operate on." It does not
 * change authentication (still env-based Credentials login, see
 * src/lib/authOptions.ts).
 *
 * Phase 2D.6D.6 — only two resolution modes exist:
 *   - requireTenantContextForSlugs(): URL-bound (organizationSlug,
 *     groupSlug) → one TenantContext, used by every canonical Admin
 *     page/API;
 *   - listAccessibleTenants(): lists every accessible Organization and
 *     its active Groups, used by the bare /admin selector.
 * The former single-tenant resolver (requireTenantContext() /
 * resolveTenantContextForEmail(), which failed closed unless the user
 * had exactly one Organization with exactly one active Group) was
 * removed together with its last caller, /api/admin/tenant-context.
 *
 * Not marked with the `server-only` package on purpose: that package's
 * client/server split relies on Next.js's webpack export-condition
 * resolution, which plain Vitest/Node does not apply — importing it
 * here would risk breaking this module's resolver unit tests without
 * extra test-runner configuration. This module is
 * already unusable from a "use client" file regardless, since it
 * imports Prisma and next-auth's server APIs, neither of which can be
 * bundled for the browser — Next.js's build fails loudly on that
 * mistake with or without the `server-only` marker.
 *
 * Testability boundary (Section 15): session acquisition
 * (getServerSession) is kept to the small `require…`/`list…` wrappers.
 * All the actual resolution logic lives in the `…ForSlugs`/`…ForEmail`
 * functions, which take a plain email string and a minimal data-source
 * interface — no NextAuth, no global Prisma singleton — so they're
 * directly unit-testable with fixtures.
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
  | "NO_GROUP"
  | "INSUFFICIENT_ROLE";

/**
 * Deterministic, typed failure for every way tenant resolution can
 * fail closed. Never carries database internals in its message —
 * safe to log, safe to summarize to a client (never expose `.message`
 * verbatim to an end user; map `.code` to an HTTP status instead — the
 * canonical routes use canonicalTenantErrorResponse() in
 * src/lib/tenantRoute.ts).
 */
export class TenantContextError extends Error {
  readonly code: TenantContextErrorCode;
  constructor(code: TenantContextErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TenantContextError";
    this.code = code;
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
// Phase 2D.6B — URL-bound tenant resolution
// ---------------------------------------------------------------

/**
 * Resolves TenantContext from an explicit (organizationSlug, groupSlug)
 * pair. This is the primitive every URL-explicit Admin page/API
 * (/admin/o/[organizationSlug]/g/[groupSlug]/..., /api/admin/o/...)
 * uses — the URL supplies SELECTION input only, never authorization
 * proof: every field of the returned TenantContext is derived
 * exclusively from OrganizationMembership (the sole authority for
 * organization access — never Player, TelegramChat, email domain, or
 * env vars), re-checked fresh on every call.
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
 * Session-acquiring wrapper for resolveTenantContextForSlugs(). Bridges
 * the env-based admin login to the tenant tables via
 * `session.user.email` — NOT `session.user.id`, which is not reliably
 * present: authOptions.ts defines no custom jwt/session callback, so
 * NextAuth v4's default session callback only copies name/email/image
 * onto `session.user`. Authentication itself is unchanged; only
 * authorization/tenant resolution happens here.
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
 * that Organization's role and active Groups — the primitive the
 * bare-`/admin` redirect/selector uses. Unlike
 * resolveTenantContextForSlugs(), this is a LISTING operation, not a "give me one active tenant" operation:
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

/** Session-acquiring wrapper for listAccessibleTenantsForEmail(), used
 * by the bare /admin entry page (src/app/admin/page.tsx). Not exposed
 * as an API route. */
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
