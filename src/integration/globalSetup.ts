import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { guardedTestDatabaseUrl } from "./env";

/**
 * Applies the repo's migrations to the guarded TEST database only.
 * Uses a temporary copy of schema.prisma whose datasource URL is the
 * literal test URL, run from a temp directory with no .env — so the
 * Prisma CLI cannot pick up the production DATABASE_URL.
 */
export default function setup() {
  const url = guardedTestDatabaseUrl();
  const root = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stg-itest-"));
  fs.cpSync(path.join(root, "prisma", "migrations"), path.join(tmp, "migrations"), { recursive: true });

  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const pinned = schema.replace(/url\s*=\s*env\("DATABASE_URL"\)/, `url = ${JSON.stringify(url)}`);
  if (pinned === schema) throw new Error("Refusing to run: could not pin the datasource URL in the temp schema.");
  fs.writeFileSync(path.join(tmp, "schema.prisma"), pinned);

  const env = { ...process.env, DATABASE_URL: url };
  execFileSync(path.join(root, "node_modules", ".bin", "prisma"), ["migrate", "deploy", "--schema", path.join(tmp, "schema.prisma")], {
    cwd: tmp,
    env,
    stdio: "inherit",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}
