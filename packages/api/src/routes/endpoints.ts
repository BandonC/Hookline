// Endpoint CRUD route handlers. Mounted at /v1/endpoints from src/index.ts.
// The signing secret is generated here, stored plaintext, and returned ONCE on
// creation. GET/list never select it.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { endpoints as endpointsTable, events as eventsTable, type Endpoint } from "@hookline/db";
import type { Bindings } from "../bindings";
import { requireAdmin } from "../auth";
import { parseSafeEndpointUrl } from "../ssrf";

export const endpoints = new Hono<{ Bindings: Bindings }>();

endpoints.use("*", requireAdmin);

// Create: validate + SSRF-guard the url, mint id + secret, insert, return the
// secret exactly once.
endpoints.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(400, { message: "body must be a JSON object" });
  }

  const url = parseSafeEndpointUrl(body.url);
  const description = parseDescription(body.description);

  const db = drizzle(c.env.DB);
  const [row] = await db
    .insert(endpointsTable)
    .values({ id: `ep_${nanoid()}`, url, signingSecret: generateSigningSecret(), description })
    .returning();

  return c.json({ ...toPublic(row), signing_secret: row.signingSecret }, 201);
});

// List — no signing_secret selected.
endpoints.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select(publicColumns).from(endpointsTable);
  return c.json({ endpoints: rows.map(toPublic) });
});

// Read one — no signing_secret selected.
endpoints.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select(publicColumns)
    .from(endpointsTable)
    .where(eq(endpointsTable.id, c.req.param("id")))
    .limit(1);
  if (!row) throw new HTTPException(404, { message: "endpoint not found" });
  return c.json(toPublic(row));
});

endpoints.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  // Refuse if any events reference this endpoint. Deleting it would strand
  // pending events (the DO needs the signing secret to deliver) — a silent drop
  // that at-least-once forbids — and would destroy delivery history. There is no
  // event-deletion path in v1, so an endpoint with history stays undeletable.
  const [hasEvents] = await db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(eq(eventsTable.endpointId, id))
    .limit(1);
  if (hasEvents) {
    throw new HTTPException(409, { message: "endpoint has events; cannot delete" });
  }

  const [deleted] = await db
    .delete(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .returning({ id: endpointsTable.id });
  if (!deleted) throw new HTTPException(404, { message: "endpoint not found" });
  return c.body(null, 204);
});

// `whsec_` + 256 bits of entropy. Stored plaintext (the DO recomputes HMAC from
// it at delivery time), so it is never recoverable via the API after creation.
function generateSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `whsec_${hex}`;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: "description must be a string" });
  }
  return value;
}

// Column set for reads — deliberately excludes signingSecret so it is never
// even loaded into memory on list/read.
const publicColumns = {
  id: endpointsTable.id,
  url: endpointsTable.url,
  description: endpointsTable.description,
  ordered: endpointsTable.ordered,
  createdAt: endpointsTable.createdAt,
} as const;

type PublicEndpoint = Pick<Endpoint, "id" | "url" | "description" | "ordered" | "createdAt">;

function toPublic(e: PublicEndpoint) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    ordered: e.ordered,
    created_at: e.createdAt.toISOString(),
  };
}
