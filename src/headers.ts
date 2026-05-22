/**
 * Cross-runtime HTTP Headers implementation.
 *
 * Targets: Deno · Bun · Node.js · Cloudflare Workers · Vercel Edge ·
 *          AWS Lambda · Browser · any WinterCG-compatible runtime.
 *
 * Published to: npm + JSR
 *
 * Features:
 *  - Full WHATWG Fetch spec Headers implementation
 *  - RFC 7230 header field-name + field-value validation
 *  - RFC 7231 / 7235 typed accessors for every standard header
 *  - Content-Type   parsing + mutation (media-type, charset, boundary)
 *  - Content-Disposition parsing (filename, filename*, name)
 *  - Cache-Control  full directive map (request + response)
 *  - Authorization  scheme + credentials parsing
 *  - WWW-Authenticate / Proxy-Authenticate challenge parsing
 *  - Accept / Accept-Encoding / Accept-Language with q-factor sorting
 *  - Range / Content-Range parsing
 *  - Link header parsing (rel, type, hreflang etc.)
 *  - Forwarded / X-Forwarded-* normalization
 *  - Retry-After: date and delta-seconds
 *  - Cookie / Set-Cookie passthrough helpers
 *  - Security headers (CSP, HSTS, X-Frame-Options, Permissions-Policy…)
 *  - Immutable, mutable, and guard-aware variants
 *  - Merge, diff, subset, redact utilities
 *  - Serialization to/from plain objects, fetch Headers, IncomingMessage
 *  - No dependencies, no runtime globals required beyond Map/Set/RegExp
 */

// ============================================================================
// §1  CONSTANTS — WELL-KNOWN HEADER NAMES
// ============================================================================

/** Every standard + widely-used header name, lowercased. */
export const HeaderName = {
  // ── Entity / Representation ───────────────────────────────────────────────
  /** HTTP header name for Content-Type */
  ContentType: "content-type",
  /** HTTP header name for Content-Length */
  ContentLength: "content-length",
  /** HTTP header name for Content-Encoding */
  ContentEncoding: "content-encoding",
  /** HTTP header name for Content-Language */
  ContentLanguage: "content-language",
  /** HTTP header name for Content-Location */
  ContentLocation: "content-location",
  /** HTTP header name for Content-Disposition */
  ContentDisposition: "content-disposition",
  /** HTTP header name for Content-Range */
  ContentRange: "content-range",
  /** HTTP header name for Content-MD5 */
  ContentMD5: "content-md5",
  /** HTTP header name for Transfer-Encoding */
  TransferEncoding: "transfer-encoding",
  /** HTTP header name for Trailer */
  TrailingHeader: "trailer",

  // ── Caching ───────────────────────────────────────────────────────────────
  /** HTTP header name for Cache-Control */
  CacheControl: "cache-control",
  /** HTTP header name for Pragma */
  Pragma: "pragma",
  /** HTTP header name for Expires */
  Expires: "expires",
  /** HTTP header name for Age */
  Age: "age",
  /** HTTP header name for ETag */
  ETag: "etag",
  /** HTTP header name for Last-Modified */
  LastModified: "last-modified",
  /** HTTP header name for Vary */
  Vary: "vary",

  // ── Conditionals ──────────────────────────────────────────────────────────
  /** HTTP header name for If-Match */
  IfMatch: "if-match",
  /** HTTP header name for If-None-Match */
  IfNoneMatch: "if-none-match",
  /** HTTP header name for If-Modified-Since */
  IfModifiedSince: "if-modified-since",
  /** HTTP header name for If-Unmodified-Since */
  IfUnmodifiedSince: "if-unmodified-since",
  /** HTTP header name for If-Range */
  IfRange: "if-range",

  // ── Request context ───────────────────────────────────────────────────────
  /** HTTP header name for Host */
  Host: "host",
  /** HTTP header name for Origin */
  Origin: "origin",
  /** HTTP header name for Referer */
  Referer: "referer",
  /** HTTP header name for User-Agent */
  UserAgent: "user-agent",
  /** HTTP header name for From */
  From: "from",
  /** HTTP header name for TE */
  TE: "te",
  /** HTTP header name for Expect */
  Expect: "expect",
  /** HTTP header name for Max-Forwards */
  MaxForwards: "max-forwards",

  // ── Negotiation ───────────────────────────────────────────────────────────
  /** HTTP header name for Accept */
  Accept: "accept",
  /** HTTP header name for Accept-Encoding */
  AcceptEncoding: "accept-encoding",
  /** HTTP header name for Accept-Language */
  AcceptLanguage: "accept-language",
  /** HTTP header name for Accept-Charset */
  AcceptCharset: "accept-charset",
  /** HTTP header name for Accept-Ranges */
  AcceptRanges: "accept-ranges",
  /** HTTP header name for Accept-Patch */
  AcceptPatch: "accept-patch",

  // ── Authentication ────────────────────────────────────────────────────────
  /** HTTP header name for Authorization */
  Authorization: "authorization",
  /** HTTP header name for Proxy-Authorization */
  ProxyAuthorization: "proxy-authorization",
  /** HTTP header name for WWW-Authenticate */
  WWWAuthenticate: "www-authenticate",
  /** HTTP header name for Proxy-Authenticate */
  ProxyAuthenticate: "proxy-authenticate",
  /** HTTP header name for Authentication-Info */
  AuthenticationInfo: "authentication-info",

  // ── Range ─────────────────────────────────────────────────────────────────
  /** HTTP header name for Range */
  Range: "range",

  // ── Cookies ───────────────────────────────────────────────────────────────
  /** HTTP header name for Cookie */
  Cookie: "cookie",
  /** HTTP header name for Set-Cookie */
  SetCookie: "set-cookie",

  // ── Routing / Proxy ───────────────────────────────────────────────────────
  /** HTTP header name for Location */
  Location: "location",
  /** HTTP header name for Via */
  Via: "via",
  /** HTTP header name for Forwarded */
  Forwarded: "forwarded",
  /** HTTP header name for X-Forwarded-For */
  XForwardedFor: "x-forwarded-for",
  /** HTTP header name for X-Forwarded-Host */
  XForwardedHost: "x-forwarded-host",
  /** HTTP header name for X-Forwarded-Proto */
  XForwardedProto: "x-forwarded-proto",
  /** HTTP header name for X-Forwarded-Port */
  XForwardedPort: "x-forwarded-port",
  /** HTTP header name for X-Real-IP */
  XRealIP: "x-real-ip",

  // ── Connection ────────────────────────────────────────────────────────────
  /** HTTP header name for Connection */
  Connection: "connection",
  /** HTTP header name for Keep-Alive */
  KeepAlive: "keep-alive",
  /** HTTP header name for Upgrade */
  Upgrade: "upgrade",

  // ── CORS ──────────────────────────────────────────────────────────────────
  /** HTTP header name for Access-Control-Allow-Origin */
  AccessControlAllowOrigin: "access-control-allow-origin",
  /** HTTP header name for Access-Control-Allow-Methods */
  AccessControlAllowMethods: "access-control-allow-methods",
  /** HTTP header name for Access-Control-Allow-Headers */
  AccessControlAllowHeaders: "access-control-allow-headers",
  /** HTTP header name for Access-Control-Expose-Headers */
  AccessControlExposeHeaders: "access-control-expose-headers",
  /** HTTP header name for Access-Control-Max-Age */
  AccessControlMaxAge: "access-control-max-age",
  /** HTTP header name for Access-Control-Allow-Credentials */
  AccessControlAllowCredentials: "access-control-allow-credentials",
  /** HTTP header name for Access-Control-Request-Method */
  AccessControlRequestMethod: "access-control-request-method",
  /** HTTP header name for Access-Control-Request-Headers */
  AccessControlRequestHeaders: "access-control-request-headers",

  // ── Timing / Server ───────────────────────────────────────────────────────
  /** HTTP header name for Date */
  Date: "date",
  /** HTTP header name for Retry-After */
  RetryAfter: "retry-after",
  /** HTTP header name for Allow */
  Allow: "allow",
  /** HTTP header name for Server */
  Server: "server",
  /** HTTP header name for Server-Timing */
  ServerTiming: "server-timing",
  /** HTTP header name for Timing-Allow-Origin */
  TimingAllowOrigin: "timing-allow-origin",

  // ── WebSocket ─────────────────────────────────────────────────────────────
  /** HTTP header name for Sec-WebSocket-Key */
  SecWebSocketKey: "sec-websocket-key",
  /** HTTP header name for Sec-WebSocket-Accept */
  SecWebSocketAccept: "sec-websocket-accept",
  /** HTTP header name for Sec-WebSocket-Protocol */
  SecWebSocketProtocol: "sec-websocket-protocol",
  /** HTTP header name for Sec-WebSocket-Version */
  SecWebSocketVersion: "sec-websocket-version",
  /** HTTP header name for Sec-WebSocket-Extensions */
  SecWebSocketExtensions: "sec-websocket-extensions",

  // ── Fetch metadata ────────────────────────────────────────────────────────
  /** HTTP header name for Sec-Fetch-Site */
  SecFetchSite: "sec-fetch-site",
  /** HTTP header name for Sec-Fetch-Mode */
  SecFetchMode: "sec-fetch-mode",
  /** HTTP header name for Sec-Fetch-User */
  SecFetchUser: "sec-fetch-user",
  /** HTTP header name for Sec-Fetch-Dest */
  SecFetchDest: "sec-fetch-dest",

  // ── Security ──────────────────────────────────────────────────────────────
  /** HTTP header name for Strict-Transport-Security */
  StrictTransportSecurity: "strict-transport-security",
  /** HTTP header name for Content-Security-Policy */
  ContentSecurityPolicy: "content-security-policy",
  /** HTTP header name for Content-Security-Policy-Report-Only */
  ContentSecurityPolicyRO: "content-security-policy-report-only",
  /** HTTP header name for X-Content-Type-Options */
  XContentTypeOptions: "x-content-type-options",
  /** HTTP header name for X-Frame-Options */
  XFrameOptions: "x-frame-options",
  /** HTTP header name for X-XSS-Protection */
  XXSSProtection: "x-xss-protection",
  /** HTTP header name for Referrer-Policy */
  ReferrerPolicy: "referrer-policy",
  /** HTTP header name for Permissions-Policy */
  PermissionsPolicy: "permissions-policy",
  /** HTTP header name for Cross-Origin-Opener-Policy */
  CrossOriginOpenerPolicy: "cross-origin-opener-policy",
  /** HTTP header name for Cross-Origin-Embedder-Policy */
  CrossOriginEmbedderPolicy: "cross-origin-embedder-policy",
  /** HTTP header name for Cross-Origin-Resource-Policy */
  CrossOriginResourcePolicy: "cross-origin-resource-policy",
  /** HTTP header name for NEL */
  NEL: "nel",
  /** HTTP header name for Report-To */
  ReportTo: "report-to",
  /** HTTP header name for Reporting-Endpoints */
  ReportingEndpoints: "reporting-endpoints",

  // ── Misc ──────────────────────────────────────────────────────────────────
  /** HTTP header name for Link */
  Link: "link",
  /** HTTP header name for Alt-Svc */
  AltSvc: "alt-svc",
  /** HTTP header name for Alt-Used */
  AltUsed: "alt-used",
  /** HTTP header name for Priority */
  Priority: "priority",
  /** HTTP header name for Early-Data */
  EarlyData: "early-data",
  /** HTTP header name for Push-Policy */
  PushPolicy: "push-policy",
  /** HTTP header name for Accept-Push-Policy */
  AcceptPushPolicy: "accept-push-policy",
  /** HTTP header name for X-Request-ID */
  XRequestID: "x-request-id",
  /** HTTP header name for X-Correlation-ID */
  XCorrelationID: "x-correlation-id",
  /** HTTP header name for X-RateLimit-Limit */
  XRateLimitLimit: "x-ratelimit-limit",
  /** HTTP header name for X-RateLimit-Remaining */
  XRateLimitRemaining: "x-ratelimit-remaining",
  /** HTTP header name for X-RateLimit-Reset */
  XRateLimitReset: "x-ratelimit-reset",
  /** HTTP header name for X-Powered-By */
  XPoweredBy: "x-powered-by",
  /** HTTP header name for X-Requested-With */
  XRequestedWith: "x-requested-with",
} as const;

