import { createMiddleware } from "hono/factory";
import type { Bindings } from "./bindings";

// Admin gate for the /v1/endpoints CRUD routes. Caller presents the key as
// `Authorization: Bearer <ADMIN_API_KEY>`. Event ingestion is intentionally
// NOT behind this gate in v1.
export const requireAdmin = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token.length === 0 || !timingSafeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// Constant-time compare so a wrong key can't be recovered byte-by-byte via
// response timing. Length is fixed for the configured key, so leaking it via
// the early return is acceptable.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
