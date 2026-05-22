/**
 * Server-Sent Events (SSE) client and server utilities.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Full SSE spec (WHATWG EventSource) client
 *  - Async iterator interface
 *  - Typed event parsing (id, event, data, retry)
 *  - Automatic reconnection with Last-Event-ID
 *  - Custom retry backoff (exponential + jitter)
 *  - Reconnect delay from server "retry:" field
 *  - AbortSignal / manual close support
 *  - Multi-line data field support
 *  - SSE server response builder
 *  - SSE transform stream (pipe raw bytes → SSEEvent)
 *  - JSON SSE events (typed generic)
 *  - Named event routing (EventSource-like)
 *  - SSE heartbeat detection
 *  - Reconnect hooks
 *  - Stream health monitoring (last event time, total events)
 *  - Works with fetch() ReadableStream (no Node streams required)
 *
 * ⚠️ Cloudflare Workers compatibility note:
 *   SSE requires keeping a connection open. Cloudflare Workers have a 30s CPU time
 *   limit and 15min wall-clock time limit. Long-lived SSE connections may be terminated
 *   by the platform. Consider using shorter-lived streams with client-side reconnection.
 */

import { KinetexError as _KinetexError } from "./types.ts";

// ============================================================================
// §1  TYPES
// ============================================================================

/**
 * A single parsed SSE event following the WHATWG EventSource specification.
 */
export interface SSEEvent {
  /** Value of the `id:` field. null if not present. */
  id: string | null;
  /** Value of the `event:` field. Defaults to "message". */
  event: string;
  /** Concatenated `data:` lines joined by newline. */
  data: string;
  /** Value of the `retry:` field in ms. null if not present. */
  retry: number | null;
  /** Raw lines that composed this event (for debugging). */
  raw: string[];
}

/**
 * A typed SSE event where the `data` field has been parsed as JSON.
 */
export interface JSONSSEEvent<T = unknown> {
  /** Value of the `event:` field. Defaults to "message". */
  event: string;
  /** Parsed JSON data. */
  data: T;
  /** Value of the `id:` field. null if not present. */
  id: string | null;
}

/**
 * Configuration for creating an SSE client stream.
 */
export interface SSEClientConfig {
  /** URL to connect to */
  url: string;
  /** Additional request headers */
  headers?: Record<string, string>;
  /** Fetch function (injectable for testing / custom auth) */
  fetch?: typeof globalThis.fetch;
  /** AbortSignal to stop the stream */
  signal?: AbortSignal;
  /** Initial Last-Event-ID to send on first connect */
  lastEventId?: string;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Initial reconnect delay in ms (default: 3000) */
  reconnectDelayMs?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
  /** Jitter factor 0–1 (default: 0.3) */
  reconnectJitter?: number;
  /** Max reconnect attempts. 0 = infinite (default: 0) */
  maxReconnects?: number;
  /** Called before each reconnect attempt */
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** Called on SSE parse errors */
  onParseError?: (err: unknown, raw: string) => void;
  /**
   * Heartbeat timeout in ms — close if no event received (default: 0 = disabled).
   *
   * When the timeout fires:
   * 1. The reader is cancelled (triggering a stream error)
   * 2. If `reconnect` is enabled, the client attempts to reconnect
   * 3. The `onReconnect` callback is invoked with the reconnect attempt count
   *
   * Use this to detect stale connections that aren't properly closed by the server.
   */
  heartbeatTimeoutMs?: number;
  /** Request method (default: GET) */
  method?: string;
  /** Request body (for POST-based SSE) */
  body?: string | null;
  /**
   * Validate response before reading the stream.
   * Return `true` to accept, `false` for a generic error, or a `string` error message.
   */
  validateResponse?: (res: Response) => boolean | string;
}

/**
 * Snapshot of SSE stream health and connection state.
 */
export interface SSEStreamHealth {
  connected: boolean;
  totalEvents: number;
  totalReconnects: number;
  lastEventAt: number | null;
  lastEventId: string | null;
  reconnectAttempt: number;
}

