/**
 * All shared types, generics, and interfaces for kinetex.
 */

// ============================================================================
// §1  RUNTIME DETECTION
// ============================================================================

/** Supported runtime identifiers. */
export type Runtime =
  "node" | "deno" | "bun" | "browser" | "cloudflare-workers" | "edge" | "unknown";

// ============================================================================
// §2  HTTP PRIMITIVES
// ============================================================================

/** HTTP method strings (upper-cased). */
export type HTTPMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE" | "CONNECT";

/**
 * HTTP protocol versions the library can actually use.
 *
 * When set in {@link KinetexRequest.httpVersion}, the client attempts to use the specified version.
 * Falls back to the next available version if the requested version is unavailable:
 * - `HTTP/2` requires ALPN negotiation or h2 upgrade support
 *
 * In most runtimes (Deno, Bun, Browser), HTTP/2 is negotiated automatically over TLS.
 * On Node.js, use {@link createTransport} with `preferHTTP2: true` for HTTP/2 support.
 *
 * `HTTP/3` is deliberately absent. As of this writing no runtime kinetex targets
 * ships an HTTP/3 *client* — Node's QUIC work is not in a stable release,
 * Deno's `fetch` has no HTTP/3, and Bun's `node:quic` is listen-only — so
 * offering the value let callers request something that silently came back as
 * HTTP/2. A server that advertises `Alt-Svc: h3` is reported as `HTTP/2`,
 * which is the protocol the response was really served over.
 */
export type HTTPVersion = "HTTP/1.0" | "HTTP/1.1" | "HTTP/2";

/**
 * Branded type utility — creates a nominal subtype.
 *
 * Use to prevent accidental mixing of semantically different values
 * that share the same underlying type.
 *
 * @example
 * ```ts
 * type UserId  = Brand<string, "UserId">;
 * type OrderId = Brand<number, "OrderId">;
 *
 * function getUser(id: UserId) { ... }
 * getUser("abc" as UserId);    // OK
 * getUser(123 as unknown as UserId); // Error
 * ```
 */
export type Brand<T, B extends string> = T & {
  /** Brand discriminator — prevents accidental mixing of semantically different values that share the same underlying type. */
  readonly __brand: B;
};

/** Branded type for request identifiers — prevents mixing up with other strings. */
export type RequestId = Brand<string, "RequestId">;

/**
 * Create a RequestId from a string.
 * @param id - The string to wrap.
 * @returns The branded RequestId.
 */
export function toRequestId(id: string): RequestId {
  return id as RequestId;
}

/**
 * A header source: a plain record, a WHATWG `Headers` instance, or an array of
 * `[name, value]` pairs. The last two forms are accepted because callers often
 * forward a `Headers` object or a serialised pair list straight from `fetch`.
 */
export type HeadersInit =
  Record<string, string | string[] | number | boolean | null | undefined> | Headers | string[][];

/** Serializable query parameter value types. */
export type QueryValue = string | number | boolean | null | undefined;

/** Query parameter map — supports arrays for repeated keys. */
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

/**
 * How array query parameters are encoded.
 *
 * - `"bracket"` (default) — `a[]=1&a[]=2`, matching axios' default serializer.
 * - `"repeat"` — `a=1&a=2`, the historical kinetex spelling.
 */
export type QueryArrayFormat = "bracket" | "repeat";

/**
 * Query serializer used by axios-style request configs.
 *
 * A function receives the merged query parameters and returns the encoded
 * query string (with or without a leading `?`). The object form matches the
 * shape axios 1.x accepts.
 */
export type ParamsSerializer =
  | ((params: QueryParams) => string)
  | {
      /** Encode the parameters into a query string. */
      serialize: (params: QueryParams) => string;
    };

/**
 * Controls how the response body is decoded.
 *
 * Mirrors axios `responseType`. `arraybuffer` returns a `Uint8Array` (which is
 * also what Node callers get from axios' Buffer-backed response), `blob`
 * returns a `Blob`, and `stream` returns a Node `Readable` on Node or a
 * `ReadableStream` elsewhere.
 */
export type ResponseType = "json" | "text" | "arraybuffer" | "blob" | "stream";

/**
 * Request body types accepted by kinetex.
 * Compatible with the Fetch API's BodyInit.
 *
 * Note: `null` is a valid body value indicating no body should be sent.
 * This is different from `undefined` which means "use default". All request
 * builders handle `null` correctly by omitting the body from the fetch call.
 */
export type BodyInit =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | URLSearchParams
  | FormData
  | Blob
  | null;

// ============================================================================
// §3  REQUEST
// ============================================================================

/**
 * Fully-resolved request object passed through the pipeline.
 *
 * @typeParam M - HTTP method
 */
export interface KinetexRequest<M extends HTTPMethod = HTTPMethod> {
  /** Fully-qualified URL string. */
  readonly url: string;
  /** HTTP method. */
  readonly method: M;
  /** Normalized request headers (lowercase keys). */
  readonly headers: Record<string, string>;
  /** Serialized request body (null for bodyless methods). */
  readonly body: BodyInit | null;
  /** AbortSignal for cancellation. */
  readonly signal: AbortSignal | null;
  /** Arbitrary per-request metadata — freely readable/writable by hooks. */
  readonly meta: Record<string, unknown>;
  /** Preferred HTTP version. Falls back if unavailable. */
  readonly httpVersion?: HTTPVersion;
  /**
   * Redirect mode passed to fetch.
   * - `"follow"` (default) — automatically follow redirects.
   * - `"manual"` — return the redirect response as-is (used internally for cookie-jar redirect following).
   * - `"error"` — throw on any redirect.
   */
  readonly redirect?: "follow" | "manual" | "error";
  /**
   * Whether redirects are followed. `false` returns the 3xx response as-is,
   * matching `redirect: "manual"`. Default: true.
   */
  readonly followRedirects?: boolean;
  /**
   * Maximum number of redirect hops to follow. `0` disables following.
   * Default: 20 (browser-compatible).
   */
  readonly maxRedirects?: number;
}

/**
 * Mutable builder state — accumulates options before `.send()`.
 *
 * ⚠️ This is an internal type used by the request builder. Do not use directly.
 * It is exported for advanced use cases (e.g., middleware that needs to inspect
 * or modify the builder state), but most users should use the public API.
 */
