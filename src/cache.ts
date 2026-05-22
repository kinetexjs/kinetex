/**
 * HTTP cache implementation.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - RFC 7234 compliant HTTP caching
 *  - In-memory LRU cache with TTL
 *  - Cache-Control full directive parsing + enforcement
 *  - Vary header support
 *  - ETag / Last-Modified conditional request support
 *  - Stale-While-Revalidate (SWR) background refresh
 *  - Stale-If-Error fallback
 *  - Cache key normalization (sorted params, stripped fragments)
 *  - Namespace / prefix isolation
 *  - Per-entry TTL override
 *  - Cache warming / preloading
 *  - Cache persistence (serialize/deserialize)
 *  - Cache statistics (hit rate, size, evictions)
 *  - Multi-tier cache (L1 memory + L2 storage adapter)
 *  - Storage adapters: memory, localStorage, sessionStorage, KV (CF Workers)
 *  - Tag-based invalidation
 *  - Manual invalidation (by URL pattern / tag / all)
 *  - Response cloning for safe reads
 *  - Max body size enforcement
 */

import { KinetexError as _KinetexError } from "./types.ts";
import { safeJSONParse } from "./utils.ts";

// ============================================================================
// #1  TYPES
// ============================================================================

/**
 * A minimal HTTP request representation suitable for cache lookup.
 */
export interface CacheableRequest {
  /** The request URL */
  url: string;
  /** HTTP method (GET, HEAD, etc.) */
  method: string;
  /** Request headers */
  headers: Record<string, string>;
}

/**
 * A minimal HTTP response representation stored in the cache.
 */
export interface CacheableResponse {
  /** HTTP status code */
  status: number;
  /** HTTP status text */
  statusText: string;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body (string, bytes, or null) */
  body: string | Uint8Array | null;
}

/**
 * A single entry stored in the cache with metadata and response data.
 */
export interface CacheEntry {
  /** The cached response payload */
  response: CacheableResponse;
  /** Timestamp when the entry was created */
  createdAt: number;
  /** Absolute expiry timestamp. Infinity = never expires */
  expiresAt: number;
  /** End of the stale-while-revalidate window */
  staleUntil: number;
  /** End of the stale-if-error window */
  staleOnError: number;
  /** ETag header value for conditional revalidation */
  etag: string | null;
  /** Last-Modified header value for conditional revalidation */
  lastModified: string | null;
  /** Hash of Vary-relevant request headers (null = Vary:*) */
  varyKey: string | null;
  /** Tags for group invalidation */
  tags: string[];
  /** Approximate entry size in bytes */
  size: number;
}

/**
 * Cache performance statistics.
 */
export interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Number of stale hits (served from SWR/SIE window) */
  staleHits: number;
  /** Number of cache access errors */
  errors: number;
  /** Number of evicted entries */
  evictions: number;
  /** Total entries currently stored */
  totalEntries: number;
  /** Total byte size of all stored entries */
  totalSizeBytes: number;
  /** Hit rate ratio (0–1) */
  hitRate: number;
}

/**
 * Configuration options for the HTTP cache.
 */
export interface CacheConfig {
  /** Maximum number of entries (LRU eviction). Default: 500 */
  maxEntries?: number;
  /** Maximum total size in bytes. Default: 50MB */
  maxSizeBytes?: number;
  /** Maximum response body size to cache in bytes. Default: 5MB */
  maxBodySizeBytes?: number;
  /** Default TTL in ms when no Cache-Control is present. Default: 60_000. Max: 1 year */
  defaultTtlMs?: number;
  /** Maximum absolute age in ms for any cached entry, regardless of Cache-Control. Default: 7 days */
  maxAbsoluteAgeMs?: number;
  /** Honor Cache-Control: no-store / no-cache. Default: true */
  honorCacheControl?: boolean;
  /** Only cache these methods. Default: ["GET", "HEAD"] */
  cacheMethods?: string[];
  /** Only cache these status codes. Default: [200,203,204,206,300,301,304,404,405,410,414,501] */
  cacheStatuses?: number[];
  /** Custom cache key function (may be async) */
  cacheKey?: (req: CacheableRequest) => string | Promise<string>;
  /** Storage adapter for persistence. Default: in-memory */
  storage?: CacheStorageAdapter;
  /** Namespace prefix for all keys */
  namespace?: string;
}

// ============================================================================
// #2  STORAGE ADAPTERS
// ============================================================================

/**
 * Pluggable storage backend for cache entries.
 */
export interface CacheStorageAdapter {
  /** Retrieve an entry by key. Returns null when missing or expired. */
  get(key: string): Promise<CacheEntry | null>;
  /** Store an entry. May return false if storage was rejected (e.g. quota exceeded). */
  set(key: string, entry: CacheEntry): Promise<void | boolean>;
  /** Remove an entry by key. */
  delete(key: string): Promise<void>;
  /** List all stored keys. */
  keys(): Promise<string[]>;
  /** Remove all entries. */
  clear(): Promise<void>;
}

// ── 2.1  In-memory (default) ──────────────────────────────────────────────────

/**
 * In-memory cache storage adapter.
 * Eviction is the sole responsibility of HTTPCache._ensureCapacity() —
 * this class is a pure KV store to avoid tag-index / stats drift.
 */
export class MemoryStorageAdapter implements CacheStorageAdapter {
  private store = new Map<string, CacheEntry>();

  // Pure KV store — eviction is HTTPCache._ensureCapacity()'s responsibility.
  // This avoids the tag-index / stats drift that occurs when the adapter
  // evicts entries that HTTPCache doesn't know about (audit §3.6 / §8.10).

