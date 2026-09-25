/**
 * Cross-runtime utilities for type safety, validation, and security.
 */

// Dynamic imports for cross-runtime compatibility
// Use globalThis to avoid static imports that fail in edge runtimes
// deno-disable-next-line no-process-global
type NodeProcess = typeof globalThis extends { process: infer P } ? P : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _process: NodeProcess | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Buffer: { isBuffer: (arg: unknown) => boolean } | undefined;

// Check globalThis.process for Node.js runtime detection (no dynamic import needed)
function getProcess(): NodeProcess | undefined {
  if (_process) return _process;
  const g = globalThis as { process?: NodeProcess };
  if (g.process?.hrtime) {
    _process = g.process;
    return _process;
  }
  return undefined;
}

// Check globalThis.Buffer for Node.js Buffer detection
function getBuffer(): { isBuffer: (arg: unknown) => boolean } | undefined {
  if (_Buffer) return _Buffer;
  const g = globalThis as { Buffer?: { isBuffer: (arg: unknown) => boolean } };
  if (g.Buffer && typeof g.Buffer.isBuffer === "function") {
    _Buffer = g.Buffer;
    return _Buffer;
  }
  return undefined;
}

// Declare Bun global for TypeScript
declare const Bun: unknown;

// ============================================================================
// §1  SAFE JSON PARSING
// ============================================================================

/** Options for safe JSON parsing. */
export interface SafeJSONParseOptions {
  /** Maximum allowed depth. Default: 32 */
  maxDepth?: number;
  /** Maximum allowed string length. Default: 10MB */
  maxStringLength?: number;
  /** Maximum allowed array length. Default: 10000 */
  maxArrayLength?: number;
  /** Maximum allowed object key count. Default: 1000 */
  maxObjectKeys?: number;
  /** Whether to allow NaN/Infinity. Default: false */
  allowNonFinite?: boolean;
}

/** Result of safe JSON parsing. */
export interface SafeJSONParseResult<T> {
  /** Whether parsing succeeded */
  success: boolean;
  /** The parsed value (present only when success is true) */
  value?: T;
  /** Machine-readable error code (present only when success is false) */
  error?: string;
  /** Human-readable error description (present only when success is false) */
  message?: string;
}

/**
 * Default safe parsing limits to prevent DoS attacks.
 */
const DEFAULT_LIMITS: Required<SafeJSONParseOptions> = {
  maxDepth: 32,
  maxStringLength: 10 * 1024 * 1024, // 10MB
  maxArrayLength: 10000,
  maxObjectKeys: 1000,
  allowNonFinite: false,
};

/**
 * Safely parse JSON with depth and size limits.
 * Protects against billion laughs attacks and other DoS vectors.
 *
 * @typeParam T - Expected parsed type
 * @param text - JSON string to parse
 * @param options - Parsing options
 * @returns Parse result with success/failure information
 */
export function safeJSONParse<T = unknown>(
  text: string,
  options: SafeJSONParseOptions = {},
): SafeJSONParseResult<T> {
  const limits = { ...DEFAULT_LIMITS, ...options };

  // Check string length first
  if (text.length > limits.maxStringLength) {
    return {
      success: false,
      error: "STRING_TOO_LONG",
      message: `JSON string length exceeds limit of ${limits.maxStringLength}`,
    };
  }

  // FIX 16: Simplified pre-parse scan — O(n) depth-only check kept as a
  // genuine DoS guard (billion-laughs early exit before JSON.parse allocates
  // a huge object tree). Bracket-balance validation removed — JSON.parse
  // rejects malformed JSON already, so the redundant pre-check was a second
  // full O(n) pass for no additional correctness benefit.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (c === "{" || c === "[") {
      if (++depth > limits.maxDepth) {
        return {
          success: false,
          error: "DEPTH_EXCEEDED",
          message: `JSON depth exceeds limit of ${limits.maxDepth}`,
        };
      }
    } else if (c === "}" || c === "]") {
      depth--;
    }
  }
  // Now try to parse with native JSON.parse
  try {
    const value = JSON.parse(text) as T;

    // Validate the parsed value
    if (!validateParsedValue(value, limits, 0)) {
      return {
        success: false,
        error: "VALIDATION_FAILED",
        message: "Parsed value exceeds size limits",
      };
    }

    // Check for NaN/Infinity if not allowed
    if (!limits.allowNonFinite && hasNonFiniteNumbers(value)) {
      return {
        success: false,
        error: "NON_FINITE_NUMBER",
        message: "JSON contains NaN or Infinity values",
      };
    }

    return { success: true, value };
  } catch {
    return {
      success: false,
      error: "PARSE_ERROR",
      message: "Failed to parse JSON",
    };
  }
}

