import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertLocalSafeDatabaseUrl, HostedDatabaseRefusedError } from "@/lib/databaseGuard";

/** Local processes (tests, next dev) never connect to a hosted / Production database by accident. */
const NEON = "postgresql://user:secret@ep-misty-butterfly-adm5suti-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require";
const OTHER_NEON = "postgresql://user:secret@ep-other-thing-123.us-east-1.aws.neon.tech/db";
const LOCAL = "postgresql://me@localhost:5432/soccer_team_generator_test";

describe("assertLocalSafeDatabaseUrl", () => {
  it("refuses any Neon host in test and development, without printing the URL or the endpoint id", () => {
    for (const NODE_ENV of ["test", "development"]) {
      for (const DATABASE_URL of [NEON, OTHER_NEON]) {
        let err: unknown;
        try {
          assertLocalSafeDatabaseUrl({ NODE_ENV, DATABASE_URL });
        } catch (e) {
          err = e;
        }
        expect(err, `${NODE_ENV} ${DATABASE_URL}`).toBeInstanceOf(HostedDatabaseRefusedError);
        const msg = (err as Error).message;
        expect(msg).not.toContain("secret");
        expect(msg).not.toContain("adm5suti");
        expect(msg).not.toContain("postgresql://");
      }
    }
  });
  it("allows local databases, an unset URL, deployed (production) processes, and an explicit operator opt-in", () => {
    expect(() => assertLocalSafeDatabaseUrl({ NODE_ENV: "test", DATABASE_URL: LOCAL })).not.toThrow();
    expect(() => assertLocalSafeDatabaseUrl({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertLocalSafeDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: NEON })).not.toThrow(); // Vercel build / runtime
    expect(() => assertLocalSafeDatabaseUrl({ NODE_ENV: "test", DATABASE_URL: NEON, TBP_ALLOW_HOSTED_DATABASE: "1" })).not.toThrow();
    expect(() => assertLocalSafeDatabaseUrl({ NODE_ENV: "test", DATABASE_URL: NEON, TBP_ALLOW_HOSTED_DATABASE: "true" })).toThrow(HostedDatabaseRefusedError);
  });
  it("the shared Prisma client runs the guard before it is created", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/prisma.ts"), "utf8");
    expect(src.indexOf("assertLocalSafeDatabaseUrl();")).toBeGreaterThan(-1);
    expect(src.indexOf("assertLocalSafeDatabaseUrl();")).toBeLessThan(src.indexOf("new PrismaClient()"));
  });
  it("no auto-loaded env file in the project root points at a hosted database", () => {
    // Next.js loads .env, .env.local, .env.<mode>, .env.<mode>.local; Prisma loads .env and prisma/.env.
    for (const f of [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local", "prisma/.env"]) {
      const p = path.join(process.cwd(), f);
      if (!fs.existsSync(p)) continue;
      const hosted = fs.readFileSync(p, "utf8").split("\n").some((l) => /^\s*(DATABASE_URL|DIRECT_URL)\s*=/.test(l) && /neon\.tech|ep-misty-butterfly/.test(l));
      expect(hosted, `${f} points at a hosted database`).toBe(false);
    }
  });
});
