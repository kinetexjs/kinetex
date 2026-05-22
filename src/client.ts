/**
 * Main `Kinetex` client class.
 * Wires all subsystems: transport, interceptors, lifecycle hooks,
 * retry, auth, cache, cookie jar, HAR, logging, progress, and SSE/GraphQL/Pagination.
 */

import { ProgressTracker, withUploadProgress } from "./progress.ts";

import { DedupMap, type DedupOptions } from "./dedup.ts";

import {
  CircuitBreakerRegistry,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
} from "./circuit-breaker.ts";

import { WSClient, type WSClientConfig } from "./ws.ts";

import type {
  KinetexConfig,
  KinetexRequest,
  KinetexResponse,
  SendOptions,
  HTTPMethod,
  AuthConfig,
  ProxyConfig,
  RetryConfig,
  InterceptorContext,
  HookContext,
  RetryContext,
  HAREntry,
  HARLog,
  HeadersInit,
  QueryParams,
  QueryValue,
  BodyInit,
  RequestInterceptor,
  ResponseInterceptor,
  ErrorInterceptor,
  PipelineStep,
  PipelineStageName,
} from "./types.ts";

import { KinetexError, HTTPStatusError, toRequestId } from "./types.ts";

import {
  isValidHeaderName,
  isValidHeaderValue,
  isSafeURL,
  uint8ArrayToBase64,
  randomBytes,
} from "./utils.ts";
import { getAuthFingerprint } from "./cache.ts";
import { createRateLimitInterceptor } from "./interceptors.ts";
import { SigV4Signer } from "./aws-sigv4.ts";
import { createDigestAuthorization } from "./digest.ts";

import {
  createTransport,
  sendWithTimeout,
  decompressBodyStream,
  readRawBody,
  parseBody,
  RUNTIME,
  IS_NODE,
  type Transport,
  type RawResponse,
} from "./core.ts";

/** Default retry configuration used when no retry config is provided. */
const DEFAULT_RETRY = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0.3,
  statuses: [408, 429, 500, 502, 503, 504],
  onNetworkError: true,
  onTimeout: false,
  methods: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"],
} satisfies RetryConfig;

// ============================================================================
// §2  INTERCEPTOR STORE — O(1) eject via Map<id, fn>
// ============================================================================

// FIX 14: _interceptorSeq is now a private field of InterceptorStore, not a
// module-level global. Multiple Kinetex instances no longer share the counter.

/**
 * O(1) insertion-ordered interceptor storage with per-instance ID counter.
 * Returns insertion-ordered arrays for iteration via getters.
 */
class InterceptorStore {
  /** Request interceptor map (id → fn). */
  private readonly _req = new Map<number, RequestInterceptor>();
  /** Response interceptor map (id → fn). */
  private readonly _res = new Map<number, ResponseInterceptor>();
  /** Error interceptor map (id → fn). */
  private readonly _err = new Map<number, ErrorInterceptor>();
  /** Monotonic per-instance ID counter for insertion ordering. */
  private _seq = 0;

  /** Request interceptors in registration order. */
  get request(): RequestInterceptor[] {
    return Array.from(this._req.values());
  }
  /** Response interceptors in registration order. */
  get response(): ResponseInterceptor[] {
    return Array.from(this._res.values());
  }
  /** Error interceptors in registration order. */
  get error(): ErrorInterceptor[] {
    return Array.from(this._err.values());
  }

  /**
   * Register a request interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function — call to remove this interceptor.
   */
  addRequest(fn: RequestInterceptor): () => void {
    const id = ++this._seq;
    this._req.set(id, fn);
    return () => {
      this._req.delete(id);
    };
  }

  /**
   * Register a response interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function — call to remove this interceptor.
   */
  addResponse(fn: ResponseInterceptor): () => void {
    const id = ++this._seq;
    this._res.set(id, fn);
    return () => {
      this._res.delete(id);
    };
  }

  /**
   * Register an error interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function — call to remove this interceptor.
   */
  addError(fn: ErrorInterceptor): () => void {
    const id = ++this._seq;
    this._err.set(id, fn);
    return () => {
      this._err.delete(id);
    };
  }

  /** Remove all registered interceptors. */
  clear(): void {
    this._req.clear();
    this._res.clear();
    this._err.clear();
  }
}

// ============================================================================
// §2b  OPENTELEMETRY CONTEXT PROPAGATION
// ============================================================================

/**
 * Minimal interface for an OpenTelemetry-compatible tracer.
 * Kinetex does NOT take a hard dependency on \@opentelemetry/api.
 * Instead, pass a tracer that implements this interface.
 *
 * Compatible with \@opentelemetry/api's `Tracer` interface — just pass
 * `trace.getTracer("kinetex")` from your OTel SDK setup.
 */
export interface OTelTracer {
  /**
   * Start a new OpenTelemetry span.
   *
   * @param name   - The span name (e.g. "HTTP GET").
   * @param options - Optional span options (e.g. `kind` for CLIENT/SERVER).
   * @returns An {@link OTelSpan} instance for recording the span lifecycle.
   */
  startSpan(name: string, options?: { kind?: number }): OTelSpan;
}

/**
 * Minimal interface for an OpenTelemetry-compatible span.
 * Kinetex does NOT take a hard dependency on \@opentelemetry/api.
 */
export interface OTelSpan {
  /**
   * Return the W3C Trace Context for this span.
   *
   * @returns An object with `traceId` (hex string), `spanId` (hex string),
   *          and `traceFlags` (bitmask of trace options).
   */
  spanContext(): {
    /** Trace ID (hex string). */
    traceId: string;
    /** Span ID (hex string). */
    spanId: string;
    /** Trace flags bitmask. */
    traceFlags: number;
  };
  /** Set a key-value attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): this;
  /** Set the span status (OK / ERROR). */
  setStatus(status: { code: number; message?: string }): this;
  /** Record an exception on this span. */
  recordException(err: Error): this;
  /** End the span. */
  end(): void;
}

/**
 * Generate a W3C `traceparent` header value from an OTel span context,
 * or from scratch if no span is provided (random trace/span IDs).
 * @param span - Optional OTel span to derive context from.
 * @returns The traceparent header string, trace ID, and span ID.
 */
function buildTraceparent(span?: OTelSpan): {
  traceparent: string;
  traceId: string;
  spanId: string;
} {
  if (span) {
    const ctx = span.spanContext();
    const flags = ctx.traceFlags.toString(16).padStart(2, "0");
    return {
      traceparent: `00-${ctx.traceId}-${ctx.spanId}-${flags}`,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    };
  }
  // Generate random IDs (16 bytes for trace, 8 bytes for span)
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  return { traceparent: `00-${traceId}-${spanId}-01`, traceId, spanId };
}

/**
 * Generate a hex string of the given length from random bytes.
 * @param len - Desired hex string length (must be even).
 * @returns Hex-encoded random string.
 */
function randomHex(len: number): string {
  return randomBytes(len / 2);
}

// ============================================================================
// §3  HAR RECORDER (inline)
// ============================================================================

/**
 * O(1) ring-buffer HAR entry recorder.
 * Stores up to `maxEntries` entries, evicting oldest first.
 */
class HARRecorder {
  /** Ring buffer of entries keyed by monotonic counter. */
  private readonly _buf = new Map<number, HAREntry>();
  /** Key of the oldest entry (for O(1) eviction). */
  private _head = 0;
  /** Key for the next insertion. */
  private _tail = 0;
  /** Maximum entries before eviction kicks in. */
  private readonly maxEntries: number;

  /**
   * @param maxEntries - Maximum number of entries before eviction (default 10000).
   */
  constructor(maxEntries: number = 10000) {
    this.maxEntries = maxEntries;
  }

  /** All entries in insertion order (internal alias). */
  private get entries(): HAREntry[] {
    return Array.from(this._buf.values());
  }

  /**
   * Record a request/response pair as a HAR entry.
   * @param req - The outgoing request.
   * @param res - The received response.
   * @param wallClockMs - Wall-clock timestamp for the request start.
   */
  record(req: KinetexRequest, res: KinetexResponse<unknown>, wallClockMs: number): void {
    const total = res.durationMs;

    // Timing breakdown: use the Resource Timing API when available (browser + Deno),
    // fall back to splitting total time into wait-only (most honest when timing unavailable).
    let sendMs = 0;
    let waitMs = total;
    let receiveMs = 0;

    try {
      // Browser Resource Timing API — accurate per-request breakdown
      if (
        typeof performance !== "undefined" &&
        typeof performance.getEntriesByType === "function"
      ) {
        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        // Find the most recent entry matching this URL
        const entry = entries.filter((e) => e.name === res.url).pop();
        if (entry && entry.requestStart > 0) {
          sendMs = Math.max(0, entry.responseStart - entry.requestStart);
          receiveMs = Math.max(0, entry.responseEnd - entry.responseStart);
          waitMs = Math.max(0, total - sendMs - receiveMs);
        }
      }
    } catch {
      // Performance API access can throw in some restricted environments — ignore
    }

    const entry: HAREntry = {
      // wallClockMs is Date.now() captured at the start of the request,
      // giving a correct absolute ISO 8601 timestamp as HAR spec requires.
      startedDateTime: new Date(wallClockMs).toISOString(),
      time: total,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: res.httpVersion,
        headers: Object.entries(req.headers).map(([name, value]) => ({ name, value })),
        queryString: (() => {
          try {
            return Array.from(new URL(req.url).searchParams.entries()).map(([name, value]) => ({
              name,
              value,
            }));
          } catch {
            return [];
          }
        })(),
        bodySize: (() => {
          if (!req.body) return 0;
          if (typeof req.body === "string") return new TextEncoder().encode(req.body).byteLength;
          if (req.body instanceof Uint8Array) return req.body.byteLength;
          if (req.body instanceof ArrayBuffer) return req.body.byteLength;
          return -1; // Unknown (stream, FormData, etc.)
        })(),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        httpVersion: res.httpVersion,
        headers: Object.entries(res.headers).map(([name, value]) => ({ name, value })),
        content: {
          size: res.rawBody?.byteLength ?? 0,
          mimeType: res.headers["content-type"] ?? "application/octet-stream",
          ...(typeof res.data === "string" ? { text: res.data } : {}),
        },
        redirectURL: res.headers["location"] ?? "",
        bodySize: res.rawBody?.byteLength ?? 0,
      },
      timings: {
        send: sendMs,
        wait: waitMs,
        receive: receiveMs,
      },
      cache: {},
    };

    // FIX 8: O(1) ring-buffer insert + evict
    this._buf.set(this._tail++, entry);
    if (this._buf.size > this.maxEntries) {
      this._buf.delete(this._head++);
    }
  }

  /**
   * Build the full HAR log from all recorded entries.
   * @returns HARLog object conforming to the HTTP Archive 1.2 spec.
   */
  getHAR(): HARLog {
    return {
      version: "1.2",
      creator: { name: "kinetex", version: "1.0.0", comment: `runtime:${RUNTIME}` },
      entries: [...this.entries],
    };
  }

  /** Clear all recorded entries. */
  clear(): void {
    this._buf.clear();
    this._head = 0;
    this._tail = 0;
  }
  /** Number of entries currently stored. */
  get count(): number {
    return this._buf.size;
  }
}

// ============================================================================
// §4  AUTH RESOLUTION
// ============================================================================

/**
 * Apply authentication configuration to a request.
 * @param req - The request to authenticate.
 * @param auth - Authentication configuration.
 * @returns A new request with auth headers applied.
 * @throws {Error} If custom auth `apply` does not return a KinetexRequest.
 */
async function applyAuth(req: KinetexRequest, auth: AuthConfig): Promise<KinetexRequest> {
  const headers = { ...req.headers };

  switch (auth.type) {
    case "bearer": {
      const token = typeof auth.token === "function" ? await auth.token() : auth.token;
      headers["authorization"] = `Bearer ${token}`;
      break;
    }
    case "basic": {
      // Use ArrayBuffer to avoid creating credential string in memory
      const encoder = new TextEncoder();
      const usernameBytes = encoder.encode(auth.username);
      const passwordBytes = encoder.encode(auth.password);

      // Combine into single buffer: username + ":" + password
      const totalLength = usernameBytes.length + 1 + passwordBytes.length;
      const allBytes = new Uint8Array(totalLength);
      allBytes.set(usernameBytes);
      allBytes.set(encoder.encode(":"), usernameBytes.length);
      allBytes.set(passwordBytes, usernameBytes.length + 1);

      const base64 = uint8ArrayToBase64(allBytes);
      headers["authorization"] = `Basic ${base64}`;

      // Zeroize sensitive data from memory
      usernameBytes.fill(0);
      passwordBytes.fill(0);
      allBytes.fill(0);
      break;
    }
    case "apikey": {
      const key = typeof auth.key === "function" ? await auth.key() : auth.key;
      headers[auth.header.toLowerCase()] = key;
      break;
    }
    case "digest": {
      // Digest auth is handled by the response interceptor:
      // initial request sends no auth header, then on 401 it
      // computes the challenge response and retries.
      break;
    }
    case "custom": {
      const result = auth.apply(req);
      if (!result) throw new Error("Custom auth 'apply' must return a KinetexRequest");
      return result;
    }
    default: {
      const _unreachable: never = auth;
      throw new Error(`Unknown auth type: ${(_unreachable as AuthConfig).type}`);
    }
  }

  return { ...req, headers };
}

// ============================================================================
// §5  URL BUILDING
// ============================================================================

/**
 * Resolve a URL against an optional base and append query parameters.
 * Rejects unsafe URLs (private/loopback addresses). Enforces query param
 * count and URL length limits.
 * @param base - Base URL for relative URL resolution.
 * @param url - Target URL (absolute or relative).
 * @param params - Query parameters to append.
 * @returns Fully-qualified URL string.
 * @throws {KinetexError} EVALIDATION — if URL is unsafe, params exceed limits, or URL too long.
 */
