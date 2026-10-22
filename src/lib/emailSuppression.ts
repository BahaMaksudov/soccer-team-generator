import { Prisma, type EmailOptOutSource, type GlobalSuppressionReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { maskEmail, normalizeEmail } from "@/lib/emailAddress";
import { appUrl } from "@/lib/email/config";

/**
 * M13B P3 — RSVP email suppression and unsubscribe. Applies ONLY to RSVP invitation
 * emails; account, password-reset and security emails never consult it.
 *
 *   GlobalEmailSuppression  — hard bounce / spam complaint: no RSVP email to the address
 *                             from any organization (recorded by the P7 webhook / manually).
 *   OrganizationEmailOptOut — the recipient opted out of ONE organization's RSVP emails.
 *
 * Unsubscribe token: 32 random bytes (base64url), only its SHA-256 stored, bound to one
 * (organization, normalized address, purpose). Issued per email by the sending engine
 * (P4) — independent of invitation records. Long-lived (UNSUBSCRIBE_TOKEN_TTL_DAYS) so an
 * old email still works; using it is idempotent (the opt-out is a unique row; replays
 * change nothing). Two flows:
 *   - website: /unsubscribe#<token> (fragment — never in a request URL) shows what will
 *     happen; ONLY an explicit confirmation (same-origin JSON POST) opts out;
 *   - RFC 8058 one-click: the mail provider POSTs "List-Unsubscribe=One-Click" to
 *     /api/email/unsubscribe/one-click?t=<token> — no page, no cookies. GET never mutates.
 * Responses never reveal whether an address exists; addresses and tokens are never logged.
 */
export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
export const UNSUBSCRIBE_PAGE_PATH = "/unsubscribe";
export const ONE_CLICK_PATH = "/api/email/unsubscribe/one-click";

/** P4: issue the unsubscribe token for one RSVP email. The raw token is returned once (put it in the email only). */
export async function issueUnsubscribeToken(organizationId: string, email: string, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_MS);
  await prisma.emailUnsubscribeToken.create({ data: { organizationId, email: normalizeEmail(email), tokenHash: hashToken(token), createdAt: now, expiresAt } });
  return { token, expiresAt };
}

/** The two links an RSVP email carries (absolute, on APP_BASE_URL). */
export function unsubscribeLinks(token: string, env: Record<string, string | undefined> = process.env): { page: string; oneClick: string } {
  return { page: appUrl(`${UNSUBSCRIBE_PAGE_PATH}#${token}`, env), oneClick: appUrl(`${ONE_CLICK_PATH}?t=${encodeURIComponent(token)}`, env) };
}

/** RFC 8058 headers for an RSVP email (the transport sends them; DKIM covers them). */
export function oneClickUnsubscribeHeaders(oneClickUrl: string): Record<string, string> {
  return { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

type TokenState = "valid" | "used" | "expired" | "invalid";
type TokenRow = { id: string; organizationId: string; email: string; expiresAt: Date; usedAt: Date | null; organization: { name: string } };

async function findToken(token: unknown): Promise<TokenRow | null> {
  if (!isWellFormedToken(token)) return null;
  return prisma.emailUnsubscribeToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, organizationId: true, email: true, expiresAt: true, usedAt: true, organization: { select: { name: true } } },
  });
}
const stateOf = (t: TokenRow | null, now: Date): TokenState => (!t ? "invalid" : t.usedAt ? "used" : t.expiresAt <= now ? "expired" : "valid");

export type UnsubscribePreview = { state: "valid" | "used"; organizationName: string; maskedEmail: string } | { state: "expired" | "invalid" };

/** Read-only, for the confirmation page: what WOULD happen. Changes nothing. */
export async function unsubscribePreview(token: unknown, now: Date = new Date()): Promise<UnsubscribePreview> {
  const t = await findToken(token);
  const state = stateOf(t, now);
  if (!t || state === "invalid" || state === "expired") return { state: state === "expired" ? "expired" : "invalid" };
  return { state, organizationName: t.organization.name, maskedEmail: maskEmail(t.email) };
}

export type ConfirmResult = { ok: true; alreadyUnsubscribed: boolean } | { ok: false; state: "invalid" | "expired" };

/**
 * Opt the token's address out of the token's organization's RSVP emails. Idempotent and
 * concurrency-safe: the opt-out is one unique row (insert-or-nothing); the token's first
 * use is recorded; a replayed / already-used token returns ok without changing anything.
 */
export async function confirmUnsubscribe(token: unknown, source: EmailOptOutSource, now: Date = new Date()): Promise<ConfirmResult> {
  const t = await findToken(token);
  const state = stateOf(t, now);
  if (!t || state === "invalid") return { ok: false, state: "invalid" };
  if (state === "expired") return { ok: false, state: "expired" };
  const inserted = await prisma.organizationEmailOptOut.createMany({ data: [{ organizationId: t.organizationId, email: t.email, source, optedOutAt: now }], skipDuplicates: true });
  await prisma.emailUnsubscribeToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: now } });
  return { ok: true, alreadyUnsubscribed: inserted.count === 0 };
}

/** P7 / manual: record a global suppression (idempotent; the first reason is kept). */
export async function recordGlobalSuppression(email: string, reason: GlobalSuppressionReason, source: string): Promise<void> {
  try {
    await prisma.globalEmailSuppression.create({ data: { email: normalizeEmail(email), reason, source } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
}

/**
 * Which of these addresses must NOT get this organization's RSVP emails: globally
 * suppressed (any reason) or opted out of THIS organization. Returns normalized
 * addresses only — never a reason, and never another organization's opt-outs.
 */
export async function suppressedFor(organizationId: string, emails: string[]): Promise<Set<string>> {
  const normalized = [...new Set(emails.map(normalizeEmail))];
  if (normalized.length === 0) return new Set();
  const [global, org] = await Promise.all([
    prisma.globalEmailSuppression.findMany({ where: { email: { in: normalized } }, select: { email: true } }),
    prisma.organizationEmailOptOut.findMany({ where: { organizationId, email: { in: normalized } }, select: { email: true } }),
  ]);
  return new Set([...global, ...org].map((r) => r.email));
}
