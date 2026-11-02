import type { Endpoint, Event } from "@hookline/db";
import { fmtDuration } from "./format";

// Turns raw delivery state into sentences. Pure and server-rendered: every
// function takes `now` so a page tells one consistent story per render.

// Mirror of MAX_ATTEMPTS in packages/api/src/do/endpoint-do.ts. The dashboard
// can't import Worker code, so if that value changes this one must follow.
export const MAX_ATTEMPTS = 6;

// How far past due an event may be before we call it late. Matches the API's
// reconciliation cron interval in packages/api/wrangler.toml: anything later
// than this has missed a sweep.
const LATE_AFTER_MS = 5 * 60 * 1000;

export type Tone = "ok" | "wait" | "bad" | "quiet";
export type Story = { tone: Tone; label: string; detail: string };

export type WaitKind = "late" | "retrying" | "breaker" | "throttled" | "tenant" | "turn" | "queued";

export type PendingFacts = Pick<Event, "nextAttemptAt" | "lastDeferReason" | "orderingKey"> & {
  attemptsMade: number;
};

export function classifyPending(e: PendingFacts, now: number): WaitKind {
  const due = e.nextAttemptAt?.getTime() ?? null;
  // Ordered events behind their key's head keep a past-due next_attempt_at by
  // design, so a past due time only means "late" for unordered events.
  if (due === null) return "late";
  if (e.orderingKey === null && now - due > LATE_AFTER_MS) return "late";
  if (e.lastDeferReason === "breaker_open") return "breaker";
  if (e.lastDeferReason === "rate_limited") return "throttled";
  if (e.lastDeferReason === "tenant_throttled") return "tenant";
  if (e.attemptsMade > 0) return "retrying";
  if (e.orderingKey !== null && due < now) return "turn";
  return "queued";
}

function untilNext(next: Date | null, now: number): string {
  if (next === null) return "soon";
  const ms = next.getTime() - now;
  return ms <= 0 ? "now" : `in ${fmtDuration(ms)}`;
}

export function describeEvent(
  e: PendingFacts & Pick<Event, "status">,
  now: number,
): Story {
  if (e.status === "delivered") {
    return {
      tone: "ok",
      label: "Delivered",
      detail: e.attemptsMade <= 1 ? "Delivered first try." : `Delivered on attempt ${e.attemptsMade}.`,
    };
  }
  if (e.status === "failed") {
    return {
      tone: "bad",
      label: "Dead-lettered",
      detail: `Gave up after ${e.attemptsMade} attempts. Hookline will not retry it.`,
    };
  }

  const next = untilNext(e.nextAttemptAt, now);
  switch (classifyPending(e, now)) {
    case "late":
      return {
        tone: "bad",
        label: "Late",
        detail:
          e.nextAttemptAt === null
            ? "Waiting, but no next attempt is scheduled."
            : `Was due ${fmtDuration(now - e.nextAttemptAt.getTime())} ago. The reconciliation sweep should pick it up.`,
      };
    case "breaker":
      return {
        tone: "wait",
        label: "Paused",
        detail: `Held because this endpoint's circuit breaker is open. Next check ${next}.`,
      };
    case "throttled":
      return {
        tone: "wait",
        label: "Throttled",
        detail: `Held by this endpoint's rate limit. Next try ${next}.`,
      };
    case "tenant":
      return {
        tone: "wait",
        label: "Waiting for a slot",
        detail: `This tenant is at its delivery limit. Next try ${next}.`,
      };
    case "retrying":
      return {
        tone: "wait",
        label: "Retrying",
        detail: `Attempt ${e.attemptsMade} failed. Attempt ${e.attemptsMade + 1} of ${MAX_ATTEMPTS} ${next}.`,
      };
    case "turn":
      return {
        tone: "wait",
        label: "In line",
        detail: "Ordered event. It goes after earlier events with the same key.",
      };
    case "queued":
      return { tone: "wait", label: "Queued", detail: `First attempt ${next}.` };
  }
}

type EndpointFacts = Pick<
  Endpoint,
  "circuitBreakerEnabled" | "breakerState" | "breakerOpenUntil"
> & { pending: number; delivered: number; failed: number };

// A breaker's stored state stays "open" until the next delivery moves it on, so
// "open" with an expired timer is not an outage: it's waiting to be retested.
export function isBreakerTripped(e: EndpointFacts, now: number): boolean {
  return (
    e.circuitBreakerEnabled &&
    e.breakerState === "open" &&
    e.breakerOpenUntil !== null &&
    e.breakerOpenUntil.getTime() > now
  );
}

export function describeEndpoint(e: EndpointFacts, now: number): Story {
  const waiting = e.pending > 0 ? `${e.pending} waiting.` : "Nothing waiting.";

  if (isBreakerTripped(e, now)) {
    const left = fmtDuration((e.breakerOpenUntil as Date).getTime() - now);
    return {
      tone: "bad",
      label: "Breaker open",
      detail: `Delivery paused after repeated failures, for another ${left}. ${waiting}`,
    };
  }
  if (e.circuitBreakerEnabled && e.breakerState === "open") {
    return {
      tone: "wait",
      label: "Ready to retest",
      detail: `Breaker cool-down is over. The next delivery tests this endpoint. ${waiting}`,
    };
  }
  if (e.circuitBreakerEnabled && e.breakerState === "half_open") {
    return {
      tone: "wait",
      label: "Testing recovery",
      detail: `A trial delivery decides whether normal delivery resumes. ${waiting}`,
    };
  }
  if (e.pending > 0) {
    return { tone: "wait", label: "Working", detail: waiting };
  }
  if (e.delivered + e.failed === 0) {
    return { tone: "quiet", label: "No events yet", detail: "Nothing has been sent here." };
  }
  if (e.failed > 0) {
    return {
      tone: "quiet",
      label: "Idle",
      detail: `Nothing waiting. ${plural(e.failed, "event")} dead-lettered.`,
    };
  }
  return { tone: "ok", label: "Healthy", detail: `Nothing waiting. All ${e.delivered} delivered.` };
}

