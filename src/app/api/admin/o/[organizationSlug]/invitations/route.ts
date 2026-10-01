import { NextResponse } from "next/server";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createAndSendInvitation, createInvitationSchema, listOrganizationMembers } from "@/lib/invitations";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M5 — OWNER-only members/invitations for the URL-selected Organization
 * (membership-verified server-side; non-members and non-OWNERs get the
 * same generic 404). The Organization always comes from the resolved
 * context — a body organizationId is ignored.
 *
 * The invitation link is delivered by email (Resend in production).
 * Outside production the response also includes the invitation path for
 * local testing; in production the raw token is never returned or
 * logged — it exists only in the email.
 */
type Params = Promise<{ organizationSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireOrganizationContextForSlug(await params);
    return NextResponse.json(await listOrganizationMembers(context));
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const context = await requireOrganizationContextForSlug(await params);
    const parsed = createInvitationSchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

    const result = await createAndSendInvitation(context, parsed.data);
    if (!result.ok) {
      if (result.code === "EMAIL_DELIVERY_FAILED") {
        return NextResponse.json(
          { error: "The invitation email could not be sent, so no invitation was created. Please try again." },
          { status: 502 }
        );
      }
      return NextResponse.json({ error: "That person is already a member of this organization." }, { status: 409 });
    }
    return NextResponse.json(
      {
        ok: true,
        invitation: result.invitation,
        invitePath: process.env.NODE_ENV === "production" ? null : `/invite/${result.token}`,
      },
      { status: 201 }
    );
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