// ============================================================================
// §2  SSE PARSER (line-level state machine)
// ============================================================================

/**
 * Line-level state machine that parses raw SSE text into structured SSEEvent objects.
 *
 * Implements the WHATWG EventSource parsing algorithm, including multi-line data,
 * id persistence across events, and retry field extraction.
 */
export class SSEParser {
  private lines: string[] = [];
  private id: string | null = null;
  private event: string = "message";
  private data: string[] = [];
  private retry: number | null = null;
  private buffer: string = "";

  /**
   * Feed raw text into the parser.
   *
   * Per the SSE specification, the `id` field persists across events - it is NOT
   * reset when an event is dispatched. Only the `reset()` method (called on
   * reconnect) clears the id. This allows clients to use Last-Event-ID for
   * resumption after temporary disconnections.
   *
   * @param chunk Raw SSE text chunk.
   * @returns Any complete events found in this chunk.
   */
  feed(chunk: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    this.buffer += chunk;

    // Split on lines — SSE uses CRLF, LF, or CR as line endings
    const rawLines = this.buffer.split(/\r\n|\r|\n/);

    // The last element may be an incomplete line — keep it in the buffer
    this.buffer = rawLines.pop() ?? "";

    for (const line of rawLines) {
      const event = this._processLine(line);
      if (event) events.push(event);
    }

    return events;
  }

  /**
   * Flush any remaining buffer content. Call when the stream ends.
   *
   * @returns A final event if data was buffered, or null.
   */
  flush(): SSEEvent | null {
    if (this.buffer) {
      this._processLine(this.buffer);
      this.buffer = "";
    }
    if (this.data.length > 0) {
      return this._dispatch();
    }
    return null;
  }

  private _processLine(line: string): SSEEvent | null {
    this.lines.push(line);

    // Empty line = dispatch event
    if (line === "") {
      if (this.data.length === 0) {
        // No data — ignore (comment-only or empty block)
        this.lines = [];
        return null;
      }
      return this._dispatch();
    }

    // Comment line
    if (line.startsWith(":")) return null;

    const colonIdx = line.indexOf(":");
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      // Optional single leading space after colon
      value = line.slice(colonIdx + 1).replace(/^ /, "");
    }

    switch (field) {
      case "id":
        // Empty id resets the last event id to null per spec
        this.id = value || null;
        break;
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "retry": {
        const ms = parseInt(value, 10);
        if (!isNaN(ms) && ms >= 0) this.retry = ms;
        break;
      }
      // Unknown fields are ignored per spec
    }

    return null;
  }

  private _dispatch(): SSEEvent {
    const event: SSEEvent = {
      id: this.id,
      event: this.event,
      data: this.data.join("\n"),
      retry: this.retry,
      raw: [...this.lines],
    };

    // Reset state (id persists across events per spec)
    this.lines = [];
    this.event = "message";
    this.data = [];
    this.retry = null;

    return event;
  }

  /** Reset parser state completely (e.g. on reconnect). */
  reset(): void {
    this.lines = [];
    this.id = null;
    this.event = "message";
    this.data = [];
    this.retry = null;
    this.buffer = "";
  }

  /** The last event ID parsed from `id:` fields, persisted across events per SSE spec. */
  get lastId(): string | null {
    return this.id;
  }
}

// ============================================================================
// §3  SSE TRANSFORM STREAM
// ============================================================================

/**
 * A TransformStream that converts raw bytes/strings into SSEEvent objects.
 * Pipe a fetch response body through this to get a stream of events.
 */
export class SSETransformStream extends TransformStream<Uint8Array | string, SSEEvent> {
  private readonly parser = new SSEParser();
  private readonly decoder = new TextDecoder("utf-8");

  /**
   * @param options.onParseError Callback invoked when a parse error occurs.
   *   The error is logged via the callback but the chunk is silently dropped.
   *   The stream continues processing subsequent chunks.
   */
  constructor(options: { onParseError?: (err: unknown, raw: string) => void } = {}) {
    super({
      transform: (chunk, controller) => {
        try {
          const text =
            typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
          const events = this.parser.feed(text);
          for (const evt of events) controller.enqueue(evt);
        } catch (err) {
          options.onParseError?.(err, String(chunk));
        }
      },
      flush: (controller) => {
        const remaining = this.parser.flush();
        if (remaining) controller.enqueue(remaining);
      },
    });
  }
}