function buildURL(base: string | undefined, url: string, params: QueryParams | undefined): string {
  const MAX_QUERY_PARAM_COUNT = 100;
  const MAX_URL_LENGTH = 8192;

  let full: string;

  if (/^https?:\/\//i.test(url)) {
    full = url;
  } else {
    const b = base ?? "";
    // Use URL for proper path resolution to handle edge cases
    try {
      // FIX 3: Ensure relative paths (without leading /) don't get concatenated
      // directly onto the base, producing e.g. ".../v1users" instead of ".../v1/users".
      // Strategy: strip trailing slash from base, prefix url with "/" when needed,
      // then let the URL constructor resolve correctly.
      const bClean = b.replace(/\/$/, "");
      const p = url.startsWith("/") ? url.slice(1) : url;
      full = new URL(p, bClean + "/").href;
      // Remove trailing slash we added to base only if original url had none
      // (URL constructor is the source of truth — result is always correct)
    } catch {
      // Fallback: simple concatenation — ensure exactly one slash between base and path
      const bClean = b.endsWith("/") ? b : b + "/";
      const p = url.startsWith("/") ? url.slice(1) : url;
      full = bClean + p;
    }
  }

  if (!params || Object.keys(params).length === 0) {
    if (!isSafeURL(full)) {
      throw new KinetexError(
        `URL "${full}" failed safety check — blocked private/loopback address or forbidden scheme`,
        "EVALIDATION",
      );
    }
    return full;
  }

  try {
    const u = new URL(full);
    let paramCount = 0;

    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      const strValue = String(value);
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v !== null && v !== undefined) {
            paramCount++;
            if (paramCount > MAX_QUERY_PARAM_COUNT) {
              throw new KinetexError(
                `Query parameter count ${paramCount} exceeds limit of ${MAX_QUERY_PARAM_COUNT}`,
                "EVALIDATION",
              );
            }
            u.searchParams.append(key, String(v));
          }
        }
      } else {
        paramCount++;
        if (paramCount > MAX_QUERY_PARAM_COUNT) {
          throw new KinetexError(
            `Query parameter count ${paramCount} exceeds limit of ${MAX_QUERY_PARAM_COUNT}`,
            "EVALIDATION",
          );
        }
        u.searchParams.set(key, strValue);
      }
    }
    const result = u.toString();

    // Check URL length limit
    if (result.length > MAX_URL_LENGTH) {
      throw new KinetexError(
        `URL length ${result.length} bytes exceeds limit of ${MAX_URL_LENGTH} bytes`,
        "EVALIDATION",
      );
    }

    // Validate the final URL with params
    if (!isSafeURL(result)) {
      throw new KinetexError(
        `URL "${result}" failed safety check — blocked private/loopback address or forbidden scheme`,
        "EVALIDATION",
      );
    }
    return result;
  } catch (err) {
    if (err instanceof KinetexError) throw err;

    // If URL parsing fails, try building params manually
    if (full.includes("?")) {
      full += "&";
    } else {
      full += "?";
    }
    const paramParts: string[] = [];
    let paramCount = 0;

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v !== null && v !== undefined) {
            paramCount++;
            if (paramCount > MAX_QUERY_PARAM_COUNT) {
              throw new KinetexError(
                `Query parameter count ${paramCount} exceeds limit of ${MAX_QUERY_PARAM_COUNT}`,
                "EVALIDATION",
              );
            }
            paramParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
          }
        }
      } else {
        paramCount++;
        if (paramCount > MAX_QUERY_PARAM_COUNT) {
          throw new KinetexError(
            `Query parameter count ${paramCount} exceeds limit of ${MAX_QUERY_PARAM_COUNT}`,
            "EVALIDATION",
          );
        }
        paramParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
    const result = full + paramParts.join("&");

    // Check URL length limit
    if (result.length > MAX_URL_LENGTH) {
      throw new KinetexError(
        `URL length ${result.length} bytes exceeds limit of ${MAX_URL_LENGTH} bytes`,
        "EVALIDATION",
      );
    }

    return result;
  }
}

// ============================================================================
// §6  HEADER NORMALIZATION
// ============================================================================

/**
 * Merge multiple header sources into a single normalized record.
 * Validates header names and values per RFC 7230.
 * @param sources - Header sources to merge (later sources override earlier).
 * @returns Merged headers with lowercase keys.
 * @throws {KinetexError} EVALIDATION — if any header name or value is invalid.
 */
function mergeHeaders(
  ...sources: (HeadersInit | Record<string, string> | undefined)[]
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const source of sources) {
    if (!source) continue;
    // FIX 17: use Object.keys() — enumerates only own *enumerable* properties,
    // which is what we want. getOwnPropertyNames would also yield non-enumerable
    // properties (e.g. array's "length"), even though the type check below would
    // filter "length" out — the intent is clearer with Object.keys().
    const keys = Object.keys(source);
    for (const k of keys) {
      // Skip dangerous property names even with Object.create(null)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      // Validate header name (RFC 7230) — prevents header injection via malformed names
      if (!isValidHeaderName(k)) {
        throw new KinetexError(
          `Invalid header name: "${k}" — contains forbidden characters`,
          "EVALIDATION",
        );
      }
      // Convert non-string values to strings
      const v = (source as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      const value = Array.isArray(v) ? v.map(String).join(", ") : String(v);
      if (!isValidHeaderValue(value)) {
        throw new KinetexError(
          `Invalid header value for ${k}: contains forbidden characters`,
          "EVALIDATION",
        );
      }
      out[k.toLowerCase()] = value;
    }
  }
  return out;
}

// ============================================================================
// §7  RETRY LOGIC
// ============================================================================

/**
 * Determine whether a request should be retried based on config and context.
 * @param cfg - Retry configuration.
 * @param ctx - Current retry context (error, response, attempt count).
 * @returns Whether a retry should be attempted.
 */
function shouldRetry(cfg: RetryConfig, ctx: RetryContext): boolean | Promise<boolean> {
  if (ctx.attempt > cfg.maxRetries) return false;
  if (!cfg.methods.includes(ctx.request.method as HTTPMethod)) return false;
  if (cfg.shouldRetry) return cfg.shouldRetry(ctx); // caller handles it

  if (ctx.error) {
    const err = ctx.error as KinetexError;
    const code = err.code;
    // Exhaustive switch on error codes — ensures all codes are considered
    switch (code) {
      case "EHTTPSTATUS":
        return cfg.statuses.includes(err.status ?? 0);
      case "ETIMEOUT":
        return cfg.onTimeout === true;
      case "ENETWORK":
        return cfg.onNetworkError;
      case "EABORT":
        return false;
      case "ESIZELIMIT":
        return false;
      case "EPARSE":
        return false;
      case "EVALIDATION":
        return false;
      case "EAUTH":
        return false;
      case "EPROXY":
        return false;
      case "EREDIRECT":
        return false;
      case "EUNKNOWN":
        return false;
      default: {
        code satisfies never;
        return false;
      }
    }
  }

  if (ctx.response) return cfg.statuses.includes(ctx.response.status);
  return false;
}

/**
 * Compute exponential back-off delay with jitter for retries.
 * @param cfg - Retry configuration (base delay, max delay, jitter).
 * @param attempt - Current attempt number (1 = first try).
 * @param retryAfterMs - Server-specified retry-after value, or null.
 * @returns Delay in ms before the next retry.
 */
function computeRetryDelay(cfg: RetryConfig, attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, cfg.maxDelayMs);

  // Cap attempt to prevent overflow in exponential calculation
  const cappedAttempt = Math.min(attempt, 31); // 2^31 would overflow 32-bit int
  const exp = cfg.baseDelayMs * Math.pow(2, cappedAttempt - 1);

  // Check for overflow/infinity before proceeding
  if (!isFinite(exp) || exp > cfg.maxDelayMs) {
    return cfg.maxDelayMs;
  }

  const capped = Math.min(exp, cfg.maxDelayMs);
  return Math.floor(capped + capped * cfg.jitter * Math.random());
}

/**
 * Extract and parse the Retry-After header value.
 * Supports both seconds (RFC 7231) and HTTP-date (RFC 1123) formats.
 * @param headers - Response headers.
 * @returns Delay in ms, or null if no valid Retry-After header is present.
 */
function getRetryAfterMs(headers: Record<string, string>): number | null {
  const ra = headers["retry-after"];
  if (!ra) return null;
  if (/^\d+$/.test(ra.trim())) {
    const seconds = parseInt(ra, 10);
    if (!isFinite(seconds) || seconds < 0) return null;
    const MAX_RETRY_AFTER_SEC = 86_400; // 24 hours
    return Math.min(seconds, MAX_RETRY_AFTER_SEC) * 1000;
  }
  const ms = Date.parse(ra);
  return isNaN(ms) ? null : Math.max(0, Math.min(ms - Date.now(), 86_400_000));
}

// ============================================================================
// §8  MAIN KINETEX CLASS
// ============================================================================

/**
 * The main HTTP client class.
 *
 * @example
 * ```ts
 * import { kinetex } from "kinetex";
 *
 * const client = kinetex({ baseURL: "https://api.example.com" });
 *
 * // Fluent chain
 * const user = await client.get("/users/1").json<User>();
 *
 * // Standard send
 * const res = await client.send<User>({ url: "/users/1", method: "GET" });
 * ```
 */
export class Kinetex {
  /** @internal */
  private readonly cfg: KinetexConfig;
  /** @internal */
  private readonly transport: Transport;
  /** @internal */
  private readonly interceptors: InterceptorStore;
  /** @internal */
  private readonly harRecorder: HARRecorder | null;
  /** @internal */
  private readonly retryConfig: RetryConfig;

  /** Lazily-initialized cache subsystem. */
  private _cache: import("./cache.ts").HTTPCache | null = null;
  /** Lazily-initialized cookie jar subsystem. */
  private _cookieJar: import("./cookiejar.ts").CookieJar | null = null;
  /** Lazily-initialized logger subsystem. */
  private _logger: import("./logging.ts").HTTPLogger | null = null;

  /** Initialization lock to prevent concurrent cache creation. */
  private _cacheInitLock: Promise<void> | null = null;
  /** Initialization lock to prevent concurrent cookie jar creation. */
  private _cookieJarInitLock: Promise<void> | null = null;
  /** Initialization lock to prevent concurrent logger creation. */
  private _loggerInitLock: Promise<void> | null = null;

  /** OpenTelemetry-compatible tracer for distributed tracing. */
  private _otelTracer: OTelTracer | null = null;

  /** Request deduplication map (coalesces identical in-flight GET/HEAD requests). */
  private _dedup: DedupMap<KinetexResponse<unknown>> | null = null;

  /** Circuit breaker registry (per-origin state machines). */
  private _circuitBreakers: CircuitBreakerRegistry | null = null;

  /** Custom circuit breaker key function — defaults to per-origin. */
  private _circuitBreakerKeyFn: ((req: KinetexRequest) => string) | null = null;

  /** Active WebSocket connections tracked for cleanup on destroy(). */
  private readonly _wsClients: Set<WSClient> = new Set();

  /**
   * @param config - Global client configuration.
   */
  constructor(config: KinetexConfig = {}) {
    this.cfg = config;
    this.interceptors = new InterceptorStore();
    this.harRecorder = config.har === true ? new HARRecorder() : null;
    this.retryConfig = { ...DEFAULT_RETRY, ...config.retry };

    // Enterprise Hardening #2: store custom circuit-breaker key function
    if (config.circuitBreakerKeyFn) {
      this._circuitBreakerKeyFn = config.circuitBreakerKeyFn;
    }

    // Rate limiter — registered synchronously (static import at top of file)
    // so it is active for the very first request without any async delay.
    if (config.rateLimit) {
      const rlInterceptor = createRateLimitInterceptor(config.rateLimit);
      this.interceptors.addRequest(rlInterceptor as RequestInterceptor);
    }

    // AWS SigV4 request signing — registered synchronously (static import).
    // Active immediately; no race between first request and interceptor registration.
    if (config.awsSigning) {
      const signer = new SigV4Signer(config.awsSigning);
      this.interceptors.addRequest(async (ctx: InterceptorContext) => {
        const req = ctx.request;
        let signableBody: string | Uint8Array | null = null;
        if (req.body instanceof Uint8Array) signableBody = req.body;
        else if (typeof req.body === "string") signableBody = req.body;
        const signed = await signer.sign({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: signableBody,
        });
        ctx.request = { ...req, headers: signed.headers };
      });
    }

    // Transport — pass strictHeaders option through to FetchTransport
    this.transport = createTransport(
      config.fetch,
      config.httpVersion !== "HTTP/1.1",
      undefined,
      config.strictHeaders ? { strict: true } : undefined,
    );

    // Register config-level interceptors
    if (config.interceptors) {
      config.interceptors.request?.forEach((fn) => this.interceptors.addRequest(fn));
      config.interceptors.response?.forEach((fn) => this.interceptors.addResponse(fn));
      config.interceptors.error?.forEach((fn) => this.interceptors.addError(fn));
    }

    // Digest auth interceptor — handles 401 → parse challenge → retry
    if (config.auth?.type === "digest") {
      const digestConfig = config.auth;
      this.interceptors.addResponse(async (ctx: InterceptorContext) => {
        if (!ctx.response) return;
        if (ctx.response.status !== 401) return;

        const wwwAuth = ctx.response.headers["www-authenticate"];
        if (!wwwAuth || !wwwAuth.toLowerCase().startsWith("digest")) return;

        if (ctx.request.meta.__digestRetried) return;

        const method = ctx.request.method;
        const uri = new URL(ctx.request.url).pathname + new URL(ctx.request.url).search;

        const authHeader = await createDigestAuthorization(
          wwwAuth,
          digestConfig.username,
          digestConfig.password,
          method,
          uri,
        );

        return {
          ...ctx.request,
          headers: { ...ctx.request.headers, authorization: authHeader },
          meta: { ...ctx.request.meta, __digestRetried: true },
        };
      });
    }
  }