/** Union of all well-known header name strings defined in {@link HeaderName}. */
export type KnownHeaderName = (typeof HeaderName)[keyof typeof HeaderName];

// ============================================================================
// §1b  ATOB/BTOA POLYFILL — for environments without global atob/btoa
// ============================================================================

/** Safe atob that falls back to manual base64 decode in environments without globals */
function decodeBase64(str: string): string {
  if (typeof atob !== "undefined") {
    return atob(str);
  }
  // Fallback: simple base64 decoder (handles standard base64)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  str = str.replace(/=+$/, "");
  for (let i = 0; i < str.length; i += 4) {
    const a = chars.indexOf(str[i]!);
    const b = i + 1 < str.length ? chars.indexOf(str[i + 1]!) : 0;
    const c = i + 2 < str.length ? chars.indexOf(str[i + 2]!) : 0;
    const d = i + 3 < str.length ? chars.indexOf(str[i + 3]!) : 0;
    output += String.fromCharCode((a << 2) | (b >> 4));
    if (i + 2 < str.length) output += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (i + 3 < str.length) output += String.fromCharCode(((c & 3) << 6) | d);
  }
  return output;
}

/** Safe btoa that falls back to manual base64 encode in environments without globals */
function encodeBase64(str: string): string {
  if (typeof btoa !== "undefined") {
    return btoa(str);
  }
  // Fallback: simple base64 encoder
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    output += chars[a >> 2];
    output += chars[((a & 3) << 4) | (b >> 4)];
    output += i + 1 < str.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    output += i + 2 < str.length ? chars[c & 63] : "=";
  }
  return output;
}

// ============================================================================
// §2  RFC 7230 VALIDATION
// ============================================================================

// Delegate to utils.ts — single source of truth for header validation
import {
  isValidHeaderName as _isValidHeaderName,
  isValidHeaderValue as _isValidHeaderValue,
} from "./utils.ts";
const isValidHeaderName = _isValidHeaderName;
const isValidHeaderValue = _isValidHeaderValue;
export { isValidHeaderName, isValidHeaderValue };

// Headers that must not be combined with commas (WHATWG Fetch spec)
const NO_COMBINE_HEADERS = new Set<string>([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
]);

// Headers that are forbidden in WHATWG Fetch request guard
const FORBIDDEN_REQUEST_HEADERS = new Set<string>([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

// Headers forbidden in response guard
const FORBIDDEN_RESPONSE_HEADERS = new Set<string>(["set-cookie", "set-cookie2"]);

// ============================================================================
// §3  GUARD TYPES (WHATWG Fetch spec §2.1.5)
// ============================================================================

/**
 * WHATWG Fetch spec guard mode restricting mutation on the headers object.
 * - `"none"` — no restrictions
 * - `"request"` — forbids forbidden request headers (Cookie, Host, etc.)
 * - `"request-no-cors"` — more restrictive for no-cors requests
 * - `"response"` — forbids Set-Cookie/Set-Cookie2
 * - `"immutable"` — all mutations throw TypeError
 */
export type HeadersGuard = "immutable" | "request" | "request-no-cors" | "response" | "none";

// ============================================================================
// §4  CORE HEADERS CLASS
// ============================================================================

/** Internal entry: list of values for a single header name. */
type HeaderEntry = { name: string; values: string[] };

/**
 * Cross-runtime HTTP headers implementation compatible with the WHATWG Fetch
 * spec Headers interface. Supports guard-based mutation control, RFC 7230
 * validation, and rich typed accessors.
 *
 * Differences from WHATWG Headers:
 * - Supports {@link clone}, {@link freeze}, {@link merge}, {@link pick},
 *   {@link omit}, {@link redact}, {@link diff}
 * - Preserves original header-name casing via {@link toHTTP1String}
 * - Multi-value headers (Set-Cookie) are always kept separate, never joined
 * - Guards are enforced synchronously
 */
export class HttpHeaders {
  /** Ordered map: lowercased name → \{ original-case name, values[] \} */
  private readonly map: Map<string, HeaderEntry> = new Map();
  private readonly guard: HeadersGuard;

  /**
   * @param init  - Optional initial headers (WHATWG Headers, HttpHeaders,
   *                plain object, or `[name, value][]` array)
   * @param guard - Guard mode (default: `"none"`)
   */
  constructor(
    init?: HeadersInit | HttpHeaders | Record<string, string | string[]> | null,
    guard: HeadersGuard = "none",
  ) {
    this.guard = guard;
    if (init == null) return;
    this.#initFrom(init);
  }

  #initFrom(init: HeadersInit | HttpHeaders | Record<string, string | string[]>): void {
    if (init instanceof HttpHeaders) {
      for (const [key, entry] of init.map) {
        this.map.set(key, { name: entry.name, values: [...entry.values] });
      }
      return;
    }

    // WHATWG Headers
    if (typeof Headers !== "undefined" && init instanceof Headers) {
      init.forEach((value, name) => this.append(name, value));
      return;
    }

    // Array of [name, value] pairs
    if (Array.isArray(init)) {
      for (const pair of init) {
        if (!Array.isArray(pair) || pair.length < 2) {
          throw new TypeError("Headers init sequence must contain [name, value] pairs");
        }
        this.append(String(pair[0]), String(pair[1]));
      }
      return;
    }

    // Plain object
    if (typeof init === "object") {
      for (const [key, val] of Object.entries(init)) {
        if (Array.isArray(val)) {
          for (const v of val) this.append(key, v);
        } else {
          this.append(key, String(val));
        }
      }
    }
  }

  // ── WHATWG Headers interface ──────────────────────────────────────────────

  /**
   * Append a value to an existing header (or create it).
   * Unlike {@link set}, this does NOT overwrite existing values.
   *
   * @param name  - Header name (case-insensitive)
   * @param value - Header value (leading/trailing OWS stripped)
   * @throws TypeError If the guard forbids mutation or name/value is invalid
   */
  append(name: string, value: string): void {
    this.#checkGuardAppend(name);
    const key = this.#validateAndNormalizeName(name);
    const val = this.#normalizeValue(value);
    const entry = this.map.get(key);
    if (entry) {
      entry.values.push(val);
    } else {
      this.map.set(key, { name, values: [val] });
    }
  }

  /**
   * Delete a header by name.
   *
   * @param name - Header name (case-insensitive)
   * @throws TypeError If the guard forbids deletion
   */
  delete(name: string): void {
    this.#checkGuardDelete(name);
    this.map.delete(name.toLowerCase());
  }

  /**
   * Return the combined value of a header.
   * Multiple values are joined with ", " except for Set-Cookie /
   * WWW-Authenticate / Proxy-Authenticate, which return only the first value.
   *
   * @param name - Header name (case-insensitive)
   * @returns The combined header value, or `null` if absent
   */
  get(name: string): string | null {
    const entry = this.map.get(name.toLowerCase());
    if (!entry) return null;
    if (NO_COMBINE_HEADERS.has(name.toLowerCase())) return entry.values[0] ?? null;
    return entry.values.join(", ");
  }

  /**
   * Return all values for a header as an array (useful for Set-Cookie).
   *
   * @param name - Header name (case-insensitive)
   * @returns Array of values (empty if absent)
   */
  getAll(name: string): string[] {
    return [...(this.map.get(name.toLowerCase())?.values ?? [])];
  }

  /**
   * Check if a header exists.
   *
   * @param name - Header name (case-insensitive)
   * @returns `true` if the header is set
   */
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  /**
   * Set a header, overwriting any existing values for that name.
   *
   * @param name  - Header name (case-insensitive)
   * @param value - Header value (leading/trailing OWS stripped)
   * @throws TypeError If the guard forbids mutation or name/value is invalid
   */
  set(name: string, value: string): void {
    this.#checkGuardSet(name);
    const key = this.#validateAndNormalizeName(name);
    const val = this.#normalizeValue(value);
    this.map.set(key, { name, values: [val] });
  }

  /**
   * Execute a callback for each header entry.
   * Multi-value headers are joined with ", " for the callback, except for
   * Set-Cookie (each value is called separately).
   *
   * @param callback - Called once per combined value with `(value, name, headers)`
   * @param thisArg  - Value for `this` inside the callback
   */
  forEach(
    callback: (value: string, name: string, headers: HttpHeaders) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, entry] of this.map) {
      const combined = NO_COMBINE_HEADERS.has(key) ? entry.values : [entry.values.join(", ")];
      for (const v of combined) callback.call(thisArg, v, key, this);
    }
  }

  /**
   * Iterator over all header names (lowercased).
   */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  /**
   * Iterator over all header values.
   * Multi-value headers are joined with ", " except Set-Cookie.
   */
  *values(): IterableIterator<string> {
    for (const [key, entry] of this.map) {
      if (NO_COMBINE_HEADERS.has(key)) {
        for (const v of entry.values) yield v;
      } else {
        yield entry.values.join(", ");
      }
    }
  }

  /**
   * Iterator over `[name, value]` tuples (WHATWG Headers-compatible).
   */
  *entries(): IterableIterator<[string, string]> {
    for (const [key, entry] of this.map) {
      if (NO_COMBINE_HEADERS.has(key)) {
        for (const v of entry.values) yield [key, v];
      } else {
        yield [key, entry.values.join(", ")];
      }
    }
  }

  /** @see {@link entries} */
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  /** @returns The string tag "HttpHeaders" */
  get [Symbol.toStringTag](): string {
    return "HttpHeaders";
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /** Convert to a plain object. Multi-value headers become arrays. */
  toObject(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, entry] of this.map) {
      const values = entry.values;
      out[key] = values.length === 1 ? (values[0] as string) : [...values];
    }
    return out;
  }

  /** Convert to a flat object. Multi-value headers are joined with ", ". */
  toFlatObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of this.map) {
      out[key] = NO_COMBINE_HEADERS.has(key) ? (entry.values[0] ?? "") : entry.values.join(", ");
    }
    return out;
  }

  /**
   * Convert to WHATWG Headers (when available in the runtime).
   *
   * @throws {Error} If WHATWG Headers is not available in this runtime
   */
  toWebHeaders(): Headers {
    if (typeof Headers === "undefined") {
      throw new Error("WHATWG Headers is not available in this runtime");
    }
    const h = new Headers();
    for (const [key, entry] of this.map) {
      for (const v of entry.values) h.append(key, v);
    }
    return h;
  }

  /** Serialize as HTTP/1.1 header block (CRLF-delimited). */
  toHTTP1String(): string {
    const lines: string[] = [];
    for (const [, entry] of this.map) {
      for (const v of entry.values) {
        lines.push(`${entry.name}: ${v}`);
      }
    }
    return lines.join("\r\n");
  }

  /** Clone this headers object. */
  clone(guard?: HeadersGuard): HttpHeaders {
    return new HttpHeaders(this, guard ?? this.guard);
  }

  /** Return a new immutable copy. */
  freeze(): HttpHeaders {
    return this.clone("immutable");
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Merge another headers source into this one.
   * Existing values are overwritten unless `append` is true.
   */
  merge(
    other: HttpHeaders | Record<string, string | string[]>,
    options: { append?: boolean } = {},
  ): this {
    const src = other instanceof HttpHeaders ? other : new HttpHeaders(other);
    for (const [key, entry] of src.map) {
      if (options.append) {
        for (const v of entry.values) this.append(key, v);
      } else {
        this.map.set(key, { name: entry.name, values: [...entry.values] });
      }
    }
    return this;
  }

  /**
   * Return a new HttpHeaders containing only the listed header names.
   */
  pick(...names: string[]): HttpHeaders {
    const out = new HttpHeaders();
    for (const name of names) {
      const key = name.toLowerCase();
      const entry = this.map.get(key);
      if (entry) out.map.set(key, { name: entry.name, values: [...entry.values] });
    }
    return out;
  }

  /**
   * Return a new HttpHeaders without the listed header names.
   */
  omit(...names: string[]): HttpHeaders {
    const out = this.clone();
    for (const name of names) out.map.delete(name.toLowerCase());
    return out;
  }

  /**
   * Redact sensitive header values (replace with "**REDACTED**").
   * Useful for logging.
   */
  redact(...names: string[]): HttpHeaders {
    const out = this.clone();
    for (const name of names) {
      const key = name.toLowerCase();
      const entry = out.map.get(key);
      if (entry) {
        out.map.set(key, { name: entry.name, values: entry.values.map(() => "**REDACTED**") });
      }
    }
    return out;
  }

  /**
   * Returns headers present in `other` that differ from this instance
   * (by combined value). Useful for diffing request/response headers.
   */
  diff(other: HttpHeaders): HttpHeaders {
    const out = new HttpHeaders();
    for (const [key, entry] of other.map) {
      const mine = this.get(key);
      const theirs = NO_COMBINE_HEADERS.has(key)
        ? (entry.values[0] ?? "")
        : entry.values.join(", ");
      if (mine !== theirs) {
        out.map.set(key, { name: entry.name, values: [...entry.values] });
      }
    }
    return out;
  }

  /** Number of distinct header names. */
  get size(): number {
    return this.map.size;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  #validateAndNormalizeName(name: string): string {
    if (!isValidHeaderName(name)) {
      throw new TypeError(`Invalid header name: "${name}"`);
    }
    return name.toLowerCase();
  }

  #normalizeValue(value: string): string {
    // Strip leading + trailing whitespace (OWS) per RFC 7230 §3.2.6
    const v = value.trim();
    if (!isValidHeaderValue(v)) {
      throw new TypeError(`Invalid header value for: "${v}"`);
    }
    return v;
  }

  #checkGuardAppend(name: string): void {
    if (this.guard === "immutable") throw new TypeError("Headers are immutable");
    if (this.guard === "request" && FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`Header "${name}" is forbidden for request guard`);
    }
    if (this.guard === "response" && FORBIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`Header "${name}" is forbidden for response guard`);
    }
  }

  #checkGuardSet(name: string): void {
    this.#checkGuardAppend(name);
  }

  #checkGuardDelete(name: string): void {
    if (this.guard === "immutable") throw new TypeError("Headers are immutable");
    if (this.guard === "request" && FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`Header "${name}" is forbidden for request guard`);
    }
  }
}

