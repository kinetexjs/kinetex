/**
 * lifecycle.ts - Real HTTP tests to httpbin.org
 * Goal: All tests use real HTTP calls to httpbin.org
 * Only unit tests where HTTP cannot test the functionality
 */

import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import { isUpstreamFlake } from "./upstream.ts";
import { HTTPStatusError } from "../src/types.ts";
import {
  HookRegistry,
  HookEmitter,
  createLoggingHooks,
  createTimingHook,
  createBodyNormalizationHook,
  createAbortHook,
  createHookContext,
  composeBeforeRequest,
  composeBeforeResponse,
  composeAround,
  validateResponse,
  injectHeaders,
  withBaseURL,
  throwOnHTTPError,
  tap,
  HTTPError,
  ResponseValidationError,
  ProgressTracker,
  RedirectTracker,
  TooManyRedirectsError,
} from "../src/lifecycle.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
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
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const bin = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });

// Fixtures for the in-memory blocks. Several suites below drive the registry
// directly so the assertion is exact and the result does not depend on a live
// API; the same three-line literals were repeated inline a dozen times.
function hookReq(over: Record<string, unknown> = {}): any {
  return {
    url: "https://x.test/a",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    ...over,
  };
}
function hookRes(over: Record<string, unknown> = {}): any {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    body: null,
    request: hookReq(),
    ...over,
  };
}

// ============================================================================
// REAL HTTP ERROR TESTS (triggers onError hooks)
// ============================================================================

suite("HTTP errors trigger onError hooks");

await test("404 triggers onError hook", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnError(async () => {
    called = true;
  });

  bin.attachHookRegistry(reg);

  // The old form swallowed the outcome with `catch (e) {}` and asserted only
  // that the hook had run. That still passed if the request resolved
  // successfully — the hook could fire without a real failure behind it.
  // Pin the rejection itself: an HTTPStatusError carrying this exact status.
  await assert.rejects(
    () => bin.get("/status/404"),
    (err: unknown) => {
      assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
      assert.equal((err as HTTPStatusError).status, 404);
      assert.equal((err as HTTPStatusError).code, "EHTTPSTATUS");
      return true;
    },
  );

  assert.equal(called, true, "onError must fire for a 404");
});

await test("500 triggers onError hook", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnError(async () => {
    called = true;
  });

  bin.attachHookRegistry(reg);

  // The old form swallowed the outcome with `catch (e) {}` and asserted only
  // that the hook had run. That still passed if the request resolved
  // successfully — the hook could fire without a real failure behind it.
  // Pin the rejection itself: an HTTPStatusError carrying this exact status.
  await assert.rejects(
    () => bin.get("/status/500"),
    (err: unknown) => {
      assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
      assert.equal((err as HTTPStatusError).status, 500);
      assert.equal((err as HTTPStatusError).code, "EHTTPSTATUS");
      return true;
    },
  );

  assert.equal(called, true, "onError must fire for a 500");
});

await test("502 triggers onError hook with attempt", async () => {
  const reg = new HookRegistry();
  let attempt = 0;
  reg.addOnError(async (err) => {
    attempt = err.attempt;
  });

  bin.attachHookRegistry(reg);

  // The old form swallowed the outcome with `catch (e) {}` and asserted only
  // that the hook had run. That still passed if the request resolved
  // successfully — the hook could fire without a real failure behind it.
  // Pin the rejection itself: an HTTPStatusError carrying this exact status.
  await assert.rejects(
    () => bin.get("/status/502"),
    (err: unknown) => {
      assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
      assert.equal((err as HTTPStatusError).status, 502);
      return true;
    },
  );

  // 502 is retried, so onError finally reports the last attempt
  assert.equal(attempt, 4, "onError must report the final retry attempt");
});

await test("503 triggers onError with request data", async () => {
  const reg = new HookRegistry();
  let url = "";
  reg.addOnError(async (err) => {
    url = err.request.url;
  });

  bin.attachHookRegistry(reg);

  // The old form swallowed the outcome with `catch (e) {}` and asserted only
  // that the hook had run. That still passed if the request resolved
  // successfully — the hook could fire without a real failure behind it.
  // Pin the rejection itself: an HTTPStatusError carrying this exact status.
  await assert.rejects(
    () => bin.get("/status/503"),
    (err: unknown) => {
      assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
      assert.equal((err as HTTPStatusError).status, 503);
      return true;
    },
  );

  assert.equal(url, "https://httpbin.org/status/503");
});

// ============================================================================
// CREATE LOGGING HOOKS with REAL HTTP
// ============================================================================

suite("createLoggingHooks with real HTTP");

await test("loggingHooks beforeRequest logs the outgoing request", async () => {
  const logged: Array<[string, any]> = [];
  const logging = createLoggingHooks({ logger: (msg, data) => logged.push([msg, data]) });

  const reg = new HookRegistry();
  reg.addBeforeRequest(logging.beforeRequest);

  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const eject = client.attachHookRegistry(reg);
  try {
    const res = await client.get("/get");
    assert.equal(res.status, 200);
    // `status === 200` is satisfied whether or not the hook ever ran, which is
    // what this test used to assert.
    assert.equal(logged.length, 1, "beforeRequest must log exactly one record");
    assert.equal(logged[0]![0], "→ request");
    assert.equal(logged[0]![1].method, "GET");
    assert.equal(logged[0]![1].url, "https://httpbin.org/get");
    assert.equal(typeof logged[0]![1].headers, "object");
  } finally {
    eject();
  }
});

await test("loggingHooks afterResponse logs the incoming response", async () => {
  const logged: Array<[string, any]> = [];
  const logging = createLoggingHooks({ logger: (msg, data) => logged.push([msg, data]) });

  const reg = new HookRegistry();
  reg.addAfterResponse(logging.afterResponse);

  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const eject = client.attachHookRegistry(reg);
  try {
    const res = await client.get("/get");
    assert.equal(res.status, 200);
    assert.equal(logged.length, 1, "afterResponse must log exactly one record");
    assert.equal(logged[0]![0], "← response");
    assert.equal(logged[0]![1].status, 200);
    assert.equal(logged[0]![1].url, "https://httpbin.org/get");
  } finally {
    eject();
  }
});

await test("loggingHooks onError with 400", async () => {
  const logged: Array<{ msg: string; data: { status?: number | null; url?: string } }> = [];
  const logging = createLoggingHooks({
    logger: (msg: string, data: unknown) => {
      logged.push({ msg, data: data as { status?: number | null; url?: string } });
    },
  });

  const reg = new HookRegistry();
  reg.addOnError(logging.onError);

  bin.attachHookRegistry(reg);

  let status = 0;
  try {
    await bin.get("/status/400");
  } catch (err: any) {
    status = err?.status ?? 0;
  }
  // A 4xx must both surface to the caller and reach the logging hook.
  assert.equal(status, 400, "expected an HTTPStatusError carrying status 400");
  assert.equal(logged.length, 1, `onError logging hook must fire once, got ${logged.length}`);
  assert.equal(logged[0]!.data.status, 400);
});

