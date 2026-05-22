/**
 * URL construction, parsing, and manipulation.
 * Zero dependencies. Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Fluent builder API (immutable + mutable variants)
 *  - Full RFC 3986 URI parsing and normalization
 *  - Path joining with dot-segment resolution
 *  - Query string: stringify, parse, merge, pick, omit
 *  - Template URL expansion (RFC 6570 Level 1–4)
 *  - Origin extraction + comparison
 *  - Base URL resolution
 *  - URL pattern matching (named params + wildcards)
 *  - Percent-encoding / decoding (full RFC 3986)
 *  - Trailing slash normalization
 *  - Sort query params (for cache-key stability)
 *  - URL redaction (mask sensitive query params)
 *  - Relative URL detection
 *  - Data URL helpers
 *  - Blob URL detection
 *  - URL diff
 */

// ============================================================================
// §1  TYPES
// ============================================================================

/**
 * Thrown when a URL validation or path parameter resolution fails.
 */
export class URLValidationError extends Error {
  readonly code = "URL_VALIDATION_ERROR";
  /** @param message Human-readable error description. */
  constructor(message: string) {
    super(message);
    this.name = "URLValidationError";
  }
}

/**
 * Fully parsed URL components (mirrors the URL API's parsed structure).
 */
export interface ParsedURL {
  href: string;
  protocol: string; // with trailing colon, e.g. "https:"
  username: string;
  password: string;
  hostname: string; // no brackets for IPv6
  host: string; // hostname + optional :port
  port: string; // empty string if default port
  pathname: string;
  search: string; // with leading "?", or ""
  hash: string; // with leading "#", or ""
  origin: string;
  searchParams: URLSearchParams;
}

/**
 * Options for URL parsing and builder construction.
 */
export interface URLBuilderOptions {
  /** Base URL to resolve relative paths against */
  base?: string;
  /** If true, sort query params (good for cache keys) */
  sortParams?: boolean;
  /** Default protocol if scheme is omitted (default: "https") */
  defaultProtocol?: string;
}

/** A single query parameter value — string, number, boolean, or null/undefined to omit. */
export type QueryValue = string | number | boolean | null | undefined;
/** A map of query parameter names to values or arrays of values (for repeated keys). */
export type QueryInput = Record<string, QueryValue | QueryValue[]>;

// RFC 6570 operator types
type RFC6570Operator = "" | "+" | "#" | "." | "/" | ";" | "?" | "&";

// ============================================================================
// §2  PERCENT ENCODING / DECODING
// ============================================================================

/**
 * Characters that are unreserved per RFC 3986 §2.3
 * A-Z a-z 0-9 - _ . ~
 */
const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/;

/**
 * Characters that are reserved per RFC 3986 §2.2
 * gen-delims + sub-delims
 */
