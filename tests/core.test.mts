import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function run(name: string, fn: () => void | Promise<void>) {
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

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

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
} from "../src/mod.ts";
import { sendWithTimeout, readRawBody, decompressBodyStream } from "../src/core.ts";

// ============================================================================
// §1  RUNTIME DETECTION
// ============================================================================

suite("Runtime detection");

await run("detectRuntime returns a known runtime string", () => {
  const valid = [
    "node",
    "deno",
    "bun",
    "browser",
    "cloudflare-workers",
    "edge",
    "workerd",
    "unknown",
  ];
  assert.ok(valid.includes(detectRuntime()));
});

await run("RUNTIME constant matches detectRuntime()", () => assert.equal(RUNTIME, detectRuntime()));

await run("IS_NODE is true in Node.js", () => assert.equal(IS_NODE, true));

await run("HAS_NATIVE_FETCH is true in Node 18+", () => assert.equal(HAS_NATIVE_FETCH, true));

await run("setRuntime/getEffectiveRuntime override", () => {
  const prev = getEffectiveRuntime();
  setRuntime("deno");
  assert.equal(getEffectiveRuntime(), "deno");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), prev);
  setRuntime("bun");
  assert.equal(getEffectiveRuntime(), "bun");
  setRuntime(null);
});

// ============================================================================
// §2  TRANSPORT CREATION
// ============================================================================

suite("Transport creation");

await run("createTransport returns transport with send", () => {
  assert.equal(typeof createTransport().send, "function");
});

await run("createTransport with custom fetch (HTTP/1.1)", () => {
  let called = false;
  const t = createTransport(async (url, init) => {
    called = true;
    return globalThis.fetch(url, init);
  }, false);
  assert.notEqual(t, null);
});

// ============================================================================
// §3  FetchTransport
// ============================================================================

suite("FetchTransport");

await run("GET returns 200", async () => {
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

await run("strict mode rejects invalid headers", async () => {
  const t = new FetchTransport({ strict: true });
  await assert.rejects(() =>
    t.send({
      url: "https://httpbin.org/get",
      method: "GET",
      headers: { x: "bad\x00header" },
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    }),
  );
});

await run("POST with JSON body returns 200", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ test: true }),
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

await run("accept-encoding header default value is removed by FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/headers",
    method: "GET",
    headers: { "accept-encoding": "gzip, deflate, br" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  const body = (await new Response(raw.body!).json()) as { headers: Record<string, string> };
  const ae = (body.headers["Accept-Encoding"] ?? "").toLowerCase();
  // Our default "gzip, deflate, br" value should be stripped so fetch()
  // can set its own. Node's fetch adds its own accept-encoding.
  assert.ok(
    !ae.startsWith("gzip"),
    `Our default accept-encoding value should be stripped. Got: ${ae}`,
  );
});

await run("explicit accept-encoding value is preserved by FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/headers",
    method: "GET",
    headers: { "accept-encoding": "identity" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  const body = (await new Response(raw.body!).json()) as { headers: Record<string, string> };
  const ae = (body.headers["Accept-Encoding"] ?? "").toLowerCase();
  // Explicit "identity" should be preserved by FetchTransport
  assert.ok(ae.includes("identity"), `Explicit accept-encoding should be preserved. Got: ${ae}`);
});

await run("abort signal rejects immediately", async () => {
  const t = new FetchTransport();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(
    () =>
      t.send({
        url: "https://httpbin.org/delay/5",
        method: "GET",
        headers: {},
        body: null,
        signal: ctrl.signal,
        meta: {},
        httpVersion: "HTTP/1.1",
      }),
    /aborted/,
  );
});

await run("network error on bad URL", async () => {
  const t = new FetchTransport();
  await assert.rejects(() =>
    t.send({
      url: "https://192.0.2.99/nonexistent",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    }),
  );
});

// ============================================================================
// §4  NodeHTTP2Transport
// ============================================================================

suite("NodeHTTP2Transport");

await run("GET via HTTP/2 returns 200", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  assert.equal(raw.status, 200);
  assert.equal(raw.httpVersion, "HTTP/2");
});

await run("POST with JSON body via HTTP/2", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "h2" }),
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  assert.equal(raw.status, 200);
});

await run("session reuse to same origin", async () => {
  const t = new NodeHTTP2Transport();
  const r1 = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  const r2 = await t.send({
    url: "https://httpbin.org/uuid",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

await run("request timeout fires", async () => {
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
    assert.ok(err.code === "ETIMEOUT" || err.message.includes("timed out"));
  }
});

await run("HTTP/1.1 fallback", async () => {
  const t = new NodeHTTP2Transport();
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
  assert.equal(raw.httpVersion, "HTTP/1.1");
});

await run("follows redirect", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/redirect/1",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
    redirect: "follow",
  });
  assert.equal(raw.status, 200);
  assert.ok(raw.redirected);
});

await run("redirect manual returns 3xx", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/redirect/1",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
    redirect: "manual",
  });
  assert.ok(raw.status >= 300 && raw.status < 400);
  assert.ok(raw.headers["location"]);
});

await run("destroy cleanly", () => {
  const t = new NodeHTTP2Transport();
  t.destroy();
  t.destroy();
});

await run("custom session options construct", () => {
  const t = new NodeHTTP2Transport({ sessionTTLMs: 100, pingIntervalMs: 0 });
  t.destroy();
});

// ============================================================================
// §5  sendWithTimeout
// ============================================================================

suite("sendWithTimeout");

