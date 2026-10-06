import Link from "next/link";
import { Button } from "@/components/ui/button";
import AuthLayout from "@/components/auth/AuthLayout";
import { StatusCard } from "@/components/auth/parts";
import { getVerificationPreview } from "@/lib/emailVerification";
import { safeCallbackPath } from "@/lib/safeRedirect";
import VerifyEmailButton from "./VerifyEmailButton";

/**
 * M5 — verification link landing page. READ-ONLY: rendering (including a
 * mail scanner prefetching the URL) never consumes the token; the
 * button sends the explicit POST /api/verify-email.
 * UI-2 — redesigned presentation; same semantics.
 */
type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ next?: string | string[] }>;

export const metadata = { title: "Verify your email — Team Balance Pro" };

export default async function VerifyEmailTokenPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? safeCallbackPath(sp.next, "") : "";
  const preview = await getVerificationPreview(token);
  const resendHref = `/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <AuthLayout headline="One quick step before game day." body="Verify your email address to start organizing your groups and matches.">
      {preview.status === "valid" ? (
        <>
          <StatusCard title="Verify your email">
            <p>Confirm that this is your email address:</p>
            <p className="break-all font-semibold text-foreground">{preview.email}</p>
          </StatusCard>
          <div className="mt-6">
            <VerifyEmailButton token={token} next={next || null} />
          </div>
        </>
      ) : (
        <>
          <StatusCard title="Verify your email" icon={false}>
            <p>
              {preview.status === "used"
                ? "This verification link has already been used."
                : preview.status === "expired"
                  ? "This verification link has expired."
                  : "This verification link is not valid."}
            </p>
          </StatusCard>
          <div className="mt-6 space-y-3">
            <Button asChild size="xl" className="w-full">
              <Link href={preview.status === "used" ? next || "/admin" : resendHref}>{preview.status === "used" ? "Continue" : "Request a new link"}</Link>
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