await test("loggingHooks with custom logger", async () => {
  let logged = false;
  const logging = createLoggingHooks({
    logger: () => {
      logged = true;
    },
  });

  const reg = new HookRegistry();
  reg.addBeforeRequest(logging.beforeRequest);
  reg.addAfterResponse(logging.afterResponse);

  bin.attachHookRegistry(reg);

  await bin.get("/get");
  assert.equal(logged, true);
});

await test("loggingHooks redactHeaders replaces the configured values", async () => {
  const logged: Array<[string, any]> = [];
  const logging = createLoggingHooks({
    logger: (msg, data) => logged.push([msg, data]),
    redactHeaders: ["content-type", "x-api-key"],
  });

  const reg = new HookRegistry();
  reg.addBeforeRequest(logging.beforeRequest);

  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const eject = client.attachHookRegistry(reg);
  try {
    const res = await client.get("/get", {
      headers: { "content-type": "application/json", "x-api-key": "super-secret" },
    });
    assert.equal(res.status, 200);
    assert.equal(logged.length, 1);
    const headers = logged[0]![1].headers as Record<string, string>;
    // The old test passed `redactHeaders` and then asserted only the status, so
    // the option was never exercised.
    assert.equal(headers["content-type"], "***");
    assert.equal(headers["x-api-key"], "***");
    assert.ok(!JSON.stringify(logged).includes("super-secret"), "no secret may reach the log");
  } finally {
    eject();
  }
});

// ============================================================================
// CREATE TIMING HOOK with REAL HTTP
// ============================================================================

suite("createTimingHook with real HTTP");

await test("timingHook tracks GET request time", async () => {
  const timing = createTimingHook();

  const reg = new HookRegistry();
  reg.addBeforeRequest(timing.beforeRequest);
  reg.addAfterResponse(timing.afterResponse);

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
  assert.equal(typeof res.durationMs, "number");
  assert.equal(res.durationMs > 0, true, `durationMs must be positive, got ${res.durationMs}`);
});

await test("timingHook tracks POST request time", async () => {
  const timing = createTimingHook();

  const reg = new HookRegistry();
  reg.addBeforeRequest(timing.beforeRequest);
  reg.addAfterResponse(timing.afterResponse);

  bin.attachHookRegistry(reg);

  const res = await bin.post("/post", { test: true });
  assert.equal(res.status, 200);
});

// ============================================================================
// REAL HTTP METHODS with hooks
// ============================================================================

suite("HTTP methods with HookRegistry");

await test("GET /get with beforeRequest", async () => {
  const reg = new HookRegistry();
  let method = "";
  reg.addBeforeRequest(async (req) => {
    method = req.method;
  });

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
  assert.equal(method, "GET");
});

// The six method tests these replace registered an empty `HookRegistry` and
// asserted only the HTTP status, so they were named after a hook they never
// installed. Each one now registers a real before-request hook, uses a fresh
// client (the shared `bin` accumulates a bridge per `attachHookRegistry` call
// for the rest of the file), and asserts the method the hook actually saw.
for (const [label, call] of [
  ["POST /post", (c: ReturnType<typeof kinetex>) => c.post("/post", { test: true })],
  ["PUT /put", (c: ReturnType<typeof kinetex>) => c.put("/put", { test: true })],
  ["PATCH /patch", (c: ReturnType<typeof kinetex>) => c.patch("/patch", { test: true })],
  ["DELETE /delete", (c: ReturnType<typeof kinetex>) => c.delete("/delete")],
  ["HEAD /get", (c: ReturnType<typeof kinetex>) => c.head("/get")],
  ["OPTIONS /get", (c: ReturnType<typeof kinetex>) => c.options("/get")],
] as const) {
  await test(`${label} fires beforeRequest with the right method`, async () => {
    // httpbin's front end answers 429/502/503/504 without forwarding the
    // request. The client then retries — which is correct, and which makes
    // the hook run once per *attempt*, not once per call. Counting the
    // retries separately is what keeps that from reading as a double
    // dispatch: without it the assertion below cannot tell "the hook fired
    // twice for one request" (the bug) from "the request was retried once
    // because upstream asked" (not a bug).
    let retries = 0;
    const client = kinetex({
      baseURL: "https://httpbin.org",
      timeout: 30_000,
      retry: {
        onRetry: () => {
          retries++;
        },
      },
    });
    const reg = new HookRegistry();
    const seen: string[] = [];
    const urls: string[] = [];
    reg.addBeforeRequest(async (req) => {
      seen.push(req.method);
      urls.push(req.url);
    });
    const eject = client.attachHookRegistry(reg);

    try {
      const res = await call(client);
      assert.equal(res.status, 200);
      assert.deepEqual(
        seen,
        new Array(retries + 1).fill(label.split(" ")[0]!),
        "the hook must see the request method, once per attempt",
      );
      assert.equal(urls[0], `https://httpbin.org${label.split(" ")[1]!}`);
    } finally {
      eject();
    }
  });
}

// ============================================================================
// OTHER ENDPOINTS with hooks
// ============================================================================

suite("Different httpbin.org endpoints");

await test("GET /json with afterResponse", async () => {
  const reg = new HookRegistry();
  let status = 0;
  reg.addAfterResponse(async (res) => {
    status = res.status;
  });

  bin.attachHookRegistry(reg);

  const res = await bin.get("/json");
  assert.equal(res.status, 200);
  assert.equal(status, 200);
});

await test("GET /html fires afterResponse with the body intact", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const reg = new HookRegistry();
  let bodySeen: string | Uint8Array | null = null;
  reg.addAfterResponse(async (res) => {
    bodySeen = res.body;
  });
  const eject = client.attachHookRegistry(reg);

  try {
    const res = await client.get("/html");
    assert.equal(res.status, 200);
    assert.ok(bodySeen !== null, "afterResponse must receive a non-null body");
    const text = typeof bodySeen === "string" ? bodySeen : new TextDecoder().decode(bodySeen);
    assert.match(text, /<html/i, "the hook must see the real body, not a placeholder");
  } finally {
    eject();
  }
});

await test("GET /bytes/100 reports the byte length to afterResponse", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const reg = new HookRegistry();
  let size = -1;
  reg.addAfterResponse(async (res) => {
    size = res.body instanceof Uint8Array ? res.body.byteLength : res.body!.length;
  });
  const eject = client.attachHookRegistry(reg);

  try {
    const res = await client.get("/bytes/100");
    assert.equal(res.status, 200);
    assert.equal(size, 100, "the hook must see all 100 bytes");
  } finally {
    eject();
  }
});

await test("GET /delay/1 completes", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.get("/delay/1");
  assert.equal(res.status, 200);
});

// ============================================================================
// REQUEST HEADERS with hooks
// ============================================================================

suite("Request headers with hooks");

await test("custom headers sent to server", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.get<any>("/headers", { headers: { "X-Custom": "TestValue" } });
  assert.equal(res.data.headers["X-Custom"], "TestValue");
});

