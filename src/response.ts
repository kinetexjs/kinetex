/**
 * response.ts
 *
 * HTTP response handling and size limiting.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Typed response wrappers (JSON, text, blob, arrayBuffer, stream)
 *  - Response size limiting (hard cap + streaming enforcement)
 *  - Content-type negotiation + validation
 *  - Charset detection + decoding (UTF-8, latin-1, etc.)
 *  - Response cloning + caching
 *  - HTTP error detection + typed error classes
 *  - Decompression (gzip, deflate via DecompressionStream; br via node:zlib on Node.js)
 *  - Response body parsing pipeline
 *  - Streaming response utilities
 *  - Response normalization (platform differences)
 *  - Multipart response parsing
 *  - Server-timing extraction
 *  - Response diffing
 *  - NDJSON (newline-delimited JSON) streaming parser
 */

// Node.js globals accessed via globalThis for cross-runtime compatibility

// Reuse parseContentType from headers.ts to avoid duplicated logic
import { parseContentType as _parseContentType, parseParams as _parseParams } from "./headers.ts";
const parseParams = _parseParams;

// ============================================================================
// §1  TYPES
// ============================================================================

/**
 * A normalized (plain-object) representation of a fetch Response.
 *
 * All header values are lower-cased strings. Useful for logging, serialization,
 * and cross-runtime consistency.
 */
export interface NormalizedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  redirected: boolean;
  ok: boolean;
  bodyUsed: boolean;
}

/**
 * Configuration for limiting the maximum response body size.
 */
export interface SizeLimitConfig {
  /** Maximum response body size in bytes. Throws if exceeded. */
  maxBytes: number;
  /** What to do when limit is exceeded: "throw" | "truncate" | "abort". Default: "throw" */
  onExceed?: "throw" | "truncate" | "abort";
  /** Called when the limit is about to be exceeded (before action). */
  onExceedCallback?: (bytesRead: number, limit: number) => void;
}

/**
 * Options shared across all response parse methods (readJSON, readText, etc.).
 */
export interface ResponseParseOptions {
  /** Expected content-type. Throws if response doesn't match. */
  expectedContentType?: string;
  /** Charset to use for text decoding. Default: from content-type or UTF-8 */
  charset?: string;
  /** Size limit config */
  sizeLimit?: SizeLimitConfig;
  /** If true, decompress body. Default: true */
  decompress?: boolean;
  /** AbortSignal */
  signal?: AbortSignal;
}

// ============================================================================
// §2  HTTP ERROR CLASSES
// ============================================================================

/**
 * Thrown when a response has an HTTP error status (4xx/5xx).
 */
export class HTTPResponseError extends Error {
  /** Human-readable error code. */
  readonly code = "EHTTPRESPONSE";
  /** The HTTP status code. */
  readonly status: number;
  /** The HTTP status text. */
  readonly statusText: string;
  /** The URL of the failed request. */
  readonly url: string;
  /** The normalized response headers. */
  readonly headers: Record<string, string>;
  /** The response body, or null if not read. */
  readonly body: string | null;

  constructor(
    status: number,
    statusText: string,
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ) {
    super(`HTTP ${status} ${statusText} — ${url}`);
    this.name = "HTTPResponseError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  /** Returns true if the status code is a client error (4xx). */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
  /**
   * Returns true if the status code is a server error (5xx).
   *
   * Bounded above, like `isClientError` is at both ends. Unbounded, any
   * status at or past 600 — a non-standard code, or anything a caller invents
   * — reported itself as a server error.
   */
  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }
  /** Returns true if the status is 404 Not Found. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
  /** Returns true if the status is 401 Unauthorized. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** Returns true if the status is 403 Forbidden. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** Returns true if the status is 429 Too Many Requests. */
  get isTooManyRequests(): boolean {
    return this.status === 429;
  }
  /** Returns true if the status is 410 Gone. */
  get isGone(): boolean {
    return this.status === 410;
  }
  /** Returns true if the status is 409 Conflict. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/**
 * Thrown when a response body exceeds the configured size limit.
 */
export class ResponseSizeLimitError extends Error {
  /** Human-readable error code. */
  readonly code = "ESIZELIMIT";
  /** Number of bytes read before hitting the limit. */
  readonly bytesRead: number;
  /** Maximum allowed bytes. */
  readonly limit: number;
  /** The URL of the response. */
  readonly url: string;

  constructor(bytesRead: number, limit: number, url: string) {
    super(
      `Response size limit exceeded: read ${bytesRead} bytes, limit is ${limit} bytes (${url})`,
    );
    this.name = "ResponseSizeLimitError";
    this.bytesRead = bytesRead;
    this.limit = limit;
    this.url = url;
  }
}

/**
 * Thrown when a response's Content-Type does not match the expected type.
 */
export class ContentTypeError extends Error {
  /** Human-readable error code. */
  readonly code = "ECONTENTTYPE";
  /** The expected content type. */
  readonly expected: string;
  /** The actual content type received. */
  readonly received: string;
  /** The URL of the response. */
  readonly url: string;

  constructor(expected: string, received: string, url: string) {
    super(`Expected content-type "${expected}", got "${received}" (${url})`);
    this.name = "ContentTypeError";
    this.expected = expected;
    this.received = received;
    this.url = url;
  }
}

/**
 * Thrown when response body decoding (charset, JSON parse) fails.
 */
export class ResponseDecodeError extends Error {
  /** Human-readable error code. */
  readonly code = "EDECODE";
  /** The character set used for decoding. */
  readonly charset: string;
  /** The URL of the response. */
  readonly url: string;

  constructor(message: string, charset: string, url: string) {
    super(`Failed to decode response as ${charset} (${url}): ${message}`);
    this.name = "ResponseDecodeError";
    this.charset = charset;
    this.url = url;
  }
}

// ============================================================================
// §3  RESPONSE NORMALIZATION
// ============================================================================

/**
 * Normalize a fetch Response headers to a plain object.
 */
// FIX 12: normalizeHeaders centralised in utils.ts.
// FIX (H6): sanitizeParsedJSON strips __proto__/constructor/prototype keys
// from freshly parsed JSON so untrusted payloads cannot pollute prototypes.
import {
  normalizeHeaders as _normalizeHeadersUtil,
  sanitizeParsedJSON as _sanitizeParsedJSON,
} from "./utils.ts";
/** @deprecated use normalizeHeaders from utils.ts directly */
export function normalizeHeaders(headers: Headers): Record<string, string> {
  return _normalizeHeadersUtil(headers);
}

/**
 * Normalize a fetch Response to a NormalizedResponse.
 *
 * @param response The fetch Response to normalize.
 * @returns A plain NormalizedResponse object.
 */
export function normalizeResponse(response: Response): NormalizedResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: normalizeHeaders(response.headers),
    url: response.url,
    redirected: response.redirected,
    ok: response.ok,
    bodyUsed: response.bodyUsed,
  };
}

