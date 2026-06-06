// Envelope encryption for endpoint credentials (signing_secret, ingest_key) at
// rest in D1. HMAC is symmetric, so the secret can't be hashed — but it can be
// encrypted with a master key held outside the database (SECRET_ENCRYPTION_KEY,
// a Worker secret), so a D1-content disclosure alone doesn't reveal credentials.
// D1 is already encrypted at rest by Cloudflare; this is defense in depth against
// a logical read (backup, support access, a query-level leak).
//
// Scheme: `enc:v1:<base64(iv)>:<base64(ciphertext+tag)>`, AES-256-GCM via Web
// Crypto. A value WITHOUT the `enc:` prefix is treated as legacy plaintext and
// passed through on read — so pre-existing rows and the 0007-backfilled ingest
// keys keep working, and get encrypted the next time they're written (rotation).

const SCHEME_PREFIX = "enc:v1:";

// Cache the imported CryptoKey per master-key string. importKey is async and the
// master key is constant for the Worker's lifetime, so re-importing per call is
// wasted work.
const keyCache = new Map<string, Promise<CryptoKey>>();

function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  if (!masterKeyB64) {
    throw new Error("SECRET_ENCRYPTION_KEY is not set — cannot encrypt/decrypt credentials");
  }
  let cached = keyCache.get(masterKeyB64);
  if (!cached) {
    const raw = base64ToBytes(masterKeyB64);
    if (raw.length !== 32) {
      throw new Error("SECRET_ENCRYPTION_KEY must be base64 of 32 bytes (AES-256)");
    }
    cached = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    keyCache.set(masterKeyB64, cached);
  }
  return cached;
}

export async function encryptSecret(masterKeyB64: string, plaintext: string): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce, GCM standard
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${SCHEME_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

// Returns plaintext. A value without the scheme prefix is legacy plaintext and is
// returned as-is (no master key required for that path). A tampered ciphertext
// fails GCM's auth check and throws — by design.
export async function decryptSecret(masterKeyB64: string, stored: string): Promise<string> {
  if (!stored.startsWith(SCHEME_PREFIX)) return stored; // legacy plaintext

  const rest = stored.slice(SCHEME_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) throw new Error("malformed encrypted secret");
  const iv = base64ToBytes(rest.slice(0, sep));
  const ct = base64ToBytes(rest.slice(sep + 1));

  const key = await importMasterKey(masterKeyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
