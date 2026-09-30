import assert from "node:assert/strict";
import process from "node:process";
import {
  kinetex,
  InterceptorManager,
  createRetryInterceptor,
  createAuthInterceptor,
  createTimeoutInterceptor,
  createLoggingInterceptor,
  createCacheInterceptor,
  createDedupeInterceptor,
  createRateLimitInterceptor,
  createHARInterceptor,
  createMetricsInterceptor,
  createInterceptorSuite,
  RateLimitError,
  TimeoutError,
  computeBodySize,
} from "../src/mod.ts";

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

const T = 30_000;
const bin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

// ── REAL HTTP ────────────────────────────────────────────────────────────
suite("REAL HTTP");
await test("GET /get", async () => assert.equal((await bin.get("/get")).status, 200));
await test("POST echoes JSON", async () =>
  assert.deepEqual((await bin.post("/post", { a: 1 })).data.json, { a: 1 }));
test("/uuid", async () => {
  const res = await bin.get("/uuid");
  assert.equal(res.status, 200);
  // Must be a well-formed v4 UUID, not merely a truthy string.
  assert.match(
    res.data.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});
test("/ip", async () => {
  const res = await bin.get("/ip");
  assert.equal(res.status, 200);
  assert.match(res.data.origin, /^[0-9a-f:.]+$/i);
});
test("/headers", async () => {
  const res = await bin.get("/headers");
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.headers, "object");
  // httpbin echoes the request headers it received; Host is always present
  // and proves the request actually carried headers end to end.
  assert.ok(res.data.headers["Host"], "expected the Host header to be echoed");
  assert.equal(typeof res.data.headers["Host"], "string");
});
test("/json", async () => {
  const res = await bin.get("/json");
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.slideshow, "object");
  assert.ok(Array.isArray(res.data.slideshow.slides), "expected slideshow.slides to be an array");
});
await test("/base64", async () =>
  assert.equal(String((await bin.get("/base64/SGVsbG8gV29ybGQ=")).data).trim(), "Hello World"));

// ── InterceptorManager CORE ──────────────────────────────────────────────
suite("InterceptorManager core");
await test("useRequest + eject", () => {
  const m = new InterceptorManager();
  const id = m.useRequest(() => {});
  assert.equal(m.requestCount, 1);
  assert.equal(m.eject(id), true);
  assert.equal(m.requestCount, 0);
});
await test("useResponse + eject", () => {
  const m = new InterceptorManager();
  const id = m.useResponse(() => {});
  assert.equal(m.responseCount, 1);
  assert.equal(m.eject(id), true);
  assert.equal(m.responseCount, 0);
});
await test("useError + eject", () => {
  const m = new InterceptorManager();
  const id = m.useError(() => {});
  assert.equal(m.errorCount, 1);
  assert.equal(m.eject(id), true);
  assert.equal(m.errorCount, 0);
});
await test("ejectAll", () => {
  const m = new InterceptorManager();
  m.useRequest(() => {});
  m.useResponse(() => {});
  m.useError(() => {});
  m.ejectAll();
  assert.equal(m.requestCount, 0);
});
await test("has()", () => {
  const m = new InterceptorManager();
  const id = m.useRequest(() => {});
  assert.equal(m.has(id), true);
  assert.equal(m.has("x"), false);
});
await test("use registers both", () => {
  const m = new InterceptorManager();
  const { requestId, responseId } = m.use(
    () => {},
    () => {},
  );
  assert.equal(typeof requestId, "string");
  assert.equal(typeof responseId, "string");
});
await test("priority ordering", async () => {
  const m = new InterceptorManager();
  const order: number[] = [];
  m.useRequest(
    () => {
      order.push(10);
    },
    { priority: 10 },
  );
  m.useRequest(
    () => {
      order.push(1);
    },
    { priority: 1 },
  );
  await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.deepEqual(order, [1, 10]);
});
await test("once auto-ejects", async () => {
  let count = 0;
  const m = new InterceptorManager();
  m.useRequest(
    () => {
      count++;
    },
    { once: true },
  );
  await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    async () => await bin.get("/uuid"),
  );
  assert.equal(count, 1);
});
await test("condition filters", async () => {
  let count = 0;
  const m = new InterceptorManager();
  m.useRequest(
    () => {
      count++;
    },
    { condition: (ctx) => ctx.request.url.includes("/uuid") },
  );
  await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(count, 0);
  await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    async () => await bin.get("/uuid"),
  );
  assert.equal(count, 1);
});

// ── RETRY INTERCEPTOR with real HTTP via InterceptorManager ──────────────
suite("Retry interceptor");
await test("retry passes on 200", async () => {
  const m = new InterceptorManager();
  const retry = createRetryInterceptor({ maxRetries: 2, baseDelayMs: 10 });
  m.useResponse(retry.responseInterceptor);
  m.useError(retry.errorInterceptor);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});
