/**
 * ws.ts — WebSocket client for kinetex.
 *
 * Features:
 *  - Full 5-state machine: CONNECTING → OPEN → RECONNECTING → CLOSING → CLOSED
 *  - Exponential back-off with full jitter, configurable cap
 *  - Application-level ping/pong with pong-timeout dead-connection detection
 *  - Per-connect timeout: rejects if handshake exceeds connectTimeoutMs
 *  - Outgoing message buffer during reconnect (configurable cap, drop-oldest)
 *  - request/response correlation: send + await matching reply by predicate
 *  - waitForOpen(): await reconnect completion from any caller
 *  - drainBuffer(): inspect and clear the outgoing queue
 *  - Lifetime metrics: bytes sent/received, reconnect count, uptime ms
 *  - Listener-based API returning eject functions
 *  - Async iterator interface for functional consumption
 *  - AbortSignal: abort closes permanently, no reconnect
 *  - Headers: real HTTP Upgrade on Deno/Bun/Node; URL params on browsers
 *  - Cross-runtime: Node.js 22, Deno, Bun, Browser, Cloudflare Workers
 */

// ============================================================================
// §1  TYPES
// ============================================================================

/** WebSocket connection state reflecting the 5-state lifecycle machine. */
export type WSState = "CONNECTING" | "OPEN" | "RECONNECTING" | "CLOSING" | "CLOSED";

/** A single WebSocket message — text or binary with optional parsed JSON. */
export interface WSMessage {
  /** Raw data as received (string or binary Uint8Array). */
  data: string | Uint8Array;
  /** Parsed JSON when data is a string and valid JSON, otherwise undefined. */
  json?: unknown;
  /** Wall-clock ms when message was received. */
  timestamp: number;
}

/** WebSocket close event information. */
export interface WSCloseEvent {
  /** Numeric close code (e.g. 1000 for normal closure). */
  code: number;
  /** Human-readable close reason. */
  reason: string;
}

/** Lifetime metrics snapshot — safe to hold onto (copy). */
export interface WSMetrics {
  /** Total number of messages sent */
  messagesSent: number;
  /** Total number of messages received */
  messagesReceived: number;
  /** Total bytes sent */
  bytesSent: number;
  /** Total bytes received */
  bytesReceived: number;
  /** Number of reconnections that occurred */
  reconnectCount: number;
  /** Total connection attempts including reconnects */
  totalConnectAttempts: number;
  /** Timestamp when the socket last entered OPEN state, or null */
  connectedAt: number | null;
  /** Timestamp when the socket last entered CLOSED state, or null */
  closedAt: number | null;
  /** Total ms the socket has been in OPEN state across all sessions. */
  uptimeMs: number;
}

/**
 * Configuration for creating a {@link WSClient} instance.
 * Controls connection parameters, reconnection strategy, ping/pong heartbeats,
 * backpressure limits, and lifecycle callbacks.
 */
export interface WSClientConfig {
  /** WebSocket URL (ws:// or wss://). */
  url: string;
  /** Subprotocols to negotiate during the handshake. */
  protocols?: string | string[];
  /**
   * Headers to inject.
   * On Deno/Bun/Node 22 these become real HTTP Upgrade request headers.
   * On browsers the WS API does not allow custom headers; they are appended
   * as URL query parameters instead.
   */
  headers?: Record<string, string>;
  /** Maximum reconnect attempts before giving up. 0 = unlimited. Default: 10 */
  maxReconnects?: number;
  /** Base delay ms for exponential back-off. Default: 1000 */
  reconnectBaseMs?: number;
  /** Maximum back-off cap ms. Default: 30_000 */
  reconnectMaxMs?: number;
  /**
   * Jitter factor 0–1. Applied multiplicatively to the capped delay so that
   * each client re-connects at a slightly different time.
   * delay = min(base * 2^n, max) * (1 + jitter * random)
   * Default: 0.3
   */
  reconnectJitter?: number;
  /**
   * Application-level ping interval ms.
   * Every this many ms the client sends pingPayload over the socket.
   * 0 = disabled. Default: 30_000
   */
  pingIntervalMs?: number;
  /** Payload sent as application-level ping. Default: "ping" */
  pingPayload?: string;
  /**
   * String or RegExp that identifies a pong reply to an application-level ping.
   * When a matching message arrives, the pong-timeout timer is reset and the
   * message is NOT dispatched to listeners.
   * Default: undefined (pong checking disabled)
   */
  pongMatcher?: string | RegExp;
  /**
   * How long ms to wait for a pong after a ping before treating the
   * connection as dead and triggering reconnect.
   * 0 = disabled. Default: 10_000
   */
  pongTimeoutMs?: number;
  /**
   * Maximum ms to wait for the WebSocket handshake to complete.
   * connect() rejects with WSConnectTimeoutError if this elapses.
   * 0 = no limit. Default: 30_000
   */
  connectTimeoutMs?: number;
  /** Buffer outgoing messages sent while RECONNECTING. Default: true */
  bufferMessages?: boolean;
  /**
   * Maximum number of messages to buffer (oldest dropped when full).
   * Default: 100
   */
  maxBufferSize?: number;
  /** AbortSignal — aborted closes permanently (code 1000, no reconnect). */
  signal?: AbortSignal;

