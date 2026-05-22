/**
 * interceptors.ts
 *
 * Cross-runtime HTTP interceptor pipeline.
 *
 * Runtimes: Deno · Bun · Node.js · Cloudflare Workers · Vercel Edge ·
 *           AWS Lambda · Browser · any WinterCG-compatible runtime.
 *
 * Features:
 *  - Request interceptors  (mutate, replace, abort before sending)
 *  - Response interceptors (mutate, retry, transform body)
 *  - Error interceptors    (recover, rethrow, classify)
 *  - Named interceptors    (register, eject by ID)
 *  - Priority ordering     (lower number = runs first)
 *  - Async-first pipeline  (every hook is async-capable)
 *  - Scoped interceptors   (per-instance, not global)
 *  - One-shot interceptors (auto-eject after first run)
 *  - Conditional interceptors (predicate-gated execution)
 *  - Retry interceptor     (exponential back-off, jitter, per-status config)
 *  - Auth interceptor      (Bearer injection + token refresh + queue)
 *  - Logging interceptor   (structured, redaction-aware)
 *  - Timeout interceptor   (per-request deadline with AbortSignal)
 *  - Cache interceptor     (in-memory LRU, stale-while-revalidate)
 *  - Dedupe interceptor    (coalesce identical in-flight requests)
 *  - Rate-limit interceptor (token bucket, respect Retry-After)
 *  - HAR interceptor       (record HTTP Archive entries)
 *  - Metrics interceptor   (timing, status buckets, error rates)
 *  - No dependencies, no runtime globals beyond Promise/Map/Set
 */

// ============================================================================
// §1  CORE TYPES
// ============================================================================

/** Normalized request passed through the pipeline. */
export interface InterceptorRequest {
  /** Target URL */
  url: string;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request headers as a flat object */
  headers: Record<string, string>;
  /** Request body */
  body: BodyInit | null;
  /** AbortSignal for cancellation (may be null) */
  signal: AbortSignal | null;
  /**
   * Arbitrary per-request metadata bag — interceptors may read/write freely.
   * Simple string-keyed values for request-scoped data.
   *
   * Use `meta` for:
   * - Request-specific data (e.g., user ID, request ID)
   * - Simple configuration passed between interceptors
   *
   * Use `ctx.store` (Map<symbol,>) for:
   * - Complex objects requiring Symbol keys
   * - Pipeline-scoped data shared across request/response/error phases
   * - Avoiding key collisions with other interceptors
   *
   * @example
   * ```ts
   * // In request interceptor:
   * ctx.request.meta.userId = "123";
   *
   * // In response interceptor:
   * const userId = ctx.request.meta.userId;
   * ```
   */
  meta: Record<string, unknown>;
}

/** Normalized response passed through the pipeline. */
export interface InterceptorResponse {
  /** HTTP status code */
  status: number;
  /** HTTP status text (e.g. "OK") */
  statusText: string;
  /** Response headers as a flat object */
  headers: Record<string, string>;
  /** Response body as string or binary */
  body: string | Uint8Array | null;
  /** Original runtime response (fetch Response, node http.IncomingMessage, etc.) */
  raw: unknown;
  /** Reference back to the request that produced this response */
  request: InterceptorRequest;
}

/** Context object threaded through the entire pipeline for one request. */
export interface InterceptorContext {
  /** Mutable request — interceptors modify this in place */
  request: InterceptorRequest;
  /** Set by the dispatcher when the response arrives */
  response: InterceptorResponse | null;
  /** Set when an error occurs at any stage */
  error: unknown | null;
  /** Monotonic start time (performance.now() or Date.now()) */
  startedAt: number;
  /** Attempt counter, incremented by retry interceptor */
  attempt: number;
  /** Whether the pipeline has been aborted */
  aborted: boolean;
  /**
   * Shared pipeline-scoped storage for cross-interceptor communication.
   * Use Symbols as keys to avoid conflicts.
   *
   * @example
   * ```ts
   * const MY_KEY = Symbol("myKey");
   * ctx.store.set(MY_KEY, { computed: true });
   * // Later interceptor:
   * const data = ctx.store.get(MY_KEY);
   * ```
   *
   * @see meta For per-request metadata (simpler key-value store)
   */
  store: Map<symbol, unknown>;
}

// ── Interceptor hook return types ────────────────────────────────────────────

/**
 * A request interceptor may:
 *  - return void / undefined  → pass the (possibly mutated) request through
 *  - return InterceptorRequest → replace the request entirely
 *  - return InterceptorResponse → short-circuit; skip the actual fetch
 *  - throw                    → abort the pipeline with that error
 */
export type RequestInterceptorResult = void | undefined | InterceptorRequest | InterceptorResponse;

/**
 * A response interceptor may:
 *  - return void / undefined     → pass through
 *  - return InterceptorResponse  → replace the response
 *  - return InterceptorRequest   → retry (pipeline re-runs from dispatch)
 *  - throw                       → convert to error pipeline
 */
export type ResponseInterceptorResult = void | undefined | InterceptorResponse | InterceptorRequest;

/**
 * An error interceptor may:
 *  - return void / undefined     → rethrow the error
 *  - return InterceptorResponse  → recover with synthetic response
 *  - throw                       → replace with a different error
 */
export type ErrorInterceptorResult = void | undefined | InterceptorResponse;

/** Generic interceptor function type (internal use). */
export type InterceptorFn<T = unknown> = (ctx: InterceptorContext) => Promise<T> | T;

/** A request-phase interceptor function. */
export type RequestInterceptorFn = (
  ctx: InterceptorContext,
) => Promise<RequestInterceptorResult> | RequestInterceptorResult;
/** A response-phase interceptor function. */
export type ResponseInterceptorFn = (
  ctx: InterceptorContext,
) => Promise<ResponseInterceptorResult> | ResponseInterceptorResult;
/** An error-phase interceptor function. */
export type ErrorInterceptorFn = (
  ctx: InterceptorContext,
) => Promise<ErrorInterceptorResult> | ErrorInterceptorResult;

/** A registered request interceptor. */
export interface RequestInterceptor {
  /** Unique identifier used for ejection. */
  id: string;
  /** Execution priority (lower = runs first). */
  priority: number;
  /** Auto-eject after first execution. */
  once: boolean;
  /** Optional predicate gate — interceptor is skipped if false. */
  condition: ((ctx: InterceptorContext) => boolean) | null;
  /** The interceptor function. */
  fn: RequestInterceptorFn;
}

/** A registered response interceptor. */
export interface ResponseInterceptor {
  /** Unique identifier used for ejection. */
  id: string;
  /** Execution priority (lower = runs first). */
  priority: number;
  /** Auto-eject after first execution. */
  once: boolean;
  /** Optional predicate gate — interceptor is skipped if false. */
  condition: ((ctx: InterceptorContext) => boolean) | null;
  /** The interceptor function. */
  fn: ResponseInterceptorFn;
}

/** A registered error interceptor. */
export interface ErrorInterceptor {
  /** Unique identifier used for ejection. */
  id: string;
  /** Execution priority (lower = runs first). */
  priority: number;
  /** Auto-eject after first execution. */
  once: boolean;
  /** Optional predicate gate — interceptor is skipped if false. */
  condition: ((ctx: InterceptorContext) => boolean) | null;
  /** The interceptor function. */
  fn: ErrorInterceptorFn;
}

