# CLAUDE.md — packages/dashboard

The read-only observability UI. Next.js on Cloudflare Pages. Lists endpoints, recent
deliveries, per-event attempt history, and dead-lettered events.

Inherits all root rules. Scope-specific rules below.

## The one rule that defines this package: it is READ-ONLY

- The dashboard reads delivery state. It does NOT create, retry, delete, or mutate events
  or endpoints in v1. No mutation routes, no action buttons that change server state.
- An event-replay button and endpoint management UI are explicitly future work. Don't add
  them, even if they seem like an obvious convenience. If asked, that's a real feature with
  its own scope — flag it, don't sneak it in.
- This keeps the security surface trivial: a read-only dashboard can't be tricked into
  triggering deliveries or leaking signing secrets.

## Data access

- Import row types from `@hookline/db` — `Endpoint`, `Event`, `DeliveryAttempt`. Never
  redefine the shape of a delivery or event in dashboard code.
- **Never display or fetch `signing_secret`.** It's a credential. It must not appear in any
  API response the dashboard consumes, in props, in client bundles, or in the DOM. If a
  query would return it, exclude the column.
- Read from D1 server-side (server components / route handlers). Don't expose D1 or
  internal query shapes to the client.

## Next.js conventions (from the web-app rule set)

- TypeScript strict. Server components by default on the App Router; mark client components
  explicitly with `"use client"` and only when interactivity needs it.
- Don't reach for `useEffect` by default — if something can be derived from props/state,
  derive it. No `useMemo`/`useCallback` without a real measured perf reason.
- Use the styling system already chosen for this package (pick one when scaffolding —
  don't mix). No new design tokens or ad-hoc color values once chosen.
- Prefer `type` over `interface` unless extending. Keep it consistent.

## Scope reminder

This is the lowest-stakes package and the easiest place to over-build. Keep it minimal:
the job is to *see* delivery state clearly, nothing more. Polish the data clarity, not the
feature count.