// ============================================================================
// §5  TYPED PARSERS — shared primitives
// ============================================================================

/**
 * Parse a parameter list: "; key=value; key2=value2" → Map
 *
 * Parses semicolon-delimited key=value pairs, handling optional quotes.
 * This is a general-purpose parser useful for many HTTP headers.
 *
 * @param paramStr - The semicolon-delimited parameter string
 * @returns Map of parameter names (lowercased) to their values
 *
 * @example
 * ```ts
 * parseParams("; charset=utf-8; boundary=something")
 * // Map(2) { "charset" => "utf-8", "boundary" => "something" }
 * ```
 */
export function parseParams(paramStr: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of paramStr.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq === -1) {
      map.set(t.toLowerCase(), "");
    } else {
      const k = t.slice(0, eq).trim().toLowerCase();
      let v = t.slice(eq + 1).trim();
      // Strip optional surrounding quotes
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      map.set(k, v);
    }
  }
  return map;
}

/**
 * A single entry from a quality-value (q-factor) header like Accept,
 * Accept-Encoding, or Accept-Language.
 */
export interface QualityValue {
  /** The media-type / encoding / language tag */
  value: string;
  /** Quality factor (0–1), default 1.0 */
  quality: number;
  /** Additional parameters beyond `q` */
  params: Map<string, string>;
}

function parseQualityList(header: string): QualityValue[] {
  return header
    .split(",")
    .map((part) => {
      const segments = part.trim().split(";");
      const value = (segments[0] ?? "").trim();
      let quality = 1.0;
      const params = new Map<string, string>();

      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]!.trim();
        const eq = seg.indexOf("=");
        if (eq === -1) continue;
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if (k === "q") quality = parseFloat(v) || 0;
        else params.set(k, v);
      }

      return { value, quality, params };
    })
    .filter((e) => e.value !== "")
    .sort((a, b) => b.quality - a.quality);
}

/** RFC 5987 encoded value (filename*=UTF-8''foo%20bar) */
function decodeRFC5987(value: string): string | null {
  const m = value.match(/^([A-Za-z0-9_-]+)'([A-Za-z0-9_-]*)'(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[3]!);
  } catch {
    return null;
  }
}

// ============================================================================
// §6  CONTENT-TYPE
// ============================================================================

/** Parsed Content-Type header value (RFC 7231 §3.1.1.5). */
export interface ContentTypeValue {
  /** Media type without parameters, e.g. "text/html" */
  mediaType: string;
  /** Top-level type, e.g. "text" */
  type: string;
  /** Subtype, e.g. "html" */
  subtype: string;
  /** Charset parameter, if present */
  charset: string | null;
  /** Boundary parameter (multipart only), if present */
  boundary: string | null;
  /** All parameters (charset, boundary, and any custom) */
  params: Map<string, string>;
}

/**
 * Parse a Content-Type header into structured representation (RFC 7231 §3.1.1.5).
 * Extracts media type, type, subtype, charset, boundary, and all parameters.
 *
 * @param value - Raw `Content-Type` header value
 * @returns Parsed content-type, or `null` if unparseable
 */
export function parseContentType(value: string): ContentTypeValue | null {
  if (!value) return null;
  const semi = value.indexOf(";");
  const mtRaw = semi === -1 ? value.trim() : value.slice(0, semi).trim();
  const slash = mtRaw.indexOf("/");
  if (slash === -1) return null;

  const type = mtRaw.slice(0, slash).toLowerCase();
  const subtype = mtRaw.slice(slash + 1).toLowerCase();

  if (!type || !subtype) return null;

  const validToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  if (!validToken.test(type) || !validToken.test(subtype)) return null;

  const params = semi === -1 ? new Map<string, string>() : parseParams(value.slice(semi));

  return {
    mediaType: `${type}/${subtype}`,
    type,
    subtype,
    charset: params.get("charset") ?? null,
    boundary: params.get("boundary") ?? null,
    params,
  };
}

/**
 * Format a Content-Type value back into a header string.
 *
 * @param ct - Content-type value (must include `mediaType`; `charset`,
 *   `boundary`, and `params` are optional)
 * @returns Formatted `Content-Type` header value
 */
export function formatContentType(ct: Partial<ContentTypeValue> & { mediaType: string }): string {
  let out = ct.mediaType;
  if (ct.charset) out += `; charset=${ct.charset}`;
  if (ct.boundary) out += `; boundary=${ct.boundary}`;
  if (ct.params && ct.params instanceof Map) {
    ct.params.forEach((v, k) => {
      if (k === "charset" || k === "boundary") return;
      out += `; ${k}=${v.includes(" ") ? `"${v}"` : v}`;
    });
  } else if (ct.params && typeof ct.params === "object") {
    for (const [k, v] of Object.entries(ct.params)) {
      if (k === "charset" || k === "boundary") continue;
      out += `; ${k}=${(v as string).includes(" ") ? `"${v}"` : v}`;
    }
  }
  return out;
}

// ============================================================================
// §7  CONTENT-DISPOSITION
// ============================================================================

/** Parsed Content-Disposition header value (RFC 6266). */
export interface ContentDispositionValue {
  /** Disposition type, e.g. "attachment" | "inline" | "form-data" */
  type: string;
  /** Decoded filename (prefers RFC 5987 `filename*` over `filename`) */
  filename: string | null;
  /** Form-data field name (from `name` parameter) */
  name: string | null;
  /** All parameters */
  params: Map<string, string>;
}