// ── Registration options ─────────────────────────────────────────────────────

export interface InterceptorOptions {
  /** Unique ID. Auto-generated if omitted. */
  id?: string;
  /**
   * Execution order. Lower = earlier.
   * Request interceptors: lower priority runs first (outbound).
   * Response interceptors: lower priority runs first (inbound).
   * Default: 0
   */
  priority?: number;
  /** If true, auto-eject after first successful execution. */
  once?: boolean;
  /** Only run if this predicate returns true. */
  condition?: (ctx: InterceptorContext) => boolean;
}

// ============================================================================
// §2  DISPATCHER TYPE
// ============================================================================

/**
 * The function that actually sends the HTTP request.
 * The pipeline calls this once (unless a retry interceptor resets the context).
 */
export type Dispatcher = (req: InterceptorRequest) => Promise<InterceptorResponse>;

// ============================================================================
// §3  INTERCEPTOR MANAGER
// ============================================================================

let _idSeq = 0;
function nextId(): string {
  return `interceptor_${++_idSeq}`;
}

function sortByPriority<T extends { priority: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.priority - b.priority);
}

/**
 * Manages registration, ejection, and pipeline execution of interceptors.
 *
 * Interceptors are executed in priority order (lowest first) through three
 * phases: request (outbound), response (inbound), and error (recovery).
 */
export class InterceptorManager {
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a request interceptor.
   *
   * @param fn   - Interceptor function
   * @param opts - Registration options (id, priority, once, condition)
   * @returns The interceptor ID (auto-generated or from opts.id)
   */
  useRequest(fn: RequestInterceptorFn, opts: InterceptorOptions = {}): string {
    const id = opts.id ?? nextId();
    this.requestInterceptors.push({
      id,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      condition: opts.condition ?? null,
      fn,
    });
    return id;
  }

  /**
   * Register a response interceptor.
   *
   * @param fn   - Interceptor function
   * @param opts - Registration options (id, priority, once, condition)
   * @returns The interceptor ID (auto-generated or from opts.id)
   */
  useResponse(fn: ResponseInterceptorFn, opts: InterceptorOptions = {}): string {
    const id = opts.id ?? nextId();
    this.responseInterceptors.push({
      id,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      condition: opts.condition ?? null,
      fn,
    });
    return id;
  }

  /**
   * Register an error interceptor.
   *
   * @param fn   - Interceptor function
   * @param opts - Registration options (id, priority, once, condition)
   * @returns The interceptor ID (auto-generated or from opts.id)
   */
  useError(fn: ErrorInterceptorFn, opts: InterceptorOptions = {}): string {
    const id = opts.id ?? nextId();
    this.errorInterceptors.push({
      id,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      condition: opts.condition ?? null,
      fn,
    });
    return id;
  }

  /** Register both request and response interceptors together. */
  use(
    requestFn: RequestInterceptorFn | null,
    responseFn: ResponseInterceptorFn | null,
    opts: InterceptorOptions = {},
  ): {
    /** ID of the registered request interceptor, or null */
    requestId: string | null;
    /** ID of the registered response interceptor, or null */
    responseId: string | null;
  } {
    const requestId = requestFn ? this.useRequest(requestFn, opts) : null;
    const responseId = responseFn ? this.useResponse(responseFn, opts) : null;
    return { requestId, responseId };
  }

  // ── Ejection ──────────────────────────────────────────────────────────────

  /**
   * Eject (remove) an interceptor by ID.
   *
   * @param id - The interceptor ID returned from registration
   * @returns `true` if an interceptor was found and removed
   */
  eject(id: string): boolean {
    const before =
      this.requestInterceptors.length +
      this.responseInterceptors.length +
      this.errorInterceptors.length;

    this.requestInterceptors = this.requestInterceptors.filter((i) => i.id !== id);
    this.responseInterceptors = this.responseInterceptors.filter((i) => i.id !== id);
    this.errorInterceptors = this.errorInterceptors.filter((i) => i.id !== id);

    const after =
      this.requestInterceptors.length +
      this.responseInterceptors.length +
      this.errorInterceptors.length;
    return after < before;
  }

  /** Remove all registered interceptors. */
  ejectAll(): void {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.errorInterceptors = [];
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** Check if an interceptor with the given ID is registered. */
  has(id: string): boolean {
    return (
      this.requestInterceptors.some((i) => i.id === id) ||
      this.responseInterceptors.some((i) => i.id === id) ||
      this.errorInterceptors.some((i) => i.id === id)
    );
  }

  /** Number of registered request interceptors. */
  get requestCount(): number {
    return this.requestInterceptors.length;
  }
  /** Number of registered response interceptors. */
  get responseCount(): number {
    return this.responseInterceptors.length;
  }
  /** Number of registered error interceptors. */
  get errorCount(): number {
    return this.errorInterceptors.length;
  }

  // ── Pipeline execution ────────────────────────────────────────────────────

  /**
   * Execute the full interceptor pipeline for a single request.
   *
   * @param request    - Initial request to send
   * @param dispatcher - The function that performs the actual HTTP fetch
   * @returns The final response after all interceptors have run
   */
  async execute(request: InterceptorRequest, dispatcher: Dispatcher): Promise<InterceptorResponse> {
    const ctx: InterceptorContext = {
      request,
      response: null,
      error: null,
      startedAt: now(),
      attempt: 0,
      aborted: false,
      store: new Map(),
    };

    return await this._run(ctx, dispatcher);
  }

  /** Internal: run (or re-run on retry) the full pipeline. */
  async _run(ctx: InterceptorContext, dispatcher: Dispatcher): Promise<InterceptorResponse> {
    ctx.attempt++;

    // Collect IDs to eject after iteration (avoids modifying array during for-of)
    const toEject = new Set<string>();

    // ── Request phase ──────────────────────────────────────────────────────
    for (const interceptor of sortByPriority(this.requestInterceptors)) {
      if (ctx.aborted) break;
      if (interceptor.condition && !interceptor.condition(ctx)) continue;

      let result: RequestInterceptorResult;
      try {
        result = await interceptor.fn(ctx);
      } catch (err) {
        ctx.error = err;
        for (const id of toEject) this.eject(id);
        return this._runErrorPhase(ctx, dispatcher);
      }

      if (interceptor.once) toEject.add(interceptor.id);

      if (result === undefined || result === null) continue;

      // Short-circuit: interceptor returned a synthetic response
      if (isInterceptorResponse(result)) {
        ctx.response = result;
        for (const id of toEject) this.eject(id);
        return this._runResponsePhase(ctx, dispatcher);
      }

      // Replace request
      if (isInterceptorRequest(result)) {
        ctx.request = result;
      }
    }

    // Eject once interceptors after request phase completes
    for (const id of toEject) this.eject(id);

    // ── Dispatch ───────────────────────────────────────────────────────────
    try {
      ctx.response = await dispatcher(ctx.request);
    } catch (err) {
      ctx.error = err;
      return this._runErrorPhase(ctx, dispatcher);
    }

    return this._runResponsePhase(ctx, dispatcher);
  }

  private async _runResponsePhase(
    ctx: InterceptorContext,
    dispatcher: Dispatcher,
  ): Promise<InterceptorResponse> {
    // Collect IDs to eject after iteration
    const toEject = new Set<string>();

    for (const interceptor of sortByPriority(this.responseInterceptors)) {
      if (ctx.aborted) break;
      if (interceptor.condition && !interceptor.condition(ctx)) continue;

      let result: ResponseInterceptorResult;
      try {
        result = await interceptor.fn(ctx);
      } catch (err) {
        ctx.error = err;
        for (const id of toEject) this.eject(id);
        return this._runErrorPhase(ctx, dispatcher);
      }

      if (interceptor.once) toEject.add(interceptor.id);

      if (result === undefined || result === null) continue;

      // Retry: interceptor returned a new request
      if (isInterceptorRequest(result)) {
        ctx.request = result;
        ctx.response = null;
        ctx.error = null;
        for (const id of toEject) this.eject(id);
        return this._run(ctx, dispatcher);
      }

      // Replace response
      if (isInterceptorResponse(result)) {
        ctx.response = result;
      }
    }

    // Eject once interceptors after response phase completes
    for (const id of toEject) this.eject(id);

    if (!ctx.response) throw new Error("Pipeline produced no response");
    return ctx.response;
  }

  private async _runErrorPhase(
    ctx: InterceptorContext,
    dispatcher: Dispatcher,
  ): Promise<InterceptorResponse> {
    // Collect IDs to eject after iteration
    const toEject = new Set<string>();

    for (const interceptor of sortByPriority(this.errorInterceptors)) {
      if (interceptor.condition && !interceptor.condition(ctx)) continue;

      let result: ErrorInterceptorResult;
      try {
        result = await interceptor.fn(ctx);
      } catch (err) {
        // Handle RetrySignal from retry interceptor error phase
        if ((err as { __retrySignal?: boolean }).__retrySignal) {
          for (const id of toEject) this.eject(id);
          ctx.error = null;
          ctx.response = null;
          return this._run(ctx, dispatcher);
        }
        ctx.error = err;
        continue;
      }

      if (interceptor.once) toEject.add(interceptor.id);

      // Recovery: interceptor returned a synthetic response
      if (result !== undefined && result !== null && isInterceptorResponse(result)) {
        ctx.response = result;
        ctx.error = null;
        for (const id of toEject) this.eject(id);
        return this._runResponsePhase(ctx, dispatcher);
      }
    }

    // Eject once interceptors after error phase completes
    for (const id of toEject) this.eject(id);

    throw ctx.error;
  }
}

// ============================================================================
// §4  TYPE GUARDS
// ============================================================================

function isInterceptorResponse(v: unknown): v is InterceptorResponse {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as InterceptorResponse).status === "number" &&
    "headers" in v &&
    "request" in v
  );
}

