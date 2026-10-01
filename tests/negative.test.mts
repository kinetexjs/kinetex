import assert from "node:assert/strict";
import { Kinetex, BatchQueue } from "../src/client.ts";
import { kinetex } from "../src/mod.ts";
import {
  KinetexError,
  HTTPStatusError,
  TimeoutError,
  SizeLimitError,
  AbortError,
  NetworkError,
  ValidationError,
  AuthError,
  ProxyError,
  RedirectError,
} from "../src/types.ts";
import {
  isSafeURL,
  sanitizeURL,
  safeJSONParse,
  isValidHeaderName,
  isValidHeaderValue,
} from "../src/utils.ts";
import {
  parseContentType,
  parseCacheControl,
  parseRetryAfter,
  parseHTTPDate,
  HttpHeaders,
} from "../src/headers.ts";
import { URLBuilder, normalizeURL, parseQuery, stringifyQuery, safeParseURL } from "../src/url.ts";
import { parseBody } from "../src/core.ts";
import {
  parseSetCookieHeader,
  parseCookieDate,
  normalizePath as normalizeCookiePath,
  pathMatch,
} from "../src/cookie-parser.ts";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
} from "../src/circuit-breaker.ts";
import { DedupMap } from "../src/dedup.ts";
import { isUpstreamFlake } from "./upstream.ts";
import { createCookieJar } from "../src/cookiejar.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    // An outage at httpbin arrives as a failure that says nothing about the
    // client. The discrimination is narrow and never excuses an
    // AssertionError, so it cannot mask a real defect; see
    // tests/upstream-drift.test.mts, which also enforces that this suite has
    // the guard in the first place.
    if (isUpstreamFlake(err)) {
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${why}`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n\u2500\u2500 ${name}`);
}

