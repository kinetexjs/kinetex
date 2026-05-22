/**
 * HTTP client lifecycle hooks system.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Full request/response/error lifecycle events
 *  - Before/after/around hook patterns
 *  - Async hook support
 *  - Hook composition and chaining
 *  - Hook priority ordering
 *  - Named hooks with ejection
 *  - One-shot hooks
 *  - Scoped hook contexts
 *  - Global vs instance hooks
 *  - Hook middleware (wrap/tap/transform)
 *  - Upload/download progress hooks
 *  - Redirect hooks
 *  - Retry hooks
 *  - Cancel/abort hooks
 *  - Connection hooks
 *  - Hook error isolation (one bad hook won't kill pipeline)
 *  - Hook timing + tracing
 *  - Typed event emitter
 */

import type { BodyInit, HTTPMethod } from "./types.ts";
import { KinetexError as _KinetexError } from "./types.ts";

// ============================================================================
// §1  TYPES
// ============================================================================

/** Full request representation passed through lifecycle hooks. */
export interface HookRequest {
  /** Target URL */
  url: string;
  /** HTTP method */
  method: HTTPMethod;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body */
  body: BodyInit | null;
  /** AbortSignal for cancellation */
  signal: AbortSignal | null;
  /** Arbitrary per-request metadata */
  meta: Record<string, unknown>;
}

/** Full response representation passed through lifecycle hooks. */
export interface HookResponse {
  /** HTTP status code */
  status: number;
  /** HTTP status text */
  statusText: string;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body: string | Uint8Array | null;
  /** Originating request */
  request: HookRequest;
}

/** Error event raised when a request fails at any stage of the lifecycle. */
export interface HookError {
  /** The error that occurred */
  error: unknown;
  /** The request that caused the error */
  request: HookRequest;
  /** Partial response (may be null for network errors) */
  response: HookResponse | null;
  /** Attempt number when the error occurred */
  attempt: number;
}

/** Progress snapshot for upload/download tracking. */
export interface ProgressEvent {
  /** Bytes transferred so far */
  loaded: number;
  /** Total bytes (null if unknown) */
  total: number | null;
  /** Progress percentage 0–100 (null if total unknown) */
  percent: number | null;
  /** Transfer rate in bytes/sec (null if unavailable) */
  rate: number | null;
  /** Elapsed time in ms */
  elapsed: number;
}

/** Redirect event emitted when a response redirects to a new URL. */
export interface RedirectEvent {
  /** Original URL */
  from: string;
  /** Redirect target URL */
  to: string;
  /** HTTP status code (301, 302, 307, 308) */
  status: number;
  /** Number of redirects followed so far */
  count: number;
  /** Current request context */
  request: HookRequest;
}

/** Event emitted before each retry attempt. */
export interface RetryEvent {
  /** Current attempt number */
  attempt: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Delay before this retry in ms */
  delayMs: number;
  /** Reason for the retry */
  reason: unknown;
  /** The request being retried */
  request: HookRequest;
  /** Previous response (may be null) */
  response: HookResponse | null;
}

/** Connection lifecycle event (connect, disconnect, timeout, reuse). */
export interface ConnectionEvent {
  /** Connection event type */
  type: "connect" | "disconnect" | "timeout" | "reuse";
  /** Remote host */
  host: string;
  /** Remote port */
  port: number;
  /** Protocol (e.g. "http:" or "https:") */
  protocol: string;
  /** Time spent establishing/reusing the connection in ms */
  elapsed: number;
}

/** Event emitted when a request is cancelled. */
export interface CancelEvent {
  /** The request being cancelled */
  request: HookRequest;
  /** Reason for cancellation */
  reason: unknown;
}

/** Context object threaded through the lifecycle hook pipeline. */
export interface HookContext {
  /** The current request */
  request: HookRequest;
  /** The response received so far (null before dispatch) */
  response: HookResponse | null;
  /** Error that occurred (null until error phase) */
  error: unknown | null;
  /** Timestamp when the request started */
  startedAt: number;
  /** Current attempt number (1-based) */
  attempt: number;
  /**
   * Arbitrary per-request metadata bag.
   *
   * Built-in keys (set by lifecycle):
   * - `durationMs`: Total request duration in milliseconds
   * - `aborted`: Whether request was aborted
   * - `redirectCount`: Number of redirects followed
   *
   * Hooks can read/write custom keys for cross-hook communication.
   *
   * @example
   * ```ts
   * // In beforeRequest hook:
   * ctx.meta.requestId = crypto.randomUUID();
   *
   * // In afterResponse hook:
   * console.log(`Request ${ctx.meta.requestId} completed in ${ctx.meta.durationMs}ms`);
   * ```
   */
  meta: Record<string, unknown>;
}

// ── Hook function signatures ──────────────────────────────────────────────────