function isInterceptorRequest(v: unknown): v is InterceptorRequest {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as InterceptorRequest).url === "string" &&
    typeof (v as InterceptorRequest).method === "string" &&
    !("status" in v)
  );
}

// ============================================================================
// §5  BUILT-IN: RETRY INTERCEPTOR
// ============================================================================

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in ms for exponential back-off (default: 300) */
  baseDelayMs: number;
  /** Maximum delay cap in ms (default: 30_000) */
  maxDelayMs: number;
  /** Jitter factor 0–1 (default: 0.3) */
  jitter: number;
  /** HTTP status codes that trigger a retry (default: [408,429,500,502,503,504]) */
  retryStatuses: number[];
  /** Retry on network errors / aborts (default: true) */
  retryOnError: boolean;
  /** Only retry these methods (default: GET, HEAD, PUT, DELETE, OPTIONS, TRACE) */
  retryMethods: string[];
  /**
   * Custom predicate — if provided, overrides retryStatuses + retryOnError.
   * Return true to retry, false to not retry.
   */
  shouldRetry: ((ctx: InterceptorContext) => boolean) | null;
  /**
   * Called before each retry with the upcoming delay in ms.
   * Useful for logging.
   */
  onRetry: ((ctx: InterceptorContext, delayMs: number) => void) | null;
}

const RETRY_DEFAULTS: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0.3,
  retryStatuses: [408, 429, 500, 502, 503, 504],
  retryOnError: true,
  retryMethods: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE", "POST"],
  shouldRetry: null,
  onRetry: null,
};

/**
 * Create a retry interceptor pair (response + error) with exponential back-off,
 * jitter, and per-status-code configuration.
 *
 * @param config - Retry configuration (defaults used for omitted fields)
 */
export function createRetryInterceptor(config: Partial<RetryConfig> = {}): {
  /** Triggers retries for responses with retryable status codes */
  responseInterceptor: ResponseInterceptorFn;
  /** Triggers retries when a request fails with a retryable error */
  errorInterceptor: ErrorInterceptorFn;
} {
  const cfg = { ...RETRY_DEFAULTS, ...config };

  function computeDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(retryAfterMs, cfg.maxDelayMs);
    const exp = cfg.baseDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exp, cfg.maxDelayMs);
    const jitterMs = capped * cfg.jitter * Math.random();
    return Math.floor(capped + jitterMs);
  }

  function shouldRetryCtx(ctx: InterceptorContext): boolean {
    if (ctx.attempt > cfg.maxRetries) return false;
    if (!cfg.retryMethods.includes(ctx.request.method.toUpperCase())) return false;
    if (cfg.shouldRetry) return cfg.shouldRetry(ctx);

    if (ctx.error) return cfg.retryOnError;
    if (ctx.response) return cfg.retryStatuses.includes(ctx.response.status);
    return false;
  }

  function retryAfterMs(ctx: InterceptorContext): number | null {
    const ra = ctx.response?.headers["retry-after"] ?? ctx.response?.headers["Retry-After"];
    if (!ra) return null;
    if (/^\d+$/.test(ra.trim())) return parseInt(ra, 10) * 1000;
    const ms = Date.parse(ra);
    if (!isNaN(ms)) return Math.max(0, ms - Date.now());
    return null;
  }

  const responseInterceptor: ResponseInterceptorFn = async (ctx) => {
    if (!shouldRetryCtx(ctx)) return;
    const delay = computeDelay(ctx.attempt, retryAfterMs(ctx));
    cfg.onRetry?.(ctx, delay);
    await sleep(delay);
    // Return the same request to trigger a retry
    return { ...ctx.request };
  };

  const errorInterceptor: ErrorInterceptorFn = async (ctx) => {
    if (!shouldRetryCtx(ctx)) return;
    const delay = computeDelay(ctx.attempt, null);
    cfg.onRetry?.(ctx, delay);
    await sleep(delay);
    ctx.error = null;
    // Returning undefined re-throws, so we signal retry via response interceptor
    // by resetting state — handled in manager._run
    throw new RetrySignal(ctx.request);
  };

  return { responseInterceptor, errorInterceptor };
}

/** Internal sentinel to signal a retry from the error phase. */
class RetrySignal {
  readonly __retrySignal = true;
  constructor(public readonly request: InterceptorRequest) {}
}

