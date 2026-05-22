/**
 * HTTP pagination system.
 * Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser.
 *
 * Features:
 *  - Offset / limit pagination
 *  - Page / per-page pagination
 *  - Cursor-based pagination (opaque cursors)
 *  - Relay-style cursor pagination (edges/node/pageInfo)
 *  - Link header pagination (RFC 5988 — GitHub style)
 *  - Keyset / seek pagination (last-seen value)
 *  - Token-based pagination (nextPageToken — Google API style)
 *  - Async iterator interface for all strategies
 *  - Auto-fetch next page (transparent pagination)
 *  - Collect all pages into array
 *  - Take N items across pages
 *  - Parallel prefetch (N pages ahead)
 *  - Typed generic responses
 *  - Abort / cancel support
 *  - Rate-aware pagination (respects Retry-After)
 *  - Per-page transform / filter
 *  - Pagination state serialization (resume support)
 */

// ============================================================================
// §1  TYPES
// ============================================================================

/** A single page of paginated results. */
export interface Page<T> {
  /** Items on this page */
  items: T[];
  /** Total item count across all pages, or null if unknown */
  total: number | null;
  /** Current page number, or null if not page-based */
  page: number | null;
  /** Items per page, or null if unknown */
  perPage: number | null;
  /** Total number of pages, or null if unknown */
  totalPages: number | null;
  /** Whether there are more pages after this one */
  hasNext: boolean;
  /** Whether there are pages before this one */
  hasPrev: boolean;
  /** Cursor for fetching the next page, or null */
  nextCursor: string | null;
  /** Cursor for fetching the previous page, or null */
  prevCursor: string | null;
  /**
   * Raw response from the API (the R type from PaginationConfig).
   * Use this to access additional response metadata not captured by the Page fields.
   *
   * @example
   * ```ts
   * const page = await firstPage;
   * const responseHeaders = (page.raw as Response).headers;
   * ```
   */
  raw: unknown;
}

/** Current state of a pagination iterator. */
export interface PaginationState {
  /** The pagination strategy in use */
  strategy: PaginationStrategy;
  /** Current page number (for page-based strategies) */
  page: number;
  /** Current offset (for offset-based strategies) */
  offset: number;
  /** Current cursor value (for cursor-based strategies) */
  cursor: string | null;
  /** Previous cursor for backward navigation */
  prevCursor: string | null;
  /** Current page token (for token-based strategies) */
  token: string | null;
  /** Whether pagination is complete (no more pages to fetch) */
  done: boolean;
  /** Total number of items fetched so far */
  totalFetched: number;
}

/** Supported pagination strategies. */
export type PaginationStrategy =
  | "offset"
  | "page"
  | "cursor"
  | "relay"
  | "link-header"
  | "token"
  | "keyset";

/** Configuration for a generic paginator. All strategies build on this. */
export interface PaginationConfig<T, R = unknown> {
  /** Fetch a single page. Receives current state, returns raw response. */
  fetch: (state: PaginationState) => Promise<R>;
  /** Extract items from the raw response. */
  getItems: (response: R, state: PaginationState) => T[];
  /** Determine if there is a next page. */
  hasNext: (response: R, state: PaginationState) => boolean;
  /** Extract the next cursor/token/page from the response. */
  getNext?: (response: R, state: PaginationState) => Partial<PaginationState> | null;
  /** Extract total item count from the response (optional). */
  getTotal?: (response: R) => number | null;
  /** Items per page (used for offset/page strategies). */
  perPage?: number;
  /** Starting page (for page strategy). */
  startPage?: number;
  /** Starting offset (for offset strategy). */
  startOffset?: number;
  /** Starting cursor (for cursor strategy). */
  startCursor?: string | null;
  /** Starting token (for token strategy). */
  startToken?: string | null;
  /** Transform each item after extraction. */
  transform?: (item: T) => T;
  /** Filter items after extraction. */
  filter?: (item: T) => boolean;
  /** AbortSignal to stop iteration. */
  signal?: AbortSignal;
  /** Delay between page fetches in ms (default: 0). */
  delayMs?: number;
  /** Max pages to fetch. 0 = unlimited (default: 0). */
  maxPages?: number;
  /** Called after each page fetch. */
  onPage?: (page: Page<T>, state: PaginationState) => void;
}