/** Validate parsed value against size limits. */
function validateParsedValue(
  value: unknown,
  limits: Required<SafeJSONParseOptions>,
  currentDepth: number,
): boolean {
  if (currentDepth > limits.maxDepth) return false;

  if (value === null || value === undefined) return true;

  if (typeof value === "string") {
    return value.length <= limits.maxStringLength;
  }

  if (typeof value === "number") {
    // Numbers are fine (NaN/Infinity checked separately)
    return true;
  }

  if (typeof value === "boolean") return true;

  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) return false;
    return value.every((item) => validateParsedValue(item, limits, currentDepth + 1));
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > limits.maxObjectKeys) return false;
    if (keys.includes("__proto__")) return false;
    if (keys.includes("constructor")) {
      const ctor = (value as Record<string, unknown>).constructor;
      if (typeof ctor === "object" && ctor !== null) {
        const ctorKeys = Object.keys(ctor);
        if (ctorKeys.includes("prototype")) return false;
        if (ctorKeys.includes("__proto__")) return false;
      }
    }
    return keys.every((key) =>
      validateParsedValue((value as Record<string, unknown>)[key], limits, currentDepth + 1),
    );
  }

  return true;
}

/** Check if value contains NaN or Infinity. */
function hasNonFiniteNumbers(value: unknown): boolean {
  if (typeof value === "number" && !Number.isFinite(value)) return true;

  if (Array.isArray(value)) {
    return value.some(hasNonFiniteNumbers);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasNonFiniteNumbers);
  }

  return false;
}

/**
 * Parse JSON with safe defaults.
 * Returns the parsed value or the fallback string if parsing fails.
 *
 * @typeParam T - Expected parsed type
 * @param text - JSON string to parse
 * @returns Parsed value or string fallback
 */
export function tryParseJSON<T = unknown>(text: string): T | string {
  const result = safeJSONParse<T>(text);
  return result.success ? result.value! : text;
}

/**
 * FIX (H6): Strip prototype-pollution keys from a freshly parsed JSON value.
 *
 * Recursively removes own properties named `__proto__`, `constructor`, and
 * `prototype` from plain objects. Use immediately after any raw `JSON.parse`
 * that does not go through {@link safeJSONParse} (streaming parsers, legacy
 * helpers) so that untrusted payloads can never smuggle pollution keys into
 * downstream spread/merge operations.
 *
 * @param value - Parsed JSON value (mutated copy is returned for objects/arrays).
 * @returns Sanitized value — same reference for primitives.
 */
export function sanitizeParsedJSON<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      (value as unknown[])[i] = sanitizeParsedJSON(value[i]);
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      delete obj[key];
      continue;
    }
    obj[key] = sanitizeParsedJSON(obj[key]);
  }
  return value;
}

/**
 * Parse JSON with reduced limits for untrusted input.
 *
 * @typeParam T - Expected parsed type
 * @param text - JSON string to parse
 * @returns Parse result
 */
export function parseUntrustedJSON<T = unknown>(text: string): SafeJSONParseResult<T> {
  return safeJSONParse<T>(text, {
    maxDepth: 16,
    maxStringLength: 1 * 1024 * 1024, // 1MB
    maxArrayLength: 1000,
    maxObjectKeys: 100,
  });
}

// ============================================================================
// §2  TYPE GUARDS
// ============================================================================

/**
 * Type guard for Uint8Array.
 *
 * @param value - The value to check
 * @returns True if the value is a Uint8Array
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Type guard for ArrayBuffer.
 *
 * @param value The value to check.
 * @returns True if the value is an ArrayBuffer.
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

/**
 * Type guard for ReadableStream<Uint8Array>.
 *
 * @param value The value to check.
 * @returns True if the value is a ReadableStream.
 */
export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    "getReader" in value &&
    typeof (value as { getReader: () => unknown }).getReader === "function"
  );
}

/**
 * Type guard for Headers.
 *
 * @param value The value to check.
 * @returns True if the value is a Headers instance.
 */