  // ── §8.1  Interceptor API ─────────────────────────────────────────────────

  /**
   * Register a request interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function — call to remove this interceptor.
   */
  useRequest(fn: RequestInterceptor): () => void {
    return this.interceptors.addRequest(fn);
  }

  // ── §8.1b  HookRegistry bridge ────────────────────────────────────────────

  /**
   * Attach a `HookRegistry` (from `lifecycle.ts`) to this client.
   *
   * The registry's `beforeRequest` hooks run as request interceptors and
   * its `onError` hooks run as error interceptors, so the full priority /
   * once / conditional system from `lifecycle.ts` is available alongside
   * kinetex's native interceptor API.
   *
   * @param registry - The HookRegistry instance to attach.
   * @returns A single eject function that removes all three bridge interceptors.
   * @example
   * ```ts
   * import { HookRegistry, createLoggingHooks } from "kinetex/lifecycle";
   *
   * const registry = new HookRegistry();
   * const { beforeRequest, afterResponse, onError } = createLoggingHooks();
   * registry.addBeforeRequest(beforeRequest);
   * registry.addAfterResponse(afterResponse);
   * registry.addOnError(onError);
   *
   * const client = kinetex({ baseURL: "https://api.example.com" });
   * client.attachHookRegistry(registry);
   * ```
   */
  attachHookRegistry(registry: import("./lifecycle.ts").HookRegistry): () => void {
    // Bridge before-request hooks as a request interceptor
    const reqEject = this.useRequest(async (ctx) => {
      const hookReq: import("./lifecycle.ts").HookRequest = {
        url: ctx.request.url,
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.body as import("./lifecycle.ts").HookRequest["body"],
        signal: ctx.request.signal,
        meta: ctx.request.meta,
      };
      const hookCtx: import("./lifecycle.ts").HookContext = {
        request: hookReq,
        response: null,
        error: null,
        startedAt: ctx.startedAt,
        attempt: ctx.attempt,
        meta: ctx.request.meta,
      };
      const updated = await registry.runBeforeRequest(hookReq, hookCtx);
      if (updated !== hookReq) {
        ctx.request = { ...ctx.request, ...updated };
      }
    });

    // Bridge after-response hooks as a response interceptor
    const resEject = this.useResponse(async (ctx) => {
      if (!ctx.response) return;
      const hookRes: import("./lifecycle.ts").HookResponse = {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        headers: ctx.response.headers,
        body: ctx.response.rawBody ?? null,
        request: {
          url: ctx.request.url,
          method: ctx.request.method,
          headers: ctx.request.headers,
          body: ctx.request.body as import("./lifecycle.ts").HookRequest["body"],
          signal: ctx.request.signal,
          meta: ctx.request.meta,
        },
      };
      const hookCtx: import("./lifecycle.ts").HookContext = {
        request: hookRes.request,
        response: hookRes,
        error: null,
        startedAt: ctx.startedAt,
        attempt: ctx.attempt,
        meta: ctx.request.meta,
      };
      await registry.runAfterResponse(hookRes, hookCtx);
    });

    // Bridge error hooks as an error interceptor
    const errEject = this.useError(async (ctx) => {
      if (!ctx.error) return;
      const hookErr: import("./lifecycle.ts").HookError = {
        error: ctx.error,
        request: {
          url: ctx.request.url,
          method: ctx.request.method,
          headers: ctx.request.headers,
          body: ctx.request.body as import("./lifecycle.ts").HookRequest["body"],
          signal: ctx.request.signal,
          meta: ctx.request.meta,
        },
        response: null,
        attempt: ctx.attempt,
      };
      const hookCtx: import("./lifecycle.ts").HookContext = {
        request: hookErr.request,
        response: null,
        error: ctx.error,
        startedAt: ctx.startedAt,
        attempt: ctx.attempt,
        meta: ctx.request.meta,
      };
      await registry.runOnError(hookErr, hookCtx);
    });

    // Return a single eject function that removes all three bridges
    return () => {
      reqEject();
      resEject();
      errEject();
    };
  }

  /**
   * Register a response interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function.
   */
  useResponse(fn: ResponseInterceptor): () => void {
    return this.interceptors.addResponse(fn);
  }

  /**
   * Register an error interceptor.
   * @param fn - The interceptor function.
   * @returns Eject function.
   */
  useError(fn: ErrorInterceptor): () => void {
    return this.interceptors.addError(fn);
  }

  // ── §8.2  HAR API ─────────────────────────────────────────────────────────

  /**
   * Get the recorded HAR log.
   * @returns The full HAR log object.
   * @throws If HAR recording was not enabled in config.
   */
  getHAR(): HARLog {
    if (!this.harRecorder)
      throw new KinetexError("HAR recording not enabled. Pass `har: true` in config.", "EUNKNOWN");
    return this.harRecorder.getHAR();
  }

  /** Clear all HAR entries. */
  clearHAR(): void {
    this.harRecorder?.clear();
  }

  // ── §8.3  Cache API ───────────────────────────────────────────────────────

  /**
   * Access the underlying cache instance.
   * Returns null if no cache is configured.
   * Protected by initialization lock to prevent concurrent creation.
   * @returns The cache instance, or null if not configured.
   */
  async getCache(): Promise<import("./cache.ts").HTTPCache | null> {
    if (this._cache) return this._cache;
    if (!this.cfg.cache) return null;

    // Wait for any in-progress initialization
    if (this._cacheInitLock) {
      await this._cacheInitLock;
      return this._cache;
    }

    // Create lock for this initialization
    let resolveInit: () => void = () => {};
    this._cacheInitLock = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    try {
      const { HTTPCache } = await import("./cache.ts");
      this._cache = new HTTPCache(this.cfg.cache);
      return this._cache;
    } finally {
      resolveInit();
      this._cacheInitLock = null;
    }
  }

  // ── §8.4  Cookie Jar API ──────────────────────────────────────────────────

  /**
   * Access the cookie jar instance.
   * Returns null if no cookie jar is configured.
   * Protected by initialization lock to prevent concurrent creation.
   * @returns The cookie jar, or null if not configured.
   */
  async getCookieJar(): Promise<import("./cookiejar.ts").CookieJar | null> {
    if (this._cookieJar) return this._cookieJar;
    if (!this.cfg.cookieJar) return null;

    // Wait for any in-progress initialization
    if (this._cookieJarInitLock) {
      await this._cookieJarInitLock;
      return this._cookieJar;
    }

    // Check if config is a pre-existing instance
    if (this.cfg.cookieJar instanceof Object && "setCookie" in this.cfg.cookieJar) {
      this._cookieJar = this.cfg.cookieJar as import("./cookiejar.ts").CookieJar;
      return this._cookieJar;
    }

    // Create lock for this initialization
    let resolveInit: () => void = () => {};
    this._cookieJarInitLock = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    try {
      const { CookieJar } = await import("./cookiejar.ts");
      this._cookieJar = new CookieJar();
      return this._cookieJar;
    } finally {
      resolveInit();
      this._cookieJarInitLock = null;
    }
  }

  // ── §8.4b  Logger ──────────────────────────────────────────────────────────

  /**
   * Lazily initialize and return the HTTPLogger instance.
   * Returns null if no logger config was provided.
   */
  private async getLogger(): Promise<import("./logging.ts").HTTPLogger | null> {
    if (this._logger) return this._logger;
    if (!this.cfg.logger) return null;

    if (this._loggerInitLock) {
      await this._loggerInitLock;
      return this._logger;
    }

    let resolveInit: () => void = () => {};
    this._loggerInitLock = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    try {
      const { createLogger } = await import("./logging.ts");
      this._logger = createLogger(this.cfg.logger);
      return this._logger;
    } finally {
      resolveInit();
      this._loggerInitLock = null;
    }
  }

  // ── §8.5  Child instance ──────────────────────────────────────────────────

  /**
   * Create a child client that inherits this instance's config,
   * overriding with the provided options.
   *
   * @param overrides - Partial config to override.
   * @returns A new Kinetex child instance.
   */
  extend(overrides: KinetexConfig): Kinetex {
    // Merge config-level interceptors from parent + overrides
    const parentReq = this.cfg.interceptors?.request ?? [];
    const parentRes = this.cfg.interceptors?.response ?? [];
    const parentErr = this.cfg.interceptors?.error ?? [];
    const childReq = overrides.interceptors?.request ?? [];
    const childRes = overrides.interceptors?.response ?? [];
    const childErr = overrides.interceptors?.error ?? [];

    const child = new Kinetex({
      ...this.cfg,
      ...overrides,
      headers: mergeHeaders(this.cfg.headers, overrides.headers),
      params: { ...this.cfg.params, ...overrides.params },
      interceptors: {
        request: [...parentReq, ...childReq],
        response: [...parentRes, ...childRes],
        error: [...parentErr, ...childErr],
      },
    });

    // Inherit runtime-registered interceptors that were NOT in cfg.interceptors
    // (those were already merged above). Comparing by identity to avoid double-registration.
    const cfgReqSet = new Set([...parentReq, ...childReq]);
    const cfgResSet = new Set([...parentRes, ...childRes]);
    const cfgErrSet = new Set([...parentErr, ...childErr]);
    for (const fn of this.interceptors.request) {
      if (!cfgReqSet.has(fn)) child.useRequest(fn);
    }
    for (const fn of this.interceptors.response) {
      if (!cfgResSet.has(fn)) child.useResponse(fn);
    }
    for (const fn of this.interceptors.error) {
      if (!cfgErrSet.has(fn)) child.useError(fn);
    }

    // Inherit circuit breaker, dedup, and otel tracer from parent if child didn't configure its own
    if (this._circuitBreakers && !child._circuitBreakers)
      child._circuitBreakers = this._circuitBreakers;
    if (this._dedup && !child._dedup) child._dedup = this._dedup;
    if (this._otelTracer && !child._otelTracer) child._otelTracer = this._otelTracer;

    return child;
  }

  // ── §8.5b  OTel Tracer ────────────────────────────────────────────────────

  /**
   * Set an OpenTelemetry-compatible tracer.
   * When set, kinetex automatically injects `traceparent` and `tracestate`
   * headers (W3C Trace Context) into every outgoing request, and creates
   * a child span for each request with standard HTTP semantic attributes.
   *
   * @example
   * ```ts
   * import { trace } from "@opentelemetry/api";
   * const client = kinetex({ baseURL: "https://api.example.com" });
   * client.setTracer(trace.getTracer("my-service"));
   * ```
   * @returns This instance for chaining.
   */
  setTracer(tracer: OTelTracer): this {
    this._otelTracer = tracer;
    return this;
  }

  // ── §8.5c  Deduplication ──────────────────────────────────────────────────

  /**
   * Enable in-flight request deduplication.
   *
   * When multiple concurrent requests target the same URL with the same method,
   * they are coalesced into a single network call. All callers receive the
   * same response object once the request completes.
   *
   * Only applies to safe methods (GET and HEAD by default).
   *
   * @example
   * ```ts
   * const client = kinetex({ baseURL: "https://api.example.com" });
   * client.enableDedup({ windowMs: 50 }); // also dedupe for 50ms after completion
   *
   * // These three calls make exactly ONE network request:
   * const [a, b, c] = await Promise.all([
   *   client.get("/users"),
   *   client.get("/users"),
   *   client.get("/users"),
   * ]);
   * ```
   * @returns This instance for chaining.
   */
  enableDedup(options?: DedupOptions): this {
    this._dedup = new DedupMap<KinetexResponse<unknown>>(options);
    return this;
  }

  /**
   * Disable in-flight request deduplication.
   * @returns This instance for chaining.
   */
  disableDedup(): this {
    this._dedup = null;
    return this;
  }

  /**
   * Returns deduplication metrics.
   *
   * @returns An object with `hits` (coalesced request count), `misses` (actual network request count),
   *          and `inFlightCount` (currently in-flight requests), or `null` if dedup is not enabled.
   */
  get dedupMetrics(): {
    /** Number of requests that shared an in-flight or windowed response. */
    hits: number;
    /** Number of requests that triggered a real network call. */
    misses: number;
    /** Number of currently in-flight requests. */
    inFlightCount: number;
  } | null {
    if (!this._dedup) return null;
    return {
      /** Number of requests that shared an in-flight or windowed response. */
      hits: this._dedup.hits,
      /** Number of requests that triggered a real network call. */
      misses: this._dedup.misses,
      /** Number of currently in-flight requests. */
      inFlightCount: this._dedup.inFlightCount,
    };
  }

  // ── §8.5d  Circuit Breaker ────────────────────────────────────────────────

  /**
   * Enable circuit breaker protection.
   *
   * The circuit breaker tracks failures per origin. When failures exceed the
   * threshold, the circuit opens and requests are rejected immediately with
   * a `CircuitOpenError` — preventing cascading failures to struggling services.
   *
   * @example
   * ```ts
   * const client = kinetex({ baseURL: "https://api.example.com" });
   * client.enableCircuitBreaker({
   *   failureThreshold: 5,
   *   resetTimeoutMs:   15_000,
   *   onOpen:  (s) => logger.warn("Circuit opened", s),
   *   onClose: (s) => logger.info("Circuit recovered", s),
   * });
   * ```
   * @returns This instance for chaining.
   */
  enableCircuitBreaker(config?: CircuitBreakerConfig): this {
    this._circuitBreakers = new CircuitBreakerRegistry(config);
    return this;
  }

