import "server-only";
import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Server-only D1 handle. getCloudflareContext() only resolves inside the Worker
// request context, so importing this from a client component fails by
// construction — D1 never reaches the browser bundle. Pages that call this must
// render dynamically (`export const dynamic = "force-dynamic"`): there is no
// build-time request context to read a binding from.
export function getDb() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB);
}
