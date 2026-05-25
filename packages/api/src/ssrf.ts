import { HTTPException } from "hono/http-exception";

// Best-effort SSRF guard, applied when an endpoint is registered. It can only
// inspect the LITERAL host in the URL. It does NOT defend against DNS rebinding
// (a public name that later resolves to a private/metadata address) — that
// requires resolve-and-pin at fetch time in the DO, which is a later step.
// Returns the normalized URL string to store.
export function parseSafeEndpointUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HTTPException(400, { message: "url is required" });
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HTTPException(400, { message: "url is not a valid URL" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HTTPException(400, { message: "url must be http or https" });
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isBlockedHost(host)) {
    throw new HTTPException(400, { message: "url target address is not allowed" });
  }
  return u.toString();
}

function isBlockedHost(host: string): boolean {
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return true; // malformed dotted-quad → block
    return isBlockedIPv4(octets);
  }

  if (host.includes(":")) return isBlockedIPv6(host);

  return false; // a DNS name — can't resolve here; see the header comment.
}

function isBlockedIPv4([a, b]: number[]): boolean {
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isBlockedIPv6(host: string): boolean {
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (host.startsWith("fe80")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (e.g. ::ffff:127.0.0.1) — re-check the embedded v4.
  const mapped = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mapped) {
    const octets = mapped.slice(1).map(Number);
    if (octets.every((o) => o <= 255)) return isBlockedIPv4(octets);
  }
  return false;
}
