// DASHBOARD_BASIC_AUTH is a Worker secret: set via `wrangler secret put` in
// production and `.dev.vars` locally. Secrets are not declared in
// wrangler.jsonc, so the generated cloudflare-env.d.ts (from `cf-typegen`)
// doesn't include it. Augment the global CloudflareEnv that
// getCloudflareContext().env resolves to, so middleware reads it typed.
interface CloudflareEnv {
  DASHBOARD_BASIC_AUTH: string;
}