// ============================================================================
// §4  CONTENT-TYPE UTILITIES
// ============================================================================

/**
 * Parsed components of a Content-Type header value.
 */
export interface ContentTypeInfo {
  mediaType: string;
  type: string;
  subtype: string;
  charset: string | null;
  boundary: string | null;
}

/**
 * Maximum header value length to prevent DoS attacks.
 */
const MAX_HEADER_LENGTH = 8192;

/**
 * Validate and parse a Content-Type header value.
 * More secure against content-type sniffing attacks.
 * Delegates to headers.ts for the actual parsing.
 *
 * @param value The raw Content-Type header string.
 * @returns Parsed ContentTypeInfo, or null if invalid/empty/too long.
 */
export function parseContentType(value: string): ContentTypeInfo | null {
  if (!value) return null;
  if (value.length > MAX_HEADER_LENGTH) return null;
  const parsed = _parseContentType(value);
  if (!parsed) return null;
  return {
    mediaType: parsed.mediaType,
    type: parsed.type,
    subtype: parsed.subtype,
    charset: parsed.charset,
    boundary: parsed.boundary,
  };
}

/**
 * Check whether a Content-Type value represents a JSON response.
 *
 * @param contentType The Content-Type header value (or null).
 * @returns True if the media type is application/json or a +json subtype.
 */
export function isJSON(contentType: string | null): boolean {
  if (!contentType) return false;
  const info = parseContentType(contentType);
  if (!info) return false;
  return info.mediaType === "application/json" || info.subtype.endsWith("+json");
}

/**
 * Check whether a Content-Type value represents a text-based response.
 *
 * @param contentType The Content-Type header value (or null).
 * @returns True if the top-level media type is "text".
 */
export function isText(contentType: string | null): boolean {
  if (!contentType) return false;
  const info = parseContentType(contentType);
  return info?.type === "text";
}

/**
 * Check whether a Content-Type represents binary (neither text nor JSON).
 *
 * @param contentType The Content-Type header value (or null).
 * @returns True if the content is neither text nor JSON.
 */
export function isBinary(contentType: string | null): boolean {
  return !isText(contentType) && !isJSON(contentType);
}

// ============================================================================
// §5  SIZE-LIMITED BODY READER
// ============================================================================

/**
 * One `reader.read()` that also settles when the signal aborts.
 *
 * Checking `signal.aborted` at the top of the read loop is not enough, because
 * the loop only gets another turn when the source produces a chunk or closes.
 * A connection that stalls after its last byte leaves the read pending
 * forever, so the abort was never observed and the promise never settled at
 * all — `readText`/`readJSON`/`readBytes` simply hung, which is the one thing
 * a signal exists to prevent. Racing the signal against the read is what makes
 * an abort actually abort.
 *
 * An aborted read resolves as `{ done: true }` rather than rejecting, so each
 * caller keeps its own established behaviour for an abort: the collecting
 * readers re-check the signal and throw, while the streaming parsers stop
 * iterating. `cancel()` is still issued so the source is released.
 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel("aborted").catch(() => {});
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

/**
 * Normalise the `onExceed` mode, failing closed.
 *
 * The three modes were tested as a chain of `if`s that each ended in a
 * `break`/`return`. A value matching none of them therefore fell straight
 * through to the ordinary "push the chunk" line below and the size limit did
 * nothing at all: `onExceed: "ignore"` against a 10-byte cap returned all
 * 1000 bytes, through both `readBodyWithLimit` and `readText`. That is a
 * fail-open on the guard this option exists to provide, and the config is a
 * plain interface, so a value read from JSON or asserted at a call site
 * reaches it. An unrecognised mode is treated as `"throw"`.
 */
function normaliseOnExceed(mode: SizeLimitConfig["onExceed"]): "throw" | "truncate" | "abort" {
  return mode === "truncate" || mode === "abort" ? mode : "throw";
}

/**
 * Read a ReadableStream with a hard size limit.
 *
 * @param stream The source ReadableStream.
 * @param url The request URL (for error messages).
 * @param limit Size limit configuration (maxBytes, onExceed, callback).
 * @param signal Optional AbortSignal for cancellation.
 * @returns Concatenated bytes within the limit.
 * @throws {ResponseSizeLimitError} If the limit is exceeded (when onExceed = "throw").
 * @throws {DOMException} If the signal fires.
 */
export async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  limit: SizeLimitConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const onExceed = normaliseOnExceed(limit.onExceed);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel("aborted");
        throw new DOMException("Response reading aborted", "AbortError");
      }
      const { done, value } = await readWithAbort(reader, signal);
      if (done) {
        // `done` is also how an aborted read settles (see readWithAbort), so
        // the signal has to be re-checked here or a partial body would be
        // returned as a complete one.
        if (signal?.aborted) {
          throw new DOMException("Response reading aborted", "AbortError");
        }
        break;
      }

      const newTotal = bytesRead + value.byteLength;

      if (newTotal > limit.maxBytes) {
        limit.onExceedCallback?.(newTotal, limit.maxBytes);

        if (onExceed === "throw") {
          await reader.cancel("size limit exceeded");
          throw new ResponseSizeLimitError(newTotal, limit.maxBytes, url);
        }

        if (onExceed === "abort") {
          await reader.cancel("size limit exceeded");
          break;
        }

        if (onExceed === "truncate") {
          const remaining = limit.maxBytes - bytesRead;
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
            bytesRead += remaining;
          }
          break;
        }
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return concatUint8Arrays(chunks);
}

// ============================================================================
// §6  CHARSET DETECTION + DECODING
// ============================================================================

const CHARSET_ALIASES: Record<string, string> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "latin-1": "latin1",
  latin1: "latin1",
  "iso-8859-1": "latin1",
  ascii: "ascii",
  "us-ascii": "ascii",
  "utf-16le": "utf-16le",
  "utf-16": "utf-16le",
  "utf-16be": "utf-16be",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
};

