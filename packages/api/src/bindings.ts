// Worker environment bindings. DB + ENDPOINT_DO come from wrangler.toml;
// ADMIN_API_KEY comes from .dev.vars (local) / `wrangler secret put` (prod).
export type Bindings = {
  DB: D1Database;
  ENDPOINT_DO: DurableObjectNamespace;
  // v2 fair scheduling coordinator. Single instance (idFromName("scheduler"))
  // — holds per-tenant credit/slot state. Per-endpoint DOs call it before
  // every deliver() and release after.
  SCHEDULER_DO: DurableObjectNamespace;
  ADMIN_API_KEY: string;
};