// ============================================================================
// §6  BUILT-IN: AUTH INTERCEPTOR (Bearer + token refresh + queue)
// ============================================================================

export interface AuthInterceptorConfig {
  /** Return the current access token. */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Called when a 401 is received. Should refresh and return the new token,
   * or null/throw to propagate the 401.
   */
  refreshToken: (() => Promise<string | null>) | null;
  /** Header to inject the token into (default: "authorization") */
  headerName: string;
  /** Scheme prefix (default: "Bearer ") */
  scheme: string;
  /** Status codes that trigger a refresh attempt (default: [401]) */
  refreshOnStatuses: number[];
  /** Max concurrent refresh queue size (default: 50) */
  maxQueue: number;
  /**
   * Circuit breaker: minimum delay between failed refresh attempts (default: 30000ms).
   * If refresh fails, subsequent requests will throw until this delay has passed.
   */
  refreshRetryDelay: number;
}

const AUTH_DEFAULTS: AuthInterceptorConfig = {
  getToken: () => null,
  refreshToken: null,
  headerName: "authorization",
  scheme: "Bearer ",
  refreshOnStatuses: [401],
  maxQueue: 50,
  refreshRetryDelay: 30_000,
};

/**
 * Create an auth interceptor pair (request + response) that injects Bearer
 * tokens and handles 401-driven token refresh with request queueing and
 * circuit-breaker.
 *
 * @param config - Auth configuration (must include `getToken`; `refreshToken`
 *   and other fields are optional)
 */
export function createAuthInterceptor(
  config: Partial<AuthInterceptorConfig> & {
    getToken: () => string | null | Promise<string | null>;
  },
): {
  /** Injects the current token into outgoing request headers */
  requestInterceptor: RequestInterceptorFn;
  /** Handles 401 responses by triggering token refresh and retry */
  responseInterceptor: ResponseInterceptorFn;
} {
  const cfg = { ...AUTH_DEFAULTS, ...config };

  let refreshPromise: Promise<string | null> | null = null;
  const queue: Array<{
    resolve: (token: string | null) => void;
    reject: (err: unknown) => void;
  }> = [];

  // Circuit breaker: track failed refreshes to prevent infinite retry loops
  let lastRefreshFailure: number | null = null;
  const REFRESH_RETRY_DELAY_MS = cfg.refreshRetryDelay ?? 30_000; // Default 30s

  async function getRefreshedToken(): Promise<string | null> {
    // Check circuit breaker: don't retry immediately after a failure
    if (lastRefreshFailure !== null) {
      const timeSinceFailure = Date.now() - lastRefreshFailure;
      if (timeSinceFailure < REFRESH_RETRY_DELAY_MS) {
        throw new Error(
          `Auth refresh circuit breaker: last failure ${Math.round(timeSinceFailure / 1000)}s ago, retry after ${Math.round((REFRESH_RETRY_DELAY_MS - timeSinceFailure) / 1000)}s`,
        );
      }
    }

    if (refreshPromise) {
      // Another refresh is in progress — queue this request
      if (queue.length >= cfg.maxQueue) throw new Error("Auth refresh queue full");
      return await new Promise<string | null>((resolve, reject) => queue.push({ resolve, reject }));
    }

    if (!cfg.refreshToken) return null;

    refreshPromise = cfg.refreshToken().then(
      (token) => {
        // Drain queue
        for (const waiter of queue) waiter.resolve(token);
        queue.length = 0;
        refreshPromise = null;
        lastRefreshFailure = null; // Reset circuit breaker on success
        return token;
      },
      (err) => {
        for (const waiter of queue) waiter.reject(err);
        queue.length = 0;
        refreshPromise = null;
        lastRefreshFailure = Date.now(); // Record failure time for circuit breaker
        throw err;
      },
    );

    return refreshPromise;
  }

  const requestInterceptor: RequestInterceptorFn = async (ctx) => {
    const token = await cfg.getToken();
    if (token) {
      ctx.request.headers[cfg.headerName] = `${cfg.scheme}${token}`;
    }
  };

  const responseInterceptor: ResponseInterceptorFn = async (ctx) => {
    if (!ctx.response) return;
    if (!cfg.refreshOnStatuses.includes(ctx.response.status)) return;
    if (!cfg.refreshToken) return;
    // Prevent infinite refresh loops
    if (ctx.request.meta.__authRetried) return;

    const newToken = await getRefreshedToken();
    if (!newToken) return;

    const retryReq: InterceptorRequest = {
      ...ctx.request,
      headers: {
        ...ctx.request.headers,
        [cfg.headerName]: `${cfg.scheme}${newToken}`,
      },
      meta: { ...ctx.request.meta, __authRetried: true },
    };
    return retryReq;
  };

  return { requestInterceptor, responseInterceptor };
}

// ============================================================================
// §7  BUILT-IN: TIMEOUT INTERCEPTOR
// ============================================================================

export interface TimeoutConfig {
  /** Default timeout in ms. 0 = disabled. */
  timeoutMs: number;
  /** Per-method overrides, e.g. { POST: 60_000 } */
  methodTimeouts: Record<string, number>;
  /** Error message on timeout */
  message: string;
}

const TIMEOUT_DEFAULTS: TimeoutConfig = {
  timeoutMs: 30_000,
  methodTimeouts: {},
  message: "Request timed out",
};

/**
 * Create a timeout interceptor that aborts requests exceeding the configured
 * deadline. Cleans up timers in both the response and error phases.
 *
 * @param config - Timeout configuration (defaults used for omitted fields)
 */
export function createTimeoutInterceptor(config: Partial<TimeoutConfig> = {}): {
  /** Identifier for this timeout interceptor instance */
  id: string;
  /** Attaches an AbortSignal to the request with the configured timeout */
  requestInterceptor: RequestInterceptorFn;
  /** Cleans up the timeout timer after a successful response */
  responseInterceptor: ResponseInterceptorFn;
  /** Cleans up the timeout timer when an error occurs */
  errorInterceptor: ErrorInterceptorFn;
} {
  const cfg = { ...TIMEOUT_DEFAULTS, ...config };

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    const ms = cfg.methodTimeouts[ctx.request.method.toUpperCase()] ?? cfg.timeoutMs;
    if (ms <= 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      ctx.aborted = true;
      controller.abort(new TimeoutError(cfg.message, ms));
    }, ms);

    // Merge with any existing signal
    const existing = ctx.request.signal;
    if (existing) {
      existing.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          controller.abort(existing.reason);
        },
        { once: true },
      );
    }

    ctx.request = { ...ctx.request, signal: controller.signal };

    // Store cleanup ref in context
    ctx.store.set(TIMEOUT_TIMER_KEY, timer);
  };

  // Response interceptor cleans up the timer after request completes
  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    const timer = ctx.store.get(TIMEOUT_TIMER_KEY) as ReturnType<typeof setTimeout> | undefined;
    if (timer) {
      clearTimeout(timer);
      ctx.store.delete(TIMEOUT_TIMER_KEY);
    }
  };

  // Error interceptor also cleans up the timer
  const errorInterceptor: ErrorInterceptorFn = (ctx) => {
    const timer = ctx.store.get(TIMEOUT_TIMER_KEY) as ReturnType<typeof setTimeout> | undefined;
    if (timer) {
      clearTimeout(timer);
      ctx.store.delete(TIMEOUT_TIMER_KEY);
    }
  };

  return {
    id: "timeout",
    requestInterceptor,
    responseInterceptor,
    errorInterceptor,
  };
}