function resolveCharset(charset: string | null): string {
  if (!charset) return "utf-8";
  const key = charset.toLowerCase().trim();
  // Own-property check, not a bare index. `CHARSET_ALIASES` is a plain object
  // literal, so an unrecognised charset naming an `Object.prototype` member
  // resolved to that member instead of falling back: `charset=constructor`
  // reached `TextDecoder` as `function Object() { [native code] }` and
  // `charset=__proto__` as `[object Object]`, either of which throws
  // ERR_ENCODING_NOT_SUPPORTED and fails the whole body with a decode error
  // naming a charset nobody sent. The charset is attacker-controlled — it
  // comes straight off a response header — so that is a denial of service on
  // body parsing, and `__proto__` is the kind of value a scanner fuzzes.
  if (Object.prototype.hasOwnProperty.call(CHARSET_ALIASES, key)) {
    return CHARSET_ALIASES[key]!;
  }
  return "utf-8";
}

/**
 * Detect charset from BOM (byte order mark) in the body.
 */
function detectBOM(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/**
 * Decode bytes to a string with charset detection and fallback.
 *
 * @param bytes The raw bytes to decode.
 * @param charset The charset hint from Content-Type (null = utf-8).
 * @param url The request URL (for error messages).
 * @returns The decoded string.
 * @throws {ResponseDecodeError} If decoding fails even with lenient fallback.
 */
export function decodeBody(bytes: Uint8Array, charset: string | null, url: string): string {
  const detected = detectBOM(bytes);
  const resolved = detected ?? resolveCharset(charset);

  // Strip BOM if present
  const data = detected ? bytes.slice(detected === "utf-8" ? 3 : 2) : bytes;

  try {
    return new TextDecoder(resolved, { fatal: true }).decode(data);
  } catch {
    // Fatal decode failed — try lenient mode
    try {
      return new TextDecoder(resolved, { fatal: false }).decode(data);
    } catch (err2) {
      throw new ResponseDecodeError(String(err2), resolved, url);
    }
  }
}

// ============================================================================
// §7  DECOMPRESSION
// ============================================================================

/**
 * Create a size-limited decompression stream that prevents decompression bomb attacks.
 * Wraps the decompressed stream and enforces a maximum decompressed size.
 */
function createSizeLimitedDecompression(
  stream: ReadableStream<Uint8Array>,
  encoding: string,
  maxDecompressedSize: number = 100_000_000, // 100MB default
): ReadableStream<Uint8Array> {
  // First decompress
  const decompressed = decompressStream(stream, encoding);

  // Then wrap with size limiting
  let bytesRead = 0;
  const sizeLimitTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxDecompressedSize) {
        controller.error(
          new ResponseSizeLimitError(bytesRead, maxDecompressedSize, "decompression"),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return decompressed.pipeThrough(sizeLimitTransform);
}

/**
 * Decompress a ReadableStream using the WHATWG DecompressionStream API.
 *
 * @param stream The compressed ReadableStream.
 * @param encoding The Content-Encoding value (gzip, deflate, br).
 * @returns A decompressed ReadableStream (passes through unchanged for br on non-Node).
 */
export function decompressStream(
  stream: ReadableStream<Uint8Array>,
  encoding: string,
): ReadableStream<Uint8Array> {
  const normalized = encoding.trim().toLowerCase();

  // ── Brotli (br) ──────────────────────────────────────────────────────────
  // WHATWG DecompressionStream does NOT support brotli in any current runtime.
  // On Node.js we use node:zlib.createBrotliDecompress() via a stream adapter.
  // On other runtimes brotli is passed through raw (server should not negotiate
  // br if the client doesn't send Accept-Encoding: br — but if it does, we do
  // our best).
  if (normalized === "br") {
    return brotliDecompressStream(stream);
  }

  // ── zstd ─────────────────────────────────────────────────────────────────
  // `DecompressionStream` has no "zstd" format in Node or the browsers as of
  // this writing, but does in Bun and newer edge runtimes. Prefer it when
  // present, otherwise fall back to node:zlib on Node 22+, and only then give
  // up and pass the bytes through.
  if (normalized === "zstd") {
    return zstdDecompressStream(stream);
  }

  // ── gzip / deflate ────────────────────────────────────────────────────────
  if (typeof DecompressionStream === "undefined") return stream;

  try {
    // CompressionFormat is a browser type, we normalize to it
    // Type assertion is safe as we validated the encoding above
    const format = normalized as "gzip" | "deflate" | "deflate-raw";
    const ds = new DecompressionStream(format);
    // DecompressionStream and TransformStream have compatible pipeThrough signatures
    // in all modern runtimes, but TypeScript doesn't recognize this type compatibility
    // Type assertion is safe here as we've validated the format above
    return stream.pipeThrough(ds as unknown as TransformStream<Uint8Array, Uint8Array>);
  } catch {
    // Unsupported format — return raw (caller sent Accept-Encoding conservatively)
    return stream;
  }
}

/**
 * Decompress a brotli-encoded ReadableStream.
 * Uses node:zlib on Node.js. Returns the stream unchanged on other runtimes.
 */
function brotliDecompressStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  // Non-Node runtime: we cannot decompress brotli natively. Return raw bytes —
  // this will likely cause a parse error downstream, which is the correct
  // behaviour (the server shouldn't have sent br in the first place).
  if (!isNodeRuntime()) return stream;

  return nodeZlibDecompressStream(stream, (zlib) => zlib.createBrotliDecompress());
}

/**
 * True when running on Node.js.
 *
 * Read defensively: `process` does not exist in edge runtimes and reading it
 * through a hostile global can throw.
 */
function isNodeRuntime(): boolean {
  try {
    return (
      typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
        ?.node === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Pipe a web ReadableStream through a `node:zlib` decompressor.
 *
 * @param stream - Compressed input.
 * @param create - Builds the zlib transform from the imported module.
 * @returns The decompressed stream.
 */
function nodeZlibDecompressStream(
  stream: ReadableStream<Uint8Array>,
  create: (zlib: typeof import("node:zlib")) => import("node:stream").Duplex,
): ReadableStream<Uint8Array> {
  // The node stream and the read loop can both try to settle the controller,
  // and `cancel()` settles it too. Whichever arrives second would throw
  // ERR_INVALID_STATE on an already closed controller — an unhandled throw
  // that takes the whole process down, not just the request. Two reachable
  // ways to get there:
  //   * an upstream error rejects `reader.read()`, we error the controller,
  //     and the `br.destroy()` below makes node emit "end" afterwards;
  //   * the consumer cancels (an aborted request), and cancelling the source
  //     makes zlib drain and emit "end" against a closed controller.
  // Neither is exotic — a server aborting a response mid-body, or a client
  // cancelling one, is ordinary traffic on any content-encoding response.
  let settled = false;
  // Hoisted so `cancel()` can reach it: the bridge holds a reader lock for the
  // whole stream, and `ReadableStream.cancel()` rejects with ERR_INVALID_STATE
  // on a locked stream. `reader.cancel()` is the supported way to abort it.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // `start()` awaits the dynamic import before locking the source, so a cancel
  // can land in that window — an immediately-aborted request is the common
  // case, not an edge one. Remember it and apply it once the reader exists.
  let cancelRequested = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Dynamic import so non-Node runtimes never load node:zlib
      const zlib = await import("node:zlib");
      const br = create(zlib);
      reader = stream.getReader();

      if (cancelRequested) {
        // The source may already be gone; there is nothing left to release.
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        reader = null;
        return;
      }

      const settleError = (e: unknown): void => {
        if (settled) return;
        settled = true;
        controller.error(e);
      };

      br.on("data", (chunk: Uint8Array) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      br.on("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      br.on("error", settleError);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            br.end();
            break;
          }
          br.write(value);
        }
      } catch (e) {
        br.destroy(e instanceof Error ? e : new Error(String(e)));
        settleError(e);
      } finally {
        reader.releaseLock();
        reader = null;
      }
    },
    cancel() {
      // Mark settled first: cancelling the reader resolves the loop's pending
      // read as `done`, which ends the zlib transform and emits "end" against
      // an already-closed controller.
      settled = true;
      cancelRequested = true;
      void reader?.cancel().catch(() => undefined);
    },
  });
}

