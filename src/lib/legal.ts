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
/** Privacy, legal and support contact shown on the legal pages (owner-confirmed, operational: forwarded via ImprovMX to the owner's inbox). */
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
export const LEGAL_EFFECTIVE_DATE: string | null = "2026-10-21";

/** Owner decisions already applied to the text (audit trail; not rendered). */
export const CONFIRMED_DECISIONS = [
  "Public product name: TeamBalance Pro.",
  "Operated under the AYBIA Labs brand — a planned business name, not a registered LLC — by an individual. No LLC or other entity is claimed.",
  "Contact for privacy, legal and support requests: support@teambalancepro.com — confirmed operational (forwarded through ImprovMX to the owner's inbox).",
  "Operator identification: 'operated by an individual under the AYBIA Labs brand; AYBIA Labs is a brand name, not a registered company'. The owner's personal legal name is not published.",
  "No mailing address (personal or home) is published; public contact is by email only.",
  "2026-10-21: the owner elected to publish both documents WITHOUT attorney review, accepting the documented unresolved risks: information about minors (COPPA / state law; youth names visible on Public, link-shared and Telegram), international-transfer wording for users outside the US, and disclaimers / limitation of liability / governing law and venue. The documents must never be described as attorney-reviewed.",
  "Accounts are for adults aged 18 or older; organizers may keep player profiles for minors when they have appropriate authority. No age or parental-consent verification exists.",
  "Retention is manual: data is kept as needed to run the service; only the listed security records and tokens expire automatically.",
  "Deletion and correction requests are handled manually by email; identity and authority may be verified; no fixed deadline.",
  "Governing law: Massachusetts, United States (no venue, arbitration or class-action provisions).",
  "Paid billing is not active; Pro subscriptions are planned.",
  "Hosting verified: application functions run in Vercel region iad1 (x-vercel-id on Production responses); database on Neon / AWS us-east-1 (database host). Other providers' processing locations are not verified and are described generically.",
] as const;

/**
 * Open items, by when they must be resolved:
 *   publication    — owner decisions required before the pages are published;
 *   legal-review   — need review by an attorney (none has been done); they keep
 *                    the pages a draft unless the owner explicitly decides otherwise;
 *   billing-launch — required only before paid billing is switched on. They do
 *                    NOT block publishing these pages and are not rendered as
 *                    markers (the Terms already say paid terms will be published
 *                    before paid subscriptions are offered).
 */
export type OwnerItemCategory = "publication" | "legal-review" | "billing-launch";
export type OwnerItem = { id: string; label: string; category: OwnerItemCategory };
export const OWNER_ITEMS: readonly OwnerItem[] = [
  { id: "billing-terms", category: "billing-launch", label: "Before paid subscriptions are enabled: billing, renewal, cancellation and refund terms." },
];

/** Items that keep the legal pages a draft (everything except billing-launch items). */
export const publicationBlockers = (items: readonly OwnerItem[] = OWNER_ITEMS) => items.filter((i) => i.category !== "billing-launch");

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Draft while any publication / legal-review item is pending or the effective date is not a valid publication date. */
export const legalIsDraft = (items: readonly OwnerItem[] = OWNER_ITEMS, effectiveDate: string | null = LEGAL_EFFECTIVE_DATE) =>
  publicationBlockers(items).length > 0 || effectiveDate === null || !isIsoDate(effectiveDate);

/** Verified hosting facts (live x-vercel-id function region; Neon host), recorded 2026-10-21. */
export const HOSTING = {
  appRegion: "Vercel region iad1 (Washington, D.C., United States)",
  databaseRegion: "Neon on Amazon Web Services, US East (N. Virginia, us-east-1)",
} as const;

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
