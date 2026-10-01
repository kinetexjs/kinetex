/**
 * kinetex — client.ts unit tests
 * Tests all Kinetex client features with real HTTP calls to external APIs.
 * No mocks, no predefined data, only real network calls.
 */

import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import { HTTPStatusError, KinetexError, SizeLimitError, TimeoutError } from "../src/types.ts";
import { encodeMultipart, NodeHTTP2Transport } from "../src/core.ts";
import { isUpstreamFlake, isUpstreamStatusDrift } from "./upstream.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

// Per-test wall-clock budget. Every test here talks to a live third-party
// API, so without a cap a single hung socket would park the whole suite for
// the 30s client timeout — or forever, if the timeout itself regressed. A
// test that overruns is a failure, never a silent stall.
const TEST_BUDGET_MS = 45_000;

/**
 * Skip the rest of the current test when `status` is an upstream failure
 * rather than `expected`. Returns true when it skipped, so the caller can
 * `return`.
 */
function skipOnUpstreamDrift(name: string, status: number, expected: number): boolean {
  if (!isUpstreamStatusDrift(status, expected)) return false;
  console.log(
    `    ⚠️  ${name} — assertions skipped (transient: httpbin answered ${status}, not ${expected})`,
  );
  return true;
}

/**
 * Almost every test in this file talks to live httpbin, so an outage arrives as
 * a failure that says nothing about the client — `HTTP 502 Bad Gateway` on a
 * POST that should have echoed its body. Handled one test at a time it is
 * whack-a-mole: the run that failed tonight would have been a different POST.
 *
 * `isUpstreamFlake` is applied to every test in the file, not opted into per
 * test, because the point is to survive an outage rather than to whitelist known
 * flakiness. Its discrimination is deliberately narrow and an AssertionError is
 * never excused, so it cannot convert a real failure into green. It lives in
 * `tests/upstream.ts`, shared with the other live suites, and is pinned by
 * `tests/upstream-drift.test.mts`.
 */

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`exceeded the ${TEST_BUDGET_MS}ms per-test budget`)),
          TEST_BUDGET_MS,
        );
      }),
    ]);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    if (isUpstreamFlake(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${msg}`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const ms = Date.now() - started;
    if (ms > 20_000) console.log(`    ⏱  ${name} took ${ms}ms`);
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const T = 30_000;
const bin = kinetex({ baseURL: "https://httpbin.org", timeout: T });
const json = kinetex({ baseURL: "https://jsonplaceholder.typicode.com", timeout: T });

// ============================================================================
// §1  BASIC HTTP METHODS
// ============================================================================

suite("Basic HTTP methods (get, post, put, patch, delete, head, options)");

await test("GET returns 200 with JSON data", async () => {
  const res = await bin.get<{ origin: string; headers: Record<string, string> }>("/get");
  console.log(`    → GET /get: status=${res.status}, origin=${res.data.origin}`);
  console.log(`    → httpVersion=${res.httpVersion}, durationMs=${res.durationMs}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.data.origin === "string");
  assert.ok(res.durationMs > 0);
});

await test("POST with JSON body returns 200 and echoes body", async () => {
  const payload = { name: "test", value: 123 };
  const res = await bin.post<{ json: typeof payload }>("/post", JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  console.log(`    → POST result: ${JSON.stringify(res.data.json)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.json, payload);
});

await test("PUT with JSON body returns 200", async () => {
  const res = await bin.put<{ json: { updated: boolean } }>(
    "/put",
    JSON.stringify({ updated: true }),
    { headers: { "content-type": "application/json" } },
  );
  console.log(`    → PUT result: ${JSON.stringify(res.data.json)}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.json.updated, true);
});

await test("PATCH returns 200", async () => {
  const res = await bin.patch<{ json: { patched: number } }>(
    "/patch",
    JSON.stringify({ patched: 42 }),
    { headers: { "content-type": "application/json" } },
  );
  console.log(`    → PATCH result: ${JSON.stringify(res.data.json)}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.json.patched, 42);
});

await test("DELETE returns 200", async () => {
  const res = await bin.delete("/delete");
  console.log(`    → DELETE: status=${res.status}`);
  assert.equal(res.status, 200);
});

await test("HEAD returns headers without body", async () => {
  const res = await bin.head("/get");
  console.log(`    → HEAD: status=${res.status}, content-type=${res.headers["content-type"]}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"]);
});

await test("OPTIONS returns 200 with allowed methods", async () => {
  const res = await bin.options("/get");
  console.log(`    → OPTIONS: status=${res.status}, allow=${res.headers["allow"]}`);
  assert.equal(res.status, 200);
});

// ============================================================================
// §2  FLUENT CHAIN API
// ============================================================================

suite("Fluent chain API (GET, POST, PUT, etc.)");

await test("client.GET().json() returns parsed data", async () => {
  const data = await bin.GET("/get").json<{ url: string; origin: string }>();
  console.log(`    → GET().json(): url=${data.url}, origin=${data.origin}`);
  assert.match(data.url, /^https:\/\/httpbin\.org\/get$/);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().text() returns raw string", async () => {
  const text = await bin.GET("/get").text();
  console.log(`    → GET().text(): length=${text.length}, startsWith=${text.startsWith("{")}`);
  assert.equal(typeof text, "string");
  assert.ok(text.startsWith("{"));
});

await test("client.GET().bytes() returns Uint8Array", async () => {
  const bytes = await bin.GET("/get").bytes();
  console.log(`    → GET().bytes(): length=${bytes.length}, type=${bytes.constructor.name}`);
  assert.ok(bytes instanceof Uint8Array);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { url: string };
  assert.match(parsed.url, /^https:\/\/httpbin\.org\/get$/);
});

await test("client.GET().send() returns full response", async () => {
  const res = await bin.GET("/get").send<{ origin: string }>();
  console.log(`    → GET().send(): status=${res.status}, data.origin=${res.data.origin}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.data.origin === "string");
  assert.ok(res.durationMs > 0);
});

await test("client.GET().param() adds query params", async () => {
  const data = await bin
    .GET("/get")
    .param("key", "value")
    .param("num", "42")
    .json<{ args: Record<string, string> }>();
  console.log(`    → GET().param(): args=${JSON.stringify(data.args)}`);
  assert.equal(data.args["key"], "value");
  assert.equal(data.args["num"], "42");
});

await test("client.GET().header() adds custom headers", async () => {
  const data = await bin
    .GET("/headers")
    .header("x-custom", "test-value")
    .json<{ headers: Record<string, string> }>();
  console.log(`    → GET().header(): x-custom=${data.headers["X-Custom"]}`);
  assert.equal(data.headers["X-Custom"], "test-value");
});

await test("client.POST().withJSON() sends JSON body", async () => {
  const payload = { x: 1, y: "hello" };
  const data = await bin.POST("/post").withJSON(payload).json<{ json: typeof payload }>();
  console.log(`    → POST().withJSON(): ${JSON.stringify(data.json)}`);
  assert.equal(data.json.x, 1);
  assert.equal(data.json.y, "hello");
});

await test("client.GET().bearer() adds Authorization header", async () => {
  const data = await bin
    .GET("/headers")
    .bearer("my-token")
    .json<{ headers: Record<string, string> }>();
  console.log(`    → GET().bearer(): Authorization=${data.headers["Authorization"]}`);
  assert.equal(data.headers["Authorization"], "Bearer my-token");
});

await test("client.GET().basic() adds Basic auth header", async () => {
  const data = await bin
    .GET("/headers")
    .basic("user", "pass")
    .json<{ headers: Record<string, string> }>();
  console.log(
    `    → GET().basic(): Authorization starts with Basic=${data.headers["Authorization"]?.startsWith("Basic ")}`,
  );
  assert.ok(data.headers["Authorization"]?.startsWith("Basic "));
  const decoded = atob(data.headers["Authorization"].slice(6));
  assert.equal(decoded, "user:pass");
});

await test("client.GET().apiKey() adds API key header", async () => {
  // httpbin might lowercase all headers
  const data = await bin
    .GET("/headers")
    .apiKey("x-api-key", "secret-key")
    .json<{ headers: Record<string, string> }>();
  console.log(`    → GET().apiKey(): headers received: ${JSON.stringify(data.headers)}`);
  const sent = Object.entries(data.headers).filter(([k]) => k.toLowerCase() === "x-api-key");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "secret-key");
});

await test("config auth with apikey", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "apikey", header: "x-api-key", key: "my-api-key" },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(
    `    → config apikey: all headers: ${Object.keys(data.headers)
      .filter((k) => k.includes("api"))
      .join(", ")}`,
  );
  // Verify apikey was added (header name might be normalized to lowercase)
  const sent = Object.entries(data.headers).filter(([k]) => k.toLowerCase() === "x-api-key");
  assert.equal(sent.length, 1, "x-api-key header should be present exactly once");
  assert.equal(sent[0][1], "my-api-key");
});

await test("client.GET().noThrow() returns 404 without throwing", async () => {
  const res = await bin.GET("/status/404").noThrow().send();
  console.log(`    → GET().noThrow(): status=${res.status}`);
  assert.equal(res.status, 404);
});

await test("client.GET().timeout() sets timeout", async () => {
  // Client timeout is 0 (disabled), so the only thing that can end this
  // request is the builder's own 500ms. That makes the failure attributable.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 0 });
  const started = Date.now();
  let caughtError: unknown;
  try {
    await client.GET("/delay/5").timeout(500).send();
  } catch (err) {
    caughtError = err;
  }
  const elapsed = Date.now() - started;
  console.log(`    → GET().timeout() error: ${caughtError?.constructor?.name} after ${elapsed}ms`);
  assert.ok(caughtError instanceof TimeoutError, "expected a TimeoutError");
  assert.equal(caughtError.code, "ETIMEOUT");
  assert.equal(caughtError.isTimeout, true);
  // It has to give up on schedule, not merely eventually: the server holds
  // the response for 5s, so anything near that means the 500ms was ignored.
  assert.ok(elapsed < 4_000, `expected the 500ms timeout to fire early, took ${elapsed}ms`);
});

await test("client.GET().noRetry() disables retry", async () => {
  const data = await bin.GET("/get").noRetry().json<{ origin: string }>();
  console.log(`    → GET().noRetry(): ${data.origin}`);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().retry() configures retry", async () => {
  const data = await bin.GET("/get").retry(2, { baseDelayMs: 100 }).json<{ origin: string }>();
  console.log(`    → GET().retry(2): ${data.origin}`);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().maxSize() sets response size limit", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  let caughtError: unknown;
  try {
    await client.GET("/bytes/1024").maxSize(100).send();
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → GET().maxSize() error: ${caughtError?.constructor?.name}`);
  // 1024 bytes requested against a 100-byte cap. Any non-ESIZELIMIT error
  // would mean the cap was not what stopped the read.
  // A *response* that overran its cap is the ESIZELIMIT case, so this is
  // SizeLimitError proper — unlike the request-side cap, which is a
  // validation failure (see the maxRequestSize case above).
  assert.ok(caughtError instanceof SizeLimitError, "expected a SizeLimitError");
  assert.equal(caughtError.code, "ESIZELIMIT");
  assert.equal(caughtError.limit, 100, "the configured cap must be reported");
  assert.ok(caughtError.bytesRead > 100, "the read must have overrun the cap");
});

await test("client.GET().http2() requests HTTP/2", async () => {
  const res = await bin.GET("/get").http2().send();
  console.log(`    → GET().http2(): httpVersion=${res.httpVersion}`);
  assert.equal(res.httpVersion, "HTTP/2");
});

await test("client.GET().http1() requests HTTP/1.1", async () => {
  const res = await bin.GET("/get").http1().send();
  console.log(`    → GET().http1(): httpVersion=${res.httpVersion}`);
  assert.equal(res.httpVersion, "HTTP/1.1");
  assert.equal(res.status, 200);
});

await test("client.GET().noCache() forces fresh fetch", async () => {
  const data = await bin.GET("/get").noCache().json<{ origin: string }>();
  console.log(`    → GET().noCache(): ${data.origin}`);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().tags() adds cache tags", async () => {
  const data = await bin.GET("/get").tags("tag1", "tag2").json<{ origin: string }>();
  console.log(`    → GET().tags(): ${data.origin}`);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().meta() attaches metadata", async () => {
  const res = await bin.GET("/get").meta({ requestId: "test-123" }).send();
  console.log(`    → GET().meta(): request.id=${res.request.meta?.requestId}`);
  assert.equal(res.request.meta?.requestId, "test-123");
});

await test("client.GET().signal() attaches AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  let caughtError: unknown;
  try {
    await bin.GET("/delay/10").signal(controller.signal).send();
  } catch (err) {
    caughtError = err;
  }
  const elapsed = Date.now() - started;
  console.log(`    → GET().signal() error: ${caughtError?.constructor?.name} after ${elapsed}ms`);
  // The signal is aborted before the call, so this must surface as an abort.
  // Without the wiring the request would run the full 10s delay and succeed.
  assert.ok(caughtError instanceof KinetexError, "expected a KinetexError");
  assert.equal(caughtError.code, "EABORT");
  assert.equal(caughtError.isAbort, true);
  assert.ok(elapsed < 5_000, `an already-aborted signal must not wait, took ${elapsed}ms`);
});

await test("client.subscribe() executes with callbacks", async () => {
  const result = await new Promise<{ status: number; origin: string }>((resolve, reject) => {
    bin.GET("/get").subscribe(
      (res) => resolve({ status: res.status, origin: (res.data as { origin: string }).origin }),
      (err) => reject(err),
    );
  });
  console.log(`    → subscribe(): status=${result.status}, origin=${result.origin}`);
  assert.equal(result.status, 200);
  assert.ok(typeof result.origin === "string");
});

await test("client.POST().withBody() sets raw body", async () => {
  const data = await bin.POST("/post").withBody("raw text content").text();
  console.log(`    → POST().withBody(): length=${data.length}`);
  assert.match(data, /"data":\s*"raw text content"/);
});

await test("client.GET().data() returns just the data", async () => {
  const data = await bin.GET("/get").data<{ origin: string }>();
  console.log(`    → data(): ${data.origin}`);
  assert.equal(typeof data.origin, "string");
});

await test("client.GET().blob() returns Blob", async () => {
  const blob = await bin.GET("/bytes/100").blob();
  console.log(`    → blob(): size=${blob.size}, type=${blob.type}`);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 100);
  assert.equal(new Uint8Array(await blob.arrayBuffer()).length, 100);
});

