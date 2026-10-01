import Link from "next/link";
import { getInvitationPreview } from "@/lib/invitations";
import SignupClient from "./SignupClient";

/**
 * M5 — self-service sign-up. With ?invite=<token> the email is fixed to
 * the invitation's (read-only here, and ignored by the server anyway)
 * and the invitation is accepted as part of account creation.
 */
type SearchParams = Promise<{ invite?: string | string[] }>;

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).invite;
  const inviteToken = typeof raw === "string" && raw ? raw : null;

  if (!inviteToken) return <SignupClient invite={null} />;

  const preview = await getInvitationPreview(inviteToken);
  if (preview.status !== "valid") {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6">
        <div className="w-full max-w-sm border rounded-xl p-6 bg-white space-y-3">
          <h1 className="text-xl font-semibold">Invitation unavailable</h1>
          <p className="text-sm text-gray-600">
            {preview.status === "expired"
              ? "This invitation has expired. Ask the organization owner for a new one."
              : preview.status === "used"
                ? "This invitation has already been used."
                : "This invitation link is not valid."}
          </p>
          <Link className="text-sm underline" href="/signup">
            Create an account without an invitation
          </Link>
        </div>
      </div>
    );
  }

  return (
    <SignupClient
      invite={{ token: inviteToken, email: preview.email, organizationName: preview.organizationName }}
    />
  );
}
