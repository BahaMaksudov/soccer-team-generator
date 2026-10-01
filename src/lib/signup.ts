import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emailSchema } from "@/lib/emailAddress";
import { hashPassword, type AuthenticatedUser } from "@/lib/accounts";
import { findUsableInvitation, type InvitationFailure } from "@/lib/invitations";
import { deliverVerificationEmail, issueVerificationTokenInTx } from "@/lib/emailVerification";
import { safeCallbackPath } from "@/lib/safeRedirect";

/**
 * M5 — self-service sign-up. Kept separate from src/lib/accounts.ts
 * (credential verification, imported by NextAuth's authOptions) so the
 * login path does not import the invitation/tenant modules.
 *
 * Every new User starts UNVERIFIED (emailVerifiedAt NULL) and gets a
 * verification token in the same transaction as the User row, then a
 * verification email. A User grants nothing by itself: Organization
 * access requires a verified email (src/lib/tenantContext.ts) AND a
 * membership.
 *
 * With an invitation token, the account is created with the
 * INVITATION's email (the client cannot choose it), but the invitation
 * is NOT consumed here — it stays pending until the User has verified
 * the email and explicitly accepts it. The verification link carries
 * the invitation path as its continuation.
 *
 * Email delivery happens after the commit (it cannot share a database
 * transaction). If it fails, the account still exists and the User can
 * request a resend — nothing is left unrecoverable.
 */

export type RegisterResult =
  | { ok: true; user: AuthenticatedUser; verificationEmailSent: boolean; next: string | null }
  | { ok: false; code: "EMAIL_TAKEN" }
  | { ok: false; code: InvitationFailure };

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function registerAccount(input: {
  name: string;
  email?: string;
  password: string;
  inviteToken?: string;
  next?: string;
}): Promise<RegisterResult> {
  let email: string;
  let next: string | null = null;
  if (input.inviteToken) {
    const found = await findUsableInvitation(input.inviteToken);
    if (!found.ok) return found;
    email = found.invitation.email;
    next = `/invite/${input.inviteToken}`;
  } else {
    email = emailSchema.parse(input.email ?? "");
    next = safeCallbackPath(input.next, "") || null;
  }

  const passwordHash = await hashPassword(input.password);

  let created: { user: AuthenticatedUser; token: string; expiresAt: Date };
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true },
      });
      const issued = await issueVerificationTokenInTx(tx, user);
      return { user, ...issued };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: "EMAIL_TAKEN" };
    throw e;
  }

  const verificationEmailSent = await deliverVerificationEmail({
    to: created.user.email,
    name: created.user.name,
    token: created.token,
    expiresAt: created.expiresAt,
    next,
  });
  return { ok: true, user: created.user, verificationEmailSent, next };
}
