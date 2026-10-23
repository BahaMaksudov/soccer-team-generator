import type { PlayerContactType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { normalizeEmail, parseContactEmail } from "@/lib/emailAddress";

/**
 * M13B P1 — organizer-managed player contact email (for FUTURE RSVP invitations;
 * nothing here sends email or creates invitations).
 *
 *   Player.contactEmail / contactEmailType — entered by an OWNER/ADMIN of the
 *   Player's Group: the player's own address (PLAYER) or a parent / guardian's
 *   (GUARDIAN). Separate from the linked account's email (User.email), which is
 *   never copied into, overwritten by or shown through these fields.
 *
 * Privacy: read and written only through this module, by OWNER/ADMIN, scoped by the
 * URL-resolved Group. No other query selects these columns (every Player query in
 * the app uses an explicit select), so they never reach rosters, public / shared
 * pages, published teams, Telegram, AI payloads or player-facing views. Addresses
 * are never logged.
 *
 * M13B P6 — contact AUTHORIZATION: setting or materially changing a contact (a different
 * address, or PLAYER ↔ GUARDIAN) requires the organizer to confirm that the address may
 * be used for match coordination email; who confirmed and when is recorded. This is the
 * organizer's attestation only — it does not prove a parent / guardian's legal consent,
 * and the app never claims it does. An unconfirmed contact is never emailed (and never
 * falls back to the linked account). Removing the contact clears the record. No other
 * information about the player (age, relationship details) is collected.
 */
const MANAGERS = ["OWNER", "ADMIN"] as const;

export type ContactView = {
  contact: { email: string; type: PlayerContactType; updatedAt: string | null; authorization: { at: string; byName: string | null } | null } | null;
  /**
   * The linked account, if any — whether it can serve as the fallback recipient
   * (verified email). The account ADDRESS is not shown to organizers: the existing
   * organizer view of a linked account is booleans only (M6-C).
   */
  linkedAccount: { linked: boolean; verified: boolean };
};

const CONTACT_SELECT = {
  contactEmail: true,
  contactEmailType: true,
  contactEmailUpdatedAt: true,
  contactAuthorizedAt: true,
  contactAuthorizedBy: { select: { name: true } },
  user: { select: { emailVerifiedAt: true } },
} as const satisfies Prisma.PlayerSelect;

type ContactRow = Prisma.PlayerGetPayload<{ select: typeof CONTACT_SELECT }>;

const toView = (p: ContactRow): ContactView => ({
  contact:
    p.contactEmail && p.contactEmailType
      ? {
          email: p.contactEmail,
          type: p.contactEmailType,
          updatedAt: p.contactEmailUpdatedAt?.toISOString() ?? null,
          authorization: p.contactAuthorizedAt ? { at: p.contactAuthorizedAt.toISOString(), byName: p.contactAuthorizedBy?.name ?? null } : null,
        }
      : null,
  linkedAccount: { linked: p.user !== null, verified: Boolean(p.user?.emailVerifiedAt) },
});

/** OWNER/ADMIN: one Player's contact (null = not this Group's Player — indistinguishable from unknown). */
export async function getPlayerContact(context: TenantContext, playerId: string): Promise<ContactView | null> {
  requireRole(context, [...MANAGERS]);
  const p = await prisma.player.findFirst({ where: { id: playerId, groupId: context.activeGroup.id }, select: CONTACT_SELECT });
  return p ? toView(p) : null;
}

export type SetContactInput = { email: unknown; type?: unknown; /** P6: the organizer confirms the address may be used for match coordination email */ authorized?: unknown };
export type SetContactResult = { ok: true; view: ContactView } | { ok: false; code: "NOT_FOUND" } | { ok: false; code: "INVALID"; field: "email" | "type" | "authorized"; error: string };

export const AUTHORIZATION_REQUIRED = {
  PLAYER: "Confirm that this player gave you this address (or agreed to its use) for match coordination emails.",
  GUARDIAN: "Confirm that this parent / guardian gave you this address (or agreed to its use) for match coordination emails about this player.",
} as const;

/**
 * OWNER/ADMIN: set or clear one Player's contact. A blank / null email clears the
 * address, its type and its authorization. Setting one requires the type (PLAYER or
 * GUARDIAN) — never guessed — and, for a new or MATERIALLY changed contact (a different
 * normalized address or type), `authorized: true` (recorded with who and when). Saving
 * the same contact again keeps its existing authorization. Runs under the Player row
 * lock and is scoped by id AND the URL-resolved Group (a foreign or unknown id changes
 * nothing and is a plain NOT_FOUND).
 */
export async function setPlayerContact(context: TenantContext, playerId: string, input: SetContactInput, now: Date = new Date()): Promise<SetContactResult> {
  requireRole(context, [...MANAGERS]);
  const parsed = parseContactEmail(input.email);
  if (!parsed.ok) return { ok: false, code: "INVALID", field: "email", error: parsed.error };
  if (parsed.email !== null && input.type !== "PLAYER" && input.type !== "GUARDIAN") return { ok: false, code: "INVALID", field: "type", error: "Choose whose email this is: the player's or a parent / guardian's." };
  const type = input.type as PlayerContactType;
  const result = await prisma.$transaction(async (tx): Promise<SetContactResult | "OK"> => {
    const [current] = await tx.$queryRaw<Array<{ contactEmail: string | null; contactEmailType: PlayerContactType | null; contactAuthorizedAt: Date | null }>>`
      SELECT "contactEmail", "contactEmailType", "contactAuthorizedAt" FROM "Player" WHERE "id" = ${playerId} AND "groupId" = ${context.activeGroup.id} FOR UPDATE`;
    if (!current) return { ok: false, code: "NOT_FOUND" };
    if (parsed.email === null) {
      await tx.player.update({ where: { id: playerId }, data: { contactEmail: null, contactEmailType: null, contactEmailUpdatedAt: now, contactAuthorizedAt: null, contactAuthorizedByUserId: null } });
      return "OK";
    }
    const same = current.contactEmail !== null && normalizeEmail(current.contactEmail) === normalizeEmail(parsed.email) && current.contactEmailType === type;
    const keep = same && current.contactAuthorizedAt !== null;
    if (!keep && input.authorized !== true) return { ok: false, code: "INVALID", field: "authorized", error: AUTHORIZATION_REQUIRED[type] };
    const data = { contactEmail: parsed.email, contactEmailType: type, contactEmailUpdatedAt: same ? undefined : now };
    await tx.player.update({
      where: { id: playerId },
      data: keep ? data : { ...data, contactAuthorizedAt: now, contactAuthorizedByUserId: context.user.id }, // one statement (CHECK-safe)
    });
    return "OK";
  });
  if (result !== "OK") return result;
  const view = await getPlayerContact(context, playerId);
  return view ? { ok: true, view } : { ok: false, code: "NOT_FOUND" };
}

// ------------------------------------------------------------------ recipient resolution (no sending)

export type RecipientInput = {
  contactEmail: string | null;
  contactEmailType: PlayerContactType | null;
  contactAuthorizedAt: Date | null;
  user: { email: string; emailVerifiedAt: Date | null } | null;
};
export type Recipient =
  | { kind: "CONTACT"; email: string; contactType: PlayerContactType }
  | { kind: "ACCOUNT"; email: string }
  | { kind: "INVALID_CONTACT" }
  | { kind: "UNCONFIRMED_CONTACT"; contactType: PlayerContactType }
  | { kind: "NO_EMAIL" };

/**
 * Where a future RSVP email for this Player would go (pure, deterministic):
 *   1. the organizer-entered contact (keeping PLAYER vs GUARDIAN), when present;
 *      a stored contact that no longer validates is INVALID_CONTACT — it never
 *      falls through to the account (a guardian's slot must not silently become
 *      the player's own inbox);
 *   2. otherwise the linked account's email, ONLY if that account is verified
 *      (User.emailVerifiedAt — set solely by a completed email verification or a
 *      Google sign-in with a Google-verified email);
 *   3. otherwise NO_EMAIL.
 * P6: a valid contact nobody has confirmed (contactAuthorizedAt) is UNCONFIRMED_CONTACT —
 * never emailed, and it never falls back to the account either.
 */
export function resolveRecipient(p: RecipientInput): Recipient {
  if (p.contactEmail !== null || p.contactEmailType !== null) {
    const parsed = parseContactEmail(p.contactEmail);
    if (!parsed.ok || parsed.email === null || !p.contactEmailType) return { kind: "INVALID_CONTACT" };
    if (!p.contactAuthorizedAt) return { kind: "UNCONFIRMED_CONTACT", contactType: p.contactEmailType };
    return { kind: "CONTACT", email: parsed.email, contactType: p.contactEmailType };
  }
  if (p.user && p.user.emailVerifiedAt) {
    const parsed = parseContactEmail(p.user.email);
    if (parsed.ok && parsed.email) return { kind: "ACCOUNT", email: parsed.email };
  }
  return { kind: "NO_EMAIL" };
}

/** Server-only loader for later phases: recipients of the given Players of ONE Group (never sends, never logs addresses). */
export async function loadRecipients(groupId: string, playerIds: string[]): Promise<Map<string, Recipient>> {
  const rows = await prisma.player.findMany({
    where: { groupId, id: { in: playerIds } },
    select: { id: true, contactEmail: true, contactEmailType: true, contactAuthorizedAt: true, user: { select: { email: true, emailVerifiedAt: true } } },
  });
  return new Map(rows.map((r) => [r.id, resolveRecipient(r)]));
}
