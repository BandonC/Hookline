import { HTTPException } from "hono/http-exception";

// Best-effort SSRF guard, applied when an endpoint is registered. It can only
// inspect the LITERAL host in the URL, and it blocks literal internal/loopback/
// metadata addresses across IPv4, IPv6, and the obfuscated IPv4 encodings
// (decimal-packed, hex, octal) that bypass a naive dotted-quad check.
//
// Residual risk it does NOT cover: DNS rebinding — a public name that resolves
// to a private/metadata address at fetch time. A true fix is resolve-and-pin at
// delivery time, which is not achievable on the Workers runtime: `fetch` does
// not expose the resolved IP and gives no way to pin the connection to a vetted
// address, so a TOCTOU window is unavoidable. Registration is admin-gated, which
// bounds (not eliminates) the exposure. Returns the normalized URL string.
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
  // https only: a cleartext http:// target would expose the (signed) event
  // payload to any on-path observer between Cloudflare and the receiver.
  if (u.protocol !== "https:") {
    throw new HTTPException(400, { message: "url must be https" });
  }
  // Reject embedded credentials (https://user:pass@host/): they would be
  // persisted in D1 and surfaced in the dashboard endpoint list — an avoidable
  // secret leak. A receiver that needs auth should not carry it in the URL.
  if (u.username !== "" || u.password !== "") {
    throw new HTTPException(400, { message: "url must not include credentials" });
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isBlockedHost(host)) {
    throw new HTTPException(400, { message: "url target address is not allowed" });
  }
  return u.toString();
}

function isBlockedHost(host: string): boolean {
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;

  // Canonical dotted-decimal IPv4: range-check the octets.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return true; // malformed dotted-quad → block
    return isBlockedIPv4(octets);
  }

  // Obfuscated IPv4 literals that bypass the canonical check but many resolvers
  // still accept: decimal-packed (2130706433), hex (0x7f000001 / 0x7f.0.0.1),
  // octal / leading-zero octets (0177.0.0.1), short forms (127.1). Anything
  // whose labels are ALL numeric-or-0x-hex, yet isn't the canonical quad above,
  // is a non-canonical IP literal we can't safely range-check — block it.
  if (isNumericIshHost(host)) return true;

  if (host.includes(":")) return isBlockedIPv6(host);

  return false; // a DNS name — can't resolve here; see the header comment.
}

// True when every dot-separated label is a plain decimal run or an 0x-prefixed
// hex run — i.e. the host is an IP literal in some base. Hex requires the 0x
// prefix so an ordinary domain whose labels happen to be valid hex (e.g.
// "ace.fade") is still treated as a name, not an address.
function isNumericIshHost(host: string): boolean {
  return host.split(".").every((l) => /^\d+$/.test(l) || /^0x[0-9a-f]+$/i.test(l));
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
  // IPv4-mapped/compat (e.g. ::ffff:127.0.0.1) — re-check the embedded v4.
  const embedded = embeddedIPv4(host);
  if (embedded) return isBlockedIPv4(embedded);
  return false;
}

// Extract the four octets of an IPv4 address embedded at the tail of a `::`-
// prefixed IPv6 host. The URL parser may keep the dotted form (::ffff:127.0.0.1)
// or compress it to two hex groups (::ffff:7f00:1) — handle both, so the hex
// normalization can't smuggle a loopback/private v4 past the check. Returns null
// when there is no embedded v4 (an ordinary IPv6 address).
function embeddedIPv4(host: string): number[] | null {
  const dotted = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.every((o) => o <= 255)) return octets;
  }
  // `...:HHHH:HHHH` → 32 bits → 4 octets. Only meaningful for the v4-mapped /
  // v4-compat prefixes, so require the address to start with `::`.
  const hex = host.match(/:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex && host.startsWith("::")) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}
