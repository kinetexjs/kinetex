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

import type { KinetexRequest, HTTPVersion, Runtime, SessionPoolConfig } from "./types.ts";
import { KinetexError, TimeoutError, SizeLimitError } from "./types.ts";
import {
  concatUint8Arrays,
  mergeSignals,
  isAbortError,
  safeJSONParse,
  isSafeURL,
  isBlockedAddress,
  randomBytes,
} from "./utils.ts";
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
/** Every value {@link Runtime} admits, for runtime validation. */
const KNOWN_RUNTIMES: readonly Runtime[] = [
  "node",
  "deno",
  "bun",
  "browser",
  "cloudflare-workers",
  "edge",
  "unknown",
];

export function setRuntime(rt: Runtime | null): void {
  // The parameter is typed, but nothing checks it at runtime, and the callers
  // that matter pass a value read from configuration. A typo — "denno" — was
  // stored verbatim and became the effective runtime, and every branch in the
  // library gated on `RUNTIME === "..."` then missed: no fetch, no HTTP/2, no
  // proxy, no Node-only path, with nothing thrown and nothing logged. An
  // unrecognised value is a mistake worth reporting at the point it is made.
  if (rt !== null && !KNOWN_RUNTIMES.includes(rt)) {
    throw new TypeError(
      `setRuntime: unknown runtime ${JSON.stringify(rt)}. Expected one of: ${KNOWN_RUNTIMES.join(", ")}`,
    );
  }
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
  /**
   * The runtime object that produced this response.
   *
   * A fetch `Response` on the FetchTransport path, a `ClientHttp2Stream` for
   * HTTP/2, or an `IncomingMessage` for the Node HTTP/1 transport. Absent on a
   * cache hit or a synthesized response.
   */
  raw?: unknown;
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
   * Permit connections to hosts that resolve into private, loopback or
   * link-local space. Default: false.
   *
   * @see {@link import("./types.ts").KinetexOptions.allowPrivateNetwork}
   */
  allowPrivateNetwork?: boolean;
  /**
   * Per-request timeout in milliseconds.
   *
   * `fetch()` has no timeout of its own, so without this a hung request waits
   * forever. `NodeHTTP2Transport` set its own `requestTimeoutMs`, but the
   * HTTP/1.1 fallback it delegates to did not pass anything down — so
   * `new NodeHTTP2Transport({ requestTimeoutMs: 500 })` against a slow host
   * waited the full response time while the HTTP/2 path gave up at 500 ms.
   *
   * Omit for no timeout (the previous behaviour on this path).
   */
  requestTimeoutMs?: number;
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
  /**
   * A `fetch` implementation extension passed straight through to the runtime,
   * most usefully an `undici` dispatcher (`Agent`, `ProxyAgent`, `MockAgent`).
   *
   * Typed as `unknown` so this stays dependency-free — kinetex never imports,
   * constructs, or type-checks against `undici`, it only forwards the value.
   * Whether the runtime honours it is up to that runtime: Node's `fetch` reads
   * `init.dispatcher`, Deno and Bun ignore it.
   *
   * Supplying a dispatcher forces {@link FetchTransport}, because the Node
   * HTTP/2 transport talks to `node:http2` directly and has no notion of one.
   */
  dispatcher?: unknown;
}

/**
 * The accept-encoding value client.ts injects when the caller did not set
 * one. FetchTransport removes exactly this string so fetch() negotiates its
 * own encodings; any other value is treated as caller intent.
 */
export const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br";

/**
 * Universal fetch-based transport.
 * Suitable for all runtimes where `fetch` is available.
 */
