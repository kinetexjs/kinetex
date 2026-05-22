// Node.js globals accessed via globalThis for cross-runtime compatibility
const g = globalThis as {
  process?: { versions?: { node?: string } };
  Buffer?: { isBuffer: (arg: unknown) => boolean; from: (arg: ArrayBuffer) => Uint8Array };
};

/**
 * Cross-runtime transport layer.
 *
 * Selects the best available transport:
 *  - Node.js: `node:http2` (with HTTP/1.1 fallback via `node:https`)
 *  - Deno / Bun / Browser / Edge: native `fetch()` (handles HTTP/2 automatically)
 *  - SOCKS5 proxy: custom TCP tunnel (from socks5.ts)
 */

import type { KinetexRequest, HTTPVersion, Runtime } from "./types.ts";
import { KinetexError, TimeoutError, SizeLimitError } from "./types.ts";
import { concatUint8Arrays, mergeSignals, isAbortError, safeJSONParse } from "./utils.ts";
import { isValidHeaderName, isValidHeaderValue } from "./headers.ts";

// ============================================================================
// §1  RUNTIME DETECTION
// ============================================================================

/**
 * Detect the current JavaScript runtime.
 *
 * @returns The detected {@link Runtime} identifier.
 */
export function detectRuntime(): Runtime {
  // Deno
  const _deno = (globalThis as unknown as { Deno?: { version?: string } }).Deno;
  if (typeof _deno !== "undefined" && typeof _deno.version !== "undefined") {
    return "deno";
  }
  // Bun
  if (typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined") {
    return "bun";
  }
  // Cloudflare Workers - rely on global caches presence, not userAgent
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>)["caches"] !== "undefined"
  ) {
    return "cloudflare-workers";
  }
  // Browser (use self !== window to avoid false positives in Workers with window stubbed)
  if (
    typeof window !== "undefined" &&
    typeof (globalThis as Record<string, unknown>)["document"] !== "undefined"
  ) {
    return "browser";
  }
  // Node.js
  if (g.process?.versions?.node !== undefined) {
    return "node";
  }
  // WinterCG / Vercel Edge / other
  if (typeof globalThis.fetch === "function") {
    return "edge";
  }
  return "unknown";
}

/** Cached runtime value — detected once at module load. */
export const RUNTIME: Runtime = detectRuntime();

/**
 * Runtime override — set via `setRuntime()` for testing in workers/isolates.
 * When non-null, `getEffectiveRuntime()` returns this value instead of `RUNTIME`.
 * @internal
 */
let _runtimeOverride: Runtime | null = null;

/**
 * Override the cached runtime value.
 *
 * Use this in test environments where the detected runtime may be incorrect
 * (e.g., a Node.js test that should behave as a Cloudflare Worker), or when
 * running inside a VM/isolate with dynamic globalThis behavior.
 *
 * Pass `null` to restore auto-detection.
 *
 * @example
 * ```ts
 * import { setRuntime } from "kinetex";
 * setRuntime("cloudflare-workers"); // test CF behavior
 * setRuntime(null);                 // restore detection
 * ```
 */
export function setRuntime(rt: Runtime | null): void {
  _runtimeOverride = rt;
}

/**
 * Return the effective runtime — the override if set, otherwise the
 * auto-detected {@link RUNTIME} constant.
 *
 * Prefer this over the `RUNTIME` export when runtime-gated branches need
 * to be testable.
 */
export function getEffectiveRuntime(): Runtime {
  return _runtimeOverride ?? RUNTIME;
}

/**
 * True when running in Node.js.
 * @public
 */
export const IS_NODE = RUNTIME === "node";

/**
 * True when running in a fetch-native environment (Deno, Bun, Browser, Edge).
 * In Node.js, this is true if `globalThis.fetch` is available (Node 18+).
 * @public
 */
export const HAS_NATIVE_FETCH = RUNTIME !== "node" || typeof globalThis.fetch === "function";

/**
 * Check if the current environment is production (suppresses non-fatal warnings).
 * Uses try-catch guard for runtimes where `process` may be absent or a
 * throwing Proxy (CF Workers, Vercel Edge).
 */
function isProductionEnvironment(): boolean {
  try {
    const g = globalThis as { process?: { env?: Record<string, string> } };
    return g.process?.env?.NODE_ENV === "production";
  } catch {
    return false;
  }
}

// ============================================================================
// §2  TRANSPORT INTERFACE
// ============================================================================

/**
 * Minimal interface a transport must implement.
 * Receives a fully-resolved {@link KinetexRequest} and returns a raw response.
 */
export interface Transport {
  send(request: KinetexRequest): Promise<RawResponse>;
}

/**
 * Raw response from the transport layer — before body parsing.
 */
export interface RawResponse {
  /** HTTP status code */
  status: number;
  /** HTTP status text (e.g. "OK") */
  statusText: string;
  /** Response headers as a flat record */
  headers: Record<string, string>;
  /** Body as a ReadableStream<Uint8Array>. May be null for 204/HEAD. */
  body: ReadableStream<Uint8Array> | null;
  /** Final response URL (after any redirects) */
  url: string;
  /** Whether the request was redirected */
  redirected: boolean;
  /** HTTP protocol version detected */
  httpVersion: HTTPVersion;
  /** Whether the body has already been decompressed by the transport layer */
  alreadyDecompressed?: boolean;
}

// ============================================================================
// §3  FETCH TRANSPORT (Deno / Bun / Browser / CF Workers / Edge / Node 18+)
// ============================================================================

/**
 * Options for the universal fetch-based transport.
 */