// ============================================================================
// §4  SSE CLIENT
// ============================================================================

/**
 * SSE client that connects to a text/event-stream endpoint and yields events.
 *
 * Supports automatic reconnection with exponential backoff + jitter,
 * Last-Event-ID resumption, heartbeat detection, and configurable validation.
 */
export class SSEClient {
  private readonly config: Required<SSEClientConfig>;
  private health: SSEStreamHealth;
  private _closed = false;

  /**
   * @param config Connection and behaviour configuration.
   */
  constructor(config: SSEClientConfig) {
    this.config = {
      fetch: globalThis.fetch,
      headers: {},
      // Signal is optional - if provided, use it; otherwise undefined
      // Required<> below will make it required but we handle undefined at usage sites
      signal: (config.signal ?? undefined) as unknown as AbortSignal,
      lastEventId: "",
      reconnect: true,
      reconnectDelayMs: 3000,
      maxReconnectDelayMs: 30_000,
      reconnectJitter: 0.3,
      maxReconnects: 0,
      onReconnect: () => {},
      // FIX 15: default to no-op — callers opt in to error visibility.
      // Unfiltered console.error in production is captured by log aggregators
      // and can trigger false-positive alerts.
      onParseError: (_err) => {
        /* no-op by default; supply onParseError to opt in */
      },
      heartbeatTimeoutMs: 0,
      method: "GET",
      body: null,
      validateResponse: () => true,
      ...config,
    };

    this.health = {
      connected: false,
      totalEvents: 0,
      totalReconnects: 0,
      lastEventAt: null,
      lastEventId: this.config.lastEventId || null,
      reconnectAttempt: 0,
    };
  }

  /** The SSE endpoint URL. */
  get url(): string {
    return this.config.url;
  }

  /** Whether the client has been closed. */
  get closed(): boolean {
    return this._closed;
  }

  /** Stream events as an async iterator. */
  async *[Symbol.asyncIterator](): AsyncIterator<SSEEvent> {
    yield* this._stream();
  }

  /** Stream events as an async iterator (explicit method). */
  async *stream(): AsyncGenerator<SSEEvent> {
    yield* this._stream();
  }

  /**
   * Listen for a specific event type (like EventSource.addEventListener).
   * Returns an async iterator that yields only matching events.
   */
  async *on(eventType: string): AsyncGenerator<SSEEvent> {
    for await (const event of this._stream()) {
      if (event.event === eventType) yield event;
    }
  }

  /**
   * Collect all events into an array until the stream closes.
   *
   * Use with caution on long-lived streams — for infinite streams, prefer
   * the async iterator interface (`for await...of`).
   *
   * @param options.limit - If provided, stops collecting after this many events.
   *   Returns early with partial results.
   * @param options.signal - AbortSignal to cancel collection early.
   * @returns Array of collected events. Returns empty array if stream ends with no events.
   */
  async collect(options: { limit?: number; signal?: AbortSignal } = {}): Promise<SSEEvent[]> {
    const events: SSEEvent[] = [];
    let count = 0;
    for await (const event of this._stream()) {
      events.push(event);
      count++;
      if (options.limit && count >= options.limit) break;
      if (options.signal?.aborted) break;
    }
    return events;
  }

  private _streamController: AbortController | null = null;

  /** Close the connection and abort any active stream. */
  close(): void {
    this._closed = true;
    // Abort any active stream
    if (this._streamController) {
      this._streamController.abort();
      this._streamController = null;
    }
    this.health.connected = false;
  }

  /**
   * Destroy the client and clean up all resources.
   */
  destroy(): void {
    this.close();
    this.health = {
      connected: false,
      totalEvents: this.health.totalEvents,
      totalReconnects: this.health.totalReconnects,
      lastEventAt: this.health.lastEventAt,
      lastEventId: this.health.lastEventId,
      reconnectAttempt: 0,
    };
  }

