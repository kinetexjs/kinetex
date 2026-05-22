/**
 * graphql.ts
 *
 * GraphQL client.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Query, Mutation, Subscription execution
 *  - Typed request/response generics
 *  - Automatic persisted queries (APQ) with SHA-256 hash
 *  - GET request for queries (CDN-cacheable)
 *  - POST request for mutations
 *  - GraphQL over SSE (subscriptions via SSE transport)
 *  - GraphQL over WebSocket (subscriptions via WS transport)
 *  - Batched requests
 *  - Variable merging
 *  - Fragment extraction
 *  - Error normalization (GraphQL errors + network errors)
 *  - Inline + file upload (multipart request spec)
 *  - Request deduplication
 *  - Response caching (normalized)
 *  - Schema introspection helper
 *  - Typed GraphQLError with extensions
 *  - Middleware / link chain (Relay-style)
 *  - Per-operation timeout
 *  - Retry on network error
 */

import { KinetexError as _KinetexError, ValidationError } from "./types.ts";

// ============================================================================
// §1  TYPES
// ============================================================================

/** A single error returned in a GraphQL response `errors` array (spec §6.4). */
export interface GraphQLError {
  /** Human-readable error description */
  message: string;
  /**
   * Source locations in the query document that triggered the error.
   * Each entry has a `line` and `column` number (1-indexed).
   */
  locations?: Array<{
    /** Line number (1-indexed). */
    line: number;
    /** Column number (1-indexed). */
    column: number;
  }>;
  /** Path to the field that caused the error (field names / array indices) */
  path?: Array<string | number>;
  /** Server-defined extension data (error code, stack trace, etc.) */
  extensions?: Record<string, unknown>;
}

/** Standard GraphQL response envelope (spec §6.3). */
export interface GraphQLResponse<T = unknown> {
  /** Requested data — absent on errors */
  data?: T;
  /** Non-empty on query errors (validation, resolver failure, etc.) */
  errors?: GraphQLError[];
  /** Server-defined extension data */
  extensions?: Record<string, unknown>;
}

/** A single GraphQL request (spec §6.2). */
export interface GraphQLRequest<V = Record<string, unknown>> {
  /** The GraphQL query, mutation, or subscription document */
  query: string;
  /** Variable values keyed by name (spec §6.2.2) */
  variables?: V;
  /** Named operation to execute (required when the document has >1 operation) */
  operationName?: string;
  /** Implementation-specific extensions (APQ, tracing, etc.) */
  extensions?: Record<string, unknown>;
  /** Per-request headers (merged into client-level headers) */
  headers?: Record<string, string>;
}

/** Batch of GraphQL requests sent in a single HTTP call (GraphQL batching convention). */
export interface GraphQLBatchRequest {
  /** Array of individual GraphQL requests to execute */
  requests: GraphQLRequest[];
}

/** Configuration options for {@link GraphQLClient}. */
export interface GraphQLClientConfig {
  /** GraphQL endpoint URL */
  url: string;
  /** Default headers for all requests */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Fetch implementation */
  fetch?: typeof globalThis.fetch;
  /** Use GET for queries (default: false) */
  useGETForQueries?: boolean;
  /**
   * Enable Automatic Persisted Queries (APQ).
   *
   * APQ improves performance by:
   * 1. Sending only a SHA-256 hash of the query on first request
   * 2. Server caches the hash→query mapping
   * 3. Subsequent requests send only the hash, reducing payload size
   *
   * The APQ cache is shared across all GraphQLClient instances (process-wide cache).
   * The cache holds up to 1000 entries with LRU eviction.
   *
   * @example
   * ```ts
   * const client = new GraphQLClient({
   *   url: "https://api.example.com/graphql",
   *   enableAPQ: true,  // Enable APQ
   * });
   * ```
   */
  enableAPQ?: boolean;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Number of retries on network error (default: 0) */
  retries?: number;
  /** Retry delay in ms (default: 300) */
  retryDelayMs?: number;
  /** Middleware/link chain */
  links?: GraphQLLink[];
  /** AbortSignal */
  signal?: AbortSignal;
  /** Called on every request (for logging, tracing etc.) */
  onRequest?: (req: GraphQLRequest) => void;
  /** Called on every response */
  onResponse?: (res: GraphQLResponse, req: GraphQLRequest) => void;
  /** Called on error */
  onError?: (err: GraphQLClientError, req: GraphQLRequest) => void;
}

/** Discriminated union of supported GraphQL operation kinds. */
export type GraphQLOperationType = "query" | "mutation" | "subscription";

// ============================================================================
// §2  ERRORS
// ============================================================================

/**
 * Error raised by the GraphQL client for network failures, GraphQL-layer
 * errors, response parse failures, timeouts, and missing data.
 *
 * Use the {@link isGraphQLError} / {@link isNetworkError} getters to
 * distinguish error categories.
 */
export class GraphQLClientError extends Error {
  /** Machine-readable error code (e.g. `"EGRAPHQL"`, `"ENETWORK"`, `"ETIMEOUT"`) */
  readonly code: string;

  /**
   * @param message       - Human-readable error description
   * @param code          - Machine-readable error code
   * @param graphQLErrors - Errors returned in the GraphQL response `errors` array
   * @param request       - The GraphQL request that triggered the error
   * @param response      - The (partial) GraphQL response, if available
   * @param networkError  - Underlying network / transport error, if applicable
   */
  constructor(
    message: string,
    code: string,
    public readonly graphQLErrors?: GraphQLError[],
    public readonly request?: GraphQLRequest,
    public readonly response?: GraphQLResponse,
    public readonly networkError?: unknown,
  ) {
    super(message);
    this.name = "GraphQLClientError";
    this.code = code;
  }

