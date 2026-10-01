import { z } from "zod";
import type { OrgRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { emailSchema, normalizeEmail } from "@/lib/emailAddress";
import { requireRole, type OrganizationContext } from "@/lib/tenantContext";
import { sendInvitationEmail } from "@/lib/email";

/**
 * M5 — Organization invitations.
 *
 * - The raw token (32 random bytes, base64url) exists only in the
 *   invitation link; the database stores its SHA-256 hash. A fast hash
 *   is appropriate here: the token has 256 bits of entropy, so there is
 *   nothing to brute-force.
 * - Each invitation is bound to one Organization, one normalized email
 *   and one role, all fixed at creation. Acceptance reads none of them
 *   from the client.
 * - Single-use and time-limited: consumption is one conditional UPDATE
 *   (acceptedAt IS NULL AND expiresAt > now), so concurrent acceptances
 *   cannot both succeed, and the membership is created in the same
 *   transaction with ON CONFLICT DO NOTHING (an existing membership is
 *   kept as-is, never duplicated, never re-roled).
 * - Only an OWNER may invite, and only as ADMIN or MEMBER (ownership
 *   transfer is out of scope for M5).
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITABLE_ROLES = ["ADMIN", "MEMBER"] as const satisfies readonly OrgRole[];

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(INVITABLE_ROLES),
});

export const generateInvitationToken = generateToken;
export const hashInvitationToken = hashToken;

export type InvitationFailure = "INVITATION_INVALID" | "INVITATION_EXPIRED" | "INVITATION_USED";

const INVITATION_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  acceptedByUserId: true,
} as const;

type InvitationRow = Prisma.OrganizationInvitationGetPayload<{ select: typeof INVITATION_SELECT }>;

async function findInvitationByToken(token: string): Promise<InvitationRow | null> {
  if (!isWellFormedToken(token)) return null;
  return prisma.organizationInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: INVITATION_SELECT,
  });
}

/** A pending, unexpired invitation for this token — or why not. */
export async function findUsableInvitation(
  token: string,
  now: Date = new Date()
): Promise<{ ok: true; invitation: InvitationRow } | { ok: false; code: InvitationFailure }> {
  const invitation = await findInvitationByToken(token);
  if (!invitation) return { ok: false, code: "INVITATION_INVALID" };
  if (invitation.acceptedAt) return { ok: false, code: "INVITATION_USED" };
  if (invitation.expiresAt <= now) return { ok: false, code: "INVITATION_EXPIRED" };
  return { ok: true, invitation };
}

/**
 * Consumes the invitation and grants its membership, inside the
 * caller's transaction. Returns false (having changed nothing) when the
 * invitation was already used or has expired in the meantime.
 */
export async function consumeInvitationInTx(
  tx: Prisma.TransactionClient,
  invitationId: string,
  userId: string,
  organizationId: string,
  role: OrgRole
): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.organizationInvitation.updateMany({
    where: { id: invitationId, acceptedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now, acceptedByUserId: userId },
  });
  if (count !== 1) return false;
  await tx.organizationMembership.createMany({
    data: [{ userId, organizationId, role }],
    skipDuplicates: true,
  });
  return true;
}

type InvitationDetails = { organizationName: string; email: string; role: OrgRole };
export type InvitationPreview =
  | ({ status: "valid" } & InvitationDetails)
  | ({ status: "expired" } & InvitationDetails)
  | { status: "used" }
  | { status: "invalid" };

/** Read-only view for the /invite/[token] page. Never consumes anything. */
export async function getInvitationPreview(token: string, now: Date = new Date()): Promise<InvitationPreview> {
  const invitation = await findInvitationByToken(token);
  if (!invitation) return { status: "invalid" };
  if (invitation.acceptedAt) return { status: "used" };
  const organization = await prisma.organization.findUnique({
    where: { id: invitation.organizationId },
    select: { name: true },
  });
  if (!organization) return { status: "invalid" };
  const details = { organizationName: organization.name, email: invitation.email, role: invitation.role };
  return invitation.expiresAt <= now ? { status: "expired", ...details } : { status: "valid", ...details };
}

export type CreateInvitationResult =
  | {
      ok: true;
      token: string;
      invitation: { id: string; email: string; role: OrgRole; expiresAt: Date; createdAt: Date };
    }
  | { ok: false; code: "ALREADY_MEMBER" };

/**
 * OWNER-only. The Organization is the URL-resolved, membership-verified
 * context's Organization — never a client-supplied id.
 */
export async function createInvitation(
  context: OrganizationContext,
  input: z.infer<typeof createInvitationSchema>,
  now: Date = new Date()
): Promise<CreateInvitationResult> {
  requireRole(context, ["OWNER"]);

  const email = normalizeEmail(input.email);
  const existingMember = await prisma.organizationMembership.findFirst({
    where: { organizationId: context.organization.id, user: { email } },
    select: { id: true },
  });
  if (existingMember) return { ok: false, code: "ALREADY_MEMBER" };

  const token = generateInvitationToken();
  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId: context.organization.id,
      email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      createdByUserId: context.user.id,
    },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  return { ok: true, token, invitation };
}