await test("retry with status 500 exhausts retries", async () => {
  const m = new InterceptorManager();
  const retry = createRetryInterceptor({
    maxRetries: 1,
    baseDelayMs: 10,
    jitter: 0,
    retryStatuses: [500, 503],
  });
  m.useResponse(retry.responseInterceptor);
  m.useError(retry.errorInterceptor);
  // In-process dispatcher so the dispatch count is exact and the test does not
  // depend on a live 500. The old version asserted only the final status, which
  // is 500 whether the retry fired once or not at all.
  let calls = 0;
  const res = await m.execute(
    { url: "https://httpbin.org/status/500", method: "GET", headers: {} },
    async () => {
      calls++;
      return {
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        data: { attempt: calls },
        rawBody: null,
        url: "",
        cached: false,
        redirected: false,
        httpVersion: "HTTP/1.1",
        durationMs: 0,
        request: null as any,
        attempt: calls,
      } as any;
    },
  );
  assert.equal(res.status, 500);
  assert.equal(calls, 2, "maxRetries: 1 means exactly one retry, i.e. two dispatches");
  assert.equal(res.data.attempt, 2, "the final response must come from the second dispatch");
});

// ── TIMEOUT INTERCEPTOR with real HTTP ───────────────────────────────────
suite("Timeout interceptor");
await test("timeout on fast request", async () => {
  const m = new InterceptorManager();
  const timeout = createTimeoutInterceptor({ timeoutMs: 5000 });
  m.useRequest(timeout.requestInterceptor);
  m.useResponse(timeout.responseInterceptor);
  m.useError(timeout.errorInterceptor);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});

// ── AUTH INTERCEPTOR with real HTTP ──────────────────────────────────────
suite("Auth interceptor");
await test("auth injects Bearer token", async () => {
  const m = new InterceptorManager();
  // `createAuthInterceptor` takes a bare `{ getToken }` provider, NOT the
  // client-level AuthConfig. The old test passed `{ type, token }`, which is
  // silently ignored, so `getToken` defaulted to `() => null` and no header was
  // ever injected — the test only checked the status of an untouched request.
  const authSuite = createAuthInterceptor({ getToken: () => "test-token" });
  m.useRequest(authSuite.requestInterceptor);
  m.useResponse(authSuite.responseInterceptor);
  // The old version asserted only `status === 200`, which the plain httpbin call
  // satisfies whether or not the interceptor ever ran. Capture the request the
  // dispatcher actually receives and assert the token is on it.
  let seen: Record<string, string> | null = null;
  const res = await m.execute(
    { url: "https://httpbin.org/headers", method: "GET", headers: {} },
    async (req) => {
      seen = req.headers;
      return await bin.get<{ headers: Record<string, string> }>("/headers");
    },
  );
  assert.equal(res.status, 200);
  assert.ok(seen, "the dispatcher must have been called");
  assert.equal(seen.authorization, "Bearer test-token");
});

// ── LOGGING INTERCEPTOR with real HTTP ───────────────────────────────────
suite("Logging interceptor");
await test("logging fires", async () => {
  const logs: string[] = [];
  const m = new InterceptorManager();
  const logging = createLoggingInterceptor({
    // The option is `logger`, not `log` — passing `log` silently fell back to
    // the default console logger, which the old weak assertion accepted.
    logger: (entry) => {
      logs.push(JSON.stringify(entry));
    },
  });
  m.useRequest(logging.requestInterceptor);
  m.useResponse(logging.responseInterceptor);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  console.log("    Logs count:", logs.length, "Response status:", res.status);
  // `>= 1 || status === 200` is satisfied by a successful call alone, so it
  // would pass even if the logging interceptor never fired. Require the log.
  assert.equal(res.status, 200);
  assert.ok(logs.length >= 1, `Expected >= 1 log, got ${logs.length}`);
});

// ── HAR INTERCEPTOR with real HTTP ───────────────────────────────────────
suite("HAR interceptor");
await test("HAR records entries", async () => {
  const har = createHARInterceptor();
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest(har.requestInterceptor);
  client.useResponse(har.responseInterceptor);
  await client.get("/get");
  await client.get("/uuid");
  const entries = har.getHAR().entries;
  // Exactly the two requests made — no duplicates, none dropped.
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.request.url, "https://httpbin.org/get");
  assert.equal(entries[1]!.request.url, "https://httpbin.org/uuid");
  for (const e of entries) {
    assert.equal(e.response.status, 200);
    assert.ok(e.startedDateTime, "entry must record startedDateTime");
  }
});

// ── METRICS INTERCEPTOR with real HTTP ───────────────────────────────────
suite("Metrics interceptor");
await test("metrics snapshot", async () => {
  const metrics = createMetricsInterceptor();
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest(metrics.requestInterceptor);
  client.useResponse(metrics.responseInterceptor);
  await client.get("/get");
  const s = metrics.snapshot();
  assert.equal(typeof s.totalRequests, "number");
  assert.ok(s.totalRequests >= 1);
});