/** Called before a request is sent — may mutate or replace the request entirely */
export type BeforeRequestHook = (
  req: HookRequest,
  ctx: HookContext,
) => Promise<HookRequest | void> | HookRequest | void;
/** Called after a request is sent (no return value) */
export type AfterRequestHook = (req: HookRequest, ctx: HookContext) => Promise<void> | void;
/** Called before processing a response — may mutate it */
export type BeforeResponseHook = (
  res: HookResponse,
  ctx: HookContext,
) => Promise<HookResponse | void> | HookResponse | void;
/** Called after a response is processed (no return value) */
export type AfterResponseHook = (res: HookResponse, ctx: HookContext) => Promise<void> | void;
/** Called when an error occurs — may return a synthetic response to recover */
export type OnErrorHook = (
  err: HookError,
  ctx: HookContext,
) => Promise<HookResponse | void> | HookResponse | void;
/** Called before each retry */
export type OnRetryHook = (evt: RetryEvent, ctx: HookContext) => Promise<void> | void;
/** Called on redirect — return false to prevent following the redirect */
export type OnRedirectHook = (
  evt: RedirectEvent,
  ctx: HookContext,
) => Promise<boolean | void> | boolean | void;
/** Called with upload progress updates */
export type OnUploadProgressHook = (evt: ProgressEvent, ctx: HookContext) => void;
/** Called with download progress updates */
export type OnDownloadProgressHook = (evt: ProgressEvent, ctx: HookContext) => void;
/** Called when a request is cancelled */
export type OnCancelHook = (evt: CancelEvent, ctx: HookContext) => void;
/** Called on connection events (connect/disconnect/timeout/reuse) */
export type OnConnectionHook = (evt: ConnectionEvent) => void;
/** "Around" hook that wraps the dispatch — receives `next` to call the inner pipeline */
export type AroundHook = (
  ctx: HookContext,
  next: () => Promise<HookResponse>,
) => Promise<HookResponse>;

// ── Hook registration options ─────────────────────────────────────────────────

/** Registration options for lifecycle hooks — controls identity, ordering, execution constraints, and error isolation. */
export interface HookOptions {
  /** Unique hook ID. Auto-generated if omitted. */
  id?: string;
  /** Execution priority (lower = runs first). Default: 0 */
  priority?: number;
  /** If true, auto-eject after first execution. */
  once?: boolean;
  /** Only run if this predicate returns true for the context. */
  condition?: (ctx: HookContext) => boolean;
  /**
   * If true, errors thrown by this hook are caught and logged rather than propagated.
   *
   * Use `safe: true` for hooks that should not break the pipeline if they fail
   * (e.g., logging hooks, metrics hooks).
   *
   * Note: If ALL hooks have `safe: true`, errors will be silently swallowed.
   * Use `safe: false` (default) for critical hooks that must propagate errors.
   *
   * @default false
   */
  safe?: boolean;
}

// ── Hook entry (internal) ─────────────────────────────────────────────────────

interface HookEntry<T> {
  id: string;
  priority: number;
  once: boolean;
  condition: ((ctx: HookContext) => boolean) | null;
  safe: boolean;
  fn: T;
}

// ============================================================================
// §2  TYPED EVENT EMITTER
// ============================================================================

type HookEventMap = {
  "before:request": HookRequest;
  "after:request": HookRequest;
  "before:response": HookResponse;
  "after:response": HookResponse;
  error: HookError;
  retry: RetryEvent;
  redirect: RedirectEvent;
  "upload:progress": ProgressEvent;
  "download:progress": ProgressEvent;
  cancel: CancelEvent;
  connection: ConnectionEvent;
};

type HookEventName = keyof HookEventMap;
type HookEventListener<E extends HookEventName> = (event: HookEventMap[E]) => void | Promise<void>;

/**
 * Lightweight typed event emitter for lifecycle events.
 *
 * Simpler than HookRegistry — no priority, conditions, or safe mode.
 * Use when you just need pub/sub notification.
 */
export class HookEmitter {
  // deno-lint-ignore ban-types
  private listeners = new Map<string, Array<{ fn: Function; once: boolean }>>();

  /** Register a persistent event listener. */
  on<E extends HookEventName>(event: E, listener: HookEventListener<E>): this {
    const list = this.listeners.get(event) ?? [];
    list.push({ fn: listener, once: false });
    this.listeners.set(event, list);
    return this;
  }

  /** Register a one-shot event listener (auto-removed after first emit). */
  once<E extends HookEventName>(event: E, listener: HookEventListener<E>): this {
    const list = this.listeners.get(event) ?? [];
    list.push({ fn: listener, once: true });
    this.listeners.set(event, list);
    return this;
  }

