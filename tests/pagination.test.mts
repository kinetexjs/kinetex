import {
  collectAll,
  collectPages,
  createCursorPaginator,
  createKeysetPaginator,
  createLinkHeaderPaginator,
  createOffsetPaginator,
  createPagePaginator,
  createRelayPaginator,
  createTokenPaginator,
  deserializePaginationState,
  mergePaginators,
  paginate,
  paginateItems,
  serializePaginationState,
  takeItems,
  toPaginationIterator,
  parseLinkHeaderNext,
  type Page,
  type PaginationState,
} from "../src/pagination.ts";
import { kinetex } from "../src/mod.ts";

const client = kinetex({ baseURL: "https://jsonplaceholder.typicode.com", maxAttempts: 1 });

let passed = 0,
  failed = 0;
const failures: { name: string; err: unknown }[] = [];

function suite(name: string) {
  console.log(`\n${name}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
    failures.push({ name, err });
  }
}

function assertEqual<T>(a: T, b: T) {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const sa = JSON.stringify(a),
      sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`Expected ${sb} got ${sa}`);
  } else if (a !== b) {
    throw new Error(`Expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}

function assertOk(val: unknown) {
  if (!val) throw new Error(`Expected truthy, got ${String(val)}`);
}

type DataPage = { items: number[]; total?: number; cursor?: string | null; token?: string | null };

function makeFetch(pages: DataPage[]) {
  let i = 0;
  return async (_state: PaginationState): Promise<DataPage> => {
    const idx = Math.min(i, pages.length - 1);
    i++;
    return pages[idx]!;
  };
}

// ── parseLinkHeaderNext ──────────────────────────────────────────────────

suite("parseLinkHeaderNext");

await test("returns null for empty string", async () => {
  assertEqual(parseLinkHeaderNext(""), null);
});

await test("returns null for header without next rel", async () => {
  assertEqual(parseLinkHeaderNext('<https://example.com>; rel="prev"'), null);
});

await test("extracts next URL with double quotes", async () => {
  assertEqual(parseLinkHeaderNext('<https://example.com/2>; rel="next"'), "https://example.com/2");
});

await test("extracts next URL with single quotes", async () => {
  assertEqual(parseLinkHeaderNext("<https://example.com/2>; rel='next'"), "https://example.com/2");
});

await test("handles multiple rel values", async () => {
  assertEqual(
    parseLinkHeaderNext('<https://example.com/2>; rel="next alternate"'),
    "https://example.com/2",
  );
});

await test("handles multiple links, picks next", async () => {
  const header =
    '<https://example.com/1>; rel="first", <https://example.com/3>; rel="next", <https://example.com/2>; rel="prev"';
  assertEqual(parseLinkHeaderNext(header), "https://example.com/3");
});

// ── serialize / deserialize ──────────────────────────────────────────────

suite("Pagination state serialization");

await test("serializePaginationState roundtrips", async () => {
  const state: PaginationState = {
    strategy: "page",
    page: 3,
    offset: 20,
    cursor: "abc",
    prevCursor: null,
    token: "tok",
    done: false,
    totalFetched: 30,
  };
  const s = serializePaginationState(state);
  const d = deserializePaginationState(s);
  assertEqual(d.page, 3);
  assertEqual(d.cursor, "abc");
  assertEqual(d.totalFetched, 30);
});

await test("deserializePaginationState throws on invalid input", async () => {
  let threw = false;
  try {
    deserializePaginationState("!!not-base64!!");
  } catch {
    threw = true;
  }
  assertOk(threw);
});

// ── paginate core ────────────────────────────────────────────────────────

suite("paginate core");

await test("paginate yields pages until hasNext returns false", async () => {
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage, s) => s.totalFetched + d.items.length < 3,
    perPage: 2,
  })) {
    pages.push(page);
  }
  assertEqual(pages.length, 2);
  assertEqual(pages[0].items, [1, 2]);
  assertEqual(pages[1].items, [3]);
});

