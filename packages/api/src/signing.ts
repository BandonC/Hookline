// HMAC-SHA256 signing via Web Crypto. Signs `${timestamp}.${rawBody}`.
// The event id lives INSIDE rawBody, so it is covered by the signature.
// Returns "v1=<hex>". See packages/api/src/do/CLAUDE.md — Invariant 2.

export async function signPayload(
  secret: string,
  rawBody: string,
  timestamp: number,
): Promise<string> {
  // TODO:
  //   import HMAC-SHA256 key from `secret` via crypto.subtle.importKey
  //   sign `${timestamp}.${rawBody}`
  //   hex-encode the result, return `v1=${hex}`
  throw new Error("signPayload not implemented");
}
