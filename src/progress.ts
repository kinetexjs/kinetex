/**
 * progress.ts
 *
 * upload/download progress tracking.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Upload progress via ReadableStream wrapping
 *  - Download progress via Response body interception
 *  - Byte-level tracking (loaded, total, percent)
 *  - Transfer rate calculation (bytes/sec, smoothed EMA)
 *  - ETA estimation
 *  - Throttled callbacks (max N calls per second)
 *  - Pause / resume support
 *  - Multi-part upload progress aggregation
 *  - Chunked transfer support (unknown total)
 *  - Progress for fetch, XHR (browser), and Node.js streams
 *  - AbortSignal integration
 *  - Async iterator interface
 *  - Readable progress formatting (human-readable bytes, speed)
 */

// ============================================================================
// §1  TYPES
// ============================================================================

export interface ProgressSnapshot {
  /** Bytes transferred so far */
  loaded: number;
  /** Total bytes (null if unknown — e.g. chunked transfer) */
  total: number | null;
  /** Completion percentage 0–100, null if total is unknown */
  percent: number | null;
  /** Current transfer rate in bytes/sec (EMA-smoothed) */
  rate: number;
  /**
   * Estimated time remaining in ms (null if rate is 0 or total unknown).
   * Formula: ((total - loaded) / rate) * 1000 — bytes/sec converted to ms.
   */
  eta: number | null;
  /** Elapsed time in ms */
  elapsed: number;
  /** Whether the transfer is complete */
  done: boolean;
}

export interface ProgressOptions {
  /** Called on every progress update */
  onProgress?: (snapshot: ProgressSnapshot) => void;
  /** Max times onProgress is called per second. 0 = every chunk. Default: 10 */
  throttleHz?: number;
  /** EMA smoothing factor 0–1. Higher = more responsive, lower = smoother. Default: 0.3 */
  smoothingFactor?: number;
  /** AbortSignal */
  signal?: AbortSignal;
}

export interface MultiPartProgress {
  parts: ProgressSnapshot[];
  overall: ProgressSnapshot;
}

// ============================================================================
// §2  PROGRESS TRACKER
// ============================================================================

/**
 * Tracks byte-level progress for uploads and downloads.
 *
 * Provides real-time snapshots of loaded bytes, transfer rate (EMA-smoothed),
 * ETA, elapsed time, and completion status. Supports throttled callbacks,
 * pause/resume semantics, and AbortSignal integration.
 *
 * @example
 * ```ts
 * const tracker = new ProgressTracker(1_000_000, {
 *   onProgress: (snap) => console.log(`${snap.percent}%`),
 * });
 * tracker.update(512_000);
 * tracker.complete();
 * ```
 */
export class ProgressTracker {
  private loaded = 0;
  private readonly total: number | null;
  private readonly startMs: number;
  private lastMs: number;
  private lastLoaded = 0;
  private smoothedRate = 0;
  private readonly smoothing: number;
  private _done = false;

  // Throttle state.
  //
  // `-Infinity` rather than 0: the gate is `now - lastEmitMs >= minIntervalMs`
  // and `now` comes from `performance.now()`, which is time since *process*
  // start. With a 0 baseline the very first update passes only once the
  // process has been alive for a full interval, so for the first second of
  // any CLI or serverless invocation **no progress event was emitted at all**.
  // A transfer starting at t=200 ms and finishing at t=800 ms reported
  // nothing but the forced final snapshot — a progress bar that never moves.
  private lastEmitMs = -Infinity;
  private readonly minIntervalMs: number;
  private readonly onProgress: ((s: ProgressSnapshot) => void) | null;

  constructor(total: number | null, options: ProgressOptions = {}) {
    this.total = total;
    this.startMs = perfNow();
    this.lastMs = this.startMs;
    this.smoothing = options.smoothingFactor ?? 0.3;
    this.onProgress = options.onProgress ?? null;

    const hz = options.throttleHz ?? 10;
    this.minIntervalMs = hz > 0 ? 1000 / hz : 0;
  }

  /**
   * Record a new chunk of bytes transferred.
   *
   * @param bytes Number of bytes received/sent in this chunk (ADDED to running total)
   * @returns Current progress snapshot
   *
   * @example
   * ```ts
   * tracker.update(1024);  // loaded = 1024
   * tracker.update(2048);  // loaded = 3072
   * ```
   */
  update(bytes: number): ProgressSnapshot {
    this.loaded += bytes;
    const snapshot = this._snapshot();

    if (this.onProgress) {
      const now = perfNow();
      if (this.minIntervalMs === 0 || now - this.lastEmitMs >= this.minIntervalMs) {
        this.lastEmitMs = now;
        this.onProgress(snapshot);
      }
    }

    return snapshot;
  }

