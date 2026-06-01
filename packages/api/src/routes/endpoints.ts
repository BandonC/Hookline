// Endpoint CRUD route handlers. Mounted at /v1/endpoints from src/index.ts.
// The signing secret is generated here, stored plaintext, and returned ONCE on
// creation. GET/list never select it.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
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

// Partial update. Admin-only (inherited from the route-level requireAdmin
// middleware), and API-only — the dashboard stays read-only. Patchable
// fields: `ordered`, the rate-limit pair `rate_limit_rps` + `rate_limit_burst`,
// and the breaker triplet `circuit_breaker_enabled` + `breaker_open_sec` +
// `breaker_threshold_pct`. url/description/signing_secret are not.
//
// Semantics (Q6, iii): standard PATCH merge with explicit-null-to-clear.
// Absent fields are untouched. The rate-limit pair is all-or-nothing per
// call — present together (both ints in bounds, or both null to clear), or
// not at all. Half-pair is a 400. The breaker tunables are independent
// nullables (each has a code default if null) — set individually.
//
// Breaker state reset: whenever `circuit_breaker_enabled` is present in the
// body (true or false), the runtime state columns (state/opened_at/open_until)
// are reset to closed/null/null in the same UPDATE. This way toggling the
// flag never leaves stale "open" state to ambush a future re-enable. The
// gate also short-circuits when enabled=false, so a stale state column can
// never be acted on, but the reset is the cleaner contract.
endpoints.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(400, { message: "body must be a JSON object" });
  }
  const bodyObj = body as Record<string, unknown>;

  const hasOrdered = "ordered" in bodyObj;
  let nextOrdered: boolean | undefined;
  if (hasOrdered) {
    if (typeof bodyObj.ordered !== "boolean") {
      throw new HTTPException(400, { message: "ordered must be a boolean" });
    }
    nextOrdered = bodyObj.ordered;
  }

  const rateConfig = parseRateConfigPatch(bodyObj);
  const breakerConfig = parseBreakerConfigPatch(bodyObj);

  if (!hasOrdered && rateConfig === undefined && breakerConfig === undefined) {
    throw new HTTPException(400, { message: "no recognized fields to update" });
  }

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  const [current] = await db
    .select({ id: endpointsTable.id, ordered: endpointsTable.ordered })
    .from(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .limit(1);
  if (!current) throw new HTTPException(404, { message: "endpoint not found" });

  // Decision F: refuse `false → true` if there are pending events with no
  // ordering_key on this endpoint. Those events live on the bare DO; flipping
  // ordered would leave them as a category ingestion-time validation forbids
  // creating, with no operator-visible recourse. The check is best-effort
  // (D1 has no multi-statement transaction with the UPDATE below), but
  // ingestion enforces the same rule, so a null-key event arriving in the
  // race window is rejected at the edge — see routes/events.ts.
  if (nextOrdered === true && !current.ordered) {
    const [blocker] = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.endpointId, id),
          eq(eventsTable.status, "pending"),
          isNull(eventsTable.orderingKey),
        ),
      )
      .limit(1);
    if (blocker) {
      throw new HTTPException(409, {
        message: "endpoint has pending events without ordering_key; cannot enable ordered",
      });
    }
  }

  const updates: Partial<typeof endpointsTable.$inferInsert> = {};
  if (nextOrdered !== undefined) updates.ordered = nextOrdered;
  if (rateConfig !== undefined) {
    updates.rateLimitRps = rateConfig.rateLimitRps;
    updates.rateLimitBurst = rateConfig.rateLimitBurst;
  }
  if (breakerConfig !== undefined) {
    if (breakerConfig.circuitBreakerEnabled !== undefined) {
      updates.circuitBreakerEnabled = breakerConfig.circuitBreakerEnabled;
      // Reset runtime state whenever the intent flag is touched: toggling
      // never leaves stale open/half-open state behind. See the route doc
      // comment above.
      updates.breakerState = "closed";
      updates.breakerOpenedAt = null;
      updates.breakerOpenUntil = null;
    }
    if (breakerConfig.breakerOpenSec !== undefined) {
      updates.breakerOpenSec = breakerConfig.breakerOpenSec;
    }
    if (breakerConfig.breakerThresholdPct !== undefined) {
      updates.breakerThresholdPct = breakerConfig.breakerThresholdPct;
    }
  }

  const [updated] = await db
    .update(endpointsTable)
    .set(updates)
    .where(eq(endpointsTable.id, id))
    .returning(publicColumns);

  return c.json(toPublic(updated));
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