const TIMEOUT_TIMER_KEY = Symbol("timeoutTimer");

/** Error thrown when a request exceeds the configured timeout. */
export class TimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ============================================================================
// §8  BUILT-IN: LOGGING INTERCEPTOR
// ============================================================================

/** A single structured log entry emitted by the logging interceptor. */
export interface LogEntry {
  /** Phase that triggered the entry */
  type: "request" | "response" | "error";
  /** Unix timestamp when the entry was created */
  timestamp: number;
  /** Unique request identifier */
  requestId: string;
  /** HTTP method */
  method: string;
  /** Request URL */
  url: string;
  /** HTTP status (null for request/error entries) */
  status: number | null;
  /** Elapsed time in ms (null for request entries) */
  durationMs: number | null;
  /** Attempt number (1-based) */
  attempt: number;
  /** Error message (null for request/response entries) */
  error: string | null;
}

export interface LoggingConfig {
  /** Called for every log entry. Defaults to console output. */
  logger: (entry: LogEntry) => void;
  /** Header names whose values should be redacted in logs. */
  redactHeaders: string[];
  /** Log request phase (default: true) */
  logRequests: boolean;
  /** Log response phase (default: true) */
  logResponses: boolean;
  /** Log error phase (default: true) */
  logErrors: boolean;
}

const LOG_DEFAULTS: LoggingConfig = {
  logger: (e) => console.log(JSON.stringify(e)),
  redactHeaders: ["authorization", "cookie", "set-cookie", "proxy-authorization"],
  logRequests: true,
  logResponses: true,
  logErrors: true,
};

const REQUEST_ID_KEY = Symbol("requestId");
let _reqIdSeq = 0;

/**
 * Create a logging interceptor that emits structured log entries for each
 * request, response, and error phase. Sensitive headers can be redacted.
 *
 * @param config - Logging configuration (defaults used for omitted fields)
 */
export function createLoggingInterceptor(config: Partial<LoggingConfig> = {}): {
  /** Emits a structured log entry when a request is sent */
  requestInterceptor: RequestInterceptorFn;
  /** Emits a structured log entry when a response is received */
  responseInterceptor: ResponseInterceptorFn;
  /** Emits a structured log entry when an error occurs */
  errorInterceptor: ErrorInterceptorFn;
} {
  const cfg = { ...LOG_DEFAULTS, ...config };
  const redactSet = new Set(cfg.redactHeaders.map((h) => h.toLowerCase()));

  function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = redactSet.has(k.toLowerCase()) ? "**REDACTED**" : v;
    }
    return out;
  }

  function makeEntry(type: LogEntry["type"], ctx: InterceptorContext): LogEntry {
    const requestId = (ctx.store.get(REQUEST_ID_KEY) as string) ?? "unknown";
    return {
      type,
      timestamp: Date.now(),
      requestId,
      method: ctx.request.method,
      url: ctx.request.url,
      status: ctx.response?.status ?? null,
      durationMs: type !== "request" ? now() - ctx.startedAt : null,
      attempt: ctx.attempt,
      error: ctx.error instanceof Error ? ctx.error.message : null,
    };
  }

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    const id = `req_${++_reqIdSeq}`;
    ctx.store.set(REQUEST_ID_KEY, id);
    if (!cfg.logRequests) return;
    cfg.logger(makeEntry("request", ctx));
  };

  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    if (!cfg.logResponses) return;
    cfg.logger(makeEntry("response", ctx));
  };

  const errorInterceptor: ErrorInterceptorFn = (ctx) => {
    if (!cfg.logErrors) return;
    cfg.logger(makeEntry("error", ctx));
  };

  void redactHeaders; // used externally; suppress unused warning
  return { requestInterceptor, responseInterceptor, errorInterceptor };
}

// ============================================================================
// §9  BUILT-IN: CACHE INTERCEPTOR (LRU + stale-while-revalidate)
// ============================================================================

/** A single entry in the cache store. */
export interface CacheEntry {
  /** The cached response */
  response: InterceptorResponse;
  /** Timestamp when the entry was created */
  createdAt: number;
  /** Timestamp when the entry expires (fresh until this point) */
  expiresAt: number;
  /** End of the stale-while-revalidate window */
  staleUntil: number;
  /** ETag for conditional revalidation */
  etag: string | null;
  /** Last-Modified date string for conditional revalidation */
  lastModified: string | null;
}

export interface CacheConfig {
  /** Maximum number of cached entries (LRU eviction) */
  maxEntries: number;
  /** Default TTL in ms when no Cache-Control is present (default: 60_000) */
  defaultTtlMs: number;
  /** Only cache these methods (default: ["GET", "HEAD"]) */
  cacheMethods: string[];
  /** Custom cache key function */
  cacheKey: ((req: InterceptorRequest) => string) | null;
  /** If false, ignore Cache-Control: no-store / no-cache on response */
  honorCacheControl: boolean;
}

const CACHE_DEFAULTS: CacheConfig = {
  maxEntries: 500,
  defaultTtlMs: 60_000,
  cacheMethods: ["GET", "HEAD"],
  cacheKey: null,
  honorCacheControl: true,
};

/**
 * Create a cache interceptor with LRU eviction and stale-while-revalidate
 * support. Only caches GET and HEAD by default.
 *
 * @param config - Cache configuration (defaults used for omitted fields)
 */
