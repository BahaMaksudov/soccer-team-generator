import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { submitJoinRequest } from "@/lib/groupJoin";

/**
 * M13A — ask to join the invitation's Group. Requires a signed-in user with a
 * VERIFIED email (requireSessionUser → 401 / 403 EMAIL_NOT_VERIFIED); JSON +
 * same-origin only. Creates a PENDING request — never membership: an organizer
 * approves or rejects it. Database-backed limits per user and per Group.
 */
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f<>]/.test(v));
const schema = z.object({ token: z.string().max(100), firstName: name, lastName: name });
const FAILURES: Record<string, [number, string]> = {
  INVITE_INVALID: [404, "This invite link is not valid."],
  INVITE_EXPIRED: [410, "This invite link has expired. Ask the organizer for a new one."],
  INVITE_REVOKED: [410, "This invite link is no longer active. Ask the organizer for a new one."],
  ALREADY_MEMBER: [409, "You're already a member of this group."],
  ALREADY_PENDING: [409, "Your request is already waiting for the organizer's approval."],
  RATE_LIMITED: [429, "Too many requests today. Please try again tomorrow."],
  TOO_MANY_PENDING: [429, "This group has too many pending requests right now. Please try again later or contact the organizer."],
};

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: HEADERS });
  try {
    const user = await requireSessionUser();
    if (!(await checkRateLimit("join-write", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Enter your first and last name." }, { status: 400, headers: HEADERS });
    const result = await submitJoinRequest(user, parsed.data.token, { firstName: parsed.data.firstName, lastName: parsed.data.lastName });
    if (!result.ok) {
      const [status, error] = FAILURES[result.code];
      return NextResponse.json({ error, code: result.code }, { status, headers: HEADERS });
    }
    return NextResponse.json(result, { status: 201, headers: HEADERS });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