// Bounds: rps in [1, 100], burst in [1, 1000]. No cross-field constraint —
// `burst < rps` is silly but legal (the bucket can only hold less than 1s of
// sustained capacity; the gate still works, just throttles below rps).
const RATE_RPS_MIN = 1;
const RATE_RPS_MAX = 100;
const RATE_BURST_MIN = 1;
const RATE_BURST_MAX = 1000;

export type RateConfigPatch = { rateLimitRps: number | null; rateLimitBurst: number | null };

// Returns undefined when neither field is present (no rate-config change),
// or a validated pair. Throws 400 with a message describing exactly which
// rule was violated. Exported for direct unit testing.
//
// Failure modes, each with its own message:
//   1. Half-pair (one field present, the other absent) — must be set together.
//   2. Mixed null + int — to clear, set both to null; to set, provide both.
//   3. rps not an integer in bounds.
//   4. burst not an integer in bounds.
export function parseRateConfigPatch(body: Record<string, unknown>): RateConfigPatch | undefined {
  const hasRps = "rate_limit_rps" in body;
  const hasBurst = "rate_limit_burst" in body;
  if (!hasRps && !hasBurst) return undefined;
  if (hasRps !== hasBurst) {
    throw new HTTPException(400, {
      message: "rate_limit_rps and rate_limit_burst must be set together",
    });
  }
  const rps = body.rate_limit_rps;
  const burst = body.rate_limit_burst;
  if (rps === null && burst === null) {
    return { rateLimitRps: null, rateLimitBurst: null };
  }
  if (rps === null || burst === null) {
    throw new HTTPException(400, {
      message:
        "to clear rate limits set both rate_limit_rps and rate_limit_burst to null; to set them provide both as integers",
    });
  }
  if (!Number.isInteger(rps) || (rps as number) < RATE_RPS_MIN || (rps as number) > RATE_RPS_MAX) {
    throw new HTTPException(400, {
      message: `rate_limit_rps must be an integer in [${RATE_RPS_MIN}, ${RATE_RPS_MAX}]`,
    });
  }
  if (!Number.isInteger(burst) || (burst as number) < RATE_BURST_MIN || (burst as number) > RATE_BURST_MAX) {
    throw new HTTPException(400, {
      message: `rate_limit_burst must be an integer in [${RATE_BURST_MIN}, ${RATE_BURST_MAX}]`,
    });
  }
  return { rateLimitRps: rps as number, rateLimitBurst: burst as number };
}

// Bounds for the breaker tunables. open_sec matches the backoff cap (1h);
// 1s is silly but legal, same pattern as the rate-limit bounds. threshold_pct
// floor of 1 — 0% would mean "always tripped," which is never the right
// state.
const BREAKER_OPEN_SEC_MIN = 1;
const BREAKER_OPEN_SEC_MAX = 3600;
const BREAKER_THRESHOLD_PCT_MIN = 1;
const BREAKER_THRESHOLD_PCT_MAX = 100;

// Each field independent and optional: present → validate and apply,
// null → clear (use the code default at gate time), absent → untouched.
// Returns undefined when no breaker field is present (no config change),
// or an object whose `undefined` keys are "not present in body."
export type BreakerConfigPatch = {
  circuitBreakerEnabled: boolean | undefined;
  breakerOpenSec: number | null | undefined;
  breakerThresholdPct: number | null | undefined;
};

