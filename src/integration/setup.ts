import { guardedTestDatabaseUrl } from "./env";

// Runs in every test worker BEFORE test files import @/lib/prisma, so the
// app's Prisma singleton connects to the guarded test database only.
// The full guard runs HERE, while DATABASE_URL still holds its original
// value (so "same as DATABASE_URL" is checked against the real one); the
// guarded URL is then recorded so tests never re-run the guard against
// the already-overridden environment.
const url = guardedTestDatabaseUrl();
process.env.DATABASE_URL = url;
process.env.ITEST_GUARDED_DATABASE_URL = url;
