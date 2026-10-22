import { NextResponse } from "next/server";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { unsubscribePreview } from "@/lib/emailSuppression";

/**
 * M13B P3 — READ-ONLY: what an unsubscribe link would do (organization name and a
 * masked address). The token comes in the JSON body (the page reads it from the URL
 * fragment). Changes nothing. Invalid / expired links get a generic answer.
 */
const HEADERS = { "Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("unsubscribe", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const p = await unsubscribePreview(body?.token);
    return NextResponse.json(p, { status: p.state === "invalid" ? 404 : 200, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