export interface FetchTransportOptions {
  /**
   * Custom fetch implementation.
   * Defaults to `globalThis.fetch`.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * When `true`, invalid headers cause a `KinetexError` instead of being
   * silently dropped. Recommended for strict/production environments where
   * silent data loss is unacceptable.
   *
   * Default: `false` (drop & warn).
   *
   * @see {@link https://github.com/kinetexjs/kinetex/docs/strict-headers.md}
   */
  strict?: boolean;
  /**
   * Called whenever a header is dropped due to an invalid name or value.
   * Useful for logging or monitoring header sanitization in non-strict mode.
   *
   * @param name  - The header name that was dropped.
   * @param value - The header value that was dropped.
   */
  onDroppedHeader?: (name: string, value: string) => void;
}

/**
 * Universal fetch-based transport.
 * Suitable for all runtimes where `fetch` is available.
 */
export class FetchTransport implements Transport {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly strict: boolean;
  private readonly onDroppedHeader: ((name: string, value: string) => void) | undefined;

  /**
   * @param fetchFnOrOptions - Custom fetch function or options object
   */
  constructor(
    fetchFnOrOptions: typeof globalThis.fetch | FetchTransportOptions = globalThis.fetch,
  ) {
    if (typeof fetchFnOrOptions === "function") {
      this.fetchFn = fetchFnOrOptions;
      this.strict = false;
      this.onDroppedHeader = undefined;
    } else {
      this.fetchFn = fetchFnOrOptions.fetchFn ?? globalThis.fetch;
      this.strict = fetchFnOrOptions.strict ?? false;
      this.onDroppedHeader = fetchFnOrOptions.onDroppedHeader;
    }
  }

  /**
   * Send a request via the native fetch() API.
   *
   * Validates and sanitizes headers to prevent injection attacks.
   * Handles accept-encoding stripping, body attachment with Node.js
   * duplex workaround, and normalizes the response into a RawResponse.
   *
   * @param req - Fully resolved request
   * @returns Raw response from the server
   */
  async send(req: KinetexRequest): Promise<RawResponse> {
    // Validate and sanitize headers to prevent injection attacks
    const sanitizedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      // Skip if header name or value is invalid
      if (typeof name !== "string" || typeof value !== "string") continue;
      if (!isValidHeaderName(name) || !isValidHeaderValue(value)) {
        if (this.strict) {
          // In strict mode, an invalid header is an error — never silently drop
          throw new KinetexError(
            `Invalid header dropped in strict mode: "${name}"`,
            "EVALIDATION",
            { request: req },
          );
        }
        // Non-strict: emit callback and/or warn, then skip
        if (this.onDroppedHeader) {
          this.onDroppedHeader(name, value);
        } else if (!isProductionEnvironment()) {
          console.warn(
            `[kinetex] Invalid header dropped: "${name}" — value may contain illegal characters. ` +
              `Pass strictHeaders: true to throw instead.`,
          );
        }
        continue;
      }
      sanitizedHeaders[name] = value;
    }

    // Strip default accept-encoding injected by client.ts so fetch()
    // can add its own. Preserve caller-explicit values (e.g. "identity").
    const ae = sanitizedHeaders["accept-encoding"];
    if (ae && ae.toLowerCase().includes("gzip") && ae.toLowerCase().includes("deflate") && ae.toLowerCase().includes("br")) {
      delete sanitizedHeaders["accept-encoding"];
    }

    // Build fetch init
    const init: RequestInit = {
      method: req.method,
      headers: sanitizedHeaders,
      redirect: req.redirect ?? "follow",
      // signal must be AbortSignal | null — omit entirely if absent
      ...(req.signal !== null ? { signal: req.signal } : {}),
    };

    // Attach body for methods that allow it
    if (req.body !== null && req.method !== "GET" && req.method !== "HEAD") {
      // req.body is typed as BodyInit which is compatible with globalThis.BodyInit
      init.body = req.body as BodyInit;

      // Node.js fetch (undici) requires duplex: 'half' when body is a ReadableStream
      // This is a Node.js-specific requirement. Check if we're in Node.js.
      if (
        IS_NODE &&
        typeof init.body === "object" &&
        init.body !== null &&
        "getReader" in init.body
      ) {
        (init as unknown as { duplex?: string }).duplex = "half";
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(req.url, init);
    } catch (err) {
      if (isAbortError(err)) {
        throw new KinetexError("Request was aborted", "EABORT", { request: req, cause: err });
      }
      throw new KinetexError(
        err instanceof Error ? err.message : "Network request failed",
        "ENETWORK",
        { request: req, cause: err },
      );
    }

    const headers = normalizeHeaders(response.headers);
    const httpVersion = detectHTTPVersion(response, headers);

    // Determine if the runtime already decompressed the body.
    // fetch()-based runtimes (Bun, Node undici, Browser) decompress all
    // common encodings (gzip, deflate, br). Deno only decompresses gzip and
    // br — deflate must be handled by decompressBodyStream downstream.
    let alreadyDecompressed = true;
    if (RUNTIME === "deno") {
      const rawCE = response.headers.get("content-encoding") || "";
      if (rawCE.toLowerCase().includes("deflate")) {
        alreadyDecompressed = false;
      }
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: response.body as ReadableStream<Uint8Array> | null,
      url: response.url || req.url,
      redirected: response.redirected,
      httpVersion,
      alreadyDecompressed,
    };
  }
}

// ============================================================================
// §4  NODE.JS HTTP/2 TRANSPORT
// ============================================================================

/**
 * Node.js HTTP/2 transport using `node:http2`.
 * Automatically falls back to HTTP/1.1 for non-HTTPS URLs or servers
 * that don't support HTTP/2.
 *
 * Only loaded when running in Node.js. In all other runtimes the
 * {@link FetchTransport} is used instead.
 */
export class NodeHTTP2Transport implements Transport {
  // Per-instance session pool (not module-level singleton) so different
  // Kinetex instances don't share sessions and can have independent configs.
  private readonly sessions = new Map<string, NodeHTTP2Session>();
  private readonly sessionTTLMs: number;
  private readonly pingIntervalMs: number;
  private readonly maxSessions: number;
  private readonly pingTimers = new Map<string, ReturnType<typeof setInterval>>();
  // _sessionCreating holds in-progress creation promises keyed by origin.
  // A key is present iff a goroutine is currently creating a session for that origin.
  private readonly _sessionCreating = new Map<
    string,
    Promise<import("node:http2").ClientHttp2Session>
  >();
  // Track session usage for LRU eviction
  private sessionUsage = new Map<string, number>();

