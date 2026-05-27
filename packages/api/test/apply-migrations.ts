import { applyD1Migrations, env } from "cloudflare:test";

// Apply the @hookline/db migrations to the test D1 before the integration suite
// runs, so the tests execute against the real production schema. TEST_MIGRATIONS
// is provided by the vitest config (readD1Migrations).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
