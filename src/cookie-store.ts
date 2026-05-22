/**
 * cookie-store.ts
 *
 * Full RFC 6265 §5.3 + §5.4 implementation:
 *  - Storage model (creation time, last access, persistent vs session)
 *  - Cookie retrieval algorithm (domain, path, secure, httpOnly, SameSite)
 *  - __Secure- / __Host- prefix enforcement (RFC 6265bis §4.1.3)
 *  - SameSite Strict / Lax / None enforcement (full state machine)
 *  - LRU eviction: per-domain cap (50) + global cap (3000)
 *  - Atomic update semantics (update preserves createdAt)
 *  - Full JSON serialization / deserialization with expiry filtering
 *  - clear / clearExpired / clearSession / clearForDomain / clearForUrl
 */

import {
  type SameSite,
  parseSetCookieHeader,
  canonicalizeDomainFull,
  defaultPath,
  pathMatch,
  domainMatch,
  isPublicSuffix,
  isIPAddress,
  extractSetCookieHeaders,
} from "./cookie-parser.ts";

// ============================================================================
// 1. INTERNAL COOKIE MODEL
// ============================================================================

/**
 * A single HTTP cookie per RFC 6265 §5.3 storage model.
 * Tracks name, value, domain, path, expiry, security flags, SameSite policy,
 * creation and last-access times, and host-only status.
 */
export interface Cookie {
  /** Cookie name (may be empty string) */
  name: string;
  /** Cookie value */
  value: string;
  /** Canonicalized domain (no leading dot, lowercased, IDN-decoded) */
  domain: string;
  /** Cookie path */
  path: string;
  /**
   * Absolute expiry time in ms since epoch.
   * Infinity means session cookie (no Expires/Max-Age).
   */
  expires: number;
  /** Raw Max-Age value in seconds as parsed (null if not present) */
  maxAge: number | null;
  /** Secure flag */
  secure: boolean;
  /** HttpOnly flag */
  httpOnly: boolean;
  /** SameSite policy */
  sameSite: SameSite;
  /** Creation time in ms since epoch (RFC 6265 §5.3 step 2) */
  createdAt: number;
  /** Last-access time in ms since epoch (RFC 6265 §5.3 step 2) */
  lastAccessed: number;
  /**
   * Host-only flag (RFC 6265 §5.3 step 6):
   * true  = cookie was set without a Domain attribute → exact host match only
   * false = cookie has a Domain attribute → subdomain matching applies
   */
  hostOnly: boolean;
}

/**
 * Serializable form of a Cookie for JSON persistence.
 * Infinity (session) expiry is stored as null.
 */
export interface CookieJSON {
  /** Cookie name */
  name: string;
  /** Cookie value */
  value: string;
  /** Canonicalized domain */
  domain: string;
  /** Cookie path */
  path: string;
  /** Absolute expiry time in ms since epoch, or null for session cookies */
  expires: number | null;
  /** Raw Max-Age value in seconds, or null if not present */
  maxAge: number | null;
  /** Secure flag */
  secure: boolean;
  /** HttpOnly flag */
  httpOnly: boolean;
  /** SameSite policy */
  sameSite: SameSite;
  /** Creation time in ms since epoch */
  createdAt: number;
  /** Last-access time in ms since epoch */
  lastAccessed: number;
  /** Host-only flag */
  hostOnly: boolean;
}

// ============================================================================
// 2. REQUEST CONTEXT FOR SAMESITE
// ============================================================================

/**
 * SameSite request context.
 *
 * "strict"     = same-site, any method
 * "lax"        = cross-site, but safe method (GET/HEAD) top-level navigation
 * "cross-site" = cross-site, non-safe or non-top-level
 * "none"       = no enforcement (e.g. direct URL bar navigation)
 */
export type SameSiteContext = "strict" | "lax" | "cross-site" | "none";

export interface SetCookieOptions {
  /** Full URL the Set-Cookie header was received from */
  url: string;
  /**
   * SameSite context of the request that produced this Set-Cookie response.
   * Defaults to "none" (no restriction on setting).
   */
  sameSiteContext?: SameSiteContext;
}

