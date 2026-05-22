# kinetex

**Feature-rich, universal TypeScript HTTP client.** Zero dependencies. One codebase, every runtime.

```ts
import { kinetex } from "kinetex";

const api = kinetex({ baseURL: "https://api.example.com", timeout: 5000 });
const users = await api.get<User[]>("/users");

// Or use the fluent builder:
const post = await api.POST("/posts").withJSON({ title: "Hello" }).bearer("token").json<Post>();
```

Works in **Node.js 18+**, **Deno**, **Bun**, **browsers**, **Cloudflare Workers**, **Vercel Edge**, and all **WinterCG-compliant** runtimes.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Client Configuration](#client-configuration)
- [Basic HTTP Methods](#basic-http-methods)
- [Fluent Request Builder](#fluent-request-builder)
- [Send Options](#send-options)
- [Response Object](#response-object)
- [Authentication](#authentication)
- [Retry](#retry)
- [Rate Limiting](#rate-limiting)
- [Timeout](#timeout)
- [Interceptors](#interceptors)
- [Lifecycle Hooks](#lifecycle-hooks)
- [HookRegistry](#hookregistry)
- [Request Deduplication](#request-deduplication)
- [Circuit Breaker](#circuit-breaker)
- [Caching](#caching)
- [Cookie Jar](#cookie-jar)
- [Cookie Parser & Store](#cookie-parser--store)
- [Pagination](#pagination)
- [Server-Sent Events (SSE)](#server-sent-events-sse)
- [WebSocket](#websocket)
- [GraphQL](#graphql)
- [Progress Tracking](#progress-tracking)
- [AWS SigV4 Signing](#aws-sigv4-signing)
- [SOCKS5 Proxy](#socks5-proxy)
- [Digest Authentication](#digest-authentication)
- [Structured Logging](#structured-logging)
- [HAR Recording](#har-recording)
- [OpenTelemetry Tracing](#opentelemetry-tracing)
- [Pipeline Trace](#pipeline-trace)
- [Transport Layer](#transport-layer)
- [Runtime Detection](#runtime-detection)
- [Child Clients](#child-clients)
- [Batch Queue](#batch-queue)
- [URL Utilities](#url-utilities)
- [Header Utilities](#header-utilities)
- [Response Parsing Utilities](#response-parsing-utilities)
- [Safe JSON Parsing](#safe-json-parsing)
- [Type Guards & Utilities](#type-guards--utilities)
- [Error Handling](#error-handling)
- [Deep Imports](#deep-imports)
- [Worker Entry Point](#worker-entry-point)
- [Browser Usage](#browser-usage)
- [Runtime Compatibility](#runtime-compatibility)
- [Resource Cleanup](#resource-cleanup)
- [License](#license)

---

## Installation

```bash
npm install kinetex
```

```bash
deno add jsr:@kinetexjs/kinetex
```

```bash
bun add kinetex
```

**JSR:**

```ts
import { kinetex } from "jsr:@kinetexjs/kinetex";
```

---

## Quick Start

```ts
import { kinetex } from "kinetex";

const client = kinetex({ baseURL: "https://jsonplaceholder.typicode.com" });

// Convenience methods
const users = await client.get<User[]>("/users");
const post = await client.post("/posts", { title: "Hello", body: "World" });

// Fluent builder
const data = await client
  .GET("/users")
  .header("X-API-Key", "secret")
  .param("page", "1")
  .bearer("my-token")
  .timeout(5000)
  .noThrow()
  .json<User[]>();

// Low-level send
const res = await client.send("/users", "GET", {
  headers: { Accept: "application/json" },
  params: { limit: "10" },
  throwOnError: false,
});

// Response
console.log(res.status, res.data, res.headers, res.durationMs);
```

---

## Client Configuration

```ts
const client = kinetex({
  // ── Core ──
  baseURL: "https://api.example.com/v1",           // Base URL for relative paths
  headers: { "X-Version": "1.0" },                 // Default headers
  params: { api_key: "xxx" },                      // Default query params
  timeout: 10000,                                  // Timeout in ms (default: 30000, 0 = no timeout)
  httpVersion: "HTTP/2",                           // "HTTP/1.1" | "HTTP/2" (default: "HTTP/2")
  throwOnError: true,                              // Throw on 4xx/5xx (default: true)
  followRedirects: true,                           // Follow redirects (default: true)
  maxRedirects: 10,                                // Max redirects (default: 10)
  httpsOnly: false,                                // Reject non-HTTPS URLs
  maxResponseSize: 10_000_000,                     // Response body size limit (0 = no limit)
  maxRequestSize: 10_000_000,                      // Request body size limit (0 = no limit)
  strictHeaders: false,                            // Throw on invalid headers vs warn+drop
  onPipelineTrace: (step) => console.log(step),    // Pipeline observability callback
  onSWRError: (err, req) => log(err),              // Background SWR revalidation error callback

  // ── Auth ──
  auth: { type: "bearer", token: "..." },
  awsSigning: { credentials: {...}, region: "...", service: "..." },

  // ── Retry ──
  retry: { maxRetries: 3, baseDelayMs: 300, statuses: [408, 429, 500, 502, 503, 504] },

  // ── Rate Limit ──
  rateLimit: { limit: 100, windowMs: 60_000, queue: true, maxQueue: 100 },

  // ── Proxy ──
  proxy: { url: "socks5://127.0.0.1:1080" },

  // ── Cache ──
  cache: { storage: "memory", ttlMs: 60_000, maxEntries: 1000, swr: true },

  // ── Cookie Jar ──
  cookieJar: true,                                 // Auto-manage cookies

  // ── Logging ──
  logger: { level: "info" },

  // ── HAR Recording ──
  har: true,                                       // Enable HTTP Archive recording

  // ── Interceptors ──
  interceptors: {
    request:  [myReqInterceptor],
    response: [myResInterceptor],
    error:    [myErrInterceptor],
  },

  // ── Lifecycle Hooks ──
  hooks: {
    onBeforeRequest:    [(req, ctx) => { ... }],
    onAfterRequest:     [(req, ctx) => { ... }],
    onBeforeResponse:   [(res, ctx) => { ... }],
    onAfterResponse:    [(res, ctx) => { ... }],
    onError:            [(err, ctx) => { ... }],
    onRetry:            [(ctx) => { ... }],
    onUploadProgress:   [(ev) => { ... }],
    onDownloadProgress: [(ev) => { ... }],
  },

  // ── Response/Request Transforms ──
  transformResponse: (data, res) => data,           // Global response transformer
  transformRequest: (req) => req,                   // Global request transformer

  // ── Circuit Breaker Key ──
  circuitBreakerKeyFn: (req) => `${req.method}:${new URL(req.url).origin}`,

  // ── Custom fetch ──
  fetch: myCustomFetch,                              // Custom fetch implementation

  // ── WebSocket defaults ──
  ws: { highWaterMark: 65536, lowWaterMark: 16384, maxSendRate: 0, keepRooms: true },
});
```

---

## Basic HTTP Methods

```ts
const get = await client.get("/resource");
const post = await client.post("/resource", { key: "value" });
const put = await client.put("/resource/1", { data: "new" });
const patch = await client.patch("/resource/1", { data: "updated" });
const del = await client.delete("/resource/1");
const head = await client.head("/resource"); // → KinetexResponse<null>
const opts = await client.options("/resource");
```

All accept optional `SendOptions` as the last argument:

```ts
const res = await client.get("/users", {
  headers: { "X-Custom": "value" },
  params: { page: "1", limit: "10" },
  timeout: 5000,
  signal: controller.signal,
  throwOnError: false,
  onDownloadProgress: (ev) => console.log(ev.percent),
  parseResponse: (raw, headers, url) => myParser(raw),
  parseFailure: (raw, error) => console.warn("JSON parse failed", error),
  onSuccess: (res) => console.log("Got:", res.data),
  onError: (err) => console.error("Failed:", err.message),
  meta: { traceId: "abc" },
  tags: ["users"],
  cache: { ttlMs: 5000 },
  maxResponseSize: 1_000_000,
  httpVersion: "HTTP/1.1",
});
```

### `send()` — Low-Level API

```ts
const res = await client.send("/resource", "GET", options);
// Equivalent to the convenience methods but with explicit method parameter.
```

---

## Fluent Request Builder

Every method returns `this` for chaining. Call `.send()`, `.json()`, `.text()`, `.bytes()`, `.blob()`, or `.data()` to execute.

```ts
const client = kinetex({ baseURL: "https://api.example.com" });

// Full chain
const data = await client
  .GET("/users") // or .POST, .PUT, .PATCH, .DELETE, .request(method, url)
  .header("X-Custom", "value") // single header
  .headers({ "X-A": "1", "X-B": "2" }) // multiple headers
  .param("page", "1") // single query param
  .params({ limit: "10", sort: "name" }) // multiple params
  .query({ filter: "active" }) // alias for .params()
  .body("raw text") // raw body
  .withJSON({ key: "value" }) // JSON body (sets Content-Type)
  .withBody("text") // alias for .body()
  .withForm(formData) // FormData body
  .bearer("token") // Bearer auth
  .basic("user", "pass") // Basic auth
  .apiKey("X-Key", "value") // API key auth
  .digest("user", "pass") // Digest auth
  .noAuth() // Skip auth
  .retry(3, { baseDelayMs: 1000 }) // Max retries + optional config
  .noRetry() // Skip retry
  .timeout(5000) // Timeout in ms
  .proxy({ url: "socks5://..." }) // Proxy config
  .cache({ ttlMs: 5000 }) // Cache config
  .noCache() // Force fresh fetch
  .maxSize(1_000_000) // Max response size
  .http2() // Prefer HTTP/2
  .http1() // Force HTTP/1.1
  .noThrow() // Don't throw on 4xx/5xx
  .meta({ requestId: "abc" }) // Arbitrary metadata
  .signal(controller.signal) // AbortSignal
  .tags("users", "active") // Cache tags
  .onUploadProgress((ev) => {}) // Upload progress callback
  .onDownloadProgress((ev) => {}) // Download progress callback
  .send() // → Promise<KinetexResponse<T>>
  .json<T>() // → Promise<T> (parsed JSON data)
  .text() // → Promise<string>
  .bytes() // → Promise<Uint8Array>
  .blob() // → Promise<Blob>
  .data<T>() // → Promise<T> (alias for .json)
  .subscribe(onSuccess, onError); // callback-style (void)
```

---

## Send Options

Full `SendOptions` interface passed to `.send()` and convenience methods:

```ts
interface SendOptions<T = unknown> {
  baseURL?: string; // Override base URL
  headers?: HeadersInit; // Additional/override headers
  params?: QueryParams; // Query parameters
  body?: BodyInit; // Request body
  timeout?: number; // Timeout in ms
  signal?: AbortSignal; // Cancellation signal
  retry?: Partial<RetryConfig> | false; // Retry config or disable
  auth?: AuthConfig | false; // Auth config or disable
  proxy?: ProxyConfig | false; // Proxy config or disable
  cache?: CacheRequestConfig | false; // Cache config or disable
  throwOnError?: boolean; // Throw on 4xx/5xx
  followRedirects?: boolean; // Follow redirects
  maxRedirects?: number; // Max redirects
  httpVersion?: HTTPVersion; // Preferred HTTP version
  maxRequestSize?: number; // Request size limit (bytes)
  maxResponseSize?: number; // Response size limit (bytes)
  parseResponse?: (raw: Uint8Array, headers: Record<string, string>, url: string) => T | Promise<T>;
  parseFailure?: (raw: Uint8Array, error: Error) => void;
  onSuccess?: (res: KinetexResponse<T>) => void;
  onError?: (err: KinetexError) => void;
  onUploadProgress?: ProgressCallback;
  onDownloadProgress?: ProgressCallback;
  tags?: string[]; // Cache invalidation tags
  meta?: Record<string, unknown>; // Arbitrary metadata
}
```

---

## Response Object

```ts
interface KinetexResponse<T = unknown> {
  status: number; // HTTP status code
  statusText: string; // HTTP status text
  headers: Record<string, string>; // Normalized (lowercased) response headers
  data: T; // Parsed response body
  rawBody: Uint8Array | null; // Raw response body bytes
  url: string; // Final URL after redirects
  cached: boolean; // Whether served from cache
  redirected: boolean; // Whether request was redirected
  httpVersion: HTTPVersion; // Detected protocol version
  durationMs: number; // Total request duration in ms
  request: KinetexRequest; // The originating request
  attempt: number; // Attempt number (1 = first try)
}
```

---

## Authentication

### Client-Level Auth

```ts
// Bearer token
kinetex({ auth: { type: "bearer", token: "my-jwt" } });
kinetex({ auth: { type: "bearer", token: async () => await refresh() } });

// HTTP Basic (credentials zeroized from memory after use)
kinetex({ auth: { type: "basic", username: "user", password: "pass" } });

// API Key (custom header)
kinetex({ auth: { type: "apikey", header: "X-API-Key", key: "my-key" } });
kinetex({ auth: { type: "apikey", header: "X-API-Key", key: async () => await getKey() } });

// HTTP Digest (auto-handles 401 → challenge parse → retry)
kinetex({ auth: { type: "digest", username: "user", password: "pass" } });

// Custom auth handler
kinetex({
  auth: {
    type: "custom",
    apply: (req) => ({ ...req, headers: { ...req.headers, "X-Custom-Auth": "value" } }),
  },
});
```

### Per-Request Auth

```ts
client.get("/public", { auth: false }); // Disable
client.get("/admin", { auth: { type: "bearer", token: t } }); // Override
```

### Fluent Auth

```ts
client.GET("/admin").bearer("token").json();
client.GET("/login").basic("user", "pass").json();
client.GET("/api").apiKey("X-Key", "value").json();
client.GET("/digest").digest("user", "pass").json();
client.GET("/public").noAuth().json();
```

---

## Retry

```ts
kinetex({
  retry: {
    maxRetries: 3, // Max attempts (default: 3)
    baseDelayMs: 300, // Exponential back-off base (default: 300)
    maxDelayMs: 30_000, // Max delay cap (default: 30_000)
    jitter: 0.3, // Random jitter factor 0-1 (default: 0.3)
    statuses: [408, 429, 500, 502, 503, 504], // Status codes that trigger retry
    onNetworkError: true, // Retry on network errors (default: true)
    onTimeout: false, // Retry on timeouts (default: false)
    methods: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"],
    shouldRetry: (ctx) => ctx.attempt < 3 && ctx.response?.status === 503, // Custom predicate
    onRetry: (ctx, delayMs) => console.log(`Retry ${ctx.attempt} in ${delayMs}ms`),
  },
});
```

### RetryContext

The `ctx` parameter in `shouldRetry` and `onRetry` is of type `RetryContext`:

```ts
interface RetryContext {
  attempt: number;
  maxRetries: number;
  response?: KinetexResponse<unknown>;
  error?: unknown;
  request: KinetexRequest;
  delayMs?: number;
}
```

Per-request override:

```ts
client.get("/data", { retry: { maxRetries: 5, statuses: [500, 502] } });
client.get("/data", { retry: false }); // Disable retry
client.GET("/data").retry(2, { baseDelayMs: 1000 }).json(); // Fluent
client.GET("/data").noRetry().json(); // Fluent disable
```

---

## Rate Limiting

Built-in token-bucket rate limiter, registered as the highest-priority request interceptor:

```ts
kinetex({
  rateLimit: {
    limit: 100, // Requests per window (default: 60)
    windowMs: 60_000, // Window size in ms (default: 60_000)
    queue: true, // Queue excess requests vs reject (default: true)
    maxQueue: 100, // Max queued requests (default: 100)
  },
});
```

---

## Timeout

Default timeout is 30 seconds. Set to 0 for no timeout:

```ts
const client = kinetex({ timeout: 10000 }); // Client-wide timeout
client.get("/slow", { timeout: 30000 }); // Per-request override
client.GET("/slow").timeout(30000).json(); // Fluent override
```

Timeout throws `TimeoutError`:

```ts
try {
  await client.get("/slow", { timeout: 100 });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.timeoutMs}ms`);
  }
}
```

Internally uses `sendWithTimeout(transport, request, timeoutMs)` which races the transport promise against a timeout promise using `AbortController` and `mergeSignals`.

---

## Interceptors

Three types of interceptors: **request**, **response**, and **error**. Each returns an eject function.

### Request Interceptor

```ts
const eject = client.useRequest(async (ctx) => {
  ctx.request.headers["X-Request-ID"] = crypto.randomUUID();
  // Return void → keep current request
  // Return KinetexRequest → replace request
  // Return KinetexResponse → short-circuit (skip network)
  // Throw → abort with error
});
// eject() removes the interceptor
```

### Response Interceptor

```ts
client.useResponse(async (ctx) => {
  if (ctx.response) {
    console.log(`Response: ${ctx.response.status}`);
  }
  // Return void → keep current response
  // Return KinetexResponse → replace response
  // Return KinetexRequest → trigger a retry
});
```

### Error Interceptor

```ts
client.useError(async (ctx) => {
  console.error("Error:", ctx.error);
  // Return void → rethrow original error
  // Return KinetexResponse → recover with synthetic response
  // Throw → replace with different error
});
```

### Config-Level Interceptors

```ts
kinetex({
  interceptors: {
    request: [fn1, fn2],
    response: [fn3, fn4],
    error: [fn5],
  },
});
```

### InterceptorContext

```ts
interface InterceptorContext {
  request: KinetexRequest;
  response: KinetexResponse<unknown> | null;
  error: unknown | null;
  startedAt: number; // Monotonic start time (ms)
  attempt: number; // Current attempt number
  aborted: boolean; // Pipeline aborted?
  store: Map<symbol | string, unknown>; // Pipeline-scoped shared storage
}
```

### Built-in Interceptors

All available from `kinetex/interceptors`:

```ts
import {
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
  InterceptorManager,
  computeBodySize,
  RateLimitError, // thrown by createRateLimitInterceptor
} from "kinetex/interceptors";

// Compute request body size (used internally by progress tracking)
computeBodySize(body); // → number | null

// Combine multiple built-in interceptors
const suite = createInterceptorSuite({
  retry: { maxRetries: 3 },
  auth: { type: "bearer", token: "..." },
  cache: { ttlMs: 5000 },
  logging: true,
  metrics: true,
});
// suite.retry, suite.auth, suite.cache, suite.logging, suite.metrics, suite.eject
```

---

## Lifecycle Hooks

Hooks are higher-level callbacks for specific lifecycle stages, configured at client creation:

```ts
kinetex({
  hooks: {
    onBeforeRequest: [
      (req, ctx) => {
        console.log(`→ ${req.method} ${req.url}`);
        return req; // Return modified request, or void
      },
    ],
    onAfterRequest: [
      (req, ctx) => {
        /* request was sent */
      },
    ],
    onBeforeResponse: [
      (res, ctx) => {
        console.log(`← ${res.status}`);
        return res; // Return modified response, or void
      },
    ],
    onAfterResponse: [
      (res, ctx) => {
        /* response processed */
      },
    ],
    onError: [
      (err, ctx) => {
        console.error(err);
        return recoveredResponse; // Return KinetexResponse to recover, or void to rethrow
      },
    ],
    onRetry: [(ctx) => console.log(`Retry ${ctx.attempt}/${ctx.maxRetries}`)],
    onUploadProgress: [(ev) => console.log(`Upload: ${ev.percent}%`)],
    onDownloadProgress: [(ev) => console.log(`Download: ${ev.percent}%`)],
  },
});
```

### HookContext

```ts
interface HookContext {
  request: KinetexRequest;
  response: KinetexResponse<unknown> | null;
  error: unknown | null;
  startedAt: number;
  attempt: number;
  meta: Record<string, unknown>;
}
```

---

## HookRegistry

For advanced hook management — priority ordering, one-shot hooks, conditional execution:

```ts
import {
  HookRegistry,
  HookEmitter,
  RedirectTracker,
  TooManyRedirectsError,
  HTTPError,
  ResponseValidationError,
  createLoggingHooks,
  createTimingHook,
  createBodyNormalizationHook,
  createAbortHook,
  createHookContext,
  tap,
  injectHeaders,
  withBaseURL,
  throwOnHTTPError,
  validateResponse,
  composeBeforeRequest,
  composeBeforeResponse,
  composeAround,
} from "kinetex/lifecycle";
import type {
  HookRequest,
  HookResponse,
  HookError,
  HookOptions,
  BeforeRequestHook,
  AfterRequestHook,
  BeforeResponseHook,
  AfterResponseHook,
  OnErrorHook,
  OnRetryHook,
  OnRedirectHook,
  OnUploadProgressHook,
  OnDownloadProgressHook,
  AroundHook,
} from "kinetex/lifecycle";

const registry = new HookRegistry();

// All hook types:
// - addBeforeRequest(fn, options?)
// - addAfterRequest(fn, options?)
// - addBeforeResponse(fn, options?)
// - addAfterResponse(fn, options?)
// - addOnError(fn, options?)
// - addOnRetry(fn, options?)
// - addOnRedirect(fn, options?)
// - addOnUploadProgress(fn, options?)
// - addOnDownloadProgress(fn, options?)
// - addAround(fn, options?)       // wraps the entire pipeline

registry.addBeforeRequest(myHook, {
  priority: 10, // Lower number = runs first (default: 100)
  once: true, // Auto-eject after first run
  if: (req) => req.method === "POST", // Conditional execution
});
registry.removeBeforeRequest(myHook); // Eject by reference

// Attach registry to a client
client.attachHookRegistry(registry); // Returns single eject function

// Built-in hook factories:
const { beforeRequest, afterResponse, onError } = createLoggingHooks();
const timingHook = createTimingHook();
const normalizeBody = createBodyNormalizationHook();
const abortHook = createAbortHook();
const ctx = createHookContext(req, res, err); // Manual HookContext creation

// Utility hooks
const injectCustomHeaders = injectHeaders({ "X-Internal": "true" }); // BeforeRequestHook
const withBase = withBaseURL("https://api.example.com"); // BeforeRequestHook
const throwOnError = throwOnHTTPError(); // BeforeResponseHook
const validator = validateResponse((res) => res.status < 500); // BeforeResponseHook
const tapped = tap((value) => console.log(value)); // Passthrough logger

// Composition
const pipeline = composeBeforeRequest(fn1, fn2, fn3);
const responsePipe = composeBeforeResponse(fn1, fn2);
// Redirect tracking
const redirectTracker = new RedirectTracker({ maxRedirects: 5 });
// Error classes
class MyHTTPError extends HTTPError {}       // extends Error
class MyValidationError extends ResponseValidationError {} // extends Error
class TooManyRedirectsError extends Error {}  // thrown by HookRegistry
```

### HookEmitter

For event-style hook emission separate from the registry:

```ts
const emitter = new HookEmitter();
emitter.on("beforeRequest", myHandler);
emitter.emit("beforeRequest", req, ctx);
emitter.off("beforeRequest", myHandler);
emitter.clear();
```

### HookOptions

```ts
interface HookOptions {
  priority?: number; // Lower runs first (default: 100)
  once?: boolean; // Auto-eject after first execution
  if?: (req: KinetexRequest) => boolean; // Conditional execution predicate
}
```

---

## Request Deduplication

Coalesces identical concurrent GET/HEAD requests into a single network call:

```ts
client.enableDedup({ windowMs: 50 }); // Also dedupe for 50ms after completion

// These 3 calls make exactly ONE network request:
const [a, b, c] = await Promise.all([
  client.get("/users"),
  client.get("/users"),
  client.get("/users"),
]);

console.log(client.dedupMetrics);
// { hits: 2, misses: 1, inFlightCount: 0 }

client.disableDedup();
```

Uses `DedupMap` internally:

```ts
import { DedupMap, createDedupMap } from "kinetex/dedup";
import type { DedupOptions } from "kinetex/dedup";

const dedup = new DedupMap<KinetexResponse>({
  keyFn: (method, url, headers) => `${method}:${url}:${headers?.["authorization"]}`,
  windowMs: 100, // Keep completed response for 100ms
  methods: ["GET", "HEAD"], // Methods to deduplicate
  signal: controller.signal,
});

const result = await dedup.execute("GET", "unique-key", () => fetchData());

// Simple factory
const dMap = createDedupMap<KinetexResponse>({ windowMs: 50 });

// Metrics
console.log(dedup.hits, dedup.misses, dedup.inFlightCount, dedup.stats);
```

---

## Circuit Breaker

Per-origin (or per-key) three-state machine to prevent cascading failures:

```ts
client.enableCircuitBreaker({
  failureThreshold: 5, // Failures before OPEN (default: 5)
  resetTimeoutMs: 30_000, // Time before HALF_OPEN probe (default: 30_000)
  successThreshold: 3, // Consecutive successes to CLOSE (default: 3)
  windowSize: 10, // Sliding window size (0 = consecutive count) (default: 10)
  halfOpenMaxRequests: 1, // Concurrent probes in HALF_OPEN (default: 1)
  failureFilter: {
    // Which failures count toward threshold
    networkErrors: true, // ENETWORK errors (default: true)
    timeouts: true, // ETIMEOUT errors (default: true)
    serverErrors: false, // HTTP 5xx (default: false)
    statusCodes: [503], // Specific status codes
  },
  onOpen: (state) => console.log("Circuit OPEN", state),
  onClose: (state) => console.log("Circuit recovered"),
  onHalfOpen: (state) => console.log("Probing..."),
  onRejected: (req) => console.log("Rejected by CB", req.url),
});

// Manual control
client.tripCircuit("https://api.example.com");
client.resetCircuit("https://api.example.com");

// Inspect state
console.log(client.circuitSnapshots);

client.disableCircuitBreaker();
```

### Standalone

```ts
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
  CircuitOpenError,
} from "kinetex/circuit-breaker";
import type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerState,
  FailureFilter,
} from "kinetex/circuit-breaker";

const cb = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

const registry = new CircuitBreakerRegistry(config);
// Thin wrapper that manages a Map<string, CircuitBreaker>
registry.get("https://api.example.com"); // → CircuitBreaker
registry.snapshots(); // → Record<string, CircuitBreakerState>
registry.trip("origin");
registry.reset("origin");
registry.clear();
```

---

## Caching

RFC 7234 compliant HTTP caching with multiple storage backends:

```ts
const client = kinetex({
  cache: {
    storage: "memory", // "memory" | "localStorage" | "kv"
    ttlMs: 60_000, // Default TTL (default: 60_000)
    maxEntries: 1000, // Max cached entries (default: 1000)
    maxBodySize: 1_000_000, // Max body size to cache
    swr: true, // Stale-while-revalidate (default: false)
    swrTtlMs: 30_000, // SWR TTL (default: ttlMs * 0.1)
    vary: true, // Respect Vary header (default: true)
    namespace: "myapp", // Cache namespace prefix
  },
});

// Per-request cache control
client.get("/users", { cache: { ttlMs: 5000 } });
client.get("/users", { cache: { forceRefresh: true } }); // Bypass + re-cache
client.get("/users", { cache: false }); // Bypass entirely
client.GET("/users").cache({ ttlMs: 5000 }).json();
client.GET("/users").noCache().json();

// SWR error callback
kinetex({
  cache: { swr: true },
  onSWRError: (err, req) => console.error("SWR failed", req.url, err),
});
```

### Standalone Cache

```ts
import {
  HTTPCache,
  createMemoryCache,
  createLocalStorageCache,
  createKVCache,
  createTwoTierCache,
  createSessionStorageCache,
  MemoryStorageAdapter,
  WebStorageAdapter,
  CloudflareKVAdapter,
  TwoTierStorageAdapter,
  getAuthFingerprint,
} from "kinetex/cache";
import type { CacheEntry, CacheStats, CacheConfig, CacheStorageAdapter } from "kinetex/cache";

// Memory cache
const cache = createMemoryCache({ ttlMs: 60_000, maxEntries: 1000 });

// Browser localStorage cache
const cache = createLocalStorageCache({ prefix: "myapp:" });

// Browser sessionStorage cache
const cache = createSessionStorageCache({ prefix: "myapp:" });

// Cloudflare KV cache
const cache = createKVCache({ kv: myKVNamespace, ttlMs: 60_000 });

// Two-tier (L1 memory + L2 storage)
const cache = createTwoTierCache({
  tier1: createMemoryCache({ ttlMs: 10_000 }),
  tier2: createLocalStorageCache({ prefix: "myapp:" }),
});

// Full HTTPCache
const cache = new HTTPCache({
  storage: new MemoryStorageAdapter(),
  ttlMs: 60_000,
  maxEntries: 1000,
  vary: true,
  namespace: "myapp",
});

await cache.set(
  { url: "https://api.example.com/users", method: "GET", headers: {} },
  { status: 200, statusText: "OK", headers: {}, body: "..." },
  { tags: ["users"] },
);

const entry = await cache.get({ url: "https://api.example.com/users", method: "GET", headers: {} });
// entry.response, entry.stale, entry.ttlMs, entry.tags, entry.cachedAt, entry.hitCount

// Tag-based invalidation
await cache.invalidateByTag("users");

// Cache statistics
const stats: CacheStats = cache.stats; // { size, hits, misses, evictions, hitRate }
cache.clear();
```

---

## Cookie Jar

Full RFC 6265 cookie storage and management with SameSite, HttpOnly, Secure, domain/path matching:

```ts
// Auto-managed through the client
const client = kinetex({ baseURL: "https://httpbin.org", cookieJar: true });
await client.get("/cookies/set/test/value");
const res = await client.get("/cookies");
console.log(res.data.cookies.test); // "value"

// Standalone
import { CookieJar, createCookieJar, loadCookieJar } from "kinetex/cookiejar";
import type { Cookie, CookieJSON } from "kinetex/cookiejar";

const jar = createCookieJar();

// From Set-Cookie header
jar.setCookie("session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax", {
  url: "https://example.com/login",
});

// From fetch Response headers
jar.processResponseHeaders(response.headers, {
  url: "https://example.com/login",
});

// Get cookies for a request
const header = jar.getCookieHeader({
  url: "https://example.com/api/users",
  http: true, // Include HttpOnly cookies (default: true)
  sameSiteContext: "strict", // "strict" | "lax" | "cross-site" (default: "strict")
});
// → "session=abc123"

const cookies: Cookie[] = jar.getCookies({
  url: "https://example.com/api",
  http: false, // Exclude HttpOnly cookies (for document.cookie)
});

// Serialization
const json: CookieJSON[] = jar.toJSON();
const jar2 = loadCookieJar(json);

// Clear
jar.clear();
jar.clearExpired();
jar.clearSession();
jar.clearForDomain("example.com");
jar.clearForUrl("https://example.com/api");
```

### Cookie Interface

```ts
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null; // epoch ms
  maxAge: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none";
  createdAt: number;
  lastAccessed: number;
  hostOnly: boolean;
}
```

---

## Cookie Parser & Store

Full RFC 6265 §5.1 + §5.2 Set-Cookie header parser with public suffix list:

```ts
import {
  parseCookieDate,
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  decodeIDNLabel,
  canonicalizeDomainFull,
  isIPAddress,
  domainMatch,
  defaultPath,
  pathMatch,
  parseSetCookieHeader,
  splitSetCookieHeaders,
  extractSetCookieHeaders,
} from "kinetex/cookie-parser";

const parsed = parseSetCookieHeader(
  "session=abc123; Path=/; Domain=.example.com; Secure; HttpOnly; SameSite=Lax; Max-Age=3600",
);
// → ParsedCookie {
//   name: "session",
//   value: "abc123",
//   domain: "example.com",
//   path: "/",
//   expires: null,
//   maxAge: 3600,
//   secure: true,
//   httpOnly: true,
//   sameSite: "Lax",
//   sameParty: false,
//   priority: null,
//   partitioned: false,
// }

domainMatch("api.example.com", "example.com"); // → true
pathMatch("/api/users", "/api"); // → true
isPublicSuffix("com"); // → true
getRegistrableDomain("api.example.com"); // → "example.com"
defaultPath("/api/users"); // → "/api"
extractSetCookieHeaders(headers); // → string[]
splitSetCookieHeaders("a=1, b=2"); // → ["a=1", "b=2"]
```

Internal storage model with LRU eviction (per-domain cap 50, global cap 3000). The `CookieStore` class handles the underlying storage:

```ts
import { CookieStore } from "kinetex/cookie-store";
const store = new CookieStore({ domainLimit: 50, globalLimit: 3000, signal: controller.signal });
store.add(cookie);
store.get("https://example.com", { http: true });
// Also: clear(), clearExpired(), clearSession(), clearForDomain(), clearForUrl(), toJSON()
```

---

## Pagination

Seven pagination strategies with async iteration:

```ts
import {
  paginate,
  collectAll,
  collectPages,
  takeItems,
  paginateItems,
  mergePaginators,
  parseLinkHeaderNext,
  createOffsetPaginator,
  createPagePaginator,
  createCursorPaginator,
  createKeysetPaginator,
  createRelayPaginator,
  createLinkHeaderPaginator,
  createTokenPaginator,
  toPaginationIterator,
  serializePaginationState,
  deserializePaginationState,
} from "kinetex/pagination";
import type { Page, PaginationState } from "kinetex/pagination";

// Offset strategy: ?offset=0&limit=100
const pages = paginate(client, {
  url: "/items",
  strategy: "offset",
  perPage: 100,
  maxPages: 10, // Stop after N pages
  initialOffset: 0,
});

// Page strategy: ?page=1&per_page=100
const pages = paginate(client, {
  url: "/items",
  strategy: "page",
  perPage: 50,
  maxPages: 5,
  pageParam: "page", // Query param name (default: "page")
  perPageParam: "per_page", // Query param name (default: "per_page")
});

// Cursor strategy: ?cursor=abc123
const pages = paginate(client, {
  url: "/items",
  strategy: "cursor",
  perPage: 100,
  getCursor: (res) => res.data.nextCursor,
  setCursor: (url, cursor) => ({ ...url, query: { ...url.query, after: cursor } }),
  getItems: (res) => res.data.items,
});

// Keyset strategy: ?after=2024-01-01
const pages = paginate(client, {
  url: "/items",
  strategy: "keyset",
  perPage: 100,
  initialKey: new Date().toISOString(),
  getKey: (res) => res.data.lastTimestamp,
  setKey: (url, key) => ({ ...url, query: { ...url.query, after: key } }),
  getItems: (res) => res.data.items,
});

// Relay strategy (GraphQL-style edges/node/pageInfo)
const pages = paginate(client, {
  url: "/items",
  strategy: "relay",
  perPage: 100,
  getItems: (res) => res.data.edges.map((e: any) => e.node),
  getPageInfo: (res) => res.data.pageInfo,
});

// Link header strategy (GitHub-style)
const pages = paginate(client, {
  url: "/items",
  strategy: "link-header",
  getItems: (res) => res.data,
  parseNext: (res) => parseLinkHeaderNext(res.headers["link"]),
});

// Token strategy (Google API-style)
const pages = paginate(client, {
  url: "/items",
  strategy: "token",
  perPage: 100,
  getToken: (res) => res.data.nextPageToken,
  setToken: (url, token) => ({ ...url, query: { ...url.query, pageToken: token } }),
  getItems: (res) => res.data.items,
});

// Consume pages
for await (const page of pages) {
  console.log(page.items, page.total, page.page, page.hasNext, page.nextCursor);
}

// Collect all items across all pages
const allItems = await collectAll(client, { url: "/items", strategy: "cursor" });

// Collect all page objects
const allPages = await collectPages(client, { url: "/items", strategy: "page", maxPages: 5 });

// Take N items across pages
const first50 = await takeItems(client, { url: "/items", strategy: "offset", perPage: 10 }, 50);

// Paginate items directly (yield items, not pages)
const items = paginateItems(client, { url: "/items", strategy: "page" });
for await (const item of items) {
  console.log(item);
}

// Parallel prefetch
const pages = paginate(client, { url: "/items", strategy: "page", prefetch: 3 });

// Merge two paginators
const merged = mergePaginators(paginator1, paginator2);

// State serialization (resume capability)
const state: PaginationState = serializePaginationState(paginator);
const paginator2 = deserializePaginationState(client, state);

// Convert to async iterator
const iterator = toPaginationIterator(paginator);
```

### Client-Level Pagination

```ts
const pages = await client.paginate("/items", {
  strategy: "page",
  perPage: 50,
  maxPages: 10,
});
```

---

## Server-Sent Events (SSE)

```ts
import {
  SSEClient,
  SSEParser,
  SSETransformStream,
  SSERouter,
  createSSEStream,
  createJSONSSEStream,
  parseSSEText,
  jsonSSE,
  SSEServerResponse,
  SSEError,
  SSEMaxReconnectsError,
  createSSEResponse,
} from "kinetex/sse";
import type { SSEEvent, SSEClientConfig, JSONSSEEvent } from "kinetex/sse";

// SSEClient
const sse = new SSEClient({
  url: "https://api.example.com/events",
  method: "POST",
  headers: { Authorization: "Bearer token" },
  body: JSON.stringify({ query: "..." }),
  fetch: globalThis.fetch,
  onEvent: (event) => {
    console.log(event.id, event.event, event.data);
  },
  autoReconnect: true,
  maxReconnects: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  signal: controller.signal,
});

// Async iteration
for await (const event of sse) {
  console.log(event.id, event.event, event.data);
}

// JSON SSE events
const jsonStream = createJSONSSEStream<{ price: number }>("https://api.example.com/prices");
for await (const event of jsonStream) {
  console.log(event.data.price);
}

// SSE transform stream
const parser = new SSEParser();
const stream = new SSETransformStream();
readableStream.pipeThrough(stream).pipeTo(writableStream);

// Named event routing
const router = new SSERouter();
router.on("price_update", (event) => {
  /* ... */
});
router.on("order_filled", (event) => {
  /* ... */
});

// Server-side SSE response builder
const response = createSSEResponse(); // → Response with text/event-stream
```

### Client-Level SSE

```ts
const sseClient = await client.sse("/events", {
  autoReconnect: true,
  maxReconnects: 5,
});
```

---

## WebSocket

```ts
import {
  WSClient,
  connectWS,
  WSError,
  WSMaxReconnectsError,
  WSConnectTimeoutError,
  WSRateLimitError,
} from "kinetex/ws";
import type {
  WSState,
  WSMessage,
  WSClientConfig,
  WSCloseEvent,
  WSBackpressureInfo,
  WSSubscribedRoom,
} from "kinetex/ws";

const ws = new WSClient({
  url: "wss://api.example.com/live",
  headers: { Authorization: "Bearer token" },
  reconnect: true,
  maxReconnects: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  connectTimeoutMs: 5000,
  pingIntervalMs: 30000,
  pongTimeoutMs: 5000,
  highWaterMark: 65536,
  lowWaterMark: 16384,
  maxSendRate: 0,          // 0 = unlimited
  keepRooms: true,
  signal: controller.signal,

  onMessage: (msg) => console.log(msg.data, msg.json),
  onError: (err) => console.error(err),
  onClose: (code, reason, willReconnect) => {},
  onReconnect: (attempt) => console.log(`Reconnecting (${attempt})`),
});

await ws.connect();

// Send
ws.send("raw message");
ws.sendJSON({ type: "subscribe", channel: "prices" });
ws.sendBinary(new Uint8Array([1, 2, 3]));

// Async iteration
for await (const msg of ws) {
  console.log(msg.data, msg.json?.type);
}

// Request/response correlation
const reply = await ws.request({ type: "ping" }, (msg) => msg.json?.type === "pong");

// Metrics
interface WSMetrics {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  reconnectCount: number;
  totalConnectAttempts: number;
  uptimeMs: number | null;
}

// Utility
const ws = await connectWS("wss://api.example.com/ws", { onMessage: ... });
```

### Client-Level WebSocket

```ts
const ws = await client.ws("wss://api.example.com/live", {
  onMessage: (msg) => console.log(msg.json),
});
// Inherits client headers, auth, cookies, and circuit breaker protection
```

---

## GraphQL

```ts
import {
  GraphQLClient,
  createGraphQLClient,
  gql,
  detectOperationType,
  extractOperationName,
  clearAPQCache,
  getAPQMetrics,
  authLink,
  errorLink,
  loggingLink,
  retryLink,
  GraphQLClientError,
} from "kinetex/graphql";
import type {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLError,
  GraphQLClientConfig,
  GraphQLLink,
  GraphQLLinkNext,
} from "kinetex/graphql";

const client = new GraphQLClient({
  url: "https://api.example.com/graphql",
  headers: { Authorization: "Bearer token" },
  fetch: globalThis.fetch,
  apq: true, // Automatic Persisted Queries
  fetchPersistedQuery: false, // Fetch persisted queries from storage
  apqHash: "sha256", // Hash algorithm
  retry: { maxRetries: 2 },
  signal: controller.signal,
  links: [
    // Middleware chain
    retryLink({ maxRetries: 3 }),
    authLink({ getToken: () => "..." }),
    loggingLink(),
    errorLink(),
  ],
  onRequest: (req) => console.log(req),
  onResponse: (res) => console.log(res),
});

// Query
const { data, errors } = await client.query<{ user: { name: string } }>(
  gql`
    query GetUser($id: ID!) {
      user(id: $id) {
        name
      }
    }
  `,
  { id: "1" },
);

// Mutation
const result = await client.mutate<{ updateUser: { success: boolean } }>(
  gql`
    mutation UpdateUser($id: ID!, $name: String!) {
      updateUser(id: $id, name: $name) {
        success
      }
    }
  `,
  { id: "1", name: "Alice" },
);

// Subscription (SSE or WebSocket transport)
const sub = await client.subscribe(
  gql`
    subscription OnPrice {
      priceUpdate {
        symbol
        price
      }
    }
  `,
  {},
  { transport: "sse" },
);
for await (const event of sub) {
  console.log(event.data);
}

// Utility
detectOperationType(gql`query { ... }`); // → "query"
extractOperationName(gql`query GetUser { ... }`); // → "GetUser"
```

### Client-Level GraphQL

```ts
const gql = await client.graphql("/graphql", {
  apq: true,
  links: [authLink({ getToken: () => "..." })],
});
const { data } = await gql.query(query, variables);
```

---

## Progress Tracking

```ts
import {
  ProgressTracker,
  withUploadProgress,
  withDownloadProgress,
  withBlobUploadProgress,
  streamWithProgress,
  MultiPartProgressAggregator,
  xhrFetch,
  formatProgress,
  throttleProgress,
  formatBytes,
  formatRate,
  formatETA,
  collectStream,
} from "kinetex/progress";

// Per-request progress
client.post("/upload", largeBlob, {
  onUploadProgress: (ev) => {
    console.log(`${ev.percent}% @ ${formatRate(ev.rate)} — ETA ${formatETA(ev.eta)}`);
  },
});

client.get("/large-file", {
  onDownloadProgress: (ev) => {
    console.log(`Downloaded ${formatBytes(ev.loaded)}/${formatBytes(ev.total)}`);
  },
});

// Standalone progress tracker
const tracker = new ProgressTracker(10_000_000, {
  throttleHz: 10,
  smoothingFactor: 0.3,
  signal: controller.signal,
  onProgress: (snap) => {
    console.log(snap.percent, formatRate(snap.rate), formatETA(snap.eta));
  },
});

tracker.update(500_000); // 500KB transferred
tracker.complete(); // Mark done
tracker.reset(20_000_000); // Reset with new total

// Wrap a ReadableStream with progress tracking
const { stream } = withUploadProgress(readableStream, totalBytes, {
  onProgress: (snap) => {},
});

const { stream } = withDownloadProgress(response, {
  onProgress: (snap) => {},
});

// Blob upload progress
const { stream } = withBlobUploadProgress(blob, {
  onProgress: (snap) => {},
});

const stream = streamWithProgress(readableStream, tracker);

// Collect full stream into Uint8Array
const bytes = await collectStream(readableStream);

// Multi-part progress
const agg = new MultiPartProgressAggregator();
const partId = agg.addPart(0, 500); // part index, bytes
agg.update(partId, 250);
agg.complete(partId);
const total = agg.total(); // ProgressSnapshot with overall progress

// Formatters
formatBytes(1500); // "1.46 KB"
formatRate(2_500_000); // "2.38 MB/s"
formatETA(3661); // "1h 1m 1s"
formatProgress({
  loaded: 500,
  total: 1000,
  percent: 50,
  rate: 1000,
  eta: 500,
  elapsed: 2000,
  done: false,
});
// → "50.0% · 1.00 KB/s · ETA 0.5s"
```

---

## AWS SigV4 Signing

```ts
import {
  SigV4Signer,
  signRequest,
  presignRequest,
  deriveSigningKey,
  staticCredentials,
  envCredentials,
  cachingCredentials,
  imdsCredentials,
  chainCredentials,
  formatAmzDate,
  formatDateStamp,
  sigV4UriEncode,
  detectClockSkew,
  isClockSkewError,
  createS3Signer,
  createAPIGatewaySigner,
  createSTSSigner,
  createDynamoDBSigner,
  signS3PostPolicy,
  initChunkedSigning,
  signChunk,
  signFinalChunk,
} from "kinetex/aws-sigv4";
import type { AWSCredentials, SigningConfig, CredentialProvider } from "kinetex/aws-sigv4";

const signer = new SigV4Signer({
  credentials: {
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    sessionToken: "token", // Optional: for STS/AssumeRole
    expiration: "2024-12-31T23:59:59Z", // Optional: ISO 8601
  },
  region: "us-east-1",
  service: "s3",
  signingDate: new Date(), // Override signing date
  payloadHash: "UNSIGNED-PAYLOAD", // For streaming
  unsignedHeaders: ["x-amz-content-sha256"], // Headers to skip
  presignExpires: 3600, // Presigned URL TTL (seconds)
  doubleEncode: true, // RFC 3986 double-encode (default: true)
  normalizePath: true, // Normalize path before signing (default: true)
});

// Sign a request
const signed = await signer.sign({
  method: "PUT",
  url: "https://my-bucket.s3.amazonaws.com/file.txt",
  headers: { "x-amz-acl": "public-read" },
  body: new Uint8Array([1, 2, 3]),
});

// Presigned URL (no body signing)
const signed = await signer.presign({
  method: "GET",
  url: "https://my-bucket.s3.amazonaws.com/file.txt",
  headers: {},
});

// Standalone helpers
const signed = await signRequest(request, config);
const presignedURL = await presignRequest(request, config);
const key = await deriveSigningKey(credentials, dateStamp, region, service);

// Credential providers
const provider = staticCredentials({ accessKeyId: "...", secretAccessKey: "..." });
const provider = envCredentials(); // AWS_ACCESS_KEY_ID, etc.
const provider = cachingCredentials(innerProvider, 5 * 60_000); // Cache with TTL
const provider = imdsCredentials({ retries: 3 }); // EC2 IMDS
const provider = chainCredentials(envCredentials, imdsCredentials); // Fallback chain

// Specialized signers
const s3Signer = createS3Signer({ credentials, region });
const apiGateway = createAPIGatewaySigner({ credentials, region });
const stsSigner = createSTSSigner({ credentials, region });
const dynamoSigner = createDynamoDBSigner({ credentials, region });

// S3 POST policy
const policy = signS3PostPolicy(credentials, region, new Date(), {
  bucket: "my-bucket",
  key: "uploads/${filename}",
  expires: 3600,
  conditions: [["starts-with", "$key", "uploads/"]],
});

// Chunked upload signing (S3 streaming)
const { sessionToken, dateTime } = await initChunkedSigning(credentials, region, "s3", new Date());
const chunkSignature = await signChunk(
  sessionToken,
  dateTime,
  chunkData,
  chunkIndex,
  previousSignature,
);
const finalSignature = await signFinalChunk(sessionToken, dateTime, chunkIndex, previousSignature);

// Clock skew detection
const skewMs = await detectClockSkew("https://sts.amazonaws.com", credentials);
isClockSkewError(err); // → boolean
```

### Client-Level SigV4

```ts
kinetex({
  baseURL: "https://execute-api.us-east-1.amazonaws.com",
  awsSigning: {
    credentials: { accessKeyId: "...", secretAccessKey: "..." },
    region: "us-east-1",
    service: "execute-api",
  },
});
// All requests are automatically signed via a request interceptor
```

---

## SOCKS5 Proxy

```ts
import {
  createSocks5Tunnel,
  parseSocks5Url,
  socks5Connector,
  denoTcpConnector,
  nodeTcpConnector,
  Socks5Error,
} from "kinetex/socks5";
import type { Socks5ProxyConfig, Socks5Tunnel, Socks5Target, TcpConnector } from "kinetex/socks5";

// Standalone tunnel
const tunnel = await createSocks5Tunnel({
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
  username: "user", // Optional: RFC 1929 auth
  password: "pass",
  connectTimeout: 10_000, // Connection timeout
  retries: 2, // Connection retries
});

const response = await tunnel.send({
  url: "https://api.example.com/data",
  method: "GET",
  headers: { Accept: "application/json" },
  body: null,
  signal: null,
  meta: {},
});

// Parse SOCKS5 URL
const config = parseSocks5Url("socks5://user:pass@127.0.0.1:1080");

// Runtime-specific TCP connectors
const nodeConnector: TcpConnector = nodeTcpConnector; // Node.js
const denoConnector: TcpConnector = denoTcpConnector; // Deno
const customConnector: TcpConnector = socks5Connector({
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
}); // Returns a TcpConnector function

// Client-level proxy
kinetex({
  proxy: { url: "socks5://127.0.0.1:1080", username: "user", password: "pass" },
});
```

---

## Digest Authentication

Full RFC 7616 implementation with MD5 (pure JS), SHA-256, and SHA-512-256:

```ts
import {
  parseDigestChallenge,
  computeDigestResponse,
  formatDigestAuth,
  createDigestAuthorization,
} from "kinetex/digest";
import type { DigestChallenge } from "kinetex/digest";

const authHeader = await createDigestAuthorization(
  `Digest realm="test", nonce="abc123", algorithm=MD5, qop="auth"`,
  "username",
  "password",
  "GET",
  "/resource",
);
// → 'Digest username="username", realm="test", nonce="abc123", uri="/resource", response="...", algorithm=MD5, qop=auth, nc=00000001, cnonce="..."'
```

---

## Structured Logging

```ts
import {
  HTTPLogger,
  ConsoleTransport,
  JSONTransport,
  Redactor,
  BatchingTransport,
  RemoteTransport,
  MultiTransport,
  createLogger,
  createProductionLogger,
  createDevelopmentLogger,
  LogLevel,
  toOTelSpan,
} from "kinetex/logging";
import type { LogEntry, LogTransport, LoggerConfig } from "kinetex/logging";

const logger = createLogger({
  level: "info", // "trace" | "debug" | "info" | "warn" | "error" | "silent"
  transports: [
    new ConsoleTransport({ pretty: true }), // Console output
    new JSONTransport({ file: "requests.log" }), // File output
  ],
  redact: ["authorization", "cookie", "x-api-key", /secret.*/i], // Redaction patterns
  redactBody: true, // Redact request/response bodies
  bodyTruncate: 1000, // Truncate bodies to N chars
  requestIdHeader: "x-request-id", // Extract request ID from this header
  sampling: 0.5, // Log only 50% of requests
  filter: (entry) => entry.status !== 200, // Only log non-200 responses
});

// Client-level logging
kinetex({
  logger: { level: "info" }, // Auto-creates logger
  logger: false, // Disable logging
});

// Batching transport (async flush)
const batch = new BatchingTransport({
  maxBatch: 100,
  flushIntervalMs: 5000,
});

// Remote transport
const remote = new RemoteTransport({
  url: "https://logging.example.com/ingest",
  headers: { Authorization: "Bearer token" },
});

// Multi transport (fan-out)
const multi = new MultiTransport([new ConsoleTransport(), new JSONTransport()]);

// Convert log entry to OpenTelemetry span
const span = toOTelSpan(entry);
```

---

## HAR Recording

HTTP Archive 1.2 format with O(1) ring buffer:

```ts
const client = kinetex({ baseURL: "https://api.example.com", har: true });

await client.get("/users");
await client.post("/posts", { title: "Test" });

const har = client.getHAR();
// HARLog { version: "1.2", creator: { name: "kinetex", version: "0.0.3" }, entries: [...] }

// Each HAREntry contains:
// startedDateTime, time, request (method, url, httpVersion, headers, queryString, bodySize),
// response (status, statusText, httpVersion, headers, content, redirectURL, bodySize),
// timings (send, wait, receive), cache

// Clear entries
client.clearHAR();
```

---

## OpenTelemetry Tracing

```ts
// With @opentelemetry/api
import { trace } from "@opentelemetry/api";
client.setTracer(trace.getTracer("my-service"));

// All outgoing requests automatically get:
// - W3C traceparent header injection
// - HTTP span creation (semantic conventions)
// - Error recording on failures
// - Status code attributes

// Manual trace propagation (no OTel SDK)
client.get("/users", { meta: { traceId: "abc123" } });

// The OTelTracer and OTelSpan interfaces are minimal and compatible with @opentelemetry/api:
import type { OTelTracer, OTelSpan } from "kinetex";

// Custom tracer implementation
client.setTracer({
  startSpan(name, options?) {
    return {
      spanContext() {
        return { traceId: "x", spanId: "y", traceFlags: 1 };
      },
      setAttribute(key, value) { return this; },
      setStatus(status) { return this; },
      recordException(err) { return this; },
      end() {},
    };
  },
});
```

---

## Pipeline Trace

Observability hook for every processing stage:

```ts
kinetex({
  onPipelineTrace: (step) => {
    console.log(
      `[${step.stage}] ${step.requestId} attempt=${step.attempt} ${step.event} +${step.elapsedMs}ms`,
    );
  },
});
```

Pipeline stages in order:

1. `request_interceptors` — request interceptor pipeline
2. `lifecycle_before` — `onBeforeRequest` hooks
3. `auth` — auth header injection
4. `cache_lookup` — cache read (short-circuits on HIT)
5. `transport_send` — actual HTTP send
6. `response_decompression` — content-encoding decompression
7. `response_parse` — body parsing (JSON, text, binary)
8. `cache_store` — cache write
9. `response_interceptors` — response interceptor pipeline
10. `lifecycle_after` — `onAfterResponse` hooks
11. `retry` — retry decision + delay (on failure only)
12. `error_interceptors` — error interceptor pipeline (on error only)

---

## Transport Layer

### FetchTransport

Universal fetch-based transport for all runtimes:

```ts
import { FetchTransport, createTransport } from "kinetex/core";
import type { FetchTransportOptions } from "kinetex/core";

const transport = new FetchTransport({
  fetchFn: globalThis.fetch, // Custom fetch implementation
  strict: true, // Throw on invalid headers (default: false)
  onDroppedHeader: (name, value) => log(`Dropped: ${name}`),
});

const raw: RawResponse = await transport.send(request);
// RawResponse { status, statusText, headers, body, url, redirected, httpVersion, alreadyDecompressed }
```

### NodeHTTP2Transport

Node.js HTTP/2 transport with session pooling, ALPN fallback, and keepalive pings:

```ts
import { NodeHTTP2Transport } from "kinetex/core";

const transport = new NodeHTTP2Transport({
  sessionTTLMs: 5 * 60_000, // Session lifetime (default: 300_000)
  pingIntervalMs: 30_000, // Keepalive ping interval (default: 30_000)
  maxSessions: 100, // Max concurrent sessions (default: 100)
  connectTimeoutMs: 30_000, // Connection timeout (default: 30_000)
  requestTimeoutMs: 30_000, // Per-request stream timeout (default: 30_000)
  strict: false, // Strict header validation
  onDroppedHeader: (name, value) => {},
});

transport.destroy(); // Close all sessions and timers
```

Features:

- Session pooling per-origin with LRU eviction
- Concurrent creation serialization (only one session per origin)
- ALPN negotiation failure → automatic HTTP/1.1 fallback via `FetchTransport`
- Configurable connect and request timeouts
- Keepalive pings with dead-session detection
- Iterative redirect following (not recursive)
- Backpressure-aware body writes (awaits `drain` events)

### Transport Factory

```ts
import { createTransport } from "kinetex/core";

// Auto-selects based on runtime:
// - Node.js with preferHTTP2=true → NodeHTTP2Transport (with HTTP/1.1 fallback)
// - All other runtimes → FetchTransport
const transport = createTransport(
  globalThis.fetch, // fetch function
  true, // prefer HTTP/2
  { sessionTTLMs: 300_000 }, // session pool options
  { strict: true }, // strict header validation
);
```

### Raw Response

```ts
interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  url: string;
  redirected: boolean;
  httpVersion: HTTPVersion;
  alreadyDecompressed?: boolean; // True if runtime auto-decompressed
}

interface Transport {
  send(request: KinetexRequest): Promise<RawResponse>;
}
```

### Core Utilities

```ts
import {
  sendWithTimeout,
  readRawBody,
  parseBody,
  decompressBodyStream,
  HAS_NATIVE_FETCH,
  HTTP_STATUS_TEXTS,
} from "kinetex/core";
import type { FetchTransportOptions } from "kinetex/core";

// Timeout wrapper
const raw = await sendWithTimeout(transport, request, 5000); // → RawResponse, throws TimeoutError

// Read body stream with size limit
const body = await readRawBody(stream, maxBytes, url, signal); // → Uint8Array, throws SizeLimitError

// Parse body by content-type
const data = parseBody<MyType>(rawBody, contentType, customParser?, onParseFailure?, headers?, url?);

// Decompress body stream
const decompressed = await decompressBodyStream(body, headers);

// HTTP status text lookup
HTTP_STATUS_TEXTS[404]; // "Not Found"
HTTP_STATUS_TEXTS[500]; // "Internal Server Error"
```

---

## Runtime Detection

```ts
import {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  setRuntime,
  getEffectiveRuntime,
  NodeHTTP2Transport,
  FetchTransport,
} from "kinetex/core";

detectRuntime(); // "node" | "deno" | "bun" | "browser" | "cloudflare-workers" | "edge" | "unknown"
RUNTIME; // Cached runtime value (detected once at module load)
IS_NODE; // True if Node.js
HAS_NATIVE_FETCH; // True if globalThis.fetch is available

// Override for testing
setRuntime("cloudflare-workers"); // Force runtime for test environments
setRuntime(null); // Restore auto-detection
getEffectiveRuntime(); // Returns override if set, else RUNTIME

// Also from utils.ts:
import { getRuntime, isNodeEnvironment, isBrowserEnvironment, hasNativeFetch } from "kinetex";
```

---

## Child Clients

```ts
const parent = kinetex({
  baseURL: "https://api.example.com",
  headers: { "X-Version": "1.0" },
  timeout: 10000,
});

const admin = parent.extend({
  baseURL: "https://api.example.com/admin",
  headers: { "X-Admin": "true" },
  auth: { type: "bearer", token: adminToken },
});
// Inherits: timeout, headers (merged), params (merged), interceptors (merged),
// circuit breaker, dedup, OTel tracer from parent
```

---

## Batch Queue

High-throughput request batching:

```ts
import { BatchQueue } from "kinetex";

const batch = new BatchQueue(client, {
  maxBatch: 50, // Flush when 50 requests queued (default: 100)
  flushMs: 10, // Flush after 10ms even if batch not full (default: 0)
});

// Fire many requests — they batch automatically
const [r1, r2, r3] = await Promise.all([
  batch.enqueue("/events", "POST", { body: JSON.stringify(e1) }),
  batch.enqueue("/events", "POST", { body: JSON.stringify(e2) }),
  batch.enqueue("/events", "POST", { body: JSON.stringify(e3) }),
]);

batch.flush(); // Force flush pending requests
batch.pendingCount; // Number of queued requests
```

---

## URL Utilities

```ts
import {
  URLBuilder,
  percentEncode,
  percentDecode,
  encodePathComponent,
  encodeQueryValue,
  stringifyQuery,
  parseQuery,
  mergeQuery,
  pickQuery,
  omitQuery,
  joinPath,
  normalizePath,
  pathSegments,
  fillPathParams,
  normalizeURL,
  compilePattern,
  expandTemplate,
  getOrigin,
  isSameOrigin,
  isSameSite,
  isAbsolute,
  isRelative,
  isHTTPS,
  isHTTP,
  isDataURL,
  isBlobURL,
  isLocalhost,
  safeParseURL,
  withTrailingSlash,
  withoutTrailingSlash,
  stripHash,
  stripQuery,
  urlExtension,
  urlFilename,
  redactURL,
  resolveURL,
  relativeURL,
  parseDataURL,
  buildDataURL,
  diffURLs,
} from "kinetex/url";
import type {
  ParsedURL,
  URLBuilderOptions,
  URLPattern,
  URLPatternMatch,
  URLDiff,
  DataURLParts,
} from "kinetex/url";

// URL Builder (fluent, immutable)
const url = URLBuilder.from("https://api.example.com")
  .withPathname("/v1/users")
  .appendPath("42", "posts")
  .setParam("page", "1")
  .setParam("limit", "10")
  .omitParams("internal")
  .redactParams("token")
  .sortParams()
  .addTrailingSlash()
  .toString();
// → "https://api.example.com/v1/users/42/posts/?limit=10&page=1&token=REDACTED"

URLBuilder.https("api.example.com", "/v1/users"); // Factory
URLBuilder.http("api.example.com"); // Factory

// Properties:
url.href;
url.protocol;
url.hostname;
url.host;
url.port;
url.pathname;
url.search;
url.hash;
url.origin;
url.searchParams; // → URLSearchParams
url.queryObject; // → Record<string, string | string[]>

// Percent encoding
percentEncode("hello world"); // "hello%20world"
percentEncode("a b", true); // "a%20b" (reserved not encoded)
percentDecode("hello%20world"); // "hello world"

// Query string
stringifyQuery({ a: "1", b: ["2", "3"] }, { sort: true, arrayFormat: "bracket" });
// → "a=1&b[]=2&b[]=3"
parseQuery("?a=1&b=2"); // { a: "1", b: "2" }
mergeQuery({ a: "1" }, { b: "2" });
pickQuery({ a: "1", b: "2", c: "3" }, "a", "c"); // { a: "1", c: "3" }
omitQuery({ a: "1", b: "2" }, "a"); // { b: "2" }

// Path utilities
joinPath("api", "v1", "users"); // "/api/v1/users"
normalizePath("//api///v1/./users/.."); // "/api/v1"
pathSegments("/api/v1/users"); // ["api", "v1", "users"]
fillPathParams("/users/:id/posts/:postId", { id: "42", postId: "99" });
// → "/users/42/posts/99"

// URL normalization
normalizeURL("https://API.EXAMPLE.COM:443/path/", { sortParams: true, removeFragment: true });

// URL pattern matching
const pattern = compilePattern("/users/:id/posts/:postId");
pattern.test("/users/42/posts/99"); // true
pattern.match("/users/42/posts/99"); // { params: { id: "42", postId: "99" }, wildcards: [], groups: {} }

// Classification
isAbsolute("https://example.com"); // true
isRelative("/path"); // true
isHTTPS("https://example.com"); // true
isHTTP("http://example.com"); // true
isDataURL("data:text/plain,hello"); // true
isBlobURL("blob:..."); // true
isLocalhost("http://localhost:8080"); // true

// URL resolution
resolveURL("/v1/users", "https://api.example.com"); // "https://api.example.com/v1/users"
relativeURL("https://api.example.com/v1/users", "https://api.example.com"); // "/v1/users"

// Data URLs
parseDataURL("data:image/png;base64,iVBOR..."); // { mediaType: "image/png", isBase64: true, data: "iVBOR..." }
buildDataURL("hello", "text/plain"); // "data:text/plain;base64,aGVsbG8="

// Redaction
redactURL("https://api.example.com?token=secret&key=123", "token", "key");
// → "https://api.example.com?token=REDACTED&key=REDACTED"

// Diff
diffURLs("https://a.com/path?a=1", "https://b.com/other?b=2");
// → { hostname: ["a.com", "b.com"], pathname: ["/path", "/other"], addedParams: { b: "2" }, ... }

// Safe parse
safeParseURL("not a url"); // null

// Misc
stripHash("https://example.com#section"); // "https://example.com"
stripQuery("https://example.com?a=1"); // "https://example.com"
urlExtension("https://example.com/file.txt"); // "txt"
urlFilename("https://example.com/file.txt"); // "file.txt"
withTrailingSlash("https://example.com/path"); // "https://example.com/path/"
withoutTrailingSlash("https://example.com/path/"); // "https://example.com/path"
```

---

## Header Utilities

```ts
import {
  HeaderName, // All standard header names as constants
  HttpHeaders, // Full headers class with typed accessors
  RichHeaders, // Enhanced headers with parsing methods
  createHeaders, // Create mutable headers
  createRequestHeaders, // Create request headers
  createResponseHeaders, // Create response headers
  createImmutableHeaders, // Create immutable headers

  // Content
  formatContentType,
  parseContentDisposition,
  formatContentDisposition,
  parseContentLanguage,

  // Cache
  parseCacheControl,
  formatCacheControl,

  // Auth
  parseAuthorization,
  parseWWWAuthenticate,
  formatBearer,
  formatBasic,

  // Negotiation
  parseAccept,
  parseAcceptEncoding,
  parseAcceptLanguage,
  negotiateContentType,

  // Range
  parseRange,
  parseContentRange,

  // Links
  parseLinkHeader,
  formatLinkHeader,

  // Forwarded
  parseForwarded,
  normalizeForwardedHeaders,
  getClientIP,

  // Retry
  parseRetryAfter,

  // Security
  parseHSTS,
  formatHSTS,
  parseCSP,
  formatCSP,
  parseServerTiming,
  formatServerTiming,
  parseAltSvc,
  parseWarning,
  parseParams,
  securityHeaders, // Recommended security headers map
  corsHeaders, // CORS headers map

  // Conversion
  fromNodeHeaders, // node:http.IncomingMessage → Record
  toNodeHeaders, // Record → node:http.OutgoingHttpHeaders
  fromWebHeaders, // fetch Headers → Record
} from "kinetex/headers";

// HeaderName constants
HeaderName.ContentType; // "content-type"
HeaderName.ContentLength; // "content-length"
HeaderName.Authorization; // "authorization"
HeaderName.CacheControl; // "cache-control"
HeaderName.ETag; // "etag"
// ... all standard headers

// Cache-Control parsing
parseCacheControl("public, max-age=3600, stale-while-revalidate=300");
// → { public: true, "max-age": 3600, "stale-while-revalidate": 300 }
formatCacheControl({ public: true, "max-age": 3600 }); // "public, max-age=3600"

// Content-Type
formatContentType("application/json", { charset: "utf-8" });
// → "application/json; charset=utf-8"

// Security headers preset
securityHeaders; // { "x-content-type-options": "nosniff", "x-frame-options": "DENY", ... }
corsHeaders; // { "access-control-allow-origin": "*", ... }
```

---

## Response Parsing Utilities

```ts
import {
  readJSON,
  readText,
  readBytes,
  readStream,
  assertOk,
  assertOkJSON,
  parseContentType,
  isJSON,
  isText,
  decodeBody,
  readBlob,
  readNDJSON,
  readJSONStream,
  readFormData,
  readBodyWithLimit,
  parseMultipartResponse,
  diffResponses,
  HTTPResponseError,
  ResponseSizeLimitError,
  ContentTypeError,
  ResponseDecodeError,
  normalizeResponse,
  isBinary,
  decompressStream,
  applyDecompression,
  extractServerTiming,
  createLimitedReader,
} from "kinetex/response";
import type { ResponseParseOptions, SizeLimitConfig } from "kinetex/response";

// Read helpers
const json = await readJSON(response); // Parse as JSON
const text = await readText(response); // Parse as text
const bytes = await readBytes(response); // Read as Uint8Array
const stream = await readStream(response); // Get ReadableStream
const blob = await readBlob(response); // Read as Blob
const ndjson = await readNDJSON(response); // Parse NDJSON line-by-line
const formData = await readFormData(response); // Parse as FormData

// JSON with assertion
const data = await assertOkJSON<MyType>(response); // Throws on non-2xx
await assertOk(response); // Throws on non-2xx

// Size limiting
const limited = await readBodyWithLimit(response, {
  maxBytes: 1_000_000,
  onExceed: "throw", // "throw" | "truncate" | "abort"
  onExceedCallback: (bytesRead, limit) => log(`Exceeded ${limit}`),
});

const reader = createLimitedReader(stream, {
  maxBytes: 1_000_000,
  onExceed: "throw",
});

// Multipart
const parts = await parseMultipartResponse(response, boundary);

// Decompression
const decompressed = await decompressStream(compressedStream, "gzip");
const raw = await applyDecompression(rawBody, headers);

// Server-Timing
const timings = extractServerTiming(headers);
// → { dur, desc, ... }

// Response diffing
const diff = diffResponses(res1, res2);

// Content type
parseContentType("application/json; charset=utf-8");
// { type: "application/json", parameters: { charset: "utf-8" } }
isJSON(response); // true if content-type is JSON
isText(response); // true if content-type is text/*
isBinary(response); // true if binary content-type
```

---

## Safe JSON Parsing

DoS-protected JSON parsing with configurable limits:

```ts
import { safeJSONParse, tryParseJSON, parseUntrustedJSON } from "kinetex";
import type { SafeJSONParseOptions, SafeJSONParseResult, ErrorContext } from "kinetex";

// Safe parsing with limits
const result: SafeJSONParseResult<User[]> = safeJSONParse(jsonString, {
  maxDepth: 32,
  maxStringLength: 10_000_000, // 10MB
  maxArrayLength: 10_000,
  maxObjectKeys: 1_000,
  allowNonFinite: false,
});
if (result.success) {
  console.log(result.value);
} else {
  console.error(result.error, result.message);
}

// Try parse (returns string fallback on failure)
const data = tryParseJSON<User[]>(jsonString); // User[] | string

// Reduced limits for untrusted input
const result = parseUntrustedJSON(untrustedJson);
// maxDepth: 16, maxStringLength: 1MB, maxArrayLength: 1000, maxObjectKeys: 100
```

---

## Type Guards & Utilities

General-purpose utility functions for type-safe request/response handling:

```ts
import {
  // Runtime
  getRuntime,
  isNodeEnvironment,
  isBrowserEnvironment,
  hasNativeFetch,

  // Type guards
  isUint8Array,
  isArrayBuffer,
  isReadableStream,
  isHeaders,
  isAbortSignal,
  isPlainObject,
  isFormData,
  isBlob,
  isURLSearchParams,
  isAbortError,

  // Header validation
  isValidHeaderName,
  isValidHeaderValue,

  // URL security
  isSafeURL,
  sanitizeURL,

  // Error utilities
  createStructuredError,
  formatError,

  // Performance / timing
  perfNow,
  sleep,
  mergeSignals,

  // Binary data
  concatUint8Arrays,
  toUint8Array,
  uint8ArrayToBase64,

  // Object utilities
  deepClone,
  normalizeHeaders,
} from "kinetex";

// Type guards
isUint8Array(data);        // data is Uint8Array
isPlainObject(obj);        // obj is Record<string, unknown>
isAbortSignal(signal);     // signal is AbortSignal
isFormData(data);          // data is FormData
isBlob(data);              // data is Blob
isAbortError(err);         // boolean
isValidHeaderName("x-foo"); // boolean
isValidHeaderValue("bar");  // boolean

// Safe URL checking
isSafeURL("https://evil.com"); // boolean — checks for dangerous protocols
sanitizeURL("javascript:alert(1)"); // string — stripped or redacted

// Error construction
const err = createStructuredError("EVALIDATION", "Invalid config", {
  request: myRequest,
  cause: originalError,
});
formatError(err); // "EVALIDATION: Invalid config"

// Timing
const start = perfNow(); // High-resolution monotonic time
await sleep(1000); // Promise-based delay
const signal = mergeSignals(signal1, signal2); // Combined AbortSignal

// Binary
const combined = concatUint8Arrays([buf1, buf2]);
const uint8 = toUint8Array(arrayBuffer);
const b64 = uint8ArrayToBase64(uint8);

// Object
const clone = deepClone(original);
const normalized = normalizeHeaders(rawHeaders); // Lowercase keys
```

---

## Error Handling

```ts
import {
  KinetexError,
  HTTPStatusError,
  TimeoutError,
  SizeLimitError,
  AbortError,
  NetworkError,
  ValidationError,
  AuthError,
  ProxyError,
  RedirectError,
} from "kinetex";
import { validateErrorCode, toRequestId } from "kinetex";

try {
  await client.get("/data");
} catch (err) {
  if (err instanceof HTTPStatusError) {
    // Server returned 4xx/5xx
    console.log(err.status); // HTTP status code
    console.log(err.isClientError); // 4xx?
    console.log(err.isServerError); // 5xx?
    console.log(err.response); // KinetexResponse
  } else if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof SizeLimitError) {
    console.log(`${err.bytesRead} > ${err.limit}`);
  } else if (err instanceof NetworkError) {
    // Connectivity issue
  } else if (err instanceof AbortError) {
    // Cancelled
  } else if (err instanceof AuthError) {
    // Auth failed
  } else if (err instanceof ProxyError) {
    // Proxy error
  } else if (err instanceof RedirectError) {
    // Redirect error
  } else if (err instanceof KinetexError) {
    console.log(err.code); // Machine-readable error code
    console.log(err.request); // Originating request
    console.log(err.response); // Response (if available)
    console.log(err.cause); // Underlying cause
    console.log(err.isNetwork, err.isTimeout, err.isAbort, err.isHTTPError, err.isProxy);
  }
}

// KinetexError base class
class KinetexError extends Error {
  readonly code: KinetexErrorCode;
  readonly request?: KinetexRequest;
  readonly response?: KinetexResponse<unknown>;
  readonly cause?: unknown;
  get isNetwork(): boolean;
  get isProxy(): boolean;
  get isTimeout(): boolean;
  get isAbort(): boolean;
  get isHTTPError(): boolean;
  get status(): number | null;
}

// Validate error codes
validateErrorCode("ENETWORK"); // "ENETWORK"
validateErrorCode("INVALID"); // undefined
```

### Error Codes

| Code          | Error Class       | Description                       |
| ------------- | ----------------- | --------------------------------- |
| `ENETWORK`    | `NetworkError`    | Server/endpoint unreachable       |
| `ETIMEOUT`    | `TimeoutError`    | Request/connection timeout        |
| `EABORT`      | `AbortError`      | Request cancelled by caller       |
| `EHTTPSTATUS` | `HTTPStatusError` | Server returned 4xx/5xx           |
| `ESIZELIMIT`  | `SizeLimitError`  | Response body exceeded size limit |
| `EPARSE`      | —                 | Failed to parse response body     |
| `EVALIDATION` | `ValidationError` | Invalid request configuration     |
| `EAUTH`       | `AuthError`       | Authentication failed             |
| `EPROXY`      | `ProxyError`      | Proxy configuration error         |
| `EREDIRECT`   | `RedirectError`   | Redirect error                    |
| `EUNKNOWN`    | `KinetexError`    | Unknown/unexpected                |

---

## Deep Imports

All sub-modules are tree-shakeable with deep import paths:

```ts
// Core
import { kinetex, Kinetex, FluentRequest, BatchQueue, createMethodCircuitBreakerKey } from "kinetex";
import type { KinetexConfig, KinetexRequest, KinetexResponse, SendOptions, RetryConfig, RetryContext, AuthConfig, ProxyConfig, HTTPMethod, HTTPVersion, HeadersInit, QueryParams, QueryValue, BodyInit, Runtime, RequestId, Brand } from "kinetex";
// Errors
import { KinetexError, HTTPStatusError, TimeoutError, SizeLimitError, AbortError, NetworkError, ValidationError, AuthError, ProxyError, RedirectError } from "kinetex";
// Types
import type { InterceptorContext, HookContext, LifecycleHooks, RequestInterceptor, ResponseInterceptor, ErrorInterceptor, ProgressEvent, ProgressCallback, PipelineStep, PipelineStageName, CacheRequestConfig, HAREntry, HARLog } from "kinetex";

// Sub-modules (tree-shakeable):
import { ... } from "kinetex/cache";
import { ... } from "kinetex/sse";
import { ... } from "kinetex/graphql";
import { ... } from "kinetex/pagination";
import { ... } from "kinetex/progress";
import { ... } from "kinetex/logging";
import { ... } from "kinetex/response";
import { ... } from "kinetex/headers";
import { ... } from "kinetex/url";
import { ... } from "kinetex/aws-sigv4";
import { ... } from "kinetex/socks5";
import { ... } from "kinetex/cookiejar";
import { ... } from "kinetex/circuit-breaker";
import { ... } from "kinetex/dedup";
import { ... } from "kinetex/digest";
import { ... } from "kinetex/ws";
import { ... } from "kinetex/lifecycle";
import { ... } from "kinetex/interceptors";
import { ... } from "kinetex/core";
import { ... } from "kinetex/worker";

// Types only from sub-modules:
import type { CacheEntry, CacheStats, CacheConfig, CacheStorageAdapter } from "kinetex/cache";
import type { SSEEvent, SSEClientConfig, JSONSSEEvent } from "kinetex/sse";
import type { GraphQLRequest, GraphQLResponse, GraphQLError, GraphQLClientConfig, GraphQLLink, GraphQLLinkNext } from "kinetex/graphql";
import type { Page, PaginationState } from "kinetex/pagination";
import type { LogEntry, LogTransport, LoggerConfig } from "kinetex/logging";
import type { ResponseParseOptions, SizeLimitConfig } from "kinetex/response";
import type { Cookie, CookieJSON } from "kinetex/cookiejar";
import type { CircuitState, CircuitBreakerConfig, CircuitBreakerState, FailureFilter } from "kinetex/circuit-breaker";
import type { DedupOptions } from "kinetex/dedup";
import type { DigestChallenge } from "kinetex/digest";
import type { WSState, WSMessage, WSClientConfig, WSCloseEvent, WSBackpressureInfo, WSSubscribedRoom } from "kinetex/ws";
import type { HookRequest, HookResponse, HookError, HookOptions, BeforeRequestHook, AfterRequestHook, BeforeResponseHook, AfterResponseHook, OnErrorHook, OnRetryHook, OnRedirectHook, OnUploadProgressHook, OnDownloadProgressHook, AroundHook } from "kinetex/lifecycle";
import type { AWSCredentials, SigningConfig, CredentialProvider } from "kinetex/aws-sigv4";
import type { Socks5ProxyConfig, Socks5Tunnel, Socks5Target, TcpConnector } from "kinetex/socks5";
import type { FetchTransportOptions } from "kinetex/core";
import type { OTelTracer, OTelSpan } from "kinetex";
import type { SafeJSONParseOptions, SafeJSONParseResult, ErrorContext } from "kinetex";
import type { ParsedURL, URLBuilderOptions, URLPattern, URLPatternMatch, URLDiff, DataURLParts } from "kinetex/url";
```

---

## Worker Entry Point

Cloudflare Workers / Vercel Edge / WinterCG safe entry point:

```ts
import { kinetex, Kinetex, FluentRequest, BatchQueue, createMethodCircuitBreakerKey } from "kinetex/worker";
// Only exports types and classes safe for edge environments.
// No Node.js-specific imports, no HTTP/2 transport.
// Also exports error classes: KinetexError, HTTPStatusError, TimeoutError, NetworkError, RedirectError

const client = kinetex({ baseURL: "https://api.example.com" });
// Uses FetchTransport (globalThis.fetch) automatically.
// Defaults to HTTP/1.1 for maximum edge compatibility.
```

```ts
// Cloudflare Workers example
export default {
  async fetch(request: Request): Promise<Response> {
    const client = kinetex({ baseURL: "https://api.example.com" });
    const res = await client.get("/data");
    return new Response(JSON.stringify(res.data), {
      headers: { "content-type": "application/json" },
    });
  },
};
```

---

## Browser Usage

```html
<!-- UMD script (window.kinetex) -->
<script src="https://unpkg.com/kinetex/dist/browser/kinetex.min.js"></script>
<script>
  const client = kinetex.default({ baseURL: "/api" });
  client.get("/users").then((res) => console.log(res.data));
</script>

<!-- ESM -->
<script type="module">
  import { kinetex } from "https://unpkg.com/kinetex/dist/browser/kinetex.esm.js";
  const client = kinetex({ baseURL: "/api" });
</script>
```

From npm (with bundler):

```ts
import { kinetex } from "kinetex/browser";
// browser-specific entry — no Node.js fallbacks
```

---

## Runtime Compatibility

| Feature                     | Node 18+ | Node 22+ | Deno      | Bun | Browser      | CF Workers | Vercel Edge |
| --------------------------- | -------- | -------- | --------- | --- | ------------ | ---------- | ----------- |
| HTTP/1.1 fetch              | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |
| HTTP/2 (fetch)              | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |
| HTTP/2 (NodeHTTP2Transport) | ✗        | ✓        | ✗         | ✗   | ✗            | ✗          | ✗           |
| HTTP/3 (detection)          | —        | —        | —         | —   | experimental | ✓          | —           |
| WebSocket (WSClient)        | ✓        | ✓        | ✓         | ✓   | ✓            | partial    | ✗           |
| SOCKS5 proxy                | ✓        | ✓        | ✓         | ✓   | ✗            | ✗          | ✗           |
| Blob                        | ✓        | ✓        | ✓         | ✓   | ✓            | guarded    | guarded     |
| DOMException                | ✓        | ✓        | ✓         | ✓   | ✓            | guarded    | guarded     |
| Buffer                      | ✓        | ✓        | ✓         | ✓   | ✗            | ✗          | ✗           |
| crypto.subtle               | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |
| ReadableStream              | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |
| URLPattern                  | —        | —        | ✓         | —   | ✓            | ✓          | —           |
| Brotli decompression        | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |
| Gzip/deflate decompression  | ✓        | ✓        | ✓         | ✓   | ✓            | ✓          | ✓           |

---

## Resource Cleanup

```ts
client.destroy();
// Closes all HTTP/2 sessions (NodeHTTP2Transport.destroy())
// Closes all tracked WebSocket connections
// Clears cache
// Clears dedup map
// Clears circuit breakers
// Clears all interceptors
// Nullifies cookie jar and logger references
```

---

## License

MIT