await test("hook can add headers", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const reg = new HookRegistry();
  reg.addBeforeRequest(async (req) => {
    req.headers["X-HookAdded"] = "true";
  });
  const eject = client.attachHookRegistry(reg);

  try {
    const res = await client.get<any>("/headers");
    assert.equal(res.status, 200);
    // This printed the echoed header and asserted only the status, with a note
    // conceding it "may not echo" — the real uncertainty was casing, not echo.
    // httpbin normalises header names on the way back, so "X-HookAdded" comes
    // back as "X-Hookadded". Look the value up case-insensitively rather than
    // leaving the question open.
    const echoed: Record<string, string> = res.data.headers;
    const key = Object.keys(echoed).find((k) => k.toLowerCase() === "x-hookadded");
    assert.ok(
      key,
      `the hook's header must reach the server; echoed: ${Object.keys(echoed).join(", ")}`,
    );
    assert.equal(echoed[key!], "true");
  } finally {
    eject();
  }
});

await test("JSON content-type sent", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.post("/post", { name: "test" });
  assert.equal(res.status, 200);
});

// ============================================================================
// REAL HTTP METADATA
// ============================================================================

suite("Request metadata via real HTTP");

await test("meta passed through request hooks", async () => {
  const reg = new HookRegistry();
  let meta: any = null;
  reg.addBeforeRequest(async (_req, ctx) => {
    meta = ctx.meta;
  });

  bin.attachHookRegistry(reg);

  await bin.get("/get", { meta: { customData: "value" } });
  assert.equal(meta.customData, "value");
});

await test("request.meta accessible in response", async () => {
  const reg = new HookRegistry();
  let reqMeta: any = null;
  reg.addAfterResponse(async (_res, ctx) => {
    reqMeta = ctx.request.meta;
  });

  bin.attachHookRegistry(reg);

  await bin.get("/get", { meta: { requestId: "123" } });
  assert.equal(reqMeta.requestId, "123");
});

// ============================================================================
// CONCURRENT real HTTP
// ============================================================================

suite("Concurrent real HTTP requests");

await test("concurrent GET requests", async () => {
  const reg = new HookRegistry();
  let count = 0;
  reg.addBeforeRequest(async () => {
    count++;
  });

  bin.attachHookRegistry(reg);

  const client1 = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const client2 = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  client1.attachHookRegistry(reg);
  client2.attachHookRegistry(reg);

  const [r1, r2] = await Promise.all([client1.get("/get"), client2.get("/get")]);

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(count, 2);
});

// ============================================================================
// HOOK REGISTRY via REAL HTTP
// ============================================================================

suite("HookRegistry via real HTTP");

await test("addBeforeRequest returns hook ID", async () => {
  const reg = new HookRegistry();
  const id = reg.addBeforeRequest(async () => {});

  bin.attachHookRegistry(reg);
  const res = await bin.get("/get");

  assert.equal(typeof id, "string");
  assert.equal(res.status, 200);
});

await test("addAfterResponse returns hook ID", async () => {
  const reg = new HookRegistry();
  const id = reg.addAfterResponse(async () => {});

  bin.attachHookRegistry(reg);
  const res = await bin.get("/get");

  assert.equal(typeof id, "string");
  assert.equal(res.status, 200);
});

await test("addOnError returns hook ID", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnError(async () => {});

  bin.attachHookRegistry(reg);

  // This one asserted only `typeof id === "string"`, which says nothing about
  // the request: any registry that returned a non-string id, or one where the
  // request silently succeeded, still passed. Pin both the id and the failure.
  let fired = 0;
  const id2 = reg.addOnError(async () => {
    fired++;
  });
  assert.equal(typeof id2, "string");
  assert.notEqual(id2, id, "each registration must get its own id");

  await assert.rejects(
    () => bin.get("/status/400"),
    (err: unknown) => {
      assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
      assert.equal((err as HTTPStatusError).status, 400);
      return true;
    },
  );

  assert.equal(fired, 1, "the newly registered hook must fire");
});

await test("remove() can eject hook", async () => {
  const reg = new HookRegistry();
  let beforeCount = 0;
  const id = reg.addBeforeRequest(async () => {
    beforeCount++;
  });

  bin.attachHookRegistry(reg);

  await bin.get("/get");
  assert.equal(beforeCount, 1);

  reg.remove(id);
  await bin.get("/get");
  assert.equal(beforeCount, 1);
});

await test("has() returns true for added hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addBeforeRequest(async () => {});

  assert.equal(reg.has(id), true);
});

await test("removeAll() clears all hooks", async () => {
  const reg = new HookRegistry();
  reg.addBeforeRequest(async () => {});
  reg.addAfterResponse(async () => {});

  bin.attachHookRegistry(reg);

  reg.removeAll();
  const res = await bin.get("/get");
  assert.equal(res.status, 200);
});

// ============================================================================
// HOOK PRIORITY with real HTTP
// ============================================================================

suite("Hook priority with real HTTP");

await test("hooks with priority execute in order", async () => {
  const order: number[] = [];
  const reg = new HookRegistry();

  reg.addBeforeRequest(
    async () => {
      order.push(1);
    },
    { priority: 100 },
  );
  reg.addBeforeRequest(
    async () => {
      order.push(2);
    },
    { priority: 50 },
  );
  reg.addBeforeRequest(
    async () => {
      order.push(3);
    },
    { priority: 200 },
  );

  bin.attachHookRegistry(reg);

  await bin.get("/get");
  assert.deepEqual(order, [2, 1, 3]);
});

// ============================================================================
// ONCE OPTION with real HTTP
// ============================================================================

suite("once option via real HTTP");

await test("once hook fires only once across requests", async () => {
  const reg = new HookRegistry();
  let count = 0;
  reg.addBeforeRequest(
    async () => {
      count++;
    },
    { once: true },
  );

  bin.attachHookRegistry(reg);

  await bin.get("/get");
  await bin.get("/get");
  await bin.get("/get");

  assert.equal(count, 1);
});

// ============================================================================
// CONDITION OPTION with real HTTP
// ============================================================================

suite("condition option via real HTTP");

await test("condition: true runs hook", async () => {
  const reg = new HookRegistry();
  let ran = false;
  reg.addBeforeRequest(
    async () => {
      ran = true;
    },
    { condition: () => true },
  );

  bin.attachHookRegistry(reg);

  await bin.get("/get");
  assert.equal(ran, true);
});

