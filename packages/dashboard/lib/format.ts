// Deterministic UTC formatting. Server-rendered, so a fixed format avoids any
// locale/timezone drift (and there's no client re-render to mismatch against).
export function fmtTime(d: Date | null): string {
  return d ? `${d.toISOString().replace("T", " ").slice(0, 19)} UTC` : "—";
}
