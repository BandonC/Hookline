// Per-endpoint ingestion rate limiter. One instance per endpoint
// (idFromName(endpointId)). The ingestion route awaits a /check before accepting
// an event, so a compromised publisher can't flood D1 + delivery past a defensive
// per-endpoint cap. A DO (not a bare counter) because it serializes concurrent
// checks — the token bucket stays correct under parallel ingestion.
//
// Decision math lives in ../ingest-limit.ts; this file owns storage + HTTP, the
// same split as scheduler.ts vs scheduler-do.ts. rate/burst are passed in by the
// caller (the policy is a code constant in routes/events.ts), so the DO is generic.

import { consumeToken, initialBucket, type BucketState } from "../ingest-limit";

type CheckBody = { rate: number; burst: number };

export class IngestLimiterDO {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const { rate, burst } = await req.json<CheckBody>();
    const now = Date.now();

    const current = (await this.state.storage.get<BucketState>("bucket")) ?? initialBucket(burst, now);
    const { allowed, state, retryAfterMs } = consumeToken(current, rate, burst, now);
    await this.state.storage.put("bucket", state);

    return Response.json({ allowed, retryAfterMs });
  }
}
