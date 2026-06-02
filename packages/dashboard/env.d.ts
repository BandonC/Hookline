// DASHBOARD_BASIC_AUTH is a Worker secret: set via `wrangler secret put` in
// production and `.dev.vars` locally. Secrets are not declared in
// wrangler.jsonc, so the generated cloudflare-env.d.ts (from `cf-typegen`)
// doesn't include it. Augment the global CloudflareEnv that
// getCloudflareContext().env resolves to, so middleware reads it typed.
//
// DASHBOARD_PUBLIC is an optional plain var (not a secret): when set to the
// string "true", the Basic Auth gate is skipped entirely so the deployment is
// publicly readable. Used for the portfolio demo, which holds only seeded
// data. Unset/anything-else keeps the gate on (fail-closed). Optional, so the
// type is `string | undefined`.
interface CloudflareEnv {
  DASHBOARD_BASIC_AUTH: string;
  DASHBOARD_PUBLIC?: string;
}
