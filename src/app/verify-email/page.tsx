import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import AuthLayout from "@/components/auth/AuthLayout";
import { StatusCard } from "@/components/auth/parts";
import { requireSessionAccount, TenantContextError } from "@/lib/tenantContext";
import { safeCallbackPath } from "@/lib/safeRedirect";
import ResendVerification from "./ResendVerification";

/**
 * M5 — "Check your email". Where unverified Users land after sign-up and
 * whenever they try to use the app before verifying. `next` (an internal
 * path, e.g. the invitation they came from) is preserved via
 * safeCallbackPath and carried into a resent link.
 * UI-2 — redesigned presentation; same semantics.
 */
type SearchParams = Promise<{ next?: string | string[]; sent?: string | string[] }>;

export const metadata = { title: "Verify your email — Team Balance Pro" };

const HEADLINE = "One quick step before game day.";
const BODY = "Verify your email address to start organizing your groups and matches.";

export default async function CheckEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? safeCallbackPath(sp.next, "") : "";
  const sendFailed = sp.sent === "0";

  let account;
  try {
    account = await requireSessionAccount();
  } catch (e) {
    if (!(e instanceof TenantContextError)) throw e;
    const back = `/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`;
    return (
      <AuthLayout headline={HEADLINE} body={BODY}>
        <StatusCard title="Verify your email">
          <p>Sign in to resend your verification email.</p>
        </StatusCard>
        <Button asChild size="xl" className="mt-6 w-full">
          <Link href={`/login?callbackUrl=${encodeURIComponent(back)}`}>Sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (account.emailVerified) redirect(next || "/admin");

  return (
    <AuthLayout headline={HEADLINE} body={BODY}>
      <StatusCard title="Check your email">
        {sendFailed ? (
          <p className="text-destructive">
            Your account was created, but we couldn&apos;t send the verification email. Use the button below to try again.
          </p>
        ) : (
          <>
            <p>We sent a verification link to</p>
            <p className="break-all font-semibold text-foreground">{account.email}</p>
            <p>Open it to verify your email address. The link expires in 24 hours.</p>
          </>
        )}
      </StatusCard>
      <div className="mt-6 space-y-3">
        <ResendVerification next={next || null} />
        <Button asChild size="xl" variant="ghost" className="w-full">
          <Link href="/login">Back to Sign In</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