/**
 * Parse a Content-Disposition header (RFC 6266).
 *
 * @param value - Raw `Content-Disposition` value
 * @returns Parsed disposition, or `null` for empty input
 */
export function parseContentDisposition(value: string): ContentDispositionValue | null {
  if (!value) return null;
  const semi = value.indexOf(";");
  const type = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  const params = semi === -1 ? new Map<string, string>() : parseParams(value.slice(semi));

  // RFC 5987 filename* takes priority
  let filename: string | null = null;
  const filenameStar = params.get("filename*");
  if (filenameStar) {
    filename = decodeRFC5987(filenameStar);
  }
  if (filename === null) {
    filename = params.get("filename") ?? null;
  }

  const name = params.get("name") ?? null;

  return { type, filename, name, params };
}

/**
 * Format a Content-Disposition value back into a header string.
 * Also emits RFC 5987 encoded `filename*` when the filename contains
 * characters that require percent-encoding.
 *
 * @param cd - Parsed disposition value
 * @returns Formatted `Content-Disposition` header value
 */
export function formatContentDisposition(cd: ContentDispositionValue): string {
  let out = cd.type;
  if (cd.name) out += `; name="${cd.name}"`;
  if (cd.filename) {
    out += `; filename="${cd.filename}"`;
    // Also emit RFC 5987 encoded form
    const encoded = encodeURIComponent(cd.filename);
    if (encoded !== cd.filename) {
      out += `; filename*=UTF-8''${encoded}`;
    }
  }
  return out;
}

// ============================================================================
// §8  CACHE-CONTROL
// ============================================================================

/** Parsed Cache-Control header directives (RFC 7234 / RFC 8246). */
export interface CacheControlDirectives {
  /** `no-cache` — must revalidate with origin server */
  noCache: boolean;
  /** `no-store` — must not cache at all */
  noStore: boolean;
  /** `no-transform` — proxies must not transform the response */
  noTransform: boolean;
  /** `only-if-cached` — request-only: use only cached copy */
  onlyIfCached: boolean;
  /** `max-age=N` — max age in seconds */
  maxAge: number | null;
  /** `max-stale=N` — request-only: accept stale response up to N seconds */
  maxStale: number | null;
  /** `min-fresh=N` — request-only: response must be fresh for N more seconds */
  minFresh: number | null;
  /** `stale-if-error=N` — serve stale on error for up to N seconds */
  staleIfError: number | null;
  /** `public` — may be cached by shared caches */
  public: boolean;
  /** `private` — may only be cached by browser; `string[]` = field names */
  private: boolean | string[];
  /** `must-revalidate` — origin server revalidation required on stale */
  mustRevalidate: boolean;
  /** `proxy-revalidate` — shared caches must revalidate */
  proxyRevalidate: boolean;
  /** `s-maxage=N` — shared cache max age in seconds (overrides max-age) */
  sMaxAge: number | null;
  /** `immutable` (RFC 8246) — never needs revalidation while fresh */
  immutable: boolean;
  /** `must-understand` — cache must understand the status code to store */
  mustUnderstand: boolean;
  /** `stale-while-revalidate=N` — serve stale while revalidating up to N s */
  staleWhileRevalidate: number | null;
  /** Unknown/unrecognized directives, lowercased */
  unknown: Map<string, string | true>;
}

/**
 * Parse a Cache-Control header into structured directives (RFC 7234).
 *
 * @param value - Raw `Cache-Control` header value
 * @returns Structured directives object with boolean flags and numeric values
 */
export function parseCacheControl(value: string): CacheControlDirectives {
  const d: CacheControlDirectives = {
    noCache: false,
    noStore: false,
    noTransform: false,
    onlyIfCached: false,
    maxAge: null,
    maxStale: null,
    minFresh: null,
    staleIfError: null,
    public: false,
    private: false,
    mustRevalidate: false,
    proxyRevalidate: false,
    sMaxAge: null,
    immutable: false,
    mustUnderstand: false,
    staleWhileRevalidate: null,
    unknown: new Map(),
  };

  for (const part of value.split(",")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    const k = (eq === -1 ? t : t.slice(0, eq)).trim().toLowerCase();
    const v =
      eq === -1
        ? null
        : t
            .slice(eq + 1)
            .trim()
            .replace(/^"|"$/g, "");

    const numVal = v !== null ? parseInt(v, 10) : null;

    switch (k) {
      case "no-cache":
        d.noCache = true;
        break;
      case "no-store":
        d.noStore = true;
        break;
      case "no-transform":
        d.noTransform = true;
        break;
      case "only-if-cached":
        d.onlyIfCached = true;
        break;
      case "public":
        d.public = true;
        break;
      case "must-revalidate":
        d.mustRevalidate = true;
        break;
      case "proxy-revalidate":
        d.proxyRevalidate = true;
        break;
      case "immutable":
        d.immutable = true;
        break;
      case "must-understand":
        d.mustUnderstand = true;
        break;
      case "max-age":
        d.maxAge = numVal;
        break;
      case "max-stale":
        d.maxStale = numVal ?? Infinity;
        break;
      case "min-fresh":
        d.minFresh = numVal;
        break;
      case "s-maxage":
        d.sMaxAge = numVal;
        break;
      case "stale-if-error":
        d.staleIfError = numVal;
        break;
      case "stale-while-revalidate":
        d.staleWhileRevalidate = numVal;
        break;
      case "private":
        d.private = v ? v.split(",").map((s) => s.trim()) : true;
        break;
      default:
        d.unknown.set(k, v ?? true);
    }
  }

  return d;
}

/**
 * Serialize cache-control directives back into a header string.
 *
 * @param d - Partial cache-control directives (only set flags are included)
 * @returns Formatted `Cache-Control` header value
 */
export function formatCacheControl(d: Partial<CacheControlDirectives>): string {
  const parts: string[] = [];
  if (d.noCache) parts.push("no-cache");
  if (d.noStore) parts.push("no-store");
  if (d.noTransform) parts.push("no-transform");
  if (d.onlyIfCached) parts.push("only-if-cached");
  if (d.public) parts.push("public");
  if (d.mustRevalidate) parts.push("must-revalidate");
  if (d.proxyRevalidate) parts.push("proxy-revalidate");
  if (d.immutable) parts.push("immutable");
  if (d.mustUnderstand) parts.push("must-understand");
  if (d.maxAge != null) parts.push(`max-age=${d.maxAge}`);
  if (d.maxStale != null)
    parts.push(d.maxStale === Infinity ? "max-stale" : `max-stale=${d.maxStale}`);
  if (d.minFresh != null) parts.push(`min-fresh=${d.minFresh}`);
  if (d.sMaxAge != null) parts.push(`s-maxage=${d.sMaxAge}`);
  if (d.staleIfError != null) parts.push(`stale-if-error=${d.staleIfError}`);
  if (d.staleWhileRevalidate != null)
    parts.push(`stale-while-revalidate=${d.staleWhileRevalidate}`);
  if (d.private) {
    // RFC 7234 §5.2.2.2: field-names in private directive are NOT quoted
    parts.push(Array.isArray(d.private) ? `private=${d.private.join(", ")}` : "private");
  }
  if (d.unknown) {
    for (const [k, v] of d.unknown) {
      parts.push(v === true ? k : `${k}=${v}`);
    }
  }
  return parts.join(", ");
}

// ============================================================================
// §9  AUTHORIZATION / WWW-AUTHENTICATE
// ============================================================================

/** Parsed Authorization / Proxy-Authorization header value. */
export interface AuthCredentials {
  /** Auth scheme lowercased (e.g. "basic", "bearer", "digest") */
  scheme: string;
  /** Token for Bearer/Basic schemes, or `null` */
  token: string | null;
  /** Key-value parameters for Digest / custom schemes */
  params: Map<string, string>;
  /** Decoded Basic auth credentials, or `null` for non-Basic schemes */
  basic: { username: string; password: string } | null;
}

/**
 * Parse an Authorization or Proxy-Authorization header (RFC 7235).
 * Supports Basic (with base64 decode), Bearer, and challenge-response
 * schemes (Digest, etc.).
 *
 * @param value - Raw `Authorization` header value
 * @returns Parsed credentials, or `null` for empty input
 */
export function parseAuthorization(value: string): AuthCredentials | null {
  if (!value) return null;
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx === -1)
    return { scheme: value.toLowerCase(), token: null, params: new Map(), basic: null };

  const scheme = value.slice(0, spaceIdx).toLowerCase();
  const rest = value.slice(spaceIdx + 1).trim();

  const params = new Map<string, string>();
  let token: string | null = null;
  let basic: { username: string; password: string } | null = null;

  if (scheme === "basic") {
    token = rest;
    try {
      const decoded = decodeBase64(rest);
      const colon = decoded.indexOf(":");
      if (colon !== -1) {
        basic = {
          username: decoded.slice(0, colon),
          password: decoded.slice(colon + 1),
        };
      }
    } catch {
      /* invalid base64 */
    }
  } else if (scheme === "bearer" || scheme === "token") {
    token = rest;
  } else {
    // Digest and other schemes: parse param list
    if (rest.includes("=")) {
      for (const part of rest.split(",")) {
        const t = part.trim();
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim().toLowerCase();
        let v = t.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        params.set(k, v);
      }
    } else {
      token = rest;
    }
  }

  return { scheme, token, params, basic };
}

/** Parsed WWW-Authenticate / Proxy-Authenticate challenge entry. */
export interface AuthChallenge {
  /** Auth scheme lowercased (e.g. "basic", "digest") */
  scheme: string;
  /** Auth realm, or `null` if not present */
  realm: string | null;
  /** Additional challenge parameters (nonce, algorithm, qop, etc.) */
  params: Map<string, string>;
}

/**
 * Parse one or more WWW-Authenticate challenge headers (RFC 7235).
 * Handles comma-separated challenges with quoted-string awareness.
 *
 * @param value - Raw `WWW-Authenticate` header value
 * @returns Array of parsed challenges (one per scheme)
 */
export function parseWWWAuthenticate(value: string): AuthChallenge[] {
  // Multiple challenges may appear, comma-separated, but commas also appear
  // inside quoted param values - use proper state machine to handle quoted strings
  const challenges: AuthChallenge[] = [];

  // State machine to split on commas only outside quoted strings
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"' && (i === 0 || value[i - 1] !== "\\")) {
      inQuotes = !inQuotes;
    }
    if (ch === "," && !inQuotes) {
      segments.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());

  for (const part of segments) {
    if (!part) continue;
    const spaceIdx = part.indexOf(" ");
    const scheme = (spaceIdx === -1 ? part : part.slice(0, spaceIdx)).toLowerCase();
    const paramStr = spaceIdx === -1 ? "" : part.slice(spaceIdx + 1);
    const params = parseParams(paramStr);

    challenges.push({ scheme, realm: params.get("realm") ?? null, params });
  }

  return challenges;
}

