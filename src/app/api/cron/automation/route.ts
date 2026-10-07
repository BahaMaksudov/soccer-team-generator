import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cronAuth";
import { runMatchAutomation } from "@/lib/matchAutomation";

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
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = authorizeCron(req);
  if (auth === "not_configured") return NextResponse.json({ ok: false, error: "Automation is not configured." }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const { errors, ...counts } = await runMatchAutomation(new Date());
    if (errors.length > 0) console.error(`[automation] run finished with ${errors.length} error(s): ${JSON.stringify(errors)}`);
    return NextResponse.json({ ok: errors.length === 0, ...counts, errorCount: errors.length }, { status: errors.length === 0 ? 200 : 500 });
  } catch (e) {
    console.error(`[automation] run failed: ${e instanceof Error ? e.message : "error"}`);
    return NextResponse.json({ ok: false, error: "Automation run failed." }, { status: 500 });
  }
}