  /**
   * Disable circuit breaker protection.
   * @returns This instance for chaining.
   */
  disableCircuitBreaker(): this {
    this._circuitBreakers = null;
    return this;
  }

  /**
   * Manually trip the circuit breaker for a given origin.
   * Useful during maintenance windows.
   * @returns This instance for chaining.
   */
  tripCircuit(origin: string): this {
    this._circuitBreakers?.trip(origin);
    return this;
  }

  /**
   * Manually reset the circuit breaker for a given origin.
   * @returns This instance for chaining.
   */
  resetCircuit(origin: string): this {
    this._circuitBreakers?.reset(origin);
    return this;
  }

  /**
   * Get circuit breaker state snapshots for all tracked origins.
   */
  get circuitSnapshots(): Record<string, CircuitBreakerState> {
    return this._circuitBreakers?.snapshots() ?? {};
  }

  // ── §8.5e  WebSocket ──────────────────────────────────────────────────────

  /**
   * Open a WebSocket connection that inherits this client's headers and auth.
   *
   * @param url - WebSocket endpoint URL (ws:// or wss://).
   * @param options - WebSocket client configuration overrides.
   * @returns A connected WSClient instance.
   * @example
   * ```ts
   * const ws = await client.ws("wss://api.example.com/live", {
   *   onMessage: (msg) => console.log(msg.json),
   * });
   * ws.sendJSON({ type: "subscribe", channel: "prices" });
   * for await (const msg of ws) {
   *   console.log(msg.data);
   * }
   * ```
   */
  async ws(url: string, options: Partial<WSClientConfig> = {}): Promise<WSClient> {
    const fullURL = buildURL(this.cfg.baseURL, url, this.cfg.params);
    const headers = mergeHeaders(this.cfg.headers, options.headers as Record<string, string>);

    // Apply auth headers manually since WS handshake goes through the browser
    // WS API which doesn't use the kinetex transport pipeline.
    const authHeaders: Record<string, string> = {};
    const auth = this.cfg.auth;
    if (auth) {
      if (auth.type === "bearer") {
        const token = typeof auth.token === "function" ? await auth.token() : auth.token;
        authHeaders["authorization"] = `Bearer ${token}`;
      } else if (auth.type === "basic") {
        const _enc = new TextEncoder();
        const _ub = _enc.encode(auth.username);
        const _pb = _enc.encode(auth.password);
        const _jb = new Uint8Array(_ub.length + 1 + _pb.length);
        _jb.set(_ub);
        _jb[_ub.length] = 58;
        _jb.set(_pb, _ub.length + 1);
        const creds = uint8ArrayToBase64(_jb);
        _jb.fill(0);
        _ub.fill(0);
        _pb.fill(0); // zeroize
        authHeaders["authorization"] = `Basic ${creds}`;
      } else if (auth.type === "apikey") {
        const key = typeof auth.key === "function" ? await auth.key() : auth.key;
        authHeaders[auth.header.toLowerCase()] = typeof key === "string" ? key : await key;
      }
    }

    // Inject cookies from cookie jar into WS handshake
    const jar = await this.getCookieJar();
    if (jar) {
      const cookieHeader = jar.getCookieHeader({ url: fullURL, http: false });
      if (cookieHeader) headers["cookie"] = cookieHeader;
    }

    // Validate WebSocket origin against baseURL for security
    try {
      const wsUrl = new URL(fullURL);
      if (this.cfg.baseURL) {
        const baseUrl = new URL(this.cfg.baseURL);
        const wsIsSecure = wsUrl.protocol === "wss:";
        const httpIsSecure = baseUrl.protocol === "https:";
        if (wsIsSecure !== httpIsSecure || wsUrl.host !== baseUrl.host) {
          throw new KinetexError(
            `WebSocket origin ${wsUrl.origin} does not match baseURL origin ${baseUrl.origin}`,
            "EVALIDATION",
          );
        }
      }
    } catch (err) {
      if (err instanceof KinetexError) throw err;
      throw new KinetexError(`Invalid WebSocket URL: ${err}`, "EVALIDATION");
    }

    // Circuit breaker check before connecting
    if (this._circuitBreakers) {
      const cbOrigin = this._circuitBreakerKeyFn
        ? this._circuitBreakerKeyFn({
            url: fullURL,
            method: "GET",
            headers,
            body: null,
            signal: null,
            meta: {},
          })
        : new URL(fullURL).origin;
      const breaker = this._circuitBreakers.get(cbOrigin);
      if (breaker.state === "OPEN") {
        throw new KinetexError(
          `Circuit breaker is open for WebSocket origin ${new URL(fullURL).origin}`,
          "ENETWORK",
        );
      }
    }

    // Merge WS-specific config from KinetexConfig.ws into options
    const wsCfg = this.cfg.ws;
    const mergedOptions: Partial<WSClientConfig> = {
      ...(wsCfg?.highWaterMark !== undefined ? { highWaterMark: wsCfg.highWaterMark } : {}),
      ...(wsCfg?.lowWaterMark !== undefined ? { lowWaterMark: wsCfg.lowWaterMark } : {}),
      ...(wsCfg?.maxSendRate !== undefined ? { maxSendRate: wsCfg.maxSendRate } : {}),
      ...(wsCfg?.keepRooms !== undefined ? { keepRooms: wsCfg.keepRooms } : {}),
      ...options,
    };

    // Wrap onClose to auto-remove from tracked set on any close
    const userOnClose = mergedOptions.onClose;
    const trackingOnClose = (code: number, reason: string, willReconnect: boolean) => {
      if (!willReconnect) this._wsClients.delete(client);
      userOnClose?.(code, reason, willReconnect);
    };

    const client = new WSClient({
      url: fullURL,
      headers: { ...authHeaders, ...(headers as Record<string, string>) },
      ...mergedOptions,
      onClose: trackingOnClose,
    });

    this._wsClients.add(client);

    await client.connect().catch((err) => {
      this._wsClients.delete(client);
      throw err;
    });

    return client;
  }

  // ── §8.6  Core send ───────────────────────────────────────────────────────

  /**
   * Execute an HTTP request.
   *
   * This is the lowest-level public method. All convenience helpers
   * (`get`, `post`, etc.) delegate to this.
   *
   * @typeParam T - Expected parsed response body type.
   * @param url - Request URL (relative to baseURL or absolute).
   * @param method - HTTP method.
   * @param options - Per-request options.
   * @returns A promise resolving to the parsed response.
   */
  async send<T = unknown>(
    url: string,
    method: HTTPMethod,
    options: SendOptions<T> = {},
  ): Promise<KinetexResponse<T>> {
    const startMs = perfNow();
    const wallClockMs = Date.now(); // Absolute wall-clock time for HAR startedDateTime

    // ── Resolve timeout ────────────────────────────────────────────────────
    const timeoutMs =
      options.timeout !== undefined ? options.timeout : (this.cfg.timeout ?? 30_000);

    // ── Resolve retry ──────────────────────────────────────────────────────
    const retryCfg: RetryConfig | false =
      options.retry === false ? false : { ...this.retryConfig, ...(options.retry ?? {}) };

    // ── Validate HTTP method ────────────────────────────────────────────────
    const VALID_METHODS = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
      "TRACE",
      "CONNECT",
    ] as const;
    const normalizedMethod = method.toUpperCase() as (typeof VALID_METHODS)[number];
    if (!(VALID_METHODS as readonly string[]).includes(normalizedMethod)) {
      throw new KinetexError(
        `Invalid HTTP method '${method}'. Valid methods: ${VALID_METHODS.join(", ")}`,
        "EVALIDATION",
      );
    }

    // ── Build initial request ─────────────────────────────────────────────
    const fullUrl = buildURL(
      options.baseURL ?? this.cfg.baseURL,
      url,
      mergeParams(this.cfg.params, options.params),
    );

    // Enforce HTTPS-only if configured
    if (this.cfg.httpsOnly) {
      try {
        const parsedUrl = new URL(fullUrl);
        if (parsedUrl.protocol !== "https:") {
          throw new KinetexError(
            `HTTPS-only mode enabled but URL uses ${parsedUrl.protocol}. Use HTTPS URLs only.`,
            "EVALIDATION",
          );
        }
      } catch (err) {
        if (err instanceof KinetexError) throw err;
        throw new KinetexError(`Invalid URL: ${err}`, "EVALIDATION");
      }
    }

    // Enforce request size limit if configured
    const maxRequestSize = options.maxRequestSize ?? this.cfg.maxRequestSize ?? 0;
    if (maxRequestSize > 0 && options.body) {
      let bodySize = 0;
      if (typeof options.body === "string") {
        bodySize = new TextEncoder().encode(options.body).byteLength;
      } else if (options.body instanceof Uint8Array) {
        bodySize = options.body.byteLength;
      } else if (options.body instanceof ArrayBuffer) {
        bodySize = options.body.byteLength;
      } else if (options.body instanceof Blob) {
        bodySize = options.body.size;
      } else if (options.body instanceof FormData) {
        // FormData size estimation is complex, skip for now
        // In practice, browsers enforce their own limits
      } else if (options.body && typeof options.body === "object") {
        bodySize = JSON.stringify(options.body).length;
      }

      if (bodySize > maxRequestSize) {
        throw new KinetexError(
          `Request body size ${bodySize} bytes exceeds limit of ${maxRequestSize} bytes`,
          "EVALIDATION",
        );
      }
    }

    let req: KinetexRequest = {
      url: fullUrl,
      method,
      headers: mergeHeaders(this.cfg.headers, options.headers),
      body: options.body ?? null,
      signal: options.signal ?? null,
      meta: { ...options.meta },
      httpVersion: options.httpVersion ?? this.cfg.httpVersion ?? "HTTP/2",
    };

    // Default Content-Type for JSON bodies
    if (
      req.body !== null &&
      typeof req.body === "object" &&
      !(req.body instanceof Uint8Array) &&
      !(req.body instanceof ArrayBuffer) &&
      !(req.body instanceof ReadableStream) &&
      !(req.body instanceof FormData) &&
      !(req.body instanceof URLSearchParams) &&
      !(req.body instanceof Blob) &&
      !req.headers["content-type"]
    ) {
      req = {
        ...req,
        headers: { ...req.headers, "content-type": "application/json" },
        body: JSON.stringify(req.body),
      };
    }

    // ── Apply auth ─────────────────────────────────────────────────────────
    const auth = options.auth !== false ? (options.auth ?? this.cfg.auth) : undefined;
    if (auth) req = await applyAuth(req, auth);

    // ── Apply global transformRequest ──────────────────────────────────────
    if (this.cfg.transformRequest) req = await this.cfg.transformRequest(req);

    // ── Cookie jar (outgoing cookies) ──────────────────────────────────────
    const jar = await this.getCookieJar();
    if (jar) {
      const cookieHeader = jar.getCookieHeader({ url: req.url, http: true });
      if (cookieHeader) req = { ...req, headers: { ...req.headers, cookie: cookieHeader } };
    }

    // ── W3C Trace Context propagation (OTel) ──────────────────────────────
    // Inject traceparent (and tracestate if present) into every outgoing
    // request so distributed traces are correctly correlated across services.
    // Works with any OpenTelemetry SDK — just call client.setTracer(tracer).
    // If no tracer is set we still propagate a randomly-generated trace ID
    // when the caller passes options.meta.traceId (useful for manual tracing).
    let _otelSpan: OTelSpan | null = null;
    if (this._otelTracer) {
      _otelSpan = this._otelTracer.startSpan(`HTTP ${req.method}`, { kind: 3 /* CLIENT */ });
      const { traceparent, traceId, spanId } = buildTraceparent(_otelSpan);
      _otelSpan.setAttribute("http.request.method", req.method);
      _otelSpan.setAttribute("url.full", req.url);
      try {
        _otelSpan.setAttribute("server.address", new URL(req.url).hostname);
      } catch {
        // Skip hostname attribute if URL is invalid
      }
      req = {
        ...req,
        headers: { ...req.headers, traceparent },
        meta: { ...req.meta, traceId, spanId },
      };
    } else if (req.meta["traceId"] && !req.headers["traceparent"]) {
      // Manual trace propagation — caller set traceId in meta
      const traceId = String(req.meta["traceId"]);
      const spanId = randomHex(16);
      req = {
        ...req,
        headers: { ...req.headers, traceparent: `00-${traceId}-${spanId}-01` },
        meta: { ...req.meta, spanId },
      };
    }

    // Determine key for dedup + circuit breaker.
    // Uses circuitBreakerKeyFn if configured (e.g. per-method isolation),
    // otherwise defaults to origin-only for broad per-service isolation.
    let _cbOrigin: string;
    if (this._circuitBreakerKeyFn) {
      try {
        _cbOrigin = this._circuitBreakerKeyFn(req);
      } catch {
        _cbOrigin = req.url;
      }
    } else {
      try {
        _cbOrigin = new URL(req.url).origin;
      } catch {
        _cbOrigin = req.url;
      }
    }

    // Core execution factory — produces a fully-parsed KinetexResponse<T>.
    // Wrapped here so dedup caches complete responses (body already read into
    // Uint8Array) and the circuit breaker sees real thrown errors including
    // HTTPStatusError from throwOnError.
    const _execFactory = (): Promise<KinetexResponse<T>> =>
      this._executeWithRetry<T>(req, retryCfg, timeoutMs, options, startMs, wallClockMs);