  /** Mark transfer as complete. Emits final snapshot regardless of throttle. */
  complete(): ProgressSnapshot {
    this._done = true;
    const snap = this._snapshot();
    this.onProgress?.(snap);
    return snap;
  }

  /** Get current snapshot without updating. */
  snapshot(): ProgressSnapshot {
    return this._snapshot();
  }

  /** Total number of bytes transferred so far. */
  get bytesLoaded(): number {
    return this.loaded;
  }
  /** Whether the transfer has been marked complete. */
  get isDone(): boolean {
    return this._done;
  }

  private _snapshot(): ProgressSnapshot {
    const now = perfNow();
    const elapsed = now - this.startMs;
    const delta = now - this.lastMs;

    // EMA rate smoothing
    if (delta > 0) {
      const instantRate = ((this.loaded - this.lastLoaded) / delta) * 1000;
      this.smoothedRate =
        this.smoothedRate === 0
          ? instantRate
          : this.smoothedRate * (1 - this.smoothing) + instantRate * this.smoothing;
      this.lastMs = now;
      this.lastLoaded = this.loaded;
    }

    // Clamped at BOTH ends. The upper clamp was there; a negative chunk — a
    // caller bug, or a Content-Length revised downward mid-transfer — put
    // `percent` below zero and every progress line rendered "(-50.0%)". A
    // running total of transferred bytes cannot be meaningfully negative, so
    // the ratio is bounded to [0, 100].
    const percent =
      this.total !== null && this.total > 0
        ? Math.min(100, Math.max(0, (this.loaded / this.total) * 100))
        : null;

    const eta =
      this.total !== null && this.smoothedRate > 0
        ? Math.max(0, ((this.total - this.loaded) / this.smoothedRate) * 1000)
        : null;

    return {
      loaded: this.loaded,
      total: this.total,
      percent: this._done ? (this.total !== null ? 100 : null) : percent,
      rate: this.smoothedRate,
      eta: this._done ? 0 : eta,
      elapsed,
      done: this._done,
    };
  }
}

/** Result of {@link withUploadProgress} and {@link withBlobUploadProgress}. */
export interface WithUploadProgressResult {
  /** Body stream wrapped with upload progress tracking. */
  stream: ReadableStream<Uint8Array>;
  /** ProgressTracker that records bytes uploaded. */
  tracker: ProgressTracker;
}

/** Result of {@link withDownloadProgress}. */
export interface WithDownloadProgressResult {
  /** Response whose body has been intercepted for download progress tracking. */
  response: Response;
  /** ProgressTracker that records bytes downloaded. */
  tracker: ProgressTracker;
}

/** A value yielded by the {@link streamWithProgress} async generator. */
export interface StreamWithProgressValue {
  /** Chunk of bytes read from the source stream. */
  chunk: Uint8Array;
  /** Progress snapshot at this point in the transfer. */
  progress: ProgressSnapshot;
}

/** Result of {@link collectStream}. */
export interface CollectStreamResult {
  /** All stream data concatenated into a single buffer. */
  data: Uint8Array;
  /** ProgressTracker that recorded bytes during collection. */
  tracker: ProgressTracker;
}

// ============================================================================
// §3  UPLOAD PROGRESS — ReadableStream wrapping
// ============================================================================

/**
 * Wrap a ReadableStream (or BodyInit) to track upload progress.
 *
 * @param body The request body — ReadableStream, Uint8Array, string, or null.
 * @param total Total bytes to upload (null if unknown).
 * @param options Progress options (onProgress, throttle, signal, etc.).
 * @returns An object with a tracked `stream` and the underlying `tracker`.
 */