/**
 * Decompress a zstd-encoded ReadableStream.
 *
 * Tries, in order: the standard `DecompressionStream("zstd")` (Bun, newer edge
 * runtimes), then `node:zlib`'s `createZstdDecompress` (Node 22+), then passes
 * the bytes through unchanged. That last case is a genuine failure mode rather
 * than a formality — kinetex does not advertise `zstd` in its default
 * `accept-encoding`, so a server should never choose it, but a caller that sets
 * the header explicitly (or proxies a response through) can still hit it.
 */
function zstdDecompressStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    try {
      // "zstd" is a real CompressionFormat at runtime but is not yet in the
      // TypeScript lib union, so it is asserted here rather than widened.
      const Ctor = DecompressionStream as unknown as new (
        format: string,
      ) => TransformStream<Uint8Array, Uint8Array>;
      return stream.pipeThrough(new Ctor("zstd"));
    } catch {
      // Format not recognised by this runtime — try node:zlib below.
    }
  }

  if (!isNodeRuntime()) return stream;

  // node:zlib gained zstd in Node 22; older versions have no such export.
  return nodeZlibDecompressStream(stream, (zlib) => {
    const create = (zlib as { createZstdDecompress?: () => import("node:stream").Duplex })
      .createZstdDecompress;
    if (typeof create !== "function") {
      throw new Error("zstd decompression is not available in this Node.js version");
    }
    return create();
  });
}

/**
 * Detect and apply decompression based on Content-Encoding header.
 *
 * Supports gzip, deflate, and brotli (Node.js only). For multiple encodings
 * (e.g., "gzip, br"), decompresses in reverse order: first outermost (gzip),
 * then inner (brotli).
 *
 * Uses DecompressionStream in browsers/Deno/Bun/Workers, and node:zlib in Node.js
 * for brotli support.
 *
 * @param stream The incoming ReadableStream (possibly compressed).
 * @param headers The response headers (content-encoding read from here).
 * @returns The decompressed ReadableStream (or original if no encoding).
 */
export function applyDecompression(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): ReadableStream<Uint8Array> {
  const encoding = headers["content-encoding"] ?? headers["Content-Encoding"];
  if (!encoding || encoding === "identity") return stream;

  // Multiple encodings: "gzip, br" — apply in reverse order
  const encodings = encoding
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .reverse();

  let result = stream;
  for (const enc of encodings) {
    result = createSizeLimitedDecompression(result, enc);
  }
  return result;
}

// ============================================================================
// §8  TYPED RESPONSE READERS
// ============================================================================

/**
 * Read a response body as JSON with full parsing pipeline.
 *
 * @param response The fetch Response.
 * @param options Parse options (content-type check, charset, size limit, signal).
 * @returns The parsed JSON value.
 * @throws {ContentTypeError} If expectedContentType is set and doesn't match.
 * @throws {ResponseDecodeError} If JSON parsing fails.
 */
export async function readJSON<T = unknown>(
  response: Response,
  options: ResponseParseOptions = {},
): Promise<T> {
  const headers = normalizeHeaders(response.headers);
  const ct = headers["content-type"] ?? null;
  const url = response.url;

  // Content-type check
  if (options.expectedContentType) {
    validateContentType(ct, options.expectedContentType, url);
  } else if (!isJSON(ct)) {
    // Lenient: try to parse anyway but note the mismatch in error if it fails
  }

  const bytes = await readBodyBytes(response, url, options);
  const charset = options.charset ?? parseContentType(ct ?? "")?.charset ?? null;
  const text = decodeBody(bytes, charset, url);

  try {
    return _sanitizeParsedJSON(JSON.parse(text) as T);
  } catch (err) {
    throw new ResponseDecodeError(`JSON parse failed: ${err}`, "json", url);
  }
}

/**
 * Read a response body as plain text.
 *
 * @param response The fetch Response.
 * @param options Parse options (content-type check, charset, size limit, signal).
 * @returns The decoded text.
 * @throws {ContentTypeError} If expectedContentType is set and doesn't match.
 */
export async function readText(
  response: Response,
  options: ResponseParseOptions = {},
): Promise<string> {
  const headers = normalizeHeaders(response.headers);
  const ct = headers["content-type"] ?? null;
  const url = response.url;

  if (options.expectedContentType) {
    validateContentType(ct, options.expectedContentType, url);
  }

  const bytes = await readBodyBytes(response, url, options);
  const charset = options.charset ?? parseContentType(ct ?? "")?.charset ?? null;
  return decodeBody(bytes, charset, url);
}