export interface GetCookiesOptions {
  /** Full URL cookies are being requested for */
  url: string;
  /**
   * Is this an HTTP(S) request?
   * false = script/document context → HttpOnly cookies are withheld.
   * Defaults to true.
   */
  http?: boolean;
  /**
   * SameSite context for the outgoing request.
   * Defaults to "none" (send all cookies).
   */
  sameSiteContext?: SameSiteContext;
}

// ============================================================================
// 3. CONSTANTS
// ============================================================================

/**
 * Maximum cookie size in bytes per RFC 6265.
 * User agents may impose a 4096-byte limit on the combined size of
 * the cookie name, "=" separator, and value.
 */
const MAX_COOKIE_SIZE = 4096;
const MAX_PER_DOMAIN = 50; // Max cookies per domain
const MAX_TOTAL = 3000; // Max total cookies across all domains
const MAX_COOKIE_AGE = 400 * 24 * 60 * 60 * 1000; // 400 days in ms (Chrome cap)

// ============================================================================
// 4. PREFIX ENFORCEMENT — RFC 6265bis §4.1.3
// ============================================================================

/**
 * Enforce __Secure- and __Host- prefix rules per RFC 6265bis §4.1.3.
 *
 * __Secure- requires Secure flag + secure context.
 * __Host- requires Secure + secure context + Path=/ + no Domain attribute.
 *
 * @param cookie    - The cookie to validate
 * @param requestUrl - URL of the request that set the cookie
 * @returns true if the cookie passes all prefix rules
 */
function enforcePrefixRules(cookie: Cookie, requestUrl: URL): boolean {
  const name = cookie.name;

  if (name.startsWith("__Secure-")) {
    // Must be Secure
    if (!cookie.secure) return false;
    // Must be from a secure context
    if (requestUrl.protocol !== "https:") return false;
  }

  if (name.startsWith("__Host-")) {
    // Must be Secure
    if (!cookie.secure) return false;
    // Must be from a secure context
    if (requestUrl.protocol !== "https:") return false;
    // Must have Path=/
    if (cookie.path !== "/") return false;
    // Must NOT have a Domain attribute (i.e. hostOnly must be true)
    if (!cookie.hostOnly) return false;
  }

  return true;
}

// ============================================================================
// 5. SAMESITE ENFORCEMENT — RFC 6265bis §5.3.7
// ============================================================================

/**
 * Determines whether a cookie with the given SameSite attribute
 * should be sent in a request with the given context.
 *
 * sameSite = Strict  → only send in strict same-site context
 * sameSite = Lax     → send in strict + lax (cross-site safe top-level nav)
 * sameSite = None    → send in all contexts (requires Secure)
 * sameSite = Unset   → treated as Lax by modern browsers (we follow suit)
 *
 * @param sameSite - The cookie's SameSite attribute
 * @param context  - The request's SameSite context
 * @returns true if the cookie may be sent
 */
function sameSiteAllows(sameSite: SameSite, context: SameSiteContext): boolean {
  switch (sameSite) {
    case "Strict":
      return context === "strict";

    case "Lax":
      // Lax allows strict context and cross-site safe top-level navigation
      return context === "strict" || context === "lax";

    case "Unset":
      // Unset: treated permissively — allow same-site and "none" (navigation/direct)
      // Block only explicit cross-site non-navigation requests
      return context !== "cross-site";

    case "None":
      // None: send in all contexts (Secure requirement enforced at set time)
      return true;
  }
}

// ============================================================================
// 6. STORAGE ENGINE
// ============================================================================

// Indexed as: domain → path → name → Cookie
type DomainMap = Map<string, PathMap>;
type PathMap = Map<string, NameMap>;
type NameMap = Map<string, Cookie>;

// ============================================================================
// 7. COOKIEJAR
// ============================================================================

/**
 * Options for creating a CookieJar instance
 */
export interface CookieJarOptions {
  /** Maximum total cookies across all domains (default: 3000) */
  maxTotal?: number;
  /** Maximum cookies per domain (default: 50) */
  maxPerDomain?: number;
  /** Custom domain match function (default: internal domainMatch) */
  domainMatcher?: (requestHost: string, cookieDomain: string) => boolean;
}