await run("timeout=0 passes through", async () => {
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

await run("normal request completes", async () => {
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
    10000,
  );
  assert.equal(raw.status, 200);
});

await run("throws TimeoutError on timeout", async () => {
  try {
    await sendWithTimeout(
      new FetchTransport(),
      {
        url: "https://httpbin.org/delay/5",
        method: "GET",
        headers: {},
        body: null,
        signal: null,
        meta: {},
        httpVersion: "HTTP/1.1",
      },
      500,
    );
    assert.fail("should have timed out");
  } catch (err: any) {
    assert.equal(err.code, "ETIMEOUT");
  }
});

// ============================================================================
// §6  readRawBody
// ============================================================================

suite("readRawBody");

await run("null stream returns empty", async () => {
  assert.equal((await readRawBody(null, 0, "")).byteLength, 0);
});

await run("reads bytes from stream", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  assert.deepEqual(Array.from(await readRawBody(s, 0, "")), [1, 2, 3]);
});

await run("enforces size limit", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(100));
      c.close();
    },
  });
  await assert.rejects(() => readRawBody(s, 50, ""), /size limit/);
});

await run("abort signal cancels", async () => {
  const s = new ReadableStream({
    start(c) {
      /* never close */
    },
  });
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(() => readRawBody(s, 0, "", c.signal), /aborted/);
});

await run("pre-aborted signal throws immediately", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(5));
      c.close();
    },
  });
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => readRawBody(s, 0, "", c.signal), /aborted/);
});

await run("readRawBody with stream that errors on read", async () => {
  const s = new ReadableStream({
    start(c) {
      c.error(new Error("stream-error"));
    },
  });
  await assert.rejects(() => readRawBody(s, 0, ""), /stream-error/);
});

// ============================================================================
// §7  parseBody
// ============================================================================

suite("parseBody");

await run("parses JSON", () => {
  const r = parseBody(new TextEncoder().encode(JSON.stringify({ a: 1 })), "application/json");
  assert.equal((r as any).a, 1);
});

await run("text content-type returns string", () => {
  assert.equal(parseBody(new TextEncoder().encode("hi"), "text/plain"), "hi");
});

await run("binary returns Uint8Array", () => {
  const r = parseBody(new Uint8Array([0xff, 0xaa]), "application/octet-stream");
  assert.ok(r instanceof Uint8Array);
});

await run("empty body returns null", () =>
  assert.equal(parseBody(new Uint8Array(0), "application/json"), null),
);

await run("JSON parse failure falls back to text", () => {
  assert.equal(parseBody(new TextEncoder().encode("not-json"), "application/json"), "not-json");
});

await run("custom parser", () => {
  const r = parseBody(
    new TextEncoder().encode("x"),
    "text/plain",
    (b) => `p:${new TextDecoder().decode(b)}`,
  );
  assert.equal(r, "p:x");
});

await run("+json content-type", () => {
  const r = parseBody(
    new TextEncoder().encode(JSON.stringify({ ok: true })),
    "application/vnd.api+json",
  );
  assert.equal((r as any).ok, true);
});

// ============================================================================
// §8  decompressBodyStream
// ============================================================================

suite("decompressBodyStream");

await run("null body returns null", async () =>
  assert.equal(await decompressBodyStream(null, {}), null),
);

await run("no content-encoding returns stream as-is", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const r = await decompressBodyStream(s, {});
  const reader = r!.getReader();
  assert.deepEqual(Array.from((await reader.read()).value!), [1, 2, 3]);
});

await run("identity encoding strips header", async () => {
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

await run("gzip decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ gzipped: boolean }>("/gzip");
  assert.equal(r.status, 200);
  assert.equal(r.data.gzipped, true);
});

await run("deflate decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ deflated: boolean }>("/deflate");
  assert.equal(r.status, 200);
  assert.equal(r.data.deflated, true);
});

await run("brotli decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ brotli: boolean }>("/brotli");
  assert.equal(r.status, 200);
  assert.equal(r.data.brotli, true);
});

// ============================================================================
// §9  REAL HTTP CALLS
// ============================================================================

suite("Real HTTP");

await run("GET /get returns 200", async () =>
  assert.equal((await httpbin.get("/get")).status, 200),
);

await run("POST echoes body", async () => {
  const r = await httpbin.post("/post", { x: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.json, { x: 1 });
});

await run("redirect followed", async () =>
  assert.equal((await httpbin.get("/redirect/2")).status, 200),
);

await run("/uuid returns UUID", async () => {
  const r = await httpbin.get("/uuid");
  assert.equal(r.status, 200);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(typeof r.data.uuid, "string");
  assert.ok(uuidPattern.test(r.data.uuid), `Expected valid UUID, got: ${r.data.uuid}`);
});

await run("/ip returns IP", async () => {
  const r = await httpbin.get("/ip");
  assert.equal(r.status, 200);
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  assert.equal(typeof r.data.origin, "string");
  assert.ok(ipv4Pattern.test(r.data.origin), `Expected valid IPv4, got: ${r.data.origin}`);
});

await run("/json returns slideshow", async () => {
  const r = await httpbin.get("/json");
  assert.equal(r.status, 200);
  assert.ok(r.data.slideshow, "slideshow should exist");
  assert.equal(typeof r.data.slideshow, "object");
  assert.equal(r.data.slideshow.author, "Yours Truly");
  assert.ok(Array.isArray(r.data.slideshow.slides));
});

await run("/anything echoes json", async () => {
  const r = await httpbin.post("/anything", { msg: "core-test" });
  assert.equal(r.status, 200);
  assert.equal(r.data.json.msg, "core-test");
});

await run("/base64 decodes", async () => {
  const r = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(r.status, 200);
  assert.equal(String(r.data).trim(), "Hello World");
});

await run("multiple sequential requests", async () => {
  for (const p of ["/get", "/ip", "/uuid", "/headers"]) {
    assert.equal((await httpbin.get(p)).status, 200);
  }
});

// ============================================================================
// §10  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CORE TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
);
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
