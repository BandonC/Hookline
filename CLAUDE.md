# CLAUDE.md — Hookline root conventions

These are the standing rules for working on this repo with AI assistance. They apply
**everywhere**. Nested `CLAUDE.md` files (in each package) add scope-specific rules on
top of these — they never relax these.

Read `HOOKLINE.md` for what the project is and where it's going. Read it for *context*;
build only what the current task and the v1 scope describe. **Do not build v2 features.**

---

## The contract

- This is a learning / portfolio project, not production. Optimize for clarity over
  cleverness. The owner reads every line — don't generate code that won't be understood.
- The owner is the architect. You are the implementer. Don't make architectural decisions
  unilaterally. If a task seems to need one, raise it and wait.
- Understand the *why* before implementing. If a choice isn't justified by the task or
  the docs, ask rather than guessing a rationale.

## Scope discipline

- Do exactly what is asked, nothing more. If something else seems necessary, mention it
  once at the end in a sentence — don't silently implement it.
- No unsolicited refactors. If existing code looks bad, flag it separately; don't "fix"
  it as a side effect of another task.
- Surgical edits only. Touch the minimum number of lines required.
- When editing, show the changed sections or a diff, not the whole file.
- Don't end responses with a bulleted summary of what you did. The code is read directly.
- Skip preamble. Don't restate the request or narrate what you're about to do.

## Honesty over confidence

- If you're not sure something works, say so. Don't emit confident-looking code for an
  API you're guessing at.
- For any library version or runtime behavior you don't know for certain (especially
  Cloudflare Workers / Durable Objects / D1 / Wrangler, which change often), say "verify
  this in the docs" rather than inventing it.
- If the owner's approach looks wrong, push back before implementing. A 30-second
  argument beats an hour of debugging.
- Don't be sycophantic. No "great question." Lead with problems, not praise.

## Security (non-negotiable)

- **Never** put secrets, API keys, or credentials in code. Use environment variables.
  Update `.env.example` (and `.dev.vars.example` for the Worker) whenever a new one is
  added.
- Never write code that commits secrets. `.gitignore` must cover `.env`, `.env.*`,
  `.dev.vars`, and `.wrangler/`. Verify this before suggesting any commit.
- Per-endpoint HMAC signing secrets are generated at runtime and stored in D1. There is
  no global signing secret. Never hardcode or log them.
- Flag any code that takes external input (event payloads, endpoint URLs, query params)
  and uses it in a DB query, a fetch target, a file path, or a shell command. Call out
  the injection / SSRF risk explicitly.
- Never log full event payloads or receiver responses if they could contain sensitive
  data. The capped response snippet stored in `delivery_attempts` is the only persisted
  copy, and it is capped for exactly this reason.

## Dependencies

- Don't add a dependency without asking. If a short vanilla solution exists, prefer it.
  Workers has Web Crypto, `fetch`, `crypto.randomUUID()` built in — reach for those first.
- If you propose a library, state when it was last updated and whether it's maintained.
- The committed stack is fixed: Hono, Drizzle, `nanoid`, and the Cloudflare platform.
  Adding anything outside this list needs explicit approval.

## Code style

- TypeScript strict mode. No `any` without explicit approval.
- Match the existing codebase — quotes, semicolons, naming, import ordering, all of it.
- Don't add defensive null checks for values the types guarantee can't be null. Trust
  the type system.
- Don't guess the shape of an external payload to write a type for it. Ask for a real
  example or derive it from the schema.
- Comments explain *why*, not *what*. Don't narrate the code.

## Testing

(Applies whenever test work happens. Full philosophy lives here so it's always in scope.)

- Tests verify observable behavior. If internals are refactored and behavior is
  identical, tests must still pass.
- A test that wouldn't fail on broken code is worse than no test. Before keeping a test,
  confirm: if the function were deleted or subtly broken (off-by-one, swapped args),
  would this test fail? If not, it's worthless — fix or delete it.
- Mock only the boundaries: network, D1, time, randomness. Don't mock so heavily that the
  test only verifies the mocks were called. If testing one function needs 5+ mocks, the
  function is doing too much — flag it.
- For this project specifically, the things most worth testing: backoff produces a
  monotonic-ish increasing, capped, jittered delay; HMAC signing produces a verifiable
  signature over `timestamp.body`; delivery records exactly one attempt row per attempt;
  an event hitting max attempts lands in `dead_letters` and is marked `failed`.
- Use fixed dates and seeded randomness. No flaky tests.

## Project-specific invariants (never violate)

These come from hard-won decisions. Breaking them silently breaks correctness.

1. **At-least-once is sacred.** An event is delivered at least once or it lands in
   `dead_letters`. Never a silent drop. The reconciliation cron exists to enforce this —
   don't remove it or weaken it.
2. **Ingestion never blocks on delivery.** `POST /v1/events` writes `pending`, schedules,
   returns `202`. It must not await a delivery attempt.
3. **D1 is the source of truth in v1.** The Durable Object schedules and delivers; it
   does not become a second source of truth. Don't move event state into DO storage.
4. **Backoff is computed in code, never read from platform retry config.** It is
   decorrelated jitter. See `packages/api/src/do/CLAUDE.md`.
5. **The signature covers `timestamp.body`, and the event ID lives inside the signed
   body.** Don't sign only the body, and don't move the event ID out to an unsigned
   header as the source of authority.
6. **`response_snippet` is read with a hard byte cap, never read-then-slice.** A hostile
   endpoint must not be able to stream unbounded data into the Worker.

## When things go sideways

The owner uses a separate prompt pack for live course-correction (over-mocking,
hallucinated APIs, doing too much, sycophancy, soft resets). If you're told you're doing
one of these, stop and reset to the relevant rule above — don't get defensive.