/**
 * Read a response body as raw bytes (Uint8Array).
 *
 * @param response The fetch Response.
 * @param options Parse options (size limit, signal, decompress).
 * @returns The raw bytes.
 */
export async function readBytes(
  response: Response,
  options: ResponseParseOptions = {},
): Promise<Uint8Array> {
  const url = response.url;
  return await readBodyBytes(response, url, options);
}

/**
 * Read a response body as a Blob.
 *
 * @param response The fetch Response.
 * @param options Parse options (size limit, signal, decompress).
 * @returns A Blob with the correct Content-Type.
 */
export async function readBlob(
  response: Response,
  options: ResponseParseOptions = {},
): Promise<Blob> {
  const bytes = await readBytes(response, options);
  const ct = response.headers.get("content-type") ?? "application/octet-stream";
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Blob([buf], { type: ct });
}

/**
 * Get a streaming ReadableStream from the response with optional size limiting.
 *
 * @param response The fetch Response.
 * @param options Parse options (decompress, size limit, signal).
 * @returns A ReadableStream (empty stream if response has no body).
 */
export function readStream(
  response: Response,
  options: ResponseParseOptions = {},
): ReadableStream<Uint8Array> {
  if (!response.body) {
    return new ReadableStream({ start: (c) => c.close() });
  }

  const headers = normalizeHeaders(response.headers);
  let stream: ReadableStream<Uint8Array> = response.body as ReadableStream<Uint8Array>;

  // Decompression
  if (options.decompress !== false) {
    stream = applyDecompression(stream, headers) as ReadableStream<Uint8Array>;
  }

  // Size limiting via transform
  if (options.sizeLimit) {
    stream = applySizeLimit(
      stream,
      response.url,
      options.sizeLimit,
      options.signal,
    ) as ReadableStream<Uint8Array>;
  }

  return stream;
}

// ============================================================================
// §9  NDJSON STREAMING PARSER
// ============================================================================

/**
 * Parse a streaming NDJSON (newline-delimited JSON) response.
 *
 * @param response The fetch Response.
 * @param options Parse options + optional onParseError for malformed lines.
 * @yields Each parsed JSON object as type T.
 */