export function withUploadProgress(
  body: ReadableStream<Uint8Array> | Uint8Array | string | null,
  total: number | null,
  options: ProgressOptions = {},
): WithUploadProgressResult {
  const tracker = new ProgressTracker(total, options);

  if (!body) {
    tracker.complete();
    return {
      stream: new ReadableStream({ start: (c) => c.close() }),
      tracker,
    };
  }

  // Normalize body to ReadableStream<Uint8Array>
  let source: ReadableStream<Uint8Array>;

  if (body instanceof ReadableStream) {
    source = body;
  } else if (typeof body === "string") {
    const encoded = new TextEncoder().encode(body);
    source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
  } else {
    // Uint8Array
    source = new ReadableStream({
      start(controller) {
        controller.enqueue(body as Uint8Array);
        controller.close();
      },
    });
  }

  // PULL-BASED, not start()-based. The old implementation drained the whole
  // source inside start(), enqueueing every chunk before the transport read a
  // single byte — a large upload was fully buffered in memory and the
  // ReadableStream highWaterMark bought nothing. pull() reads one chunk per
  // demand, so backpressure reaches the source.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let onUploadAbort: (() => void) | null = null;
  // Distinguishes an end-of-stream from a cancellation, which a pending
  // `read()` reports identically. `withDownloadProgress` already kept this
  // flag; without it here, aborting an upload ran the `done` branch below —
  // `tracker.complete()` and `controller.close()` — on the path that was
  // aborting, so the transfer was still announced as finished and 100% done
  // even after removing the `complete()` from the abort handler itself.
  let aborted = false;

  const detach = (): void => {
    if (onUploadAbort) {
      options.signal?.removeEventListener("abort", onUploadAbort);
      onUploadAbort = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Handle already-aborted signal immediately
      if (options.signal?.aborted) {
        controller.error(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      reader = source.getReader();
      onUploadAbort = () => {
        if (aborted) return;
        aborted = true;
        const r = reader;
        reader = null;
        void r?.cancel("aborted").catch(() => {});
        // The tracker is deliberately NOT completed here. `complete()` reports
        // `done: true` and, because `done` is what forces the final percent,
        // `percent: 100`: an upload aborted 10 bytes into a 100-byte body was
        // announced to every `onProgress` listener as a finished, 100%-complete
        // transfer. The caller learns the real outcome from the AbortError the
        // stream is errored with, which is the same contract
        // `withDownloadProgress` already followed on abort.
        controller.error(new DOMException("Upload aborted", "AbortError"));
      };
      // Removed in detach() on close/cancel/error so repeated uploads sharing
      // one signal do not accumulate listeners (leak fix).
      options.signal?.addEventListener("abort", onUploadAbort, { once: true });
    },
    async pull(controller) {
      // Captured once, before the await. The abort handler nulls the shared
      // `reader` while a read is pending, and re-reading the variable after
      // the await meant `releaseLock()` below dereferenced `null`.
      const r = reader;
      if (!r) return;
      try {
        const { done, value } = await r.read();
        if (done) {
          detach();
          if (reader === r) reader = null;
          r.releaseLock();
          // `done` here can just as well mean "cancelled by the abort
          // handler", in which case the stream is already errored and the
          // transfer must not be reported as a completed one.
          if (!aborted) {
            tracker.complete();
            controller.close();
          }
          return;
        }
        tracker.update(value.byteLength);
        controller.enqueue(value);
      } catch (err) {
        detach();
        if (reader === r) reader = null;
        if (!aborted) tracker.complete();
        controller.error(err);
      }
    },
    cancel(reason) {
      detach();
      const r = reader;
      reader = null;
      void r?.cancel(reason).catch(() => {});
    },
  });

  return { stream, tracker };
}

/**
 * Wrap a Blob/File for upload with progress tracking.
 *
 * @param blob The Blob or File to upload.
 * @param options Progress options (onProgress, throttle, signal, etc.).
 * @returns An object with a tracked `stream` and the underlying `tracker`.
 */
export function withBlobUploadProgress(
  blob: Blob,
  options: ProgressOptions = {},
): WithUploadProgressResult {
  return withUploadProgress(blob.stream() as ReadableStream<Uint8Array>, blob.size, options);
}

// ============================================================================
// §4  DOWNLOAD PROGRESS — Response body interception
// ============================================================================

/**
 * Intercept a fetch Response body to track download progress.
 *
 * @param response The original fetch Response.
 * @param options Progress options (onProgress, throttle, signal, etc.).
 * @returns An object with a tracked `response` and the underlying `tracker`.
 */
export function withDownloadProgress(
  response: Response,
  options: ProgressOptions = {},
): WithDownloadProgressResult {
  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const tracker = new ProgressTracker(isNaN(total as number) ? null : total, options);

  if (!response.body) {
    tracker.complete();
    return { response, tracker };
  }

  const body = response.body;

  // PULL-BASED for the same reason as withUploadProgress: the start()-based
  // version buffered the entire download in memory before the consumer read it.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let aborted = false;
  let onAbort: (() => void) | null = null;

  const detach = (): void => {
    if (onAbort) {
      options.signal?.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  };

  const trackedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.signal?.aborted) {
        aborted = true;
        controller.error(new DOMException("Download aborted", "AbortError"));
        return;
      }
      reader = body.getReader();
      onAbort = () => {
        if (aborted) return;
        aborted = true;
        const r = reader;
        reader = null;
        // Ensure tracker knows we're aborting (don't wait for complete)
        void r?.cancel("aborted").catch(() => {});
        controller.error(new DOMException("Download aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      // Captured before the await, for the same reason as the upload wrapper:
      // the abort handler nulls the shared `reader` while a read is pending.
      const r = reader;
      if (!r) return;
      try {
        const { done, value } = await r.read();
        if (done) {
          detach();
          if (reader === r) reader = null;
          r.releaseLock();
          // Ensure tracker is marked as complete even on error
          if (!aborted) {
            tracker.complete();
          }
          controller.close();
          return;
        }
        tracker.update(value.byteLength);
        controller.enqueue(value);
      } catch (err) {
        detach();
        if (reader === r) reader = null;
        // Ensure tracker is marked as complete even on error
        if (!aborted) {
          tracker.complete();
        }
        controller.error(err);
      }
    },
    cancel(reason) {
      detach();
      const r = reader;
      reader = null;
      void r?.cancel(reason).catch(() => {});
    },
  });

  const trackedResponse = new Response(trackedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // A reconstructed Response reports url === "" and redirected === false, which
  // silently broke anything downstream that reads them. `url` and `redirected`
  // are prototype getters, so shadow them with own properties on the instance.
  for (const prop of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(trackedResponse, prop, {
        value: (response as unknown as Record<string, unknown>)[prop],
        enumerable: true,
        configurable: true,
      });
    } catch {
      /* non-configurable in this runtime — leave the default in place */
    }
  }

  return { response: trackedResponse, tracker };
}

// ============================================================================
// §5  ASYNC ITERATOR INTERFACE
// ============================================================================

/**
 * Iterate over a ReadableStream chunk by chunk, yielding progress snapshots.
 *
 * @param stream The ReadableStream to consume.
 * @param total Total bytes (null if unknown).
 * @param options Progress options (signal, throttleHz, smoothingFactor — but NOT onProgress).
 * @yields {{ chunk: Uint8Array; progress: ProgressSnapshot }}
 * @throws {DOMException} If the stream is aborted via AbortSignal.
 */
export async function* streamWithProgress(
  stream: ReadableStream<Uint8Array>,
  total: number | null,
  options: Omit<ProgressOptions, "onProgress"> = {},
): AsyncGenerator<StreamWithProgressValue> {
  const tracker = new ProgressTracker(total, options);
  const reader = stream.getReader();

  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new DOMException("Stream aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) {
        const progress = tracker.complete();
        // Yield one last snapshot with done=true
        yield { chunk: new Uint8Array(0), progress };
        break;
      }

      const progress = tracker.update(value.byteLength);
      yield { chunk: value, progress };
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collect a ReadableStream to a Uint8Array while tracking progress.
 *
 * @param stream The ReadableStream to collect.
 * @param total Total bytes (null for unknown).
 * @param options Progress options including optional AbortSignal.
 * @returns The concatenated `data` buffer and the underlying `tracker`.
 *
 * **Note:** If the stream is large, consider using streamWithProgress for
 * incremental processing instead of buffering the entire stream in memory.
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  total: number | null,
  options: ProgressOptions = {},
): Promise<CollectStreamResult> {
  const tracker = new ProgressTracker(total, options);
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  // Handle already-aborted signal
  if (options.signal?.aborted) {
    reader.cancel("aborted").catch(() => {});
    reader.releaseLock();
    throw new DOMException("Stream aborted", "AbortError");
  }

  // An abort has to REJECT, not merely stop the reads.
  //
  // `reader.cancel()` resolves the pending `read()` with `{ done: true }`,
  // which is indistinguishable from an ordinary end-of-stream: the loop broke
  // out, `tracker.complete()` ran, and the truncated buffer was returned as a
  // successful result. A caller collecting a 100-byte body under an abort that
  // arrived after 3 bytes got `data: 3 bytes, isDone: true` and no error, so
  // the partial body was stored as if it were the whole one. The sibling API
  // `streamWithProgress` throws `AbortError` for exactly this case, so the two
  // disagreed about the same event.
  let aborted = false;

  // Register abort handler (removed in the finally below — leak fix)
  const abortHandler = () => {
    aborted = true;
    reader.cancel("aborted").catch(() => {});
  };
  if (options.signal) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      // Once the abort handler has cancelled the reader, this read — including
      // one already in flight — resolves `{ done: true }`, so the loop always
      // breaks and the check below is reached. There is no path that skips it.
      if (done) break;
      chunks.push(value);
      tracker.update(value.byteLength);
    }
    // `done` above can equally mean "cancelled by the abort handler".
    if (aborted) throw new DOMException("Stream aborted", "AbortError");
  } finally {
    reader.releaseLock();
    options.signal?.removeEventListener("abort", abortHandler);
  }

  tracker.complete();

  // Concatenate chunks
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { data: result, tracker };
}