  /** Retrieve an entry by key. Returns null when missing. */
  get(key: string): Promise<CacheEntry | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  /** Store an entry. */
  set(key: string, entry: CacheEntry): Promise<void> {
    this.store.set(key, entry);
    return Promise.resolve();
  }

  /** Remove an entry by key. */
  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  /** List all stored keys. */
  keys(): Promise<string[]> {
    return Promise.resolve(Array.from(this.store.keys()));
  }

  /** Remove all entries. */
  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this.store.size;
  }
}

// ── 2.2  Web Storage (localStorage / sessionStorage) ─────────────────────────

/**
 * Web Storage (localStorage / sessionStorage) cache adapter.
 * Prefixes keys to avoid collisions with other data.
 * Returns false from set() on QuotaExceededError.
 */
export class WebStorageAdapter implements CacheStorageAdapter {
  constructor(
    /** The Storage instance (localStorage or sessionStorage) */
    private readonly storage: Storage,
    /** Key prefix to isolate cache entries. Default: "hc:" */
    private readonly prefix = "hc:",
  ) {}

  /** Retrieve an entry by key. Returns null when missing or unparseable. */
  get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = this.storage.getItem(this.prefix + key);
      if (!raw) return Promise.resolve(null);
      const result = safeJSONParse<CacheEntry>(raw, { maxDepth: 32 });
      return Promise.resolve(result.success && result.value !== undefined ? result.value : null);
    } catch {
      return Promise.resolve(null);
    }
  }

  /** Store an entry. Returns false when quota is exceeded. */
  set(key: string, entry: CacheEntry): Promise<boolean> {
    try {
      this.storage.setItem(this.prefix + key, JSON.stringify(entry));
      return Promise.resolve(true);
    } catch (err) {
      // QuotaExceededError — notify caller instead of silently dropping
      if (
        err instanceof Error &&
        (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED")
      ) {
        console.warn(
          "[kinetex] WebStorageAdapter: storage quota exceeded. Entry was NOT cached. " +
            "Consider reducing maxBodySizeBytes or using a different storage adapter.",
        );
        return Promise.resolve(false);
      }
      return Promise.resolve(false);
    }
  }

  /** Remove an entry by key. */
  delete(key: string): Promise<void> {
    this.storage.removeItem(this.prefix + key);
    return Promise.resolve();
  }

  /** List all stored keys (prefixed entries only). */
  keys(): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return Promise.resolve(out);
  }

  /** Remove all prefixed entries. */
  clear(): Promise<void> {
    const toDelete: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(this.prefix)) toDelete.push(k);
    }
    for (const k of toDelete) this.storage.removeItem(k);
    return Promise.resolve();
  }
}

// ── 2.3  Cloudflare KV adapter ────────────────────────────────────────────────

/**
 * Minimal Cloudflare Workers KV namespace interface.
 * Matches the shape of the binding injected by the Workers runtime.
 */
export interface CloudflareKVNamespace {
  /** Retrieve a JSON value by key */
  get(key: string, type: "json"): Promise<unknown>;
  /** Store a string value with optional expiration */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /** Delete a key */
  delete(key: string): Promise<void>;
  /** List keys with optional prefix filter */
  list(options?: { prefix?: string }): Promise<{
    /** Array of key objects. */
    keys: Array<{
      /** The key name. */
      name: string;
    }>;
  }>;
}

/**
 * Cloudflare Workers KV storage adapter.
 * Uses KV's built-in expirationTtl for automatic TTL-based eviction.
 */
export class CloudflareKVAdapter implements CacheStorageAdapter {
  constructor(
    /** The Cloudflare KV namespace binding */
    private readonly kv: CloudflareKVNamespace,
    /** Key prefix to isolate cache entries. Default: "hc:" */
    private readonly prefix = "hc:",
  ) {}

  /** Retrieve an entry by key from KV. Returns null when missing. */
  async get(key: string): Promise<CacheEntry | null> {
    const val = (await this.kv.get(this.prefix + key, "json")) as CacheEntry | null;
    return val;
  }

  /** Store an entry in KV with automatic expirationTtl derived from entry.expiresAt. */
  async set(key: string, entry: CacheEntry): Promise<void> {
    const ttlSecs =
      entry.expiresAt === Infinity
        ? undefined
        : Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    await this.kv.put(this.prefix + key, JSON.stringify(entry), {
      ...(ttlSecs !== undefined ? { expirationTtl: ttlSecs } : {}),
    });
  }

  /** Remove an entry by key from KV. */
  async delete(key: string): Promise<void> {
    await this.kv.delete(this.prefix + key);
  }

  /** List all cached keys currently stored in KV. */
  async keys(): Promise<string[]> {
    const result = await this.kv.list({ prefix: this.prefix });
    return result.keys.map((k) => k.name.slice(this.prefix.length));
  }

  /** Remove all cached entries from KV. */
  async clear(): Promise<void> {
    const keys = await this.keys();
    await Promise.all(keys.map((k) => this.kv.delete(this.prefix + k)));
  }
}

// ── 2.4  Two-tier (L1 memory + L2 persistent) ────────────────────────────────

/**
 * Two-tier cache: fast in-memory L1 backed by a persistent L2 adapter.
 * Reads promote entries from L2 to L1. Writes go to both tiers in parallel.
 */
export class TwoTierStorageAdapter implements CacheStorageAdapter {
  private l1 = new MemoryStorageAdapter();

  constructor(
    /** The persistent backend storage adapter */
    private readonly l2: CacheStorageAdapter,
  ) {}

  /** Retrieve an entry from L1 (fast) with L2 fallback. Promotes L2 hits into L1. */
  async get(key: string): Promise<CacheEntry | null> {
    const l1Hit = await this.l1.get(key);
    if (l1Hit) return l1Hit;

    const l2Hit = await this.l2.get(key);
    if (l2Hit) {
      await this.l1.set(key, l2Hit); // promote to L1
    }
    return l2Hit;
  }

