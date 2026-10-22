import type { PlayerContactType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { attendanceMode } from "@/lib/attendanceClosure";
import { matchRosterIds } from "@/lib/personalAttendance";
import { loadRecipients, type Recipient } from "@/lib/playerContact";
import { organizationPlan, utcDay, utcMonth, type EffectivePlan } from "@/lib/entitlements";

/**
 * M13B P2 — RSVP invitation RECIPIENT PREVIEW (OWNER/ADMIN). Strictly read-only:
 * no email, no invitation / send record, no RSVP link or token, no attendance or
 * override change, no usage counted. Website-only matches only (a Telegram match
 * is answered in its poll — 409 TELEGRAM_MATCH), and only while attendance is open.
 *
 * Every player on the match's eligible roster (the same roster as personal
 * attendance links) is classified, in this order:
 *   ORGANIZER_OVERRIDE  — an organizer set the status (never re-asked)
 *   ALREADY_ANSWERED    — the player answered (any channel)
 *   INVALID_CONTACT     — the stored organizer contact no longer validates (no fallback)
 *   NO_EMAIL            — no contact and no verified linked-account email
 *   SUPPRESSED          — reserved for P3 (no suppression list exists yet; never assigned)
 *   OVER_LIMIT          — sendable, but beyond today's / this month's allowance
 *   WILL_SEND           — sendable
 * Group players who are NOT on this match's roster are listed separately
 * (names only, NOT_ON_ROSTER) and never counted as recipients.
 * Destinations are masked ("p•••@example.com"); full addresses never leave the server.
 */
export type PreviewStatus = "WILL_SEND" | "NO_EMAIL" | "INVALID_CONTACT" | "ALREADY_ANSWERED" | "ORGANIZER_OVERRIDE" | "NOT_ON_ROSTER" | "SUPPRESSED" | "OVER_LIMIT";
export type DestinationSource = "PLAYER" | "GUARDIAN" | "ACCOUNT";

export type PreviewRow = {
  playerId: string;
  name: string;
  status: PreviewStatus;
  source: DestinationSource | null;
  maskedEmail: string | null;
};

export type RsvpAllowance = {
  plan: EffectivePlan;
  day: { limit: number; period: string; resetsAt: string };
  month: { limit: number; period: string; resetsAt: string };
  /**
   * Actual usage needs the sending ledger (P4). Until then usage is UNKNOWN —
   * never reported as zero — and the preview's OVER_LIMIT marks only recipients
   * beyond the allowance itself (provisional).
   */
  usage: { available: false; note: string };
};

export type RsvpPreview = {
  match: { id: string; date: string; startTime: string | null };
  recipients: PreviewRow[];
  notOnRoster: Array<{ playerId: string; name: string; status: "NOT_ON_ROSTER" }>;
  counts: { willSend: number; excluded: number; byStatus: Record<PreviewStatus, number> };
  allowance: RsvpAllowance;
  suppression: { available: false };
  sending: { available: false };
};

export type PreviewRefusal = "NOT_FOUND" | "TELEGRAM_MATCH" | "MATCH_CANCELED" | "MATCH_COMPLETED" | "ATTENDANCE_CLOSED" | "DEADLINE_PASSED";

const MANAGERS = ["OWNER", "ADMIN"] as const;
const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

/** "pat.smith@example.com" → "p•••@example.com" (domain kept so organizers can sanity-check it). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••@${email.slice(at + 1)}`;
}

/** The organization's RSVP allowance windows (UTC calendar day / month). Usage unknown until P4. */
export async function rsvpAllowance(organizationId: string, now: Date = new Date()): Promise<RsvpAllowance> {
  const { plan, limits } = await organizationPlan(organizationId, now);
  const day = utcDay(now);
  const month = utcMonth(now);
  return {
    plan,
    day: { limit: limits.rsvpEmailsPerDay, period: day.period, resetsAt: day.next.toISOString() },
    month: { limit: limits.rsvpEmailsPerMonth, period: month.period, resetsAt: month.next.toISOString() },
    usage: { available: false, note: "Emails already sent today / this month aren't tracked until sending exists, so the remaining allowance is provisional." },
  };
}

const source = (r: Recipient): { source: DestinationSource | null; maskedEmail: string | null } =>
  r.kind === "CONTACT" ? { source: r.contactType as PlayerContactType, maskedEmail: maskEmail(r.email) } : r.kind === "ACCOUNT" ? { source: "ACCOUNT", maskedEmail: maskEmail(r.email) } : { source: null, maskedEmail: null };

export async function previewRsvpRecipients(context: TenantContext, matchId: string, now: Date = new Date()): Promise<{ ok: true; preview: RsvpPreview } | { ok: false; code: PreviewRefusal }> {
  requireRole(context, [...MANAGERS]);
  const groupId = context.activeGroup.id;
  const match = await prisma.match.findFirst({
    where: { id: matchId, groupId },
    select: { id: true, groupId: true, communityId: true, status: true, date: true, startTime: true, attendanceClosedAt: true, attendanceDeadlineAt: true },
  });
  if (!match) return { ok: false, code: "NOT_FOUND" };
  if ((await attendanceMode(groupId, match.id)) === "telegram") return { ok: false, code: "TELEGRAM_MATCH" };
  if (match.status === "CANCELED") return { ok: false, code: "MATCH_CANCELED" };
  if (match.status === "COMPLETED") return { ok: false, code: "MATCH_COMPLETED" };
  if (match.attendanceClosedAt) return { ok: false, code: "ATTENDANCE_CLOSED" };
  if (match.attendanceDeadlineAt && match.attendanceDeadlineAt.getTime() <= now.getTime()) return { ok: false, code: "DEADLINE_PASSED" };

  const roster = await matchRosterIds(match);
  const [players, attendance, allowance] = await Promise.all([
    prisma.player.findMany({ where: { groupId }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }], select: { id: true, firstName: true, lastName: true } }),
    prisma.attendanceResponse.findMany({ where: { matchId: match.id, groupId }, select: { playerId: true, participantStatus: true, overrideStatus: true } }),
    rsvpAllowance(context.organization.id, now),
  ]);
  const onRoster = players.filter((p) => roster.has(p.id));
  const recipients = await loadRecipients(groupId, onRoster.map((p) => p.id));
  const answers = new Map(attendance.map((a) => [a.playerId, a]));
  // Provisional: actual usage is unknown until P4, so only the allowance itself can be exceeded here.
  const capacity = Math.min(allowance.day.limit, allowance.month.limit);
  let sendable = 0;

  const rows: PreviewRow[] = onRoster.map((p) => {
    const r = recipients.get(p.id) ?? ({ kind: "NO_EMAIL" } as Recipient);
    const a = answers.get(p.id);
    const dest = source(r);
    let status: PreviewStatus;
    if (a?.overrideStatus) status = "ORGANIZER_OVERRIDE";
    else if (a?.participantStatus) status = "ALREADY_ANSWERED";
    else if (r.kind === "INVALID_CONTACT") status = "INVALID_CONTACT";
    else if (r.kind === "NO_EMAIL") status = "NO_EMAIL";
    else status = ++sendable > capacity ? "OVER_LIMIT" : "WILL_SEND";
    return { playerId: p.id, name: fullName(p), status, ...dest };
  });

  const byStatus = Object.fromEntries((["WILL_SEND", "NO_EMAIL", "INVALID_CONTACT", "ALREADY_ANSWERED", "ORGANIZER_OVERRIDE", "NOT_ON_ROSTER", "SUPPRESSED", "OVER_LIMIT"] as const).map((s) => [s, 0])) as Record<PreviewStatus, number>;
  for (const r of rows) byStatus[r.status]++;
  const notOnRoster = players.filter((p) => !roster.has(p.id)).map((p) => ({ playerId: p.id, name: fullName(p), status: "NOT_ON_ROSTER" as const }));
  byStatus.NOT_ON_ROSTER = notOnRoster.length;

  return {
    ok: true,
    preview: {
      match: { id: match.id, date: match.date.toISOString().slice(0, 10), startTime: match.startTime },
      recipients: rows,
      notOnRoster,
      counts: { willSend: byStatus.WILL_SEND, excluded: rows.length - byStatus.WILL_SEND, byStatus },
      allowance,
      suppression: { available: false },
      sending: { available: false },
    },
  };
}

/**
 * P4 design (not implemented): quota enforcement happens server-side inside the send
 * transaction, under a per-organization advisory lock, against the RsvpInvitation
 * ledger for the current UTC day and month:
 *   counts toward usage   — QUEUED / SENDING (reserved), SENT, UNCERTAIN (may have been delivered);
 *   does not count        — FAILED (provider definitely rejected), SKIPPED (never attempted);
 *   remaining = limit − counted; a send reserves its recipients atomically and marks
 *   any beyond the remainder SKIPPED / LIMIT (402 PLAN_LIMIT when nothing fits).
 * Interface: `reserveRsvpQuota(tx, organizationId, requested, now) → { granted, remaining: { day, month } }`.
 */