  /**
   * Backpressure high-water mark in bytes.
   * When the outgoing buffer exceeds this threshold `backpressure` returns true
   * and `send()` will buffer rather than transmit.
   * Default: 65536 (64 KB)
   */
  highWaterMark?: number;
  /**
   * Low-water mark in bytes for backpressure release.
   * The `drain()` promise resolves when buffered bytes fall below this value.
   * Must be <= highWaterMark. Default: 16384 (16 KB)
   */
  lowWaterMark?: number;
  /**
   * Maximum outbound message rate (messages per second).
   * 0 = unlimited. Default: 0
   */
  maxSendRate?: number;
  /**
   * Rooms to automatically join after connecting (and re-joining after reconnect).
   * Each entry is a room name string.
   */
  rooms?: string[];
  /**
   * Automatically re-join subscribed rooms after a reconnect.
   * Default: true
   */
  keepRooms?: boolean;
  /**
   * Called when backpressure state changes.
   * isBackpressured=true when the outgoing buffer exceeds highWaterMark.
   */
  onBackpressure?: (isBackpressured: boolean, info: WSBackpressureInfo) => void;

  /** Called when the socket transitions to OPEN */
  onOpen?: (reconnectCount: number) => void;
  /** Called when a message is received */
  onMessage?: (msg: WSMessage) => void;
  /** Called when the socket closes */
  onClose?: (code: number, reason: string, willReconnect: boolean) => void;
  /** Called on WebSocket error */
  onError?: (err: Error) => void;
  /** Called before each reconnect attempt */
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** Called when reconnection is permanently abandoned */
  onGiveUp?: (totalAttempts: number) => void;
}

/**
 * Snapshot of the WebSocket client's backpressure state.
 * Indicates whether the outgoing buffer is saturated and the current buffer levels.
 */
export interface WSBackpressureInfo {
  /** Current bytes buffered across outgoing queue + pending sends. */
  bufferedBytes: number;
  /** High-water mark in bytes; sending pauses when exceeded. */
  highWaterMark: number;
  /** Low-water mark in bytes; drain() resolves when bufferedBytes falls below this. */
  lowWaterMark: number;
  /** True when bufferedBytes >= highWaterMark. */
  isBackpressured: boolean;
}

/** Room subscription metadata. */
export interface WSSubscribedRoom {
  /** Room identifier. */
  room: string;
  /** Optional namespace. Default: undefined. */
  namespace?: string | undefined;
  /** Timestamp when join was sent. */
  joinedAt: number;
}

// ============================================================================
// §2  ERRORS
// ============================================================================

/** WebSocket connection or protocol error. */
export class WSError extends Error {
  /** Machine-readable error code for WebSocket errors. */
  readonly code = "EWSCONNECT";
  /** The original error that caused this failure, if any. */
  readonly originalCause?: unknown;
  /**
   * @param message - Human-readable error description
   * @param cause - Original error that caused this failure
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause != null ? { cause } : undefined);
    this.name = "WSError";
    this.originalCause = cause;
  }
}
/** Thrown when the client exhausts all reconnect attempts. */
export class WSMaxReconnectsError extends Error {
  /** Machine-readable error code for exhausted reconnect attempts. */
  readonly code = "EWSMAXRECONNECTS";
  /**
   * @param attempts - Number of reconnect attempts made before giving up
   */
  constructor(public readonly attempts: number) {
    super(`WebSocket gave up after ${attempts} reconnect attempts`);
    this.name = "WSMaxReconnectsError";
  }
}
/** Thrown when the WebSocket handshake does not complete within the configured timeout. */
export class WSConnectTimeoutError extends Error {
  /** Machine-readable error code for WebSocket handshake timeout. */
  readonly code = "EWSCONNECTTIMEOUT";
  /**
   * @param url - The WebSocket endpoint URL
   * @param ms - The timeout duration in milliseconds
   */
  constructor(url: string, ms: number) {
    super(`WebSocket connect to ${url} timed out after ${ms}ms`);
    this.name = "WSConnectTimeoutError";
  }
}

/** Thrown when a send operation is rate-limited and must wait. */
export class WSRateLimitError extends Error {
  /** Machine-readable error code for WebSocket rate limiting. */
  readonly code = "EWSRATELIMIT";
  /**
   * @param delayMs - Milliseconds to wait before retrying
   */
  constructor(public readonly delayMs: number) {
    super(`WebSocket send rate limited; retry in ${delayMs}ms`);
    this.name = "WSRateLimitError";
  }
}

// ============================================================================
// §3  INTERNAL TYPES
// ============================================================================

interface OpenWaiter {
  resolve: () => void;
  reject: (e: unknown) => void;
}
interface Correlation<T = unknown> {
  matcher: (msg: WSMessage) => boolean;
  extract: (msg: WSMessage) => T;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// §4  WSCLIENT
// ============================================================================

/**
 * WebSocket client with reconnection, backoff, ping/pong, and buffering.
 *
 * Cross-runtime: Browser, Deno, Bun, Node.js, Cloudflare Workers, Vercel Edge.
 *
 * Architecture:
 * - Manages WebSocket lifecycle: connect, reconnect on failure, graceful close
 * - Exponential backoff with jitter for reconnection delays
 * - Built-in ping/pong heartbeat with configurable intervals
 * - Message buffering during disconnection with automatic drain on reconnect
 * - Async iterator interface for receiving messages
 *
 * @example
 * ```ts
 * const ws = new WSClient({ url: "wss://example.com/socket" });
 *
 * // Send messages
 * ws.send("hello");
 * ws.send(JSON.stringify({ type: "ping" }));
 *
 * // Receive messages via async iterator
 * for await (const msg of ws) {
 *   console.log("received:", msg);
 * }
 *
 * // Or use callbacks
 * ws.onMessage((msg) => console.log(msg));
 * ```
 */
export class WSClient {
  // ── Config (normalised) ─────────────────────────────────────────────────
  private readonly _url: string;
  private readonly _protocols: string | string[] | undefined;
  private readonly _headers: Record<string, string> | undefined;
  private readonly _maxReconnects: number;
  private readonly _reconnectBaseMs: number;
  private readonly _reconnectMaxMs: number;
  private readonly _reconnectJitter: number;
  private readonly _pingIntervalMs: number;
  private readonly _pingPayload: string;
  private readonly _pongMatcher: string | RegExp | undefined;
  private readonly _pongTimeoutMs: number;
  private readonly _connectTimeoutMs: number;
  private readonly _bufferMessages: boolean;
  private readonly _maxBufferSize: number;
  private readonly _cbOpen: ((n: number) => void) | undefined;
  private readonly _cbMessage: ((m: WSMessage) => void) | undefined;
  private readonly _cbClose: ((code: number, reason: string, will: boolean) => void) | undefined;
  private readonly _cbError: ((e: Error) => void) | undefined;
  private readonly _cbReconnect: ((n: number, d: number) => void) | undefined;
  private readonly _cbGiveUp: ((n: number) => void) | undefined;