  /** Store an entry in both L1 (memory) and L2 (persistent) in parallel. */
  async set(key: string, entry: CacheEntry): Promise<void> {
    await Promise.all([this.l1.set(key, entry), this.l2.set(key, entry)]);
  }

  /** Remove an entry from both tiers in parallel. */
  async delete(key: string): Promise<void> {
    await Promise.all([this.l1.delete(key), this.l2.delete(key)]);
  }

  /** List all keys from L2 (source of truth for key enumeration). */
  async keys(): Promise<string[]> {
    return await this.l2.keys();
  }

  /** Clear both tiers in parallel. */
  async clear(): Promise<void> {
    await Promise.all([this.l1.clear(), this.l2.clear()]);
  }
}

// ============================================================================
// #3  CACHE-CONTROL PARSER
// ============================================================================

/**
 * Parsed Cache-Control response directives.
 * All numeric durations are in seconds unless otherwise noted.
 */
interface CacheControlDirectives {
  /** Response must not be stored */
  noStore: boolean;
  /** Response must be revalidated before reuse */
  noCache: boolean;
  /** Stale responses must not be served without revalidation */
  mustRevalidate: boolean;
  /** Shared caches must revalidate stale responses */
  proxyRevalidate: boolean;
  /** Response can be cached by any cache */
  public: boolean;
  /** Response is intended for a single user only */
  private: boolean;
  /** max-age value in seconds, or null */
  maxAge: number | null;
  /** s-maxage value in seconds (shared cache override), or null */
  sMaxAge: number | null;
  /** stale-while-revalidate window in seconds, or null */
  staleWhileRevalidate: number | null;
  /** stale-if-error window in seconds, or null */
  staleIfError: number | null;
  /** Response is immutable during its freshness lifetime */
  immutable: boolean;
}

/** Parse a Cache-Control header value into structured directives. */
function parseCacheControl(value: string): CacheControlDirectives {
  const d: CacheControlDirectives = {
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    proxyRevalidate: false,
    public: false,
    private: false,
    maxAge: null,
    sMaxAge: null,
    staleWhileRevalidate: null,
    staleIfError: null,
    immutable: false,
  };

  for (const part of value.split(",")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    const k = (eq === -1 ? t : t.slice(0, eq)).trim().toLowerCase();
    const v =
      eq === -1
        ? null
        : t
            .slice(eq + 1)
            .trim()
            .replace(/^"|"$/g, "");
    const n = v !== null ? parseInt(v, 10) : null;

    switch (k) {
      case "no-store":
        d.noStore = true;
        break;
      case "no-cache":
        d.noCache = true;
        break;
      case "must-revalidate":
        d.mustRevalidate = true;
        break;
      case "proxy-revalidate":
        d.proxyRevalidate = true;
        break;
      case "public":
        d.public = true;
        break;
      case "private":
        d.private = true;
        break;
      case "immutable":
        d.immutable = true;
        break;
      case "max-age":
        d.maxAge = n;
        break;
      case "s-maxage":
        d.sMaxAge = n;
        break;
      case "stale-while-revalidate":
        d.staleWhileRevalidate = n;
        break;
      case "stale-if-error":
        d.staleIfError = n;
        break;
      case "no-transform":
        break;
      case "only-if-cached":
        break;
      case "must-understand":
        break;
      default:
        break;
    }
  }
  return d;
}

// ============================================================================
// #4  VARY HEADER SUPPORT
// ============================================================================

/**
 * Build a Vary key for cache differentiation.
 * Returns `null` when `Vary: *` is present — callers must treat this as "never cache".
 * Returns a deterministic string of field=value pairs for all other Vary headers.
 */
function buildVaryKey(varyHeader: string, requestHeaders: Record<string, string>): string | null {
  if (!varyHeader) return "";
  // RFC 7231 §7.1.4: Vary: * means the response is uncacheable
  if (varyHeader.trim() === "*") return null;

  const fields = varyHeader
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .sort();
  const parts = fields.map((f) => {
    const val = requestHeaders[f] ?? requestHeaders[f.toLowerCase()] ?? "";
    return `${f}=${val}`;
  });
  return parts.join(";");
}

// ============================================================================
// #5  CACHE KEY BUILDING
// ============================================================================

/**
 * Normalize a string for use in a cache key to prevent injection attacks.
 * Removes control characters and normalizes whitespace.
 */
function normalizeCacheKeyPart(part: string): string {
  const controlRanges = [
    String.fromCharCode(0x00) + "-" + String.fromCharCode(0x1f),
    String.fromCharCode(0x7f) + "-" + String.fromCharCode(0x9f),
  ].join("");
  const controlRegex = new RegExp(`[${controlRanges}]`, "g");
  return part.replaceAll(controlRegex, "").replaceAll(/\s+/g, " ").trim();
}

/**
 * Generate a cryptographic fingerprint of auth-sensitive headers using SHA-256.
 * Async, but the result is always a stable hex string usable as a cache key segment.
 * Returns "" when no auth headers are present (shared/anonymous cache).
 */
export async function getAuthFingerprint(headers: Record<string, string>): Promise<string> {
  const authHeaders = ["authorization", "cookie", "x-api-key", "x-auth-token"];
  const parts: string[] = [];

  for (const header of authHeaders) {
    const value = headers[header.toLowerCase()];
    if (value) parts.push(`${header}=${value}`);
  }

  if (parts.length === 0) return "";

  const data = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32); // 128-bit prefix — ample for auth isolation
  return `auth:${hex}`;
}