  /** True if the error contains GraphQL-layer errors (not network). */
  get isGraphQLError(): boolean {
    return !!this.graphQLErrors && this.graphQLErrors.length > 0;
  }

  /** True if the error is a network/transport error. */
  get isNetworkError(): boolean {
    return !!this.networkError;
  }

  /** Return the first error message from the GraphQL errors array. */
  get firstErrorMessage(): string | null {
    return this.graphQLErrors?.[0]?.message ?? null;
  }
}

function buildGraphQLError(
  graphQLErrors: GraphQLError[],
  req: GraphQLRequest,
  res: GraphQLResponse,
): GraphQLClientError {
  const message = graphQLErrors.map((e) => e.message).join("; ");
  return new GraphQLClientError(message, "EGRAPHQL", graphQLErrors, req, res);
}

// ============================================================================
// §3  LINK CHAIN (Relay-style middleware)
// ============================================================================

/**
 * A GraphQL operation ready to be processed by a link chain.
 * Wraps the request alongside client configuration for middleware access.
 */
export interface GraphQLOperation<V = Record<string, unknown>> {
  /** The GraphQL request (query, variables, etc.) */
  request: GraphQLRequest<V>;
  /** Client configuration (URL, headers, etc.) */
  config: GraphQLClientConfig;
  /** Abort signal for request cancellation */
  signal?: AbortSignal;
}

/**
 * Next link in the chain - calls the next middleware or terminal handler.
 */
export type GraphQLLinkNext = (op: GraphQLOperation) => Promise<GraphQLResponse>;

/**
 * GraphQL middleware link - similar to Relay-style middleware.
 *
 * Links form a chain where each link can:
 * - Transform the operation before passing to `next`
 * - Transform the response after `next` returns
 * - Short-circuit and return early without calling `next`
 * - Add headers or modify config
 *
 * @example
 * ```ts
 * // Custom link that adds a header
 * const authLink = (op, next) => {
 *   op.config.headers = { ...op.config.headers, Authorization: "Bearer token" };
 *   return next(op);
 * };
 *
 * // Custom link that logs timing
 * const timingLink = async (op, next) => {
 *   const start = Date.now();
 *   const res = await next(op);
 *   console.log(`Query took ${Date.now() - start}ms`);
 *   return res;
 * };
 *
 * const client = new GraphQLClient({
 *   url: "https://api.example.com/graphql",
 *   links: [authLink, timingLink],
 * });
 * ```
 */
export type GraphQLLink = (op: GraphQLOperation, next: GraphQLLinkNext) => Promise<GraphQLResponse>;

// Utility function (B-10 fix - moved before usage)
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLinkChain(links: GraphQLLink[], terminal: GraphQLLinkNext): GraphQLLinkNext {
  return links.reduceRight(
    (next: GraphQLLinkNext, link: GraphQLLink) => (op) => link(op, next),
    terminal,
  );
}

// ============================================================================
// §4  OPERATION TYPE DETECTION
// ============================================================================

/**
 * Determine the operation type from a raw GraphQL query string.
 * Strips comments, then matches the first operation keyword.
 *
 * @param query - Raw GraphQL query/mutation/subscription string
 * @returns `"query"`, `"mutation"`, or `"subscription"`
 */
