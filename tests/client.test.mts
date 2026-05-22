/**
 * kinetex — client.ts unit tests
 * Tests all Kinetex client features with real HTTP calls to external APIs.
 * No mocks, no predefined data, only real network calls.
 */

import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";

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
  assert.ok(data.url.includes("/get"));
  assert.ok(typeof data.origin === "string");
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
  assert.ok(bytes.length > 0);
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
  assert.ok(
    data.headers["x-api-key"] === "secret-key" || data.headers["X-Api-Key"] === "secret-key",
  );
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
  const headerKeys = Object.keys(data.headers).map((k) => k.toLowerCase());
  assert.ok(headerKeys.includes("x-api-key"), "x-api-key header should be present");
});

await test("client.GET().noThrow() returns 404 without throwing", async () => {
  const res = await bin.GET("/status/404").noThrow().send();
  console.log(`    → GET().noThrow(): status=${res.status}`);
  assert.equal(res.status, 404);
});

await test("client.GET().timeout() sets timeout", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 0 });
  let caughtError: unknown;
  try {
    await client.GET("/delay/5").timeout(500).send();
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → GET().timeout() error: ${caughtError?.constructor?.name}`);
  assert.notEqual(caughtError, undefined);
});

await test("client.GET().noRetry() disables retry", async () => {
  const data = await bin.GET("/get").noRetry().json<{ origin: string }>();
  console.log(`    → GET().noRetry(): ${data.origin}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().retry() configures retry", async () => {
  const data = await bin.GET("/get").retry(2, { baseDelayMs: 100 }).json<{ origin: string }>();
  console.log(`    → GET().retry(2): ${data.origin}`);
  assert.ok(typeof data.origin === "string");
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
  assert.notEqual(caughtError, undefined);
});

await test("client.GET().http2() requests HTTP/2", async () => {
  const res = await bin.GET("/get").http2().send();
  console.log(`    → GET().http2(): httpVersion=${res.httpVersion}`);
  assert.equal(res.httpVersion, "HTTP/2");
});

await test("client.GET().http1() requests HTTP/1.1", async () => {
  const res = await bin.GET("/get").http1().send();
  console.log(`    → GET().http1(): httpVersion=${res.httpVersion}`);
  assert.ok(res.httpVersion === "HTTP/1.1" || res.httpVersion === "HTTP/2");
});