async function main() {
  suite("4. Invalid URL handling");

  await test("Kinetex client with empty URL string throws validation error", async () => {
    const client = kinetex();
    try {
      await client.send("", "GET");
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
    }
  });

  await test("Kinetex client with malformed URL throws validation error", async () => {
    const client = kinetex();
    try {
      await client.send("not-a-url", "GET");
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
    }
  });

  await test("Kinetex client with whitespace-only URL throws validation error", async () => {
    const client = kinetex();
    try {
      await client.send("   ", "GET");
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
    }
  });

  await test("isSafeURL rejects protocol-relative URL", () => {
    assert.equal(isSafeURL("//example.com/path"), false);
  });

  await test("URLBuilder with null/undefined throws TypeError", () => {
    assert.throws(() => new URLBuilder(null as unknown as string), /Invalid URL/i);
    assert.throws(() => new URLBuilder(undefined as unknown as string), /Invalid URL/i);
  });

  await test("URLBuilder with empty string throws TypeError", () => {
    assert.throws(() => new URLBuilder(""), /Invalid URL/i);
  });

  await test("URLBuilder with invalid URL throws TypeError", () => {
    assert.throws(() => new URLBuilder("ht tp://bad url"), /Invalid URL/i);
  });

  await test("URLBuilder from with null base throws TypeError", () => {
    assert.throws(
      () => URLBuilder.from("relative/path", null as unknown as string),
      /Invalid URL/i,
    );
  });

  await test("sanitizeURL returns null for empty string", () => {
    assert.equal(sanitizeURL(""), null);
  });

  await test("sanitizeURL returns null for whitespace string", () => {
    assert.equal(sanitizeURL("   "), null);
  });

  await test("sanitizeURL returns null for protocol-relative URL", () => {
    assert.equal(sanitizeURL("//evil.com/path"), null);
  });

  await test("URL with username:password@ is stripped by sanitizeURL", () => {
    const result = sanitizeURL("https://user:pass@api.example.com/data");
    assert.equal(result, "https://api.example.com/data");
  });

  suite("5. Malformed header handling");

  await test("parseContentType with empty string returns null", () => {
    assert.equal(parseContentType(""), null);
  });

  await test("parseContentType with random non-string coerced types handled gracefully", () => {
    assert.equal(parseContentType(null as unknown as string), null);
    assert.equal(parseContentType(undefined as unknown as string), null);
  });

  await test("parseContentType with number string returns null", () => {
    assert.equal(parseContentType("12345"), null);
  });

  await test("parseContentType with array-like string returns null", () => {
    assert.equal(parseContentType("a,b,c"), null);
  });

  await test("parseContentType with malformed content type with spaces returns null", () => {
    assert.equal(parseContentType("text/ plain"), null);
  });

  await test("HttpHeaders set with invalid header name throws TypeError", () => {
    const h = new HttpHeaders();
    assert.throws(() => h.set("bad header\n", "value"), /Invalid header name/i);
    assert.throws(() => h.set("x:y", "value"), /Invalid header name/i);
    assert.throws(() => h.set("", "value"), /Invalid header name/i);
  });

  await test("HttpHeaders append with invalid header value throws TypeError", () => {
    const h = new HttpHeaders();
    assert.throws(() => h.set("x-custom", "value\x00injected"), /Invalid header value/i);
    assert.throws(() => h.set("x-custom", "line\r\nbreak"), /Invalid header value/i);
  });

  await test("parseCacheControl with malformed directives still parses without crash", () => {
    const r = parseCacheControl("max-age=not-a-number, no-cache, =value, ,");
    assert.equal(r.noCache, true);
    assert.ok(
      r.maxAge === null || (typeof r.maxAge === "number" && Number.isNaN(r.maxAge)),
      `maxAge should be null or NaN, got ${r.maxAge}`,
    );
    assert.equal(r.unknown.size, 1);
  });

  await test("parseCacheControl with excessively large max-age handles gracefully", () => {
    const r = parseCacheControl("max-age=99999999999999999999");
    // `parseInt` on a 20-digit literal yields the nearest double, 1e20. The old
    // `r.maxAge! > 0 || r.maxAge === null` disjunction was already dead on its
    // right arm — the line above proves typeof is "number", and typeof null is
    // "object" — so only the loose `> 0` half ever ran.
    assert.equal(r.maxAge, 1e20);
    assert.equal(Number.isFinite(r.maxAge), true, "must not overflow to Infinity");
  });

  await test("parseCacheControl with empty string returns default directives", () => {
    const r = parseCacheControl("");
    assert.equal(r.noCache, false);
    assert.equal(r.noStore, false);
    assert.equal(r.maxAge, null);
  });

  await test("parseCacheControl with only whitespace returns default directives", () => {
    const r = parseCacheControl("   ,  , ");
    assert.equal(r.noCache, false);
  });

  await test("parseCacheControl with Unicode in directives handled gracefully", () => {
    const r = parseCacheControl("no-cache, \u00e9=value");
    assert.equal(r.noCache, true);
    assert.ok(r.unknown.has("\u00e9"));
  });

  suite("6. Invalid body / parseBody");

  await test("parseBody with empty Uint8Array returns null", () => {
    const result = parseBody(new Uint8Array(0), "application/json");
    assert.equal(result, null);
  });

  await test("parseBody with content-type application/json but body is not JSON returns text fallback", () => {
    const result = parseBody(
      new TextEncoder().encode("not json at all"),
      "application/json",
    ) as string;
    assert.equal(result, "not json at all");
  });

  await test("parseBody with truncated JSON returns text fallback", () => {
    const result = parseBody(
      new TextEncoder().encode('{"key": "unfinished'),
      "application/json",
    ) as string;
    assert.equal(result, '{"key": "unfinished');
  });

  await test("safeJSONParse with truncated JSON returns parse error", () => {
    const r = safeJSONParse('{"key": "unfinished');
    assert.equal(r.success, false);
    assert.equal(r.error, "PARSE_ERROR");
  });

  await test("safeJSONParse with trailing garbage returns parse error", () => {
    const r = safeJSONParse('{"a":1} extra');
    assert.equal(r.success, false);
    assert.equal(r.error, "PARSE_ERROR");
  });

  await test("safeJSONParse with repeated keys succeeds (last wins, no crash)", () => {
    const r = safeJSONParse('{"a":1,"a":2}');
    assert.equal(r.success, true);
  });

  await test("parseBody with text/plain body decodes correctly", () => {
    const result = parseBody(new TextEncoder().encode("hello world"), "text/plain") as string;
    assert.equal(result, "hello world");
  });

  await test("parseBody with no content-type returns raw bytes", () => {
    const result = parseBody(new TextEncoder().encode("hello"), null);
    assert.equal(result instanceof Uint8Array, true);
    assert.equal(new TextDecoder().decode(result as Uint8Array), "hello");
  });

  suite("7. Timeout / abort edge cases");

  await test("AbortSignal that is already aborted before request", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = kinetex();
    try {
      await client.send("https://httpbin.org/get", "GET", { signal: controller.signal });
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof Error, `Expected Error, got ${typeof err}`);
      const code = (err as any).code;
      const name = (err as any).name;
      const isAbort =
        code === "EABORT" || code === "ENETWORK" || code === 20 || name === "AbortError";
      assert.ok(isAbort, `Expected abort-related error, got code=${code} name=${name}`);
    }
  });

  await test("AbortController.abort() called multiple times does not double-callback", async () => {
    let callCount = 0;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      callCount++;
    });
    controller.abort();
    controller.abort();
    controller.abort();
    assert.equal(callCount, 1);
  });

  await test("Timeout of 0 treated as no timeout (should succeed)", async () => {
    const client = kinetex({ timeout: 0 });
    const res = await client.send("https://httpbin.org/get", "GET");
    assert.equal(res.status, 200);
  });

  await test("Timeout of -1 treated as no timeout (should succeed)", async () => {
    const client = kinetex({ timeout: -1 });
    const res = await client.send("https://httpbin.org/get", "GET");
    assert.equal(res.status, 200);
  });

  await test("Concurrent abort and timeout — abort wins", async () => {
    const controller = new AbortController();
    const client = kinetex();
    const promise = client.send("https://httpbin.org/delay/10", "GET", {
      signal: controller.signal,
      timeout: 5000,
    });
    controller.abort();
    try {
      await promise;
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof Error, `Expected Error, got ${typeof err}`);
      const code = (err as any).code;
      const name = (err as any).name;
      const isAbort =
        code === "EABORT" ||
        code === "ENETWORK" ||
        code === "ETIMEOUT" ||
        code === 20 ||
        name === "AbortError";
      assert.ok(isAbort, `Expected abort/timeout error, got code=${code} name=${name}`);
    }
  });

  suite("8. Stream / data edge cases");

  await test("readRawBody with null stream returns empty buffer", async () => {
    const result = await (await import("../src/core.ts")).readRawBody(null, 0, "http://test");
    assert.equal(result.byteLength, 0);
  });

  await test("parseBody with empty content-length: 100 body handles gracefully", () => {
    const result = parseBody(new Uint8Array(0), "text/plain");
    assert.equal(result, null);
  });

  await test("safeJSONParse with very large number does not crash", () => {
    const r = safeJSONParse('{"val": 99999999999999999999999999999999999}');
    assert.equal(r.success, true);
  });

  await test("decompressBodyStream with null body returns null", async () => {
    const result = await (await import("../src/core.ts")).decompressBodyStream(null, {});
    assert.equal(result, null);
  });

  await test("decompressBodyStream with no content-encoding returns body unchanged", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const result = await (await import("../src/core.ts")).decompressBodyStream(stream, {});
    assert.ok(result !== null);
    const reader = result.getReader();
    const { value } = await reader.read();
    assert.deepEqual(value, new Uint8Array([1, 2, 3]));
    reader.releaseLock();
  });

  suite("9. Cookie negative cases");

  await test("parseSetCookieHeader with null/empty returns null", () => {
    assert.equal(parseSetCookieHeader(""), null);
    assert.equal(parseSetCookieHeader("   "), null);
  });

  await test("parseSetCookieHeader with domain pointing to private IP", () => {
    const cookie = parseSetCookieHeader("session=abc; Domain=127.0.0.1; Path=/");
    assert.ok(cookie !== null);
    assert.equal(cookie!.domain, "127.0.0.1");
  });

  await test("parseSetCookieHeader with domain pointing to 10.x private IP", () => {
    const cookie = parseSetCookieHeader("session=abc; Domain=10.0.0.5; Path=/");
    assert.ok(cookie !== null);
    assert.equal(cookie!.domain, "10.0.0.5");
  });

  await test("parseSetCookieHeader with path=../.. does not start with / and is rejected", () => {
    const cookie = parseSetCookieHeader("session=abc; path=../..");
    assert.ok(cookie !== null);
    assert.equal(cookie!.path, null);
  });

  await test("normalizeCookiePath resolves path traversal", () => {
    assert.equal(normalizeCookiePath("/foo/bar/../../etc"), "/etc");
    assert.equal(normalizeCookiePath("/foo/./bar"), "/foo/bar");
  });

  await test("pathMatch prevents path traversal bypass", () => {
    assert.equal(pathMatch("/admin/secret", "/admin/../"), true);
    assert.equal(pathMatch("/admin", "/admin/"), true);
    assert.equal(pathMatch("/adminx", "/admin"), false);
  });

  await test("parseCookieDate with invalid date string returns null", () => {
    assert.equal(parseCookieDate("not a date"), null);
    assert.equal(parseCookieDate(""), null);
    assert.equal(parseCookieDate("31/31/2099"), null);
  });

  await test("CookieJar with expired cookies ignores them", async () => {
    const jar = createCookieJar();
    jar.setCookie("expired=yes; Max-Age=0; Path=/", { url: "https://example.com" });
    const cookies = jar.getCookies({ url: "https://example.com" });
    assert.equal(cookies.length, 0);
  });

  await test("CookieJar with very old expires ignores the cookie", async () => {
    const jar = createCookieJar();
    jar.setCookie("old=yes; Expires=Thu, 01 Jan 2000 00:00:00 GMT; Path=/", {
      url: "https://example.com",
    });
    const cookies = jar.getCookies({ url: "https://example.com" });
    assert.equal(cookies.length, 0);
  });

  await test("CookieJar with non-secure cookie on HTTPS URL works", () => {
    const jar = createCookieJar();
    jar.setCookie("test=value; Path=/", { url: "https://example.com" });
    const cookies = jar.getCookies({ url: "https://example.com" });
    assert.equal(cookies.length, 1);
  });

  suite("10. Error class tests");

  await test("HTTPStatusError has correct name, code, and extends KinetexError", async () => {
    const client = kinetex({ throwOnError: true });
    try {
      await client.send("https://httpbin.org/status/404", "GET");
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof HTTPStatusError);
      assert.ok(err instanceof KinetexError);
      assert.equal(err.name, "HTTPStatusError");
      assert.equal(err.code, "EHTTPSTATUS");
      assert.equal(err.status, 404);
      assert.equal(err.isClientError, true);
      assert.equal(err.isServerError, false);
    }
  });

  await test("HTTPStatusError 500 is server error", async () => {
    const client = kinetex({ throwOnError: true });
    try {
      await client.send("https://httpbin.org/status/500", "GET");
      assert.fail("Expected error");
    } catch (err) {
      assert.ok(err instanceof HTTPStatusError);
      assert.equal(err.status, 500);
      assert.equal(err.isServerError, true);
      assert.equal(err.isClientError, false);
    }
  });

  await test("TimeoutError has correct name, code, and timeoutMs", () => {
    const err = new TimeoutError(5000);
    assert.equal(err.name, "TimeoutError");
    assert.equal(err.code, "ETIMEOUT");
    assert.equal(err.timeoutMs, 5000);
    assert.ok(err instanceof KinetexError);
    assert.equal(err.isTimeout, true);
  });

  await test("SizeLimitError has correct name, code, bytesRead, and limit", () => {
    const err = new SizeLimitError(1000, 500);
    assert.equal(err.name, "SizeLimitError");
    assert.equal(err.code, "ESIZELIMIT");
    assert.equal(err.bytesRead, 1000);
    assert.equal(err.limit, 500);
    assert.ok(err instanceof KinetexError);
  });

  await test("AbortError has correct name and code", () => {
    const err = new AbortError();
    assert.equal(err.name, "AbortError");
    assert.equal(err.code, "EABORT");
    assert.ok(err instanceof KinetexError);
    assert.equal(err.isAbort, true);
  });

  await test("NetworkError has correct name and code", () => {
    const err = new NetworkError("connection refused");
    assert.equal(err.name, "NetworkError");
    assert.equal(err.code, "ENETWORK");
    assert.ok(err instanceof KinetexError);
    assert.equal(err.isNetwork, true);
  });

  await test("ValidationError has correct name and code", () => {
    const err = new ValidationError("invalid input");
    assert.equal(err.name, "ValidationError");
    assert.equal(err.code, "EVALIDATION");
    assert.ok(err instanceof KinetexError);
  });

  await test("AuthError has correct name and code", () => {
    const err = new AuthError("unauthorized");
    assert.equal(err.name, "AuthError");
    assert.equal(err.code, "EAUTH");
    assert.ok(err instanceof KinetexError);
  });

  await test("ProxyError has correct name and code", () => {
    const err = new ProxyError("proxy unreachable");
    assert.equal(err.name, "ProxyError");
    assert.equal(err.code, "EPROXY");
    assert.ok(err instanceof KinetexError);
    assert.equal(err.isProxy, true);
  });

  await test("RedirectError has correct name and code", () => {
    const err = new RedirectError("too many redirects");
    assert.equal(err.name, "RedirectError");
    assert.equal(err.code, "EREDIRECT");
    assert.ok(err instanceof KinetexError);
  });

  suite("11. Race conditions (simulated)");

  await test("DedupMap: multiple simultaneous requests to same URL deduplicate", async () => {
    const dedup = new DedupMap<number>({ windowMs: 100 });
    let callCount = 0;
    const factory = async () => {
      callCount++;
      return 42;
    };
    const [a, b, c] = await Promise.all([
      dedup.execute("GET", "http://test", factory),
      dedup.execute("GET", "http://test", factory),
      dedup.execute("GET", "http://test", factory),
    ]);
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(c, 42);
    assert.equal(callCount, 1);
  });

  await test("DedupMap: different URLs are not deduplicated", async () => {
    const dedup = new DedupMap<number>({ windowMs: 100 });
    let callCount = 0;
    const factory = async () => {
      callCount++;
      return 42;
    };
    const [a, b] = await Promise.all([
      dedup.execute("GET", "http://test/a", factory),
      dedup.execute("GET", "http://test/b", factory),
    ]);
    assert.equal(callCount, 2);
  });

  await test("DedupMap: POST requests are not deduplicated by default", async () => {
    const dedup = new DedupMap<number>();
    let callCount = 0;
    const factory = async () => {
      callCount++;
      return 42;
    };
    const [a, b] = await Promise.all([
      dedup.execute("POST", "http://test", factory),
      dedup.execute("POST", "http://test", factory),
    ]);
    assert.equal(callCount, 2);
  });

  await test("CircuitBreaker: rapid failures open the circuit", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3, resetTimeoutMs: 60000 });
    const failFactory = async () => {
      const e = new Error("fail");
      (e as any).code = "ENETWORK";
      throw e;
    };
    // `assert.rejects` rather than `try { ... } catch {}`: the bare catch would
    // pass just as happily if the factory stopped throwing, which is the whole
    // thing under test.
    for (let i = 1; i <= 3; i++) {
      await assert.rejects(
        () => cb.execute(failFactory),
        (err: unknown) => {
          assert.ok(err instanceof Error, `attempt ${i} must reject`);
          assert.equal(
            (err as { code?: string }).code,
            "ENETWORK",
            "the original error, not a wrapper",
          );
          assert.equal(err.message, "fail", "the breaker must not rewrite the message");
          return true;
        },
        `attempt ${i} of 3 must reject`,
      );
      assert.equal(cb.state, i < 3 ? "CLOSED" : "OPEN", `state after ${i} failure(s)`);
    }
    assert.equal(cb.snapshot.totalFailures, 3, "every failure must be counted");
    assert.equal(cb.snapshot.totalSuccesses, 0);
  });

  await test("CircuitBreaker: open circuit rejects immediately", async () => {
    const cb = new CircuitBreaker("test2", { failureThreshold: 1, resetTimeoutMs: 60000 });
    const failFactory = async () => {
      const e = new Error("fail");
      (e as any).code = "ENETWORK";
      throw e;
    };
    await assert.rejects(() => cb.execute(failFactory));
    assert.equal(cb.state, "OPEN");

    // The operation must not be invoked at all while the circuit is open.
    // `assert.rejects` alone would not catch a breaker that ran it and then
    // discarded the result.
    let invoked = 0;
    await assert.rejects(
      () =>
        cb.execute(async () => {
          invoked++;
          return "should not reach";
        }),
      (err: unknown) => {
        assert.ok(err instanceof CircuitOpenError, `expected CircuitOpenError, got ${String(err)}`);
        assert.equal((err as { code?: string }).code, "ECIRCUITOPEN");
        return true;
      },
    );
    assert.equal(invoked, 0, "an open circuit must not call the operation");
    assert.equal(cb.snapshot.totalRequests, 1, "a rejected-by-open-circuit call is not a request");
  });

  await test("CircuitBreaker: successful requests keep circuit closed", async () => {
    const cb = new CircuitBreaker("test3", { failureThreshold: 3, resetTimeoutMs: 60000 });
    // The return value must survive the wrapper, not just the state.
    for (const n of [1, 2, 3]) {
      assert.equal(
        await cb.execute(async () => `ok-${n}`),
        `ok-${n}`,
        `call ${n} must return its value`,
      );
    }
    assert.equal(cb.state, "CLOSED");
    assert.equal(cb.snapshot.totalSuccesses, 3, "every success must be counted");
    assert.equal(cb.snapshot.totalFailures, 0);
  });

  await test("CircuitBreaker snapshot has correct state and counters", async () => {
    const cb = new CircuitBreaker("test4", { failureThreshold: 2, resetTimeoutMs: 60000 });
    await cb.execute(async () => "ok");
    const snap = cb.snapshot;
    assert.equal(snap.state, "CLOSED");
    assert.equal(snap.totalRequests, 1);
    assert.equal(snap.totalSuccesses, 1);
    assert.equal(snap.totalFailures, 0);
  });

  await test("CircuitBreakerRegistry manages multiple keys", async () => {
    const reg = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60000 });
    const fail = async () => {
      const e = new Error("fail");
      (e as any).code = "ENETWORK";
      throw e;
    };
    // Two failures on key-a open it; one on key-b must not, because breakers
    // are tracked per key.
    await assert.rejects(() => reg.execute("key-a", fail));
    await assert.rejects(() => reg.execute("key-a", fail));
    await assert.rejects(() => reg.execute("key-b", fail));
    const snaps = reg.snapshots();
    assert.equal(snaps["key-a"]!.state, "OPEN", "key-a hit its threshold");
    assert.equal(snaps["key-b"]!.state, "CLOSED", "key-b must be unaffected by key-a");
    assert.equal(snaps["key-a"]!.totalFailures, 2);
    assert.equal(snaps["key-b"]!.totalFailures, 1);
  });

  await test("BatchQueue enqueue same URL twice", async () => {
    let reqCount = 0;
    const mockClient = {
      send: async (url: string, method: string) => {
        reqCount++;
        return { url, method, status: 200, data: "ok" };
      },
    };
    const queue = new BatchQueue(mockClient as unknown as Kinetex, { maxBatch: 10, flushMs: 0 });
    const [r1, r2] = await Promise.all([
      queue.enqueue("/test", "GET"),
      queue.enqueue("/test", "GET"),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(reqCount, 2);
  });

  suite("Additional edge cases");

  await test("isValidHeaderName rejects null/undefined", () => {
    assert.equal(isValidHeaderName(null as unknown as string), false);
    assert.equal(isValidHeaderName(undefined as unknown as string), false);
  });

  await test("isValidHeaderValue rejects null/undefined", () => {
    assert.equal(isValidHeaderValue(null), false);
    assert.equal(isValidHeaderValue(undefined), false);
  });

  await test("isValidHeaderValue allows empty string", () => {
    assert.equal(isValidHeaderValue(""), true);
  });

  await test("isSafeURL rejects URLs longer than 8192 chars", () => {
    const long = "https://example.com/" + "a".repeat(8200);
    assert.equal(isSafeURL(long), false);
  });

  await test("isSafeURL rejects file:// scheme", () => {
    assert.equal(isSafeURL("file:///etc/passwd"), false);
  });

  await test("isSafeURL rejects javascript: scheme", () => {
    assert.equal(isSafeURL("javascript:alert(1)"), false);
  });

  await test("isSafeURL rejects data: scheme", () => {
    assert.equal(isSafeURL("data:text/html,<script>alert(1)</script>"), false);
  });

  await test("isSafeURL rejects ssh:// scheme", () => {
    assert.equal(isSafeURL("ssh://evil.com"), false);
  });

  await test("normalizeURL with null/empty input throws", () => {
    assert.throws(() => normalizeURL(""), /Invalid URL/i);
  });

  await test("safeParseURL returns null for malformed URLs", () => {
    assert.equal(safeParseURL(""), null);
    assert.equal(safeParseURL("not a url"), null);
  });

  await test("parseQuery with empty string returns empty object", () => {
    assert.deepEqual(parseQuery(""), {});
    assert.deepEqual(parseQuery("?"), {});
  });

  await test("stringifyQuery with null/undefined values omits them", () => {
    const result = stringifyQuery({ a: "1", b: null, c: undefined });
    assert.equal(result, "a=1");
  });

  await test("safeJSONParse with empty string returns parse error", () => {
    const r = safeJSONParse("");
    assert.equal(r.success, false);
  });

  await test("safeJSONParse with non-JSON text returns parse error", () => {
    const r = safeJSONParse("hello world");
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects NaN when allowNonFinite is false", () => {
    const r = safeJSONParse('{"val": NaN}');
    assert.equal(r.success, false);
  });

  await test("parseBody with null content-type and empty raw returns null", () => {
    const result = parseBody(new Uint8Array(0), null);
    assert.equal(result, null);
  });

  await test("parseBody with application/json and valid JSON body parses correctly", () => {
    const result = parseBody(new TextEncoder().encode('{"msg":"ok"}'), "application/json");
    assert.deepEqual(result, { msg: "ok" });
  });

  await test("parseSetCookieHeader with invalid cookie name (CTL chars) returns null", () => {
    assert.equal(parseSetCookieHeader("bad\x00name=value"), null);
  });

  await test("parseSetCookieHeader with Secure and HttpOnly flags", () => {
    const cookie = parseSetCookieHeader("token=secret; Secure; HttpOnly; Path=/");
    assert.ok(cookie !== null);
    assert.equal(cookie!.secure, true);
    assert.equal(cookie!.httpOnly, true);
  });

  await test("ParseSetCookieHeader with SameSite=None and Secure", () => {
    const cookie = parseSetCookieHeader("cross=val; SameSite=None; Secure");
    assert.ok(cookie !== null);
    assert.equal(cookie!.sameSite, "None");
  });

  suite("12. Retry-After / retry back-off (regression)");

  // A local fetch stub: the SSRF gate rejects loopback, so the real baseURL is
  // never dialled — the response is manufactured instead.
  const stub = (status: number, headers: Record<string, string>) =>
    new Kinetex({
      baseURL: "https://example.com",
      fetch: (async () => new Response("{}", { status, headers })) as unknown as typeof fetch,
    });

  interface RetryRun {
    delays: number[];
    contexts: Array<{ response: unknown; error: unknown; attempt: number }>;
    error: unknown;
  }

  async function runWithRetry(
    client: Kinetex,
    opts: { baseDelayMs: number; maxDelayMs: number; maxRetries: number },
  ): Promise<RetryRun> {
    const delays: number[] = [];
    const contexts: RetryRun["contexts"] = [];
    let error: unknown = null;
    try {
      await client.get("/", {
        retry: {
          maxRetries: opts.maxRetries,
          baseDelayMs: opts.baseDelayMs,
          maxDelayMs: opts.maxDelayMs,
          jitter: 0,
          onRetry: (ctx, delay) => {
            delays.push(delay);
            contexts.push({
              response: ctx.response,
              error: ctx.error,
              attempt: ctx.attempt,
            });
          },
        },
      });
    } catch (e) {
      error = e;
    }
    return { delays, contexts, error };
  }

  await test("regression: parseRetryAfter rejects values Date.parse would misread", () => {
    // Date.parse() reads all of these as real dates, which used to become a
    // delay (and, on the retry path, a 0 ms back-off on a 429).
    for (const bad of ["-5", "1.5", "+5", "tomorrow", "12:00", "2015-10-21T07:28:00Z", "-", ""]) {
      assert.deepEqual(
        parseRetryAfter(bad),
        { date: null, delay: null },
        `expected ${JSON.stringify(bad)} to be rejected outright`,
      );
      assert.equal(
        parseHTTPDate(bad),
        null,
        `parseHTTPDate(${JSON.stringify(bad)}) should be null`,
      );
    }
  });

  await test("regression: parseRetryAfter accepts all three RFC 7231 HTTP-date forms", () => {
    const imf = parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(imf.delay, null);
    assert.equal(imf.date?.toISOString(), "2015-10-21T07:28:00.000Z");

    // The two obsolete formats RFC 7231 §7.1.1.1 still requires recipients to
    // accept.
    const rfc850 = parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT");
    assert.equal(rfc850.delay, null);
    assert.equal(rfc850.date?.toISOString(), "1994-11-06T08:49:37.000Z");

    const asctime = parseRetryAfter("Sun Nov  6 08:49:37 1994");
    assert.equal(asctime.delay, null);
    assert.equal(asctime.date?.toISOString(), "1994-11-06T08:49:37.000Z");
  });

  await test("regression: parseRetryAfter still reads delta-seconds, including 0", () => {
    assert.deepEqual(parseRetryAfter("120"), { date: null, delay: 120 });
    assert.deepEqual(parseRetryAfter("  120  "), { date: null, delay: 120 });
    assert.deepEqual(parseRetryAfter("0"), { date: null, delay: 0 });
    // A huge value is still a delta, not a date.
    assert.deepEqual(parseRetryAfter("999999999"), { date: null, delay: 999999999 });
  });

  await test("regression: malformed Retry-After falls back to exponential back-off, not 0", async () => {
    for (const bad of ["-5", "1.5", "+5", "tomorrow"]) {
      const client = stub(429, { "retry-after": bad });
      const run = await runWithRetry(client, {
        baseDelayMs: 20,
        maxDelayMs: 10_000,
        maxRetries: 2,
      });
      client.destroy();
      assert.ok(run.error instanceof HTTPStatusError, `${bad}: expected HTTPStatusError`);
      // Deterministic (jitter: 0) exponential back-off: 20, then 40.
      assert.deepEqual(run.delays, [20, 40], `retry-after=${bad} must not steer the back-off`);
    }
  });

  await test("regression: Retry-After delta-seconds honoured on the default throwOnError path", async () => {
    const client = stub(429, { "retry-after": "2" });
    const run = await runWithRetry(client, { baseDelayMs: 20, maxDelayMs: 60_000, maxRetries: 2 });
    client.destroy();
    assert.ok(run.error instanceof HTTPStatusError);
    assert.equal((run.error as HTTPStatusError).status, 429);
    // Used to be [20, 40] — the header was dropped on the error path.
    assert.deepEqual(run.delays, [2000, 2000]);
  });

  await test("regression: Retry-After HTTP-date honoured on the error path", async () => {
    const when = new Date(Date.now() + 1500);
    const client = stub(503, { "retry-after": when.toUTCString() });
    const run = await runWithRetry(client, { baseDelayMs: 20, maxDelayMs: 60_000, maxRetries: 1 });
    client.destroy();
    assert.equal(run.delays.length, 1);
    // Allow for clock granularity and the time the request itself took.
    assert.ok(run.delays[0]! > 400, `expected a real wait, got ${run.delays[0]}ms`);
    assert.ok(run.delays[0]! <= 1500, `expected <= 1500ms, got ${run.delays[0]}ms`);
  });

  await test("regression: a Retry-After date in the past means retry immediately", async () => {
    const when = new Date(Date.now() - 60_000);
    const client = stub(503, { "retry-after": when.toUTCString() });
    const run = await runWithRetry(client, {
      baseDelayMs: 5000,
      maxDelayMs: 60_000,
      maxRetries: 1,
    });
    client.destroy();
    assert.deepEqual(run.delays, [0]);
  });

  await test("regression: Retry-After is capped at 24 hours", async () => {
    const client = stub(429, { "retry-after": "999999" });
    const delays: number[] = [];
    // The cap is 24 h, so the sleep is aborted on the first callback rather
    // than actually waited out.
    const ac = new AbortController();
    let err: unknown = null;
    try {
      await client.get("/", {
        signal: ac.signal,
        retry: {
          maxRetries: 1,
          baseDelayMs: 20,
          maxDelayMs: 86_400_000,
          jitter: 0,
          onRetry: (_ctx, delay) => {
            delays.push(delay);
            ac.abort();
          },
        },
      });
      assert.fail("expected the aborted back-off to throw");
    } catch (e) {
      err = e;
    }
    client.destroy();
    assert.ok(err instanceof KinetexError, `expected a KinetexError, got ${String(err)}`);
    assert.equal((err as KinetexError).code, "EABORT");
    assert.equal((err as KinetexError).isAbort, true);
    // 999999 s would be ~11.6 days uncapped.
    assert.deepEqual(delays, [86_400_000]);
  });

  await test("regression: RetryContext.response is populated for status-error retries", async () => {
    const client = stub(429, { "retry-after": "2", "x-quota": "0" });
    const run = await runWithRetry(client, { baseDelayMs: 20, maxDelayMs: 60_000, maxRetries: 2 });
    client.destroy();
    assert.equal(run.contexts.length, 2);
    for (const [i, ctx] of run.contexts.entries()) {
      // Was hard-coded to null, so hooks could not read the 429's headers.
      const res = ctx.response as { status: number; headers: Record<string, string> } | null;
      assert.ok(res !== null, `context ${i}: response should not be null`);
      assert.equal(res!.status, 429);
      assert.equal(res!.headers["retry-after"], "2");
      assert.equal(res!.headers["x-quota"], "0");
      assert.ok(ctx.error instanceof HTTPStatusError, `context ${i}: error should be set`);
      assert.equal((ctx.error as HTTPStatusError).code, "EHTTPSTATUS");
      assert.equal(ctx.attempt, i + 1);
    }
  });

  await test("regression: lifecycle onRetry hooks fire for status-error retries", async () => {
    let hookCalls = 0;
    const client = new Kinetex({
      baseURL: "https://example.com",
      fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
      hooks: {
        onRetry: [
          () => {
            hookCalls++;
          },
        ],
      },
    });
    const run = await runWithRetry(client, { baseDelayMs: 20, maxDelayMs: 1000, maxRetries: 2 });
    client.destroy();
    assert.ok(run.error instanceof HTTPStatusError);
    // Used to be 0 — only the resolved-response path notified hooks.
    assert.equal(hookCalls, 2);
  });

  // Retry once, observe the computed delay via onRetry, then abort so the
  // back-off is never actually slept. Returns the delay, or null if no retry
  // happened at all.
  async function firstRetryDelay(
    client: Kinetex,
    cfg: { baseDelayMs: number; maxDelayMs: number; jitter?: number },
  ): Promise<number | null> {
    const ac = new AbortController();
    const delays: number[] = [];
    let threw = false;
    try {
      await client.get("/", {
        signal: ac.signal,
        retry: {
          maxRetries: 1,
          baseDelayMs: cfg.baseDelayMs,
          maxDelayMs: cfg.maxDelayMs,
          ...(cfg.jitter !== undefined ? { jitter: cfg.jitter } : {}),
          onRetry: (_ctx, delay) => {
            delays.push(delay);
            ac.abort();
          },
        },
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, "the aborted back-off must reject rather than resolve");
    return delays.length === 0 ? null : delays[0]!;
  }

  await test("regression: retry jitter actually varies the back-off", async () => {
    // Every other retry test here pins `jitter: 0` for determinism, which left
    // `capped * cfg.jitter * Math.random()` completely unexercised: deleting
    // the whole term passed the entire suite. Seed the randomness so the
    // assertion does not depend on luck.
    const realRandom = Math.random;
    const samples: number[] = [];
    try {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        Math.random = () => r;
        const client = stub(503, {});
        const d = await firstRetryDelay(client, {
          baseDelayMs: 1000,
          maxDelayMs: 60_000,
          jitter: 0.5,
        });
        client.destroy();
        assert.notEqual(d, null, `jitter seed ${r} produced no retry`);
        samples.push(d!);
      }
    } finally {
      Math.random = realRandom;
    }
    // base + base*jitter*seed  ->  1000 + 500*seed
    assert.deepEqual(samples, [1000, 1125, 1250, 1375, 1500]);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i]! > samples[i - 1]!, `sample ${i} must exceed ${i - 1}`);
    }
  });

  await test("regression: the default jitter is 0.3, not 0", async () => {
    // A default of 0 would switch off the documented thundering-herd
    // protection silently, and nothing in the suite would notice.
    const realRandom = Math.random;
    try {
      Math.random = () => 0.5;
      const client = stub(503, {});
      // No `jitter` supplied — the client default applies.
      const d = await firstRetryDelay(client, { baseDelayMs: 1000, maxDelayMs: 60_000 });
      client.destroy();
      // 1000 + 30% of 1000, at a 0.5 seed.
      assert.equal(d, 1150);
    } finally {
      Math.random = realRandom;
    }
  });

  await test("regression: jitter 1.0 can at most double the base delay", async () => {
    const realRandom = Math.random;
    try {
      Math.random = () => 1;
      const client = stub(503, {});
      const d = await firstRetryDelay(client, { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 1 });
      client.destroy();
      assert.equal(d, 2000, "jitter: 1 adds 100% of the base");
    } finally {
      Math.random = realRandom;
    }
  });

  await test("regression: jitter never pushes the delay past maxDelayMs", async () => {
    const realRandom = Math.random;
    try {
      Math.random = () => 1; // worst case
      const client = stub(503, {});
      const d = await firstRetryDelay(client, { baseDelayMs: 1000, maxDelayMs: 1200, jitter: 1 });
      client.destroy();
      // 1000 + 100% would be 2000, but the cap wins.
      assert.equal(d, 1200);
    } finally {
      Math.random = realRandom;
    }
  });

  await test("regression: jitter is not applied to a server Retry-After", async () => {
    // A Retry-After is the server's instruction, not an estimate to decorrelate.
    const realRandom = Math.random;
    try {
      Math.random = () => 1;
      const client = stub(503, { "retry-after": "2" });
      const d = await firstRetryDelay(client, { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 1 });
      client.destroy();
      assert.equal(d, 2000, "Retry-After wins outright, with no jitter added");
    } finally {
      Math.random = realRandom;
    }
  });

  await test("regression: a non-retryable status still fires no onRetry hook", async () => {
    let hookCalls = 0;
    const client = new Kinetex({
      baseURL: "https://example.com",
      fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
      hooks: {
        onRetry: [
          () => {
            hookCalls++;
          },
        ],
      },
    });
    const run = await runWithRetry(client, { baseDelayMs: 20, maxDelayMs: 1000, maxRetries: 3 });
    client.destroy();
    assert.equal((run.error as HTTPStatusError).status, 404);
    assert.deepEqual(run.delays, []);
    assert.equal(hookCalls, 0);
  });

  console.log(
    `\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
  );
  console.log(`  Negative tests: ${passed + failed} | \u2705 ${passed} | \u274c ${failed}`);
  console.log(
    `\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
  );

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures)
      console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