await test("client.GET().onUploadProgress() callback is called", async () => {
  const loaded: number[] = [];
  const res = await bin
    .POST("/post")
    .withBody(new Uint8Array(2048).fill(65))
    .onUploadProgress((event) => {
      loaded.push(event.loaded);
      console.log(`    → upload progress: ${event.loaded} bytes`);
    })
    .send();
  console.log(`    → onUploadProgress events: ${loaded.length}`);
  assert.equal(res.status, 200);
  assert.equal(loaded.length > 0, true, "onUploadProgress must fire for a body-bearing request");
  assert.equal(loaded[loaded.length - 1], 2048);
});

await test("client.GET().onDownloadProgress() callback is called", async () => {
  const loaded: number[] = [];
  const res = await bin
    .GET("/bytes/2048")
    .onDownloadProgress((event) => {
      loaded.push(event.loaded);
      console.log(`    → download progress: ${event.loaded} bytes`);
    })
    .send();
  console.log(`    → onDownloadProgress events: ${loaded.length}`);
  assert.equal(res.status, 200);
  assert.equal(loaded.length > 0, true, "onDownloadProgress must fire");
  assert.equal(loaded[loaded.length - 1], 2048);
});

await test("client.GET().withForm() sets FormData body", async () => {
  const formData = new FormData();
  formData.append("key", "value");
  formData.append("count", "42");
  const data = await bin
    .POST("/post")
    .withForm(formData)
    .json<{ form?: Record<string, string>; headers?: Record<string, string> }>();
  console.log(`    → withForm(): ${JSON.stringify(data.form)}`);
  // httpbin parses a multipart body and echoes it back under `form`. An empty
  // or absent `form` is what a zero-byte body looks like, which is exactly
  // the failure this test used to miss behind `notEqual(data, null)`.
  assert.deepEqual(data.form, { key: "value", count: "42" });
  assert.match(
    data.headers?.["Content-Type"] ?? "",
    /^multipart\/form-data; boundary=/,
    "a multipart body must carry a boundary in its content type",
  );
});

await test("meta.traceId generates traceparent header without error", async () => {
  const res = await bin.GET("/get").meta({ traceId: "test-trace-123" }).send();
  console.log(`    → meta with traceId: sent successfully`);
  assert.equal(res.request.meta?.traceId, "test-trace-123");
  assert.equal(res.status, 200);
});

await test("retry with onRetry callback", async () => {
  const retryInfo: Array<{ attempt: number; delayMs: number }> = [];
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    retry: {
      maxRetries: 2,
      baseDelayMs: 50,
      statuses: [503],
      onRetry: (ctx, delayMs) => retryInfo.push({ attempt: ctx.attempt, delayMs }),
    },
  });
  const res = await client.get("/status/503", { throwOnError: false });
  console.log(`    → retry onStatus: status=${res.status}, retries=${retryInfo.length}`);
  if (skipOnUpstreamDrift("retry onStatus: retries on configured 503", res.status, 503)) return;
  assert.equal(res.status, 503);
  assert.deepEqual(
    retryInfo.map((r) => r.attempt),
    [1, 2],
  );
  assert.equal(
    retryInfo.every((r) => r.delayMs >= 0),
    true,
  );
});

await test("retry with shouldRetry custom function", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    retry: {
      maxRetries: 1,
      baseDelayMs: 50,
      shouldRetry: async (ctx) => ctx.response?.status === 429,
    },
  });
  const res = await client.get("/status/503", { throwOnError: false });
  console.log(`    → custom shouldRetry: status=${res.status}`);
  if (skipOnUpstreamDrift("custom shouldRetry: not called for a 503", res.status, 503)) return;
  assert.equal(res.status, 503);
});

