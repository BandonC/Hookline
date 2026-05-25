import { drizzle } from "drizzle-orm/d1";
import type { Endpoint, Event } from "@hookline/db";
import { signPayload } from "../signing";
import { computeBackoff } from "../backoff";

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_SNIPPET_CAP = 1024; // 1KB — enforced during the read, never read-then-slice

type Env = { DB: D1Database; ENDPOINT_DO: DurableObjectNamespace };

// Per-endpoint Durable Object: scheduler + delivery worker.
// One instance per endpoint (idFromName(endpointId)). See ./CLAUDE.md for the
// four invariants — do not violate them.
export class EndpointDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  // Poked by the ingestion API / reconciliation cron to schedule a due event.
  // Step 1 establishes the call path: it only arms the alarm. The alarm()/
  // deliver() loop is Step 2. eventId is unused here on purpose — alarm() loads
  // due events from D1 (the source of truth), so the poke just sets the time.
  async fetch(req: Request): Promise<Response> {
    const { dueAt } = await req.json<{ eventId: string; dueAt: number }>();
    const current = await this.state.storage.getAlarm();
    if (current === null || dueAt < current) {
      await this.state.storage.setAlarm(dueAt);
    }
    return new Response(null, { status: 202 });
  }

  // Fires when the soonest scheduled delivery is due. Must be safe to run twice.
  async alarm(): Promise<void> {
    // TODO: load this endpoint's due `pending` events from D1
    //   (status='pending' AND next_attempt_at <= now), re-check status,
    //   for each -> this.deliver(...). Then re-arm setAlarm() to next due time.
  }

  // The one method where Invariants 2, 3, 4 all live.
  private async deliver(
    db: ReturnType<typeof drizzle>,
    event: Event,
    endpoint: Endpoint,
  ): Promise<void> {
    // TODO:
    //   timestamp = Date.now(); rawBody = JSON.stringify(event.payload)
    //   signature = await signPayload(endpoint.signingSecret, rawBody, timestamp)  [Inv. 2]
    //   POST to endpoint.url with X-Hookline-Timestamp / X-Hookline-Signature,
    //     AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    //   snippet = await readCapped(res, RESPONSE_SNIPPET_CAP)                       [Inv. 4]
    //   record exactly one attempt row + event mutation in ONE db.batch()          [Inv. 3]
    //   success -> mark delivered
    //   fail & attemptNumber >= MAX_ATTEMPTS -> mark failed + dead_letters
    //   fail & under max -> computeBackoff(...) -> set next_attempt_at; alarm() re-arms
  }
}

// Invariant 4: read at most `cap` bytes, then stop and cancel. Never buffer the
// whole body — a hostile endpoint streaming GBs must not OOM the Worker.
async function readCapped(res: Response, cap: number): Promise<string> {
  // TODO: stream res.body via getReader(), accumulate up to `cap` bytes,
  //   cancel the reader, decode, return.
  throw new Error("readCapped not implemented");
}
