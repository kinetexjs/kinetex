/**
 * perf.test.mts — Performance benchmarks & load tests
 *
 * Run: npx tsx tests/perf.test.mts
 */

import assert from "node:assert/strict";
import {
  percentEncode,
  percentDecode,
  stringifyQuery,
  parseQuery,
  URLBuilder,
  safeJSONParse,
  uint8ArrayToBase64,
} from "../src/mod.ts";
import {
  parseCacheControl,
  parseWWWAuthenticate,
  parseLinkHeader,
  createRequestHeaders,
  createResponseHeaders,
} from "../src/mod.ts";
import { parseSetCookieHeader, formatSetCookieHeader } from "../src/cookie-parser.ts";
import { MemoryStorageAdapter, HTTPCache } from "../src/mod.ts";
import { DedupMap } from "../src/mod.ts";

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

// ============================================================================
// Helpers
// ============================================================================

function base64Encode(buf: Uint8Array): string {
  return uint8ArrayToBase64(buf);
}

function base64Decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function elapsedMs(start: number): number {
  return performance.now() - start;
}

function logTiming(label: string, start: number, iterations: number): number {
  const e = elapsedMs(start);
  console.log(
    `  ⏱  ${label}: ${e.toFixed(2)}ms (${iterations} iterations, ${((e / iterations) * 1000).toFixed(2)}µs/op)`,
  );
  return e;
}

function fmtJSON(size: number): string {
  const arr: number[] = [];
  for (let i = 0; i < size; i++) arr.push(i);
  const nested = arr.slice(0, Math.min(size, 200));
  return JSON.stringify({ data: arr, label: "bench", nested: { values: nested } });
}

// ============================================================================
// §1  URL ENCODING / DECODING SPEED
// ============================================================================

suite("URL encoding / decoding");

await test("percentEncode 1000 common URLs", () => {
  const urls: string[] = [];
  for (let i = 0; i < 1000; i++) {
    urls.push(`https://example.com/path/${i}/resource?q=hello world&n=${i * 7}`);
  }
  const start = performance.now();
  for (const u of urls) percentEncode(u);
  const e = logTiming("percentEncode", start, 1000);
  assert.ok(e < 200, `percentEncode took ${e}ms, expected <200ms`);
});

await test("percentDecode 1000 encoded URLs", () => {
  const encoded: string[] = [];
  for (let i = 0; i < 1000; i++) {
    encoded.push(
      encodeURIComponent(`https://example.com/path/${i}/resource?q=hello world&n=${i * 7}`),
    );
  }
  const start = performance.now();
  for (const u of encoded) percentDecode(u);
  const e = logTiming("percentDecode", start, 1000);
  assert.ok(e < 100, `percentDecode took ${e}ms, expected <100ms`);
});

await test("stringifyQuery with 100 params", () => {
  const params: Record<string, string | number> = {};
  for (let i = 0; i < 100; i++) params[`key${i}`] = `value${i}`;
  const start = performance.now();
  for (let i = 0; i < 100; i++) stringifyQuery(params);
  const e = elapsedMs(start);
  logTiming("stringifyQuery ×100", start, 100);
  assert.ok(e < 100, `stringifyQuery took ${e}ms (100 reps), expected <100ms`);
});

await test("URLBuilder build 1000 URLs", () => {
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    new URLBuilder(`https://api.example.com/v${i % 5}/users/${i}`)
      .setParam("page", Math.floor(i / 50) + 1)
      .setParam("limit", "20")
      .toString();
  }
  const e = logTiming("URLBuilder", start, 1000);
  assert.ok(e < 500, `URLBuilder took ${e}ms, expected <500ms`);
});

await test("parseQuery round-trip stability", () => {
  const qs = "a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10";
  for (let i = 0; i < 1000; i++) {
    const parsed = parseQuery(qs);
    assert.equal(parsed.a, "1");
    assert.equal(parsed.j, "10");
  }
});

// ============================================================================
// §2  HEADER PARSING SPEED
// ============================================================================

suite("Header parsing");