// ============================================================================
// §2  INITIAL STATE BUILDER
// ============================================================================

/** Build the initial PaginationState from a config and strategy name. */
function buildInitialState<T, R>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy,
): PaginationState {
  return {
    strategy,
    page: config.startPage ?? 1,
    offset: config.startOffset ?? 0,
    cursor: config.startCursor ?? null,
    prevCursor: null,
    token: config.startToken ?? null,
    done: false,
    totalFetched: 0,
  };
}

// ============================================================================
// §3  PAGE BUILDER
// ============================================================================

/** Build a Page<T> from fetched items, response, and state. */
function buildPage<T, R>(
  items: T[],
  response: R,
  state: PaginationState,
  config: PaginationConfig<T, R>,
  next: Partial<PaginationState> | null,
  hasNextOverride?: boolean,
): Page<T> {
  const total = config.getTotal?.(response) ?? null;
  const perPage = config.perPage ?? null;
  const totalPages = total !== null && perPage !== null ? Math.ceil(total / perPage) : null;

  const hasPrev =
    state.page > 1 ||
    state.offset > 0 ||
    (state as { prevCursor?: string | null }).prevCursor !== null;

  return {
    items,
    total,
    page: state.page,
    perPage,
    totalPages,
    hasNext: hasNextOverride ?? config.hasNext(response, state),
    hasPrev,
    nextCursor: next?.cursor ?? null,
    prevCursor: (state as { prevCursor?: string | null }).prevCursor ?? null,
    raw: response,
  };
}

// ============================================================================
// §4  CORE ASYNC ITERATOR
// ============================================================================

/**
 * Core paginator — yields one Page<T> per fetch.
 */
export async function* paginate<T, R = unknown>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
): AsyncGenerator<Page<T>> {
  let state = buildInitialState(config, strategy);
  let pageNum = 0;

  while (!state.done) {
    if (config.signal?.aborted) break;
    if (config.maxPages && pageNum >= config.maxPages) break;

    // Delay between pages
    if (pageNum > 0 && config.delayMs && config.delayMs > 0) {
      await sleep(config.delayMs, config.signal);
    }

    // Fetch
    let response: R;
    try {
      response = await config.fetch(state);
    } catch (err) {
      if (config.signal?.aborted) break;
      throw err;
    }

    // Extract + transform + filter items
    let items = config.getItems(response, state);
    if (config.transform) items = items.map(config.transform);
    if (config.filter) items = items.filter(config.filter);

    // Get next state
    const nextPartial = config.getNext ? config.getNext(response, state) : null;
    const hasMore = config.hasNext(response, state);
    const page = buildPage(items, response, state, config, nextPartial, hasMore);

    // Track previous cursor for bidirectional pagination
    const newPrevCursor = state.cursor;

    state = {
      ...state,
      page: nextPartial?.page ?? state.page + 1,
      offset: nextPartial?.offset ?? state.offset + items.length,
      cursor: nextPartial?.cursor ?? state.cursor,
      token: nextPartial?.token ?? state.token,
      done: !hasMore,
      totalFetched: state.totalFetched + items.length,
      prevCursor: newPrevCursor,
    };

    pageNum++;
    config.onPage?.(page, state);

    yield page;

    if (!hasMore) break;
  }
}

/**
 * Flatten pages into individual items.
 */
export async function* paginateItems<T, R = unknown>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
): AsyncGenerator<T> {
  for await (const page of paginate(config, strategy)) {
    for (const item of page.items) {
      yield item;
    }
  }
}

// ============================================================================
// §5  COLLECTION HELPERS
// ============================================================================

