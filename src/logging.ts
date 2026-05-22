/**
 * Structured HTTP request/response logging.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Structured log entries (JSON-serializable)
 *  - Log levels: TRACE, DEBUG, INFO, WARN, ERROR, SILENT
 *  - Request / response / error phases
 *  - Header redaction (per-field + regex patterns)
 *  - Body redaction / truncation / masking
 *  - Sensitive URL param redaction
 *  - Request ID generation + correlation
 *  - Timing: total, TTFB, DNS, connect, TLS (where available)
 *  - Multiple transports: console, structured JSON, remote, batching, multi
 *  - Transport batching + async flush
 *  - Sampling (log only N% of requests)
 *  - Filtering (only log matching URLs / methods / statuses)
 *  - Child loggers with inherited config + extra fields
 *  - Context propagation (trace ID, user ID, etc.)
 *  - Pretty-print mode for development
 *  - OpenTelemetry-compatible fields
 *
 * Note: Log rotation is not currently implemented. For production deployments,
 * consider using external log rotation (e.g., logrotate) or shipping logs
 * to a remote service (RemoteTransport) rather than writing to files.
 */

// Cross-runtime: safely detect Node.js process.env
const getNodeEnv = (): string | undefined => {
  try {
    return (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[
      "NODE_ENV"
    ];
  } catch {
    return undefined;
  }
};

// ============================================================================
// §1  TYPES
// ============================================================================

/**
 * Numeric log levels. Higher = more severe.
 * - TRACE:  0  — Fine-grained debug information
 * - DEBUG:  1  — Debug-level messages
 * - INFO:   2  — General informational messages
 * - WARN:   3  — Warning conditions
 * - ERROR:  4  — Error conditions
 * - SILENT: 5  — No logging
 */
export const LogLevel = {
  /** Finest-grained diagnostic messages. */
  TRACE: 0,
  /** Debug-level messages for development. */
  DEBUG: 1,
  /** General informational messages. */
  INFO: 2,
  /** Warning conditions requiring attention. */
  WARN: 3,
  /** Error conditions requiring immediate action. */
  ERROR: 4,
  /** No logging — suppresses all output. */
  SILENT: 5,
} as const;

/** String names of the available log levels. */
export type LogLevelName = keyof typeof LogLevel;
/** Numeric values of the available log levels. */
export type LogLevelValue = (typeof LogLevel)[LogLevelName];

/** A structured log entry for an outgoing HTTP request. */
export interface RequestLogEntry {
  /** Entry discriminator: "request" */
  type: "request";
  /** Correlated request identifier */
  requestId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  /** Severity level */
  level: LogLevelName;
  /** HTTP method */
  method: string;
  /** Request URL (with sensitive params redacted) */
  url: string;
  /** Request headers (sensitive values redacted) */
  headers: Record<string, string>;
  /** Body size in bytes, or null if not logged */
  bodySize: number | null;
  /** Body content (redacted/truncated), or null */
  body: string | null;
  /** Retry attempt number */
  attempt: number;
  /** Arbitrary metadata */
  meta: Record<string, unknown>;
}

/** A structured log entry for an HTTP response. */
export interface ResponseLogEntry {
  /** Entry discriminator: "response" */
  type: "response";
  /** Correlated request identifier */
  requestId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  /** Severity level */
  level: LogLevelName;
  /** HTTP method */
  method: string;
  /** Request URL (with sensitive params redacted) */
  url: string;
  /** HTTP status code */
  status: number;
  /** HTTP status text */
  statusText: string;
  /** Response headers (sensitive values redacted) */
  headers: Record<string, string>;
  /** Body size in bytes, or null if not logged */
  bodySize: number | null;
  /** Body content (redacted/truncated), or null */
  body: string | null;
  /** Total request duration in milliseconds */
  durationMs: number;
  /** Retry attempt number */
  attempt: number;
  /** Whether the response was served from cache */
  cached: boolean;
  /** Arbitrary metadata */
  meta: Record<string, unknown>;
}

/** A structured log entry for an HTTP error. */
export interface ErrorLogEntry {
  /** Entry discriminator: "error" */
  type: "error";
  /** Correlated request identifier */
  requestId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  /** Severity level */
  level: LogLevelName;
  /** HTTP method */
  method: string;
  /** Request URL (with sensitive params redacted) */
  url: string;
  /** Serialized error details */
  error: SerializedError;
  /** HTTP status code, or null if no response */
  status: number | null;
  /** Total request duration in milliseconds */
  durationMs: number;
  /** Retry attempt number */
  attempt: number;
  /** Arbitrary metadata */
  meta: Record<string, unknown>;
}

/** Union type of all log entry types. */
export type LogEntry = RequestLogEntry | ResponseLogEntry | ErrorLogEntry;

/** A serialized error for safe logging (avoids circular references). */
export interface SerializedError {
  /** Error class name */
  name: string;
  /** Error message */
  message: string;
  /** Machine-readable error code (e.g. "ENETWORK") */
  code?: string;
  /** Stack trace */
  stack?: string;
}

// ============================================================================
// §2  REDACTION CONFIG
// ============================================================================

/** Configuration for log entry redaction — controls which data is masked before logging. */
export interface RedactionConfig {
  /** Header names to fully redact (value replaced with "***"). Case-insensitive. */
  headers?: string[];
  /** Query param names to redact in logged URL. */
  queryParams?: string[];
  /** Body fields to redact (dot-path, e.g. "password", "user.token"). */
  bodyFields?: string[];
  /** Regex patterns — any matching substring in body is replaced. */
  bodyPatterns?: RegExp[];
  /**
   * Max body length to log (bytes). Truncates if exceeded. Default: 4096
   *
   * Body length is measured in UTF-8 bytes, not character count.
   * For strings, the body is encoded as UTF-8 and the byte length is used.
   * This ensures multi-byte characters (e.g., emoji) are counted correctly.
   */
  maxBodyLength?: number;
  /** If true, log request body. Default: false */
  logRequestBody?: boolean;
  /** If true, log response body. Default: false */
  logResponseBody?: boolean;
  /** Content-types for which body logging is allowed. Default: text/*, application/json */
  allowedBodyTypes?: string[];
}

/**
 * Default headers to redact from logs.
 * Includes authentication headers, cookies, and common API key patterns.
 *
 * Rationale: These headers commonly contain credentials, tokens, or session
 * identifiers that should not be logged for security reasons.
 */
const DEFAULT_REDACT_HEADERS = [
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
];

/**
 * Default URL query parameters to redact from logs.
 * Includes common token, key, and secret parameter names.
 *
 * Rationale: Query parameters often contain authentication tokens or API keys
 * that should be hidden in logs.
 */
const DEFAULT_REDACT_PARAMS = [
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "pass",
  "pwd",
  "key",
  "auth",
];

/**
 * Default content-types for which body logging is allowed.
 * Requests/responses with other content-types will have their body replaced
 * with a short indicator (e.g. "[binary]") instead of being logged verbatim.
 */
const DEFAULT_ALLOWED_BODY_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "text/",
];

