import type { PlayerContactType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { attendanceMode } from "@/lib/attendanceClosure";
import { matchRosterIds } from "@/lib/personalAttendance";
import { loadRecipients, type Recipient } from "@/lib/playerContact";
import { organizationPlan, utcDay, utcMonth, type EffectivePlan } from "@/lib/entitlements";
import { maskEmail } from "@/lib/emailAddress";
import { suppressedFor } from "@/lib/emailSuppression";
import { rsvpDeliveryMode } from "@/lib/rsvpDeliveryMode";

/**
 * M13B — RSVP invitation RECIPIENT PREVIEW (OWNER/ADMIN; P2) and the shared
 * eligibility / allowance rules the sending engine (P4, src/lib/rsvpSend.ts) re-runs
 * at send time. The preview is strictly read-only: no email, no records, no tokens,
 * no usage. Website-only matches only (409 TELEGRAM_MATCH), only while open.
 *
 * Every player on the match's eligible roster (the same roster as personal attendance
 * links) is classified, in this order:
 *   ORGANIZER_OVERRIDE  — an organizer set the status (never re-asked)
 *   ALREADY_ANSWERED    — the player answered (any channel)
 *   IN_PROGRESS         — an invitation to this player is still queued / being sent (P6:
 *                         a resend never duplicates an in-flight email)
 *   INVALID_CONTACT     — the stored organizer contact no longer validates (no fallback)
 *   CONTACT_UNCONFIRMED — P6: nobody confirmed the contact may be used for match
 *                         coordination email (no fallback to the account)
 *   NO_EMAIL            — no contact and no verified linked-account email
 *   SUPPRESSED          — globally suppressed (hard bounce / complaint) or opted out of THIS
 *                         organization's RSVP emails (the reason is never shown)
 *   OVER_LIMIT          — sendable, but beyond the organization's REMAINING allowance
 *                         (actual ledger usage) — still provisional: the send recalculates
 *   WILL_SEND           — sendable
 * Group players who are NOT on this match's roster are listed separately (names only).
 * Destinations are masked ("p•••@example.com"); full addresses never leave the server.
 */
export type PreviewStatus = "WILL_SEND" | "NO_EMAIL" | "INVALID_CONTACT" | "CONTACT_UNCONFIRMED" | "IN_PROGRESS" | "ALREADY_ANSWERED" | "ORGANIZER_OVERRIDE" | "NOT_ON_ROSTER" | "SUPPRESSED" | "OVER_LIMIT";
export type DestinationSource = "PLAYER" | "GUARDIAN" | "ACCOUNT";

export type PreviewRow = { playerId: string; name: string; status: PreviewStatus; source: DestinationSource | null; maskedEmail: string | null };

/** The statuses that count against the allowance: reserved (QUEUED / SENDING) and consumed (SENT / UNCERTAIN). */
export const COUNTED_STATUSES = ["QUEUED", "SENDING", "SENT", "UNCERTAIN"] as const;

export type RsvpUsage = { used: number; reserved: number };
export type RsvpAllowance = {
  plan: EffectivePlan;
  day: { limit: number; period: string; resetsAt: string } & RsvpUsage & { remaining: number };
  month: { limit: number; period: string; resetsAt: string } & RsvpUsage & { remaining: number };
  /** "used" = consumed (accepted by the provider, or uncertain — may have been delivered) + reserved (queued / sending). */
  note: string;
};

export type RsvpPreview = {
  match: { id: string; date: string; startTime: string | null };
  recipients: PreviewRow[];
  notOnRoster: Array<{ playerId: string; name: string; status: "NOT_ON_ROSTER" }>;
  counts: { willSend: number; excluded: number; byStatus: Record<PreviewStatus, number>; overLimitIsProvisional: true };
  allowance: RsvpAllowance;
  suppression: { available: true };
  /** P5: true only where rsvpDeliveryMode() is "test-outbox" (never in Production / Preview). */
  sending: { available: boolean };
};

export type PreviewRefusal = "NOT_FOUND" | "TELEGRAM_MATCH" | "MATCH_CANCELED" | "MATCH_COMPLETED" | "ATTENDANCE_CLOSED" | "DEADLINE_PASSED";

const MANAGERS = ["OWNER", "ADMIN"] as const;
const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();
type Db = Prisma.TransactionClient | typeof prisma;

export { maskEmail } from "@/lib/emailAddress";

/**
 * Usage in a UTC window [start, end): CONSUMED (SENT / UNCERTAIN, from the durable
 * RsvpEmailUsage ledger — survives match / player deletion) + RESERVED (QUEUED / SENDING
 * invitations, counted live). An invitation moves from reserved to consumed in ONE
 * transaction, and both parts are read in ONE statement (one snapshot), so a row is
 * never counted twice or missed while it moves.
 */
async function usageIn(db: Db, organizationId: string, start: Date, end: Date): Promise<RsvpUsage> {
  const [row] = await db.$queryRaw<Array<{ consumed: bigint; reserved: bigint }>>`
    SELECT
      (SELECT COALESCE(SUM("consumed"), 0) FROM "RsvpEmailUsage"
        WHERE "organizationId" = ${organizationId} AND "day" >= ${isoDay(start)}::date AND "day" < ${isoDay(end)}::date)::bigint AS consumed,
      (SELECT count(*) FROM "RsvpInvitation"
        WHERE "organizationId" = ${organizationId} AND "status" IN ('QUEUED', 'SENDING')
          AND "reservedAt" >= ${start.toISOString()}::timestamp AND "reservedAt" < ${end.toISOString()}::timestamp)::bigint AS reserved`;
  const reserved = Number(row.reserved);
  return { used: Number(row.consumed) + reserved, reserved };
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The organization's RSVP allowance with ACTUAL ledger usage (UTC calendar day / month). */
export async function rsvpAllowance(organizationId: string, now: Date = new Date(), db: Db = prisma): Promise<RsvpAllowance> {
  const { plan, limits } = await organizationPlan(organizationId, now, db);
  const day = utcDay(now);
  const month = utcMonth(now);
  const [d, m] = await Promise.all([usageIn(db, organizationId, day.start, day.next), usageIn(db, organizationId, month.start, month.next)]);
  return {
    plan,
    day: { limit: limits.rsvpEmailsPerDay, period: day.period, resetsAt: day.next.toISOString(), ...d, remaining: Math.max(0, limits.rsvpEmailsPerDay - d.used) },
    month: { limit: limits.rsvpEmailsPerMonth, period: month.period, resetsAt: month.next.toISOString(), ...m, remaining: Math.max(0, limits.rsvpEmailsPerMonth - m.used) },
    note: "Used counts emails accepted for delivery, emails whose delivery is uncertain, and emails queued to send. Sending re-checks everything, so the final count can differ.",
  };
}

export type MatchRow = { id: string; groupId: string; communityId: string | null; status: "SCHEDULED" | "COMPLETED" | "CANCELED"; date: Date; startTime: string | null; attendanceClosedAt: Date | null; attendanceDeadlineAt: Date | null };

/** Why a match can't take RSVP emails now (null = it can). Shared with the send path. */
export async function matchRefusal(groupId: string, match: MatchRow, now: Date, db: Db = prisma): Promise<PreviewRefusal | null> {
  if ((await attendanceMode(groupId, match.id, db as Prisma.TransactionClient)) === "telegram") return "TELEGRAM_MATCH";
  if (match.status === "CANCELED") return "MATCH_CANCELED";
  if (match.status === "COMPLETED") return "MATCH_COMPLETED";
  if (match.attendanceClosedAt) return "ATTENDANCE_CLOSED";
  if (match.attendanceDeadlineAt && match.attendanceDeadlineAt.getTime() <= now.getTime()) return "DEADLINE_PASSED";
  return null;
}

export const MATCH_SELECT = { id: true, groupId: true, communityId: true, status: true, date: true, startTime: true, attendanceClosedAt: true, attendanceDeadlineAt: true } as const;

export type ClassifiedRow = { playerId: string; name: string; status: PreviewStatus; recipient: Recipient };

/**
 * Classify the match's roster (shared by the preview and the send path). `capacity` is
 * how many sendable recipients still fit; beyond it they are OVER_LIMIT. Rows come back
 * in a deterministic order (first name, last name, id).
 */
export async function classifyRoster(organizationId: string, match: MatchRow, capacity: number, db: Db = prisma): Promise<{ rows: ClassifiedRow[]; notOnRoster: Array<{ playerId: string; name: string }> }> {
  const groupId = match.groupId;
  const roster = await matchRosterIds(match);
  const [players, attendance, inFlight] = await Promise.all([
    db.player.findMany({ where: { groupId }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }], select: { id: true, firstName: true, lastName: true } }),
    db.attendanceResponse.findMany({ where: { matchId: match.id, groupId }, select: { playerId: true, participantStatus: true, overrideStatus: true } }),
    db.rsvpInvitation.findMany({ where: { matchId: match.id, status: { in: ["QUEUED", "SENDING"] }, playerId: { not: null } }, select: { playerId: true } }),
  ]);
  const pending = new Set(inFlight.map((i) => i.playerId));
  const onRoster = players.filter((p) => roster.has(p.id));
  const recipients = await loadRecipients(groupId, onRoster.map((p) => p.id));
  const answers = new Map(attendance.map((a) => [a.playerId, a]));
  const addresses = [...recipients.values()].flatMap((r) => (r.kind === "CONTACT" || r.kind === "ACCOUNT" ? [r.email] : []));
  const suppressed = await suppressedFor(organizationId, addresses);
  let sendable = 0;
  const rows = onRoster.map((p): ClassifiedRow => {
    const recipient = recipients.get(p.id) ?? ({ kind: "NO_EMAIL" } as Recipient);
    const a = answers.get(p.id);
    let status: PreviewStatus;
    if (a?.overrideStatus) status = "ORGANIZER_OVERRIDE";
    else if (a?.participantStatus) status = "ALREADY_ANSWERED";
    else if (pending.has(p.id)) status = "IN_PROGRESS";
    else if (recipient.kind === "INVALID_CONTACT") status = "INVALID_CONTACT";
    else if (recipient.kind === "UNCONFIRMED_CONTACT") status = "CONTACT_UNCONFIRMED";
    else if (recipient.kind === "NO_EMAIL") status = "NO_EMAIL";
    else if (suppressed.has(recipient.email)) status = "SUPPRESSED";
    else status = ++sendable > capacity ? "OVER_LIMIT" : "WILL_SEND";
    return { playerId: p.id, name: fullName(p), status, recipient };
  });
  return { rows, notOnRoster: players.filter((p) => !roster.has(p.id)).map((p) => ({ playerId: p.id, name: fullName(p) })) };
}