  /** Remove a specific listener from an event. */
  off<E extends HookEventName>(event: E, listener: HookEventListener<E>): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    this.listeners.set(
      event,
      list.filter((l) => l.fn !== listener),
    );
    return this;
  }

  /** Emit an event, calling all registered listeners. Listener errors are isolated. */
  async emit<E extends HookEventName>(event: E, data: HookEventMap[E]): Promise<void> {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;

    const toRemove = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const listener = list[i]!;
      try {
        await (listener.fn as (d: HookEventMap[E]) => void | Promise<void>)(data);
      } catch {
        /* isolate listener errors */
      }
      if (listener.once) toRemove.add(i);
    }

    if (toRemove.size > 0) {
      const remaining = list.filter((_, i) => !toRemove.has(i));
      this.listeners.set(event, remaining);
    }
  }

  /** Remove all listeners for an event (or all events if omitted). */
  removeAllListeners(event?: HookEventName): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}

/**
 * HookEmitter vs HookRegistry — When to use which:
 *
 * | Feature                    | HookEmitter           | HookRegistry              |
 * |----------------------------|----------------------|---------------------------|
 * | Priority ordering         | No                   | Yes (lower = runs first)  |
 * | Conditional execution     | No                   | Yes (condition function)  |
 * | One-shot hooks            | Yes (once:)          | Yes (once: option)        |
 * | Named hooks + ejection    | No                   | Yes (id + eject)          |
 * | Safe error handling       | No                   | Yes (safe: option)        |
 * | Before/after/around phases| No (event-based)     | Yes (explicit phases)     |
 * | Complexity                | Simple               | Full-featured             |
 *
 * Use **HookEmitter** when:
 * - You need simple pub/sub (subscribe to events, get notified)
 * - You don't need priority, conditions, or named hooks
 * - You're building a lightweight event system
 *
 * Use **HookRegistry** when:
 * - You need lifecycle hooks (beforeRequest, afterResponse, etc.)
 * - You need priority ordering (lower priority runs first)
 * - You need conditional hook execution based on context
 * - You need named hooks with ability to eject by ID
 * - You need safe mode to isolate hook failures
 *
 * @example
 * ```ts
 * // Simple event subscription (HookEmitter)
 * emitter.on("error", (err) => console.error(err));
 *
 * // Full lifecycle hooks (HookRegistry)
 * registry.beforeRequest(addAuth, { priority: 10 });
 * registry.beforeRequest(logRequest, { priority: 20 }); // runs after addAuth
 * ```
 */

// ============================================================================
// §3  HOOK REGISTRY
// ============================================================================

let _hookIdSeq = 0;
function nextHookId(): string {
  return `hook_${++_hookIdSeq}`;
}
function sortHooks<T>(hooks: HookEntry<T>[]): HookEntry<T>[] {
  return [...hooks].sort((a, b) => a.priority - b.priority);
}

/**
 * Full-featured lifecycle hook registry supporting priority ordering,
 * conditional execution, named hooks with ejection, and safe error isolation.
 *
 * Phases: beforeRequest → afterRequest → around → [dispatch] →
 *         beforeResponse → afterResponse
 * Error phase: onError (can recover with synthetic response)
 * Side-event phases: onRetry, onRedirect, onUploadProgress,
 *                    onDownloadProgress, onCancel, onConnection
 */
export class HookRegistry {
  private beforeRequest: HookEntry<BeforeRequestHook>[] = [];
  private afterRequest: HookEntry<AfterRequestHook>[] = [];
  private beforeResponse: HookEntry<BeforeResponseHook>[] = [];
  private afterResponse: HookEntry<AfterResponseHook>[] = [];
  private onError: HookEntry<OnErrorHook>[] = [];
  private onRetry: HookEntry<OnRetryHook>[] = [];
  private onRedirect: HookEntry<OnRedirectHook>[] = [];
  private onUploadProgress: HookEntry<OnUploadProgressHook>[] = [];
  private onDownloadProgress: HookEntry<OnDownloadProgressHook>[] = [];
  private onCancel: HookEntry<OnCancelHook>[] = [];
  private onConnection: HookEntry<OnConnectionHook>[] = [];
  private aroundHooks: HookEntry<AroundHook>[] = [];

  /** Typed event emitter for pub/sub-style lifecycle events. */
  readonly emitter: HookEmitter = new HookEmitter();

  // ── Registration ──────────────────────────────────────────────────────────

  /** Register a before-request hook. Returns the hook ID for ejection. */
  addBeforeRequest(fn: BeforeRequestHook, opts: HookOptions = {}): string {
    return this._add(this.beforeRequest, fn, opts);
  }

  /** Register an after-request hook. Returns the hook ID for ejection. */
  addAfterRequest(fn: AfterRequestHook, opts: HookOptions = {}): string {
    return this._add(this.afterRequest, fn, opts);
  }

