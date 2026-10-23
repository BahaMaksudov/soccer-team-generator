import type { AttendanceStatus, RsvpDeliveryStatus, RsvpSendKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { effectiveAttendance, type AttendanceRow } from "@/lib/attendance";
import { effectiveClosedAt } from "@/lib/attendanceDeadline";
import { maskEmail } from "@/lib/emailAddress";
import { suppressedFor } from "@/lib/emailSuppression";
import { RSVP_MAX_ATTEMPTS, rsvpDeliveryMode } from "@/lib/rsvpSend";

/**
 * M13B P5 — the organizer's RSVP email DELIVERY DASHBOARD for one match (OWNER/ADMIN).
 * Read-only. Delivery status (did the email leave?) and RSVP status (did the player
 * answer?) are reported SEPARATELY — an accepted email is not an answer, and an answer
 * can come from any channel. "Accepted" means the provider (in P5: the test outbox)
 * accepted the message — never proof that it reached an inbox. Destinations are masked.
 */
export type DeliveryCounts = Record<"queued" | "processing" | "accepted" | "failed" | "uncertain" | "skipped", number>;
export type RsvpCounts = { yes: number; maybe: number; no: number; unanswered: number };
export type StatusRow = {
  playerId: string | null;
  name: string;
  maskedEmail: string | null;
  recipientType: "PLAYER" | "GUARDIAN" | "ACCOUNT" | null;
  round: number;
  delivery: RsvpDeliveryStatus;
  skipReason: string | null;
  attempts: number;
  /** P6 timestamps (ISO): queued (reserved), last attempt (claimed), accepted, failed. */
  at: { queued: string | null; lastAttempt: string | null; accepted: string | null; failed: string | null };
  /** P6: the address is now suppressed / opted out for this organization (e.g. a later bounce or unsubscribe). */
  suppressedNow: boolean;
  rsvp: AttendanceStatus | null;
  rsvpSetByOrganizer: boolean;
};
export type RsvpStatusView = {
  mode: "test-outbox" | "live" | "disabled";
  sends: Array<{ id: string; round: number; kind: RsvpSendKind; createdAt: string; counts: DeliveryCounts; retryable: number }>;
  /** Latest round each player appears in (not SKIPPED where an earlier round reached them). */
  recipients: StatusRow[];
  totals: { delivery: DeliveryCounts; rsvp: RsvpCounts; inProgress: boolean; uncertain: number };
};

const KEY: Record<RsvpDeliveryStatus, keyof DeliveryCounts> = { QUEUED: "queued", SENDING: "processing", SENT: "accepted", FAILED: "failed", UNCERTAIN: "uncertain", SKIPPED: "skipped" };
const zero = (): DeliveryCounts => ({ queued: 0, processing: 0, accepted: 0, failed: 0, uncertain: 0, skipped: 0 });

export async function rsvpStatusView(context: TenantContext, matchId: string): Promise<RsvpStatusView | null> {
  requireRole(context, ["OWNER", "ADMIN"]);
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: { id: true, attendanceClosedAt: true, attendanceDeadlineAt: true } });
  if (!match) return null;
  const [sends, invitations, attendance] = await Promise.all([
    prisma.rsvpSend.findMany({ where: { matchId: match.id, organizationId: context.organization.id }, orderBy: { round: "asc" }, select: { id: true, round: true, kind: true, createdAt: true } }),
    prisma.rsvpInvitation.findMany({
      where: { matchId: match.id, organizationId: context.organization.id },
      orderBy: [{ round: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        sendId: true,
        playerId: true,
        round: true,
        status: true,
        skipReason: true,
        email: true,
        recipientType: true,
        attempts: true,
        reservedAt: true,
        claimedAt: true,
        sentAt: true,
        failedAt: true,
        player: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.attendanceResponse.findMany({ where: { matchId: match.id }, select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } }),
  ]);
  const closedAt = effectiveClosedAt(match);
  const answers = new Map(attendance.map((a) => [a.playerId, effectiveAttendance(a as AttendanceRow, closedAt)]));

  const perSend = new Map(sends.map((s) => [s.id, { counts: zero(), retryable: 0 }]));
  const latest = new Map<string, (typeof invitations)[number]>();
  for (const inv of invitations) {
    const s = perSend.get(inv.sendId)!;
    s.counts[KEY[inv.status]]++;
    if (inv.status === "FAILED" && inv.attempts < RSVP_MAX_ATTEMPTS) s.retryable++;
    const key = inv.playerId ?? `removed:${inv.sendId}:${latest.size}`;
    const prev = latest.get(key);
    // A later round's SKIPPED row (e.g. answered meanwhile) doesn't hide an earlier delivery.
    if (!prev || inv.status !== "SKIPPED" || prev.status === "SKIPPED") latest.set(key, inv);
  }

  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const nowSuppressed = await suppressedFor(context.organization.id, [...latest.values()].flatMap((i) => (i.email ? [i.email] : [])));
  const recipients: StatusRow[] = [...latest.values()].map((inv) => {
    const a = inv.playerId ? answers.get(inv.playerId) : undefined;
    return {
      playerId: inv.playerId,
      name: inv.player ? `${inv.player.firstName} ${inv.player.lastName}`.trim() : "Removed player",
      maskedEmail: inv.email ? maskEmail(inv.email) : null,
      recipientType: inv.recipientType,
      round: inv.round,
      delivery: inv.status,
      skipReason: inv.skipReason,
      attempts: inv.attempts,
      at: { queued: iso(inv.reservedAt), lastAttempt: iso(inv.claimedAt), accepted: iso(inv.sentAt), failed: iso(inv.failedAt) },
      suppressedNow: inv.email ? nowSuppressed.has(inv.email) : false,
      rsvp: a?.status ?? null,
      rsvpSetByOrganizer: a?.overridden ?? false,
    };
  });
  recipients.sort((x, y) => x.name.localeCompare(y.name));

  const delivery = zero();
  const rsvp: RsvpCounts = { yes: 0, maybe: 0, no: 0, unanswered: 0 };
  for (const r of recipients) {
    delivery[KEY[r.delivery]]++;
    if (r.delivery === "SKIPPED" || !r.playerId) continue; // RSVP totals: players an email was meant for
    if (r.rsvp === "PLAYING") rsvp.yes++;
    else if (r.rsvp === "MAYBE") rsvp.maybe++;
    else if (r.rsvp === "NOT_PLAYING") rsvp.no++;
    else rsvp.unanswered++;
  }
  return {
    mode: rsvpDeliveryMode(),
    sends: sends.map((s) => ({ id: s.id, round: s.round, kind: s.kind, createdAt: s.createdAt.toISOString(), ...perSend.get(s.id)! })),
    recipients,
    totals: { delivery, rsvp, inProgress: delivery.queued + delivery.processing > 0, uncertain: delivery.uncertain },
  };
}