/**
 * Format a Bearer token into an Authorization header value.
 *
 * @param token - OAuth / JWT token
 * @returns `"Bearer <token>"`
 */
export function formatBearer(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Format Basic auth credentials into an Authorization header value.
 *
 * @param username - Auth username
 * @param password - Auth password
 * @returns `"Basic <base64>"`
 */
export function formatBasic(username: string, password: string): string {
  return `Basic ${encodeBase64(`${username}:${password}`)}`;
}

// ============================================================================
// §10  ACCEPT / ACCEPT-ENCODING / ACCEPT-LANGUAGE
// ============================================================================

/**
 * Parse an Accept header value into sorted quality values.
 *
 * @param value - Raw `Accept` value (e.g. `"text/html, application/json;q=0.9"`)
 * @returns Quality list sorted descending by q-factor
 */
export function parseAccept(value: string): QualityValue[] {
  return parseQualityList(value);
}

/**
 * Parse an Accept-Encoding header value into sorted quality values.
 *
 * @param value - Raw `Accept-Encoding` value
 * @returns Quality list sorted descending by q-factor
 */
export function parseAcceptEncoding(value: string): QualityValue[] {
  return parseQualityList(value);
}

/**
 * Parse an Accept-Language header value into sorted quality values.
 *
 * @param value - Raw `Accept-Language` value
 * @returns Quality list sorted descending by q-factor
 */
export function parseAcceptLanguage(value: string): QualityValue[] {
  return parseQualityList(value);
}

/**
 * Parse Content-Language header (RFC 7231 §3.1.3.2).
 * Returns array of language tags, each with optional quality params.
 *
 * @example
 * ```ts
 * parseContentLanguage("en-US, fr-CA;q=0.9")
 * // [{ value: "en-US", quality: 1, params: Map(0) }, { value: "fr-CA", quality: 0.9, params: Map(0) }]
 * ```
 */
export function parseContentLanguage(value: string): QualityValue[] {
  if (!value.trim()) return [];
  return parseQualityList(value);
}

/**
 * Content negotiation: pick the best match from the available content types
 * given the client's Accept header, respecting q-factors and wildcards.
 *
 * @param acceptHeader - Raw `Accept` header value
 * @param available    - Sorted list of content types the server can serve
 * @returns Best matching content type, or `null` if none match
 */
export function negotiateContentType(acceptHeader: string, available: string[]): string | null {
  const accepted = parseAccept(acceptHeader);
  for (const { value } of accepted) {
    if (value === "*/*") return available[0] ?? null;
    const [type] = value.split("/");
    if (value.endsWith("/*")) {
      const match = available.find((a) => a.startsWith(type + "/"));
      if (match) return match;
    }
    if (available.includes(value)) return value;
  }
  return null;
}

// ============================================================================
// §11  RANGE / CONTENT-RANGE
// ============================================================================

/** Parsed Range request header (RFC 7233 §3.1). */
export interface RangeSpec {
  /** Range unit (typically "bytes") */
  unit: string;
  /** Individual byte-range specs (start/end may be null for suffix/prefix) */
  ranges: Array<{ start: number | null; end: number | null }>;
}

/**
 * Parse a Range header value (RFC 7233 §3.1).
 *
 * @param value - Raw `Range` header value (e.g. `"bytes=0-499"`)
 * @returns Parsed range spec, or `null` if unparseable
 */
export function parseRange(value: string): RangeSpec | null {
  const eq = value.indexOf("=");
  if (eq === -1) return null;
  const unit = value.slice(0, eq).trim().toLowerCase();
  const ranges = value
    .slice(eq + 1)
    .split(",")
    .map((r) => {
      const t = r.trim();
      const dash = t.indexOf("-");
      if (dash === -1) return null;
      const start = t.slice(0, dash).trim();
      const end = t.slice(dash + 1).trim();
      return {
        start: start === "" ? null : parseInt(start, 10),
        end: end === "" ? null : parseInt(end, 10),
      };
    })
    .filter((r): r is { start: number | null; end: number | null } => r !== null);

  return { unit, ranges };
}

/** Parsed Content-Range response header (RFC 7233 §4.2). */
export interface ContentRangeValue {
  /** Range unit (typically "bytes") */
  unit: string;
  /** Start offset, or `null` if unknown (`"*"`) */
  start: number | null;
  /** End offset */
  end: number | null;
  /** Total size, or `null` if unknown (`"*"`) */
  total: number | null;
}

/**
 * Parse a Content-Range header value (RFC 7233 §4.2).
 *
 * @param value - Raw `Content-Range` value (e.g. `"bytes 200-999/1234"`)
 * @returns Parsed range value, or `null` if unparseable
 */
export function parseContentRange(value: string): ContentRangeValue | null {
  // bytes 200-999/1234  or  bytes */1234  or  bytes 200-999/*
  const m = value.match(/^(\S+)\s+(\*|\d+-\d+)\/(\*|\d+)$/);
  if (!m) return null;
  const unit = m[1]!.toLowerCase();
  const range = m[2]!;
  const total = m[3] === "*" ? null : parseInt(m[3]!, 10);

  if (range === "*") return { unit, start: null, end: null, total };

  const dash = range.indexOf("-");
  return {
    unit,
    start: parseInt(range.slice(0, dash), 10),
    end: parseInt(range.slice(dash + 1), 10),
    total,
  };
}

// ============================================================================
// §12  LINK HEADER
// ============================================================================

/** Parsed Link header entry (RFC 5988). */
export interface LinkValue {
  /** The URI reference (the part inside `< >`) */
  uri: string;
  /** Link relation type (`rel` parameter) */
  rel: string | null;
  /** Media type hint (`type` parameter) */
  type: string | null;
  /** Language hint (`hreflang` parameter) */
  hreflang: string | null;
  /** Title (`title` parameter) */
  title: string | null;
  /** Target media description (`media` parameter) */
  media: string | null;
  /** All parameters (rel, type, hreflang, title, media, and unknown) */
  params: Map<string, string>;
}

/**
 * Parse a Link header value (RFC 5988).
 *
 * @param value - Raw `Link` header (e.g.
 *   `"</css/style.css>; rel=stylesheet, </favicon.ico>; rel=icon"`)
 * @returns Array of parsed link entries
 */
export function parseLinkHeader(value: string): LinkValue[] {
  const links: LinkValue[] = [];

  // Split on ">, " but not inside angle brackets or quotes
  const entries = value.split(/,\s*(?=<)/);

  for (const entry of entries) {
    const t = entry.trim();
    const close = t.indexOf(">");
    if (!t.startsWith("<") || close === -1) continue;
    const uri = t.slice(1, close);
    const rest = t.slice(close + 1);
    const params = parseParams(rest);

    links.push({
      uri,
      rel: params.get("rel") ?? null,
      type: params.get("type") ?? null,
      hreflang: params.get("hreflang") ?? null,
      title: params.get("title") ?? null,
      media: params.get("media") ?? null,
      params,
    });
  }

  return links;
}

/**
 * Serialize an array of Link values back into a Link header string.
 *
 * @param links - Parsed Link entries
 * @returns Formatted `Link` header value
 */
export function formatLinkHeader(links: LinkValue[]): string {
  return links
    .map((l) => {
      let s = `<${l.uri}>`;
      if (l.rel) s += `; rel="${l.rel}"`;
      if (l.type) s += `; type="${l.type}"`;
      if (l.hreflang) s += `; hreflang="${l.hreflang}"`;
      if (l.title) s += `; title="${l.title}"`;
      if (l.media) s += `; media="${l.media}"`;
      const paramEntries =
        l.params instanceof Map ? [...l.params.entries()] : Object.entries(l.params ?? {});
      for (const [k, v] of paramEntries) {
        if (["rel", "type", "hreflang", "title", "media"].includes(k)) continue;
        s += `; ${k}="${v}"`;
      }
      return s;
    })
    .join(", ");
}

// ============================================================================
// §13  FORWARDED / X-FORWARDED-*
// ============================================================================

/** Parsed Forwarded header value (RFC 7239). */
export interface ForwardedValue {
  /** The `by` proxy identifier (obfuscated or IP) */
  by: string | null;
  /** The `for` list of original client identifiers (IPs, obfuscated) */
  for: string[];
  /** Original `host` */
  host: string | null;
  /** Original protocol (`proto`), e.g. "http" or "https" */
  proto: string | null;
}

/**
 * Parse a Forwarded header (RFC 7239).
 *
 * @param value - Raw `Forwarded` header value
 * @returns Parsed forwarding information
 */
export function parseForwarded(value: string): ForwardedValue {
  const result: ForwardedValue = { by: null, for: [], host: null, proto: null };

  for (const part of value.split(",")) {
    const params = parseParams(part.trim());
    if (params.has("by")) result.by = params.get("by")!;
    if (params.has("for")) result.for.push(params.get("for")!);
    if (params.has("host")) result.host = params.get("host")!;
    if (params.has("proto")) result.proto = params.get("proto")!;
  }

  return result;
}

/**
 * Normalize X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto
 * into a canonical ForwardedValue. Prefers the canonical `Forwarded` header
 * when present.
 *
 * @param headers - Source headers object
 * @returns Normalized forwarded value (from Forwarded or X-Forwarded-*)
 */
export function normalizeForwardedHeaders(headers: HttpHeaders): ForwardedValue {
  // Prefer canonical Forwarded header
  const forwarded = headers.get(HeaderName.Forwarded);
  if (forwarded) return parseForwarded(forwarded);

  const xff = headers.get(HeaderName.XForwardedFor);
  const xhost = headers.get(HeaderName.XForwardedHost);
  const xproto = headers.get(HeaderName.XForwardedProto);

  return {
    by: null,
    for: xff ? xff.split(",").map((s) => s.trim()) : [],
    host: xhost ?? null,
    proto: xproto ?? null,
  };
}

/**
 * Extract the real client IP from Forwarded, X-Forwarded-For, or X-Real-IP
 * headers (in priority order).
 *
 * @param headers - Source headers object
 * @returns First client IP found, or `null` if none present
 */
export function getClientIP(headers: HttpHeaders): string | null {
  const fwd = normalizeForwardedHeaders(headers);
  if (fwd.for.length > 0) return fwd.for[0]!;
  return headers.get(HeaderName.XRealIP);
}

// ============================================================================
// §14  RETRY-AFTER
// ============================================================================

/** Parsed Retry-After header (RFC 7231 §7.1.3). */
export interface RetryAfterValue {
  /** Absolute date, if the value was an HTTP-date */
  date: Date | null;
  /** Delta-seconds, if the value was a number */
  delay: number | null;
}

/**
 * Parse a Retry-After header which may be either delta-seconds or an
 * HTTP-date.
 *
 * @param value - Raw `Retry-After` header value
 * @returns Parsed retry value (either `date` or `delay`)
 */
export function parseRetryAfter(value: string): RetryAfterValue {
  const t = value.trim();
  // Delta-seconds: pure integer
  if (/^\d+$/.test(t)) return { date: null, delay: parseInt(t, 10) };
  // HTTP-date
  const ms = Date.parse(t);
  if (!isNaN(ms)) return { date: new Date(ms), delay: null };
  return { date: null, delay: null };
}

// ============================================================================
// §14b  WARNING (RFC 7234)
// ============================================================================

/** Parsed Warning header entry (RFC 7234). */
export interface WarningValue {
  /** Warning code (1xx = warning, 2xx = error) */
  code: number;
  /** Agent responsible for the warning (`"-"` for origin) */
  agent: string;
  /** Warning text message */
  text: string;
  /** Optional date when the warning was added */
  date?: Date;
}

/**
 * Parse Warning header (RFC 7234 §5.5).
 * Format: `<code> <agent> <text> [<date>]`
 *
 * @param value - Raw `Warning` header value
 * @returns Array of parsed warning entries
 *
 * @example
 * ```ts
 * parseWarning('112 - "network timeout" "Mon, 01 Jan 1990 00:00:00 GMT"')
 * // [{ code: 112, agent: "-", text: "network timeout", date: Date }]
 * ```
 */
export function parseWarning(value: string): WarningValue[] {
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"' && (i === 0 || value[i - 1] !== "\\")) inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      if (current.trim()) segments.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());

  return segments
    .map((part): WarningValue | null => {
      const m = part.match(/^(\d{3})\s+(\S+)\s+["']?([^"']+)["']?\s*(.*)$/);
      if (!m) return null;
      const codeStr = m[1]!;
      const agent = m[2]!;
      const text = m[3]!;
      const rest = m[4] ?? "";
      const code = parseInt(codeStr, 10);
      const date = (() => {
        const restClean = rest.trim().replace(/^"|"$/g, "");
        if (restClean) {
          const dateMs = Date.parse(restClean);
          if (!isNaN(dateMs)) return new Date(dateMs);
        }
        return undefined;
      })();
      return { code, agent, text, ...(date !== undefined ? { date } : {}) };
    })
    .filter((w): w is WarningValue => w !== null);
}

// ============================================================================
// §15  STRICT-TRANSPORT-SECURITY (HSTS)
// ============================================================================

/** Parsed Strict-Transport-Security (HSTS) header (RFC 6797). */
export interface HSTSValue {
  /** `max-age` in seconds */
  maxAge: number;
  /** `includeSubDomains` flag */
  includeSubDomains: boolean;
  /** `preload` flag (not in RFC 6797, used by browser preload lists) */
  preload: boolean;
}

/**
 * Parse a Strict-Transport-Security header.
 *
 * @param value - Raw `Strict-Transport-Security` value
 * @returns Parsed HSTS value, or `null` if `max-age` is missing/invalid
 */
export function parseHSTS(value: string): HSTSValue | null {
  const params = parseParams(";" + value);
  const maxAgeStr = params.get("max-age");
  if (maxAgeStr === undefined) return null;
  const maxAge = parseInt(maxAgeStr, 10);
  if (isNaN(maxAge)) return null;
  return {
    maxAge,
    includeSubDomains: params.has("includesubdomains"),
    preload: params.has("preload"),
  };
}

/**
 * Serialize HSTS value back into a header string.
 *
 * @param v - Parsed HSTS value
 * @returns Formatted `Strict-Transport-Security` header value
 */
export function formatHSTS(v: HSTSValue): string {
  let s = `max-age=${v.maxAge}`;
  if (v.includeSubDomains) s += "; includeSubDomains";
  if (v.preload) s += "; preload";
  return s;
}

// ============================================================================
// §16  CONTENT-SECURITY-POLICY
// ============================================================================

/**
 * Map of CSP directive names to their value lists.
 * Each directive maps to an array of source expressions / tokens.
 */
export type CSPDirectiveMap = Map<string, string[]>;

/**
 * Parse a Content-Security-Policy header into a directive→values map.
 *
 * @param value - Raw `Content-Security-Policy` header value
 * @returns Map of directive names (lowercased) to their value arrays
 *
 * @example
 * ```ts
 * const csp = parseCSP("default-src 'self'; script-src 'self' cdn.example.com");
 * csp.get("default-src") // ["'self'"]
 * csp.get("script-src")  // ["'self'", "cdn.example.com"]
 * ```
 */
export function parseCSP(value: string): CSPDirectiveMap {
  const map: CSPDirectiveMap = new Map();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0 || !tokens[0]) continue;
    const directive = tokens[0].toLowerCase();
    const values = tokens.slice(1);
    map.set(directive, values);
  }
  return map;
}