  private readonly _strict: boolean;
  private readonly _onDroppedHeader: ((name: string, value: string) => void) | undefined;
  /** FIX 11: Configurable connect timeout (replaces hardcoded 30 000 ms) */
  private readonly _connectTimeoutMs: number;
  /** FIX 11: Configurable per-request stream timeout (replaces hardcoded 30 000 ms) */
  private readonly _requestTimeoutMs: number;
  /** Cached HTTP/1.1 fallback transport — reuse instead of creating fresh FetchTransport per call */
  private _http1Fallback: FetchTransport | null = null;

  /**
   * @param options - Session pool and transport configuration
   */
  constructor(
    options: {
      sessionTTLMs?: number;
      pingIntervalMs?: number;
      maxSessions?: number;
      strict?: boolean;
      onDroppedHeader?: (name: string, value: string) => void;
      /** HTTP/2 connection (CONNECT) timeout in ms. Default: 30 000 */
      connectTimeoutMs?: number;
      /** HTTP/2 per-stream request timeout in ms. Default: 30 000 */
      requestTimeoutMs?: number;
    } = {},
  ) {
    this.sessionTTLMs = options.sessionTTLMs ?? 5 * 60_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.maxSessions = options.maxSessions ?? 100;
    this._strict = options.strict ?? false;
    this._onDroppedHeader = options.onDroppedHeader;
    this._connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this._requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /**
   * Get or create a session for the given origin, properly serialising concurrent
   * callers so only ONE session is created even when many requests arrive together.
   */
  private _getOrCreateSession(
    origin: string,
    req: KinetexRequest,
    http2: typeof import("node:http2"),
  ): Promise<import("node:http2").ClientHttp2Session> {
    // If a creation is already in progress for this origin, join it.
    const inFlight = this._sessionCreating.get(origin);
    if (inFlight) return inFlight;

    // Start a new creation and store the promise before any await so subsequent
    // callers see it immediately.
    const promise = this._createSession(origin, req, http2);
    this._sessionCreating.set(origin, promise);
    promise
      .finally(() => {
        // Remove only if still our promise (another creation may have replaced it).
        if (this._sessionCreating.get(origin) === promise) {
          this._sessionCreating.delete(origin);
        }
      })
      .catch(() => {});
    return promise;
  }

  /**
   * Create a new HTTP/2 session for an origin with connection timeout
   * and abort signal support. Sets up ping keepalive and LRU tracking.
   */
  private async _createSession(
    origin: string,
    req: KinetexRequest,
    http2: typeof import("node:http2"),
  ): Promise<import("node:http2").ClientHttp2Session> {
    // Re-check under async lock — another caller may have resolved and stored by now.
    const current = this.sessions.get(origin);
    if (
      current &&
      !current.session.destroyed &&
      !current.session.closed &&
      !(Date.now() - current.createdAt > this.sessionTTLMs)
    ) {
      this.sessionUsage.set(origin, Date.now());
      return current.session;
    }

    // Evict stale session
    if (current) this._evictSession(origin, current.session);

    // Enforce max sessions with LRU eviction
    if (this.sessions.size >= this.maxSessions) {
      let lruOrigin = "";
      let lruTime = Infinity;
      for (const [o, t] of this.sessionUsage.entries()) {
        if (t < lruTime) {
          lruTime = t;
          lruOrigin = o;
        }
      }
      if (lruOrigin) {
        const lruSession = this.sessions.get(lruOrigin);
        if (lruSession) this._evictSession(lruOrigin, lruSession.session);
      }
    }

    const session = await new Promise<import("node:http2").ClientHttp2Session>(
      (resolve, reject) => {
        const s = http2.connect(origin, { rejectUnauthorized: true });
        // FIX 11: use configurable connect timeout instead of hardcoded 30 000 ms
        // FIX 9: unref() the timer so it does not prevent process exit
        const connectTimeout = setTimeout(() => {
          s.destroy();
          reject(
            new KinetexError(`HTTP/2 connection to ${origin} timed out`, "ETIMEOUT", {
              request: req,
            }),
          );
        }, this._connectTimeoutMs);
        if (typeof (connectTimeout as unknown as { unref?: () => void }).unref === "function") {
          (connectTimeout as unknown as { unref: () => void }).unref();
        }

        const onAbort = () => {
          clearTimeout(connectTimeout);
          s.destroy();
          reject(new KinetexError("Connection aborted", "EABORT", { request: req }));
        };
        const abortCleanup = () => req.signal?.removeEventListener("abort", onAbort);
        req.signal?.addEventListener("abort", onAbort, { once: true });

        s.once("connect", () => {
          abortCleanup();
          clearTimeout(connectTimeout);
          resolve(s);
        });
        s.once("error", (err) => {
          abortCleanup();
          clearTimeout(connectTimeout);
          reject(err);
        });
      },
    );

    session.on("goaway", () => {
      this._evictSession(origin, session);
    });
    session.on("error", () => {
      this._evictSession(origin, session);
    });

    this.sessions.set(origin, { session, createdAt: Date.now() });
    this.sessionUsage.set(origin, Date.now());

    // Start keepalive pings for this new session
    if (this.pingIntervalMs > 0) {
      const existingTimer = this.pingTimers.get(origin);
      if (existingTimer) clearInterval(existingTimer);
      const pingTimer = setInterval(() => {
        const entry = this.sessions.get(origin);
        if (!entry || entry.session.destroyed || entry.session.closed) {
          this._evictSession(origin, entry?.session);
          return;
        }
        entry.session.ping((err) => {
          if (err) this._evictSession(origin, entry.session);
        });
      }, this.pingIntervalMs);
      if (typeof pingTimer === "object" && pingTimer !== null && "unref" in pingTimer) {
        (pingTimer as { unref: () => void }).unref();
      }
      this.pingTimers.set(origin, pingTimer);
    }

    return session;
  }

  /**
   * Send a request via HTTP/2 with automatic fallback to HTTP/1.1.
   *
   * For HTTPS URLs, attempts HTTP/2 first. If the server doesn't support
   * HTTP/2 (ALPN negotiation fails), falls back to HTTP/1.1 via fetch().
   * Non-HTTPS URLs or explicit HTTP/1.1 preference skip straight to fallback.
   *
   * @param req - Fully resolved request
   * @returns Raw response from the server
   */
  async send(req: KinetexRequest): Promise<RawResponse> {
    const url = new URL(req.url);

    // HTTP/2 only works over HTTPS (or h2c for cleartext, but that's rare)
    if (url.protocol !== "https:" || req.httpVersion === "HTTP/1.1") {
      return this._sendHTTP1(req);
    }

    try {
      return await this._sendHTTP2(req, url);
    } catch (err) {
      // ALPN negotiation failed or server doesn't support h2 — fall back
      if (isHTTP2FallbackError(err)) {
        return this._sendHTTP1(req);
      }
      throw err;
    }
  }

  /**
   * Send a request over HTTP/2 with iterative redirect following.
   * Each hop reuses or creates a session for the target origin.
   */
  private async _sendHTTP2(req: KinetexRequest, url: URL): Promise<RawResponse> {
    // Lazy-import node:http2 so this module is still importable in non-Node runtimes
    const http2 = await import("node:http2");

    // -----------------------------------------------------------------------
    // FIX 1 (Critical): Redirect loop is now fully iterative — no more
    // resolve(null) + dead reject() pattern that caused callers to receive
    // `null` and crash on `raw.status` access.
    // -----------------------------------------------------------------------
    let currentReq = req;
    let currentUrl = url;
    let redirected = false;
    const MAX_HOPS = 10;

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (hop === MAX_HOPS) {
        throw new KinetexError("Too many HTTP/2 redirects", "ENETWORK", { request: req });
      }

      const origin = currentUrl.origin;

      // Reuse or create session — properly serialised via _getOrCreateSession
      const existing = this.sessions.get(origin);
      const isStale = existing && Date.now() - existing.createdAt > this.sessionTTLMs;

      let session: import("node:http2").ClientHttp2Session;
      if (!existing || existing.session.destroyed || existing.session.closed || isStale) {
        session = await this._getOrCreateSession(origin, currentReq, http2);
      } else {
        session = existing.session;
        this.sessionUsage.set(origin, Date.now());
      }

      // Build headers for this hop
      const h2ReqHeaders: Record<string, string | string[]> = {
        ":method": currentReq.method,
        ":path": currentUrl.pathname + currentUrl.search,
        ":scheme": "https",
        ":authority": currentUrl.host,
        ...currentReq.headers,
      };

      // Strict-mode header validation (HTTP/2 control-character check)
      if (this._strict) {
        for (const [hName, hValue] of Object.entries(h2ReqHeaders)) {
          if (hName.startsWith(":")) continue;
          const hStr = Array.isArray(hValue) ? hValue.join(", ") : String(hValue);
          let hasForbidden = false;
          for (let ci = 0; ci < hStr.length; ci++) {
            const code = hStr.charCodeAt(ci);
            if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
              hasForbidden = true;
              break;
            }
          }
          if (hasForbidden) {
            if (this._onDroppedHeader) {
              this._onDroppedHeader(hName, hStr);
              delete (h2ReqHeaders as Record<string, unknown>)[hName];
            } else {
              throw new KinetexError(
                `Strict mode: header "${hName}" contains forbidden control characters`,
                "EVALIDATION",
                { request: currentReq },
              );
            }
          }
        }
      }

      const endStream =
        !currentReq.body || currentReq.method === "GET" || currentReq.method === "HEAD";
      const stream = session.request(h2ReqHeaders, { endStream });

      // FIX 6 (backpressure): attachBodyToH2Stream now awaits drain events
      if (currentReq.body && !endStream) {
        attachBodyToH2Stream(stream, currentReq.body).catch((err) => {
          stream.destroy(err instanceof Error ? err : new Error(String(err)));
        });
      }

      // FIX 11: Use configurable timeouts instead of hardcoded 30 000 ms
      // Capture the signal at this hop so the abort listener closure always references
      // the correct signal even when currentReq is reassigned for redirects
      const hopSignal = currentReq.signal;
      const raw = await new Promise<RawResponse>((resolve, reject) => {
        const requestTimeoutMs = this._requestTimeoutMs;
        const requestTimeout = setTimeout(() => {
          abortCleanup();
          reject(
            new KinetexError(
              `HTTP/2 request to ${currentUrl} timed out after ${requestTimeoutMs}ms`,
              "ETIMEOUT",
              { request: currentReq },
            ),
          );
          stream.destroy();
        }, requestTimeoutMs);

        const onAbort = () => {
          clearTimeout(requestTimeout);
          reject(new KinetexError("Request was aborted", "EABORT", { request: currentReq }));
          stream.destroy();
        };
        const abortCleanup = () => hopSignal?.removeEventListener("abort", onAbort);
        hopSignal?.addEventListener("abort", onAbort, { once: true });

        stream.once("response", (h2RespHeaders) => {
          const status = Number(h2RespHeaders[":status"] ?? 200);
          const statusText = HTTP_STATUS_TEXTS[status] ?? "";
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(h2RespHeaders)) {
            if (k.startsWith(":")) continue;
            resHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
          }

          clearTimeout(requestTimeout);
          abortCleanup();

          // Check abort status AFTER cleanup to avoid removing listener from freed signal
          if (hopSignal?.aborted) {
            reject(new KinetexError("Request was aborted", "EABORT", { request: currentReq }));
            stream.destroy();
            return;
          }

          if (
            currentReq.redirect === "error" &&
            status >= 300 &&
            status < 400 &&
            resHeaders["location"]
          ) {
            reject(
              new KinetexError(
                `Redirect not allowed (redirect:"error") — received ${status} to ${resHeaders["location"]}`,
                "ENETWORK",
                { request: currentReq },
              ),
            );
            stream.destroy();
            return;
          }

          resolve({
            status,
            statusText,
            headers: resHeaders,
            body: nodeDuplexToReadable(stream),
            url: currentReq.url,
            redirected,
            httpVersion: "HTTP/2",
            alreadyDecompressed: false,
          });
        });

        stream.once("error", (err) => {
          clearTimeout(requestTimeout);
          abortCleanup();
          if (hopSignal?.aborted) {
            reject(
              new KinetexError("Request was aborted", "EABORT", {
                request: currentReq,
                cause: err,
              }),
            );
          } else {
            reject(new KinetexError(err.message, "ENETWORK", { request: currentReq, cause: err }));
          }
          stream.destroy();
        });
      });

