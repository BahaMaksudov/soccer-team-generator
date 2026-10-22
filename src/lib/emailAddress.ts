import { z } from "zod";

/** M5 — canonical email form used for every User/invitation lookup and write. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const emailSchema = z
  .string()
  .trim()
  .max(254, "Email is too long.")
  .email("Enter a valid email address.")
  .transform(normalizeEmail);

/**
 * M13B P1 — an OPTIONAL organizer-entered contact address (player or guardian).
 * Same canonical form as account emails (normalizeEmail: trimmed, lowercased —
 * the application's one documented policy, so later suppression/de-duplication
 * compares like with like). No provider-specific rewriting (Gmail dots and
 * +tags are kept). Control characters — CR/LF included — are rejected anywhere
 * in the raw input, BEFORE trimming, so header-injection payloads can never be
 * "cleaned" into a valid address. Blank input clears the contact.
 */
export const CONTACT_EMAIL_MAX = 254;
const LOCAL_PART_MAX = 64;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

export type ContactEmailParse = { ok: true; email: string | null } | { ok: false; error: string };

export function parseContactEmail(raw: unknown): ContactEmailParse {
  if (raw === null || raw === undefined) return { ok: true, email: null };
  if (typeof raw !== "string") return { ok: false, error: "Enter a valid email address." };
  if (CONTROL_CHARS.test(raw)) return { ok: false, error: "Enter a valid email address." };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, email: null };
  if (trimmed.length > CONTACT_EMAIL_MAX) return { ok: false, error: "Email is too long." };
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || trimmed.slice(0, at).length > LOCAL_PART_MAX || /\s/.test(trimmed)) return { ok: false, error: "Enter a valid email address." };
  if (!z.string().email().safeParse(trimmed).success) return { ok: false, error: "Enter a valid email address." };
  return { ok: true, email: normalizeEmail(trimmed) };
}

/** "pat.smith@example.com" → "p•••@example.com" (domain kept so organizers / recipients can sanity-check it). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••@${email.slice(at + 1)}`;
}