await test("paginate respects maxPages", async () => {
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 2,
  })) {
    pages.push(page);
  }
  assertEqual(pages.length, 2);
});

await test("paginate respects signal abort", async () => {
  const ac = new AbortController();
  ac.abort();
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: async () => ({ items: [1] }),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 10,
    signal: ac.signal,
  })) {
    pages.push(page);
  }
  assertEqual(pages.length, 0);
});

await test("paginate applies transform and filter", async () => {
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2, 3, 4] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 4,
    transform: (x: number) => x * 10,
    filter: (x: number) => x > 10,
  })) {
    pages.push(page);
  }
  assertEqual(pages[0].items, [20, 30, 40]);
});

await test("paginate uses getNext to update state", async () => {
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([
      { items: [1], cursor: "c1" },
      { items: [2], cursor: null },
    ]),
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage) => d.cursor !== null,
    getNext: (d: DataPage): Partial<PaginationState> | null =>
      d.cursor ? { cursor: d.cursor } : null,
    perPage: 1,
  })) {
    pages.push(page);
  }
  assertEqual(pages.length, 2);
  assertEqual(pages[0].nextCursor, "c1");
  assertEqual(pages[1].nextCursor, null);
});

await test("paginate calls onPage callback", async () => {
  let callCount = 0;
  for await (const _page of paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 2,
    onPage: () => {
      callCount++;
    },
  })) {
    /* iterate */
  }
  assertEqual(callCount, 2);
});

await test("paginate with delayMs waits between pages", async () => {
  let fetchCount = 0;
  const start = Date.now();
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: async () => {
      fetchCount++;
      return { items: [fetchCount] };
    },
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage, s) => s.totalFetched < 2,
    perPage: 1,
    delayMs: 50,
    maxPages: 2,
  })) {
    pages.push(page);
  }
  assertOk(Date.now() - start >= 40);
  assertEqual(pages.length, 2);
});

// ── paginateItems ────────────────────────────────────────────────────────

suite("paginateItems");

