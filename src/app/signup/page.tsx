import { Button } from "@/components/ui/button";
import Link from "next/link";
import AuthLayout from "@/components/auth/AuthLayout";
import { FormHead } from "@/components/auth/parts";
import { getInvitationPreview } from "@/lib/invitations";
import { isGoogleAuthConfigured } from "@/lib/googleAuth";
import SignupClient from "./SignupClient";
import { safeCallbackPath } from "@/lib/safeRedirect";

/**
 * M5 — self-service sign-up. With ?invite=<token> the email is fixed to
 * the invitation's (read-only here, and ignored by the server anyway)
 * and the invitation is accepted as part of account creation.
 * UI-2 — redesigned presentation; same server semantics. No role picker:
 * a new account has no memberships until onboarding or an invitation.
 */
type SearchParams = Promise<{ invite?: string | string[]; next?: string | string[] }>;

export const metadata = {
  title: "Create Account — Team Balance Pro",
  description: "Create your Team Balance Pro account and set up your first sports group.",
};

const HEADLINE = "Organize better games from day one.";
const BODY = "Create your Team Balance Pro account and set up your first sports group in minutes.";

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const raw = sp.invite;
  const inviteToken = typeof raw === "string" && raw ? raw : null;
  const next = typeof sp.next === "string" ? safeCallbackPath(sp.next, "") : "";
  const googleEnabled = isGoogleAuthConfigured();

  if (!inviteToken) {
    return (
      <AuthLayout headline={HEADLINE} body={BODY}>
        <SignupClient invite={null} next={next || null} googleEnabled={googleEnabled} />
      </AuthLayout>
    );
  }

  const preview = await getInvitationPreview(inviteToken);
  if (preview.status !== "valid") {
    return (
      <AuthLayout headline={HEADLINE} body={BODY}>
        <FormHead
          title="Invitation unavailable"
          body={
            preview.status === "expired"
              ? "This invitation has expired. Ask the organization owner for a new one."
              : preview.status === "used"
                ? "This invitation has already been used."
                : "This invitation link is not valid."
          }
        />
        <Button asChild size="xl" variant="outline" className="w-full">
          <Link href="/signup">Create an account without an invitation</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout headline={HEADLINE} body={BODY}>
      <SignupClient
        invite={{ token: inviteToken, email: preview.email, organizationName: preview.organizationName }}
        googleEnabled={googleEnabled}
      />
    </AuthLayout>
  );
}