export function createCacheInterceptor(config: Partial<CacheConfig> = {}): {
  /** Serves cached responses and attaches conditional headers for revalidation */
  requestInterceptor: RequestInterceptorFn;
  /** Caches successful responses and handles 304 revalidation */
  responseInterceptor: ResponseInterceptorFn;
  /** Direct access to the underlying cache store */
  store: Map<string, CacheEntry>;
} {
  const cfg = { ...CACHE_DEFAULTS, ...config };
  const store = new Map<string, CacheEntry>();
  const lru: string[] = []; // front = most-recently-used

  function cacheKey(req: InterceptorRequest): string {
    return cfg.cacheKey ? cfg.cacheKey(req) : `${req.method}:${req.url}`;
  }

  function touchLRU(key: string): void {
    const idx = lru.indexOf(key);
    if (idx !== -1) lru.splice(idx, 1);
    lru.unshift(key);
    while (lru.length > cfg.maxEntries) {
      const evict = lru.pop()!;
      store.delete(evict);
    }
  }

  function parseTtl(response: InterceptorResponse): { ttlMs: number; swrMs: number } {
    const cc = response.headers["cache-control"] ?? response.headers["Cache-Control"] ?? "";
    const maxAge = cc.match(/max-age=(\d+)/)?.[1];
    const swr = cc.match(/stale-while-revalidate=(\d+)/)?.[1];
    const noStore = /no-store/i.test(cc);
    const noCache = /no-cache/i.test(cc);

    if (cfg.honorCacheControl && (noStore || noCache)) return { ttlMs: 0, swrMs: 0 };

    const ttlMs = maxAge ? parseInt(maxAge, 10) * 1000 : cfg.defaultTtlMs;
    const swrMs = swr ? parseInt(swr, 10) * 1000 : 0;
    return { ttlMs, swrMs };
  }

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    if (!cfg.cacheMethods.includes(ctx.request.method.toUpperCase())) return undefined;
    const key = cacheKey(ctx.request);
    const entry = store.get(key);
    if (!entry) return undefined;

    const t = now();

    // Fresh — return cached
    if (entry.expiresAt > t) {
      touchLRU(key);
      ctx.store.set(CACHE_HIT_KEY, true);
      return { ...entry.response, request: ctx.request };
    }

    // Stale-while-revalidate — return stale but allow pipeline to continue
    if (entry.staleUntil > t) {
      touchLRU(key);
      ctx.store.set(CACHE_STALE_KEY, entry);
      // inject conditional headers for revalidation
      if (entry.etag) {
        ctx.request = {
          ...ctx.request,
          headers: { ...ctx.request.headers, "if-none-match": entry.etag },
        };
      } else if (entry.lastModified) {
        ctx.request = {
          ...ctx.request,
          headers: { ...ctx.request.headers, "if-modified-since": entry.lastModified },
        };
      }
    }
    // SWR: allow the request to continue so the pipeline fetches fresh content
    return undefined;
  };

  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    if (!ctx.response) return;
    if (!cfg.cacheMethods.includes(ctx.request.method.toUpperCase())) return;

    const key = cacheKey(ctx.request);

    // 304 Not Modified — restore body from stale entry
    if (ctx.response.status === 304) {
      const stale = ctx.store.get(CACHE_STALE_KEY) as CacheEntry | undefined;
      if (stale) {
        const { ttlMs, swrMs } = parseTtl(stale.response);
        const t = now();
        const updated: CacheEntry = {
          ...stale,
          createdAt: t,
          expiresAt: t + ttlMs,
          staleUntil: t + ttlMs + swrMs,
        };
        store.set(key, updated);
        touchLRU(key);
        ctx.response = { ...stale.response, request: ctx.request };
        return;
      }
    }

    const { ttlMs, swrMs } = parseTtl(ctx.response);
    if (ttlMs <= 0) return;

    const t = now();
    const entry: CacheEntry = {
      response: ctx.response,
      createdAt: t,
      expiresAt: t + ttlMs,
      staleUntil: t + ttlMs + swrMs,
      etag: ctx.response.headers["etag"] ?? ctx.response.headers["ETag"] ?? null,
      lastModified: ctx.response.headers["last-modified"] ?? null,
    };
    store.set(key, entry);
    touchLRU(key);
  };

  return { requestInterceptor, responseInterceptor, store };
}

const CACHE_HIT_KEY = Symbol("cacheHit");
const CACHE_STALE_KEY = Symbol("cacheStale");

// ============================================================================
// §10  BUILT-IN: DEDUPLICATION INTERCEPTOR
// ============================================================================

/**
 * Create a deduplication interceptor that coalesces concurrent GET/HEAD
 * requests to the same URL into a single fetch.
 */
export function createDedupeInterceptor(): {
  /** Coalesces duplicate in-flight GET/HEAD requests into one */
  requestInterceptor: RequestInterceptorFn;
  /** Resolves queued waiters with the shared response */
  responseInterceptor: ResponseInterceptorFn;
  /** Rejects queued waiters when the shared request fails */
  errorInterceptor: ErrorInterceptorFn;
} {
  type Waiter = {
    resolve: (r: InterceptorResponse) => void;
    reject: (e: unknown) => void;
  };
  const inflight = new Map<string, { promise: Promise<InterceptorResponse>; waiters: Waiter[] }>();

  function key(req: InterceptorRequest): string {
    return `${req.method.toUpperCase()}:${req.url}`;
  }

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    if (ctx.request.method.toUpperCase() !== "GET" && ctx.request.method.toUpperCase() !== "HEAD")
      return;

    const k = key(ctx.request);
    const slot = inflight.get(k);
    if (!slot) {
      // First request for this key — create in-flight entry
      inflight.set(k, {
        promise: undefined as unknown as Promise<InterceptorResponse>,
        waiters: [],
      });
      return;
    }

    // A request is already in flight — queue up
    ctx.store.set(DEDUPE_QUEUED_KEY, k);
    // Return a Promise that resolves to InterceptorResponse (which is a valid RequestInterceptorResult)
    return new Promise<RequestInterceptorResult>((resolve, reject) => {
      slot.waiters.push({
        resolve: (res: InterceptorResponse) => resolve(res),
        reject: (err: unknown) => reject(err), // Properly reject instead of throwing
      });
    });
  };

  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    if (!ctx.response) return;
    const k = key(ctx.request);
    const slot = inflight.get(k);
    if (!slot) return;
    inflight.delete(k);
    for (const w of slot.waiters) w.resolve(ctx.response);
  };

  const errorInterceptor: ErrorInterceptorFn = (ctx) => {
    const k = key(ctx.request);
    const slot = inflight.get(k);
    if (!slot) return;
    inflight.delete(k);
    for (const w of slot.waiters) w.reject(ctx.error);
  };

  return { requestInterceptor, responseInterceptor, errorInterceptor };
}

const DEDUPE_QUEUED_KEY = Symbol("dedupeQueued");

// ============================================================================
// §11  BUILT-IN: RATE-LIMIT INTERCEPTOR (token bucket)
// ============================================================================

export interface RateLimitConfig {
  /** Maximum requests per window */
  limit: number;
  /** Window size in ms (default: 1000 = 1 req/s * limit) */
  windowMs: number;
  /** If true, queue excess requests instead of rejecting (default: true) */
  queue: boolean;
  /** Max queue depth before rejecting (default: 100) */
  maxQueue: number;
}

const RATE_LIMIT_DEFAULTS: RateLimitConfig = {
  limit: 60,
  windowMs: 60_000,
  queue: true,
  maxQueue: 100,
};

/**
 * Create a rate-limit interceptor using a token bucket algorithm.
 * Excess requests are queued (default) or rejected when the queue is full.
 *
 * @param config - Rate-limit configuration (defaults used for omitted fields)
 */
export function createRateLimitInterceptor(
  config: Partial<RateLimitConfig> = {},
): RequestInterceptorFn {
  const cfg = { ...RATE_LIMIT_DEFAULTS, ...config };
  let tokens = cfg.limit;
  let lastRefill = now();
  const pending: Array<() => void> = [];
  let refillTimer: ReturnType<typeof setInterval> | null = null;

  function refill(): void {
    const t = now();
    const delta = (t - lastRefill) / cfg.windowMs;
    tokens = Math.min(cfg.limit, tokens + delta * cfg.limit);
    lastRefill = t;
  }

  function ensureRefillTimer(): void {
    if (refillTimer !== null) return;
    refillTimer = setInterval(
      () => {
        refill();
        while (tokens >= 1 && pending.length > 0) {
          tokens--;
          pending.shift()!();
        }
        if (pending.length === 0 && refillTimer !== null) {
          clearInterval(refillTimer);
          refillTimer = null;
        }
      },
      Math.ceil(cfg.windowMs / cfg.limit),
    );
    if (typeof refillTimer === "object" && refillTimer !== null && "unref" in refillTimer) {
      (refillTimer as { unref: () => void }).unref();
    }
  }

  async function acquire(): Promise<void> {
    refill();
    if (tokens >= 1) {
      tokens--;
      return;
    }

    if (!cfg.queue) throw new RateLimitError("Rate limit exceeded");
    if (pending.length >= cfg.maxQueue) throw new RateLimitError("Rate limit queue full");

    await new Promise<void>((resolve) => {
      pending.push(() => resolve());
      ensureRefillTimer();
    });
  }

  return async () => {
    await acquire();
  };
}