/**
 * Default cache key function.
 * Normalizes: method, URL (sorted query params, stripped hash), auth fingerprint.
 * Format: "METHOD:normalized_url[:auth:hex]"
 */
async function defaultCacheKey(req: CacheableRequest): Promise<string> {
  try {
    const u = new URL(req.url);
    // Normalize directly instead of re-parsing sanitized string
    const hostname = normalizeCacheKeyPart(u.hostname);
    const pathname = normalizeCacheKeyPart(u.pathname);
    // Sort params in place and build normalized URL
    u.searchParams.sort();
    const search = normalizeCacheKeyPart(u.search);
    u.hash = "";

    // Build key from already-normalized URL components
    const normalized = `${u.protocol}//${hostname}${u.port ? ":" + u.port : ""}${pathname}${search}`;
    const method = normalizeCacheKeyPart(req.method.toUpperCase());
    const authFp = await getAuthFingerprint(req.headers ?? {});
    const key = `${method}:${normalized}`;
    return authFp ? `${key}:${authFp}` : key;
  } catch {
    const method = normalizeCacheKeyPart(req.method.toUpperCase());
    const url = normalizeCacheKeyPart(req.url);
    const authFp = await getAuthFingerprint(req.headers ?? {});
    const key = `${method}:${url}`;
    return authFp ? `${key}:${authFp}` : key;
  }
}

// ============================================================================
// #6  TTL COMPUTATION
// ============================================================================

/** Result of TTL computation for a cached response. */
interface TTLResult {
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Stale-while-revalidate window in milliseconds */
  swrMs: number;
  /** Stale-if-error window in milliseconds */
  staleOnError: number;
  /** Whether the response should be cached at all */
  shouldCache: boolean;
}

/**
 * Compute cache TTL, SWR window, and stale-on-error window
 * from Cache-Control headers, Expires header, or Last-Modified heuristic.
 */
function computeTTL(response: CacheableResponse, defaultTtl: number, honor: boolean): TTLResult {
  const cc = response.headers["cache-control"] ?? response.headers["Cache-Control"] ?? "";
  const d = parseCacheControl(cc);

  // Hard no-cache
  if (honor && d.noStore) {
    return { ttlMs: 0, swrMs: 0, staleOnError: 0, shouldCache: false };
  }

  // s-maxage takes priority (for shared/proxy caches)
  const maxAgeSecs = d.sMaxAge ?? d.maxAge;

  let ttlMs: number;

  if (maxAgeSecs !== null) {
    // Respect Age header (already-elapsed time)
    const age = parseInt(response.headers["age"] ?? response.headers["Age"] ?? "0", 10) || 0;
    ttlMs = Math.max(0, (maxAgeSecs - age) * 1000);
  } else {
    // Try Expires header
    const expires = response.headers["expires"] ?? response.headers["Expires"];
    if (expires) {
      const exp = Date.parse(expires);
      ttlMs = isNaN(exp) ? defaultTtl : Math.max(0, exp - Date.now());
    } else {
      // Heuristic: 10% of Last-Modified age
      const lm = response.headers["last-modified"] ?? response.headers["Last-Modified"];
      if (lm) {
        const lmTime = Date.parse(lm);
        if (!isNaN(lmTime)) {
          ttlMs = Math.min((Date.now() - lmTime) * 0.1, defaultTtl);
        } else {
          ttlMs = defaultTtl;
        }
      } else {
        ttlMs = defaultTtl;
      }
    }
  }

  // immutable: treat as "very long TTL" but still respect maxAbsoluteAgeMs cap applied in set()
  if (d.immutable && ttlMs > 0) {
    ttlMs = 365 * 24 * 60 * 60 * 1000; // cap will be applied by HTTPCache.set()
  }

  const swrMs = d.staleWhileRevalidate !== null ? d.staleWhileRevalidate * 1000 : 0;
  const staleOnError = d.staleIfError !== null ? d.staleIfError * 1000 : 0;

  return {
    ttlMs,
    swrMs,
    staleOnError,
    shouldCache: ttlMs > 0 || swrMs > 0,
  };
}

// ============================================================================
// #7  LRU EVICTION — O(1) doubly-linked list + Map
// ============================================================================

/** Node in the O(1) LRU doubly-linked list. */
class LRUNode {
  constructor(
    /** Cache key this node represents */
    public key: string,
    /** Previous node (toward LRU end) */
    public prev: LRUNode | null = null,
    /** Next node (toward MRU end) */
    public next: LRUNode | null = null,
  ) {}
}

/**
 * O(1) LRU eviction tracker using a doubly-linked list + Map.
 * Head = Most-Recently-Used, Tail = Least-Recently-Used.
 */
class LRUTracker {
  private readonly map = new Map<string, LRUNode>();
  private head: LRUNode | null = null; // Most-Recently-Used
  private tail: LRUNode | null = null; // Least-Recently-Used

  /** Record access to a key (moves it to MRU position). */
  touch(key: string): void {
    const existing = this.map.get(key);
    if (existing) {
      this._unlink(existing);
      this._prepend(existing);
    } else {
      const node = new LRUNode(key);
      this.map.set(key, node);
      this._prepend(node);
    }
  }

  /** Evict the Least-Recently-Used key. Returns the evicted key or null if empty. */
  evict(): string | null {
    if (!this.tail) return null;
    const key = this.tail.key;
    this._unlink(this.tail);
    this.map.delete(key);
    return key;
  }

  /** Remove a specific key from the tracker. */
  remove(key: string): void {
    const node = this.map.get(key);
    if (!node) return;
    this._unlink(node);
    this.map.delete(key);
  }

  /** Clear all tracked entries. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /** Number of tracked entries. */
  get size(): number {
    return this.map.size;
  }

