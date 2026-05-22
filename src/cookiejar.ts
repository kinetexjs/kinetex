/**
 * cookiejar.ts — Public API barrel
 *
 * Single import point. Re-exports everything you need from the two
 * implementation files so callers never need to know the internal split.
 *
 * Usage:
 *   import { CookieJar, createCookieJar, loadCookieJar } from "./cookiejar.ts";
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUICK REFERENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Creating a jar
 *
 *   const jar = createCookieJar();
 *
 * ## Setting cookies from a server response
 *
 *   // From a fetch() Response:
 *   jar.processResponseHeaders(response.headers, { url: "https://example.com/login" });
 *
 *   // From a raw Set-Cookie header string:
 *   jar.setCookie("session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax", {
 *     url: "https://example.com/login",
 *   });
 *
 * ## Sending cookies with a request
 *
 *   const cookieHeader = jar.getCookieHeader({ url: "https://example.com/api" });
 *   // → "session=abc123"
 *
 *   const cookies = jar.getCookies({ url: "https://example.com/api" });
 *   // → Cookie[]
 *
 * ## SameSite context
 *
 *   // Cross-site fetch (e.g. embedded image from third-party page):
 *   jar.getCookieHeader({
 *     url: "https://api.example.com/data",
 *     sameSiteContext: "cross-site",   // blocks Strict + Lax cookies
 *   });
 *
 *   // Top-level navigation (GET, cross-site):
 *   jar.getCookieHeader({
 *     url: "https://example.com/",
 *     sameSiteContext: "lax",          // blocks Strict, allows Lax
 *   });
 *
 *   // Same-site request:
 *   jar.getCookieHeader({
 *     url: "https://api.example.com/data",
 *     sameSiteContext: "strict",       // allows all
 *   });
 *
 * ## Script / document context (HttpOnly enforcement)
 *
 *   jar.getCookies({ url: "https://example.com/", http: false });
 *   // HttpOnly cookies are excluded
 *
 * ## Removing cookies
 *
 *   jar.removeCookie("example.com", "/", "session");  // Single cookie by domain+path+name
 *   jar.clearForDomain("example.com");                // All cookies for domain + subdomains
 *   jar.clearForUrl("https://example.com/path");      // All cookies for URL's domain+path
 *   jar.clearExpired();                               // Remove all expired cookies
 *   jar.clearSession();                                // Remove all session cookies (no expiry)
 *   jar.clear();                                       // Remove all cookies completely
 *
 * ### Clear methods explained:
 * - `removeCookie(domain, path, name)` - Remove one specific cookie
 * - `clearForDomain(domain)` - Clear all cookies for a domain and its subdomains
 * - `clearForUrl(url)` - Clear all cookies that would be sent to a specific URL
 * - `clearExpired()` - Remove cookies that have passed their expiration time
 * - `clearSession()` - Remove all session cookies (cookies without Expires/Max-Age)
 * - `clear()` - Nuke everything
 *
 * ## Persistence
 *
 *   // Save:
 *   const json = jar.toString();               // JSON string
 *   await Deno.writeTextFile("cookies.json", json);
 *
 *   // Load:
 *   const saved = await Deno.readTextFile("cookies.json");
 *   const jar2 = loadCookieJar(saved);
 *
 * ### Serialization format
 *
 * The jar serializes to a JSON array of CookieJSON objects:
 * ```json
 * [
 *   {
 *     "name": "session",
 *     "value": "abc123",
 *     "domain": "example.com",
 *     "path": "/",
 *     "expires": null,
 *     "maxAge": 3600,
 *     "secure": true,
 *     "httpOnly": true,
 *     "sameSite": "Lax",
 *     "createdAt": 1704067200000,
 *     "lastAccessed": 1704070800000,
 *     "hostOnly": false
 *   }
 * ]
 * ```
 *
 * Note: Expired cookies are filtered out during serialization (toJSON excludes them).
 * Session cookies (no expiry) have `expires: null`.
 *
 * ## Integration with fetch (Deno / Node)
 *
 *   async function fetchWithCookies(jar: CookieJar, url: string, init?: RequestInit) {
 *     const cookieHeader = jar.getCookieHeader({
 *       url,
 *       http: true,
 *       sameSiteContext: "strict",
 *     });
 *
 *     const headers = new Headers(init?.headers);
 *     if (cookieHeader) headers.set("Cookie", cookieHeader);
 *
 *     const response = await fetch(url, { ...init, headers });
 *
 *     jar.processResponseHeaders(response.headers, { url });
 *
 *     return response;
 *   }
 *
 * ### Set-Cookie handling
 *
 * `processResponseHeaders()` handles both formats:
 * - `Set-Cookie` - Standard RFC 6265 header (single cookie per header)
 * - `Set-Cookie2` - RFC 2965 legacy format (rare, still parsed)
 *
 * For Headers objects, it uses `getSetCookie()` when available (Node 18+, Deno, Bun)
 * to get all cookies. For plain objects, it handles both single values and arrays.
 *
 * ## Low-level utilities
 *
 *   import {
 *     parseCookieDate,
 *     parseSetCookieHeader,
 *     getPublicSuffix,
 *     getRegistrableDomain,
 *     isPublicSuffix,
 *     domainMatch,
 *     pathMatch,
 *     defaultPath,
 *     canonicalizeDomainFull,
 *     isIPAddress,
 *     decodeIDNLabel,
 *     splitSetCookieHeaders,
 *     extractSetCookieHeaders,
 *   } from "./cookiejar.ts";
 */

// ── Core jar ─────────────────────────────────────────────────────────────────
/* creates a new CookieJar — see createCookieJar() in cookie-store.ts */

export { CookieJar, createCookieJar, loadCookieJar } from "./cookie-store.ts";

/*
 * loadCookieJar — deserializes cookies from JSON.
 * See loadCookieJar() in cookie-store.ts for full docs.
 */

export type {
  Cookie,
  CookieJSON,
  SetCookieOptions,
  GetCookiesOptions,
  SameSiteContext,
  /** Options for creating a CookieJar with custom limits */
  CookieJarOptions,
} from "./cookie-store.ts";

// ── Parser + utilities ────────────────────────────────────────────────────────
export {
  // Date parsing
  parseCookieDate,
  // Cookie parsing & serialization
  parseSetCookieHeader,
  formatSetCookieHeader,
  // Public Suffix List
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  // Matching
  domainMatch,
  pathMatch,
  normalizePath,
  // Utilities
  defaultPath,
  canonicalizeDomainFull,
  isIPAddress,
  decodeIDNLabel,
  // Header handling
  splitSetCookieHeaders,
  extractSetCookieHeaders,
} from "./cookie-parser.ts";

export type { SameSite, ParsedCookie } from "./cookie-parser.ts";