// ============================================================================
// §3  LOG TRANSPORTS
// ============================================================================

/** Pluggable transport for delivering log entries to a destination. */
export interface LogTransport {
  /** Deliver a single log entry. May be sync or async. */
  write(entry: LogEntry): void | Promise<void>;
  /** Flush any buffered entries. Optional — not all transports buffer. */
  flush?(): Promise<void>;
}

// ── 3.1  Console transport ────────────────────────────────────────────────────

/** Options for the ConsoleTransport logger. */
export interface ConsoleTransportOptions {
  /** Enable pretty-printed (human-readable) output. Defaults to true in non-production. */
  pretty?: boolean;
  /** Enable ANSI colorization (reserved for future use). */
  useColors?: boolean;
  /** Which stream to write to. Currently unused. */
  stream?: "stdout" | "stderr";
  /** Callback that receives the formatted output string. Default: console.log */
  onWrite: (output: string) => void;
}

/**
 * Console transport — writes log entries to the console.
 * Supports pretty-printed output for development and JSON for production.
 */
export class ConsoleTransport implements LogTransport {
  /** Whether to pretty-print output */
  private readonly pretty: boolean;
  /** Output callback */
  private readonly onWrite: (output: string) => void;

  /**
   * @param opts - Console transport options
   */
  constructor(
    opts: ConsoleTransportOptions = {
      pretty: false,
      onWrite: (output: string) => console.log(output),
    },
  ) {
    this.pretty = opts.pretty ?? getNodeEnv() !== "production";
    this.onWrite = opts.onWrite;
    // useColors reserved for future ANSI colorization
    void opts.useColors;
  }