  /** Register a before-response hook. Returns the hook ID for ejection. */
  addBeforeResponse(fn: BeforeResponseHook, opts: HookOptions = {}): string {
    return this._add(this.beforeResponse, fn, opts);
  }

  /** Register an after-response hook. Returns the hook ID for ejection. */
  addAfterResponse(fn: AfterResponseHook, opts: HookOptions = {}): string {
    return this._add(this.afterResponse, fn, opts);
  }

  /** Register an on-error hook. Returns the hook ID for ejection. */
  addOnError(fn: OnErrorHook, opts: HookOptions = {}): string {
    return this._add(this.onError, fn, opts);
  }

  /** Register an on-retry hook. Returns the hook ID for ejection. */
  addOnRetry(fn: OnRetryHook, opts: HookOptions = {}): string {
    return this._add(this.onRetry, fn, opts);
  }

  /** Register an on-redirect hook. Returns the hook ID for ejection. */
  addOnRedirect(fn: OnRedirectHook, opts: HookOptions = {}): string {
    return this._add(this.onRedirect, fn, opts);
  }

  /** Register an upload-progress hook. Returns the hook ID for ejection. */
  addOnUploadProgress(fn: OnUploadProgressHook, opts: HookOptions = {}): string {
    return this._add(this.onUploadProgress, fn, opts);
  }

  /** Register a download-progress hook. Returns the hook ID for ejection. */
  addOnDownloadProgress(fn: OnDownloadProgressHook, opts: HookOptions = {}): string {
    return this._add(this.onDownloadProgress, fn, opts);
  }

  /** Register a cancel hook. Returns the hook ID for ejection. */
  addOnCancel(fn: OnCancelHook, opts: HookOptions = {}): string {
    return this._add(this.onCancel, fn, opts);
  }

  /** Register a connection hook. Returns the hook ID for ejection. */
  addOnConnection(fn: OnConnectionHook, opts: HookOptions = {}): string {
    return this._add(this.onConnection, fn, opts);
  }

  /** Register an around hook. Returns the hook ID for ejection. */
  addAround(fn: AroundHook, opts: HookOptions = {}): string {
    return this._add(this.aroundHooks, fn, opts);
  }

  // ── Ejection ──────────────────────────────────────────────────────────────

  /** Remove a hook by ID from all phases. Returns true if any hook was removed. */
  remove(id: string): boolean {
    let removed = false;
    const lists = [
      this.beforeRequest,
      this.afterRequest,
      this.beforeResponse,
      this.afterResponse,
      this.onError,
      this.onRetry,
      this.onRedirect,
      this.onUploadProgress,
      this.onDownloadProgress,
      this.onCancel,
      this.onConnection,
      this.aroundHooks,
    ] as HookEntry<unknown>[][];

    for (const list of lists) {
      const before = list.length;
      const after = list.filter((h) => h.id !== id);
      if (after.length < before) {
        list.length = 0;
        list.push(...after);
        removed = true;
      }
    }
    return removed;
  }

  /** Remove all hooks from all phases. */
  removeAll(): void {
    this.beforeRequest.length = 0;
    this.afterRequest.length = 0;
    this.beforeResponse.length = 0;
    this.afterResponse.length = 0;
    this.onError.length = 0;
    this.onRetry.length = 0;
    this.onRedirect.length = 0;
    this.onUploadProgress.length = 0;
    this.onDownloadProgress.length = 0;
    this.onCancel.length = 0;
    this.onConnection.length = 0;
    this.aroundHooks.length = 0;
  }

