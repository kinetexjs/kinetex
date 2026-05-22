/**
 * HTTP circuit breaker for kinetex.
 * Implements the classic three-state machine:
 *
 *   CLOSED ──(threshold failures)──► OPEN ──(resetTimeoutMs)──► HALF_OPEN
 *     ▲                                                               │
 *     └──────────────────(probe succeeded)────────────────────────────┘
 *   Probe failures re-open: HALF_OPEN ──► OPEN
 *
 * Features:
 *  - Per-origin (or per-key) isolation — one breaker per service
 *  - Configurable failure threshold, success threshold, and reset window
 *  - Separate tracking for network errors vs HTTP errors vs timeouts
 *  - Sliding-window or consecutive-count failure detection
 *  - Half-open probe with configurable concurrency limit
 *  - Callbacks: onOpen, onClose, onHalfOpen, onRejected
 *  - Manual trip / reset for admin operations
 *  - State serialization for persistence / dashboards
 *  - Zero dependencies, cross-runtime (Node / Deno / Bun / Browser / Edge)
 */

// ============================================================================
// #1  TYPES
// ============================================================================

/** Circuit breaker states. */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Which failure categories count toward the threshold. */
export interface FailureFilter {
  /** Count network errors (ENETWORK). Default: true */
  networkErrors?: boolean;
  /** Count timeout errors (ETIMEOUT). Default: true */
  timeouts?: boolean;
  /** Count HTTP 5xx responses (requires `throwOnError: true`). Default: false */
  serverErrors?: boolean;
  /** Specific HTTP status codes that count as failures. Default: [] */
  statusCodes?: number[];
}

/** Full circuit breaker configuration. */
export interface CircuitBreakerConfig {
  /**
   * Number of failures in the window before opening the circuit.
   * Default: 5
   */
  failureThreshold?: number;
  /**
   * Sliding-window size (number of most-recent calls tracked).
   * Set to 0 for consecutive-count mode (any 5 in a row).
   * Default: 10
   */
  windowSize?: number;
  /**
   * How long to keep the circuit OPEN before probing (ms).
   * Default: 30_000
   */
  resetTimeoutMs?: number;
  /**
   * Number of consecutive successes in HALF_OPEN needed to close.
   * Default: 2
   */
  successThreshold?: number;
  /**
   * Maximum in-flight probe requests allowed in HALF_OPEN.
   * Default: 1
   */
  halfOpenConcurrency?: number;
  /** Which error categories count as failures. */
  failures?: FailureFilter;
  /** Called when the circuit opens. */
  onOpen?: (state: CircuitBreakerState) => void;
  /** Called when the circuit closes (recovers). */
  onClose?: (state: CircuitBreakerState) => void;
  /** Called when the circuit enters half-open. */
  onHalfOpen?: (state: CircuitBreakerState) => void;
  /** Called when a request is rejected due to an open circuit. */
  onRejected?: (state: CircuitBreakerState) => void;
}

/** Current state snapshot — safe to serialize. */
export interface CircuitBreakerState {
  /** Current circuit state */
  state: CircuitState;
  /** Failure count (window or consecutive, depending on config) */
  failureCount: number;
  /** Consecutive success count (used in HALF_OPEN) */
  successCount: number;
  /** Timestamp of last failure, or null */
  lastFailureAt: number | null;
  /** Timestamp of last success, or null */
  lastSuccessAt: number | null;
  /** Timestamp when circuit was opened, or null */
  openedAt: number | null;
  /** Timestamp when circuit entered HALF_OPEN, or null */
  halfOpenAt: number | null;
  /** Total requests ever attempted */
  totalRequests: number;
  /** Total failures ever recorded */
  totalFailures: number;
  /** Total successes ever recorded */
  totalSuccesses: number;
  /** Total requests rejected while OPEN */
  totalRejected: number;
  /** Current in-flight probe requests in HALF_OPEN */
  inFlightProbes: number;
}

/** Error thrown when a request is rejected by an open circuit. */
export class CircuitOpenError extends Error {
  /** Machine-readable error code: "ECIRCUITOPEN" */
  readonly code = "ECIRCUITOPEN";
  /** Snapshot of breaker state at the time of rejection */
  readonly state: CircuitBreakerState;