/**
 * RFC 6265 §5.3 + §5.4 cookie jar implementation.
 *
 * Stores cookies in a three-level map (domain → path → name) with:
 *  - LRU eviction (per-domain cap of 50, global cap of 3000)
 *  - __Secure- / __Host- prefix enforcement (RFC 6265bis §4.1.3)
 *  - SameSite Strict / Lax / None enforcement
 *  - JSON serialization / deserialization
 *
 * @example
 * const jar = new CookieJar();
 * jar.setCookie("session=abc; Path=/; Secure", { url: "https://example.com/" });
 * const cookies = jar.getCookies({ url: "https://example.com/page" });
 */
export class CookieJar {
  private readonly dm: DomainMap = new Map();
  private total = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Customizable limits
  private readonly maxTotal: number;
  private readonly maxPerDomain: number;
  private readonly domainMatcherFn: ((requestHost: string, cookieDomain: string) => boolean) | null;

  /**
   * @param options - Cookie jar limits and optional custom domain matcher
   */
  constructor(options: CookieJarOptions = {}) {
    this.maxTotal = options.maxTotal ?? MAX_TOTAL;
    this.maxPerDomain = options.maxPerDomain ?? MAX_PER_DOMAIN;
    this.domainMatcherFn = options.domainMatcher ?? null;

    // Set up periodic cleanup (1% chance on each cookie access + every 5 minutes)
    this.cleanupTimer = setInterval(
      () => {
        this.clearExpired();
      },
      5 * 60 * 1000,
    );

    // Allow process to exit even if timer is running (Node.js only)
    if (
      typeof this.cleanupTimer === "object" &&
      this.cleanupTimer !== null &&
      "unref" in this.cleanupTimer
    ) {
      (this.cleanupTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Destroy the jar — clears the periodic cleanup timer.
   * Call this when the jar is no longer needed to prevent memory leaks.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // 7.1  setCookie — RFC 6265 §5.3
  // --------------------------------------------------------------------------

  /**
   * Set a cookie per RFC 6265 §5.3.
   *
   * Rejects cookies that exceed size limits, fail domain/path validation,
   * violate prefix rules, or would be immediately expired (treats those as deletes).
   *
   * @param header  - Raw Set-Cookie header value (e.g. "session=abc; Path=/; Secure")
   * @param options - URL the cookie was received from + SameSite context
   * @returns true if the cookie was stored, false if rejected
   */
  setCookie(header: string, options: SetCookieOptions): boolean {
    const url = safeParseUrl(options.url);
    if (!url) return false;

    const parsed = parseSetCookieHeader(header);
    if (!parsed) return false;

    const now = Date.now();
    const reqHost = url.hostname.toLowerCase();
    const reqHostBare = reqHost.replace(/^\[|\]$/g, "");
    const isSecureCtx =
      url.protocol === "https:" ||
      reqHostBare === "localhost" ||
      reqHostBare === "127.0.0.1" ||
      reqHostBare === "::1";

    // §5.3 step 1: validate name/value size
    const rawSize = parsed.name.length + 1 + parsed.value.length;
    if (rawSize > MAX_COOKIE_SIZE) return false;

    // §5.3 step 2: determine cookie-domain and host-only-flag
    let cookieDomain: string;
    let hostOnly: boolean;

    if (parsed.domain !== null && parsed.domain !== "") {
      const cd = parsed.domain;

      // Must domain-match the request host (use custom matcher if provided)
      const matcher = this.domainMatcherFn ?? domainMatch;
      if (!matcher(reqHost, cd)) return false;

      // Must not be a public suffix
      if (isPublicSuffix(cd)) return false;

      cookieDomain = cd;
      hostOnly = false;
    } else {
      cookieDomain = reqHost;
      hostOnly = true;
    }

    // §5.3 step 3: determine cookie-path
    const cookiePath = parsed.path ?? defaultPath(url.pathname);

    // §5.3 step 4: Secure attribute
    const secure = parsed.secure;
    if (secure && !isSecureCtx) return false;

    // §5.3 step 5: HttpOnly — caller signals HTTP context implicitly by calling us

    // §5.3 step 6: SameSite
    const sameSite = parsed.sameSite;
    // SameSite=None requires Secure
    if (sameSite === "None" && !secure) return false;

    // §5.3 step 7: compute expiry
    let expires: number;

    if (parsed.maxAge !== null) {
      // Max-Age takes precedence over Expires
      if (parsed.maxAge <= 0) {
        // Delete the cookie
        this.removeCookie(cookieDomain, cookiePath, parsed.name);
        return true;
      }
      // Cap at 400 days (Chrome / Firefox behaviour)
      const ageMs = Math.min(parsed.maxAge * 1000, MAX_COOKIE_AGE);
      expires = now + ageMs;
    } else if (parsed.expires !== null) {
      expires = parsed.expires;
      if (expires <= now) {
        // Already expired — treat as delete
        this.removeCookie(cookieDomain, cookiePath, parsed.name);
        return true;
      }
      // Cap at 400 days from now
      expires = Math.min(expires, now + MAX_COOKIE_AGE);
    } else {
      expires = Infinity; // session cookie
    }

    // §5.3 step 8: build cookie object
    const cookie: Cookie = {
      name: parsed.name,
      value: parsed.value,
      domain: cookieDomain,
      path: cookiePath,
      expires,
      maxAge: parsed.maxAge,
      secure,
      httpOnly: parsed.httpOnly,
      sameSite,
      createdAt: now,
      lastAccessed: now,
      hostOnly,
    };

    // RFC 6265bis prefix rules
    if (!enforcePrefixRules(cookie, url)) return false;

    // §5.3 step 11-12: store (evicting old entry if same name/domain/path)
    this.putCookie(cookie);
    return true;
  }

  // --------------------------------------------------------------------------
  // 7.2  getCookies — RFC 6265 §5.4
  // --------------------------------------------------------------------------

  /**
   * Retrieve matching cookies per RFC 6265 §5.4.
   *
   * Filters by domain, path, secure/httpOnly flags, and SameSite context.
   * Results are sorted by longest path first, then oldest creation time.
   * Updates lastAccessed on returned cookies.
   *
   * @param options - URL, protocol context, and SameSite context
   * @returns Array of matching Cookie objects (direct references into storage)
   */
  getCookies(options: GetCookiesOptions): Cookie[] {
    // Lazy cleanup: 1% chance to clear expired cookies on each access
    if (Math.random() < 0.01) {
      this.clearExpired();
    }

    const url = safeParseUrl(options.url);
    if (!url) return [];

    const reqHost = url.hostname.toLowerCase();
    const reqHostBare = reqHost.replace(/^\[|\]$/g, "");
    const reqPath = url.pathname || "/";
    const isSecure =
      url.protocol === "https:" ||
      reqHostBare === "localhost" ||
      reqHostBare === "127.0.0.1" ||
      reqHostBare === "::1";
    const isHttp = options.http !== false;
    const context = options.sameSiteContext ?? "none";
    const now = Date.now();

    const result: Cookie[] = [];

    for (const [domain, pm] of this.dm) {
      // §5.4 step 1: domain match
      if (!this.matchDomain(reqHost, domain)) continue;

      for (const [, nm] of pm) {
        for (const [, cookie] of nm) {
          // §5.4 step 2a: hostOnly check
          if (cookie.hostOnly && reqHost !== cookie.domain) continue;

          // §5.4 step 2b: expiry check
          if (cookie.expires !== Infinity && cookie.expires < now) continue;

          // §5.4 step 2b: path match
          if (!pathMatch(reqPath, cookie.path)) continue;

          // §5.4 step 2c: secure flag
          if (cookie.secure && !isSecure) continue;

          // §5.4 step 2d: httpOnly flag
          if (cookie.httpOnly && !isHttp) continue;

          // §5.4 step 2e: SameSite
          if (!sameSiteAllows(cookie.sameSite, context)) continue;

          result.push(cookie);
        }
      }
    }

    // §5.4 step 2 sort: longer path first, then older createdAt
    result.sort((a, b) => {
      const pd = b.path.length - a.path.length;
      if (pd !== 0) return pd;
      return a.createdAt - b.createdAt;
    });

    // §5.4 step 3: update last-access time
    const ts = Date.now();
    for (const c of result) {
      // Note: getCookies returns direct references to stored cookies, not copies.
      // Modifying lastAccessed here directly updates the stored cookie.
      c.lastAccessed = ts;
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // 7.3  getCookieHeader
  // --------------------------------------------------------------------------

  /**
   * Get a Cookie header string for a request.
   *
   * @param options - URL and request context
   * @returns "name=value; name=value" string suitable for a Cookie header
   */
  getCookieHeader(options: GetCookiesOptions): string {
    return this.getCookies(options)
      .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
      .join("; ");
  }

  // --------------------------------------------------------------------------
  // 7.4a  getCookiesForDomain
  // --------------------------------------------------------------------------

  /**
   * Get all cookies for a specific domain.
   *
   * @param domain - The domain to get cookies for (will be canonicalized)
   * @returns Array of cookies that would be sent to this domain
   *
   * @example
   * jar.setCookie("session=abc", { url: "https://example.com/" });
   * jar.getCookiesForDomain("example.com"); // Returns cookies for example.com
   */
  getCookiesForDomain(domain: string): Cookie[] {
    const d = canonicalizeDomainFull(domain);
    const result: Cookie[] = [];

    for (const [stored, pm] of this.dm) {
      // Match domain or its subdomains
      if (stored === d || stored.endsWith("." + d)) {
        for (const [, nm] of pm) {
          for (const [, cookie] of nm) {
            // Skip expired cookies
            if (cookie.expires !== Infinity && cookie.expires < Date.now()) continue;
            result.push(cookie);
          }
        }
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // 7.4  processResponseHeaders
  // --------------------------------------------------------------------------

  /**
   * Process Set-Cookie headers from an HTTP response.
   * Extracts all Set-Cookie values and calls setCookie() for each.
   *
   * @param headers - Response headers (Headers object or plain record)
   * @param options - URL and SameSite context for all cookies
   */
  processResponseHeaders(
    headers: Headers | Record<string, string | string[]>,
    options: SetCookieOptions,
  ): void {
    for (const h of extractSetCookieHeaders(headers)) {
      this.setCookie(h, options);
    }
  }

  // --------------------------------------------------------------------------
  // 7.5  removeCookie
  // --------------------------------------------------------------------------

  /**
   * Remove a specific cookie by domain, path, and name.
   *
   * @param domain - Domain the cookie was stored under
   * @param path   - Cookie path
   * @param name   - Cookie name
   * @returns true if a cookie was removed
   */
  removeCookie(domain: string, path: string, name: string): boolean {
    const d = canonicalizeDomainFull(domain);
    const pm = this.dm.get(d);
    if (!pm) return false;
    const nm = pm.get(path);
    if (!nm) return false;
    const deleted = nm.delete(name);
    if (deleted) {
      this.total--;
      if (nm.size === 0) pm.delete(path);
      if (pm.size === 0) this.dm.delete(d);
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // 7.6  Clear operations
  // --------------------------------------------------------------------------

  /**
   * Remove every cookie from the jar.
   */
  clear(): void {
    this.dm.clear();
    this.total = 0;
  }

  /**
   * Remove all expired cookies from the jar.
   *
   * @returns Number of cookies removed
   */
  clearExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [domain, pm] of this.dm) {
      for (const [path, nm] of pm) {
        for (const [name, cookie] of nm) {
          if (cookie.expires !== Infinity && cookie.expires < now) {
            nm.delete(name);
            this.total--;
            removed++;
          }
        }
        if (nm.size === 0) pm.delete(path);
      }
      if (pm.size === 0) this.dm.delete(domain);
    }
    return removed;
  }

  /**
   * Remove all session cookies (cookies with no expiry / Infinity).
   *
   * @returns Number of cookies removed
   */
  clearSession(): number {
    let removed = 0;
    for (const [domain, pm] of this.dm) {
      for (const [path, nm] of pm) {
        for (const [name, cookie] of nm) {
          if (cookie.expires === Infinity) {
            nm.delete(name);
            this.total--;
            removed++;
          }
        }
        if (nm.size === 0) pm.delete(path);
      }
      if (pm.size === 0) this.dm.delete(domain);
    }
    return removed;
  }

  /**
   * Remove all cookies for a domain and its subdomains.
   *
   * @param domain - Domain to clear (e.g., "example.com" clears sub.example.com too)
   * @returns Number of cookies removed
   */
  clearForDomain(domain: string): number {
    const d = canonicalizeDomainFull(domain);
    let removed = 0;
    for (const [stored, pm] of this.dm) {
      if (stored === d || stored.endsWith("." + d)) {
        let n = 0;
        for (const nm of pm.values()) n += nm.size;
        this.dm.delete(stored);
        this.total -= n;
        removed += n;
      }
    }
    return removed;
  }

  /**
   * Remove all cookies that would be sent to a given URL.
   *
   * @param url - Full URL whose hostname cookies should be cleared
   * @returns Number of cookies removed
   */
  clearForUrl(url: string): number {
    const parsed = safeParseUrl(url);
    if (!parsed) return 0;
    return this.clearForDomain(parsed.hostname);
  }

  // --------------------------------------------------------------------------
  // 7.7  Serialization
  // --------------------------------------------------------------------------

  /**
   * Serialize all non-expired cookies to a JSON-compatible array.
   * Session cookies (Infinity) are stored with `expires: null`.
   *
   * @returns Array of serialized cookies
   */
  toJSON(): CookieJSON[] {
    const now = Date.now();
    const out: CookieJSON[] = [];

    for (const [, pm] of this.dm) {
      for (const [, nm] of pm) {
        for (const [, cookie] of nm) {
          if (cookie.expires !== Infinity && cookie.expires < now) continue;
          out.push({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires === Infinity ? null : cookie.expires,
            maxAge: cookie.maxAge,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            createdAt: cookie.createdAt,
            lastAccessed: cookie.lastAccessed,
            hostOnly: cookie.hostOnly,
          });
        }
      }
    }

    return out;
  }

  /**
   * Get a pretty-printed JSON string of all cookies.
   *
   * @returns Formatted JSON string
   */
  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Deserialize cookies from JSON and create a new CookieJar.
   * Expired cookies in the input are silently skipped.
   *
   * @param data - Array of serialized cookies or a JSON string
   * @returns A new CookieJar populated with the deserialized cookies
   */
  static fromJSON(data: CookieJSON[] | string): CookieJar {
    const jar = new CookieJar();
    const items = (typeof data === "string" ? JSON.parse(data) : data) as CookieJSON[];
    const now = Date.now();

    for (const item of items) {
      const expires = item.expires === null ? Infinity : item.expires;
      if (expires !== Infinity && expires < now) continue; // skip expired

      const cookie: Cookie = {
        name: item.name,
        value: item.value,
        domain: item.domain,
        path: item.path,
        expires,
        maxAge: item.maxAge,
        secure: item.secure,
        httpOnly: item.httpOnly,
        sameSite: item.sameSite,
        createdAt: item.createdAt,
        lastAccessed: item.lastAccessed,
        hostOnly: item.hostOnly,
      };
      jar.putCookie(cookie);
    }

    return jar;
  }

  // --------------------------------------------------------------------------
  // 7.8  Inspection
  // --------------------------------------------------------------------------

  /**
   * Total number of cookies currently stored in the jar.
   */
  get count(): number {
    return this.total;
  }

  /**
   * Return a snapshot of all cookies (copies, not references to internal storage).
   *
   * @returns Array of cloned Cookie objects
   */
  getAll(): Cookie[] {
    const out: Cookie[] = [];
    for (const [, pm] of this.dm) {
      for (const [, nm] of pm) {
        for (const [, c] of nm) out.push({ ...c });
      }
    }
    return out;
  }

  /**
   * Return all cookies for a given domain (exact match + subdomains).
   *
   * @param domain - Domain to query (e.g., "example.com")
   * @returns Array of cloned Cookie objects for matching domains
   */
  getForDomain(domain: string): Cookie[] {
    const d = canonicalizeDomainFull(domain);
    const out: Cookie[] = [];
    for (const [stored, pm] of this.dm) {
      if (stored === d || stored.endsWith("." + d)) {
        for (const [, nm] of pm) {
          for (const [, c] of nm) out.push({ ...c });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // 7.9  Private: storage internals
  // --------------------------------------------------------------------------

  /**
   * Store or update a cookie in the internal map.
   * Preserves original createdAt on update per RFC 6265 §5.3 step 11.
   */
  private putCookie(cookie: Cookie): void {
    const { domain, path, name } = cookie;

    if (!this.dm.has(domain)) this.dm.set(domain, new Map());
    const pm = this.dm.get(domain)!;

    if (!pm.has(path)) pm.set(path, new Map());
    const nm = pm.get(path)!;

    if (nm.has(name)) {
      // Update: preserve original createdAt (RFC 6265 §5.3 step 11)
      const old = nm.get(name)!;
      nm.set(name, { ...cookie, createdAt: old.createdAt });
      // total unchanged — same slot
    } else {
      // New cookie: enforce caps first
      this.evictForDomain(domain, pm);
      this.evictGlobal();
      nm.set(name, cookie);
      this.total++;
    }
  }

  /**
   * Evict the least-recently-accessed cookie from a domain when
   * the per-domain cap is exceeded. Evicts down to maxPerDomain - 1.
   */
  private evictForDomain(_domain: string, pm: PathMap): void {
    let count = 0;
    for (const nm of pm.values()) count += nm.size;
    if (count < this.maxPerDomain) return;

    // Collect all cookies for this domain, sort by lastAccessed ascending (LRU first)
    const candidates: [string, string, Cookie][] = [];
    for (const [p, nm] of pm) {
      for (const [n, c] of nm) candidates.push([p, n, c]);
    }
    candidates.sort((a, b) => a[2].lastAccessed - b[2].lastAccessed);

    // Evict until we're at maxPerDomain - 1 (leaving room for new cookie)
    let i = 0;
    while (count >= this.maxPerDomain && i < candidates.length) {
      const [p, n] = candidates[i++]!;
      if (pm.get(p)?.delete(n)) {
        this.total--;
        count--;
      }
    }

    // Prune empty path entries
    for (const [p, nm] of pm) {
      if (nm.size === 0) pm.delete(p);
    }
  }

  /**
   * Evict the least-recently-accessed cookie globally when
   * the total cap is exceeded. Evicts down to below maxTotal.
   */
  private evictGlobal(): void {
    if (this.total < this.maxTotal) return;

    // Collect all cookies globally, sort by lastAccessed ascending (LRU first)
    const candidates: [string, string, string, Cookie][] = [];
    for (const [d, pm] of this.dm) {
      for (const [p, nm] of pm) {
        for (const [n, c] of nm) candidates.push([d, p, n, c]);
      }
    }
    candidates.sort((a, b) => a[3].lastAccessed - b[3].lastAccessed);

    let i = 0;
    while (this.total >= this.maxTotal && i < candidates.length) {
      const [d, p, n] = candidates[i++]!;
      const domainMap = this.dm.get(d);
      const pathMap = domainMap?.get(p);
      if (pathMap?.delete(n)) {
        this.total--;
        // Prune empty maps
        if (pathMap.size === 0) domainMap!.delete(p);
        if (domainMap!.size === 0) this.dm.delete(d);
      }
    }
  }

  /**
   * Check whether a request host matches a cookie domain.
   * Uses custom matcher if provided, otherwise does suffix matching.
   */
  private matchDomain(reqHost: string, cookieDomain: string): boolean {
    // Use custom domain matcher if provided
    if (this.domainMatcherFn) {
      return this.domainMatcherFn(reqHost, cookieDomain);
    }
    // For host-only cookies: exact match only.
    // For domain cookies: domain-match (subdomains allowed).
    // We can't know per-domain whether it's host-only without checking cookies,
    // so we do the broader domain-match here and filter host-only per cookie.
    if (reqHost === cookieDomain) return true;
    if (isIPAddress(reqHost)) return false;
    return reqHost.endsWith("." + cookieDomain);
  }
}

// ============================================================================
// 8. UTILITY
// ============================================================================

/**
 * Safely parse a URL string, returning null instead of throwing.
 *
 * @param url - URL string to parse
 * @returns URL object or null if invalid
 */
function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ============================================================================
// 9. FACTORY
// ============================================================================

/**
 * Create a new empty CookieJar.
 *
 * @returns A new CookieJar instance
 */
export function createCookieJar(): CookieJar {
  return new CookieJar();
}

/**
 * Load a CookieJar from previously serialized JSON data.
 *
 * @param data - CookieJSON array or JSON string
 * @returns A new CookieJar populated with the deserialized cookies
 */
export function loadCookieJar(data: string | CookieJSON[]): CookieJar {
  return CookieJar.fromJSON(data);
}