/**
 * Serialize a CSP directive map back into a header string.
 *
 * @param directives - CSP directive map
 * @returns Formatted `Content-Security-Policy` header value
 */
export function formatCSP(directives: CSPDirectiveMap): string {
  const parts: string[] = [];
  for (const [directive, values] of directives) {
    parts.push(values.length > 0 ? `${directive} ${values.join(" ")}` : directive);
  }
  return parts.join("; ");
}

// ============================================================================
// §17  SERVER-TIMING
// ============================================================================

/** A single entry from a Server-Timing header (W3C Server Timing). */
export interface ServerTimingEntry {
  /** Metric name */
  name: string;
  /** Duration in milliseconds, or `null` if not provided */
  duration: number | null;
  /** Human-readable description, or `null` */
  description: string | null;
}

/**
 * Parse a Server-Timing header.
 *
 * @param value - Raw `Server-Timing` header value
 * @returns Array of timing entries
 */
export function parseServerTiming(value: string): ServerTimingEntry[] {
  return value
    .split(",")
    .map((part) => {
      const segments = part.trim().split(";");
      const name = (segments[0] ?? "").trim();
      const params = parseParams(segments.slice(1).join(";"));
      const dur = params.get("dur");
      return {
        name,
        duration: dur !== undefined ? parseFloat(dur) : null,
        description: params.get("desc") ?? null,
      };
    })
    .filter((e) => e.name !== "");
}

/**
 * Serialize server-timing entries back into a header string.
 *
 * @param entries - Parsed timing entries
 * @returns Formatted `Server-Timing` header value
 */
export function formatServerTiming(entries: ServerTimingEntry[]): string {
  return entries
    .map((e) => {
      let s = e.name;
      if (e.duration !== null) s += `;dur=${e.duration}`;
      if (e.description !== null) s += `;desc="${e.description}"`;
      return s;
    })
    .join(", ");
}

// ============================================================================
// §18  ALT-SVC
// ============================================================================

/** A single alternative service from an Alt-Svc header (RFC 7838). */
export interface AltSvcEntry {
  /** Protocol ID (e.g. "h2", "h3") */
  protocol: string;
  /** Host name or IP */
  host: string;
  /** Port number */
  port: number;
  /** Max age in seconds, or `null` */
  maxAge: number | null;
  /** Whether the service persists across network changes */
  persist: boolean;
}

/**
 * Parse an Alt-Svc header (RFC 7838).
 *
 * @param value - Raw `Alt-Svc` header value
 * @returns Array of alternative service entries
 */
export function parseAltSvc(value: string): AltSvcEntry[] {
  if (value.trim() === "clear") return [];
  const entries: AltSvcEntry[] = [];

  for (const part of value.split(",")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const proto = t.slice(0, eq).trim().replace(/^"|"$/g, "");
    const rest = t.slice(eq + 1).trim();
    const semIdx = rest.indexOf(";");
    const params = semIdx !== -1 ? parseParams(";" + rest.slice(semIdx + 1)) : new Map();
    const authority = (semIdx !== -1 ? rest.slice(0, semIdx) : rest).replace(/^"|"$/g, "");

    let host: string;
    let port: number;
    if (authority.startsWith("[")) {
      // IPv6 format: [IPv6]:port
      const closeBracket = authority.indexOf("]");
      if (closeBracket === -1) {
        host = authority;
        port = 443;
      } else {
        host = authority.slice(0, closeBracket + 1);
        const portStr = authority.slice(closeBracket + 2);
        port = portStr ? parseInt(portStr, 10) : 443;
      }
    } else {
      // IPv4 or hostname
      const colon = authority.lastIndexOf(":");
      host = colon === -1 ? authority : authority.slice(0, colon);
      port = colon === -1 ? 443 : parseInt(authority.slice(colon + 1), 10);
    }

    entries.push({
      protocol: proto,
      host,
      port,
      maxAge: params.has("ma") ? parseInt(params.get("ma")!, 10) : null,
      persist: params.has("persist") && params.get("persist") === "1",
    });
  }

  return entries;
}

// ============================================================================
// §19  INTEROP HELPERS
// ============================================================================

/**
 * Convert a Node.js `http.IncomingMessage` headers object to HttpHeaders.
 * Node's IncomingMessage uses lowercased keys with `string | string[]` values.
 *
 * @param nodeHeaders - Headers from `http.IncomingMessage.headers`
 * @returns A new HttpHeaders instance
 */
export function fromNodeHeaders(
  nodeHeaders: Record<string, string | string[] | undefined>,
): HttpHeaders {
  const h = new HttpHeaders();
  for (const [key, val] of Object.entries(nodeHeaders)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) h.append(key, v);
    } else {
      h.append(key, val);
    }
  }
  return h;
}

/**
 * Convert HttpHeaders to a Node.js-compatible flat object
 * (`string | string[]` per key, matching `http.IncomingMessage.headers`).
 *
 * @param headers - Source HttpHeaders instance
 * @returns Plain object with lowercased keys
 */
export function toNodeHeaders(headers: HttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  // Use the public forEach method to access header entries
  // This properly handles the private map without type assertions
  headers.forEach((_value, name) => {
    // Get all values for this header to preserve the original array
    const entryValues = headers.getAll(name);
    const values = entryValues;
    out[name] = values.length === 1 ? (values[0] as string) : [...values];
  });
  return out;
}

/**
 * Convert a WHATWG `Headers` object to HttpHeaders.
 *
 * @param webHeaders - Standard `Headers` instance
 * @returns A new HttpHeaders instance
 */