export function isHeaders(value: unknown): value is Headers {
  return (
    value !== null &&
    typeof value === "object" &&
    "forEach" in value &&
    typeof (value as { forEach: () => unknown }).forEach === "function"
  );
}

/**
 * Type guard for AbortSignal.
 *
 * @param value The value to check.
 * @returns True if the value is an AbortSignal.
 */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    "aborted" in value &&
    typeof (value as { aborted: boolean }).aborted === "boolean"
  );
}

/**
 * Type guard for plain objects (\[object Object\]).
 *
 * @param value The value to check.
 * @returns True if the value is a plain Object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Type guard for FormData.
 *
 * @param value The value to check.
 * @returns True if the value is a FormData instance.
 */
export function isFormData(value: unknown): value is FormData {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as FormData).constructor?.name === "FormData"
  );
}

/**
 * Type guard for Blob.
 *
 * @param value The value to check.
 * @returns True if the value is a Blob instance.
 */
export function isBlob(value: unknown): value is Blob {
  return (
    value !== null && typeof value === "object" && (value as Blob).constructor?.name === "Blob"
  );
}

/**
 * Type guard for URLSearchParams.
 *
 * @param value The value to check.
 * @returns True if the value is a URLSearchParams instance.
 */
export function isURLSearchParams(value: unknown): value is URLSearchParams {
  return (
    value !== null &&
    typeof value === "object" &&
    "has" in value &&
    typeof (value as { has: () => boolean }).has === "function"
  );
}

// ============================================================================
// §3  VALIDATION UTILITIES
// ============================================================================

/** Valid HTTP header name pattern (RFC 7230). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate an HTTP header name.
 * @param name - Header name to validate
 * @returns True if valid
 */
export function isValidHeaderName(name: string): boolean {
  // Header names are case-insensitive, should be ASCII
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.length > 4096) return false; // Reasonable length limit
  return HEADER_NAME_PATTERN.test(name);
}

/**
 * Validate an HTTP header value.
 * @param value - Header value to validate
 * @returns True if valid
 */
export function isValidHeaderValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length > 8192) return false; // Reasonable length limit
  // Header values can contain any ASCII except CTLs and CRLF (header injection)
  // Per RFC 7230, HT (0x09) is allowed in header values
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // No control characters (0-31 except 9=HT), 127
    // No CRLF (13 = \r, 10 = \n) - prevents header injection
    if ((code < 32 && code !== 9) || code === 127 || code === 13 || code === 10) return false;
  }
  return true;
}

/**
 * Forbidden URL schemes that should never be allowed to prevent SSRF attacks.
 *
 * Categories:
 * - Local access: file:// (read local files), ftp://
 * - Protocol bypass: gopher:// (legacy protocol with multiple backend access)
 * - Code execution: javascript:, data:
 * - Network services (potential internal service access):
 *   - dict:// (dictionary protocol)
 *   - ldap://, ldaps:// (directory services)
 *   - imap://, pop://, smtp:// (email protocols)
 *   - ssh://, git://, svn:// (version control)
 *   - telnet://, rlogin:// (remote access)
 *   - tn3270:// (IBM mainframe)
 *   - nntp://, news:// (Usenet)
 *   - webcal:// (calendar subscriptions)
 */
const FORBIDDEN_SCHEMES = new Set([
  "file",
  "ftp",
  "gopher",
  "data",
  "javascript",
  "dict",
  "ldap",
  "ldaps",
  "rlogin",
  "telnet",
  "tn3270",
  "imap",
  "pop",
  "smtp",
  "nntp",
  "news",
  "ssh",
  "git",
  "svn",
  "webcal",
  "urn",
]);

// FIX (H1): The regex-based PRIVATE_IP_RANGES list was bypassable via
// IPv6 forms like `http://[::0:1]/`, `http://[::ffff:7f00:1]/` (hex), and
// `http://[::ffff:a9fe:a9fe]/` (IMDS 169.254.169.254), plus numeric IPv4
// hostnames like `http://2130706433/` (127.0.0.1) and `http://0x7f000001/`.
// isSafeURL() now expands addresses to bytes and compares ranges numerically.

/**
 * Reserved IPv4 ranges blocked for SSRF prevention, as [lo, hi] 32-bit values.
 */