    // Dedup: coalesce identical concurrent GET/HEAD requests into one network
    // call. All callers share the same KinetexResponse object once resolved.
    // SECURITY: The dedup key includes a fingerprint of auth-sensitive headers
    // so requests from different users (different Authorization / Cookie) are
    // NEVER coalesced — each user gets their own isolated in-flight slot.
    const authFp = await getAuthFingerprint(req.headers ?? {});
    const _dedupKey = `${req.method}:${req.url}${authFp ? ":" + authFp : ""}`;
    const _dedupedFactory: () => Promise<KinetexResponse<T>> = this._dedup
      ? () =>
          (this._dedup as DedupMap<KinetexResponse<unknown>>)
            .execute(req.method, _dedupKey, _execFactory as () => Promise<KinetexResponse<unknown>>)
            .then((r) => r as KinetexResponse<T>)
      : _execFactory;

    // Circuit breaker: short-circuit to CircuitOpenError when open.
    // Wraps dedup so a single failing coalesced request counts as one failure.
    const _guardedFactory: () => Promise<KinetexResponse<T>> = this._circuitBreakers
      ? () =>
          this._circuitBreakers!.execute(_cbOrigin, _dedupedFactory as () => Promise<unknown>).then(
            (r) => r as KinetexResponse<T>,
          )
      : _dedupedFactory;

    try {
      const result = await _guardedFactory();
      if (_otelSpan) {
        _otelSpan.setAttribute("http.response.status_code", result.status);
        _otelSpan.setStatus({ code: result.status < 400 ? 1 /* OK */ : 2 /* ERROR */ });
        _otelSpan.end();
      }
      return result;
    } catch (err) {
      if (_otelSpan) {
        _otelSpan.setStatus({
          code: 2 /* ERROR */,
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Error) _otelSpan.recordException(err);
        _otelSpan.end();
      }
      throw err;
    }
  }

  // ── §8.7  Retry loop ──────────────────────────────────────────────────────

  /**
   * Execute a request with retry logic.
   * Runs the full pipeline (interceptors, cache, transport, parsing)
   * and retries on failure per the retry config.
   */
  private async _executeWithRetry<T>(
    req: KinetexRequest,
    retryCfg: RetryConfig | false,
    timeout: number,
    options: SendOptions<T>,
    startMs: number,
    wallClockMs?: number,
  ): Promise<KinetexResponse<T>> {
    let attempt = 0;
    while (true) {
      attempt++;

      // If caller aborted between retries, stop immediately
      if (req.signal?.aborted) {
        throw createAbortError();
      }

      try {
        const res = await this._executeOnce<T>(
          req,
          timeout,
          options,
          startMs,
          attempt,
          wallClockMs,
          retryCfg,
        );

        // Check if retry needed based on status
        if (retryCfg && attempt <= retryCfg.maxRetries) {
          const retryCtx: RetryContext = {
            request: req,
            response: res as KinetexResponse<unknown>,
            error: null,
            attempt,
            maxRetries: retryCfg.maxRetries,
          };
          const doRetry = retryCfg.shouldRetry
            ? await retryCfg.shouldRetry(retryCtx)
            : shouldRetry(retryCfg, retryCtx);

          if (doRetry) {
            const delay = computeRetryDelay(retryCfg, attempt, getRetryAfterMs(res.headers));
            await retryCfg.onRetry?.(retryCtx, delay);
            await this.cfg.hooks?.onRetry?.reduce(async (p, fn) => {
              await p;
              await fn(retryCtx);
            }, Promise.resolve());
            await sleep(delay, req.signal);
            continue;
          }
        }

        return res;
      } catch (err) {
        if (retryCfg && attempt <= retryCfg.maxRetries) {
          const retryCtx: RetryContext = {
            request: req,
            response: null,
            error: err,
            attempt,
            maxRetries: retryCfg.maxRetries,
          };
          const doRetry = retryCfg.shouldRetry
            ? await retryCfg.shouldRetry(retryCtx)
            : shouldRetry(retryCfg, retryCtx);

          if (doRetry) {
            const delay = computeRetryDelay(retryCfg, attempt, null);
            await retryCfg.onRetry?.(retryCtx, delay);
            await sleep(delay, req.signal);
            continue;
          }
        }

        // Run error interceptors
        const recovered = await this._runErrorInterceptors(req, err, attempt, startMs);
        if (recovered) return recovered as KinetexResponse<T>;

        // Callback-style error
        if (options.onError) {
          const kinetexErr =
            err instanceof KinetexError
              ? err
              : new KinetexError(String(err), "EUNKNOWN", { request: req, cause: err });
          options.onError(kinetexErr);
          throw kinetexErr;
        }

        throw err;
      }
    }
  }

  // ── §8.8a  Cookie-aware redirect following ────────────────────────────────
  //
  // fetch() auto-follows redirects and silently drops Set-Cookie headers from
  // intermediate redirect responses. When a cookie jar is active we must follow
  // redirects ourselves one hop at a time so we can capture cookies at each step.

  /**
   * Follow redirects manually, one hop at a time, to capture Set-Cookie headers.
   * fetch() auto-follows redirects but silently drops Set-Cookie from intermediary hops.
   */
  private async _sendFollowingRedirects(
    req: KinetexRequest,
    timeout: number,
    jar: import("./cookiejar.ts").CookieJar,
    appliedAuth?: AuthConfig | undefined | false,
  ): Promise<RawResponse> {
    const MAX_REDIRECTS = 20;
    let currentReq: KinetexRequest = { ...req, redirect: "manual" as const };
    // Track visited URLs to detect redirect loops
    const visited = new Set<string>();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Apply auth headers on every hop (they may have been lost during redirect)
      if (hop > 0 && appliedAuth) {
        currentReq = await applyAuth(currentReq, appliedAuth);
      }

      // Fire request interceptors and onBeforeRequest hooks on every hop
      // so auth headers, logging, and tracing apply to redirect legs too.
      if (hop > 0 && this.cfg.hooks?.onBeforeRequest) {
        for (const fn of this.cfg.hooks.onBeforeRequest) {
          const result = await fn(currentReq, {
            request: currentReq,
            response: null,
            error: null,
            startedAt: perfNow(),
            attempt: 1,
            meta: currentReq.meta,
          });
          if (result) currentReq = { ...result, redirect: "manual" as const };
        }
      }

      const raw = await sendWithTimeout(this.transport, currentReq, timeout);

      // Log the redirect hop if a logger is active
      if (hop > 0) {
        const logger = await this.getLogger();
        if (logger) {
          const requestId = (currentReq.meta["requestId"] as string) ?? "redirect";
          logger.logResponse(
            requestId,
            raw.status,
            raw.statusText,
            raw.headers,
            new Uint8Array(0),
            1,
            false,
          );
        }
      }

      // Capture Set-Cookie from every intermediate redirect hop.
      // The final response's cookies are handled by _executeOnce as usual.
      const isRedirect = raw.status >= 300 && raw.status < 400 && !!raw.headers["location"];

      if (isRedirect) {
        // Check for redirect loops
        if (visited.has(raw.url)) {
          throw new KinetexError(`Redirect loop detected: ${raw.url}`, "ENETWORK", {
            request: req,
          });
        }
        visited.add(raw.url);

        // Capture cookies from this redirect hop
        jar.processResponseHeaders(raw.headers as Record<string, string | string[]>, {
          url: raw.url,
        });

        if (hop === MAX_REDIRECTS) {
          throw new KinetexError(`Too many redirects (exceeded ${MAX_REDIRECTS})`, "ENETWORK", {
            request: req,
          });
        }

        // Drain the redirect body (usually empty, but must be cancelled)
        if (raw.body) {
          try {
            await raw.body.cancel();
          } catch {
            /* ignore */
          }
        }

        // Resolve the Location — may be relative
        const location = raw.headers["location"]!;
        let nextUrl: string;
        try {
          const locationUrl = new URL(location, raw.url);
          nextUrl = locationUrl.href;

          // Security: Reject unsafe protocols that could be used for SSRF/injection attacks.
          // Note: URL.protocol includes the trailing colon, e.g. "https:" not "https://"
          const protocol = locationUrl.protocol.toLowerCase();
          if (protocol !== "http:" && protocol !== "https:") {
            throw new KinetexError(
              `Unsafe redirect to ${protocol} detected — only HTTP(S) allowed`,
              "ENETWORK",
              { request: req },
            );
          }
        } catch (err) {
          if (err instanceof KinetexError) throw err;
          throw new KinetexError(`Invalid redirect location: ${location}`, "ENETWORK", {
            request: req,
            cause: err,
          });
        }

        // RFC 7231 §6.4: 301/302/303 → GET + drop body
        //                 307/308    → keep original method + body
        const nextMethod: HTTPMethod =
          raw.status === 301 || raw.status === 302 || raw.status === 303
            ? "GET"
            : currentReq.method;
        const nextBody: BodyInit | null =
          nextMethod === "GET" || nextMethod === "HEAD" ? null : currentReq.body;

        // Rebuild Cookie header for the next hop using the updated jar
        const cookieHeader = jar.getCookieHeader({ url: nextUrl, http: true });
        const nextHeaders = { ...currentReq.headers };
        if (cookieHeader) {
          nextHeaders["cookie"] = cookieHeader;
        } else {
          delete nextHeaders["cookie"];
        }

        currentReq = {
          ...currentReq,
          url: nextUrl,
          method: nextMethod,
          body: nextBody,
          headers: nextHeaders,
          redirect: "manual" as const,
        };
        continue;
      }

      // Not a redirect — return the final raw response as-is.
      // _executeOnce will capture its Set-Cookie headers via the normal path.
      return raw;
    }