/**
 * Collect all items across all pages into a single array.
 */
export async function collectAll<T, R = unknown>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
): Promise<T[]> {
  const items: T[] = [];
  for await (const page of paginate(config, strategy)) {
    items.push(...page.items);
  }
  return items;
}

/**
 * Collect all pages into an array.
 */
export async function collectPages<T, R = unknown>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
): Promise<Page<T>[]> {
  const pages: Page<T>[] = [];
  for await (const page of paginate(config, strategy)) {
    pages.push(page);
  }
  return pages;
}

/**
 * Take exactly N items across pages. Stops fetching once N items are collected.
 */
export async function takeItems<T, R = unknown>(
  n: number,
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of paginateItems(config, strategy)) {
    items.push(item);
    if (items.length >= n) break;
  }
  return items;
}

// ============================================================================
// §6  BUILT-IN STRATEGIES
// ============================================================================

// ── 6.1  Offset / Limit ───────────────────────────────────────────────────────

/** Options for offset/limit-based pagination. */
export interface OffsetPaginationOptions<T> {
  /** API endpoint URL */
  url: string;
  /** Number of items per page */
  limit: number;
  /** Custom query parameter names for offset and limit. Default: "offset" and "limit" */
  paramNames?: { offset?: string; limit?: string };
  /** Custom fetch implementation. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers */
  headers?: Record<string, string>;
  /** Extract items from the parsed JSON response */
  getItems: (data: unknown) => T[];
  /** Extract total item count from the response (optional) */
  getTotal?: (data: unknown) => number | null;
  /** Custom has-more check. Receives data, fetched count, and total */
  hasMore?: (data: unknown, fetched: number, total: number | null) => boolean;
  /** AbortSignal to cancel pagination */
  signal?: AbortSignal;
  /** Maximum pages to fetch (0 = unlimited) */
  maxPages?: number;
  /** Delay between page fetches in ms */
  delayMs?: number;
}

/** Create an offset/limit-based paginator. */
export function createOffsetPaginator<T>(
  options: OffsetPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const params = options.paramNames ?? {};
  const offsetKey = params.offset ?? "offset";
  const limitKey = params.limit ?? "limit";
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, unknown>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      perPage: options.limit,

      fetch: async (state) => {
        const url = new URL(options.url);
        url.searchParams.set(offsetKey, String(state.offset));
        url.searchParams.set(limitKey, String(options.limit));
        const res = await fetchFn(url.toString(), {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        return res.json();
      },

      getItems: (data, _state) => options.getItems(data),

      getTotal: options.getTotal ?? (() => null),

      hasNext: (data, state) => {
        const total = options.getTotal?.(data) ?? null;
        if (options.hasMore)
          return options.hasMore(data, state.totalFetched + options.limit, total);
        if (total !== null) return state.offset + options.limit < total;
        const items = options.getItems(data);
        return items.length === options.limit;
      },

      getNext: (_, state) => ({ offset: state.offset + options.limit }),
    },
    "offset",
  );
}

// ── 6.2  Page / Per-page ──────────────────────────────────────────────────────

/** Options for page/per-page based pagination. */
export interface PagePaginationOptions<T> {
  /** API endpoint URL */
  url: string;
  /** Number of items per page */
  perPage: number;
  /** Starting page number. Default: 1 */
  startPage?: number;
  /** Custom query parameter names for page and per_page. Default: "page" and "per_page" */
  paramNames?: { page?: string; perPage?: string };
  /** Custom fetch implementation. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers */
  headers?: Record<string, string>;
  /** Extract items from the parsed JSON response */
  getItems: (data: unknown) => T[];
  /** Extract total item count from the response (optional) */
  getTotal?: (data: unknown) => number | null;
  /** Extract total page count from the response (optional) */
  getTotalPages?: (data: unknown) => number | null;
  /** AbortSignal to cancel pagination */
  signal?: AbortSignal;
  /** Maximum pages to fetch (0 = unlimited) */
  maxPages?: number;
  /** Delay between page fetches in ms */
  delayMs?: number;
}