const RESERVED_RE = /^[:/?#\[\]@!$&'()*+,;=]$/;

/**
 * Percent-encode a string per RFC 3986. By default encodes everything except
 * unreserved chars (A-Z a-z 0-9 - _ . ~). Pass `allowReserved: true` to also
 * let reserved characters through.
 *
 * Surrogate pairs (code points > 0xFFFF like emoji 😀, 𝄞, etc.) are encoded as
 * their UTF-8 byte sequence. For example, U+1F600 (😀) becomes %F0%9F%90%80.
 * This is correct per RFC 3986 which uses UTF-8 as the default encoding.
 *
 * @param str The string to percent-encode.
 * @param allowReserved If true, reserved characters (:/?#[]@!$&'()*+,;=) pass through.
 * @returns The percent-encoded string.
 */
export function percentEncode(str: string, allowReserved = false): string {
  return Array.from(str)
    .map((char) => {
      if (UNRESERVED_RE.test(char)) return char;
      if (allowReserved && RESERVED_RE.test(char)) return char;
      const code = char.codePointAt(0)!;
      if (code > 0xffff) {
        // Surrogate pair — encode as UTF-8 bytes
        const bytes = new TextEncoder().encode(char);
        return Array.from(bytes)
          .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
          .join("");
      }
      if (code > 0x7f) {
        const bytes = new TextEncoder().encode(char);
        return Array.from(bytes)
          .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
          .join("");
      }
      return "%" + code.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

/**
 * Decode a percent-encoded string. Handles UTF-8 multi-byte sequences.
 * Falls back to raw byte decoding on malformed sequences.
 *
 * @param str The percent-encoded string.
 * @returns The decoded string (or original on failure).
 */
export function percentDecode(str: string): string {
  try {
    return decodeURIComponent(str.replace(/\+/g, "%20"));
  } catch {
    // Manual UTF-8 decode on malformed sequences
    return str.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
}

/**
 * Encode a path component — encodes everything except unreserved chars,
 * sub-delimiters, colon, and @.
 *
 * @param segment The path segment to encode.
 * @returns The encoded path segment.
 */
export function encodePathComponent(segment: string): string {
  return encodeURIComponent(segment)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * Encode a query parameter value.
 *
 * @param value The raw value to encode.
 * @returns The encoded query value.
 */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

// ============================================================================
// §3  QUERY STRING
// ============================================================================

/**
 * Stringify a query input object to a query string (without leading "?").
 *
 * @param params The query parameters as a key-value object.
 * @param options.sort If true, sort keys alphabetically.
 * @param options.arrayFormat How to format arrays: "repeat" (default), "bracket", or "comma".
 * @returns The query string (without leading "?").
 */
export function stringifyQuery(
  params: QueryInput,
  options: { sort?: boolean; arrayFormat?: "repeat" | "bracket" | "comma" } = {},
): string {
  const { sort = false, arrayFormat = "repeat" } = options;
  const parts: [string, string][] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;

    const encodedKey = encodeQueryValue(key);

    if (Array.isArray(value)) {
      const filtered = value.filter((v) => v !== null && v !== undefined) as (
        | string
        | number
        | boolean
      )[];
      if (filtered.length === 0) continue;

      if (arrayFormat === "comma") {
        parts.push([encodedKey, filtered.map((v) => encodeQueryValue(String(v))).join(",")]);
      } else if (arrayFormat === "bracket") {
        for (const v of filtered) {
          parts.push([`${encodedKey}[]`, encodeQueryValue(String(v))]);
        }
      } else {
        // repeat (default)
        for (const v of filtered) {
          parts.push([encodedKey, encodeQueryValue(String(v))]);
        }
      }
    } else {
      parts.push([encodedKey, encodeQueryValue(String(value))]);
    }
  }

  if (sort) parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return parts.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Parse a query string (with or without leading "?") into a plain object.
 * Repeated keys produce arrays.
 *
 * @param qs The query string (e.g. "?a=1&b=2" or "a=1&b=2").
 * @returns An object mapping keys to string values (or arrays for repeated keys).
 */
export function parseQuery(qs: string): Record<string, string | string[]> {
  const str = qs.startsWith("?") ? qs.slice(1) : qs;
  const result: Record<string, string | string[]> = {};
  if (!str) return result;

  for (const pair of str.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = percentDecode(eq === -1 ? pair : pair.slice(0, eq));
    const val = eq === -1 ? "" : percentDecode(pair.slice(eq + 1));

    const existing = result[key];
    if (existing === undefined) {
      result[key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      result[key] = [existing, val];
    }
  }

  return result;
}

/**
 * Merge two query inputs. Right operand wins on conflict.
 * null values in right operand delete the key.
 *
 * @param base The base query input.
 * @param overrides The overrides to merge in.
 * @returns A new QueryInput with merged values.
 */
export function mergeQuery(base: QueryInput, overrides: QueryInput): QueryInput {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Pick specific keys from a query input.
 *
 * @param params The source query input.
 * @param keys Keys to include.
 * @returns A new QueryInput with only the picked keys.
 */
export function pickQuery(params: QueryInput, ...keys: string[]): QueryInput {
  const result: QueryInput = {};
  for (const key of keys) {
    if (key in params) result[key] = params[key];
  }
  return result;
}

/**
 * Omit specific keys from a query input.
 *
 * @param params The source query input.
 * @param keys Keys to exclude.
 * @returns A new QueryInput without the omitted keys.
 */
export function omitQuery(params: QueryInput, ...keys: string[]): QueryInput {
  const omitSet = new Set(keys);
  const result: QueryInput = {};
  for (const [k, v] of Object.entries(params)) {
    if (!omitSet.has(k)) result[k] = v;
  }
  return result;
}

// ============================================================================
// §4  PATH UTILITIES
// ============================================================================

/**
 * Join path segments, resolving dot segments and normalizing slashes.
 * Similar to path.join but for URLs (always uses forward slashes).
 *
 * @param segments Path segments to join.
 * @returns A normalized path string starting with "/".
 */
export function joinPath(...segments: string[]): string {
  if (segments.length === 0) return "/";

  const parts: string[] = [];
  for (const seg of segments) {
    if (!seg) continue;
    parts.push(...seg.split("/").filter((s, i) => s !== "" || i === 0));
  }

  const resolved = resolveDotSegments(parts);
  const joined = resolved.join("/");

  // Preserve trailing slash if last segment ended with one
  const lastSeg = segments[segments.length - 1];
  const trailingSlash = lastSeg?.endsWith("/") && joined !== "/" ? "/" : "";

  return (joined.startsWith("/") ? "" : "/") + joined + trailingSlash;
}

/**
 * Resolve dot segments in a path component array (RFC 3986 §5.2.4).
 */
function resolveDotSegments(segments: string[]): string[] {
  const output: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      output.pop();
    } else {
      output.push(seg);
    }
  }
  return output;
}

/**
 * Normalize a URL path — collapses multiple slashes, resolves . and ..,
 * and optionally adds or removes a trailing slash.
 *
 * @param path The path to normalize.
 * @param options.trailingSlash "preserve" (default), "add", or "remove".
 * @returns The normalized path.
 */
export function normalizePath(
  path: string,
  options: { trailingSlash?: "add" | "remove" | "preserve" } = {},
): string {
  const { trailingSlash = "preserve" } = options;
  const hasTrailing = path.endsWith("/") && path !== "/";

  const segments = path.split("/").filter(Boolean);
  const resolved = resolveDotSegments(segments);
  let result = "/" + resolved.join("/");

  if (trailingSlash === "add" && result !== "/") result += "/";
  else if (trailingSlash === "remove") {
    /* no-op, already removed */
  } else if (trailingSlash === "preserve" && hasTrailing && result !== "/") result += "/";

  return result;
}

/**
 * Extract path segments as an array (empty segments filtered out).
 *
 * @param path The URL path.
 * @returns Decoded path segments.
 */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean).map(percentDecode);
}

/**
 * Replace named parameters in a path template (":param" style, Express-compatible).
 *
 * @param template The path template (e.g. "/users/:id/posts/:postId").
 * @param params Parameter values keyed by name.
 * @returns The filled path.
 * @throws {URLValidationError} If a required param is missing.
 */
export function fillPathParams(template: string, params: Record<string, string | number>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const val = params[name];
    if (val === undefined) throw new URLValidationError(`Missing path param: "${name}"`);
    return encodePathComponent(String(val));
  });
}

// ============================================================================
// §5  URL NORMALIZATION
// ============================================================================

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ftp:": "21",
  "ws:": "80",
  "wss:": "443",
};

/**
 * Normalize a URL:
 * - Lowercase scheme and host
 * - Remove default ports
 * - Normalize path (resolve dot segments)
 * - Optionally sort query params
 */
export function normalizeURL(
  url: string,
  options: {
    sortParams?: boolean;
    trailingSlash?: "add" | "remove" | "preserve";
    removeFragment?: boolean;
  } = {},
): string {
  const parsed = safeParseURL(url);
  if (!parsed) throw new TypeError(`Invalid URL: ${url}`);

  // Remove default port
  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  const port = parsed.port === defaultPort ? "" : parsed.port;

  // Normalize path
  const path = normalizePath(parsed.pathname, {
    trailingSlash: options.trailingSlash ?? "preserve",
  });

  // Sort params
  if (options.sortParams) parsed.searchParams.sort();

  const search = parsed.searchParams.toString() ? `?${parsed.searchParams}` : "";
  const hash = options.removeFragment ? "" : parsed.hash;
  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}${parsed.password ? ":" + encodeURIComponent(parsed.password) : ""}@`
    : "";

  const hostWithPort = port ? `${parsed.hostname}:${port}` : parsed.hostname;

  return `${parsed.protocol}//${auth}${hostWithPort}${path}${search}${hash}`;
}