    // Unreachable
    throw new KinetexError("Redirect loop", "ENETWORK", { request: req });
  }

  // ── §8.8  Single attempt ──────────────────────────────────────────────────

  /**
   * Execute a single request attempt (no retry).
   * Runs the full pipeline: interceptors, lifecycle hooks, cache lookup,
   * transport send, decompression, progress tracking, body parsing,
   * cache store, HAR recording, and response interceptors.
   */
  private async _executeOnce<T>(
    req: KinetexRequest,
    timeout: number,
    options: SendOptions<T>,
    startMs: number,
    attempt: number,
    wallClockMs?: number,
    retryCfg?: RetryConfig | false,
  ): Promise<KinetexResponse<T>> {
    // ── Interceptor context ────────────────────────────────────────────────
    const ctx: InterceptorContext = {
      request: req,
      response: null,
      error: null,
      startedAt: startMs,
      attempt,
      aborted: false,
      store: new Map(),
    };

    // Derive requestId for pipeline tracing — prefer logger-assigned ID, fall back to meta
    const _traceId: string =
      (req.meta["requestId"] as string | undefined) ?? `req-${attempt}-${Date.now()}`;

    // ── Request interceptors ───────────────────────────────────────────────
    this._trace(_traceId, "request_interceptors", "start", startMs, attempt);
    req = await this._runRequestInterceptors(ctx);
    this._trace(_traceId, "request_interceptors", "end", startMs, attempt);

    // ── Lifecycle: before request ──────────────────────────────────────────
    this._trace(_traceId, "lifecycle_before", "start", startMs, attempt);
    if (this.cfg.hooks?.onBeforeRequest) {
      for (const fn of this.cfg.hooks.onBeforeRequest) {
        const result = await fn(req, this._hookCtx(ctx));
        if (result) req = result;
      }
    }
    this._trace(_traceId, "lifecycle_before", "end", startMs, attempt);

    // ── Cache lookup ───────────────────────────────────────────────────────
    if (options.cache !== false && this.cfg.cache) {
      const cache = await this.getCache();
      if (cache) {
        const cacheReq = { url: req.url, method: req.method, headers: req.headers };
        const hit = await cache.get(cacheReq);

        if (hit && !hit.stale) {
          // Fresh cache hit — return immediately, no network call
          const cached = await this._buildResponse<T>(
            hit.entry.response as import("./core.ts").RawResponse,
            req,
            true,
            attempt,
            startMs,
            options,
          );
          if (this.cfg.hooks?.onBeforeResponse) {
            for (const fn of this.cfg.hooks.onBeforeResponse) {
              await fn(cached as KinetexResponse<unknown>, this._hookCtx(ctx));
            }
          }
          return cached;
        }

        if (hit?.stale) {
          // ── Stale-While-Revalidate (SWR) ────────────────────────────────
          // RFC 5861: Serve the stale cached response to the caller immediately,
          // then kick off a background revalidation so the next caller gets fresh data.
          // markSWRInFlight returns false if a revalidation is already running —
          // prevents stampede when many concurrent requests hit the same stale entry.
          const markedInFlight = await cache.markSWRInFlight(cacheReq);
          if (markedInFlight) {
            // Launch background revalidation — fire-and-forget intentionally.
            // We capture errors so unhandled rejections don't crash the process.
            const bgReq = {
              ...req,
              headers: { ...req.headers, ...cache.buildConditionalHeaders(hit.entry) },
            };
            (async () => {
              try {
                const bgRaw = await sendWithTimeout(this.transport, bgReq, timeout);
                const bgCache2 = await this.getCache();
                if (bgCache2) {
                  if (bgRaw.status === 304) {
                    await bgCache2.revalidate(
                      { url: bgReq.url, method: bgReq.method, headers: bgReq.headers },
                      {
                        status: 304,
                        statusText: "Not Modified",
                        headers: bgRaw.headers,
                        body: null,
                      },
                    );
                  } else {
                    const { decompressBodyStream, readRawBody: _readRaw } =
                      await import("./core.ts");
                    const decompressed = await decompressBodyStream(bgRaw.body, bgRaw.headers);
                    const bgRawBody = await _readRaw(decompressed, 0, bgRaw.url, bgReq.signal);
                    await bgCache2.set(
                      { url: bgReq.url, method: bgReq.method, headers: bgReq.headers },
                      {
                        status: bgRaw.status,
                        statusText: bgRaw.statusText,
                        headers: bgRaw.headers,
                        body: bgRawBody,
                      },
                      { tags: options.tags ?? [] },
                    );
                  }
                }
              } catch (revalErr) {
                if (this.cfg.onSWRError) {
                  try {
                    this.cfg.onSWRError(revalErr, bgReq);
                  } catch {
                    /* isolate */
                  }
                }
              } finally {
                (await this.getCache())?.clearSWRInFlight(cacheReq);
              }
            })();
          }
          // Return the stale response immediately to the caller
          const staleRes = await this._buildResponse<T>(
            hit.entry.response as RawResponse,
            req,
            true,
            attempt,
            startMs,
            options,
          );
          return staleRes;
        }
      }
    }

    // ── Upload progress ────────────────────────────────────────────────────
    // Wrap the request body in a progress-tracking ReadableStream so that
    // upload bytes are counted as they flow to the transport.
    // options.onUploadProgress is a single ProgressCallback; hooks may be an array
    const _uploadCbs: import("./types.ts").ProgressCallback[] = [];
    if (options.onUploadProgress) _uploadCbs.push(options.onUploadProgress);
    if (this.cfg.hooks?.onUploadProgress) _uploadCbs.push(...this.cfg.hooks.onUploadProgress);
    const onUpload = _uploadCbs.length > 0 ? _uploadCbs : null;
    let _uploadStreamForCleanup: ReadableStream<Uint8Array> | null = null;
    if (onUpload !== null && req.body !== null) {
      let bodyStream: ReadableStream<Uint8Array> | null = null;
      let bodyTotal: number | null = null;

      if (req.body instanceof ReadableStream) {
        bodyStream = req.body as ReadableStream<Uint8Array>;
      } else if (typeof req.body === "string") {
        const enc = new TextEncoder().encode(req.body);
        bodyTotal = enc.byteLength;
        bodyStream = new ReadableStream({
          start: (c) => {
            c.enqueue(enc);
            c.close();
          },
        });
      } else if (req.body instanceof Uint8Array) {
        bodyTotal = req.body.byteLength;
        bodyStream = new ReadableStream({
          start: (c) => {
            c.enqueue(req.body as Uint8Array);
            c.close();
          },
        });
      } else if (req.body instanceof ArrayBuffer) {
        const arr = new Uint8Array(req.body);
        bodyTotal = arr.byteLength;
        bodyStream = new ReadableStream({
          start: (c) => {
            c.enqueue(arr);
            c.close();
          },
        });
      } else if (typeof Blob !== "undefined" && req.body instanceof Blob) {
        bodyTotal = req.body.size;
        bodyStream = req.body.stream() as ReadableStream<Uint8Array>;
      } else if (typeof URLSearchParams !== "undefined" && req.body instanceof URLSearchParams) {
        const enc = new TextEncoder().encode(req.body.toString());
        bodyTotal = enc.byteLength;
        bodyStream = new ReadableStream({
          start: (c) => {
            c.enqueue(enc);
            c.close();
          },
        });
      }

      if (bodyStream) {
        const { stream } = withUploadProgress(bodyStream, bodyTotal, {
          onProgress: (snap: import("./progress.ts").ProgressSnapshot) => {
            // ProgressSnapshot and ProgressEvent have identical structures
            // This is a safe cast between equivalent types from different modules
            const event: import("./types.ts").ProgressEvent =
              snap as import("./types.ts").ProgressEvent;
            for (const cb of _uploadCbs) cb(event);
          },
          ...(req.signal !== null ? { signal: req.signal } : {}),
        });
        _uploadStreamForCleanup = stream;
        req = { ...req, body: stream };
      }
    }

    // ── Inject Accept-Encoding ────────────────────────────────────────────
    // Advertise compression support so servers compress responses.
    // fetch()-based runtimes (Deno/Bun/Browser) handle this automatically,
    // but Node.js HTTP/2 does not — we must set the header explicitly.
    if (!req.headers["accept-encoding"]) {
      req = {
        ...req,
        headers: {
          ...req.headers,
          "accept-encoding": "gzip, deflate, br",
        },
      };
    }

    // ── Dispatch ───────────────────────────────────────────────────────────
    // When a cookie jar is active we must follow redirects manually so we can
    // capture Set-Cookie headers from every intermediate hop — fetch() drops
    // them silently when auto-following.
    const dispatchJar = await this.getCookieJar();

    this._trace(_traceId, "transport_send", "start", startMs, attempt);
    let raw: RawResponse;
    try {
      raw = dispatchJar
        ? await this._sendFollowingRedirects(
            req,
            timeout,
            dispatchJar,
            options.auth !== false ? (options.auth ?? this.cfg.auth) : undefined,
          )
        : await sendWithTimeout(this.transport, req, timeout);
    } catch (err) {
      // Cancel the progress-tracking ReadableStream to release the underlying
      // resource (byte counter, event listeners) when the transport throws.
      if (_uploadStreamForCleanup) {
        try {
          _uploadStreamForCleanup.cancel("Request failed").catch(() => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
    this._trace(_traceId, "transport_send", "end", startMs, attempt);

    // ── Handle 304 Not Modified ────────────────────────────────────────────
    if (raw.status === 304) {
      const cache = await this.getCache();
      if (cache) {
        const revalidated = await cache.revalidate(
          { url: req.url, method: req.method, headers: req.headers },
          { status: 304, statusText: "Not Modified", headers: raw.headers, body: null },
        );
        if (revalidated) {
          return await this._buildResponse<T>(
            revalidated.response as import("./core.ts").RawResponse,
            req,
            true,
            attempt,
            startMs,
            options,
          );
        }
      }
    }

    // ── Decompress body ───────────────────────────────────────────────────
    // Node.js HTTP/2 does not auto-decompress — we must do it ourselves.
    // fetch()-based runtimes (Deno, Bun, Browser) auto-decompress and set
    // alreadyDecompressed=true. Strip the content-encoding header when the
    // transport already decompressed so we don't double-decompress.
    if (raw.alreadyDecompressed) {
      delete raw.headers["content-encoding"];
      delete raw.headers["Content-Encoding"];
    }
    const decompressedBody = await decompressBodyStream(raw.body, raw.headers);

    // ── Download progress ──────────────────────────────────────────────────
    // Intercept the decompressed stream to count bytes as they are read.
    const _downloadCbs: import("./types.ts").ProgressCallback[] = [];
    if (options.onDownloadProgress) _downloadCbs.push(options.onDownloadProgress);
    if (this.cfg.hooks?.onDownloadProgress) _downloadCbs.push(...this.cfg.hooks.onDownloadProgress);
    const onDownload = _downloadCbs.length > 0 ? _downloadCbs : null;
    let bodyStream = decompressedBody;
    if (onDownload && bodyStream) {
      const contentLength = raw.headers["content-length"];
      const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
      const dlTracker = new ProgressTracker(totalBytes && !isNaN(totalBytes) ? totalBytes : null, {
        onProgress: (snap: import("./progress.ts").ProgressSnapshot) => {
          // ProgressSnapshot and ProgressEvent have identical structures
          // This is a safe cast between equivalent types from different modules
          const event: import("./types.ts").ProgressEvent =
            snap as import("./types.ts").ProgressEvent;
          for (const cb of _downloadCbs) cb(event);
        },
        ...(req.signal !== null ? { signal: req.signal } : {}),
      });
      bodyStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = bodyStream!.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                dlTracker.complete();
                controller.close();
                break;
              }
              dlTracker.update(value.byteLength);
              controller.enqueue(value);
            }
          } catch (e) {
            controller.error(e);
          } finally {
            reader.releaseLock();
          }
        },
        cancel() {
          bodyStream?.cancel();
        },
      });
    }

    // ── Read body with size limit ──────────────────────────────────────────
    const maxSize = options.maxResponseSize ?? this.cfg.maxResponseSize ?? 0;
    const rawBody = await readRawBody(bodyStream, maxSize, raw.url, req.signal);

    // ── Cookie jar (incoming Set-Cookie) ──────────────────────────────────
    const jar = await this.getCookieJar();
    if (jar) {
      jar.processResponseHeaders(raw.headers as Record<string, string | string[]>, {
        url: raw.url,
      });
    }

    // ── Parse body ────────────────────────────────────────────────────────
    const ct = raw.headers["content-type"] ?? null;
    this._trace(_traceId, "response_parse", "start", startMs, attempt);
    const data = (await parseBody<T>(
      rawBody,
      ct,
      options.parseResponse,
      options.parseFailure,
      raw.headers,
      raw.url,
    )) as T;
    this._trace(_traceId, "response_parse", "end", startMs, attempt);

    // ── Build response object ──────────────────────────────────────────────
    const durationMs = perfNow() - startMs;
    const res: KinetexResponse<T> = {
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
      data: this.cfg.transformResponse
        ? this.cfg.transformResponse<T>(data, {} as KinetexResponse<unknown>)
        : data,
      rawBody,
      url: raw.url,
      cached: false,
      redirected: raw.redirected,
      httpVersion: raw.httpVersion,
      durationMs,
      request: req,
      attempt,
    };

    // ── Store in cache ─────────────────────────────────────────────────────
    if (options.cache !== false && this.cfg.cache) {
      const cache = await this.getCache();
      if (cache && raw.status !== 304) {
        await cache.set(
          { url: req.url, method: req.method, headers: req.headers },
          { status: raw.status, statusText: raw.statusText, headers: raw.headers, body: rawBody },
          { tags: options.tags ?? [] },
        );
      }
    }

    // ── Logger ─────────────────────────────────────────────────────────────
    const logger = await this.getLogger();
    if (logger) {
      const requestId =
        (ctx.store.get("requestId") as string) ?? (req.meta["requestId"] as string) ?? "unknown";
      logger.logResponse(
        requestId,
        res.status,
        res.statusText,
        res.headers,
        rawBody,
        attempt,
        false,
      );
    }

    // ── HAR recording ──────────────────────────────────────────────────────
    this.harRecorder?.record(
      req,
      res as KinetexResponse<unknown>,
      wallClockMs ?? Date.now() - res.durationMs,
    );

    // ── Response interceptors ─────────────────────────────────────────────
    ctx.response = res as KinetexResponse<unknown>;
    this._trace(_traceId, "response_interceptors", "start", startMs, attempt);
    const finalRes = await this._runResponseInterceptors<T>(
      ctx,
      res,
      req,
      timeout,
      options,
      startMs,
      attempt,
      retryCfg ?? false,
    );
    this._trace(_traceId, "response_interceptors", "end", startMs, attempt);

    // ── Lifecycle: before response ─────────────────────────────────────────
    if (this.cfg.hooks?.onBeforeResponse) {
      let current = finalRes as KinetexResponse<unknown>;
      for (const fn of this.cfg.hooks.onBeforeResponse) {
        const r = await fn(current, this._hookCtx(ctx));
        if (r) current = r;
      }
    }

    // ── Throw on HTTP error ────────────────────────────────────────────────
    const throwOnErr = options.throwOnError ?? this.cfg.throwOnError ?? true;
    if (throwOnErr && finalRes.status >= 400) {
      throw new HTTPStatusError(finalRes as KinetexResponse<unknown>, req);
    }

    // ── Lifecycle: after response ──────────────────────────────────────────
    if (this.cfg.hooks?.onAfterResponse) {
      for (const fn of this.cfg.hooks.onAfterResponse) {
        await fn(finalRes as KinetexResponse<unknown>, this._hookCtx(ctx));
      }
    }

    // ── Callback-style success ─────────────────────────────────────────────
    options.onSuccess?.(finalRes);

    return finalRes;
  }

  // ── §8.9  Interceptor runners ─────────────────────────────────────────────

  /**
   * Run all registered request interceptors in sequence.
   * Each interceptor may modify the request, replace it, or short-circuit.
   */
  private async _runRequestInterceptors(ctx: InterceptorContext): Promise<KinetexRequest> {
    let req = ctx.request;
    for (const fn of this.interceptors.request) {
      ctx.request = req;
      const result = await fn(ctx);
      if (result && "url" in result && !("status" in result)) {
        req = result as KinetexRequest;
      } else if (ctx.request !== req) {
        req = ctx.request;
      }
    }
    ctx.request = req;
    return req;
  }

  /**
   * Run all registered response interceptors in sequence.
   * Each interceptor may modify the response, replace it, or trigger a retry.
   */
  private async _runResponseInterceptors<T>(
    ctx: InterceptorContext,
    res: KinetexResponse<T>,
    _req: KinetexRequest,
    timeout: number,
    options: SendOptions<T>,
    startMs: number,
    attempt: number,
    retryCfg: RetryConfig | false,
  ): Promise<KinetexResponse<T>> {
    let current = res;
    for (const fn of this.interceptors.response) {
      const result = await fn(ctx);
      if (!result) continue;
      if ("status" in result && "headers" in result) {
        current = result as unknown as KinetexResponse<T>;
      } else if ("url" in result && "method" in result && !("status" in result)) {
        if (retryCfg && attempt <= retryCfg.maxRetries) {
          const retryCtx: RetryContext = {
            request: _req,
            response: res as KinetexResponse<unknown>,
            error: null,
            attempt,
            maxRetries: retryCfg.maxRetries,
          };
          const delay = computeRetryDelay(retryCfg, attempt, 0);
          await retryCfg.onRetry?.(retryCtx, delay);
          await this.cfg.hooks?.onRetry?.reduce(async (p, fn) => {
            await p;
            await fn(retryCtx);
          }, Promise.resolve());
          await sleep(delay, _req.signal);
        }
        return this._executeOnce<T>(
          result as unknown as KinetexRequest,
          timeout,
          options,
          startMs,
          attempt + 1,
          undefined,
          retryCfg,
        );
      }
    }
    return current;
  }

  /**
   * Run all registered error interceptors in sequence.
   * Each interceptor may recover from the error by returning a synthetic response.
   * @returns A recovered response, or null if no interceptor handled the error.
   */
  private async _runErrorInterceptors(
    req: KinetexRequest,
    err: unknown,
    attempt: number,
    startMs: number,
  ): Promise<KinetexResponse<unknown> | null> {
    const ctx: InterceptorContext = {
      request: req,
      response: null,
      error: err,
      startedAt: startMs,
      attempt,
      aborted: false,
      store: new Map(),
    };

    for (const fn of this.interceptors.error) {
      const result = await fn(ctx);
      if (result && "status" in result) return result;
    }

    if (this.cfg.hooks?.onError) {
      for (const fn of this.cfg.hooks.onError) {
        const result = await fn(err, this._hookCtx(ctx));
        if (result) return result;
      }
    }

    return null;
  }

  // ── §8.10  Convenience: build response from cache entry ───────────────────

  // NOTE: _buildResponse is async so parseBody (which may return Promise<T>
  // for async custom parsers) is always properly awaited. Previously sync,
  // which silently returned Promise objects in res.data for cache hits.
  /**
   * Build a KinetexResponse from a raw transport response or cache entry.
   * Parses the body using the configured parser.
   */
  private async _buildResponse<T>(
    raw: RawResponse | import("./cache.ts").CacheableResponse,
    req: KinetexRequest,
    cached: boolean,
    attempt: number,
    startMs: number,
    options: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    const bodyData = raw.body;
    const rawBody =
      bodyData instanceof Uint8Array
        ? bodyData
        : typeof bodyData === "string"
          ? new TextEncoder().encode(bodyData)
          : null;

    // Await parseBody — it may return Promise<T> when parseResponse is async.
    const data = rawBody
      ? await parseBody<T>(
          rawBody,
          raw.headers["content-type"] ?? null,
          options.parseResponse,
          options.parseFailure,
          raw.headers,
          "url" in raw ? (raw as import("./core.ts").RawResponse).url : req.url,
        )
      : (null as T);

    const durationMs = perfNow() - startMs;
    const responseURL = "url" in raw ? (raw as RawResponse).url : req.url;
    const wasRedirected = "redirected" in raw ? (raw as RawResponse).redirected : false;
    const responseHTTPVersion =
      "httpVersion" in raw ? (raw as RawResponse).httpVersion : "HTTP/1.1";

    return {
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
      data,
      rawBody,
      url: responseURL,
      cached,
      redirected: wasRedirected,
      httpVersion: responseHTTPVersion,
      durationMs,
      request: req,
      attempt,
    };
  }

  // ── §8.11  HookContext builder ─────────────────────────────────────────────

  /** Build a HookContext from the current InterceptorContext. */
  private _hookCtx(ictx: InterceptorContext): HookContext {
    return {
      request: ictx.request,
      response: ictx.response,
      error: ictx.error,
      startedAt: ictx.startedAt,
      attempt: ictx.attempt,
      meta: ictx.request.meta,
    };
  }

  /**
   * Emit a pipeline trace event if `onPipelineTrace` is configured.
   * Synchronous and non-throwing — trace errors are silently suppressed.
   *
   * @internal
   */
  private _trace(
    requestId: string,
    stage: PipelineStageName,
    event: "start" | "end",
    startMs: number,
    attempt: number,
    extra?: Partial<Pick<PipelineStep, "cacheStatus" | "error">>,
  ): void {
    if (!this.cfg.onPipelineTrace) return;
    try {
      console.debug("[kinetex:trace]", requestId, stage, event, attempt);
      this.cfg.onPipelineTrace({
        requestId: toRequestId(requestId),
        stage,
        event,
        elapsedMs:
          typeof performance !== "undefined" ? performance.now() - startMs : Date.now() - startMs,
        attempt,
        ...extra,
      });
    } catch {
      // Trace callbacks must never bubble exceptions into the request pipeline
    }
  }

  // ============================================================================
  // §9  CONVENIENCE METHOD API
  // ============================================================================

  /** Execute a GET request. */
  get<T = unknown>(url: string, options?: SendOptions<T>): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "GET", options);
  }

  /** Execute a POST request. */
  post<T = unknown>(
    url: string,
    body?: BodyInit,
    options?: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "POST", { ...options, ...(body !== undefined ? { body } : {}) });
  }

  /** Execute a PUT request. */
  put<T = unknown>(
    url: string,
    body?: BodyInit,
    options?: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "PUT", { ...options, ...(body !== undefined ? { body } : {}) });
  }

  /** Execute a PATCH request. */
  patch<T = unknown>(
    url: string,
    body?: BodyInit,
    options?: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "PATCH", { ...options, ...(body !== undefined ? { body } : {}) });
  }

  /** Execute a DELETE request. */
  delete<T = unknown>(url: string, options?: SendOptions<T>): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "DELETE", options);
  }

  /** Execute a HEAD request. */
  head(url: string, options?: SendOptions<null>): Promise<KinetexResponse<null>> {
    return this.send<null>(url, "HEAD", options);
  }

  /** Execute an OPTIONS request. */
  options<T = unknown>(url: string, options?: SendOptions<T>): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "OPTIONS", options);
  }

  // ============================================================================
  // §10  FLUENT CHAIN ENTRY POINTS
  // ============================================================================

  /** Begin a fluent request chain. */
  request(method: HTTPMethod, url: string): FluentRequest {
    return new FluentRequest(this, method, url);
  }

  /** Begin a fluent GET chain. */
  GET(url: string): FluentRequest {
    return this.request("GET", url);
  }
  /** Begin a fluent POST chain. */
  POST(url: string): FluentRequest {
    return this.request("POST", url);
  }
  /** Begin a fluent PUT chain. */
  PUT(url: string): FluentRequest {
    return this.request("PUT", url);
  }
  /** Begin a fluent PATCH chain. */
  PATCH(url: string): FluentRequest {
    return this.request("PATCH", url);
  }
  /** Begin a fluent DELETE chain. */
  DELETE(url: string): FluentRequest {
    return this.request("DELETE", url);
  }

  // ============================================================================
  // §11  SSE
  // ============================================================================

  /**
   * Open a Server-Sent Events stream.
   *
   * @param url - SSE endpoint URL.
   * @param options - SSE client configuration overrides.
   * @returns An SSEClient instance connected via the full kinetex pipeline.
   */
  async sse(
    url: string,
    options: Partial<import("./sse.ts").SSEClientConfig> = {},
  ): Promise<import("./sse.ts").SSEClient> {
    const { SSEClient } = await import("./sse.ts");
    const headers = mergeHeaders(this.cfg.headers, options.headers);
    const fullURL = buildURL(this.cfg.baseURL, url, this.cfg.params);

    // Route through the full kinetex pipeline (auth, interceptors, rate-limit, CB, etc.)
    // by providing a pipeline-aware fetch function.
    const pipeFetch: typeof fetch = async (input, init) => {
      const reqUrl = typeof input === "string" ? input : (input as Request).url;
      const fi = init as { method?: string; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal };
      const rawRes = await this.send<Uint8Array>(reqUrl, (fi.method ?? "GET") as HTTPMethod, {
        headers: fi.headers as Record<string, string>,
        body: fi.body as BodyInit,
        signal: fi.signal as AbortSignal,
        throwOnError: false,
        parseResponse: (b) => b,
      });
      const respHeaders = { ...rawRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["Content-Encoding"];
      return new Response((rawRes.rawBody?.buffer as ArrayBuffer) ?? null, {
        status: rawRes.status,
        headers: respHeaders,
      });
    };

    return new SSEClient({
      url: fullURL,
      headers,
      fetch: pipeFetch,
      ...options,
    });
  }

  // ============================================================================
  // §12  GRAPHQL
  // ============================================================================

  /**
   * Create a GraphQL client bound to this kinetex instance.
   *
   * @param url - GraphQL endpoint URL.
   * @param options - GraphQL client config overrides.
   * @returns A GraphQLClient instance routed through the full kinetex pipeline.
   */
  async graphql(
    url: string,
    options: Partial<import("./graphql.ts").GraphQLClientConfig> = {},
  ): Promise<import("./graphql.ts").GraphQLClient> {
    const { GraphQLClient } = await import("./graphql.ts");
    const headers = mergeHeaders(this.cfg.headers, options.headers as Record<string, string>);
    const fullURL = buildURL(this.cfg.baseURL, url, this.cfg.params);

    // Route through the full kinetex pipeline (auth, interceptors, rate-limit, CB, OTel, etc.)
    const pipeFetch: typeof fetch = async (input, init) => {
      const reqUrl = typeof input === "string" ? input : (input as Request).url;
      const fi = init as { method?: string; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal };
      const rawRes = await this.send<unknown>(reqUrl, (fi.method ?? "POST") as HTTPMethod, {
        headers: fi.headers as Record<string, string>,
        body: fi.body as BodyInit,
        signal: fi.signal as AbortSignal,
        throwOnError: false,
        parseResponse: (b) => b,
      });
      const respHeaders = { ...rawRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["Content-Encoding"];
      return new Response((rawRes.rawBody?.buffer as ArrayBuffer) ?? null, {
        status: rawRes.status,
        headers: respHeaders,
      });
    };

    return new GraphQLClient({
      url: fullURL,
      headers,
      fetch: pipeFetch,
      ...options,
    });
  }

  // ============================================================================
  // §13  PAGINATION
  // ============================================================================

  /**
   * Create a page-based paginator.
   *
   * @param url - API endpoint URL.
   * @param options - Paginator configuration.
   * @returns An async generator yielding pages.
   */
  async paginate<T>(
    url: string,
    options: Omit<import("./pagination.ts").PagePaginationOptions<T>, "url" | "fetch">,
  ): Promise<AsyncGenerator<import("./pagination.ts").Page<T>>> {
    const { createPagePaginator } = await import("./pagination.ts");
    const fullURL = buildURL(this.cfg.baseURL, url, this.cfg.params);

    // Route through the full kinetex pipeline
    const pipeFetch: typeof fetch = async (input, init) => {
      const reqUrl = typeof input === "string" ? input : (input as Request).url;
      const fi = init as { method?: string; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal };
      const rawRes = await this.send<unknown>(reqUrl, (fi.method ?? "GET") as HTTPMethod, {
        headers: fi.headers as Record<string, string>,
        body: fi.body as BodyInit,
        signal: fi.signal as AbortSignal,
        throwOnError: false,
        parseResponse: (b) => b,
      });
      const respHeaders = { ...rawRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["Content-Encoding"];
      return new Response((rawRes.rawBody?.buffer as ArrayBuffer) ?? null, {
        status: rawRes.status,
        headers: respHeaders,
      });
    };

    return createPagePaginator<T>({
      url: fullURL,
      fetch: pipeFetch,
      headers: mergeHeaders(this.cfg.headers) as Record<string, string>,
      ...options,
    });
  }

  /**
   * Clean up all resources held by this client instance.
   * Call this when the client is no longer needed to prevent memory leaks.
   * @returns A promise that resolves when cleanup is complete.
   */
  async destroy(): Promise<void> {
    // Close all tracked WebSocket connections
    for (const ws of this._wsClients) {
      try {
        ws.close(1000, "Client destroyed");
      } catch {
        /* best-effort */
      }
    }
    this._wsClients.clear();

    if (this._cache) {
      try {
        await this._cache.clear();
      } catch {
        /* best-effort */
      }
    }
    if (IS_NODE && this.transport && "destroy" in this.transport) {
      (this.transport as { destroy: () => void }).destroy();
    }
    this._cookieJar = null;
    this._logger = null;
    this._dedup?.clear();
    this._circuitBreakers?.clear?.();
    this._otelTracer = null;
    this.interceptors.clear();
  }
}

// ============================================================================
// §14  FLUENT REQUEST BUILDER
// ============================================================================

/**
 * Fluent (chained) request builder.
 * Each method returns `this` for chaining; call `.send()` or a parser
 * method to execute.
 *
 * @example
 * ```ts
 * const data = await client
 *   .GET("/users")
 *   .header("x-api-version", "2")
 *   .param("page", 1)
 *   .timeout(5000)
 *   .retry(2)
 *   .json<User[]>();
 * ```
 */
export class FluentRequest {
  /** Accumulated per-request options. */
  private _options: SendOptions = {};
  /** Target URL for this request. */
  private _url: string;

  /**
   * @param client - The parent Kinetex instance.
   * @param method - HTTP method for this request.
   * @param url - Request URL (relative to baseURL or absolute).
   */
  constructor(
    private readonly client: Kinetex,
    private readonly method: HTTPMethod,
    url: string,
  ) {
    this._url = url;
  }

  // ── Headers ────────────────────────────────────────────────────────────────

  /** Set or override a single header. */
  header(name: string, value: string): this {
    this._options.headers = {
      ...(this._options.headers as Record<string, string>),
      [name.toLowerCase()]: value,
    };
    return this;
  }

  /** Merge a headers map. */
  headers(headers: HeadersInit): this {
    this._options.headers = {
      ...(this._options.headers as Record<string, string>),
      ...(headers as Record<string, string>),
    };
    return this;
  }

  // ── Query params ────────────────────────────────────────────────────────────

  /** Set a single query parameter. */
  param(key: string, value: QueryValue): this {
    this._options.params = { ...this._options.params, [key]: value };
    return this;
  }

  /** Merge a query params map. */
  params(params: QueryParams): this {
    this._options.params = { ...this._options.params, ...params };
    return this;
  }

  // ── Body ─────────────────────────────────────────────────────────────────────

  /** Set the request body. */
  withBody(body: BodyInit): this {
    this._options.body = body;
    return this;
  }

  /** Set a JSON body (serializes and sets Content-Type). */
  withJSON(data: unknown): this {
    this._options.body = JSON.stringify(data);
    this._options.headers = {
      ...(this._options.headers as Record<string, string>),
      "content-type": "application/json",
    };
    return this;
  }

  /** Set a FormData body. */
  withForm(data: FormData): this {
    this._options.body = data;
    return this;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────

  /** Set Bearer token authentication. */
  bearer(token: string | (() => string | Promise<string>)): this {
    this._options.auth = { type: "bearer", token };
    return this;
  }

  /** Set Basic authentication. */
  basic(username: string, password: string): this {
    this._options.auth = { type: "basic", username, password };
    return this;
  }

  /** Set API key authentication. */
  apiKey(header: string, key: string): this {
    this._options.auth = { type: "apikey", header, key };
    return this;
  }

  /** Set Digest Access Authentication (RFC 7616). */
  digest(username: string, password: string): this {
    this._options.auth = { type: "digest", username, password };
    return this;
  }

  /** Disable auth for this request. */
  noAuth(): this {
    this._options.auth = false;
    return this;
  }

  // ── Retry ─────────────────────────────────────────────────────────────────────

  /** Set max retry count. */
  retry(maxRetries: number, options?: Partial<RetryConfig>): this {
    this._options.retry = { maxRetries, ...options };
    return this;
  }

  /** Disable retry for this request. */
  noRetry(): this {
    this._options.retry = false;
    return this;
  }

  // ── Timeout ───────────────────────────────────────────────────────────────────

  /** Set request timeout in ms. */
  timeout(ms: number): this {
    this._options.timeout = ms;
    return this;
  }

  // ── Proxy ─────────────────────────────────────────────────────────────────────

  /** Set proxy for this request. */
  proxy(config: ProxyConfig): this {
    this._options.proxy = config;
    return this;
  }

  // ── Cache ─────────────────────────────────────────────────────────────────────

  /** Configure caching for this request. */
  cache(config: import("./types.ts").CacheRequestConfig | false): this {
    this._options.cache = config;
    return this;
  }

  /** Force a fresh fetch, bypassing any cached response. */
  noCache(): this {
    this._options.cache = { forceRefresh: true };
    return this;
  }

  // ── Progress ──────────────────────────────────────────────────────────────────

  /** Register an upload progress callback. */
  onUploadProgress(cb: import("./types.ts").ProgressCallback): this {
    this._options.onUploadProgress = cb;
    return this;
  }

  /** Register a download progress callback. */
  onDownloadProgress(cb: import("./types.ts").ProgressCallback): this {
    this._options.onDownloadProgress = cb;
    return this;
  }

  // ── Signal ────────────────────────────────────────────────────────────────────

  /** Attach an AbortSignal for cancellation. */
  signal(signal: AbortSignal): this {
    this._options.signal = signal;
    return this;
  }

  // ── Size limit ────────────────────────────────────────────────────────────────

  /** Set maximum response body size in bytes. */
  maxSize(bytes: number): this {
    this._options.maxResponseSize = bytes;
    return this;
  }

  // ── HTTP version ──────────────────────────────────────────────────────────────

  /** Request HTTP/2. */
  http2(): this {
    this._options.httpVersion = "HTTP/2";
    return this;
  }

  /** Request HTTP/1.1. */
  http1(): this {
    this._options.httpVersion = "HTTP/1.1";
    return this;
  }

  // ── Throw on error ────────────────────────────────────────────────────────────

  /** Do not throw on 4xx/5xx status codes. */
  noThrow(): this {
    this._options.throwOnError = false;
    return this;
  }

  // ── Tags (for cache invalidation) ─────────────────────────────────────────────

  /** Attach cache tags. */
  tags(...tags: string[]): this {
    this._options.tags = tags;
    return this;
  }

  // ── Meta ──────────────────────────────────────────────────────────────────────

  /** Attach arbitrary metadata. */
  meta(data: Record<string, unknown>): this {
    this._options.meta = { ...this._options.meta, ...data };
    return this;
  }

  // ── Execution ─────────────────────────────────────────────────────────────────

  /** Execute and return the full KinetexResponse. */
  send<T = unknown>(): Promise<KinetexResponse<T>> {
    return this.client.send<T>(this._url, this.method, this._options as SendOptions<T>);
  }

  /** Execute and return the parsed data. Alias for `.send().then(r => r.data)`. */
  async data<T = unknown>(): Promise<T> {
    const res = await this.client.send<T>(this._url, this.method, this._options as SendOptions<T>);
    return res.data;
  }

  /** Execute, parse as JSON, and return the typed data. */
  async json<T = unknown>(): Promise<T> {
    const opts = { ...this._options } as SendOptions<T>;
    opts.headers = { ...(opts.headers as Record<string, string>), accept: "application/json" };
    const res = await this.client.send<T>(this._url, this.method, opts);
    return res.data;
  }

  /** Execute, parse as text, and return the string. */
  async text(): Promise<string> {
    const opts = { ...this._options } as SendOptions<string>;
    opts.parseResponse = (raw) => new TextDecoder("utf-8").decode(raw);
    const res = await this.client.send<string>(this._url, this.method, opts);
    return res.data;
  }

  /** Execute, return raw bytes. */
  async bytes(): Promise<Uint8Array> {
    const opts = { ...this._options } as SendOptions<Uint8Array>;
    opts.parseResponse = (raw) => raw;
    const res = await this.client.send<Uint8Array>(this._url, this.method, opts);
    return res.data;
  }

  /** Execute, return a Blob. */
  async blob(): Promise<Blob> {
    const raw = await this.bytes();
    const type = "application/octet-stream";
    if (typeof Blob === "undefined") {
      throw new KinetexError("Blob is not available in this runtime", "EUNKNOWN");
    }
    return new Blob([raw.buffer as ArrayBuffer], { type });
  }

  /** Execute with callback-style handlers. */
  subscribe<T = unknown>(
    onSuccess: (res: KinetexResponse<T>) => void,
    onError?: (err: KinetexError) => void,
  ): void {
    this.client
      .send<T>(this._url, this.method, {
        ...(this._options as SendOptions<T>),
        onSuccess,
        ...(onError !== undefined ? { onError } : {}),
      })
      .catch((err) =>
        onError?.(err instanceof KinetexError ? err : new KinetexError(String(err), "EUNKNOWN")),
      );
  }
}

// ============================================================================
// §15  UTILITIES
// ============================================================================

/**
 * Create an AbortError that is compatible across runtimes.
 * Uses DOMException where available (browser/Deno), falls back to plain Error.
 */
function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Merge two query parameter maps into one.
 * @param a - First params map (overridden by b).
 * @param b - Second params map (overrides a).
 * @returns Merged params, or undefined if both are empty.
 */
function mergeParams(a?: QueryParams, b?: QueryParams): QueryParams | undefined {
  if (!a && !b) return undefined;
  return { ...a, ...b };
}

/**
 * Promise-based sleep with AbortSignal support.
 * @param ms - Milliseconds to sleep.
 * @param signal - Optional AbortSignal to cancel early.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cross-runtime performance.now() — falls back to Date.now(). */
function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ============================================================================
// §16  ENTERPRISE HELPERS
// ============================================================================

/**
 * Pre-built circuit-breaker key function that isolates breakers per HTTP method
 * AND per origin — e.g. `"GET:https://api.example.com"`.
 *
 * Pass this to `KinetexConfig.circuitBreakerKeyFn` to prevent a stream of
 * failing POST mutations from opening the breaker for safe GET reads:
 *
 * ```ts
 * import { kinetex, createMethodCircuitBreakerKey } from "kinetex";
 *
 * const client = kinetex({
 *   circuitBreakerKeyFn: createMethodCircuitBreakerKey,
 * });
 * client.enableCircuitBreaker();
 * ```
 *
 * @see Enterprise Hardening #2 — Circuit breaker per-method
 * @returns A circuit breaker key in the form "METHOD:origin".
 */
export function createMethodCircuitBreakerKey(req: KinetexRequest): string {
  try {
    return `${req.method}:${new URL(req.url).origin}`;
  } catch {
    return `${req.method}:${req.url}`;
  }
}

/**
 * Batch request queue — coalesces individual requests fired within the same
 * micro-task tick (or within `flushMs`) into a concurrent `Promise.all` burst,
 * sharing a single connection pool flush.
 *
 * This is a high-throughput helper for write-heavy scenarios (e.g. event
 * ingestion, metric flushing) where you want to fire many requests quickly
 * without overloading the event loop one-by-one.
 *
 * @example
 * ```ts
 * const batch = new BatchQueue(client, { maxBatch: 50, flushMs: 10 });
 *
 * // Fire individual requests — they batch automatically
 * const [r1, r2, r3] = await Promise.all([
 *   batch.enqueue("/events", "POST", { body: JSON.stringify(event1) }),
 *   batch.enqueue("/events", "POST", { body: JSON.stringify(event2) }),
 *   batch.enqueue("/events", "POST", { body: JSON.stringify(event3) }),
 * ]);
 * ```
 *
 * @see Enterprise Hardening #4 — Request batching for high-throughput scenarios
 */
export class BatchQueue<T = unknown> {
  /** The parent Kinetex instance used to send requests. */
  private readonly _client: Kinetex;
  /** Maximum number of requests to flush at once. */
  private readonly _maxBatch: number;
  /** Milliseconds to wait before flushing an incomplete batch. */
  private readonly _flushMs: number;

  /** Pending (not yet flushed) requests. */
  private _queue: Array<{
    url: string;
    method: HTTPMethod;
    options: SendOptions<T>;
    resolve: (res: KinetexResponse<T>) => void;
    reject: (err: unknown) => void;
    _abortCleanup?: () => void;
  }> = [];
  /** Timer handle for deferred flush. */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param client - The Kinetex client to send requests through.
   * @param options - Batch configuration options.
   */
  constructor(
    client: Kinetex,
    options: {
      /**
       * Maximum number of requests to flush at once.
       * When this many requests are queued, flush immediately.
       * Default: 100
       */
      maxBatch?: number;
      /**
       * Milliseconds to wait before flushing an incomplete batch.
       * Allows requests fired in the same event-loop tick to coalesce.
       * Default: 0 (flush on next microtask)
       */
      flushMs?: number;
    } = {},
  ) {
    this._client = client;
    this._maxBatch = options.maxBatch ?? 100;
    this._flushMs = options.flushMs ?? 0;
  }

  /**
   * Enqueue a request. Returns a promise that resolves when the batch
   * containing this request has been sent and the response is ready.
   * @param url - Request URL.
   * @param method - HTTP method (default GET).
   * @param options - Per-request options.
   * @returns A promise resolving with the response.
   */
  enqueue(
    url: string,
    method: HTTPMethod = "GET",
    options: SendOptions<T> = {},
  ): Promise<KinetexResponse<T>> {
    return new Promise<KinetexResponse<T>>((resolve, reject) => {
      const item: {
        url: string;
        method: HTTPMethod;
        options: SendOptions<T>;
        resolve: (res: KinetexResponse<T>) => void;
        reject: (err: unknown) => void;
        _abortCleanup?: () => void;
      } = { url, method, options, resolve, reject };
      this._queue.push(item);

      const abortSignal = options.signal;
      if (abortSignal) {
        const onAbort = () => {
          const idx = this._queue.indexOf(item);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            reject(new KinetexError("Request aborted while queued", "EABORT"));
          }
        };
        // Store the cleanup function tied to this item for later removal on flush
        item._abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        if (abortSignal.aborted) {
          // Clean up the listener we just registered (signal fires abort synchronously
          // in some environments; but removeEventListener is safe either way)
          abortSignal.removeEventListener("abort", onAbort);
          // Remove the item from the queue — the push() at line 2792 already happened
          const idx = this._queue.indexOf(item);
          if (idx !== -1) this._queue.splice(idx, 1);
          reject(new KinetexError("Request aborted before flush", "EABORT"));
          return;
        }
      }

      if (this._queue.length >= this._maxBatch) {
        // Flush immediately if the batch is full
        this._flushNow();
      } else if (!this._timer) {
        // Schedule a flush after flushMs - use queueMicrotask for flushMs=0 (true microtask)
        if (this._flushMs === 0) {
          queueMicrotask(() => {
            this._timer = null;
            this._flushNow();
          });
        } else {
          this._timer = setTimeout(() => this._flushNow(), this._flushMs);
        }
      }
    });
  }

  /**
   * Flush any pending requests immediately without waiting for the timer.
   * Loops until the queue is empty so items beyond maxBatch are not orphaned.
   */
  flush(): void {
    while (this._queue.length > 0) this._flushNow();
  }

  /** How many requests are currently queued (not yet sent). */
  get pendingCount(): number {
    return this._queue.length;
  }

  /** Flush the current batch of queued requests concurrently. */
  private _flushNow(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._queue.length === 0) return;

    const batch = this._queue.splice(0, this._maxBatch);

    // Fire all requests concurrently — they share the
    // underlying connection pool of the Kinetex instance.
    // Each request is fire-and-forget with .then() resolution.
    for (const item of batch) {
      // Wrap in try-catch to handle synchronous errors from send()
      // (e.g., URL validation errors) that would otherwise leave promises pending
      const done = (res: KinetexResponse<T>) => {
        item._abortCleanup?.();
        item.resolve(res);
      };
      const fail = (err: unknown) => {
        item._abortCleanup?.();
        item.reject(err);
      };
      try {
        this._client.send<T>(item.url, item.method, item.options).then(done, fail);
      } catch (err) {
        fail(err);
      }
    }
  }
}