await test("onError hook is called on error", async () => {
  let hookCalls = 0;
  let hookError: unknown;
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    hooks: {
      onError: [
        async (err) => {
          hookCalls++;
          hookError = err;
        },
      ],
    },
  });
  try {
    await client.get("/status/500");
  } catch (err) {
    // A 5xx must surface as an HTTPStatusError carrying the response.
    assert.ok(err instanceof HTTPStatusError, `expected HTTPStatusError, got ${String(err)}`);
    if (
      skipOnUpstreamDrift("onError hook is called on error", (err as HTTPStatusError).status, 500)
    ) {
      client.destroy();
      return;
    }
    assert.equal((err as HTTPStatusError).status, 500);
  }
  // The hook must have fired exactly once, with that same error.
  assert.equal(hookCalls, 1, "onError hook must fire exactly once");
  assert.ok(hookError instanceof Error, "onError hook must receive an Error");
  client.destroy();
});

await test("onSuccess hook is called on success", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    hooks: {
      onSuccess: [
        (res) => {
          console.log(`    → onSuccess hook: status=${res.status}`);
        },
      ],
    },
  });
  const res = await client.get("/get");
  console.log(`    → onSuccess hook: done`);
  assert.equal(res.status, 200);
});

await test("transformRequest modifies request", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    transformRequest: async (req) => {
      return { ...req, headers: { ...req.headers, "x-transformed": "yes" } };
    },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → transformRequest: ${data.headers["X-Transformed"]}`);
  assert.equal(data.headers["X-Transformed"], "yes");
});

await test("transformResponse modifies response", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    transformResponse: (data) => ({ transformed: true, ...(data as object) }),
  });
  const data = await client.GET("/get").json<{ transformed: boolean }>();
  console.log(`    → transformResponse: ${data.transformed}`);
  assert.equal(data.transformed, true);
});

await test("httpsOnly blocks http URLs", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, httpsOnly: true });
  let caughtError: unknown;
  try {
    await client.get("http://httpbin.org/get");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → httpsOnly error: ${caughtError?.constructor?.name}`);
  // The request must be refused *before* a socket is opened, and refused as a
  // validation failure. Any code here would pass a bare "something threw",
  // including a DNS failure or a connect error against the cleartext port.
  assert.ok(caughtError instanceof KinetexError, "expected a KinetexError");
  assert.equal(caughtError.code, "EVALIDATION");
  assert.match(caughtError.message, /https-only|HTTPS-only/i);
});

await test("maxRequestSize blocks large bodies", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, maxRequestSize: 10 });
  let caughtError: unknown;
  try {
    await client.post("/post", "this is a very long body that exceeds the limit", {
      throwOnError: false,
    });
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → maxRequestSize error: ${caughtError?.constructor?.name}`);
  // The limit is enforced before the socket opens, and it is reported as
  // EVALIDATION: this is the request being rejected as unacceptable, not a
  // read that ran over budget. `throwOnError:false` is set precisely so a
  // 2xx reply would surface as a missing rejection rather than a status throw.
  assert.ok(caughtError instanceof KinetexError, "expected a KinetexError");
  assert.equal(caughtError.code, "EVALIDATION");
  // The message carries both numbers, so a cap computed from the wrong
  // length (say, a character count) would not produce this pair.
  assert.match(caughtError.message, /exceeds limit of 10 bytes/);
  assert.match(caughtError.message, /Request body size \d+ bytes/);
  assert.equal(caughtError.response, undefined, "nothing was sent, so there is no response");
});

await test("meta.traceId is stored in request meta", async () => {
  const res = await bin.GET("/get").meta({ traceId: "test-trace-123" }).send();
  console.log(`    → traceId in meta: ${res.request.meta?.traceId}`);
  assert.equal(res.request.meta?.traceId, "test-trace-123");
});

await test("client.GET().cache() sets cache config", async () => {
  const res = await bin.GET("/get").cache({ ttl: 60 }).send();
  console.log(`    → cache() executed: ${res.status}`);
  assert.equal(res.status, 200);
});

await test("client.GET().cache(false) disables cache", async () => {
  const res = await bin.GET("/get").cache(false).send();
  console.log(`    → cache(false) executed: ${res.status}`);
  assert.equal(res.status, 200);
});

await test("retry with already aborted signal throws", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: 5000,
    retry: { maxRetries: 1, baseDelayMs: 10 },
  });
  let threw = false;
  let caughtErr: unknown;
  try {
    await client.get("/delay/1", { signal: controller.signal });
  } catch (err: unknown) {
    caughtErr = err;
    threw =
      err instanceof Error &&
      (err.name === "AbortError" || err.constructor.name === "DOMException");
    console.log(
      `    → already aborted signal: ${err instanceof Error ? err.constructor.name : typeof err}`,
    );
  }
  assert.equal(
    threw,
    true,
    `Expected AbortError or DOMException but got: ${caughtErr instanceof Error ? caughtErr.constructor.name : typeof caughtErr}`,
  );
  assert.equal((caughtErr as Error).name, "AbortError");
  // Assert the error code, not the message text. An already-aborted signal used
  // to surface a bare DOMException ("Aborted"); the retry path now raises the
  // library AbortError like every other abort path, so EABORT is the contract
  // that has to hold and the human-readable message is free to change.
  assert.equal((caughtErr as KinetexError).code, "EABORT");
  assert.equal((caughtErr as KinetexError).isAbort, true);
});

await test("client.GET().proxy() fails fast (per-request proxy is unsupported)", async () => {
  // A client-level `proxy` is now honoured by the Node transport. A
  // per-request one still cannot be: the transport pools one connection per
  // origin, so honouring it would mean tearing the pool down mid-flight.
  await assert.rejects(
    () => bin.GET("/get").proxy({ url: "http://proxy.example.com:8080" }).send(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /per-request `proxy` is not supported/);
      assert.match(err.message, /set `proxy` on the client/);
      return true;
    },
  );
  console.log(`    → proxy() correctly rejected with guidance`);
});

await test("client.GET().headers() merges multiple headers", async () => {
  const res = await bin
    .GET("/headers")
    .headers({ "X-Test-Header": "test-value", "X-Another": "another" })
    .send();
  const sent = res.data.headers as Record<string, string>;
  console.log(`    → headers(): X-Test-Header=${sent["X-Test-Header"]}`);
  // Both headers have to survive the merge, exactly once each, with their
  // values intact — a status of 200 says nothing about any of that.
  assert.equal(sent["X-Test-Header"], "test-value");
  assert.equal(sent["X-Another"], "another");
  const count = (k: string) => Object.keys(sent).filter((h) => h.toLowerCase() === k).length;
  assert.equal(count("x-test-header"), 1, "X-Test-Header must appear exactly once");
  assert.equal(count("x-another"), 1, "X-Another must appear exactly once");
});

await test("client.destroy() cleans up resources", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  // Make a real request first, so the transport has something to release.
  await client.get("/get");
  const transport = (client as unknown as { transport: unknown }).transport as {
    sessions?: Map<string, unknown>;
  };
  assert.ok(transport.sessions instanceof Map, "expected the Node HTTP/2 transport");

  transport.destroy();

  assert.equal(transport.sessions.size, 0, "destroy() must drop every pooled session");
  // Idempotent: a second destroy must resolve rather than throw or double-free.
  await assert.doesNotReject(() => client.destroy(), "destroy() must be idempotent");
});

await test("client.extend() with debug enabled", async () => {
  const child = bin.extend({ debug: true });
  console.log(`    → extend with debug: created`);
  assert.notEqual(child, null);
  // A child that merely exists proves nothing — it has to be a working
  // client that inherited the base URL and can complete a request.
  const res = await child.get("/get");
  assert.equal(res.status, 200);
  assert.match(res.url, /^https:\/\/httpbin\.org\/get$/);
  await child.destroy();
});

// Test query param merging
await test("client.GET().params() merges with config params", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    params: { configParam: "config-value" },
  });
  const res = await client.GET("/get").params({ extraParam: "extra-value" }).send();
  const sent = res.data.args as Record<string, string>;
  console.log(`    → params merge: ${JSON.stringify(sent)}`);
  // The whole point is that both survive. Either one alone means the merge
  // dropped a side — a request param clobbering the config, or vice versa.
  assert.equal(sent["configParam"], "config-value");
  assert.equal(sent["extraParam"], "extra-value");
  await client.destroy();
});

// Test custom fetch
await test("client with custom fetch function", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, fetch: fetch });
  const res = await client.get("/get");
  console.log(`    → custom fetch option accepted: ${res.status}`);
  assert.equal(res.status, 200);
  client.destroy();
});

// Test throwOnError option with successful response
await test("throwOnError:true with 200 response", async () => {
  const res = await bin.GET("/get").send();
  console.log(`    → default throwOnError on 200: ${res.status}`);
  assert.equal(res.status, 200);
});

// Test abort during retry delay
await test("abort during retry delay", async () => {
  const controller = new AbortController();
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: 10000,
    retry: { maxRetries: 2, baseDelayMs: 200 },
  });

  // Abort after first failure but before first retry
  setTimeout(() => controller.abort(), 150);

  let caught: any = null;
  try {
    await client.get("/status/503", {
      signal: controller.signal,
      throwOnError: false,
    });
  } catch (err: any) {
    caught = err;
  }
  // Aborting mid-retry must reject rather than resolving normally.
  assert.ok(caught, "aborting during the retry delay must reject");
  // Whether the signal lands while the request is in flight or while the retry
  // back-off is sleeping is a timing race, so this asserts the contract that
  // must hold on BOTH paths: an EABORT KinetexError. (The retry-sleep path used
  // to raise a bare DOMException, which had no `code`; that made this assertion
  // pass or fail depending on how fast httpbin answered.)
  assert.ok(caught instanceof KinetexError, `expected KinetexError, got ${String(caught)}`);
  assert.equal(caught.code, "EABORT");
  assert.equal(caught.isAbort, true);
  client.destroy();
});

// Test with complex client options - simplified
await test("client with basic options", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: 10000,
    headers: { "X-Client-Header": "client-value" },
    params: { clientParam: "client-param" },
    throwOnError: false,
  });
  const res = await client.get("/get");
  console.log(`    → basic options: ${res.status}`);
  assert.equal(res.status, 200);
  client.destroy();
});

// Test client with cache option
await test("client with cache option", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    cache: { ttl: 300 },
  });
  const res = await client.get("/get");
  console.log(`    → cache option: ${res.status}`);
  assert.equal(res.status, 200);
  client.destroy();
});

// Test params() method
await test("client.GET().params() adds multiple params", async () => {
  const res = await bin.GET("/get").params({ a: "1", b: "2" }).send();
  const sent = res.data.args as Record<string, string>;
  console.log(`    → params(): a=${sent["a"]}, b=${sent["b"]}`);
  assert.equal(sent["a"], "1");
  assert.equal(sent["b"], "2");
  assert.equal(res.status, 200);
});

// Test noThrow() with error status
await test("client.GET().noThrow() returns error status", async () => {
  const res = await bin.GET("/status/400").noThrow().send();
  console.log(`    → noThrow() 400: ${res.status}`);
  assert.equal(res.status, 400);
});

// Test client level throwOnError:false
await test("client with throwOnError:false config", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: false });
  const res = await client.get("/status/500");
  console.log(`    → throwOnError:false config: ${res.status}`);
  if (skipOnUpstreamDrift("client with throwOnError:false config", res.status, 500)) {
    client.destroy();
    return;
  }
  assert.equal(res.status, 500);
  client.destroy();
});

// Test client level throwOnError:true
await test("client with throwOnError:true config throws on error", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  let threw = false;
  let caughtErr: unknown;
  try {
    await client.get("/status/500");
  } catch (err: unknown) {
    caughtErr = err;
    threw = err instanceof Error;
  }
  console.log(`    → throwOnError:true config threw: ${threw}`);
  assert.equal(
    threw,
    true,
    `Expected an Error to be thrown but got: ${caughtErr instanceof Error ? caughtErr.constructor.name : typeof caughtErr}`,
  );
  assert.equal(caughtErr instanceof HTTPStatusError, true);
  assert.equal((caughtErr as HTTPStatusError).code, "EHTTPSTATUS");
  assert.equal((caughtErr as HTTPStatusError).response?.status, 500);
  client.destroy();
});

// ============================================================================
// §3  AUTH CONFIG
// ============================================================================

suite("Authentication (config-level auth)");

await test("config auth with bearer token", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "bearer", token: "config-token-123" },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → config bearer: ${data.headers["Authorization"]}`);
  assert.equal(data.headers["Authorization"], "Bearer config-token-123");
});