  /** Check if a hook ID is registered in any phase. */
  has(id: string): boolean {
    const lists = [
      this.beforeRequest,
      this.afterRequest,
      this.beforeResponse,
      this.afterResponse,
      this.onError,
      this.onRetry,
      this.onRedirect,
      this.onUploadProgress,
      this.onDownloadProgress,
      this.onCancel,
      this.onConnection,
      this.aroundHooks,
    ] as HookEntry<unknown>[][];
    return lists.some((l) => l.some((h) => h.id === id));
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /** Execute all before-request hooks in priority order. May mutate the request. */
  async runBeforeRequest(req: HookRequest, ctx: HookContext): Promise<HookRequest> {
    let current = req;
    for (const hook of sortHooks(this.beforeRequest)) {
      if (!this._shouldRun(hook, ctx)) continue;
      const result = await this._safeRun(hook, () => hook.fn(current, ctx));
      if (result && typeof result === "object" && "url" in result) {
        current = result as HookRequest;
      }
      this._maybeEject(hook, this.beforeRequest);
    }
    await this.emitter.emit("before:request", current);
    return current;
  }

  /** Execute all after-request hooks. */
  async runAfterRequest(req: HookRequest, ctx: HookContext): Promise<void> {
    for (const hook of sortHooks(this.afterRequest)) {
      if (!this._shouldRun(hook, ctx)) continue;
      await this._safeRun(hook, () => hook.fn(req, ctx));
      this._maybeEject(hook, this.afterRequest);
    }
    await this.emitter.emit("after:request", req);
  }

  /** Execute all before-response hooks in priority order. May mutate the response. */
  async runBeforeResponse(res: HookResponse, ctx: HookContext): Promise<HookResponse> {
    let current = res;
    for (const hook of sortHooks(this.beforeResponse)) {
      if (!this._shouldRun(hook, ctx)) continue;
      const result = await this._safeRun(hook, () => hook.fn(current, ctx));
      if (result && typeof result === "object" && "status" in result) {
        current = result as HookResponse;
      }
      this._maybeEject(hook, this.beforeResponse);
    }
    await this.emitter.emit("before:response", current);
    return current;
  }

  /** Execute all after-response hooks. */
  async runAfterResponse(res: HookResponse, ctx: HookContext): Promise<void> {
    for (const hook of sortHooks(this.afterResponse)) {
      if (!this._shouldRun(hook, ctx)) continue;
      await this._safeRun(hook, () => hook.fn(res, ctx));
      this._maybeEject(hook, this.afterResponse);
    }
    await this.emitter.emit("after:response", res);
  }

  /**
   * Execute all on-error hooks.
   * If any hook returns a HookResponse, it is treated as recovery and returned.
   */
  async runOnError(err: HookError, ctx: HookContext): Promise<HookResponse | null> {
    for (const hook of sortHooks(this.onError)) {
      if (!this._shouldRun(hook, ctx)) continue;
      const result = await this._safeRun(hook, () => hook.fn(err, ctx));
      this._maybeEject(hook, this.onError);
      if (result && typeof result === "object" && "status" in result) {
        return result as HookResponse;
      }
    }
    await this.emitter.emit("error", err);
    return null;
  }

  /** Execute all on-retry hooks. */
  async runOnRetry(evt: RetryEvent, ctx: HookContext): Promise<void> {
    for (const hook of sortHooks(this.onRetry)) {
      if (!this._shouldRun(hook, ctx)) continue;
      await this._safeRun(hook, () => hook.fn(evt, ctx));
      this._maybeEject(hook, this.onRetry);
    }
    await this.emitter.emit("retry", evt);
  }

  /**
   * Execute all on-redirect hooks.
   * Returns false if any hook returns false (redirect should not be followed).
   */
  async runOnRedirect(evt: RedirectEvent, ctx: HookContext): Promise<boolean> {
    let allow = true;
    for (const hook of sortHooks(this.onRedirect)) {
      if (!this._shouldRun(hook, ctx)) continue;
      const result = await this._safeRun(hook, () => hook.fn(evt, ctx));
      this._maybeEject(hook, this.onRedirect);
      if (result === false) {
        allow = false;
        break;
      }
    }
    await this.emitter.emit("redirect", evt);
    return allow;
  }

  /** Execute all upload-progress hooks. */
  runOnUploadProgress(evt: ProgressEvent, ctx: HookContext): void {
    for (const hook of sortHooks(this.onUploadProgress)) {
      if (!this._shouldRun(hook, ctx)) continue;
      try {
        hook.fn(evt, ctx);
      } catch {
        /* isolate */
      }
      this._maybeEject(hook, this.onUploadProgress);
    }
    this.emitter.emit("upload:progress", evt);
  }

  /** Execute all download-progress hooks. */
  runOnDownloadProgress(evt: ProgressEvent, ctx: HookContext): void {
    for (const hook of sortHooks(this.onDownloadProgress)) {
      if (!this._shouldRun(hook, ctx)) continue;
      try {
        hook.fn(evt, ctx);
      } catch {
        /* isolate */
      }
      this._maybeEject(hook, this.onDownloadProgress);
    }
    this.emitter.emit("download:progress", evt);
  }

  /** Execute all on-cancel hooks. */
  runOnCancel(evt: CancelEvent, ctx: HookContext): void {
    for (const hook of sortHooks(this.onCancel)) {
      try {
        hook.fn(evt, ctx);
      } catch {
        /* isolate */
      }
      this._maybeEject(hook, this.onCancel);
    }
    this.emitter.emit("cancel", evt);
  }

  /** Execute all on-connection hooks. */
  runOnConnection(evt: ConnectionEvent): void {
    for (const hook of sortHooks(this.onConnection)) {
      try {
        hook.fn(evt);
      } catch {
        /* isolate */
      }
      this._maybeEject(hook, this.onConnection);
    }
    this.emitter.emit("connection", evt);
  }

  /**
   * Wrap a dispatch function with all registered around hooks.
   * Around hooks form an onion: outermost (lowest priority) wraps innermost.
   */
  wrapWithAround(
    ctx: HookContext,
    dispatch: () => Promise<HookResponse>,
  ): () => Promise<HookResponse> {
    const sorted = sortHooks(this.aroundHooks).reverse(); // innermost first

    let fn = dispatch;
    for (const hook of sorted) {
      const next = fn;
      fn = () => {
        if (!this._shouldRun(hook, ctx)) return next();
        const result = hook.fn(ctx, next);
        this._maybeEject(hook, this.aroundHooks);
        return result;
      };
    }

    return fn;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _add<T>(list: HookEntry<T>[], fn: T, opts: HookOptions): string {
    const id = opts.id ?? nextHookId();
    list.push({
      id,
      priority: opts.priority ?? 0,
      once: opts.once ?? false,
      condition: opts.condition ?? null,
      safe: opts.safe ?? false,
      fn,
    });
    return id;
  }

  private _shouldRun<T>(hook: HookEntry<T>, ctx: HookContext): boolean {
    return hook.condition ? hook.condition(ctx) : true;
  }

  private async _safeRun<T, R>(
    hook: HookEntry<T>,
    fn: () => R | Promise<R>,
  ): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!hook.safe) throw err;
      // Safe mode: swallow and log
      console.error(`[lifecycle] Hook "${hook.id}" threw:`, err);
      return undefined;
    }
  }

  private _maybeEject<T>(hook: HookEntry<T>, list: HookEntry<T>[]): void {
    if (!hook.once) return;
    const idx = list.indexOf(hook);
    if (idx !== -1) list.splice(idx, 1);
  }
}