// The suite only ever tested `condition: () => true`, which is indistinguishable
// from having no condition at all. These pin the `false` case on every phase
// that supports one — `runOnCancel` and `runOnConnection` used to ignore the
// option entirely, and `runOnConnection` was not even given a context to
// evaluate it against.
await test("condition: false suppresses the hook in every phase that supports it", async () => {
  const fired: string[] = [];
  const never = () => false;
  const reg = new HookRegistry();
  const ctx = createHookContext(hookReq());

  reg.addBeforeRequest(
    () => {
      fired.push("beforeRequest");
    },
    { condition: never },
  );
  reg.addAfterRequest(
    () => {
      fired.push("afterRequest");
    },
    { condition: never },
  );
  reg.addBeforeResponse(
    () => {
      fired.push("beforeResponse");
    },
    { condition: never },
  );
  reg.addAfterResponse(
    () => {
      fired.push("afterResponse");
    },
    { condition: never },
  );
  reg.addOnError(
    () => {
      fired.push("onError");
    },
    { condition: never },
  );
  reg.addOnRetry(
    () => {
      fired.push("onRetry");
    },
    { condition: never },
  );
  reg.addOnRedirect(
    () => {
      fired.push("onRedirect");
    },
    { condition: never },
  );
  reg.addOnUploadProgress(
    () => {
      fired.push("onUploadProgress");
    },
    { condition: never },
  );
  reg.addOnDownloadProgress(
    () => {
      fired.push("onDownloadProgress");
    },
    { condition: never },
  );
  reg.addOnCancel(
    () => {
      fired.push("onCancel");
    },
    { condition: never },
  );
  reg.addOnConnection(
    () => {
      fired.push("onConnection");
    },
    { condition: never },
  );
  reg.addAround((_c, next) => next(), { condition: never });

  const req = hookReq();
  await reg.runBeforeRequest(req, ctx);
  await reg.runAfterRequest(req, ctx);
  await reg.runBeforeResponse(hookRes(req), ctx);
  await reg.runAfterResponse(hookRes(req), ctx);
  await reg.runOnError({ error: new Error("e"), request: req, response: null, attempt: 1 }, ctx);
  await reg.runOnRetry(
    { attempt: 2, maxRetries: 3, delayMs: 1, reason: null, request: req, response: null },
    ctx,
  );
  await reg.runOnRedirect({ from: "a", to: "b", status: 301, count: 1, request: req }, ctx);
  reg.runOnUploadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx);
  reg.runOnDownloadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx);
  reg.runOnCancel({ request: req, reason: null }, ctx);
  reg.runOnConnection({ type: "connect", host: "h", port: 1, protocol: "https", elapsed: 1 }, ctx);
  const wrapped = await reg.wrapWithAround(ctx, async () => hookRes(req))();

  assert.deepEqual(fired, [], "no hook may run when its condition is false");
  assert.equal(wrapped.status, 200, "a suppressed around hook must still reach the dispatch");
});

await test("condition: true still runs in every phase", async () => {
  const fired: string[] = [];
  const always = () => true;
  const reg = new HookRegistry();
  const ctx = createHookContext(hookReq());
  const req = hookReq();

  reg.addBeforeRequest(
    () => {
      fired.push("beforeRequest");
    },
    { condition: always },
  );
  reg.addAfterRequest(
    () => {
      fired.push("afterRequest");
    },
    { condition: always },
  );
  reg.addBeforeResponse(
    () => {
      fired.push("beforeResponse");
    },
    { condition: always },
  );
  reg.addAfterResponse(
    () => {
      fired.push("afterResponse");
    },
    { condition: always },
  );
  reg.addOnError(
    () => {
      fired.push("onError");
    },
    { condition: always },
  );
  reg.addOnRetry(
    () => {
      fired.push("onRetry");
    },
    { condition: always },
  );
  reg.addOnRedirect(
    () => {
      fired.push("onRedirect");
    },
    { condition: always },
  );
  reg.addOnUploadProgress(
    () => {
      fired.push("onUploadProgress");
    },
    { condition: always },
  );
  reg.addOnDownloadProgress(
    () => {
      fired.push("onDownloadProgress");
    },
    { condition: always },
  );
  reg.addOnCancel(
    () => {
      fired.push("onCancel");
    },
    { condition: always },
  );
  reg.addOnConnection(
    () => {
      fired.push("onConnection");
    },
    { condition: always },
  );

  await reg.runBeforeRequest(req, ctx);
  await reg.runAfterRequest(req, ctx);
  await reg.runBeforeResponse(hookRes(req), ctx);
  await reg.runAfterResponse(hookRes(req), ctx);
  await reg.runOnError({ error: new Error("e"), request: req, response: null, attempt: 1 }, ctx);
  await reg.runOnRetry(
    { attempt: 2, maxRetries: 3, delayMs: 1, reason: null, request: req, response: null },
    ctx,
  );
  await reg.runOnRedirect({ from: "a", to: "b", status: 301, count: 1, request: req }, ctx);
  reg.runOnUploadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx);
  reg.runOnDownloadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx);
  reg.runOnCancel({ request: req, reason: null }, ctx);
  reg.runOnConnection({ type: "connect", host: "h", port: 1, protocol: "https", elapsed: 1 }, ctx);

  assert.deepEqual(fired, [
    "beforeRequest",
    "afterRequest",
    "beforeResponse",
    "afterResponse",
    "onError",
    "onRetry",
    "onRedirect",
    "onUploadProgress",
    "onDownloadProgress",
    "onCancel",
    "onConnection",
  ]);
});

// ============================================================================
// SAFE OPTION with real HTTP
// ============================================================================

suite("safe option via real HTTP");

await test("safe hook doesn't crash pipeline", async () => {
  const reg = new HookRegistry();
  let called = false;

  reg.addBeforeRequest(
    async () => {
      throw new Error("test");
    },
    { safe: true },
  );
  reg.addBeforeRequest(async () => {
    called = true;
  });

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
  assert.equal(called, true);
});

// ============================================================================
// PROGRESS/RETRY/REDIRECT hooks
// ============================================================================

suite("Additional hooks via real HTTP");

// These seven asserted only that `add*` handed back a string. A registry that
// registered the hook in the wrong phase, or never ran it, returned the same
// string. Each now fires its own phase and requires the hook to run.
await test("addOnUploadProgress hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnUploadProgress(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  reg.runOnUploadProgress(
    { loaded: 1, total: 10, percent: 10, rate: null, elapsed: 1 },
    createHookContext(hookReq()),
  );
  assert.equal(n, 1);
});

await test("addOnDownloadProgress hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnDownloadProgress(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  reg.runOnDownloadProgress(
    { loaded: 1, total: 10, percent: 10, rate: null, elapsed: 1 },
    createHookContext(hookReq()),
  );
  assert.equal(n, 1);
});

await test("addOnRedirect hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnRedirect(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  await reg.runOnRedirect(
    { from: "https://a.test", to: "https://b.test", status: 301, count: 1, request: hookReq() },
    createHookContext(hookReq()),
  );
  assert.equal(n, 1);
});

await test("addOnRetry hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnRetry(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  await reg.runOnRetry(
    {
      attempt: 2,
      maxRetries: 3,
      delayMs: 1,
      reason: new Error("r"),
      request: hookReq(),
      response: null,
    },
    createHookContext(hookReq()),
  );
  assert.equal(n, 1);
});

await test("addOnConnection hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnConnection(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  reg.runOnConnection(
    { type: "connect", host: "a.test", port: 443, protocol: "https", elapsed: 1 },
    createHookContext(hookReq()),
  );
  assert.equal(n, 1);
});

await test("addOnCancel hook runs", async () => {
  const reg = new HookRegistry();
  let n = 0;
  const id = reg.addOnCancel(() => {
    n++;
  });
  assert.equal(typeof id, "string");
  reg.runOnCancel({ request: hookReq(), reason: null }, createHookContext(hookReq()));
  assert.equal(n, 1);
});

await test("addAround hook wraps the dispatch", async () => {
  const reg = new HookRegistry();
  let entered = false;
  const id = reg.addAround(async (_ctx, next) => {
    entered = true;
    return next();
  });
  assert.equal(typeof id, "string");
  const req = hookReq();
  const ctx = createHookContext(req);
  const res = await reg.wrapWithAround(ctx, async () => hookRes(req))();
  assert.equal(entered, true, "the around hook must be entered");
  assert.equal(res.status, 200, "and the dispatch must still run");
});