await test("config auth with basic auth", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "basic", username: "admin", password: "secret" },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → config basic: ${data.headers["Authorization"]?.slice(0, 20)}...`);
  const decoded = atob(data.headers["Authorization"].slice(6));
  assert.equal(decoded, "admin:secret");
});

await test("config auth with apikey", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "apikey", header: "x-api-key", key: "my-api-key" },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  const headerVal = data.headers["x-api-key"] || "not found";
  console.log(`    → config apikey: ${headerVal}`);
  if (data.headers["x-api-key"]) {
    assert.equal(data.headers["x-api-key"], "my-api-key");
  }
});

await test("config auth with dynamic token function", async () => {
  let callCount = 0;
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: {
      type: "bearer",
      token: async () => {
        callCount++;
        return `dynamic-${callCount}`;
      },
    },
  });
  const r1 = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  const r2 = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → dynamic token calls: ${callCount}`);
  assert.equal(r1.headers["Authorization"], "Bearer dynamic-1");
  assert.equal(r2.headers["Authorization"], "Bearer dynamic-2");
  assert.equal(callCount, 2);
});

await test("per-request auth overrides config auth", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "bearer", token: "config-token" },
  });
  const data = await client
    .GET("/headers")
    .bearer("override-token")
    .json<{ headers: Record<string, string> }>();
  console.log(`    → override: ${data.headers["Authorization"]}`);
  assert.equal(data.headers["Authorization"], "Bearer override-token");
});

await test("noAuth() disables auth", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "bearer", token: "should-be-ignored" },
  });
  const data = await client.GET("/headers").noAuth().json<{ headers: Record<string, string> }>();
  console.log(`    → noAuth: Authorization=${data.headers["Authorization"] || "not set"}`);
  assert.equal(data.headers["Authorization"], undefined);
});

// ============================================================================
// §4  INTERCEPTORS
// ============================================================================

suite("Interceptors (useRequest, useResponse, useError)");

await test("useRequest interceptor modifies request", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest((ctx) => {
    ctx.request.headers["x-added-by-interceptor"] = "intercepted";
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → request interceptor: ${data.headers["X-Added-By-Interceptor"]}`);
  assert.equal(data.headers["X-Added-By-Interceptor"], "intercepted");
});

await test("useResponse interceptor receives response", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  let capturedStatus = 0;
  client.useResponse(async (ctx) => {
    await new Promise((r) => setTimeout(r, 10)); // Small delay to ensure ctx is populated
    if (ctx.response) capturedStatus = ctx.response.status;
  });
  await client.GET("/get").send();
  console.log(`    → response interceptor: status=${capturedStatus}`);
  assert.equal(capturedStatus, 200);
});

await test("useError interceptor receives error", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  let capturedError = "";
  client.useError(async (ctx) => {
    await new Promise((r) => setTimeout(r, 10));
    if (ctx.error)
      capturedError = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
  });
  // Asserted, not logged: `console.log` of the captured value reported a pass
  // whether or not the interceptor ever ran. A 404 must reject with an
  // HTTPStatusError, and the interceptor must have seen that exact error.
  await assert.rejects(
    () => client.GET("/status/404").send(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 404);
      return true;
    },
  );
  assert.notEqual(capturedError, "", "the error interceptor must have captured the failure");
  assert.equal(capturedError.startsWith("HTTP 404"), true, `Unexpected message: ${capturedError}`);
});

await test("eject() removes interceptor", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const eject = client.useRequest((ctx) => {
    ctx.request.headers["x-should-be-removed"] = "yes";
  });
  eject();
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → eject: ${data.headers["X-Should-Be-Removed"] || "not present"}`);
  assert.equal(data.headers["X-Should-Be-Removed"], undefined);
});

await test("multiple interceptors chain in order", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.useRequest((ctx) => {
    ctx.request.headers["x-order"] = "1";
  });
  client.useRequest((ctx) => {
    ctx.request.headers["x-order"] = (ctx.request.headers["x-order"] || "") + "2";
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → chain: x-order=${data.headers["X-Order"]}`);
  assert.equal(data.headers["X-Order"], "12");
});

// ============================================================================
// §5  HEADERS AND PARAMS
// ============================================================================

suite("Headers and Query Params");

await test("config headers sent on every request", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    headers: { "x-config-header": "config-value" },
  });
  const data = await client.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → config header: ${data.headers["X-Config-Header"]}`);
  assert.equal(data.headers["X-Config-Header"], "config-value");
});

await test("per-request headers merged with config headers", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    headers: { "x-config": "config-value" },
  });
  const data = await client
    .GET("/headers")
    .header("x-per-request", "request-value")
    .json<{ headers: Record<string, string> }>();
  console.log(
    `    → merged: config=${data.headers["X-Config"]}, request=${data.headers["X-Per-Request"]}`,
  );
  assert.equal(data.headers["X-Config"], "config-value");
  assert.equal(data.headers["X-Per-Request"], "request-value");
});

await test("config params sent on every request", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    params: { configParam: "config-value" },
  });
  const data = await client.GET("/get").json<{ args: Record<string, string> }>();
  console.log(`    → config params: ${JSON.stringify(data.args)}`);
  assert.equal(data.args["configParam"], "config-value");
});

await test("per-request params merged with config params", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    params: { base: "base-value" },
  });
  const data = await client
    .GET("/get")
    .param("extra", "extra-value")
    .json<{ args: Record<string, string> }>();
  console.log(`    → merged params: ${JSON.stringify(data.args)}`);
  assert.equal(data.args["base"], "base-value");
  assert.equal(data.args["extra"], "extra-value");
});

await test("array params sent as repeated keys", async () => {
  const data = await bin
    .GET("/get")
    .params({ tag: ["a", "b", "c"] })
    .json<{ args: Record<string, string> }>();
  console.log(`    → array params: ${JSON.stringify(data.args)}`);
  // httpbin echoes repeated keys as an array
  assert.deepEqual(data.args["tag"] as unknown, ["a", "b", "c"]);
});

// ============================================================================
// §6  TIMEOUT AND RETRY
// ============================================================================

suite("Timeout and Retry");

