import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cronAuth";
import { runMatchAutomation } from "@/lib/matchAutomation";

/**
 * M9.2 — scheduled Match Automation entry point (any scheduler that sends
 * `Authorization: Bearer <CRON_SECRET>`, e.g. Vercel Cron). Fail closed: 503
 * when CRON_SECRET is not configured, 401 for any other caller. Idempotent:
 * every run does only what is due. Never publishes teams.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = authorizeCron(req);
  if (auth === "not_configured") return NextResponse.json({ error: "Automation is not configured." }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const run = await runMatchAutomation(new Date());
  // Counts only (no player data, no ids beyond what a failure needs).
  return NextResponse.json({ ok: true, ...run });
}
