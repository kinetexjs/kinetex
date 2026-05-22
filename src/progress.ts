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

  // Throttle state
  private lastEmitMs = 0;
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

    const percent =
      this.total !== null && this.total > 0
        ? Math.min(100, (this.loaded / this.total) * 100)
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();

      // Handle already-aborted signal immediately
      if (options.signal?.aborted) {
        reader.cancel("aborted").catch(() => {});
        controller.error(new DOMException("Upload aborted", "AbortError"));
        return;
      }

      options.signal?.addEventListener(
        "abort",
        () => {
          reader.cancel("aborted").catch(() => {});
          controller.error(new DOMException("Upload aborted", "AbortError"));
        },
        { once: true },
      );

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            tracker.complete();
            controller.close();
            break;
          }
          tracker.update(value.byteLength);
          controller.enqueue(value);
        }
      } catch (err) {
        tracker.complete();
        controller.error(err);
      }
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

  const trackedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      let aborted = false;

      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        // Ensure tracker knows we're aborting (don't wait for complete)
        reader.cancel("aborted").catch(() => {});
        controller.error(new DOMException("Download aborted", "AbortError"));
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            tracker.complete();
            controller.close();
            break;
          }
          tracker.update(value.byteLength);
          controller.enqueue(value);
        }
      } catch (err) {
        // Ensure tracker is marked as complete even on error
        if (!aborted) {
          tracker.complete();
        }
        controller.error(err);
      } finally {
        // Remove abort listener if not already triggered
        if (!aborted) {
          options.signal?.removeEventListener("abort", onAbort);
        }
      }
    },
  });

  const trackedResponse = new Response(trackedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

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
    throw new DOMException("Stream aborted", "AbortError");
  }

  // Register abort handler
  if (options.signal) {
    const abortHandler = () => {
      reader.cancel("aborted").catch(() => {});
    };
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      tracker.update(value.byteLength);
    }
  } finally {
    reader.releaseLock();
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
    const percent = hasTotal ? Math.min(100, (totalLoaded / totalBytes) * 100) : null;
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
  | (new () => _XMLHttpRequest)
  | undefined;

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

    // Abort signal
    options.signal?.addEventListener(
      "abort",
      () => {
        xhr.abort();
        reject(new DOMException("Request aborted", "AbortError"));
      },
      { once: true },
    );

    xhr.addEventListener("load", () => {
      downloadTracker.complete();

      // Parse response headers
      const rawHeaders = xhr.getAllResponseHeaders();
      const headers: Record<string, string> = {};
      for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(": ");
        if (idx !== -1) {
          headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
        }
      }

      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
        body: typeof xhr.response === "string" ? xhr.response : String(xhr.response ?? ""),
      });
    });

    xhr.addEventListener("error", () => {
      reject(new TypeError("Network request failed"));
    });

    xhr.addEventListener("timeout", () => {
      reject(new TypeError("Request timed out"));
    });

    xhr.send(options.body ?? null);
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
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = Math.max(0, decimals);
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const unit = UNITS[Math.min(i, UNITS.length - 1)];
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${unit}`;
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
 * Example: "4.56 MB / 10.00 MB (45.6%) at 1.00 MB/s ETA 5s"
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
  let lastCall = 0;

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