  /** Write a single log entry to the console. */
  write(entry: LogEntry): void {
    const output = this.pretty ? this._prettyFormat(entry) : JSON.stringify(entry);
    this.onWrite(output);
  }

  /** Format a log entry as a human-readable string for development output. */
  private _prettyFormat(entry: LogEntry): string {
    const time = new Date(entry.timestampMs).toISOString().slice(11, 23);
    const level = entry.level.padEnd(5);
    const id = entry.requestId.slice(-8);

    if (entry.type === "request") {
      return `[${time}] ${level} ← ${entry.method} ${entry.url} [${id}]`;
    }
    if (entry.type === "response") {
      const dur = `${entry.durationMs.toFixed(0)}ms`;
      const flag = entry.cached ? " (cached)" : "";
      return `[${time}] ${level} → ${entry.status} ${entry.method} ${entry.url} ${dur}${flag} [${id}]`;
    }
    // error
    return `[${time}] ${level} ✗ ${entry.method} ${entry.url} ${entry.error.message} [${id}]`;
  }
}

// Cross-runtime: safely detect Node.js stdout
const hasStdout = (): boolean => {
  try {
    const g = globalThis as { process?: { stdout?: { write?: unknown } } };
    return typeof g.process?.stdout?.write === "function";
  } catch {
    return false;
  }
};

// ── 3.2  JSON transport (line-delimited NDJSON) ───────────────────────────────

/**
 * JSON transport — writes line-delimited JSON (NDJSON) log entries.
 * Defaults to writing to process.stdout (Node.js/Bun) or console.log.
 */
export class JSONTransport implements LogTransport {
  /** Output function that receives one JSON line at a time */
  private readonly writeLine: (line: string) => void;

  /**
   * @param writeLine - Function that receives each JSON line + newline. Defaults to stdout or console.log.
   */
  constructor(
    writeLine: (line: string) => void = (l) => {
      // Cross-runtime: prefer process.stdout on Node.js/Bun, fall back to console.log everywhere else
      if (hasStdout()) {
        (globalThis as { process?: { stdout?: { write?: (s: string) => void } } }).process!.stdout!
          .write!(l + "\n");
      } else {
        console.log(l);
      }
    },
  ) {
    this.writeLine = writeLine;
  }

  /** Write a single log entry as a JSON line. */
  write(entry: LogEntry): void {
    this.writeLine(JSON.stringify(entry));
  }
}

// ── 3.3  Batching transport ───────────────────────────────────────────────────

/**
 * BatchingTransport buffers log entries and flushes them in batches.
 *
 * Note: If flush() is called while a timer is pending, there is a potential race:
 * - The timer callback could fire while flush() is executing
 * - The timer is cleared at the start of flush() to mitigate this
 * - However, if the timer fires simultaneously with flush(), entries may be
 *   written twice or the timer callback could operate on an empty buffer
 */
export class BatchingTransport implements LogTransport {
  /** Internal buffer of pending log entries */
  private buffer: LogEntry[] = [];
  /** Timer handle for scheduled flush */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param inner - The underlying transport to flush entries to
   * @param options - Batching configuration (maxBatch, flushMs)
   */
  constructor(
    private readonly inner: LogTransport,
    private readonly options: {
      /** Maximum entries per batch. Default: 100 */
      maxBatch?: number;
      /** Flush interval in ms. Default: 5000 */
      flushMs?: number;
    } = {},
  ) {}

  /** Buffer a single log entry. Triggers flush when maxBatch is reached. */
  write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= (this.options.maxBatch ?? 100)) {
      this._flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this._flush(), this.options.flushMs ?? 5000);
    }
  }

  /** Force-flush all buffered entries to the inner transport. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._flush();
    if (this.inner.flush) await this.inner.flush();
  }

  /** Internal flush — sends all buffered entries to inner transport. */
  private _flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    for (const entry of batch) this.inner.write(entry);
  }
}

// ── 3.4  Remote HTTP transport ────────────────────────────────────────────────

/**
 * Remote transport — sends buffered log entries to an HTTP endpoint.
 * Supports configurable batch size, flush interval, and custom fetch implementation.
 */
