import { NextResponse } from "next/server";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { confirmUnsubscribe } from "@/lib/emailSuppression";

/**
 * M13B P3 — the website unsubscribe CONFIRMATION (the recipient pressed "Unsubscribe"
 * on /unsubscribe). JSON + same-origin only; POST only (GET is not exported: 405).
 * Idempotent. Opts the address out of THIS organization's RSVP invitation emails only —
 * never account or password emails. Never logs the token or address.
 */
const HEADERS = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: HEADERS });
  if (!(await checkRateLimit("unsubscribe", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const r = await confirmUnsubscribe(body?.token, "LINK");
    if (r.ok) return NextResponse.json({ ok: true }, { headers: HEADERS });
    return r.state === "expired"
      ? NextResponse.json({ error: "This unsubscribe link has expired. Use the link in a newer email or contact support@teambalancepro.com.", code: "EXPIRED" }, { status: 410, headers: HEADERS })
      : NextResponse.json({ error: "This unsubscribe link is not valid.", code: "INVALID" }, { status: 404, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