export function detectOperationType(query: string): GraphQLOperationType {
  const trimmed = query.replace(/^\s*#.*$/gm, "").trim();
  if (/^\s*mutation\s/i.test(trimmed)) return "mutation";
  if (/^\s*subscription\s/i.test(trimmed)) return "subscription";
  return "query";
}

/**
 * Extract the operation name from a raw GraphQL query string.
 * Returns `null` for anonymous operations.
 *
 * @param query - Raw GraphQL query/mutation/subscription string
 * @returns Operation name (e.g. `"GetUser"`) or `null` if anonymous
 */
export function extractOperationName(query: string): string | null {
  const trimmed = query.replace(/^\s*#.*$/gm, "").trim();
  const m = trimmed.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/im);
  return m ? m[1]! : null;
}

// ============================================================================
// §5  AUTOMATIC PERSISTED QUERIES (APQ)
// ============================================================================

async function sha256Hex(str: string): Promise<string> {
  const encoded = new TextEncoder().encode(str);
  const buf: ArrayBuffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Maximum APQ cache entries to prevent memory leaks */
const MAX_APQ_CACHE_ENTRIES = 1000;
/** APQ cache entry TTL in ms — entries older than this are evicted */
const APQ_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** How often to run APQ cache cleanup in ms */
const APQ_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// §6  REQUEST BUILDING
// ============================================================================

async function buildHeaders(
  config: GraphQLClientConfig,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };

  const configured =
    typeof config.headers === "function" ? await config.headers() : (config.headers ?? {});

  return { ...base, ...configured, ...extra };
}

/**
 * Maximum allowed GraphQL query length (100KB) to prevent DoS attacks.
 */
const MAX_QUERY_LENGTH = 100 * 1024;

/**
 * Maximum allowed query depth to prevent stack overflow attacks.
 * A query depth of 100 is more than enough for any reasonable query.
 */
const MAX_QUERY_DEPTH = 100;

/**
 * Pattern to detect potentially malicious GraphQL queries.
 *
 * These patterns prevent common attack vectors:
 * - Nested braces without closing → Depth attacks / DoS
 * - XML-like patterns → XXE injection attempts
 * - HTML comments → Comment injection
 * - Script tags → XSS attempts
 * - javascript: URLs → Protocol handler injection
 * - onerror/eval → Event handler injection / code execution
 *
 * This is a basic defense layer. For production GraphQL APIs,
 * consider using a dedicated security tool like graphql-guard,
 * GraphQL Armor, or Istapaper.
 */
const MALICIOUS_QUERY_PATTERNS = [
  /\{\s*\{/, // Deeply nested braces without closing
  /<\s*</, // Potential XML/XXE injection attempt
  /<!--/, // HTML/XML comment injection
  /<script/, // XSS via script tags
  /javascript:/i, // JavaScript protocol handler injection
  /onerror\s*=/i, // Event handler injection (onerror=, onclick=, etc.)
  /eval\s*\(/i, // Code execution via eval()
];

/**
 * Validate a GraphQL query for safety.
 * Prevents excessively large queries and detects malicious patterns.
 *
 * @param query - Raw GraphQL query string to validate
 * @throws {@link ValidationError} If the query exceeds length/depth limits,
 *   contains malicious patterns, or has unbalanced braces.
 */
function validateGraphQLQuery(query: string): void {
  // Check length
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(`GraphQL query exceeds maximum length of ${MAX_QUERY_LENGTH} bytes`);
  }

  // Check for malicious patterns
  for (const pattern of MALICIOUS_QUERY_PATTERNS) {
    if (pattern.test(query)) {
      throw new ValidationError(`GraphQL query contains potentially malicious pattern: ${pattern}`);
    }
  }

  // Basic depth check by counting open braces
  let depth = 0;
  let maxDepth = 0;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    if (char === "{") {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    } else if (char === "}") {
      depth--;
    }
  }

  if (maxDepth > MAX_QUERY_DEPTH) {
    throw new ValidationError(`GraphQL query exceeds maximum depth of ${MAX_QUERY_DEPTH}`);
  }

  // Check for unbalanced braces
  if (depth !== 0) {
    throw new ValidationError("GraphQL query has unbalanced braces");
  }
}

/**
 * Safely serialize a value to JSON, enforcing a maximum length to prevent
 * DDoS / resource-exhaustion attacks via oversized payloads.
 *
 * @param value    - Value to JSON-serialize
 * @param maxLength - Maximum allowed string length (default 10 000)
 * @returns JSON string
 * @throws {@link ValidationError} If the serialized string exceeds `maxLength`
 */
function safeStringify(value: unknown, maxLength: number = 10000): string {
  const str = JSON.stringify(value);
  if (str.length > maxLength) {
    throw new ValidationError(`String value exceeds maximum length of ${maxLength} characters`);
  }
  return str;
}

/**
 * Build a GET URL for a GraphQL request by appending query, variables,
 * operationName, and extensions as URL search parameters.
 * Validates the query before building the URL.
 *
 * @param url - Base GraphQL endpoint URL
 * @param req - GraphQL request (query, variables, etc.)
 * @returns Full URL with query parameters appended
 */
function buildGETUrl(url: string, req: GraphQLRequest): string {
  // Skip validation for empty query (APQ mode uses empty query) - B-3 fix
  if (req.query) {
    validateGraphQLQuery(req.query);
  }

  const u = new URL(url);
  const body = buildJSONBody(req);

  u.searchParams.set("query", req.query);
  if (req.operationName) u.searchParams.set("operationName", req.operationName);
  if (req.variables && Object.keys(req.variables).length > 0) {
    u.searchParams.set("variables", safeStringify(req.variables));
  }
  if (req.extensions && Object.keys(req.extensions).length > 0) {
    u.searchParams.set("extensions", safeStringify(req.extensions));
  }

  void body; // suppress unused
  return u.toString();
}

/**
 * Build a JSON-serialized request body for a GraphQL POST.
 * Validates the query before building the body.
 *
 * @param req - GraphQL request
 * @returns JSON string for the POST body
 * @throws {@link ValidationError} If query validation fails or the body
 *   exceeds the maximum payload limit (100 KB)
 */
function buildJSONBody(req: GraphQLRequest): string {
  // Validate query before building body
  validateGraphQLQuery(req.query);

  const payload: Record<string, unknown> = { query: req.query };
  if (req.operationName) payload.operationName = req.operationName;
  if (req.variables) payload.variables = req.variables;
  if (req.extensions) payload.extensions = req.extensions;

  // Use safeStringify for the entire payload
  return safeStringify(payload, 100000); // 100KB limit for payload
}

// ============================================================================
// §7  MULTIPART FILE UPLOAD (GraphQL multipart request spec)
// ============================================================================

/**
 * Represents a file upload for GraphQL multipart request spec.
 *
 * @example
 * ```ts
 * // Upload a file to a mutation that expects:
 * // mutation UploadFile($file: Upload!) { uploadFile(file: $file) { id } }
 *
 * await client.upload(
 *   `mutation UploadFile($file: Upload!) { uploadFile(file: $file) { id } }`,
 *   {}, // no variables
 *   [{ file: myFile, path: "file" }]
 * );
 *
 * // For nested variable paths:
 * // mutation Upload($input: Input!) { upload(input: $input) { id } }
 * // where Input has `file: Upload`
 * await client.upload(
 *   `mutation Upload($input: Input!) { upload(input: $input) { id } }`,
 *   {},
 *   [{ file: myFile, path: "input.file" }]
 * );
 * ```
 */
export interface GraphQLUpload {
  /** The File or Blob to upload (Browser File or Node.js Buffer/Blob) */
  file: File | Blob;
  /**
   * Dot-notation path to the variable where this file should be placed.
   *
   * Examples:
   * - `"file"` → maps to variables.file
   * - `"input.file"` → maps to variables.input.file
   * - `"files.0"` → maps to variables.files[0]
   */
  path: string;
}

function buildMultipartBody(req: GraphQLRequest, uploads: GraphQLUpload[]): FormData {
  const form = new FormData();

  // Null out file variables in the operations object
  const operations = JSON.parse(buildJSONBody(req)) as Record<string, unknown>;

  // Build map: { "0": ["variables.input.file"], "1": [...] }
  const map: Record<string, string[]> = {};
  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i]!;
    map[String(i)] = [upload.path];
    setNestedValue(operations, upload.path, null);
  }

  form.append("operations", JSON.stringify(operations));
  form.append("map", JSON.stringify(map));

  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i]!;
    const name = upload.file instanceof File ? upload.file.name : `file_${i}`;
    form.append(String(i), upload.file, name);
  }

  return form;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