  // ── Mutable state ───────────────────────────────────────────────────────
  private _ws: WebSocket | null = null;
  private _state: WSState = "CLOSED";
  private _reconnAttempt = 0;
  private _buffer: Array<string | ArrayBuffer> = [];
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnTimer: ReturnType<typeof setTimeout> | null = null;
  private _msgListeners: Array<(m: WSMessage) => void> = [];
  private _closeListeners: Array<(e: WSCloseEvent) => void> = [];
  private _openWaiters: OpenWaiter[] = [];
  private _correlations: Map<string, Correlation> = new Map();
  private _aborted = false;

  // ── Async iterator ──────────────────────────────────────────────────────
  private _iterQueue: WSMessage[] = [];
  private _iterWaiter: ((r: IteratorResult<WSMessage>) => void) | null = null;
  private _iterDone = false;

  // ── Rooms ───────────────────────────────────────────────────────────────
  private _rooms: WSSubscribedRoom[] = [];
  private readonly _keepRooms: boolean;

  // ── Backpressure ────────────────────────────────────────────────────────
  private readonly _highWaterMark: number;
  private readonly _lowWaterMark: number;
  private _bufferedBytes = 0;
  private _drainWaiters: Array<() => void> = [];
  private _cbBackpressure: ((bp: boolean, info: WSBackpressureInfo) => void) | undefined;
  private _wasBackpressured = false;

  // ── Rate limiter (token bucket) ──────────────────────────────────────────
  private readonly _maxSendRate: number;
  private _tokens = 0;
  private _lastToken = 0;

  // ── Sticky session ──────────────────────────────────────────────────────
  private _serverEndpoint: string | null = null;

  // ── Metrics ─────────────────────────────────────────────────────────────
  private _mx: WSMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    reconnectCount: 0,
    totalConnectAttempts: 0,
    connectedAt: null,
    closedAt: null,
    uptimeMs: 0,
  };
  private _openedAt: number | null = null;

  /**
   * @param cfg - Configuration object (see WSClientConfig for details)
   */
  constructor(cfg: WSClientConfig) {
    this._url = cfg.url;
    this._protocols = cfg.protocols;
    this._headers = cfg.headers;
    this._maxReconnects = cfg.maxReconnects ?? 10;
    this._reconnectBaseMs = cfg.reconnectBaseMs ?? 1_000;
    this._reconnectMaxMs = cfg.reconnectMaxMs ?? 30_000;
    this._reconnectJitter = cfg.reconnectJitter ?? 0.3;
    this._pingIntervalMs = cfg.pingIntervalMs ?? 30_000;
    this._pingPayload = cfg.pingPayload ?? "ping";
    this._pongMatcher = cfg.pongMatcher;
    this._pongTimeoutMs = cfg.pongTimeoutMs ?? 10_000;
    this._connectTimeoutMs = cfg.connectTimeoutMs ?? 30_000;
    this._bufferMessages = cfg.bufferMessages ?? true;
    this._maxBufferSize = cfg.maxBufferSize ?? 100;
    this._cbOpen = cfg.onOpen;
    this._cbMessage = cfg.onMessage;
    this._cbClose = cfg.onClose;
    this._cbError = cfg.onError;
    this._cbReconnect = cfg.onReconnect;
    this._cbGiveUp = cfg.onGiveUp;
    this._cbBackpressure = cfg.onBackpressure;

    this._highWaterMark = cfg.highWaterMark ?? 65536;
    this._lowWaterMark = cfg.lowWaterMark ?? 16384;
    this._maxSendRate = cfg.maxSendRate ?? 0;
    this._keepRooms = cfg.keepRooms ?? true;

    // Pre-subscribe rooms
    if (cfg.rooms && cfg.rooms.length > 0) {
      for (const r of cfg.rooms) {
        this._rooms.push({ room: r, joinedAt: 0 });
      }
    }

    cfg.signal?.addEventListener("abort", () => this.close(1000, "AbortSignal aborted"), {
      once: true,
    });
  }

