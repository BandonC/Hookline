// HMAC-SHA256 signing via Web Crypto. Signs `${timestamp}.${rawBody}`.
// The event id lives INSIDE rawBody, so it is covered by the signature.
// Returns "v1=<hex>". See packages/api/src/do/CLAUDE.md — Invariant 2.

export async function signPayload(
  secret: string,
  rawBody: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v1=${hex}`;
}