// ============================================================================
// §6  MULTI-PART UPLOAD AGGREGATOR
// ============================================================================

/**
 * Aggregates progress from multiple simultaneous uploads (e.g., multipart POST).
 *
 * Tracks each part independently and provides an overall snapshot combining all parts.
 * When some parts complete before others, getOverall() sums the loaded bytes and rates
 * from all parts to produce a unified progress view.
 *
 * @example
 * ```ts
 * const agg = new MultiPartProgressAggregator(3, (overall) => {
 *   console.log(`Overall: ${overall.overall.percent}%`);
 * });
 *
 * const tracker1 = agg.createPartTracker(0, 1000000);
 * const tracker2 = agg.createPartTracker(1, 1000000);
 * const tracker3 = agg.createPartTracker(2, 1000000);
 *
 * tracker1.update(500000); // 50% of part 1
 * console.log(agg.getOverall().overall.percent); // ~16.7%
 * ```
 */
export class MultiPartProgressAggregator {
  private readonly trackers: Map<number, ProgressTracker> = new Map();
  private readonly totals: Map<number, number> = new Map();
  private readonly onOverall: ((snapshot: MultiPartProgress) => void) | null;

  constructor(
    private readonly partCount: number,
    onOverall?: (snapshot: MultiPartProgress) => void,
  ) {
    this.onOverall = onOverall ?? null;
  }

