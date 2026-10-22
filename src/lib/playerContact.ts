import type { PlayerContactType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { parseContactEmail } from "@/lib/emailAddress";

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
 */
const MANAGERS = ["OWNER", "ADMIN"] as const;

export type ContactView = {
  contact: { email: string; type: PlayerContactType; updatedAt: string | null } | null;
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
  user: { select: { emailVerifiedAt: true } },
} as const satisfies Prisma.PlayerSelect;

type ContactRow = Prisma.PlayerGetPayload<{ select: typeof CONTACT_SELECT }>;

const toView = (p: ContactRow): ContactView => ({
  contact: p.contactEmail && p.contactEmailType ? { email: p.contactEmail, type: p.contactEmailType, updatedAt: p.contactEmailUpdatedAt?.toISOString() ?? null } : null,
  linkedAccount: { linked: p.user !== null, verified: Boolean(p.user?.emailVerifiedAt) },
});

/** OWNER/ADMIN: one Player's contact (null = not this Group's Player — indistinguishable from unknown). */
export async function getPlayerContact(context: TenantContext, playerId: string): Promise<ContactView | null> {
  requireRole(context, [...MANAGERS]);
  const p = await prisma.player.findFirst({ where: { id: playerId, groupId: context.activeGroup.id }, select: CONTACT_SELECT });
  return p ? toView(p) : null;
}

export type SetContactInput = { email: unknown; type?: unknown };
export type SetContactResult = { ok: true; view: ContactView } | { ok: false; code: "NOT_FOUND" } | { ok: false; code: "INVALID"; field: "email" | "type"; error: string };

/**
 * OWNER/ADMIN: set or clear one Player's contact. A blank / null email clears both
 * the address and its type. Setting one requires the type (PLAYER or GUARDIAN) —
 * never guessed. The write is a single statement scoped by id AND the URL-resolved
 * Group (a foreign or unknown id changes nothing and is a plain NOT_FOUND).
 */
export async function setPlayerContact(context: TenantContext, playerId: string, input: SetContactInput, now: Date = new Date()): Promise<SetContactResult> {
  requireRole(context, [...MANAGERS]);
  const parsed = parseContactEmail(input.email);
  if (!parsed.ok) return { ok: false, code: "INVALID", field: "email", error: parsed.error };
  let data: Prisma.PlayerUpdateManyMutationInput;
  if (parsed.email === null) {
    data = { contactEmail: null, contactEmailType: null, contactEmailUpdatedAt: now };
  } else {
    if (input.type !== "PLAYER" && input.type !== "GUARDIAN") return { ok: false, code: "INVALID", field: "type", error: "Choose whose email this is: the player's or a parent / guardian's." };
    data = { contactEmail: parsed.email, contactEmailType: input.type, contactEmailUpdatedAt: now };
  }
  const { count } = await prisma.player.updateMany({ where: { id: playerId, groupId: context.activeGroup.id }, data });
  if (count !== 1) return { ok: false, code: "NOT_FOUND" };
  const view = await getPlayerContact(context, playerId);
  return view ? { ok: true, view } : { ok: false, code: "NOT_FOUND" };
}

// ------------------------------------------------------------------ recipient resolution (no sending)

export type RecipientInput = {
  contactEmail: string | null;
  contactEmailType: PlayerContactType | null;
  user: { email: string; emailVerifiedAt: Date | null } | null;
};
export type Recipient =
  | { kind: "CONTACT"; email: string; contactType: PlayerContactType }
  | { kind: "ACCOUNT"; email: string }
  | { kind: "INVALID_CONTACT" }
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
 */
export function resolveRecipient(p: RecipientInput): Recipient {
  if (p.contactEmail !== null || p.contactEmailType !== null) {
    const parsed = parseContactEmail(p.contactEmail);
    if (!parsed.ok || parsed.email === null || !p.contactEmailType) return { kind: "INVALID_CONTACT" };
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
    select: { id: true, contactEmail: true, contactEmailType: true, user: { select: { email: true, emailVerifiedAt: true } } },
  });
  return new Map(rows.map((r) => [r.id, resolveRecipient(r)]));
}