export class FetchTransport implements Transport {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly strict: boolean;
  private readonly onDroppedHeader: ((name: string, value: string) => void) | undefined;
  private readonly dispatcher: unknown;
  /** Per-request timeout; omitted means no timeout. */
  private readonly requestTimeoutMs: number | undefined;
  /**
   * Permit connections to hosts resolving into private/loopback space.
   * Default: false.
   */
  private readonly _allowPrivateNetwork: boolean;

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
      this.dispatcher = undefined;
      this.requestTimeoutMs = undefined;
      this._allowPrivateNetwork = false;
    } else {
      this.fetchFn = fetchFnOrOptions.fetchFn ?? globalThis.fetch;
      this.strict = fetchFnOrOptions.strict ?? false;
      this.onDroppedHeader = fetchFnOrOptions.onDroppedHeader;
      this.dispatcher = fetchFnOrOptions.dispatcher;
      this.requestTimeoutMs = fetchFnOrOptions.requestTimeoutMs;
      this._allowPrivateNetwork = fetchFnOrOptions.allowPrivateNetwork ?? false;
    }
  }

  /**
   * Refuse a host that resolves into blocked address space.
   *
   * The Node transports close DNS rebinding properly: they resolve once and
   * pin the checked address to the socket (`createPinnedLookup`). `fetch` has no
   * resolver hook — undici owns the connection and exposes no way to install
   * one — so the only place to intervene is before the call.
   *
   * That closes the case that matters in practice: a name resolving to loopback
   * or the cloud metadata address is refused outright, which is the vector
   * behind the classic SSRF-through-DNS attacks. What it cannot close is a
   * resolver that answers public on this lookup and private on the connect a
   * moment later. Closing *that* needs a resolver hook `fetch` does not offer,
   * and claiming otherwise would be worse than saying so.
   *
   * The host has already passed the lexical screen by this point, so this is a
   * second line of defence rather than the first.
   */
  private async assertReachableHost(url: string): Promise<void> {
    if (this._allowPrivateNetwork) return;
    // A caller-supplied `fetch` owns its own name resolution — its dispatcher,
    // agent or resolver may answer something the system resolver never would,
    // and vice versa. Screening the *system* answer for a name this transport
    // will not resolve is theatre: it cannot observe the connection that
    // actually happens, so it neither protects the caller nor describes the
    // risk honestly. The lexical screen still applies to every URL, including
    // redirects; the resolution half of the defence is the transport's job, and
    // a custom one is the caller's.
    if (this.fetchFn !== globalThis.fetch) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return; // Malformed URLs fail later, with a better message.
    }
    if (!parsed.hostname || isIPAddress(parsed.hostname)) return;

    let addresses: Array<{ address: string; family: number }>;
    try {
      // `all: true` so every candidate is inspected, matching what the socket
      // would have been able to reach.
      const lookup = await getDnsLookup();
      addresses = await new Promise<Array<{ address: string; family: number }>>(
        (resolve, reject) => {
          lookup(parsed.hostname, { all: true }, (err, res) =>
            err ? reject(err) : resolve(res as Array<{ address: string; family: number }>),
          );
        },
      );
    } catch {
      // Resolution failed; let the request itself report it rather than
      // inventing a different failure.
      return;
    }
    const safe = filterSafeAddresses(addresses);
    if (safe.length > 0) return;
    throw blockedHostError(url, addresses);
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
    await this.assertReachableHost(req.url);

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
      // `__proto__` is a legal header name — it is made of token characters,
      // so it passes the check above — and `sanitizedHeaders[name] = value` is a
      // [[Set]], so it went to the inherited setter, which ignores a primitive.
      // The header did not overwrite anything: it vanished, and the caller was
      // never told. Written as a data property, which is what was meant.
      if (name === "__proto__") {
        Object.defineProperty(sanitizedHeaders, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        continue;
      }
      sanitizedHeaders[name] = value;
    }

    // Strip the accept-encoding value INJECTED by client.ts so fetch() can add
    // its own. The old check removed ANY value containing gzip+deflate+br,
    // including one the caller set deliberately; matching the exact injected
    // default keeps caller intent intact.
    const ae = sanitizedHeaders["accept-encoding"];
    if (ae && ae.toLowerCase().replace(/\s+/g, " ") === DEFAULT_ACCEPT_ENCODING) {
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

    // Forwarded only when set: an explicit `dispatcher: undefined` would
    // otherwise override a globally-installed dispatcher on the runtime.
    if (this.dispatcher !== undefined) {
      (init as unknown as { dispatcher?: unknown }).dispatcher = this.dispatcher;
    }

    // fetch() has no timeout of its own, so one is enforced here with an
    // AbortController. Composed with the caller's signal rather than replacing
    // it, so cancelling the caller still cancels the request.
    const timeoutMs = this.requestTimeoutMs;
    const timeoutCtl = timeoutMs === undefined ? undefined : new AbortController();
    let timedOut = false;
    const onCallerAbort = () => timeoutCtl?.abort();
    if (timeoutCtl && req.signal) {
      if (req.signal.aborted) timeoutCtl.abort();
      else req.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer =
      timeoutCtl && timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            timeoutCtl.abort();
          }, timeoutMs)
        : undefined;
    const initWithSignal: RequestInit =
      timeoutCtl && !init.signal ? { ...init, signal: timeoutCtl.signal } : init;

    let response: Response;
    try {
      response = await this.fetchFn(req.url, initWithSignal);
    } catch (err) {
      // Clear the timer on every exit path, and drop the listener we added.
      if (timer !== undefined) clearTimeout(timer);
      if (timeoutCtl && req.signal) req.signal.removeEventListener("abort", onCallerAbort);
      if (timedOut) {
        throw new KinetexError(
          `HTTP/1.1 request to ${req.url} timed out after ${timeoutMs}ms`,
          "ETIMEOUT",
          { request: req, cause: err },
        );
      }
      if (isAbortError(err)) {
        throw new KinetexError("Request was aborted", "EABORT", { request: req, cause: err });
      }
      throw new KinetexError(
        err instanceof Error ? err.message : "Network request failed",
        "ENETWORK",
        { request: req, cause: err },
      );
    }
    if (timer !== undefined) clearTimeout(timer);
    if (timeoutCtl && req.signal) req.signal.removeEventListener("abort", onCallerAbort);

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
      raw: response,
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
  /** Optional CA bundle for origins with self-signed / private-PKI certificates. */
  private readonly _ca: string | string[] | undefined;
  /** FIX 11: Configurable connect timeout (replaces hardcoded 30 000 ms) */
  private readonly _connectTimeoutMs: number;
  /** FIX 11: Configurable per-request stream timeout (replaces hardcoded 30 000 ms) */
  private readonly _requestTimeoutMs: number;
  /** Cached HTTP/1.1 fallback transport — reuse instead of creating fresh FetchTransport per call */
  private _http1Fallback: FetchTransport | null = null;
  /**
   * Origins that rejected HTTP/2 during TLS ALPN. The first request pays the
   * failed handshake; every later request for the same origin goes straight to
   * HTTP/1.1 instead of repeating it.
   */
  private readonly _http1OnlyOrigins = new Set<string>();
  /**
   * Dedicated keep-alive agent for the legacy `node:https` path.
   *
   * This path called `https.request(options)` with no `agent`, so behaviour was
   * whatever the global agent happened to do — and that default is a moving
   * target. Node 19 turned `keepAlive` on for `https.globalAgent`, so this path
   * silently changed from a TCP + TLS handshake per request (Node 18 and
   * earlier) to pooled connections, with no code change here to explain it.
   *
   * An explicit agent makes the behaviour identical on every supported Node
   * version, bounds the idle-socket pool (the global agent keeps 256 free
   * sockets, which is a lot to hold open for a legacy fallback), and gives
   * callers a way to opt out.
   */
  /** Whether to permit connections into private/loopback address space. */
  private readonly _allowPrivateNetwork: boolean;
  private readonly _http1KeepAlive: boolean;
  private readonly _http1MaxSockets: number;
  /** One agent per protocol: an http.Agent cannot speak TLS and vice versa. */
  private _http1Agent: import("node:http").Agent | null = null;
  private _http1SecureAgent: import("node:https").Agent | null = null;
  /** HTTP(S) CONNECT proxy, or undefined for a direct connection. */
  private readonly _proxy: import("./types.ts").ProxyConfig | undefined;

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
      /** CA certificate(s) to trust in addition to the system store (private PKIs, self-signed test servers). */
      ca?: string | string[];
      /** HTTP/2 connection (CONNECT) timeout in ms. Default: 30 000 */
      connectTimeoutMs?: number;
      /** HTTP/2 per-stream request timeout in ms. Default: 30 000 */
      requestTimeoutMs?: number;
      /** Reuse TCP sockets on the legacy node:https path. Default: true */
      http1KeepAlive?: boolean;
      /** Max idle sockets retained by the legacy keep-alive agent. Default: 16 */
      http1MaxSockets?: number;
      /**
       * Route every connection through this HTTP(S) proxy using `CONNECT`.
       * Node.js only.
       */
      proxy?: import("./types.ts").ProxyConfig;
      /**
       * Permit connections to hosts that resolve into private, loopback or
       * link-local address space. Default: `false`.
       *
       * A hostname is screened as written, but the socket is dialled at whatever
       * that name *resolves to*, and nothing between the two re-checked the
       * answer. Without this, a name that answered with `127.0.0.1` reached a
       * loopback service and one that answered with `169.254.169.254` reached a
       * cloud metadata endpoint — DNS rebinding, needing only control of the
       * domain being requested.
       *
       * Set this to reach a service on `localhost`, a private network, or a
       * container network — which is most local development, and every test
       * that stands up a local server. Leave it unset for anything processing
       * untrusted URLs.
       */
      allowPrivateNetwork?: boolean;
    } = {},
  ) {
    this.sessionTTLMs = options.sessionTTLMs ?? 5 * 60_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.maxSessions = options.maxSessions ?? 100;
    this._allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this._http1KeepAlive = options.http1KeepAlive ?? true;
    this._http1MaxSockets = options.http1MaxSockets ?? 16;
    this._proxy = options.proxy;
    this._strict = options.strict ?? false;
    this._onDroppedHeader = options.onDroppedHeader;
    this._ca = options.ca;
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

    // With a proxy, the tunnel (and, for an https origin, the TLS handshake
    // to the target) is established *before* http2.connect is called.
    //
    // `createConnection` must return a socket synchronously — node:http2 does
    // not await it, and handing it a Promise yields a session built on a
    // thenable, which fails deep inside the stream layer with
    // "stream.pause is not a function". So the async work happens here and
    // the already-open socket is passed back synchronously.
    let proxiedSocket: import("node:net").Socket | import("node:tls").TLSSocket | null = null;
    if (this._proxy !== undefined) {
      proxiedSocket = await this._createProxiedSocket(origin, undefined, req);
    }

    const session = await new Promise<import("node:http2").ClientHttp2Session>(
      (resolve, reject) => {
        const s = http2.connect(origin, {
          rejectUnauthorized: true,
          // Resolve-and-check, so a hostname that points at a private address is
          // refused before anything is dialled. See `createPinnedLookup`.
          ...(this._allowPrivateNetwork ? {} : { lookup: PINNED_LOOKUP }),
          ...(this._ca !== undefined ? { ca: this._ca } : {}),
          // Already connected (and already TLS-wrapped for an https origin),
          // so node:http2 must use it as-is rather than negotiating again.
          ...(proxiedSocket !== null
            ? {
                createConnection: (() =>
                  proxiedSocket) as unknown as import("node:http2").SecureClientSessionOptions["createConnection"],
              }
            : {}),
        });
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

    // A pooled ClientHttp2Session is a live handle. Left ref'd, Node keeps the
    // event loop alive after the last response, so a one-shot script that does
    // not call destroy() never exits. `unref()` drops that handle's own hold
    // on the loop; active streams still hold it while they are open, which is
    // why this is safe to do at session creation rather than only when idle.
    session.unref();

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

    // Normalise every accepted spelling before it reaches the transport. The
    // old check compared against the literal "HTTP/1.1", so "http/1.1", "1.1"
    // and "HTTP/1.0" silently took the HTTP/2 path. An unrecognised value is a
    // caller error, not a request to negotiate, so it fails before dialling.
    const requested = req.httpVersion === undefined ? null : normalizeHTTPVersion(req.httpVersion);
    if (req.httpVersion !== undefined && requested === null) {
      throw new KinetexError(
        `Invalid httpVersion "${String(req.httpVersion)}" — expected "HTTP/2", "HTTP/1.1" or "HTTP/1.0"`,
        "EVALIDATION",
        { request: req },
      );
    }

    // HTTP/2 only works over HTTPS (or h2c for cleartext, but that's rare).
    //
    // `HTTP/1.0` is accepted as a preference, not a promise: Node has no
    // HTTP/1.0 client mode, so it resolves to the HTTP/1.1 path and the
    // response reports the protocol actually used.
    if (
      url.protocol !== "https:" ||
      requested === "HTTP/1.1" ||
      requested === "HTTP/1.0" ||
      this._http1OnlyOrigins.has(url.origin)
    ) {
      return this._sendHTTP1(req);
    }

    try {
      return await this._sendHTTP2(req, url);
    } catch (err) {
      // ALPN negotiation failed or the server does not support h2. Remember
      // the origin so subsequent requests skip the doomed handshake, and only
      // replay requests whose body can still be sent again.
      if (isHTTP2FallbackError(err) && isReplayableBody(req.body)) {
        this._http1OnlyOrigins.add(url.origin);
        return this._sendHTTP1(req);
      }
      throw err;
    }
  }

  /**
   * Refuse one header on the HTTP/2 path. Strict mode raises `EVALIDATION`
   * before anything is dialled; non-strict notifies the callback (if any) and
   * warns, never dropping silently.
   *
   * Both the pseudo-header filter and the validation loop go through here so
   * the two cannot drift apart, which is what let a caller-supplied `:path`
   * reach the wire while `FetchTransport` dropped the identical header.
   */
  private _rejectHeader(
    name: string,
    value: string,
    reason: string,
    request: KinetexRequest,
  ): void {
    if (this._strict) {
      throw new KinetexError(`Strict mode: header "${name}" ${reason}`, "EVALIDATION", {
        request,
      });
    }
    if (this._onDroppedHeader) {
      this._onDroppedHeader(name, value);
    } else if (typeof console !== "undefined") {
      console.warn(
        `[kinetex] Invalid header dropped (HTTP/2): "${name}" — ${reason}. ` +
          `Pass strictHeaders: true to throw instead.`,
      );
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

      // A `FormData` body has to be encoded BEFORE the header block is built:
      // the multipart boundary is generated during encoding, and a boundary
      // that cannot reach `content-type` leaves a body the peer cannot parse.
      // This transport bypasses fetch, so nothing else would have encoded it.
      // The client's own path never reaches this — it encodes the form and sets
      // the header together before dispatch — but a caller handing a `FormData`
      // straight to a transport would otherwise send a body whose boundary no
      // header ever named.
      let bodyForHop: import("./types.ts").BodyInit = currentReq.body;
      let encodedForHop: EncodedBody | undefined;
      if (currentReq.body instanceof FormData) {
        encodedForHop = await serializeRawBody(currentReq.body);
        bodyForHop = encodedForHop.bytes;
        // Request headers are lowercased before they reach the transport, so
        // a direct key read is the right test here.
        if (encodedForHop.contentType !== undefined && !currentReq.headers["content-type"]) {
          currentReq = {
            ...currentReq,
            headers: { ...currentReq.headers, "content-type": encodedForHop.contentType },
          };
        }
      }

      // Build headers for this hop. The transport owns the request line, so a
      // caller-supplied pseudo-header (":path", ":authority", ":method",
      // ":scheme") is refused rather than merged.
      //
      // They used to be spread over the transport's own values, which meant a
      // caller could send a request to a path and a `:authority` that the URL
      // argument never contained — the URL that `isSafeURL` screened is not
      // the URL that got dialled. The validation loop below could not catch it
      // either, because it skipped every name starting with ":", so even
      // `strict: true` returned 200 for a hijacked `:path`, and
      // `FetchTransport` dropped the very same header because ":" is not a
      // token character. Same request, two transports, two answers.
      const h2ReqHeaders: Record<string, string | string[]> = {
        ":method": currentReq.method,
        ":path": currentUrl.pathname + currentUrl.search,
        ":scheme": "https",
        ":authority": currentUrl.host,
      };
      for (const [hName, hValue] of Object.entries(currentReq.headers)) {
        if (hName.startsWith(":")) {
          this._rejectHeader(
            hName,
            Array.isArray(hValue) ? hValue.join(", ") : String(hValue),
            "is not a valid header name",
            currentReq,
          );
          continue;
        }
        // `__proto__` is a legal header name — it is made of token characters,
        // so it passes `isValidHeaderName` — and `h2ReqHeaders[name] = value`
        // is a [[Set]], so it hit the inherited setter, which ignores a
        // primitive. The header did not overwrite anything: it vanished, and
        // neither the callback nor the warning said so. Written as a data
        // property, which is what `FetchTransport` already does — the two
        // transports disagreed about whether it is sent at all.
        if (hName === "__proto__") {
          Object.defineProperty(h2ReqHeaders, hName, {
            value: hValue,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          continue;
        }
        h2ReqHeaders[hName] = hValue;
      }

      // Header validation (HTTP/2 control-character check). Runs in BOTH modes:
      // strict throws, non-strict drops with callback/warn — matching the
      // FetchTransport contract. (Previously the whole loop was gated on
      // strict mode, so non-strict requests never validated and a header with
      // forbidden control characters crashed session.request() with a raw
      // ERR_INVALID_HEADER_VALUE instead of being dropped.)
      for (const [hName, hValue] of Object.entries(h2ReqHeaders)) {
        if (hName.startsWith(":")) continue;
        const hStr = Array.isArray(hValue) ? hValue.join(", ") : String(hValue);
        // The same two checks FetchTransport runs, through the same helpers —
        // not a hand-rolled control-character scan. The scan checked the value
        // only, so a header *name* that was not a token ("X Bad", "X\u00e9")
        // reached `session.request()` and came back as a raw
        // ERR_INVALID_HTTP2_HEADER / ERR_INVALID_HEADER_VALUE instead of being
        // dropped in non-strict mode or raising EVALIDATION in strict mode; and
        // it had no upper bound, so a value above U+00FF — which FetchTransport
        // refuses because no ByteString header value can carry it — was sent on
        // this path and dropped on that one. Same request, two transports, two
        // answers. The comment above this loop claimed they matched; they did
        // not, and HTTP/2 is the default on Node.
        const nameOk = isValidHeaderName(hName);
        const valueOk = isValidHeaderValue(hStr);
        if (!nameOk || !valueOk) {
          this._rejectHeader(
            hName,
            hStr,
            nameOk ? "contains forbidden control characters" : "is not a valid header name",
            currentReq,
          );
          delete (h2ReqHeaders as Record<string, unknown>)[hName];
        }
      }

      const endStream = !bodyForHop || currentReq.method === "GET" || currentReq.method === "HEAD";
      const stream = session.request(h2ReqHeaders, { endStream });

      // FIX 6 (backpressure): attachBodyToH2Stream now awaits drain events
      if (bodyForHop && !endStream) {
        attachBodyToH2Stream(stream, bodyForHop).catch((err) => {
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
            raw: stream,
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
          // `for(;;)` rather than `while (true)`: same loop, no condition for a
          // linter to have an opinion about.
          for (;;) {
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
      let nextProtocol: string;
      try {
        const nextUrl = new URL(location, currentReq.url);
        nextHref = nextUrl.href;
        nextProtocol = nextUrl.protocol.toLowerCase();
      } catch {
        throw new KinetexError(`Invalid redirect Location: ${location}`, "ENETWORK", {
          request: req,
        });
      }

      // The same two gates the client's manual redirect follower applies, for
      // the same reasons. They were absent here, and this loop is the *only*
      // follower on this path whenever the request arrives without
      // `redirect: "manual"` — which is every direct use of this transport.
      //
      //  - Protocol. This transport hardcodes `:scheme: "https"` and speaks
      //    HTTP/2, so a cleartext target cannot be dialled at all: the hop
      //    failed as `ERR_HTTP2_ERROR: Protocol error` with nothing to connect
      //    it to the target. A downgrade was therefore possible by accident
      //    rather than refused on purpose, and an `httpsOnly` client could not
      //    tell the difference.
      //  - SSRF. The hop origin is dialled directly by `http2.connect` below,
      //    with no `isSafeURL` screen — the client's follower screens every hop
      //    precisely because "a redirect target never went through that
      //    check". A 302 to `http://127.0.0.1:9/` opened the socket.
      if (nextProtocol !== "https:") {
        throw new KinetexError(
          `HTTP/2 redirect to a non-HTTPS target blocked: ${nextProtocol}//…`,
          "EVALIDATION",
          { request: req },
        );
      }
      if (!isSafeURL(nextHref)) {
        throw new KinetexError(
          `Unsafe redirect target blocked: ${nextHref.replace(/:\/\/[^/@]*@/, "://…@")}`,
          "EVALIDATION",
          { request: req },
        );
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
    // `ca` and `proxy` cannot be expressed through the platform fetch API
    // without an undici dispatcher, which this package deliberately does not
    // depend on. The node:http(s) path honours both, so use it whenever either
    // is configured instead of silently dropping the setting.
    const needsNodeTls = this._ca !== undefined || this._proxy !== undefined;

    if (typeof globalThis.fetch === "function" && !needsNodeTls) {
      if (!this._http1Fallback) {
        const opts: FetchTransportOptions = {
          fetchFn: globalThis.fetch,
          strict: this._strict,
          // The h2 path enforces `_requestTimeoutMs` itself; without passing it
          // down, `new NodeHTTP2Transport({ requestTimeoutMs: 500 })` hung for
          // the full response time on any non-https URL or HTTP/1.1 request.
          requestTimeoutMs: this._requestTimeoutMs,
          // Both were accepted by this transport and then dropped on the
          // fallback path, so a private hostname hit the DNS screen with the
          // default `false` and a private-network request failed even though
          // the client had opted in.
          allowPrivateNetwork: this._allowPrivateNetwork,
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
    const url = new URL(req.url);
    const secure = url.protocol === "https:";
    // A proxy or custom CA forces this path even on Node 18+, so it must be
    // able to speak plain HTTP as well as TLS. Reaching for node:https for an
    // `http://` URL wrapped the socket in TLS and failed the handshake.
    const nodeHttp = secure ? await import("node:https") : await import("node:http");

    // A `FormData` body is encoded before the request options are built, for
    // the same reason as on the HTTP/2 path: the multipart boundary is
    // generated during encoding, and this transport bypasses fetch, so
    // nothing else would encode it or announce the boundary. A caller-set
    // `content-type` wins — they may have encoded the form themselves.
    let legacyReq = req;
    if (req.body instanceof FormData) {
      const encoded = await serializeRawBody(req.body);
      legacyReq = { ...req, body: encoded.bytes };
      if (encoded.contentType !== undefined && !legacyReq.headers["content-type"]) {
        legacyReq = {
          ...legacyReq,
          headers: { ...legacyReq.headers, "content-type": encoded.contentType },
        };
      }
    }

    const options: import("node:http").RequestOptions = {
      hostname: url.hostname,
      port: url.port || (secure ? "443" : "80"),
      path: url.pathname + url.search,
      method: legacyReq.method,
      headers: legacyReq.headers,
      // A proxy is implemented by overriding the agent's createConnection, so
      // it needs an agent even when keep-alive is disabled. Previously
      // `http1KeepAlive: false` silently bypassed the proxy.
      ...(this._http1KeepAlive || this._proxy !== undefined
        ? { agent: this._getHttp1Agent(nodeHttp, secure) }
        : {}),
      // `ca` was accepted by the transport but never reached this path, so a
      // private or self-signed peer could not be reached without disabling
      // verification process-wide.
      ...(this._ca !== undefined ? { ca: this._ca } : {}),
      // Same reason as the HTTP/2 path above.
      ...(this._allowPrivateNetwork ? {} : { lookup: PINNED_LOOKUP }),
    };

    return new Promise<RawResponse>((resolve, reject) => {
      const request = nodeHttp.request as typeof import("node:https").request;
      const httpReq = request(options, (httpRes) => {
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
          raw: httpRes,
        });
      });

      httpReq.once("error", (err: Error) => {
        // An error raised while building the connection (a refused proxy
        // tunnel, a TLS failure) is already a KinetexError carrying a
        // meaningful code. Re-wrapping it as ENETWORK threw that away, so a
        // 403 from the proxy and a DNS failure became indistinguishable.
        reject(
          err instanceof KinetexError
            ? err
            : new KinetexError(err.message, "ENETWORK", { request: req, cause: err }),
        );
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
        pipeBodyToNodeReq(httpReq, legacyReq.body).catch(reject);
      } else {
        httpReq.end();
      }
    });
  }

  /**
   * Lazily create the keep-alive agent used by the legacy HTTP/1.1 path.
   *
   * @param nodeHttp - The already-imported `node:http` or `node:https` module.
   * @param secure - Whether this agent will dial TLS.
   * @returns The shared agent for that protocol, reused across requests.
   */
  private _getHttp1Agent(
    nodeHttp: typeof import("node:https") | typeof import("node:http"),
    secure: boolean,
  ): import("node:http").Agent | import("node:https").Agent {
    const existing = secure ? this._http1SecureAgent : this._http1Agent;
    if (existing) return existing;

    // The two Agent classes share the option surface used here; the secure
    // one additionally reads `ca`, which the plain one ignores.
    const Agent = nodeHttp.Agent as typeof import("node:https").Agent;
    const agent = new Agent({
      keepAlive: this._http1KeepAlive,
      maxSockets: this._http1MaxSockets,
      maxFreeSockets: this._http1MaxSockets,
      // A private/self-signed peer must be trusted before the socket enters
      // the pool, otherwise the agent only fails later on reuse.
      ...(secure && this._ca !== undefined ? { ca: this._ca } : {}),
    });
    if (secure) this._http1SecureAgent = agent;
    else this._http1Agent = agent;

    if (this._proxy !== undefined) {
      // Assigned to the INSTANCE, not passed in the agent options:
      // `new Agent({ createConnection })` only copies it into
      // `agent.options`, while `Agent.prototype.createSocket` calls
      // `this.createConnection(...)` — the prototype method. Passing it in
      // the options is silently ignored and the agent dials the origin
      // directly, bypassing the proxy entirely.
      //
      // `createSocket` does:
      //     const s = this.createConnection(options, oncreate);
      //     if (s) oncreate(null, s);
      // so returning a Promise would be truthy and the agent would adopt
      // the thenable as a socket. The callback form is the supported way to
      // connect asynchronously: this returns undefined and reports the
      // tunneled socket through `oncreate`.
      //
      // The tunnel is already TLS-wrapped for an https origin, which is
      // exactly what https.Agent expects createConnection to return.
      agent.createConnection = ((
        opts: import("node:tls").ConnectionOptions & { protocol?: string },
        oncreate: (err: Error | null, socket?: import("node:net").Socket) => void,
      ) => {
        // The agent does not reliably put `protocol` in the connection
        // options, so fall back to the scheme this agent was built for. A
        // plain-HTTP proxy tunnel must stay plain; defaulting to https would
        // TLS-wrap it and fail the handshake.
        const protocol =
          opts.protocol === "http:" || opts.protocol === "https:"
            ? opts.protocol
            : secure
              ? "https:"
              : "http:";
        const defaultPort = protocol === "http:" ? 80 : 443;
        void this._createProxiedSocket(
          `${protocol}//${String(opts.host ?? opts.servername ?? "localhost")}:${String(opts.port ?? defaultPort)}`,
          undefined,
          undefined,
        ).then(
          (socket) => oncreate(null, socket),
          (err: Error) => oncreate(err),
        );
        return undefined;
      }) as unknown as typeof import("node:https").Agent.prototype.createConnection;
    }
    return agent;
  }

  /**
   * Open a socket to `origin` through the configured proxy.
   *
   * The returned socket is fully established — tunneled, and TLS-wrapped when
   * the origin is `https:` — so it can be handed to a transport that requires
   * its connection synchronously.
   *
   * @param origin - Target origin, e.g. `https://api.example.com:443`.
   * @param req - Originating request, attached to any thrown error.
   * @returns A socket connected to the target through the proxy.
   */
  private async _createProxiedSocket(
    origin: string,
    _tlsOpts: unknown,
    req: KinetexRequest | undefined,
  ): Promise<import("node:net").Socket | import("node:tls").TLSSocket> {
    const { connectThroughProxy } = await import("./proxy.ts");
    const target = new URL(origin);
    return await connectThroughProxy(this._proxy as import("./types.ts").ProxyConfig, target, {
      ...(this._ca !== undefined ? { ca: this._ca } : {}),
      connectTimeoutMs: this._connectTimeoutMs,
      ...(req?.signal != null ? { signal: req.signal } : {}),
      ...(req !== undefined ? { request: req } : {}),
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

    // Drain the legacy HTTP/1.1 keep-alive pools too, so a destroyed transport
    // leaves no idle sockets behind holding the event loop open. There is one
    // agent per scheme: an http.Agent cannot speak TLS and vice versa.
    this._http1Agent?.destroy();
    this._http1Agent = null;
    this._http1SecureAgent?.destroy();
    this._http1SecureAgent = null;
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
  sessionOptions?: SessionPoolConfig,
  transportOptions?: Pick<FetchTransportOptions, "strict" | "onDroppedHeader" | "dispatcher"> & {
    /** CA certificate(s) trusted in addition to the system store. */
    ca?: string | string[];
    /** HTTP(S) CONNECT proxy (Node.js only). */
    proxy?: import("./types.ts").ProxyConfig;
    /** Permit connections to hosts resolving into private/loopback space. Default: false. */
    allowPrivateNetwork?: boolean;
  },
): Transport {
  // FIX (M7-class silent no-op): a custom `fetch` config was silently ignored on
  // Node.js when HTTP/2 was preferred (the default) — NodeHTTP2Transport has no
  // fetchFn input, so the caller's fetch was never used. When a custom fetch is
  // supplied, always route through FetchTransport so the documented
  // "Custom fetch implementation" behavior holds on every runtime.
  // Use NodeHTTP2Transport for Node.js when HTTP/2 is preferred and no custom
  // fetch is given. Falls back to FetchTransport otherwise.
  // A dispatcher belongs to the fetch implementation, exactly like a custom
  // fetch does — NodeHTTP2Transport speaks `node:http2` and has no notion of
  // one. So it forces the same fallback rather than being silently dropped.
  const needsFetchTransport = fetchFn !== undefined || transportOptions?.dispatcher !== undefined;
  if (IS_NODE && preferHTTP2 && needsFetchTransport) {
    if (!isProductionEnvironment()) {
      console.warn(
        fetchFn !== undefined
          ? '[kinetex] httpVersion: "HTTP/2" is ignored when a custom `fetch` is configured — ' +
              "NodeHTTP2Transport cannot use a custom fetch, so the request goes through " +
              "FetchTransport (HTTP/1.1 semantics). Drop the `fetch` option to use HTTP/2."
          : '[kinetex] httpVersion: "HTTP/2" is ignored when a `dispatcher` is configured — ' +
              "NodeHTTP2Transport talks to node:http2 directly and cannot use a fetch " +
              "dispatcher, so the request goes through FetchTransport (HTTP/1.1 semantics). " +
              "Drop the `dispatcher` option to use HTTP/2.",
      );
    }
  }
  // A forced HTTP/1.1 preference does not by itself justify dropping to
  // FetchTransport: `ca` and `proxy` can only be honoured by the Node HTTP
  // transport (fetch has no equivalent without an undici dispatcher). Keep the
  // Node transport when either is configured and let `req.httpVersion` choose
  // the HTTP/1.1 path inside it.
  const needsNodeTransport =
    preferHTTP2 || transportOptions?.ca !== undefined || transportOptions?.proxy !== undefined;

  if (IS_NODE && needsNodeTransport && !needsFetchTransport) {
    return new NodeHTTP2Transport({
      ...(sessionOptions?.sessionTTLMs !== undefined
        ? { sessionTTLMs: sessionOptions.sessionTTLMs }
        : {}),
      ...(sessionOptions?.pingIntervalMs !== undefined
        ? { pingIntervalMs: sessionOptions.pingIntervalMs }
        : {}),
      // maxSessions was a documented transport option but was never forwarded
      // here, so the LRU cap was unreachable and the pool grew unbounded.
      ...(sessionOptions?.maxSessions !== undefined
        ? { maxSessions: sessionOptions.maxSessions }
        : {}),
      ...(sessionOptions?.http1KeepAlive !== undefined
        ? { http1KeepAlive: sessionOptions.http1KeepAlive }
        : {}),
      ...(sessionOptions?.http1MaxSockets !== undefined
        ? { http1MaxSockets: sessionOptions.http1MaxSockets }
        : {}),
      ...(sessionOptions?.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: sessionOptions.connectTimeoutMs }
        : {}),
      ...(sessionOptions?.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: sessionOptions.requestTimeoutMs }
        : {}),
      ...(transportOptions?.strict !== undefined ? { strict: transportOptions.strict } : {}),
      ...(transportOptions?.allowPrivateNetwork !== undefined
        ? { allowPrivateNetwork: transportOptions.allowPrivateNetwork }
        : {}),
      ...(transportOptions?.onDroppedHeader !== undefined
        ? { onDroppedHeader: transportOptions.onDroppedHeader }
        : {}),
      ...(transportOptions?.ca !== undefined ? { ca: transportOptions.ca } : {}),
      ...(transportOptions?.proxy !== undefined ? { proxy: transportOptions.proxy } : {}),
    });
  }
  return new FetchTransport({
    fetchFn: fetchFn ?? globalThis.fetch,
    ...(transportOptions?.strict !== undefined ? { strict: transportOptions.strict } : {}),
    ...(transportOptions?.onDroppedHeader !== undefined
      ? { onDroppedHeader: transportOptions.onDroppedHeader }
      : {}),
    ...(transportOptions?.dispatcher !== undefined
      ? { dispatcher: transportOptions.dispatcher }
      : {}),
    // Reaches the pre-flight DNS screen in FetchTransport. It was accepted by
    // createTransport and then dropped, so every fetch-based runtime silently
    // had the screen off.
    ...(transportOptions?.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: transportOptions.allowPrivateNetwork }
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

  const timeoutPromise = new Promise<RawResponse>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new TimeoutError(timeoutMs, request)),
      { once: true },
    );
  });

  try {
    // Race the transport against the timer. The race is the actual deadline
    // — a transport that never resolves (or ignores the abort signal) can no
    // longer hang the caller past timeoutMs.
    const result = await Promise.race([transport.send(req), timeoutPromise]);
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
    if (controller.signal.aborted && !(err instanceof TimeoutError)) {
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

      // Same policy as the readers in response.ts, reached through the same
      // helper. The error class stays this entry point's own: `SizeLimitError`
      // is a `KinetexError` carrying code `ESIZELIMIT`, where the response
      // readers raise `ResponseSizeLimitError`, which is a bare `Error` with the
      // same code. Both are public and documented, and merging them would be a
      // breaking change, so the factory is passed in rather than shared.
      if (maxBytes > 0) {
        try {
          limitAction(value, total, { maxBytes }, "throw", (n, max) => new SizeLimitError(n, max));
        } catch (err) {
          await reader.cancel("size limit exceeded");
          throw err;
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
      } else if (!result.success) {
        // `safeJSONParse` refuses a payload for a reason it can name — a
        // depth, a length, a key count, a prototype-pollution key — and that
        // reason was dropped on the floor, so the caller was told "JSON parse
        // failed" for a body that is perfectly valid JSON and merely larger
        // than the limits this function chose. A response that quietly changes
        // from parsed to raw text is worth one specific sentence about which
        // limit it crossed, and the code is on the error so a handler can
        // branch on it.
        const failure = new Error(
          `JSON body rejected: ${result.message ?? "parse failed"} — falling back to raw text`,
        );
        Object.assign(failure, { code: result.error ?? "EPARSE" });
        parseError = failure;
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
//
// `node:dns` is loaded lazily. A static import here made the browser bundle
// unloadable even though the browser never takes a Node transport: esbuild
// cannot bundle `node:dns`, and the import ran before the runtime check could
// avoid it. The promise is shared, so the cost is one import per process.
let dnsLookupPromise: Promise<typeof import("node:dns").lookup> | null = null;
function getDnsLookup(): Promise<typeof import("node:dns").lookup> {
  dnsLookupPromise ??= import("node:dns").then((mod) => mod.lookup);
  return dnsLookupPromise;
}

/**
 * Whether a URL hostname is an IP literal.
 *
 * `URL.hostname` brackets IPv6 literals, while a bare IPv4 address is already
 * unambiguous. This replaces `node:net`'s `isIP()` in the fetch preflight so
 * the module has no static Node builtin import; the full address-range check
 * still happens in {@link isBlockedAddress}.
 */
function isIPAddress(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** One instance, shared: it holds no per-request state. */
const PINNED_LOOKUP = createPinnedLookup();

/**
 * A `lookup` for node:http and node:http2 that closes the DNS-rebinding gap.
 *
 * `isSafeURL` reads the hostname the caller wrote. The socket, however, is
 * dialled at whatever that hostname *resolves to*, and nothing between the two
 * points re-checked the answer — so a name that resolves to a public address on
 * the first lookup and to `127.0.0.1` on the second reached a private service.
 * That is DNS rebinding, and it needs an attacker-controlled resolver, which is
 * an ordinary capability for whoever controls the domain being requested.
 *
 * Resolving here and pinning the result closes it for the connection that
 * follows: every address the resolver returns is checked against the same
 * blocklist `isSafeURL` applies to a literal, and only a checked address is
 * handed back for the dial. A name that resolves solely to private space fails
 * instead of connecting.
 *
 * The alternative — checking the hostname again after connecting — is too late:
 * the request is already on the wire.
 *
 * `dns.lookup` (not `resolve`) is used deliberately: it honours `/etc/hosts`,
 * the resolver search list and `dns.setDefaultResultOrder`, so a host pinned in
 * the system file resolves the way it would have without this, and the address
 * handed back is the one the socket would have reached anyway.
 */
/**
 * Drop every resolved address that falls in a blocked range.
 *
 * Exported separately from `createPinnedLookup` so the decision can be tested
 * against addresses a resolver would have to be trusted to produce: a name
 * that answers with a public address and a private one is the rebinding case,
 * and it cannot be arranged offline through a real resolver.
 */
export function filterSafeAddresses<T extends { address: string; family?: number }>(
  addresses: readonly T[],
): T[] {
  return addresses.filter((a) => a.family !== 0 && !isBlockedAddress(a.address));
}

/**
 * The refusal a host whose every resolved address is blocked earns.
 *
 * Split out from {@link FetchTransport} so the message and code can be
 * asserted without arranging a resolver that answers with a blocked address.
 */
export function blockedHostError(
  url: string,
  addresses: ReadonlyArray<{ address: string }>,
): KinetexError {
  return new KinetexError(
    `URL "${url}" resolved only to blocked addresses (${
      addresses.map((a) => a.address).join(", ") || "none"
    })`,
    "EBLOCKEDHOST",
  );
}

export function createPinnedLookup(): import("node:net").LookupFunction {
  return (hostname, options, callback) => {
    // Node's declared callback takes an address even on failure, and it ignores
    // it — callers branch on `err` first. Node's own resolvers call back with
    // the error alone, so this matches them rather than inventing a bogus
    // address.
    const fail = (err: NodeJS.ErrnoException): void => {
      (callback as (e: NodeJS.ErrnoException | null) => void)(err);
    };

    // `all: true` so every candidate is inspected. Node sets it when
    // `autoSelectFamily` is on (the default since Node 20), in which case the
    // callback expects an array; when it is not, a single address is expected.
    const wantsAll = options.all === true;
    // Typed as `LookupAllOptions` so TypeScript selects the overload that
    // yields `LookupAddress[]`. Left as a plain object literal it picks the
    // single-address overload, and `.filter` below does not exist on a string.
    const resolved: import("node:dns").LookupAllOptions = { ...options, all: true };
    const runLookup = (lookup: typeof import("node:dns").lookup): void => {
      lookup(hostname, resolved, (err, addresses) => {
        if (err) {
          fail(err);
          return;
        }
        const safe = filterSafeAddresses(addresses ?? []);
        if (safe.length === 0) {
          // Report it as a name-resolution failure rather than a connection
          // error: nothing was dialled, and the distinction matters to a caller
          // deciding whether to retry or to fail over.
          const blocked = (addresses ?? []).map((a) => a.address).join(", ") || "no addresses";
          const e: NodeJS.ErrnoException = new Error(
            `Refusing to connect to ${hostname}: it resolves only to a blocked address (${blocked})`,
          );
          e.code = "EBLOCKEDHOST";
          fail(e);
          return;
        }
        if (wantsAll) {
          callback(null, safe);
          return;
        }
        const first = safe[0]!;
        callback(null, first.address, first.family);
      });
    };
    void getDnsLookup().then(runLookup).catch(fail);
  };
}

import { normalizeHeaders as _normalizeHeaders } from "./utils.ts";
import { limitAction } from "./response.ts";
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
/**
 * Translate a runtime-reported protocol string into the {@link HTTPVersion}
 * union, or return null when it says nothing this library can act on.
 *
 * Accepts the spellings Deno and Bun actually use ("2", "2.0", "1", "1.0",
 * "1.1") plus the union's own members, case- and whitespace-insensitively, so a
 * peer cannot widen the field to a string by adding a prefix.
 */
export function normalizeHTTPVersion(raw: string): HTTPVersion | null {
  const v = raw.trim().toLowerCase();
  if (v === "2" || v === "2.0" || v === "h2" || v === "http/2" || v === "http/2.0") return "HTTP/2";
  if (v === "1" || v === "1.0" || v === "http/1" || v === "http/1.0") return "HTTP/1.0";
  if (v === "1.1" || v === "http/1.1") return "HTTP/1.1";
  return null;
}

function detectHTTPVersion(response: Response, _headers: Record<string, string>): HTTPVersion {
  // Deno and Bun both expose `httpVersion` on the Response, and both spell it
  // their own way: Deno answers "2.0", Bun answers "1.1" and "2". The Deno arm
  // translated its values; the Bun arm returned whatever it was given, so a
  // plain HTTP/1.1 response on Bun reported the string "1.1" — a value outside
  // the `HTTPVersion` union, reaching every caller of `res.httpVersion` through
  // a `[[typed]]` lie. A consumer switching on "HTTP/1.1" silently fell through,
  // and on a runtime the library does not run in CI the type checker is the only
  // thing that would have said so. Both arms now go through one translation, and
  // anything unrecognised falls through to the default below rather than being
  // reported as a protocol.
  const denoResponse = response as unknown as { httpVersion?: string };
  const runtimeVersion = denoResponse.httpVersion;
  if (typeof runtimeVersion === "string") {
    const normalized = normalizeHTTPVersion(runtimeVersion);
    if (normalized) return normalized;
  }

  // `Alt-Svc` advertises what a server *can* speak; it does not describe the
  // protocol that carried this response. Node's fetch (undici) speaks HTTP/1.1,
  // so a plain HTTP/1.1 server advertising h2 was previously reported as
  // HTTP/2 — a false statement about the response, not a capability hint.
  // Report runtime evidence when it exists, otherwise the fetch transport's
  // actual protocol. Server capabilities belong in a separate field.
  return "HTTP/1.1";
}

/**
 * Check whether an error indicates an HTTP/2 connection failure
 * that should trigger a fallback to HTTP/1.1.
 */
function isHTTP2FallbackError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const codeOf = (candidate: Error): string =>
    ((candidate as NodeJS.ErrnoException).code ?? "").toString();

  const isNegotiationFailure = (candidate: Error): boolean => {
    const code = codeOf(candidate);
    // An HTTP/1.1-only TLS server rejects the h2 ALPN offer with this code.
    // Its message is "no application protocol" and contains neither "alpn"
    // nor "h2", so the old message-only predicate missed the exact failure it
    // was written for.
    if (code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL") return true;
    if (code.startsWith("ERR_HTTP2_")) return true;

    // Negotiation-specific phrases only. A generic "HTTP/2 …" message is the
    // library's own error — a request timeout or a redirect gate — and
    // replaying that over HTTP/1.1 would hide it. The previous predicate
    // matched any message containing "http/2", which made a timed-out h2
    // request re-run (and a refused redirect get followed) on the h1 path.
    const msg = candidate.message.toLowerCase();
    return msg.includes("alpn") || msg.includes("no application protocol");
  };

  if (isNegotiationFailure(err)) return true;
  // Stream errors are wrapped as `KinetexError("…", "ENETWORK", { cause })`;
  // the Node code lives on the cause.
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && isNegotiationFailure(cause);
}

/**
 * Whether a request body can be written a second time.
 *
 * The HTTP/2 → HTTP/1.1 fallback replays the request. A stream or Blob has
 * already been consumed (or locked) by the first attempt, so replaying it
 * would either throw or send an empty body; the caller gets the original
 * transport error instead.
 */
function isReplayableBody(body: import("./types.ts").BodyInit): boolean {
  if (body === null) return true;
  if (body instanceof ReadableStream) return false;
  return !(typeof Blob !== "undefined" && body instanceof Blob);
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
 * Handles ReadableStream, Uint8Array, ArrayBuffer, string, URLSearchParams and Blob bodies.
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
    // The raw Node transports bypass fetch, so bodies fetch would normally
    // serialize (URLSearchParams, Blob) must be encoded here. Skipping them
    // silently sent an empty body to the server.
    const { bytes } = await serializeRawBody(body);
    stream.end(bytes);
  }
}

/**
 * Write a request body to a Node.js http.ClientRequest, respecting backpressure.
 * Handles ReadableStream, Uint8Array, ArrayBuffer, string, URLSearchParams and Blob bodies.
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
    // The raw Node transports bypass fetch, so bodies fetch would normally
    // serialize (URLSearchParams, Blob) must be encoded here. Skipping them
    // silently sent an empty body to the server.
    const { bytes } = await serializeRawBody(body);
    req.end(bytes);
  }
}

/**
 * The result of encoding a body the raw Node transports have to serialize
 * themselves. `contentType` is set only when the encoding produced one the
 * caller must announce — a multipart body is unusable without its boundary,
 * and a boundary invented here cannot reach a header block that was already
 * written.
 */
interface EncodedBody {
  bytes: Uint8Array;
  contentType?: string;
}

/**
 * Serialize body types that `fetch` would normally encode for us, so the raw
 * Node HTTP/1.1 and HTTP/2 transports do not silently send an empty payload.
 *
 * @param body - Request body that is not a stream, byte array, or string
 * @returns The encoded bytes to write, plus a content type to announce when the
 *          encoding generated one (empty bytes for unsupported types)
 */
async function serializeRawBody(body: import("./types.ts").BodyInit): Promise<EncodedBody> {
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return { bytes: new TextEncoder().encode(body.toString()) };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()) };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const { bytes, boundary } = await encodeMultipart(body);
    return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
  }
  return { bytes: new Uint8Array(0) };
}

/**
 * Escape a multipart field name or filename for a `Content-Disposition`
 * parameter. RFC 7578 §5.1 percent-encodes CR, LF and a double quote; a bare
 * backslash is escaped too so a name cannot terminate the quoted string early.
 */
function escapeFieldName(name: string): string {
  return name.replace(
    /[\r\n"\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * Encode a `FormData` as `multipart/form-data` (RFC 7578).
 *
 * The function this lives in was written to stop the raw Node transports from
 * sending an *empty* body for the types fetch would have serialized, and it
 * covered `URLSearchParams` and `Blob`. `FormData` was missed, so on the
 * default transport on Node — `NodeHTTP2Transport`, which bypasses fetch
 * entirely — a form upload went out as a request with no body at all and no
 * `Content-Type`, and the server recorded an empty form. The response was an
 * ordinary 200, so nothing looked wrong.
 *
 * The boundary is generated per call and written into the body. The transports
 * that call this only ever see bytes, so the header is set by the client from
 * `options.headers`; a body encoded here without a matching header is
 * unparseable, which is why the boundary is returned alongside the bytes for a
 * caller that has to announce it. Passing one in makes the output
 * deterministic, which is what the test suite pins.
 */
export async function encodeMultipart(
  form: FormData,
  boundary?: string,
): Promise<{ bytes: Uint8Array; boundary: string }> {
  // 24 random bytes as hex: 192 bits is far past any collision concern, and hex
  // is all legal in a boundary.
  const bnd = boundary ?? `----kinetexFormBoundary${randomBytes(24)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(encoder.encode(text));
  };

  for (const [name, value] of form.entries()) {
    // A field name is application- and sometimes user-controlled, and CR/LF in
    // one would forge a part header. Such a name is refused rather than sent
    // or silently dropped.
    if (/[\r\n"]/.test(name)) {
      throw new KinetexError(
        `Cannot send a multipart field whose name contains CR, LF or a quote: ${JSON.stringify(name)}`,
        "EVALIDATION",
      );
    }
    push(`--${bnd}\r\n`);
    if (typeof value === "string") {
      push(`Content-Disposition: form-data; name="${escapeFieldName(name)}"\r\n\r\n`);
      push(value);
      push("\r\n");
      continue;
    }
    // A File/Blob part: RFC 7578 §4.2 wants its own type and filename.
    push(
      `Content-Disposition: form-data; name="${escapeFieldName(name)}"; ` +
        `filename="${escapeFieldName(value.name || "blob")}"\r\n` +
        `Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
    );
    chunks.push(new Uint8Array(await value.arrayBuffer()));
    push("\r\n");
  }
  push(`--${bnd}--\r\n`);
  return { bytes: concatUint8Arrays(chunks), boundary: bnd };
}

// ============================================================================
// §10  DECOMPRESSION
// ============================================================================

/**
 * Apply content-encoding decompression to a raw body stream.
 * Dynamically imports response.ts so that environments that don't use
 * decompression don't pay the code cost. The import is cached by the runtime.
 *
 * Supported encodings: gzip, deflate, br (brotli), zstd.
 * Unsupported encodings are passed through compressed; the caller must handle
 * them.
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
  const supportedEncodings = ["gzip", "deflate", "br", "zstd", "identity"];
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
