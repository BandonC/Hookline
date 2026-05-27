import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));

// Two projects:
//  - "unit": the existing tests, on the default Node pool. They mock D1, fetch,
//    and time, so they don't need a Worker runtime — keep them as-is.
//  - "integration": real-D1 tests in workerd (vitest-pool-workers), with the
//    @hookline/db migrations applied. This is where the reconciliation WHERE
//    filter is exercised against actual SQLite, which the mocked unit test can't.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            // Read the same migrations production applies, and hand them to the
            // setup file via a test-only binding (see test/apply-migrations.ts).
            const migrations = await readD1Migrations(path.join(here, "../db/migrations"));
            return {
              singleWorker: true,
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            };
          }),
        ],
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
    ],
  },
});