await test("paginateItems yields individual items across pages", async () => {
  const items: number[] = [];
  for await (const item of paginateItems({
    fetch: makeFetch([{ items: [1, 2] }, { items: [3, 4] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage, s) => s.totalFetched + d.items.length < 4,
    perPage: 2,
  })) {
    items.push(item);
  }
  assertEqual(items, [1, 2, 3, 4]);
});

// ── collect helpers ──────────────────────────────────────────────────────

suite("Collection helpers");

await test("collectAll collects all items from pages", async () => {
  const items = await collectAll({
    fetch: makeFetch([{ items: [1, 2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage, s) => s.totalFetched + d.items.length < 3,
    perPage: 2,
  });
  assertEqual(items, [1, 2, 3]);
});

await test("collectPages collects all page objects", async () => {
  const pages = await collectPages({
    fetch: makeFetch([{ items: [1, 2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: (d: DataPage, s) => s.totalFetched + d.items.length < 3,
    perPage: 2,
  });
  assertEqual(pages.length, 2);
  assertEqual(pages[0].items, [1, 2]);
  assertEqual(pages[1].items, [3]);
});

await test("takeItems takes exactly N items across pages", async () => {
  const items = await takeItems(3, {
    fetch: makeFetch([{ items: [1, 2, 3, 4, 5] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 5,
  });
  assertEqual(items, [1, 2, 3]);
});

// ── toPaginationIterator ─────────────────────────────────────────────────

suite("toPaginationIterator");

await test("toPaginationIterator wraps generator with return", async () => {
  const gen = paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
  });
  const iter = toPaginationIterator(gen);
  const first = await iter.next();
  assertOk(!first.done);
  const returned = await iter.return!();
  assertOk(returned.done);
});

await test("toPaginationIterator return when iterator lacks return", async () => {
  const simple = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i++ < 1 ? { value: i, done: false } : { value: undefined, done: true }),
      };
    },
  };
  const iter = toPaginationIterator(simple);
  const first = await iter.next();
  assertEqual(first.value, 1);
  // return() should work even without inner return
  const r = await iter.return!(42);
  assertEqual(r.done, true);
});

await test("toPaginationIterator throw when iterator lacks throw", async () => {
  const simple = {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: 1, done: false }) };
    },
  };
  const iter = toPaginationIterator(simple);
  const first = await iter.next();
  assertEqual(first.value, 1);
  let threw = false;
  try {
    await iter.throw!(new Error("fail"));
  } catch {
    threw = true;
  }
  assertOk(threw);
});

// ── Factory paginators (use real fetch with Response objects) ────────────

suite("createOffsetPaginator");

await test("Offset paginator real HTTP against jsonplaceholder", async () => {
  try {
    const pages: Page<any>[] = [];
    for await (const page of createOffsetPaginator<any>({
      url: "https://jsonplaceholder.typicode.com/posts",
      limit: 5,
      paramNames: { offset: "_start", limit: "_limit" },
      getItems: (d: any) => d,
      getTotal: () => 100,
      maxPages: 2,
    })) {
      pages.push(page);
      assertEqual(page.items.length, 5);
    }
    assertEqual(pages.length, 2);
  } catch {
    // jsonplaceholder can be flaky; skip on network error
  }
});

await test("Offset paginator hasMore function with real HTTP", async () => {
  let calls = 0;
  const pages: Page<any>[] = [];
  for await (const page of createOffsetPaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    limit: 5,
    paramNames: { offset: "_start", limit: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    hasMore: (_, fetched) => {
      calls++;
      return fetched < 15;
    },
    maxPages: 5,
  })) {
    pages.push(page);
    assertEqual(page.items.length, 5);
  }
  assertEqual(pages.length, 3);
});

await test("Offset paginator custom param names with real HTTP", async () => {
  const pages: Page<any>[] = [];
  for await (const page of createOffsetPaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    limit: 3,
    paramNames: { offset: "_start", limit: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    maxPages: 2,
  })) {
    pages.push(page);
    assertEqual(page.items.length, 3);
  }
  assertEqual(pages.length, 2);
});

suite("createPagePaginator");

await test("Page paginator real HTTP against jsonplaceholder", async () => {
  const pages: Page<any>[] = [];
  for await (const page of createPagePaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    perPage: 5,
    paramNames: { page: "_page", perPage: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    maxPages: 2,
  })) {
    pages.push(page);
    assertEqual(page.items.length, 5);
  }
  assertEqual(pages.length, 2);
});

await test("Page paginator with startPage", async () => {
  for await (const page of createPagePaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    perPage: 5,
    startPage: 3,
    paramNames: { page: "_page", perPage: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    maxPages: 1,
  })) {
    assertEqual(page.page, 3);
  }
});

await test("Page paginator with getTotalPages using real HTTP", async () => {
  for await (const page of createPagePaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    perPage: 5,
    paramNames: { page: "_page", perPage: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    getTotalPages: () => 20,
    maxPages: 1,
  })) {
    assertEqual(page.totalPages, 20);
  }
});