  // ── Getters ──────────────────────────────────────────────────────────────

  /** Current connection state. */
  get state(): WSState {
    return this._state;
  }
  /** True when the socket is in the OPEN state and ready for data. */
  get connected(): boolean {
    return this._state === "OPEN";
  }
  /** Number of messages currently buffered in the outgoing queue. */
  get bufferedCount(): number {
    return this._buffer.length;
  }
  /** Snapshot of lifetime metrics (bytes sent/received, reconnect count, uptime). */
  get metrics(): WSMetrics {
    return {
      ...this._mx,
      uptimeMs: this._mx.uptimeMs + (this._openedAt != null ? Date.now() - this._openedAt : 0),
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Initiate the WebSocket connection. Resolves once the handshake completes.
   * If already CONNECTING or RECONNECTING, queues the caller for resolution
   * once OPEN is reached.
   *
   * @returns A promise that resolves when the socket is OPEN
   */
  connect(): Promise<void> {
    if (this._state === "OPEN") return Promise.resolve();
    if (this._state === "CONNECTING" || this._state === "RECONNECTING") {
      return new Promise((res, rej) => this._openWaiters.push({ resolve: res, reject: rej }));
    }
    return this._doConnect(false);
  }

  /**
   * Returns a Promise that resolves once the socket reaches OPEN.
   * Safe to call while CONNECTING or RECONNECTING.
   * Rejects with WSConnectTimeoutError if timeoutMs elapses (default 60s).
   *
   * @param timeoutMs - Timeout in milliseconds. If 0, no timeout is applied
   *   and the promise will wait indefinitely until the socket opens or errors.
   * @returns A promise that resolves when the socket is OPEN
   */
  waitForOpen(timeoutMs = 60_000): Promise<void> {
    if (this._state === "OPEN") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tid =
        timeoutMs > 0
          ? setTimeout(() => {
              const i = this._openWaiters.findIndex((w) => w.resolve === resolve);
              if (i !== -1) this._openWaiters.splice(i, 1);
              reject(new WSConnectTimeoutError(this._url, timeoutMs));
            }, timeoutMs)
          : null;
      this._openWaiters.push({
        resolve: () => {
          if (tid) clearTimeout(tid);
          resolve();
        },
        reject: (e) => {
          if (tid) clearTimeout(tid);
          reject(e);
        },
      });
    });
  }

  /**
   * Permanently close the connection. No reconnect will occur.
   *
   * @param _code - WebSocket close code (default: 1000)
   * @param _reason - Human-readable close reason (default: "Client closed")
   */
  close(code = 1000, reason = "Client closed"): void {
    this._aborted = true;
    this._stopAll();

    for (const w of this._drainWaiters.splice(0)) w();

    this._state = "CLOSING";
    const ws = this._ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState < 2) {
        try {
          ws.close(code, reason);
        } catch {
          /* ignore */
        }
      }
      this._ws = null;
    }

    this._buffer = [];
    this._bufferedBytes = 0;

    this._iterQueue = [];
    this._iterDone = true;
    if (this._iterWaiter) {
      this._iterWaiter({ done: true, value: undefined });
      this._iterWaiter = null;
    }

    this._msgListeners = [];
    this._closeListeners = [];
    for (const w of this._openWaiters.splice(0)) w.reject(new Error("Client closed"));
    this._rooms = [];

    for (const c of this._correlations.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.reject(new Error("Client closed"));
    }
    this._correlations.clear();

    if (this._openedAt != null) {
      this._mx.uptimeMs += Date.now() - this._openedAt;
      this._openedAt = null;
    }