  /**
   * Create or retrieve a ProgressTracker for a specific part.
   *
   * @param partIndex Zero-based index of this part.
   * @param partSize Total size of this part in bytes.
   * @param options Per-part progress options (onProgress, throttle, signal, etc.).
   * @returns A ProgressTracker instance for this part.
   */
  createPartTracker(
    partIndex: number,
    partSize: number,
    options: ProgressOptions = {},
  ): ProgressTracker {
    // "Create or retrieve", as this method documents itself. It always
    // created: a second call for the same index built a fresh tracker and
    // overwrote the stored one, so the bytes already recorded for that part
    // were silently discarded and the aggregate fell back to 0 — a caller
    // re-acquiring a tracker it had lost a handle to erased the part's
    // progress rather than recovering it. The first call's `partSize` wins,
    // because changing it would restate a total the bytes were counted
    // against.
    const existing = this.trackers.get(partIndex);
    if (existing) return existing;

    this.totals.set(partIndex, partSize);

    const tracker = new ProgressTracker(partSize, {
      ...options,
      onProgress: (snap) => {
        options.onProgress?.(snap);
        this._emit();
      },
    });

    this.trackers.set(partIndex, tracker);
    return tracker;
  }

  /**
   * Aggregate progress across all parts into a single MultiPartProgress snapshot.
   *
   * @returns The individual per-part snapshots plus a computed overall snapshot.
   */
  getOverall(): MultiPartProgress {
    const parts: ProgressSnapshot[] = [];
    let totalLoaded = 0;
    let totalBytes = 0;
    let totalRate = 0;
    let allDone = true;
    let maxElapsed = 0;

    for (let i = 0; i < this.partCount; i++) {
      const tracker = this.trackers.get(i);
      const snap = tracker?.snapshot() ?? {
        loaded: 0,
        total: this.totals.get(i) ?? null,
        percent: 0,
        rate: 0,
        eta: null,
        elapsed: 0,
        done: false,
      };
      parts.push(snap);
      totalLoaded += snap.loaded;
      if (snap.total !== null) totalBytes += snap.total;
      totalRate += snap.rate;
      if (!snap.done) allDone = false;
      if (snap.elapsed > maxElapsed) maxElapsed = snap.elapsed;
    }

    const hasTotal = totalBytes > 0;
    // Bounded at BOTH ends, for the same reason `ProgressTracker._snapshot`
    // bounds its own: a negative chunk — a caller bug, or a `Content-Length`
    // revised downward mid-transfer — put the aggregate below zero and
    // rendered "(-50.0%)". The tracker was clamped in an earlier round and
    // the aggregate that sums the same snapshots was not, so the overall view
    // was the one place the fix did not reach.
    const percent = hasTotal ? Math.max(0, Math.min(100, (totalLoaded / totalBytes) * 100)) : null;
    const eta =
      hasTotal && totalRate > 0
        ? Math.max(0, ((totalBytes - totalLoaded) / totalRate) * 1000)
        : null;

    // Use the max elapsed time across all parts as overall elapsed
    const overall: ProgressSnapshot = {
      loaded: totalLoaded,
      total: hasTotal ? totalBytes : null,
      percent,
      rate: totalRate,
      eta: allDone ? 0 : eta,
      elapsed: maxElapsed,
      done: allDone,
    };

    return { parts, overall };
  }

