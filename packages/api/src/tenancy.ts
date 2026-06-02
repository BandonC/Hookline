// Fair-scheduling constants shared by the SchedulerDO (the coordinator) and
// the tenants CRUD validator. Code-level rather than env vars: same pattern
// as MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, backoff base/cap. Tuning these is a
// deploy, not a config flip — they're load-bearing for the global cap.

// Defensive ceiling on concurrent in-flight deliveries across ALL tenants.
// Sized well under any Cloudflare account-level subrequest budget — exists
// to bound damage when a tenant misbehaves, not to bind on normal traffic.
export const GLOBAL_MAX_IN_FLIGHT = 50;

// Per-tenant cap when tenants.max_in_flight is null. 20% of GLOBAL — a single
// well-behaved tenant cannot starve others even at saturation.
export const DEFAULT_TENANT_MAX_IN_FLIGHT = 10;

// Idle-credit ceiling per tenant. Caps burst size on wake-up; matches the
// default per-tenant in-flight cap so a burst can fill the slot allowance
// but no more. Absolute (not weight-scaled): a high-weight tenant gets faster
// steady-state, not bigger bursts.
export const CREDIT_CAP_PER_TENANT = 10;

// Credit accrual rate: every interval, each tenant gains `weight` credits up
// to the cap. The "round duration" equivalent in event-driven DRR — accrual
// is computed lazily on each acquire call against elapsed wall time, not on
// a clock tick.
export const ACCRUAL_INTERVAL_MS = 1000;

// Held-slot TTL in the coordinator. After this, an acquired-but-never-
// released slot is reclaimed on the next lazy sweep. Must be comfortably
// longer than REQUEST_TIMEOUT_MS (10s) + D1 write latency so a legitimate
// slow delivery isn't reclaimed mid-flight.
export const SLOT_TTL_MS = 30_000;