// ============================================================================
// HOOK EMITTER
// ============================================================================

suite("HookEmitter");

await test("HookEmitter.on with emission", async () => {
  const emitter = new HookEmitter();
  let called = false;

  // "test" is not a member of HookEventMap, so this never typechecked — the
  // test files are outside tsconfig.check.json. Use a real event.
  emitter.on("cancel", async () => {
    called = true;
  });
  await emitter.emit("cancel", { request: hookReq(), reason: null });

  assert.equal(called, true);
});

await test("HookEmitter.once fires once", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.once("cancel", async () => {
    count++;
  });
  await emitter.emit("cancel", { request: hookReq(), reason: null });
  await emitter.emit("cancel", { request: hookReq(), reason: null });

  assert.equal(count, 1);
});

await test("HookEmitter.off removes listener", async () => {
  const emitter = new HookEmitter();
  let count = 0;
  const listener = async () => {
    count++;
  };

  emitter.on("cancel", listener);
  emitter.off("cancel", listener);
  await emitter.emit("cancel", { request: hookReq(), reason: null });

  assert.equal(count, 0);
});

await test("HookEmitter.removeAllListeners", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.on("cancel", async () => {
    count++;
  });
  emitter.removeAllListeners();
  await emitter.emit("cancel", { request: hookReq(), reason: null });

  assert.equal(count, 0);
});

await test("HookEmitter.removeAllListeners(event)", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.on("cancel", async () => {
    count++;
  });
  emitter.removeAllListeners("cancel");
  await emitter.emit("cancel", { request: hookReq(), reason: null });

  assert.equal(count, 0);
});

// ============================================================================
// HOOK UTILITIES - these need in-memory testing
// ============================================================================

suite("Hook utilities (in-memory)");

await test("createHookContext creates context", () => {
  const ctx = createHookContext({
    url: "https://example.com",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  });

  assert.equal(ctx.request.url, "https://example.com");
});

await test("createHookContext with overrides", () => {
  const ctx = createHookContext(
    {
      url: "https://example.com",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    },
    { attempt: 5 },
  );

  assert.equal(ctx.attempt, 5);
});

await test("composeBeforeRequest combines hooks", async () => {
  const hook1 = async (req: any) => ({ ...req, headers: { ...req.headers, "X-1": "1" } });
  const hook2 = async (req: any) => ({ ...req, headers: { ...req.headers, "X-2": "2" } });
  const composed = composeBeforeRequest(hook1, hook2);

  const result = await composed({
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  });
  assert.equal(result.headers["X-1"], "1");
  assert.equal(result.headers["X-2"], "2");
});

await test("composeBeforeResponse transforms response", async () => {
  const hook1 = async (res: any) => ({ ...res, status: 201 });
  const hook2 = async (res: any) => ({ ...res, statusText: "Created" });
  const composed = composeBeforeResponse(hook1, hook2);

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const res = { status: 200, statusText: "OK", headers: {}, body: null, request: req };
  const ctx = createHookContext(req);

  const result = await composed(res, ctx);
  assert.equal(result.status, 201);
});

await test("composeAround wraps execution", async () => {
  const around = composeAround(async (ctx, next) => {
    ctx.meta.wrapped = true;
    const res = await next();
    ctx.meta.wrappedAfter = true;
    return res;
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const res = { status: 200, statusText: "OK", headers: {}, body: null, request: req };
  const ctx = createHookContext(req);

  await around(ctx, async () => res);
  assert.equal(ctx.meta.wrapped, true);
});

await test("validateResponse throws on invalid", async () => {
  const hook = validateResponse((res) => (res.status >= 400 ? "Error" : true));

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const badRes = { status: 400, statusText: "Error", headers: {}, body: null, request: req };
  const ctx = createHookContext(req);

  let threw = false;
  try {
    await hook(badRes, ctx);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof ResponseValidationError);
  }
  assert.equal(threw, true);
});

await test("injectHeaders adds headers", async () => {
  const hook = injectHeaders({ "X-Custom": "value" });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const result = await hook(req);
  assert.equal(result.headers["X-Custom"], "value");
});

await test("injectHeaders with async function", async () => {
  const hook = injectHeaders(async () => ({ "X-Func": "value" }));

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const result = await hook(req);
  assert.equal(result.headers["X-Func"], "value");
});

await test("withBaseURL sets relative URL", async () => {
  const hook = withBaseURL("https://api.example.com");

  const req = { url: "/users", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const result = await hook(req);
  assert.equal(result.url, "https://api.example.com/users");
});

await test("withBaseURL returns undefined for absolute", async () => {
  const hook = withBaseURL("https://api.example.com");

  const req = {
    url: "https://other.com/path",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  };
  const result = await hook(req);
  assert.equal(result, undefined);
});

await test("throwOnHTTPError throws on error status", async () => {
  const hook = throwOnHTTPError();

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  let threw = false;
  try {
    await hook({
      error: new Error("test"),
      request: req,
      response: { status: 500, statusText: "Error", headers: {}, body: null, request: req },
      attempt: 1,
    });
  } catch (e) {
    threw = true;
    assert.ok(e instanceof HTTPError);
  }
  assert.equal(threw, true);
});

await test("throwOnHTTPError passes valid", async () => {
  const hook = throwOnHTTPError();

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  // A 200 must pass through untouched — make that a positive claim rather than
  // an absence of a throw.
  let returned: unknown = "unset";
  await assert.doesNotReject(async () => {
    returned = await hook({
      error: new Error("test"),
      request: req,
      response: { status: 200, statusText: "OK", headers: {}, body: null, request: req },
      attempt: 1,
    });
  });
  assert.equal(returned, undefined, "a passing response must be returned unmodified");
});

await test("tap runs side-effect", async () => {
  let tapped = false;
  const hook = tap(async () => {
    tapped = true;
  });

  const result = await hook({
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  });
  assert.equal(tapped, true);
  assert.equal(result.url, "/test");
});

await test("HTTPError has correct properties", () => {
  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const res = { status: 500, statusText: "Error", headers: {}, body: null, request: req };

  const err = new HTTPError(500, "Error", res);

  assert.equal(err.status, 500);
  assert.equal(err.code, "EHTTPERROR");
});

await test("ResponseValidationError has correct properties", () => {
  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const res = { status: 400, statusText: "Bad", headers: {}, body: null, request: req };

  const err = new ResponseValidationError("Invalid", res);

  assert.equal(err.code, "EVALIDATION");
});

// ============================================================================
// PROGRESS/REDIRECT TRACKERS
// ============================================================================

suite("Progress/Redirect trackers");

await test("ProgressTracker tracks uploading", () => {
  const tracker = new ProgressTracker(1000);
  const event = tracker.update(100);

  assert.equal(event.loaded, 100);
  assert.equal(event.total, 1000);
});

await test("ProgressTracker calculates rate", () => {
  const tracker = new ProgressTracker(1000);
  tracker.update(100);
  const event = tracker.update(100);

  assert.equal(event.loaded, 200);
  assert.equal(event.total, 1000);
  assert.equal(event.percent, 20);
  assert.equal(typeof event.rate, "number");
  assert.equal(event.rate! >= 0, true);
});

await test("ProgressTracker.complete returns final", () => {
  const tracker = new ProgressTracker(1000);
  tracker.update(500);
  const event = tracker.complete();

  assert.equal(event.loaded, 500);
});

await test("RedirectTracker records", () => {
  const tracker = new RedirectTracker(5);
  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };

  const event = tracker.record("https://a.com", "https://b.com", 301, req);

  assert.equal(event.count, 1);
});

await test("TooManyRedirectsError throws", () => {
  const tracker = new RedirectTracker(2);
  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };

  tracker.record("https://a.com", "https://b.com", 301, req);
  tracker.record("https://b.com", "https://c.com", 301, req);

  let threw = false;
  try {
    tracker.record("https://c.com", "https://d.com", 301, req);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof TooManyRedirectsError);
  }
  assert.equal(threw, true);
});

