/**
 * Public legal pages (/privacy, /terms) — the single configuration for them.
 *
 * Every statement in the pages was checked against the code and the Production
 * configuration. Owner decisions that are CONFIRMED are written into the text
 * (and recorded below for the audit trail). Items still PENDING are rendered as
 * visible "Owner to confirm" markers; while ANY item is pending (or the
 * effective date is unset) the pages show a draft banner and are noindex — they
 * must not be treated as a final policy. Resolve an item only when the owner
 * (and, where noted, an attorney) has actually decided it.
 */
export const LEGAL_PATHS = { privacy: "/privacy", terms: "/terms" } as const;

/** Public product name and operating brand (owner-confirmed). No legal-entity claim. */
export const PRODUCT_NAME = "TeamBalance Pro";
export const OPERATING_BRAND = "AYBIA Labs";
/** Privacy, legal and support contact shown on the legal pages (owner-confirmed address). */
export const LEGAL_CONTACT_EMAIL = "support@teambalancepro.com";
/** Governing law (owner-confirmed). No venue, arbitration or class-action clauses. */
export const GOVERNING_LAW = "the Commonwealth of Massachusetts, United States";
/** Minimum age to hold an account (owner-confirmed policy; NOT technically enforced). */
export const ACCOUNT_MIN_AGE = 18;

/**
 * Effective date of BOTH documents: the actual publication date (YYYY-MM-DD),
 * set explicitly during the approved release — never the commit or build date.
 * null = not published yet (the pages show it as pending and stay a draft).
 */
export const LEGAL_EFFECTIVE_DATE: string | null = null;

/** Owner decisions already applied to the text (audit trail; not rendered). */
export const CONFIRMED_DECISIONS = [
  "Operated under the AYBIA Labs brand; the operator is an individual (sole proprietor). No LLC or other entity is claimed.",
  "Contact for privacy, legal and support requests: support@teambalancepro.com.",
  "Accounts are for adults aged 18 or older; organizers may keep player profiles for minors when they have appropriate authority. No age or parental-consent verification exists.",
  "Retention is manual: data is kept as needed to run the service; only the listed security records and tokens expire automatically.",
  "Deletion and correction requests are handled manually by email; identity and authority may be verified; no fixed deadline.",
  "Governing law: Massachusetts, United States (no venue, arbitration or class-action provisions).",
  "Paid billing is not active; Pro subscriptions are planned.",
] as const;

export type OwnerItem = { id: string; label: string };
export const OWNER_ITEMS: readonly OwnerItem[] = [
  { id: "operator-identity", label: "How the individual operator is legally identified in these documents (name and form of public identification)." },
  { id: "mailbox", label: "Confirm that support@teambalancepro.com receives and is monitored for email." },
  { id: "mailing-address", label: "Whether a public mailing address must be published, and which one." },
  { id: "hosting-disclosure", label: "Verify the hosting and data-processing locations (including the Vercel function region) and any cross-border wording you require." },
  { id: "effective-date", label: "Set at publication: the date these documents are published." },
  { id: "attorney-children", label: "Attorney review: information about minors entered by organizers (including COPPA and state-law questions, and visibility of minors' names on Public or link-shared pages)." },
  { id: "attorney-liability", label: "Attorney review: disclaimers, limitation of liability and governing-law wording (including whether a venue clause is needed)." },
  { id: "billing-terms", label: "Before paid subscriptions are enabled: billing, renewal, cancellation and refund terms." },
];

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Draft while any owner item is pending or the effective date is not a valid publication date. */
export const legalIsDraft = (items: readonly OwnerItem[] = OWNER_ITEMS, effectiveDate: string | null = LEGAL_EFFECTIVE_DATE) =>
  items.length > 0 || effectiveDate === null || !isIsoDate(effectiveDate);

/** "November 25, 2026" for a YYYY-MM-DD effective date. */
export const formatEffectiveDate = (v: string) => new Date(`${v}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

/** Absolute canonical URL on APP_BASE_URL (https://teambalancepro.com in Production); the bare path if it isn't a valid origin. */
export function legalCanonical(path: string, env: Record<string, string | undefined> = process.env): string {
  try {
    const base = new URL(env.APP_BASE_URL ?? "");
    return base.protocol === "https:" || base.protocol === "http:" ? `${base.origin}${path}` : path;
  } catch {
    return path;
  }
}