  /**
   * @param key - The circuit breaker key (typically the origin/host)
   * @param state - Snapshot of breaker state at rejection time
   */
  constructor(key: string, state: CircuitBreakerState) {
    super(`Circuit breaker OPEN for "${key}" — request rejected`);
    this.name = "CircuitOpenError";
    this.state = state;
  }
}

// ============================================================================
// #2  CIRCUIT BREAKER
// ============================================================================

/**
 * Per-key circuit breaker implementing the CLOSED → OPEN → HALF_OPEN state
 * machine with sliding-window or consecutive-count failure detection.
 *
 * Thread-safe for async use. Rejects with {@link CircuitOpenError} when OPEN.
 *
 * @example
 * ```typescript
 * const cb = new CircuitBreaker("api.example.com", { failureThreshold: 3 });
 * const result = await cb.execute(() => fetch("https://api.example.com/data"));
 * ```
 */
export class CircuitBreaker {
  /** The breaker key (typically origin/host) */
  private readonly key: string;
  /** Failure count needed to open the circuit */
  private readonly failureThreshold: number;
  /** Sliding-window size (0 = consecutive-count mode) */
  private readonly windowSize: number;
  /** Duration in ms before transitioning OPEN → HALF_OPEN */
  private readonly resetTimeoutMs: number;
  /** Consecutive successes in HALF_OPEN needed to close */
  private readonly successThreshold: number;
  /** Maximum in-flight probe requests allowed in HALF_OPEN */
  private readonly halfOpenConcurrency: number;
  /** Which error categories count as failures */
  private readonly failureFilter: Required<FailureFilter>;
  /** Raw config reference (for callbacks) */
  private readonly cfg: CircuitBreakerConfig;

  /** Current circuit state */
  private _state: CircuitState = "CLOSED";
  /** Sliding window of success/failure booleans */
  private _window: boolean[] = [];
  /** Consecutive failure counter (used in consecutive mode) */
  private _consecutiveFails = 0;
  /** Consecutive success counter (used in HALF_OPEN) */
  private _consecutiveSucc = 0;
  /** Timestamp the circuit was opened */
  private _openedAt: number | null = null;
  /** Timestamp the circuit entered HALF_OPEN */
  private _halfOpenAt: number | null = null;
  /** Timestamp of the last failure */
  private _lastFailureAt: number | null = null;
  /** Timestamp of the last success */
  private _lastSuccessAt: number | null = null;
  /** Current number of in-flight probe requests */
  private _inFlightProbes = 0;

  // Lifetime counters
  private _totalRequests = 0;
  private _totalFailures = 0;
  private _totalSuccesses = 0;
  private _totalRejected = 0;

