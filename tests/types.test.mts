import assert from "node:assert/strict";
import {
  KinetexError,
  SizeLimitError,
  HTTPStatusError,
  AbortError,
  NetworkError,
  ValidationError,
  AuthError,
  ProxyError,
  RedirectError,
  TimeoutError,
  validateErrorCode,
} from "../src/types.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

// Minimal request and response fixtures
const fakeReq = {
  url: "https://example.com/api",
  method: "GET" as const,
  headers: {},
  body: null,
  signal: null,
  meta: {},
  httpVersion: "HTTP/2" as const,
};

const fakeRes = {
  status: 500,
  statusText: "Internal Server Error",
  headers: {},
  data: null,
  rawBody: null,
  url: "https://example.com/api",
  cached: false,
  redirected: false,
  httpVersion: "HTTP/2" as const,
  durationMs: 100,
  request: fakeReq,
  attempt: 1,
};

// ============================================================================
// §1  KinetexError — base class
// ============================================================================

suite("KinetexError base class");

await test("constructor sets name, message, code", () => {
  const e = new KinetexError("test error", "ENETWORK");
  assert.equal(e.name, "KinetexError");
  assert.equal(e.message, "test error");
  assert.equal(e.code, "ENETWORK");
  assert.ok(e instanceof Error);
});

await test("constructor with all options", () => {
  const cause = new Error("root cause");
  const e = new KinetexError("msg", "EHTTPSTATUS", { request: fakeReq, response: fakeRes, cause });
  assert.equal(e.request, fakeReq);
  assert.equal(e.response, fakeRes);
  assert.equal(e.cause, cause);
  assert.equal(e.status, 500);
});

await test("constructor without options", () => {
  const e = new KinetexError("bare", "EUNKNOWN");
  assert.equal(e.request, undefined);
  assert.equal(e.response, undefined);
  assert.equal(e.cause, undefined);
  assert.equal(e.status, null);
});

await test("get isNetwork", () => {
  assert.equal(new KinetexError("", "ENETWORK").isNetwork, true);
  assert.equal(new KinetexError("", "ETIMEOUT").isNetwork, false);
});

await test("get isTimeout", () => {
  assert.equal(new KinetexError("", "ETIMEOUT").isTimeout, true);
  assert.equal(new KinetexError("", "EABORT").isTimeout, false);
});

await test("get isAbort", () => {
  assert.equal(new KinetexError("", "EABORT").isAbort, true);
  assert.equal(new KinetexError("", "ENETWORK").isAbort, false);
});

await test("get isHTTPError", () => {
  assert.equal(new KinetexError("", "EHTTPSTATUS").isHTTPError, true);
  assert.equal(new KinetexError("", "ESIZELIMIT").isHTTPError, false);
});

await test("get isProxy", () => {
  assert.equal(new KinetexError("", "EPROXY").isProxy, true);
  assert.equal(new KinetexError("", "ENETWORK").isProxy, false);
});

// ============================================================================
// §2  Error subclasses
// ============================================================================

suite("SizeLimitError");

await test("SizeLimitError with request", () => {
  const e = new SizeLimitError(1000000, 1024, fakeReq);
  assert.equal(e.name, "SizeLimitError");
  assert.equal(e.code, "ESIZELIMIT");
  assert.equal(e.bytesRead, 1000000);
  assert.equal(e.limit, 1024);
  assert.equal(e.request, fakeReq);
  assert.ok(e instanceof KinetexError);
});

await test("SizeLimitError without request", () => {
  const e = new SizeLimitError(500, 100);
  assert.equal(e.name, "SizeLimitError");
  assert.equal(e.bytesRead, 500);
  assert.equal(e.limit, 100);
  assert.equal(e.request, undefined);
});

suite("HTTPStatusError");

await test("HTTPStatusError client error (4xx)", () => {
  const res = { ...fakeRes, status: 404, statusText: "Not Found" };
  const e = new HTTPStatusError(res, fakeReq);
  assert.equal(e.name, "HTTPStatusError");
  assert.equal(e.code, "EHTTPSTATUS");
  assert.equal(e.status, 404);
  assert.equal(e.response, res);
  assert.equal(e.request, fakeReq);
  assert.equal(e.isClientError, true);
  assert.equal(e.isServerError, false);
});

await test("HTTPStatusError server error (5xx)", () => {
  const res = { ...fakeRes, status: 503, statusText: "Service Unavailable" };
  const e = new HTTPStatusError(res, fakeReq);
  assert.equal(e.status, 503);
  assert.equal(e.isServerError, true);
  assert.equal(e.isClientError, false);
});

await test("HTTPStatusError message includes status and URL", () => {
  const e = new HTTPStatusError(fakeRes, fakeReq);
  assert.ok(e.message.includes("500"));
  assert.ok(e.message.includes("https://example.com/api"));
});

suite("AbortError");

await test("AbortError with request", () => {
  const e = new AbortError(fakeReq);
  assert.equal(e.name, "AbortError");
  assert.equal(e.code, "EABORT");
  assert.equal(e.request, fakeReq);
  assert.equal(e.isAbort, true);
  assert.ok(e instanceof KinetexError);
});

await test("AbortError without request", () => {
  const e = new AbortError();
  assert.equal(e.name, "AbortError");
  assert.equal(e.code, "EABORT");
  assert.equal(e.request, undefined);
});

