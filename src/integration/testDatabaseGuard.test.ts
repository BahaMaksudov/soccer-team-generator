import { describe, it, expect } from "vitest";
import { resolveSafeTestDatabaseUrl, databaseUrlFromDotenv, UnsafeTestDatabaseError } from "./testDatabaseGuard";

const OK = "postgresql://tester:pw@localhost:5432/soccer_team_generator_test";
const PROD = "postgresql://owner:secret@ep-misty-butterfly-adm5suti-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require";
const env = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: "test", TEST_DATABASE_URL: OK, ...over });

describe("resolveSafeTestDatabaseUrl — fail-closed integration-test guard", () => {
  it("accepts a local, test-named database when NODE_ENV=test", () => {
    expect(resolveSafeTestDatabaseUrl(env())).toBe(OK);
    expect(resolveSafeTestDatabaseUrl(env({ TEST_DATABASE_URL: "postgres://u@127.0.0.1:55432/it_test" }))).toBe(
      "postgres://u@127.0.0.1:55432/it_test"
    );
  });

  it.each([
    ["NODE_ENV is not test", env({ NODE_ENV: "development" })],
    ["NODE_ENV missing", env({ NODE_ENV: undefined })],
    ["TEST_DATABASE_URL missing — never falls back to DATABASE_URL", env({ TEST_DATABASE_URL: undefined, DATABASE_URL: OK })],
    ["TEST_DATABASE_URL blank", env({ TEST_DATABASE_URL: "   " })],
    ["not a URL", env({ TEST_DATABASE_URL: "soccer_test" })],
    ["wrong protocol", env({ TEST_DATABASE_URL: "mysql://u@localhost/app_test" })],
    ["the production Neon host", env({ TEST_DATABASE_URL: PROD })],
    ["production host even with a test-named database", env({ TEST_DATABASE_URL: "postgresql://u@ep-misty-butterfly-x.neon.tech/neondb_test" })],
    ["any Neon host", env({ TEST_DATABASE_URL: "postgresql://u@ep-other-123.us-east-2.aws.neon.tech/app_test" })],
    ["a non-local host", env({ TEST_DATABASE_URL: "postgresql://u@db.example.com:5432/app_test" })],
    ["a database name without 'test'", env({ TEST_DATABASE_URL: "postgresql://u@localhost:5432/soccer" })],
    ["same URL as DATABASE_URL", env({ DATABASE_URL: OK })],
    ["same host/port/db as DATABASE_URL with different credentials", env({ DATABASE_URL: "postgresql://other:x@LOCALHOST:5432/soccer_team_generator_test" })],
  ])("rejects: %s", (_label, e) => {
    expect(() => resolveSafeTestDatabaseUrl(e)).toThrow(UnsafeTestDatabaseError);
  });

  it("rejects when TEST_DATABASE_URL equals the DATABASE_URL found in .env", () => {
    expect(() => resolveSafeTestDatabaseUrl(env(), [OK])).toThrow(/same database/);
  });

  it("never includes the URL or password in the error", () => {
    try {
      resolveSafeTestDatabaseUrl(env({ TEST_DATABASE_URL: PROD }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).not.toContain("secret");
      expect(String(e)).not.toContain("owner:");
    }
  });
});

describe("databaseUrlFromDotenv", () => {
  it("reads DATABASE_URL (quoted or not) without loading the file into process.env", () => {
    expect(databaseUrlFromDotenv(`FOO=1\nDATABASE_URL="${PROD}"\n`)).toBe(PROD);
    expect(databaseUrlFromDotenv(`DATABASE_URL=${OK}`)).toBe(OK);
    expect(databaseUrlFromDotenv("NOTHING=1")).toBeUndefined();
  });
});
