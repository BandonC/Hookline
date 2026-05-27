/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exposes `env` typed as `Cloudflare.Env`. The integration
// tests read `env.DB` (bound from wrangler.toml), so declare it on the namespace
// for tsc. (TEST_MIGRATIONS is used only in test/apply-migrations.ts, which is
// outside the src typecheck.)
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