      // Check whether this hop is a redirect we should follow
      const isRedirect =
        raw.status >= 300 &&
        raw.status < 400 &&
        !!raw.headers["location"] &&
        currentReq.redirect !== "manual";

      if (!isRedirect) {
        // Final response — drain any unread body and return
        return raw;
      }

      // Drain the redirect response body before making the next request
      try {
        if (raw.body) {
          const drain = raw.body.getReader();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done } = await drain.read();
            if (done) break;
          }
          drain.releaseLock();
        }
      } catch {
        /* ignore drain errors */
      }

      const location = raw.headers["location"]!;
      let nextHref: string;
      try {
        nextHref = new URL(location, currentReq.url).href;
      } catch {
        throw new KinetexError(`Invalid redirect Location: ${location}`, "ENETWORK", {
          request: req,
        });
      }

      // RFC 7231 §6.4: 301/302/303 → downgrade to GET; 307/308 → preserve method
      const nextMethod =
        raw.status === 301 || raw.status === 302 || raw.status === 303 ? "GET" : currentReq.method;
      const nextBody = nextMethod === "GET" || nextMethod === "HEAD" ? null : currentReq.body;

      currentReq = { ...currentReq, url: nextHref, method: nextMethod, body: nextBody };
      currentUrl = new URL(nextHref);
      redirected = true;
    }

    // Unreachable — loop exits via return or throw above
    throw new KinetexError("HTTP/2 redirect loop terminated unexpectedly", "ENETWORK", {
      request: req,
    });
  }

  /**
   * Fallback to HTTP/1.1 via fetch() or legacy node:https.
   */
  private _sendHTTP1(req: KinetexRequest): Promise<RawResponse> {
    // Fall back to fetch for HTTP/1.1 on Node — works in Node 18+
    // For older Node, use node:https
    if (typeof globalThis.fetch === "function") {
      if (!this._http1Fallback) {
        const opts: FetchTransportOptions = {
          fetchFn: globalThis.fetch,
          strict: this._strict,
        };
        if (this._onDroppedHeader !== undefined) opts.onDroppedHeader = this._onDroppedHeader;
        this._http1Fallback = new FetchTransport(opts);
      }
      return this._http1Fallback.send(req);
    }

    return this._sendHTTP1Legacy(req);
  }

  /**
   * Legacy HTTP/1.1 via node:https for Node.js <18 (no global fetch).
   */
  private async _sendHTTP1Legacy(req: KinetexRequest): Promise<RawResponse> {
    const https = await import("node:https");
    const url = new URL(req.url);

    const options: import("node:http").RequestOptions = {
      hostname: url.hostname,
      port: url.port || "443",
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    };

    return new Promise<RawResponse>((resolve, reject) => {
      const httpReq = https.request(options, (httpRes) => {
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(httpRes.headers)) {
          if (v !== undefined) resHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
        }

        const body = nodeReadableToWebStream(httpRes);

        resolve({
          status: httpRes.statusCode ?? 200,
          statusText: httpRes.statusMessage ?? "",
          headers: resHeaders,
          body,
          url: req.url,
          redirected: false,
          httpVersion: "HTTP/1.1",
          alreadyDecompressed: false, // node:https does NOT auto-decompress
        });
      });

      httpReq.once("error", (err: Error) => {
        reject(new KinetexError(err.message, "ENETWORK", { request: req, cause: err }));
      });

      // Remove the abort listener once the request settles so the httpReq
      // reference doesn't leak beyond the request lifetime.
      const onAbort = () => {
        httpReq.destroy();
        reject(new KinetexError("Request was aborted", "EABORT", { request: req }));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => req.signal?.removeEventListener("abort", onAbort);
      httpReq.once("close", cleanup);
      httpReq.once("error", cleanup);

      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        pipeBodyToNodeReq(httpReq, req.body).catch(reject);
      } else {
        httpReq.end();
      }
    });
  }

  /** @internal Evict one session and its associated ping timer. */
  private _evictSession(origin: string, session?: import("node:http2").ClientHttp2Session): void {
    const timer = this.pingTimers.get(origin);
    if (timer) {
      clearInterval(timer);
      this.pingTimers.delete(origin);
    }
    this.sessions.delete(origin);
    this.sessionUsage.delete(origin);
    this._sessionCreating.delete(origin);
    if (session && !session.destroyed && !session.closed) {
      session.destroy();
    }
  }

  /** Close all cached HTTP/2 sessions and their ping timers. */
  destroy(): void {
    for (const timer of this.pingTimers.values()) {
      clearInterval(timer);
    }
    this.pingTimers.clear();
    this._sessionCreating.clear();
    for (const [origin, { session }] of this.sessions.entries()) {
      this._evictSession(origin, session);
    }
    this.sessions.clear();
  }
}