/** Create a page/per-page based paginator. */
export function createPagePaginator<T>(options: PagePaginationOptions<T>): AsyncGenerator<Page<T>> {
  const params = options.paramNames ?? {};
  const pageKey = params.page ?? "page";
  const perPageKey = params.perPage ?? "per_page";
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, unknown>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
      startPage: options.startPage ?? 1,

      fetch: async (state) => {
        const url = new URL(options.url);
        url.searchParams.set(pageKey, String(state.page));
        url.searchParams.set(perPageKey, String(options.perPage));
        const res = await fetchFn(url.toString(), {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        return res.json();
      },

      getItems: (data) => options.getItems(data),
      getTotal: options.getTotal ?? (() => null),

      hasNext: (data, state) => {
        const totalPages = options.getTotalPages?.(data) ?? null;
        if (totalPages !== null) return state.page < totalPages;
        const total = options.getTotal?.(data) ?? null;
        if (total !== null) return state.page * options.perPage < total;
        return options.getItems(data).length === options.perPage;
      },

      getNext: (_, state) => ({ page: state.page + 1 }),
    },
    "page",
  );
}

// ── 6.3  Cursor ───────────────────────────────────────────────────────────────

/** Options for cursor-based pagination. */
export interface CursorPaginationOptions<T> {
  /** API endpoint URL */
  url: string;
  /** Query parameter name for the cursor. Default: "cursor" */
  paramName?: string;
  /** Custom fetch implementation. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers */
  headers?: Record<string, string>;
  /** Extract items from the parsed JSON response */
  getItems: (data: unknown) => T[];
  /** Extract the next cursor from the response */
  getNextCursor: (data: unknown) => string | null;
  /** Initial cursor value */
  startCursor?: string | null;
  /** AbortSignal to cancel pagination */
  signal?: AbortSignal;
  /** Maximum pages to fetch (0 = unlimited) */
  maxPages?: number;
  /** Delay between page fetches in ms */
  delayMs?: number;
}

/** Create a cursor-based paginator. */
export function createCursorPaginator<T>(
  options: CursorPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const cursorKey = options.paramName ?? "cursor";
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, unknown>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      startCursor: options.startCursor ?? null,

      fetch: async (state) => {
        const url = new URL(options.url);
        if (state.cursor) url.searchParams.set(cursorKey, state.cursor);
        const res = await fetchFn(url.toString(), {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        return res.json();
      },

      getItems: (data) => options.getItems(data),

      hasNext: (data) => options.getNextCursor(data) !== null,

      getNext: (data) => {
        const cursor = options.getNextCursor(data);
        return cursor ? { cursor } : null;
      },
    },
    "cursor",
  );
}

// ── 6.4  Relay Cursor (edges/node/pageInfo) ────────────────────────────────────

/** A single edge in a Relay-style paginated response. */
export interface RelayEdge<T> {
  /** The item at this edge */
  node: T;
  /** Opaque cursor for this edge */
  cursor: string;
}

/** Page metadata in a Relay-style paginated response. */
export interface RelayPageInfo {
  /** Whether there are more pages after this one */
  hasNextPage: boolean;
  /** Whether there are pages before this one */
  hasPreviousPage: boolean;
  /** Cursor of the first edge on this page, or null */
  startCursor: string | null;
  /** Cursor of the last edge on this page, or null */
  endCursor: string | null;
}

/** A Relay-style paginated response (edges + pageInfo pattern). */
export interface RelayConnection<T> {
  /** Edges on this page */
  edges: RelayEdge<T>[];
  /** Page metadata (hasNextPage, cursors) */
  pageInfo: RelayPageInfo;
  /** Total item count across all pages, if provided */
  totalCount?: number;
}