// ============================================================================
// ADDITIONAL HOOK METHODS
// ============================================================================

suite("Additional HookRegistry methods");

await test("wrapWithAround wraps dispatch", async () => {
  const reg = new HookRegistry();
  let wrapped = false;
  reg.addAround(async (ctx, next) => {
    wrapped = true;
    return next();
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  const wrappedFn = reg.wrapWithAround(ctx, async () => ({
    status: 200,
    statusText: "OK",
    headers: {},
    body: null,
    request: req,
  }));
  const result = await wrappedFn();

  assert.equal(wrapped, true);
  assert.equal(result.status, 200);
});

await test("runOnUploadProgress with condition", () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnUploadProgress(
    async () => {
      called = true;
    },
    { condition: () => true },
  );

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  reg.runOnUploadProgress({ loaded: 100, total: 1000, percent: 10, rate: 100, elapsed: 100 }, ctx);
  assert.equal(called, true);
});

await test("runOnDownloadProgress fires", () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnDownloadProgress(async () => {
    called = true;
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  reg.runOnDownloadProgress(
    { loaded: 100, total: 1000, percent: 10, rate: 100, elapsed: 100 },
    ctx,
  );
  assert.equal(called, true);
});

await test("runOnRedirect returns false when hook returns false", async () => {
  const reg = new HookRegistry();
  reg.addOnRedirect(async () => false);

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  const allow = await reg.runOnRedirect(
    {
      from: "https://a.com",
      to: "https://b.com",
      status: 301,
      count: 1,
      request: req,
    },
    ctx,
  );

  assert.equal(allow, false);
});

await test("runOnCancel fires", () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnCancel(async () => {
    called = true;
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  reg.runOnCancel({ request: req, reason: new Error("cancelled") }, ctx);
  assert.equal(called, true);
});

await test("runOnConnection fires", () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnConnection(async () => {
    called = true;
  });

  reg.runOnConnection(
    {
      type: "connect",
      host: "example.com",
      port: 443,
      protocol: "https",
      elapsed: 50,
    },
    createHookContext(hookReq()),
  );
  assert.equal(called, true);
});

await test("runBeforeResponse transforms", async () => {
  const reg = new HookRegistry();
  reg.addBeforeResponse(async (res) => ({ ...res, status: 201 }));

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  const res = { status: 200, statusText: "OK", headers: {}, body: null, request: req };
  const result = await reg.runBeforeResponse(res, ctx);

  assert.equal(result.status, 201);
});

await test("runOnRetry fires", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnRetry(async () => {
    called = true;
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  await reg.runOnRetry(
    {
      attempt: 2,
      maxRetries: 3,
      delayMs: 500,
      reason: new Error("test"),
      request: req,
      response: null,
    },
    ctx,
  );

  assert.equal(called, true);
});

await test("runAfterRequest fires", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addAfterRequest(async () => {
    called = true;
  });

  const req = { url: "/test", method: "GET", headers: {}, body: null, signal: null, meta: {} };
  const ctx = createHookContext(req);

  await reg.runAfterRequest(req, ctx);
  assert.equal(called, true);
});

await test("createAbortHook with signal", async () => {
  const abort = createAbortHook();
  const controller = new AbortController();

  const req = {
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: controller.signal,
    meta: {},
  };
  const ctx = createHookContext(req);

  // beforeRequest is synchronous, so doesNotReject is the wrong shape here.
  assert.doesNotThrow(() => abort.beforeRequest(req, ctx));
  // An un-aborted signal must be left alone.
  assert.equal(controller.signal.aborted, false, "beforeRequest must not abort an active request");
});

await test("createAbortHook throws when aborted", async () => {
  const abort = createAbortHook();
  const controller = new AbortController();
  controller.abort();

  const req = {
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: controller.signal,
    meta: {},
  };
  const ctx = createHookContext(req);

  let threw = false;
  try {
    await abort.beforeRequest(req, ctx);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof DOMException);
  }
  assert.equal(threw, true);
});

// ── Additional coverage tests ───────────────────────────────────────────
suite("Additional coverage");

// Lines 459-460: error hook returning recovery response
await test("error hook recovery response is returned to the caller", async () => {
  const reg = new HookRegistry();
  let saw: any = null;
  reg.addOnError((err) => {
    saw = err;
    return { status: 200, statusText: "Recovered", headers: {}, body: "ok", request: err.request };
  });
  const req = hookReq();
  const hookCtx = createHookContext(req);
  hookCtx.error = new Error("test error");
  // The old call passed a bare `Error` where a `HookError` is required. It only
  // worked because the hook ignored its argument, so the argument was never
  // checked — and `error`, `request`, `response` and `attempt` are the entire
  // point of the type.
  const hookErr = { error: new Error("test error"), request: req, response: null, attempt: 3 };
  const result = await reg.runOnError(hookErr, hookCtx);
  assert.notEqual(result, null);
  assert.equal(result!.status, 200);
  assert.equal(result!.statusText, "Recovered");
  assert.equal(saw, hookErr, "the hook must receive the exact HookError it was given");
  assert.equal(saw.attempt, 3);
  assert.equal(saw.request, req);
});

// Lines 900-909: body normalization hook with non-Uint8Array body
await test("createBodyNormalizationHook non-Uint8Array body covers line 907", async () => {
  const hook = createBodyNormalizationHook("utf-8");
  const result = hook({ status: 200, statusText: "OK", headers: {}, body: "already string" });
  assert.equal(result, undefined);
});

// Cross-runtime: createAbortError fallback (lines 945-946)
await test("createAbortError fallback in non-DOMException runtime", async () => {
  const orig = (globalThis as any).DOMException;
  (globalThis as any).DOMException = undefined;
  try {
    // Re-import the module to trigger the fallback path
    const { createAbortHook: cah } = await import("../src/lifecycle.ts");
    const abort = cah();
    const ctrl = new AbortController();
    ctrl.abort();
    let threw = false;
    try {
      await abort.beforeRequest(
        { url: "/t", method: "GET", headers: {}, body: null, signal: ctrl.signal, meta: {} },
        createHookContext({
          url: "/t",
          method: "GET",
          headers: {},
          body: null,
          signal: null,
          meta: {},
        }),
      );
    } catch (e: any) {
      threw = true;
      assert.ok(e instanceof Error);
      assert.equal(e.name, "AbortError");
    }
    assert.equal(threw, true);
  } finally {
    (globalThis as any).DOMException = orig;
  }
});

// Cross-runtime: Date.now() fallback in perfNow (line 950)
await test("perfNow uses Date.now when performance missing", async () => {
  const orig = (globalThis as any).performance;
  (globalThis as any).performance = undefined;
  try {
    const { createHookContext: chc } = await import("../src/lifecycle.ts");
    const ctx = chc({ url: "/t", method: "GET", headers: {}, body: null, signal: null, meta: {} });
    assert.equal(typeof ctx.startedAt, "number");
  } finally {
    (globalThis as any).performance = orig;
  }
});

// Lines 930-931: createAbortHook onCancel handler
await test("createAbortHook onCancel fires", async () => {
  const abort = createAbortHook();
  let cancelled = false;
  const orig = abort.onCancel;
  abort.onCancel = (evt: any) => {
    cancelled = true;
    orig(evt);
  };
  const controller = new AbortController();
  const req = {
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: controller.signal,
    meta: {},
  };
  const ctx = createHookContext(req);
  controller.abort();
  // `assert.throws`, not `assert.rejects`: the hook aborts synchronously, and
  // the distinction matters. `assert.rejects` re-throws a synchronous throw
  // instead of validating it, so it reported the raw error; the empty
  // `catch {}` this replaced asserted nothing at all.
  assert.throws(
    () => abort.beforeRequest(req, ctx),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an aborted beforeRequest must throw an Error");
      assert.equal((err as { name?: string }).name, "AbortError");
      assert.match(err.message, /aborted/i);
      return true;
    },
    "a hook run under an aborted signal must throw",
  );
  // Call onCancel directly
  abort.onCancel({ request: req, reason: "test" } as any);
  assert.equal(cancelled, true);
});