// final_error is "HTTP <code>" when the receiver answered, otherwise the name of
// the network error (see deliver() in packages/api/src/do/endpoint-do.ts). The
// advice stays general: we know the symptom, not the receiver's actual cause.
export function explainFailure(finalError: string | null): string {
  if (finalError === null) return "No error was recorded.";
  if (finalError === "TimeoutError") return "The receiver didn't reply in time.";

  const code = /^HTTP (\d{3})$/.exec(finalError)?.[1];
  if (code === undefined) return "Hookline couldn't reach the receiver.";
  if (code === "401" || code === "403") {
    return "The receiver refused the request. Check how it verifies signatures.";
  }
  if (code === "404" || code === "410") return "The receiver says this URL doesn't exist.";
  if (code === "429") return "The receiver was rate limiting Hookline.";
  if (code.startsWith("5")) return "The receiver's server was returning errors.";
  if (code.startsWith("3")) return "The receiver redirected instead of accepting the event.";
  return "The receiver rejected the request.";
}

type DeadLetterFacts = {
  endpointId: string;
  endpointDescription: string | null;
  finalError: string | null;
};

// Groups dead letters by endpoint, worst first, and tallies each group's errors,
// because "12 events, one cause" reads very differently from twelve table rows.
export function groupDeadLetters<T extends DeadLetterFacts>(rows: T[]) {
  type Group = {
    endpointId: string;
    name: string;
    rows: T[];
    errors: Map<string | null, number>;
  };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const group: Group = groups.get(row.endpointId) ?? {
      endpointId: row.endpointId,
      name: row.endpointDescription ?? row.endpointId,
      rows: [],
      errors: new Map(),
    };
    group.rows.push(row);
    group.errors.set(row.finalError, (group.errors.get(row.finalError) ?? 0) + 1);
    groups.set(row.endpointId, group);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      errors: [...g.errors].map(([error, n]) => ({ error, n })).sort((a, b) => b.n - a.n),
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

export function deadLetterHeadline(events: number, endpoints: number): string {
  return `Hookline gave up on ${plural(events, "event")} across ${plural(endpoints, "endpoint")}.`;
}

export type SummaryItem = { tone: Tone; text: string; href?: string };
export type Summary = { tone: Tone; headline: string; items: SummaryItem[] };

type SummaryInput = {
  endpoints: (EndpointFacts & { id: string; description: string | null })[];
  waiting: Record<WaitKind, number>;
  counts: { total: number; pending: number; delivered: number; failed: number };
  lastDeadLetterAt: Date | null;
  now: number;
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// The Overview's "right now" panel. Items run worst-first; the headline names
// the single most important thing, so it must agree with the first item.
export function summarize({ endpoints, waiting, counts, lastDeadLetterAt, now }: SummaryInput): Summary {
  const items: SummaryItem[] = [];

  const down = endpoints.filter((e) => isBreakerTripped(e, now));
  for (const e of down) {
    const left = fmtDuration((e.breakerOpenUntil as Date).getTime() - now);
    items.push({
      tone: "bad",
      text: `${e.description ?? e.id} is failing. Delivery is paused for another ${left}.`,
    });
  }
  if (waiting.late > 0) {
    items.push({ tone: "bad", text: `${plural(waiting.late, "event")} running late.` });
  }
  if (waiting.retrying > 0) {
    items.push({
      tone: "wait",
      text: `${plural(waiting.retrying, "event")} being retried after a failed attempt.`,
    });
  }
  if (waiting.breaker > 0) {
    items.push({ tone: "wait", text: `${plural(waiting.breaker, "event")} held by an open breaker.` });
  }
  if (waiting.throttled > 0) {
    items.push({ tone: "wait", text: `${plural(waiting.throttled, "event")} slowed by a rate limit.` });
  }
  if (waiting.tenant > 0) {
    items.push({ tone: "wait", text: `${plural(waiting.tenant, "event")} waiting for a tenant slot.` });
  }
  if (waiting.turn > 0) {
    items.push({ tone: "wait", text: `${plural(waiting.turn, "event")} in line behind same-key events.` });
  }
  if (waiting.queued > 0) {
    items.push({ tone: "wait", text: `${plural(waiting.queued, "event")} queued for a first attempt.` });
  }
  if (counts.failed > 0) {
    const when =
      lastDeadLetterAt !== null ? ` Latest ${fmtDuration(now - lastDeadLetterAt.getTime())} ago.` : "";
    items.push({
      tone: "quiet",
      text: `${plural(counts.failed, "event")} dead-lettered.${when}`,
      href: "/dead-letters",
    });
  }

  let headline: string;
  let tone: Tone;
  if (endpoints.length === 0) {
    tone = "quiet";
    headline = "No endpoints registered yet.";
  } else if (down.length > 0) {
    tone = "bad";
    headline = `${plural(down.length, "endpoint")} ${down.length === 1 ? "is" : "are"} failing.`;
  } else if (waiting.late > 0) {
    tone = "bad";
    headline = "Some events are running late.";
  } else if (counts.pending > 0) {
    tone = "wait";
    headline = `${plural(counts.pending, "event")} on the way.`;
  } else if (counts.total === 0) {
    tone = "quiet";
    headline = "No events yet.";
  } else if (counts.failed > 0) {
    tone = "quiet";
    headline = "All quiet. Nothing is waiting.";
  } else {
    tone = "ok";
    headline = "All clear. Every event was delivered.";
  }

  return { tone, headline, items };
}
