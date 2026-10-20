import { NextResponse } from "next/server";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { requireSessionAccount } from "@/lib/tenantContext";
import { joinPreview } from "@/lib/groupJoin";

/**
 * M13A — preview a group invitation (/join#<token>). The token comes in the JSON
 * body (the page reads it from the URL fragment), so it never appears in a request
 * URL or access log, and it is never logged. Shows the Group's name only — never
 * the roster — plus the signed-in viewer's OWN standing. An unknown token is a 404;
 * expired / revoked links reveal nothing about the Group.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("join-read", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const account = await requireSessionAccount().catch(() => null);
    const preview = await joinPreview(body?.token, account ? { id: account.id, email: account.email, name: account.name, emailVerified: account.emailVerified } : null);
    return NextResponse.json(preview, { status: preview.state === "invalid" ? 404 : 200, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