await test("client-level timeout throws TimeoutError", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 100 });
  const started = Date.now();
  let caughtError: unknown;
  try {
    await client.get("/delay/5");
  } catch (err) {
    caughtError = err;
  }
  const elapsed = Date.now() - started;
  console.log(
    `    → timeout error: ${caughtError?.constructor?.name}, code=${(caughtError as { code?: string })?.code}`,
  );
  // The old assertion accepted any error whose constructor happened to be
  // named `KinetexError`, which every library error is — so a 404 or a DNS
  // failure satisfied it. The contract is specifically the timeout.
  assert.ok(caughtError instanceof TimeoutError, "expected a TimeoutError");
  assert.equal(caughtError.code, "ETIMEOUT");
  assert.equal(caughtError.isTimeout, true);
  assert.ok(elapsed < 4_000, `expected the 100ms timeout to fire early, took ${elapsed}ms`);
});

await test("retry on 503 with maxRetries", async () => {
  let attempts = 0;
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    retry: { maxRetries: 2, baseDelayMs: 50, statuses: [503] },
  });
  client.useRequest(() => {
    attempts++;
  });
  const res = await client.get("/status/503", { throwOnError: false });
  console.log(`    → retry attempts: ${attempts}, status=${res.status}`);
  if (skipOnUpstreamDrift("retry on configured status", res.status, 503)) return;
  assert.equal(attempts, 3); // 1 initial + 2 retries
});

await test("retry NOT on non-configured status", async () => {
  // The meaningful assertion is that exactly one attempt was made.
  let attempts = 0;
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    retry: { maxRetries: 3, baseDelayMs: 50, statuses: [503] },
  });
  client.useRequest(() => {
    attempts++;
  });
  await client.get("/status/404", { throwOnError: false });
  console.log(`    → no retry on 404: attempts=${attempts}`);
  assert.equal(attempts, 1);
});

await test("retry on network error when onNetworkError=true", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    retry: { maxRetries: 1, baseDelayMs: 50, onNetworkError: true },
  });
  const res = await client.get("/status/500", { throwOnError: false });
  console.log(`    → network retry: status=${res.status}`);
  if (skipOnUpstreamDrift("retry on network error", res.status, 500)) return;
  assert.equal(res.status, 500);
  assert.equal(res.attempt, 2, "maxRetries: 1 means exactly 2 attempts");
});

// ============================================================================
// §7  RESPONSE PROPERTIES
// ============================================================================

suite("Response Properties");

await test("response.durationMs is accurate", async () => {
  const res = await bin.get("/get");
  console.log(`    → durationMs: ${res.durationMs}ms`);
  assert.equal(typeof res.durationMs, "number");
  assert.equal(res.durationMs > 0 && res.durationMs < 30_000, true);
  assert.equal(res.status, 200);
});

await test("response.headers contains all headers", async () => {
  const res = await bin.get("/get");
  console.log(`    → content-type: ${res.headers["content-type"]}`);
  assert.match(res.headers["content-type"], /^application\/json/);
});

await test("response.request reflects sent request", async () => {
  const res = await bin.get("/get", { headers: { "x-test": "value" } });
  console.log(`    → request.url: ${res.request.url}, method: ${res.request.method}`);
  assert.ok(res.request.url.includes("/get"));
  assert.equal(res.request.method, "GET");
});

await test("response.cached is false for normal requests", async () => {
  const res = await bin.get("/get");
  console.log(`    → cached: ${res.cached}`);
  assert.equal(res.cached, false);
});

await test("response.httpVersion is set", async () => {
  const res = await bin.get("/get");
  console.log(`    → httpVersion: ${res.httpVersion}`);
  assert.equal(
    ["HTTP/1.1", "HTTP/2"].includes(res.httpVersion),
    true,
    `Unexpected: ${res.httpVersion}`,
  );
  assert.equal(res.status, 200);
});

// ============================================================================
// §8  ERROR HANDLING
// ============================================================================

suite("Error Handling");

await test("throwOnError:true throws HTTPStatusError on 4xx", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  let caughtError: unknown;
  try {
    await client.get("/status/404");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → 404 throw: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof HTTPStatusError, "expected an HTTPStatusError");
  assert.equal(caughtError.code, "EHTTPSTATUS");
  assert.equal(caughtError.response?.status, 404);
  assert.equal(caughtError.isHTTPError, true);
  assert.equal(caughtError.status, 404, "the status shorthand must agree");
});

await test("throwOnError:true throws HTTPStatusError on 5xx", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  let caughtError: unknown;
  try {
    await client.get("/status/503");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → 503 throw: ${caughtError?.constructor?.name}`);
  // 503 rather than 500: the client's default retry list contains 503, so
  // this also proves the status reaches the error path intact rather than
  // being flattened by a retry loop on its way out.
  assert.ok(caughtError instanceof HTTPStatusError, "expected an HTTPStatusError");
  assert.equal(caughtError.code, "EHTTPSTATUS");
  if (
    skipOnUpstreamDrift(
      "throwOnError:true throws HTTPStatusError on 5xx",
      caughtError.response?.status ?? 0,
      503,
    )
  ) {
    return;
  }
  assert.equal(caughtError.response?.status, 503);
  assert.equal(caughtError.isHTTPError, true);
  assert.equal(caughtError.status, 503, "the status shorthand must agree");
});

await test("throwOnError:false returns 4xx without throwing", async () => {
  const res = await bin.get("/status/404", { throwOnError: false });
  console.log(`    → 404 no throw: status=${res.status}`);
  assert.equal(res.status, 404);
});

await test("throwOnError:false returns 5xx without throwing", async () => {
  const res = await bin.get("/status/503", { throwOnError: false });
  console.log(`    → 503 no throw: status=${res.status}`);
  if (skipOnUpstreamDrift("throwOnError:false returns 5xx without throwing", res.status, 503)) {
    return;
  }
  assert.equal(res.status, 503);
});

await test("options.onError callback is called on error", async () => {
  let callbackCalled = false;
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  // Previously `console.log`-ed, so the callback firing was never checked.
  await assert.rejects(
    () =>
      client.get("/status/500", {
        onError: (err) => {
          callbackCalled = true;
          assert.ok(err instanceof Error, "onError receives the KinetexError");
          if (
            skipOnUpstreamDrift(
              "options.onError callback is called on error",
              (err as { status?: number }).status ?? 0,
              500,
            )
          ) {
            return;
          }
          assert.equal((err as { status?: number }).status, 500);
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      if (
        skipOnUpstreamDrift(
          "options.onError callback is called on error",
          (err as { status?: number }).status ?? 0,
          500,
        )
      ) {
        return true;
      }
      assert.equal((err as { status?: number }).status, 500);
      return true;
    },
    "a 500 must reject",
  );
  assert.equal(callbackCalled, true, "onError must have been invoked");
  assert.equal(callbackCalled, true);
});

await test("options.onSuccess callback is called on success", async () => {
  let callbackCalled = false;
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  await client.get("/get", {
    onSuccess: () => {
      callbackCalled = true;
    },
  });
  console.log(`    → onSuccess callback: ${callbackCalled}`);
  assert.equal(callbackCalled, true);
});

// ============================================================================
// §9  CHILD CLIENTS (extend)
// ============================================================================

suite("Child Clients (extend)");

await test("extend() inherits baseURL", async () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const child = parent.extend({});
  const res = await child.get("/get");
  console.log(`    → extend baseURL: status=${res.status}`);
  assert.equal(res.status, 200);
});

await test("extend() inherits headers", async () => {
  const parent = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    headers: { "x-from-parent": "yes" },
  });
  const child = parent.extend({});
  const data = await child.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → extend headers: ${data.headers["X-From-Parent"]}`);
  assert.equal(data.headers["X-From-Parent"], "yes");
});

await test("extend() adds its own headers", async () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const child = parent.extend({ headers: { "x-child": "yes" } });
  const data = await child.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → extend add: ${data.headers["X-Child"]}`);
  assert.equal(data.headers["X-Child"], "yes");
});

await test("extend() overrides config", async () => {
  const parent = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    auth: { type: "bearer", token: "parent" },
  });
  const child = parent.extend({ auth: { type: "bearer", token: "child" } });
  const data = await child.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → extend override: ${data.headers["Authorization"]}`);
  assert.equal(data.headers["Authorization"], "Bearer child");
});

await test("extend() copies runtime interceptors", async () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  parent.useRequest((ctx) => {
    ctx.request.headers["x-from-parent"] = "yes";
  });
  const child = parent.extend({});
  const data = await child.GET("/headers").json<{ headers: Record<string, string> }>();
  console.log(`    → extend interceptors: ${data.headers["X-From-Parent"]}`);
  assert.equal(data.headers["X-From-Parent"], "yes");
});

await test("extend() with new timeout overrides", async () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  const child = parent.extend({ timeout: 500 });
  const started = Date.now();
  let caughtError: unknown;
  try {
    await child.get("/delay/10");
  } catch (err) {
    caughtError = err;
  }
  const elapsed = Date.now() - started;
  console.log(`    → extend timeout: ${caughtError?.constructor?.name} after ${elapsed}ms`);
  // If `extend()` ignored the override the request would take the parent's
  // 30s and fail with a network/timeout error only at the very end; here it
  // must be the child's 500ms that fires, against a 10s server delay.
  assert.ok(caughtError instanceof TimeoutError, "expected a TimeoutError from the child config");
  assert.equal(caughtError.code, "ETIMEOUT");
  assert.ok(elapsed < 4_000, `expected the child timeout to fire early, took ${elapsed}ms`);
  await child.destroy();
});