  /**
   * @param key - The breaker key (typically origin/host like "https://api.example.com")
   * @param config - Circuit breaker configuration
   */
  constructor(key: string, config: CircuitBreakerConfig = {}) {
    this.key = key;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.windowSize = config.windowSize ?? 10;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.successThreshold = config.successThreshold ?? 2;
    this.halfOpenConcurrency = config.halfOpenConcurrency ?? 1;
    this.failureFilter = {
      networkErrors: config.failures?.networkErrors ?? true,
      timeouts: config.failures?.timeouts ?? true,
      serverErrors: config.failures?.serverErrors ?? false,
      statusCodes: config.failures?.statusCodes ?? [],
    };
    this.cfg = config;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** The current circuit state. */
  get state(): CircuitState {
    return this._state;
  }

  /** Snapshot of all counters — suitable for logging or dashboards. */
  get snapshot(): CircuitBreakerState {
    return {
      state: this._state,
      failureCount:
        this.windowSize > 0 ? this._window.filter((v) => !v).length : this._consecutiveFails,
      successCount: this._consecutiveSucc,
      lastFailureAt: this._lastFailureAt,
      lastSuccessAt: this._lastSuccessAt,
      openedAt: this._openedAt,
      halfOpenAt: this._halfOpenAt,
      totalRequests: this._totalRequests,
      totalFailures: this._totalFailures,
      totalSuccesses: this._totalSuccesses,
      totalRejected: this._totalRejected,
      inFlightProbes: this._inFlightProbes,
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws `CircuitOpenError` if the circuit is open.
   * Records success/failure and transitions state accordingly.
   */
  execute<T>(fn: () => Promise<T>): Promise<T> {
    this._checkTransition();

    if (this._state === "OPEN") {
      this._totalRejected++;
      const snap = this.snapshot;
      this.cfg.onRejected?.(snap);
      return Promise.reject(new CircuitOpenError(this.key, snap));
    }

    if (this._state === "HALF_OPEN") {
      if (this._inFlightProbes >= this.halfOpenConcurrency) {
        this._totalRejected++;
        const snap = this.snapshot;
        this.cfg.onRejected?.(snap);
        return Promise.reject(new CircuitOpenError(this.key, snap));
      }
      this._inFlightProbes++;
    }

    this._totalRequests++;

    return fn().then(
      (result) => {
        if (this._state === "HALF_OPEN")
          this._inFlightProbes = Math.max(0, this._inFlightProbes - 1);
        this._recordSuccess();
        return result;
      },
      (err: unknown) => {
        if (this._state === "HALF_OPEN")
          this._inFlightProbes = Math.max(0, this._inFlightProbes - 1);
        if (this._isCountableFailure(err)) {
          this._recordFailure();
        }
        // Never decrement _totalRequests — keep a faithful count of all attempts,
        // including non-countable failures (e.g. app-level errors we don't treat as outages).
        throw err;
      },
    );
  }

  /**
   * Manually trip the circuit open — useful for maintenance windows.
   */
  trip(): void {
    if (this._state !== "OPEN") {
      this._openedAt = Date.now();
      this._state = "OPEN";
      this.cfg.onOpen?.(this.snapshot);
    }
  }

  /**
   * Manually reset the circuit to CLOSED — useful after a fix deployment.
   */
  reset(): void {
    this._state = "CLOSED";
    this._window = [];
    this._consecutiveFails = 0;
    this._consecutiveSucc = 0;
    this._openedAt = null;
    this._halfOpenAt = null;
    this._inFlightProbes = 0;
    this.cfg.onClose?.(this.snapshot);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Check if the OPEN state should transition to HALF_OPEN based on resetTimeoutMs. */
  private _checkTransition(): void {
    if (this._state === "OPEN" && this._openedAt !== null) {
      if (Date.now() - this._openedAt >= this.resetTimeoutMs) {
        this._state = "HALF_OPEN";
        this._halfOpenAt = Date.now();
        this._consecutiveSucc = 0;
        this._inFlightProbes = 0;
        this.cfg.onHalfOpen?.(this.snapshot);
      }
    }
  }

  /** Record a successful call and potentially transition HALF_OPEN → CLOSED. */
  private _recordSuccess(): void {
    this._lastSuccessAt = Date.now();
    this._totalSuccesses++;
    this._consecutiveFails = 0;

    if (this._state === "HALF_OPEN") {
      this._consecutiveSucc++;
      if (this._consecutiveSucc >= this.successThreshold) {
        this.reset();
      }
      return;
    }

    // CLOSED state — add success to sliding window
    if (this.windowSize > 0) {
      this._window.push(true);
      if (this._window.length > this.windowSize) this._window.shift();
    }
  }

  /** Record a failure and potentially transition CLOSED → OPEN or HALF_OPEN → OPEN. */
  private _recordFailure(): void {
    this._lastFailureAt = Date.now();
    this._totalFailures++;
    this._consecutiveSucc = 0;
    this._consecutiveFails++;

    if (this._state === "HALF_OPEN") {
      // Single failure in HALF_OPEN re-opens immediately
      this._openedAt = Date.now();
      this._state = "OPEN";
      this.cfg.onOpen?.(this.snapshot);
      return;
    }

    // CLOSED state
    if (this.windowSize > 0) {
      this._window.push(false);
      if (this._window.length > this.windowSize) this._window.shift();

      const failures = this._window.filter((v) => !v).length;
      if (failures >= this.failureThreshold) {
        this._openedAt = Date.now();
        this._state = "OPEN";
        this.cfg.onOpen?.(this.snapshot);
      }
    } else {
      // Consecutive mode
      if (this._consecutiveFails >= this.failureThreshold) {
        this._openedAt = Date.now();
        this._state = "OPEN";
        this.cfg.onOpen?.(this.snapshot);
      }
    }
  }

  /** Determine whether an error should count toward the failure threshold based on the configured filter. */
  private _isCountableFailure(err: unknown): boolean {
    if (!(err instanceof Error)) return false;

    const code = (err as { code?: string }).code;

    if (this.failureFilter.networkErrors && code === "ENETWORK") return true;
    if (this.failureFilter.timeouts && code === "ETIMEOUT") return true;

    if (this.failureFilter.serverErrors) {
      const status = (err as { status?: number }).status;
      if (status && status >= 500) return true;
    }

    if (this.failureFilter.statusCodes && this.failureFilter.statusCodes.length > 0) {
      const status = (err as { status?: number }).status;
      if (status && this.failureFilter.statusCodes.includes(status)) return true;
    }

    return false;
  }
}

// ============================================================================
// #3  CIRCUIT BREAKER REGISTRY
// ============================================================================

/**
 * Registry that manages one `CircuitBreaker` per key (typically per origin/host).
 * Automatically creates breakers on first use.
 */
export class CircuitBreakerRegistry {
  /** Map of key → CircuitBreaker instances */
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Default config applied to all new breakers */
  private readonly defaultConfig: CircuitBreakerConfig;

  /**
   * @param defaultConfig - Default configuration inherited by all breakers
   */
  constructor(defaultConfig: CircuitBreakerConfig = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Get or create a circuit breaker for `key`.
   * `key` is typically the request origin, e.g. `"https://api.example.com"`.
   */
  get(key: string, overrides?: CircuitBreakerConfig): CircuitBreaker {
    if (!this.breakers.has(key)) {
      this.breakers.set(key, new CircuitBreaker(key, { ...this.defaultConfig, ...overrides }));
    }
    return this.breakers.get(key)!;
  }

  /**
   * Wrap a function call through the breaker for `key`.
   * Creates the breaker if it doesn't exist.
   */
  execute<T>(key: string, fn: () => Promise<T>, overrides?: CircuitBreakerConfig): Promise<T> {
    return this.get(key, overrides).execute(fn);
  }

  /** Manually trip the breaker for `key` (creates it if it doesn't exist). */
  trip(key: string): void {
    this.get(key).trip();
  }

  /** Manually reset the breaker for `key` (creates it if it doesn't exist). */
  reset(key: string): void {
    this.get(key).reset();
  }

  /** Snapshot all breakers — for monitoring / health endpoints. */
  snapshots(): Record<string, CircuitBreakerState> {
    const out: Record<string, CircuitBreakerState> = {};
    for (const [k, b] of this.breakers) out[k] = b.snapshot;
    return out;
  }

  /** Remove a specific breaker. */
  delete(key: string): void {
    this.breakers.delete(key);
  }

  /** Remove all breakers. */
  clear(): void {
    this.breakers.clear();
  }

  /** How many breakers are registered. */
  get size(): number {
    return this.breakers.size;
  }
}

// ============================================================================
// #4  FACTORY HELPERS
// ============================================================================

/**
 * Create a single-key circuit breaker with a convenient default config.
 * Suitable when you manage the key externally.
 */
export function createCircuitBreaker(key: string, config?: CircuitBreakerConfig): CircuitBreaker {
  return new CircuitBreaker(key, config);
}

/**
 * Create a registry for managing multiple per-origin breakers.
 * All breakers inherit `defaultConfig`, with per-key overrides at `.get()`.
 */
export function createCircuitBreakerRegistry(
  defaultConfig?: CircuitBreakerConfig,
): CircuitBreakerRegistry {
  return new CircuitBreakerRegistry(defaultConfig);
}
