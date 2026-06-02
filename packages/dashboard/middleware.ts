import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// HTTP Basic Auth gate for the read-only dashboard. It exposes delivery
// metadata (endpoint URLs, status codes, response snippets), so it must not be
// public. We compare the full decoded `user:pass` against the
// DASHBOARD_BASIC_AUTH secret (set via `wrangler secret put` in production,
// `.dev.vars` locally). There is no signing_secret here — the dashboard never
// reads it (see packages/dashboard/CLAUDE.md).
//
// Convention note: Next 16 deprecated `middleware` in favor of `proxy`, but
// `proxy` is locked to the Node.js runtime and OpenNext's Cloudflare adapter
// only supports Edge middleware — so we stay on the (Edge-default) `middleware`
// convention. The deprecation warning at build time is expected. Revisit when
// OpenNext supports a Node-runtime proxy.
//
// Why this is sufficient as the only gate: every data page is
// `export const dynamic = "force-dynamic"` and reads D1 at request time, so each
// page request is rendered by the Worker and passes through here. Static assets
// (_next/static, optimized images, favicon) carry no D1 data and are excluded
// from the matcher below.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export async function middleware(req: NextRequest) {
  // Async form: the documented accessor that resolves in every context. The
  // sync form is only guaranteed inside a request handler, and OpenNext does
  // not document the middleware context — so don't rely on it here.
  const { env } = await getCloudflareContext({ async: true });

  // Public-demo opt-out: when DASHBOARD_PUBLIC === "true", skip the gate so the
  // deployment is open with no login. Used for the portfolio demo, which holds
  // only seeded data and exposes no signing secrets. The auth path below stays
  // intact for any deployment that doesn't set the flag (fail-closed default).
  if (env.DASHBOARD_PUBLIC === "true") {
    return NextResponse.next();
  }

  const expected = env.DASHBOARD_BASIC_AUTH;

  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Basic ")
    ? decodeBase64(header.slice("Basic ".length).trim())
    : null;

  // Fail closed: an unset secret (a deploy that forgot `secret put`), a missing
  // header, or a mismatch all serve nothing rather than exposing delivery data.
  if (!expected || provided === null || !timingSafeEqual(provided, expected)) {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Hookline", charset="UTF-8"' },
    });
  }

  return NextResponse.next();
}

function decodeBase64(b64: string): string | null {
  try {
    return atob(b64);
  } catch {
    return null;
  }
}

// Constant-time compare so a wrong credential can't be recovered byte-by-byte
// via response timing. Mirrors packages/api/src/auth.ts. The length-difference
// early return leaks only the configured credential's length, which is
// acceptable.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