export interface RequestState {
  /** Target URL. */
  url: string;
  /** HTTP method. */
  method: HTTPMethod;
  /** Request headers (lowercase keys). */
  headers: Record<string, string>;
  /** Query parameters. */
  query: QueryParams;
  /** Serialized request body (null for bodyless methods). */
  body: BodyInit | null;
  /** AbortSignal for cancellation. */
  signal: AbortSignal | null;
  /** Arbitrary per-request metadata. */
  meta: Record<string, unknown>;
  /** Preferred HTTP version. */
  httpVersion?: HTTPVersion;
  /** Request timeout in ms. */
  timeout?: number;
  /** Number of retry attempts. */
  retries?: number;
  /** Delay between retries in ms. */
  retryDelay?: number;
  /** HTTP status codes that trigger a retry. */
  retryStatuses?: number[];
  /** Whether to follow redirects. */
  followRedirects?: boolean;
  /** Maximum number of redirects. */
  maxRedirects?: number;
  /** Authentication configuration. */
  auth?: AuthConfig;
  /** Proxy configuration. */
  proxy?: ProxyConfig;

  cache?: CacheRequestConfig;
  /** Maximum response body size in bytes. */
  sizeLimit?: number;
  /** Upload progress callback. */
  onUploadProgress?: ProgressCallback;
  /** Download progress callback. */
  onDownloadProgress?: ProgressCallback;
  /** Tags for grouping/categorization. */
  tags?: string[];
}

// ============================================================================
// §4  RESPONSE
// ============================================================================

/**
 * Parsed, typed HTTP response.
 *
 * @typeParam T - Parsed body type
 */
export interface KinetexResponse<T = unknown> {
  /** HTTP status code. */
  readonly status: number;
  /** HTTP status text. */
  readonly statusText: string;
  /** Normalized response headers (lowercase keys). */
  readonly headers: Record<string, string>;
  /** Parsed response body. */
  readonly data: T;
  /** Raw response body bytes (before parsing). */
  readonly rawBody: Uint8Array | null;
  /**
   * The same bytes as a string, for an interceptor-phase view of this response.
   *
   * Always the same bytes as {@link rawBody}. It exists so a response
   * satisfies `InterceptorResponse` without a cast, which is what lets one
   * interceptor type serve both sides of the pipeline; prefer `rawBody` in new
   * code.
   */
  readonly body: string | Uint8Array | null;
  /**
   * The underlying runtime response, when one exists.
   *
   * Absent on a response the client synthesised (a cache hit or a redirect-free
   * replay), which is why it is optional rather than `null`.
   */
  readonly raw?: unknown;
  /** Final URL after redirects. */
  readonly url: string;
  /** Whether this response was served from cache. */
  readonly cached: boolean;
  /** Whether the request was redirected. */
  readonly redirected: boolean;
  /** HTTP version used. */
  readonly httpVersion: HTTPVersion;
  /** Total request duration in ms. */
  readonly durationMs: number;
  /** The originating request. */
  readonly request: KinetexRequest;
  /** Attempt number (1 = first try, 2+ = retries). */
  readonly attempt: number;
}

// ============================================================================
// §5  ERRORS
// ============================================================================

/**
 * Base error codes used by kinetex.
 *
 * - ENETWORK: Server/endpoint unreachable (not proxy-related)
 * - EPROXY: Proxy configuration or proxy connection error
 * - ETIMEOUT: Request/connection timeout
 * - EABORT: Request cancelled by caller
 * - EHTTPSTATUS: Server returned 4xx/5xx status
 * - ESIZELIMIT: Response body exceeded size limit
 * - EPARSE: Failed to parse response body
 * - EVALIDATION: Invalid request configuration
 * - EAUTH: Authentication failed
 * - EREDIRECT: Redirect error (too many, invalid location, etc.)
 * - EUNKNOWN: Unknown/unexpected error
 */
export type KinetexErrorCode =
  | "ENETWORK"
  | "ETIMEOUT"
  | "EABORT"
  | "EHTTPSTATUS"
  | "ESIZELIMIT"
  | "EPARSE"
  | "EVALIDATION"
  | "EAUTH"
  | "EPROXY"
  | "EREDIRECT"
  /** A host was refused because it resolves into blocked address space. */
  | "EBLOCKEDHOST"
  | "EUNKNOWN";

const VALID_ERROR_CODES = [
  "ENETWORK",
  "ETIMEOUT",
  "EABORT",
  "EHTTPSTATUS",
  "ESIZELIMIT",
  "EPARSE",
  "EVALIDATION",
  "EAUTH",
  "EPROXY",
  "EREDIRECT",
  "EUNKNOWN",
] as const satisfies readonly KinetexErrorCode[];

/**
 * Validate a string is a known `KinetexErrorCode`.
 * @param code - The error code string to validate.
 * @returns The validated code if valid, otherwise `undefined`.
 */
export function validateErrorCode(code: unknown): KinetexErrorCode | undefined {
  if (typeof code === "string") {
    for (const valid of VALID_ERROR_CODES) {
      if (valid === code) return valid;
    }
  }
  return undefined;
}

/**
 * Base kinetex error.
 *
 * Note: The `code` parameter accepts any string at runtime. The `KinetexErrorCode`
 * type is a TypeScript hint for valid codes, but no runtime validation is performed.
 * This is intentional for flexibility. For stricter validation, use `validateErrorCode()`.
 */
export class KinetexError extends Error {
  /** Machine-readable error code. */
  readonly code: KinetexErrorCode;
  /** Original request, if available. */
  readonly request?: KinetexRequest;
  /** Response, if available (for HTTP-level errors). */
  readonly response?: KinetexResponse<unknown>;
  /** Underlying cause. */
  override readonly cause?: unknown;

