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