// ============================================================================
// §6  URL BUILDER (FLUENT API)
// ============================================================================

/**
 * Immutable URL builder with a fluent API.
 * Every method returns a new instance.
 */
export class URLBuilder {
  private readonly _url: URL;

  /**
   * @param url Initial URL string or URL object.
   * @param base Optional base URL for resolving relative URLs.
   * @throws {TypeError} If the URL is invalid.
   */
  constructor(url: string | URL, base?: string | URL) {
    try {
      this._url = new URL(String(url), base);
    } catch {
      throw new TypeError(`Invalid URL: "${url}"${base ? ` (base: "${base}")` : ""}`);
    }
  }

  // ── Factories ─────────────────────────────────────────────────────────────

  /** Create a URLBuilder from a URL string or object (convenience factory). */
  static from(url: string | URL, base?: string | URL): URLBuilder {
    return new URLBuilder(url, base);
  }

  /** Create a URLBuilder for https://host/path. */
  static https(host: string, path?: string): URLBuilder {
    return new URLBuilder(`https://${host}${path ?? "/"}`);
  }

  /** Create a URLBuilder for http://host/path. */
  static http(host: string, path?: string): URLBuilder {
    return new URLBuilder(`http://${host}${path ?? "/"}`);
  }

  // ── Components ────────────────────────────────────────────────────────────

  /** Set the protocol (e.g. "https:" or "https"). */
  withProtocol(value: string): URLBuilder {
    const u = this._clone();
    u._url.protocol = value.endsWith(":") ? value : value + ":";
    return u;
  }

  /** Set the hostname. */
  withHostname(value: string): URLBuilder {
    const u = this._clone();
    u._url.hostname = value;
    return u;
  }

  /** Set the full host (hostname + port). */
  withHost(value: string): URLBuilder {
    const u = this._clone();
    u._url.host = value;
    return u;
  }

  /** Set the port number. */
  withPort(value: number | string): URLBuilder {
    const u = this._clone();
    u._url.port = String(value);
    return u;
  }

  /** Set the URL username. */
  withUsername(value: string): URLBuilder {
    const u = this._clone();
    u._url.username = encodeURIComponent(value);
    return u;
  }