  private _prepend(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private _unlink(node: LRUNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }
}

// ============================================================================
// #8  HTTP CACHE
// ============================================================================

/**
 * RFC 7234-compliant HTTP cache with LRU eviction, Vary support,
 * stale-while-revalidate, stale-if-error, tag-based invalidation,
 * and pluggable storage backends.
 *
 * @example
 * ```typescript
 * const cache = new HTTPCache({ maxEntries: 200, defaultTtlMs: 30_000 });
 * await cache.set(req, res);
 * const result = await cache.get(req);
 * ```
 */
export class HTTPCache {
  /** Resolved cache configuration with defaults applied */
  private readonly cfg: Required<CacheConfig>;
  /** Storage adapter (in-memory or pluggable backend) */
  private readonly storage: CacheStorageAdapter;
  /** O(1) LRU eviction tracker */
  private readonly lru = new LRUTracker();
  /** Tag → set of cache keys for tag-based invalidation */
  private readonly tagIndex = new Map<string, Set<string>>();
  /** Keys currently being revalidated (prevents duplicate SWR fetches) */
  private readonly swrInFlight = new Set<string>();

  /** Cache performance statistics */
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    errors: 0,
    evictions: 0,
    totalEntries: 0,
    totalSizeBytes: 0,
    hitRate: 0,
  };

  /**
   * @param config - Cache configuration
   */
  constructor(config: CacheConfig = {}) {
    this.cfg = {
      maxEntries: config.maxEntries ?? 500,
      maxSizeBytes: config.maxSizeBytes ?? 50 * 1024 * 1024,
      maxBodySizeBytes: config.maxBodySizeBytes ?? 5 * 1024 * 1024,
      defaultTtlMs: config.defaultTtlMs ?? 60_000,
      maxAbsoluteAgeMs: config.maxAbsoluteAgeMs ?? 7 * 24 * 60 * 60 * 1000, // 7 days
      honorCacheControl: config.honorCacheControl ?? true,
      cacheMethods: config.cacheMethods ?? ["GET", "HEAD"],
      cacheStatuses: config.cacheStatuses ?? [
        200, 203, 204, 206, 300, 301, 304, 404, 405, 410, 414, 501,
      ],
      cacheKey: config.cacheKey ?? defaultCacheKey,
      storage: config.storage ?? new MemoryStorageAdapter(),
      namespace: config.namespace ?? "",
    };

    // Cap default TTL to maximum 1 year to prevent infinite cache entries
    if (this.cfg.defaultTtlMs === Infinity || this.cfg.defaultTtlMs > 365 * 24 * 60 * 60 * 1000) {
      console.warn(
        `[Kinetex Cache] Capping defaultTtlMs from ${this.cfg.defaultTtlMs}ms to 1 year (${365 * 24 * 60 * 60 * 1000}ms)`,
      );
      this.cfg.defaultTtlMs = 365 * 24 * 60 * 60 * 1000;
    }

    this.storage = this.cfg.storage;
  }

  // ──8.1  get ─────────────────────────────────────────────────────────────

  /**
   * Look up a cached response.
   *
   * @returns An object with `entry` (the cached {@link CacheEntry}) and `stale` (boolean indicating
   *          the entry is expired but within the stale-while-revalidate or stale-if-error window),
   *          or `null` if no matching entry was found.
   */
  async get(req: CacheableRequest): Promise<{
    /** The cached CacheEntry. */
    entry: CacheEntry;
    /** Whether the entry is stale but within the stale-while-revalidate or stale-if-error window. */
    stale: boolean;
  } | null> {
    if (!this._isCacheable(req.method)) return null;

    const key = await this._key(req);
    const entry = await this.storage.get(key);

    if (!entry) {
      this.stats.misses++;
      this._updateHitRate();
      return null;
    }

    // Vary check
    if (entry.varyKey !== null && entry.varyKey !== "") {
      const reqVaryKey = buildVaryKey(
        entry.response.headers["vary"] ?? entry.response.headers["Vary"] ?? "",
        req.headers,
      );
      // null means Vary:* — never serve from cache
      if (reqVaryKey === null || reqVaryKey !== entry.varyKey) {
        this.stats.misses++;
        this._updateHitRate();
        return null;
      }
    }

    const now = Date.now();

    // Check absolute age limit — entries older than maxAbsoluteAgeMs are always expired
    const age = now - entry.createdAt;
    if (age > this.cfg.maxAbsoluteAgeMs) {
      await this._delete(key, entry);
      this.stats.misses++;
      this._updateHitRate();
      return null;
    }

    // Fresh
    if (entry.expiresAt === Infinity || entry.expiresAt > now) {
      this.stats.hits++;
      this.lru.touch(key);
      this._updateHitRate();
      return { entry: cloneEntry(entry), stale: false };
    }

    // Stale-While-Revalidate window
    if (entry.staleUntil > now) {
      this.stats.staleHits++;
      this.lru.touch(key);
      this._updateHitRate();
      return { entry: cloneEntry(entry), stale: true };
    }

    // Stale-If-Error window (caller checks this case)
    if (entry.staleOnError > now) {
      this.stats.staleHits++;
      this._updateHitRate();
      return { entry: cloneEntry(entry), stale: true };
    }

    // Expired — delete
    await this._delete(key, entry);
    this.stats.misses++;
    this._updateHitRate();
    return null;
  }

  // ──8.2  set ─────────────────────────────────────────────────────────────