// ============================================================================
// §4  PROGRESS TRACKER
// ============================================================================

/**
 * Tracks upload/download progress by counting bytes and computing rate/percentage.
 */
export class ProgressTracker {
  private loaded = 0;
  private total: number | null;
  private startMs: number;
  private lastMs: number;
  private lastLoaded = 0;

  constructor(total: number | null = null) {
    this.total = total;
    this.startMs = perfNow();
    this.lastMs = this.startMs;
  }

  /** Record that `chunk` bytes were transferred. Returns a progress snapshot. */
  update(chunk: number): ProgressEvent {
    const now = perfNow();
    this.loaded += chunk;
    const elapsed = now - this.startMs;
    const delta = now - this.lastMs;
    const rate = delta > 0 ? ((this.loaded - this.lastLoaded) / delta) * 1000 : null;

    this.lastMs = now;
    this.lastLoaded = this.loaded;

    return {
      loaded: this.loaded,
      total: this.total,
      percent: this.total ? Math.min(100, (this.loaded / this.total) * 100) : null,
      rate,
      elapsed,
    };
  }

  /** Take a final snapshot (as if 0 bytes were transferred). */
  complete(): ProgressEvent {
    return this.update(0); // no new bytes, just snapshot
  }
}

// ============================================================================
// §5  REDIRECT TRACKER
// ============================================================================

/**
 * Tracks redirect chains and throws when the maximum is exceeded.
 */
export class RedirectTracker {
  private count = 0;

  constructor(private readonly maxRedirects = 10) {}

  /** Record a redirect. Throws TooManyRedirectsError if maxRedirects exceeded. */
  record(from: string, to: string, status: number, request: HookRequest): RedirectEvent {
    this.count++;
    if (this.count > this.maxRedirects) {
      throw new TooManyRedirectsError(this.count, from);
    }
    return { from, to, status, count: this.count, request };
  }

  /** Number of redirects followed so far. */
  get redirectCount(): number {
    return this.count;
  }
  /** Reset the redirect counter. */
  reset(): void {
    this.count = 0;
  }
}

/**
 * Thrown when the maximum number of redirects is exceeded.
 *
 * @param count - Number of redirects followed
 * @param url - The URL that exceeded the redirect limit
 */
export class TooManyRedirectsError extends Error {
  /** Error code identifying this as a redirect error. */
  readonly code = "ETOOMANYREDIRECTS";
  constructor(
    /** Number of redirects followed. */
    public readonly count: number,
    /** The URL that exceeded the redirect limit. */
    public readonly url: string,
  ) {
    super(`Too many redirects (${count}) at ${url}`);
    this.name = "TooManyRedirectsError";
  }
}

// ============================================================================
// §6  LIFECYCLE MIDDLEWARE (tap / transform / wrap)
// ============================================================================

/**
 * Create a "tap" hook — runs a side-effect on a value without modifying it.
 */
export function tap<T>(fn: (value: T) => void | Promise<void>): (value: T) => Promise<T> {
  return async (value: T) => {
    await fn(value);
    return value;
  };
}

/**
 * Create a before-request hook that injects headers.
 */
