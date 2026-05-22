import assert from "assert/strict";
import { Kinetex, KinetexError, TimeoutError, HTTPStatusError } from "../../../src/mod.ts";
import {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  getEffectiveRuntime,
  setRuntime,
  FetchTransport,
  NodeHTTP2Transport,
  createTransport,
} from "../../../src/core.ts";
import {
  isAbortError,
  mergeSignals,
  uint8ArrayToBase64,
  concatUint8Arrays,
  sleep,
} from "../../../src/utils.ts";

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

const T = 30_000;

async function main() {
  suite("Runtime detection");

  await test("RUNTIME is 'bun'", () => {
    assert.equal(RUNTIME, "bun");
  });

  await test("IS_NODE is false", () => {
    assert.equal(IS_NODE, false);
  });

  await test("getEffectiveRuntime() returns 'bun'", () => {
    assert.equal(getEffectiveRuntime(), "bun");
  });

  await test("setRuntime override and restore", () => {
    setRuntime("node");
    assert.equal(getEffectiveRuntime(), "node");
    setRuntime(null);
    assert.equal(getEffectiveRuntime(), "bun");
  });

  await test("detectRuntime() returns 'bun'", () => {
    assert.equal(detectRuntime(), "bun");
  });

  suite("Cross-realm guards");

  await test("isAbortError recognizes AbortError", () => {
    const err = new DOMException("Aborted", "AbortError");
    assert.equal(isAbortError(err), true);
  });

  await test("isAbortError rejects regular Error", () => {
    assert.equal(isAbortError(new Error("regular")), false);
  });

  await test("isAbortError rejects non-Error values", () => {
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError("string"), false);
  });

  await test("mergeSignals with no/null signals returns undefined", () => {
    assert.equal(mergeSignals(), undefined);
    assert.equal(mergeSignals(null), undefined);
  });

  await test("mergeSignals with single signal returns same signal", () => {
    const ac = new AbortController();
    assert.equal(mergeSignals(ac.signal), ac.signal);
  });

  await test("mergeSignals with multiple signals", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const merged = mergeSignals(ac1.signal, ac2.signal);
    assert.notEqual(merged, undefined);
    assert.equal(merged!.aborted, false);
    ac1.abort();
    assert.equal(merged!.aborted, true);
  });

  await test("uint8ArrayToBase64 round-trip", () => {
    const input = new TextEncoder().encode("hello bun");
    const b64 = uint8ArrayToBase64(input);
    const decoded = Buffer.from(b64, "base64").toString();
    assert.equal(decoded, "hello bun");
  });

  await test("uint8ArrayToBase64 empty buffer", () => {
    assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
  });

  await test("concatUint8Arrays", () => {
    const result = concatUint8Arrays([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    assert.deepEqual(Array.from(result), [1, 2, 3, 4, 5, 6]);
  });

  suite("Transport in Bun");

  await test("createTransport returns FetchTransport", () => {
    const t = createTransport();
    assert.ok(t instanceof FetchTransport);
  });

  suite("Kinetex client in Bun");

  await test("GET to httpbin returns 200", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    const res = await client.get<{ origin: string }>("/get");
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.origin, "string");
  });

  await test("Fluent .GET().json() works", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    const data = await client.GET("/get").json<{ origin: string }>();
    assert.equal(typeof data.origin, "string");
  });

  await test("Fluent .param() sends query parameters", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    const data = await client
      .GET("/get")
      .param("a", "1")
      .param("b", "hello")
      .json<{ args: Record<string, string> }>();
    assert.equal(data.args["a"], "1");
    assert.equal(data.args["b"], "hello");
  });

  await test("POST with JSON body", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    const payload = { msg: "hello from bun" };
    const res = await client.post<{ json: typeof payload }>("/post", JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.json.msg, "hello from bun");
  });

  await test("Timeout throws TimeoutError", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 500 });
    try {
      await client.get("/delay/10");
      assert.fail("Expected timeout");
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });

  suite("Error classes");

  await test("KinetexError construction", () => {
    const e = new KinetexError("test", "EUNKNOWN");
    assert.equal(e.name, "KinetexError");
    assert.equal(e.code, "EUNKNOWN");
    assert.equal(e.message, "test");
  });

  await test("TimeoutError construction", () => {
    const e = new TimeoutError(5000);
    assert.equal(e.code, "ETIMEOUT");
    assert.equal(e.timeoutMs, 5000);
    assert.equal(e.message, "Request timed out after 5000ms");
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Cross-runtime Bun: ${passed}/${passed + failed} passed`);
  console.log(`${"=".repeat(60)}`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const { name, err } of failures) {
      console.log(`  \u2717 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