/** A tracked HTTP/2 session with its creation timestamp. */
interface NodeHTTP2Session {
  session: import("node:http2").ClientHttp2Session;
  createdAt: number;
}

// ============================================================================
// §5  TRANSPORT FACTORY
// ============================================================================

/**
 * Create the appropriate transport for the current runtime.
 * Each call returns a fresh transport — the Kinetex client owns the lifetime.
 *
 * @param fetchFn - Custom fetch implementation.
 * @param preferHTTP2 - Whether to prefer HTTP/2 on Node.js.
 * @param sessionOptions - HTTP/2 session pool options.
 * @param transportOptions - Header validation options (strict mode, dropped-header callback).
 */
export function createTransport(
  fetchFn?: typeof globalThis.fetch,
  preferHTTP2 = true,
  sessionOptions?: {
    sessionTTLMs?: number;
    pingIntervalMs?: number;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
  },
  transportOptions?: Pick<FetchTransportOptions, "strict" | "onDroppedHeader">,
): Transport {
  // Use NodeHTTP2Transport for Node.js when HTTP/2 is preferred
  // Falls back to FetchTransport for HTTP/1.1 or non-Node runtimes
  if (IS_NODE && preferHTTP2) {
    return new NodeHTTP2Transport({
      ...(sessionOptions?.sessionTTLMs !== undefined
        ? { sessionTTLMs: sessionOptions.sessionTTLMs }
        : {}),
      ...(sessionOptions?.pingIntervalMs !== undefined
        ? { pingIntervalMs: sessionOptions.pingIntervalMs }
        : {}),
      ...(sessionOptions?.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: sessionOptions.connectTimeoutMs }
        : {}),
      ...(sessionOptions?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: sessionOptions.requestTimeoutMs }
        : {}),
      ...(transportOptions?.strict !== undefined ? { strict: transportOptions.strict } : {}),
      ...(transportOptions?.onDroppedHeader !== undefined
        ? { onDroppedHeader: transportOptions.onDroppedHeader }
        : {}),
    });
  }
  return new FetchTransport({
    fetchFn: fetchFn ?? globalThis.fetch,
    ...(transportOptions?.strict !== undefined ? { strict: transportOptions.strict } : {}),
    ...(transportOptions?.onDroppedHeader !== undefined
      ? { onDroppedHeader: transportOptions.onDroppedHeader }
      : {}),
  });
}