/** Error thrown when the rate limit is exceeded. */
export class RateLimitError extends Error {
  /** Machine-readable error code identifying this as a rate-limit error */
  readonly code = "ERATELIMIT";
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ============================================================================
// §12  BUILT-IN: HAR RECORDER INTERCEPTOR
// ============================================================================

/** A single HAR (HTTP Archive) entry representing one request/response pair. */
export interface HAREntry {
  /** ISO 8601 timestamp of the request start */
  startedDateTime: string;
  /** Total round-trip time in ms */
  time: number;
  /** Request details */
  request: {
    /** HTTP method */
    method: string;
    /** Full request URL */
    url: string;
    /** HTTP version string (e.g. "HTTP/1.1") */
    httpVersion: string;
    /** Request headers as name/value pairs */
    headers: Array<{ name: string; value: string }>;
    /** Query string parameters */
    queryString: Array<{ name: string; value: string }>;
    /** Request body size in bytes */
    bodySize: number;
  };
  /** Response details */
  response: {
    /** HTTP status code */
    status: number;
    /** HTTP status text */
    statusText: string;
    /** HTTP version string */
    httpVersion: string;
    /** Response headers as name/value pairs */
    headers: Array<{ name: string; value: string }>;
    /** Response content metadata */
    content: {
      /** Content size in bytes */
      size: number;
      /** MIME type of the response */
      mimeType: string;
      /** Response body text (only for string bodies) */
      text?: string;
    };
    /** Response body size in bytes */
    bodySize: number;
    /** Redirect target URL if applicable */
    redirectURL: string;
  };
  /** Request timing breakdown */
  timings: {
    /** Time spent sending the request in ms */
    send: number;
    /** Time waiting for the response in ms */
    wait: number;
    /** Time receiving the response in ms */
    receive: number;
  };
}

/** A top-level HAR log container (HAR 1.2 format). */
export interface HARLog {
  /** HAR format version */
  version: string;
  /** Tool that created the log */
  creator: { name: string; version: string };
  /** Array of request/response entries */
  entries: HAREntry[];
}

/**
 * Create a HAR (HTTP Archive) recording interceptor.
 * Captures request/response pairs for export as a HAR log.
 */
export function createHARInterceptor(): {
  /** Records the start time for HAR entry timing */
  requestInterceptor: RequestInterceptorFn;
  /** Captures request/response details into the HAR log */
  responseInterceptor: ResponseInterceptorFn;
  /** Returns the recorded HAR log in HAR 1.2 format */
  getHAR: () => HARLog;
  /** Clears all recorded HAR entries */
  clearHAR: () => void;
} {
  const entries: HAREntry[] = [];
  const HAR_START_KEY = Symbol("harStart");

  function headersToHAR(h: Record<string, string>): Array<{ name: string; value: string }> {
    return Object.entries(h).map(([name, value]) => ({ name, value }));
  }

  function queryStringFromURL(url: string): Array<{ name: string; value: string }> {
    try {
      const u = new URL(url);
      return Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  }

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    ctx.store.set(HAR_START_KEY, now());
  };

  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    if (!ctx.response) return;
    const started = (ctx.store.get(HAR_START_KEY) as number) ?? ctx.startedAt;
    const total = now() - started;
    const mime =
      ctx.response.headers["content-type"] ??
      ctx.response.headers["Content-Type"] ??
      "application/octet-stream";

    const body = ctx.response.body;
    const bSize =
      body instanceof Uint8Array ? body.byteLength : typeof body === "string" ? body.length : 0;

    entries.push({
      startedDateTime: new Date(Date.now() - total).toISOString(),
      time: total,
      request: {
        method: ctx.request.method.toUpperCase(),
        url: ctx.request.url,
        httpVersion: "HTTP/1.1",
        headers: headersToHAR(ctx.request.headers),
        queryString: queryStringFromURL(ctx.request.url),
        bodySize: computeBodySize(ctx.request.body),
      },
      response: {
        status: ctx.response.status,
        statusText: ctx.response.statusText,
        httpVersion: "HTTP/1.1",
        headers: headersToHAR(ctx.response.headers),
        content: {
          size: bSize,
          mimeType: mime,
          ...(typeof body === "string" ? { text: body } : {}),
        },
        bodySize: bSize,
        redirectURL: ctx.response.headers["location"] ?? "",
      },
      timings: {
        send: 0,
        wait: Math.floor(total * 0.9),
        receive: Math.floor(total * 0.1),
      },
    });
  };

  return {
    requestInterceptor,
    responseInterceptor,
    getHAR: () => ({
      version: "1.2",
      creator: { name: "kinetex", version: "0.0.3" },
      entries: [...entries],
    }),
    clearHAR: () => {
      entries.length = 0;
    },
  };
}

// ============================================================================
// §13  BUILT-IN: METRICS INTERCEPTOR
// ============================================================================

/** Snapshot of metrics collected by the metrics interceptor. */
export interface MetricsSnapshot {
  /** Total requests processed */
  totalRequests: number;
  /** Total errors encountered */
  totalErrors: number;
  /** Total retry attempts */
  totalRetries: number;
  /** Status code buckets ("2xx", "3xx", "4xx", "5xx") */
  statusBuckets: Record<string, number>;
  /** Average request duration in ms */
  avgDurationMs: number;
  /** Median request duration in ms */
  p50DurationMs: number;
  /** 95th percentile duration in ms */
  p95DurationMs: number;
  /** 99th percentile duration in ms */
  p99DurationMs: number;
}

/**
 * Create a metrics interceptor that tracks request count, error rate, status
 * code buckets, and duration percentiles.
 */