  /** Snapshot of current stream health (events, reconnects, last event time). */
  get streamHealth(): Readonly<SSEStreamHealth> {
    return { ...this.health };
  }

  // ── Core streaming loop ───────────────────────────────────────────────────

  private async *_stream(): AsyncGenerator<SSEEvent> {
    const cfg = this.config;
    let reconnectDelay = cfg.reconnectDelayMs;
    let reconnectAttempt = 0;

    // Create abort controller for this stream
    this._streamController = new AbortController();

    while (!this._closed && !this._streamController?.signal.aborted) {
      // Snapshot _closed to avoid race with setter firing during yield
      const closedSnapshot = this._closed;
      if (closedSnapshot || cfg.signal?.aborted || this._streamController?.signal.aborted) break;

      const parser = new SSEParser();
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

      try {
        // Build request headers
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          "cache-control": "no-cache",
          ...cfg.headers,
        };

        if (this.health.lastEventId) {
          headers["last-event-id"] = this.health.lastEventId;
        }

        // Build fetch init - Node.js 20+ requires duplex: "half" when sending a body
        const init: RequestInit = {
          method: cfg.method,
          headers,
          body: cfg.body ?? null,
          signal: cfg.signal ?? null,
        };
        // Node.js 20+ requires duplex option when body is present.
        // TypeScript doesn't know about this option; `as unknown` cast is intentional
        // and safe — the property is only accessed by Node.js and ignored elsewhere.
        if (cfg.body !== null && cfg.body !== undefined) {
          (init as unknown as { duplex: string }).duplex = "half";
        }

        const response = await cfg.fetch(cfg.url, init);

        // Validate response
        const valid = cfg.validateResponse(response);
        if (valid !== true) {
          const msg = typeof valid === "string" ? valid : `SSE server returned ${response.status}`;
          throw new SSEError(msg, response.status, response);
        }

        if (!response.ok) {
          throw new SSEError(`SSE server error: ${response.status}`, response.status, response);
        }

        if (!response.body) {
          throw new SSEError("SSE response has no body", response.status, response);
        }

        // Verify content type
        const ct = response.headers.get("content-type") ?? "";
        if (!ct.startsWith("text/event-stream")) {
          throw new SSEError(`Expected text/event-stream, got: ${ct}`, response.status, response);
        }

        this.health.connected = true;
        reconnectAttempt = 0;
        reconnectDelay = cfg.reconnectDelayMs;

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        // Heartbeat watchdog
        const resetHeartbeat = () => {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          if (cfg.heartbeatTimeoutMs > 0) {
            heartbeatTimer = setTimeout(() => {
              reader.cancel("heartbeat timeout");
            }, cfg.heartbeatTimeoutMs);
          }
        };

        resetHeartbeat();

        try {
          while (!closedSnapshot) {
            if (cfg.signal?.aborted) break;

            const { done, value } = await reader.read();

            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const events = parser.feed(text);

            for (const evt of events) {
              resetHeartbeat();

              // Apply retry field from server
              if (evt.retry !== null) {
                reconnectDelay = Math.min(evt.retry, cfg.maxReconnectDelayMs);
              }

              // Update last event ID
              if (evt.id !== null) {
                this.health.lastEventId = evt.id;
              }

              this.health.totalEvents++;
              this.health.lastEventAt = Date.now();

              yield evt;
            }
          }
        } finally {
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
        }

        // Flush remaining
        const final = parser.flush();
        if (final) {
          this.health.totalEvents++;
          this.health.lastEventAt = Date.now();
          yield final;
        }
      } catch (err) {
        this.health.connected = false;

        // AbortError or manual close — stop (use snapshot to avoid race with setter during yield)
        if (
          closedSnapshot ||
          (err instanceof Error && err.name === "AbortError") ||
          cfg.signal?.aborted
        ) {
          break;
        }

        // SSE error with non-retryable status
        if (err instanceof SSEError && err.status && [401, 403, 404].includes(err.status)) {
          throw err;
        }

        if (!cfg.reconnect) throw err;

        // Max reconnects reached
        if (cfg.maxReconnects > 0 && reconnectAttempt >= cfg.maxReconnects) {
          throw new SSEMaxReconnectsError(reconnectAttempt, cfg.url);
        }

        reconnectAttempt++;
        this.health.totalReconnects++;
        this.health.reconnectAttempt = reconnectAttempt;

        // Exponential back-off + jitter
        const jitter = reconnectDelay * cfg.reconnectJitter * Math.random();
        const delay = Math.min(reconnectDelay + jitter, cfg.maxReconnectDelayMs);
        reconnectDelay = Math.min(reconnectDelay * 2, cfg.maxReconnectDelayMs);

        cfg.onReconnect(reconnectAttempt, delay);

        // Clear orphaned heartbeat timer before sleep to avoid firing during back-off
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }

        await sleep(delay);
        parser.reset();
        continue;
      }

