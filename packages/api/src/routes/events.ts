// Event ingestion route handler. Mounted from src/index.ts.
// Flow: validate -> evt_<nanoid> -> write pending + first next_attempt_at
// -> poke endpoint DO -> 202. Never awaits delivery.

// TODO: export the Hono route handler for POST /v1/events.
export {};
