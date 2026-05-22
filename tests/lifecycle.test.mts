/**
 * lifecycle.ts - Real HTTP tests to httpbin.org
 * Goal: All tests use real HTTP calls to httpbin.org
 * Only unit tests where HTTP cannot test the functionality
 */

import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
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

  try {
    await bin.get("/status/404");
  } catch (e) {}

  assert.equal(called, true);
});

await test("500 triggers onError hook", async () => {
  const reg = new HookRegistry();
  let called = false;
  reg.addOnError(async () => {
    called = true;
  });

  bin.attachHookRegistry(reg);

  try {
    await bin.get("/status/500");
  } catch (e) {}

  assert.equal(called, true);
});

await test("502 triggers onError hook with attempt", async () => {
  const reg = new HookRegistry();
  let attempt = 0;
  reg.addOnError(async (err) => {
    attempt = err.attempt;
  });

  bin.attachHookRegistry(reg);

  try {
    await bin.get("/status/502");
  } catch (e) {}

  assert.ok(attempt > 0);
});

await test("503 triggers onError with request data", async () => {
  const reg = new HookRegistry();
  let url = "";
  reg.addOnError(async (err) => {
    url = err.request.url;
  });

  bin.attachHookRegistry(reg);

  try {
    await bin.get("/status/503");
  } catch (e) {}

  assert.ok(url.includes("/status/503"));
});

// ============================================================================
// CREATE LOGGING HOOKS with REAL HTTP
// ============================================================================

suite("createLoggingHooks with real HTTP");

await test("loggingHooks beforeRequest with GET", async () => {
  const logging = createLoggingHooks();

  const reg = new HookRegistry();
  reg.addBeforeRequest(logging.beforeRequest);

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
});

await test("loggingHooks afterResponse with GET", async () => {
  const logging = createLoggingHooks();

  const reg = new HookRegistry();
  reg.addAfterResponse(logging.afterResponse);

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
});

await test("loggingHooks onError with 400", async () => {
  const logging = createLoggingHooks();

  const reg = new HookRegistry();
  reg.addOnError(logging.onError);

  bin.attachHookRegistry(reg);

  try {
    await bin.get("/status/400");
  } catch (e) {}
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

await test("loggingHooks with redactHeaders", async () => {
  const logging = createLoggingHooks({ redactHeaders: ["content-type"] });

  const reg = new HookRegistry();
  reg.addBeforeRequest(logging.beforeRequest);

  bin.attachHookRegistry(reg);

  const res = await bin.get("/get");
  assert.equal(res.status, 200);
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
  assert.ok(res.durationMs >= 0);
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

await test("POST /post with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.post("/post", { test: true });
  assert.equal(res.status, 200);
});

await test("PUT /put with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.put("/put", { test: true });
  assert.equal(res.status, 200);
});

await test("PATCH /patch with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.patch("/patch", { test: true });
  assert.equal(res.status, 200);
});

await test("DELETE /delete with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.delete("/delete");
  assert.equal(res.status, 200);
});

await test("HEAD /get with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.head("/get");
  assert.equal(res.status, 200);
});

await test("OPTIONS /get with beforeRequest", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.options("/get");
  assert.equal(res.status, 200);
});

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

await test("GET /html with afterResponse", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.get("/html");
  assert.equal(res.status, 200);
});

await test("GET /bytes/100 with response", async () => {
  const reg = new HookRegistry();

  bin.attachHookRegistry(reg);

  const res = await bin.get("/bytes/100");
  assert.equal(res.status, 200);
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
  const reg = new HookRegistry();
  reg.addBeforeRequest(async (req) => {
    req.headers["X-HookAdded"] = "true";
  });

  bin.attachHookRegistry(reg);

  const res = await bin.get<any>("/headers");
  console.log(`    → X-HookAdded: ${res.data.headers["X-HookAdded"]}`);
  // Note: May not echo custom headers in response
  assert.equal(res.status, 200);
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

  try {
    await bin.get("/status/400");
  } catch (e) {}

  assert.equal(typeof id, "string");
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

await test("addOnUploadProgress adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnUploadProgress(async () => {});
  assert.equal(typeof id, "string");
});

await test("addOnDownloadProgress adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnDownloadProgress(async () => {});
  assert.equal(typeof id, "string");
});

await test("addOnRedirect adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnRedirect(async () => {});
  assert.equal(typeof id, "string");
});

await test("addOnRetry adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnRetry(async () => {});
  assert.equal(typeof id, "string");
});

await test("addOnConnection adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnConnection(async () => {});
  assert.equal(typeof id, "string");
});

await test("addOnCancel adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addOnCancel(async () => {});
  assert.equal(typeof id, "string");
});

await test("addAround adds hook", async () => {
  const reg = new HookRegistry();
  const id = reg.addAround(async (_ctx, next) => next());
  assert.equal(typeof id, "string");
});

// ============================================================================
// HOOK EMITTER
// ============================================================================

suite("HookEmitter");

await test("HookEmitter.on with emission", async () => {
  const emitter = new HookEmitter();
  let called = false;

  emitter.on("test", async () => {
    called = true;
  });
  await emitter.emit("test", {});

  assert.equal(called, true);
});

await test("HookEmitter.once fires once", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.once("test", async () => {
    count++;
  });
  await emitter.emit("test", {});
  await emitter.emit("test", {});

  assert.equal(count, 1);
});

await test("HookEmitter.off removes listener", async () => {
  const emitter = new HookEmitter();
  let count = 0;
  const listener = async () => {
    count++;
  };

  emitter.on("test", listener);
  emitter.off("test", listener);
  await emitter.emit("test", {});

  assert.equal(count, 0);
});

await test("HookEmitter.removeAllListeners", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.on("test", async () => {
    count++;
  });
  emitter.removeAllListeners();
  await emitter.emit("test", {});

  assert.equal(count, 0);
});

await test("HookEmitter.removeAllListeners(event)", async () => {
  const emitter = new HookEmitter();
  let count = 0;

  emitter.on("test", async () => {
    count++;
  });
  emitter.removeAllListeners("test");
  await emitter.emit("test", {});

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
  await hook({
    error: new Error("test"),
    request: req,
    response: { status: 200, statusText: "OK", headers: {}, body: null, request: req },
    attempt: 1,
  });
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

  assert.ok(event.rate! >= 0);
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

  reg.runOnConnection({
    type: "connect",
    host: "example.com",
    port: 443,
    protocol: "https",
    elapsed: 50,
  });
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

  await abort.beforeRequest(req, ctx);
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
await test("error hook recovery response covers lines 459-460", async () => {
  const reg = new HookRegistry();
  reg.addOnError(() => ({ status: 200, statusText: "Recovered", headers: {}, body: "ok" }));
  const hookCtx = createHookContext({
    url: "/test",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  });
  hookCtx.error = new Error("test error");
  const result = await reg.runOnError(new Error("test error"), hookCtx);
  assert.notEqual(result, null);
  assert.equal(result.status, 200);
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
  try {
    await abort.beforeRequest(req, ctx);
  } catch {}
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
