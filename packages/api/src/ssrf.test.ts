import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import { parseSafeEndpointUrl } from "./ssrf";

// parseSafeEndpointUrl is the registration-time SSRF guard: https-only, and it
// blocks literal loopback/private/metadata addresses including the obfuscated
// IPv4 encodings a naive dotted-quad check misses. These tests would fail if a
// blocked form leaked through (the whole point of the guard).

function expectRejected(url: unknown): HTTPException {
  try {
    parseSafeEndpointUrl(url);
  } catch (e) {
    if (!(e instanceof HTTPException)) throw new Error("expected HTTPException");
    expect(e.status).toBe(400);
    return e;
  }
  throw new Error(`expected ${String(url)} to be rejected`);
}

describe("parseSafeEndpointUrl", () => {
  it("accepts a normal public https URL and returns it normalized", () => {
    expect(parseSafeEndpointUrl("https://receiver.example/hook")).toBe(
      "https://receiver.example/hook",
    );
    // A public IPv4 literal is fine.
    expect(parseSafeEndpointUrl("https://8.8.8.8/hook")).toBe("https://8.8.8.8/hook");
  });

  it("rejects non-string / empty input", () => {
    expectRejected(undefined);
    expectRejected("");
    expectRejected(42);
  });

  it("rejects http:// (https-only)", () => {
    expectRejected("http://receiver.example/hook");
  });

  it("rejects non-http(s) schemes", () => {
    expectRejected("ftp://receiver.example/");
    expectRejected("file:///etc/passwd");
  });

  it("rejects localhost and loopback", () => {
    expectRejected("https://localhost/");
    expectRejected("https://api.localhost/");
    expectRejected("https://127.0.0.1/");
    expectRejected("https://127.0.0.2/");
  });

  it("rejects private and CGNAT ranges", () => {
    expectRejected("https://10.0.0.5/");
    expectRejected("https://172.16.3.4/");
    expectRejected("https://192.168.1.1/");
    expectRejected("https://100.64.0.1/");
  });

  it("rejects link-local and cloud metadata", () => {
    expectRejected("https://169.254.169.254/latest/meta-data/");
    expectRejected("https://0.0.0.0/");
  });

  it("rejects obfuscated IPv4 encodings", () => {
    expectRejected("https://2130706433/"); // decimal-packed 127.0.0.1
    expectRejected("https://0x7f000001/"); // hex-packed
    expectRejected("https://0x7f.0.0.1/"); // hex octet
    expectRejected("https://0177.0.0.1/"); // octal / leading-zero octet
    expectRejected("https://127.1/"); // short form
  });

  it("rejects IPv6 loopback / link-local / unique-local", () => {
    expectRejected("https://[::1]/");
    expectRejected("https://[fe80::1]/");
    expectRejected("https://[fd00::1]/");
    expectRejected("https://[::ffff:127.0.0.1]/"); // IPv4-mapped loopback
  });

  it("does not treat a hex-looking domain name as an IP", () => {
    // labels are valid hex but lack the 0x prefix → a name, not an address.
    expect(parseSafeEndpointUrl("https://ace.fade/hook")).toBe("https://ace.fade/hook");
  });
});