// ============================================================================
// §8  RESPONSE HANDLING
// ============================================================================

async function parseGraphQLResponse<T>(
  response: Response,
  req: GraphQLRequest,
): Promise<GraphQLResponse<T>> {
  const ct = response.headers.get("content-type") ?? "";

  if (!response.ok && !ct.includes("application/json")) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new GraphQLClientError(
      `HTTP ${response.status}: ${response.statusText}\n${text}`,
      "ENETWORK",
      undefined,
      req,
      undefined,
      new Error(`HTTP ${response.status}`),
    );
  }

  let json: GraphQLResponse<T>;
  try {
    json = (await response.json()) as GraphQLResponse<T>;
  } catch (err) {
    throw new GraphQLClientError(
      "Failed to parse GraphQL response as JSON",
      "EPARSE",
      undefined,
      req,
      undefined,
      err,
    );
  }

  return json;
}

// ============================================================================
// §9  CORE EXECUTE FUNCTION
// ============================================================================

async function executeHTTP<T>(
  req: GraphQLRequest,
  config: Required<GraphQLClientConfig>,
  signal: AbortSignal | null,
  apqMode: "none" | "omitQuery" | "full" = "none",
  getAPQHashFn?: (query: string) => Promise<string>,
): Promise<GraphQLResponse<T>> {
  const headers = await buildHeaders(config);
  const opType = detectOperationType(req.query);
  const useGET = config.useGETForQueries && opType === "query";

  let fetchUrl = config.url;
  let fetchBody: BodyInit | null = null;
  const fetchHeaders: Record<string, string> = { ...headers };

  if (apqMode === "omitQuery" || apqMode === "full") {
    // APQ: build extensions with persisted query hash
    const hash = getAPQHashFn ? await getAPQHashFn(req.query) : await sha256Hex(req.query);
    const extensions = {
      ...req.extensions,
      persistedQuery: { version: 1, sha256Hash: hash },
    };
    const apqReq: GraphQLRequest =
      apqMode === "omitQuery"
        ? { ...req, query: "", extensions } // omit query on first try
        : { ...req, extensions }; // include query on retry

    if (useGET) {
      fetchUrl = buildGETUrl(config.url, apqReq);
    } else {
      fetchBody = buildJSONBody(apqReq);
    }
  } else {
    if (useGET) {
      fetchUrl = buildGETUrl(config.url, req);
    } else {
      fetchBody = buildJSONBody(req);
    }
  }

  if (!useGET) fetchHeaders["content-type"] = "application/json";

  const controller = new AbortController();
  const timer =
    config.timeoutMs > 0 ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

  // Merge external signal
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await config.fetch(fetchUrl, {
      method: useGET ? "GET" : "POST",
      headers: fetchHeaders,
      body: fetchBody,
      signal: controller.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new GraphQLClientError("Request timed out", "ETIMEOUT", undefined, req, undefined, err);
    }
    throw new GraphQLClientError(
      err instanceof Error ? err.message : "Network error",
      "ENETWORK",
      undefined,
      req,
      undefined,
      err,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  return parseGraphQLResponse<T>(response, req);
}

// ============================================================================
// §10  GRAPHQL CLIENT
// ============================================================================

/**
 * GraphQL client supporting queries, mutations, subscriptions (via SSE),
 * file uploads, batched requests, Automatic Persisted Queries (APQ),
 * and a Relay-style middleware link chain.
 *
 * @typeParam T - Shape of response `data` (defaults to `unknown`)
 * @typeParam V - Shape of variables (defaults to `Record<string, unknown>`)
 */

/** APQ cache metrics. */
export interface APQMetrics {
  /** Number of cached query hashes. */
  size: number;
  /** APQ cache hits. */
  hits: number;
  /** APQ cache misses. */
  misses: number;
}

export class GraphQLClient {
  private readonly config: Required<GraphQLClientConfig>;
  private readonly executeLink: GraphQLLinkNext;

  // Static APQ cache — shared across all instances so standalone exports work
  private static apqCache = new Map<string, { hash: string; createdAt: number }>(); // query → {hash, createdAt}
  private static apqHashToQuery = new Map<string, { query: string; createdAt: number }>(); // hash → {query, createdAt}
  private static _apqHits = 0;
  private static _apqMisses = 0;
  private static _apqCleanupTimer: ReturnType<typeof setInterval> | null = null;

  private static _ensureAPQCleanup(): void {
    if (GraphQLClient._apqCleanupTimer) return;
    GraphQLClient._apqCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [q, entry] of GraphQLClient.apqCache) {
        if (now - entry.createdAt > APQ_CACHE_TTL_MS) {
          GraphQLClient.apqCache.delete(q);
          GraphQLClient.apqHashToQuery.delete(entry.hash);
        }
      }
      for (const [h, entry] of GraphQLClient.apqHashToQuery) {
        if (now - entry.createdAt > APQ_CACHE_TTL_MS) {
          GraphQLClient.apqHashToQuery.delete(h);
          // Also remove from reverse map if it still points to this hash
          for (const [q, e] of GraphQLClient.apqCache) {
            if (e.hash === h) {
              GraphQLClient.apqCache.delete(q);
              break;
            }
          }
        }
      }
    }, APQ_CLEANUP_INTERVAL_MS);
    if (
      typeof GraphQLClient._apqCleanupTimer === "object" &&
      GraphQLClient._apqCleanupTimer !== null &&
      "unref" in GraphQLClient._apqCleanupTimer
    ) {
      (GraphQLClient._apqCleanupTimer as { unref: () => void }).unref();
    }
  }

  /**
   * @param config - GraphQL client configuration
   */
  constructor(config: GraphQLClientConfig) {
    this.config = {
      fetch: globalThis.fetch,
      headers: {},
      useGETForQueries: false,
      enableAPQ: false,
      timeoutMs: 30_000,
      retries: 0,
      retryDelayMs: 300,
      links: [],
      signal: config.signal ?? new AbortController().signal,
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      ...config,
    };

    // Terminal link — does the actual HTTP fetch
    const terminal: GraphQLLinkNext = (op) =>
      this._executeWithAPQ(op.request, op.signal ?? null) as Promise<GraphQLResponse>;

    this.executeLink = buildLinkChain(this.config.links, terminal);
  }

  // ── APQ (Automatic Persisted Queries) ───────────────────────────────────

  /**
   * Get the APQ hash for a query, with collision detection.
   * Uses instance-level cache (B-1 fix).
   */
  private async _getAPQHash(query: string): Promise<string> {
    GraphQLClient._ensureAPQCleanup();
    const cached = GraphQLClient.apqCache.get(query);
    if (cached) {
      // Check TTL
      if (Date.now() - cached.createdAt <= APQ_CACHE_TTL_MS) {
        GraphQLClient._apqHits++;
        return cached.hash;
      }
      // Expired — remove
      GraphQLClient.apqCache.delete(query);
      GraphQLClient.apqHashToQuery.delete(cached.hash);
    }

    GraphQLClient._apqMisses++;
    const hash = await sha256Hex(query);
    const now = Date.now();

    // Check for hash collision
    const existingEntry = GraphQLClient.apqHashToQuery.get(hash);
    if (existingEntry && existingEntry.query !== query) {
      console.warn("[GraphQL] APQ hash collision detected");
      GraphQLClient.apqCache.delete(existingEntry.query);
      GraphQLClient.apqHashToQuery.delete(hash);
    }

    // Evict oldest entry if at capacity
    if (GraphQLClient.apqCache.size >= MAX_APQ_CACHE_ENTRIES) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, v] of GraphQLClient.apqCache) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const oldest = GraphQLClient.apqCache.get(oldestKey);
        if (oldest) {
          GraphQLClient.apqCache.delete(oldestKey);
          GraphQLClient.apqHashToQuery.delete(oldest.hash);
        }
      }
    }

    GraphQLClient.apqCache.set(query, { hash, createdAt: now });
    GraphQLClient.apqHashToQuery.set(hash, { query, createdAt: now });

    return hash;
  }

  /** Clear the process-wide APQ cache shared by all client instances. */
  clearAPQCache(): void {
    GraphQLClient.apqCache.clear();
    GraphQLClient.apqHashToQuery.clear();
    GraphQLClient._apqHits = 0;
    GraphQLClient._apqMisses = 0;
    if (GraphQLClient._apqCleanupTimer) {
      clearInterval(GraphQLClient._apqCleanupTimer);
      GraphQLClient._apqCleanupTimer = null;
    }
  }

  /**
   * Get APQ cache metrics for this client.
   *
   * @returns An object with `size` (number of cached query hashes),
   *          `hits` (cache hit count), and `misses` (cache miss count).
   */
  getAPQMetrics(): APQMetrics {
    return {
      /** Number of cached query hashes. */
      size: GraphQLClient.apqCache.size,
      /** APQ cache hits. */
      hits: GraphQLClient._apqHits,
      /** APQ cache misses. */
      misses: GraphQLClient._apqMisses,
    };
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Execute a GraphQL query and return the data payload.
   * Automatically detects the operation name if one is not explicitly provided.
   *
   * @typeParam T - Shape of the expected `data` object in the response
   * @typeParam V - Shape of the variables object
   * @param query     - GraphQL query string
   * @param variables - Optional query variables
   * @param options   - Additional options (operationName, headers, signal, extensions)
   * @returns The `data` field from the GraphQL response
   * @throws {@link GraphQLClientError} On network errors, GraphQL errors,
   *   or missing data
   */
  async query<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: V,
    options: {
      operationName?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      extensions?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const req: GraphQLRequest<V> = {
      query,
      ...(variables !== undefined ? { variables } : {}),
      ...(options.operationName !== undefined
        ? { operationName: options.operationName }
        : extractOperationName(query) !== undefined
          ? { operationName: extractOperationName(query)! }
          : {}),
      ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    } as GraphQLRequest<V>;

    return await this._execute<T, V>(req, options.signal ?? null);
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  /**
   * Execute a GraphQL mutation.
   * Delegates to {@link GraphQLClient.query} — mutations use POST semantics automatically
   * via the client's transport layer.
   *
   * @typeParam T - Shape of the expected `data` object in the response
   * @typeParam V - Shape of the variables object
   * @param query     - GraphQL mutation string
   * @param variables - Optional mutation variables
   * @param options   - Additional options
   * @returns The `data` field from the GraphQL response
   */
  async mutate<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: V,
    options: {
      operationName?: string;
      signal?: AbortSignal;
      extensions?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    return await this.query<T, V>(query, variables, options);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /**
   * Execute a GraphQL mutation with file uploads using the GraphQL multipart
   * request spec.
   *
   * The request body is sent as `multipart/form-data` with:
   * - `operations` — the JSON-encoded GraphQL request (file variables replaced
   *   with `null`)
   * - `map` — mapping of file indices to variable paths
   * - `0`, `1`, … — the actual file blobs
   *
   * @typeParam T - Shape of the expected `data` object in the response
   * @param query     - GraphQL mutation string
   * @param variables - Mutation variables (file variables excluded —
   *                   pass them via `uploads`)
   * @param uploads   - Array of file uploads with variable paths
   * @param options   - Additional options
   * @returns The `data` field from the GraphQL response
   *
   * @example
   * ```ts
   * const data = await client.upload(
   *   `mutation ($file: Upload!) { uploadFile(file: $file) { id } }`,
   *   {},
   *   [{ file: myBlob, path: "file" }],
   * );
   * ```
   */
  async upload<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
    uploads: GraphQLUpload[],
    options: { operationName?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const req: GraphQLRequest = {
      query,
      variables,
      ...(options.operationName !== undefined
        ? { operationName: options.operationName }
        : extractOperationName(query) !== undefined
          ? { operationName: extractOperationName(query)! }
          : {}),
    } as GraphQLRequest;

    const headers = await buildHeaders(this.config, {
      /* drop content-type for multipart */
    });
    delete headers["content-type"]; // FormData sets it with boundary

    const form = buildMultipartBody(req, uploads);
    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    this.config.onRequest(req);

    let response: Response;
    try {
      response = await this.config.fetch(this.config.url, {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      const clientErr = new GraphQLClientError(
        err instanceof Error ? err.message : "Upload network error",
        "ENETWORK",
        undefined,
        req,
        undefined,
        err,
      );
      this.config.onError(clientErr, req);
      throw clientErr;
    }

    const gqlRes = await parseGraphQLResponse<T>(response, req);
    this.config.onResponse(gqlRes, req);

    if (gqlRes.errors?.length) {
      const err = buildGraphQLError(gqlRes.errors, req, gqlRes);
      this.config.onError(err, req);
      throw err;
    }

    if (gqlRes.data === undefined) {
      throw new GraphQLClientError("No data in upload response", "ENODATA", undefined, req, gqlRes);
    }

    return gqlRes.data;
  }

  // ── Batch ─────────────────────────────────────────────────────────────────

  /**
   * Execute multiple GraphQL requests in a single batch HTTP call.
   * All requests are sent as a JSON array to the endpoint, and the response
   * must be a JSON array of {@link GraphQLResponse} objects.
   *
   * @typeParam T - Expected element type in the returned array (defaults to
   *   `unknown[]` for maximum flexibility)
   * @param requests - Array of GraphQL requests
   * @param options  - Additional options (signal)
   * @returns Array of `data` fields, one per request in order
   * @throws {@link GraphQLClientError} If the batch response is not an array,
   *   contains GraphQL errors, or is missing data for any request
   */
  async batch<T = unknown[]>(
    requests: GraphQLRequest[],
    options: { signal?: AbortSignal } = {},
  ): Promise<T[]> {
    const headers = await buildHeaders(this.config);
    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await this.config.fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(requests),
        signal: controller.signal,
      });
    } catch (err) {
      throw new GraphQLClientError(
        err instanceof Error ? err.message : "Batch network error",
        "ENETWORK",
        undefined,
        requests[0],
        undefined,
        err,
      );
    }

    const rawResults = await response.json();

    // Validate response is array (B-5 fix)
    if (!Array.isArray(rawResults)) {
      throw new GraphQLClientError(
        "Batch response must be an array of GraphQL responses",
        "EINVALIDRESPONSE",
        undefined,
        requests[0],
        rawResults,
      );
    }

    const results = rawResults as GraphQLResponse<T>[];

    return results.map((res, i) => {
      if (res.errors?.length) throw buildGraphQLError(res.errors, requests[i]!, res);
      if (res.data === undefined) {
        throw new GraphQLClientError(
          "No data in batch response",
          "ENODATA",
          undefined,
          requests[i]!,
          res,
        );
      }
      return res.data;
    });
  }

  // ── Subscription (SSE transport) ──────────────────────────────────────────

  /**
   * Subscribe to GraphQL subscriptions using Server-Sent Events (SSE).
   *
   * @typeParam T - Shape of yielded `data` values
   * @typeParam V - Shape of subscription variables
   * @param query     - GraphQL subscription string
   * @param variables - Optional subscription variables
   * @param options   - Options: custom `url`, `signal`, `operationName`
   * @yields `data` payloads from each incoming subscription event
   *
   * @example
   * ```ts
   * // Basic subscription
   * for await (const data of client.subscribe(`subscription { onMessage { text } }`)) {
   *   console.log(data);
   * }
   *
   * // With variables and custom endpoint
   * for await (const data of client.subscribe(
   *   `subscription OnMessage($chatId: ID!) { onMessage(chatId: $chatId) { text } }`,
   *   { chatId: "123" },
   *   { url: "wss://api.example.com/graphql" }
   * )) {
   *   console.log(data);
   * }
   * ```
   *
   * ## Transport Selection
   *
   * **Use SSE (this method) when:**
   * - Server supports GraphQL over SSE (popular with Apollo, Hasura)
   * - Need simple server-sent events without WebSocket complexity
   * - Running in environment with limited WebSocket support
   *
   * **Use WebSocket (ws.ts) when:**
   * - Server requires bidirectional communication
   * - Need more efficient persistent connections
   * - Server supports graphql-ws protocol
   *
   * ## Reconnection
   *
   * Currently `reconnect: false` - subscriptions do NOT auto-reconnect on disconnect.
   * This is intentional: re-establishing a subscription requires re-subscribing
   * with the same operation, which may have side effects on the server.
   * Caller should handle reconnection logic if needed.
   */
  async *subscribe<T = unknown, V extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: V,
    options: {
      operationName?: string;
      signal?: AbortSignal;
      url?: string; // Override subscription endpoint
    } = {},
  ): AsyncGenerator<T> {
    const req: GraphQLRequest<V> = {
      query,
      ...(variables !== undefined ? { variables } : {}),
      ...(options.operationName !== undefined
        ? { operationName: options.operationName }
        : extractOperationName(query) !== undefined
          ? { operationName: extractOperationName(query)! }
          : {}),
    } as GraphQLRequest<V>;

    const url = options.url ?? this.config.url;
    const headers = await buildHeaders(this.config, { accept: "text/event-stream" });
    const body = buildJSONBody(req);

    const { SSEClient } = await import("./sse.ts");

    const client = new SSEClient({
      url,
      method: "POST",
      headers,
      body,
      signal: options.signal ?? this.config.signal,
      reconnect: false, // subscriptions don't auto-reconnect
      fetch: this.config.fetch,
    });

    for await (const event of client) {
      if (event.event === "complete") return;
      if (!event.data) continue;

      let gqlRes: GraphQLResponse<T>;
      try {
        gqlRes = JSON.parse(event.data) as GraphQLResponse<T>;
      } catch {
        continue;
      }

      if (gqlRes.errors?.length) {
        throw buildGraphQLError(gqlRes.errors, req, gqlRes);
      }

      if (gqlRes.data !== undefined) {
        yield gqlRes.data;
      }
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /**
   * Introspect the GraphQL schema using the standard `__schema` query.
   * Returns the raw schema object without type-safety.
   *
   * @returns The full `__schema` introspection result
   */
  async introspect(): Promise<unknown> {
    return await this.query<unknown>(INTROSPECTION_QUERY);
  }

  // ── Raw execute ───────────────────────────────────────────────────────────

  /**
   * Execute a raw {@link GraphQLRequest} and return the full
   * {@link GraphQLResponse} including `data`, `errors`, and `extensions`.
   * Unlike {@link query}, this does NOT throw on GraphQL errors — the caller
   * inspects the response directly.
   *
   * @typeParam T - Expected type of the `data` field
   * @param req    - Fully-formed GraphQL request
   * @param signal - Optional abort signal
   * @returns The full GraphQL response envelope
   */
  async raw<T = unknown>(req: GraphQLRequest, signal?: AbortSignal): Promise<GraphQLResponse<T>> {
    return await this._executeRaw<T>(req, signal ?? null);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _execute<T, V extends Record<string, unknown>>(
    req: GraphQLRequest<V>,
    signal: AbortSignal | null,
  ): Promise<T> {
    this.config.onRequest(req);

    const gqlRes = await this._executeWithRetry<T>(req, signal);
    this.config.onResponse(gqlRes, req);

    if (gqlRes.errors?.length) {
      const err = buildGraphQLError(gqlRes.errors, req, gqlRes);
      this.config.onError(err, req);
      throw err;
    }

    if (gqlRes.data === undefined) {
      throw new GraphQLClientError("Response contained no data", "ENODATA", undefined, req, gqlRes);
    }

    return gqlRes.data;
  }

  private async _executeRaw<T>(
    req: GraphQLRequest,
    signal: AbortSignal | null,
  ): Promise<GraphQLResponse<T>> {
    return await (this.executeLink({
      request: req,
      config: this.config,
      ...(signal != null ? { signal } : {}),
    }) as Promise<GraphQLResponse<T>>);
  }

  private async _executeWithRetry<T>(
    req: GraphQLRequest,
    signal: AbortSignal | null,
  ): Promise<GraphQLResponse<T>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      if (attempt > 0) await sleep(this.config.retryDelayMs * Math.pow(2, attempt - 1));
      try {
        return await this._executeRaw<T>(req, signal);
      } catch (err) {
        lastErr = err;
        if (err instanceof GraphQLClientError && err.isGraphQLError) throw err; // don't retry GQL errors
        if (signal?.aborted) throw err;
      }
    }
    throw lastErr;
  }

  private async _executeWithAPQ<T>(
    req: GraphQLRequest,
    signal: AbortSignal | null,
  ): Promise<GraphQLResponse<T>> {
    if (!this.config.enableAPQ) {
      return executeHTTP<T>(req, this.config, signal, "none", undefined);
    }

    // APQ: first try without query string
    const res1 = await executeHTTP<T>(req, this.config, signal, "omitQuery", (q) =>
      this._getAPQHash(q),
    );

    // Check if server responded with PersistedQueryNotFound
    const notFound = res1.errors?.some(
      (e) => e.extensions?.["code"] === "PERSISTED_QUERY_NOT_FOUND",
    );

    if (!notFound) return res1;

    // Retry with full query
    return executeHTTP<T>(req, this.config, signal, "full", (q) => this._getAPQHash(q));
  }
}

// ============================================================================
// §11  LINKS (built-in middleware)
// ============================================================================

/**
 * Auth link: injects an authorization header into every request.
 *
 * @param getToken - Function that returns the token (sync or async).
 *   Return `null` to skip header injection.
 * @param scheme  - Authorization scheme (default: `"Bearer"`)
 * @returns A {@link GraphQLLink} that adds the `authorization` header
 */
export function authLink(
  getToken: () => string | null | Promise<string | null>,
  scheme = "Bearer",
): GraphQLLink {
  return async (op, next) => {
    const token = await getToken();
    if (token) {
      // Inject into request headers (B-8 fix)
      const existingReqHeaders = op.request.headers ?? {};
      op.request = {
        ...op.request,
        headers: { ...existingReqHeaders, authorization: `${scheme} ${token}` },
      };
      // Also inject into config headers (merged in buildHeaders)
      const existing =
        typeof op.config.headers === "object" && !Array.isArray(op.config.headers)
          ? (op.config.headers as Record<string, string>)
          : {};
      op = {
        ...op,
        config: {
          ...op.config,
          headers: { ...existing, authorization: `${scheme} ${token}` },
        },
      };
    }
    return next(op);
  };
}

/**
 * Error link: intercept and transform errors thrown by downstream links.
 * The handler can return a fallback response to recover from the error,
 * or `null` to re-throw.
 *
 * @param handler - Error handler. Receives the error, the operation, and a
 *   `retry` function that re-executes the downstream chain.
 * @returns A {@link GraphQLLink} that intercepts {@link GraphQLClientError}s
 */
export function errorLink(
  handler: (
    err: GraphQLClientError,
    op: GraphQLOperation,
    retry: () => Promise<GraphQLResponse>,
  ) => Promise<GraphQLResponse> | null,
): GraphQLLink {
  return async (op, next) => {
    try {
      return await next(op);
    } catch (err) {
      if (!(err instanceof GraphQLClientError)) throw err;
      const result = handler(err, op, () => next(op));
      if (result) return result;
      throw err;
    }
  };
}

/**
 * Logging link: log every operation to a user-provided logger or `console.log`.
 *
 * @param logger - Logger function that receives a message string and a data
 *   object. Defaults to `console.log`.
 * @returns A {@link GraphQLLink} that logs request/response lifecycle
 */
export function loggingLink(
  logger: (msg: string, data: unknown) => void = (msg, data) => console.log(msg, data),
): GraphQLLink {
  return async (op, next) => {
    const start = Date.now();
    logger("→ GraphQL", { operation: op.request.operationName ?? "anonymous", url: op.config.url });
    try {
      const res = await next(op);
      logger("← GraphQL", {
        operation: op.request.operationName,
        durationMs: Date.now() - start,
        errors: res.errors,
      });
      return res;
    } catch (err) {
      logger("✗ GraphQL", {
        operation: op.request.operationName,
        durationMs: Date.now() - start,
        error: String(err),
      });
      throw err;
    }
  };
}

/**
 * Retry link: retry failed operations with exponential backoff.
 * By default retries 3 times with 300ms initial delay and 2x backoff,
 * skipping retry for GraphQL-layer errors (server rejected the query).
 *
 * @param options.maxRetries  - Maximum retry attempts (default: 3)
 * @param options.delayMs     - Initial delay between retries in ms (default: 300)
 * @param options.shouldRetry - Predicate to decide if a retry should be attempted.
 *   Receives the error and current attempt number.
 *   Default: skip retry for {@link GraphQLClientError} with `isGraphQLError === true`
 * @returns A {@link GraphQLLink} that retries failed operations
 */
export function retryLink(
  options: {
    maxRetries?: number;
    delayMs?: number;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
  } = {},
): GraphQLLink {
  const max = options.maxRetries ?? 3;
  const delay = options.delayMs ?? 300;
  const should =
    options.shouldRetry ?? ((err) => !(err instanceof GraphQLClientError && err.isGraphQLError));

  return async (op, next) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= max; attempt++) {
      if (attempt > 0) await sleep(delay * Math.pow(2, attempt - 1));
      try {
        return await next(op);
      } catch (err) {
        lastErr = err;
        if (!should(err, attempt)) throw err;
      }
    }
    throw lastErr;
  };
}