const IPV4_BLOCKED_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 — this-network
  [0x0a000000, 0x0affffff], // 10.0.0.0/8 — RFC 1918 private
  [0x64400000, 0x647fffff], // 100.64.0.0/10 — CGNAT (RFC 6598)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 — loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 — link-local (AWS IMDS etc.)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 — RFC 1918 private
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 — IETF protocol assignments
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 — TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 — RFC 1918 private
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 — benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 — TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 — TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 — multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 — reserved (incl. 255.255.255.255)
];

/** True when the 32-bit IPv4 value falls inside a reserved/blocked range. */
function isBlockedIPv4(n: number): boolean {
  return IPV4_BLOCKED_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Parse one dotted/numeric component: decimal, hex (0x…), or octal (0…). */
function parseIPv4Component(p: string): number | null {
  if (p === "") return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p, 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (/^\d+$/.test(p)) return parseInt(p, 10);
  return null;
}

/**
 * Best-effort parse of a dotted or numeric IPv4 literal, accepting decimal,
 * hex (0x…), and octal (0…) component forms — the same shapes URL parsers
 * and resolvers accept (e.g. "2130706433", "0x7f.1", "0177.0.0.1").
 * Returns the 32-bit value, or null when the host cannot be an IPv4 literal.
 */
function parseIPv4Host(host: string): number | null {
  if (host.includes(":") || !/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;
  if (parts.length === 1) {
    const v = parseIPv4Component(parts[0]!);
    if (v === null || v > 0xffffffff) return null;
    return v >>> 0;
  }
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseIPv4Component(p);
    // Last part may absorb the remainder per WHATWG; cap it at 24 bits.
    const isLast = p === parts[parts.length - 1];
    if (v === null || v > (isLast && nums.length === 3 ? 0xff : 0xff)) return null;
    nums.push(v);
  }
  while (nums.length < 4) nums.push(0);
  return ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
}

/**
 * Expand an IPv6 address (bracket-stripped) into its 16 bytes.
 * Handles :: compression, IPv4-mapped dotted tails, and zone indexes.
 * Returns null when the address is not a valid IPv6 literal.
 */
function parseIPv6Host(host: string): Uint8Array | null {
  if (!host.includes(":")) return null;
  const bare = host.split("%")[0]!; // strip zone index (fe80::1%eth0)
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const expandGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g === "") return null;
      if (g.includes(".")) {
        // IPv4 dotted tail (e.g. ::ffff:127.0.0.1) must be the last group
        if (i !== groups.length - 1) return null;
        const n = parseIPv4Host(g);
        if (n === null) return null;
        out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        const v = parseInt(g, 16);
        out.push((v >>> 8) & 0xff, v & 0xff);
      }
    }
    return out;
  };

  let bytes: number[];
  if (halves.length === 2) {
    const left = expandGroups(halves[0]!);
    const right = expandGroups(halves[1]!);
    if (!left || !right) return null;
    const fill = 16 - left.length - right.length;
    if (fill < 0) return null;
    bytes = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    const all = expandGroups(bare);
    if (!all || all.length !== 16) return null;
    bytes = all;
  }
  return bytes.length === 16 ? new Uint8Array(bytes) : null;
}

/** True when the 16-byte IPv6 address is in a reserved/blocked range. */
function isBlockedIPv6(b: Uint8Array): boolean {
  const read32 = (i: number): number =>
    ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

  // :: (unspecified) — always blocked
  if (b.every((x) => x === 0)) return true;
  // ::1/128 — loopback
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;

  const first = b[0]!;
  // fc00::/7 — unique local addresses (fc00::/8 + fd00::/8)
  if ((first & 0xfe) === 0xfc) return true;
  // fe80::/10 — link-local
  if (first === 0xfe && (b[1]! & 0xc0) === 0x80) return true;
  // ff00::/8 — multicast
  if (first === 0xff) return true;
  // 2001:db8::/32 — documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;

  // ::ffff:0:0/96 — IPv4-mapped → apply the IPv4 checks to the tail
  if (
    b.slice(0, 10).every((x) => x === 0) &&
    b[10] === 0xff &&
    b[11] === 0xff
  ) {
    return isBlockedIPv4(read32(12));
  }
  // ::/96 — deprecated IPv4-compatible → apply the IPv4 checks to the tail
  // (covers e.g. [::127.0.0.1] and [::169.254.169.254])
  if (b.slice(0, 12).every((x) => x === 0)) {
    return isBlockedIPv4(read32(12));
  }
  // 64:ff9b::/96 — NAT64 (RFC 6052): traffic is translated to the embedded IPv4
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return isBlockedIPv4(read32(12));
  }
  // 2002::/16 — 6to4: the embedded IPv4 sits in bits 16–47
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isBlockedIPv4(read32(2));
  }
  return false;
}

