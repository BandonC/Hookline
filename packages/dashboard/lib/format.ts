// Deterministic UTC formatting. Server-rendered, so a fixed format avoids any
// locale/timezone drift (and there's no client re-render to mismatch against).
export function fmtTime(d: Date | null): string {
  return d ? `${d.toISOString().replace("T", " ").slice(0, 19)} UTC` : "—";
}

// "45s", "4m 12s", "3h 5m", "12d 4h": the two largest units are enough to read
// at a glance. The exact timestamp stays available via fmtTime.
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}
