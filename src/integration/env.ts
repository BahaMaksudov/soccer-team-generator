import fs from "node:fs";
import path from "node:path";
import { resolveSafeTestDatabaseUrl, databaseUrlFromDotenv } from "./testDatabaseGuard";

/** Guarded TEST_DATABASE_URL, also refusing the DATABASE_URL found in the project's .env. */
export function guardedTestDatabaseUrl(): string {
  const dotenvPath = path.resolve(process.cwd(), ".env");
  const dotenvUrl = fs.existsSync(dotenvPath) ? databaseUrlFromDotenv(fs.readFileSync(dotenvPath, "utf8")) : undefined;
  return resolveSafeTestDatabaseUrl(process.env, [dotenvUrl]);
}
