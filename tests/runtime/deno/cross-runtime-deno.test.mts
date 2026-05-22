import { assertEquals, assert, assertStrictEquals } from "jsr:@std/assert";
import { Kinetex, KinetexError, TimeoutError, HTTPStatusError } from "../src/mod.ts";
import {
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  detectRuntime,
  setRuntime,
  getEffectiveRuntime,
  createTransport,
  FetchTransport,
} from "../src/mod.ts";
import { isAbortError, mergeSignals, uint8ArrayToBase64 } from "../src/mod.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u274c  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n\u2500\u2500 ${name}`);
}

const T = 30_000;
const bin = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });

async function main() {
  suite("Runtime detection");

  await test("RUNTIME is 'deno'", () => {
    assertStrictEquals(RUNTIME, "deno");
  });

  await test("IS_NODE is false", () => {
    assertStrictEquals(IS_NODE, false);
  });

  await test("getEffectiveRuntime returns 'deno'", () => {
    assertStrictEquals(getEffectiveRuntime(), "deno");
  });

  await test("setRuntime override and restore", () => {
    setRuntime("bun");
    assertStrictEquals(getEffectiveRuntime(), "bun");
    setRuntime(null);
    assertStrictEquals(getEffectiveRuntime(), "deno");
  });

  await test("detectRuntime returns 'deno'", () => {
    assertStrictEquals(detectRuntime(), "deno");
  });

  suite("Cross-realm guards");

  await test("isAbortError recognizes AbortError", () => {
    assert(isAbortError(new DOMException("Aborted", "AbortError")));
  });

  await test("isAbortError rejects regular Error", () => {
    assert(!isAbortError(new Error("regular")));
  });

  await test("isAbortError rejects non-Error values", () => {
    assert(!isAbortError(null));
    assert(!isAbortError("string"));
    assert(!isAbortError(42));
  });

  await test("mergeSignals with no/null signals returns undefined", () => {
    assertEquals(mergeSignals(), undefined);
    assertEquals(mergeSignals(null), undefined);
  });

  await test("mergeSignals with single signal returns same signal", () => {
    const ctrl = new AbortController();
    assertStrictEquals(mergeSignals(ctrl.signal), ctrl.signal);
  });

  await test("mergeSignals with multiple signals", () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const merged = mergeSignals(ctrl1.signal, ctrl2.signal);
    assert(merged !== undefined);
    assertEquals(merged!.aborted, false);
    ctrl1.abort();
    assertEquals(merged!.aborted, true);
  });

  await test("uint8ArrayToBase64 round-trip", () => {
    const input = new TextEncoder().encode("hello deno");
    const b64 = uint8ArrayToBase64(input);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    assertEquals(decoded, "hello deno");
  });

  await test("uint8ArrayToBase64 empty buffer", () => {
    assertEquals(uint8ArrayToBase64(new Uint8Array(0)), "");
  });

  suite("Transport in Deno");

  await test("createTransport returns FetchTransport (not NodeHTTP2Transport)", () => {
    const t = createTransport();
    assert(t instanceof FetchTransport);
  });

  suite("Kinetex client in Deno");

  await test("GET to httpbin returns 200", async () => {
    const res = await bin.get<{ origin: string }>("/get");
    assertEquals(res.status, 200);
    assertEquals(typeof res.data.origin, "string");
    assert(res.data.origin.length > 0);
  });

  await test("Fluent .GET().json() works", async () => {
    const data = await bin.GET("/get").json<{ origin: string }>();
    assertEquals(typeof data.origin, "string");
  });

  await test("Fluent .param() sends query parameters", async () => {
    const data = await bin
      .GET("/get")
      .param("a", "1")
      .param("b", "hello")
      .json<{ args: Record<string, string> }>();
    assertEquals(data.args["a"], "1");
    assertEquals(data.args["b"], "hello");
  });

  await test("HEAD returns no body", async () => {
    const res = await bin.head("/get");
    assertEquals(res.status, 200);
    assertEquals(res.data, null);
  });

  await test("404 throws HTTPStatusError with status 404", async () => {
    try {
      await bin.get("/status/404");
      assert(false);
    } catch (err) {
      assert(err instanceof HTTPStatusError);
      assertEquals(err.status, 404);
    }
  });

  await test("Timeout throws error", async () => {
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: 500 });
    let caught: unknown;
    try {
      await client.get("/delay/10");
    } catch (err) {
      caught = err;
    }
    assert(caught !== undefined);
    assert(caught instanceof KinetexError);
  });

  await test("Request interceptor fires", async () => {
    let fired = false;
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    client.useRequest(() => {
      fired = true;
    });
    await client.get("/get");
    assert(fired);
  });

  await test("Response interceptor fires", async () => {
    let fired = false;
    const client = new Kinetex({ baseURL: "https://httpbin.org", timeout: T });
    client.useResponse(() => {
      fired = true;
    });
    await client.get("/get");
    assert(fired);
  });

  suite("Error classes");

  await test("KinetexError properties", () => {
    const e = new KinetexError("test", "ECUSTOM");
    assert(e instanceof Error);
    assertEquals(e.name, "KinetexError");
    assertEquals(e.message, "test");
    assertEquals(e.code, "ECUSTOM");
  });

  await test("TimeoutError properties", () => {
    const e = new TimeoutError(5000);
    assert(e instanceof KinetexError);
    assertEquals(e.code, "ETIMEOUT");
    assertEquals(e.timeoutMs, 5000);
  });

  await test("HTTPStatusError properties", () => {
    const req = {
      url: "http://test",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    };
    const res = {
      status: 404,
      statusText: "Not Found",
      url: "http://test",
      headers: {},
      data: null,
      httpVersion: "HTTP/1.1",
      durationMs: 100,
      request: req,
      ok: false,
      redirected: false,
    };
    const e = new HTTPStatusError(res, req);
    assert(e instanceof KinetexError);
    assert(e.isClientError);
    assert(!e.isServerError);
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Cross-runtime Deno: ${passed}/${passed + failed} passed`);
  console.log(`${"=".repeat(60)}`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const { name, err } of failures) {
      console.log(`  \u2717 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    Deno.exit(1);
  }
  Deno.exit(0);
}

main();