  /**
   * Store a response in the cache.
   *
   * @param req - The request used as the cache key
   * @param res - The response to cache
   * @param options - Optional tags, per-entry TTL override, or force flag to bypass no-store
   * @returns true if the entry was stored, false if rejected (uncacheable, too large, or quota exceeded)
   */
  async set(
    req: CacheableRequest,
    res: CacheableResponse,
    options: {
      tags?: string[];
      ttlMs?: number;
      force?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!this._isCacheable(req.method)) return false;
    if (!this.cfg.cacheStatuses.includes(res.status)) return false;

    const { ttlMs, swrMs, staleOnError, shouldCache } =
      options.ttlMs !== undefined
        ? { ttlMs: options.ttlMs, swrMs: 0, staleOnError: 0, shouldCache: true }
        : computeTTL(res, this.cfg.defaultTtlMs, this.cfg.honorCacheControl);

    if (!shouldCache && !options.force) return false;

    // Body size check
    const bodySize = bodyBytes(res.body);
    if (bodySize > this.cfg.maxBodySizeBytes) return false;

    const now = Date.now();

    // 9.10 — cap TTL to maxAbsoluteAgeMs so stored entries can never outlive the limit
    const absoluteCap = this.cfg.maxAbsoluteAgeMs;
    const cappedTtlMs = Math.min(ttlMs === Infinity ? absoluteCap : ttlMs, absoluteCap);
    if (cappedTtlMs <= 0 && !options.force) return false;
    const varyHeader = res.headers["vary"] ?? res.headers["Vary"] ?? null;
    const varyKey = varyHeader ? buildVaryKey(varyHeader, req.headers) : "";
    // Vary: * means this response is per-user and must never be shared from cache
    if (varyKey === null) return false;
    const tags = options.tags ?? [];

    const entry: CacheEntry = {
      response: cloneResponse(res),
      createdAt: now,
      expiresAt: cappedTtlMs === Infinity ? Infinity : now + cappedTtlMs,
      staleUntil: now + cappedTtlMs + swrMs,
      staleOnError: now + cappedTtlMs + staleOnError,
      etag: res.headers["etag"] ?? res.headers["ETag"] ?? null,
      lastModified: res.headers["last-modified"] ?? res.headers["Last-Modified"] ?? null,
      varyKey,
      tags,
      size: bodySize + 256,
    };

    const key = await this._key(req);

    // Evict if needed
    await this._ensureCapacity(entry.size);

    const stored = await this.storage.set(key, entry);
    // WebStorageAdapter returns false on quota exceeded — don't update stats if not stored
    if (stored === false) return false;

    this.lru.touch(key);
    this.stats.totalEntries++;
    this.stats.totalSizeBytes += entry.size;

    // Update tag index
    for (const tag of tags) {
      const set = this.tagIndex.get(tag) ?? new Set();
      set.add(key);
      this.tagIndex.set(tag, set);
    }

    return true;
  }

  // ──8.3  Conditional request headers ─────────────────────────────────────

  /**
   * Build conditional request headers (If-None-Match / If-Modified-Since)
   * for cache revalidation.
   */
  buildConditionalHeaders(entry: CacheEntry): Record<string, string> {
    const headers: Record<string, string> = {};
    if (entry.etag) headers["if-none-match"] = entry.etag;
    if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;
    return headers;
  }

  /**
   * Handle a 304 Not Modified response — refresh the entry TTL in place.
   */
  async revalidate(
    req: CacheableRequest,
    res: CacheableResponse, // 304 response with updated headers
  ): Promise<CacheEntry | null> {
    const key = await this._key(req);
    const entry = await this.storage.get(key);
    if (!entry) return null;

    // Merge new headers into cached response
    const mergedHeaders = { ...entry.response.headers, ...res.headers };
    const updatedRes = { ...entry.response, headers: mergedHeaders };

    const { ttlMs, swrMs, staleOnError } = computeTTL(
      updatedRes,
      this.cfg.defaultTtlMs,
      this.cfg.honorCacheControl,
    );

    const now = Date.now();
    // 9.4 — cap refreshed TTL the same way set() does
    const cappedTtl = Math.min(
      ttlMs === Infinity ? this.cfg.maxAbsoluteAgeMs : ttlMs,
      this.cfg.maxAbsoluteAgeMs,
    );
    const updated: CacheEntry = {
      ...entry,
      response: updatedRes,
      createdAt: now,
      expiresAt: cappedTtl <= 0 ? now : now + cappedTtl,
      staleUntil: now + cappedTtl + swrMs,
      staleOnError: now + cappedTtl + staleOnError,
      etag: mergedHeaders["etag"] ?? mergedHeaders["ETag"] ?? entry.etag,
      lastModified:
        mergedHeaders["last-modified"] ?? mergedHeaders["Last-Modified"] ?? entry.lastModified,
    };

    await this.storage.set(key, updated);
    this.lru.touch(key);
    return cloneEntry(updated);
  }

  // ──8.4  Stale-While-Revalidate ──────────────────────────────────────────

  /**
   * Mark a request as being revalidated for stale-while-revalidate.
   * Returns false if the key is already in flight.
   */
  async markSWRInFlight(req: CacheableRequest): Promise<boolean> {
    const key = await this._key(req);
    if (this.swrInFlight.has(key)) return false;
    this.swrInFlight.add(key);
    return true;
  }

  /** Clear the SWR in-flight flag for a request. */
  async clearSWRInFlight(req: CacheableRequest): Promise<void> {
    const key = await this._key(req);
    this.swrInFlight.delete(key);
  }

  /** Check whether a request is currently being revalidated. */
  async isSWRInFlight(req: CacheableRequest): Promise<boolean> {
    const key = await this._key(req);
    return this.swrInFlight.has(key);
  }

  // ──8.5  Invalidation ────────────────────────────────────────────────────

  /**
   * Delete a single entry from the cache.
   * @returns true if the entry existed and was deleted
   */
  async delete(req: CacheableRequest): Promise<boolean> {
    const key = await this._key(req);
    const entry = await this.storage.get(key);
    if (!entry) return false;
    await this._delete(key, entry);
    return true;
  }

