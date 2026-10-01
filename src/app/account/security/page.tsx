import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionAccount, TenantContextError } from "@/lib/tenantContext";
import ChangePasswordForm from "./ChangePasswordForm";

/**
 * M5.1 — Account security (Change Password). Any signed-in account,
 * with or without an Organization. Shows the account's own email only —
 * never ids, hashes or tokens.
 */
export default async function AccountSecurityPage() {
  let email: string;
  try {
    email = (await requireSessionAccount()).email;
  } catch (e) {
    if (e instanceof TenantContextError) redirect("/login?callbackUrl=%2Faccount%2Fsecurity");
    throw e;
  }

  return (
    <div className="max-w-md mx-auto rounded-2xl border bg-white shadow-sm p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Account security</h1>
        <Link className="text-sm underline" href="/admin">
          Back to workspaces
        </Link>
      </div>
      <p className="text-sm text-gray-600">
        Signed in as <span className="font-medium">{email}</span>
      </p>
      <section className="space-y-3">
        <h2 className="font-semibold">Change password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