  private _emit(): void {
    if (!this.onOverall) return;
    this.onOverall(this.getOverall());
  }
}

// ============================================================================
// §7  BROWSER XHR PROGRESS (when fetch doesn't support upload progress)
// ============================================================================

/**
 * Options for {@link xhrFetch} — upload/download progress with XMLHttpRequest.
 */
export interface XHRProgressOptions {
  /** Called on upload progress updates */
  onUploadProgress?: (snap: ProgressSnapshot) => void;
  /** Called on download progress updates */
  onDownloadProgress?: (snap: ProgressSnapshot) => void;
  /** AbortSignal to cancel the request */
  signal?: AbortSignal;
  /** Max callbacks per second (default: 10) */
  throttleHz?: number;
  /** EMA smoothing factor 0–1 (default: 0.3) */
  smoothingFactor?: number;
}

/**
 * Result of an {@link xhrFetch} call.
 */
export interface XHRResult {
  /** HTTP status code (e.g. 200) */
  status: number;
  /** HTTP status text (e.g. "OK") */
  statusText: string;
  /** Lowercased response headers */
  headers: Record<string, string>;
  /** Response body as text */
  body: string;
}

/**
 * XMLHttpRequest-based fetch with upload AND download progress.
 * Use when fetch() doesn't support upload progress (most browsers).
 */
// Ambient declarations for XHR globals — present in browsers, absent in Deno/Node.
// We use runtime checks (typeof XMLHttpRequest === "undefined") to guard all usage.
type XMLHttpRequestResponseType = "" | "arraybuffer" | "blob" | "document" | "json" | "text";

// Runtime value access for XMLHttpRequest (browser-only, absent in Deno/Node)
type _XHRProgressEvent = { loaded: number; total: number };
type _XHRLoadEvent = { total: number };
type _XMLHttpRequestUpload = {
  onprogress: ((e: _XHRProgressEvent) => void) | null;
  onloadstart: ((e: _XHRLoadEvent) => void) | null;
  addEventListener(type: string, listener: (e: unknown) => void): void;
};
type _XMLHttpRequest = {
  open(method: string, url: string, async?: boolean): void;
  send(body?: string | Blob | FormData | URLSearchParams | ArrayBuffer | null): void;
  setRequestHeader(name: string, value: string): void;
  abort(): void;
  addEventListener<T = unknown>(type: string, listener: (e: T) => void): void;
  readonly readyState: number;
  readonly status: number;
  readonly statusText: string;
  readonly response: unknown;
  readonly responseText: string;
  responseType: XMLHttpRequestResponseType;
  withCredentials: boolean;
  timeout: number;
  readonly upload: _XMLHttpRequestUpload;
  onreadystatechange: (() => void) | null;
  onload: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  onprogress: ((e: _XHRProgressEvent) => void) | null;
  onloadstart: ((e: _XHRLoadEvent) => void) | null;
  getResponseHeader(name: string): string | null;
  getAllResponseHeaders(): string;
};
const _XHR = (globalThis as Record<string, unknown>)["XMLHttpRequest"] as
  (new () => _XMLHttpRequest) | undefined;

/**
 * Fetch implementation using XMLHttpRequest for browsers that don't support
 * fetch with upload progress.
 *
 * When to use xhrFetch vs withUploadProgress:
 *
 * | Scenario | Use |
 * |----------|-----|
 * | Modern browsers (Chrome 72+, Firefox 70+, Safari 15+) | withUploadProgress |
 * | Need upload progress in older browsers | xhrFetch |
 * | Uploading to servers that require XHR semantics | xhrFetch |
 * | Already using fetch-based code | withUploadProgress |
 *
 * Note: xhrFetch uses XMLHttpRequest which is browser-only and will throw
 * in Node.js, Deno, Bun, or other non-browser runtimes.
 */
