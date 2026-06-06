import { createMiddleware } from "hono/factory";
import type { Bindings } from "./bindings";
import { timingSafeEqual } from "./timing-safe-equal";

// Admin gate for the /v1/endpoints and /v1/tenants CRUD routes. Caller presents
// the key as `Authorization: Bearer <ADMIN_API_KEY>`. Event ingestion is NOT
// behind this admin gate — it has its own per-endpoint credential (the
// endpoint's ingest_key, checked in routes/events.ts), so publishers don't need
// the admin key and a leaked ingest_key is scoped to one endpoint.
export const requireAdmin = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token.length === 0 || !timingSafeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