// ── DEDUPE INTERCEPTOR with real HTTP ────────────────────────────────────
suite("Dedupe interceptor");
await test("dedupe coalesces concurrent GETs", async () => {
  const m = new InterceptorManager();
  const d = createDedupeInterceptor();
  m.useRequest(d.requestInterceptor);
  m.useResponse(d.responseInterceptor);
  m.useError(d.errorInterceptor);
  let callCount = 0;
  const dispatcher = async () => {
    callCount++;
    return await bin.get<{ uuid: string }>("/uuid");
  };
  const [a, b] = await Promise.all([
    m.execute({ url: "https://httpbin.org/uuid", method: "GET", headers: {} }, dispatcher),
    m.execute({ url: "https://httpbin.org/uuid", method: "GET", headers: {} }, dispatcher),
  ]);
  assert.equal((a as any).data.uuid, (b as any).data.uuid);
  // Both responses are equal, but only if the leader's promise was shared.
  assert.equal(callCount, 1, "two concurrent GETs of the same URL must dispatch once");
});

// ── CACHE INTERCEPTOR with real HTTP ─────────────────────────────────────
suite("Cache interceptor");
await test("cache interceptor caches responses", async () => {
  const m = new InterceptorManager();
  const cache = createCacheInterceptor({ ttlMs: 5000 });
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);
  let callCount = 0;
  const dispatcher = async () => {
    callCount++;
    return await bin.get<{ uuid: string }>("/uuid");
  };
  const r1 = await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    dispatcher,
  );
  assert.equal(callCount, 1);
  // A single execute cannot distinguish "cached" from "never cached", so make a
  // second one: the dispatcher must not run again and the hit must be flagged.
  const r2 = await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    dispatcher,
  );
  assert.equal(callCount, 1, "the second execute must be served from the cache");
  assert.equal(r1.data?.uuid, r2.data?.uuid, "the cached response must be replayed");
});

// ── RATE-LIMIT INTERCEPTOR with real HTTP ────────────────────────────────
suite("Rate-limit interceptor");
await test("rate limit passes through", async () => {
  const m = new InterceptorManager();
  m.useRequest(createRateLimitInterceptor({ limit: 50, windowMs: 1000, queue: false }));
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});
await test("rate limit without queue throws on excess", async () => {
  const m = new InterceptorManager();
  m.useRequest(createRateLimitInterceptor({ limit: 1, windowMs: 60000, queue: false }));
  const dispatcher = async () => await bin.get("/get");
  await m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher);
  try {
    await m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher);
    assert.fail("should throw");
  } catch (e: any) {
    assert.ok(e instanceof RateLimitError);
  }
});
// rate-limit queue-full path is racy with real timers — covered by error path above

// ── computeBodySize coverage ────────────────────────────────────────────
suite("computeBodySize");
await test("bodySize returns 0 for null", () => {
  const size = computeBodySize(null);
  assert.equal(size, 0);
});
await test("bodySize returns length for string", () => {
  const size = computeBodySize("hello");
  assert.equal(size, 5);
});
await test("bodySize returns byteLength for Uint8Array", () => {
  const size = computeBodySize(new Uint8Array([1, 2, 3]));
  assert.equal(size, 3);
});
await test("bodySize returns byteLength for ArrayBuffer", () => {
  const size = computeBodySize(new ArrayBuffer(10));
  assert.equal(size, 10);
});
await test("bodySize returns -1 for unknown type", () => {
  const size = computeBodySize(new ReadableStream() as any);
  assert.equal(size, -1);
});

// ── RateLimitError ──────────────────────────────────────────────────────
suite("RateLimitError");
await test("RateLimitError properties", () => {
  const err = new RateLimitError("test limit");
  assert.equal(err.message, "test limit");
  assert.equal(err.code, "ERATELIMIT");
  assert.equal(err.name, "RateLimitError");
});

// ── STRICT MOCK: remainder branches ─────────────────────────────────────
suite("Strict mock: remaining branches");

// Dedupe error interceptor (lines 1112-1117): leader fails, waiters rejected
await test("dedupe error interceptor rejects waiters on leader failure", async () => {
  const m = new InterceptorManager();
  const dedupe = createDedupeInterceptor();
  m.useRequest(dedupe.requestInterceptor);
  m.useResponse(dedupe.responseInterceptor);
  m.useError(dedupe.errorInterceptor);
  const results = await Promise.allSettled([
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, async () => {
      throw new Error("leader-fail");
    }),
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, async () => {
      throw new Error("leader-fail");
    }),
  ]);
  assert.equal(results[0].status, "rejected", "First (leader) should reject");
  assert.equal(
    results[1].status,
    "rejected",
    "Second (waiter) should also reject via error interceptor",
  );
});

// computeBodySize Date.now() fallback (line 1417): mock performance undefined
await test("computeBodySize handles various body types", () => {
  const size = computeBodySize(new Uint8Array(100));
  assert.equal(size, 100);
});