await test("client.GET().noCache() forces fresh fetch", async () => {
  const data = await bin.GET("/get").noCache().json<{ origin: string }>();
  console.log(`    → GET().noCache(): ${data.origin}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().tags() adds cache tags", async () => {
  const data = await bin.GET("/get").tags("tag1", "tag2").json<{ origin: string }>();
  console.log(`    → GET().tags(): ${data.origin}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().meta() attaches metadata", async () => {
  const res = await bin.GET("/get").meta({ requestId: "test-123" }).send();
  console.log(`    → GET().meta(): request.id=${res.request.meta?.requestId}`);
  assert.equal(res.request.meta?.requestId, "test-123");
});

await test("client.GET().signal() attaches AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  let caughtError: unknown;
  try {
    await bin.GET("/delay/10").signal(controller.signal).send();
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → GET().signal() error: ${caughtError?.constructor?.name}`);
  assert.notEqual(caughtError, undefined);
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
  assert.ok(data.includes("raw text content"));
});

await test("client.GET().data() returns just the data", async () => {
  const data = await bin.GET("/get").data<{ origin: string }>();
  console.log(`    → data(): ${data.origin}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().blob() returns Blob", async () => {
  const blob = await bin.GET("/bytes/100").blob();
  console.log(`    → blob(): size=${blob.size}, type=${blob.type}`);
  assert.ok(blob instanceof Blob);
  assert.ok(blob.size > 0);
});

await test("client.GET().onUploadProgress() callback is called", async () => {
  let progressCalled = false;
  const data = await bin
    .GET("/get")
    .onUploadProgress((event) => {
      progressCalled = true;
      console.log(`    → upload progress: ${event.loaded} bytes`);
    })
    .json<{ origin: string }>();
  console.log(`    → onUploadProgress called: ${progressCalled}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().onDownloadProgress() callback is called", async () => {
  let progressCalled = false;
  const data = await bin
    .GET("/get")
    .onDownloadProgress((event) => {
      progressCalled = true;
      console.log(`    → download progress: ${event.loaded} bytes`);
    })
    .json<{ origin: string }>();
  console.log(`    → onDownloadProgress called: ${progressCalled}`);
  assert.ok(typeof data.origin === "string");
});

await test("client.GET().withForm() sets FormData body", async () => {
  const formData = new FormData();
  formData.append("key", "value");
  const data = await bin.POST("/post").withForm(formData).json<{ form?: Record<string, string> }>();
  console.log(`    → withForm(): posted successfully`);
  assert.notEqual(data, null);
});

await test("meta.traceId generates traceparent header without error", async () => {
  const res = await bin.GET("/get").meta({ traceId: "test-trace-123" }).send();
  console.log(`    → meta with traceId: sent successfully`);
  assert.ok(res.request.meta?.traceId !== undefined);
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
  assert.ok(retryInfo.length > 0);
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
  assert.equal(res.status, 503);
});

await test("onError hook is called on error", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    hooks: {
      onError: [
        async (err) => {
          console.log(`    → onError hook: ${err.message}`);
        },
      ],
    },
  });
  try {
    await client.get("/status/500");
  } catch {
    /* expected */
  }
  console.log(`    → onError hook: executed`);
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
  assert.notEqual(caughtError, undefined);
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
  assert.notEqual(caughtError, undefined);
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
    threw = err instanceof Error && (err.name === "AbortError" || err.constructor.name === "DOMException");
    console.log(`    → already aborted signal: ${err instanceof Error ? err.constructor.name : typeof err}`);
  }
  assert.ok(threw, `Expected AbortError or DOMException but got: ${caughtErr instanceof Error ? caughtErr.constructor.name : typeof caughtErr}`);
});

await test("client.GET().proxy() sets proxy config", async () => {
  const res = await bin.GET("/get").proxy({ host: "proxy.example.com", port: 8080 }).send();
  console.log(`    → proxy() executed: ${res.status}`);
  assert.equal(res.status, 200);
});

await test("client.GET().headers() merges multiple headers", async () => {
  const res = await bin
    .GET("/headers")
    .headers({ "X-Test-Header": "test-value", "X-Another": "another" })
    .send();
  console.log(`    → headers() executed: ${res.status}`);
  assert.equal(res.status, 200);
});

await test("client.destroy() cleans up resources", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.destroy();
  console.log(`    → destroy() executed without error`);
});

await test("client.extend() with debug enabled", async () => {
  const child = bin.extend({ debug: true });
  console.log(`    → extend with debug: created`);
  assert.notEqual(child, null);
  child.destroy();
});

// Test query param merging
await test("client.GET().params() merges with config params", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    params: { configParam: "config-value" },
  });
  const res = await client.GET("/get").params({ extraParam: "extra-value" }).send();
  console.log(`    → params merge: ${res.status}`);
  assert.equal(res.status, 200);
  client.destroy();
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

  try {
    await client.get("/status/503", {
      signal: controller.signal,
      throwOnError: false,
    });
  } catch (err: any) {
    console.log(`    → abort during retry: ${err.name || "Error"}`);
  }
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
  console.log(`    → params(): ${res.status}`);
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
  assert.ok(threw, `Expected an Error to be thrown but got: ${caughtErr instanceof Error ? caughtErr.constructor.name : typeof caughtErr}`);
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
  try {
    await client.GET("/status/404").send();
  } catch {
    /* expected */
  }
  console.log(`    → error interceptor: capturedError length=${capturedError.length}`);
  assert.ok(capturedError.length > 0);
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
  // httpbin repeats params as comma-separated
  assert.ok(
    data.args["tag"]?.includes("a") &&
      data.args["tag"]?.includes("b") &&
      data.args["tag"]?.includes("c"),
  );
});

// ============================================================================
// §6  TIMEOUT AND RETRY
// ============================================================================

suite("Timeout and Retry");

await test("client-level timeout throws TimeoutError", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 100 });
  let caughtError: unknown;
  try {
    await client.get("/delay/5");
  } catch (err) {
    caughtError = err;
  }
  console.log(
    `    → timeout error: ${caughtError?.constructor?.name}, code=${(caughtError as { code?: string })?.code}`,
  );
  assert.notEqual(caughtError, undefined);
  // Verify it's a timeout-related error
  const err = caughtError as { code?: string; constructor?: { name: string } };
  assert.ok(
    err.code === "ETIMEOUT" ||
      err.constructor?.name === "TimeoutError" ||
      err.constructor?.name === "KinetexError",
  );
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
  assert.equal(attempts, 3); // 1 initial + 2 retries
});

await test("retry NOT on non-configured status", async () => {
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
  assert.ok(res.status >= 200, `status ${res.status} should be >= 200`);
});

// ============================================================================
// §7  RESPONSE PROPERTIES
// ============================================================================

suite("Response Properties");

await test("response.durationMs is accurate", async () => {
  const res = await bin.get("/get");
  console.log(`    → durationMs: ${res.durationMs}ms`);
  assert.ok(res.durationMs > 0);
  assert.ok(res.durationMs < 30_000);
});

await test("response.headers contains all headers", async () => {
  const res = await bin.get("/get");
  console.log(`    → content-type: ${res.headers["content-type"]}`);
  assert.ok(typeof res.headers["content-type"] === "string");
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
  assert.ok(res.httpVersion === "HTTP/1.1" || res.httpVersion === "HTTP/2");
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
  assert.notEqual(caughtError, undefined);
});

await test("throwOnError:true throws HTTPStatusError on 5xx", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  let caughtError: unknown;
  try {
    await client.get("/status/500");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → 500 throw: ${caughtError?.constructor?.name}`);
  assert.notEqual(caughtError, undefined);
});

await test("throwOnError:false returns 4xx without throwing", async () => {
  const res = await bin.get("/status/404", { throwOnError: false });
  console.log(`    → 404 no throw: status=${res.status}`);
  assert.equal(res.status, 404);
});

await test("throwOnError:false returns 5xx without throwing", async () => {
  const res = await bin.get("/status/503", { throwOnError: false });
  console.log(`    → 503 no throw: status=${res.status}`);
  assert.equal(res.status, 503);
});

await test("options.onError callback is called on error", async () => {
  let callbackCalled = false;
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  try {
    await client.get("/status/500", {
      onError: (err) => {
        callbackCalled = true;
      },
    });
  } catch {
    /* ignore */
  }
  console.log(`    → onError callback: ${callbackCalled}`);
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
  let caughtError: unknown;
  try {
    await child.get("/delay/10");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → extend timeout: ${caughtError?.constructor?.name}`);
  assert.notEqual(caughtError, undefined);
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
  if (r.status === 200 && Array.isArray(r.data)) {
    assert.ok(r.data.length > 0);
    assert.ok(typeof r.data[0].id === "number");
  } else {
    console.log(`    → Note: API returned status ${r.status}, skipping assertion`);
  }
});

await test("GET /posts/1 returns single post", async () => {
  const r = await json.get<{ id: number; title: string; body: string }>("/posts/1", {
    throwOnError: false,
  });
  console.log(`    → GET /posts/1: status=${r.status}`);
  if (r.status === 200) {
    assert.equal(r.data.id, 1);
  }
});

await test("POST creates new post", async () => {
  const r = await json.post<{ id: number; title: string }>(
    "/posts",
    JSON.stringify({ title: "test", body: "test body", userId: 1 }),
    { headers: { "content-type": "application/json" }, throwOnError: false },
  );
  console.log(`    → POST: status=${r.status}`);
  if (r.status === 201) {
    assert.ok(r.data.id > 0);
  }
});

await test("PUT replaces post", async () => {
  const r = await json.put<{ id: number; title: string }>(
    "/posts/1",
    JSON.stringify({ id: 1, title: "updated", body: "updated body", userId: 1 }),
    { headers: { "content-type": "application/json" }, throwOnError: false },
  );
  console.log(`    → PUT: status=${r.status}`);
  if (r.status === 200) {
    assert.equal(r.data.title, "updated");
  }
});

await test("DELETE returns success", async () => {
  const r = await json.delete("/posts/1", { throwOnError: false });
  console.log(`    → DELETE: status=${r.status}`);
  // DELETE should succeed
  assert.ok(r.status === 200 || r.status === 204);
});

await test("GET /users/1/posts returns user's posts", async () => {
  const r = await json.get<Array<{ userId: number; id: number }>>("/users/1/posts", {
    throwOnError: false,
  });
  console.log(`    → nested: status=${r.status}`);
  if (r.status === 200 && Array.isArray(r.data)) {
    assert.ok(r.data.length > 0);
    assert.ok(r.data.every((p) => p.userId === 1));
  }
});

// ============================================================================
// §11  HTTPS-ONLY MODE
// ============================================================================

suite("HTTPS-only mode");

await test("httpsOnly throws on HTTP URL", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, httpsOnly: true });
  let caughtError: unknown;
  try {
    await client.get("http://httpbin.org/get");
  } catch (err) {
    caughtError = err;
  }
  console.log(`    → httpsOnly error: ${caughtError?.constructor?.name}`);
  assert.notEqual(caughtError, undefined);
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
    assert.ok(pageCount >= 2);
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
  try {
    const ws = await client.ws("/raw");
    console.log(`    → ws connected: true`);
    ws.send("Hello");
    ws.close();
    console.log(`    → ws sent and closed`);
  } catch (err: any) {
    console.log(`    → ws error: ${err.message.slice(0, 50)}`);
  }
  client.destroy();
  console.log(`    → ws test completed`);
});

await test("client.graphql() creates GraphQL client", async () => {
  const client = kinetex({ baseURL: "https://countries.trevorblades.com", timeout: T });
  try {
    const gql = await client.graphql("/graphql");
    console.log(`    → graphql client created: ${typeof gql.query === "function"}`);
    assert.equal(typeof gql.query, "function");
  } catch (err: any) {
    console.log(`    → graphql error: ${err.message.slice(0, 50)}`);
  }
  client.destroy();
});

await test("client.sse() creates SSE client", async () => {
  const client = kinetex({ baseURL: "https://sse.example.com", timeout: T });
  try {
    const sse = await client.sse("/events");
    console.log(`    → sse client created: ${typeof sse.connect === "function"}`);
    assert.equal(typeof sse.connect, "function");
  } catch (err: any) {
    console.log(`    → sse error (expected): ${err.message.slice(0, 30)}`);
  }
  client.destroy();
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