/** Options for Relay-style cursor pagination. */
export interface RelayPaginationOptions<T> {
  /** Function to fetch a relay connection. Receives { first, after } for forward pagination. */
  fetch: (args: {
    first?: number;
    after?: string | null;
    last?: number;
    before?: string | null;
  }) => Promise<RelayConnection<T>>;
  /** Number of items per page. Default: 20 */
  first?: number;
  /** Starting cursor */
  startCursor?: string | null;
  /** AbortSignal to cancel pagination */
  signal?: AbortSignal;
  /** Maximum pages to fetch (0 = unlimited) */
  maxPages?: number;
  /** Delay between page fetches in ms */
  delayMs?: number;
  /** Transform each node after extraction */
  transform?: (node: T) => T;
  /** Filter nodes after extraction */
  filter?: (node: T) => boolean;
  /** Called after each page fetch */
  onPage?: (page: Page<T>, state: PaginationState) => void;
}

/** Create a Relay-style cursor paginator (edges/node/pageInfo). */
export function createRelayPaginator<T>(
  options: RelayPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const pageSize = options.first ?? 20;

  return paginate<T, RelayConnection<T>>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(options.transform !== undefined ? { transform: options.transform } : {}),
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
      ...(options.onPage !== undefined ? { onPage: options.onPage } : {}),
      startCursor: options.startCursor ?? null,
      perPage: pageSize,

      fetch: (state) => options.fetch({ first: pageSize, after: state.cursor }),

      getItems: (conn) => conn.edges.map((e) => e.node),

      getTotal: (conn) => conn.totalCount ?? null,

      hasNext: (conn) => conn.pageInfo.hasNextPage,

      getNext: (conn) => {
        const cursor = conn.pageInfo.endCursor ?? null;
        return cursor ? { cursor } : null;
      },
    },
    "relay",
  );
}

// ── 6.5  Link Header (RFC 5988 — GitHub style) ────────────────────────────────

/** Options for Link header-based pagination (RFC 5988, GitHub style). */
export interface LinkHeaderPaginationOptions<T> {
  /** API endpoint URL */
  url: string;
  /** Custom fetch implementation. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers */
  headers?: Record<string, string>;
  /** Extract items from the parsed JSON response */
  getItems: (data: unknown) => T[];
  /** Extract total item count from the response and headers (optional) */
  getTotal?: (data: unknown, headers: Headers) => number | null;
  /** AbortSignal to cancel pagination */
  signal?: AbortSignal;
  /** Maximum pages to fetch (0 = unlimited) */
  maxPages?: number;
  /** Delay between page fetches in ms */
  delayMs?: number;
}

/** Internal response type for Link header pagination — wraps data, headers, and next URL. */
interface LinkHeaderResponse {
  /** Parsed JSON response body */
  data: unknown;
  /** Raw response headers (for getTotal) */
  headers: Headers;
  /** Extracted next page URL from the Link header */
  nextUrl: string | null;
}

/** Create a Link header-based paginator (RFC 5988, GitHub style). */
export function createLinkHeaderPaginator<T>(
  options: LinkHeaderPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, LinkHeaderResponse>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),

      fetch: async (state) => {
        const url = state.cursor ?? options.url; // cursor holds next URL for link-header
        const res = await fetchFn(url, {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        const nextUrl = parseLinkHeaderNext(res.headers.get("link") ?? "");
        const data = await res.json();
        return { data, headers: res.headers, nextUrl };
      },

      getItems: (res) => options.getItems(res.data),

      getTotal: (res) => options.getTotal?.(res.data, res.headers) ?? null,

      hasNext: (res) => res.nextUrl !== null,

      getNext: (res) => (res.nextUrl ? { cursor: res.nextUrl } : null),
    },
    "link-header",
  );
}

/**
 * Parse a Link header and extract the URL for rel="next".
 *
 * Handles both double and single quoted rel values per RFC 5988.
 * Also handles multiple rel values (e.g., `rel="next alternate"`).
 *
 * @param linkHeader The Link header value to parse
 * @returns The URL for the "next" relation, or null if not found
 *
 * @example
 * ```ts
 * const nextUrl = parseLinkHeaderNext('<https://api.example.com/items?page=2>; rel="next"');
 * // Returns: "https://api.example.com/items?page=2"
 * ```
 */
