import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cronAuth";

/**
 * M9.2 — scheduled Match Automation entry point (Vercel Cron, see vercel.json).
 * Fail closed: 503 when CRON_SECRET is not configured, 401 for any other caller.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = authorizeCron(req);
  if (auth === "not_configured") return NextResponse.json({ error: "Automation is not configured." }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, ran: [] });
}
