/**
 * M11.3 / M12-A — the optional support contact (SUPPORT_EMAIL). Never invented:
 * when it isn't configured (or is malformed) no contact is shown anywhere.
 * Client-safe (no Prisma / Node imports); read on the server only.
 */
export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.SUPPORT_EMAIL?.trim() ?? "";
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : null;
}
