// Worker environment bindings. DB + ENDPOINT_DO come from wrangler.toml;
// ADMIN_API_KEY comes from .dev.vars (local) / `wrangler secret put` (prod).
export type Bindings = {
  DB: D1Database;
  ENDPOINT_DO: DurableObjectNamespace;
  // v2 fair scheduling coordinator. Single instance (idFromName("scheduler"))
  // — holds per-tenant credit/slot state. Per-endpoint DOs call it before
  // every deliver() and release after.
  SCHEDULER_DO: DurableObjectNamespace;
  // Per-endpoint ingestion rate limiter (token bucket). Checked on POST
  // /v1/events before an event is accepted. One instance per endpoint.
  INGEST_LIMITER: DurableObjectNamespace;
  ADMIN_API_KEY: string;
  // Master key for envelope-encrypting endpoint credentials at rest in D1
  // (base64 of 32 random bytes). Set via `wrangler secret put` in prod /
  // .dev.vars locally. See timing-safe-equal.ts's sibling crypto-secret.ts.
  SECRET_ENCRYPTION_KEY: string;
};