      // Clean stream close — stop if not reconnecting
      this.health.connected = false;
      if (!cfg.reconnect) break;

      // Max reconnects reached (also checked in catch for error path)
      if (cfg.maxReconnects > 0 && reconnectAttempt >= cfg.maxReconnects) {
        throw new SSEMaxReconnectsError(reconnectAttempt, cfg.url);
      }

      // Reconnect after stream closed by server
      reconnectAttempt++;
      this.health.totalReconnects++;

      const delay = Math.min(reconnectDelay, cfg.maxReconnectDelayMs);
      cfg.onReconnect(reconnectAttempt, delay);

      // Clear orphaned heartbeat timer before sleep to avoid firing during back-off
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }

      await sleep(delay);
    }

    this.health.connected = false;
  }
}

// ============================================================================
// §5  TYPED JSON SSE
// ============================================================================

/**
 * Higher-order wrapper that parses SSE data as JSON.
 *
 * Non-JSON events are silently skipped (optional onError callback).
 *
 * @param source - AsyncIterable of SSEEvent (e.g., from SSEClient)
 * @param options - Options with optional onError callback and reviver
 * @yields A typed object with `event`, `data`, and `id` fields.
 *
 * @example
 * ```ts
 * for await (const { event, data } of jsonSSE<T>(client, {
 *   onError: (err, evt) => console.warn("Parse error:", evt.data),
 * })) {
 *   console.log(event, data);
 * }
 * ```
 */
export async function* jsonSSE<T = unknown>(
  source: AsyncIterable<SSEEvent>,
  options: {
    /** Called when JSON.parse fails on an event's data. If omitted, errors are silently ignored. */
    onError?: (err: unknown, event: SSEEvent) => void;
    reviver?: Parameters<typeof JSON.parse>[1];
  } = {},
): AsyncGenerator<JSONSSEEvent<T>> {
  for await (const evt of source) {
    if (!evt.data && evt.data !== "") continue;
    try {
      const data = JSON.parse(evt.data, options.reviver) as T;
      yield { event: evt.event, data, id: evt.id };
    } catch (err) {
      options.onError?.(err, evt);
    }
  }
}

// ============================================================================
// §6  EVENT ROUTER
// ============================================================================

/** Handler function for routed SSE events. */
export type SSEEventHandler<T = string> = (data: T, event: SSEEvent) => void | Promise<void>;

/**
 * Route SSE events by type to registered handlers, similar to EventSource.addEventListener.
 */
export class SSERouter {
  private handlers = new Map<string, SSEEventHandler[]>();
  private fallback: SSEEventHandler | null = null;

  /**
   * Register a handler for a specific SSE event type.
   *
   * @param eventType The event name to match (e.g. "message", "update").
   * @param handler Async function called with event data and the raw SSEEvent.
   * @returns this for chaining.
   */
  on(eventType: string, handler: SSEEventHandler): this {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return this;
  }

