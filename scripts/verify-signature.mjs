#!/usr/bin/env node
// Reference receiver for Hookline's HMAC-SHA256 signatures. Independent of the
// Worker code (uses node:crypto, not src/signing.ts) so it's a real interop
// check, not a re-run of our own implementation.
//
// Verification recipe (what any receiver does):
//   1. Read the raw request body BYTES (do not re-serialize the JSON).
//   2. expected = "v1=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`) as hex.
//   3. Constant-time compare against the X-Hookline-Signature header.
//   4. Reject if X-Hookline-Timestamp is outside your replay window.
//   5. Authoritative event id is JSON.parse(rawBody).id — NOT the
//      X-Hookline-Event-Id header (that's convenience only; it isn't signed as
//      authority — the id inside the signed body is).
//
// Two ways to feed it a real signed request (the SSRF guard blocks localhost, so
// both go through a public DNS name the guard can't pre-resolve):
//
//   serve — run as the receiver and point a tunnel (cloudflared/ngrok) at it,
//           then register the tunnel URL as the endpoint. Verifies live.
//     node scripts/verify-signature.mjs serve <secret> [port]
//
//   check — verify values you captured elsewhere (e.g. webhook.site). Body from
//           a file or stdin.
//     node scripts/verify-signature.mjs check <secret> <timestamp> <signature> [bodyFile]
//     cat body.json | node scripts/verify-signature.mjs check <secret> <ts> <sig>

import crypto from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";

const REPLAY_TOLERANCE_S = 300; // 5 min — matches a typical receiver's window

function expectedSignature(secret, timestamp, rawBody) {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `v1=${hex}`;
}

function timingSafeEqual(a, b) {
  // timingSafeEqual throws on length mismatch, so guard length first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Returns { ok, reasons[] }. `ok` is signature validity; freshness/id are
// reported but a stale-but-valid signature still counts as ok=true so a demo
// still shows the match — the staleness is surfaced as a warning.
function verify({ secret, timestamp, signature, rawBody }) {
  const reasons = [];
  const expected = expectedSignature(secret, timestamp, rawBody);
  const ok = typeof signature === "string" && timingSafeEqual(expected, signature);
  if (!ok) reasons.push(`signature mismatch (expected ${expected}, got ${signature})`);

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    reasons.push(`timestamp not numeric: ${timestamp}`);
  } else {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > REPLAY_TOLERANCE_S) {
      reasons.push(`stale timestamp: ${skew}s skew > ${REPLAY_TOLERANCE_S}s window (replay?)`);
    }
  }

  let bodyId;
  try {
    bodyId = JSON.parse(rawBody).id;
  } catch {
    reasons.push("body is not valid JSON");
  }
  return { ok, expected, bodyId, reasons };
}

function report(label, headers, rawBody) {
  const secret = SECRET;
  const timestamp = headers["x-hookline-timestamp"];
  const signature = headers["x-hookline-signature"];
  const headerId = headers["x-hookline-event-id"];
  const { ok, bodyId, reasons } = verify({ secret, timestamp, signature, rawBody });

  console.log(`\n${label}`);
  console.log(`  signature : ${ok ? "MATCH ✓" : "NO MATCH ✗"}`);
  console.log(`  body id   : ${bodyId} (authoritative)`);
  if (headerId !== undefined) {
    const agree = headerId === bodyId ? "agrees" : "DISAGREES — trust the body";
    console.log(`  header id : ${headerId} (${agree}, convenience only)`);
  }
  for (const r of reasons) console.log(`  warn      : ${r}`);
  return ok;
}

const [, , mode, secretArg, ...rest] = process.argv;
const SECRET = secretArg;

if (!mode || !SECRET) {
  console.error("usage: verify-signature.mjs <serve|check> <secret> [...]");
  process.exit(2);
}

if (mode === "serve") {
  const port = Number(rest[0]) || 8788;
  http
    .createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // Verify over the exact received bytes — never JSON.parse then re-stringify.
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const ok = report(`${req.method} ${req.url}`, req.headers, rawBody);
        res.writeHead(ok ? 200 : 400).end(ok ? "ok\n" : "bad signature\n");
      });
    })
    .listen(port, () => {
      console.log(`verifying sink on :${port} — point a tunnel here, register that URL`);
    });
} else if (mode === "check") {
  const [timestamp, signature, bodyFile] = rest;
  if (!timestamp || !signature) {
    console.error("usage: verify-signature.mjs check <secret> <timestamp> <signature> [bodyFile]");
    process.exit(2);
  }
  const rawBody = readFileSync(bodyFile ?? 0, "utf8").replace(/\n$/, "");
  const ok = report("captured request", {
    "x-hookline-timestamp": timestamp,
    "x-hookline-signature": signature,
  }, rawBody);
  process.exit(ok ? 0 : 1);
} else {
  console.error(`unknown mode: ${mode} (expected serve|check)`);
  process.exit(2);
}
