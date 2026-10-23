import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cronAuth";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { runTrialLifecycle } from "@/lib/trialLifecycle";
import { processRsvpQueue, rsvpDeliveryMode } from "@/lib/rsvpSend";
import { runRsvpRetention } from "@/lib/rsvpRetention";

/**
 * M9.2 — scheduled Match Automation entry point. The production clock is a
 * GitHub Actions workflow (.github/workflows/match-automation.yml) that POSTs
 * here every 15 minutes with `Authorization: Bearer <CRON_SECRET>`; it only
 * triggers — every due-work decision is made by runMatchAutomation, the same
 * engine as the organizer's "Run now" (shared idempotency).
 *
 * Fail closed: 503 when CRON_SECRET is not configured, 401 for any other
 * caller (no query-string secret). 500 when the run reported failures, so the
 * trigger fails visibly. The body holds counts only (it is printed in the
 * workflow log): no player data, no ids, no error text — details go to the
 * server log. The secret is never logged or returned.
 *
 * M11.3 — the same clock also runs the trial lifecycle (reminder / expiry
 * emails, TRIAL_EXPIRED audit). It is OFF unless TRIAL_LIFECYCLE is "audit" or
 * "send", is independent of match automation (one failing never skips the
 * other) and never decides plan access (that is evaluated on every request).
 *
 * M13B P5 — the same clock continues the RSVP email queue: bounded claims (FOR UPDATE
 * SKIP LOCKED — overlapping runs never take the same invitation) within a time budget,
 * stale SENDING rows recovered as UNCERTAIN, never an automatic retry. Delivery is the
 * test outbox or — only once separately approved — the Production live pilot (allowlisted
 * organizations' rows only); while delivery is disabled (the default, and always in
 * Preview) this part reports { disabled: true } and claims nothing.
 *
 * M13B release — RSVP retention (src/lib/rsvpRetention.ts), OFF unless RSVP_RETENTION_MODE
 * is set: "dry-run" reports counts on every run and changes nothing; "run" removes direct
 * identifiers only in the 03:00–03:14 UTC window (≈ once a day; idempotent, bounded).
 * Counts only in the response. Independent of everything above.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = authorizeCron(req);
  if (auth === "not_configured") return NextResponse.json({ ok: false, error: "Automation is not configured." }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const now = new Date();
  const trial = await trialLifecycleCounts(now);
  const rsvp = await rsvpQueueCounts();
  const retention = await rsvpRetentionCounts(now);
  try {
    const { errors, ...counts } = await runMatchAutomation(now);
    if (errors.length > 0) console.error(`[automation] run finished with ${errors.length} error(s): ${JSON.stringify(errors)}`);
    const ok = errors.length === 0 && trial.ok && rsvp.ok && retention.ok;
    return NextResponse.json({ ok, ...counts, errorCount: errors.length, trial: trial.counts, rsvp: rsvp.counts, retention: retention.counts }, { status: ok ? 200 : 500 });
  } catch (e) {
    console.error(`[automation] run failed: ${e instanceof Error ? e.message : "error"}`);
    return NextResponse.json({ ok: false, error: "Automation run failed.", trial: trial.counts, rsvp: rsvp.counts, retention: retention.counts }, { status: 500 });
  }
}

/** Counts only (printed in the workflow log); details go to the server log. */
async function trialLifecycleCounts(now: Date) {
  try {
    const { errors, ...counts } = await runTrialLifecycle(now);
    if (errors.length > 0) console.error(`[trial] run finished with ${errors.length} error(s): ${JSON.stringify(errors)}`);
    return { ok: errors.length === 0, counts: { ...counts, errorCount: errors.length } };
  } catch (e) {
    console.error(`[trial] run failed: ${e instanceof Error ? e.message : "error"}`);
    return { ok: false, counts: { failed: true } };
  }
}

/** RSVP email queue continuation (counts only). Off — nothing claimed — unless delivery is the local test outbox. */
const RSVP_CRON_BUDGET_MS = 20_000;
const RSVP_CRON_LIMIT = 200;
async function rsvpQueueCounts() {
  if (rsvpDeliveryMode() === "disabled") return { ok: true, counts: { disabled: true } };
  try {
    const run = await processRsvpQueue({ limit: RSVP_CRON_LIMIT, budgetMs: RSVP_CRON_BUDGET_MS });
    return { ok: run.errors === 0, counts: run };
  } catch (e) {
    console.error(`[rsvp] queue run failed: ${e instanceof Error ? e.name : "error"}`);
    return { ok: false, counts: { failed: true } };
  }
}

/** RSVP retention action for this run. Off unless RSVP_RETENTION_MODE is "dry-run" or "run"; "run" acts only 03:00–03:14 UTC. */
function retentionAction(mode: string | undefined, now: Date): "off" | "dry-run" | "run" | "outside-window" {
  if (mode === "dry-run") return "dry-run";
  if (mode !== "run") return "off";
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 15 ? "run" : "outside-window";
}
async function rsvpRetentionCounts(now: Date) {
  const action = retentionAction(process.env.RSVP_RETENTION_MODE?.trim(), now);
  if (action === "off") return { ok: true, counts: { disabled: true } };
  if (action === "outside-window") return { ok: true, counts: { skipped: "outside-window" } };
  try {
    const run = await runRsvpRetention({ now, dryRun: action === "dry-run" });
    return { ok: true, counts: run };
  } catch (e) {
    console.error(`[retention] run failed: ${e instanceof Error ? e.name : "error"}`);
    return { ok: false, counts: { failed: true } };
  }
}