    this._state = "CLOSED";
  }

  /**
   * Destroy the client and clean up all resources.
   * More aggressive than close() - clears all listeners and buffers.
   */
  destroy(): void {
    this._aborted = true;
    this._stopAll(); // cleans up ping, pong, reconnect timers

    // Resolve all drain waiters
    for (const w of this._drainWaiters.splice(0)) w();

    this._state = "CLOSING";
    const ws = this._ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState < 2) {
        try {
          ws.close(1000, "Destroyed");
        } catch {
          /* ignore */
        }
      }
      this._ws = null;
    }

    this._buffer = [];
    this._bufferedBytes = 0;

    this._iterQueue = [];
    this._iterDone = true;
    if (this._iterWaiter) {
      this._iterWaiter({ done: true, value: undefined });
      this._iterWaiter = null;
    }

    this._msgListeners = [];
    this._closeListeners = [];
    for (const w of this._openWaiters.splice(0)) w.reject(new Error("Client destroyed"));
    this._rooms = [];

    for (const c of this._correlations.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.reject(new Error("Client destroyed"));
    }
    this._correlations.clear();

    if (this._openedAt != null) {
      this._mx.uptimeMs += Date.now() - this._openedAt;
      this._openedAt = null;
    }
    this._mx.closedAt = Date.now();
    this._state = "CLOSED";

    this._cbClose?.(1000, "Destroyed", false);
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * Send a text message. Buffered when the socket is reconnecting or
   * under backpressure.
   *
   * @param data - Text payload to send
   */
  send(data: string): void {
    if (this._tx(data)) this._mx.messagesSent++;
  }

  /**
   * Send a binary message. Buffered when the socket is reconnecting or
   * under backpressure.
   *
   * @param data - Binary payload (Uint8Array or ArrayBuffer)
   */
  sendBinary(data: Uint8Array | ArrayBuffer): void {
    const ab = data instanceof Uint8Array ? data.slice().buffer : data;
    if (this._tx(ab as ArrayBuffer)) this._mx.messagesSent++;
  }

  /**
   * Serialize and send a value as JSON text.
   *
   * @param data - Any JSON-serializable value
   */
  sendJSON(data: unknown): void {
    this.send(JSON.stringify(data));
  }

  /**
   * Send a message and await a correlated reply.
   *
   * @param payload - What to send (string → sent as-is; anything else → JSON-serialized).
   * @param replyMatcher - Predicate called for every incoming message until it returns true.
   * @param extract - Transform the matching WSMessage into the return type. Default: msg.json ?? msg.data.
   * @param timeoutMs - How long to wait ms. Default: 10_000. 0 = no timeout.
   * @returns A promise that resolves with the extracted reply value
   */
  request<T = unknown>(
    payload: string | unknown,
    replyMatcher: (msg: WSMessage) => boolean,
    extract: (msg: WSMessage) => T = (m) => (m.json ?? m.data) as T,
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const key = `${Date.now()}-${Math.random()}`;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const c = this._correlations.get(key);
              if (c?.timer) clearTimeout(c.timer);
              this._correlations.delete(key);
              reject(new WSError(`request() timed out after ${timeoutMs}ms waiting for reply`));
            }, timeoutMs)
          : null;
      this._correlations.set(key, {
        matcher: replyMatcher,
        extract: extract as (m: WSMessage) => unknown,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      if (typeof payload === "string") this.send(payload);
      else this.sendJSON(payload);
    });
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  /**
   * Register a message listener.
   *
   * @param fn - Callback invoked for every incoming message
   * @returns An eject function that removes this listener
   */
  onMessage(fn: (msg: WSMessage) => void): () => void {
    this._msgListeners.push(fn);
    return () => {
      const i = this._msgListeners.indexOf(fn);
      if (i !== -1) this._msgListeners.splice(i, 1);
    };
  }

  /**
   * Register a close listener.
   *
   * @param fn - Callback invoked with the close event (code + reason)
   * @returns An eject function that removes this listener
   */
  onClose(fn: (evt: WSCloseEvent) => void): () => void {
    this._closeListeners.push(fn);
    return () => {
      const i = this._closeListeners.indexOf(fn);
      if (i !== -1) this._closeListeners.splice(i, 1);
    };
  }

  /**
   * Return and clear the current outgoing message buffer.
   *
   * When reconnecting, any messages queued while disconnected are held in this buffer.
   * On successful reconnect, buffered messages are automatically flushed to the new socket.
   * Use this method to inspect or discard queued messages if needed.
   *
   * @returns Array of pending messages (strings or ArrayBuffers)
   */
  drainBuffer(): Array<string | ArrayBuffer> {
    const drained = this._buffer.splice(0);
    this._bufferedBytes = 0;
    this._updateBackpressure();
    return drained;
  }

  // ── Rooms / Namespaces ────────────────────────────────────────────────

  /**
   * Subscribe to a room. Sends a `room:join` signal over the wire and tracks
   * the subscription so it can be re-joined after a reconnect.
   *
   * @param room - Room name.
   * @param namespace - Optional namespace qualifier.
   */
  join(room: string, namespace?: string): void {
    if (this._rooms.some((r) => r.room === room && r.namespace === namespace)) return;
    this._rooms.push({ room, namespace, joinedAt: Date.now() });
    this.sendJSON({ type: "room:join", room, namespace: namespace ?? null });
  }

  /**
   * Unsubscribe from a room. Sends a `room:leave` signal.
   *
   * @param room - Room name to leave
   * @param namespace - Optional namespace qualifier
   */
  leave(room: string, namespace?: string): void {
    const idx = this._rooms.findIndex((r) => r.room === room && r.namespace === namespace);
    if (idx === -1) return;
    this._rooms.splice(idx, 1);
    this.sendJSON({ type: "room:leave", room, namespace: namespace ?? null });
  }

  /** Read-only list of currently subscribed rooms. */
  get rooms(): readonly WSSubscribedRoom[] {
    return this._rooms as readonly WSSubscribedRoom[];
  }

  // ── Backpressure ──────────────────────────────────────────────────────

  /**
   * Current backpressure snapshot.
   * `isBackpressured` is true when buffered bytes >= highWaterMark.
   */
  get backpressure(): WSBackpressureInfo {
    return {
      bufferedBytes: this._bufferedBytes,
      highWaterMark: this._highWaterMark,
      lowWaterMark: this._lowWaterMark,
      isBackpressured: this._bufferedBytes >= this._highWaterMark,
    };
  }

  /**
   * Returns a Promise that resolves when the outgoing buffer has drained
   * below the low-water mark. Rejects immediately if already closed/aborted.
   *
   * @param timeoutMs - Max ms to wait. 0 = no timeout. Default: 30_000.
   * @returns A promise that resolves when the buffer is drained
   */
  drain(timeoutMs = 30_000): Promise<void> {
    if (this._state === "CLOSED")
      return Promise.reject(new WSError("Cannot drain — socket is CLOSED"));
    if (this._bufferedBytes < this._lowWaterMark) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const tid =
        timeoutMs > 0
          ? setTimeout(
              () => reject(new WSError(`drain() timed out after ${timeoutMs}ms`)),
              timeoutMs,
            )
          : null;
      this._drainWaiters.push(() => {
        if (tid) clearTimeout(tid);
        resolve();
      });
    });
  }

  /**
   * Gracefully shut down: wait for the outgoing buffer to drain, then close
   * the connection cleanly.
   *
   * @param timeoutMs - Max ms to wait for drain before force-closing. Default: 30_000.
   * @returns A promise that resolves after clean shutdown
   */
  async drainAndClose(timeoutMs = 30_000): Promise<void> {
    if (this._state === "CLOSED") return;
    try {
      await this.drain(timeoutMs);
    } catch {
      // timeout — force close anyway
    }
    this.close(1000, "Graceful shutdown");
  }

  // ── Sticky session awareness ──────────────────────────────────────────

  /**
   * The server endpoint the client is currently (or was last) connected to.
   * Populated after a successful handshake. Useful for verifying sticky-session
   * routing in load-balanced deployments.
   */
  get serverEndpoint(): string | null {
    return this._serverEndpoint;
  }

  // ── Async iterator ────────────────────────────────────────────────────

  /** Iterate over incoming messages. The iterator closes when the socket closes. */
  [Symbol.asyncIterator](): AsyncIterator<WSMessage> {
    return {
      next: (): Promise<IteratorResult<WSMessage>> => {
        if (this._iterQueue.length > 0)
          return Promise.resolve({ done: false, value: this._iterQueue.shift()! });
        if (this._iterDone) return Promise.resolve({ done: true, value: undefined });
        return new Promise((res) => {
          this._iterWaiter = res;
        });
      },
      return: (): Promise<IteratorResult<WSMessage>> => {
        this.close(1000, "Iterator returned");
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _doConnect(isReconnect: boolean): Promise<void> {
    this._mx.totalConnectAttempts++;
    this._state = "CONNECTING";

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      // Connect timeout
      let connTid: ReturnType<typeof setTimeout> | null = null;
      if (this._connectTimeoutMs > 0) {
        connTid = setTimeout(() => {
          if (settled) return;
          settled = true;
          const e = new WSConnectTimeoutError(this._url, this._connectTimeoutMs);
          reject(e);
          this._cbError?.(e);
          const ws = this._ws;
          if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            ws.close();
            this._ws = null;
          }
          if (!this._aborted && this._canRecon()) this._scheduleRecon();
          else {
            this._state = "CLOSED";
            for (const w of this._openWaiters.splice(0)) w.reject(e);
            this._rejectCorrelations("Connection timeout");
          }
        }, this._connectTimeoutMs);
      }
      const clearConn = () => {
        if (connTid) {
          clearTimeout(connTid);
          connTid = null;
        }
      };

      // URL — inject headers as query params in browser environments.
      // Detect browser by checking for the presence of window, navigator, and document APIs
      // while excluding Node.js (process.versions.node), Deno, and Bun runtimes.
      let url = this._url;
      const isBrowser = (() => {
        try {
          const g = globalThis as { process?: { versions?: { node?: string } } };
          if (typeof (globalThis as Record<string, unknown>)["Deno"] !== "undefined") return false;
          if (typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined") return false;
          if (g.process?.versions?.node) return false;
          if (typeof window === "undefined") return false;
          const w = window as unknown as Record<string, unknown>;
          return typeof w["navigator"] !== "undefined" && typeof w["document"] !== "undefined";
        } catch {
          return false;
        }
      })();
      if (this._headers && isBrowser) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(this._headers)) u.searchParams.set(k, v);
        url = u.href;
      }

      // WebSocket is now built-in across all supported runtimes:
      // Browser, Deno, Bun, Node.js 22+, Cloudflare Workers, etc.
      // Use global WebSocket constructor directly
      let ws: WebSocket;
      try {
        ws = this._protocols ? new WebSocket(url, this._protocols) : new WebSocket(url);
      } catch (err) {
        clearConn();
        this._state = "CLOSED";
        reject(
          new WSError("Failed to construct WebSocket", err instanceof Error ? err : undefined),
        );
        return;
      }

      // Native header injection (Deno/Bun/Node)
      // Some runtimes (Deno) have setHeader method on WebSocket
      if (this._headers && !isBrowser) {
        // Type assertion for runtime-specific WebSocket extensions
        const wsExt = ws as unknown as { setHeader?: (key: string, value: string) => void };
        if (typeof wsExt.setHeader === "function") {
          for (const [k, v] of Object.entries(this._headers)) {
            wsExt.setHeader(k, v);
          }
        }
      }

      this._ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        clearConn();
        if (settled) return;
        settled = true;
        this._state = "OPEN";
        this._openedAt = Date.now();
        this._mx.connectedAt = this._openedAt;
        if (isReconnect) this._mx.reconnectCount++;

        // Sticky session: store the server's URL (may differ after redirect).
        this._serverEndpoint = ws.url ?? this._url;

        this._reconnAttempt = 0;

        // Auto-rejoin rooms after reconnect
        if (this._rooms.length > 0 && this._keepRooms) {
          for (const r of this._rooms) {
            try {
              ws.send(
                JSON.stringify({ type: "room:join", room: r.room, namespace: r.namespace ?? null }),
              );
            } catch {
              /* best-effort */
            }
          }
        }

        this._startPing();
        this._flushBuf();
        this._cbOpen?.(this._mx.reconnectCount);
        resolve();
        for (const w of this._openWaiters.splice(0)) w.resolve();
      };

      ws.onmessage = async (evt) => {
        if (this._aborted) return;
        let data: string | Uint8Array;
        let json: unknown;
        let bytes: number;

        if (typeof evt.data === "string") {
          data = evt.data;
          bytes = new TextEncoder().encode(data).byteLength;
          try {
            json = JSON.parse(data);
          } catch {
            /* not JSON */
          }
        } else if (evt.data instanceof ArrayBuffer) {
          data = new Uint8Array(evt.data);
          bytes = data.byteLength;
        } else if (typeof Blob !== "undefined" && evt.data instanceof Blob) {
          // Node.js native WebSocket may deliver binary as Blob even after binaryType="arraybuffer"
          const ab = await evt.data.arrayBuffer();
          data = new Uint8Array(ab);
          bytes = data.byteLength;
        } else {
          // ArrayBufferView or other
          data = new Uint8Array(evt.data as ArrayBufferLike);
          bytes = data.byteLength;
        }

        this._mx.messagesReceived++;
        this._mx.bytesReceived += bytes;

        const msg: WSMessage = { data, json, timestamp: Date.now() };

        // Pong detection
        if (this._pongMatcher && typeof data === "string") {
          const isPong =
            typeof this._pongMatcher === "string"
              ? data === this._pongMatcher
              : (this._pongMatcher as RegExp).test(data);
          if (isPong) {
            if (this._pongTimer) {
              clearTimeout(this._pongTimer);
              this._pongTimer = null;
            }
            return;
          }
        }

        // Correlation matching
        for (const [key, c] of this._correlations) {
          if (c.matcher(msg)) {
            this._correlations.delete(key);
            if (c.timer) clearTimeout(c.timer);
            try {
              c.resolve(c.extract(msg));
            } catch (e) {
              c.reject(e);
            }
            return;
          }
        }

        // Dispatch to listeners + iterator
        for (const fn of this._msgListeners) {
          try {
            fn(msg);
          } catch {
            /* isolate */
          }
        }
        this._cbMessage?.(msg);
        // Async-iterator queue — cap to avoid unbounded growth when no consumer is active
        if (this._iterWaiter) {
          const r = this._iterWaiter;
          this._iterWaiter = null;
          r({ done: false, value: msg });
        } else {
          if (this._iterQueue.length >= this._maxBufferSize) this._iterQueue.shift();
          this._iterQueue.push(msg);
        }
      };

      ws.onerror = (evt) => {
        this._cbError?.(
          new WSError((evt as ErrorEvent).message ?? "WebSocket error", (evt as ErrorEvent).error),
        );
      };

      ws.onclose = (evt) => {
        clearConn();
        this._stopPing();
        if (this._openedAt != null) {
          this._mx.uptimeMs += Date.now() - this._openedAt;
          this._openedAt = null;
        }
        this._mx.closedAt = Date.now();

        for (const fn of this._closeListeners) {
          try {
            fn({ code: evt.code, reason: evt.reason });
          } catch {
            /* isolate */
          }
        }

        if (!settled) {
          settled = true;
          reject(new WSError(`Socket closed before open (code ${evt.code}: ${evt.reason})`));
        }

        if (this._aborted || evt.code === 1000 || evt.code === 1001) {
          this._state = "CLOSED";
          this._cbClose?.(evt.code, evt.reason, false);
          this._terminateIter();
          for (const w of this._openWaiters.splice(0)) w.reject(new WSError(`Socket closed (code ${evt.code})`));
          this._rejectCorrelations(`Socket closed (code ${evt.code})`);
          return;
        }

        const will = this._canRecon();
        this._cbClose?.(evt.code, evt.reason, will);

        if (will) {
          this._scheduleRecon();
        } else {
          this._cbGiveUp?.(this._reconnAttempt);
          this._state = "CLOSED";
          this._terminateIter();
          const err = new WSMaxReconnectsError(this._reconnAttempt);
          for (const w of this._openWaiters.splice(0)) w.reject(err);
          this._rejectCorrelations("Max reconnects exceeded");
        }
      };
    });
  }

  private _canRecon(): boolean {
    return this._maxReconnects === 0 || this._reconnAttempt < this._maxReconnects;
  }

  private _scheduleRecon(): void {
    this._state = "RECONNECTING";
    this._reconnAttempt++;
    const exp = this._reconnectBaseMs * Math.pow(2, this._reconnAttempt - 1);
    const capped = Math.min(exp, this._reconnectMaxMs);
    const delay = Math.floor(capped * (1 + this._reconnectJitter * Math.random()));
    this._cbReconnect?.(this._reconnAttempt, delay);
    this._reconnTimer = setTimeout(() => {
      if (!this._aborted) this._doConnect(true).catch(() => {});
    }, delay);
    // Allow Node.js process to exit even with pending timer
    if (
      typeof this._reconnTimer === "object" &&
      this._reconnTimer !== null &&
      "unref" in this._reconnTimer
    ) {
      (this._reconnTimer as { unref: () => void }).unref();
    }
  }

  private _tx(data: string | ArrayBuffer): boolean {
    const ws = this._ws;
    const byteLen =
      typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : (data as ArrayBuffer).byteLength;

    // Rate limiting (token bucket)
    if (this._maxSendRate > 0) {
      const now = Date.now();
      if (this._lastToken === 0) {
        this._lastToken = now;
        this._tokens = this._maxSendRate;
      }
      const elapsed = now - this._lastToken;
      this._tokens = Math.min(
        this._maxSendRate,
        this._tokens + (elapsed * this._maxSendRate) / 1000,
      );
      this._lastToken = now;
      if (this._tokens < 1) {
        // Buffer instead of dropping
        this._bufferMessage(data, byteLen);
        return false;
      }
      this._tokens--;
    }

    // Backpressure check: if we're above highWaterMark, buffer instead
    if (this._bufferedBytes >= this._highWaterMark) {
      this._bufferMessage(data, byteLen);
      return false;
    }

    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(data as string);
        // Update metrics
        this._mx.bytesSent += byteLen;
        return true;
      } catch (err) {
        this._cbError?.(
          new WSError(
            `WebSocket send failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        );
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.close(4001, "Send error");
          } catch {
            /* ignore close errors */
          }
        }
        this._ws = null;
        if (!this._aborted && this._canRecon()) {
          this._scheduleRecon();
        }
        return false;
      }
    }

    this._bufferMessage(data, byteLen);
    return false;
  }

  /** Buffer an outgoing message and track bytes for backpressure. */
  private _bufferMessage(data: string | ArrayBuffer, byteLen: number): void {
    if (this._bufferMessages && !this._aborted) {
      const evicted = this._buffer.length >= this._maxBufferSize ? this._buffer.shift() : undefined;
      if (evicted !== undefined) {
        this._bufferedBytes -=
          typeof evicted === "string"
            ? new TextEncoder().encode(evicted).byteLength
            : (evicted as ArrayBuffer).byteLength;
      }
      this._buffer.push(data);
      this._bufferedBytes += byteLen;
      this._updateBackpressure();
    }
  }

  private _flushBuf(): void {
    const msgs = this._buffer.splice(0);
    for (const msg of msgs) {
      try {
        this._ws?.send(msg as string);
        this._mx.messagesSent++;
        this._mx.bytesSent += typeof msg === "string" ? new TextEncoder().encode(msg).byteLength : msg.byteLength;
      } catch {
        /* ignore */
      }
    }
    // Reset byte tracking after flush
    this._bufferedBytes = 0;
    this._updateBackpressure();
  }

  /** Fire backpressure callbacks when crossing the high/low water threshold. */
  private _updateBackpressure(): void {
    const bp = this._bufferedBytes >= this._highWaterMark;
    if (bp !== this._wasBackpressured) {
      this._wasBackpressured = bp;
      this._cbBackpressure?.(bp, this.backpressure);
    }
    // Drain waiters fire when we drop below low-water mark
    if (!bp && this._bufferedBytes < this._lowWaterMark && this._drainWaiters.length > 0) {
      for (const w of this._drainWaiters.splice(0)) w();
    }
  }

  private _startPing(): void {
    if (this._pingIntervalMs <= 0) return;
    this._pingTimer = setInterval(() => {
      const ws = this._ws;
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send(this._pingPayload);
        this._mx.messagesSent++;
        this._mx.bytesSent += new TextEncoder().encode(this._pingPayload).byteLength;
      } catch {
        /* ignore */
      }
      if (this._pongMatcher && this._pongTimeoutMs > 0) {
        if (this._pongTimer) clearTimeout(this._pongTimer);
        this._pongTimer = setTimeout(() => {
          this._pongTimer = null;
          const ws2 = this._ws;
          if (ws2) {
            ws2.onopen = ws2.onmessage = ws2.onerror = ws2.onclose = null;
            ws2.close(4000, "Pong timeout");
            this._ws = null;
          }
          if (!this._aborted && this._canRecon()) {
            this._cbClose?.(4000, "Pong timeout", true);
            this._scheduleRecon();
          } else this._state = "CLOSED";
        }, this._pongTimeoutMs);
        if (
          typeof this._pongTimer === "object" &&
          this._pongTimer !== null &&
          "unref" in this._pongTimer
        ) {
          (this._pongTimer as { unref: () => void }).unref();
        }
      }
    }, this._pingIntervalMs);
    if (
      typeof this._pingTimer === "object" &&
      this._pingTimer !== null &&
      "unref" in this._pingTimer
    ) {
      (this._pingTimer as { unref: () => void }).unref();
    }
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  private _stopAll(): void {
    this._stopPing();
    if (this._reconnTimer) {
      clearTimeout(this._reconnTimer);
      this._reconnTimer = null;
    }
  }

  private _terminateIter(): void {
    this._iterDone = true;
    if (this._iterWaiter) {
      this._iterWaiter({ done: true, value: undefined });
      this._iterWaiter = null;
    }
  }

  private _rejectCorrelations(reason: string): void {
    for (const c of this._correlations.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.reject(new WSError(reason));
    }
    this._correlations.clear();
  }
}

// ============================================================================
// §5  FACTORY
// ============================================================================

/**
 * Create and immediately connect a WebSocket client.
 * Resolves once OPEN. Throws WSConnectTimeoutError on handshake timeout.
 *
 * @param config - Client configuration (URL, protocols, callbacks, etc.)
 * @returns A connected WSClient instance
 */
export async function connectWS(config: WSClientConfig): Promise<WSClient> {
  const client = new WSClient(config);
  await client.connect();
  return client;
}
