import { createHash, randomBytes } from "node:crypto";

/**
 * M5 — shared primitives for single-use emailed tokens (invitations,
 * email verification): 32 random bytes as base64url in the link; only
 * the SHA-256 hash is ever stored. A fast hash is appropriate because
 * the token carries 256 bits of entropy — nothing to brute-force.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}
