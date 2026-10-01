import { createHash } from "node:crypto";

/**
 * M6-B — pure delivery-state rules for one (event, channel, context),
 * e.g. TEAMS_PUBLISHED → TELEGRAM for one poll. No I/O; the caller
 * evaluates this under a per-context lock, so the decision and the
 * reservation it leads to are atomic with respect to other requests.
 *
 * Guarantees (and limits): at most one reservation (SENDING) at a time;
 * nothing is ever sent automatically after an unknown outcome; a definite
 * provider rejection is retryable. Telegram offers no idempotency key, so
 * an explicit organizer retry after an UNCERTAIN outcome CAN produce a
 * duplicate message — that is why it requires an explicit action.
 */

/** A reservation older than this without a final status is treated as uncertain. */
export const STALE_SENDING_MS = 2 * 60 * 1000;

export const LEGACY_CONTENT_HASH = "legacy";

export type DeliveryRecord = {
  id: string;
  status: "SENDING" | "SENT" | "FAILED" | "UNCERTAIN";
  contentHash: string;
  teamGenerationId: string | null;
  claimedAt: Date;
  sentAt: Date | null;
  createdAt: Date;
};

export type CurrentContent = {
  contentHash: string;
  teamGenerationId: string;
  /** TeamGeneration.updatedAt — bumped by every (re)publish. */
  generationUpdatedAt: Date;
};

export type DeliveryState =
  | { kind: "not_posted" }
  | { kind: "sending"; delivery: DeliveryRecord }
  | { kind: "uncertain"; delivery: DeliveryRecord }
  | { kind: "failed"; delivery: DeliveryRecord }
  | { kind: "posted"; delivery: DeliveryRecord }
  | { kind: "updated_available"; delivery: DeliveryRecord };

export function contentHashOf(messageBody: string): string {
  return createHash("sha256").update(messageBody, "utf8").digest("hex");
}

/**
 * Whether a SENT delivery already carried the current content. Rows
 * copied from the pre-M6-B posting columns have no content hash: they
 * count as the same content only if they posted this generation and the
 * generation has not been republished since.
 */
export function isSameContent(d: DeliveryRecord, current: CurrentContent): boolean {
  if (d.contentHash === LEGACY_CONTENT_HASH) {
    return d.teamGenerationId === current.teamGenerationId && d.sentAt !== null && current.generationUpdatedAt <= d.sentAt;
  }
  return d.contentHash === current.contentHash;
}

export function isStaleSending(d: DeliveryRecord, now: Date): boolean {
  return d.status === "SENDING" && now.getTime() - d.claimedAt.getTime() > STALE_SENDING_MS;
}

/** `deliveries` in any order; the newest (createdAt) decides in-flight/uncertain/failed. */
export function deliveryStateOf(deliveries: DeliveryRecord[], current: CurrentContent, now: Date = new Date()): DeliveryState {
  if (deliveries.length === 0) return { kind: "not_posted" };
  const sorted = [...deliveries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = sorted[0];

  if (latest.status === "SENDING") {
    return isStaleSending(latest, now) ? { kind: "uncertain", delivery: latest } : { kind: "sending", delivery: latest };
  }
  if (latest.status === "UNCERTAIN") return { kind: "uncertain", delivery: latest };

  const sentSame = sorted.find((d) => d.status === "SENT" && isSameContent(d, current));
  if (sentSame) return { kind: "posted", delivery: sentSame };
  if (latest.status === "FAILED") return { kind: "failed", delivery: latest };

  const lastSent = sorted.find((d) => d.status === "SENT");
  return lastSent ? { kind: "updated_available", delivery: lastSent } : { kind: "not_posted" };
}
