import { Prisma, type GlobalSuppressionReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseContactEmail } from "@/lib/emailAddress";

/**
 * M13B P6 — Resend delivery events → GLOBAL suppression (no RSVP email to that address
 * from any organization). Called only AFTER the signature was verified.
 *   email.bounced    — "the recipient's mail server permanently rejected the email"
 *                      (Resend docs; data.bounce.type "Permanent") → HARD_BOUNCE.
 *                      Defensive: a bounce whose type is present and not "Permanent"
 *                      is ignored.
 *   email.complained — delivered, but the recipient marked it as spam → SPAM_COMPLAINT.
 *   anything else    — acknowledged and ignored.
 * Idempotent: the provider event id (svix-id) is recorded once (unique), in the SAME
 * transaction as the suppressions, so a retried / replayed / concurrent duplicate changes
 * nothing; an existing suppression keeps its first reason. Addresses are normalized and
 * never logged or returned; the event record stores no address.
 */
export const RESEND_PROVIDER = "resend";
export type WebhookOutcome = { status: "processed" | "duplicate"; outcome: "SUPPRESSED" | "IGNORED"; recipients: number };

type ResendEvent = { type?: unknown; data?: { to?: unknown; bounce?: { type?: unknown } | null } | null };

function classify(event: ResendEvent): GlobalSuppressionReason | null {
  if (event.type === "email.complained") return "SPAM_COMPLAINT";
  if (event.type === "email.bounced") {
    const kind = event.data?.bounce?.type;
    return kind === undefined || kind === null || kind === "Permanent" ? "HARD_BOUNCE" : null;
  }
  return null;
}

function recipients(event: ResendEvent): string[] {
  const to = event.data?.to;
  const list = Array.isArray(to) ? to : typeof to === "string" ? [to] : [];
  const out = new Set<string>();
  for (const raw of list.slice(0, 50)) {
    const parsed = parseContactEmail(raw);
    if (parsed.ok && parsed.email) out.add(parsed.email);
  }
  return [...out];
}

export async function processResendEvent(eventId: string, event: ResendEvent): Promise<WebhookOutcome> {
  const reason = classify(event);
  const addresses = reason ? recipients(event) : [];
  const outcome = reason && addresses.length > 0 ? "SUPPRESSED" : "IGNORED";
  const type = typeof event.type === "string" ? event.type.slice(0, 64) : "unknown";
  try {
    await prisma.$transaction(async (tx) => {
      await tx.emailWebhookEvent.create({ data: { provider: RESEND_PROVIDER, eventId: eventId.slice(0, 200), type, outcome } });
      if (reason && addresses.length > 0) {
        await tx.globalEmailSuppression.createMany({ data: addresses.map((email) => ({ email, reason, source: "resend-webhook" })), skipDuplicates: true });
      }
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { status: "duplicate", outcome, recipients: addresses.length };
    throw e;
  }
  return { status: "processed", outcome, recipients: addresses.length };
}