export function parseBreakerConfigPatch(
  body: Record<string, unknown>,
): BreakerConfigPatch | undefined {
  const hasEnabled = "circuit_breaker_enabled" in body;
  const hasOpenSec = "breaker_open_sec" in body;
  const hasThreshold = "breaker_threshold_pct" in body;
  if (!hasEnabled && !hasOpenSec && !hasThreshold) return undefined;

  let circuitBreakerEnabled: boolean | undefined;
  if (hasEnabled) {
    if (typeof body.circuit_breaker_enabled !== "boolean") {
      throw new HTTPException(400, {
        message: "circuit_breaker_enabled must be a boolean",
      });
    }
    circuitBreakerEnabled = body.circuit_breaker_enabled;
  }

  let breakerOpenSec: number | null | undefined;
  if (hasOpenSec) {
    const v = body.breaker_open_sec;
    if (v === null) breakerOpenSec = null;
    else if (
      !Number.isInteger(v) ||
      (v as number) < BREAKER_OPEN_SEC_MIN ||
      (v as number) > BREAKER_OPEN_SEC_MAX
    ) {
      throw new HTTPException(400, {
        message: `breaker_open_sec must be an integer in [${BREAKER_OPEN_SEC_MIN}, ${BREAKER_OPEN_SEC_MAX}] or null`,
      });
    } else breakerOpenSec = v as number;
  }

  let breakerThresholdPct: number | null | undefined;
  if (hasThreshold) {
    const v = body.breaker_threshold_pct;
    if (v === null) breakerThresholdPct = null;
    else if (
      !Number.isInteger(v) ||
      (v as number) < BREAKER_THRESHOLD_PCT_MIN ||
      (v as number) > BREAKER_THRESHOLD_PCT_MAX
    ) {
      throw new HTTPException(400, {
        message: `breaker_threshold_pct must be an integer in [${BREAKER_THRESHOLD_PCT_MIN}, ${BREAKER_THRESHOLD_PCT_MAX}] or null`,
      });
    } else breakerThresholdPct = v as number;
  }

  return { circuitBreakerEnabled, breakerOpenSec, breakerThresholdPct };
}

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
  rateLimitRps: endpointsTable.rateLimitRps,
  rateLimitBurst: endpointsTable.rateLimitBurst,
  circuitBreakerEnabled: endpointsTable.circuitBreakerEnabled,
  breakerOpenSec: endpointsTable.breakerOpenSec,
  breakerThresholdPct: endpointsTable.breakerThresholdPct,
  breakerState: endpointsTable.breakerState,
  breakerOpenedAt: endpointsTable.breakerOpenedAt,
  breakerOpenUntil: endpointsTable.breakerOpenUntil,
  createdAt: endpointsTable.createdAt,
} as const;

type PublicEndpoint = Pick<
  Endpoint,
  | "id"
  | "url"
  | "description"
  | "ordered"
  | "rateLimitRps"
  | "rateLimitBurst"
  | "circuitBreakerEnabled"
  | "breakerOpenSec"
  | "breakerThresholdPct"
  | "breakerState"
  | "breakerOpenedAt"
  | "breakerOpenUntil"
  | "createdAt"
>;

function toPublic(e: PublicEndpoint) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    ordered: e.ordered,
    rate_limit_rps: e.rateLimitRps,
    rate_limit_burst: e.rateLimitBurst,
    circuit_breaker_enabled: e.circuitBreakerEnabled,
    breaker_open_sec: e.breakerOpenSec,
    breaker_threshold_pct: e.breakerThresholdPct,
    breaker_state: e.breakerState,
    breaker_opened_at: e.breakerOpenedAt?.toISOString() ?? null,
    breaker_open_until: e.breakerOpenUntil?.toISOString() ?? null,
    created_at: e.createdAt.toISOString(),
  };
}