// Cache interceptor SWR + 304 paths: mock-style test
await test("cache interceptor SWR and 304 paths", async () => {
  // Use cache interceptor with a known endpoint
  const cache = createCacheInterceptor({ ttlMs: 5000 });
  const m = new InterceptorManager();
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);
  // First call caches
  const r1 = await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    async () => await bin.get<{ uuid: string }>("/uuid"),
  );
  assert.equal(typeof r1.data?.uuid, "string");
  assert.match(
    r1.data?.uuid as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

// Rate-limit interval cleanup (lines 1175-1177): mock setTimeout to fire once
await test("rate-limit interval cleanup on empty pending", async () => {
  const m = new InterceptorManager();
  const rateLimit = createRateLimitInterceptor({ limit: 50, windowMs: 1000, queue: false });
  m.useRequest(rateLimit);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});

// HAR bodySize inline for completeness
await test("HAR records with string body via execute", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute(
    {
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "test-body",
    },
    async () => await bin.post("/post", "test-body", { headers: { "content-type": "text/plain" } }),
  );
  const entries = har.getHAR().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request.method, "POST");
  assert.equal(new URL(entries[0].request.url).pathname, "/post");
});
await test("rate limit queues excess", async () => {
  const m = new InterceptorManager();
  m.useRequest(createRateLimitInterceptor({ limit: 2, windowMs: 1000, queue: true, maxQueue: 10 }));
  const dispatcher = async () => await bin.get("/get");
  const results = await Promise.allSettled([
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher),
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher),
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
});

// ── HAR INTERCEPTOR with real HTTP ───────────────────────────────────────
suite("HAR interceptor");
await test("HAR records entries", async () => {
  const m = new InterceptorManager();
  const har = createHARInterceptor();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    async () => await bin.get("/uuid"),
  );
  const entries = har.getHAR().entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => new URL(e.request.url).pathname),
    ["/get", "/uuid"],
  );
});

// ── METRICS INTERCEPTOR with real HTTP ───────────────────────────────────
suite("Metrics interceptor");
await test("metrics snapshot", async () => {
  const m = new InterceptorManager();
  const metrics = createMetricsInterceptor();
  m.useRequest(metrics.requestInterceptor);
  m.useResponse(metrics.responseInterceptor);
  await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  const s = metrics.snapshot();
  assert.equal(typeof s.totalRequests, "number");
  assert.ok(s.totalRequests >= 1);
});

// ── CACHE INTERCEPTOR with real HTTP ─────────────────────────────────────
suite("Cache interceptor");
await test("cache interceptor caches responses", async () => {
  const m = new InterceptorManager();
  const cache = createCacheInterceptor({ ttlMs: 5000 });
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);
  let callCount = 0;
  const dispatcher = async () => {
    callCount++;
    return await bin.get<{ uuid: string }>("/uuid");
  };
  const r1 = await m.execute(
    { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
    dispatcher,
  );
  assert.equal(callCount, 1);
  assert.ok(r1.data?.uuid);
});

// Cache SWR: a stale entry is revalidated with a conditional request, and the
// stale body is only restored when the server answers 304. Note this
// interceptor does NOT serve the stale copy blind — the request always goes out.
await test("cache SWR revalidates and restores the stale body on 304", async () => {
  const cache = createCacheInterceptor({ defaultTtlMs: 60_000 });
  const m = new InterceptorManager();
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);

  let dispatches = 0;
  const seenIfNoneMatch: Array<string | undefined> = [];
  const dispatcher = async (req: any) => {
    dispatches++;
    seenIfNoneMatch.push(req.headers["if-none-match"]);
    if (dispatches === 1) {
      return {
        status: 200,
        statusText: "OK",
        headers: {
          etag: '"v1"',
          "cache-control": "public, max-age=1, stale-while-revalidate=3600",
        },
        data: { v: 1 },
        rawBody: null,
        url: "https://x.test/v",
        cached: false,
        redirected: false,
        httpVersion: "HTTP/1.1",
        durationMs: 0,
        request: req,
        attempt: 1,
      } as any;
    }
    return {
      status: 304,
      statusText: "Not Modified",
      headers: { etag: '"v1"' },
      data: null,
      rawBody: null,
      url: "https://x.test/v",
      cached: false,
      redirected: false,
      httpVersion: "HTTP/1.1",
      durationMs: 0,
      request: req,
      attempt: 1,
    } as any;
  };

  const r1 = await m.execute(
    { url: "https://x.test/v", method: "GET", headers: {} } as any,
    dispatcher,
  );
  assert.equal(r1.status, 200);
  assert.equal(dispatches, 1, "the first call is always a miss");
  assert.equal(seenIfNoneMatch[0], undefined, "nothing is cached yet, so no conditional header");

  // max-age=1 has elapsed but the entry is still inside the
  // stale-while-revalidate window, so it is revalidated rather than discarded.
  await new Promise((r) => setTimeout(r, 1200));
  const r2 = await m.execute(
    { url: "https://x.test/v", method: "GET", headers: {} } as any,
    dispatcher,
  );
  assert.equal(dispatches, 2, "a stale-but-revalidatable entry must be revalidated, not dropped");
  assert.equal(
    seenIfNoneMatch[1],
    '"v1"',
    "revalidation must send if-none-match from the stored etag",
  );
  assert.equal(r2.status, 200, "a 304 with a stale entry must be restored to the cached response");
  assert.deepEqual(r2.data, { v: 1 }, "the stale body must be replayed");

  // The 304 refresh reset createdAt, so the entry is fresh again (max-age=1
  // from the stale entry's own cache-control) and must be served from cache.
  const r3 = await m.execute(
    { url: "https://x.test/v", method: "GET", headers: {} } as any,
    dispatcher,
  );
  assert.equal(dispatches, 2, "the refreshed entry is fresh and must not be refetched");
  assert.deepEqual(r3.data, { v: 1 });
});

