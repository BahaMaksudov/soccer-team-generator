import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 2D.6E.6C — REAL-DATABASE integration tests (tenant isolation).
 * Separate from vitest.config.mts: `npm test` never runs these.
 * Runs only against TEST_DATABASE_URL, validated fail-closed by
 * src/integration/testDatabaseGuard.ts (local host, *test* database,
 * never production/Neon, never equal to DATABASE_URL, NODE_ENV=test).
 *
 *   NODE_ENV=test TEST_DATABASE_URL=postgresql://…@localhost:5432/<name>_test npm run test:integration
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(dirname, "./src") } },
  test: {
    environment: "node",
    include: ["src/integration/**/*.itest.ts"],
    globalSetup: ["src/integration/globalSetup.ts"],
    setupFiles: ["src/integration/setup.ts"],
    // One shared database: run files sequentially in a single worker.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
