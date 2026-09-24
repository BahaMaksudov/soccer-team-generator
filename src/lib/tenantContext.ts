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
