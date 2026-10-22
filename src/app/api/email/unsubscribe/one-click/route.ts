import { NextResponse } from "next/server";
import { confirmUnsubscribe } from "@/lib/emailSuppression";

/**
 * M13B P3 — RFC 8058 one-click unsubscribe. The recipient's MAIL PROVIDER POSTs here
 * (from the email's List-Unsubscribe / List-Unsubscribe-Post headers, covered by the
 * message's DKIM signature) with exactly "List-Unsubscribe=One-Click" as an
 * application/x-www-form-urlencoded or multipart body; the token is in the URL (`t`).
 * No page, no cookies, no same-origin check (it is not a browser form). POST only:
 * a GET (link scanner, prefetch) is 405 and changes nothing. Idempotent.
 * Never logs the token or the address.
 */
const HEADERS = { "Cache-Control": "no-store, private" };

async function isOneClickBody(req: Request): Promise<boolean> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return false;
  try {
    const form = await req.formData();
    return form.get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!(await isOneClickBody(req))) return NextResponse.json({ error: "Bad request" }, { status: 400, headers: HEADERS });
  const token = new URL(req.url).searchParams.get("t");
  try {
    const r = await confirmUnsubscribe(token, "ONE_CLICK");
    if (r.ok) return NextResponse.json({ ok: true }, { headers: HEADERS });
    return NextResponse.json({ error: r.state === "expired" ? "Expired" : "Not found" }, { status: r.state === "expired" ? 410 : 404, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