  /**
   * Register a handler for events of a given type, automatically parsing data as JSON.
   *
   * Note: JSON parse errors are silently ignored — if the event data is not valid JSON,
   * the handler is not called and no error is thrown. To handle parse errors, use
   * `on()` with a try/catch inside your handler.
   *
   * @param eventType The SSE event type to match (e.g., "update", "message").
   * @param handler Async function called with parsed JSON data and the raw event.
   * @returns this for chaining.
   */
  onJSON<T>(eventType: string, handler: SSEEventHandler<T>): this {
    return this.on(eventType, async (data, evt) => {
      try {
        const parsed = JSON.parse(data) as T;
        await handler(parsed, evt);
      } catch {
        /* ignore parse error */
      }
    });
  }

  /** Register a handler for "message" events (default event type). */
  onMessage(handler: SSEEventHandler): this {
    return this.on("message", handler);
  }

  /** Handle any event not matched by a specific handler. */
  onAny(handler: SSEEventHandler): this {
    this.fallback = handler;
    return this;
  }

  /**
   * Dispatch a single SSE event to the appropriate handler(s).
   *
   * @param event The parsed SSE event to dispatch.
   */
  async dispatch(event: SSEEvent): Promise<void> {
    const handlers = this.handlers.get(event.event);
    if (handlers && handlers.length > 0) {
      for (const h of handlers) await h(event.data, event);
    } else if (this.fallback) {
      await this.fallback(event.data, event);
    }
  }

  /**
   * Consume an async iterable of SSE events, routing each one.
   *
   * @param source An async iterable of SSEEvent (e.g. from SSEClient).
   */
  async consume(source: AsyncIterable<SSEEvent>): Promise<void> {
    for await (const event of source) {
      await this.dispatch(event);
    }
  }
}

// ============================================================================
// §7  SSE SERVER BUILDER
// ============================================================================

/**
 * Builder for creating SSE-compatible server responses.
 * Works with any runtime that supports the WHATWG Streams API.
 */
export class SSEServerResponse {
  private readonly controller: ReadableStreamDefaultController<string>;
  /** The underlying readable stream for writing SSE events. */
  readonly stream: ReadableStream<string>;
  private _closed = false;

  /**
   * Create a new SSE server response. The underlying stream is created lazily.
   */
  constructor() {
    let ctrl!: ReadableStreamDefaultController<string>;
    this.stream = new ReadableStream<string>({
      start: (c) => {
        ctrl = c;
      },
      cancel: () => {
        this._closed = true;
      },
    });
    this.controller = ctrl;
  }

  /** Send a comment (heartbeat ping). */
  comment(text = ""): this {
    if (!this._closed) this.controller.enqueue(`: ${text}\n\n`);
    return this;
  }

  /** Send a "message" event. */
  send(data: string, options: { id?: string; retry?: number } = {}): this {
    return this.sendEvent("message", data, options);
  }

  /** Send a named event. */
  sendEvent(event: string, data: string, options: { id?: string; retry?: number } = {}): this {
    if (this._closed) return this;
    let msg = "";
    if (options.id !== undefined) msg += `id: ${options.id}\n`;
    if (event !== "message") msg += `event: ${event}\n`;
    if (options.retry !== undefined) msg += `retry: ${options.retry}\n`;

    // Multi-line data support
    for (const line of data.split("\n")) {
      msg += `data: ${line}\n`;
    }
    msg += "\n";

    this.controller.enqueue(msg);
    return this;
  }

  /** Send a typed JSON event. */
  sendJSON<T>(event: string, data: T, options: { id?: string } = {}): this {
    return this.sendEvent(event, JSON.stringify(data), options);
  }

  /** Send a heartbeat comment to keep the connection alive. */
  heartbeat(): this {
    return this.comment("heartbeat");
  }

  /** Tell the client to reconnect after `ms` milliseconds. */
  setReconnectDelay(ms: number): this {
    if (!this._closed) this.controller.enqueue(`retry: ${ms}\n\n`);
    return this;
  }