/**
 * Creates the invitation, then emails the link (the raw token lives only
 * in memory and in that email).
 *
 * Database + email cannot be one transaction, so:
 *   - email fails → the just-created invitation is deleted (its token
 *     reached no one, so it could never be used) and EMAIL_DELIVERY_FAILED
 *     is returned; the OWNER simply retries, which creates a fresh one;
 *   - email succeeds → older still-pending invitations for the same
 *     Organization + email are deleted, so at most one link is live.
 * Nothing here touches memberships.
 */
export async function createAndSendInvitation(
  context: OrganizationContext,
  input: z.infer<typeof createInvitationSchema>,
  now: Date = new Date()
): Promise<CreateInvitationResult | { ok: false; code: "EMAIL_DELIVERY_FAILED" }> {
  const created = await createInvitation(context, input, now);
  if (!created.ok) return created;

  try {
    await sendInvitationEmail({
      to: created.invitation.email,
      organizationName: context.organization.name,
      inviterName: context.user.name,
      role: created.invitation.role,
      token: created.token,
      expiresAt: created.invitation.expiresAt,
    });
  } catch (e) {
    console.error(`[email] invitation email not sent: ${e instanceof Error ? e.name : "unknown error"}`);
    await prisma.organizationInvitation
      .deleteMany({ where: { id: created.invitation.id, acceptedAt: null } })
      .catch(() => console.error("[invitations] could not remove an undelivered invitation (it expires on its own)"));
    return { ok: false, code: "EMAIL_DELIVERY_FAILED" };
  }

  await prisma.organizationInvitation.deleteMany({
    where: {
      organizationId: context.organization.id,
      email: created.invitation.email,
      acceptedAt: null,
      id: { not: created.invitation.id },
    },
  });
  return created;
}

export type AcceptInvitationResult =
  | { ok: true; organizationId: string; alreadyAccepted: boolean }
  | { ok: false; code: InvitationFailure | "EMAIL_MISMATCH" | "EMAIL_NOT_VERIFIED" };

/**
 * Accepts an invitation for the authenticated, email-verified User (`userId` comes from
 * the server-side session, never from the request body). The User's
 * normalized email must equal the invitation's. Replaying a link the
 * same User already accepted is an idempotent success; anyone else gets
 * INVITATION_USED.
 */
export async function acceptInvitation(params: { userId: string; token: string }): Promise<AcceptInvitationResult> {
  const invitation = await findInvitationByToken(params.token);
  if (!invitation) return { ok: false, code: "INVITATION_INVALID" };

  if (invitation.acceptedAt) {
    return invitation.acceptedByUserId === params.userId
      ? { ok: true, organizationId: invitation.organizationId, alreadyAccepted: true }
      : { ok: false, code: "INVITATION_USED" };
  }
  if (invitation.expiresAt <= new Date()) return { ok: false, code: "INVITATION_EXPIRED" };

  const user = await prisma.user.findUnique({ where: { id: params.userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) return { ok: false, code: "INVITATION_INVALID" };
  if (normalizeEmail(user.email) !== invitation.email) return { ok: false, code: "EMAIL_MISMATCH" };
  // Defense in depth (the route's session resolver already requires it):
  // an unverified account never consumes an invitation.
  if (!user.emailVerifiedAt) return { ok: false, code: "EMAIL_NOT_VERIFIED" };

  const consumed = await prisma.$transaction((tx) =>
    consumeInvitationInTx(tx, invitation.id, params.userId, invitation.organizationId, invitation.role)
  );
  if (consumed) return { ok: true, organizationId: invitation.organizationId, alreadyAccepted: false };

  // Lost a race: re-read to report accurately.
  const latest = await findInvitationByToken(params.token);
  if (latest?.acceptedAt && latest.acceptedByUserId === params.userId) {
    return { ok: true, organizationId: invitation.organizationId, alreadyAccepted: true };
  }
  return { ok: false, code: latest?.acceptedAt ? "INVITATION_USED" : "INVITATION_EXPIRED" };
}

export type OrganizationMembersView = {
  members: Array<{ id: string; name: string | null; email: string; role: OrgRole }>;
  pendingInvitations: Array<{ id: string; email: string; role: OrgRole; expiresAt: Date; createdAt: Date }>;
};

/** OWNER-only listing of an Organization's members and pending invitations (no token material). */
export async function listOrganizationMembers(
  context: OrganizationContext,
  now: Date = new Date()
): Promise<OrganizationMembersView> {
  requireRole(context, ["OWNER"]);
  const [memberships, invitations] = await Promise.all([
    prisma.organizationMembership.findMany({
      where: { organizationId: context.organization.id },
      select: { id: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.organizationInvitation.findMany({
      where: { organizationId: context.organization.id, acceptedAt: null, expiresAt: { gt: now } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    members: memberships.map((m) => ({ id: m.id, name: m.user.name, email: m.user.email, role: m.role })),
    pendingInvitations: invitations,
  };
}