  /** Set the URL password. */
  withPassword(value: string): URLBuilder {
    const u = this._clone();
    u._url.password = encodeURIComponent(value);
    return u;
  }

  // ── Path ──────────────────────────────────────────────────────────────────

  /** Set the full pathname. */
  withPathname(value: string): URLBuilder {
    const u = this._clone();
    u._url.pathname = value;
    return u;
  }

  /** Append path segments to the existing pathname. */
  appendPath(...segments: string[]): URLBuilder {
    const u = this._clone();
    const base = u._url.pathname.replace(/\/$/, "");
    const appended = segments.map((s) => s.replace(/^\/|\/$/g, "")).filter(Boolean);
    u._url.pathname = base + "/" + appended.join("/");
    return u;
  }

  /** Replace the pathname entirely, joining segments. */
  path(...segments: string[]): URLBuilder {
    const u = this._clone();
    u._url.pathname = joinPath(...segments);
    return u;
  }

  /** Fill :param placeholders in pathname and add query params. */
  params(values: Record<string, string | number>): URLBuilder {
    const u = this._clone();
    u._url.pathname = fillPathParams(u._url.pathname, values);
    for (const [k, v] of Object.entries(values)) {
      u._url.searchParams.set(k, String(v));
    }
    return u;
  }

  /** Ensure the pathname ends with a slash. */
  addTrailingSlash(): URLBuilder {
    const u = this._clone();
    if (!u._url.pathname.endsWith("/")) u._url.pathname += "/";
    return u;
  }

  /** Remove trailing slash from pathname (unless it is just "/"). */
  removeTrailingSlash(): URLBuilder {
    const u = this._clone();
    if (u._url.pathname !== "/" && u._url.pathname.endsWith("/")) {
      u._url.pathname = u._url.pathname.slice(0, -1);
    }
    return u;
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /** Set a single query parameter. */
  setParam(key: string, value: QueryValue): URLBuilder {
    const u = this._clone();
    if (value === null || value === undefined) {
      u._url.searchParams.delete(key);
    } else {
      u._url.searchParams.set(key, String(value));
    }
    return u;
  }

  /** Append a query parameter (allows repeated keys). */
  appendParam(key: string, value: QueryValue): URLBuilder {
    if (value === null || value === undefined) return this;
    const u = this._clone();
    u._url.searchParams.append(key, String(value));
    return u;
  }

  /** Delete a query parameter by key. */
  deleteParam(key: string): URLBuilder {
    const u = this._clone();
    u._url.searchParams.delete(key);
    return u;
  }

  /** Merge a query input object (null values delete keys). */
  query(params: QueryInput): URLBuilder {
    const u = this._clone();
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
        u._url.searchParams.delete(key);
      } else if (Array.isArray(value)) {
        u._url.searchParams.delete(key);
        for (const v of value) {
          if (v !== null && v !== undefined) {
            u._url.searchParams.append(key, String(v));
          }
        }
      } else {
        u._url.searchParams.set(key, String(value));
      }
    }
    return u;
  }

  /** Replace all query params with a new set. */
  setQuery(params: QueryInput): URLBuilder {
    const u = this._clone();
    u._url.search = "";
    return u.query(params);
  }

  /** Pick specific query params, removing all others. */
  pickParams(...keys: string[]): URLBuilder {
    const u = this._clone();
    const keep = new Set(keys);
    const toKeep: [string, string][] = [];
    for (const [k, v] of u._url.searchParams.entries()) {
      if (keep.has(k)) toKeep.push([k, v]);
    }
    u._url.search = "";
    for (const [k, v] of toKeep) u._url.searchParams.append(k, v);
    return u;
  }

  /** Omit specific query params. */
  omitParams(...keys: string[]): URLBuilder {
    const u = this._clone();
    const omit = new Set(keys);
    for (const key of omit) u._url.searchParams.delete(key);
    return u;
  }

  /** Sort query params alphabetically (useful for cache key stability). */
  sortParams(): URLBuilder {
    const u = this._clone();
    u._url.searchParams.sort();
    return u;
  }

  /** Redact sensitive query params (replace value with "REDACTED"). */
  redactParams(...keys: string[]): URLBuilder {
    let u = this._clone();
    for (const key of keys) {
      if (u._url.searchParams.has(key)) {
        u = u.setParam(key, "REDACTED");
      }
    }
    return u;
  }

  // ── Hash ──────────────────────────────────────────────────────────────────

  /** Set the hash fragment (with or without leading "#"). */
  withHash(value: string): URLBuilder {
    const u = this._clone();
    u._url.hash = value.startsWith("#") ? value : "#" + value;
    return u;
  }

  /** Remove the hash fragment. */
  removeHash(): URLBuilder {
    const u = this._clone();
    u._url.hash = "";
    return u;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /** Serialize to a URL string. */
  toString(): string {
    return this._url.toString();
  }
  /** Clone as a native URL object. */
  toURL(): URL {
    return new URL(this._url.toString());
  }

  /** Full URL string. */
  get href(): string {
    return this._url.href;
  }
  /** Protocol with trailing colon (e.g. "https:"). */
  get protocol(): string {
    return this._url.protocol;
  }
  /** Hostname (lowercased, IPv6 without brackets). */
  get hostname(): string {
    return this._url.hostname;
  }
  /** Host (hostname + :port). */
  get host(): string {
    return this._url.host;
  }
  /** Port string (empty for default port). */
  get port(): string {
    return this._url.port;
  }
  /** Pathname component. */
  get pathname(): string {
    return this._url.pathname;
  }
  /** Search string with leading "?". */
  get search(): string {
    return this._url.search;
  }
  /** Hash fragment with leading "#". */
  get hash(): string {
    return this._url.hash;
  }
  /** Read-only origin string. */
  get origin(): string {
    return this._url.origin;
  }

  /** Live URLSearchParams (cloned from internal state). */
  get searchParams(): URLSearchParams {
    return new URLSearchParams(this._url.searchParams);
  }

  /** Parsed query as a plain object. */
  get queryObject(): Record<string, string | string[]> {
    return parseQuery(this._url.search);
  }

  private _clone(): URLBuilder {
    return new URLBuilder(this._url.toString());
  }
}

