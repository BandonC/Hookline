import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // @hookline/db ships as TypeScript source (its package exports ./src/index.ts),
  // so Next must transpile it rather than expect a prebuilt package.
  transpilePackages: ["@hookline/db"],
};

export default nextConfig;

// Wires Cloudflare bindings (D1) into `next dev` so getCloudflareContext() works
// locally the same way it does in production. No-op outside local dev (so it has
// no effect on build/deploy, where the real D1 binding is used).
//
// The API Worker and this dashboard are separate Miniflare processes with
// separate local state, so to read the SAME local D1 the API writes to, both
// must point at one persistence dir. `wrangler dev` for the API persists to
// packages/api/.wrangler/state and stores D1 under .../v3, so default to that
// (resolved from THIS file's location, not cwd, so it holds regardless of how
// dev is launched). Override with HOOKLINE_D1_PERSIST if your layout differs.
const here = path.dirname(fileURLToPath(import.meta.url));
const d1Persist =
  process.env.HOOKLINE_D1_PERSIST ?? path.resolve(here, "../api/.wrangler/state/v3");
initOpenNextCloudflareForDev({ persist: { path: d1Persist } });