suite("NetworkError");

await test("NetworkError with request", () => {
  const e = new NetworkError("connection refused", fakeReq);
  assert.equal(e.name, "NetworkError");
  assert.equal(e.code, "ENETWORK");
  assert.equal(e.isNetwork, true);
  assert.equal(e.request, fakeReq);
});

await test("NetworkError without request", () => {
  const e = new NetworkError("timeout");
  assert.equal(e.name, "NetworkError");
  assert.equal(e.request, undefined);
});

suite("TimeoutError");

await test("TimeoutError with timeoutMs and request", () => {
  const e = new TimeoutError(5000, fakeReq);
  assert.equal(e.name, "TimeoutError");
  assert.equal(e.code, "ETIMEOUT");
  assert.equal(e.timeoutMs, 5000);
  assert.equal(e.isTimeout, true);
  assert.equal(e.request, fakeReq);
  assert.ok(e.message.includes("5000"));
});

await test("TimeoutError without request", () => {
  const e = new TimeoutError(30000);
  assert.equal(e.name, "TimeoutError");
  assert.equal(e.request, undefined);
  assert.equal(e.timeoutMs, 30000);
});

suite("ValidationError");

await test("ValidationError with request", () => {
  const e = new ValidationError("bad url", fakeReq);
  assert.equal(e.name, "ValidationError");
  assert.equal(e.code, "EVALIDATION");
  assert.equal(e.request, fakeReq);
});

await test("ValidationError without request", () => {
  const e = new ValidationError("bad param");
  assert.equal(e.name, "ValidationError");
  assert.equal(e.request, undefined);
});

suite("AuthError");

await test("AuthError", () => {
  const e = new AuthError("invalid token");
  assert.equal(e.name, "AuthError");
  assert.equal(e.code, "EAUTH");
});

suite("ProxyError");

await test("ProxyError with request", () => {
  const e = new ProxyError("proxy auth failed", fakeReq);
  assert.equal(e.name, "ProxyError");
  assert.equal(e.code, "EPROXY");
  assert.equal(e.isProxy, true);
  assert.equal(e.request, fakeReq);
});

await test("ProxyError without request", () => {
  const e = new ProxyError("no proxy");
  assert.equal(e.name, "ProxyError");
  assert.equal(e.request, undefined);
});

suite("RedirectError");

await test("RedirectError with request", () => {
  const e = new RedirectError("too many", fakeReq);
  assert.equal(e.name, "RedirectError");
  assert.equal(e.code, "EREDIRECT");
  assert.equal(e.request, fakeReq);
});

// ============================================================================
// §3  validateErrorCode
// ============================================================================

suite("validateErrorCode");

await test("returns code for valid known codes", () => {
  const valid = [
    "ENETWORK",
    "ETIMEOUT",
    "EABORT",
    "EHTTPSTATUS",
    "ESIZELIMIT",
    "EPARSE",
    "EVALIDATION",
    "EAUTH",
    "EPROXY",
    "EREDIRECT",
    "EUNKNOWN",
  ];
  for (const c of valid) {
    assert.equal(validateErrorCode(c), c);
  }
});

await test("returns undefined for unknown string", () => {
  assert.equal(validateErrorCode("EBOGUS"), undefined);
});

await test("returns undefined for non-string types", () => {
  assert.equal(validateErrorCode(42), undefined);
  assert.equal(validateErrorCode(null), undefined);
  assert.equal(validateErrorCode(undefined), undefined);
  assert.equal(validateErrorCode({}), undefined);
  assert.equal(validateErrorCode(true), undefined);
});

// ============================================================================
// §4  Error class hierarchy — instanceof
// ============================================================================

suite("Error hierarchy");

await test("all error classes inherit from KinetexError", () => {
  assert.ok(new SizeLimitError(1, 1) instanceof KinetexError);
  assert.ok(new HTTPStatusError(fakeRes, fakeReq) instanceof KinetexError);
  assert.ok(new AbortError() instanceof KinetexError);
  assert.ok(new NetworkError("") instanceof KinetexError);
  assert.ok(new ValidationError("") instanceof KinetexError);
  assert.ok(new AuthError("") instanceof KinetexError);
  assert.ok(new ProxyError("") instanceof KinetexError);
  assert.ok(new RedirectError("") instanceof KinetexError);
  assert.ok(new TimeoutError(1) instanceof KinetexError);
});

await test("all error classes inherit from Error", () => {
  assert.ok(new SizeLimitError(1, 1) instanceof Error);
  assert.ok(new HTTPStatusError(fakeRes, fakeReq) instanceof Error);
  assert.ok(new AbortError() instanceof Error);
  assert.ok(new NetworkError("") instanceof Error);
});

suite("KinetexError status getter");

await test("status returns response.status when response set", () => {
  const e = new KinetexError("msg", "EHTTPSTATUS", { response: fakeRes });
  assert.equal(e.status, 500);
});

await test("status returns null when no response", () => {
  const e = new KinetexError("msg", "ENETWORK");
  assert.equal(e.status, null);
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`  Types tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
console.log(`════════════════════════════════════════════════════════════`);

if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
  process.exit(1);
}
process.exit(0);
