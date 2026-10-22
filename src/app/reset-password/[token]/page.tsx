import Link from "next/link";
import { Button } from "@/components/ui/button";
import AuthLayout from "@/components/auth/AuthLayout";
import { FormHead, StatusCard } from "@/components/auth/parts";
import { getPasswordResetPreview } from "@/lib/passwordReset";
import ResetPasswordForm from "./ResetPasswordForm";

/**
 * M11.3 — reset link landing page. READ-ONLY: rendering (including a mail
 * scanner prefetching the URL) never consumes the token; the form sends the
 * explicit POST /api/password/reset. Shows no account data.
 */
type Params = Promise<{ token: string }>;

export const metadata = { title: "Choose a new password — TeamBalance Pro" };

export default async function ResetPasswordPage({ params }: { params: Params }) {
  const { token } = await params;
  const preview = await getPasswordResetPreview(token);
  return (
    <AuthLayout headline="Back in the game in a minute." body="Choose a new password for your account.">
      {preview.status === "valid" ? (
        <>
          <FormHead title="Choose a new password" body="Resetting signs you out on every device; then sign in with the new password." />
          <ResetPasswordForm token={token} />
        </>
      ) : (
        <>
          <StatusCard title="Reset your password" icon={false}>
            <p>
              {preview.status === "used" ? "This reset link has already been used." : preview.status === "expired" ? "This reset link has expired." : "This reset link is not valid."}
            </p>
          </StatusCard>
          <div className="mt-6 space-y-3">
            <Button asChild size="xl" className="w-full">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
            <Button asChild size="xl" variant="ghost" className="w-full">
              <Link href="/login">Back to Sign In</Link>
            </Button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