export function xhrFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Blob | FormData | URLSearchParams | ArrayBuffer | null;
    responseType?: XMLHttpRequestResponseType;
  } & XHRProgressOptions,
): Promise<XHRResult> {
  return new Promise((resolve, reject) => {
    // XHR is browser-only
    if (!_XHR) {
      reject(new Error("XMLHttpRequest is not available in this runtime. Use fetch() instead."));
      return;
    }

    // `XHRResult.body` is a string, but `responseType` is typed with the whole
    // XHR enum — and everything outside "" / "text" hands back a parsed value
    // rather than text. `String(xhr.response)` turned an ArrayBuffer, a Blob
    // and a parsed JSON object alike into the literal string
    // "[object Object]", which is indistinguishable from a body and is not one:
    // the upload path is the reason this function exists, and a binary
    // response came back as seven characters of nothing. Refused here, before
    // anything is constructed, so the request is never opened.
    if (options.responseType && options.responseType !== "text") {
      reject(
        new TypeError(
          `xhrFetch: responseType "${options.responseType}" cannot produce a text body. ` +
            `XHRResult.body is a string — use "text", or omit responseType.`,
        ),
      );
      return;
    }

    const xhr = new _XHR!();
    const uploadTracker = new ProgressTracker(null, {
      ...(options.onUploadProgress !== undefined ? { onProgress: options.onUploadProgress } : {}),
      ...(options.throttleHz !== undefined ? { throttleHz: options.throttleHz } : {}),
      ...(options.smoothingFactor !== undefined
        ? { smoothingFactor: options.smoothingFactor }
        : {}),
    });
    const downloadTracker = new ProgressTracker(null, {
      ...(options.onDownloadProgress !== undefined
        ? { onProgress: options.onDownloadProgress }
        : {}),
      ...(options.throttleHz !== undefined ? { throttleHz: options.throttleHz } : {}),
      ...(options.smoothingFactor !== undefined
        ? { smoothingFactor: options.smoothingFactor }
        : {}),
    });

    xhr.open(options.method ?? "GET", url, true);

    // Set headers
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(k, v);
    }

    if (options.responseType) xhr.responseType = options.responseType;

    // Upload progress
    if (xhr.upload && options.onUploadProgress) {
      (xhr.upload.addEventListener as (t: string, fn: (e: ProgressEvent) => void) => void)(
        "loadstart",
        (_e: ProgressEvent) => {
          // Note: Would like to set tracker total from e.total, but ProgressTracker.total is readonly
          // This is a known limitation - tracker works with null total
        },
      );
      (xhr.upload.addEventListener as (t: string, fn: (e: ProgressEvent) => void) => void)(
        "progress",
        (e: ProgressEvent) => {
          uploadTracker.update(e.loaded - uploadTracker.bytesLoaded);
        },
      );
      xhr.upload.addEventListener("load", () => uploadTracker.complete());
    }

    // Download progress
    if (options.onDownloadProgress) {
      xhr.addEventListener("progress", (e: ProgressEvent) => {
        downloadTracker.update(e.loaded - downloadTracker.bytesLoaded);
      });
    }

    // Abort signal. The listener is detached on settle: with `{ once: true }`
    // it only self-removes when it actually fires, so a caller reusing one
    // signal across many xhrFetch calls accumulated listeners — and each one
    // kept the whole XHR + promise closures alive after the request finished.
    const onAbort = () => {
      xhr.abort();
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const detach = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      detach();
      onAbort();
      return;
    }

    xhr.addEventListener("load", () => {
      detach();
      downloadTracker.complete();

      // Parse response headers
      const rawHeaders = xhr.getAllResponseHeaders();
      const headers: Record<string, string> = {};
      for (const line of rawHeaders.split(/[\r\n]+/)) {
        // Split on the colon, not on `": "`. The separator is the *last* space
        // before the value, so `trim()` first stripped the single space of an
        // empty value — `"X-Empty: \r\n"` became `"X-Empty:"`, the search
        // for `": "` missed it, and the header was dropped. A response whose
        // headers were all empty-valued normalized to `{}`.
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        if (name === "") continue;
        const value = line.slice(idx + 1).trim();
        // `__proto__` is a legal header name; a [[Set]] would send it to the
        // inherited setter, which ignores a primitive, and the header would
        // vanish rather than overwrite anything.
        if (name === "__proto__") {
          Object.defineProperty(headers, name, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          continue;
        }
        headers[name] = value;
      }

      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
        body: typeof xhr.response === "string" ? xhr.response : String(xhr.response ?? ""),
      });
    });

    xhr.addEventListener("error", () => {
      detach();
      reject(new TypeError("Network request failed"));
    });

    xhr.addEventListener("timeout", () => {
      detach();
      reject(new TypeError("Request timed out"));
    });

    xhr.addEventListener("abort", () => {
      // Covers aborts initiated from inside the XHR (not via the signal).
      detach();
      reject(new DOMException("Request aborted", "AbortError"));
    });

    try {
      xhr.send(options.body ?? null);
    } catch (err) {
      // A body the implementation refuses — an invalid state, a type it will
      // not put on the wire — throws straight out of the executor. The promise
      // rejects with it, so the caller sees an error, but every handler above
      // had already been wired and none of them runs on this path: the
      // signal's `abort` listener stayed attached, holding this XHR and these
      // closures alive for as long as the caller keeps the signal. The detach
      // that every other exit performs happens here too.
      detach();
      throw err;
    }
  });
}