export function fromWebHeaders(webHeaders: Headers): HttpHeaders {
  return new HttpHeaders(webHeaders);
}

/**
 * Build common security headers suitable for most web responses.
 */
export function securityHeaders(
  options: {
    hsts?: boolean | HSTSValue;
    csp?: string | CSPDirectiveMap;
    frameOptions?: "DENY" | "SAMEORIGIN";
    noSniff?: boolean;
    referrer?: string;
    permissions?: string;
    coep?: "require-corp" | "unsafe-none";
    coop?: "same-origin" | "same-origin-allow-popups" | "unsafe-none";
    corp?: "same-origin" | "same-site" | "cross-origin";
  } = {},
): HttpHeaders {
  const h = new HttpHeaders();

  // HSTS
  if (options.hsts !== false) {
    const hstsVal =
      options.hsts === true || options.hsts === undefined
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : (options.hsts as HSTSValue);
    h.set(HeaderName.StrictTransportSecurity, formatHSTS(hstsVal));
  }

  // CSP
  if (options.csp) {
    const cspStr = typeof options.csp === "string" ? options.csp : formatCSP(options.csp);
    h.set(HeaderName.ContentSecurityPolicy, cspStr);
  }

  // X-Frame-Options
  h.set(HeaderName.XFrameOptions, options.frameOptions ?? "DENY");

  // X-Content-Type-Options
  if (options.noSniff !== false) h.set(HeaderName.XContentTypeOptions, "nosniff");

  // Referrer-Policy
  h.set(HeaderName.ReferrerPolicy, options.referrer ?? "strict-origin-when-cross-origin");

  // Permissions-Policy
  if (options.permissions) h.set(HeaderName.PermissionsPolicy, options.permissions);

  // Cross-Origin policies
  if (options.coep) h.set(HeaderName.CrossOriginEmbedderPolicy, options.coep);
  if (options.coop) h.set(HeaderName.CrossOriginOpenerPolicy, options.coop);
  if (options.corp) h.set(HeaderName.CrossOriginResourcePolicy, options.corp);

  return h;
}

/**
 * Build standard CORS headers.
 *
 * This function sets headers unconditionally. If you need to merge with
 * pre-existing CORS headers, use the returned HttpHeaders as a base and then
 * apply additional headers after. Do not use Object.assign() or merge functions
 * that may overwrite the Access-Control-Allow-Origin set here.
 *
 * @example
 * ```ts
 * // As a base - caller adds the rest
 * const base = corsHeaders({ origin: "https://example.com" });
 * base.set("Access-Control-Allow-Methods", "GET, POST");
 * ```
 */
export function corsHeaders(options: {
  origin: string | string[] | "*";
  methods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}): HttpHeaders {
  const h = new HttpHeaders();

  const origin = Array.isArray(options.origin) ? options.origin.join(", ") : options.origin;
  h.set(HeaderName.AccessControlAllowOrigin, origin);

  if (options.methods?.length) {
    h.set(HeaderName.AccessControlAllowMethods, options.methods.join(", "));
  }
  if (options.allowHeaders?.length) {
    h.set(HeaderName.AccessControlAllowHeaders, options.allowHeaders.join(", "));
  }
  if (options.exposeHeaders?.length) {
    h.set(HeaderName.AccessControlExposeHeaders, options.exposeHeaders.join(", "));
  }
  if (options.credentials) {
    h.set(HeaderName.AccessControlAllowCredentials, "true");
  }
  if (options.maxAge != null) {
    h.set(HeaderName.AccessControlMaxAge, String(options.maxAge));
  }

  return h;
}

// ============================================================================
// §20  TYPED ACCESSOR MIXIN — HttpHeaders extension with parsed getters
// ============================================================================

/**
 * RichHeaders extends HttpHeaders with typed getter/setter shortcuts
 * for all commonly-used headers.
 *
 * Provides parsed accessors for:
 * - Content-Type, Content-Disposition, Content-Range
 * - Cache-Control, ETag, Last-Modified, Expires, Vary, Age
 * - Authorization, WWW-Authenticate
 * - Accept, Accept-Encoding, Accept-Language
 * - Set-Cookie (via setCookies getter)
 * - Link, Server-Timing, Alt-Svc
 * - Forwarded / X-Forwarded-* normalization
 * - CORS headers
 * - Security headers (CSP, HSTS, etc.)
 *
 * @example
 * ```ts
 * const headers = new RichHeaders();
 * headers.contentType = "application/json";
 * headers.set("Content-Type", "text/html");
 * console.log(headers.contentType?.charset); // "utf-8"
 *
 * headers.setCookies; // string[] of all Set-Cookie values
 * ```
 */
export class RichHeaders extends HttpHeaders {
  // ── Content-Type ──────────────────────────────────────────────────────────
  /** Get the parsed Content-Type header value. */
  get contentType(): ContentTypeValue | null {
    const v = this.get(HeaderName.ContentType);
    return v ? parseContentType(v) : null;
  }
  /** Set the Content-Type header from a string or parsed value. */
  set contentType(v: string | ContentTypeValue | null) {
    if (v === null) {
      this.delete(HeaderName.ContentType);
      return;
    }
    if (typeof v === "string") {
      this.set(HeaderName.ContentType, v);
      return;
    }
    this.set(HeaderName.ContentType, formatContentType(v));
  }