// Lines 902-906: body normalization with Uint8Array body
await test("createBodyNormalizationHook Uint8Array body", async () => {
  const hook = createBodyNormalizationHook("utf-8");
  const result = hook({
    status: 200,
    statusText: "OK",
    headers: {},
    body: new TextEncoder().encode("hello"),
  });
  assert.notEqual(result, null);
  assert.equal(result.body, "hello");
});

// Lines 945-946: createAbortError fallback (can't test in Node.js — DOMException exists)
// These are dead code in modern runtimes

// Lines 413-414: modified request from hook
await test("beforeRequest hook modifies request URL", async () => {
  const reg = new HookRegistry();
  reg.addBeforeRequest((req) => ({ ...req, url: "/modified" }));
  const result = await reg.runBeforeRequest(
    { url: "/original", method: "GET", headers: {}, body: null, signal: null, meta: {} },
    createHookContext({
      url: "/original",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    }),
  );
  assert.equal(result.url, "/modified");
});
// ============================================================================
// REGRESSION: defects found by the strictest-assertion audit
// ============================================================================
suite("Regression: audit fixes");

await test("regression: withBaseURL joins with exactly one slash", async () => {
  const ctx = createHookContext(hookReq());
  const join = async (base: string, url: string): Promise<string> => {
    // An absolute URL is left alone and the hook returns undefined by design.
    const out = (await withBaseURL(base)(hookReq({ url }), ctx)) as any;
    return out === undefined ? url : out.url;
  };
  // The old rule — "add a slash unless one side already has one" — produced a
  // double slash precisely when both did, and `baseURL: "https://api.test/"` is
  // the spelling most people write.
  assert.equal(await join("https://api.test/v1/", "/users"), "https://api.test/v1/users");
  assert.equal(await join("https://api.test/v1", "/users"), "https://api.test/v1/users");
  assert.equal(await join("https://api.test/v1/", "users"), "https://api.test/v1/users");
  assert.equal(await join("https://api.test/v1", "users"), "https://api.test/v1/users");
  // Trailing and leading runs of slashes collapse to one.
  assert.equal(await join("https://api.test///", "///users"), "https://api.test/users");
  // An empty path keeps the single trailing slash.
  assert.equal(await join("https://api.test/v1", ""), "https://api.test/v1/");
  // A non-http scheme is still treated as absolute and left alone.
  assert.equal(await join("https://api.test", "https://other.test/x"), "https://other.test/x");
});

await test('regression: runOnError emits "error" when a hook recovers', async () => {
  // The `error` event used to sit behind a plain `return`, so the early return
  // taken by a recovering hook skipped it: every error was published except the
  // recovered ones, which are precisely the ones the caller never sees.
  const req = hookReq();
  const ctx = createHookContext(req);
  const published: any[] = [];
  const events: string[] = [];

  const recovering = new HookRegistry();
  recovering.emitter.on("error", (e) => {
    events.push("recovered-case");
    published.push(e);
  });
  recovering.addOnError(() => ({ ...hookRes(), status: 503, request: req }));
  const err = { error: new Error("boom"), request: req, response: hookRes(), attempt: 2 };
  const out = await recovering.runOnError(err, ctx);

  assert.equal(out!.status, 503, "the recovery response is still returned");
  assert.deepEqual(events, ["recovered-case"], "a recovered error must still be published");
  assert.equal(published[0], err, "and the published event is the HookError itself");

  // The unrecovered case must keep publishing too, so the fix did not simply
  // move the emit to the other branch.
  const failing = new HookRegistry();
  const seen: any[] = [];
  failing.emitter.on("error", (e) => seen.push(e));
  const none = await failing.runOnError(err, ctx);
  assert.equal(none, null);
  assert.equal(seen.length, 1, "an unrecovered error must be published as well");
});

await test("regression: safe:false propagates on every phase", async () => {
  // Four phases used a bare `try {} catch {}` that ignored `safe` entirely, so
  // a critical hook marked safe:false — the documented default — was swallowed
  // and the pipeline carried on. Around hooks ignored it in the other
  // direction: safe:true still took the request down.
  const ctx = createHookContext(hookReq());
  const boom = () => {
    throw new Error("hook-boom");
  };
  const req = hookReq();

  const cancel = new HookRegistry();
  cancel.addOnCancel(boom);
  assert.throws(
    () => cancel.runOnCancel({ request: req, reason: null }, ctx),
    /hook-boom/,
    "a safe:false cancel hook must propagate",
  );

  const conn = new HookRegistry();
  conn.addOnConnection(boom);
  assert.throws(
    () =>
      conn.runOnConnection(
        { type: "connect", host: "h", port: 1, protocol: "https", elapsed: 1 },
        ctx,
      ),
    /hook-boom/,
    "a safe:false connection hook must propagate",
  );

  const up = new HookRegistry();
  up.addOnUploadProgress(boom);
  assert.throws(
    () => up.runOnUploadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx),
    /hook-boom/,
    "a safe:false upload-progress hook must propagate",
  );

  const down = new HookRegistry();
  down.addOnDownloadProgress(boom);
  assert.throws(
    () =>
      down.runOnDownloadProgress({ loaded: 1, total: 2, percent: 50, rate: null, elapsed: 1 }, ctx),
    /hook-boom/,
    "a safe:false download-progress hook must propagate",
  );

  const around = new HookRegistry();
  around.addAround(boom);
  // The wrapper calls the hook synchronously, so this throws rather than
  // returning a rejected promise and `assert.rejects` is the wrong shape.
  assert.throws(
    () => around.wrapWithAround(ctx, async () => hookRes())(),
    /hook-boom/,
    "a safe:false around hook must propagate",
  );
});

