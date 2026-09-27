<div align="center">

<img src="https://raw.githubusercontent.com/GlobalTechInfo/Database/main/images/kinetex.png" alt="kinetex" width="100%" />

[![NPM](https://img.shields.io/npm/v/kinetex.svg)](https://www.npmjs.com/package/kinetex)
[![JSR](https://jsr.io/badges/@kinetexjs/kinetex)](https://jsr.io/@kinetexjs/kinetex)
[![codecov](https://codecov.io/gh/kinetexjs/kinetex/branch/main/graph/badge.svg)](https://codecov.io/gh/kinetexjs/kinetex)
[![Downloads](https://img.shields.io/npm/dw/kinetex?style=flat-square&label=Downloads&color=green)](https://npmjs.com/package/kinetex)

</div>

**Feature-rich, universal TypeScript HTTP client.** Zero dependencies. One codebase, every runtime.

---

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
// A plain object is JSON-encoded automatically (content-type: application/json).
// Set `content-type` yourself to send the value as an already-prepared body.
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
  baseURL: "https://api.example.com/v1", // Base URL for relative paths
  headers: { "X-Version": "1.0" }, // Default headers
  params: { api_key: "xxx" }, // Default query params
  timeout: 10000, // Timeout in ms (default: 30000, 0 = no timeout)
  httpVersion: "HTTP/2", // "HTTP/1.1" | "HTTP/2" (default: "HTTP/2")
  throwOnError: true, // Throw on 4xx/5xx (default: true)
  followRedirects: true, // Follow redirects (default: true; false returns the 3xx as-is)
  maxRedirects: 20, // Max redirect hops (default: 20; 0 disables following)
  httpsOnly: false, // Reject non-HTTPS URLs
  maxResponseSize: 10_000_000, // Response body size limit (0 = no limit)
  maxRequestSize: 10_000_000, // Request body size limit (0 = no limit)
  strictHeaders: false, // Throw on invalid headers vs warn+drop
  onPipelineTrace: (step) => console.log(step), // Pipeline observability callback
  onSWRError: (err, req) => log(err), // Background SWR revalidation error callback

  // ── Auth ──
  auth: { type: "bearer", token: "..." },
  awsSigning: {
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    region: "us-east-1",
    service: "s3",
  },

  // ── Retry ──
  retry: { maxRetries: 3, baseDelayMs: 300, statuses: [408, 429, 500, 502, 503, 504] },

  // ── Rate Limit ──
  rateLimit: { limit: 100, windowMs: 60_000, queue: true, maxQueue: 100 },

  // ── Proxy ──
  // NOTE: `proxy` fails fast — kinetex's built-in transports cannot route
  // through it. Use the `fetch` option with a proxy-capable agent for
  // HTTP(S) proxies, or createSocks5Tunnel() from "kinetex/socks5" for SOCKS5.
  // proxy: { url: "socks5://127.0.0.1:1080" },  // → throws with guidance

  // ── Cache ──
  cache: { maxEntries: 500, defaultTtlMs: 60_000 }, // see "Caching" for the full CacheConfig

  // ── Cookie Jar ──
  cookieJar: true, // Auto-manage cookies

  // ── Logging ──
  logger: { level: "info" },

  // ── HAR Recording ──
  har: true, // Enable HTTP Archive recording

  // ── Interceptors ──
  interceptors: {
    request: [myReqInterceptor],
    response: [myResInterceptor],
    error: [myErrInterceptor],
  },

  // ── Lifecycle Hooks ──
  hooks: {
    onBeforeRequest: [
      (req, ctx) => {
        /* ... */
      },
    ],
    onAfterRequest: [
      (req, ctx) => {
        /* ... */
      },
    ],
    onBeforeResponse: [
      (res, ctx) => {
        /* ... */
      },
    ],
    onAfterResponse: [
      (res, ctx) => {
        /* ... */
      },
    ],
    onError: [
      (err, ctx) => {
        /* ... */
      },
    ],
    onRetry: [
      (ctx) => {
        /* ... */
      },
    ],
    onUploadProgress: [
      (ev) => {
        /* ... */
      },
    ],
    onDownloadProgress: [
      (ev) => {
        /* ... */
      },
    ],
  },

  // ── Response/Request Transforms ──
  transformResponse: (data, res) => data, // Global response transformer
  transformRequest: (req) => req, // Global request transformer

  // ── Circuit Breaker Key ──
  circuitBreakerKeyFn: (req) => `${req.method}:${new URL(req.url).origin}`,

  // ── Custom fetch ──
  fetch: myCustomFetch, // Custom fetch implementation

  // ── WebSocket defaults ──
  ws: { highWaterMark: 65536, lowWaterMark: 16384, maxSendRate: 0, keepRooms: true },
});
```

---

## Basic HTTP Methods

```ts
const get = await client.get("/resource");
const post = await client.post("/resource", { key: "value" }); // auto-JSON
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

Every builder method returns `this` for chaining. Call one terminal method — `.send()`, `.json()`, `.text()`, `.bytes()`, `.blob()`, `.data()`, or `.subscribe()` — to execute; they return promises, not the builder.

```ts
const client = kinetex({ baseURL: "https://api.example.com" });

// Full chain
const data = await client
  .GET("/users") // or .POST, .PUT, .PATCH, .DELETE, .request(method, url)
  .header("X-Custom", "value") // single header
  .headers({ "X-A": "1", "X-B": "2" }) // multiple headers
  .param("page", "1") // single query param
  .params({ limit: "10", sort: "name" }) // multiple params
  .withBody("raw text") // raw body (string, Uint8Array, ReadableStream, ...)
  .withJSON({ key: "value" }) // JSON body (sets Content-Type)
  .withForm(formData) // FormData body
  .bearer("token") // Bearer auth
  .basic("user", "pass") // Basic auth
  .apiKey("X-Key", "value") // API key auth
  .digest("user", "pass") // Digest auth
  .noAuth() // Skip auth
  .retry(3, { baseDelayMs: 1000 }) // Max retries + optional config
  .noRetry() // Skip retry
  .timeout(5000) // Timeout in ms
  .proxy({ url: "socks5://..." }) // Throws — see "Proxy" note above; use fetch+agent or createSocks5Tunnel()
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
  .send(); // → Promise<KinetexResponse<T>>

// The methods above all return `this`. These are the terminal calls — pick
// exactly one, and nothing may be chained after it:
const res = await client.GET("/users").send(); // Promise<KinetexResponse<T>>
const data = await client.GET("/users").json<User>(); // Promise<T> (parsed JSON)
const str = await client.GET("/users").text(); // Promise<string>
const buf = await client.GET("/users").bytes(); // Promise<Uint8Array>
const blob = await client.GET("/users").blob(); // Promise<Blob>
const same = await client.GET("/users").data<User>(); // Promise<T> (alias for .json)
client.GET("/users").subscribe(onSuccess, onError); // callback-style (void)
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
  followRedirects?: boolean; // Follow redirects (default: true; false returns the 3xx as-is)
  maxRedirects?: number; // Max redirect hops (default: 20; 0 disables following)
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
  response: KinetexResponse<unknown> | null; // null when the attempt failed before a response
  error: unknown;
  request: KinetexRequest;
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
  request: InterceptorRequest; // url, method, headers, body, signal, meta
  response: InterceptorResponse | null;
  error: unknown | null;
  startedAt: number; // Monotonic start time (ms)
  attempt: number; // Current attempt number
  aborted: boolean; // Pipeline aborted?
  store: Map<symbol, unknown>; // Pipeline-scoped shared storage (symbol keys only)
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

// Compute request body size (used internally by progress tracking).
// Returns the byte length, 0 for an empty body, or -1 when the size is unknown
// (e.g. a ReadableStream) — it never returns null.
computeBodySize(body); // → number

// Combine multiple built-in interceptors at documented priorities:
//   -100 timeout · -90 rate limit · -80 dedup · -70 cache
//   -50 auth · 50 retry · 90 logging · 95 HAR · 100 metrics
const suite = createInterceptorSuite({
  timeout: { timeoutMs: 5000 },
  retry: { maxRetries: 3 },
  rateLimit: { limit: 100, windowMs: 60_000 },
  // `auth` is a bare getToken provider, not an AuthConfig
  auth: { getToken: () => "my-token" },
  // `cache` is a CacheConfig — the key is defaultTtlMs, there is no `ttlMs`
  cache: { defaultTtlMs: 5000 },
  logging: {/* Partial<LoggingConfig> */},
});
// suite: { manager, retry, auth, timeout, logging, cache, dedupe, har, metrics }
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

// All hook types (each add* returns a string id used for removal):
// - addBeforeRequest(fn, options?)
// - addAfterRequest(fn, options?)
// - addBeforeResponse(fn, options?)
// - addAfterResponse(fn, options?)
// - addOnError(fn, options?)
// - addOnRetry(fn, options?)
// - addOnRedirect(fn, options?)
// - addOnUploadProgress(fn, options?)
// - addOnDownloadProgress(fn, options?)
// - addOnCancel(fn, options?)
// - addOnConnection(fn, options?)
// - addAround(fn, options?)       // wraps the entire pipeline

const id = registry.addBeforeRequest(myHook, {
  id: "my-hook", // optional unique id (auto-generated if omitted)
  priority: 10, // Lower number = runs first (default: 0)
  once: true, // Auto-eject after first run
  condition: (ctx) => ctx.request.method === "POST", // receives the HookContext
  safe: true, // swallow+log errors from this hook instead of propagating
});
registry.remove(id); // eject by id — there is no removeBeforeRequest()
registry.has(id);
registry.removeAll();

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
class MyHTTPError extends HTTPError {} // extends Error
class MyValidationError extends ResponseValidationError {} // extends Error
class TooManyRedirectsError extends Error {} // thrown by HookRegistry
```

### HookEmitter

For event-style hook emission separate from the registry:

```ts
const emitter = new HookEmitter();
emitter.on("before:request", (req) => console.log(req.method, req.url));
await emitter.emit("before:request", req); // async; takes ONE event object
emitter.off("before:request", handler);
emitter.once("error", (err) => console.error(err));
emitter.removeAllListeners(); // all events
emitter.removeAllListeners("error"); // one event
```

Event names are colon-separated and typed: `before:request`, `after:request`, `before:response`, `after:response`, `error`, `retry`, `redirect`, `upload:progress`, `download:progress`, `cancel`, `connection`. `emit()` returns a promise and isolates listener errors. There is no `clear()` — it is `removeAllListeners()`.

### HookOptions

```ts
interface HookOptions {
  id?: string; // Unique hook id. Auto-generated if omitted.
  priority?: number; // Lower runs first (default: 0)
  once?: boolean; // Auto-eject after first execution
  condition?: (ctx: HookContext) => boolean; // Conditional predicate — not `if`
  safe?: boolean; // Catch+log hook errors instead of propagating (default: false)
}
```

---

## Request Deduplication

Coalesces identical concurrent GET/HEAD requests into a single network call. The dedup key includes a SHA-256 fingerprint of every credential-bearing header, so two users calling the same URL with different `Authorization` / `Cookie` / API-key headers are never coalesced into one response:

```ts
import { CREDENTIAL_HEADERS } from "kinetex/cache";
// ["authorization", "proxy-authorization", "cookie", "x-api-key", "apikey", "api-key",
//  "x-auth-token", "x-access-token", "x-refresh-token", "x-session-id", "x-session-token",
//  "x-secret", "x-secret-key", "x-private-key", "x-csrf-token"]
```

> If you authenticate with a header outside that list, supply a `keyFn` that includes it (see below) — otherwise two identities can share one in-flight slot.

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
console.log(dedup.hits, dedup.misses, dedup.inFlightCount, dedup.keys);
console.log(dedup.getStats()); // a method — there is no `stats` property
```

---

## Circuit Breaker

Per-origin (or per-key) three-state machine to prevent cascading failures:

```ts
client.enableCircuitBreaker({
  failureThreshold: 5, // Failures before OPEN (default: 5)
  resetTimeoutMs: 30_000, // Time before HALF_OPEN probe (default: 30_000)
  successThreshold: 2, // Consecutive successes to CLOSE (default: 2)
  windowSize: 10, // Sliding window size (default: 10)
  halfOpenConcurrency: 1, // Concurrent probes in HALF_OPEN (default: 1)
  // The filter key is `failures`, not `failureFilter`
  failures: {
    // Which failures count toward threshold
    networkErrors: true, // ENETWORK errors (default: true)
    timeouts: true, // ETIMEOUT errors (default: true)
    serverErrors: false, // HTTP 5xx (default: false)
    statusCodes: [503], // Specific status codes
  },
  onOpen: (state) => console.log("Circuit OPEN", state),
  onClose: (state) => console.log("Circuit recovered", state),
  onHalfOpen: (state) => console.log("Probing...", state),
  // Every callback receives a CircuitBreakerState, not the request
  onRejected: (state) => console.log("Rejected by CB", state.state, state.failureCount),
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

// A standalone breaker takes a key as its FIRST argument, then the config.
const cb = createCircuitBreaker("api.example.com", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

await cb.execute(async () => {
  /* throws CircuitOpenError while OPEN */
});
cb.state; // "CLOSED" | "OPEN" | "HALF_OPEN"
cb.snapshot; // CircuitBreakerState
cb.trip();
cb.reset();

const registry = new CircuitBreakerRegistry(config);
// Thin wrapper that manages a Map<string, CircuitBreaker>
await registry.execute("https://api.example.com", () => doRequest());
registry.get("https://api.example.com"); // → CircuitBreaker
registry.snapshots(); // → Record<string, CircuitBreakerState>
registry.trip("origin");
registry.reset("origin");
registry.delete("origin");
registry.size;
registry.clear();
```

---

## Caching

RFC 7234 compliant HTTP caching with pluggable storage backends. Freshness comes from the response's `Cache-Control` headers, and `Vary` is always honoured — there is no toggle for either.

```ts
import { kinetex, MemoryStorageAdapter } from "kinetex";

const client = kinetex({
  cache: {
    // maxEntries: 500, // LRU eviction
    // maxSizeBytes: 50 * 1024 * 1024, // total bytes held
    // maxBodySizeBytes: 5 * 1024 * 1024, // skip caching larger bodies
    // defaultTtlMs: 60_000, // when the response has no Cache-Control (max 1 year)
    // maxAbsoluteAgeMs: 7 * 24 * 60 * 60 * 1000, // hard cap regardless of Cache-Control
    // honorCacheControl: true, // respect no-store / no-cache
    // cacheMethods: ["GET", "HEAD"],
    // cacheStatuses: [200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501],
    storage: new MemoryStorageAdapter(), // omit for plain in-memory
    // cacheKey: (req) => `${req.url}`, // may be async
    // namespace: "myapp", // key prefix
  },
});

// Per-request cache control — this is CacheRequestConfig, a different shape
// from the client-level CacheConfig above (note `enabled`, not `storage`).
client.get("/users", { cache: { ttlMs: 5000 } }); // override TTL for this call
client.get("/users", { cache: { tags: ["users"] } }); // tag for later invalidation
client.get("/users", { cache: { forceRefresh: true } }); // bypass + re-cache
client.get("/users", { cache: { enabled: false } }); // bypass entirely
client.get("/users", { cache: false }); // shorthand for { enabled: false }

// Fluent equivalents
client.GET("/users").cache({ ttlMs: 5000 }).json();
client.GET("/users").noCache().json(); // forceRefresh: true
```

**Stale-while-revalidate needs no config flag.** There is no `swr` or `swrTtlMs` option: the SWR window is taken from the response's `Cache-Control: stale-while-revalidate=N`, and within that window kinetex serves the stale copy immediately and revalidates in the background. Two consequences worth knowing:

- A per-request `cache.ttlMs` override pins the SWR window to 0 for that request. If you want SWR, let the server's `Cache-Control` decide the lifetime.
- `onSWRError` is a **top-level client option**, not a member of `cache`:

```ts
const client = kinetex({
  onSWRError: (err, req) => console.error("SWR failed", req.url, err),
});
```

### Credential isolation

Cache keys include a SHA-256 fingerprint of every header in `CREDENTIAL_HEADERS`, so a response fetched with one user's `Authorization`/`Cookie`/API key is never served to another. `getAuthFingerprint(headers)` exposes the same function for custom key functions:

```ts
import { getAuthFingerprint, CREDENTIAL_HEADERS } from "kinetex/cache";

await getAuthFingerprint({ authorization: "Bearer …" }); // → "auth:9f86d0…"
await getAuthFingerprint({ accept: "*/*" }); // → "" (anonymous → shared entry)
```

Default `cacheStatuses` are `200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501` — error responses are not cached, and `304` is handled by revalidation rather than stored.

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
  CREDENTIAL_HEADERS,
} from "kinetex/cache";
import type { CacheEntry, CacheStats, CacheConfig, CacheStorageAdapter } from "kinetex/cache";
```

Each factory takes its storage first, then an optional `CacheConfig` (with `storage` omitted, since the factory supplies it):

```ts
// Memory cache
const cache = createMemoryCache({ defaultTtlMs: 60_000, maxEntries: 1000 });

// Browser localStorage cache — note the prefix is the first positional arg
const cache = createLocalStorageCache("myapp:", { defaultTtlMs: 60_000 });

// Browser sessionStorage cache
const cache = createSessionStorageCache("myapp:");

// Cloudflare KV cache — the namespace is the first positional arg
const cache = createKVCache(myKVNamespace, { defaultTtlMs: 60_000 });

// Two-tier: L1 is always in-memory, so you pass only the L2 adapter
const cache = createTwoTierCache(new WebStorageAdapter(localStorage, "myapp:"), {
  defaultTtlMs: 60_000,
});

// Full HTTPCache — you choose the adapter here
const cache = new HTTPCache({
  storage: new MemoryStorageAdapter(),
  defaultTtlMs: 60_000,
  maxEntries: 1000,
  maxBodySizeBytes: 1_000_000,
  maxAbsoluteAgeMs: 3_600_000,
  namespace: "myapp",
});

const req = { url: "https://api.example.com/users", method: "GET", headers: {} };

await cache.set(
  req,
  { status: 200, statusText: "OK", headers: {}, body: "..." },
  { tags: ["users"] },
);

const entry = await cache.get(req); // CacheEntry | null
// entry.response, entry.createdAt, entry.expiresAt, entry.staleUntil, entry.staleOnError
// entry.etag, entry.lastModified, entry.varyKey, entry.tags, entry.size

// Tag-based and URL-prefix invalidation
await cache.invalidateByTag("users");
await cache.invalidateByURL("https://api.example.com/users");

// Conditional revalidation headers for a stored entry
cache.buildConditionalHeaders(entry); // → { "if-none-match": "…" } when an etag exists

// Cache statistics — a method, not a property
const stats: CacheStats = cache.getStats();
// { hits, misses, staleHits, errors, evictions, totalEntries, totalSizeBytes, hitRate }

await cache.clear();
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
  domain: string; // canonicalized, lowercased, no leading dot
  path: string;
  expires: number; // epoch ms; Infinity = session cookie (no Expires/Max-Age)
  maxAge: number | null; // raw Max-Age in seconds as parsed, null if absent
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite; // "Strict" | "Lax" | "None" | "Unset"
  createdAt: number; // epoch ms
  lastAccessed: number; // epoch ms
  hostOnly: boolean; // true = set without a Domain attribute → exact host match only
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

The jar stores cookies in a three-level map (domain → path → name) with LRU eviction — a per-domain cap of 50 and a global cap of 3000 by default. There is no separate `CookieStore` class and no `kinetex/cookie-store` entry point; `CookieJar` **is** the store. Tune the caps and domain matching through its constructor:

```ts
import { CookieJar, createCookieJar, loadCookieJar } from "kinetex/cookiejar";

const jar = new CookieJar({
  maxTotal: 3000, // default 3000
  maxPerDomain: 50, // default 50
  domainMatcher: (requestHost, cookieDomain) => requestHost.endsWith(cookieDomain),
});

// Cookies are read and written through the jar, not a raw store:
jar.setCookie("session=abc123; Path=/; Secure", { url: "https://example.com/" });
jar.getCookies({ url: "https://example.com/page", http: true }); // → Cookie[]
jar.getCookieHeader({ url: "https://example.com/page" }); // → "session=abc123"
jar.getAll();
jar.getForDomain("example.com");

// Also: clear(), clearExpired(), clearSession(), clearForDomain(),
// clearForUrl(), removeCookie(domain, path, name), toJSON(), toString()
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

// Core: paginate() takes a single PaginationConfig and an optional strategy name.
// It does NOT take a client — you supply a `fetch` that returns the raw response.
import {
  paginate,
  collectAll,
  collectPages,
  takeItems,
  paginateItems,
  prefetchPaginate,
} from "kinetex/pagination";

const pages = paginate<Item>(
  {
    fetch: (state) => client.get<ItemsResponse>(`/items?offset=${state.offset}&limit=100`),
    getItems: (res) => res.items,
    hasNext: (res) => res.items.length === 100,
    getNext: (res) => ({ offset: res.items.at(-1)!.id }),
    getTotal: (res) => res.total,
    perPage: 100,
    startOffset: 0,
    maxPages: 10, // 0 = unlimited (default)
    delayMs: 0,
    signal: controller.signal,
    transform: (item) => item,
    filter: (item) => !item.deleted,
    onPage: (page) => console.log("fetched page", page.page),
  },
  "offset",
);

for await (const page of pages) {
  console.log(page.items, page.total, page.page, page.hasNext, page.nextCursor);
}

// ── Per-strategy factories ────────────────────────────────────────────────
// These wrap globalThis.fetch (or a `fetch` you pass) and build the config
// for you. Each returns an AsyncGenerator<Page<T>> directly.

// Offset/limit — ?offset=0&limit=100
createOffsetPaginator<Item>({
  url: "https://api.example.com/items",
  limit: 100,
  getItems: (data) => data.items,
  getTotal: (data) => data.total,
  maxPages: 10,
  // paramNames: { offset: "o", limit: "l" },
  // fetch: globalThis.fetch, headers: {}, signal,
});

// Page/per-page — ?page=1&per_page=100
createPagePaginator<Item>({
  url: "https://api.example.com/items",
  perPage: 50,
  startPage: 1,
  getItems: (data) => data.items,
  // paramNames: { page: "p", perPage: "pp" },
});

// Cursor — ?cursor=abc123
createCursorPaginator<Item>({
  url: "https://api.example.com/items",
  getItems: (data) => data.items,
  getNextCursor: (data) => data.nextCursor, // string | null
  startCursor: null,
  paramName: "cursor", // default "cursor"
});

// Keyset — ?after_id=123
createKeysetPaginator<Item>({
  url: "https://api.example.com/items",
  keyParam: "after_id",
  getItems: (data) => data.items,
  getLastKey: (items) => String(items.at(-1)!.id),
  hasMore: (items) => items.length > 0,
  startKey: null,
  pageSize: 100,
  pageSizeParam: "limit",
});

// Relay (GraphQL-style connections)
// RelayPaginationOptions has no getItems/getNext: your `fetch` must resolve to a
// RelayConnection<T> and the paginator unwraps edges/node and pageInfo itself.
createRelayPaginator<Item>({
  fetch: async ({ first, after }) =>
    graphql<RelayConnection<Item>>(
      `
        query ($first: Int, $after: String) {
          items(first: $first, after: $after) {
            edges {
              node
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { first, after },
    ),
  first: 100, // page size
  startCursor: null,
  maxPages: 10,
});

// Link header (GitHub-style) — follows the RFC 8288 `Link` header
createLinkHeaderPaginator<Item>({
  url: "https://api.github.com/repos/kinetexjs/kinetex/issues",
  getItems: (data) => data,
  headers: { Accept: "application/vnd.github+json" },
});

// Page token (Google API-style)
createTokenPaginator<Item>({
  url: "https://www.googleapis.com/books/v1/volumes",
  getItems: (data) => data.items,
  getNextToken: (data) => data.nextPageToken,
  tokenParam: "pageToken",
  pageSize: 10,
});

// ── Collection helpers — all take (config, strategy?) ────────────────────
const allItems = await collectAll<Item>(config);
const allPages = await collectPages<Item>(config);
const first50 = await takeItems<Item>(50, config); // (n, config) — n comes FIRST
const items = paginateItems<Item>(config); // yields items, not pages
const prefetched = prefetchPaginate<Item>(config, "page", 3); // 3 pages in flight

// Merge several paginators into one stream
const merged = mergePaginators(paginator1, paginator2);

// ── State serialization (base64 JSON of a PaginationState) ──────────────
const serialized: string = serializePaginationState(state);
const restored: PaginationState = deserializePaginationState(serialized);

// Convert any AsyncIterable to an AsyncIterableIterator
const iterator = toPaginationIterator(paginator);
```

### Client-Level Pagination

```ts
// Routes through the full kinetex pipeline. Takes PagePaginationOptions
// (minus url/fetch) — there is no `strategy` key; the strategy is implied.
const pages = await client.paginate("/items", {
  perPage: 50,
  getItems: (data) => data.items,
  getTotal: (data) => data.total,
  maxPages: 10,
});

for await (const page of pages) {
  console.log(page.items);
}
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

// SSEClient — note the real option names: reconnect (not autoReconnect),
// reconnectDelayMs / maxReconnectDelayMs (not baseDelay / maxDelay).
// There is no `onEvent` option; iterate the client instead.
const sse = new SSEClient({
  url: "https://api.example.com/events",
  method: "POST",
  headers: { Authorization: "Bearer token" },
  body: JSON.stringify({ query: "..." }),
  fetch: globalThis.fetch,
  signal: controller.signal,
  lastEventId: "", // resume point

  reconnect: true, // default true
  reconnectDelayMs: 3000, // default 3000
  maxReconnectDelayMs: 30_000, // default 30000
  reconnectJitter: 0.3, // default 0.3
  maxReconnects: 0, // 0 = unlimited (default)
  onReconnect: (attempt, delayMs) => console.log(`retry ${attempt} in ${delayMs}ms`),
  onParseError: (err, raw) => console.warn("bad SSE frame", raw, err),
  heartbeatTimeoutMs: 0, // 0 = disabled
  validateResponse: (res) => res.ok || "stream rejected", // false | string to stop
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
// Takes Partial<SSEClientConfig> and routes through the full kinetex pipeline
const sseClient = await client.sse("/events", {
  reconnect: true, // not `autoReconnect`
  maxReconnects: 5,
});
```

### SSEClient Lifecycle & Health

```ts
// Collect a bounded number of events (resolves or aborts)
const events = await sse.collect({ limit: 100, signal: controller.signal });

// Health snapshot
sse.url; // Current URL (updated after reconnect)
sse.closed; // boolean
sse.streamHealth;
// { connected, totalEvents, totalReconnects, lastEventAt, lastEventId, reconnectAttempt }

// Teardown
sse.close(); // Graceful close — stops reconnecting
destroy(); // Hard teardown
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
  protocols: "graphql-ws", // or string[]
  headers: { Authorization: "Bearer token" },
  // There is no `reconnect` boolean or `baseDelay`/`maxDelay` — the real
  // names are reconnectBaseMs / reconnectMaxMs. maxReconnects: 0 = unlimited.
  maxReconnects: 10,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
  reconnectJitter: 0.3,
  connectTimeoutMs: 5000,
  pingIntervalMs: 30_000,
  pingPayload: "ping",
  pongMatcher: "pong", // string | RegExp
  pongTimeoutMs: 5000,
  highWaterMark: 65536,
  lowWaterMark: 16384,
  maxSendRate: 0, // 0 = unlimited
  keepRooms: true,
  bufferMessages: true,
  maxBufferSize: 1000,
  rooms: ["prices"],
  signal: controller.signal,

  onOpen: (reconnectCount) => console.log(`open (${reconnectCount} prior reconnects)`),
  onMessage: (msg) => console.log(msg.data, msg.json),
  onError: (err) => console.error(err),
  onClose: (code, reason, willReconnect) => {},
  onReconnect: (attempt, delayMs) => console.log(`Reconnecting (${attempt}) in ${delayMs}ms`),
  onGiveUp: (totalAttempts) => console.warn("gave up", totalAttempts),
  onBackpressure: (isBackpressured, info) => console.log("backpressure", info),
});

await ws.connect();

// Send
ws.send("raw message");
ws.sendJSON({ type: "subscribe", channel: "prices" });
ws.sendBinary(new Uint8Array([1, 2, 3]));

// Async iteration
for await (const msg of ws) {
  // `json` is `unknown` — narrow it before reading fields.
  const payload = msg.json as { type?: string } | undefined;
  console.log(msg.data, payload?.type);
}

// Message subscription — returns an eject function (there is no
// built-in request/response correlation helper)
const off = ws.onMessage((msg) => console.log(msg.data, msg.json));
off(); // unsubscribe

// Metrics
interface WSMetrics {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  reconnectCount: number;
  totalConnectAttempts: number;
  uptimeMs: number;
}

// Utility
const ws = await connectWS("wss://api.example.com/ws", {
  onMessage: (msg) => console.log(msg.data),
});

// Connection state & health
ws.state; // "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "RECONNECTING"
ws.connected; // boolean
ws.bufferedCount; // Messages queued while disconnected
ws.metrics; // WSMetrics (see above)
await ws.waitForOpen(5000); // Resolve when OPEN (throws on timeout)

// Rooms (pub/sub groups — auto re-joined on reconnect when keepRooms: true)
ws.join("prices");
ws.join("orders", "v2"); // with optional namespace
ws.leave("prices");
ws.rooms; // readonly WSSubscribedRoom[]

// Backpressure
ws.backpressure; // { bufferedBytes, highWaterMark, lowWaterMark, isBackpressured, ... }
await ws.drain(30_000); // Wait until outbound buffer is flushed
await ws.drainAndClose(30_000); // Drain, then close gracefully
ws.drainBuffer(); // Take queued offline messages as an array

// Teardown
ws.close(1000, "done"); // Close with code/reason (disconnects reconnect logic)
ws.destroy(); // Hard teardown, no close frame
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
  useGETForQueries: false,
  enableAPQ: true, // Automatic Persisted Queries (not `apq`)
  timeoutMs: 10_000,
  retries: 2, // plain number — there is no `retry: { maxRetries }`
  retryDelayMs: 300,
  signal: controller.signal,
  links: [
    // Middleware chain
    retryLink({ maxRetries: 3 }),
    authLink(() => "..."), // authLink(getToken, scheme = "Bearer")
    loggingLink(),
    errorLink(),
  ],
  onRequest: (req) => console.log(req),
  onResponse: (res, req) => console.log(res, req),
  onError: (err, req) => console.error(err, req),
});

// Query — `query()` resolves to the response's `data` field directly, not to
// a `{ data, errors }` envelope. A non-empty `errors` array throws
// `GraphQLClientError`, which carries `.graphqlErrors` and `.response`.
const data = await client.query<{ user: { name: string } }>(
  `
    query GetUser($id: ID!) {
      user(id: $id) {
        name
      }
    }
  `,
  { id: "1" },
);

// Mutation — also resolves to `data`
const result = await client.mutate<{ updateUser: { success: boolean } }>(
  `
    mutation UpdateUser($id: ID!, $name: String!) {
      updateUser(id: $id, name: $name) {
        success
      }
    }
  `,
  { id: "1", name: "Alice" },
);

// Subscription — an async generator. The third argument is
// { operationName, signal, url }; there is no `transport` option.
const sub = client.subscribe(
  `
    subscription OnPrice {
      priceUpdate {
        symbol
        price
      }
    }
  `,
  {},
  { operationName: "OnPrice", signal: controller.signal },
);
for await (const event of sub) {
  console.log(event.data);
}

// Utility — these take a raw query string, not a template tag
detectOperationType("query { user { id } }"); // → "query"
extractOperationName("query GetUser { user { id } }"); // → "GetUser"
```

> **`gql` is a one-shot function, not a template tag.** `gql(url, query, variables?, headers?)` creates a throwaway `GraphQLClient`, runs the query, and returns its `data`. For anything repeated, construct a `GraphQLClient` (or `createGraphQLClient(config)`) instead. There is no tagged-template form of `gql`.

### Client-Level GraphQL

`client.graphql()` returns a `GraphQLClient` whose transport is routed through the kinetex pipeline (auth, interceptors, rate limiting, circuit breaker, OTel), not a `gql` function.

```ts
const gqlClient = await client.graphql("/graphql", {
  enableAPQ: true,
  links: [authLink(() => "...")],
});
const data = await gqlClient.query(query, variables);
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

tracker.update(500_000); // 500KB transferred → ProgressSnapshot
tracker.complete(); // Mark done → ProgressSnapshot
tracker.snapshot(); // Current ProgressSnapshot
// There is no reset(); construct a new ProgressTracker(total, options) instead.

// Wrap an upload body with progress tracking → { stream, tracker }
const { stream: uploadStream, tracker: upTracker } = withUploadProgress(
  readableStream,
  totalBytes,
  { onProgress: (snap) => {} },
);

// Download tracking returns { response, tracker } — the Response is returned
// with an instrumented body, so there is no `stream` property here.
const { response: tracked, tracker: downTracker } = withDownloadProgress(response, {
  onProgress: (snap) => {},
});

// Blob upload progress → { stream, tracker }
const { stream: blobStream, tracker: blobTracker } = withBlobUploadProgress(blob, {
  onProgress: (snap) => {},
});
```

All three upload/download wrappers are **pull-based**: the source is read one chunk per downstream demand, so backpressure reaches the underlying socket/file and a multi-gigabyte transfer is not buffered in memory. Cancelling the returned stream (or aborting the supplied `signal`) propagates to the source, and the tracker is always completed or errored on the way out.

> Upload progress is not available for a body that cannot be replayed on retry. Retrying a `ReadableStream`/`Blob` body now fails fast with `EVALIDATION` (it was previously consumed by the first attempt, so the retry silently sent an empty body). Buffer the body first, or disable retry for that request.

```ts
// Wrap a ReadableStream with progress tracking. `streamWithProgress(stream,
// total, options)` is an async generator yielding { chunk, progress } — it
// returns the generator itself, not an object with a `stream` property.
// Its options are `Omit<ProgressOptions, "onProgress">`: progress arrives as
// the `progress` field of each yielded value instead of via a callback.
for await (const { chunk, progress } of streamWithProgress(readableStream, totalBytes, {
  throttleHz: 10,
})) {
  // … consume `chunk` …
}

// Collect a full stream into a Uint8Array
const bytes = await collectStream(readableStream);

// Multi-part progress — create a per-part tracker, then read the roll-up.
// There is no addPart()/update(partId)/total() API.
const agg = new MultiPartProgressAggregator(3, (m) => {
  console.log("overall", m.overall.percent);
});
const part = agg.createPartTracker(0, 500, { onProgress: (s) => console.log(s.loaded) });
part.update(250);
part.complete();

const { parts, overall } = agg.getOverall(); // MultiPartProgress

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
  unsignedPayload: true, // Send UNSIGNED-PAYLOAD (for streaming) — not `payloadHash`
  unsignedHeaders: ["x-amz-content-sha256"], // Headers to skip
  doubleEncodeUri: true, // RFC 3986 double-encode (not `doubleEncode`)
});
// The SigV4Signer constructor is Omit<SigningConfig, "signingDate" |
// "clockSkewSecs">: both are managed internally (the latter tracks detected
// clock skew). To pin a signing date, pass a full SigningConfig to
// signRequest(request, config) / presignRequest(request, config) instead.
// There is no `presignExpires` or `normalizePath` on SigningConfig either.

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
const provider = imdsCredentials({ timeout: 1000 }); // EC2 IMDS — options are { endpoint?, timeout? }
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
// `initChunkedSigning(request, config)` takes a SignableRequest and a
// SigningConfig. It returns the seed request plus the state object that
// `signChunk` / `signFinalChunk` thread through each chunk — there are no
// `sessionToken`, `dateTime`, `chunkIndex`, or `previousSignature` arguments.
const { signedRequest, state } = await initChunkedSigning(
  { url: targetURL, method: "PUT", headers: {}, body: null },
  { credentials, region, service: "s3" },
);

// signChunk returns the wire header and the *updated* state; feed newState
// into the next call rather than reusing `state`.
for await (const chunk of chunks) {
  const { chunkHeader, newState } = await signChunk(chunk, state);
  state = newState;
  write(chunkHeader);
  write(chunk);
}
write(await signFinalChunk(state));

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

// Standalone tunnel. All three arguments are required:
// (proxy config, target, connector). The result is a raw TCP tunnel —
// Socks5Tunnel is { conn, boundAddr, boundPort }. It has NO .send();
// the tunnel is not an HTTP client. Speak HTTP/TLS over `tunnel.conn`
// yourself, or hand it to a transport that can.
const tunnel: Socks5Tunnel = await createSocks5Tunnel(
  {
    host: "127.0.0.1", // not `proxyHost`
    port: 1080, // not `proxyPort`
    username: "user", // Optional: RFC 1929 auth
    password: "pass",
    remoteDns: true, // Resolve hostnames at the proxy
    connectTimeoutMs: 10_000, // not `connectTimeout`
    handshakeTimeoutMs: 10_000,
    maxRetries: 2, // not `retries`
    retryDelayMs: 500,
  },
  { host: "api.example.com", port: 443, tls: true, tlsServerName: "api.example.com" },
  nodeTcpConnector,
);

// tunnel.conn is a TcpConn: { read(buf), write(data), close() }
tunnel.boundAddr; // string — address the proxy reported
tunnel.boundPort; // number
tunnel.conn.close();

// Parse SOCKS5 URL
const config = parseSocks5Url("socks5://user:pass@127.0.0.1:1080");

// Runtime-specific TCP connectors
const nodeConnector: TcpConnector = nodeTcpConnector; // Node.js
const denoConnector: TcpConnector = denoTcpConnector; // Deno
const customConnector: TcpConnector = socks5Connector({
  host: "127.0.0.1",
  port: 1080,
}); // Returns a TcpConnector function

// Client-level proxy
// NOTE: like the per-request option, client-level `proxy` fails fast with
// guidance instead of silently routing direct. For SOCKS5 use createSocks5Tunnel():
try {
  kinetex({
    proxy: { url: "socks5://127.0.0.1:1080", username: "user", password: "pass" },
  });
} catch (e) {
  // KinetexError: "proxy is configured but kinetex's built-in transports cannot
  // route through it ..."
}

// Correct way to route through an HTTP(S) proxy — supply a proxy-aware fetch:
import { ProxyAgent } from "undici"; // npm i undici (Node.js)
const proxied = kinetex({
  fetch: new ProxyAgent("http://127.0.0.1:8080").dispatch.bind(
    new ProxyAgent("http://127.0.0.1:8080"),
  ) as typeof fetch,
});

// Correct way to route through a SOCKS5 proxy — dial through the tunnel
// and upgrade to TLS, then hand the socket to a fetch implementation that
// accepts a custom connection:
import { createSocks5Tunnel } from "kinetex/socks5";
const socks = await createSocks5Tunnel(
  { host: "127.0.0.1", port: 1080 },
  { host: "api.example.com", port: 443, tls: true },
  nodeTcpConnector,
);
const tlsSocket = await upgradeToTLS(socks.conn, { servername: "api.example.com" });
const viaSocks = kinetex({ fetch: fetchOverSocket(tlsSocket) });
```

`createSocks5Tunnel` is a low-level primitive. It gives you a connected socket and nothing else — no request building, no redirect handling, no kinetex pipeline. For full kinetex behaviour over SOCKS5, connect a fetch implementation to the tunnel and pass it as the client's `fetch`.

---

## Digest Authentication

Full RFC 7616 implementation with MD5 (pure JS), SHA-256, and SHA-512-256:

```ts
import {
  parseDigestChallenge,
  computeDigestResponse,
  formatDigestAuth,
  createDigestAuthorization,
  createDigestAuthorizer,
} from "kinetex/digest";
import type { DigestChallenge } from "kinetex/digest";

// One-shot: stateless, always nc=00000001
const authHeader = await createDigestAuthorization(
  `Digest realm="test", nonce="abc123", algorithm=MD5, qop="auth"`,
  "username",
  "password",
  "GET",
  "/resource",
);
// → 'Digest username="username", realm="test", nonce="abc123", uri="/resource", response="...", algorithm=MD5, qop=auth, nc=00000001, cnonce="..."'
```

### Nonce counting (`nc`)

RFC 7616 requires `nc` — the hex request count for the current nonce — to **increase on every request that reuses a nonce**. Servers with replay protection enabled (nginx, Apache with `AuthDigestNonceLifetime`) reject a repeated `nc=00000001`, so a long-lived client needs the stateful authorizer:

```ts
// The first argument is the raw WWW-Authenticate header string, not a
// parsed challenge object.
const authorize = createDigestAuthorizer();

await authorize(challenge, "username", "password", "GET", "/a"); // nc=00000001
await authorize(challenge, "username", "password", "GET", "/b"); // nc=00000002
await authorize(challenge, "username", "password", "GET", "/c"); // nc=00000003

// A new nonce from the server resets the counter
await authorize(newChallenge, "username", "password", "GET", "/a"); // nc=00000001
```

Create one per client (do not share it across users). `Kinetex`'s built-in `auth: { type: "digest" }` interceptor uses it automatically: it answers the `401` challenge, retries once, and increments `nc` on every subsequent request.

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
    new JSONTransport((line) => appendFileSync("requests.log", line)), // one JSON line at a time
  ],
  // Redaction is a structured config, not a flat array of patterns
  redaction: {
    headers: ["authorization", "cookie", "x-api-key"],
    queryParams: ["api_key", "access_token"],
    bodyFields: ["password", "ssn"],
    bodyPatterns: [/secret.*/i],
    maxBodyLength: 1000,
    logRequestBody: true,
    logResponseBody: true,
    allowedBodyTypes: ["application/json"],
  },
  sampleRate: 0.5, // Log ~50% of requests (not `sampling`)
  methods: ["GET", "POST"],
  statuses: [429, 500, 503],
  excludeURLs: [/\/health$/],
  context: { service: "api" },
  generateId: () => crypto.randomUUID(),
});

// Client-level logging
kinetex({
  logger: { level: "info" }, // Auto-creates logger
  logger: false, // Disable logging
});

// Batching transport (async flush)
const batch = new BatchingTransport(inner, {
  maxBatch: 100, // default 100
  flushMs: 5000, // default 5000 — not `flushIntervalMs`
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
// HARLog { version: "1.2", creator: { name: "kinetex", version: "1.0.0" }, entries: [...] }

// Each HAREntry contains:
// startedDateTime, time, request (method, url, httpVersion, headers, queryString, bodySize),
// response (status, statusText, httpVersion, headers, content, redirectURL, bodySize),
// timings (send, wait, receive), cache

// Clear entries
client.clearHAR();
```

### Redaction

HAR logs are routinely exported and shared, so entries are redacted before they are recorded:

- **Headers** — every credential-bearing name (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `apikey`, `x-session-token`, …) is replaced with `***REDACTED***`.
- **URLs** — sensitive query parameters (`api_key`, `access_token`, `signature`, `password`, `code`, `sas`, …) and the fragment are masked, in both `request.url` and `request.queryString[]`. Non-sensitive parameters and the rest of the URL are preserved so the log stays useful.
- **`Location`** — the redirect target is passed through the same URL redaction.
- **Bodies** — response text is recorded only for `json`/`xml`/`text/plain`/`javascript` content types and truncated to 8 KiB; HTML and binary bodies are never recorded.

```ts
// ?api_key=SUPERSECRET&page=2  →  https://api.example.com/v1/items?api_key=***REDACTED***&page=2
```

> Redaction is deliberately conservative. If a credential travels in a non-standard header or parameter, add it to your own allow/deny handling before exporting the log.

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
      setAttribute(key, value) {
        return this;
      },
      setStatus(status) {
        return this;
      },
      recordException(err) {
        return this;
      },
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
  ca: [readFileSync("corp-ca.pem")], // Trust a private/self-signed CA for this origin
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
const data = parseBody<MyType>(rawBody, contentType, customParse, onParseFailure, headers, url);

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
  maxBatch: 50, // Dispatch in groups of 50 (default: 100; must be a positive integer)
  flushMs: 10, // Flush after 10ms even if the batch is not full (default: 0)
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

> `maxBatch` is a **batching size, not a concurrency limit**: every request taken out of the queue is dispatched immediately and in parallel, and `flush()` drains the whole queue the same way. Use it to bound how much is dispatched per tick, and a rate limiter or semaphore to bound actual parallelism. `maxBatch: 0` (or a negative/fractional value) throws a `RangeError` in the constructor, as does a negative or non-finite `flushMs`.

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

// URL Builder (fluent, immutable — every method returns a new builder)
const builder = URLBuilder.from("https://api.example.com")
  .withPathname("/v1/users")
  .appendPath("42", "posts")
  .setParam("page", "1")
  .setParam("limit", "10")
  .omitParams("internal")
  .redactParams("token")
  .sortParams()
  .addTrailingSlash();

builder.toString();
// → "https://api.example.com/v1/users/42/posts/?limit=10&page=1&token=REDACTED"

URLBuilder.https("api.example.com", "/v1/users"); // Factory
URLBuilder.http("api.example.com"); // Factory

// Properties — read these off the *builder*, not off toString():
builder.href;
builder.protocol;
builder.hostname;
builder.host;
builder.port;
builder.pathname;
builder.search;
builder.hash;
builder.origin;
builder.searchParams; // → URLSearchParams
builder.queryObject; // → Record<string, string | string[]>

// Percent encoding
percentEncode("hello world"); // "hello%20world"
percentEncode("a b", true); // "a%20b" — true lets reserved chars (:/?#[]@!$&'()*+,;=) pass through
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
relativeURL("https://api.example.com/v1/users", "https://api.example.com"); // "v1/users" (no leading slash)
relativeURL("https://other.com/x", "https://api.example.com"); // null — not under base

// Data URLs
parseDataURL("data:image/png;base64,iVBOR..."); // { mediaType: "image/png", isBase64: true, data: "iVBOR..." }
buildDataURL("hello", "text/plain"); // "data:text/plain;base64,aGVsbG8="

// Redaction
redactURL("https://api.example.com?token=secret&key=123", "token", "key");
// → "https://api.example.com/?token=REDACTED&key=REDACTED"

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
  getClientIP, // (headers, { trustedHops }) — see below

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
  securityHeaders, // (options) => HttpHeaders — recommended security header set
  corsHeaders, // (options) => HttpHeaders — CORS response headers

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

// Cache-Control parsing — directives use camelCase keys, not kebab-case
parseCacheControl("public, max-age=3600, stale-while-revalidate=300");
// → { noCache: false, noStore: false, noTransform: false, onlyIfCached: false,
//     maxAge: 3600, maxStale: null, minFresh: null, staleIfError: null,
//     public: true, private: false, mustRevalidate: false, proxyRevalidate: false,
//     sMaxAge: null, immutable: false, mustUnderstand: false,
//     staleWhileRevalidate: 300, unknown: {} }
formatCacheControl({ public: true, maxAge: 3600 }); // "public, max-age=3600"

// Content-Type — takes a single object, not (string, options)
formatContentType({ mediaType: "application/json", charset: "utf-8" });
// → "application/json; charset=utf-8"

// Security / CORS headers are functions returning HttpHeaders
securityHeaders({ hsts: true, csp: "default-src 'self'", frameOptions: "DENY", noSniff: true });
corsHeaders({ origin: "*", methods: ["GET", "POST"], credentials: false, maxAge: 600 });
```

---

### `getClientIP` — proxy trust

`X-Forwarded-For` is client-controlled: the left-most entry is whatever the caller sent. `getClientIP` therefore takes a `trustedHops` count — the number of reverse proxies you actually operate — and returns the address the nearest trusted proxy appended:

```ts
import { getClientIP, HttpHeaders } from "kinetex/headers";

const headers = new HttpHeaders(req.headers);

// X-Forwarded-For: 1.1.1.1, 2.2.2.2, 3.3.3.3
getClientIP(headers, { trustedHops: 1 }); // → "3.3.3.3" (written by your edge proxy)
getClientIP(headers, { trustedHops: 2 }); // → "2.2.2.2"
getClientIP(headers); // → "1.1.1.1" (client-supplied, spoofable — default for back-compat)
```

`for="…"` quoting, `[ipv6]:port` and a bare `:port` suffix are normalized away. ⚠️ Never use the default (`trustedHops: 0`) result for access control, rate limiting or audit trails; the value is not validated as an IP address.

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

// Size limiting — readBodyWithLimit takes a *stream*, a url, and a limit config
const limited = await readBodyWithLimit(response.body, response.url, {
  maxBytes: 1_000_000,
  onExceed: "throw", // "throw" | "truncate" | "abort"
  onExceedCallback: (bytesRead, limit) => log(`Exceeded ${limit}`),
});

// createLimitedReader takes a byte count and an action — not (stream, config).
// It returns a LimitedReader with json/text/bytes/blob/stream/ndjson methods.
const reader = createLimitedReader(1_000_000, "throw");
const parsed = await reader.json<Response>(response);

// Multipart
const parts = await parseMultipartResponse(response, boundary);

// Decompression
const decompressed = await decompressStream(compressedStream, "gzip");
const raw = await applyDecompression(rawBody, headers);

// Server-Timing — returns an array of metrics
const timings = extractServerTiming(headers);
// → [{ name: "db", duration: 53, description: null }]

// Response diffing
const diff = diffResponses(res1, res2);

// Content type
parseContentType("application/json; charset=utf-8");
// { mediaType: "application/json", type: "application", subtype: "json",
//   charset: "utf-8", boundary: null }
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

Also available: `sanitizeParsedJSON(value)` strips prototype-pollution keys
(`__proto__`, `constructor`, `prototype`) from a value that was already parsed
elsewhere (streaming parsers, legacy code paths).

> **Built-in protection:** kinetex applies `sanitizeParsedJSON` automatically
> to every untrusted JSON body it parses — `readJSON`, `readNDJSON`,
> `readJSONStream`, GraphQL responses/batch/SSE events, SSE `jsonSSE()` and
> `SSERouter.onJSON()`, and WebSocket `message.json`. Hostile
> `"__proto__": {...}` keys in server payloads can never reach user code or
> downstream merges.

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
isUint8Array(data); // data is Uint8Array
isPlainObject(obj); // obj is Record<string, unknown>
isAbortSignal(signal); // signal is AbortSignal
isFormData(data); // data is FormData
isBlob(data); // data is Blob
isAbortError(err); // boolean
isValidHeaderName("x-foo"); // boolean
isValidHeaderValue("bar"); // boolean

// Safe URL checking
// Rejects non-HTTP(S) schemes and any host that resolves to a blocked literal range:
// loopback, RFC 1918, CGNAT, link-local (incl. 169.254.169.254), IETF/TEST-NET,
// benchmarking, multicast and reserved space — including IPv4-mapped/compatible
// IPv6, 6to4, NAT64, hex/octal/decimal IPv4 literals and WHATWG shortcut hosts.
isSafeURL("https://api.example.com"); // true
isSafeURL("http://127.0.0.1/"); // false
isSafeURL("http://169.254.169.254/latest/meta-data/"); // false
isSafeURL("http://[::ffff:127.0.0.1]/"); // false

// Applied to the initial URL AND to every redirect hop, so a public host cannot
// bounce a request into the private network. (DNS rebinding is out of scope —
// the check is literal-address based, not a resolution.)
sanitizeURL("javascript:alert(1)"); // null — invalid or an SSRF risk
sanitizeURL("https://user:pass@api.example.com/x"); // "https://api.example.com/x" (credentials stripped)

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

| Code           | Error Class        | Description                         |
| -------------- | ------------------ | ----------------------------------- |
| `ENETWORK`     | `NetworkError`     | Server/endpoint unreachable         |
| `ETIMEOUT`     | `TimeoutError`     | Request/connection timeout          |
| `EABORT`       | `AbortError`       | Request cancelled by caller         |
| `EHTTPSTATUS`  | `HTTPStatusError`  | Server returned 4xx/5xx             |
| `ESIZELIMIT`   | `SizeLimitError`   | Response body exceeded size limit   |
| `EPARSE`       | —                  | Failed to parse response body       |
| `EVALIDATION`  | `ValidationError`  | Invalid request configuration       |
| `EAUTH`        | `AuthError`        | Authentication failed               |
| `EPROXY`       | `ProxyError`       | Proxy configuration error           |
| `EREDIRECT`    | `RedirectError`    | Redirect error                      |
| `ECIRCUITOPEN` | `CircuitOpenError` | Rejected by an open circuit breaker |
| `EUNKNOWN`     | `KinetexError`     | Unknown/unexpected                  |

---

## Deep Imports

All sub-modules are tree-shakeable with deep import paths:

```ts
// Core
import {
  kinetex,
  Kinetex,
  FluentRequest,
  BatchQueue,
  createMethodCircuitBreakerKey,
} from "kinetex";
import type {
  KinetexConfig,
  KinetexRequest,
  KinetexResponse,
  SendOptions,
  RetryConfig,
  RetryContext,
  AuthConfig,
  ProxyConfig,
  HTTPMethod,
  HTTPVersion,
  HeadersInit,
  QueryParams,
  QueryValue,
  BodyInit,
  Runtime,
  RequestId,
  Brand,
} from "kinetex";
// Errors
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
// Types
import type {
  InterceptorContext,
  HookContext,
  LifecycleHooks,
  RequestInterceptor,
  ResponseInterceptor,
  ErrorInterceptor,
  ProgressEvent,
  ProgressCallback,
  PipelineStep,
  PipelineStageName,
  CacheRequestConfig,
  HAREntry,
  HARLog,
} from "kinetex";

// Sub-modules (tree-shakeable):
import {} from /* ... */ "kinetex/cache";
import {} from /* ... */ "kinetex/sse";
import {} from /* ... */ "kinetex/graphql";
import {} from /* ... */ "kinetex/pagination";
import {} from /* ... */ "kinetex/progress";
import {} from /* ... */ "kinetex/logging";
import {} from /* ... */ "kinetex/response";
import {} from /* ... */ "kinetex/headers";
import {} from /* ... */ "kinetex/url";
import {} from /* ... */ "kinetex/aws-sigv4";
import {} from /* ... */ "kinetex/socks5";
import {} from /* ... */ "kinetex/cookiejar";
import {} from /* ... */ "kinetex/circuit-breaker";
import {} from /* ... */ "kinetex/dedup";
import {} from /* ... */ "kinetex/digest";
import {} from /* ... */ "kinetex/ws";
import {} from /* ... */ "kinetex/cookie-parser";
import {} from /* ... */ "kinetex/lifecycle";
import {} from /* ... */ "kinetex/interceptors";
import {} from /* ... */ "kinetex/core";
import {} from /* ... */ "kinetex/worker";

// Types only from sub-modules:
import type { CacheEntry, CacheStats, CacheConfig, CacheStorageAdapter } from "kinetex/cache";
import type { SSEEvent, SSEClientConfig, JSONSSEEvent } from "kinetex/sse";
import type {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLError,
  GraphQLClientConfig,
  GraphQLLink,
  GraphQLLinkNext,
} from "kinetex/graphql";
import type { Page, PaginationState } from "kinetex/pagination";
import type { LogEntry, LogTransport, LoggerConfig } from "kinetex/logging";
import type { ResponseParseOptions, SizeLimitConfig } from "kinetex/response";
import type { Cookie, CookieJSON } from "kinetex/cookiejar";
import type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerState,
  FailureFilter,
} from "kinetex/circuit-breaker";
import type { DedupOptions } from "kinetex/dedup";
import type { DigestChallenge } from "kinetex/digest";
import type {
  WSState,
  WSMessage,
  WSClientConfig,
  WSCloseEvent,
  WSBackpressureInfo,
  WSSubscribedRoom,
} from "kinetex/ws";
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
import type { AWSCredentials, SigningConfig, CredentialProvider } from "kinetex/aws-sigv4";
import type { Socks5ProxyConfig, Socks5Tunnel, Socks5Target, TcpConnector } from "kinetex/socks5";
import type { FetchTransportOptions } from "kinetex/core";
import type { OTelTracer, OTelSpan } from "kinetex";
import type { SafeJSONParseOptions, SafeJSONParseResult, ErrorContext } from "kinetex";
import type {
  ParsedURL,
  URLBuilderOptions,
  URLPattern,
  URLPatternMatch,
  URLDiff,
  DataURLParts,
} from "kinetex/url";
```

---

## Worker Entry Point

Cloudflare Workers / Vercel Edge / WinterCG safe entry point:

```ts
import {
  kinetex,
  Kinetex,
  FluentRequest,
  BatchQueue,
  createMethodCircuitBreakerKey,
} from "kinetex/worker";
// Only exports types and classes safe for edge environments.
// No Node.js-specific imports, no HTTP/2 transport.
// Also exports error classes: KinetexError, HTTPStatusError, TimeoutError, NetworkError, RedirectError

const client = kinetex({ baseURL: "https://api.example.com" });
// Uses FetchTransport (globalThis.fetch) automatically.
// Defaults to HTTP/1.1 for maximum edge compatibility.
// httpVersion: "HTTP/2" is ignored here — the HTTP/2 transport needs node:http2,
// which this entry point deliberately excludes. Use the main entry on Node.js.
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

| Feature                                   | Node 18+                 | Node 22+ | Deno          | Bun           | Browser       | CF Workers    | Vercel Edge   |
| ----------------------------------------- | ------------------------ | -------- | ------------- | ------------- | ------------- | ------------- | ------------- |
| HTTP/1.1 fetch                            | ✓                        | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |
| HTTP/2 (fetch, via Alt-Svc/runtime hints) | ✓*                       | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |
| HTTP/2 (NodeHTTP2Transport)               | ✗                        | ✓        | ✗             | ✗             | ✗             | ✗             | ✗             |
| HTTP/3 (detection via Alt-Svc)            | ✓*                       | ✓*       | ✓*            | ✓*            | experimental  | ✓*            | ✓*            |
| WebSocket (WSClient)                      | ✗¹ (no native WebSocket) | ✓        | ✓             | ✓             | ✓             | partial²      | ✗³            |
| SOCKS5 proxy                              | ✓                        | ✓        | ✓             | ✓             | ✗             | ✗             | ✗             |
| Blob                                      | ✓                        | ✓        | ✓             | ✓             | ✓             | guarded       | guarded       |
| DOMException                              | ✓                        | ✓        | ✓             | ✓             | ✓             | guarded       | guarded       |
| Buffer                                    | ✓                        | ✓        | ✓             | ✓             | ✗             | ✗             | ✗             |
| crypto.subtle                             | ✓                        | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |
| ReadableStream                            | ✓                        | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |
| URL pattern matching                      | ✓                        | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |
| Brotli decompression                      | ✓                        | ✓        | ✗ passthrough | ✗ passthrough | ✗ passthrough | ✗ passthrough | ✗ passthrough |
| Gzip/deflate decompression                | ✓                        | ✓        | ✓             | ✓             | ✓             | ✓             | ✓             |

\* HTTP/2+ detection is best-effort and internal. kinetex's own `detectHTTPVersion()` helper (not exported) reports HTTP/2 only when the runtime exposes protocol evidence — a response `httpVersion`/`protocol` property, or an `Alt-Svc` header — and otherwise reports `HTTP/1.1`. The version on every `KinetexResponse` comes from that heuristic, so it is not a guarantee. This is accurate for Node 18's undici fetch, which does not negotiate h2 by default; use `NodeHTTP2Transport` (Node 22+) when you need guaranteed HTTP/2.

¹ WSClient requires a native `WebSocket` constructor. Node added one in v22 — on Node 18 use a polyfill (`globalThis.WebSocket = require('undici').WebSocket`).

² Cloudflare Workers exposes a `WebSocket` constructor, but outbound client connections depend on runtime support.

³ Vercel Edge has no stable outbound `WebSocket` client API.

**URL pattern matching**: kinetex's `compilePattern` / `URLPattern` type (`kinetex/url`) is a built-in implementation — works identically in every runtime, does not use the native `URLPattern` API.

**Brotli**: `decompressStream` uses `node:zlib.createBrotliDecompress()` on Node.js only. On all other runtimes, brotli-encoded bodies pass through compressed (WHATWG `DecompressionStream` does not support brotli), surfacing as a parse error downstream — servers should not negotiate `br` for non-Node clients.

---

## Resource Cleanup

```ts
await client.destroy();
// Closes all HTTP/2 sessions (NodeHTTP2Transport.destroy())
// Closes all tracked WebSocket connections
// Clears dedup map
// Clears circuit breakers
// Clears all interceptors
// Nullifies cookie jar and logger references
```

`destroy()` releases resources — it does **not** delete cached data. A user-supplied storage adapter (`localStorage`, Cloudflare KV, Redis, …) would otherwise lose every persisted entry on teardown. To empty the cache explicitly:

```ts
const cache = await client.getCache();
await cache?.clear();
```

---

## License

MIT
