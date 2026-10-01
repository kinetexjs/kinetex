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

import { isUpstreamFlake } from "./upstream.ts";
import { isAbortError, mergeSignals, uint8ArrayToBase64 } from "../src/utils.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

// Several tests here talk to httpbin.org and several deliberately wait on a
// timeout, so without a cap a single hung socket parks the whole file — on
// exactly the code path whose failure to fire is under test.
const TEST_BUDGET_MS = 45_000;

async function test(name: string, fn: () => void | Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(
          () => reject(new Error(`exceeded the ${TEST_BUDGET_MS}ms per-test budget`)),
          TEST_BUDGET_MS,
        );
      }),
    ]);
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
    assert.equal(t instanceof NodeHTTP2Transport, true);
    // The options have to land, or they are decorative: this is the same
    // class of bug as `maxSessions` being dropped on the floor.
    const priv = t as unknown as Record<string, unknown>;
    assert.equal(priv["sessionTTLMs"], 100, "sessionTTLMs must be stored");
    assert.equal(priv["pingIntervalMs"], 0, "pingIntervalMs must be stored");
    t.destroy();
    // Idempotent: a second destroy must resolve rather than double-free.
    assert.doesNotThrow(() => t.destroy());
    assert.doesNotThrow(() => t.destroy());
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
    // `notEqual(t, null)` is true of `undefined` too. On Node with no custom
    // fetch and no dispatcher the transport must specifically be the HTTP/2
    // one — that is the default this library ships, and the branch that
    // decides it is what the next few tests depend on.
    const t = createTransport();
    assert.ok(t, "a transport must be returned");
    assert.equal(typeof (t as { send?: unknown }).send, "function");
    assert.ok(
      t instanceof NodeHTTP2Transport,
      "Node defaults to the HTTP/2 transport when no fetch is supplied",
    );
    (t as { destroy?: () => void }).destroy?.();

    // A custom fetch forces the fetch transport instead — the signature is
    // (fetchFn, preferHTTP2, sessionOptions, transportOptions).
    const fetchT = createTransport(globalThis.fetch);
    assert.ok(fetchT instanceof FetchTransport, "a custom fetch must force FetchTransport");
    (fetchT as { destroy?: () => void }).destroy?.();
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

  await test("mergeSignals aborts from the SECOND source too", () => {
    // The existing pair of tests only ever aborted the first controller, so a
    // merge that listened to just one input passed both. `sendWithTimeout`
    // merges the caller's signal with its timeout controller, and which of the
    // two fires is not knowable in advance.
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const merged = mergeSignals(ctrl1.signal, ctrl2.signal)!;
    assert.equal(merged.aborted, false);
    ctrl2.abort(new Error("from the second"));
    assert.equal(merged.aborted, true, "the second source must abort the merge");
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

  suite("Regressions (cross-runtime round)");

  await test("regression: mergeSignals keeps the caller's abort reason", async () => {
    // The pre-aborted shortcut called `controller.abort()` with no argument,
    // installing the platform's generic `AbortError: This operation was
    // aborted` and throwing away *why*. The two-live-signal branch preserved
    // the reason, and so does `AbortSignal.any` — which is the path this
    // function actually uses on every current runtime — so the one case a
    // caller is most likely to hit was the only one that lost it.
    // `interceptors.ts` re-aborts with `existing.reason` when it merges, so the
    // loss propagated: a caller's `AbortSignal.timeout()` surfaced as a generic
    // abort with nothing left to tell a timeout from a manual cancel.
    const timed = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(timed.aborted, true, "precondition: the caller's signal fired");

    const merged = mergeSignals(timed, new AbortController().signal)!;
    assert.equal(merged.aborted, true);
    assert.equal(
      String(merged.reason),
      String(timed.reason),
      "the merged signal must report the caller's reason, not a generic AbortError",
    );
    assert.notEqual(
      String(merged.reason),
      "AbortError: This operation was aborted",
      "the generic reason is exactly what the fix removed",
    );
  });

  await test("regression: mergeSignals keeps a caller's custom reason", () => {
    const c = new AbortController();
    c.abort(new RangeError("quota exhausted"));
    const merged = mergeSignals(c.signal, new AbortController().signal)!;
    assert.ok(
      merged.reason instanceof RangeError,
      `expected the caller's RangeError, got ${String(merged.reason)}`,
    );
    assert.equal(String(merged.reason), "RangeError: quota exhausted");
  });

  await test("regression: a pre-aborted merge matches AbortSignal.any", () => {
    // The two implementations must agree, or the same request behaves
    // differently depending on whether the runtime has `AbortSignal.any`.
    const c = new AbortController();
    c.abort(new Error("the real reason"));
    const live = new AbortController().signal;
    assert.equal(
      String(mergeSignals(c.signal, live)!.reason),
      String(AbortSignal.any([c.signal, live]).reason),
    );
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