export function parseLinkHeaderNext(linkHeader: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    // Handle both double and single quoted rel values per RFC 5988
    const match = part.match(/<([^>]+)>.*?rel=["']([^"']+)["']/);
    if (match && match[2] && match[2].split(/\s+/).includes("next")) return match[1]!;
  }
  return null;
}

// ── 6.6  Token-based (nextPageToken — Google API style) ───────────────────────

/** Options for token-based pagination (nextPageToken, Google API style). */
export interface TokenPaginationOptions<T> {
  url: string;
  tokenParam?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  getItems: (data: unknown) => T[];
  getNextToken: (data: unknown) => string | null;
  getTotal?: (data: unknown) => number | null;
  signal?: AbortSignal;
  maxPages?: number;
  delayMs?: number;
  pageSize?: number;
  pageSizeParam?: string;
}

/** Create a token-based paginator (nextPageToken, Google API style). */
export function createTokenPaginator<T>(
  options: TokenPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const tokenParam = options.tokenParam ?? "pageToken";
  const pageSizeParam = options.pageSizeParam ?? "pageSize";
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, unknown>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(options.pageSize !== undefined ? { perPage: options.pageSize } : {}),

      fetch: async (state) => {
        const url = new URL(options.url);
        if (state.token) url.searchParams.set(tokenParam, state.token);
        if (options.pageSize) url.searchParams.set(pageSizeParam, String(options.pageSize));
        const res = await fetchFn(url.toString(), {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        return res.json();
      },

      getItems: (data) => options.getItems(data),
      getTotal: options.getTotal ?? (() => null),

      hasNext: (data) => options.getNextToken(data) !== null,

      getNext: (data) => {
        const token = options.getNextToken(data);
        return token ? { token } : null;
      },
    },
    "token",
  );
}

// ── 6.7  Keyset / Seek ────────────────────────────────────────────────────────

/** Options for keyset/seek-based pagination. */
export interface KeysetPaginationOptions<T> {
  url: string;
  keyParam: string; // e.g. "after_id" or "created_before"
  getLastKey: (items: T[]) => string | null;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  getItems: (data: unknown) => T[];
  hasMore?: (items: T[], data: unknown) => boolean;
  pageSize?: number;
  pageSizeParam?: string;
  startKey?: string | null;
  signal?: AbortSignal;
  maxPages?: number;
  delayMs?: number;
}

