import Link from "next/link";
import { getInvitationPreview } from "@/lib/invitations";
import { requireSessionAccount, type SessionAccount } from "@/lib/tenantContext";
import AcceptInvitation from "./AcceptInvitation";

/**
 * M5 — invitation landing page. Read-only: viewing never consumes the
 * invitation; acceptance is an explicit POST (/api/invitations/accept),
 * offered only to the signed-in, email-verified, matching account.
 */
type Params = Promise<{ token: string }>;

export default async function InvitePage({ params }: { params: Params }) {
  const { token } = await params;
  const preview = await getInvitationPreview(token);
  const account: SessionAccount | null = await requireSessionAccount().catch(() => null);
  const sessionEmail = account?.email ?? null;
  const here = `/invite/${encodeURIComponent(token)}`;

  let body: React.ReactNode;
  if (preview.status === "invalid") {
    body = <p className="text-sm text-gray-600">This invitation link is not valid.</p>;
  } else if (preview.status === "used") {
    body = <p className="text-sm text-gray-600">This invitation has already been used.</p>;
  } else if (preview.status === "expired") {
    body = <p className="text-sm text-gray-600">This invitation has expired. Ask the organization owner for a new one.</p>;
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          You have been invited to join <span className="font-semibold">{preview.organizationName}</span> as{" "}
          <span className="font-semibold">{preview.role}</span>. The invitation is for{" "}
          <span className="font-semibold">{preview.email}</span>.
        </p>
        {!sessionEmail ? (
          <div className="flex flex-wrap gap-2">
            <Link className="bg-black text-white rounded-md px-4 py-2 text-sm" href={`/login?callbackUrl=${encodeURIComponent(here)}`}>
              Sign in to accept
            </Link>
            <Link className="border rounded-md px-4 py-2 text-sm" href={`/signup?invite=${encodeURIComponent(token)}`}>
              Create an account
            </Link>
          </div>
        ) : sessionEmail !== preview.email ? (
          <p className="text-sm text-red-600">
            You are signed in as {sessionEmail}, but this invitation was sent to a different email address. Sign out and
            sign in with the invited account to accept it.
          </p>
        ) : !account?.emailVerified ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">
              Verify your email address first. After verifying you&apos;ll come back here to accept the invitation.
            </p>
            <Link className="bg-black text-white rounded-md px-4 py-2 text-sm inline-block" href={`/verify-email?next=${encodeURIComponent(here)}`}>
              Verify email
            </Link>
          </div>
        ) : (
          <AcceptInvitation token={token} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-md border rounded-xl p-6 bg-white space-y-3">
        <h1 className="text-xl font-semibold">Invitation</h1>
        {body}
      </div>
    </div>
  );
}