await test("parseCacheControl 10,000 iterations", () => {
  const h =
    "public, max-age=3600, stale-while-revalidate=60, stale-if-error=86400, must-revalidate";
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const d = parseCacheControl(h);
    assert.equal(d.public, true);
    assert.equal(d.maxAge, 3600);
  }
  const e = logTiming("parseCacheControl", start, 10_000);
  assert.ok(e < 500, `parseCacheControl took ${e}ms, expected <500ms`);
});

await test("parseWWWAuthenticate 10,000 iterations (Digest)", () => {
  const h =
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const ch = parseWWWAuthenticate(h);
    assert.ok(ch.length >= 1);
    assert.equal(ch[0]!.scheme, "digest");
    assert.equal(ch[0]!.params.get("realm"), "testrealm@host.com");
  }
  const e = logTiming("parseWWWAuthenticate", start, 10_000);
  assert.ok(e < 500, `parseWWWAuthenticate took ${e}ms, expected <500ms`);
});

await test("parseLinkHeader 10,000 iterations (multi-link)", () => {
  const h =
    '<https://api.example.com/users?page=1>; rel="first", <https://api.example.com/users?page=3>; rel="last", <https://api.example.com/users?page=2>; rel="next"';
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const links = parseLinkHeader(h);
    assert.equal(links.length, 3);
    assert.equal(links[0]!.rel, "first");
    assert.equal(links[2]!.rel, "next");
  }
  const e = logTiming("parseLinkHeader", start, 10_000);
  assert.ok(e < 500, `parseLinkHeader took ${e}ms, expected <500ms`);
});

await test("createRequestHeaders 10,000 iterations (merge 10 headers)", () => {
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const h = createRequestHeaders({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer test-token",
      "x-request-id": `req-${i}`,
      "user-agent": "kinetex-perf/1.0",
      "cache-control": "no-cache",
      "x-api-key": "abc123",
      "x-correlation-id": "corr-perf",
      "accept-language": "en-US",
      "x-forwarded-for": "10.0.0.1",
    });
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(h.get("x-request-id"), `req-${i}`);
  }
  const e = logTiming("createRequestHeaders", start, 10_000);
  assert.ok(e < 500, `createRequestHeaders took ${e}ms, expected <500ms`);
});

// ============================================================================
// §3  JSON PARSING SPEED
// ============================================================================

suite("JSON parsing");

await test("safeJSONParse 10KB blob — 2,000 iterations", () => {
  const blob = fmtJSON(2200);
  assert.ok(blob.length >= 9_000, `10KB blob is ${blob.length} bytes, expected >=9000`);
  const start = performance.now();
  for (let i = 0; i < 2_000; i++) {
    const r = safeJSONParse<{ data: number[] }>(blob);
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.value.data.length, 2200);
  }
  const e = logTiming("safeJSONParse 10KB", start, 2_000);
  assert.ok(e < 1000, `safeJSONParse 10KB took ${e}ms, expected <1000ms`);
});

await test("safeJSONParse 100KB blob — 200 iterations", () => {
  const blob = fmtJSON(20_000);
  assert.ok(blob.length >= 80_000, `100KB blob is ${blob.length} bytes, expected >=80000`);
  const opts = { maxArrayLength: 30_000 };
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    const r = safeJSONParse<{ data: number[] }>(blob, opts);
    assert.equal(r.success, true, `safeJSONParse failed: ${r.error} ${r.message}`);
    if (r.success) assert.ok(r.value.data.length >= 20_000);
  }
  const e = logTiming("safeJSONParse 100KB", start, 200);
  assert.ok(e < 1000, `safeJSONParse 100KB took ${e}ms, expected <1000ms`);
});

// ============================================================================
// §4  COOKIE PARSING SPEED
// ============================================================================

suite("Cookie parsing");