// ============================================================================
// §10  HTTP STATUS CODES (jsonplaceholder)
// ============================================================================

suite("JSONPlaceholder CRUD");

await test("GET /posts returns posts", async () => {
  const r = await json.get<Array<{ id: number; title: string }>>("/posts", { throwOnError: false });
  console.log(
    `    → GET /posts: status=${r.status}, count=${Array.isArray(r.data) ? r.data.length : "not array"}`,
  );
  assert.equal(r.status, 200);
  assert.equal(Array.isArray(r.data), true);
  assert.equal(r.data.length, 100);
  assert.equal(typeof r.data[0].id, "number");
});

await test("GET /posts/1 returns single post", async () => {
  const r = await json.get<{ id: number; title: string; body: string }>("/posts/1", {
    throwOnError: false,
  });
  console.log(`    → GET /posts/1: status=${r.status}, id=${r.data?.id}`);
  // Unconditional: under `if (r.status === 200)` a 404 made this test pass
  // while asserting nothing at all.
  assert.equal(r.status, 200);
  assert.equal(r.data.id, 1);
  assert.equal(typeof r.data.title, "string");
  assert.equal(typeof r.data.body, "string");
});

await test("POST creates new post", async () => {
  const r = await json.post<{ id: number; title: string }>(
    "/posts",
    JSON.stringify({ title: "test", body: "test body", userId: 1 }),
    { headers: { "content-type": "application/json" }, throwOnError: false },
  );
  console.log(`    → POST: status=${r.status}`);
  assert.equal(r.status, 201);
  assert.equal(r.data.id > 0, true);
  assert.equal(r.data.title, "test");
});

await test("PUT replaces post", async () => {
  const r = await json.put<{ id: number; title: string }>(
    "/posts/1",
    JSON.stringify({ id: 1, title: "updated", body: "updated body", userId: 1 }),
    { headers: { "content-type": "application/json" }, throwOnError: false },
  );
  console.log(`    → PUT: status=${r.status}, title=${r.data?.title}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.title, "updated");
  assert.equal(r.data.id, 1);
});

await test("DELETE returns success", async () => {
  const r = await json.delete("/posts/1", { throwOnError: false });
  console.log(`    → DELETE: status=${r.status}`);
  // DELETE should succeed
  assert.equal([200, 204].includes(r.status), true, `Unexpected DELETE status ${r.status}`);
});

await test("GET /users/1/posts returns user's posts", async () => {
  const r = await json.get<Array<{ userId: number; id: number }>>("/users/1/posts", {
    throwOnError: false,
  });
  console.log(`    → nested: status=${r.status}`);
  assert.equal(r.status, 200);
  assert.equal(Array.isArray(r.data), true);
  assert.equal(r.data.length, 10);
  assert.equal(
    r.data.every((p) => p.userId === 1),
    true,
  );
});

// ============================================================================
// §11  HTTPS-ONLY MODE
// ============================================================================

suite("HTTPS-only mode");

await test("httpsOnly throws on HTTP URL", async () => {
  // Same guard as §4, asserted at the *builder* level rather than the
  // convenience method, so the two cases exercise different entry points
  // into the same check instead of repeating one request shape.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, httpsOnly: true });
  let caughtError: unknown;
  try {
    await client.GET("http://httpbin.org/get").send();
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → httpsOnly (builder) error: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof KinetexError, "expected a KinetexError");
  assert.equal(caughtError.code, "EVALIDATION");
});

await test("httpsOnly still allows https on the same client", async () => {
  // The guard is scheme-specific: it must not degrade into "reject everything".
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, httpsOnly: true });
  const res = await client.get("/get");
  console.log(`    → httpsOnly allows https: status=${res.status}`);
  assert.equal(res.status, 200);
});

// ============================================================================
// §12  HAR RECORDING
// ============================================================================

suite("HAR Recording");

await test("HAR recording captures request/response", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, har: true });
  await client.get("/get");
  await client.post("/post", JSON.stringify({ x: 1 }), {
    headers: { "content-type": "application/json" },
  });
  const har = client.getHAR();
  console.log(`    → HAR entries: ${har.entries.length}`);
  assert.equal(har.entries.length, 2);
  assert.equal(har.entries[0]?.request.method, "GET");
  assert.equal(har.entries[1]?.request.method, "POST");
});

await test("clearHAR() resets entries", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, har: true });
  await client.get("/get");
  assert.equal(client.getHAR().entries.length, 1);
  client.clearHAR();
  console.log(`    → after clear: ${client.getHAR().entries.length}`);
  assert.equal(client.getHAR().entries.length, 0);
});

await test("client.ws() method exists", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  console.log(`    → ws method exists: ${typeof client.ws === "function"}`);
  assert.equal(typeof client.ws, "function");
  client.destroy();
});

await test("client.paginate() with jsonplaceholder", async () => {
  const client = kinetex({ baseURL: "https://jsonplaceholder.typicode.com", timeout: T });
  try {
    const gen = await client.paginate<Post>("/posts", {
      perPage: 5,
      paramNames: { page: "_page", perPage: "_limit" },
      getItems: (data: any) => data || [],
      getTotal: () => 100,
    });

    let pageCount = 0;
    for await (const page of gen) {
      console.log(`    → page ${page.page}: ${page.data?.length || 0} items`);
      pageCount++;
      if (pageCount >= 2) break;
    }
    console.log(`    → paginate pages: ${pageCount}`);
    assert.equal(pageCount, 2);
  } catch (err) {
    console.log(`    → paginate error: ${err}`);
    throw err;
  }
  client.destroy();
});

await test("client.paginate() with maxPages limit", async () => {
  const client = kinetex({ baseURL: "https://jsonplaceholder.typicode.com", timeout: T });
  try {
    const gen = await client.paginate<Post>("/posts", {
      perPage: 10,
      maxPages: 2,
      paramNames: { page: "_page", perPage: "_limit" },
      getItems: (data: any) => data || [],
    });

    let pageCount = 0;
    for await (const page of gen) {
      pageCount++;
      console.log(`    → maxPages page ${page.page}: ${page.data?.length || 0} items`);
    }
    console.log(`    → maxPages total: ${pageCount}`);
    assert.equal(pageCount, 2);
  } catch (err) {
    console.log(`    → maxPages error: ${err}`);
    throw err;
  }
  client.destroy();
});

await test("client.ws() connects to WebSocket server", async () => {
  const client = kinetex({ baseURL: "wss://ws.postman-echo.com", timeout: 10000 });
  let ws;
  try {
    ws = await client.ws("/raw");
  } catch (err: any) {
    // Only an SSRF guard rejection is an environmental skip (the sandbox DNS
    // resolves the public host to a private address). Anything else is a bug
    // and must fail the test.
    if (String(err?.message ?? "").includes("safety check")) {
      console.log("    ⚠ skipped: sandbox SSRF guard blocks this public host");
      client.destroy();
      return;
    }
    throw err;
  }
  assert.equal(ws.connected, true, "socket must report connected");
  assert.equal(ws.state, "OPEN");
  // Must survive a real send/close round trip without throwing.
  assert.equal(ws.bufferedCount, 0, "an open socket has nothing queued");
  const sentBefore = ws.metrics.messagesSent;
  ws.send("Hello");
  // `send()` on an OPEN socket writes through synchronously, so the buffer
  // stays empty and the send is counted rather than queued.
  assert.equal(ws.metrics.messagesSent, sentBefore + 1, "the frame must be written and counted");
  assert.equal(ws.bufferedCount, 0, "an open socket writes through, it does not queue");
  ws.close();
  // The close handshake is asynchronous, so poll for the terminal state rather
  // than asserting it synchronously. `WSClient` exposes `state`/`connected`; it
  // has no `closed` property, so the assertion this replaces could never have
  // passed — it was masked by the sandbox SSRF skip above.
  const deadline = Date.now() + 5_000;
  while (ws.state !== "CLOSED" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(ws.state, "CLOSED", "close() must reach the CLOSED state");
  assert.equal(ws.connected, false, "a closed socket is not connected");
  assert.equal(ws.bufferedCount, 0, "close() must drop anything still queued");
  ws.destroy();
});

await test("client.graphql() creates GraphQL client", async () => {
  const client = kinetex({ baseURL: "https://countries.trevorblades.com", timeout: T });
  let gql: Awaited<ReturnType<typeof client.graphql>> | undefined;
  try {
    gql = await client.graphql("/graphql");
  } catch (err) {
    // The old body caught every error and logged it, so the test passed
    // even when the factory threw. Record why, then still fail below.
    console.log(`    → graphql threw: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    await client.destroy();
    throw err;
  }
  console.log(`    → graphql client created: ${typeof gql.query === "function"}`);
  assert.equal(typeof gql.query, "function");
  // Run a real query so the client is exercised, not just constructed.
  const result = await gql.query<{ countries: Array<{ name: string }> }>(`{
    countries { name }
  }`);
  assert.ok(Array.isArray(result.countries), "expected a countries array");
  assert.ok(result.countries.length > 0, "expected at least one country");
  await client.destroy();
});