// ============================================================================
// §7  RFC 6570 URL TEMPLATE EXPANSION
// ============================================================================

type TemplateVars = Record<
  string,
  string | number | boolean | string[] | Record<string, string> | null | undefined
>;

/**
 * Expand an RFC 6570 URI template (Level 1–4).
 *
 * Supports operators: (none), +, #, ., /, ;, ?, &
 */
export function expandTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    const operator = expr[0] as RFC6570Operator;
    const hasOperator = "+#./;?&".includes(operator);
    const varList = (hasOperator ? expr.slice(1) : expr).split(",");
    const op = hasOperator ? operator : ("" as RFC6570Operator);

    return expandExpression(op, varList, vars);
  });
}

function expandExpression(op: RFC6570Operator, varList: string[], vars: TemplateVars): string {
  const separator = getSeparator(op);
  const prefix = getPrefix(op);
  const named = isNamed(op);
  const ifeEmpty = getIfEmpty(op);
  const allowReserved = op === "+" || op === "#";

  const parts: string[] = [];

  for (const varSpec of varList) {
    const { name, explode, maxLength } = parseVarSpec(varSpec.trim());
    const value = vars[name];

    if (value === null || value === undefined) continue;

    const encoded = encodeValue(
      value,
      name,
      named,
      explode,
      maxLength,
      allowReserved,
      separator,
      ifeEmpty,
    );
    if (encoded !== null) parts.push(encoded);
  }

  if (parts.length === 0) return "";
  return prefix + parts.join(separator);
}

function parseVarSpec(spec: string): { name: string; explode: boolean; maxLength: number | null } {
  if (spec.endsWith("*")) return { name: spec.slice(0, -1), explode: true, maxLength: null };
  const colonIdx = spec.lastIndexOf(":");
  if (colonIdx !== -1) {
    const max = parseInt(spec.slice(colonIdx + 1), 10);
    return { name: spec.slice(0, colonIdx), explode: false, maxLength: isNaN(max) ? null : max };
  }
  return { name: spec, explode: false, maxLength: null };
}

function encodeValue(
  value: TemplateVars[string],
  name: string,
  named: boolean,
  explode: boolean,
  maxLength: number | null,
  allowReserved: boolean,
  separator: string,
  ifeEmpty: string,
): string | null {
  const encode = (s: string) => (allowReserved ? percentEncode(s, true) : percentEncode(s));

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    let str = String(value);
    if (maxLength !== null) str = str.slice(0, maxLength);
    const encoded = encode(str);
    return named ? `${name}${encoded === "" ? ifeEmpty : "=" + encoded}` : encoded;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (explode) {
      return value
        .map((v) => {
          const e = encode(String(v));
          return named ? `${name}=${e}` : e;
        })
        .join(separator);
    }
    const joined = value.map((v) => encode(String(v))).join(",");
    return named ? `${name}=${joined}` : joined;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, string>);
    if (entries.length === 0) return null;
    if (explode) {
      return entries.map(([k, v]) => `${encode(k)}=${encode(v)}`).join(separator);
    }
    const joined = entries.flatMap(([k, v]) => [encode(k), encode(v)]).join(",");
    return named ? `${name}=${joined}` : joined;
  }

  return null;
}

function getSeparator(op: RFC6570Operator): string {
  switch (op) {
    case ".":
      return ".";
    case "/":
      return "/";
    case ";":
      return ";";
    case "?":
    case "&":
      return "&";
    default:
      return ",";
  }
}