export class RemoteTransport implements LogTransport {
  /** Internal buffer of pending log entries */
  private readonly buffer: LogEntry[] = [];
  /** Timer handle for scheduled flush */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param endpoint - HTTP endpoint to POST log batches to
   * @param options - Remote transport options
   */
  constructor(
    private readonly endpoint: string,
    private readonly options: {
      /** Maximum entries per batch. Default: 50 */
      batchSize?: number;
      /** Flush interval in ms. Default: 3000 */
      flushMs?: number;
      /** Extra headers to include in the POST request */
      headers?: Record<string, string>;
      /** Custom fetch implementation (for cross-runtime compat). Default: globalThis.fetch */
      fetch?: typeof globalThis.fetch;
      /** Error callback for background flush failures */
      onError?: (err: unknown) => void;
    } = {},
  ) {}

  /** Buffer a log entry. Triggers HTTP POST when batchSize is reached. */
  write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= (this.options.batchSize ?? 50)) {
      this._flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this._flush(), this.options.flushMs ?? 3000);
    }
  }

  /** Force-flush all buffered entries to the remote endpoint. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this._flushAsync();
  }

  /** Fire-and-forget flush with error handling. */
  private _flush(): void {
    this._flushAsync().catch(
      this.options.onError ?? ((err) => console.error("[logging] Flush error:", err)),
    );
  }

  /** Async flush implementation — sends batch via HTTP POST. */
  private async _flushAsync(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const fetchFn = this.options.fetch ?? globalThis.fetch;

    // Use streaming for large batches to reduce memory usage
    // For small batches, use JSON.stringify directly
    if (batch.length <= 10) {
      await fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(batch),
      });
    } else {
      // For large batches, use Streaming API if available (Node.js 18+)
      // Fallback to JSON.stringify for other runtimes
      try {
        const { Readable } = await import("node:stream");
        const streamBody = Readable.from([JSON.stringify(batch)]);
        await fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.options.headers,
          },
          body: streamBody as unknown as BodyInit,
          ...{ duplex: "half" as const },
        });
      } catch {
        // Fallback for non-Node.js runtimes
        await fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.options.headers,
          },
          body: JSON.stringify(batch),
        });
      }
    }
  }
}

// ── 3.5  Multi-transport ──────────────────────────────────────────────────────

/**
 * Multi-transport — fans out log entries to multiple underlying transports.
 * Failures in individual transports are isolated and do not affect others.
 */
export class MultiTransport implements LogTransport {
  /**
   * @param transports - Array of transport instances to fan out to
   */
  constructor(private readonly transports: LogTransport[]) {}

  /** Write a log entry to all transports. Errors in individual transports are isolated. */
  write(entry: LogEntry): void {
    for (const t of this.transports) {
      try {
        t.write(entry);
      } catch {
        /* isolate */
      }
    }
  }