export function injectHeaders(
  headers:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>),
): BeforeRequestHook {
  return async (req) => ({
    ...req,
    headers: {
      ...req.headers,
      ...(typeof headers === "function" ? await headers() : headers),
    },
  });
}

/**
 * Create a before-request hook that sets a base URL.
 */
export function withBaseURL(base: string): BeforeRequestHook {
  return (req) => {
    if (/^https?:\/\//i.test(req.url)) return;
    const slash = base.endsWith("/") || req.url.startsWith("/") ? "" : "/";
    return { ...req, url: `${base}${slash}${req.url}` };
  };
}

/**
 * Create an error hook that converts HTTP error status codes to thrown errors.
 */
export function throwOnHTTPError(
  isError: (status: number) => boolean = (s) => s >= 400,
): OnErrorHook {
  return (err) => {
    if (err.response && isError(err.response.status)) {
      throw new HTTPError(err.response.status, err.response.statusText, err.response);
    }
  };
}

/**
 * Create a before-response hook that validates the response.
 */
export function validateResponse(
  validator: (res: HookResponse) => boolean | string,
): BeforeResponseHook {
  return (res) => {
    const result = validator(res);
    if (result === true) return;
    const message =
      typeof result === "string" ? result : `Response validation failed (status ${res.status})`;
    throw new ResponseValidationError(message, res);
  };
}

/**
 * Thrown by `throwOnHTTPError` when a response status indicates an error.
 *
 * @param status - HTTP status code (e.g., 404, 500)
 * @param statusText - HTTP status text (e.g., "Not Found")
 * @param response - The response that triggered the error
 */
export class HTTPError extends Error {
  /** Error code identifying this as an HTTP error. */
  readonly code = "EHTTPERROR";
  constructor(
    /** HTTP status code (e.g., 404, 500). */
    public readonly status: number,
    /** HTTP status text (e.g., "Not Found"). */
    public readonly statusText: string,
    /** The response that triggered the error. */
    public readonly response: HookResponse,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HTTPError";
  }
}

/**
 * Thrown by `validateResponse` when a response fails validation.
 *
 * @param message - Human-readable validation error message
 * @param response - The response that failed validation
 */
export class ResponseValidationError extends Error {
  /** Error code identifying this as a validation error. */
  readonly code = "EVALIDATION";
  constructor(
    message: string,
    /** The response that failed validation. */
    public readonly response: HookResponse,
  ) {
    super(message);
    this.name = "ResponseValidationError";
  }
}

// ============================================================================
// §7  HOOK COMPOSITION
// ============================================================================

/**
 * Compose multiple before-request hooks into one.
 */
export function composeBeforeRequest(...hooks: BeforeRequestHook[]): BeforeRequestHook {
  return async (req, ctx) => {
    let current = req;
    for (const hook of hooks) {
      const result = await hook(current, ctx);
      if (result && typeof result === "object" && "url" in result) {
        current = result as HookRequest;
      }
    }
    return current;
  };
}

/**
 * Compose multiple before-response hooks into one.
 */
export function composeBeforeResponse(...hooks: BeforeResponseHook[]): BeforeResponseHook {
  return async (res, ctx) => {
    let current = res;
    for (const hook of hooks) {
      const result = await hook(current, ctx);
      if (result && typeof result === "object" && "status" in result) {
        current = result as HookResponse;
      }
    }
    return current;
  };
}

/**
 * Compose multiple around hooks into one using the "onion" model.
 *
 * Each hook wraps the next, forming a chain where:
 * - The highest priority hook wraps closest to `next` (innermost)
 * - The lowest priority hook wraps closest to the caller (outermost)
 *
 * Execution order (example with 3 hooks):
 * ```text
 * hook0 (outermost)
 *   → hook1
 *     → hook2 (innermost)
 *       → next()
 *       ← hook2 returns
 *     ← hook1 returns
 *   ← hook0 returns
 * ```
 *
 * @param hooks AroundHooks to compose (applied in priority order)
 * @returns Single composed AroundHook
 *
 * @example
 * ```ts
 * const timing = (ctx, next) => {
 *   const start = Date.now();
 *   return next().finally(() => {
 *     console.log(`Duration: ${Date.now() - start}ms`);
 *   });
 * };
 *
 * const auth = (ctx, next) => {
 *   ctx.request.headers.Authorization = `Bearer ${getToken()}`;
 *   return next();
 * };
 *
 * const composed = composeAround(timing, auth);
 * ```
 */
export function composeAround(...hooks: AroundHook[]): AroundHook {
  return (ctx, next) => {
    const composed = hooks.reduceRight(
      (n: () => Promise<HookResponse>, hook) => () => hook(ctx, n),
      next,
    );
    return composed();
  };
}

// ============================================================================
// §8  BUILT-IN HOOKS
// ============================================================================

/**
 * Hook: log every request and response to console (structured).
 *
 * @param options.logger - Custom logger function (defaults to console.log)
 * @param options.logBody - Whether to include request/response bodies in logs
 * @param options.redactHeaders - Header names to redact in log output
 * @returns An object containing:
 *   - `beforeRequest`: Logs outgoing request details (method, URL, headers).
 *   - `afterResponse`: Logs incoming response details (status, URL, headers).
 *   - `onError`: Logs error details (URL, error message, status code).
 */
export function createLoggingHooks(
  options: {
    logger?: (msg: string, data: unknown) => void;
    logBody?: boolean;
    redactHeaders?: string[];
  } = {},
): {
  /** Logs outgoing request details (method, URL, headers). */
  beforeRequest: BeforeRequestHook;
  /** Logs incoming response details (status, URL, headers). */
  afterResponse: AfterResponseHook;
  /** Logs error details (URL, error message, status code). */
  onError: OnErrorHook;
} {
  const log = options.logger ?? ((msg, data) => console.log(msg, JSON.stringify(data)));
  const redact = new Set(
    (options.redactHeaders ?? ["authorization", "cookie"]).map((h) => h.toLowerCase()),
  );

  function safeHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k] = redact.has(k.toLowerCase()) ? "***" : v;
    return out;
  }

  return {
    beforeRequest: (req) => {
      log("→ request", {
        method: req.method,
        url: req.url,
        headers: safeHeaders(req.headers),
      });
    },
    afterResponse: (res) => {
      log("← response", {
        status: res.status,
        url: res.request.url,
        headers: safeHeaders(res.headers),
      });
    },
    onError: (err) => {
      log("✗ error", {
        url: err.request.url,
        error: err.error instanceof Error ? err.error.message : String(err.error),
        status: err.response?.status ?? null,
      });
    },
  };
}