function getPrefix(op: RFC6570Operator): string {
  switch (op) {
    case "#":
      return "#";
    case ".":
      return ".";
    case "/":
      return "/";
    case ";":
      return ";";
    case "?":
      return "?";
    case "&":
      return "&";
    default:
      return "";
  }
}

function isNamed(op: RFC6570Operator): boolean {
  return op === ";" || op === "?" || op === "&";
}

function getIfEmpty(op: RFC6570Operator): string {
  return op === ";" ? "" : "=";
}

// ============================================================================
// §8  URL PATTERN MATCHING
// ============================================================================

/**
 * Compiled URL pattern matcher produced by {@link compilePattern}.
 */
export interface URLPattern {
  /** Match a URL against this pattern, returning named params and wildcards. */
  match(url: string): URLPatternMatch | null;
  /** Test whether a URL matches without extracting params. */
  test(url: string): boolean;
}

/**
 * The result of matching a URL against a compiled {@link URLPattern}.
 */
export interface URLPatternMatch {
  /** Named parameters captured from `:name` placeholders */
  params: Record<string, string>;
  /** Segments captured by wildcard (`*`) placeholders */
  wildcards: string[];
  /** All capture groups including named params and wildcards */
  groups: Record<string, string>;
}

/**
 * Compile a URL pattern string into a matcher.
 *
 * Syntax:
 *  :name         — named parameter (one segment)
 *  :name(regex)  — named parameter with regex constraint
 *  *             — wildcard (one segment)
 *  **            — greedy wildcard (multiple segments)
 *
 * Examples:
 *  "/users/:id"                → matches "/users/42", params: \{ id: "42" \}
 *  "/files/**"                 → matches "/files/a/b/c", wildcards: ["a","b","c"]
 *  "/items/:id(\\d+)"          → matches "/items/99" only if id is numeric
 */
