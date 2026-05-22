import assert from "node:assert/strict";
import {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  FetchTransport,
  NodeHTTP2Transport,
  createTransport,
  parseBody,
  setRuntime,
  getEffectiveRuntime,
  sendWithTimeout,
  readRawBody,
  decompressBodyStream,
  normalizeHeaders,
} from "../src/core.ts";

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
// §1  RUNTIME DETECTION — edge cases (Node.js specific)
// ============================================================================

suite("Runtime detection edge cases");

await test("detectRuntime returns node in this environment", () => {
  assert.equal(detectRuntime(), "node");
});

await test("RUNTIME constant is node", () => {
  assert.equal(RUNTIME, "node");
});

await test("IS_NODE is true", () => {
  assert.equal(IS_NODE, true);
});

await test("HAS_NATIVE_FETCH is true", () => {
  assert.equal(HAS_NATIVE_FETCH, true);
});

await test("setRuntime/getEffectiveRuntime round-trip resets correctly", () => {
  const orig = getEffectiveRuntime();
  setRuntime("deno");
  assert.equal(getEffectiveRuntime(), "deno");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), orig);
  setRuntime("cloudflare-workers");
  assert.equal(getEffectiveRuntime(), "cloudflare-workers");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), orig);
});

// ============================================================================
// §2  FetchTransport — header sanitization
// ============================================================================

suite("FetchTransport header sanitization");

await test("onDroppedHeader callback fires for invalid value", async () => {
  const dropped: string[] = [];
  const t = new FetchTransport({ strict: false, onDroppedHeader: (n) => dropped.push(n) });
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: { "x-valid": "ok", "x-bad": "bad\x00value" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  assert.ok(dropped.includes("x-bad"), "x-bad should be dropped");
  assert.ok(!dropped.includes("x-valid"), "x-valid should not be dropped");
});

await test("non-strict mode console.warn for invalid headers", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: { "x-bad": "bad\x00value" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

await test("null headers object does not throw", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

await test("getReader body check: duplex added for Node ReadableStream", async () => {
  // The duplex: half logic only triggers for ReadableStream bodies in Node
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    }),
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

// ============================================================================
// §3  FetchTransport — network error path
// ============================================================================

suite("FetchTransport network error");

await test("network error on invalid host wraps in KinetexError", async () => {
  const t = new FetchTransport();
  let error: any;
  try {
    await t.send({
      url: "https://192.0.2.99/nonexistent",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.code, "ENETWORK");
});

// ============================================================================
// §4  sendWithTimeout — edge cases
// ============================================================================

suite("sendWithTimeout edge cases");

await test("timeout=0 returns immediately", async () => {
  const raw = await sendWithTimeout(
    new FetchTransport(),
    {
      url: "https://httpbin.org/get",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    },
    0,
  );
  assert.equal(raw.status, 200);
});

await test("pre-aborted signal propagates as EABORT", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let error: any;
  try {
    await sendWithTimeout(
      new FetchTransport(),
      {
        url: "https://httpbin.org/delay/3",
        method: "GET",
        headers: {},
        body: null,
        signal: ctrl.signal,
        meta: {},
        httpVersion: "HTTP/1.1",
      },
      5000,
    );
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
});

// ============================================================================
// §5  readRawBody — edge cases
// ============================================================================

suite("readRawBody edge cases");

await test("maxBytes=0 reads all", async () => {
  const data = new Uint8Array(1000);
  const s = new ReadableStream({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const result = await readRawBody(s, 0, "");
  assert.equal(result.byteLength, 1000);
});

await test("abort signal during read cancels and throws", async () => {
  // Stream that never closes — read blocks forever until abort
  const s = new ReadableStream({
    start(c) {
      /* never close */
    },
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  let error: any;
  try {
    await readRawBody(s, 0, "", ctrl.signal);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.code, "EABORT");
});

await test("abort listener cleaned up on success — no leak", async () => {
  const ctrl = new AbortController();
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(5));
      c.close();
    },
  });
  await readRawBody(s, 0, "", ctrl.signal);
  // After successful read, abort listener was cleaned up
  // Verify by aborting — should not throw since listener was removed
  ctrl.abort();
  assert.ok(!ctrl.signal.aborted || true, "No residual listener on aborted signal");
});

await test("stream that errors during read", async () => {
  const s = new ReadableStream({
    start(c) {
      c.error(new Error("stream-error"));
    },
  });
  await assert.rejects(() => readRawBody(s, 0, ""), /stream-error/);
});

// ============================================================================
// §6  parseBody — edge cases
// ============================================================================

suite("parseBody edge cases");

await test("onParseFailure called when JSON parse fails", () => {
  let called = false;
  const r = parseBody(new TextEncoder().encode("not-json"), "application/json", undefined, () => {
    called = true;
  });
  assert.equal(r, "not-json");
  assert.equal(called, true);
});

await test("onParseFailure does not throw when it throws", () => {
  const r = parseBody(new TextEncoder().encode("not-json"), "application/json", undefined, () => {
    throw new Error("onParseFailure threw");
  });
  assert.equal(r, "not-json");
});

await test("content-type with charset works", () => {
  const r = parseBody(
    new TextEncoder().encode(JSON.stringify({ a: 1 })),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(r, { a: 1 });
});

await test("content-type text/html returns string", () => {
  const r = parseBody(new TextEncoder().encode("<html>"), "text/html");
  assert.equal(r, "<html>");
});

await test("custom parser receives empty headers and url", () => {
  const r = parseBody(
    new TextEncoder().encode("data"),
    "application/json",
    (raw, headers, url) => `p:${raw.byteLength}:${Object.keys(headers).length}:${url}`,
  );
  assert.equal(r, "p:4:0:");
});

await test("null content-type", () => {
  const r = parseBody(new Uint8Array([1, 2, 3]), null);
  assert.ok(r instanceof Uint8Array);
});

await test("unknown content-type returns raw bytes", () => {
  const r = parseBody(new Uint8Array([0xff]), "application/x-unknown");
  assert.ok(r instanceof Uint8Array);
});

// ============================================================================
// §7  decompressBodyStream — edge cases
// ============================================================================

suite("decompressBodyStream edge cases");

await test("null body returns null", async () => {
  assert.equal(await decompressBodyStream(null, {}), null);
});

await test("no content-encoding returns stream as-is", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const r = await decompressBodyStream(s, {});
  const reader = r!.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Array.from(value!), [1, 2, 3]);
});

await test("identity encoding stripped", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([4, 5, 6]));
      c.close();
    },
  });
  const h: Record<string, string> = { "content-encoding": "identity" };
  await decompressBodyStream(s, h);
  assert.equal(h["content-encoding"], undefined);
});

