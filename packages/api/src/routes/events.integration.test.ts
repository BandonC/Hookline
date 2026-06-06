import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { endpoints, events } from "@hookline/db";

// Exercises the POST /v1/events ingest gate end-to-end through the Worker (SELF),
// against real D1. The claim under test: ingestion requires the endpoint's
// ingest_key, so a non-secret endpoint id alone can't get a payload signed and
// delivered. Also the 128 KB body cap. The DO poke is fire-and-forget
// (waitUntil) and doesn't affect these assertions.

const db = drizzle(env.DB);

const EP_ID = "ep_ingest_test";
const INGEST_KEY = "ingk_correct_horse_battery_staple";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
  await db.insert(endpoints).values({
    id: EP_ID,
    tenantId: "ten_default", // seeded by migration 0006
    url: "https://receiver.example/hook",
    signingSecret: "whsec_test",
    ingestKey: INGEST_KEY,
  });
});

function post(headers: Record<string, string>, body: string) {
  return SELF.fetch("https://hookline.test/v1/events", { method: "POST", headers, body });
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const validBody = JSON.stringify({ endpoint_id: EP_ID, payload: { hello: "world" } });

describe("POST /v1/events ingest gate", () => {
  it("rejects a request with no Authorization header (401)", async () => {
    const res = await post(JSON_HEADERS, validBody);
    expect(res.status).toBe(401);
    // Nothing was ingested.
    const rows = await db.select().from(events).where(eq(events.endpointId, EP_ID));
    expect(rows).toHaveLength(0);
  });

  it("rejects a wrong ingest key (401)", async () => {
    const res = await post({ ...JSON_HEADERS, Authorization: "Bearer ingk_wrong" }, validBody);
    expect(res.status).toBe(401);
    const rows = await db.select().from(events).where(eq(events.endpointId, EP_ID));
    expect(rows).toHaveLength(0);
  });

  it("accepts the correct ingest key and ingests the event (202)", async () => {
    const res = await post({ ...JSON_HEADERS, Authorization: `Bearer ${INGEST_KEY}` }, validBody);
    expect(res.status).toBe(202);
    const rows = await db.select().from(events).where(eq(events.endpointId, EP_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
  });

  it("rejects a body over the 128 KB cap (413)", async () => {
    // Valid token so we get past the auth pre-check to the body read.
    const huge = JSON.stringify({ endpoint_id: EP_ID, payload: { blob: "x".repeat(200_000) } });
    const res = await post({ ...JSON_HEADERS, Authorization: `Bearer ${INGEST_KEY}` }, huge);
    expect(res.status).toBe(413);
    const rows = await db.select().from(events).where(eq(events.endpointId, EP_ID));
    expect(rows).toHaveLength(0);
  });
});
