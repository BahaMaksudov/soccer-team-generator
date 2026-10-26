/**
 * Local-safety guard: ordinary LOCAL processes — unit tests (NODE_ENV=test) and
 * `next dev` (NODE_ENV=development) — never open a connection to a HOSTED
 * database (Neon, including the Production endpoint). Deployed builds and
 * functions run with NODE_ENV=production and are unaffected. An operator who
 * really means to reach a hosted database from a dev/test process must opt in
 * explicitly with TBP_ALLOW_HOSTED_DATABASE=1. The URL is never printed.
 */
export const HOSTED_DATABASE_FRAGMENTS = ["neon.tech", "ep-misty-butterfly"];

export class HostedDatabaseRefusedError extends Error {
  constructor(host: string) {
    super(`Refusing to connect to a hosted database (${host}) from a local ${process.env.NODE_ENV} process. Use a local database, or set TBP_ALLOW_HOSTED_DATABASE=1 deliberately.`);
    this.name = "HostedDatabaseRefusedError";
  }
}

export function assertLocalSafeDatabaseUrl(env: Record<string, string | undefined> = process.env): void {
  const mode = env.NODE_ENV;
  if (mode !== "test" && mode !== "development") return;
  if (env.TBP_ALLOW_HOSTED_DATABASE === "1") return;
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return; // Prisma reports an invalid URL itself
  }
  if (HOSTED_DATABASE_FRAGMENTS.some((f) => host.includes(f))) throw new HostedDatabaseRefusedError(host.replace(/^ep-[a-z0-9-]+/, "ep-<endpoint>"));
}