export async function* readNDJSON<T = unknown>(
  response: Response,
  options: ResponseParseOptions & {
    onParseError?: (err: unknown, line: string) => void;
  } = {},
): AsyncGenerator<T> {
  const stream = readStream(response, options);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (options.signal?.aborted) break;

      const { done, value } = await readWithAbort(reader, options.signal);
      if (done) {
        // Process remaining buffer
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            yield _sanitizeParsedJSON(JSON.parse(trimmed) as T);
          } catch (err) {
            options.onParseError?.(err, trimmed);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        try {
          yield _sanitizeParsedJSON(JSON.parse(trimmed) as T);
        } catch (err) {
          options.onParseError?.(err, trimmed);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// §9b  STREAMING JSON PARSER
// ============================================================================

/**
 * Parse a streaming JSON response (not NDJSON).
 *
 * Unlike NDJSON which requires newline-delimited JSON objects, this parser
 * handles a stream of JSON data where objects may be split across chunks.
 * Uses a state machine to handle partial JSON values.
 *
 * @param response The fetch Response.
 * @param options Parse options + onObject/onParseError callbacks.
 * @yields Each parsed JSON object as type T.
 * @throws {Error} If the streaming JSON buffer exceeds 10MB.
 *
 * @example
 * ```ts
 * // For a response streaming: {"a":1}{"a":2}{"a":3}
 * for await (const obj of readJSONStream(response)) {
 *   console.log(obj); // {a:1}, {a:2}, {a:3}
 * }
 * ```
 */
export async function* readJSONStream<T = unknown>(
  response: Response,
  options: ResponseParseOptions & {
    /** Called when a complete object is parsed */
    onObject?: (obj: T) => void;
    /** Called on parse errors (skip bad objects) */
    onParseError?: (err: unknown, partial: string) => void;
  } = {},
): AsyncGenerator<T> {
  const stream = readStream(response, options);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");

  let depth = 0;
  let buffer = "";
  let startIdx = -1;
  // JSON string state for the scan below. Braces and brackets inside a string
  // are DATA: the counter closed on a lone `}` in a value, cut the object in
  // half, and reported both halves as parse errors — so the object was
  // silently dropped. `{"note":"use } to close"}` yielded nothing at all.
  let inString = false;
  let escaped = false;

  const flushBuffer = (): string | null => {
    if (startIdx === -1) return null;
    const result = buffer.slice(startIdx);
    startIdx = -1;
    return result;
  };

  try {
    while (true) {
      if (options.signal?.aborted) break;

      const { done, value } = await readWithAbort(reader, options.signal);
      if (done) {
        // Try to parse remaining content as final object
        const remaining = flushBuffer();
        if (remaining) {
          try {
            const obj = _sanitizeParsedJSON(JSON.parse(remaining) as T);
            options.onObject?.(obj);
            yield obj;
          } catch (err) {
            options.onParseError?.(err, remaining);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i]!;

        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }

        if (char === "{" || char === "[") {
          if (depth === 0) startIdx = i;
          depth++;
        } else if (char === "}" || char === "]") {
          depth--;
          if (depth === 0 && startIdx !== -1) {
            const objStr = buffer.slice(startIdx, i + 1);
            try {
              const obj = _sanitizeParsedJSON(JSON.parse(objStr) as T);
              options.onObject?.(obj);
              yield obj;
            } catch (err) {
              options.onParseError?.(err, objStr);
            }
            buffer = buffer.slice(i + 1);
            // The consumed object's index must not survive into the next
            // object: the buffer was resliced underneath it, and a stale
            // startIdx is an offset into a string it no longer indexes.
            startIdx = -1;
            inString = false;
            escaped = false;
            i = -1;
          }
        }
      }

      // Keep buffer from getting too large
      if (buffer.length > 10_000_000) {
        throw new Error("JSON stream buffer exceeded 10MB limit");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// §10  HTTP ERROR ASSERTION
// ============================================================================

/**
 * Throw an HTTPResponseError if the response status indicates an error.
 *
 * @param response The fetch Response to check.
 * @param options Options: readBody (default true) and custom isError predicate.
 * @returns The response unchanged if status is OK.
 * @throws {HTTPResponseError} If the status matches the error condition.
 */
export async function assertOk(
  response: Response,
  options: {
    readBody?: boolean;
    isError?: (status: number) => boolean;
  } = {},
): Promise<Response> {
  const isErr = options.isError ?? ((s) => s >= 400);

  if (!isErr(response.status)) return response;

  const headers = normalizeHeaders(response.headers);
  let body: string | null = null;

  if (options.readBody !== false && response.body && !response.bodyUsed) {
    try {
      const clone = response.clone();
      body = await clone.text();
    } catch {
      /* ignore */
    }
  }

  throw new HTTPResponseError(response.status, response.statusText, response.url, headers, body);
}

/**
 * Throw if response is not 2xx. Variant that parses error body as JSON.
 *
 * @param response The fetch Response to check.
 * @returns An object containing `response` (the original Response if ok) and optionally `errorBody` (parsed JSON error body).
 * @throws {HTTPResponseError} If the response is not ok.
 */
export async function assertOkJSON<E = unknown>(
  response: Response,
): Promise<{
  /** The original Response if ok. */
  response: Response;
  /** Parsed JSON error body, if available. */
  errorBody?: E;
}> {
  if (response.ok) return { response };

  const headers = normalizeHeaders(response.headers);
  let body: string | null = null;
  if (response.body && !response.bodyUsed) {
    try {
      const clone = response.clone();
      body = await clone.text();
    } catch {
      /* ignore */
    }
  }

  throw new HTTPResponseError(response.status, response.statusText, response.url, headers, body);
}

// ============================================================================
// §10b  RESPONSE CACHING
// ============================================================================

/**
 * Simple in-memory response cache with TTL support.
 *
 * Stores cloned responses in memory. Useful for testing or short-lived caching.
 * For production, use proper HTTP caching headers or an external cache.
 *
 * @example
 * ```ts
 * const cache = new ResponseCache({ ttlMs: 60_000 });
 *
 * // Cache a response
 * await cache.set(request, response);
 *
 * // Get cached response if valid
 * const cached = await cache.get(request);
 * if (cached) return cached;
 * ```
 */
export class ResponseCache {
  private readonly cache = new Map<string, { response: Response; expiresAt: number }>();
  private readonly ttlMs: number;

  /**
   * @param options.ttlMs Time-to-live in milliseconds (default: 60000).
   */
  constructor(options: { ttlMs: number } = { ttlMs: 60_000 }) {
    this.ttlMs = options.ttlMs;
  }

  private hashRequest(req: Request | string): string {
    const url = typeof req === "string" ? req : req.url;
    const method = typeof req === "string" ? "GET" : req.method;
    return `${method}:${url}`;
  }

  /**
   * Retrieve a cached response if not expired.
   *
   * @param request The URL string or Request object.
   * @returns A cloned Response, or null if missing/expired.
   */
  async get(request: Request | string): Promise<Response | null> {
    const key = this.hashRequest(request);
    const entry = this.cache.get(key);

    if (!entry) return null;
    // `>=`, not `>`: an entry is expired AT its expiry instant, so
    // `ttlMs: 0` served a cached response instead of expiring immediately.
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return await Promise.resolve(entry.response.clone());
  }

  /**
   * Cache a response with the configured TTL.
   *
   * @param request The URL string or Request object (used as cache key).
   * @param response The Response to cache (a clone is stored internally).
   */
  async set(request: Request | string, response: Response): Promise<void> {
    const key = this.hashRequest(request);
    await Promise.resolve(
      this.cache.set(key, {
        response: response.clone(),
        expiresAt: Date.now() + this.ttlMs,
      }),
    );
  }

  /**
   * Remove a specific entry from the cache.
   *
   * @param request The URL string or Request object to remove.
   */
  delete(request: Request | string): void {
    this.cache.delete(this.hashRequest(request));
  }

  /** Remove all entries from the cache. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// §11  RESPONSE DIFF
// ============================================================================

/**
 * Result of diffing two fetch Response objects.
 */
export interface ResponseDiff {
  statusChanged: boolean;
  headersChanged: Record<string, [string, string]>;
  headersAdded: Record<string, string>;
  headersRemoved: Record<string, string>;
  bodyChanged: boolean;
}

/**
 * Diff two fetch Response objects (status, headers, body text).
 *
 * @param a The first Response.
 * @param b The second Response.
 * @returns A ResponseDiff with changed/added/removed fields.
 */
export async function diffResponses(a: Response, b: Response): Promise<ResponseDiff> {
  const ha = normalizeHeaders(a.headers);
  const hb = normalizeHeaders(b.headers);

  const headersChanged: Record<string, [string, string]> = {};
  const headersAdded: Record<string, string> = {};
  const headersRemoved: Record<string, string> = {};

  // Own-property tests, not `in`. `in` walks the prototype chain, and these
  // are plain object literals, so a header whose lowercased name is an
  // `Object.prototype` member read as PRESENT in the other response when it
  // was absent: a `constructor` header only on `a` came back as
  // `headersChanged: { constructor: ["yes", null] }` — a removed header
  // reported as changed-to-nothing, in a field typed `[string, string]`.
  for (const [k, v] of Object.entries(ha)) {
    if (!Object.prototype.hasOwnProperty.call(hb, k)) headersRemoved[k] = v;
    else if (hb[k] !== v) headersChanged[k] = [v, hb[k]!];
  }
  for (const [k, v] of Object.entries(hb)) {
    if (!Object.prototype.hasOwnProperty.call(ha, k)) headersAdded[k] = v!;
  }

  // Body diff (only if both are text)
  let bodyChanged = false;
  try {
    const [ta, tb] = await Promise.all([a.clone().text(), b.clone().text()]);
    bodyChanged = ta !== tb;
  } catch {
    /* ignore */
  }

  return {
    statusChanged: a.status !== b.status,
    headersChanged,
    headersAdded,
    headersRemoved,
    bodyChanged,
  };
}

// ============================================================================
// §12  MULTIPART RESPONSE PARSER
// ============================================================================

/**
 * A single part parsed from a multipart response body.
 */
export interface MultipartPart {
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Parse a multipart/mixed or multipart/form-data response body.
 *
 * Handles preamble (content before first boundary) and epilogue (content after
 * final boundary) by skipping them appropriately per RFC 2046.
 *
 * @param response The fetch Response with Content-Type: multipart/*.
 * @returns An array of parsed MultipartPart (headers + body).
 * @throws {ContentTypeError} If no boundary is found in Content-Type.
 */
export async function parseMultipartResponse(response: Response): Promise<MultipartPart[]> {
  const ct = response.headers.get("content-type") ?? "";
  const info = parseContentType(ct);

  if (!info?.boundary) {
    throw new ContentTypeError("multipart/*", ct, response.url);
  }

  const bytes = await response.arrayBuffer();
  const body = new Uint8Array(bytes);
  const boundary = new TextEncoder().encode("--" + info.boundary);
  const parts: MultipartPart[] = [];

  // Split on boundary
  // offset tracking via start variable
  const findBoundary = (from: number): number => {
    // `<=`, not `<`: the loop needs `i + boundary.length <= body.length`, so
    // a boundary sitting flush against the end of the body — no trailing
    // newline at all — was the one position the search could not reach.
    for (let i = from; i <= body.length - boundary.length; i++) {
      if (body.subarray(i, i + boundary.length).every((b, j) => b === boundary[j])) return i;
    }
    return -1;
  };

  // Find first boundary, skip preamble (content before it)
  let start = findBoundary(0);
  if (start === -1) return []; // No boundaries found

  // Skip past the first boundary to start parsing parts
  start += boundary.length;

  // Skip CRLF after first boundary
  if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  else if (body[start] === 0x0a) start += 1;

  // Check if first boundary is a closing boundary (--)
  if (body[start] === 0x2d && body[start + 1] === 0x2d) {
    // Empty multipart - just preamble (no parts)
    return [];
  }

  while (start < body.length) {
    // Find next boundary
    const end = findBoundary(start);
    if (end === -1) break; // No more boundaries - remaining is epilogue

    // Check if this is a closing boundary
    const checkPos = end + boundary.length;
    if (checkPos < body.length) {
      if (body[checkPos] === 0x0d && body[checkPos + 1] === 0x0a) {
        // Normal boundary followed by CRLF
      } else if (body[checkPos] === 0x0a) {
        // Boundary followed by just LF
      } else if (body[checkPos] === 0x2d && body[checkPos + 1] === 0x2d) {
        // Closing boundary (--) - remaining is epilogue
        // Don't break here — parse the current part first
        // The closing boundary break happens below after parsing
      }
    }

    // Strip the delimiter that precedes this boundary. It was a blind `- 2`
    // on the assumption of CRLF, so a bare-LF body lost its last two real
    // bytes, and a part framed some other way lost them too. Measured on the
    // same two parts: `end - 2` gave "hell" and "worl".
    let partEnd = end;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;
    else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) partEnd -= 1;

    const brk = findHeaderBreak(body, start, partEnd);
    if (!brk) {
      start = end + boundary.length;
      continue;
    }

    const headerBytes = body.subarray(start, brk.headerEnd);
    const partBody = body.subarray(brk.bodyStart, partEnd);

    const headerText = new TextDecoder().decode(headerBytes);
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r\n|\n/)) {
      const colon = line.indexOf(":");
      if (colon !== -1) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    parts.push({ headers, body: partBody });
    start = end + boundary.length;

    // After finding a part, check if next chars are "--" (closing boundary)
    if (start < body.length - 1 && body[start] === 0x2d && body[start + 1] === 0x2d) {
      break; // Reached closing boundary - rest is epilogue
    }
  }

  return parts;
}

/**
 * Locate the blank line separating a part's headers from its body, accepting
 * both CRLF and bare-LF framing.
 *
 * The old helper matched `\r\n\r\n` and nothing else, so a multipart body
 * that used bare LF — non-conformant per RFC 2046, and produced in practice —
 * parsed as ZERO parts rather than as a slightly-off one: every part failed
 * the header/body split, each was skipped, and the caller got an empty array
 * with no error. Both framings are now accepted, and the returned body offset
 * is the real start of the content either way.
 */
function findHeaderBreak(
  bytes: Uint8Array,
  from: number,
  to: number,
): { headerEnd: number; bodyStart: number } | null {
  for (let i = from; i < to; i++) {
    // Bare LF: checked first because in `\r\n\r\n` the byte after the
    // first LF is CR, so the two rules cannot both match at one position.
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { headerEnd: i, bodyStart: i + 2 };
    }
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return { headerEnd: i, bodyStart: i + 4 };
    }
  }
  return null;
}

/**
 * Read a multipart/form-data response as a FormData object.
 *
 * Parses multipart response and extracts form fields, supporting both
 * file uploads and regular form fields.
 *
 * @param response Response with Content-Type: multipart/form-data
 * @returns FormData with parsed fields
 *
 * @example
 * ```ts
 * const form = await readFormData(response);
 * const name = form.get("name");
 * const file = form.get("file") as File;
 * ```
 */
export async function readFormData(response: Response): Promise<FormData> {
  const parts = await parseMultipartResponse(response);
  const form = new FormData();

  for (const part of parts) {
    const disposition = part.headers["content-disposition"] ?? "";
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);

    if (!nameMatch) continue;

    const name = nameMatch[1]!;
    const filename = filenameMatch?.[1];

    if (filename) {
      // File upload - create a File object
      const contentType = part.headers["content-type"] ?? "application/octet-stream";
      const fileBuf = new ArrayBuffer(part.body.byteLength);
      new Uint8Array(fileBuf).set(part.body);
      const file = new File([fileBuf], filename, { type: contentType });
      form.append(name, file);
    } else {
      // Regular field - decode as UTF-8 text
      const value = new TextDecoder().decode(part.body);
      form.append(name, value);
    }
  }

  return form;
}

// ============================================================================
// §13  SERVER-TIMING EXTRACTION
// ============================================================================

/**
 * A single metric from the Server-Timing response header.
 */
export interface ServerTimingMetric {
  name: string;
  duration: number | null;
  description: string | null;
}

/**
 * Extract Server-Timing metrics from response headers.
 *
 * @param headers The normalized response headers.
 * @returns An array of ServerTimingMetric (name, duration, description).
 */
export function extractServerTiming(headers: Record<string, string>): ServerTimingMetric[] {
  const raw = headers["server-timing"] ?? headers["Server-Timing"];
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const segments = part.trim().split(";");
      const name = (segments[0] ?? "").trim();
      const params = parseParams(segments.slice(1).join(";"));
      const dur = params.get("dur");

      // `Number.isFinite`, not `dur !== undefined`: `parseFloat` returns NaN
      // for anything non-numeric, and `Server-Timing: x;dur=abc` is a
      // malformed header a server can send. The NaN went straight into the
      // metrics array, where it is not a number, fails every comparison, and
      // vanishes from a chart with nothing to indicate why.
      const parsed = dur !== undefined ? parseFloat(dur) : NaN;
      return {
        name,
        duration: Number.isFinite(parsed) ? parsed : null,
        description: params.get("desc") ?? null,
      };
    })
    .filter((m) => m.name);
}

// ============================================================================
// §14  UTILITIES
// ============================================================================

async function readBodyBytes(
  response: Response,
  url: string,
  options: ResponseParseOptions,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);

  const headers = normalizeHeaders(response.headers);
  let stream: ReadableStream<Uint8Array> = response.body as ReadableStream<Uint8Array>;

  // Decompression
  if (options.decompress !== false) {
    stream = applyDecompression(stream, headers) as ReadableStream<Uint8Array>;
  }

  // Signal abort
  if (options.signal?.aborted) {
    throw new DOMException("Response reading aborted", "AbortError");
  }

  if (options.sizeLimit) {
    return readBodyWithLimit(stream, url, options.sizeLimit, options.signal);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new DOMException("Response reading aborted", "AbortError");
      }
      const { done, value } = await readWithAbort(reader, options.signal);
      if (done) {
        // See readWithAbort: an aborted read also resolves as done.
        if (options.signal?.aborted) {
          throw new DOMException("Response reading aborted", "AbortError");
        }
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Cancel before releasing when we are bailing out, so the unread remainder
    // of the body is discarded rather than left buffered on a released lock.
    if (options.signal?.aborted) {
      await reader.cancel("aborted").catch(() => {});
    }
    reader.releaseLock();
  }

  return concatUint8Arrays(chunks);
}

function applySizeLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  limit: SizeLimitConfig,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const onExceed = normaliseOnExceed(limit.onExceed);
  let bytesRead = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel("aborted");
            controller.error(new DOMException("Response reading aborted", "AbortError"));
            return;
          }
          const { done, value } = await readWithAbort(reader, signal);
          if (done) {
            // See readWithAbort: an aborted read also resolves as done, and
            // here the caller must see the error rather than a clean close.
            if (signal?.aborted) {
              await reader.cancel("aborted").catch(() => {});
              controller.error(new DOMException("Response reading aborted", "AbortError"));
              return;
            }
            controller.close();
            break;
          }

          const newTotal = bytesRead + value.byteLength;
          if (newTotal > limit.maxBytes) {
            limit.onExceedCallback?.(newTotal, limit.maxBytes);

            if (onExceed === "throw") {
              await reader.cancel("size limit");
              controller.error(new ResponseSizeLimitError(newTotal, limit.maxBytes, url));
              return;
            }
            if (onExceed === "abort") {
              await reader.cancel("size limit");
              controller.close();
              return;
            }
            if (onExceed === "truncate") {
              const remaining = limit.maxBytes - bytesRead;
              if (remaining > 0) controller.enqueue(value.slice(0, remaining));
              controller.close();
              await reader.cancel("size limit");
              return;
            }
          }

          bytesRead += value.byteLength;
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function validateContentType(actual: string | null, expected: string, url: string): void {
  if (!actual) throw new ContentTypeError(expected, "(none)", url);
  const normalizedActual = actual.split(";")[0]?.trim().toLowerCase() ?? "";
  const normalizedExpected = expected.split(";")[0]?.trim().toLowerCase() ?? "";
  // Media-type equality, not a string prefix. `startsWith` accepted
  // `text/plaintext` for `text/plain` and `application/json-seq` for
  // `application/json` — an `expectedContentType` set to narrow the parse to
  // one format accepted every format whose name merely begins with it. A bare
  // top-level type still matches the whole tree, which is the one prefix case
  // that means something: `image` for `image/png`.
  const actualType = normalizedActual.split("/")[0] ?? "";
  const matches =
    normalizedActual === normalizedExpected ||
    (normalizedExpected.indexOf("/") === -1 && actualType === normalizedExpected);
  if (!matches) {
    throw new ContentTypeError(expected, actual, url);
  }
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ============================================================================
// §15  FACTORY HELPERS
// ============================================================================

/**
 * A response reader with a pre-configured size limit applied to all read operations.
 * Created by {@link createLimitedReader}.
 */
export interface LimitedReader {
  /** Read the response body as JSON */
  json: <T>(res: Response, opts?: ResponseParseOptions) => Promise<T>;
  /** Read the response body as text */
  text: (res: Response, opts?: ResponseParseOptions) => Promise<string>;
  /** Read the response body as raw bytes */
  bytes: (res: Response, opts?: ResponseParseOptions) => Promise<Uint8Array>;
  /** Read the response body as a Blob */
  blob: (res: Response, opts?: ResponseParseOptions) => Promise<Blob>;
  /** Read the response body as a ReadableStream */
  stream: (res: Response, opts?: ResponseParseOptions) => ReadableStream<Uint8Array>;
  /** Read the response body as NDJSON stream */
  ndjson: <T>(res: Response, opts?: ResponseParseOptions) => AsyncGenerator<T>;
}

/**
 * Create a response reader with a global size limit applied to all reads.
 *
 * @param maxBytes Maximum response body size in bytes.
 * @param onExceed Action when limit is exceeded (default: "throw").
 * @returns A LimitedReader with json/text/bytes/blob/stream/ndjson methods.
 */
export function createLimitedReader(
  maxBytes: number,
  onExceed: SizeLimitConfig["onExceed"] = "throw",
): LimitedReader {
  const limit: SizeLimitConfig = { maxBytes, onExceed };
  return {
    json: <T>(res: Response, opts?: ResponseParseOptions) =>
      readJSON<T>(res, { sizeLimit: limit, ...opts }),
    text: (res: Response, opts?: ResponseParseOptions) =>
      readText(res, { sizeLimit: limit, ...opts }),
    bytes: (res: Response, opts?: ResponseParseOptions) =>
      readBytes(res, { sizeLimit: limit, ...opts }),
    blob: (res: Response, opts?: ResponseParseOptions) =>
      readBlob(res, { sizeLimit: limit, ...opts }),
    stream: (res: Response, opts?: ResponseParseOptions) =>
      readStream(res, { sizeLimit: limit, ...opts }),
    ndjson: <T>(res: Response, opts?: ResponseParseOptions) =>
      readNDJSON<T>(res, { sizeLimit: limit, ...opts }),
  };
}