  /** Delete all entries whose URLs start with a given prefix. Works with namespaces. */
  async invalidateByURL(urlPrefix: string): Promise<number> {
    const keys = await this.storage.keys();
    let count = 0;

    // Reconstruct the key prefix that would be produced by defaultCacheKey for this URL prefix.
    // Since the key format is "[namespace:]METHOD:url[:auth]" we search for any key that
    // contains the url prefix after the first colon-separated segment (the method).
    for (const key of keys) {
      // Strip namespace prefix if present
      const bare = this.cfg.namespace
        ? key.startsWith(this.cfg.namespace + ":")
          ? key.slice(this.cfg.namespace.length + 1)
          : null
        : key;
      if (bare === null) continue;

      // bare is now "METHOD:url[:auth]" — check if the url segment starts with urlPrefix
      const colonIdx = bare.indexOf(":");
      if (colonIdx === -1) continue;
      const urlPart = bare.slice(colonIdx + 1);

      // Strip auth fingerprint suffix (auth:HEX) for prefix comparison
      const authIdx = urlPart.lastIndexOf(":auth:");
      const urlOnly = authIdx !== -1 ? urlPart.slice(0, authIdx) : urlPart;

      // Normalize trailing slashes for consistent prefix matching
      const normalizedPrefix = urlPrefix.endsWith("/") ? urlPrefix.slice(0, -1) : urlPrefix;
      const normalizedUrl = urlOnly.endsWith("/") ? urlOnly.slice(0, -1) : urlOnly;

      if (normalizedUrl.startsWith(normalizedPrefix)) {
        const entry = await this.storage.get(key);
        await this._delete(key, entry ?? undefined);
        count++;
      }
    }
    return count;
  }

  /** Delete all entries with a specific tag. */
  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;

    let count = 0;
    for (const key of [...keys]) {
      const entry = await this.storage.get(key);
      await this._delete(key, entry ?? undefined);
      count++;
    }
    this.tagIndex.delete(tag);
    return count;
  }

  /** Clear all cached entries. */
  async clear(): Promise<void> {
    await this.storage.clear();
    this.lru.clear();
    this.tagIndex.clear();
    this.swrInFlight.clear();
    this.stats.totalEntries = 0;
    this.stats.totalSizeBytes = 0;
  }

  // ──8.6  Cache warming ───────────────────────────────────────────────────

  /**
   * Pre-populate the cache with a set of request/response pairs.
   */
  async warm(
    entries: Array<{ req: CacheableRequest; res: CacheableResponse; tags?: string[] }>,
  ): Promise<void> {
    for (const { req, res, tags } of entries) {
      await this.set(req, res, { ...(tags !== undefined ? { tags } : {}), force: true as const });
    }
  }

  // ──8.7  Stats ───────────────────────────────────────────────────────────

  /** Get a snapshot of current cache statistics. */
  getStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  /** Reset all cache statistics to zero. */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      staleHits: 0,
      errors: 0,
      evictions: 0,
      totalEntries: 0,
      totalSizeBytes: 0,
      hitRate: 0,
    };
  }

  // ──8.8  Serialization ───────────────────────────────────────────────────

  /**
   * Serialize cache entries to a JSON string for persistence.
   * Expired entries are excluded. Format: { version: 1, entries: [[key, entry], ...] }.
   */
  async serialize(): Promise<string> {
    const keys = await this.storage.keys();
    const entries: Array<[string, CacheEntry]> = [];
    const now = Date.now();

    for (const key of keys) {
      const entry = await this.storage.get(key);
      if (!entry) continue;
      // Skip expired entries
      if (entry.expiresAt !== Infinity && entry.expiresAt < now) continue;
      entries.push([key, entry]);
    }

    return JSON.stringify({ version: 1, entries });
  }

  /**
   * Restore cache entries from a previously serialized JSON string.
   * Validates structure, enforces max age and body size limits, skips expired entries.
   * @throws {Error} If the JSON format is invalid or unexpected.
   */
  async deserialize(data: string): Promise<void> {
    const parsed = safeJSONParse<{ version: number; entries: unknown[] }>(data, { maxDepth: 32 });
    if (!parsed.success) {
      throw new Error("[kinetex] HTTPCache.deserialize: invalid JSON");
    }
    const obj = parsed.value;

    if (
      typeof obj !== "object" ||
      obj === null ||
      !("version" in obj) ||
      !("entries" in obj) ||
      obj.version !== 1 ||
      !Array.isArray(obj.entries)
    ) {
      throw new Error(
        "[kinetex] HTTPCache.deserialize: unexpected format (expected {version:1, entries:[…]})",
      );
    }

    const { entries } = obj;
    const now = Date.now();

    for (const raw of entries) {
      if (!Array.isArray(raw) || raw.length !== 2) continue;
      const [key, entry] = raw as [unknown, unknown];

      // Validate key
      if (typeof key !== "string" || key.length === 0 || key.length > 2048) continue;

      // Validate entry shape — reject anything missing required numeric fields
      // Use try-catch to handle Proxy objects that might throw on property access
      let validEntry: CacheEntry | null = null;
      try {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).createdAt === "number" &&
          typeof (entry as Record<string, unknown>).expiresAt === "number" &&
          typeof (entry as Record<string, unknown>).staleUntil === "number" &&
          typeof (entry as Record<string, unknown>).staleOnError === "number" &&
          typeof (entry as Record<string, unknown>).size === "number" &&
          Array.isArray((entry as Record<string, unknown>).tags)
        ) {
          // Validate tags are all strings
          const tags = (entry as Record<string, unknown>).tags as unknown[];
          if (tags.every((t): t is string => typeof t === "string")) {
            validEntry = entry as CacheEntry;
          }
        }
      } catch {
        /* skip invalid entries */
      }

      if (!validEntry) continue;

      const e = entry as CacheEntry;

      // Skip expired entries
      if (e.expiresAt !== Infinity && e.expiresAt < now) continue;

      // Enforce maxAbsoluteAgeMs on import
      if (now - e.createdAt > this.cfg.maxAbsoluteAgeMs) continue;

      // Validate body size limit
      if (e.size > this.cfg.maxBodySizeBytes + 512) continue;

      await this.storage.set(key, e);
      this.lru.touch(key);
      this.stats.totalEntries++;
      this.stats.totalSizeBytes += e.size;

      // Rebuild tag index
      for (const tag of e.tags) {
        const set = this.tagIndex.get(tag) ?? new Set<string>();
        set.add(key);
        this.tagIndex.set(tag, set);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _key(req: CacheableRequest): Promise<string> {
    const base = await this.cfg.cacheKey(req);
    return this.cfg.namespace ? `${this.cfg.namespace}:${base}` : base;
  }

  private _isCacheable(method: string): boolean {
    return this.cfg.cacheMethods.includes(method.toUpperCase());
  }

  private async _delete(key: string, entry?: CacheEntry): Promise<void> {
    await this.storage.delete(key);
    this.lru.remove(key);
    if (entry) {
      this.stats.totalEntries = Math.max(0, this.stats.totalEntries - 1);
      this.stats.totalSizeBytes = Math.max(0, this.stats.totalSizeBytes - entry.size);
      for (const tag of entry.tags) {
        this.tagIndex.get(tag)?.delete(key);
      }
    }
    /* NOTE: If entry is undefined (e.g., not found during LRU eviction),
       the tag index entry for that key will not be cleaned up.
       This is a minor leak on disk-based storage miss, acceptable trade-off
       since the key is gone from LRU and storage anyway. */
  }

  private async _ensureCapacity(newEntrySize: number): Promise<void> {
    // Entry count cap
    while (this.stats.totalEntries >= this.cfg.maxEntries) {
      const evictKey = this.lru.evict();
      if (!evictKey) break;
      const entry = await this.storage.get(evictKey);
      await this._delete(evictKey, entry ?? undefined);
      this.stats.evictions++;
    }

    // Size cap
    while (this.stats.totalSizeBytes + newEntrySize > this.cfg.maxSizeBytes) {
      const evictKey = this.lru.evict();
      if (!evictKey) break;
      const entry = await this.storage.get(evictKey);
      await this._delete(evictKey, entry ?? undefined);
      this.stats.evictions++;
    }
  }

  private _updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses + this.stats.staleHits;
    this.stats.hitRate = total > 0 ? (this.stats.hits + this.stats.staleHits) / total : 0;
  }
}