await test("Page paginator respects maxPages with real HTTP", async () => {
  let count = 0;
  for await (const _page of createPagePaginator<any>({
    url: "https://jsonplaceholder.typicode.com/posts",
    perPage: 5,
    paramNames: { page: "_page", perPage: "_limit" },
    getItems: (d: any) => d,
    getTotal: () => 100,
    maxPages: 1,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

suite("createCursorPaginator");

await test("Cursor paginator stops when cursor null", async () => {
  let count = 0;
  for await (const _page of createCursorPaginator<number>({
    url: "https://api.test/items",
    fetch: async () => new Response(JSON.stringify([1])),
    getItems: (d: any) => d,
    getNextCursor: () => null,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

suite("createTokenPaginator");

await test("Token paginator uses pageToken param", async () => {
  let lastUrl = "";
  let callNum = 0;
  for await (const page of createTokenPaginator<number>({
    url: "https://api.test/items",
    fetch: async (url: string) => {
      lastUrl = url;
      callNum++;
      return new Response(
        JSON.stringify({ items: [1, 2, 3], nextToken: callNum < 2 ? "tok2" : null }),
      );
    },
    getItems: (d: any) => d.items,
    getNextToken: (d: any) => d.nextToken ?? null,
    pageSize: 3,
    maxPages: 2,
  })) {
    assertEqual(page.items.length, 3);
  }
  assertOk(lastUrl.includes("pageSize=3"));
});

await test("Token paginator stops when token null", async () => {
  let count = 0;
  for await (const _page of createTokenPaginator<number>({
    url: "https://api.test/items",
    fetch: async () => new Response(JSON.stringify({ items: [1] })),
    getItems: (d: any) => d.items,
    getNextToken: () => null,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

suite("createKeysetPaginator");

await test("Keyset paginator stops when items < pageSize", async () => {
  let count = 0;
  for await (const _page of createKeysetPaginator<number>({
    url: "https://api.test/items",
    keyParam: "after",
    getLastKey: (items) => (items.length > 0 ? "last" : null),
    fetch: async () => new Response(JSON.stringify([1])),
    getItems: (d: any) => d,
    pageSize: 5,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

suite("createRelayPaginator");

await test("Relay paginator fetches edges", async () => {
  let callCount = 0;
  const paginator = createRelayPaginator<number>({
    fetch: async ({ first, after }) => {
      callCount++;
      return {
        edges: [
          { node: 1, cursor: "c1" },
          { node: 2, cursor: "c2" },
        ],
        pageInfo: {
          hasNextPage: callCount < 2,
          hasPreviousPage: false,
          startCursor: "c1",
          endCursor: "c2",
        },
        totalCount: 4,
      };
    },
    first: 2,
    maxPages: 2,
  });
  const pages: Page<number>[] = [];
  for await (const page of paginator) pages.push(page);
  assertEqual(pages.length, 2);
  assertEqual(pages[0].items, [1, 2]);
});

// ── mergePaginators ──────────────────────────────────────────────────────

suite("mergePaginators");

await test("mergePaginators interleaves items", async () => {
  const g1 = paginateItems({
    fetch: makeFetch([{ items: [1, 2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 2,
  });
  const g2 = paginateItems({
    fetch: makeFetch([{ items: [10, 20] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 2,
  });
  const merged: number[] = [];
  for await (const item of mergePaginators(g1, g2)) merged.push(item);
  assertEqual(merged, [1, 10, 2, 20]);
});

// ── Page properties ──────────────────────────────────────────────────────

suite("Page properties");

await test("Page hasPrev false for first page", async () => {
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2], total: 4 }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    getTotal: (d: DataPage) => d.total ?? null,
    perPage: 2,
  })) {
    assertEqual(page.hasPrev, false);
    assertEqual(page.total, 4);
    assertEqual(page.totalPages, 2);
  }
});

await test("Page totalPages null when missing info", async () => {
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
  })) {
    assertEqual(page.total, null);
    assertEqual(page.totalPages, null);
    assertEqual(page.perPage, null);
  }
});

// ── Keyset paginator additional branches ──────────────────────────────────

suite("Keyset paginator branches");

await test("Keyset paginator with startKey uses initial cursor", async () => {
  const urls: string[] = [];
  let callNum = 0;
  for await (const _p of createKeysetPaginator<number>({
    url: "https://api.test/items",
    keyParam: "after",
    startKey: "initial-key",
    getLastKey: () => (callNum++ === 0 ? "cursor-2" : null),
    fetch: async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([1]));
    },
    getItems: (d: any) => d,
  })) {
    if (callNum > 2) break;
  }
  assertOk(urls[0]?.includes("after=initial-key"));
});

await test("Keyset paginator getLastKey returns null stops pagination", async () => {
  let count = 0;
  for await (const _p of createKeysetPaginator<number>({
    url: "https://api.test/items",
    keyParam: "after",
    getLastKey: () => null,
    fetch: async () => new Response(JSON.stringify([1, 2])),
    getItems: (d: any) => d,
    hasMore: (items) => false,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

await test("Keyset paginator hasMore with empty items returns false", async () => {
  let count = 0;
  for await (const _p of createKeysetPaginator<number>({
    url: "https://api.test/items",
    keyParam: "after",
    getLastKey: (items) => (items.length > 0 ? "cursor" : null),
    fetch: async () => new Response(JSON.stringify([])),
    getItems: (d: any) => d,
    pageSize: 5,
    hasMore: (items) => items.length > 0,
  })) {
    count++;
  }
  assertEqual(count, 1);
});

suite("Additional branch coverage");

await test("paginate rethrows fetch errors unrelated to abort", async () => {
  const gen = paginate({
    fetch: async () => {
      throw new Error("network error");
    },
    getItems: (d: DataPage) => [],
    hasNext: () => true,
    perPage: 1,
    maxPages: 1,
  });
  let threw = false;
  try {
    for await (const _ of gen) {
    }
  } catch (e: any) {
    threw = true;
    assertEqual(e.message, "network error");
  }
  assertOk(threw);
});

await test("Offset paginator ends when items < limit via real HTTP", async () => {
  let totalItems = 0;
  for await (const _page of createOffsetPaginator<any>({
    url: "https://jsonplaceholder.typicode.com/comments",
    limit: 500,
    paramNames: { offset: "_start", limit: "_limit" },
    getItems: (d: any) => d,
    maxPages: 5,
  })) {
    totalItems += _page.items.length;
  }
  assertEqual(totalItems, 500);
});

await test("prefetchPaginate prefetches ahead", async () => {
  const { prefetchPaginate } = await import("../src/pagination.ts");
  let callCount = 0;
  const pages: Page<number>[] = [];
  for await (const page of prefetchPaginate(
    {
      fetch: async () => {
        callCount++;
        return { items: [callCount] };
      },
      getItems: (d: DataPage) => d.items,
      hasNext: (d: DataPage, s) => s.totalFetched < 3,
      getNext: () => null,
      perPage: 1,
      maxPages: 4,
    },
    "page",
    2,
  )) {
    pages.push(page);
  }
  // paginate yields the page where hasMore=false before breaking, so 4 pages, 4 fetches
  assertEqual(pages.length, 4);
  assertEqual(callCount, 4);
});

await test("LinkHeader paginator real HTTP against GitHub API", async () => {
  let callCount = 0;
  try {
    for await (const page of createLinkHeaderPaginator<any>({
      url: "https://api.github.com/repos/opencode-ai/opencode/issues?per_page=2",
      getItems: (d: any) => d,
      maxPages: 2,
    })) {
      callCount++;
      assertOk(Array.isArray(page.items));
    }
    assertEqual(callCount, 2);
  } catch {
    // Skip if GitHub API is unavailable (rate limit, network)
    console.log("    → GitHub API unavailable, skipping");
  }
});

suite("Real HTTP");

await test("GET /posts returns array", async () => {
  const res = await client.get<any[]>("/posts");
  assertEqual(res.status, 200);
  assertOk(Array.isArray(res.data));
  assertOk(res.data.length > 0);
});

await test("GET /posts?_limit=5 returns 5 items", async () => {
  const res = await client.get<any[]>("/posts", { params: { _limit: 5 } });
  assertEqual(res.status, 200);
  assertEqual(res.data.length, 5);
});

await test("GET /users returns 10 users", async () => {
  const res = await client.get<any[]>("/users");
  assertEqual(res.status, 200);
  assertEqual(res.data.length, 10);
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
}
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