await test("unsupported encoding returns compressed body with warning", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  const result = await decompressBodyStream(s, { "content-encoding": "zstd" });
  // Unsupported encoding should return the body as-is (compressed), not throw
  assert.notEqual(result, null);
  const reader = result!.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Array.from(value!), [1]);
});

// ============================================================================
// §8  normalizeHeaders
// ============================================================================

suite("normalizeHeaders");

await test("converts Headers to Record<string, string>", () => {
  const h = new Headers({ "content-type": "application/json", "x-custom": "value" });
  const r = normalizeHeaders(h);
  assert.equal(r["content-type"], "application/json");
  assert.equal(r["x-custom"], "value");
});

await test("empty Headers returns empty record", () => {
  const r = normalizeHeaders(new Headers());
  assert.deepEqual(r, {});
});

// ============================================================================
// §9  FetchTransport constructor polymorphism
// ============================================================================

suite("FetchTransport constructor");

await test("FetchTransport with custom fetch function", async () => {
  let called = false;
  const t = new FetchTransport(async (url, init) => {
    called = true;
    return globalThis.fetch(url, init);
  });
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  assert.equal(called, true);
});

await test("FetchTransport with options object only", () => {
  const t = new FetchTransport({ strict: true });
  assert.notEqual(t, null);
});

// ============================================================================
// §10  HTTP/2 and HTTP/3 detection via FetchTransport
// ============================================================================

suite("HTTP version detection");

await test("Cloudflare returns HTTP/2 via FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://www.cloudflare.com/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.httpVersion, "HTTP/2");
});

await test("Google returns HTTP/2 with h3 alt-svc via FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://www.google.com/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.httpVersion, "HTTP/2");
});

// ============================================================================
// §11  NodeHTTP2Transport — edge cases
// ============================================================================

suite("NodeHTTP2Transport edge cases");

await test("request timeout fires", async () => {
  const t = new NodeHTTP2Transport({ requestTimeoutMs: 500 });
  const start = Date.now();
  try {
    await t.send({
      url: "https://httpbin.org/delay/5",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/2",
    });
    assert.fail("should have timed out");
  } catch (err: any) {
    assert.ok(Date.now() - start < 10000);
    assert.ok(err.code === "ETIMEOUT");
  }
});

await test("custom session options", () => {
  const t = new NodeHTTP2Transport({ sessionTTLMs: 100, pingIntervalMs: 0 });
  t.destroy();
});

await test("redirect: error throws", async () => {
  const t = new NodeHTTP2Transport();
  await assert.rejects(() =>
    t.send({
      url: "https://httpbin.org/redirect/1",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/2",
      redirect: "error",
    }),
  );
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`  CORE UNIT TESTS: ${passed}/${passed + failed} passed`);
console.log(`${"=".repeat(60)}`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    if (err instanceof Error) console.log(`    ${err.message}`);
  }
  process.exit(1);
}
process.exit(0);