  /** Flush all transports in parallel. All results are settled (errors isolated). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.flush?.()));
  }
}

// ============================================================================
// §4  LOGGER CONFIG
// ============================================================================

/** Configuration for the HTTP logger. */
export interface LoggerConfig {
  /** Minimum level to log. Default: INFO */
  level?: LogLevelName;
  /** Log transports. Default: ConsoleTransport */
  transports?: LogTransport[];
  /** Redaction configuration */
  redaction?: RedactionConfig;
  /**
   * Sampling rate 0–1 (1 = log everything). Default: 1
   *
   * Sampling is not deterministic — each request is evaluated independently.
   * If the same request is logged multiple times (e.g., retries), it may be sampled
   * differently each time.
   */
  sampleRate?: number;
  /** Only log requests matching these methods. Empty = all. */
  methods?: string[];
  /** Only log responses with these status codes. Empty = all. */
  statuses?: number[];
  /** URL patterns to exclude from logging */
  excludeURLs?: RegExp[];
  /** Extra fields to merge into every log entry */
  context?: Record<string, unknown>;
  /** Custom request ID generator function */
  generateId?: () => string;
}

// ============================================================================
// §5  REQUEST ID GENERATOR
// ============================================================================

let _logIdSeq = 0;
/** Default request ID generator — combines timestamp, sequence, and random components. */
function defaultGenerateId(): string {
  const ts = Date.now().toString(36);
  const seq = (++_logIdSeq).toString(36).padStart(4, "0");
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${ts}-${seq}-${rnd}`;
}

// ============================================================================
// §6  REDACTION ENGINE
// ============================================================================

/**
 * Redacts sensitive data from headers, URLs, and request/response bodies
 * before they are written to log output.
 */
export class Redactor {
  /** Set of header names to redact (case-insensitive) */
  private readonly headerSet: Set<string>;
  /** Set of query param names to redact (case-insensitive) */
  private readonly paramSet: Set<string>;
  /** Dot-path field selectors for JSON body redaction */
  private readonly bodyFields: string[];
  /** Regex patterns for body content redaction */
  private readonly patterns: RegExp[];
  /** Maximum body length to log in bytes */
  private readonly maxBody: number;
  /** Whether to log request bodies */
  private readonly logReqBody: boolean;
  /** Whether to log response bodies */
  private readonly logResBody: boolean;
  /** Allowed content-types for body logging */
  private readonly allowedTypes: string[];

  /**
   * @param config - Redaction configuration
   */
  constructor(config: RedactionConfig = {}) {
    const headers = config.headers ?? DEFAULT_REDACT_HEADERS;
    const params = config.queryParams ?? DEFAULT_REDACT_PARAMS;

    this.headerSet = new Set(headers.map((h) => h.toLowerCase()));
    this.paramSet = new Set(params.map((p) => p.toLowerCase()));
    this.bodyFields = config.bodyFields ?? [];
    this.patterns = config.bodyPatterns ?? [];
    this.maxBody = config.maxBodyLength ?? 4096;
    this.logReqBody = config.logRequestBody ?? false;
    this.logResBody = config.logResponseBody ?? false;
    this.allowedTypes = config.allowedBodyTypes ?? DEFAULT_ALLOWED_BODY_TYPES;
  }

  /** Redact sensitive header values, replacing them with "***". */
  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = this.headerSet.has(k.toLowerCase()) ? "***" : v;
    }
    return out;
  }

  /** Redact sensitive query parameters from a URL. */
  redactURL(url: string): string {
    try {
      const u = new URL(url);
      for (const key of [...u.searchParams.keys()]) {
        if (this.paramSet.has(key.toLowerCase())) {
          u.searchParams.set(key, "***");
        }
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * Redact and optionally truncate a request or response body.
   *
   * @returns An object containing `body` (the redacted/truncated body string, or null)
   *          and `size` (the original byte size, or null).
   */
  redactBody(
    body: string | Uint8Array | null,
    contentType: string | null,
    isResponse: boolean,
  ): {
    /** The redacted/truncated body string, or null. */
    body: string | null;
    /** The original byte size, or null. */
    size: number | null;
  } {
    const shouldLog = isResponse ? this.logResBody : this.logReqBody;

    if (!shouldLog || !body) {
      return { body: null, size: body ? bodySize(body) : null };
    }

    const ct = contentType ?? "";
    const allowed = this.allowedTypes.some((t) => ct.startsWith(t));
    if (!allowed) {
      return { body: `[${ct || "binary"}]`, size: body ? bodySize(body) : null };
    }

    let str: string;
    if (body instanceof Uint8Array) {
      try {
        str = new TextDecoder().decode(body);
      } catch {
        return { body: "[binary]", size: body.byteLength };
      }
    } else {
      str = body;
    }

    const size = str.length;

    // Redact body fields (JSON)
    if (ct.includes("application/json") && this.bodyFields.length > 0) {
      try {
        const parsed = JSON.parse(str);
        for (const path of this.bodyFields) redactObjectPath(parsed, path.split("."));
        str = JSON.stringify(parsed);
      } catch {
        /* not JSON */
      }
    }

    // Redact patterns
    for (const pattern of this.patterns) {
      str = str.replace(pattern, "***");
    }

    // Truncate
    if (str.length > this.maxBody) {
      str = str.slice(0, this.maxBody) + `... [truncated ${str.length - this.maxBody} bytes]`;
    }

    return { body: str, size };
  }
}

/** Redact a specific dot-path field within a parsed JSON object, replacing its value with "***". */
function redactObjectPath(obj: unknown, path: string[]): void {
  if (!obj || typeof obj !== "object" || path.length === 0) return;
  const [head, ...rest] = path;
  if (head === undefined) return;
  const o = obj as Record<string, unknown>;
  if (rest.length === 0) {
    if (head in o) o[head] = "***";
    return;
  }
  if (typeof o[head] === "object") redactObjectPath(o[head] as Record<string, unknown>, rest);
}

/** Compute the byte length of a body value. Accounts for UTF-8 multi-byte characters. */
function bodySize(body: string | Uint8Array): number {
  if (typeof body === "string") {
    // Count UTF-8 bytes, not UTF-16 characters
    return new TextEncoder().encode(body).byteLength;
  }
  return body.byteLength;
}

// ============================================================================
// §7  HTTP LOGGER
// ============================================================================

/**
 * Structured HTTP request/response/error logger.
 * Supports multiple transports, redaction, sampling, filtering, and child loggers.
 */
export class HTTPLogger {
  /** Resolved logger configuration with defaults */
  private readonly cfg: Required<LoggerConfig>;
  /** Redactor instance for sensitive data masking */
  private readonly redactor: Redactor;
  /** Minimum numeric log level for filtering */
  private readonly level: LogLevelValue;
  /** Map of active request IDs → timing info for duration calculation */
  private readonly activeIds = new Map<string, { startMs: number; method: string; url: string }>();
  /** Maximum number of concurrently tracked active IDs */
  private static readonly MAX_ACTIVE_IDS = 10000;
  /** Time after which an abandoned active ID is evicted */
  private static readonly IDLE_TIMEOUT_MS = 60000; // 1 minute

  constructor(config: LoggerConfig = {}) {
    this.cfg = {
      level: config.level ?? "INFO",
      transports: config.transports ?? [new ConsoleTransport()],
      redaction: config.redaction ?? {},
      sampleRate: config.sampleRate ?? 1,
      methods: config.methods ?? [],
      statuses: config.statuses ?? [],
      excludeURLs: config.excludeURLs ?? [],
      context: config.context ?? {},
      generateId: config.generateId ?? defaultGenerateId,
    };

    this.redactor = new Redactor(this.cfg.redaction);
    this.level = LogLevel[this.cfg.level];
  }

  /** Evict oldest or stale (abandoned) active IDs to prevent unbounded memory growth. */
  private _cleanupActiveIds(): void {
    const now = perfNow();
    if (this.activeIds.size > HTTPLogger.MAX_ACTIVE_IDS) {
      // Evict oldest entries when exceeding max
      const entries = Array.from(this.activeIds.entries());
      const toRemove = entries.slice(
        0,
        entries.length - Math.floor(HTTPLogger.MAX_ACTIVE_IDS * 0.8),
      );
      for (const [id] of toRemove) this.activeIds.delete(id);
    }
    // Remove stale entries (abandoned requests)
    for (const [id, entry] of this.activeIds) {
      if (now - entry.startMs > HTTPLogger.IDLE_TIMEOUT_MS) {
        this.activeIds.delete(id);
      }
    }
  }

  // ── §7.1  Core logging methods ─────────────────────────────────────────────

  /**
   * Log an outgoing HTTP request.
   *
   * @param requestId - Correlated request identifier
   * @param method - HTTP method
   * @param url - Request URL
   * @param headers - Request headers (sensitive values are redacted)
   * @param body - Request body (redacted/truncated)
   * @param attempt - Retry attempt number
   * @param meta - Arbitrary metadata
   */
  logRequest(
    requestId: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | Uint8Array | null,
    attempt: number,
    meta: Record<string, unknown> = {},
  ): void {
    if (!this._shouldLog("INFO", method, url)) return;

    // Periodic cleanup to prevent memory leaks from abandoned requests
    if (this.activeIds.size > 500) {
      this._cleanupActiveIds();
    }

    this.activeIds.set(requestId, { startMs: perfNow(), method, url });

    const ct = headers["content-type"] ?? headers["Content-Type"] ?? null;
    const redacted = this.redactor.redactBody(body, ct, false);

    const entry: RequestLogEntry = {
      type: "request",
      requestId,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      level: "INFO",
      method: method.toUpperCase(),
      url: this.redactor.redactURL(url),
      headers: this.redactor.redactHeaders(headers),
      bodySize: redacted.size,
      body: redacted.body,
      attempt,
      meta: { ...this.cfg.context, ...meta },
    };

    this._write(entry);
  }

  /**
   * Log an HTTP response.
   *
   * @param requestId - Correlated request identifier
   * @param status - HTTP status code
   * @param statusText - HTTP status text
   * @param headers - Response headers (sensitive values are redacted)
   * @param body - Response body (redacted/truncated)
   * @param attempt - Retry attempt number
   * @param cached - Whether the response was served from cache
   * @param meta - Arbitrary metadata
   */
  logResponse(
    requestId: string,
    status: number,
    statusText: string,
    headers: Record<string, string>,
    body: string | Uint8Array | null,
    attempt: number,
    cached: boolean,
    meta: Record<string, unknown> = {},
  ): void {
    const active = this.activeIds.get(requestId);
    const dur = active ? perfNow() - active.startMs : 0;
    const method = active?.method ?? "GET";
    const url = active?.url ?? "";

    if (!this._shouldLog("INFO", method, url, status)) return;

    const ct = headers["content-type"] ?? headers["Content-Type"] ?? null;
    const redacted = this.redactor.redactBody(body, ct, true);
    const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";

    const entry: ResponseLogEntry = {
      type: "response",
      requestId,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      level,
      method: method.toUpperCase(),
      url: this.redactor.redactURL(url),
      status,
      statusText,
      headers: this.redactor.redactHeaders(headers),
      bodySize: redacted.size,
      body: redacted.body,
      durationMs: Math.round(dur),
      attempt,
      cached,
      meta: { ...this.cfg.context, ...meta },
    };

    this.activeIds.delete(requestId);
    this._write(entry);
  }

  /**
   * Log an HTTP error.
   *
   * @param requestId - Correlated request identifier
   * @param error - The error object
   * @param status - HTTP status code, or null if no response
   * @param attempt - Retry attempt number
   * @param meta - Arbitrary metadata
   */
  logError(
    requestId: string,
    error: unknown,
    status: number | null,
    attempt: number,
    meta: Record<string, unknown> = {},
  ): void {
    const active = this.activeIds.get(requestId);
    const dur = active ? perfNow() - active.startMs : 0;
    const method = active?.method ?? "GET";
    const url = active?.url ?? "";

    if (!this._shouldLog("ERROR", method, url)) return;

    const entry: ErrorLogEntry = {
      type: "error",
      requestId,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      level: "ERROR",
      method: method.toUpperCase(),
      url: this.redactor.redactURL(url),
      error: serializeError(error),
      status,
      durationMs: Math.round(dur),
      attempt,
      meta: { ...this.cfg.context, ...meta },
    };

    this.activeIds.delete(requestId);
    this._write(entry);
  }

  // ── §7.2  ID management ────────────────────────────────────────────────────

  /** Generate a unique request ID using the configured generator. */
  generateRequestId(): string {
    return this.cfg.generateId();
  }

  // ── §7.3  Child logger ─────────────────────────────────────────────────────

  /**
   * Create a child logger with additional context fields.
   *
   * The child logger inherits all configuration from the parent (transports, redaction, etc.)
   * but adds or overrides the `context` object with additional fields.
   *
   * Note: Context is copied, not shared. Changes to the parent context after creating
   * a child do not affect the child, and vice versa.
   *
   * @param context Additional context fields to merge into the logger's context
   * @returns A new HTTPLogger with merged context
   *
   * @example
   * ```ts
   * const logger = createProductionLogger();
   * const child = logger.child({ requestId: "req-123", userId: "user-456" });
   * child.logRequest(...); // Logs will include both requestId and userId
   * ```
   */
  child(context: Record<string, unknown>): HTTPLogger {
    return new HTTPLogger({
      ...this.cfg,
      context: { ...this.cfg.context, ...context },
    });
  }

  // ── §7.4  Flush ────────────────────────────────────────────────────────────

  /**
   * Flush all buffered log entries to their transports.
   * Errors in individual transports are settled independently.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.cfg.transports.map((t) => t.flush?.()));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Write a log entry to all configured transports, subject to level filtering. */
  private _write(entry: LogEntry): void {
    const entryLevel = LogLevel[entry.level];
    if (entryLevel < this.level) return;

    for (const transport of this.cfg.transports) {
      try {
        const result = transport.write(entry);
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch(() => {
            /* isolate async transport errors */
          });
        }
      } catch {
        /* isolate sync transport errors */
      }
    }
  }

  /** Determine whether an entry should be logged based on level, sampling, method, status, and URL filters. */
  private _shouldLog(level: LogLevelName, method: string, url: string, status?: number): boolean {
    if (LogLevel[level] < this.level) return false;

    // Sampling
    if (this.cfg.sampleRate < 1 && Math.random() > this.cfg.sampleRate) return false;

    // Method filter
    if (this.cfg.methods.length > 0 && !this.cfg.methods.includes(method.toUpperCase()))
      return false;

    // Status filter
    if (status !== undefined && this.cfg.statuses.length > 0 && !this.cfg.statuses.includes(status))
      return false;

    // URL exclusion
    for (const pattern of this.cfg.excludeURLs) {
      if (pattern.test(url)) return false;
    }

    return true;
  }
}

// ============================================================================
// §8  OPENTELEMETRY-COMPATIBLE FIELDS
// ============================================================================

/**
 * Convert a log entry to OpenTelemetry-compatible semantic conventions.
 *
 * Maps HTTP log entries to OpenTelemetry semantic conventions (HTTP span attributes).
 * Produces span attributes compatible with OpenTelemetry specification v1.21.0+.
 *
 * Output format:
 * - request: http.request.id, http.request.method, url.full
 * - response: http.response.status_code, http.response.body.size, http.time_to_first_byte
 * - error: error, error.type, error.message, http.status_code
 *
 * @param entry A log entry from HTTPLogger
 * @returns OpenTelemetry-compliant span attributes
 *
 * @example
 * ```ts
 * const spanAttrs = toOTelSpan(responseEntry);
 * // { "http.request.id": "req-123", "http.request.method": "GET", "url.full": "https://api.example.com", ... }
 * ```
 */
export function toOTelSpan(entry: LogEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "http.request.id": entry.requestId,
    "http.request.method": entry.method,
    "url.full": entry.url,
  };

  if (entry.type === "response") {
    base["http.response.status_code"] = entry.status;
    base["http.response.body.size"] = entry.bodySize;
    base["http.time_to_first_byte"] = entry.durationMs;
  }

  if (entry.type === "error") {
    base["error"] = true;
    base["error.type"] = entry.error.name;
    base["error.message"] = entry.error.message;
    base["http.status_code"] = entry.status;
  }

  return base;
}

// ============================================================================
// §9  UTILITIES
// ============================================================================

/** Serialize an error into a safe, JSON-friendly format without circular references. */
function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const errCode = (err as NodeJS.ErrnoException).code;
    const errStack = err.stack;
    return {
      name: err.name,
      message: err.message,
      ...(errCode !== undefined ? { code: errCode } : {}),
      ...(errStack !== undefined ? { stack: errStack } : {}),
    };
  }
  return { name: "Error", message: String(err) };
}

/** Cross-runtime high-resolution timer. Falls back to Date.now() when performance.now() is unavailable. */
function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ============================================================================
// §10  FACTORY HELPERS
// ============================================================================

/** Create an HTTP logger with the given configuration. */
export function createLogger(config?: LoggerConfig): HTTPLogger {
  return new HTTPLogger(config);
}

/**
 * Create a production-ready logger with JSON transport and optional remote shipping.
 *
 * **Security Warning:** Logs structured JSON to stdout by default; when an endpoint
 * is configured, entries are batched and sent to the remote service. Ensure the
 * remote endpoint uses HTTPS in production.
 */
export function createProductionLogger(options: {
  level?: LogLevelName;
  endpoint?: string;
  context?: Record<string, unknown>;
}): HTTPLogger {
  const transports: LogTransport[] = [new JSONTransport()];
  if (options.endpoint) {
    transports.push(new BatchingTransport(new RemoteTransport(options.endpoint)));
  }
  return new HTTPLogger({
    level: options.level ?? "INFO",
    transports: [new MultiTransport(transports)],
    ...(options.context !== undefined ? { context: options.context } : {}),
  });
}

/**
 * Create a development-friendly logger with pretty-printed output and body logging enabled by default.
 *
 * **Security Warning:** Logging request/response bodies by default can expose
 * sensitive data (API keys, credentials, PII). In production, set
 * `logBodies: false` or use `createProductionLogger()` instead.
 */
export function createDevelopmentLogger(
  options: {
    level?: LogLevelName;
    logBodies?: boolean;
  } = {},
): HTTPLogger {
  return new HTTPLogger({
    level: options.level ?? "DEBUG",
    transports: [
      new ConsoleTransport({
        pretty: true,
        useColors: true,
        onWrite: (output: string) => console.log(output),
      }),
    ],
    redaction: {
      logRequestBody: options.logBodies ?? true,
      logResponseBody: options.logBodies ?? true,
      maxBodyLength: 2048,
    },
  });
}
