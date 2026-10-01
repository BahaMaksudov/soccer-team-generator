import Link from "next/link";
import { getVerificationPreview } from "@/lib/emailVerification";
import { safeCallbackPath } from "@/lib/safeRedirect";
import VerifyEmailButton from "./VerifyEmailButton";

/**
 * M5 — verification link landing page. READ-ONLY: rendering (including a
 * mail scanner prefetching the URL) never consumes the token; the
 * button sends the explicit POST /api/verify-email.
 */
type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ next?: string | string[] }>;

export default async function VerifyEmailTokenPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? safeCallbackPath(sp.next, "") : "";
  const preview = await getVerificationPreview(token);
  const resendHref = `/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-md border rounded-xl p-6 bg-white space-y-3">
        <h1 className="text-xl font-semibold">Verify your email</h1>
        {preview.status === "valid" ? (
          <>
            <p className="text-sm text-gray-600">
              Confirm that <span className="font-medium">{preview.email}</span> is your email address.
            </p>
            <VerifyEmailButton token={token} next={next || null} />
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              {preview.status === "used"
                ? "This verification link has already been used."
                : preview.status === "expired"
                  ? "This verification link has expired."
                  : "This verification link is not valid."}
            </p>
            <Link className="text-sm underline" href={preview.status === "used" ? next || "/admin" : resendHref}>
              {preview.status === "used" ? "Continue" : "Request a new link"}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