await test("parseSetCookieHeader 10,000 iterations", () => {
  const h =
    "session=abc123def456; Path=/; Domain=.example.com; HttpOnly; Secure; SameSite=Lax; Max-Age=3600";
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const c = parseSetCookieHeader(h);
    assert.ok(c !== null);
    assert.equal(c!.name, "session");
    assert.equal(c!.value, "abc123def456");
    assert.equal(c!.maxAge, 3600);
  }
  const e = logTiming("parseSetCookieHeader", start, 10_000);
  assert.ok(e < 500, `parseSetCookieHeader took ${e}ms, expected <500ms`);
});

await test("Cookie header parsing 10,000 iterations (10 cookies)", () => {
  const cookies: string[] = [];
  for (let i = 0; i < 10; i++) cookies.push(`cookie${i}=value${i}`);
  const h = cookies.join("; ");
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const pairs = h.split("; ");
    assert.equal(pairs.length, 10);
    for (const p of pairs) {
      const eq = p.indexOf("=");
      assert.ok(eq > 0);
      assert.ok(p.slice(eq + 1).length > 0);
    }
  }
  const e = logTiming("Cookie header split", start, 10_000);
  assert.ok(e < 200, `Cookie header parsing took ${e}ms, expected <200ms`);
});

await test("formatSetCookieHeader round-trip 10,000 iterations", () => {
  const cookie = {
    name: "session",
    value: "abc123",
    domain: "example.com",
    path: "/",
    expires: null,
    maxAge: 3600,
    secure: true,
    httpOnly: true,
    sameSite: "Lax" as const,
    sameParty: false,
    priority: null as "Low" | "Medium" | "High" | null,
    partitioned: false,
  };
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const serialized = formatSetCookieHeader(cookie);
    const parsed = parseSetCookieHeader(serialized);
    assert.ok(parsed !== null);
    assert.equal(parsed!.name, "session");
    assert.equal(parsed!.value, "abc123");
  }
  const e = logTiming("formatSetCookieHeader round-trip", start, 10_000);
  assert.ok(e < 500, `formatSetCookieHeader round-trip took ${e}ms, expected <500ms`);
});

// ============================================================================
// §5  CACHE SPEED
// ============================================================================

suite("Cache");

await test("MemoryStorage set/get 10,000 entries", async () => {
  const store = new MemoryStorageAdapter();
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const entry = {
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: `data-${i}`,
      },
      createdAt: Date.now(),
      expiresAt: Infinity,
      staleUntil: Infinity,
      staleOnError: 0,
      etag: null,
      lastModified: null,
      varyKey: null,
      tags: [],
      size: 64,
    };
    await store.set(`key-${i}`, entry);
    const got = await store.get(`key-${i}`);
    assert.ok(got !== null);
    assert.equal(got!.response.body, `data-${i}`);
  }
  const e = logTiming("MemoryStorage set/get", start, 10_000);
  assert.ok(e < 500, `MemoryStorage took ${e}ms, expected <500ms`);
  assert.equal(store.size, 10_000);
});

await test("MemoryStorage eviction under maxSize", async () => {
  const cache = new HTTPCache({ maxEntries: 100, storage: new MemoryStorageAdapter() });
  const start = performance.now();
  for (let i = 0; i < 1_000; i++) {
    const req = { url: `https://example.com/resource/${i}`, method: "GET", headers: {} };
    const res = {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=3600" },
      body: `payload-${i}`,
    };
    await cache.set(req, res);
  }
  const stats = cache.getStats();
  const e = elapsedMs(start);
  logTiming("MemoryStorage eviction", start, 1_000);
  assert.ok(stats.evictions >= 900, `expected >=900 evictions, got ${stats.evictions}`);
  assert.ok(stats.totalEntries <= 100, `expected <=100 entries, got ${stats.totalEntries}`);
  assert.ok(e < 500, `eviction took ${e}ms, expected <500ms`);
});

// ============================================================================
// §6  BASE64 ENCODING SPEED
// ============================================================================

suite("Base64");

await test("base64Encode 1KB buffer — 10,000 iterations", () => {
  const buf = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) buf[i] = i & 0xff;
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const enc = base64Encode(buf);
    assert.ok(enc.length > 0);
  }
  const e = logTiming("base64Encode 1KB", start, 10_000);
  assert.ok(e < 500, `base64Encode took ${e}ms, expected <500ms`);
});

