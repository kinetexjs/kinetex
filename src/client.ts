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

import { KinetexError, HTTPStatusError, AbortError, RedirectError, toRequestId } from "./types.ts";

import {
  isValidHeaderName,
  isValidHeaderValue,
  isSafeURL,
  uint8ArrayToBase64,
  randomBytes,
} from "./utils.ts";
import { getAuthFingerprint, CREDENTIAL_HEADERS } from "./cache.ts";
import { createRateLimitInterceptor, ConcurrencyLimiter } from "./interceptors.ts";
import { SigV4Signer } from "./aws-sigv4.ts";
import { createDigestAuthorizer } from "./digest.ts";
import { generateIdempotencyKey, isValidIdempotencyKey, parseRetryAfter } from "./headers.ts";

import { DEFAULT_ACCEPT_ENCODING, encodeMultipart } from "./core.ts";
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

/**
 * Hard ceiling on redirect hops followed by the manual redirect follower.
 * Overridable per client / per request with `maxRedirects`.
 */
const DEFAULT_MAX_REDIRECTS = 20;

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

  /**
   * Record a value into a histogram. Optional — omit it and only spans are
   * produced.
   *
   * @param name  - Instrument name.
   * @param value - Recorded value. For `http.client.request.duration` this is
   *   in **seconds**, matching OpenTelemetry semantic conventions.
   * @param attributes - Low-cardinality dimensions (method, status, host).
   */
  recordHistogram?(name: string, value: number, attributes?: MetricAttributes): void;

  /**
   * Increment a counter. Optional — omit it and only spans are produced.
   *
   * @param name  - Instrument name.
   * @param value - Amount to add (default 1).
   * @param attributes - Low-cardinality dimensions.
   */
  incrementCounter?(name: string, value?: number, attributes?: MetricAttributes): void;
}

/** Attribute values accepted by {@link OTelTracer}'s metric methods. */
export type MetricAttributes = Record<string, string | number | boolean>;

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
 * Headers redacted before being written to HAR entries (FIX M2).
 * Mirrors logging.ts DEFAULT_REDACT_HEADERS — HAR logs are routinely exported
 * and shared, so credentials must never appear verbatim.
 */
const HAR_REDACT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-refresh-token",
  "x-csrf-token",
  "x-session-id",
  "x-session-token",
  "x-secret",
  "x-secret-key",
  "x-private-key",
  "api-key",
  "apikey",
  "bearer",
  "token",
  "authentication",
  "credentials",
  "password",
  "passwd",
  "secret",
]);

/**
 * `meta` key carrying the number of response-interceptor re-sends so a
 * self-retriggering interceptor cannot loop forever.
 */
/** Request-meta key: a clock-skew correction has already been spent. */
const AWS_SKEW_CORRECTED = "__awsSkewCorrected";
const INTERCEPTOR_RESEND_DEPTH = "__interceptorResendDepth";

/** Hard cap on consecutive response-interceptor re-sends (digest refresh, etc.). */
const MAX_INTERCEPTOR_RESENDS = 5;

/** Query-parameter names whose values are redacted in HAR output. */
const HAR_REDACT_PARAMS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "auth",
  "authorization",
  "key",
  "secret",
  "password",
  "passwd",
  "signature",
  "sig",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "sas",
  "session",
  "sessionid",
  "jwt",
  "code",
]);

/** Maximum number of body characters recorded in a HAR entry. */
const HAR_MAX_BODY_CHARS = 8192;

/** HTML/other content types whose bodies are never recorded in HAR output. */
function isHARBodySafeToRecord(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("text/plain") ||
    ct.includes("application/javascript")
  );
}

/**
 * Redact sensitive query-parameter values in a URL, preserving everything else
 * (scheme, host, path, parameter names, ordering) so the HAR stays useful.
 */
function redactHARUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (HAR_REDACT_PARAMS.has(key.toLowerCase())) {
        u.searchParams.set(key, "***REDACTED***");
        changed = true;
      }
    }
    // Hash can carry an implicit-access-token (S3, Firebase, share links).
    if (u.hash && (u.hash.includes("token") || u.hash.includes("sig") || u.hash.length > 1)) {
      u.hash = "#***REDACTED***";
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    // Unparseable URL — fall back to a regex that masks known param names.
    return url.replace(
      /([?&])(api_key|apikey|access_token|refresh_token|token|secret|password|signature|sig)=([^&#]*)/gi,
      "$1$2=***REDACTED***",
    );
  }
}

/** Redact a single header value for HAR output. */
function redactHARHeader(name: string, value: string): { name: string; value: string } {
  return HAR_REDACT_HEADERS.has(name.toLowerCase())
    ? { name, value: "***REDACTED***" }
    : { name, value };
}

/**
 * O(1) ring-buffer HAR entry recorder.
 * Stores up to `maxEntries` entries, evicting oldest first.
 */
/**
 * The `postData` block for a recorded request, or `{}` when there is nothing
 * safe or possible to record.
 *
 * Kept out of `record()` so the recorder's entry literal reads as the HAR it
 * claims to conform to, and so the "may I record this?" decision has one home.
 */
function harPostData(req: KinetexRequest): { postData?: { mimeType: string; text: string } } {
  if (!req.body) return {};
  const mimeType = req.headers["content-type"] ?? "";
  // Same policy as the response body: skip anything that is not plain text.
  if (mimeType && !isHARBodySafeToRecord(mimeType)) return {};
  let text: string;
  if (typeof req.body === "string") {
    text = req.body;
  } else if (req.body instanceof Uint8Array) {
    text = new TextDecoder().decode(req.body);
  } else if (req.body instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(req.body));
  } else {
    return {}; // stream / FormData / Blob: not readable without consuming it
  }
  return { postData: { mimeType, text: text.slice(0, HAR_MAX_BODY_CHARS) } };
}

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
        // getEntriesByName narrows the buffer instead of scanning every resource
        // entry for each recorded request (was O(entries) per request).
        const entries = (
          typeof performance.getEntriesByName === "function"
            ? performance.getEntriesByName(res.url)
            : (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
                (e) => e.name === res.url,
              )
        ) as PerformanceResourceTiming[];
        // Most recent entry for this URL. Entries are startTime-ordered, so the
        // last one is the most recent — and, unlike a name-only match, we also
        // require it to be recent enough to actually belong to this request.
        const entry = entries[entries.length - 1];
        if (entry && entry.requestStart > 0 && Date.now() - entry.startTime < 60_000) {
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
        // Redacted: HAR logs are routinely exported and shared, and a query
        // string is just as leaky as a header (?api_key=, ?access_token=,
        // ?signature=). Previously only headers were redacted, so the full URL
        // and every query value landed in the log verbatim.
        url: redactHARUrl(req.url),
        httpVersion: res.httpVersion,
        headers: Object.entries(req.headers).map(([name, value]) => redactHARHeader(name, value)),
        queryString: (() => {
          try {
            return Array.from(new URL(redactHARUrl(req.url)).searchParams.entries()).map(
              ([name, value]) => ({
                name,
                value,
              }),
            );
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
        // `postData` is declared on `HAREntry` as "Posted data, if applicable"
        // and was never written, so a HAR exported from a client that POSTs
        // anything shows an empty request body in every viewer — the response
        // body, the query string, the headers and the URL are all there, and
        // the one part that explains what was actually sent is not. The gates
        // are the ones the response side already uses: a body is recorded only
        // when its content type is safe to record, it is truncated to the same
        // limit, and a body that cannot be read without consuming it (a stream,
        // a FormData) is omitted rather than guessed at — which is what the
        // `bodySize: -1` above already admits.
        ...harPostData(req),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        httpVersion: res.httpVersion,
        headers: Object.entries(res.headers).map(([name, value]) => redactHARHeader(name, value)),
        content: {
          size: res.rawBody?.byteLength ?? 0,
          mimeType: res.headers["content-type"] ?? "application/octet-stream",
          // Body text is only kept for non-HTML payloads and is truncated:
          // response bodies routinely carry tokens and PII.
          ...(typeof res.data === "string" && isHARBodySafeToRecord(res.headers["content-type"])
            ? { text: res.data.slice(0, HAR_MAX_BODY_CHARS) }
            : {}),
        },
        // The Location header can itself carry a signed URL — redact it too.
        redirectURL: res.headers["location"] ? redactHARUrl(res.headers["location"]) : "",
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
      // FIX (H3): token values — especially from async providers — must be
      // validated before injection. A token containing CRLF would split or
      // forge headers on the wire (header injection).
      const headerValue = `Bearer ${token}`;
      if (!isValidHeaderValue(headerValue)) {
        throw new KinetexError(
          "Invalid bearer token — contains forbidden characters (CRLF/CTL)",
          "EVALIDATION",
        );
      }
      headers["authorization"] = headerValue;
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
      // FIX (LOW): validate the custom header name — an apikey header containing
      // CRLF or spaces would be injected verbatim into the request.
      if (!isValidHeaderName(auth.header)) {
        throw new KinetexError(`Invalid apikey auth header name: "${auth.header}"`, "EVALIDATION");
      }
      // FIX (H3): the key value is equally attacker-influenced when provided
      // via an async provider — validate before injection.
      if (!isValidHeaderValue(String(key))) {
        throw new KinetexError(
          `Invalid apikey value for "${auth.header}" — contains forbidden characters`,
          "EVALIDATION",
        );
      }
      headers[auth.header.toLowerCase()] = String(key);
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
 * Headers stripped when a redirect crosses origins (FIX H2).
 * These carry credentials and must never be forwarded to a different origin.
 */
// Derived from the single CREDENTIAL_HEADERS list in cache.ts so the strip
// list, the dedup key and the cache key can never drift apart. (The previous
// list also carried `www-authenticate`, a RESPONSE header that can never appear
// on an outgoing request.)
const CROSS_ORIGIN_STRIP_HEADERS = new Set<string>([
  ...CREDENTIAL_HEADERS,
  // Response-only per RFC 9110, so it can never legitimately appear on an
  // outgoing request — kept in the strip list as defence in depth for callers
  // that copy a full header bag (including response headers) onto a request.
  "www-authenticate",
]);

/**
 * Strip userinfo (user:pass@) from a URL string for safe error messages (FIX M5).
 * Falls back to a regex strip when the URL cannot be parsed.
 */
function redactUserInfo(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    return url.replace(/\/\/[^/@]*@/, "//");
  }
}

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
function buildURL(
  base: string | undefined,
  url: string,
  params: QueryParams | undefined,
  allowedSchemes: string[] = ["http", "https"],
): string {
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
    if (!isSafeURL(full, allowedSchemes)) {
      throw new KinetexError(
        `URL "${redactUserInfo(full)}" failed safety check — blocked private/loopback address or forbidden scheme`,
        "EVALIDATION",
      );
    }
    return full;
  }

  try {
    const u = new URL(full);
    // The params branch screens the URL after appending them, so it needs the
    // same scheme list as the no-params branch above.
    if (!isSafeURL(u, allowedSchemes)) {
      throw new KinetexError(
        `URL "${redactUserInfo(full)}" failed safety check — blocked private/loopback address or forbidden scheme`,
        "EVALIDATION",
      );
    }
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
        `URL "${redactUserInfo(result)}" failed safety check — blocked private/loopback address or forbidden scheme`,
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

    // FIX M4: the manual param-concat fallback previously returned WITHOUT a
    // safety check — validate the assembled URL like every other path.
    if (!isSafeURL(result)) {
      throw new KinetexError(
        `URL "${redactUserInfo(result)}" failed safety check — blocked private/loopback address or forbidden scheme`,
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
  const jittered = capped + capped * cfg.jitter * Math.random();
  // `maxDelayMs` is documented as a maximum, so the cap must be re-applied
  // *after* jitter. It was not: base 1000, cap 1200, jitter 1 returned 2000ms,
  // so the option never bounded worst-case latency at all — it bounded only the
  // pre-jitter base. With the default jitter of 0.3 a 30 s cap still allowed
  // 39 s.
  return Math.min(Math.floor(jittered), cfg.maxDelayMs);
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
  // Delegate to the single RFC 7231 §7.1.1 parser instead of a second,
  // looser copy: Date.parse() accepts "-5", "1.5" and "+5" as dates, which
  // used to yield a 0 ms (i.e. "ignore Retry-After") back-off on a 429.
  const parsed = parseRetryAfter(ra);
  if (parsed.delay !== null) {
    const MAX_RETRY_AFTER_SEC = 86_400; // 24 hours
    return Math.min(parsed.delay, MAX_RETRY_AFTER_SEC) * 1000;
  }
  if (parsed.date) {
    // A date in the past genuinely means "retry now" — 0 is the answer, not a
    // parse failure. Cap at 24 h so a bogus far-future date cannot stall.
    const MAX_RETRY_AFTER_MS = 86_400_000;
    return Math.max(0, Math.min(parsed.date.getTime() - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return null;
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
 * // Fluent chain — `get()` returns a Promise, so use the uppercase
 * // `GET()` builder if you want to chain `.json()` onto it.
 * const user = await client.GET("/users/1").json<User>();
 *
 * // Standard send — `send(url, method, options)`, not an object argument
 * const res = await client.send<User>("/users/1", "GET");
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
   * Optional bulkhead bounding in-flight requests. `null` when
   * `concurrencyLimit` is not configured, which keeps the hot path free of a
   * limiter check.
   */
  private readonly _concurrencyLimiter: ConcurrencyLimiter | null;
  /** SigV4 signer kept so a clock-skew correction survives across retries. */
  private _awsSigner: SigV4Signer | null = null;

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

    // Concurrency limiter (bulkhead). Held as an object rather than a request
    // interceptor because a permit must survive until the request settles,
    // and interceptors cannot wrap the downstream call.
    this._concurrencyLimiter = config.concurrencyLimit
      ? new ConcurrencyLimiter(config.concurrencyLimit)
      : null;

    // AWS SigV4 request signing — registered synchronously (static import).
    // Active immediately; no race between first request and interceptor registration.
    if (config.awsSigning) {
      const signer = new SigV4Signer(config.awsSigning);
      this._awsSigner = signer;
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
      // The HTTP/2 session pool was configurable on the transport but the
      // client always passed `undefined` here, so `sessionPool` on the client
      // config could not tune it.
      config.sessionPool,
      {
        ...(config.strictHeaders ? { strict: true } : {}),
        ...(config.dispatcher !== undefined ? { dispatcher: config.dispatcher } : {}),
        ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
      },
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
      // Per-client nonce counter. RFC 7616 requires `nc` to strictly increase
      // for every request reusing a nonce; the stateless helper always used
      // 00000001, so any server enforcing replay protection rejected the second
      // authenticated request with 401.
      const digestAuthorizer = createDigestAuthorizer();
      this.interceptors.addResponse(async (ctx: InterceptorContext) => {
        if (!ctx.response) return;
        if (ctx.response.status !== 401) return;

        const wwwAuth = ctx.response.headers["www-authenticate"];
        if (!wwwAuth || !wwwAuth.toLowerCase().startsWith("digest")) return;

        if (ctx.request.meta.__digestRetried) return;

        const method = ctx.request.method;
        const parsedUrl = new URL(ctx.request.url);
        const uri = parsedUrl.pathname + parsedUrl.search;

        const authHeader = await digestAuthorizer(
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
      const hookReq: import("./lifecycle.ts").HookRequest = {
        url: ctx.request.url,
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.body as import("./lifecycle.ts").HookRequest["body"],
        signal: ctx.request.signal,
        meta: ctx.request.meta,
      };
      // A failed request can still have produced a response: HTTPStatusError
      // carries the KinetexResponse, and createLoggingHooks' onError reads
      // `err.response?.status`. Hardcoding null here made every bridged
      // onError hook see no response, so log entries silently recorded a null
      // status for 4xx/5xx. Only genuinely response-less errors (network,
      // timeout, abort) keep null.
      const errResponse = toHookResponse(
        (ctx.error as { response?: KinetexResponse<unknown> }).response,
        hookReq,
      );
      const hookErr: import("./lifecycle.ts").HookError = {
        error: ctx.error,
        request: hookReq,
        response: errResponse,
        attempt: ctx.attempt,
      };
      const hookCtx: import("./lifecycle.ts").HookContext = {
        request: hookErr.request,
        response: errResponse,
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
   * The full `DedupMap.getStats()` snapshot, so a caller has to reach for one
   * shape rather than two. The wrapper used to expose only `hits`, `misses`
   * and `inFlightCount` — which meant the hit rate, the only figure anyone
   * actually wants from a dedup map, was unavailable on the client even
   * though the map computed it.
   *
   * @returns `{ hits, misses, totalRequests, hitRate, inFlightCount, trackedKeys }`,
   *          or `null` if dedup is not enabled.
   */
  get dedupMetrics(): ReturnType<DedupMap["getStats"]> | null {
    if (!this._dedup) return null;
    return this._dedup.getStats();
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
    // `ws://` / `wss://` have to be allowed here, and only here. The default
    // `["http", "https"]` is what stops an ordinary HTTP request from being
    // pointed at a WebSocket scheme, and every other buildURL caller keeps it.
    // Without this opt-in the documented `client.ws("wss://…")` form — the one
    // in the README and in this method's own JSDoc — failed the SSRF scheme
    // check and threw EVALIDATION on every call, so `client.ws()` could not
    // connect to anything. Only the scheme list is widened: the loopback and
    // private-range checks still apply to WebSocket URLs.
    const fullURL = buildURL(this.cfg.baseURL, url, this.cfg.params, [
      "http",
      "https",
      "ws",
      "wss",
    ]);
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
        // A baseURL may itself be a WebSocket URL — `kinetex({ baseURL:
        // "wss://…" })` then `client.ws("/path")` is the natural spelling, and
        // it is what the README's origin-validation section shows. Comparing
        // `wss:` only against `https:` rejected that pairing outright, so a
        // client configured with a WebSocket baseURL could never open a socket.
        const httpIsSecure = baseUrl.protocol === "https:" || baseUrl.protocol === "wss:";
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

    // A client-level `proxy` is honoured by the Node transport, which tunnels
    // every connection through it with CONNECT. A per-request `proxy` cannot be:
    // the transport pools one connection per origin, so honouring a per-request
    // proxy would mean tearing the pool down mid-flight. Reject it with an
    // accurate reason rather than silently ignoring it.
    const perRequestProxy = options.proxy;
    if (perRequestProxy) {
      throw new KinetexError(
        "A per-request `proxy` is not supported because the transport pools one connection " +
          "per origin — set `proxy` on the client instead, or use a custom `fetch` with a " +
          "proxy agent for per-request routing. SOCKS5 requires createSocks5Tunnel() from " +
          "kinetex/socks5.",
        "EVALIDATION",
      );
    }

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

    // A multipart body has no size until it is encoded, and the encoding is
    // the same call the dispatch path makes below, so it is done once here and
    // the result reused. The guard used to estimate it with a flat 76 bytes per
    // part, which is less than the framing `encodeMultipart` actually writes
    // for its 70-character generated boundary: a form sized to exactly the
    // estimate passed this check and then went out roughly 45 bytes per part
    // over the limit the caller had set.
    let preEncodedForm: { bytes: Uint8Array; boundary: string } | undefined;

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
      } else if (ArrayBuffer.isView(options.body)) {
        // FIX (H4): other typed-array/DataView views were uncounted.
        // ArrayBuffer.isView() is used instead of `instanceof ArrayBufferView`
        // because there is no runtime global to instanceof against.
        bodySize = (options.body as ArrayBufferView).byteLength;
      } else if (options.body instanceof URLSearchParams) {
        // FIX (H4): previously silently skipped — count the serialized form.
        bodySize = new TextEncoder().encode(options.body.toString()).byteLength;
      } else if (options.body instanceof FormData) {
        // FIX (H4): the old branch skipped FormData entirely, which allowed
        // unbounded uploads past the configured limit; it then replaced the
        // skip with an estimate whose per-part constant was smaller than the
        // framing it stood in for. The exact bytes are the only honest
        // answer, and they are needed a few lines below anyway.
        preEncodedForm = await encodeMultipart(options.body);
        bodySize = preEncodedForm.bytes.byteLength;
      } else if (options.body instanceof ReadableStream) {
        // FIX (H4): a stream's size cannot be known without consuming it —
        // reject rather than silently bypassing the limit. Callers who need
        // streaming uploads must pass maxRequestSize: 0 explicitly.
        throw new KinetexError(
          `maxRequestSize cannot be enforced for ReadableStream bodies — pass maxRequestSize: 0 to opt out, or buffer the body first`,
          "EVALIDATION",
        );
      } else if (options.body && typeof options.body === "object") {
        try {
          bodySize = new TextEncoder().encode(JSON.stringify(options.body)).byteLength;
        } catch (err) {
          // A circular (or BigInt-containing) body threw a raw TypeError from
          // inside the size guard, masking the real serialization error.
          throw new KinetexError(
            `Cannot measure request body size: ${err instanceof Error ? err.message : String(err)}`,
            "EVALIDATION",
          );
        }
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
      // Use the normalized method, not the caller's casing: `send(url, "patch")`
      // passed validation above but used to put the literal string "patch" on
      // the wire. fetch() only normalizes delete/get/head/options/post/put, so a
      // lowercase PATCH/CONNECT went out verbatim and servers answered 405.
      method: normalizedMethod,
      headers: mergeHeaders(this.cfg.headers, options.headers),
      // A plain object/array is accepted by the public API (RequestBody) and is
      // JSON-encoded in the block immediately below, so the request object only
      // ever holds a real BodyInit by the time this function returns.
      body: (options.body ?? null) as BodyInit | null,
      signal: options.signal ?? null,
      // Resolved once here so the manual redirect follower sees the same
      // effective values the caller asked for. Spread (not `??`) because the
      // project uses exactOptionalPropertyTypes.
      ...(options.followRedirects !== undefined || this.cfg.followRedirects !== undefined
        ? { followRedirects: options.followRedirects ?? this.cfg.followRedirects }
        : {}),
      ...(options.maxRedirects !== undefined || this.cfg.maxRedirects !== undefined
        ? { maxRedirects: options.maxRedirects ?? this.cfg.maxRedirects }
        : {}),
      meta: { ...options.meta },
      httpVersion: options.httpVersion ?? this.cfg.httpVersion ?? "HTTP/2",
    };

    // A `FormData` body is encoded here rather than handed to the transport,
    // because the encoding and the `Content-Type` that describes it have to be
    // produced together. The raw Node transports bypass fetch, and
    // `serializeRawBody` — the function written so they would not send an empty
    // body — covered `URLSearchParams` and `Blob` but not `FormData`, so on the
    // default transport on Node a form upload went out with no body and no
    // `Content-Type` and the server recorded an empty form. The response was an
    // ordinary 200, so nothing downstream could tell.
    if (req.body !== null && req.body instanceof FormData && !req.headers["content-type"]) {
      const encoded = preEncodedForm ?? (await encodeMultipart(req.body));
      req = {
        ...req,
        headers: {
          ...req.headers,
          "content-type": `multipart/form-data; boundary=${encoded.boundary}`,
        },
        body: encoded.bytes,
      };
    }

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

    // A URLSearchParams body is urlencoded by the raw Node transports, which
    // do not set a content-type the way fetch does. Without this the server
    // receives the bytes but cannot parse them as a form.
    if (
      req.body !== null &&
      typeof URLSearchParams !== "undefined" &&
      req.body instanceof URLSearchParams &&
      !req.headers["content-type"]
    ) {
      req = {
        ...req,
        headers: { ...req.headers, "content-type": "application/x-www-form-urlencoded" },
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
    // Everything between startSpan() and the dispatch try/catch below can
    // throw (traceparent building, the circuit-breaker key fn, auth
    // fingerprinting). Wrap it so a failure still ends the span instead of
    // abandoning it — an unended span is never exported and never reports the
    // error, and holds its attributes in the tracer's memory.
    let _otelSpan: OTelSpan | null = null;
    try {
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
    } catch (tracingErr) {
      if (_otelSpan) {
        _otelSpan.setStatus({
          code: 2 /* ERROR */,
          message: tracingErr instanceof Error ? tracingErr.message : String(tracingErr),
        });
        if (tracingErr instanceof Error) _otelSpan.recordException(tracingErr);
        _otelSpan.end();
      }
      throw tracingErr;
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
    // Fingerprinting hashes the credential headers with SHA-256, so it is only
    // paid when dedup is actually enabled.
    let _dedupKey = "";
    if (this._dedup) {
      const authFp = await getAuthFingerprint(req.headers ?? {});
      _dedupKey = `${req.method}:${req.url}${authFp ? ":" + authFp : ""}`;
    }
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
    // A permit is held for the whole logical request — including every retry
    // attempt — and released in `finally`, so a throw or an exhausted retry
    // budget can never leak one and permanently shrink the pool.
    const run = async (): Promise<KinetexResponse<T>> => {
      if (!this._concurrencyLimiter) {
        return await this._executeWithRetryInner<T>(
          req,
          retryCfg,
          timeout,
          options,
          startMs,
          wallClockMs,
        );
      }
      await this._concurrencyLimiter.acquire(req.signal);
      try {
        return await this._executeWithRetryInner<T>(
          req,
          retryCfg,
          timeout,
          options,
          startMs,
          wallClockMs,
        );
      } finally {
        this._concurrencyLimiter.release();
      }
    };

    // Metrics measure the whole logical request, retries included, and are
    // emitted from `finally` so failures and aborts are counted too. The
    // no-tracer case is not short-circuited here: `_recordMetrics` returns
    // immediately when telemetry is off, and this client then pays nothing
    // beyond the call it already makes on every request.
    const metricsStart = Date.now();
    let status: number | undefined;
    let errorCode: string | undefined;
    try {
      const res = await run();
      status = res.status;
      return res;
    } catch (err) {
      errorCode = (err as { code?: string }).code;
      throw err;
    } finally {
      this._recordMetrics(req, status, errorCode, Date.now() - metricsStart);
    }
  }

  /**
   * Emit request metrics to the configured tracer, if it supports them.
   *
   * Failures here are swallowed on purpose: telemetry must never be able to
   * fail a request that otherwise succeeded.
   *
   * @param req - The originating request.
   * @param status - Final HTTP status, or undefined if the request threw.
   * @param errorCode - `KinetexError` code, or undefined on success.
   * @param durationMs - Wall-clock duration of the logical request.
   */
  private _recordMetrics(
    req: KinetexRequest,
    status: number | undefined,
    errorCode: string | undefined,
    durationMs: number,
  ): void {
    const tracer = this._otelTracer;
    if (!tracer) return;

    // `req.url` is always an absolute, already-parsed URL by the time a
    // request reaches here: `buildURL()` constructs it and the SSRF safety
    // check parses it again before dispatch, so there is nothing to guard.
    const attributes: MetricAttributes = {
      "http.request.method": req.method,
      "server.address": new URL(req.url).hostname,
    };
    if (status !== undefined) attributes["http.response.status_code"] = status;
    if (errorCode !== undefined) attributes["error.type"] = errorCode;

    try {
      // Seconds, per OTel semantic conventions for http.client.request.duration.
      tracer.recordHistogram?.("http.client.request.duration", durationMs / 1000, attributes);
      tracer.incrementCounter?.("http.client.request.count", 1, attributes);
      if (errorCode !== undefined) {
        tracer.incrementCounter?.("http.client.error.count", 1, attributes);
      }
    } catch {
      // Swallowed — see the doc comment.
    }
  }

  /** Retry loop body. See {@link _executeWithRetry} for the concurrency gate. */
  private async _executeWithRetryInner<T>(
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
        throw createAbortError(req);
      }

      // A ReadableStream / Blob body is not replayable: the first attempt
      // consumes (and locks) it, so a retry re-wraps an already-locked stream
      // for upload progress and sends an empty body. Fail loudly on the retry
      // instead of silently transmitting nothing.
      if (attempt > 1 && isNonReplayableBody(req.body)) {
        throw new KinetexError(
          "Cannot retry a request whose body is a stream or Blob — the body was consumed by the first attempt. Buffer it first, or disable retry for this request.",
          "EVALIDATION",
          { request: req },
        );
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
        if ((globalThis as Record<string, unknown>).__KINETEX_DEBUG_RETRY) {
          console.log("DBG catch", {
            attempt,
            maxRetries: retryCfg === false ? "FALSE" : retryCfg?.maxRetries,
            methods: retryCfg === false ? "FALSE" : retryCfg?.methods,
            code: (err as { code?: string })?.code,
            method: req.method,
          });
        }
        // Clock-skew correction. `SigV4Signer.handleClockSkewError` existed and
        // `detectClockSkew` was a public export, but nothing in the library
        // ever called them: a client with a wrong clock got a 403
        // `RequestTimeTooSkewed`, retried if 403 happened to be in `statuses`,
        // and re-signed the identical wrong timestamp every attempt. Correcting
        // here is bounded to one attempt per logical request, so a server that
        // keeps reporting a different time cannot spin.
        let clockSkewCorrected = false;
        const skewResponse = (err as { response?: KinetexResponse<unknown> }).response;
        if (this._awsSigner && skewResponse && (err as KinetexError).code === "EHTTPSTATUS") {
          // `data` is the parsed body: a string for text, a Uint8Array for any
          // other content type (which is what an XML error body arrives as),
          // and an object only for JSON.
          const raw = skewResponse.data;
          const body =
            typeof raw === "string"
              ? raw
              : raw instanceof Uint8Array
                ? new TextDecoder().decode(raw)
                : raw instanceof ArrayBuffer
                  ? new TextDecoder().decode(new Uint8Array(raw))
                  : JSON.stringify(raw ?? "");
          if (
            this._awsSigner.handleClockSkewError(skewResponse.status, body, skewResponse.headers)
          ) {
            clockSkewCorrected = !req.meta[AWS_SKEW_CORRECTED];
            if (clockSkewCorrected) req.meta[AWS_SKEW_CORRECTED] = true;
          }
        }

        if (retryCfg && (attempt <= retryCfg.maxRetries || clockSkewCorrected)) {
          // A thrown HTTPStatusError already carries the full response. This
          // path used to hand hooks a context with `response: null` and a hard
          // `null` Retry-After, so the *default* case — throwOnError: true,
          // which is what every 429/503 goes through — ignored the server's
          // Retry-After entirely and never fired lifecycle onRetry hooks.
          const errResponse = skewResponse ?? null;
          const retryCtx: RetryContext = {
            request: req,
            response: errResponse,
            error: err,
            attempt,
            maxRetries: retryCfg.maxRetries,
          };
          const doRetry = clockSkewCorrected
            ? true
            : retryCfg.shouldRetry
              ? await retryCfg.shouldRetry(retryCtx)
              : shouldRetry(retryCfg, retryCtx);

          if (doRetry) {
            const delay = computeRetryDelay(
              retryCfg,
              attempt,
              errResponse ? getRetryAfterMs(errResponse.headers) : null,
            );
            await retryCfg.onRetry?.(retryCtx, delay);
            await this.cfg.hooks?.onRetry?.reduce(async (p, fn) => {
              await p;
              await fn(retryCtx);
            }, Promise.resolve());
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
   * Follow redirects manually, one hop at a time.
   *
   * Two independent reasons this path exists:
   *  1. fetch() auto-follows redirects but silently drops Set-Cookie from
   *     intermediary hops, so an active cookie jar must see every hop itself.
   *  2. Per the Fetch spec, a cross-origin redirect only drops
   *     `authorization` / `cookie` / `proxy-authorization`. Custom credential
   *     headers (apikey, X-Company-Key, ...) are forwarded verbatim, so any
   *     request carrying one must also be followed manually.
   *
   * @param jar - Optional cookie jar. When omitted, no cookie header is
   *              rebuilt and intermediate Set-Cookie headers are ignored.
   */
  private async _sendFollowingRedirects(
    req: KinetexRequest,
    timeout: number,
    jar?: import("./cookiejar.ts").CookieJar,
    appliedAuth?: AuthConfig | undefined | false,
  ): Promise<RawResponse> {
    // `maxRedirects` / `followRedirects` were documented on KinetexConfig and
    // SendOptions but never read, so the documented default and the enforced one
    // had drifted apart. Both are honoured here now.
    const maxRedirects = Math.max(0, req.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
    const followRedirects = req.followRedirects !== false && maxRedirects > 0;
    let currentReq: KinetexRequest = { ...req, redirect: "manual" as const };
    const origin0 = (() => {
      try {
        return new URL(req.url).origin;
      } catch {
        return null;
      }
    })();
    // Track visited URLs to detect redirect loops
    const visited = new Set<string>();

    for (let hop = 0; hop <= maxRedirects; hop++) {
      // FIX H2 (part 2): re-apply auth on every hop ONLY while we remain on the
      // original origin. Once a redirect has crossed origins, credential-bearing
      // headers must not be re-injected — otherwise the cross-origin strip in
      // the redirect branch below would be immediately undone.
      if (hop > 0 && appliedAuth) {
        const sameOrigin = (() => {
          try {
            return new URL(currentReq.url).origin === origin0;
          } catch {
            return false;
          }
        })();
        if (sameOrigin) {
          currentReq = await applyAuth(currentReq, appliedAuth);
        }
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
          throw new RedirectError(`Redirect loop detected: ${raw.url}`, req);
        }
        visited.add(raw.url);

        // Capture cookies from this redirect hop
        jar?.processResponseHeaders(raw.headers as Record<string, string | string[]>, {
          url: raw.url,
        });

        // `followRedirects: false` (or `maxRedirects: 0`) hands the 3xx back to
        // the caller instead of chasing it — the same shape fetch() returns for
        // `redirect: "manual"`. It reported `redirected: true`, which is the one
        // value `redirected` must never take: no hop was taken, `res.url` is
        // still the request's own URL, and the whole point of the option is that
        // the caller now has to read `Location` and decide for itself. A caller
        // branching on `if (res.redirected)` to detect a cross-origin bounce was
        // told it had already been redirected to a URL it never requested.
        if (!followRedirects) return { ...raw, redirected: false };

        if (hop === maxRedirects) {
          // `EREDIRECT`, not `ENETWORK`. A redirect chain that has run out of
          // hops is a deterministic answer from the origin: the same request
          // produces the same chain. As an `ENETWORK` it fell into
          // `shouldRetry`'s network-error case and the whole chain was replayed
          // once per attempt — 16 requests against a server already looping,
          // under a `maxRedirects: 3` the caller had set, and after the whole
          // backoff schedule before the error they asked for finally arrived.
          // `shouldRetry` already had a non-retryable `EREDIRECT` case, and
          // `RedirectError` was already exported and documented; nothing
          // constructed it.
          throw new RedirectError(`Too many redirects (exceeded ${maxRedirects})`, req);
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

          // SSRF GATE (P0): the initial URL is screened by buildURL → isSafeURL,
          // but a redirect target never went through that check. Without this a
          // public host could 302 the client straight at link-local/loopback
          // addresses (169.254.169.254, 127.0.0.1, 10/8, ::1, …) and the whole
          // private-network block list would be bypassable. Re-validate every hop.
          if (!isSafeURL(nextUrl)) {
            throw new KinetexError(
              `Unsafe redirect target blocked: ${redactUserInfo(location)}`,
              "EVALIDATION",
              { request: req },
            );
          }

          // httpsOnly must hold for redirect legs too, otherwise a redirect is a
          // trivial downgrade from https:// to http:// past the pre-flight guard.
          if (this.cfg.httpsOnly && protocol !== "https:") {
            throw new KinetexError(
              `HTTPS-only mode enabled but redirect target uses ${protocol}`,
              "EVALIDATION",
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

        const nextHeaders = { ...currentReq.headers };

        // FIX H2: When the redirect crosses origins, strip credential-bearing
        // headers (Authorization, Cookie, proxy auth, API keys) so secrets are
        // never forwarded to a different origin (RFC 9110 7.1 semantics).
        //
        // ORDERING (this must happen BEFORE the cookie header is rebuilt): the
        // previous order computed the new origin's cookie header first and then
        // deleted it again in the strip loop, so every cross-origin hop was
        // sent without the cookies the jar had just scoped for it.
        let crossOrigin = false;
        try {
          crossOrigin = new URL(nextUrl).origin !== new URL(currentReq.url).origin;
        } catch {
          /* nextUrl was already validated above */
        }
        if (crossOrigin) {
          for (const h of CROSS_ORIGIN_STRIP_HEADERS) {
            delete nextHeaders[h];
          }
          // An `apikey` auth header name is chosen by the application, so it is
          // not in the well-known list. It is a credential all the same, and it
          // was being forwarded verbatim to the new origin.
          if (appliedAuth && appliedAuth.type === "apikey") {
            delete nextHeaders[appliedAuth.header.toLowerCase()];
          }
        }

        // Rebuild the Cookie header for the next hop from the updated jar.
        // Jar scoping guarantees only cookies that match the NEW origin are
        // attached, which is exactly the post-strip state we want.
        if (jar) {
          const cookieHeader = jar.getCookieHeader({ url: nextUrl, http: true });
          if (cookieHeader) {
            nextHeaders["cookie"] = cookieHeader;
          } else {
            delete nextHeaders["cookie"];
          }
        } else if (crossOrigin) {
          // No jar: drop the caller's cookie header with the other credentials
          // (mirrors what fetch() does for a cross-origin redirect).
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
      // The chain was followed by hand, so report `redirected: true` for hop > 0
      // to match what fetch() reports under redirect: "follow".
      return hop > 0 ? { ...raw, redirected: true } : raw;
    }

    // Unreachable
    throw new RedirectError("Redirect loop", req);
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
    // `noCache()` sets `cache: { forceRefresh: true }`, and `forceRefresh` was
    // declared on `CacheRequestConfig` and read *nowhere*: the lookup below ran
    // exactly as if no option had been passed, so a warm entry was served and
    // the fluent method documented as "Force a fresh fetch, bypassing any cached
    // response" did not fetch. The fix is to skip the read for this request —
    // the write still happens, which is what "refresh" means.
    const forceRefresh = options.cache !== false && options.cache?.forceRefresh === true;
    if (options.cache !== false && this.cfg.cache) {
      const cache = await this.getCache();
      if (cache && !forceRefresh) {
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
                // Must not be able to skip: if getCache() rejects, the in-flight
                // marker survives and this key can never revalidate again, so
                // every future stale hit would be served stale forever.
                try {
                  (await this.getCache())?.clearSWRInFlight(cacheReq);
                } catch {
                  /* isolate — never leave the SWR marker stuck */
                }
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
          "accept-encoding": DEFAULT_ACCEPT_ENCODING,
        },
      };
    }

    // ── Dispatch ───────────────────────────────────────────────────────────
    // Redirects are ALWAYS followed by hand, and that is not a preference.
    //
    // `_sendFollowingRedirects` is the only place kinetex checks a redirect
    // *target*: the SSRF gate (`isSafeURL` on every hop), the `httpsOnly`
    // policy, the redirect-loop detector, the `maxRedirects` cap, and the
    // RFC 7231 method downgrade for 301/302/303. It also exists to capture
    // intermediate Set-Cookie and to strip credentials across origins, which is
    // why it used to be entered only when a cookie jar or a forwarded credential
    // header happened to be configured.
    //
    // An ordinary GET is neither. So an ordinary GET's redirects were chased by
    // the transport instead, and every check above was skipped: the HTTP/2
    // transport's own loop resolved any `Location` and dialled it, and
    // `FetchTransport` handed fetch `redirect: "follow"`, which does the same.
    // A 302 to `http://127.0.0.1:9/` opened the socket (`ECONNREFUSED` came
    // back from the loopback port, which is the point — nothing refused the
    // connection first), and a 302 to `http://169.254.169.254/` was answered by
    // the cloud metadata service. `httpsOnly: true` changed nothing on either
    // path; both reported the same opaque `Protocol error`.
    //
    // The two reasons the follower was originally introduced are reasons it is
    // *necessary*, not an exhaustive list of when it applies.
    const dispatchJar = await this.getCookieJar();
    const effectiveAuth = options.auth !== false ? (options.auth ?? this.cfg.auth) : undefined;

    this._trace(_traceId, "transport_send", "start", startMs, attempt);
    let raw: RawResponse;
    try {
      raw = await this._sendFollowingRedirects(
        req,
        timeout,
        dispatchJar ?? undefined,
        effectiveAuth,
      );
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

    // ── Lifecycle: after request ───────────────────────────────────────────
    // "After the request is sent (before response is processed)" — the window
    // between the transport answering and the response being built, and the
    // only place a caller can observe that the wire round trip is over without
    // also having to see the parsed response. It was declared on `LifecycleHooks`
    // and documented twice in the README, and never invoked: a caller who
    // registered it got silence, on every code path, for every status.
    //
    // Deliberately *not* fired on the throw above: the request was not sent.
    if (this.cfg.hooks?.onAfterRequest) {
      for (const fn of this.cfg.hooks.onAfterRequest) {
        await fn(req, this._hookCtx(ctx));
      }
    }

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
      // Capture the SOURCE in its own binding. `bodyStream` is reassigned to
      // this wrapper immediately after construction, so closing over it made
      // `cancel()` cancel *itself*: readRawBody's reader.cancel() (size limit,
      // abort, read error) re-entered this function, which threw
      // "Invalid state: ReadableStream is locked" from inside the cancel
      // algorithm and left that inner promise unhandled (process-level crash on
      // Node). start() only worked by accident, relying on the async-fn body
      // running synchronously up to the first await.
      const source: ReadableStream<Uint8Array> = bodyStream;
      bodyStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader();
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
        cancel(reason) {
          // Forward cancellation to the real source and swallow its failure:
          // a rejection here is never observed by the cancelling reader.
          void source.cancel(reason).catch(() => {});
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
      // transformResponse is applied below, once `res` exists, so it receives
      // the real response object instead of the `{}` placeholder it used to get.
      data,
      rawBody,
      url: raw.url,
      cached: false,
      redirected: raw.redirected,
      httpVersion: raw.httpVersion,
      durationMs,
      request: req,
      attempt,
    };

    // Apply transformResponse now that the response object exists, so the hook
    // receives the real response (status/headers/url) rather than the empty
    // placeholder it used to be handed.
    if (this.cfg.transformResponse) {
      // `data` is readonly on the public type; the cast is confined to this one
      // write, immediately after construction.
      (res as { data: T }).data = this.cfg.transformResponse<T>(
        res.data,
        res as KinetexResponse<unknown>,
      );
    }

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
        // Re-sending from a response interceptor used to be unbounded: an
        // interceptor that always returns a modified request (the classic
        // token-refresh shape, but also a mis-written one) recursed forever,
        // each level a fresh _executeOnce with a fresh interceptor context.
        // The depth therefore travels on request meta, which _executeOnce
        // carries into the nested call (ctx.store would not survive it).
        const resendDepth = Number(_req.meta[INTERCEPTOR_RESEND_DEPTH] ?? 0);
        if (resendDepth >= MAX_INTERCEPTOR_RESENDS) {
          throw new KinetexError(
            `Response interceptor re-send limit reached (${MAX_INTERCEPTOR_RESENDS}) — refusing to loop`,
            "EVALIDATION",
            { request: _req },
          );
        }
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
          {
            ...(result as unknown as KinetexRequest),
            meta: {
              ...(result as unknown as KinetexRequest).meta,
              [INTERCEPTOR_RESEND_DEPTH]: resendDepth + 1,
            },
          },
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
    body?: import("./types.ts").RequestBody,
    options?: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "POST", { ...options, ...(body !== undefined ? { body } : {}) });
  }

  /** Execute a PUT request. */
  put<T = unknown>(
    url: string,
    body?: import("./types.ts").RequestBody,
    options?: SendOptions<T>,
  ): Promise<KinetexResponse<T>> {
    return this.send<T>(url, "PUT", { ...options, ...(body !== undefined ? { body } : {}) });
  }

  /** Execute a PATCH request. */
  patch<T = unknown>(
    url: string,
    body?: import("./types.ts").RequestBody,
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
      const fi = init as {
        method?: string;
        headers?: Record<string, string>;
        body?: BodyInit;
        signal?: AbortSignal;
      };
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
      const fi = init as {
        method?: string;
        headers?: Record<string, string>;
        body?: BodyInit;
        signal?: AbortSignal;
      };
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
      const fi = init as {
        method?: string;
        headers?: Record<string, string>;
        body?: BodyInit;
        signal?: AbortSignal;
      };
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
  // Not `async`: nothing here awaits, so the returned promise is resolved
  // explicitly instead. The signature stays Promise<void> — callers and the
  // docs `await client.destroy()`.
  destroy(): Promise<void> {
    // Close all tracked WebSocket connections
    for (const ws of this._wsClients) {
      try {
        ws.close(1000, "Client destroyed");
      } catch {
        /* best-effort */
      }
    }
    this._wsClients.clear();

    // NOTE: the cache is deliberately NOT cleared here. destroy() releases
    // resources; it must not purge data, and a user-supplied adapter
    // (localStorage / Cloudflare KV / Redis) would lose every persisted entry.
    // Call `client.getCache().then(c => c.clear())` explicitly to empty it.
    if (IS_NODE && this.transport && "destroy" in this.transport) {
      (this.transport as { destroy: () => void }).destroy();
    }
    // Reject anyone still parked on the queue — it can never drain now.
    this._concurrencyLimiter?.drain();
    this._cookieJar = null;
    this._logger = null;
    this._dedup?.clear();
    this._circuitBreakers?.clear?.();
    this._otelTracer = null;
    this.interceptors.clear();

    return Promise.resolve();
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

  /**
   * Attach an `Idempotency-Key`, generating one when none is given.
   *
   * Lets a retried `POST` be recognised as the same logical operation by the
   * server instead of creating a duplicate. Because the header is set on the
   * request options — not regenerated per attempt — every retry of this
   * request carries the same key, which is the entire point.
   *
   * @param value - An explicit key, or `undefined` to generate a v4 UUID.
   * @throws {TypeError} If `value` is not a valid key (see `isValidIdempotencyKey`).
   *
   * @example
   * ```ts
   * await client.POST("/charges").withJSON(body).idempotencyKey().json();
   * ```
   */
  idempotencyKey(value?: string): this {
    const key = value === undefined ? generateIdempotencyKey() : value;
    if (!isValidIdempotencyKey(key)) {
      throw new TypeError(
        `idempotencyKey: ${typeof key === "string" ? JSON.stringify(key) : typeof key} is not a ` +
          "valid Idempotency-Key — expected 1-255 visible ASCII characters",
      );
    }
    this._options.headers = {
      ...(this._options.headers as Record<string, string>),
      "idempotency-key": key,
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
  withBody(body: import("./types.ts").RequestBody): this {
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
 * Convert a KinetexResponse into the lifecycle HookResponse shape, or null
 * when the request never produced one (network error, timeout, abort).
 *
 * Used by the error-hook bridge so onError hooks can read the HTTP status of
 * a failed request instead of always seeing null.
 */
function toHookResponse(
  res: KinetexResponse<unknown> | undefined,
  request: import("./lifecycle.ts").HookRequest,
): import("./lifecycle.ts").HookResponse | null {
  if (!res) return null;
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.rawBody ?? null,
    request,
  };
}

/**
 * The abort error raised by the retry loop itself.
 *
 * This used to build a bare `DOMException`, which is a real `Error` but not a
 * `KinetexError`: it carries no `code`, so `err.code === "EABORT"` and
 * `err.isAbort` were both false here while every other abort path in the
 * library (see core.ts) raised `EABORT`. Callers documented to see `AbortError`
 * therefore got a structurally different error depending on whether the signal
 * fired mid-request or mid-retry-delay. The library's own `AbortError` keeps
 * `name === "AbortError"`, so name-based checks like `isAbortError` are
 * unaffected.
 *
 * @param request - The request being retried, attached when available.
 * @returns A KinetexError with code `EABORT`.
 */
function createAbortError(request?: KinetexRequest): AbortError {
  return new AbortError(request);
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

/**
 * True for request bodies that cannot be sent twice: a ReadableStream is
 * consumed (and locked) by the first attempt, and a Blob-backed stream is
 * derived from an already-read handle. Both are fine once, never on retry.
 */
function isNonReplayableBody(body: unknown): boolean {
  if (body instanceof ReadableStream) return true;
  return typeof Blob !== "undefined" && body instanceof Blob;
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
  /**
   * Maximum number of requests taken out of the queue per flush.
   * NOTE: this is a batching size, NOT a concurrency limit — every request in a
   * batch is dispatched immediately and in parallel, and `flush()` drains the
   * whole queue the same way. Use `maxBatch` to bound how much is dispatched per
   * tick, and a semaphore or rate limiter to bound actual parallelism.
   */
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
    // maxBatch must be a positive integer: _flushNow() splices exactly
    // `_maxBatch` items, so 0 (or a negative value) spliced nothing and made
    // flush() spin forever on a queue it could never drain.
    const maxBatch = options.maxBatch ?? 100;
    if (!Number.isInteger(maxBatch) || maxBatch < 1) {
      throw new RangeError(`BatchQueue maxBatch must be a positive integer (got ${maxBatch})`);
    }
    this._maxBatch = maxBatch;
    const flushMs = options.flushMs ?? 0;
    if (!Number.isFinite(flushMs) || flushMs < 0) {
      throw new RangeError(
        `BatchQueue flushMs must be a non-negative finite number (got ${flushMs})`,
      );
    }
    this._flushMs = flushMs;
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
    // The constructor guarantees _maxBatch >= 1, so every _flushNow() removes at
    // least one item. The counter is defence in depth against a future change
    // reintroducing a zero-progress flush (which would spin forever).
    let guard = this._queue.length + 1;
    while (this._queue.length > 0 && guard-- > 0) this._flushNow();
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