// ============================================================================
// §12  INTROSPECTION QUERY
// ============================================================================

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType    { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        description
        locations
        args { ...InputValue }
      }
    }
  }

  fragment FullType on __Type {
    kind name description
    fields(includeDeprecated: true) {
      name description
      args { ...InputValue }
      type { ...TypeRef }
      isDeprecated
      deprecationReason
    }
    inputFields { ...InputValue }
    interfaces  { ...TypeRef }
    enumValues(includeDeprecated: true) {
      name description isDeprecated deprecationReason
    }
    possibleTypes { ...TypeRef }
  }

  fragment InputValue on __InputValue {
    name description
    type { ...TypeRef }
    defaultValue
  }

  fragment TypeRef on __Type {
    kind name
    ofType {
      kind name
      ofType {
        kind name
        ofType {
          kind name
          ofType {
            kind name
            ofType { kind name ofType { kind name ofType { kind name } } }
          }
        }
      }
    }
  }
`;

// ============================================================================
// §13  FACTORY HELPERS
// ============================================================================

/**
 * Create a new {@link GraphQLClient} — convenience factory that avoids `new`.
 *
 * @param config - GraphQL client configuration
 * @returns A new GraphQLClient instance
 */
export function createGraphQLClient(config: GraphQLClientConfig): GraphQLClient {
  return new GraphQLClient(config);
}

/**
 * Minimal one-shot query helper — no client instantiation needed.
 * Creates a temporary {@link GraphQLClient} and executes the query.
 *
 * @typeParam T - Shape of the expected `data` object
 * @param url       - GraphQL endpoint URL
 * @param query     - GraphQL query string
 * @param variables - Optional query variables
 * @param headers   - Optional request headers
 * @returns The `data` field from the GraphQL response
 */
export async function gql<T = unknown>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  const client = new GraphQLClient({ url, ...(headers !== undefined ? { headers } : {}) });
  return await client.query<T>(query, variables);
}

/** Clear the process-wide APQ cache. @see {@link GraphQLClient#clearAPQCache} */
export const clearAPQCache: () => void = GraphQLClient.prototype.clearAPQCache.bind(
  GraphQLClient.prototype,
);
/**
 * Get APQ cache metrics (size, hits, misses).
 *
 * @returns An object with `size` (number of cached query hashes),
 *          `hits` (cache hit count), and `misses` (cache miss count).
 * @see {@link GraphQLClient#getAPQMetrics}
 */
export const getAPQMetrics: () => APQMetrics = GraphQLClient.prototype.getAPQMetrics.bind(
  GraphQLClient.prototype,
);