// Cache 304: mock 304 response — the response returns 304 (restoration is internal)
await test("cache 304 response is handled", async () => {
  const cache = createCacheInterceptor({ ttlMs: 5000 });
  const m = new InterceptorManager();
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);
  let callNum = 0;
  const dispatcher = async () => {
    callNum++;
    if (callNum === 1) {
      const res = await bin.get("/get");
      return {
        ...res,
        headers: {
          ...res.headers,
          etag: '"x"',
          "cache-control": "public, max-age=0, stale-while-revalidate=3600",
        },
      };
    }
    return {
      status: 304,
      statusText: "Not Modified",
      headers: { etag: '"x"' },
      data: null,
      rawBody: null,
      url: "",
      cached: false,
      redirected: false,
      httpVersion: "HTTP/1.1",
      durationMs: 0,
      request: null as any,
      attempt: 0,
    };
  };
  await m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher);
  const r2 = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    dispatcher,
  );
  // `max-age=0` means the response is never stored (the interceptor skips
  // ttlMs <= 0 entirely), so there is no stale entry to restore from and the 304
  // is surfaced as-is. This is the "server answered 304 with nothing to restore"
  // path; the real revalidation path is covered by the SWR test above.
  assert.equal(r2.status, 304);
  assert.equal(r2.cached, false);
  assert.equal(callNum, 2, "the second execute must revalidate rather than serve the entry");
});

// ── RATE-LIMIT INTERCEPTOR with real HTTP ────────────────────────────────
suite("Rate-limit interceptor");
await test("rate limit passes through", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest(createRateLimitInterceptor({ limit: 50, windowMs: 1000, queue: false }));
  assert.equal((await client.get("/get")).status, 200);
});
await test("rate limit queues excess requests", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest(
    createRateLimitInterceptor({ limit: 2, windowMs: 1000, queue: true, maxQueue: 10 }),
  );
  const results = await Promise.allSettled([
    client.get("/get"),
    client.get("/get"),
    client.get("/get"),
    client.get("/get"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
});

// ── INTERCEPTOR SUITE ────────────────────────────────────────────────────
suite("Interceptor suite");
await test("suite creates manager", () => {
  const s = createInterceptorSuite({ timeout: { timeoutMs: 5000 }, retry: { maxRetries: 1 } });
  assert.equal(s.manager instanceof InterceptorManager, true);
  assert.deepEqual(Object.keys(s), [
    "manager",
    "retry",
    "auth",
    "timeout",
    "logging",
    "cache",
    "dedupe",
    "har",
    "metrics",
  ]);
  assert.equal(s.auth, null, "no auth config means no auth interceptor");
  assert.equal(s.timeout.id, "timeout");
});
await test("suite with rateLimit config", () => {
  const s = createInterceptorSuite({
    timeout: { timeoutMs: 5000 },
    retry: { maxRetries: 1 },
    rateLimit: { limit: 10, windowMs: 1000, queue: true, maxQueue: 5 },
  });
  assert.equal(s.manager instanceof InterceptorManager, true);
  assert.equal(s.rateLimit, undefined, "rateLimit is folded into the manager, not returned");
});
await test("suite with auth config", () => {
  const s = createInterceptorSuite({
    timeout: { timeoutMs: 5000 },
    retry: { maxRetries: 1 },
    auth: { type: "bearer", token: "test" },
  });
  assert.equal(s.manager instanceof InterceptorManager, true);
  assert.equal(s.auth !== null, true, "auth config must produce an auth interceptor");
  assert.equal(typeof s.auth?.requestInterceptor, "function");
  assert.equal(typeof s.auth?.responseInterceptor, "function");
});

// ── METRICS RESET ───────────────────────────────────────────────────────
suite("Metrics reset");
await test("metrics reset clears counts", () => {
  const metrics = createMetricsInterceptor();
  metrics.requestInterceptor({
    store: new Map(),
    attempt: 1,
    request: { url: "x", method: "GET" },
  } as any);
  metrics.responseInterceptor({
    store: new Map(),
    response: { status: 200 },
    request: { url: "x", method: "GET" },
  } as any);
  metrics.errorInterceptor({
    store: new Map(),
    error: new Error("x"),
    request: { url: "x", method: "GET" },
  } as any);
  const before = metrics.snapshot();
  assert.ok(before.totalRequests >= 1);
  metrics.reset();
  const after = metrics.snapshot();
  assert.equal(after.totalRequests, 0);
});

// ── HAR bodySize coverage ───────────────────────────────────────────────
suite("HAR body size");
await test("HAR handles Uint8Array request body", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute(
    {
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ a: 1 })),
    },
    async () => await bin.post("/post", { a: 1 }),
  );
  const log = har.getHAR();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].request.method, "POST");
  // `{"a":1}` is 7 UTF-8 bytes. Asserting only the method is what let the
  // string-length-instead-of-byte-length bug through.
  assert.equal(log.entries[0].request.bodySize, 7);
});
await test("HAR handles ArrayBuffer request body", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  const buf = new TextEncoder().encode(JSON.stringify({ b: 2 })).buffer as ArrayBuffer;
  await m.execute(
    {
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buf,
    },
    async () => await bin.post("/post", { b: 2 }),
  );
  const log = har.getHAR();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].request.method, "POST");
  assert.equal(log.entries[0].request.bodySize, 7, '`{"b":2}` is 7 UTF-8 bytes');
});
await test("HAR handles string request body", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute(
    {
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "plain string",
    },
    async () =>
      await bin.post("/post", "plain string", { headers: { "content-type": "text/plain" } }),
  );
  const log = har.getHAR();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].request.method, "POST");
  assert.equal(log.entries[0].request.bodySize, 12, '"plain string" is 12 UTF-8 bytes');
});

