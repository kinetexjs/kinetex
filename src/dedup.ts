/**
 * In-flight request deduplication (coalescing) for kinetex.
 *
 * When multiple callers make identical concurrent requests (same method +
 * URL + headers), dedup coalesces them into a single network call and
 * fans the result out to all waiters. This prevents thundering-herd
 * patterns in React renders, parallel service calls, and CDN misses.
 *
 * Features:
 *  - Key-based deduplication (fully customizable key function)
 *  - Configurable TTL: response cached briefly so slightly-staggered
 *    calls (within `windowMs`) also hit the coalesced result
 *  - Cancellation: if the "leader" request is aborted, waiters fall
 *    through to their own requests automatically
 *  - Error propagation: errors are shared across all waiting callers
 *  - Metrics: hit count, miss count, in-flight map
 *  - Zero dependencies, cross-runtime
 */

// ============================================================================
// §1  TYPES
// ============================================================================

export interface DedupOptions {
  /**
   * Custom key function. Receives the method and URL.
   * Default: `"${method}::${url}"`
   */
  keyFn?: (method: string, url: string, headers?: Record<string, string>) => string;
  /**
   * How long (ms) to keep a completed response in the window so that
   * requests arriving just after completion still coalesce.
   * Default: 0 (disabled — only in-flight requests are deduplicated)
   */
  windowMs?: number;
  /**
   * HTTP methods to deduplicate. Default: ["GET", "HEAD"]
   * Only safe idempotent methods should be deduplicated.
   * Note: Methods are case-insensitive (converted to uppercase internally).
   */
  methods?: string[];
  /**
   * Global abort signal for the dedup map. When aborted, in-flight entries
   * are cleaned up and new calls fall through to factory().
   * Note: Pass per-request signals to `execute()` instead for finer control.
   * @experimental
   */
  signal?: AbortSignal;
  /**
   * Timer functions used for the coalescing window.
   *
   * Defaults to the globals. Injecting them lets a test drive the window
   * without replacing `globalThis.setTimeout` — which, when done at module
   * scope, also captures every unrelated timer in the process. That is not
   * hypothetical: undici's HTTP/1 parser calls `setTimeout` and then `.unref()`s
   * the result, so a stub returning a plain number crashed a run outright as
   * soon as any socket was open.
   */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

interface InFlightEntry<T> {
  promise: Promise<T>;
  resolvedAt: number | null;
  result?: unknown; // stored as unknown, cast at use site
  error?: unknown;
}

// ============================================================================
// §2  DEDUP MAP
// ============================================================================

/**
 * Headers that are per-request noise rather than part of a request's identity.
 *
 * Two callers sending different trace ids are the same request as far as the
 * response is concerned, so including them would only cost the coalescing that
 * dedup exists to provide. Everything else — `Authorization`, `Cookie`,
 * `Accept`, any custom header a gateway keys on — participates, so a request is
 * only ever coalesced with one that would have received the same response.
 */
/**
 * The default dedup key: method, URL, and the identity-bearing headers.
 *
 * Sorting makes the key order-independent, since two requests that differ only
 * in header order are the same request. Values are included verbatim: a caller
 * that wants coarser or finer granularity supplies a `keyFn`.
 */
/**
 * Headers excluded from a request's identity, as with {@link defaultDedupKey}.
 * Duplicated rather than imported so `dedup.ts` stays dependency-free; the two
 * lists must be kept in step.
 */
const NON_IDENTITY_HEADERS = [
  "traceparent",
  "tracestate",
  "baggage",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
];

/**
 * A stable, opaque digest of everything that makes a request distinct.
 *
 * Hashing rather than concatenating keeps credentials out of the key: a dedup
 * map is a long-lived map of strings, and its keys should not be a place where
 * an `Authorization` header sits in plain text. Returns `""` when no header
 * distinguishes the request, so the common unauthenticated case keys on method
 * and URL alone.
 */
export async function identityFingerprint(
  headers: Record<string, string> | undefined,
): Promise<string> {
  if (headers === undefined) return "";
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lowered.set(name.toLowerCase(), value);
  }
  const parts: string[] = [];
  for (const name of NON_IDENTITY_HEADERS) lowered.delete(name);
  for (const name of [...lowered.keys()].sort()) {
    parts.push(`${name}=${lowered.get(name)}`);
  }
  if (parts.length === 0) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a dedup key from a method, URL and identity digest.
 */
export function dedupKeyFrom(method: string, url: string, fingerprint: string): string {
  return fingerprint ? `${method}:${url}:${fingerprint}` : `${method}:${url}`;
}

export function defaultDedupKey(
  method: string,
  url: string,
  headers?: Record<string, string>,
): string {
  if (headers === undefined) return `${method}::${url}`;
  const identity = Object.entries(headers)
    .filter(([name]) => !NON_IDENTITY_HEADERS.includes(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}=${value}`)
    .sort();
  // No distinguishing header means the key stays method + URL, so an empty
  // header set does not silently become a different key shape.
  return identity.length === 0 ? `${method}::${url}` : `${method}::${url}::${identity.join("&")}`;
}

/**
 * `DedupMap` manages in-flight promises keyed by a request fingerprint.
 * It is transport-agnostic — pass any async factory function.
 */
export class DedupMap<T = unknown> {
  private readonly inflight = new Map<string, InFlightEntry<T>>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Window timers, overridable for tests. See {@link DedupOptions.timers}. */
  private readonly _setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly windowMs: number;
  private readonly methods: Set<string>;
  private readonly keyFn: (m: string, url: string, headers?: Record<string, string>) => string;
  private readonly _globalSignal: AbortSignal | null;

  // Metrics (private - use getters)
  private _hits = 0;
  private _misses = 0;

  /**
   * @param options - Deduplication configuration
   */
  constructor(options: DedupOptions = {}) {
    this.windowMs = options.windowMs ?? 0;
    this.methods = new Set((options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase()));
    this.keyFn = options.keyFn ?? defaultDedupKey;
    this._globalSignal = options.signal ?? null;
    this._setTimeout = options.timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.timers?.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /**
   * Execute `factory` for the given method/url, or return the in-flight
   * promise if one already exists for the same key.
   *
   * @param method  - HTTP method
   * @param url     - Request URL (fully resolved)
   * @param factory - Async function that performs the actual work
   * @param headers - Optional headers included in the key (not deduplicated by default!)
   * @param windowMs - Optional per-key TTL override for this specific call.
   *                   Uses the default windowMs if not provided.
   * @param signal - Optional abort signal for this specific request.
   *                   Falls back to the global signal from DedupOptions if not provided.
   *
   * @throws If `factory` throws, the error is propagated to all concurrent
   *         waiters sharing the same promise. The entry is removed on error,
   *         so subsequent callers will trigger a fresh factory call.
   *
   * Thread-safety: In single-threaded JavaScript, the synchronous `inflight.get(key)`
   * check is atomic - there's no race condition between checking for an existing
   * entry and creating a new one. The first caller becomes the "leader" and all
   * subsequent callers within the same tick share the same promise.
   *
   * Note: the default key includes the request headers, so two requests to the
   * same URL carrying different `Authorization` or `Cookie` are separate
   * requests and are never coalesced. A key of method + URL alone was the
   * default once, and it handed one caller's response to another: 50 callers
   * aside, even two callers for different tenants shared a single response.
   * See {@link defaultDedupKey}.
   */
  execute(
    method: string,
    url: string,
    factory: () => Promise<T>,
    headers?: Record<string, string>,
    windowMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    // Use per-key TTL if provided, otherwise fall back to global windowMs (F-3)
    const effectiveWindowMs = windowMs ?? this.windowMs;
    // Use per-request signal, falling back to the global options signal
    const effectiveSignal = signal ?? this._globalSignal;

    // Handle abort signal (F-2): if signal is already aborted, don't dedupe
    if (effectiveSignal?.aborted) {
      // Still a real network call. It used to return before the counters were
      // touched, so a client whose method filter excluded everything reported
      // totalRequests 0 and a hitRate of 0 after any number of real requests
      // — and `misses` is documented as "requests that triggered a real
      // network call". Both bypasses below now count.
      this._misses++;
      return factory();
    }

    if (!this.methods.has(method.toUpperCase())) {
      this._misses++;
      return factory();
    }

    // The method is canonicalised before it reaches the key function. The
    // methods filter has always been case-insensitive, but the key was built
    // from the caller's spelling, so `execute("get", u)` and
    // `execute("GET", u)` were two different keys and never coalesced — the
    // one case a caller gets wrong most often, and one the library otherwise
    // treats as equal everywhere.
    const canonicalMethod = method.toUpperCase();
    const key = this.keyFn(canonicalMethod, url, headers);
    const existing = this.inflight.get(key);

    if (existing) {
      // In-flight: share the promise. This is coalescing, not caching, so it
      // is not gated on the window.
      if (existing.resolvedAt === null) {
        this._hits++;
        return existing.promise;
      }

      // Within window: return cached result
      if (effectiveWindowMs > 0 && Date.now() - existing.resolvedAt <= effectiveWindowMs) {
        this._hits++;
        // Return the typed promise directly - preserves error type
        return existing.promise;
      }

      if (effectiveWindowMs > 0) {
        // This caller's own window has lapsed — drop the stale entry and lead.
        this.inflight.delete(key);
      } else {
        // This caller explicitly asked for no window, so it gets its own
        // request. It used to fall through to `inflight.delete(key)` and lead
        // as well, which destroyed a window some *other* caller had
        // established and was still relying on: one `windowMs: 0` call was
        // enough to empty the cache for everyone, and the next windowed caller
        // had to go to the network for a result that was still in hand.
        this._misses++;
        return factory();
      }
    }

    this._misses++;

    // Create entry and register it in the inflight map BEFORE starting the async work
    // to prevent a race where another caller checks inflight.get(key) before set().
    const entry: InFlightEntry<T> = {
      resolvedAt: null,
      promise: undefined as unknown as Promise<T>,
    };
    this.inflight.set(key, entry);

    entry.promise = (async () => {
      const onAbort = effectiveSignal
        ? () => {
            this.inflight.delete(key);
            const existingTimeout = this.timeouts.get(key);
            if (existingTimeout !== undefined) {
              this._clearTimeout(existingTimeout);
              this.timeouts.delete(key);
            }
          }
        : null;
      if (effectiveSignal && onAbort) {
        effectiveSignal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        return await factory();
      } finally {
        if (effectiveSignal && onAbort) {
          effectiveSignal.removeEventListener("abort", onAbort);
        }
      }
    })().then(
      (result) => {
        entry.resolvedAt = Date.now();
        entry.result = result;
        // This entry may have lost the key while the factory was running: an
        // abort, a `clear()`, or an `invalidate()` all drop it, and a later
        // caller for the same URL then becomes the leader. Registering a
        // window timer here regardless re-inserted a timer for a key someone
        // else now owns, and when it fired it deleted their still-in-flight
        // entry — so the request after that started a third copy. The
        // identity check is what makes "who owns this key" decidable.
        if (this.inflight.get(key) !== entry) {
          return result;
        }
        if (effectiveWindowMs <= 0) {
          this.inflight.delete(key);
        } else {
          // Clear any previous timer for this key first. Registering a new
          // window without clearing the old one let the stale timer fire later
          // and `inflight.delete(key)` — wiping the *new*, still-in-flight entry
          // out from under callers that were sharing it.
          const stale = this.timeouts.get(key);
          if (stale !== undefined) {
            this._clearTimeout(stale);
            this.timeouts.delete(key);
          }
          const timeoutId = this._setTimeout(() => {
            this.inflight.delete(key);
            this.timeouts.delete(key);
          }, effectiveWindowMs);
          this.timeouts.set(key, timeoutId);
        }
        return result;
      },
      (err) => {
        entry.resolvedAt = Date.now();
        entry.error = err;
        // Same ownership rule as the success path: an entry that has already
        // been dropped must not delete the entry that replaced it.
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
        const existingTimeout = this.timeouts.get(key);
        if (existingTimeout !== undefined) {
          this._clearTimeout(existingTimeout);
          this.timeouts.delete(key);
        }
        throw err;
      },
    );

    return entry.promise;
  }

  /** Number of requests that shared an in-flight or windowed response. */
  get hits(): number {
    return this._hits;
  }
  /** Number of requests that triggered a real network call. */
  get misses(): number {
    return this._misses;
  }
  /** Number of currently in-flight requests. */
  get inFlightCount(): number {
    let count = 0;
    for (const e of this.inflight.values()) {
      if (e.resolvedAt === null) count++;
    }
    return count;
  }

  /** All currently tracked keys (in-flight + window). */
  get keys(): string[] {
    return [...this.inflight.keys()];
  }

  /**
   * Get comprehensive deduplication statistics.
   *
   * NOTE: inFlightCount and trackedKeys reflect snapshot time; entries may
   * resolve asynchronously between sampling and return (non-blocking, acceptable).
   *
   * @returns Snapshot containing `hits`, `misses`, `totalRequests`, `hitRate` (0–1),
   *          `inFlightCount`, and `trackedKeys`.
   */
  getStats(): {
    /** Number of requests that shared an in-flight or windowed response. */
    hits: number;
    /** Number of requests that triggered a real network call. */
    misses: number;
    /** Total number of requests (hits + misses). */
    totalRequests: number;
    /** Hit rate ratio (0–1). */
    hitRate: number;
    /** Number of currently in-flight requests. */
    inFlightCount: number;
    /** Number of tracked keys (in-flight + window). */
    trackedKeys: number;
  } {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      totalRequests: total,
      hitRate: total === 0 ? 0 : this._hits / total,
      inFlightCount: this.inFlightCount,
      trackedKeys: this.inflight.size,
    };
  }

  /** Reset metrics counters. */
  resetMetrics(): void {
    this._hits = 0;
    this._misses = 0;
  }

  /** Clear all in-flight entries (does NOT cancel their underlying promises). */
  clear(): void {
    this.inflight.clear();
    // Clear pending timeouts (B-1)
    for (const timeoutId of this.timeouts.values()) {
      this._clearTimeout(timeoutId);
    }
    this.timeouts.clear();
  }

  /**
   * Manually invalidate a specific key.
   * Removes the entry from the dedup map and clears any pending timeout.
   *
   * @param key - The key to invalidate
   * @returns true if key was found and removed
   */
  invalidate(key: string): boolean {
    const timeoutId = this.timeouts.get(key);
    if (timeoutId) {
      this._clearTimeout(timeoutId);
      this.timeouts.delete(key);
    }
    return this.inflight.delete(key);
  }

  /**
   * Destroy the dedup map - clears all entries and cancels all timeouts.
   * Use this when the dedup map is no longer needed to prevent memory leaks.
   */
  destroy(): void {
    this.clear();
  }
}

// ============================================================================
// §3  FACTORY
// ============================================================================

/**
 * Create a `DedupMap` with default options.
 *
 * @example
 * ```ts
 * const dedup = createDedupMap({ windowMs: 100 });
 *
 * // Both calls below share one network request
 * const [a, b] = await Promise.all([
 *   dedup.execute("GET", "/api/users", () => client.get("/api/users")),
 *   dedup.execute("GET", "/api/users", () => client.get("/api/users")),
 * ]);
 * ```
 *
 * @typeParam T - The expected result type of the factory function.
 *                Note: `T` is purely for caller-side type inference — it does
 *                not validate the factory's return type at runtime.
 */
export function createDedupMap<T>(options?: DedupOptions): DedupMap<T> {
  return new DedupMap<T>(options);
}