// ============================================================================
// §6  TIMEOUT WRAPPER
// ============================================================================

/**
 * Wrap a transport with a per-request timeout.
 * Works by racing the transport promise against a timeout promise.
 *
 * @param transport - Transport to wrap
 * @param request   - Request to send
 * @param timeoutMs - Timeout in milliseconds (<=0 disables timeout)
 * @returns Raw response from the server
 * @throws {TimeoutError} If the request exceeds the timeout
 */
export async function sendWithTimeout(
  transport: Transport,
  request: KinetexRequest,
  timeoutMs: number,
): Promise<RawResponse> {
  if (timeoutMs <= 0) return transport.send(request);

  // Create a local abort controller that fires on timeout
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(timeoutMs, request));
  }, timeoutMs);

  // Merge signals
  const signal = mergeSignals(request.signal, controller.signal) ?? null;
  const req = { ...request, signal };

  try {
    const result = await transport.send(req);
    clearTimeout(timer);
    // Safety net: the transport may have resolved despite the abort signal
    // (e.g. Node.js HTTP/2 'close' fires before 'error' in some versions).
    // If the timeout controller fired, always surface a TimeoutError.
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, request);
    }
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs, request);
    }
    throw err;
  }
}

// ============================================================================
// §7  BODY READING
// ============================================================================

/**
 * Read a raw response body stream into a Uint8Array,
 * enforcing an optional size limit.
 *
 * @param stream - The response body stream to read
 * @param maxBytes - Maximum bytes to read (0 = unlimited)
 * @param _url - Request URL (reserved for debugging/logging in error messages)
 * @param signal - AbortSignal for cancellation
 * @returns Complete body as a single Uint8Array
 * @throws {SizeLimitError} If the body exceeds maxBytes
 * @throws {KinetexError} If reading is aborted
 */
