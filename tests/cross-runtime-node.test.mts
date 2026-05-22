import assert from "node:assert/strict";

import {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  NodeHTTP2Transport,
  FetchTransport,
  createTransport,
  setRuntime,
  getEffectiveRuntime,
  sendWithTimeout,
} from "../src/core.ts";

import { Kinetex, KinetexError, TimeoutError } from "../src/mod.ts";

import { isAbortError, mergeSignals, uint8ArrayToBase64 } from "../src/utils.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
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
  suite("Runtime detection");

  await test("detectRuntime() returns 'node'", () => {
    assert.equal(detectRuntime(), "node");
  });

  await test("RUNTIME constant is 'node'", () => {
    assert.equal(RUNTIME, "node");
  });

  await test("IS_NODE is true", () => {
    assert.equal(IS_NODE, true);
  });

  await test("getEffectiveRuntime() returns 'node'", () => {
    assert.equal(getEffectiveRuntime(), "node");
  });

  await test("setRuntime override and restore", () => {
    setRuntime("browser");
    assert.equal(getEffectiveRuntime(), "browser");
    setRuntime(null);
    assert.equal(getEffectiveRuntime(), "node");
  });

  suite("Node-specific transports");

  await test("NodeHTTP2Transport can be constructed and destroyed", () => {
    const t = new NodeHTTP2Transport({ sessionTTLMs: 100, pingIntervalMs: 0 });
    assert.ok(t instanceof NodeHTTP2Transport);
    t.destroy();
    t.destroy();
  });

  await test("NodeHTTP2Transport sends real HTTP/2 request", async () => {
    const t = new NodeHTTP2Transport({ requestTimeoutMs: 15000 });
    try {
      const raw = await t.send({
        url: "https://httpbin.org/get",
        method: "GET",
        headers: {},
        body: null,
        signal: null,
        meta: {},
      });
      assert.equal(raw.status, 200);
    } finally {
      t.destroy();
    }
  });

  await test("FetchTransport sends real request", async () => {
    const t = new FetchTransport();
    const raw = await t.send({
      url: "https://httpbin.org/get",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    });
    assert.equal(raw.status, 200);
  });

  await test("createTransport returns a transport with .send()", () => {
    const t = createTransport();
    assert.notEqual(t, null);
    assert.equal(typeof t.send, "function");
  });

  await test("sendWithTimeout returns correct response", async () => {
    const raw = await sendWithTimeout(
      new FetchTransport(),
      {
        url: "https://httpbin.org/get",
        method: "GET",
        headers: {},
        body: null,
        signal: null,
        meta: {},
      },
      15000,
    );
    assert.equal(raw.status, 200);
  });

  suite("Cross-realm guards");

  await test("isAbortError recognizes DOMException AbortError", () => {
    assert.equal(isAbortError(new DOMException("Aborted", "AbortError")), true);
  });

  await test("isAbortError recognizes Error with name AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    assert.equal(isAbortError(err), true);
  });

  await test("isAbortError returns false for regular Error and non-Error", () => {
    assert.equal(isAbortError(new Error("regular")), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError("string"), false);
    assert.equal(isAbortError(42), false);
  });

  await test("isAbortError recognizes Node ECONNRESET/ECONNABORTED", () => {
    const e1 = new Error("econnreset") as NodeJS.ErrnoException;
    e1.code = "ECONNRESET";
    assert.equal(isAbortError(e1), true);
    const e2 = new Error("econnaborted") as NodeJS.ErrnoException;
    e2.code = "ECONNABORTED";
    assert.equal(isAbortError(e2), true);
  });

  await test("mergeSignals with no/nulled signals returns undefined", () => {
    assert.equal(mergeSignals(), undefined);
    assert.equal(mergeSignals(null), undefined);
    assert.equal(mergeSignals(undefined), undefined);
    assert.equal(mergeSignals(null, undefined), undefined);
  });

  await test("mergeSignals with single signal returns same reference", () => {
    const ctrl = new AbortController();
    assert.equal(mergeSignals(ctrl.signal), ctrl.signal);
  });

  await test("mergeSignals with multiple signals", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const merged = mergeSignals(ctrl1.signal, ctrl2.signal);
    assert.notEqual(merged, undefined);
    assert.equal(merged!.aborted, false);
  });

  await test("mergeSignals propagates abort from either source", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const merged = mergeSignals(ctrl1.signal, ctrl2.signal)!;
    assert.equal(merged.aborted, false);
    ctrl1.abort();
    assert.equal(merged.aborted, true);
  });

  await test("mergeSignals with pre-aborted signal", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const merged = mergeSignals(ctrl.signal, new AbortController().signal);
    assert.notEqual(merged, undefined);
    assert.equal(merged!.aborted, true);
  });

  await test("uint8ArrayToBase64 round-trip", () => {
    const input = new TextEncoder().encode("hello world");
    const b64 = uint8ArrayToBase64(input);
    const decoded = Buffer.from(b64, "base64").toString();
    assert.equal(decoded, "hello world");
  });

  await test("uint8ArrayToBase64 empty buffer", () => {
    assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
  });

  suite("Kinetex client in Node.js");

  await test("GET to httpbin returns 200 with correct body", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    const res = await client.get<{ origin: string; url: string }>("/get");
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.origin, "string");
    assert.ok(res.data.origin.length > 0);
    assert.ok(res.data.url.includes("/get"));
  });

  await test("Fluent .GET().json() works", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    const data = await client.GET("/get").json<{ origin: string }>();
    assert.equal(typeof data.origin, "string");
  });

  await test("Fluent .param() sends query parameters", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    const data = await client
      .GET("/get")
      .param("key1", "value1")
      .param("key2", "value2")
      .json<{ args: Record<string, string> }>();
    assert.equal(data.args["key1"], "value1");
    assert.equal(data.args["key2"], "value2");
  });

  await test("Fluent .header() sends custom header", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    const data = await client
      .GET("/headers")
      .header("x-custom-node", "test-value")
      .json<{ headers: Record<string, string> }>();
    const lowered = Object.fromEntries(
      Object.entries(data.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.equal(lowered["x-custom-node"], "test-value");
  });

  await test("Timeout throws TimeoutError", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 500 });
    const start = Date.now();
    let caught: unknown;
    try {
      await client.get("/delay/10");
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    assert.notEqual(caught, undefined);
    assert.ok(caught instanceof TimeoutError);
    assert.equal((caught as TimeoutError).code, "ETIMEOUT");
    assert.ok(elapsed < 5000, `Timeout took ${elapsed}ms, expected < 5000ms`);
  });

  await test("POST with JSON body", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    const payload = { msg: "hello from node" };
    const res = await client.post<{ json: typeof payload }>("/post", JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.json.msg, "hello from node");
  });

  await test("Request interceptor fires", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    let intercepted = false;
    client.useRequest(() => {
      intercepted = true;
    });
    await client.get("/get");
    assert.equal(intercepted, true);
  });

  await test("Response interceptor fires", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 30000 });
    let intercepted = false;
    client.useResponse(() => {
      intercepted = true;
    });
    await client.get("/get");
    assert.equal(intercepted, true);
  });

  await test("setRuntime restore preserves 'node'", () => {
    setRuntime("browser");
    setRuntime(null);
    assert.equal(getEffectiveRuntime(), "node");
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  CROSS-RUNTIME NODE TESTS: ${passed}/${passed + failed} passed`);
  console.log(`${"=".repeat(60)}`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const { name, err } of failures) {
      console.log(`  \u2717 ${name}`);
      if (err instanceof Error) console.log(`    ${err.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