const destination = (r: Recipient): { source: DestinationSource | null; maskedEmail: string | null } =>
  r.kind === "CONTACT" ? { source: r.contactType as PlayerContactType, maskedEmail: maskEmail(r.email) } : r.kind === "ACCOUNT" ? { source: "ACCOUNT", maskedEmail: maskEmail(r.email) } : r.kind === "UNCONFIRMED_CONTACT" ? { source: r.contactType, maskedEmail: null } : { source: null, maskedEmail: null };

export async function previewRsvpRecipients(context: TenantContext, matchId: string, now: Date = new Date()): Promise<{ ok: true; preview: RsvpPreview } | { ok: false; code: PreviewRefusal }> {
  requireRole(context, [...MANAGERS]);
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: MATCH_SELECT });
  if (!match) return { ok: false, code: "NOT_FOUND" };
  const refusal = await matchRefusal(match.groupId, match, now);
  if (refusal) return { ok: false, code: refusal };

  const allowance = await rsvpAllowance(context.organization.id, now);
  const { rows, notOnRoster } = await classifyRoster(context.organization.id, match, Math.min(allowance.day.remaining, allowance.month.remaining));
  const recipients: PreviewRow[] = rows.map((r) => ({ playerId: r.playerId, name: r.name, status: r.status, ...destination(r.recipient) }));

  const byStatus = Object.fromEntries((["WILL_SEND", "NO_EMAIL", "INVALID_CONTACT", "CONTACT_UNCONFIRMED", "IN_PROGRESS", "ALREADY_ANSWERED", "ORGANIZER_OVERRIDE", "NOT_ON_ROSTER", "SUPPRESSED", "OVER_LIMIT"] as const).map((s) => [s, 0])) as Record<PreviewStatus, number>;
  for (const r of recipients) byStatus[r.status]++;
  byStatus.NOT_ON_ROSTER = notOnRoster.length;

  return {
    ok: true,
    preview: {
      match: { id: match.id, date: match.date.toISOString().slice(0, 10), startTime: match.startTime },
      recipients,
      notOnRoster: notOnRoster.map((p) => ({ ...p, status: "NOT_ON_ROSTER" as const })),
      counts: { willSend: byStatus.WILL_SEND, excluded: recipients.length - byStatus.WILL_SEND, byStatus, overLimitIsProvisional: true },
      allowance,
      suppression: { available: true },
      sending: { available: rsvpDeliveryMode() === "test-outbox" },
    },
  };
}
