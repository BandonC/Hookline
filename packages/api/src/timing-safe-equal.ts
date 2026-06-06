// Constant-time string compare so a wrong credential can't be recovered
// byte-by-byte via response timing. Shared by the admin gate (auth.ts) and the
// ingest gate (routes/events.ts). The length-difference early return leaks only
// the configured credential's length, which is acceptable.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