  // ── Content-Length ────────────────────────────────────────────────────────
  /** Get the Content-Length header value as a number. */
  get contentLength(): number | null {
    const v = this.get(HeaderName.ContentLength);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** Set the Content-Length header from a number. */
  set contentLength(v: number | null) {
    if (v === null) {
      this.delete(HeaderName.ContentLength);
      return;
    }
    this.set(HeaderName.ContentLength, String(v));
  }

  // ── Content-Disposition ───────────────────────────────────────────────────
  /** Get the parsed Content-Disposition header value. */
  get contentDisposition(): ContentDispositionValue | null {
    const v = this.get(HeaderName.ContentDisposition);
    return v ? parseContentDisposition(v) : null;
  }
  /** Set the Content-Disposition header from a string or parsed value. */
  set contentDisposition(v: string | ContentDispositionValue | null) {
    if (v === null) {
      this.delete(HeaderName.ContentDisposition);
      return;
    }
    if (typeof v === "string") {
      this.set(HeaderName.ContentDisposition, v);
      return;
    }
    this.set(HeaderName.ContentDisposition, formatContentDisposition(v));
  }

  // ── Cache-Control ─────────────────────────────────────────────────────────
  /** Get the parsed Cache-Control header directives. */
  get cacheControl(): CacheControlDirectives | null {
    const v = this.get(HeaderName.CacheControl);
    return v ? parseCacheControl(v) : null;
  }
  /** Set the Cache-Control header from a string or partial directives. */
  set cacheControl(v: string | Partial<CacheControlDirectives> | null) {
    if (v === null) {
      this.delete(HeaderName.CacheControl);
      return;
    }
    if (typeof v === "string") {
      this.set(HeaderName.CacheControl, v);
      return;
    }
    this.set(HeaderName.CacheControl, formatCacheControl(v));
  }

  // ── Authorization ─────────────────────────────────────────────────────────
  /** Get the parsed Authorization header credentials. */
  get authorization(): AuthCredentials | null {
    const v = this.get(HeaderName.Authorization);
    return v ? parseAuthorization(v) : null;
  }
  /** Set the Authorization header from a raw string. */
  set authorization(v: string | null) {
    if (v === null) {
      this.delete(HeaderName.Authorization);
      return;
    }
    this.set(HeaderName.Authorization, v);
  }

  /** Parsed Accept quality values sorted by q-factor */
  get accept(): QualityValue[] {
    return parseAccept(this.get(HeaderName.Accept) ?? "");
  }
  /** Parsed Accept-Encoding quality values sorted by q-factor */
  get acceptEncoding(): QualityValue[] {
    return parseAcceptEncoding(this.get(HeaderName.AcceptEncoding) ?? "");
  }
  /** Parsed Accept-Language quality values sorted by q-factor */
  get acceptLanguage(): QualityValue[] {
    return parseAcceptLanguage(this.get(HeaderName.AcceptLanguage) ?? "");
  }

  /** Parsed Range request header (RFC 7233) */
  get range(): RangeSpec | null {
    const v = this.get(HeaderName.Range);
    return v ? parseRange(v) : null;
  }
  /** Parsed Content-Range response header (RFC 7233) */
  get contentRange(): ContentRangeValue | null {
    const v = this.get(HeaderName.ContentRange);
    return v ? parseContentRange(v) : null;
  }

  // ── ETag ──────────────────────────────────────────────────────────────────
  /** Get the ETag header value. */
  get etag(): string | null {
    return this.get(HeaderName.ETag);
  }
  /** Set the ETag header, automatically quoting if needed. */
  set etag(v: string | null) {
    if (v === null) {
      this.delete(HeaderName.ETag);
      return;
    }
    // Wrap in quotes if not already
    const quoted = v.startsWith('"') || v.startsWith('W/"') ? v : `"${v}"`;
    this.set(HeaderName.ETag, quoted);
  }

  // ── Link ──────────────────────────────────────────────────────────────────
  /** Get parsed Link header entries. */
  get links(): LinkValue[] {
    const v = this.get(HeaderName.Link);
    return v ? parseLinkHeader(v) : [];
  }

  // ── RetryAfter ────────────────────────────────────────────────────────────
  /** Get the parsed Retry-After header value. */
  get retryAfter(): RetryAfterValue | null {
    const v = this.get(HeaderName.RetryAfter);
    return v ? parseRetryAfter(v) : null;
  }

  // ── HSTS ──────────────────────────────────────────────────────────────────
  /** Get the parsed Strict-Transport-Security header value. */
  get hsts(): HSTSValue | null {
    const v = this.get(HeaderName.StrictTransportSecurity);
    return v ? parseHSTS(v) : null;
  }
  /** Set the Strict-Transport-Security header from an HSTS value. */
  set hsts(v: HSTSValue | null) {
    if (v === null) {
      this.delete(HeaderName.StrictTransportSecurity);
      return;
    }
    this.set(HeaderName.StrictTransportSecurity, formatHSTS(v));
  }

  // ── CSP ───────────────────────────────────────────────────────────────────
  /** Get the parsed Content-Security-Policy directives. */
  get csp(): CSPDirectiveMap | null {
    const v = this.get(HeaderName.ContentSecurityPolicy);
    return v ? parseCSP(v) : null;
  }
  /** Set the Content-Security-Policy header from a string or directive map. */
  set csp(v: CSPDirectiveMap | string | null) {
    if (v === null) {
      this.delete(HeaderName.ContentSecurityPolicy);
      return;
    }
    if (typeof v === "string") {
      this.set(HeaderName.ContentSecurityPolicy, v);
      return;
    }
    this.set(HeaderName.ContentSecurityPolicy, formatCSP(v));
  }

  // ── Server-Timing ─────────────────────────────────────────────────────────
  /** Get parsed Server-Timing entries. */
  get serverTiming(): ServerTimingEntry[] {
    const v = this.get(HeaderName.ServerTiming);
    return v ? parseServerTiming(v) : [];
  }

  /** Best guess at real client IP from Forwarded / X-Forwarded-For / X-Real-IP */
  get clientIP(): string | null {
    return getClientIP(this);
  }
  /** Normalized Forwarded or X-Forwarded-* information */
  get forwarded(): ForwardedValue {
    return normalizeForwardedHeaders(this);
  }

  /** Raw Host header value */
  get host(): string | null {
    return this.get(HeaderName.Host);
  }
  /** Raw Origin header value */
  get origin(): string | null {
    return this.get(HeaderName.Origin);
  }
  /** Raw User-Agent header value */
  get userAgent(): string | null {
    return this.get(HeaderName.UserAgent);
  }
  /** Raw Location header value */
  get location(): string | null {
    return this.get(HeaderName.Location);
  }
  /** Parsed Date header as a Date object */
  get date(): Date | null {
    const v = this.get(HeaderName.Date);
    if (!v) return null;
    const ms = Date.parse(v);
    return isNaN(ms) ? null : new Date(ms);
  }
  /** Parsed Age header in seconds */
  get age(): number | null {
    const v = this.get(HeaderName.Age);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** Parsed Vary header as an array of field names (lowercased) */
  get vary(): string[] {
    const v = this.get(HeaderName.Vary);
    return v ? v.split(",").map((s) => s.trim().toLowerCase()) : [];
  }

  /** X-Request-ID header value */
  get xRequestID(): string | null {
    return this.get(HeaderName.XRequestID);
  }
  /** X-Correlation-ID header value */
  get xCorrelationID(): string | null {
    return this.get(HeaderName.XCorrelationID);
  }
  /** X-Powered-By header value */
  get xPoweredBy(): string | null {
    return this.get(HeaderName.XPoweredBy);
  }
  /** X-Requested-With header value */
  get xRequestedWith(): string | null {
    return this.get(HeaderName.XRequestedWith);
  }

  /** X-RateLimit-Limit header value (parsed as number) */
  get xRateLimitLimit(): number | null {
    const v = this.get(HeaderName.XRateLimitLimit);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** X-RateLimit-Remaining header value (parsed as number) */
  get xRateLimitRemaining(): number | null {
    const v = this.get(HeaderName.XRateLimitRemaining);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** X-RateLimit-Reset header value (parsed as number) */
  get xRateLimitReset(): number | null {
    const v = this.get(HeaderName.XRateLimitReset);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  /** Sec-Fetch-Site header value */
  get secFetchSite(): string | null {
    return this.get(HeaderName.SecFetchSite);
  }
  /** Sec-Fetch-Mode header value */
  get secFetchMode(): string | null {
    return this.get(HeaderName.SecFetchMode);
  }
  /** Sec-Fetch-User header value */
  get secFetchUser(): string | null {
    return this.get(HeaderName.SecFetchUser);
  }
  /** Sec-Fetch-Dest header value */
  get secFetchDest(): string | null {
    return this.get(HeaderName.SecFetchDest);
  }

  /** Early-Data header value (parsed as number) */
  get earlyData(): number | null {
    const v = this.get(HeaderName.EarlyData);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** Priority header value */
  get priority(): string | null {
    return this.get(HeaderName.Priority);
  }

  /** Allow header value */
  get allow(): string | null {
    return this.get(HeaderName.Allow);
  }
  /** Server header value */
  get server(): string | null {
    return this.get(HeaderName.Server);
  }
  /** Accept-Ranges header value */
  get acceptRanges(): string | null {
    return this.get("accept-ranges");
  }
  /** Parsed Last-Modified header as a Date object */
  get lastModified(): Date | null {
    const v = this.get("last-modified");
    if (!v) return null;
    const ms = Date.parse(v);
    return isNaN(ms) ? null : new Date(ms);
  }
  /** Parsed Expires header as a Date object */
  get expires(): Date | null {
    const v = this.get("expires");
    if (!v) return null;
    const ms = Date.parse(v);
    return isNaN(ms) ? null : new Date(ms);
  }
  /** Content-Encoding header value */
  get contentEncoding(): string | null {
    return this.get("content-encoding");
  }
  /** Content-Language header value */
  get contentLanguage(): string | null {
    return this.get("content-language");
  }
  /** Content-Location header value */
  get contentLocation(): string | null {
    return this.get("content-location");
  }
  /** First Link header entry (parsed) */
  get link(): LinkValue | null {
    const v = this.get(HeaderName.Link);
    return v ? (parseLinkHeader(v)[0] ?? null) : null;
  }
  /** Parsed Alt-Svc entries */
  get altSvc(): AltSvcEntry[] {
    const v = this.get(HeaderName.AltSvc);
    return v ? parseAltSvc(v) : [];
  }
  /** Get parsed WWW-Authenticate challenge entries. */
  get wwwAuthenticate(): AuthChallenge[] | null {
    const v = this.get("www-authenticate");
    return v ? parseWWWAuthenticate(v) : null;
  }
  /** Set the WWW-Authenticate header from challenge entries. */
  set wwwAuthenticate(v: AuthChallenge[] | null) {
    if (v === null) {
      this.delete("www-authenticate");
      return;
    }
    const out = v
      .map((c) => {
        const paramEntries = [...c.params].filter(([k]) => k !== "realm");
        const params = paramEntries.map(([k, val]) => `${k}=${val}`).join(", ");
        let result = c.scheme;
        if (c.realm) result += ` realm="${c.realm}"`;
        if (params) result += `; ${params}`;
        return result;
      })
      .join(", ");
    this.set("www-authenticate", out);
  }

  // ── Proxy Authentication ───────────────────────────────────────────────────
  /** Get parsed Proxy-Authenticate challenge entries. */
  get proxyAuthenticate(): AuthChallenge[] | null {
    const v = this.get(HeaderName.ProxyAuthenticate);
    return v ? parseWWWAuthenticate(v) : null;
  }
  /** Set the Proxy-Authenticate header from challenge entries. */
  set proxyAuthenticate(v: AuthChallenge[] | null) {
    if (v === null) {
      this.delete(HeaderName.ProxyAuthenticate);
      return;
    }
    const out = v
      .map((c) => {
        const paramEntries = [...c.params].filter(([k]) => k !== "realm");
        const params = paramEntries.map(([k, val]) => `${k}=${val}`).join(", ");
        let result = c.scheme;
        if (c.realm) result += ` realm="${c.realm}"`;
        if (params) result += `; ${params}`;
        return result;
      })
      .join(", ");
    this.set(HeaderName.ProxyAuthenticate, out);
  }
  /** Get the parsed Proxy-Authorization header credentials. */
  get proxyAuthorization(): AuthCredentials | null {
    const v = this.get(HeaderName.ProxyAuthorization);
    return v ? parseAuthorization(v) : null;
  }
  /** Set the Proxy-Authorization header from a string or parsed credentials. */
  set proxyAuthorization(v: string | AuthCredentials | null) {
    if (v === null) {
      this.delete(HeaderName.ProxyAuthorization);
      return;
    }
    if (typeof v === "string") {
      this.set(HeaderName.ProxyAuthorization, v);
      return;
    }
    // Format from AuthCredentials
    if (v.basic) {
      this.set(
        HeaderName.ProxyAuthorization,
        `Basic ${encodeBase64(`${v.basic.username}:${v.basic.password}`)}`,
      );
    } else if (v.token) {
      this.set(HeaderName.ProxyAuthorization, `${v.scheme} ${v.token}`);
    } else {
      this.set(HeaderName.ProxyAuthorization, v.scheme);
    }
  }

  // ── Cookies ────────────────────────────────────────────────────────────────────
  /** Get all Set-Cookie header values as an array. */
  get setCookies(): string[] {
    return this.getAll(HeaderName.SetCookie);
  }

  /** Access-Control-Allow-Origin header value */
  get accessControlAllowOrigin(): string | null {
    return this.get(HeaderName.AccessControlAllowOrigin);
  }
  /** Access-Control-Allow-Methods header value */
  get accessControlAllowMethods(): string | null {
    return this.get(HeaderName.AccessControlAllowMethods);
  }
  /** Access-Control-Allow-Headers header value */
  get accessControlAllowHeaders(): string | null {
    return this.get(HeaderName.AccessControlAllowHeaders);
  }
  /** Access-Control-Max-Age header value (parsed as number) */
  get accessControlMaxAge(): number | null {
    const v = this.get(HeaderName.AccessControlMaxAge);
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }
  /** Access-Control-Allow-Credentials header value (parsed as boolean) */
  get accessControlCredentials(): boolean | null {
    const v = this.get(HeaderName.AccessControlAllowCredentials);
    return v === "true" ? true : v === "false" ? false : null;
  }
}

// ============================================================================
// §21  FACTORY HELPERS
// ============================================================================

/**
 * Create a new RichHeaders instance with no guard.
 * @param init Optional initial headers (HeadersInit, plain object, or array of tuples)
 * @returns A new RichHeaders instance
 */
export function createHeaders(
  init?: HeadersInit | Record<string, string | string[]> | null,
): RichHeaders {
  return new RichHeaders(init);
}

/**
 * Create a new RichHeaders instance with "request" guard.
 * Request guard forbids certain headers (Cookie, Host, etc.) per WHATWG Fetch spec.
 * @param init Optional initial headers
 * @returns A new RichHeaders instance with request guard
 */
export function createRequestHeaders(
  init?: HeadersInit | Record<string, string | string[]> | null,
): RichHeaders {
  return new RichHeaders(init, "request");
}

/**
 * Create a new RichHeaders instance with "response" guard.
 * Response guard forbids Set-Cookie headers.
 * @param init Optional initial headers
 * @returns A new RichHeaders instance with response guard
 */
export function createResponseHeaders(
  init?: HeadersInit | Record<string, string | string[]> | null,
): RichHeaders {
  return new RichHeaders(init, "response");
}

/**
 * Create a new RichHeaders instance with "immutable" guard.
 * Immutable headers cannot be modified after creation.
 * @param init Optional initial headers
 * @returns A new RichHeaders instance with immutable guard
 */
export function createImmutableHeaders(
  init?: HeadersInit | Record<string, string | string[]> | null,
): RichHeaders {
  return new RichHeaders(init, "immutable");
}