export async function readRawBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  _url: string,
  signal?: AbortSignal | null,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // Register an abort listener BEFORE the first read() so that
  // an abort signal fires while read() is blocked cancels it immediately
  // (rather than waiting for the current chunk to arrive).
  // FIX: Assign _abortReject before adding the listener to prevent race condition
  let _abortReject!: (e: unknown) => void;
  const _abortPromise = new Promise<never>((_, reject) => {
    _abortReject = reject;
  });
  const _onAbort = () => {
    reader.cancel("aborted").catch(() => {});
    _abortReject(new KinetexError("Response reading aborted", "EABORT"));
  };
  if (signal?.aborted) {
    reader.cancel("aborted").catch(() => {});
    throw new KinetexError("Response reading aborted", "EABORT");
  }
  signal?.addEventListener("abort", _onAbort, { once: true });

  try {
    while (true) {
      const readResult = await Promise.race([
        reader.read().catch((err) => {
          reader.cancel("read error").catch(() => {});
          throw err;
        }),
        _abortPromise,
      ]);
      const { done, value } = readResult;

      if (done) break;

      if (maxBytes > 0) {
        const newTotal = total + value.byteLength;
        if (newTotal > maxBytes) {
          await reader.cancel("size limit exceeded");
          throw new SizeLimitError(newTotal, maxBytes);
        }
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    // Ensure stream is properly cancelled on any error
    reader.cancel("error during read").catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", _onAbort);
    reader.releaseLock();
  }

  return concatUint8Arrays(chunks);
}

// ============================================================================
// §8  RESPONSE PARSING
// ============================================================================

/**
 * Parse a raw body into a typed value.
 * Uses content-type to select the parser:
 *  - application/json → JSON.parse
 *  - text/* → TextDecoder
 *  - otherwise → Uint8Array
 *
 * @param raw           - Raw body bytes
 * @param contentType   - Content-Type header value (or null)
 * @param customParser  - Optional custom parser function
 * @param onParseFailure - Called when JSON parsing fails before falling back to text
 * @param headers       - Response headers (passed to customParser)
 * @param url           - Request URL (passed to customParser)
 * @returns Parsed body value (T, string, or Uint8Array)
 */
export function parseBody<T>(
  raw: Uint8Array,
  contentType: string | null,
  customParser?: (raw: Uint8Array, headers: Record<string, string>, url: string) => T | Promise<T>,
  onParseFailure?: (raw: Uint8Array, error: Error) => void,
  headers?: Record<string, string>,
  url?: string,
): T | Promise<T> {
  if (customParser) return customParser(raw, headers ?? {}, url ?? "");

  // Empty body returns null
  if (!raw.byteLength) return null as T;

  const ct = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (ct === "application/json" || ct.endsWith("+json")) {
    const text = new TextDecoder("utf-8").decode(raw);
    let parseResult: T | undefined;
    let parseError: Error | undefined;
    try {
      const result = safeJSONParse<T>(text, {
        maxStringLength: 10_000_000, // 10MB
        maxDepth: 100,
        maxArrayLength: 100_000,
      });
      if (result.success && result.value !== undefined) {
        parseResult = result.value;
      }
    } catch (e) {
      parseError = e instanceof Error ? e : new Error(String(e));
    }

    if (parseResult !== undefined) {
      return parseResult;
    }

    // JSON parsing failed — notify caller via onParseFailure before falling back to text
    if (onParseFailure) {
      try {
        onParseFailure(
          raw,
          parseError ?? new Error("JSON parse failed — falling back to raw text"),
        );
      } catch {
        // onParseFailure must not throw — swallow to avoid masking the original error
      }
    }
    return text as T;
  }

  if (ct.startsWith("text/")) {
    return new TextDecoder("utf-8").decode(raw) as T;
  }

  return raw as T;
}

// ============================================================================
// §9  UTILITIES
// ============================================================================

// FIX 12: normalizeHeaders centralised in utils.ts.
import { normalizeHeaders as _normalizeHeaders } from "./utils.ts";
/**
 * Normalize a Headers object to a plain record.
 *
 * @deprecated use normalizeHeaders from utils.ts directly
 * @param headers - Headers object to normalize
 * @returns Plain key-value record
 */
export function normalizeHeaders(headers: Headers): Record<string, string> {
  return _normalizeHeaders(headers);
}

/**
 * Detect the HTTP version from a Response object.
 * Checks runtime-specific properties (Deno httpVersion, Bun httpVersion),
 * Alt-Svc headers for HTTP/2 and HTTP/3, and protocols.
 *
 * @param response - The fetch Response object
 * @param _headers - Parsed response headers (reserved)
 * @returns Detected HTTP version
 */
function detectHTTPVersion(response: Response, _headers: Record<string, string>): HTTPVersion {
  // Deno exposes response.type or we can infer from headers
  // Runtime-specific property access requires type assertion
  const denoResponse = response as unknown as { httpVersion?: string };
  if (denoResponse.httpVersion === "2.0" || denoResponse.httpVersion === "2") {
    return "HTTP/2";
  }

  // Bun exposes httpVersion as a property
  const bunResponse = response as unknown as { httpVersion?: HTTPVersion };
  if (bunResponse.httpVersion) {
    return bunResponse.httpVersion;
  }

  // HTTP/3 (QUIC) detection via Alt-Svc header.
  // Servers that support HTTP/3 advertise: Alt-Svc: h3="...", h3-29="..."
  // We detect the advertisement here and update accordingly.
  const altSvc = response.headers.get("alt-svc");

  // Check for active HTTP/3 negotiation (runtime-specific property)
  const h3Response = response as unknown as { httpVersion?: string; protocol?: string };
  if (
    h3Response.httpVersion === "3" ||
    h3Response.httpVersion === "3.0" ||
    h3Response.protocol === "h3"
  ) {
    return "HTTP/3";
  }

  // Alt-Svc advertisement: infer HTTP version from the advertised protocols.
  // - h3 (QUIC) means the server supports HTTP/3
  // - h2 means the server supports HTTP/2
  // Most h3-capable servers also support h2; advertise Alt-Svc: h3="...", h2="..."
  // But some (e.g. Cloudflare) only advertise h3 — the current response is
  // served over HTTP/2 regardless, since fetch() negotiated HTTP/2 or higher.
  if (altSvc) {
    const hasH3 = altSvc.includes('h3="') || altSvc.includes("h3-29=") || altSvc.includes("h3-32=");
    const hasH2 = altSvc.includes('h2="');
    if (hasH2) return "HTTP/2";
    // h3 without h2 means server supports HTTP/3 — current response is at least HTTP/2
    if (hasH3) return "HTTP/2";
  }

  // Default to HTTP/1.1 — only report HTTP/2+ when there is runtime-specific evidence
  // (httpVersion on Response, Alt-Svc header, or underlying transport confirmation).
  return "HTTP/1.1";
}

/**
 * Check whether an error indicates an HTTP/2 connection failure
 * that should trigger a fallback to HTTP/1.1.
 */
function isHTTP2FallbackError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("alpn") ||
    msg.includes("h2") ||
    msg.includes("http2") ||
    (err as NodeJS.ErrnoException).code === "ERR_HTTP2_ERROR"
  );
}

// ── Node.js stream helpers (only executed on Node) ────────────────────────────

/**
 * Convert a Node.js Readable stream to a web ReadableStream<Uint8Array>.
 * Handles Buffer chunks, Uint8Array chunks, and stream closure/error/destroy events.
 *
 * @param stream - Node.js Readable stream
 * @returns Web ReadableStream of Uint8Array chunks
 */