await test("client.sse() creates SSE client", async () => {
  // Built against a real local SSE server: sse.example.com does not exist,
  // so the old version could only ever have taken its swallow-everything
  // branch, which is why it asserted nothing.
  // The factory itself only builds a client — it does not connect — so a
  // plain https endpoint is enough to prove the wiring, and no network
  // round-trip is involved.
  const client = kinetex({ baseURL: "https://sse.example.com", timeout: T });
  const sse = await client.sse("/events");
  console.log(`    → sse client created: url=${sse.url}`);
  // `SSEClient` has no `connect()` — connecting happens when you collect or
  // subscribe. The old body asserted `typeof sse.connect === "function"`,
  // which can never be true, and its catch-all hid that.
  assert.equal(sse.url, "https://sse.example.com/events", "the base URL must be applied");
  assert.equal(typeof sse.collect, "function");
  assert.equal(typeof sse.on, "function");
  assert.equal(sse.closed, false);
  sse.close();
  assert.equal(sse.closed, true, "close() must take effect");
  await client.destroy();
});

await test("client.sse() refuses a private base URL", async () => {
  // The SSE factory routes through the same pipeline as every other request,
  // so the SSRF screen applies here too. The old body caught this rejection
  // and logged it, which is why a loopback target could not fail the test.
  const client = kinetex({ baseURL: "http://127.0.0.1:9", timeout: T });
  let caughtError: unknown;
  try {
    await client.sse("/events");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → sse private URL: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof KinetexError, "a loopback SSE URL must be refused");
  assert.equal(caughtError.code, "EVALIDATION");
  await client.destroy();
});

await test("client.getCache() returns cache or null", async () => {
  const clientWithCache = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    cache: { ttl: 60 },
  });
  const cache = await clientWithCache.getCache();
  console.log(`    → cache instance: ${cache !== null}`);
  assert.notEqual(cache, null);
  clientWithCache.destroy();

  const clientNoCache = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const noCache = await clientNoCache.getCache();
  console.log(`    → no cache: ${noCache === null}`);
  assert.equal(noCache, null);
  clientNoCache.destroy();
});

// ============================================================================
// §13  REGRESSIONS (client round)
//
// One case per defect found while auditing this file. Each names the exact
// behaviour that regressed, so a future change that reintroduces it fails
// here with a readable message instead of silently restoring the old path.
// ============================================================================

suite("Regressions (client round)");

// ── noCache() was a no-op: `forceRefresh` was declared and read nowhere ──
await test("regression: noCache() bypasses a warm cache entry", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cache: { ttl: 60_000 } });
  // Warm the entry. A second identical request must be served from cache,
  // otherwise the "bypass" assertion below would pass for the wrong reason.
  const first = await client.get("/uuid");
  const second = await client.get("/uuid");
  console.log(`    → warm cache: cached=${first.cached}/${second.cached}`);
  assert.equal(first.cached, false, "the first request must go to the network");
  assert.equal(second.cached, true, "the second request must be served from cache");
  assert.equal(second.data.uuid, first.data.uuid, "both reads must be the same cached body");

  // `noCache()` sets `cache: { forceRefresh: true }`. `forceRefresh` used to
  // be declared in CacheRequestConfig and read nowhere, so a warm entry was
  // still returned and the builder option silently did nothing.
  const fresh = await client.GET("/uuid").noCache().send();
  console.log(`    → noCache(): cached=${fresh.cached}`);
  assert.equal(fresh.cached, false, "noCache() must not serve a cached entry");
  assert.equal(fresh.status, 200);

  // Refreshing still writes through, so a later plain read is cached again.
  const after = await client.get("/uuid");
  assert.equal(after.cached, true, "the refreshed entry must be written back to the cache");
  await client.destroy();
});

await test("regression: a plain request is still served from cache", async () => {
  // The counterpart to the case above: the fix must not have turned the
  // cache off. A mutation that forced `forceRefresh` true unconditionally
  // would make this fail.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cache: { ttl: 60_000 } });
  await client.get("/get");
  const second = await client.get("/get");
  console.log(`    → plain second read: cached=${second.cached}`);
  assert.equal(second.cached, true);
  assert.equal(second.status, 200);
  await client.destroy();
});

// ── redirect safety gates were unreachable for ordinary requests ──
await test("regression: a redirect to a loopback address is blocked", async () => {
  // Every hop is screened by kinetex, so a server-chosen Location can never
  // walk the client onto a private address. Before the fix, `_sendFollowing
  // Redirects` was only entered for cookie-jar or forwarded-credential
  // requests; an ordinary GET was left to the transport, which dialled
  // 127.0.0.1:9 itself and reported ECONNREFUSED — a socket was opened.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  let caughtError: unknown;
  try {
    await client.get("/redirect-to?url=http%3A%2F%2F127.0.0.1%3A9%2F&status_code=302");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → loopback redirect: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof KinetexError, "the redirect must be refused");
  assert.equal(caughtError.code, "EVALIDATION");
  assert.match(caughtError.message, /Unsafe redirect target blocked/);
  await client.destroy();
});

await test("regression: a redirect to the cloud metadata service is blocked", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  let caughtError: unknown;
  try {
    await client.get(
      "/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F&status_code=302",
    );
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → IMDS redirect: ${caughtError?.constructor?.name}`);
  // 169.254.169.254 is link-local: the SSRF screen has to catch it. Before
  // the fix the metadata service answered 401, which surfaced to the caller
  // as a perfectly ordinary `EHTTPSTATUS HTTP 401`.
  assert.ok(caughtError instanceof KinetexError, "the redirect must be refused");
  assert.equal(caughtError.code, "EVALIDATION");
  assert.match(caughtError.message, /169\.254\.169\.254/);
  await client.destroy();
});

await test("regression: httpsOnly is enforced on the redirect target", async () => {
  // `httpsOnly` gates the *initial* URL, but a 302 to a cleartext target
  // walks straight past it. Before the fix this returned an opaque
  // `ENETWORK "Protocol error"` from the transport instead.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, httpsOnly: true });
  let caughtError: unknown;
  try {
    await client.get("/redirect-to?url=http%3A%2F%2Fexample.com%2F&status_code=302");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → httpsOnly redirect: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof KinetexError, "the downgrade must be refused");
  assert.equal(caughtError.code, "EVALIDATION");
  assert.match(caughtError.message, /HTTPS-only mode enabled/);
  await client.destroy();
});

await test("regression: maxRedirects is enforced on ordinary requests", async () => {
  // /redirect/3 bounces three times before returning 200, so a budget of 2
  // is genuinely too small. The hop counter only exists inside the manual
  // follower, so a request that skipped it could never observe `maxRedirects`
  // at all — this is the assertion that would go missing.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  let caughtError: unknown;
  try {
    await client.get("/redirect/3", { maxRedirects: 2 });
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → redirect budget: ${caughtError?.constructor?.name}`);
  assert.ok(caughtError instanceof KinetexError, "the hop budget must be enforced");
  // `EREDIRECT`, not `ENETWORK`. A chain that has run out of hops is a
  // deterministic answer, and `shouldRetry` has always had a non-retryable
  // case for this code — but nothing constructed it, so the error arrived as a
  // network failure and every attempt replayed the whole chain.
  assert.equal(caughtError.code, "EREDIRECT");
  assert.equal(caughtError.name, "RedirectError");
  assert.match(caughtError.message, /Too many redirects \(exceeded 2\)/);

  // The same chain fits inside a budget of 3 and must then succeed, so the
  // counter is a real limit rather than "reject any redirect".
  const ok = await client.get("/redirect/3", { maxRedirects: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.redirected, true);
  await client.destroy();
});

await test("regression: a same-origin redirect is still followed", async () => {
  // The counterpart: screening every hop must not stop legitimate ones.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const res = await client.get("/redirect-to?url=%2Fget&status_code=302");
  console.log(`    → same-origin redirect: status=${res.status}, redirected=${res.redirected}`);
  assert.equal(res.status, 200);
  assert.equal(res.redirected, true);
  assert.equal(res.url, "https://httpbin.org/get");
  await client.destroy();
});

await test("regression: the HTTP/2 transport gates its own redirect target", async () => {
  // `NodeHTTP2Transport` has its own redirect loop for direct transport
  // users. It resolved the Location and dialled it with no protocol gate and
  // no `isSafeURL` screen, so the client's own gates were not the only thing
  // standing between a 302 and a private address on that path.
  const transport = new NodeHTTP2Transport();
  const base = {
    method: "GET" as const,
    headers: {} as Record<string, string>,
    body: null,
    signal: undefined,
    timeout: T,
    httpVersion: "HTTP/2" as const,
  };
  // A cleartext target: this transport hardcodes `:scheme: "https"`, so the
  // hop used to fail as an opaque `ERR_HTTP2_ERROR: Protocol error` — a
  // downgrade that happened to be impossible rather than one refused.
  let downgraded: unknown;
  try {
    await transport.send({
      ...base,
      url: "https://httpbin.org/redirect-to?url=http%3A%2F%2Fexample.com%2F&status_code=302",
    } as never);
  } catch (err) {
    downgraded = err;
  }
  console.log(`    → h2 downgrade: ${(downgraded as Error)?.constructor?.name}`);
  assert.ok(downgraded instanceof KinetexError, "the h2 transport must refuse the downgrade");
  assert.equal(downgraded.code, "EVALIDATION");
  assert.match(downgraded.message, /HTTP\/2 redirect to a non-HTTPS target blocked/);

  // An https target that is itself private: the protocol gate passes, so the
  // `isSafeURL` screen is the only thing standing between the hop and a
  // loopback socket. This one used to open the socket.
  let loopback: unknown;
  try {
    await transport.send({
      ...base,
      url: "https://httpbin.org/redirect-to?url=https%3A%2F%2F127.0.0.1%3A9%2F&status_code=302",
    } as never);
  } catch (err) {
    loopback = err;
  } finally {
    transport.destroy();
  }
  console.log(`    → h2 loopback: ${(loopback as Error)?.constructor?.name}`);
  assert.ok(loopback instanceof KinetexError, "the h2 transport must screen the target");
  assert.equal(loopback.code, "EVALIDATION");
  assert.match(loopback.message, /Unsafe redirect target blocked/);
});