await test("regression: safe:true isolates the hook on every phase", async () => {
  const ctx = createHookContext(hookReq());
  const req = hookReq();
  const boom = () => {
    throw new Error("hook-boom");
  };
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const cancel = new HookRegistry();
    cancel.addOnCancel(boom, { safe: true });
    assert.doesNotThrow(() => cancel.runOnCancel({ request: req, reason: null }, ctx));
    assert.ok(
      logged.some((l) => String((l as unknown[])[0]).includes("threw")),
      "a safe hook's failure must be reported, not silently dropped",
    );

    const around = new HookRegistry();
    around.addAround(boom, { safe: true });
    const res = await around.wrapWithAround(ctx, async () => hookRes())();
    // An around hook that throws before calling `next` has no response to
    // return, so the dispatch still runs — otherwise the request cannot proceed.
    assert.equal(res.status, 200, "a safe around hook must not break the dispatch");
  } finally {
    console.error = origError;
  }
});

await test("regression: condition gates the cancel and connection phases", async () => {
  // `runOnCancel` and `runOnConnection` never evaluated `condition`, and
  // `runOnConnection` was not even given a context to evaluate it against, so
  // `addOnCancel(fn, { condition })` ran the hook unconditionally.
  const ctx = createHookContext(hookReq());
  const ran: string[] = [];

  const cancel = new HookRegistry();
  cancel.addOnCancel(() => ran.push("cancel"), {
    condition: (c) => c.request.url.includes("/nope"),
  });
  cancel.runOnCancel({ request: hookReq(), reason: null }, ctx);
  assert.deepEqual(ran, [], "a false condition must suppress a cancel hook");

  const conn = new HookRegistry();
  conn.addOnConnection(() => ran.push("connection"), {
    condition: (c) => c.request.url.includes("/nope"),
  });
  conn.runOnConnection({ type: "connect", host: "h", port: 1, protocol: "https", elapsed: 1 }, ctx);
  assert.deepEqual(ran, [], "a false condition must suppress a connection hook");

  // ...and a true condition still runs, so this is a gate and not a kill switch.
  const open = new HookRegistry();
  open.addOnCancel(() => ran.push("cancel-allowed"), { condition: () => true });
  open.runOnCancel({ request: hookReq(), reason: null }, ctx);
  assert.deepEqual(ran, ["cancel-allowed"]);
});

await test("regression: HookEmitter.emit is re-entrancy safe", async () => {
  const evt = { request: hookReq(), reason: null };

  // (a) A listener that registers another listener must not have it called by
  // the emit already in progress.
  const e1 = new HookEmitter();
  const order: string[] = [];
  e1.on("cancel", () => {
    order.push("first");
    e1.on("cancel", () => order.push("added-during-emit"));
  });
  await e1.emit("cancel", evt);
  assert.deepEqual(order, ["first"], "a listener added mid-emit waits for the next emit");
  await e1.emit("cancel", evt);
  assert.deepEqual(order, ["first", "first", "added-during-emit"]);

  // (b) A listener that removes another must not have the removal undone by the
  // write-back that drops `once` listeners.
  // A `once` listener has to be present for this to be observable at all: the
  // write-back only runs when the emit consumed one, and the first version of
  // this test had none, so it passed against the code that re-adds what off()
  // just removed.
  const e2 = new HookEmitter();
  const calls: string[] = [];
  const second = () => calls.push("second");
  const oneShot = () => calls.push("once");
  e2.on("cancel", () => {
    calls.push("first");
    e2.off("cancel", second);
  });
  e2.on("cancel", second);
  e2.once("cancel", oneShot);
  await e2.emit("cancel", evt);
  assert.deepEqual(calls, ["first", "second", "once"], "listeners present at emit time still run");
  calls.length = 0;
  await e2.emit("cancel", evt);
  assert.deepEqual(
    calls,
    ["first"],
    "the off() performed mid-emit must survive the once-listener write-back",
  );

  // (c) `once` removal still works, and is by identity rather than by index.
  const e3 = new HookEmitter();
  let n = 0;
  e3.once("cancel", () => n++);
  e3.on("cancel", () => n++);
  await e3.emit("cancel", evt);
  await e3.emit("cancel", evt);
  assert.equal(n, 3, "the once listener fires exactly once, the persistent one twice");

  // (d) A listener added during an emit that also contains a `once` listener
  // must not be dropped by the trailing filter.
  const e4 = new HookEmitter();
  const seen: string[] = [];
  e4.once("cancel", () => {
    seen.push("once");
    e4.on("cancel", () => seen.push("late"));
  });
  await e4.emit("cancel", evt);
  assert.deepEqual(seen, ["once"]);
  seen.length = 0;
  await e4.emit("cancel", evt);
  assert.deepEqual(
    seen,
    ["late"],
    "a listener added during a once-emit must survive the write-back",
  );
});

await test("regression: createLoggingHooks redacts Set-Cookie by default", async () => {
  // The default list was `authorization` and `cookie` only, while `afterResponse`
  // logs *response* headers — so Set-Cookie went to the log in cleartext on a
  // hook whose whole purpose is logging. The interceptors already redact all four.
  const logged: Array<[string, any]> = [];
  const logging = createLoggingHooks({ logger: (m, d) => logged.push([m, d]) });
  const req = hookReq();
  logging.afterResponse(
    hookRes({
      request: req,
      headers: {
        authorization: "Bearer tok",
        cookie: "sid=c",
        "set-cookie": "session=SECRET",
        "proxy-authorization": "Basic SECRET",
        "content-type": "application/json",
      },
    }),
    createHookContext(req),
  );
  const headers = logged[0]![1].headers as Record<string, string>;
  assert.equal(headers["authorization"], "***");
  assert.equal(headers["cookie"], "***");
  assert.equal(headers["set-cookie"], "***", "Set-Cookie must be redacted by default");
  assert.equal(headers["proxy-authorization"], "***");
  assert.equal(headers["content-type"], "application/json", "other headers still log");
  const serialised = JSON.stringify(logged);
  assert.ok(!serialised.includes("SECRET"), `no secret may reach the log: ${serialised}`);

  // An explicit list still replaces the default rather than adding to it.
  const custom: Array<[string, any]> = [];
  const only = createLoggingHooks({
    logger: (m, d) => custom.push([m, d]),
    redactHeaders: ["x-trace"],
  });
  only.beforeRequest(
    hookReq({ headers: { "x-trace": "t", "set-cookie": "left-alone" } }),
    createHookContext(req),
  );
  const h = custom[0]![1].headers as Record<string, string>;
  assert.equal(h["x-trace"], "***");
  assert.equal(h["set-cookie"], "left-alone", "an explicit list replaces the default");
});

// ============================================================================

console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
}
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
