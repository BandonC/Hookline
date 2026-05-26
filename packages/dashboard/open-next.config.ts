import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Read-only dashboard: there's no ISR or data cache to back, so no incremental
// cache override (and no R2 binding) is needed. If caching is ever introduced,
// wire an incrementalCache override here.
export default defineCloudflareConfig({});
