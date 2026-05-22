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

/**
 * Private IP ranges that must be blocked to prevent SSRF attacks.
 *
 * IPv6 coverage:
 * - ::1 (loopback)
 * - fc00::/7 (ULA - includes fc00: and fd00:)
 * - fe80::/10 (link-local)
 * - 2001:db8::/32 (documentation)
 * - ::/96 (IPv4-compatible - deprecated but still seen)
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x)
 */
const PRIVATE_IP_RANGES = [
  /^127\./, // loopback
  /^10\./, // RFC 1918
  /^192\.168\./, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
  /^169\.254\./, // link-local (AWS IMDS, etc.)
  /^0\./, // this-network
  /^::1$/i, // IPv6 loopback
  /^fc00:/i, // IPv6 ULA (fc00::/7 - includes fc00: and fd00:)
  /^fd00:/i, // IPv6 ULA (fd00::/8 - unique local)
  /^fe80:/i, // IPv6 link-local (fe80::/10)
  /^2001:db8:/i, // IPv6 documentation range
  /^::0?ffff:/i, // IPv4-mapped IPv6 (::ffff:...)
  /^0:0:0:0:0:ffff:/i, // IPv4-mapped compressed form
  // FIX 4: IPv4-mapped IPv6 SSRF bypass — e.g. http://[::ffff:127.0.0.1]
  /^::ffff:127\./i, // IPv4-mapped loopback
  /^::ffff:10\./i, // IPv4-mapped RFC 1918
  /^::ffff:192\.168\./i, // IPv4-mapped RFC 1918
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i, // IPv4-mapped RFC 1918
  /^::ffff:169\.254\./i, // IPv4-mapped link-local
  /^0:0:0:0:0:ffff:7f/i, // compressed form of ::ffff:127.x
  /^::$/i, // IPv4-compatible :: (any ::/96)
];

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
    // Strip IPv6 brackets for consistent matching
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    // Normalize expanded IPv6 loopback (::1 → 0:0:0:0:0:0:0:1)
    if (host === "0:0:0:0:0:0:0:1") host = "::1";

    // Block loopback and localhost
    if (host === "localhost" || host === "0.0.0.0") return false;

    // Block private IP ranges (SSRF prevention)
    if (PRIVATE_IP_RANGES.some((r) => r.test(host))) return false;

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
 * Falls back to `crypto.randomUUID()` as a secondary CSPRNG path for
 * hypothetical environments without `getRandomValues`.
 *
 * @param byteCount - Number of random bytes (output hex length = byteCount * 2)
 * @returns Hex-encoded random string
 */
export function randomBytes(byteCount: number): string {
  const arr = new Uint8Array(byteCount);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    // Fallback: crypto.randomUUID() returns 36 hex chars (16 random bytes)
    // in all WinterCG-compliant runtimes. Repeat to fill requested length.
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : "";
    if (uuid.length >= byteCount * 2) {
      return uuid.slice(0, byteCount * 2);
    }
    // Last-resort fallback for environments with no crypto at all.
    // This should never be reached in any runtime kinetex targets.
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
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