// ============================================================================
// §8  FORMATTING UTILITIES
// ============================================================================

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * Format bytes as a human-readable string.
 * e.g. 1_234_567 → "1.18 MB"
 *
 * @param bytes The byte count.
 * @param decimals Number of decimal places (default: 2).
 * @returns Formatted string (e.g. "1.18 MB").
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (Number.isNaN(bytes)) return "NaN B";
  if (bytes === Infinity) return "∞";
  if (bytes === -Infinity) return "-∞";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sign = bytes < 0 ? "-" : "";
  const mag = Math.abs(bytes);
  // Clamp the unit index into range. Math.log(0.5) / Math.log(1024) floors to
  // -1, and Math.log of a negative or NaN is NaN — either one indexed past the
  // end of UNITS and rendered "512 undefined" or "NaN undefined". A transfer
  // rate below 1 byte/s is ordinary on a slow link, so formatRate — and with
  // it every progress line — was affected.
  const i = Math.min(Math.max(0, Math.floor(Math.log(mag) / Math.log(k))), UNITS.length - 1);
  const unit = UNITS[i]!;
  return `${sign}${parseFloat((mag / Math.pow(k, i)).toFixed(dm))} ${unit}`;
}

/**
 * Format a transfer rate as human-readable bytes/sec.
 * e.g. 1_048_576 → "1.00 MB/s"
 *
 * @param bytesPerSec Transfer rate in bytes per second.
 * @returns Formatted string (e.g. "1.00 MB/s").
 */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Format ETA in ms as a human-readable duration.
 * e.g. 90_000 → "1m 30s"
 *
 * @param ms ETA in milliseconds.
 * @returns Formatted duration (e.g. "1m 30s" or "∞" for infinite/NaN).
 */
export function formatETA(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "∞";
  const secs = Math.round(ms / 1000);
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const s = secs % 60;

  if (hours > 0) return `${hours}h ${mins}m ${s}s`;
  if (mins > 0) return `${mins}m ${s}s`;
  return `${s}s`;
}

/**
 * Build a human-readable progress string.
 *
 * Output format: "{loaded} / {total} ({percent}) @ {rate} ETA {eta}"
 * Example: "488.28 KB / 976.56 KB (50.0%) @ 97.66 KB/s ETA 5s"
 *
 * @param snap Progress snapshot
 * @returns Formatted progress string
 *
 * @example
 * ```ts
 * console.log(formatProgress(tracker.snapshot()));
 * // "1.23 MB / 10.00 MB (12.3%) at 5.67 MB/s ETA 1m 32s"
 * ```
 */
export function formatProgress(snap: ProgressSnapshot): string {
  const loaded = formatBytes(snap.loaded);
  const total = snap.total !== null ? ` / ${formatBytes(snap.total)}` : "";
  const pct = snap.percent !== null ? ` (${snap.percent.toFixed(1)}%)` : "";
  const rate = snap.rate > 0 ? ` @ ${formatRate(snap.rate)}` : "";
  const eta = snap.eta !== null && !snap.done ? ` ETA ${formatETA(snap.eta)}` : "";
  return `${loaded}${total}${pct}${rate}${eta}`;
}

// ============================================================================
// §9  THROTTLE HELPER
// ============================================================================

/**
 * Create a throttled version of a progress callback.
 *
 * This is a standalone throttle helper, different from the built-in throttle
 * in ProgressTracker (which uses per-tracker throttling). Use this when you
 * need to throttle progress across multiple trackers or when using the tracker
 * without the built-in callback.
 *
 * @param fn The callback to throttle
 * @param hz Maximum calls per second (default: 10)
 * @returns Throttled callback that always emits when snap.done is true
 *
 * @example
 * ```ts
 * const throttled = throttleProgress((snap) => {
 *   console.log(`${snap.percent}%`);
 * }, 5); // max 5 calls per second
 * ```
 */
export function throttleProgress(
  fn: (snap: ProgressSnapshot) => void,
  hz = 10,
): (snap: ProgressSnapshot) => void {
  const minInterval = hz > 0 ? 1000 / hz : 0;
  // See ProgressTracker.lastEmitMs: a 0 baseline measures against process
  // start, so the first call was dropped for the first interval of the
  // process's life.
  let lastCall = -Infinity;

  return (snap: ProgressSnapshot) => {
    const now = perfNow();
    // Always emit final snapshot
    if (snap.done || now - lastCall >= minInterval) {
      lastCall = now;
      fn(snap);
    }
  };
}

// ============================================================================
// §10  UTILITIES
// ============================================================================

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
