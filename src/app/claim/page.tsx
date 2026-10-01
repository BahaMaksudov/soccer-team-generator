import { requireSessionAccount } from "@/lib/tenantContext";
import ClaimView from "./ClaimView";

/**
 * M6-C — Player claim link landing (/claim#<token>). The token stays in
 * the URL fragment (never sent to the server or in Referer); ClaimView
 * previews it read-only and accepts it only on an explicit POST.
 */
export const metadata = {
  title: "Team Balance Pro — Claim your player profile",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default async function ClaimPage() {
  const account = await requireSessionAccount().catch(() => null);
  return <ClaimView signedIn={Boolean(account)} emailVerified={Boolean(account?.emailVerified)} email={account?.email ?? null} />;
}