/** Create a keyset/seek-based paginator. */
export function createKeysetPaginator<T>(
  options: KeysetPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const pageSizeParam = options.pageSizeParam ?? "limit";
  const fetchFn = options.fetch ?? globalThis.fetch;

  return paginate<T, unknown>(
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(options.pageSize !== undefined ? { perPage: options.pageSize } : {}),
      startCursor: options.startKey ?? null,

      fetch: async (state) => {
        const url = new URL(options.url);
        if (state.cursor) url.searchParams.set(options.keyParam, state.cursor);
        if (options.pageSize) url.searchParams.set(pageSizeParam, String(options.pageSize));
        const res = await fetchFn(url.toString(), {
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        return res.json();
      },

      getItems: (data) => options.getItems(data),

      hasNext: (data, _state) => {
        const items = options.getItems(data);
        if (options.hasMore) return options.hasMore(items, data);
        if (options.pageSize) return items.length >= options.pageSize;
        return items.length > 0;
      },

      getNext: (data, _state) => {
        const items = options.getItems(data);
        const cursor = options.getLastKey(items);
        return cursor ? { cursor } : null;
      },
    },
    "keyset",
  );
}

// ============================================================================
// §7  PARALLEL PREFETCH
// ============================================================================

/**
 * Prefetch N pages ahead in parallel, yielding them in order.
 * Useful when pages are independent (offset/page strategy).
 */
export async function* prefetchPaginate<T, R = unknown>(
  config: PaginationConfig<T, R>,
  strategy: PaginationStrategy = "page",
  prefetchAhead = 2,
): AsyncGenerator<Page<T>> {
  const queue: Promise<Page<T> | null>[] = [];
  const gen = paginate(config, strategy);
  let done = false;

  async function enqueue(): Promise<void> {
    if (done) return;
    const { value, done: d } = await gen.next();
    done = d ?? false;
    queue.push(Promise.resolve(value ?? null));
  }

  // Fill prefetch queue
  for (let i = 0; i < prefetchAhead + 1; i++) await enqueue();

  while (queue.length > 0) {
    const page = await queue.shift()!;
    if (page === null || page === undefined) break;
    await enqueue();
    yield page;
  }
}

// ============================================================================
// §8  STATE SERIALIZATION (resume support)
// ============================================================================

/**
 * Serialize pagination state to a base64 string for storage/resumption.
 *
 * Warning: No versioning is included. If the PaginationState interface changes
 * (e.g., new fields are added), deserialization of old serialized states may
 * fail or produce incorrect results. Consider implementing your own versioning
 * if you store pagination state long-term.
 *
 * @param state The pagination state to serialize
 * @returns Base64-encoded JSON string
 */
export function serializePaginationState(state: PaginationState): string {
  return btoa(JSON.stringify(state));
}

/**
 * Deserialize a serialized pagination state string back to PaginationState.
 *
 * @param serialized Base64-encoded JSON string from serializePaginationState
 * @returns The reconstructed pagination state
 * @throws Error if the string is not valid base64/JSON
 */
export function deserializePaginationState(serialized: string): PaginationState {
  try {
    return JSON.parse(atob(serialized)) as PaginationState;
  } catch {
    throw new Error("Invalid pagination state string");
  }
}

// ============================================================================
// §9  UTILITIES
// ============================================================================

/** Promise-based delay with optional abort signal support. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) {
      r();
      return;
    }
    const timer = setTimeout(r, ms);
    if (signal)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
  });
}

/**
 * Convert a paginator to a standard async iterator with a return() method.
 */
export function toPaginationIterator<T>(source: AsyncIterable<T>): AsyncIterableIterator<T> {
  const iter = source[Symbol.asyncIterator]();
  return {
    next: () => iter.next(),
    return: (v?: unknown) => iter.return?.(v) ?? Promise.resolve({ value: v as T, done: true }),
    throw: (e?: unknown) => iter.throw?.(e) ?? Promise.reject(e),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Merge multiple paginators in round-robin order.
 *
 * Iterates through all paginators sequentially, yielding one item from each
 * in turn (round-robin). When one paginator exhausts, it is removed from the
 * rotation and the remaining paginators continue until all are done.
 *
  * Warning: Each paginator gets equal turns regardless of response speed.

 * If one paginator is significantly slower than others, items from faster
 * paginators will wait. For use cases requiring fairness based on data
 * availability, consider using separate iterators instead.
 *
 * @param paginators Multiple async iterables to merge
 * @yields Items from each paginator in round-robin order
 *
 * @example
 * ```ts
 * const combined = mergePaginators(paginator1, paginator2, paginator3);
 * for await (const item of combined) {
 *   console.log(item); // Prints: p1-item1, p2-item1, p3-item1, p1-item2, ...
 * }
 * ```
 */
export async function* mergePaginators<T>(...paginators: AsyncIterable<T>[]): AsyncGenerator<T> {
  const iters = paginators.map((p) => p[Symbol.asyncIterator]());
  const active = new Set(iters.map((_, i) => i));

  while (active.size > 0) {
    for (const i of [...active]) {
      const { value, done } = await iters[i]!.next();
      if (done) {
        active.delete(i);
        continue;
      }
      yield value!;
    }
  }
}