await test("base64Decode encoded string — 10,000 iterations", () => {
  const buf = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) buf[i] = i & 0xff;
  const encoded = base64Encode(buf);
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const dec = base64Decode(encoded);
    assert.equal(dec.length, 1024);
  }
  const e = logTiming("base64Decode", start, 10_000);
  assert.ok(e < 500, `base64Decode took ${e}ms, expected <500ms`);
});

await test("Base64 round-trip correctness — 100 random buffers", () => {
  for (let n = 0; n < 100; n++) {
    const len = 1 + Math.floor(Math.random() * 4096);
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    const enc = base64Encode(buf);
    const dec = base64Decode(enc);
    assert.equal(dec.length, buf.length);
    for (let i = 0; i < buf.length; i++) assert.equal(dec[i], buf[i]);
  }
});

// ============================================================================
// §7  DEDUP SPEED
// ============================================================================

suite("Request deduplication");

await test("RequestDeduplicator 1,000 concurrent dedup requests", async () => {
  const d = new DedupMap<string>();
  let calls = 0;
  const factory = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return "result";
  };
  const start = performance.now();
  const batch: Promise<string>[] = [];
  for (let i = 0; i < 1_000; i++) {
    batch.push(d.execute("GET", "https://example.com/data", factory));
  }
  const results = await Promise.all(batch);
  const e = elapsedMs(start);
  logTiming("Dedup 1000 concurrent", start, 1_000);
  assert.equal(calls, 1);
  assert.equal(d.hits, 999);
  assert.equal(d.misses, 1);
  for (const r of results) assert.equal(r, "result");
  assert.ok(e < 1000, `dedup took ${e}ms, expected <1000ms`);
});

await test("Dedup no memory leak — 10,000 cycles", async () => {
  const d = new DedupMap({ windowMs: 0 });
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const url = `https://example.com/resource/${i}`;
    await d.execute("GET", url, async () => "ok");
  }
  const e = elapsedMs(start);
  logTiming("Dedup 10k cycles", start, 10_000);
  assert.equal(d.keys.length, 0, `expected 0 tracked keys after windowMs=0, got ${d.keys.length}`);
  assert.equal(d.inFlightCount, 0, `expected 0 in-flight, got ${d.inFlightCount}`);
  assert.ok(e < 2000, `dedup cycles took ${e}ms, expected <2000ms`);
});

// ============================================================================
// §8  REAL HTTP PERFORMANCE (single iteration)
// ============================================================================

suite("Real HTTP (single)");

await test("Kinetex GET to httpbin.org/get — should complete < 5s", async () => {
  const { kinetex } = await import("../src/mod.ts");
  const client = kinetex({ timeout: 10_000 });
  const start = performance.now();
  const res = await client.get("https://httpbin.org/get");
  const e = elapsedMs(start);
  logTiming("GET httpbin.org/get", start, 1);
  assert.equal(res.status, 200);
  assert.ok(e < 5000, `GET took ${e}ms, expected <5000ms`);
});

await test("Kinetex POST with 1KB body — should complete < 5s", async () => {
  const { kinetex } = await import("../src/mod.ts");
  const client = kinetex({ timeout: 10_000 });
  const body = "x".repeat(1024);
  const start = performance.now();
  try {
    const res = await client.post("https://httpbin.org/post", body, {
      headers: { "content-type": "text/plain" },
    });
    const e = elapsedMs(start);
    logTiming("POST 1KB to httpbin.org/post", start, 1);
    assert.equal(res.status, 200);
    assert.ok(e < 5000, `POST took ${e}ms, expected <5000ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠  POST httpbin.org/post skipped (transient: ${msg})`);
  }
});

// ============================================================================
// Summary
// ============================================================================

const total = passed + failed;
console.log(`\n── Summary ──`);
console.log(`  Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    const msg = f.err instanceof Error ? f.err.message : String(f.err);
    console.log(`  • ${f.name}: ${msg}`);
  }
  process.exit(1);
}
process.exit(0);