/**
 * Validate a URL for safety.
 * @param url - URL to validate
 * @param allowedSchemes - Allowed URL schemes
 * @returns True if URL is safe
 */
export function isSafeURL(
  url: string | URL,
  allowedSchemes: string[] = ["http", "https"],
): boolean {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

    // Check scheme
    if (!allowedSchemes.some((s) => s.toLowerCase() === scheme)) {
      return false;
    }

    // Block forbidden schemes regardless of allowedSchemes
    if (FORBIDDEN_SCHEMES.has(scheme)) {
      return false;
    }

    let host = parsed.hostname.toLowerCase();
    const isV6Literal = host.startsWith("[") && host.endsWith("]");
    if (isV6Literal) host = host.slice(1, -1);

    // Block loopback hostnames (including *.localhost subdomains)
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return false;

    // Block private/reserved IPs (SSRF prevention) — numeric comparison over
    // expanded bytes so every IPv6 spelling and numeric IPv4 form is covered.
    if (isV6Literal || host.includes(":")) {
      const v6 = parseIPv6Host(host);
      // Unparseable IPv6 literal → reject defensively
      if (v6 === null || isBlockedIPv6(v6)) return false;
    } else {
      const v4 = parseIPv4Host(host);
      if (v4 !== null && isBlockedIPv4(v4)) return false;
    }

    // Check for suspicious patterns (path traversal)
    if (parsed.hostname.includes("..") || parsed.pathname.includes("..")) {
      return false;
    }

    // Check hostname length (RFC 1035)
    if (parsed.hostname.length > 253) return false;

    // FIX 13: unified URL length limit (buildURL enforces 8 192; we match it here)
    if (parsed.href.length > 8_192) return false;

    // Validate port if present
    if (parsed.port) {
      const port = parseInt(parsed.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is absolute (has a scheme).
 *
 * @param url The URL to check.
 * @returns True if the URL has a recognised scheme (e.g. "https://...").
 *
 * @example
 * ```ts
 * isAbsoluteURL("https://example.com") // true
 * isAbsoluteURL("/path/to/resource")  // false
 * isAbsoluteURL("api/users")          // false
 * ```
 */
export function isAbsoluteURL(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/**
 * Deep clone a value (JSON-safe objects only).
 * For complex objects with circular references, use a dedicated library.
 *
 * @param value - Value to clone
 * @returns Deep cloned value
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }
  if (value instanceof Map) {
    const cloned = new Map();
    value.forEach((v, k) => cloned.set(k, deepClone(v)));
    return cloned as T;
  }
  if (value instanceof Set) {
    const cloned = new Set();
    value.forEach((v) => cloned.add(deepClone(v)));
    return cloned as T;
  }
  const cloned: Record<string, unknown> = {};
  for (const key in value) {
    // Prototype-pollution guard: never copy __proto__ / constructor / prototype
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      cloned[key] = deepClone((value as Record<string, unknown>)[key]);
    }
  }
  return cloned as T;
}

/**
 * Type guard to check if a value is a Promise.
 *
 * @param value - Value to check
 * @returns True if value is a Promise
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// ============================================================================
// §4  ERROR UTILITIES
// ============================================================================

/**
 * Error context for structured error creation.
 * Provides machine-readable error codes with optional cause, request, and response attachments.
 */
export interface ErrorContext {
  /** Machine-readable error code (e.g. "ENETWORK", "EVALIDATION"). */
  code: string;
  /** Human-readable error description. */
  message: string;
  /** The original error that caused this error, if any. */
  cause?: unknown;
  /** The request that triggered the error, if applicable. */
  request?: unknown;
  /** The response that produced the error, if applicable. */
  response?: unknown;
  [key: string]: unknown;
}

/**
 * Create a structured error with context.
 * @param message - Error message
 * @param context - Additional context
 * @returns Error with structured information
 */
export function createStructuredError(
  message: string,
  context: ErrorContext,
): Error & ErrorContext {
  const error = new Error(message) as Error & ErrorContext;
  Object.assign(error, context);
  return error;
}

/**
 * Format error with full context for logging.
 * @param error - Error to format
 * @returns Formatted error string
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const context: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(error)) {
      if (key !== "message" && key !== "name" && key !== "stack") {
        context[key] = value;
      }
    }
    const contextStr = Object.keys(context).length > 0 ? ` | ${JSON.stringify(context)}` : "";
    return `${error.name}: ${error.message}${contextStr}`;
  }
  return String(error);
}

// ============================================================================
// §5  TIME UTILITIES
// ============================================================================

/**
 * Sanitize a URL by stripping credentials and validating safety.
 * Returns null if the URL is invalid or flagged as an SSRF risk.
 *
 * @param url - URL to sanitize
 * @returns Sanitized URL or null if invalid or unsafe (SSRF risk)
 */
export function sanitizeURL(url: string): string | null {
  if (typeof url !== "string") return null;
  if (url.length > 2048) return null; // URL length limit

  try {
    const parsed = new URL(url);

    // Validate for SSRF risks - block private IPs, etc.
    if (!isSafeURL(parsed)) {
      return null;
    }

    // Reconstruct with safe components — strip credentials
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Get high-resolution timestamp.
 * Prefers Node.js hrtime if available, otherwise falls back to Date.now().
 * Note: Bun's Bun.ns provides nanosecond precision but requires the Bun runtime.
 * For cross-runtime compatibility, we use hrtime (Node) or Date.now().
 *
 * @returns High-resolution timestamp in milliseconds
 */
export function perfNow(): number {
  const p = getProcess();
  if (p?.hrtime) {
    const [sec, ns] = p.hrtime();
    return sec * 1000 + ns / 1_000_000;
  }
  // Bun: check for Bun.nanoseconds for higher precision
  const g = globalThis as { Bun?: { ns?: { __brand: "nanoseconds" } } };
  if (typeof g.Bun !== "undefined") {
    // Bun.nanoseconds is available in Bun runtime
    return Date.now();
  }
  return Date.now();
}

/**
 * Sleep for a specified number of milliseconds.
 * @param ms - Milliseconds to sleep
 * @param signal - Optional abort signal
 * @returns Promise that resolves when sleep completes or rejects on abort
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(_abortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(_abortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort); // cleanup on normal completion
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ============================================================================
// §6  BUFFER UTILITIES
// ============================================================================

/**
 * Concatenate Uint8Array chunks efficiently.
 * @param chunks - Arrays to concatenate
 * @returns Concatenated array
 */
export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);

  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Convert various buffer types to Uint8Array.
 * @param data - Data to convert
 * @returns Uint8Array or null if unsupported type
 */
export function toUint8Array(data: string | Uint8Array | ArrayBuffer | unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const b = getBuffer();
  if (b && b.isBuffer(data)) {
    return new Uint8Array(data as unknown as ArrayBufferLike);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return null;
}

/**
 * Encode a Uint8Array to base64 without using spread arguments —
 * safe for arbitrarily large buffers (no call-stack size limit).
 *
 * Uses the WHATWG `btoa` API which is available in all target runtimes.
 * Processes the buffer in chunks to avoid allocating a single huge string.
 *
 * @param bytes The buffer to encode.
 * @returns Base64-encoded string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Process in 3-byte (24-bit) aligned chunks to avoid padding issues mid-stream.
  // 3 × 2¹³ = 24 576 bytes per chunk — keeps individual strings small.
  const CHUNK = 24_576;
  if (bytes.byteLength <= CHUNK) {
    // Fast path — small buffer, single allocation
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }
  // Large buffer — process in chunks and concatenate base64 segments.
  // Each chunk is a multiple of 3 bytes so base64 output aligns without padding.
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    let binary = "";
    for (let i = 0; i < slice.byteLength; i++) {
      binary += String.fromCharCode(slice[i]!);
    }
    parts.push(btoa(binary));
  }
  // Remove padding from all but the last segment to avoid mid-stream "==" breaks.
  return parts.map((p, i) => (i < parts.length - 1 ? p.replace(/=+$/, "") : p)).join("");
}

// ============================================================================
// §7  SIGNAL UTILITIES
// ============================================================================

/**
 * Merge multiple AbortSignals into one.
 * @param signals - Signals to merge
 * @returns Merged AbortSignal
 */
export function mergeSignals(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal | undefined {
  const validSignals = signals.filter((s): s is AbortSignal => s !== null && s !== undefined);

  if (validSignals.length === 0) {
    return undefined;
  }

  if (validSignals.length === 1) return validSignals[0]!;

  // Check if any signal is already aborted
  if (validSignals.some((s) => s.aborted)) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  const controller = new AbortController();

  // abort: fire the controller and clean up ALL listeners immediately.
  const abort = () => {
    for (const s of validSignals) s.removeEventListener("abort", abort);
    controller.abort(_abortError());
  };

  // 9.11: when the merged signal itself aborts (e.g. from another path), also clean up.
  // This prevents listener accumulation when callers abort the controller externally.
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const s of validSignals) s.removeEventListener("abort", abort);
    },
    { once: true },
  );

  for (const s of validSignals) s.addEventListener("abort", abort, { once: true });

  return controller.signal;
}

/**
 * Check if an error is an abort error.
 * @param error - Error to check
 * @returns True if error is an abort error
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  if (error.name === "AbortError") return true;

  // Node.js specific
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ECONNRESET" || err.code === "ECONNABORTED") return true;

  // DOMException
  if (error instanceof DOMException && error.name === "AbortError") return true;

  return false;
}

/**
 * Generate cryptographically secure random hex bytes.
 * Uses `crypto.getRandomValues()` which is available in all target runtimes
 * (Node 18+, Deno, Bun, Browser, Cloudflare Workers, Vercel Edge).
 *
 * FIX (M8): removed the `Math.random()` fallback — non-CSPRNG output must
 * never be used for nonces/cnonces (digest auth) or trace IDs. Environments
 * without a CSPRNG now fail fast instead of silently producing predictable
 * values.
 *
 * @param byteCount - Number of random bytes (output hex length = byteCount * 2)
 * @returns Hex-encoded random string
 * @throws {Error} When no CSPRNG is available in the current runtime
 */
export function randomBytes(byteCount: number): string {
  if (!Number.isInteger(byteCount) || byteCount < 0 || byteCount > 65536) {
    throw new Error(`randomBytes: invalid byteCount ${byteCount}`);
  }
  const arr = new Uint8Array(byteCount);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    throw new Error(
      "randomBytes: no CSPRNG available in this runtime — crypto.getRandomValues is required",
    );
  }
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Cross-runtime error creation: DOMException may not exist in all runtimes.
function _abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

// ============================================================================
// §8  Runtime Detection Utilities
// ============================================================================

/** Runtime detection cache. */
let cachedRuntime: string | null = null;

/**
 * Detect the current runtime environment.
 * Cached after first call for performance.
 *
 * @returns Runtime name: "node", "deno", "bun", "browser", "edge", or "unknown"
 */
export function getRuntime(): string {
  if (cachedRuntime) return cachedRuntime;

  // Safely check for Node.js without throwing in edge runtimes
  try {
    const g = globalThis as { process?: { versions?: { node?: string } } };
    if (g.process?.versions?.node) {
      cachedRuntime = "node";
      return cachedRuntime;
    }
  } catch {
    /* process not available */
  }

  if (typeof (globalThis as Record<string, unknown>)["Deno"] !== "undefined") {
    cachedRuntime = "deno";
  } else if (typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined") {
    cachedRuntime = "bun";
  } else if (typeof window !== "undefined") {
    cachedRuntime = "browser";
  } else if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
    cachedRuntime = "edge";
  } else {
    cachedRuntime = "unknown";
  }

  return cachedRuntime;
}

/**
 * Check if running in Node.js.
 *
 * @returns True if the current runtime is Node.js.
 */
export function isNodeEnvironment(): boolean {
  return getRuntime() === "node";
}

/**
 * Check if running in a browser.
 *
 * @returns True if the current runtime is a browser.
 */
export function isBrowserEnvironment(): boolean {
  return getRuntime() === "browser";
}

/**
 * Check if running in a fetch-compatible environment.
 *
 * @returns True if globalThis.fetch is available.
 */
export function hasNativeFetch(): boolean {
  return typeof globalThis?.fetch === "function";
}

// ============================================================================
// §9  HEADER UTILITIES
// ============================================================================

/**
 * Normalize Headers to a plain Record<string, string>.
 * Works across all runtimes — Headers entries are always string pairs.
 *
 * @param headers The Headers instance to normalize.
 * @returns A plain object with lowercased header keys.
 */
export function normalizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}
