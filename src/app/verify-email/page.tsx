import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionAccount, TenantContextError } from "@/lib/tenantContext";
import { safeCallbackPath } from "@/lib/safeRedirect";
import ResendVerification from "./ResendVerification";

/**
 * M5 — "Check your email". Where unverified Users land after sign-up and
 * whenever they try to use the app before verifying. `next` (an internal
 * path, e.g. the invitation they came from) is preserved via
 * safeCallbackPath and carried into a resent link.
 */
type SearchParams = Promise<{ next?: string | string[]; sent?: string | string[] }>;

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
      <Card title="Verify your email">
        <p className="text-sm text-gray-600">Sign in to resend your verification email.</p>
        <Link className="text-sm underline" href={`/login?callbackUrl=${encodeURIComponent(back)}`}>
          Sign in
        </Link>
      </Card>
    );
  }

  if (account.emailVerified) redirect(next || "/admin");

  return (
    <Card title="Check your email">
      {sendFailed ? (
        <p className="text-sm text-red-600">
          Your account was created, but we couldn&apos;t send the verification email. Use the button below to try again.
        </p>
      ) : (
        <p className="text-sm text-gray-600">
          We sent a verification link to <span className="font-medium">{account.email}</span>. Open it to verify your email
          address. The link expires in 24 hours.
        </p>
      )}
      <ResendVerification next={next || null} />
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-md border rounded-xl p-6 bg-white space-y-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}