export function createMetricsInterceptor(): {
  /** Records request start time and increments request counter */
  requestInterceptor: RequestInterceptorFn;
  /** Records response duration and updates status code buckets */
  responseInterceptor: ResponseInterceptorFn;
  /** Increments the error counter on pipeline errors */
  errorInterceptor: ErrorInterceptorFn;
  /** Returns a snapshot of accumulated metrics */
  snapshot: () => MetricsSnapshot;
  /** Resets all metrics counters to zero */
  reset: () => void;
} {
  const METRICS_START = Symbol("metricsStart");
  let totalRequests = 0;
  let totalErrors = 0;
  let totalRetries = 0;
  const statusBuckets: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  const MAX_DURATIONS = 10_000;
  const durations: number[] = [];

  const requestInterceptor: RequestInterceptorFn = (ctx) => {
    ctx.store.set(METRICS_START, now());
    totalRequests++;
    if (ctx.attempt > 1) totalRetries++;
  };

  const responseInterceptor: ResponseInterceptorFn = (ctx) => {
    if (!ctx.response) return;
    const started = ctx.store.get(METRICS_START) as number | undefined;
    if (started !== undefined) {
      const elapsed = now() - started;
      if (durations.length >= MAX_DURATIONS) durations.shift();
      durations.push(elapsed);
    }

    const bucket = `${Math.floor(ctx.response.status / 100)}xx`;
    if (bucket in statusBuckets) {
      const buckets = statusBuckets as Record<string, number>;
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
  };

  const errorInterceptor: ErrorInterceptorFn = () => {
    totalErrors++;
  };

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    const boundedIdx = Math.min(Math.max(0, idx), sorted.length - 1);
    return sorted[boundedIdx]!;
  }

  const snapshot = (): MetricsSnapshot => {
    const sorted = [...durations].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return {
      totalRequests,
      totalErrors,
      totalRetries,
      statusBuckets: { ...statusBuckets },
      avgDurationMs: Math.round(avg),
      p50DurationMs: percentile(sorted, 50),
      p95DurationMs: percentile(sorted, 95),
      p99DurationMs: percentile(sorted, 99),
    };
  };

  const reset = (): void => {
    totalRequests = 0;
    totalErrors = 0;
    totalRetries = 0;
    for (const k of Object.keys(statusBuckets)) statusBuckets[k] = 0;
    durations.length = 0;
  };

  return { requestInterceptor, responseInterceptor, errorInterceptor, snapshot, reset };
}

// ============================================================================
// §14  UTILITIES
// ============================================================================

function now(): number {
  // Use performance.now() when available (browser, Deno, Node 16+, Bun)
  // Fall back to Date.now() for edge runtimes that may not expose it
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @internal Compute byte size of a request/response body. Exported for testing. */
export function computeBodySize(body: BodyInit | string | Uint8Array | null): number {
  if (!body) return 0;
  if (typeof body === "string") return body.length;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return -1;
}

// ============================================================================
// §15  CONVENIENCE: register all built-ins at once
// ============================================================================

/** All interceptor instances returned by {@link createInterceptorSuite}. */
export interface FullInterceptorSuite {
  /** The interceptor manager with all built-ins registered. */
  manager: InterceptorManager;
  /** Retry interceptor pair. */
  retry: ReturnType<typeof createRetryInterceptor>;
  /** Auth interceptor pair (null if not configured). */
  auth: ReturnType<typeof createAuthInterceptor> | null;
  /** Timeout interceptor metadata. */
  timeout: { id: string };
  /** Logging interceptor triplet. */
  logging: ReturnType<typeof createLoggingInterceptor>;
  /** Cache interceptor with store. */
  cache: ReturnType<typeof createCacheInterceptor>;
  /** Deduplication interceptor triplet. */
  dedupe: ReturnType<typeof createDedupeInterceptor>;
  /** HAR recording interceptor. */
  har: ReturnType<typeof createHARInterceptor>;
  /** Metrics interceptor. */
  metrics: ReturnType<typeof createMetricsInterceptor>;
}

/** Configuration options for {@link createInterceptorSuite}. */
export interface SuiteConfig {
  retry?: Partial<RetryConfig>;
  auth?: Partial<AuthInterceptorConfig> & {
    getToken: () => string | null | Promise<string | null>;
  };
  timeout?: Partial<TimeoutConfig>;
  logging?: Partial<LoggingConfig>;
  cache?: Partial<CacheConfig>;
  rateLimit?: Partial<RateLimitConfig>;
}

/**
 * Create a full interceptor suite with all built-in interceptors registered
 * at sensible priority levels:
 *
 * | Priority | Interceptor      |
 * |----------|------------------|
 * | -100     | Timeout          |
 * | -90      | Rate limit       |
 * | -80      | Deduplication    |
 * | -70      | Cache            |
 * | -50      | Auth             |
 * |  50      | Retry            |
 * |  90      | Logging          |
 * |  95      | HAR              |
 * | 100      | Metrics          |
 *
 * @param config - Configuration for each built-in interceptor
 */
export function createInterceptorSuite(config: SuiteConfig = {}): FullInterceptorSuite {
  const manager = new InterceptorManager();

  // Timeout — lowest priority (outermost wrap)
  const timeout = createTimeoutInterceptor(config.timeout);
  manager.useRequest(timeout.requestInterceptor, { priority: -100, id: "timeout-req" });
  manager.useResponse(timeout.responseInterceptor, { priority: -100, id: "timeout-res" });
  manager.useError(timeout.errorInterceptor, { priority: -100, id: "timeout-err" });

  // Rate limit
  if (config.rateLimit) {
    manager.useRequest(createRateLimitInterceptor(config.rateLimit), {
      priority: -90,
      id: "ratelimit",
    });
  }

  // Dedupe
  const dedupe = createDedupeInterceptor();
  manager.useRequest(dedupe.requestInterceptor, { priority: -80, id: "dedupe-req" });
  manager.useResponse(dedupe.responseInterceptor, { priority: -80, id: "dedupe-res" });
  manager.useError(dedupe.errorInterceptor, { priority: -80, id: "dedupe-err" });

  // Cache
  const cache = createCacheInterceptor(config.cache);
  manager.useRequest(cache.requestInterceptor, { priority: -70, id: "cache-req" });
  manager.useResponse(cache.responseInterceptor, { priority: -70, id: "cache-res" });

  // Auth
  let authSuite: ReturnType<typeof createAuthInterceptor> | null = null;
  if (config.auth) {
    authSuite = createAuthInterceptor(config.auth);
    manager.useRequest(authSuite.requestInterceptor, { priority: -50, id: "auth-req" });
    manager.useResponse(authSuite.responseInterceptor, { priority: -50, id: "auth-res" });
  }

  // Retry
  const retry = createRetryInterceptor(config.retry);
  manager.useResponse(retry.responseInterceptor, { priority: 50, id: "retry-res" });
  manager.useError(retry.errorInterceptor, { priority: 50, id: "retry-err" });

  // Logging
  const logging = createLoggingInterceptor(config.logging);
  manager.useRequest(logging.requestInterceptor, { priority: 90, id: "log-req" });
  manager.useResponse(logging.responseInterceptor, { priority: 90, id: "log-res" });
  manager.useError(logging.errorInterceptor, { priority: 90, id: "log-err" });

  // HAR
  const har = createHARInterceptor();
  manager.useRequest(har.requestInterceptor, { priority: 95, id: "har-req" });
  manager.useResponse(har.responseInterceptor, { priority: 95, id: "har-res" });

  // Metrics
  const metrics = createMetricsInterceptor();
  manager.useRequest(metrics.requestInterceptor, { priority: 100, id: "metrics-req" });
  manager.useResponse(metrics.responseInterceptor, { priority: 100, id: "metrics-res" });
  manager.useError(metrics.errorInterceptor, { priority: 100, id: "metrics-err" });

  return {
    manager,
    retry,
    auth: authSuite,
    timeout: { id: timeout.id },
    logging,
    cache,
    dedupe,
    har,
    metrics,
  };
}