  /** Close the stream. */
  close(): void {
    if (!this._closed) {
      this._closed = true;
      try {
        this.controller.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** Whether the underlying stream has been closed. */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Build a standard SSE HTTP Response object.
   *
   * @param headers Additional HTTP headers to merge with the SSE defaults.
   * @returns A Response with content-type text/event-stream.
   */
  toResponse(headers: Record<string, string> = {}): Response {
    const encoder = new TextEncoder();
    const encoded = this.stream.pipeThrough(
      new TransformStream({
        transform: (chunk, ctrl) => ctrl.enqueue(encoder.encode(chunk)),
      }),
    );

    return new Response(encoded, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Disable nginx buffering - ensures events are sent immediately to client
        // rather than being buffered. This is a nginx-specific header but harmless
        // on other servers.
        "x-accel-buffering": "no",
        ...headers,
      },
    });
  }
}

// ============================================================================
// §8  ERRORS
// ============================================================================

/**
 * Error from an SSE operation (connection failure, validation rejection, etc.).
 */
export class SSEError extends Error {
  /** Machine-readable error code identifying SSE errors. */
  readonly code = "ESSE";
  /**
   * @param message Human-readable error description.
   * @param status HTTP status code, or null if not applicable.
   * @param response The fetch Response, or null if not applicable.
   */
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly response: Response | null,
  ) {
    super(message);
    this.name = "SSEError";
  }
}

/**
 * Thrown when the SSE client exhausts its maximum reconnect attempts.
 */
export class SSEMaxReconnectsError extends Error {
  /** Machine-readable error code for exhausted reconnect attempts. */
  readonly code = "ESSEMAXRECONNECTS";
  /**
   * @param attempts Number of reconnect attempts made.
   * @param url The SSE endpoint URL.
   */
  constructor(
    public readonly attempts: number,
    public readonly url: string,
  ) {
    super(`SSE max reconnects (${attempts}) reached for ${url}`);
    this.name = "SSEMaxReconnectsError";
  }
}

// ============================================================================
// §9  FACTORY FUNCTIONS
// ============================================================================

/**
 * Create an SSE client and return its async iterator directly.
 *
 * @param config SSE client configuration (URL, headers, reconnect, etc.).
 * @returns An async iterable of SSEEvent objects.
 */
export function createSSEStream(config: SSEClientConfig): AsyncIterable<SSEEvent> {
  return new SSEClient(config);
}

/**
 * Create an SSE client that yields typed JSON events.
 *
 * @param config SSE client configuration.
 * @param options Optional reviver and error callback for JSON parsing.
 * @returns An async iterable of typed JSON events.
 */
export function createJSONSSEStream<T>(
  config: SSEClientConfig,
  options: {
    reviver?: Parameters<typeof JSON.parse>[1];
    onError?: (err: unknown, evt: SSEEvent) => void;
  } = {},
): AsyncIterable<JSONSSEEvent<T>> {
  return jsonSSE<T>(new SSEClient(config), options);
}

/**
 * Create an SSE server response with a generator function.
 * The generator yields events; when it returns, the stream closes.
 *
 * @param generator Function that receives an SSEServerResponse to send events.
 * @param headers Additional HTTP headers for the Response.
 * @returns An HTTP Response with content-type text/event-stream.
 */
export function createSSEResponse(
  this: void,
  generator: (sse: SSEServerResponse) => Promise<void> | void,
  headers: Record<string, string> = {},
): Response {
  const sse = new SSEServerResponse();

  // Run generator async, close stream when done
  // Wrap in async function so synchronous throws are caught before returning
  (async () => {
    try {
      await generator(sse);
    } catch (err) {
      console.error("[sse] Generator error:", err);
    }
    sse.close();
  })();

  return sse.toResponse(headers);
}

/**
 * Parse a raw SSE text string into an array of events.
 * Useful for testing and offline parsing.
 *
 * @param text Raw SSE response body as a string.
 * @returns An array of parsed SSEEvent objects.
 */
export function parseSSEText(text: string): SSEEvent[] {
  const parser = new SSEParser();
  const events = parser.feed(text);
  const final = parser.flush();
  if (final) events.push(final);
  return events;
}

// ============================================================================
// §10  UTILITIES
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
