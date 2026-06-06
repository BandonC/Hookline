import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto-secret";

// Envelope encryption round-trip + the properties that make it safe: a tampered
// ciphertext is rejected (GCM auth), a wrong key can't decrypt, and legacy
// plaintext values pass through unchanged so existing rows keep working.

function makeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", async () => {
    const key = makeKey();
    const secret = "whsec_deadbeef";
    const enc = await encryptSecret(key, secret);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain(secret); // plaintext not present in the stored form
    expect(await decryptSecret(key, enc)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const key = makeKey();
    const a = await encryptSecret(key, "ingk_same");
    const b = await encryptSecret(key, "ingk_same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(key, a)).toBe("ingk_same");
    expect(await decryptSecret(key, b)).toBe("ingk_same");
  });

  it("passes through legacy plaintext (no scheme prefix) without the key", async () => {
    // Pre-encryption rows + the 0007-backfilled ingest keys are stored plaintext.
    expect(await decryptSecret("", "whsec_legacy_plaintext")).toBe("whsec_legacy_plaintext");
    expect(await decryptSecret(makeKey(), "ingk_legacy")).toBe("ingk_legacy");
  });

  it("rejects a tampered ciphertext", async () => {
    const key = makeKey();
    const enc = await encryptSecret(key, "whsec_x");
    // Flip the first base64 char of the ciphertext — that maps to the top bits of
    // ciphertext byte 0, so it's a guaranteed byte change GCM must reject.
    const lastColon = enc.lastIndexOf(":");
    const ct = enc.slice(lastColon + 1);
    const tampered = enc.slice(0, lastColon + 1) + (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(decryptSecret(key, tampered)).rejects.toThrow();
  });

  it("cannot be decrypted with the wrong key", async () => {
    const enc = await encryptSecret(makeKey(), "whsec_x");
    await expect(decryptSecret(makeKey(), enc)).rejects.toThrow();
  });

  it("rejects a master key that isn't 32 bytes", async () => {
    await expect(encryptSecret(btoa("short"), "whsec_x")).rejects.toThrow();
  });
});