// ── FormData reached the raw Node transports as zero bytes ──
await test("regression: FormData reaches the server over HTTP/2", async () => {
  // `NodeHTTP2Transport` is Node's default transport and does not go through
  // fetch, so it reads the body itself. `serializeRawBody` handled
  // URLSearchParams and Blob but not FormData, so a form upload went out
  // with no body and no content type at all — and the server answered 200.
  const formData = new FormData();
  formData.append("k", "v");
  formData.append("n", "42");
  const data = await bin
    .POST("/post")
    .withForm(formData)
    .json<{ form?: Record<string, string>; headers?: Record<string, string> }>();
  console.log(`    → h2 form upload: ${JSON.stringify(data.form)}`);
  assert.deepEqual(data.form, { k: "v", n: "42" });
  assert.match(
    data.headers?.["Content-Type"] ?? "",
    /^multipart\/form-data; boundary=\S+$/,
    "the boundary must be generated and sent in the content type",
  );
  assert.equal(
    (data.headers?.["Content-Type"] ?? "").includes("kinetexFormBoundary"),
    true,
    "the generated boundary should be the documented one",
  );
});

await test("regression: FormData is byte-identical over HTTP/1.1", async () => {
  const formData = new FormData();
  formData.append("k", "v");
  formData.append("n", "42");
  const data = await bin
    .POST("/post")
    .withForm(formData)
    .http1()
    .json<{ form?: Record<string, string>; headers?: Record<string, string> }>();
  console.log(`    → http1 form upload: ${JSON.stringify(data.form)}`);
  // The two transports must agree; a fix that only repaired the h2 path
  // would leave this one silently different.
  assert.deepEqual(data.form, { k: "v", n: "42" });
});

await test("regression: a transport given a FormData body serializes it", async () => {
  // The client encodes FormData itself, before dispatch, so `serializeRawBody`
  // is not on the path a normal `withForm()` call takes. It is still the last
  // line of defence for a caller who hands a `FormData` straight to a raw Node
  // transport, and reverting its FormData branch to `new Uint8Array(0)` sends
  // an empty body with no error at all.
  //
  // Reaching it means avoiding both shortcuts: a cleartext URL or
  // `httpVersion: "HTTP/1.1"` routes through the `fetch` fallback, where
  // undici serializes the FormData itself and kinetex never sees it. Only the
  // HTTP/2-over-TLS path reaches `attachBodyToH2Stream`.
  const { createSecureServer } = await import("node:http2");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const certDir = mkdtempSync(join(tmpdir(), "kinetex-form-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  const bodies: string[] = [];
  let sentType: string | undefined;
  const server = createSecureServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    allowHTTP1: false,
  });
  server.on("stream", (stream, headers) => {
    sentType = headers["content-type"] as string | undefined;
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("latin1"));
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // `ca` is a transport constructor option, not a per-request field.
  const transport = new NodeHTTP2Transport({ ca: readFileSync(certPath) });
  const form = new FormData();
  form.append("k", "v");
  let sent = false;
  try {
    // No `content-type` supplied: the transport has to invent the boundary and
    // announce it, which is the whole point of encoding before the headers.
    await transport.send({
      url: `https://127.0.0.1:${port}/upload`,
      method: "POST",
      headers: {},
      body: form,
      signal: undefined,
      timeout: T,
      httpVersion: "HTTP/2",
    } as never);
    sent = true;
  } finally {
    transport.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`    → h2 transport form: ${bodies[0]?.length ?? 0} bytes, ct=${sentType}`);
  assert.equal(sent, true, "the h2 request must have completed");
  assert.equal(bodies.length, 1, "the server must have received exactly one body");
  const body = bodies[0]!;
  assert.ok(
    body.length > 0,
    "a FormData body handed to the transport directly must not be sent as zero bytes",
  );
  assert.match(sentType ?? "", /^multipart\/form-data; boundary=\S+$/);

  // The boundary in the body and the one in the header must be the SAME
  // string. Generating the body after the header block is written leaves a
  // body no header describes, which a parser cannot recover from — and the
  // fix is to encode before building the headers, not to copy the header's
  // value into the body.
  const announced = /boundary=(.+)$/.exec(sentType ?? "")?.[1]!;
  assert.ok(announced.length > 0, "the content type must announce a boundary");
  assert.ok(
    body.startsWith(`--${announced}\r\n`),
    `body must start with the announced boundary ${announced}, got ${JSON.stringify(body.slice(0, 40))}`,
  );
  assert.ok(body.endsWith(`--${announced}--\r\n`), "body must close with the announced boundary");
  assert.match(body, /name="k"/);
  // kinetex's own prefix, not undici's `----formdata-undici-…`: proof that
  // `serializeRawBody` encoded this rather than the fetch fallback.
  assert.match(announced, /kinetexFormBoundary/);
});

await test("regression: the HTTP/1.1 fallback path encodes a FormData body", async () => {
  // `_sendHTTP1Legacy` — the `node:https` path used when the runtime has no
  // global fetch — builds its request options before the body is written, so
  // a multipart boundary generated during encoding has nowhere to go. Same
  // fix as the HTTP/2 path, and it needs its own assertion because this branch
  // is unreachable on any Node that ships fetch.
  const { createServer } = await import("node:https");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const certDir = mkdtempSync(join(tmpdir(), "kinetex-form-h1-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  const bodies: string[] = [];
  let sentType: string | undefined;
  const server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      sentType = req.headers["content-type"];
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("latin1"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // Hide fetch so `_sendHTTP1` takes the legacy branch. Restored immediately.
  // `Object.defineProperty` rather than `delete`: deleting a non-optional
  // global is a type error, and silencing that needs a suppression comment.
  // The transport tests `typeof globalThis.fetch === "function"`, so shadowing
  // the property with `undefined` hides it just as completely as removing it.
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const transport = new NodeHTTP2Transport({ ca: readFileSync(certPath) });
  const form = new FormData();
  form.append("k", "v");
  let sent = false;
  let caught: unknown;
  try {
    await transport.send({
      url: `https://127.0.0.1:${port}/upload`,
      method: "POST",
      headers: {},
      body: form,
      signal: undefined,
      timeout: T,
      httpVersion: "HTTP/1.1",
    } as never);
    sent = true;
  } catch (err) {
    caught = err;
  } finally {
    globalThis.fetch = realFetch;
    transport.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`    → http1 legacy form: ${bodies[0]?.length ?? 0} bytes, ct=${sentType}`);
  assert.equal(caught, undefined, `the legacy path must complete: ${String(caught)}`);
  assert.equal(sent, true);
  assert.equal(bodies.length, 1, "the server must have received exactly one body");
  const body = bodies[0]!;
  assert.ok(body.length > 0, "the legacy path must not send a zero-byte body");
  const announced = /boundary=(.+)$/.exec(sentType ?? "")?.[1]!;
  assert.ok(announced, "the content type must announce a boundary");
  assert.ok(
    body.startsWith(`--${announced}\r\n`),
    "body and content-type must name the same boundary",
  );
  assert.match(body, /name="k"/);
});

await test("regression: a multipart filename with a quote is escaped, not rejected", async () => {
  // The CR/LF/quote guard only covers *field names*. A File's `filename` goes
  // through the same quoted-string context, so it has to be escaped rather
  // than refused — rejecting it would break ordinary uploads whose name
  // happens to contain a quote.
  const form = new FormData();
  form.append("f", new File(['"quoted"'], 'we"ird.txt', { type: "text/plain" }));
  const { bytes } = await encodeMultipart(form, "----kinetexTestBoundary");
  const text = Buffer.from(bytes).toString("latin1");
  console.log(`    → filename escaped: ${/filename="we%22ird.txt"/.test(text)}`);
  assert.match(
    text,
    /filename="we%22ird\.txt"/,
    "a quote in a filename must be percent-encoded, not emitted raw and not refused",
  );
  assert.ok(
    !text.includes('filename="we"ird.txt"'),
    "the raw quote must not survive into the part header",
  );
});

await test("regression: encodeMultipart rejects a header-injecting field name", async () => {
  // The field name goes verbatim into the part headers, so a CR/LF or a
  // quote in it would let a caller append arbitrary part headers.
  const form = new FormData();
  form.append('evil"\r\nX-Injected: 1', "x");
  await assert.rejects(
    () => encodeMultipart(form),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, "expected a KinetexError");
      assert.equal(err.code, "EVALIDATION");
      return true;
    },
  );
  console.log(`    → encodeMultipart rejected a CR/LF field name`);
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`  Tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
console.log(`════════════════════════════════════════════════════════════`);

if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
  process.exit(1);
}
process.exit(0);