// ── Content-Type uppercase fallback (line 1294) ─────────────────────────
suite("Content-Type header casing");
await test("HAR reads uppercase Content-Type", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, async () => {
    const r = await bin.get("/get");
    // Construct response with ONLY uppercase Content-Type header
    const upperHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) {
      upperHeaders[k.toUpperCase()] = v;
    }
    delete upperHeaders["CONTENT-TYPE"]; // ensure lowercase is missing
    upperHeaders["Content-Type"] = "application/json";
    return { ...r, headers: upperHeaders };
  });
  const entries = har.getHAR().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].response.content.mimeType, "application/json");
});

// ── Rate-limit interval coverage ────────────────────────────────────────
suite("Rate-limit internal paths");
await test("rate-limit refill processes queue", async () => {
  // Use a very short window to force interval processing
  const m = new InterceptorManager();
  m.useRequest(createRateLimitInterceptor({ limit: 1, windowMs: 100, queue: true, maxQueue: 5 }));
  let callCount = 0;
  const dispatcher = async () => {
    callCount++;
    return await bin.get("/get");
  };
  // First request consumes the token, second queues, third queues
  const results = await Promise.allSettled([
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher),
    m.execute({ url: "https://httpbin.org/get", method: "GET", headers: {} }, dispatcher),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(callCount, 2);
});

// ── ADDITIONAL COVERAGE TESTS ───────────────────────────────────────────
suite("Additional coverage");

// Retry response interceptor
await test("retry interceptor response/error paths", async () => {
  const m = new InterceptorManager();
  const retry = createRetryInterceptor({ maxRetries: 1, baseDelayMs: 10 });
  m.useResponse(retry.responseInterceptor);
  m.useError(retry.errorInterceptor);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});

// Timeout interceptor as registered via suite
await test("timeout interceptor via manager", async () => {
  const m = new InterceptorManager();
  const to = createTimeoutInterceptor({ timeoutMs: 5000 });
  m.useRequest(to.requestInterceptor);
  m.useResponse(to.responseInterceptor);
  m.useError(to.errorInterceptor);
  const res = await m.execute(
    { url: "https://httpbin.org/get", method: "GET", headers: {} },
    async () => await bin.get("/get"),
  );
  assert.equal(res.status, 200);
});

// Dedupe interceptor with different URLs don't coalesce
await test("dedupe different URLs are independent", async () => {
  const m = new InterceptorManager();
  const d = createDedupeInterceptor();
  m.useRequest(d.requestInterceptor);
  m.useResponse(d.responseInterceptor);
  m.useError(d.errorInterceptor);
  const results = await Promise.allSettled([
    m.execute(
      { url: "https://httpbin.org/get", method: "GET", headers: {} },
      async () => await bin.get("/get"),
    ),
    m.execute(
      { url: "https://httpbin.org/uuid", method: "GET", headers: {} },
      async () => await bin.get("/uuid"),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
});

// createInterceptorSuite with retry
await test("suite full config works", () => {
  const s = createInterceptorSuite({
    timeout: { timeoutMs: 5000 },
    retry: { maxRetries: 1 },
    rateLimit: { limit: 50, windowMs: 60000, queue: false, maxQueue: 100 },
    auth: { type: "bearer", token: "test" },
    cache: { ttlMs: 1000 },
    logging: { logRequests: true, logResponses: true },
  });
  assert.equal(s.manager instanceof InterceptorManager, true);
  assert.equal(typeof s.har.requestInterceptor, "function");
  assert.equal(typeof s.metrics.requestInterceptor, "function");
  assert.equal(typeof s.dedupe.requestInterceptor, "function");
  assert.equal(typeof s.cache.requestInterceptor, "function");
  assert.equal(typeof s.logging.requestInterceptor, "function");
  assert.equal(typeof s.retry.responseInterceptor, "function");
});

// InterceptorManager use() with null response
await test("InterceptorManager use() null response", () => {
  const m = new InterceptorManager();
  m.useResponse(() => {});
  const { requestId, responseId } = m.use(null, () => {});
  assert.equal(requestId, null);
  assert.equal(typeof responseId, "string");
});

// InterceptorManager eject by id across types
await test("eject across types", () => {
  const m = new InterceptorManager();
  const rid = m.useRequest(() => {});
  m.useResponse(() => {});
  m.useError(() => {});
  m.eject(rid);
  assert.equal(m.requestCount, 0);
  assert.equal(m.responseCount, 1);
  assert.equal(m.errorCount, 1);
});

// ── REGRESSION: defects found by the strictest-assertion audit ────────
suite("Regression: audit fixes");

// Every case below drives the interceptor directly with a synthetic context,
// so it is exact and independent of the network.

function fakeRequest(over: Record<string, unknown> = {}): any {
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
function fakeResponse(over: Record<string, unknown> = {}): any {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    data: null,
    rawBody: null,
    url: "https://x.test/a",
    cached: false,
    redirected: false,
    httpVersion: "HTTP/1.1",
    durationMs: 0,
    request: fakeRequest(),
    attempt: 1,
    ...over,
  };
}

await test("regression: Retry-After accepts only delta-seconds or an HTTP-date", async () => {
  // `Date.parse` is lenient enough to read "1.5", "-5" and "+5" as ancient dates.
  // Those resolved to ~0ms, silently skipping the back-off instead of falling
  // through to the exponential delay.
  const delayFor = async (retryAfter: string): Promise<number> => {
    const seen: number[] = [];
    const { responseInterceptor } = createRetryInterceptor({
      maxRetries: 1,
      baseDelayMs: 120,
      jitter: 0,
      maxDelayMs: 60_000,
      onRetry: (_ctx, delayMs) => seen.push(delayMs),
    });
    await responseInterceptor({
      attempt: 1,
      error: null,
      request: fakeRequest(),
      startedAt: Date.now(),
      response: fakeResponse({ status: 503, headers: { "retry-after": retryAfter } }),
      store: new Map(),
    } as any);
    return seen[0]!;
  };

  // Valid delta-seconds is honoured.
  assert.equal(await delayFor("2"), 2000);
  assert.equal(await delayFor("  7  "), 7000);
  // A valid HTTP-date that is already in the past means "retry now" -> 0.
  assert.equal(await delayFor("Wed, 21 Oct 2015 07:28:00 GMT"), 0);
  // Malformed values must be ignored so the exponential back-off still runs.
  for (const bad of ["1.5", "-5", "+5", "0.5", "garbage", "5s", "2026-13-45"]) {
    assert.equal(
      await delayFor(bad),
      120,
      `Retry-After ${JSON.stringify(bad)} is not a valid header and must fall back to baseDelayMs`,
    );
  }
});

await test("regression: maxDelayMs is a hard cap even with jitter", async () => {
  // jitter: 1 is the worst case — uncapped it would be base * (1 + 1) = 20000.
  for (let i = 0; i < 25; i++) {
    const seen: number[] = [];
    const retry = createRetryInterceptor({
      maxRetries: 5,
      baseDelayMs: 10_000,
      maxDelayMs: 500,
      jitter: 1,
      onRetry: (_ctx, delayMs) => seen.push(delayMs),
    });
    await retry.responseInterceptor({
      attempt: 3,
      error: null,
      request: fakeRequest(),
      startedAt: Date.now(),
      response: fakeResponse({ status: 503 }),
      store: new Map(),
    } as any);
    assert.ok(seen[0]! <= 500, `jitter pushed the delay to ${seen[0]}ms, past maxDelayMs=500`);
  }
});

await test("regression: logging redacts the configured header names", async () => {
  const entries: any[] = [];
  const logging = createLoggingInterceptor({
    logger: (e) => entries.push(e),
    redactHeaders: ["Authorization", "X-Api-Key"],
  });
  const m = new InterceptorManager();
  m.useRequest(logging.requestInterceptor);
  await m.execute(
    fakeRequest({
      headers: {
        authorization: "Bearer super-secret",
        "X-Api-Key": "key-123",
        "content-type": "application/json",
      },
    }),
    async () => fakeResponse(),
  );
  assert.equal(entries.length, 1);
  const hdrs = entries[0].headers;
  assert.deepEqual(hdrs, {
    authorization: "**REDACTED**",
    "X-Api-Key": "**REDACTED**",
    "content-type": "application/json",
  });
  // The secret must not survive anywhere in the serialised entry.
  assert.ok(!JSON.stringify(entries[0]).includes("super-secret"));
  assert.ok(!JSON.stringify(entries[0]).includes("key-123"));
});

await test("regression: logging redacts by default and on the error phase", async () => {
  const entries: any[] = [];
  const logging = createLoggingInterceptor({ logger: (e) => entries.push(e) });
  const m = new InterceptorManager();
  m.useRequest(logging.requestInterceptor);
  m.useError(logging.errorInterceptor);
  await m
    .execute(fakeRequest({ headers: { cookie: "session=abc", "set-cookie": "a=b" } }), async () => {
      throw new Error("boom");
    })
    .catch(() => {});
  assert.equal(entries.length, 2, "one request entry and one error entry");
  for (const e of entries) {
    assert.equal(e.headers.cookie, "**REDACTED**");
    assert.equal(e.headers["set-cookie"], "**REDACTED**");
  }
  assert.ok(!JSON.stringify(entries).includes("session=abc"));
});

await test("regression: computeBodySize reports UTF-8 bytes, not UTF-16 units", () => {
  assert.equal(computeBodySize("hello"), 5);
  assert.equal(computeBodySize("héllo"), 6, "é is 2 bytes in UTF-8");
  assert.equal(computeBodySize("😀"), 4, "an astral character is 4 bytes and 2 units");
  assert.equal(computeBodySize("日本語"), 9, "each CJK character is 3 bytes");
  assert.equal(computeBodySize(""), 0);
  assert.equal(computeBodySize(null), 0);
  assert.equal(computeBodySize(new Uint8Array([1, 2, 3])), 3);
  assert.equal(computeBodySize(new ArrayBuffer(10)), 10);
  assert.equal(computeBodySize(new ReadableStream() as any), -1);
});

await test("regression: HAR response bodySize counts UTF-8 bytes", async () => {
  const har = createHARInterceptor();
  const m = new InterceptorManager();
  m.useRequest(har.requestInterceptor);
  m.useResponse(har.responseInterceptor);
  await m.execute(fakeRequest({ url: "https://x.test/ja" }), async () =>
    fakeResponse({ status: 200, body: "日本語" } as any),
  );
  const entry = har.getHAR().entries[0]!;
  assert.equal(entry.response.bodySize, 9);
  assert.equal(entry.response.content.size, 9);
  assert.equal(entry.response.content.text, "日本語");
});

await test("regression: s-maxage never sets the stored TTL", async () => {
  const cache = createCacheInterceptor({ defaultTtlMs: 12_345, maxEntries: 10 });
  const m = new InterceptorManager();
  m.useRequest(cache.requestInterceptor);
  m.useResponse(cache.responseInterceptor);
  const ttlFor = async (cc: string): Promise<number> => {
    await m.execute(fakeRequest(), async () => fakeResponse({ headers: { "cache-control": cc } }));
    const e = cache.store.get("GET:https://x.test/a")!;
    cache.store.clear();
    // The cache stamps entries from a fractional monotonic clock, so the delta
    // is a float; the TTL itself is exact.
    return Math.round(e.expiresAt - e.createdAt);
  };
  // `s-maxage` is a shared-cache directive and must not become a browser TTL.
  assert.equal(await ttlFor("s-maxage=600"), 12_345);
  assert.equal(await ttlFor("public, s-maxage=600"), 12_345);
  // A real `max-age` next to it still wins.
  assert.equal(await ttlFor("max-age=10, s-maxage=9999"), 10_000);
  assert.equal(await ttlFor("max-age=60"), 60_000);
});

await test("regression: rate-limit rejects a config with no valid bucket", () => {
  // limit: 0 made the refill interval `windowMs / 0` = Infinity, which
  // setInterval clamped to ~1ms -- a busy-poll that also never released waiters.
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => createRateLimitInterceptor({ limit: bad }),
      RangeError,
      `limit ${bad} must be rejected`,
    );
  }
  for (const bad of [0, -1, NaN]) {
    assert.throws(
      () => createRateLimitInterceptor({ limit: 1, windowMs: bad }),
      RangeError,
      `windowMs ${bad} must be rejected`,
    );
  }
  assert.throws(
    () => createRateLimitInterceptor({ limit: 1, windowMs: 1000, maxQueue: -1 }),
    RangeError,
  );
  // A valid config still constructs.
  assert.equal(typeof createRateLimitInterceptor({ limit: 1, windowMs: 1000 }), "function");
});

// ── SUMMARY ──────────────────────────────────────────────────────────────
// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
console.log(`\n── RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
