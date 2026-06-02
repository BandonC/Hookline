// Tenant CRUD route handlers. Mounted at /v1/tenants from src/index.ts.
// Tenants are the unit of fairness for v2 scheduling: every endpoint belongs
// to exactly one tenant, and the coordinator DO enforces per-tenant slot caps
// + DRR credit accrual using `weight` and `max_in_flight`.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  tenants as tenantsTable,
  endpoints as endpointsTable,
  DEFAULT_TENANT_ID,
  type Tenant,
} from "@hookline/db";
import type { Bindings } from "../bindings";
import { requireAdmin } from "../auth";
import { GLOBAL_MAX_IN_FLIGHT } from "../tenancy";

export const tenants = new Hono<{ Bindings: Bindings }>();

tenants.use("*", requireAdmin);

// Bounds. weight in [1, 100] — same ceiling pattern as rate-limit rps. A
// weight of 0 is nonsensical (no credits = perpetual deny), so 1 is the floor.
// max_in_flight bounded by GLOBAL_MAX_IN_FLIGHT — a tenant cap above the
// global cap is meaningless.
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 100;
const MAX_IN_FLIGHT_MIN = 1;

tenants.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(400, { message: "body must be a JSON object" });
  }
  const bodyObj = body as Record<string, unknown>;

  const name = parseName(bodyObj.name);
  const weight = parseWeight(bodyObj.weight);
  const maxInFlight = parseMaxInFlight(bodyObj.max_in_flight);

  const db = drizzle(c.env.DB);
  const [row] = await db
    .insert(tenantsTable)
    .values({ id: `ten_${nanoid()}`, name, weight, maxInFlight })
    .returning();
  return c.json(toPublic(row), 201);
});

tenants.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(tenantsTable);
  return c.json({ tenants: rows.map(toPublic) });
});

tenants.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, c.req.param("id")))
    .limit(1);
  if (!row) throw new HTTPException(404, { message: "tenant not found" });
  return c.json(toPublic(row));
});

tenants.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // The default tenant is the FK backfill target; deleting it would orphan
  // any pre-migration endpoint that wasn't explicitly reassigned.
  if (id === DEFAULT_TENANT_ID) {
    throw new HTTPException(409, { message: "the default tenant cannot be deleted" });
  }

  const db = drizzle(c.env.DB);

  // Same shape as the endpoints DELETE guard: refuse if any endpoint references
  // this tenant. There is no cascading reassignment in v1 — the operator
  // explicitly moves endpoints to another tenant first.
  const [hasEndpoints] = await db
    .select({ id: endpointsTable.id })
    .from(endpointsTable)
    .where(eq(endpointsTable.tenantId, id))
    .limit(1);
  if (hasEndpoints) {
    throw new HTTPException(409, { message: "tenant has endpoints; cannot delete" });
  }

  const [deleted] = await db
    .delete(tenantsTable)
    .where(eq(tenantsTable.id, id))
    .returning({ id: tenantsTable.id });
  if (!deleted) throw new HTTPException(404, { message: "tenant not found" });
  return c.body(null, 204);
});

function parseName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HTTPException(400, { message: "name must be a non-empty string" });
  }
  if (value.length > 128) {
    throw new HTTPException(400, { message: "name must be 128 characters or fewer" });
  }
  return value;
}

// Optional on create; defaults to 1. Validated independent of presence so the
// caller can supply weight=1 explicitly without it being treated as "absent."
function parseWeight(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < WEIGHT_MIN || (value as number) > WEIGHT_MAX) {
    throw new HTTPException(400, {
      message: `weight must be an integer in [${WEIGHT_MIN}, ${WEIGHT_MAX}]`,
    });
  }
  return value as number;
}

function parseMaxInFlight(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < MAX_IN_FLIGHT_MIN ||
    (value as number) > GLOBAL_MAX_IN_FLIGHT
  ) {
    throw new HTTPException(400, {
      message: `max_in_flight must be an integer in [${MAX_IN_FLIGHT_MIN}, ${GLOBAL_MAX_IN_FLIGHT}] or null`,
    });
  }
  return value as number;
}

function toPublic(t: Tenant) {
  return {
    id: t.id,
    name: t.name,
    weight: t.weight,
    max_in_flight: t.maxInFlight,
    created_at: t.createdAt.toISOString(),
  };
}