// ============================================================================
// #9  UTILITIES
// ============================================================================

/** Deep-clone a cache entry (response + tags array, no shared references). */
function cloneEntry(entry: CacheEntry): CacheEntry {
  return {
    ...entry,
    response: cloneResponse(entry.response),
    tags: [...entry.tags],
  };
}

/** Deep-clone a cacheable response (headers object + copy Uint8Array body). */
function cloneResponse(res: CacheableResponse): CacheableResponse {
  return {
    ...res,
    headers: { ...res.headers },
    body: res.body instanceof Uint8Array ? new Uint8Array(res.body) : res.body,
  };
}

/** Compute the actual byte length of a body value (accounts for UTF-8 multi-byte). */
function bodyBytes(body: string | Uint8Array | null): number {
  if (!body) return 0;
  // TextEncoder to get actual UTF-8 byte count, not JS char count.
  // For ASCII this is identical; for multi-byte characters it can be 2–4× larger.
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  return body.byteLength;
}

// ============================================================================
// #10  FACTORY HELPERS
// ============================================================================

/**
 * Create an HTTP cache backed by in-memory storage.
 */
export function createMemoryCache(config?: Omit<CacheConfig, "storage">): HTTPCache {
  return new HTTPCache({ ...config, storage: new MemoryStorageAdapter() });
}

/**
 * Create an HTTP cache backed by localStorage.
 * @throws {Error} If localStorage is not available in the current runtime.
 */
export function createLocalStorageCache(
  prefix?: string,
  config?: Omit<CacheConfig, "storage">,
): HTTPCache {
  if (typeof localStorage === "undefined") throw new Error("localStorage is not available");
  return new HTTPCache({ ...config, storage: new WebStorageAdapter(localStorage, prefix) });
}

/**
 * Create an HTTP cache backed by sessionStorage.
 * @throws {Error} If sessionStorage is not available in the current runtime.
 */
export function createSessionStorageCache(
  prefix?: string,
  config?: Omit<CacheConfig, "storage">,
): HTTPCache {
  if (typeof sessionStorage === "undefined") throw new Error("sessionStorage is not available");
  return new HTTPCache({ ...config, storage: new WebStorageAdapter(sessionStorage, prefix) });
}

/**
 * Create an HTTP cache backed by Cloudflare Workers KV.
 */
export function createKVCache(
  kv: CloudflareKVNamespace,
  config?: Omit<CacheConfig, "storage">,
): HTTPCache {
  return new HTTPCache({ ...config, storage: new CloudflareKVAdapter(kv) });
}

/**
 * Create a two-tier HTTP cache (L1: memory, L2: persistent adapter).
 */
export function createTwoTierCache(
  l2: CacheStorageAdapter,
  config?: Omit<CacheConfig, "storage">,
): HTTPCache {
  return new HTTPCache({ ...config, storage: new TwoTierStorageAdapter(l2) });
}
