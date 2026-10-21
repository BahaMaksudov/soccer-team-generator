/**
 * Public legal pages (/privacy, /terms). Every statement in them was checked
 * against the code and the Production configuration (no invented facts).
 * Business / legal facts only the owner can supply are listed here; each one is
 * rendered as a visible "Owner to confirm" marker. While ANY item is open the
 * pages show a draft banner and are noindex — they must not be treated as a
 * final policy. Resolve an item by writing the confirmed text into the page and
 * removing it from this list.
 */
export const LEGAL_PATHS = { privacy: "/privacy", terms: "/terms" } as const;

export type OwnerItem = { id: string; label: string };
export const OWNER_ITEMS: readonly OwnerItem[] = [
  { id: "operator", label: "Legal name and type of the operator (person or company) responsible for Team Balance Pro, and its mailing address if one will be published." },
  { id: "contact", label: "Contact email for privacy and legal requests (SUPPORT_EMAIL is not configured in Production, so no address is shown anywhere)." },
  { id: "effective-date", label: "Effective date of both documents." },
  { id: "age", label: "Minimum age to create an account, and the policy for players who are minors (no age check exists in the product today)." },
  { id: "retention", label: "How long accounts, organizations, player records and attendance history are kept after they are no longer used (no automatic deletion exists today except the short-lived security records listed)." },
  { id: "deletion", label: "How account and data deletion requests are handled (there is no self-service account deletion today; requests would be handled manually)." },
  { id: "governing-law", label: "Governing law and venue for disputes." },
  { id: "billing", label: "Cancellation and refund terms for paid Pro subscriptions before paid billing is switched on (billing is not active in Production today)." },
  { id: "liability", label: "Final wording of the disclaimer and limitation-of-liability sections (recommended: review by a lawyer)." },
];

export const legalIsDraft = (items: readonly OwnerItem[] = OWNER_ITEMS) => items.length > 0;

/** Absolute canonical URL on APP_BASE_URL (https://teambalancepro.com in Production); the bare path if it isn't a valid origin. */
export function legalCanonical(path: string, env: Record<string, string | undefined> = process.env): string {
  try {
    const base = new URL(env.APP_BASE_URL ?? "");
    return base.protocol === "https:" || base.protocol === "http:" ? `${base.origin}${path}` : path;
  } catch {
    return path;
  }
}