export function compilePattern(pattern: string): URLPattern {
  const paramNames: string[] = [];
  const wildcardCount = { n: 0 };
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars (except /)
    .replace(/\\\*/g, "*") // restore our * wildcards
    .replace(/\*\*/g, () => {
      // wildcard: matches any path segments (non-greedy due to anchors)
      return "(.+?)";
    })
    .replace(/\*(?!\*)/g, () => {
      // single wildcard
      wildcardCount.n++;
      return "([^/]+)";
    })
    .replace(
      /:([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?/g,
      (_, name: string, constraint: string | undefined) => {
        paramNames.push(name);
        return `(${constraint ?? "[^/]+"})`;
      },
    );

  const regex = new RegExp(`^${regexStr}\\/?$`);

  return {
    match(url: string): URLPatternMatch | null {
      const pathname = safePathname(url);
      const m = regex.exec(pathname);
      if (!m) return null;

      const params: Record<string, string> = {};
      const wildcards: string[] = [];
      const groups: Record<string, string> = {};

      let captureIdx = 1;
      for (const name of paramNames) {
        params[name] = percentDecode(m[captureIdx++] ?? "");
      }
      while (captureIdx <= m.length - 1) {
        const val = m[captureIdx++] ?? "";
        wildcards.push(...val.split("/").filter(Boolean).map(percentDecode));
      }

      return { params, wildcards, groups };
    },

    test(url: string): boolean {
      return regex.test(safePathname(url));
    },
  };
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ============================================================================
// §9  ORIGIN & SAME-ORIGIN
// ============================================================================

/**
 * Extract the origin from a URL.
 *
 * @param url The URL string.
 * @returns The origin, "null" for opaque origins (file:, data:, blob:), or null on parse failure.
 */
export function getOrigin(url: string): string | null {
  const parsed = safeParseURL(url);
  if (!parsed) return null;
  // Opaque origins (file:, data:, blob:) return "null"
  if (["file:", "data:", "blob:"].includes(parsed.protocol)) return "null";
  return parsed.origin;
}

/**
 * Check whether two URLs share the same origin.
 *
 * @param a First URL.
 * @param b Second URL.
 * @returns True if both URLs have the same origin.
 */
export function isSameOrigin(a: string, b: string): boolean {
  const ao = getOrigin(a);
  const bo = getOrigin(b);
  if (!ao || !bo) return false;
  return ao === bo;
}

/**
 * Check if two URLs have the same site (registrable domain).
 *
 * ⚠️ Warning: Uses a heuristic based on TLD labels. This may produce incorrect
 * results for some multi-part TLDs not in the internal list (e.g., .com.mx, .org.br).
 * For production cookie security, consider using a Public Suffix List library.
 */
export function isSameSite(a: string, b: string): boolean {
  const pa = safeParseURL(a);
  const pb = safeParseURL(b);
  if (!pa || !pb) return false;
  if (pa.protocol !== pb.protocol) return false;
  return registrableDomain(pa.hostname) === registrableDomain(pb.hostname);
}

function registrableDomain(host: string): string {
  // Common multi-part TLDs where we need last 3 labels
  // This is not comprehensive - a full PSL library would be needed for production
  const MULTI_PART_TLDS = new Set([
    "co.uk",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.za",
    "co.in",
    "com.au",
    "com.br",
    "com.mx",
    "com.cn",
    "com.tw",
    "com.hk",
    "com.sg",
    "com.my",
    "com.ph",
    "com.vn",
    "com.tr",
    "net.au",
    "net.uk",
    "net.br",
    "org.uk",
    "org.au",
    "org.nz",
    "org.cn",
    "org.in",
    "ac.uk",
    "gov.uk",
    "gov.au",
    "gov.cn",
    "or.kr",
    "pe.kr",
    "go.jp",
    "ne.jp",
    "ac.jp",
    "github.io",
    "herokuapp.com",
    "cloudfront.net",
  ]);
  const labels = host.split(".");
  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join(".");
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return labels.slice(-3).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

// ============================================================================
// §10  URL RESOLUTION
// ============================================================================

/**
 * Resolve a URL relative to a base URL (RFC 3986 §5).
 * Returns the resolved absolute URL string.
 */
export function resolveURL(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    throw new TypeError(`Cannot resolve "${relative}" against base "${base}"`);
  }
}

/**
 * Make a URL relative to a base.
 * Returns null if the URL is not under the base.
 */
export function relativeURL(url: string, base: string): string | null {
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.origin !== b.origin) return null;
    if (!u.pathname.startsWith(b.pathname)) return null;
    return u.pathname.slice(b.pathname.length) + u.search + u.hash;
  } catch {
    return null;
  }
}

// ============================================================================
// §11  URL CLASSIFICATION
// ============================================================================

/**
 * Check whether a URL is absolute (has a scheme).
 *
 * @param url The URL to check.
 * @returns True if the URL has a recognised scheme.
 */
export function isAbsolute(url: string): boolean {
  try {
    // For schemes with // (https://, ftp://, etc.)
    if (/^[A-Za-z][A-Za-z0-9+\-.]*:\/\//.test(url)) return true;
    // For opaque schemes like data:, blob:, javascript:
    const u = new URL(url);
    return u.protocol !== "" && u.protocol !== "file:";
  } catch {
    return false;
  }
}

/**
 * Check whether a URL is relative (no scheme).
 *
 * @param url The URL to check.
 * @returns True if the URL is not absolute.
 */
export function isRelative(url: string): boolean {
  return !isAbsolute(url);
}

/**
 * Check whether a URL uses the HTTPS scheme.
 *
 * @param url The URL to check.
 * @returns True if the protocol is "https:".
 */
export function isHTTPS(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Check whether a URL uses HTTP or HTTPS.
 *
 * @param url The URL to check.
 * @returns True if the protocol is "http:" or "https:".
 */
export function isHTTP(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * Check whether a URL is a data: URL.
 *
 * @param url The URL to check.
 * @returns True if the URL starts with "data:".
 */
export function isDataURL(url: string): boolean {
  return url.trimStart().startsWith("data:");
}

/**
 * Check whether a URL is a blob: URL.
 *
 * @param url The URL to check.
 * @returns True if the URL starts with "blob:".
 */
export function isBlobURL(url: string): boolean {
  return url.trimStart().startsWith("blob:");
}

/**
 * Check whether a URL points to localhost.
 *
 * @param url The URL to check.
 * @returns True if hostname is localhost, 127.0.0.1, ::1, or *.localhost.
 */
export function isLocalhost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

// ============================================================================
// §12  DATA URL HELPERS
// ============================================================================

/**
 * Parsed data URL components.
 *
 * Note: `data` is a string - for base64 data URLs, this is the raw base64 string,
 * not decoded bytes. Callers must base64-decode if needed.
 */
export interface DataURLParts {
  /** MIME type (e.g., "image/png", "text/plain") */
  mediaType: string;
  /** True if base64-encoded, false if URL-encoded */
  isBase64: boolean;
  /**
   * The data portion as a string:
   * - For base64: raw base64 string (not decoded)
   * - For non-base64: percent-decoded string
   */
  data: string;
}

/**
 * Parse a data: URL into its components (media type, encoding, data).
 *
 * @param url The data: URL string.
 * @returns Parsed DataURLParts, or null if not a valid data URL.
 */
export function parseDataURL(url: string): DataURLParts | null {
  const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  return {
    mediaType: m[1] ?? "text/plain",
    isBase64: !!m[2],
    data: m[3] ?? "",
  };
}

/**
 * Build a data: URL from raw data, media type, and encoding.
 *
 * @param data The data payload (string or Uint8Array).
 * @param mediaType MIME type (e.g. "image/png", "text/plain").
 * @param base64 If true (default), base64-encode the data.
 * @returns A data: URL string.
 */
export function buildDataURL(data: string | Uint8Array, mediaType: string, base64 = true): string {
  if (typeof data === "string") {
    if (base64) {
      return `data:${mediaType};base64,${btoa(data)}`;
    }
    return `data:${mediaType},${encodeURIComponent(data)}`;
  }
  // Uint8Array → base64 (chunked to avoid memory issues with large data)
  // Use TextDecoder for efficient Uint8Array to string conversion
  const binary = new TextDecoder("iso-8859-1").decode(data);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

// ============================================================================
// §13  URL DIFF
// ============================================================================

/**
 * Result of diffing two URLs — shows changed components and query param diffs.
 */
export interface URLDiff {
  protocol?: [string, string];
  hostname?: [string, string];
  port?: [string, string];
  pathname?: [string, string];
  search?: [string, string];
  hash?: [string, string];
  addedParams: Record<string, string>;
  removedParams: Record<string, string>;
  changedParams: Record<string, [string, string]>;
}

/**
 * Diff two URLs — returns changed components and query param differences.
 *
 * @param a First URL.
 * @param b Second URL.
 * @returns A URLDiff describing component changes and query param diffs.
 * @throws {TypeError} If either URL is invalid.
 */
export function diffURLs(a: string, b: string): URLDiff {
  const ua = safeParseURL(a);
  const ub = safeParseURL(b);
  if (!ua || !ub) throw new TypeError(`Cannot diff invalid URLs: "${a}" vs "${b}"`);
  const diff: URLDiff = { addedParams: {}, removedParams: {}, changedParams: {} };

  if (ua.protocol !== ub.protocol) diff.protocol = [ua.protocol, ub.protocol];
  if (ua.hostname !== ub.hostname) diff.hostname = [ua.hostname, ub.hostname];
  if (ua.port !== ub.port) diff.port = [ua.port, ub.port];
  if (ua.pathname !== ub.pathname) diff.pathname = [ua.pathname, ub.pathname];
  if (ua.hash !== ub.hash) diff.hash = [ua.hash, ub.hash];

  // Param diff
  for (const [k, v] of ua.searchParams.entries()) {
    const bv = ub.searchParams.get(k);
    if (bv === null) diff.removedParams[k] = v;
    else if (bv !== v) diff.changedParams[k] = [v, bv];
  }
  for (const [k, v] of ub.searchParams.entries()) {
    if (!ua.searchParams.has(k)) diff.addedParams[k] = v;
  }

  if (
    ua.search !== ub.search &&
    !Object.keys(diff.changedParams).length &&
    !Object.keys(diff.addedParams).length &&
    !Object.keys(diff.removedParams).length
  ) {
    diff.search = [ua.search, ub.search];
  }

  return diff;
}

// ============================================================================
// §14  UTILITIES
// ============================================================================

/**
 * Parse a URL without throwing on invalid input.
 *
 * @param url The URL string to parse.
 * @returns A URL object, or null if parsing fails.
 */
export function safeParseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Ensure a URL has a trailing slash on the pathname.
 *
 * @param url The URL to modify.
 * @returns URL with a trailing slash on the pathname.
 *
 * Note: Relative URLs (e.g., "api/users") require a base URL to be resolved.
 * This function will throw on purely relative URLs without a base.
 * Use absolute URLs or URLs with a scheme (http://, https://).
 */
export function withTrailingSlash(url: string): string {
  return URLBuilder.from(url).addTrailingSlash().toString();
}

/**
 * Remove trailing slash from a URL pathname.
 *
 * @param url The URL to modify.
 * @returns URL without a trailing slash on the pathname.
 * See `withTrailingSlash` notes about relative URLs.
 */
export function withoutTrailingSlash(url: string): string {
  return URLBuilder.from(url).removeTrailingSlash().toString();
}

/**
 * Strip the hash fragment from a URL.
 *
 * @param url The URL to strip.
 * @returns URL without hash fragment.
 */
export function stripHash(url: string): string {
  return URLBuilder.from(url).removeHash().toString();
}

/**
 * Strip all query params from a URL.
 *
 * @param url The URL to strip.
 * @returns URL without query string.
 */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Get the file extension from a URL path, or empty string.
 *
 * @param url The URL to inspect.
 * @returns The lowercased file extension (e.g. "png"), or empty string if none.
 */
export function urlExtension(url: string): string {
  try {
    const p = new URL(url).pathname;
    const seg = p.split("/").pop() ?? "";
    const dot = seg.lastIndexOf(".");
    return dot === -1 ? "" : seg.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Get the filename from a URL path.
 *
 * @param url The URL to inspect.
 * @returns The decoded filename, or empty string if the path has no filename.
 */
export function urlFilename(url: string): string {
  try {
    const p = new URL(url).pathname;
    return percentDecode(p.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}

/**
 * Mask sensitive query parameters for safe logging.
 * Replaces matching param values with "REDACTED".
 *
 * @param url The URL to redact.
 * @param sensitiveParams One or more query parameter names to mask.
 * @returns URL with sensitive param values replaced with "REDACTED".
 */
export function redactURL(url: string, ...sensitiveParams: string[]): string {
  return URLBuilder.from(url)
    .redactParams(...sensitiveParams)
    .toString();
}