function nodeDuplexToReadable(stream: import("node:stream").Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let ended = false;
      let errored = false;

      stream.on("data", (chunk: unknown) => {
        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else if (g.Buffer?.isBuffer(chunk)) {
          // Node.js Buffer — wrap without copying using offset + length
          const b = chunk as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
          controller.enqueue(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        } else {
          controller.enqueue(new Uint8Array(chunk as ArrayBuffer));
        }
      });

      stream.once("end", () => {
        if (ended || errored) return;
        ended = true;
        try {
          controller.close();
        } catch {
          // Controller may already be closed/aborted by another event
        }
      });

      stream.once("error", (e) => {
        if (ended || errored) return;
        ended = true;
        errored = true;
        try {
          controller.error(e);
        } catch {
          // Controller may already be closed
        }
      });

      // When the Node.js stream is destroyed (e.g. due to abort or timeout),
      // it emits "close" but NOT "end". Without this handler the ReadableStream
      // controller is never closed and any pending reader.read() hangs forever.
      stream.once("close", () => {
        if (ended || errored) return;
        ended = true;
        const err = Object.assign(new Error("Stream closed before end"), { code: "ECONNRESET" });
        try {
          controller.error(err);
        } catch {
          // Controller may already be closed
        }
      });
    },
    cancel() {
      stream.destroy();
    },
  });
}

// nodeReadableToWebStream only runs on Node - same implementation as nodeDuplexToReadable
const nodeReadableToWebStream = nodeDuplexToReadable;

/**
 * Write a single chunk to a writable Node stream,
 * honouring backpressure by awaiting the "drain" event when write() returns false.
 *
 * @param stream - Writable Node stream
 * @param chunk  - Data chunk to write
 */
async function writeChunkWithBackpressure(
  stream: { write: (d: unknown) => boolean; once: (e: string, cb: () => void) => unknown },
  chunk: Uint8Array,
): Promise<void> {
  const ok = stream.write(chunk);
  if (!ok) {
    await new Promise<void>((resolve) => stream.once("drain", resolve));
  }
}

/**
 * Write a request body to an HTTP/2 stream, respecting backpressure.
 * Handles ReadableStream, Uint8Array, ArrayBuffer, and string body types.
 *
 * @param stream - HTTP/2 stream to write to
 * @param body   - Request body
 */
async function attachBodyToH2Stream(
  stream: import("node:http2").ClientHttp2Stream,
  body: import("./types.ts").BodyInit,
): Promise<void> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        stream.end();
        break;
      }
      // FIX 6: respect backpressure — await drain when buffer is full
      await writeChunkWithBackpressure(stream, value);
    }
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    stream.end(g.Buffer ? new Uint8Array(body as ArrayBuffer) : (body as Uint8Array));
  } else if (typeof body === "string") {
    stream.end(body);
  } else {
    stream.end();
  }
}

/**
 * Write a request body to a Node.js http.ClientRequest, respecting backpressure.
 * Handles ReadableStream, Uint8Array, ArrayBuffer, and string body types.
 *
 * @param req  - Node.js ClientRequest
 * @param body - Request body
 */
async function pipeBodyToNodeReq(
  req: import("node:http").ClientRequest,
  body: import("./types.ts").BodyInit,
): Promise<void> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        req.end();
        break;
      }
      // FIX 6: respect backpressure — await drain when buffer is full
      await writeChunkWithBackpressure(req, value);
    }
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    req.end(g.Buffer ? new Uint8Array(body as ArrayBuffer) : (body as Uint8Array));
  } else if (typeof body === "string") {
    req.end(body);
  } else {
    req.end();
  }
}

// ============================================================================
// §10  DECOMPRESSION
// ============================================================================

/**
 * Apply content-encoding decompression to a raw body stream.
 * Dynamically imports response.ts so that environments that don't use
 * decompression don't pay the code cost. The import is cached by the runtime.
 *
 * Supported encodings: gzip, deflate, br (brotli)
 * Unsupported encodings (zstd, etc.) are passed through compressed; caller must handle or error.
 *
 * @param body    - Raw body stream (or null)
 * @param headers - Response headers (content-encoding is read and stripped on success)
 * @returns Decompressed body stream, null for null input, or original body for identity/unsupported
 */
export async function decompressBodyStream(
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string>,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!body) return null;
  const encoding = headers["content-encoding"] ?? headers["Content-Encoding"];
  if (!encoding) return body;

  const normalizedEncoding = encoding.trim().toLowerCase();

  // Split into individual encodings for validation
  const encodings = normalizedEncoding
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  // Check for unsupported encodings
  const supportedEncodings = ["gzip", "deflate", "br", "identity"];
  for (const enc of encodings) {
    if (!supportedEncodings.includes(enc)) {
      console.warn(
        `[Kinetex] Unsupported Content-Encoding: ${enc}. ` +
          `Supported: ${supportedEncodings.join(", ")}. ` +
          `Response body is passed through compressed.`,
      );
      return body;
    }
  }

  // identity means "no encoding" — return body as-is but strip the header
  // so downstream code doesn't misinterpret the presence of the header.
  if (normalizedEncoding === "identity") {
    // Remove the header to prevent false-positive decompression downstream
    delete headers["content-encoding"];
    delete headers["Content-Encoding"];
    return body;
  }

  // Lazily import applyDecompression from response.ts
  const { applyDecompression } = await import("./response.ts");
  return applyDecompression(body, headers);
}

/**
 * HTTP status code to text mapping.
 * Based on RFC 9110 and IANA HTTP Status Code Registry.
 * Includes all common status codes (1xx-5xx).
 *
 * @example
 * HTTP_STATUS_TEXTS[404] // "Not Found"
 * HTTP_STATUS_TEXTS[500] // "Internal Server Error"
 */
export const HTTP_STATUS_TEXTS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  // 418 "I'm a Teapot" removed - not appropriate for production
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};
