import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cronAuth";
import { billingConfig } from "@/lib/billing/config";
import { reconcileBilling } from "@/lib/billing/sync";

/**
 * M11.2A — billing reconciliation (independent of match automation): recovers
 * missed webhooks and inconsistent projections from Stripe's current state.
 * Same fail-closed CRON_SECRET bearer auth as /api/cron/automation; 503 when
 * billing is not enabled. Counts only in the response.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = authorizeCron(req);
  if (auth === "not_configured") return NextResponse.json({ ok: false, error: "Not configured." }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!billingConfig().enabled) return NextResponse.json({ ok: false, error: "Billing is not enabled." }, { status: 503 });
  try {
    const r = await reconcileBilling();
    return NextResponse.json({ ok: r.failures === 0, ...r }, { status: r.failures === 0 ? 200 : 500 });
  } catch (e) {
    console.error(`[billing] reconcile failed: ${e instanceof Error ? e.message : "error"}`);
    return NextResponse.json({ ok: false, error: "Reconciliation failed." }, { status: 500 });
  }
}