  /**
   * @param message - Human-readable error description.
   * @param code - Machine-readable error code.
   * @param options - Additional context (request, response, cause).
   */
  constructor(
    message: string,
    code: KinetexErrorCode,
    options?: {
      request?: KinetexRequest;
      response?: KinetexResponse<unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "KinetexError";
    this.code = code;
    if (options?.request !== undefined) this.request = options.request;
    if (options?.response !== undefined) this.response = options.response;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  /** True if the error is a network/transport failure (not proxy-related). */
  get isNetwork(): boolean {
    return this.code === "ENETWORK";
  }

  /** True if the error is a proxy-related failure. */
  get isProxy(): boolean {
    return this.code === "EPROXY";
  }

  /** True if the error is a timeout. */
  get isTimeout(): boolean {
    return this.code === "ETIMEOUT";
  }

  /** True if the request was aborted by the caller. */
  get isAbort(): boolean {
    return this.code === "EABORT";
  }

  /** True if the server returned a 4xx or 5xx status. */
  get isHTTPError(): boolean {
    return this.code === "EHTTPSTATUS";
  }

  /** HTTP status code shorthand (null for non-HTTP errors). */
  get status(): number | null {
    return this.response?.status ?? null;
  }
}

/**
 * Thrown when the response body exceeds the configured size limit.
 * @param bytesRead - Number of bytes read before exceeding the limit.
 * @param limit - Configured size limit in bytes.
 * @param request - The request that triggered the error.
 */
export class SizeLimitError extends KinetexError {
  constructor(
    /** Number of bytes read before exceeding the limit. */
    public readonly bytesRead: number,
    /** Configured size limit in bytes. */
    public readonly limit: number,
    request?: KinetexRequest,
  ) {
    super(
      `Response size limit exceeded: ${bytesRead} bytes read, limit is ${limit} bytes`,
      "ESIZELIMIT",
      request !== undefined ? { request } : {},
    );
    this.name = "SizeLimitError";
  }
}

/**
 * Thrown when the server returns a 4xx or 5xx status.
 * @param response - The HTTP response that caused the error.
 * @param request - The request that produced the response.
 */
export class HTTPStatusError extends KinetexError {
  constructor(response: KinetexResponse<unknown>, request: KinetexRequest) {
    super(`HTTP ${response.status} ${response.statusText} — ${response.url}`, "EHTTPSTATUS", {
      request,
      response,
    });
    this.name = "HTTPStatusError";
  }

  /** True if the status is a 4xx client error. */
  get isClientError(): boolean {
    return (this.status ?? 0) >= 400 && (this.status ?? 0) < 500;
  }

  /** True if the status is a 5xx server error. */
  get isServerError(): boolean {
    return (this.status ?? 0) >= 500;
  }
}

/**
 * Thrown when a request is aborted.
 * @param request - The request that was aborted, if available.
 */
export class AbortError extends KinetexError {
  constructor(request?: KinetexRequest) {
    super("Request was aborted", "EABORT", request !== undefined ? { request } : {});
    this.name = "AbortError";
  }
}

/**
 * Thrown when a network error occurs.
 * @param message - Human-readable error description.
 * @param request - The request that triggered the error, if available.
 */
export class NetworkError extends KinetexError {
  constructor(message: string, request?: KinetexRequest) {
    super(message, "ENETWORK", request !== undefined ? { request } : {});
    this.name = "NetworkError";
  }
}

/**
 * Thrown when a validation error occurs.
 * @param message - Description of the validation failure.
 * @param request - The invalid request, if available.
 */
export class ValidationError extends KinetexError {
  constructor(message: string, request?: KinetexRequest) {
    super(message, "EVALIDATION", request !== undefined ? { request } : {});
    this.name = "ValidationError";
  }
}

/**
 * Thrown when an authentication error occurs.
 * @param message - Description of the authentication failure.
 * @param request - The request that failed authentication, if available.
 */
export class AuthError extends KinetexError {
  constructor(message: string, request?: KinetexRequest) {
    super(message, "EAUTH", request !== undefined ? { request } : {});
    this.name = "AuthError";
  }
}

/**
 * Thrown when a proxy error occurs.
 * @param message - Description of the proxy failure.
 * @param request - The request that triggered the proxy error, if available.
 */
export class ProxyError extends KinetexError {
  constructor(message: string, request?: KinetexRequest) {
    super(message, "EPROXY", request !== undefined ? { request } : {});
    this.name = "ProxyError";
  }
}

/**
 * Thrown when a redirect error occurs.
 * @param message - Description of the redirect failure.
 * @param request - The request that encountered the redirect error, if available.
 */
export class RedirectError extends KinetexError {
  constructor(message: string, request?: KinetexRequest) {
    super(message, "EREDIRECT", request !== undefined ? { request } : {});
    this.name = "RedirectError";
  }
}

/**
 * Thrown when a request times out.
 * @param timeoutMs - The timeout duration in milliseconds.
 * @param request - The request that timed out, if available.
 */
export class TimeoutError extends KinetexError {
  constructor(
    /** The timeout duration in milliseconds. */
    public readonly timeoutMs: number,
    request?: KinetexRequest,
  ) {
    super(
      `Request timed out after ${timeoutMs}ms`,
      "ETIMEOUT",
      request !== undefined ? { request } : {},
    );
    this.name = "TimeoutError";
  }
}

// ============================================================================
// §6  AUTH
// ============================================================================

/** Authentication configuration. */
export type AuthConfig =
  | {
      /** Bearer authentication. */
      type: "bearer";
      /** Token value or a factory function that returns one. */
      token: string | (() => string | Promise<string>);
    }
  | {
      /** HTTP Basic authentication. */
      type: "basic";
      /** Username for basic auth. */
      username: string;
      /** Password for basic auth. */
      password: string;
    }
  | {
      /** API key sent via a custom header. */
      type: "apikey";
      /** HTTP header name carrying the key. */
      header: string;
      /** API key value or a factory function that returns one. */
      key: string | (() => string | Promise<string>);
    }
  | {
      /** HTTP Digest authentication. */
      type: "digest";
      /** Username for digest auth. */
      username: string;
      /** Password for digest auth. */
      password: string;
    }
  | {
      /** Custom authentication handler. */
      type: "custom";
      /**
       * Custom authentication transform.
       * @returns Modified request, or void to leave request unchanged.
       */
      apply: (req: KinetexRequest) => KinetexRequest | Promise<KinetexRequest> | void;
    };

// ============================================================================
// §7  PROXY
// ============================================================================

/** Proxy configuration. */
export interface ProxyConfig {
  /** Proxy URL: http://, https://, socks5://, socks5h:// */
  url: string;
  /** Username for proxy authentication. */
  username?: string;
  /** Password for proxy authentication. */
  password?: string;
}

// ============================================================================
// §8  RETRY
// ============================================================================

/** Retry policy configuration. */
export interface RetryConfig {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries: number;
  /**
   * Ceiling on the total wall-clock time for the request, retries and backoff
   * included. Defaults to the request `timeout`, so `timeout` bounds the whole
   * call rather than each attempt. `0` disables the ceiling entirely.
   *
   * `timeout` applies to one attempt, and the backoff between attempts is not
   * bounded by it either: with `timeout: 1_000`, `maxRetries: 5` and a growing
   * `baseDelayMs`, a failing endpoint held the caller for well over a minute.
   * That is fine for a background job and wrong for anything on a request path,
   * so this bounds the whole thing. When the budget is exhausted the last
   * error is rethrown rather than replaced, so the cause is still visible.
   */
  totalTimeoutMs?: number;
  /** Base delay in ms (exponential back-off base). Default: 300 */
  baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs: number;
  /** Jitter factor 0–1. Default: 0.3 */
  jitter: number;
  /** HTTP status codes that trigger a retry. Default: [408,429,500,502,503,504] */
  statuses: number[];
  /** Retry on network errors (ENETWORK). Default: true */
  onNetworkError: boolean;
  /**
   * Retry on timeout errors (ETIMEOUT). Default: false
   *
   * Timeouts indicate the server is genuinely slow for this request.
   * Retrying will usually just time out again and burn the full
   * `timeout × maxRetries` budget. Set to `true` only if your server
   * has known transient latency spikes you want to ride out.
   */
  onTimeout: boolean;
  /** HTTP methods eligible for retry. Default: ["GET","HEAD","PUT","DELETE","OPTIONS","TRACE"] */
  methods: HTTPMethod[];
  /**
   * Custom predicate — overrides statuses + onNetworkError when provided.
   * @param context - Retry context with request, response, error, and attempt info.
   */
  shouldRetry?: (context: RetryContext) => boolean | Promise<boolean>;
  /** Called before each retry with the upcoming delay. */
  onRetry?: (context: RetryContext, delayMs: number) => void | Promise<void>;
}

/** Context passed to retry callbacks. */
export interface RetryContext {
  /** The original request being retried. */
  request: KinetexRequest;
  /** The response from the failed attempt (null if no response). */
  response: KinetexResponse<unknown> | null;
  /** The error that triggered the retry. */
  error: unknown;
  /** Current attempt number (1 = first try). */
  attempt: number;
  /** Maximum number of retry attempts configured. */
  maxRetries: number;
}

// ============================================================================
// §9  CACHE (request-level config)
// ============================================================================

/** Per-request cache configuration. */
export interface CacheRequestConfig {
  /** If false, bypass cache entirely. Default: true */
  enabled?: boolean;
  /** Override TTL in ms for this specific request. */
  ttlMs?: number;
  /** Cache tags for targeted invalidation. */
  tags?: string[];
  /** If true, force a fresh fetch and update the cache. */
  forceRefresh?: boolean;
}

// ============================================================================
// §10  PROGRESS
// ============================================================================

/** Progress event snapshot. */
export interface ProgressEvent {
  /** Bytes transferred so far. */
  loaded: number;
  /** Total bytes (null if unknown). */
  total: number | null;
  /** Completion percentage 0–100, null if total unknown. */
  percent: number | null;
  /** Transfer rate in bytes/sec (EMA-smoothed). */
  rate: number;
  /** ETA in ms (null if unavailable). */
  eta: number | null;
  /** Elapsed ms since transfer started. */
  elapsed: number;
  /** Whether the transfer is complete. */
  done: boolean;
}

/** Progress callback. */
export type ProgressCallback = (event: ProgressEvent) => void;

// ============================================================================
// §11  INTERCEPTORS (public types)
// ============================================================================

/**
 * An interceptor that can modify, replace, or short-circuit a request.
 *
 * Return values:
 * - `void` / `undefined` — pass through (possibly mutated ctx.request)
 * - `KinetexRequest` — replace the request
 * - `KinetexResponse` — short-circuit; skip the actual fetch
 * - throw — abort the pipeline with that error
 */
export type RequestInterceptor = (
  ctx: InterceptorContext,
) =>
  | void
  | undefined
  | KinetexRequest
  | KinetexResponse<unknown>
  | import("./interceptors.ts").InterceptorResponse
  | Promise<
      | void
      | undefined
      | KinetexRequest
      | KinetexResponse<unknown>
      | import("./interceptors.ts").InterceptorResponse
    >;

/**
 * An interceptor that can modify or replace a response, or trigger a retry.
 *
 * Return values:
 * - `void` / `undefined` — pass through
 * - `KinetexResponse` — replace the response
 * - `KinetexRequest` — retry (re-run from dispatch)
 * - throw — convert to error pipeline
 */
export type ResponseInterceptor = (
  ctx: InterceptorContext,
) =>
  | void
  | undefined
  | KinetexResponse<unknown>
  | import("./interceptors.ts").InterceptorResponse
  | KinetexRequest
  | Promise<
      | void
      | undefined
      | KinetexResponse<unknown>
      | import("./interceptors.ts").InterceptorResponse
      | KinetexRequest
    >;

/**
 * An interceptor that can recover from errors.
 *
 * Return values:
 * - `void` — rethrow the error
 * - `KinetexResponse` — recover with a synthetic response
 * - throw — replace with a different error
 */
export type ErrorInterceptor = (
  ctx: InterceptorContext,
) => void | KinetexResponse<unknown> | Promise<void | KinetexResponse<unknown>>;

/** Context threaded through the interceptor pipeline. */
/**
 * The context an interceptor receives.
 *
 * This is an alias, not a second declaration. There used to be two incompatible
 * `InterceptorContext` types — one here over `KinetexRequest` /
 * `KinetexResponse`, one in `src/interceptors.ts` over `InterceptorRequest` /
 * `InterceptorResponse` — so an interceptor written against one could not be
 * passed to an API typed against the other, and every crossing point needed a
 * cast. `InterceptorRequest` is now an alias of `KinetexRequest` and both
 * responses share a shape, so one definition is correct.
 */
export type InterceptorContext = import("./interceptors.ts").InterceptorContext;

// ============================================================================
// §12  LIFECYCLE HOOKS (public types)
// ============================================================================

/** All lifecycle hook registrations. */
export interface LifecycleHooks {
  /** Before the request is sent. */
  onBeforeRequest?: Array<
    (
      req: KinetexRequest,
      ctx: HookContext,
    ) => KinetexRequest | void | Promise<KinetexRequest | void>
  >;
  /** After the request is sent (before response is processed). */
  onAfterRequest?: Array<(req: KinetexRequest, ctx: HookContext) => void | Promise<void>>;
  /** Before the response is returned to the caller. */
  onBeforeResponse?: Array<
    (
      res: KinetexResponse<unknown>,
      ctx: HookContext,
    ) => KinetexResponse<unknown> | void | Promise<KinetexResponse<unknown> | void>
  >;
  /** After the response is returned. */
  onAfterResponse?: Array<
    (res: KinetexResponse<unknown>, ctx: HookContext) => void | Promise<void>
  >;
  /** On error (may return a recovery response). */
  onError?: Array<
    (
      err: unknown,
      ctx: HookContext,
    ) => KinetexResponse<unknown> | void | Promise<KinetexResponse<unknown> | void>
  >;
  /** Before a retry attempt. */
  onRetry?: Array<(ctx: RetryContext) => void | Promise<void>>;
  /** On upload progress. */
  onUploadProgress?: Array<ProgressCallback>;
  /** On download progress. */
  onDownloadProgress?: Array<ProgressCallback>;
}

/** Context available to all lifecycle hooks. */
export interface HookContext {
  /** The request being processed. */
  request: KinetexRequest;
  /**
   * The response received (null before dispatch or on error).
   *
   * Typed as the shared {@link import("./interceptors.ts").InterceptorResponse}
   * rather than `KinetexResponse`: hooks run during the interceptor phase, so
   * they see `body`, not `data`. Naming the richer type here was the third copy
   * of the same shape, and every hook had to be narrowed at its boundary.
   */
  response: import("./interceptors.ts").InterceptorResponse | null;
  /** The error that occurred (null on success). */
  error: unknown | null;
  /** Monotonic start time in ms. */
  startedAt: number;
  /** Current attempt number (1 = first try). */
  attempt: number;
  /** Arbitrary hook-scoped metadata. */
  meta: Record<string, unknown>;
}

// ============================================================================
// §13  CLIENT CONFIG
// ============================================================================

/**
 * HTTP/2 session pool tuning.
 *
 * Only applies on Node.js, and only when the client uses the built-in
 * `NodeHTTP2Transport` — that is, when no custom `fetch` is configured and
 * `httpVersion` is not `"HTTP/1.1"`. On every other runtime, and whenever
 * `FetchTransport` is selected, requests are pooled by the runtime's own
 * `fetch` implementation, which this client does not configure; these options
 * are then ignored.
 *
 * @example
 * ```ts
 * const client = kinetex({
 *   sessionPool: { maxSessions: 20, sessionTTLMs: 120_000 },
 * });
 * ```
 */
export interface SessionPoolConfig {
  /**
   * How long a cached session may be reused before it is evicted, in ms.
   * Default: `300_000` (5 minutes).
   */
  sessionTTLMs?: number;

  /**
   * Interval between HTTP/2 keepalive pings, in ms. A ping failure evicts the
   * session. Set to `0` to disable keepalive pings. Default: `30_000`.
   */
  pingIntervalMs?: number;

  /**
   * Maximum number of concurrently cached sessions (one per origin), with
   * least-recently-used eviction. Default: `100`.
   */
  maxSessions?: number;

  /**
   * HTTP/2 connection (CONNECT) timeout in ms. Default: `30_000`.
   */
  connectTimeoutMs?: number;

  /**
   * HTTP/2 per-stream request timeout in ms. Default: `30_000`.
   */
  requestTimeoutMs?: number;

  /**
   * Use a dedicated keep-alive agent on the legacy HTTP/1.1 (`node:https`)
   * path, which only runs on Node.js versions without a global `fetch` (< 18).
   *
   * This path previously inherited `https.globalAgent`, whose `keepAlive`
   * default flipped on in Node 19 — so the same code handshaked per request on
   * Node 18 and pooled on Node 20+. An explicit agent makes the behaviour
   * consistent, and bounds the idle-socket pool that the global agent's 256
   * free sockets would otherwise hold open.
   *
   * Default: `true`.
   */
  http1KeepAlive?: boolean;

  /**
   * Maximum number of idle sockets retained by the legacy HTTP/1.1 keep-alive
   * agent. Default: `16`.
   */
  http1MaxSockets?: number;
}

/**
 * Global configuration for a `Kinetex` client instance.
 */
export interface KinetexConfig {
  /**
   * Base URL prepended to all relative request URLs.
   * @example "https://api.example.com/v1"
   */
  baseURL?: string;

  /** Default headers sent with every request. */
  headers?: HeadersInit;

  /** Default query parameters appended to every request URL. */
  params?: QueryParams;

  /** Default request timeout in ms. 0 = no timeout. Default: 30_000 */
  timeout?: number;
  /**
   * Ceiling on the whole request — every attempt and every backoff. Defaults to
   * `timeout`, so `timeout` bounds the whole call rather than each attempt.
   * Set `0` to disable, or a larger value to allow a longer retry chain than a
   * single attempt may take.
   */
  totalTimeoutMs?: number;

  /** Default retry policy. */
  retry?: Partial<RetryConfig>;

  /** Default authentication. */
  auth?: AuthConfig;

  /** Proxy configuration. */
  proxy?: ProxyConfig;
  /**
   * Permit requests to hosts that resolve into private, loopback or link-local
   * address space. Default: `false`.
   *
   * A hostname is screened as written, but the socket is dialled at whatever the
   * name resolves to. By default the resolved address is checked too, so a name
   * answering with `127.0.0.1` or `169.254.169.254` is refused — the DNS
   * rebinding case, which needs only control of the domain being requested.
   *
   * Set this to `true` to reach a service on `localhost`, a private network or a
   * container network: local development, a service mesh, and any test that
   * stands up a local server all need it. Leave it unset wherever the URLs being
   * requested are influenced by someone else.
   *
   * Node's HTTP/2 and HTTP/1.1 transports only. A configured custom `fetch` or
   * `dispatcher` resolves through that implementation instead, which has no
   * `lookup` hook to install — with those set, this option has no effect.
   */
  allowPrivateNetwork?: boolean;

  /**
   * Additional CA certificate(s) to trust, as PEM strings, on top of the
   * system store.
   *
   * Node's HTTP/2 and HTTP/1.1 transports only. A configured custom `fetch` or
   * `dispatcher` negotiates TLS through that implementation instead, and
   * `fetch` exposes no CA option — honouring it would need an undici
   * `Agent`, which this package does not depend on. Give such a setup its own
   * dispatcher instead. The same caveat applies to
   * {@link allowPrivateNetwork}.
   *
   * Needed to reach an origin whose certificate a private CA issued, which is
   * every internal service mesh and most enterprise proxies.
   */
  ca?: string | string[];

  /** HTTP cache configuration. */
  cache?: import("./cache.ts").CacheConfig; // Import type from cache module

  /** Logging configuration. */
  logger?: import("./logging.ts").LoggerConfig | false;

  /** Whether to throw on HTTP error status codes (4xx/5xx). Default: true */
  throwOnError?: boolean;

  /**
   * Maximum response body size in bytes, applied while the body is buffered.
   * `0` disables the limit. Default: 104857600 (100 MB).
   *
   * Without a ceiling a hostile or broken server can drive the process out of
   * memory: the body is read in full before the caller sees any of it.
   */
  maxResponseSize?: number;

  /** Maximum request body size in bytes. 0 = no limit. Default: 0 */
  maxRequestSize?: number;

  /** Axios-compatible alias for {@link maxResponseSize}. */
  maxContentLength?: number;

  /** Axios-compatible alias for {@link maxRequestSize}. */
  maxBodyLength?: number;

  /**
   * Default response decoding for every request.
   *
   * When omitted, kinetex's content-type-driven parser is used.
   */
  responseType?: ResponseType;

  /**
   * Decide whether an HTTP status is successful. Returning `false` throws
   * {@link HTTPStatusError}; `null` accepts every status. When omitted,
   * {@link throwOnError} controls 4xx/5xx responses.
   */
  validateStatus?: ((status: number) => boolean) | null;

  /** Default custom query-string serializer. */
  paramsSerializer?: ParamsSerializer;

  /**
   * How array query parameters are encoded. Default: `"bracket"`.
   *
   * `"bracket"` matches axios (`a[]=1&a[]=2`); `"repeat"` preserves the older
   * kinetex spelling (`a=1&a=2`).
   */
  arrayFormat?: QueryArrayFormat;

  /**
   * Disable transparent `content-encoding` decompression.
   *
   * Node transports honour this; a custom `fetch` transport may have decoded
   * the body before kinetex sees it and cannot be reversed.
   */
  decompress?: boolean;

  /** Follow redirects. Default: true */
  followRedirects?: boolean;

  /** Maximum number of redirects to follow. Default: 10 */
  maxRedirects?: number;

  /** Enforce HTTPS-only requests. Rejects HTTP URLs. Default: false */
  httpsOnly?: boolean;

  /** Preferred HTTP version. Default: "HTTP/2" */
  httpVersion?: HTTPVersion;

  /**
   * HTTP/2 session pool tuning. Node.js only, and ignored when a custom
   * `fetch` is supplied (that forces {@link FetchTransport}, which cannot use
   * a session pool). See {@link SessionPoolConfig}.
   */
  sessionPool?: SessionPoolConfig;

  /**
   * Bound how many requests may be in flight at once (a bulkhead).
   *
   * Distinct from {@link KinetexConfig.rateLimit}, which bounds requests per
   * unit of _time_ and releases its token at dispatch — so `rateLimit: 100`
   * per minute still permits 100 simultaneous sockets. A permit here is held
   * for the whole request, including its retries, and returned when it
   * settles.
   *
   * @example
   * ```ts
   * const client = kinetex({
   *   concurrencyLimit: { maxConcurrent: 8 },
   * });
   * ```
   */
  concurrencyLimit?: import("./interceptors.ts").ConcurrencyLimitConfig;

  /** Custom fetch implementation (useful for testing). */
  fetch?: typeof globalThis.fetch;

  /**
   * A `fetch` implementation extension forwarded verbatim to the runtime —
   * most usefully an `undici` dispatcher (`Agent`, `ProxyAgent`, `MockAgent`),
   * which is the only way to control HTTP/1.1 connection pooling, route
   * through an HTTP(S) proxy, or inject mock responses.
   *
   * Typed as `unknown` to keep kinetex dependency-free. Node's `fetch` reads
   * `init.dispatcher`; Deno and Bun ignore it.
   *
   * Supplying this forces the fetch transport, since the Node HTTP/2
   * transport has no notion of a dispatcher — see {@link SessionPoolConfig}.
   *
   * @example
   * ```ts
   * import { Agent } from "undici";
   *
   * const client = kinetex({
   *   dispatcher: new Agent({ connections: 32, keepAliveTimeout: 10_000 }),
   * });
   * ```
   */
  dispatcher?: unknown;

  /** Interceptors registered at construction time. */
  interceptors?: {
    /** Request interceptors run before the request is sent. */
    request?: RequestInterceptor[];
    /** Response interceptors run after the response is received. */
    response?: ResponseInterceptor[];
    /** Error interceptors run when an error occurs in the pipeline. */
    error?: ErrorInterceptor[];
  };

  /** Lifecycle hooks registered at construction time. */
  hooks?: LifecycleHooks;

  /**
   * Cookie jar instance. Pass `true` to auto-create one,
   * or a pre-existing instance.
   */
  cookieJar?: import("./cookiejar.ts").CookieJar | boolean;

  /** HAR recording. Pass `true` to enable with defaults. */
  har?: boolean;

  /** Global response transform applied after parsing. */
  transformResponse?: <T>(data: unknown, response: KinetexResponse<unknown>) => T;

  /** Global request transform applied before sending. */
  transformRequest?: (req: KinetexRequest) => KinetexRequest | Promise<KinetexRequest>;

  // ── Enterprise Hardening ────────────────────────────────────────────────

  /**
   * Enforce strict header validation.
   *
   * When `true`, requests with invalid header names or values throw a
   * `KinetexError` with code `"EVALIDATION"` instead of silently dropping
   * the offending header. Recommended for production services where silent
   * data loss is unacceptable.
   *
   * Default: `false` — emit `console.warn` and drop.
   *
   * @see Architecture Risk C: Silent Header Dropping
   */
  strictHeaders?: boolean;

  /**
   * Built-in token-bucket rate limiter applied to all outgoing requests.
   *
   * Registered automatically as the highest-priority request interceptor
   * so it runs before auth, cache, and dedup.
   *
   * @example
   * ```ts
   * const client = kinetex({
   *   rateLimit: { limit: 100, windowMs: 60_000 }, // 100 req/min
   * });
   * ```
   *
   * @see Enterprise Hardening #6: Centralized Rate Limit Enforcer
   */
  rateLimit?: {
    /** Maximum requests per window. Default: 60 */
    limit?: number;
    /** Window size in ms. Default: 60_000 (1 minute) */
    windowMs?: number;
    /** If `true`, queue excess requests; if `false`, reject immediately. Default: true */
    queue?: boolean;
    /** Max number of queued requests before rejecting. Default: 100 */
    maxQueue?: number;
  };

  // ── WebSocket client config ──────────────────────────────────────────────
  /**
   * Default WebSocket client configuration inherited by `client.ws()`.
   * These values are merged with per-call options.
   */
  ws?: {
    /** High-water mark in bytes for backpressure. Default: 65536 */
    highWaterMark?: number;
    /** Low-water mark in bytes for backpressure release. Default: 16384 */
    lowWaterMark?: number;
    /** Max outbound messages per second (0 = unlimited). Default: 0 */
    maxSendRate?: number;
    /** Automatically re-join subscribed rooms after reconnect. Default: true */
    keepRooms?: boolean;
  };

  /**
   * Custom function to compute the circuit-breaker key for a request.
   *
   * Default behavior: key = request origin (`https://api.example.com`).
   * Override to scope breakers per-method, per-route, or per-tenant.
   *
   * @example Per-method isolation:
   * ```ts
   * const client = kinetex({
   *   circuitBreakerKeyFn: (req) =>
   *     `${new URL(req.url).origin}:${req.method}`,
   * });
   * ```
   *
   * @see Enterprise Hardening #2: Circuit Breaker Per-Method
   */
  circuitBreakerKeyFn?: (req: KinetexRequest) => string;

  /**
   * AWS SigV4 request signing applied automatically to every outgoing request.
   *
   * When set, a `SigV4Signer` is registered as a request interceptor that
   * signs headers (Authorization, x-amz-date, x-amz-content-sha256) before
   * the request is sent. Compatible with all AWS services and API Gateway.
   *
   * @example
   * ```ts
   * const client = kinetex({
   *   baseURL: "https://execute-api.us-east-1.amazonaws.com",
   *   awsSigning: {
   *     credentials: { accessKeyId: "...", secretAccessKey: "..." },
   *     region: "us-east-1",
   *     service: "execute-api",
   *   },
   * });
   * ```
   *
   * @see Enterprise Hardening #3: Optional Request Signing
   */
  awsSigning?: import("./aws-sigv4.ts").SigningConfig;

  /**
   * Pipeline trace callback — called at the start and end of each pipeline
   * stage for every request.
   *
   * Use this for detailed observability without adding interceptors:
   * structured logging, distributed tracing, or performance profiling.
   *
   * The callback is synchronous and must not throw.
   *
   * @example
   * ```ts
   * const client = kinetex({
   *   onPipelineTrace: (step) => {
   *     tracer.addEvent(step.stage, { elapsedMs: step.elapsedMs });
   *   },
   * });
   * ```
   *
   * @see Architecture Risk A: Unclear Responsibility Separation
   */
  onPipelineTrace?: (step: PipelineStep) => void;

  /**
   * Called when a background stale-while-revalidate (SWR) fetch fails.
   *
   * Without this callback, SWR revalidation errors are silently swallowed and
   * stale data continues to be served. Use this hook to monitor revalidation
   * health, increment error counters, or trigger alerts.
   *
   * @param error - The error that caused the revalidation to fail.
   * @param req   - The request that was being revalidated.
   *
   * @example
   * ```ts
   * const client = kinetex({
   *   cache: { ... },
   *   onSWRError: (err, req) => {
   *     metrics.increment("cache.swr_error");
   *     logger.warn("SWR revalidation failed", { url: req.url, error: err });
   *   },
   * });
   * ```
   */
  onSWRError?: (error: unknown, req: KinetexRequest) => void;
}

// ============================================================================
// §13b  PIPELINE TRACE (observability hook for request pipeline steps)
// ============================================================================

/**
 * Names of the distinct processing stages in the kinetex request pipeline.
 *
 * **Execution order:**
 * 1. `request_interceptors`   — all registered request interceptors run in priority order
 * 2. `lifecycle_before`       — `onBeforeRequest` lifecycle hooks
 * 3. `auth`                   — authentication header injection (bearer, basic, api-key, custom)
 * 4. `cache_lookup`           — cache read (short-circuits if HIT)
 * 5. `transport_send`         — actual HTTP send (fetch / HTTP2 / SOCKS5)
 * 6. `response_decompression` — content-encoding decompression (gzip, deflate, br)
 * 7. `response_parse`         — body parsing (JSON, text, binary)
 * 8. `cache_store`            — cache write for cacheable responses
 * 9. `response_interceptors`  — all registered response interceptors
 * 10. `lifecycle_after`       — `onAfterResponse` lifecycle hooks
 * 11. `retry`                 — retry decision + delay (only on failure)
 * 12. `error_interceptors`    — all registered error interceptors (only on error)
 */
export type PipelineStageName =
  | "request_interceptors"
  | "lifecycle_before"
  | "auth"
  | "cache_lookup"
  | "transport_send"
  | "response_decompression"
  | "response_parse"
  | "cache_store"
  | "response_interceptors"
  | "lifecycle_after"
  | "retry"
  | "error_interceptors";

/**
 * A single pipeline trace event emitted via `KinetexConfig.onPipelineTrace`.
 *
 * @example
 * ```ts
 * const client = kinetex({
 *   onPipelineTrace: (step) => {
 *     console.log(`[${step.stage}] ${step.requestId} +${step.elapsedMs}ms`);
 *   },
 * });
 * ```
 */
export interface PipelineStep {
  /** Unique identifier for this request (propagated across retries). */
  requestId: RequestId;
  /** The pipeline stage that just completed (or errored). */
  stage: PipelineStageName;
  /** Elapsed ms since the request started (not since the previous step). */
  elapsedMs: number;
  /** Current retry attempt number (1 = first attempt). */
  attempt: number;
  /** `"start"` when entering a stage, `"end"` when leaving. */
  event: "start" | "end";
  /**
   * Set when this step produced or consumed a cache result.
   * `"hit"` = served from cache, `"miss"` = not in cache, `"store"` = written to cache.
   */
  cacheStatus?: "hit" | "miss" | "store";
  /** Set when the stage ended with an error. */
  error?: unknown;
}

// ============================================================================
// §14  SEND OPTIONS (per-request overrides)
// ============================================================================

/**
 * Options passed to individual request methods — override instance defaults.
 *
 * @typeParam T - Expected parsed response body type.
 */
/**
 * A request body accepted by the public API.
 *
 * In addition to the standard `BodyInit` values, a plain object or array is
 * accepted: when the caller has not set a `content-type` header, kinetex
 * JSON-encodes the value and sends `content-type: application/json`. Setting a
 * `content-type` explicitly disables that behaviour, so the value is then
 * treated as an already-prepared `BodyInit`.
 *
 * (`KinetexRequest.body` stays `BodyInit | null` because the encoding has
 * already happened by the time the request object is built.)
 */
export type RequestBody = BodyInit | Record<string, unknown> | unknown[];

export interface SendOptions<T = unknown> {
  /** Override base URL for this request. */
  baseURL?: string;
  /** Additional / override headers. */
  headers?: HeadersInit;
  /** Query parameters (merged with instance defaults). */
  params?: QueryParams;
  /** Request body. */
  body?: RequestBody;
  /**
   * Axios-compatible alias for {@link body}.
   *
   * Supplying both `body` and `data` is rejected rather than silently choosing
   * one.
   */
  data?: RequestBody;
  /** Override timeout in ms. */
  timeout?: number;
  /** Override the whole-request ceiling for this request. 0 disables it. */
  totalTimeoutMs?: number;
  /** Override retry config. */
  retry?: Partial<RetryConfig> | false;
  /** Override auth. */
  auth?: AuthConfig | false;
  /** Override proxy. */
  proxy?: ProxyConfig | false;
  /** Maximum request body size in bytes. 0 = no limit. */
  maxRequestSize?: number;
  /** Axios-compatible alias for {@link maxRequestSize}. */
  maxBodyLength?: number;
  /** AbortSignal. */
  signal?: AbortSignal;
  /** Per-request cache config. */
  cache?: CacheRequestConfig | false;
  /** Response size limit in bytes. */
  maxResponseSize?: number;
  /** Axios-compatible alias for {@link maxResponseSize}. */
  maxContentLength?: number;
  /** Whether to throw on HTTP 4xx/5xx. */
  throwOnError?: boolean;
  /**
   * Axios-compatible status validator. Returning `false` throws
   * {@link HTTPStatusError}; `null` accepts every status.
   */
  validateStatus?: ((status: number) => boolean) | null;
  /** Axios-compatible query-string serializer. */
  paramsSerializer?: ParamsSerializer;
  /** Override how array query parameters are encoded for this request. */
  arrayFormat?: QueryArrayFormat;
  /** Decode responseType explicitly instead of relying on content-type. */
  responseType?: ResponseType;
  /** Disable transparent content-encoding decompression. */
  decompress?: boolean;
  /**
   * Per-request response transform, applied after parsing and before response
   * interceptors. Runs after the client-level `transformResponse`.
   */
  transformResponse?: (data: unknown, response: KinetexResponse<unknown>) => unknown;
  /** Whether to follow redirects. */
  followRedirects?: boolean;
  /** Max redirects. */
  maxRedirects?: number;
  /** Preferred HTTP version. */
  httpVersion?: HTTPVersion;
  /** Upload progress callback. */
  onUploadProgress?: ProgressCallback;
  /** Download progress callback. */
  onDownloadProgress?: ProgressCallback;
  /** Cache tags for invalidation. */
  tags?: string[];
  /** Response body parser. Defaults to JSON for application/json, text otherwise. */
  parseResponse?: (raw: Uint8Array, headers: Record<string, string>, url: string) => T | Promise<T>;
  /**
   * Called when the default body parser silently falls back from JSON to raw
   * text due to a parse error.
   *
   * This makes implicit type-conversion failures visible without requiring a
   * custom `parseResponse`. Useful for monitoring and debugging content-type
   * mismatches in production.
   *
   * @param raw   - The raw response body bytes.
   * @param error - The parse error that caused the fallback.
   *
   * @example
   * ```ts
   * const res = await client.get<User>("/profile", {
   *   parseFailure: (raw, err) => {
   *     logger.warn("JSON parse failed, got text instead", { error: err.message });
   *   },
   * });
   * ```
   */
  parseFailure?: (raw: Uint8Array, error: Error) => void;
  /**
   * Callback invoked on successful response.
   *
   * Alternative to the promise return pattern. If both `onSuccess` and the
   * promise are used, the callback is invoked first, then the promise resolves.
   *
   * @example
   * ```ts
   * client.get("/data", {
   *   onSuccess: (res) => console.log("Got:", res.data),
   *   onError: (err) => console.error("Failed:", err.message),
   * });
   * ```
   */
  onSuccess?: (res: KinetexResponse<T>) => void;
  /**
   * Callback invoked on request/response error.
   *
   * Called for both network errors and HTTP error responses (4xx/5xx when
   * `throwOnError` is true). Use this for callback-style error handling
   * without try/catch.
   */
  onError?: (err: KinetexError) => void;
  /** Arbitrary metadata attached to the request. */
  meta?: Record<string, unknown>;
}

/**
 * Axios-style request configuration accepted by `client.request(config)`.
 *
 * All {@link SendOptions} fields are accepted, plus `url`, `method` and the
 * axios spellings for the body and response options.
 */
export interface RequestConfig<T = unknown> extends SendOptions<T> {
  /** Absolute URL, or a path resolved against `baseURL`. */
  url?: string;
  /** HTTP method. Case-insensitive; defaults to `GET`. */
  method?: HTTPMethod | string;
  /**
   * Node HTTP agents are not supported because kinetex pools its own
   * connections. Passing one fails with `EVALIDATION` instead of silently
   * ignoring it; use the client's `proxy`/`dispatcher` options instead.
   */
  httpAgent?: unknown;
  /** See {@link RequestConfig.httpAgent}. */
  httpsAgent?: unknown;
}

/** Alias that makes axios migrations read naturally. */
export type AxiosRequestConfig<T = unknown> = RequestConfig<T>;

// ============================================================================
// §15  HAR
// ============================================================================

/**
 * A single HAR log entry conforming to the HTTP Archive specification.
 */
export interface HAREntry {
  /** ISO 8601 timestamp of the request start. */
  startedDateTime: string;
  /** Total elapsed time in ms. */
  time: number;
  /** Serialized request data. */
  request: {
    /** HTTP method. */
    method: string;
    /** Request URL. */
    url: string;
    /** HTTP version string (e.g. "HTTP/1.1", "HTTP/2"). */
    httpVersion: string;
    /** Request headers as name/value pairs. */
    headers: Array<{
      /** Header name. */
      name: string;
      /** Header value. */
      value: string;
    }>;
    /** Query parameters as name/value pairs. */
    queryString: Array<{
      /** Parameter name. */
      name: string;
      /** Parameter value. */
      value: string;
    }>;
    /** Request body size in bytes (-1 if unknown). */
    bodySize: number;
    /** Posted data, if applicable. */
    postData?: {
      /** MIME type of the posted data. */
      mimeType: string;
      /** Plain-text body of the posted data. */
      text: string;
    };
  };
  /** Serialized response data. */
  response: {
    /** HTTP status code. */
    status: number;
    /** HTTP status text. */
    statusText: string;
    /** HTTP version string. */
    httpVersion: string;
    /** Response headers as name/value pairs. */
    headers: Array<{
      /** Header name. */
      name: string;
      /** Header value. */
      value: string;
    }>;
    /** Response content metadata. */
    content: {
      /** Response body size in bytes. */
      size: number;
      /** MIME type of the response. */
      mimeType: string;
      /** Response body text (only included for text responses). */
      text?: string;
    };
    /** Redirect target URL, if applicable. */
    redirectURL: string;
    /** Response body size in bytes (-1 if unknown). */
    bodySize: number;
  };
  /** Timing breakdown in ms. */
  timings: {
    /** Time spent sending the request in ms. */
    send: number;
    /** Time spent waiting for the response in ms. */
    wait: number;
    /** Time spent receiving the response in ms. */
    receive: number;
  };
  /** Cache state before and after the request. */
  cache: {
    /** State of the cache before the request (always null in HAR 1.2). */
    beforeRequest?: null;
    /** State of the cache after the request (always null in HAR 1.2). */
    afterRequest?: null;
  };
}

/**
 * Full HAR log object conforming to the HTTP Archive specification.
 */
export interface HARLog {
  /** HAR spec version (e.g. "1.2"). */
  version: string;
  /** Information about the creator of this HAR log. */
  creator: {
    /** Name of the library/tool that created the log. */
    name: string;
    /** Version of the creating library/tool. */
    version: string;
    /** Optional comment about the creator. */
    comment?: string;
  };
  /** Ordered list of request/response entries. */
  entries: HAREntry[];
}