/**
 * Hook: measure request timing and attach to response meta.
 *
 * @returns An object containing:
 *   - `beforeRequest`: Records the start timestamp in the context metadata.
 *   - `afterResponse`: Computes elapsed time and sets `durationMs` in context metadata.
 */
export function createTimingHook(): {
  /** Records the start timestamp in the context metadata. */
  beforeRequest: BeforeRequestHook;
  /** Computes elapsed time and sets durationMs in context metadata. */
  afterResponse: AfterResponseHook;
} {
  const TIMING_KEY = "__kinetex_timing__";

  return {
    beforeRequest: (_req, ctx) => {
      ctx.meta[TIMING_KEY] = perfNow();
    },
    afterResponse: (_res, ctx) => {
      const start = ctx.meta[TIMING_KEY] as number | undefined;
      const elapsed = start !== undefined ? perfNow() - start : null;
      if (elapsed !== null) {
        ctx.meta.durationMs = elapsed;
      }
    },
  };
}

/**
 * Hook: normalize response body encoding.
 */
export function createBodyNormalizationHook(encoding: string = "utf-8"): BeforeResponseHook {
  return (res) => {
    if (res.body instanceof Uint8Array) {
      return {
        ...res,
        body: new TextDecoder(encoding).decode(res.body),
      };
    }
    return undefined;
  };
}

/**
 * Hook: abort request if signal fires before it completes.
 *
 * The abort error uses DOMException when available (browsers, Deno, Bun,
 * Node.js 18+). Falls back to a plain Error in older runtimes. The AbortError
 * name is set on the fallback error for compatibility.
 *
 * @returns An object containing:
 *   - `beforeRequest`: Checks the request signal — throws AbortError if already aborted.
 *   - `onCancel`: Logs cancellation with the request URL and reason.
 */
export function createAbortHook(this: void): {
  /** Checks the request signal — throws AbortError if already aborted. */
  beforeRequest: BeforeRequestHook;
  /** Logs cancellation with the request URL and reason. */
  onCancel: OnCancelHook;
} {
  return {
    beforeRequest: (req, ctx) => {
      if (req.signal?.aborted) {
        ctx.meta.aborted = true;
        throw createAbortError("Request aborted before sending");
      }
    },
    onCancel: (evt) => {
      console.debug(`[lifecycle] Request cancelled: ${evt.request.url}`, evt.reason);
    },
  };
}

// ============================================================================
// §9  UTILITIES
// ============================================================================

// Cross-runtime: safe AbortError creation (DOMException may not exist in all runtimes)
function createAbortError(message: string): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Create a new HookContext for the given request.
 *
 * @param request  - The initial request
 * @param overrides - Optional fields to override in the context
 */
export function createHookContext(
  request: HookRequest,
  overrides: Partial<HookContext> = {},
): HookContext {
  return {
    request,
    response: null,
    error: null,
    startedAt: perfNow(),
    attempt: 1,
    meta: {},
    ...overrides,
  };
}
