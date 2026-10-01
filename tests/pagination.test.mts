import assert from "node:assert/strict";
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

function assertEqual<T>(a: T, b: T, note?: string) {
  const suffix = note ? ` (${note})` : "";
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    // Structural, not textual. `JSON.stringify` compared *key order*, so two
    // objects with the same content and a different insertion order were
    // reported as unequal, and it could not tell an absent key from one
    // holding `undefined` — both serialise to nothing.
    const keysA = Object.keys(a as object).sort();
    const keysB = Object.keys(b as object).sort();
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      throw new Error(
        `Expected keys ${JSON.stringify(keysB)} got ${JSON.stringify(keysA)}${suffix}`,
      );
    }
    for (const k of keysB) {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      if (av !== bv && JSON.stringify(av) !== JSON.stringify(bv)) {
        throw new Error(
          `Expected ${JSON.stringify(bv)} got ${JSON.stringify(av)} for key "${k}"${suffix}`,
        );
      }
    }
    return;
  }
  // `Object.is` so NaN, -0 and +0 are told apart where it matters.
  if (!Object.is(a as unknown, b as unknown)) {
    throw new Error(`Expected ${JSON.stringify(b)} got ${JSON.stringify(a)}${suffix}`);
  }
}

/** Assert a condition, with a message that says what was actually seen. */
function assertThat(cond: boolean, what: string): void {
  if (!cond) throw new Error(`Expected ${what}`);
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
  // The whole state, all eight fields. The test checked three of them, so a
  // serializer that dropped `strategy`, `offset`, `prevCursor` or `token` —
  // exactly the fields a resume depends on — passed.
  assertEqual(deserializePaginationState(s), state);
  // And it really is base64 of the JSON, not some other encoding.
  assertEqual(atob(s), JSON.stringify(state));
  assertEqual(JSON.parse(atob(s)), state);
  // Deterministic: the same state serializes to the same string.
  assertEqual(serializePaginationState(state), s);
  // A round trip preserves identity of value, not reference.
  const back = deserializePaginationState(s);
  assert.ok(back !== state, "a fresh object, not the original");
});

await test("deserializePaginationState throws on invalid input", async () => {
  const bad = [
    "!!not-base64!!",
    "",
    "a",
    btoa("not json at all"),
    btoa(JSON.stringify({ hello: "world" })),
    btoa(JSON.stringify([1, 2, 3])),
    btoa(JSON.stringify("a string")),
    btoa(JSON.stringify(null)),
    btoa(JSON.stringify(42)),
    btoa(JSON.stringify({ strategy: "page", done: false })),
    btoa(JSON.stringify({ strategy: "page", done: false, page: "3", offset: 0 })),
    btoa(JSON.stringify({ page: 1, offset: 0, done: "no", strategy: "page" })),
  ];
  for (const input of bad) {
    assert.throws(
      () => deserializePaginationState(input),
      /Invalid pagination state string/,
      `${JSON.stringify(input)} must be rejected`,
    );
  }
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
  // The whole Page object, not just its items: a page that lost its `page`
  // number, its `total`, or its `hasNext` would have passed.
  assertEqual(pages[0], {
    items: [1, 2],
    total: null,
    page: 1,
    perPage: 2,
    totalPages: null,
    hasNext: true,
    hasPrev: false,
    nextCursor: null,
    prevCursor: null,
    raw: { items: [1, 2] },
  });
  assertEqual(pages[1], {
    items: [3],
    total: null,
    page: 2,
    perPage: 2,
    totalPages: null,
    hasNext: false,
    hasPrev: true,
    nextCursor: null,
    prevCursor: null,
    raw: { items: [3] },
  });
});

await test("Page reports total and totalPages when getTotal is given", async () => {
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2, 3] }]),
    getItems: (d: DataPage) => d.items,
    getTotal: () => 7,
    hasNext: () => false,
    perPage: 3,
  })) {
    pages.push(page);
  }
  // 7 items at 3 per page is 3 pages, not 2 — a floor division here would
  // tell a caller they had seen everything after two.
  assertEqual(pages[0].total, 7);
  assertEqual(pages[0].perPage, 3);
  assertEqual(pages[0].totalPages, 3);
  // Without perPage, totalPages is genuinely unknown.
  const noPerPage: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1] }]),
    getItems: (d: DataPage) => d.items,
    getTotal: () => 100,
    hasNext: () => false,
  })) {
    noPerPage.push(page);
  }
  assertEqual(noPerPage[0].total, 100);
  assertEqual(noPerPage[0].perPage, null);
  assertEqual(noPerPage[0].totalPages, null);
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
  // maxPages counts *fetches*, and stops before the (maxPages + 1)-th, so a
  // config with more pages available than permitted must not over-fetch.
  assertEqual(pages.length, 2);
  assertEqual(pages[0].items, [1]);
  assertEqual(pages[1].items, [2]);
  assertEqual(pages[0].page, 1);
  assertEqual(pages[1].page, 2);
  // ...and the page that would have carried `hasNext: true` was never
  // produced, so a caller cannot mistake a truncated run for a complete one
  // by reading the last page's hasNext.
  assertEqual(pages[1].hasNext, true, "the last page still says there was more");
});

await test("maxPages: 0 means unlimited, not zero pages", async () => {
  // Bounded by the server instead of by the cap: the fetch refuses to answer
  // a fifth time, so a regression that turned `0` into "no pages" would still
  // be caught, and a regression that made it "one page" would fail loudly
  // rather than hang.
  let calls = 0;
  const pages: Page<number>[] = [];
  for await (const page of paginate({
    fetch: async () => {
      calls++;
      return { items: [calls] };
    },
    getItems: (d: DataPage) => d.items,
    hasNext: (_d, s) => s.page < 4,
    perPage: 1,
    maxPages: 0,
  })) {
    pages.push(page);
  }
  // 0 is "unlimited", so all four pages come back. A reading of "stop
  // immediately" would return none, and a reading of "one" would return one.
  assertEqual(pages.length, 4);
  assertEqual(calls, 4);
  assertEqual(
    pages.map((p) => p.items[0]),
    [1, 2, 3, 4],
  );
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
  // The order matters and is pinned: transform runs first, then filter on the
  // transformed values (so `x > 10` keeps 20, 30, 40 and drops 10).
  assertEqual(pages[0].items, [20, 30, 40]);
  assertEqual(pages[0].items.length, 3);
  // A filter that drops everything still yields the page — an empty page is
  // a page, and swallowing it would hide the fetch from the caller.
  const emptied: Page<number>[] = [];
  for await (const page of paginate({
    fetch: makeFetch([{ items: [1, 2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 2,
    filter: () => false,
  })) {
    emptied.push(page);
  }
  assertEqual(emptied.length, 1);
  assertEqual(emptied[0].items, []);
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
  const seen: Array<{ items: number[]; state: PaginationState }> = [];
  for await (const _page of paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }, { items: [3] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 2,
    onPage: (page, state) => {
      seen.push({ items: page.items, state: { ...state } });
    },
  })) {
    /* iterate */
  }
  // The count, and *what* the callback was handed — a hook that fired with an
  // empty page, or with a state that had not yet advanced, would pass a bare
  // counter.
  assertEqual(seen.length, 2);
  assertEqual(seen[0].items, [1]);
  assertEqual(seen[1].items, [2]);
  // The state handed to onPage is the one the *next* request will be made
  // with — the loop advances it before firing the hook — so it is always one
  // step ahead of the page it arrives with. Recorded here because pairing
  // `state.page` with `page.page` in a log line is exactly the off-by-one
  // this makes possible, and the counter alone would never have shown it.
  assertEqual(seen[0].state.page, 2);
  assertEqual(seen[1].state.page, 3);
  assertEqual(seen[0].state.totalFetched, 1);
  assertEqual(seen[1].state.totalFetched, 2);
  assertEqual(seen[0].state.strategy, "page");
  // The state the page itself was built from is on the page.
  assertEqual(seen[0].items.length, 1);
  // The state snapshot is a copy: a hook that mutated it must not steer the
  // iteration.
  const mutated: number[] = [];
  for await (const _page of paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 2,
    onPage: (_p, st) => {
      st.page = 99;
      mutated.push(st.page);
    },
  })) {
    /* iterate */
  }
  assertEqual(mutated, [99, 99], "the hook saw its own write");
  // ...and the iteration still advanced 1, 2.
  const advanced: number[] = [];
  for await (const p of paginate({
    fetch: makeFetch([{ items: [1] }, { items: [2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    maxPages: 2,
    onPage: () => {
      /* noop */
    },
  })) {
    advanced.push(p.page);
  }
  assertEqual(advanced, [1, 2]);
});

await test("aborting during the inter-page delay stops pagination promptly", async () => {
  // The delay between pages must be abortable. Without that, an abort() issued
  // during back-off was only noticed after the full delayMs elapsed.
  const controller = new AbortController();
  let fetchCount = 0;
  const start = Date.now();
  const pages: Page<number>[] = [];

  for await (const page of paginate({
    fetch: async () => {
      fetchCount++;
      // Abort once the first page is in hand, i.e. while the next sleep runs.
      if (fetchCount === 1) setTimeout(() => controller.abort(), 10);
      return { items: [fetchCount] };
    },
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
    perPage: 1,
    delayMs: 30_000,
    maxPages: 10,
    signal: controller.signal,
  })) {
    pages.push(page);
  }

  const elapsed = Date.now() - start;
  assertOk(elapsed < 5000, `abort must cut the 30s delay short, took ${elapsed}ms`);
  // The abort short-circuits the sleep, but the signal is only re-checked at the
  // top of the loop, so the page that was already scheduled is still fetched
  // once before iteration stops. What matters here is that it stops: without
  // an abortable delay this would have taken the full 30s per remaining page.
  assertEqual(fetchCount, 2, "iteration must stop after the abort");
  assertEqual(pages.length, 2);
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
  assert.equal(first.done, false);
  const returned = await iter.return!();
  assert.equal(returned.done, true);
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
  // The injected error must reach the caller unchanged, not merely *some*
  // error — a wrapper that swallowed it and threw a TypeError passed before.
  await assert.rejects(
    () => iter.throw!(new Error("fail")),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "fail", "the injected error must propagate unchanged");
      return true;
    },
    "iterator.throw must surface the injected error",
  );
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
  } catch (e) {
    // A flaky upstream must not be able to mask a defect in the paginator, so
    // only a genuine transport failure is tolerated. Anything else — a bad
    // page shape, a wrong count, a TypeError from our own code — is rethrown
    // and fails the suite. A bare `catch {}` here would have swallowed all of
    // them and reported a pass.
    assert.ok(
      e instanceof Error &&
        /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|timeout|network/i.test(
          `${e.name}: ${e.message}`,
        ),
      `paginator failed for a non-network reason and must not be skipped: ${String(e)}`,
    );
    console.log(`    → jsonplaceholder unavailable, skipping: ${(e as Error).message}`);
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
  assertEqual(new URL(lastUrl).searchParams.get("pageSize"), "3");
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
  assert.equal(urls[0], "https://api.test/items?after=initial-key");
  assert.equal(
    urls.every((u) => u.startsWith("https://api.test/items?after=")),
    true,
    `unexpected URLs: ${JSON.stringify(urls)}`,
  );
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

/**
 * GitHub answers a throttled request with HTTP 200 and an error object, not a
 * 403 — so it reaches the assertions as a "page" that is not an array, and the
 * transport-failure skip below cannot see it. Deliberately narrow: only a
 * non-array object whose own `message` names a rate limit, so a paginator that
 * genuinely returned a malformed page still fails.
 */
function isGitHubThrottled(items: unknown): boolean {
  if (Array.isArray(items) || typeof items !== "object" || items === null) {
    return false;
  }
  const message = (items as { message?: unknown }).message;
  return typeof message === "string" && /rate limit|abuse detection/i.test(message);
}

await test("LinkHeader paginator real HTTP against GitHub API", async () => {
  let callCount = 0;
  try {
    for await (const page of createLinkHeaderPaginator<any>({
      url: "https://api.github.com/repos/opencode-ai/opencode/issues?per_page=2",
      getItems: (d: any) => d,
      maxPages: 2,
    })) {
      callCount++;
      if (isGitHubThrottled(page.items)) {
        console.log("    → GitHub API rate limited, skipping");
        return;
      }
      assertOk(Array.isArray(page.items));
    }
    assertEqual(callCount, 2);
  } catch (e) {
    // Only a transport failure or a GitHub rate limit may skip this test. A
    // malformed page or a wrong call count is a real defect and must fail.
    const why = `${(e as Error)?.name ?? ""}: ${(e as Error)?.message ?? String(e)}`;
    assert.ok(
      /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|timeout|network|429|rate limit|403/i.test(
        why,
      ),
      `Link-header paginator failed for a non-network reason and must not be skipped: ${why}`,
    );
    console.log(`    → GitHub API unavailable, skipping: ${why}`);
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

// ── Regression: the five fixes ──────────────────────────────────────────

suite("regression: filter/offset, infinite loops, state encoding, Link headers");

await test("regression: a filter no longer corrupts the offset", async () => {
  // The offset advanced by the *filtered* item count. Whenever a filter drops
  // anything the next request asks for rows the client has already seen and
  // steps over rows it has not. Measured with a parity filter over three-item
  // pages: offsets 0, 2, 4, 6, 8, 10 instead of 0, 3, 6, 9 — the odd items
  // never yielded at all, and every even one yielded twice.
  const requested: number[] = [];
  const it = paginate<number>(
    {
      fetch: async (s) => {
        requested.push(s.offset);
        return { items: [s.offset, s.offset + 1, s.offset + 2] };
      },
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.offset < 9,
      filter: (n) => n % 2 === 0,
    },
    "offset",
  );
  const got: number[] = [];
  for await (const page of it) got.push(...page.items);

  assertEqual(requested, [0, 3, 6, 9], "the offset advances by what the server sent");
  assertEqual(got, [0, 2, 4, 6, 8, 10], "every surviving item, once");
  assertEqual(new Set(got).size, got.length, "and no duplicates");
  // The even items of the full 0..11 range, each exactly once — the odd ones
  // are correctly dropped by the filter, and none of the evens is lost or
  // repeated. 10 is the last item of the fourth page (offsets 9, 10, 11).
  assertEqual(got, [0, 2, 4, 6, 8, 10]);
  assertEqual(
    Array.from({ length: 12 }, (_, n) => n).filter((n) => n % 2 === 0),
    got,
  );
  // A transform is 1:1, so it must not move the offset at all.
  const tRequested: number[] = [];
  const tGot: number[] = [];
  for await (const page of paginate<number>(
    {
      fetch: async (s) => {
        tRequested.push(s.offset);
        return { items: [s.offset, s.offset + 1] };
      },
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.offset < 4,
      transform: (n) => n * 10,
    },
    "offset",
  )) {
    tGot.push(...page.items);
  }
  assertEqual(tRequested, [0, 2, 4]);
  assertEqual(tGot, [0, 10, 20, 30, 40, 50]);
  // An explicit getNext still wins over the arithmetic.
  const explicit: number[] = [];
  for await (const page of paginate<number>(
    {
      fetch: async (s) => ({ items: [s.page], page: s.page }),
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.page < 3,
      getNext: (_d, s) => ({ page: s.page + 1 }),
    },
    "page",
  )) {
    explicit.push(page.page);
  }
  assertEqual(explicit, [1, 2, 3]);
});

await test("regression: a paginator that cannot advance stops instead of looping", async () => {
  // `hasNext` and `getNext` are two independent callbacks and nothing checked
  // that agreeing to another page gave the fetcher something new to ask for.
  // `maxPages` defaults to 0 — "unlimited" — so a disagreement had no bound at
  // all: a Relay connection reporting `hasNextPage: true` beside a null
  // `endCursor` was followed forever, re-fetching the same page on every tick.
  // A hanging test is the only symptom a looping paginator ever produces.
  const conn = {
    edges: [{ node: 1, cursor: "c1" }],
    pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "c0", endCursor: null },
  };
  let relayCalls = 0;
  const relayPages: Page<number>[] = [];
  for await (const page of createRelayPaginator<number>({
    first: 1,
    fetch: async () => {
      relayCalls++;
      return conn;
    },
  })) {
    relayPages.push(page);
    if (relayPages.length > 5) throw new Error("the relay paginator never stopped");
  }
  assertEqual(relayPages.length, 1, "one page, then it recognised there was nowhere to go");
  assertEqual(relayCalls, 1, "and it did not re-fetch the same page");

  // A cursor API that keeps handing back the cursor it was given.
  let stuckCalls = 0;
  const stuck: number[] = [];
  for await (const _p of createCursorPaginator<number>({
    url: "https://x.test/i",
    getItems: (d: unknown) => d as number[],
    getNextCursor: () => "STUCK",
    fetch: (async () => {
      stuckCalls++;
      return new Response("[1]", { headers: { "content-type": "application/json" } });
    }) as never,
  })) {
    stuck.push(1);
    if (stuck.length > 5) throw new Error("the cursor paginator never stopped");
  }
  // Two pages, not one: a paginator cannot know a cursor is stuck until it
  // has asked once. The first request carries no cursor, the second carries
  // the cursor the first returned, and that value comes back again — so the
  // third request is never made. Bounded, where before it was not.
  assertEqual(stuck.length, 2, "ask once, then recognise the repeat");
  assertEqual(stuckCalls, 2, "and stop instead of re-fetching forever");

  // A working cursor chain is unaffected — three pages, three distinct cursors.
  // The cursor travels in the body, as a real API's does, rather than being
  // read out of a counter the fetch also advances.
  let i = 0;
  const good: number[] = [];
  const seenCursors: Array<string | null> = [];
  for await (const page of createCursorPaginator<number>({
    url: "https://x.test/i",
    getItems: (d: unknown) => (d as { items: number[] }).items,
    getNextCursor: (d: unknown) => (d as { cursor: string | null }).cursor,
    fetch: (async () => {
      const n = ++i;
      return new Response(JSON.stringify({ items: [n], cursor: n < 3 ? `c${n}` : null }), {
        headers: { "content-type": "application/json" },
      });
    }) as never,
  })) {
    good.push(...page.items);
    seenCursors.push(page.nextCursor);
  }
  assertEqual(good, [1, 2, 3], "a real cursor chain still walks to the end");
  assertEqual(seenCursors, ["c1", "c2", null], "each page reports the cursor it handed on");
  assertEqual(i, 3, "and no fourth request");
  // ...and a page/offset strategy is still allowed to progress by those
  // numbers with a null getNext, which is a no-op rather than a stop.
  let byPage = 0;
  for await (const _p of paginate<number>(
    {
      fetch: async (st) => ({ items: [st.page] }),
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, st) => st.page < 3,
      getNext: () => null,
      perPage: 1,
    },
    "page",
  )) {
    byPage++;
  }
  assertEqual(byPage, 3);
});

await test("regression: pagination state round-trips a non-ASCII cursor", async () => {
  // `btoa` takes a Latin-1 (binary) string and throws InvalidCharacterError on
  // anything above U+00FF. A cursor is opaque and can hold any character, so
  // an ordinary state made serialization throw and the paginator
  // un-resumable — with no hint that the state itself was the problem.
  const state: PaginationState = {
    strategy: "cursor",
    page: 4,
    offset: 60,
    cursor: "curseur-é-☃-🎉",
    prevCursor: "précédent",
    token: "tøken-中",
    done: false,
    totalFetched: 60,
  };
  const serialized = serializePaginationState(state);
  assert.equal(typeof serialized, "string");
  assertEqual(deserializePaginationState(serialized), state, "byte-for-byte");
  // The encoding is UTF-8 through base64, not a raw Latin-1 string.
  assertEqual(
    new TextDecoder().decode(Uint8Array.from(atob(serialized), (c) => c.charCodeAt(0))),
    JSON.stringify(state),
  );
  // The ASCII form is unchanged, so a state written by the old code still
  // reads back — the version both agree on.
  const ascii: PaginationState = { ...state, cursor: "abc", prevCursor: null, token: "tok" };
  assertEqual(
    atob(serializePaginationState(ascii)),
    JSON.stringify(ascii),
    "an ASCII state serializes exactly as before",
  );
  assertEqual(deserializePaginationState(serializePaginationState(ascii)), ascii);
});

await test("regression: a Link header with a comma in the URL is followed", async () => {
  // The header was split on every comma, and a URI is allowed to contain one
  // — `?ids=1,2,3` is routine. The entry was cut in half, the `rel` was no
  // longer found, and the function reported "no next page": pagination
  // stopping early against a server that had more to give, with no error.
  assertEqual(
    parseLinkHeaderNext('<https://api.test/items?ids=1,2,3>; rel="next"'),
    "https://api.test/items?ids=1,2,3",
  );
  assertEqual(
    parseLinkHeaderNext('<https://a/1>; rel="prev", <https://a/?ids=4,5>; rel="next"'),
    "https://a/?ids=4,5",
    "and the comma-bearing one is still found in a multi-link header",
  );
  // The shapes that already worked.
  assertEqual(parseLinkHeaderNext('<https://example.com/2>; rel="next"'), "https://example.com/2");
  assertEqual(parseLinkHeaderNext("<https://example.com/2>; rel='next'"), "https://example.com/2");
  assertEqual(
    parseLinkHeaderNext('<https://example.com/2>; rel="next alternate"'),
    "https://example.com/2",
  );
  assertEqual(
    parseLinkHeaderNext(
      '<https://a/1>; rel="first", <https://a/3>; rel="next", <https://a/2>; rel="prev"',
    ),
    "https://a/3",
  );
  assertEqual(parseLinkHeaderNext('<https://example.com>; rel="prev"'), null);
  assertEqual(parseLinkHeaderNext(""), null);
  // A `rel="next"` inside another parameter's value is not the relation.
  assertEqual(parseLinkHeaderNext('<https://a/1>; title="rel=next"; rel="prev"'), null);
  // End to end: a link-header paginator over a server that puts a comma in
  // every next URL walks all three pages.
  let calls = 0;
  const bodies = [[1, 2], [3, 4], [5]];
  const got: number[] = [];
  for await (const page of createLinkHeaderPaginator<number>({
    url: "https://x.test/i",
    getItems: (d: unknown) => d as number[],
    fetch: (async () => {
      const idx = calls++;
      const next = idx < 2 ? `<https://x.test/i?ids=${idx + 1},${idx + 2}>; rel="next"` : null;
      return new Response(JSON.stringify(bodies[idx] ?? []), {
        headers: { "content-type": "application/json", ...(next ? { link: next } : {}) },
      });
    }) as never,
  })) {
    got.push(...page.items);
  }
  assertEqual(got, [1, 2, 3, 4, 5], "all three pages, not just the first");
  assertEqual(calls, 3);
});

await test("regression: a deserialized state must actually be a state", async () => {
  // `atob` and `JSON.parse` succeeding says nothing about the shape. Anything
  // that decoded to JSON was returned as a `PaginationState` and typed as
  // one, so a caller resuming from it read `page`/`offset`/`done` off an
  // object that had none.
  for (const junk of [
    btoa('{"hello":"world"}'),
    btoa("[1,2,3]"),
    btoa('"a string"'),
    btoa("null"),
    btoa("42"),
    btoa('{"strategy":"page","done":false}'),
    btoa('{"strategy":"page","done":false,"page":"3","offset":0}'),
    btoa('{"page":1,"offset":0,"done":"no","strategy":"page"}'),
  ]) {
    assert.throws(
      () => deserializePaginationState(junk),
      /Invalid pagination state string/,
      `${JSON.stringify(junk)} must be refused`,
    );
  }
  // A real one still round-trips, and the prototype-pollution strip is intact.
  const good: PaginationState = {
    strategy: "cursor",
    page: 2,
    offset: 10,
    cursor: "c",
    prevCursor: null,
    token: null,
    done: false,
    totalFetched: 10,
  };
  assertEqual(deserializePaginationState(serializePaginationState(good)), good);
  const dirty = btoa(
    '{"strategy":"cursor","page":2,"offset":10,"cursor":"c","prevCursor":null,"token":null,"done":false,"totalFetched":10,"__proto__":{"polluted":1}}',
  );
  assertEqual(
    (deserializePaginationState(dirty) as Record<string, unknown>).__proto__,
    Object.prototype,
  );
  assertEqual(({} as Record<string, unknown>).polluted, undefined);
});

await test("regression: takeItems(0) and takeItems(negative) return nothing", async () => {
  // The loop pushed an item and only then tested `items.length >= n`, so
  // `takeItems(0)` returned one item and so did every negative N (1 >= -5).
  // The README documents `n <= 0` as returning [], so this was a contradiction
  // with the stated contract, not an undocumented edge.
  const config = () => ({
    fetch: makeFetch([{ items: [1, 2, 3, 4, 5] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 5,
  });
  for (const n of [0, -1, -5, -0.5]) {
    assertEqual(await takeItems(n, config()), [], `takeItems(${n})`);
  }
  // A non-number is refused the same way rather than coerced.
  assertEqual(await takeItems(NaN, config()), [], "takeItems(NaN)");
  // And N is honoured exactly at and above the boundary, so the guard is not
  // simply eating the first item.
  assertEqual(await takeItems(1, config()), [1], "n = 1");
  assertEqual(await takeItems(3, config()), [1, 2, 3], "n = 3");
  assertEqual(await takeItems(5, config()), [1, 2, 3, 4, 5], "n = exactly one page");
  assertEqual(await takeItems(9, config()), [1, 2, 3, 4, 5], "n above what exists");
  // A fractional N floors rather than returning a partial page: 2.9 is a
  // request for two whole items.
  assertEqual(await takeItems(2.9, config()), [1, 2], "fractional n floors");
  // Infinity is the documented "more than exists" case, and must not be
  // swallowed by the same guard that rejects NaN.
  assertEqual(await takeItems(Infinity, config()), [1, 2, 3, 4, 5], "n = Infinity");
  // A zero request must not touch the network at all.
  let calls = 0;
  await takeItems(0, {
    fetch: async () => {
      calls++;
      return { items: [1] };
    },
    getItems: (d: DataPage) => d.items,
    hasNext: () => true,
  });
  assertEqual(calls, 0, "takeItems(0) performs no request");
});

await test("regression: prefetchPaginate overlaps the consumer with the next fetch", async () => {
  const { prefetchPaginate } = await import("../src/pagination.ts");
  // `enqueue` awaited `gen.next()` before queueing it, so the consumer was
  // blocked on the *next* page's fetch before it could even be handed the page
  // it already had. The queue cost bookkeeping and prefetched nothing —
  // strictly worse than a plain `paginate`, which at least never waited.
  // The gate every fetch after the first waits on. It is released by the
  // consumer, once it is working on the page it was handed.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let starved = 0;
  let peak = 0;
  let inFlight = 0;
  let calls = 0;
  const PAGES = 4;
  const got: number[] = [];

  for await (const page of prefetchPaginate<number, DataPage>(
    {
      fetch: async () => {
        calls++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        const idx = calls - 1;
        if (idx > 0) {
          // The next request cannot complete until the consumer has started
          // work on the page it already has. Under the old awaiting
          // `enqueue`, the consumer never receives that page, so this never
          // resolves and `starved` trips.
          const outcome = await Promise.race([
            gate.then(() => "released" as const),
            new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
          ]);
          if (outcome === "timeout") starved++;
        }
        inFlight--;
        return { items: [idx] };
      },
      getItems: (d: DataPage) => d.items,
      // `hasNext` is required — `paginate` calls it after every fetch — and is
      // always true here so that `maxPages` alone decides when to stop. The
      // paginator yields the page that turns `hasMore` false as well, so a
      // fixture that counts pages by hand has to allow for one more than it
      // looks like; `maxPages` is the clean way to express "exactly this many".
      hasNext: () => true,
      maxPages: PAGES,
    },
    "page",
    2,
  )) {
    got.push(...page.items);
    release();
    // Simulate the consumer working on the page it was just given.
    await new Promise((r) => setTimeout(r, 10));
  }

  assertEqual(
    starved,
    0,
    "every queued fetch completed while the consumer worked — the consumer is never blocked on the next fetch",
  );
  assertEqual(got, [0, 1, 2, 3], "all four pages, in order, exactly once each");
  assertEqual(calls, PAGES, "no page fetched twice and none skipped");
  assertEqual(new Set(got).size, got.length, "and no duplicates");
  // A single async generator runs one body at a time, so `prefetchAhead` buys
  // overlap, not parallel sockets. Asserted so the distinction stays explicit
  // and a future change does not silently widen it.
  assertEqual(peak, 1, "one request at a time — overlap, not request-level parallelism");
});

await test("regression: prefetchPaginate surfaces errors and survives early exit", async () => {
  const { prefetchPaginate } = await import("../src/pagination.ts");
  // An error on a queued request must still reach a consumer that is there to
  // receive it, unchanged.
  let n = 0;
  let caught: unknown;
  try {
    for await (const p of prefetchPaginate<number, DataPage>(
      {
        fetch: async () => {
          if (n++ === 1) throw new Error("boom");
          return { items: [n] };
        },
        getItems: (d: DataPage) => d.items,
        hasNext: () => n <= 4,
      },
      "page",
      3,
    )) {
      void p;
    }
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "a failing request must reach the consumer");
  assertEqual((caught as Error).message, "boom", "and propagate unchanged");

  // Abandoning the generator leaves queued requests in flight with nobody
  // awaiting them. If one of those rejects, the rejection is unhandled: in
  // Node that terminates the process, and in a browser it becomes a global
  // `unhandledrejection` the caller can neither catch nor attribute. A
  // consumer that stops early is a normal thing to do, so it must not be able
  // to take the process down.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let i = 0;
    let taken = 0;
    for await (const p of prefetchPaginate<number, DataPage>(
      {
        fetch: async () => {
          const idx = i++;
          await new Promise((r) => setTimeout(r, 10));
          // A page the consumer will never ask for, and it fails.
          if (idx === 3) throw new Error("late-boom");
          return { items: [idx] };
        },
        getItems: (d: DataPage) => d.items,
        hasNext: () => true,
      },
      "page",
      3,
    )) {
      void p;
      if (++taken === 2) break;
    }
    // Give the abandoned requests time to reject and for Node to notice.
    await new Promise((r) => setTimeout(r, 250));
    assertEqual(unhandled, [], "an abandoned queued request must not reject unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

await test("regression: totalFetched counts rows fetched, not rows kept", async () => {
  // The offset already advanced by `rawCount` — what the server returned —
  // precisely so a filter could not desynchronise it. `totalFetched` added
  // `items.length`, the count *after* the filter, so the same page was
  // reported as two different sizes by two fields of the same state, and any
  // `hasNext` written against totalFetched under-counted the work done: a
  // filter dropping half of every page also halved the total.
  const seen: { fetched: number; kept: number }[] = [];
  for await (const page of paginate<number, DataPage>(
    {
      fetch: async (s) => ({ items: [s.offset, s.offset + 1, s.offset + 2, s.offset + 3] }),
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.offset < 8,
      filter: (n) => n % 2 === 0,
    },
    "offset",
  )) {
    // `state` is the state the request was made with; the count of the page
    // just built is exposed on the page itself.
    seen.push({ fetched: page.items.length, kept: page.items.length });
  }
  // 0,4,8 -> 3 pages of 4 fetched, 2 kept each.
  assertEqual(seen.length, 3, "three pages");
  // The real check: the final state's totalFetched must equal the 12 rows the
  // server was asked for, not the 6 that survived.
  const states: PaginationState[] = [];
  for await (const page of paginate<number, DataPage>(
    {
      fetch: async (s) => {
        states.push(s);
        return { items: [s.offset, s.offset + 1, s.offset + 2, s.offset + 3] };
      },
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.offset < 8,
      filter: (n) => n % 2 === 0,
    },
    "offset",
  )) {
    void page;
  }
  // The state handed to the *last* request has counted the first two pages:
  // 8 rows fetched, 4 kept.
  assertEqual(states.length, 3, "three requests");
  assertEqual(states[0]!.totalFetched, 0, "nothing fetched before the first request");
  assertEqual(states[1]!.totalFetched, 4, "four rows fetched before the second request");
  assertEqual(states[2]!.totalFetched, 8, "eight rows fetched before the third request");
  // Without a filter the two definitions coincide, so this is not a blanket
  // change to the field.
  const noFilter: number[] = [];
  for await (const page of paginate<number, DataPage>(
    {
      fetch: async (s) => {
        noFilter.push(s.totalFetched);
        return { items: [s.offset, s.offset + 1] };
      },
      getItems: (d: DataPage) => d.items,
      hasNext: (_d, s) => s.offset < 4,
    },
    "offset",
  )) {
    void page;
  }
  assertEqual(noFilter, [0, 2, 4], "unfiltered: fetched and kept are the same count");
});

await test("regression: one failing source does not abort a merge", async () => {
  // `mergePaginators` is for fanning out over several endpoints. A single
  // endpoint erroring ended the whole iteration and discarded everything the
  // healthy sources had already yielded — silently, with no error to explain
  // the short stream. The failing source is dropped and the rest continue.
  const g1 = paginateItems<number, DataPage>({
    fetch: makeFetch([{ items: [1, 2] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 2,
  });
  const g2 = paginateItems<number, DataPage>(
    {
      fetch: async () => {
        throw new Error("endpoint down");
      },
      getItems: (d: DataPage) => d.items,
      hasNext: () => true,
    },
    "page",
  );
  const g3 = paginateItems<number, DataPage>({
    fetch: makeFetch([{ items: [10, 20] }]),
    getItems: (d: DataPage) => d.items,
    hasNext: () => false,
    perPage: 2,
  });

  const merged: number[] = [];
  for await (const item of mergePaginators(g1, g2, g3)) merged.push(item);
  assertEqual(merged, [1, 10, 2, 20], "the failing source is skipped, the rest arrive");
  assertThat(!merged.some((v) => v === undefined), "no undefined holes from the dropped source");

  // A source that fails on its *second* page takes its already-yielded items
  // with it — the items it produced before failing are still delivered, and
  // only the source stops.
  const flaky = paginateItems<number, DataPage>(
    {
      fetch: makeFetch([{ items: [1] }, { items: [2] }]),
      getItems: (d: DataPage) => d.items,
      perPage: 1,
      hasNext: () => true,
      // `maxPages` bounds the fixture to exactly two pages. Driving this off
      // `hasNext` instead does not: the paginator yields the page that turns
      // `hasMore` false as well, so a two-page fixture has to allow for a
      // third, and `makeFetch` repeats its last page into it.
      maxPages: 2,
    },
    "page",
  );
  const failing = paginateItems<number, DataPage>(
    {
      fetch: async (): Promise<DataPage> => {
        throw new Error("down");
      },
      getItems: (d: DataPage) => d.items,
      hasNext: () => true,
    },
    "page",
  );
  const out: number[] = [];
  for await (const item of mergePaginators(flaky, failing)) out.push(item);
  assertEqual(out, [1, 2], "the healthy source completes despite its neighbour failing");

  // When *every* source fails, the merge ends quietly with nothing rather than
  // throwing: the caller's `for await` simply completes.
  const dead = paginateItems<number, DataPage>(
    {
      fetch: async (): Promise<DataPage> => {
        throw new Error("down");
      },
      getItems: (d: DataPage) => d.items,
      hasNext: () => true,
    },
    "page",
  );
  const none: number[] = [];
  for await (const item of mergePaginators(dead)) none.push(item);
  assertEqual(none, [], "all sources failing yields an empty stream, not a throw");
});

await test("regression: a Link rel is matched case-insensitively", async () => {
  // RFC 5988 §3.1: relation types are compared case-insensitively, and RFC
  // 8288 §4 makes parameter names case-insensitive too. Matching `rel`
  // case-sensitively meant a server sending `rel="Next"` — legal, and common
  // in the wild — produced no next page, so pagination stopped one page early
  // with no error and no indication that rows were being skipped.
  assertEqual(
    parseLinkHeaderNext('<https://api.test/i?p=2>; rel="Next"'),
    "https://api.test/i?p=2",
    'rel="Next"',
  );
  assertEqual(
    parseLinkHeaderNext("<https://api.test/i?p=2>; rel='NEXT'"),
    "https://api.test/i?p=2",
    "single-quoted and upper",
  );
  assertEqual(
    parseLinkHeaderNext('<https://api.test/i?p=2>; REL="next"'),
    "https://api.test/i?p=2",
    "the parameter name itself upper-cased",
  );
  assertEqual(
    parseLinkHeaderNext('<https://api.test/i?p=3>; rel="next Alternate"'),
    "https://api.test/i?p=3",
    "a multi-value rel with the next token in mixed case",
  );
  assertEqual(
    parseLinkHeaderNext(
      '<https://api.test/i?p=2>; rel="Next", <https://api.test/i?p=9>; rel="prev"',
    ),
    "https://api.test/i?p=2",
    "the case-insensitive entry is found in a multi-link header",
  );
  // Case-insensitivity must not make a non-next relation match.
  assertEqual(parseLinkHeaderNext('<https://api.test/i?p=1>; rel="Prev"'), null, 'rel="Prev"');
  assertEqual(
    parseLinkHeaderNext('<https://api.test/i?p=1>; title="REL=next"; rel="prev"'),
    null,
    "a rel= inside another parameter's value is still not the relation",
  );
  // End to end, against a server that capitalises its rel.
  let calls = 0;
  const bodies = [[1, 2], [3, 4], [5]];
  const got: number[] = [];
  for await (const page of createLinkHeaderPaginator<number>({
    url: "https://x.test/i",
    getItems: (d: unknown) => d as number[],
    fetch: (async () => {
      const idx = calls++;
      const next = idx < 2 ? `<https://x.test/i?p=${idx + 2}>; rel="Next"` : null;
      return new Response(JSON.stringify(bodies[idx] ?? []), {
        headers: { "content-type": "application/json", ...(next ? { link: next } : {}) },
      });
    }) as never,
  })) {
    got.push(...page.items);
  }
  assertEqual(got, [1, 2, 3, 4, 5], "all three pages, not just the first");
  assertEqual(calls, 3, "and the paginator followed every link");
});

await test("regression: a deserialized state must name a real strategy and real numbers", async () => {
  // The shape check accepted any string as a strategy and any number as a
  // cursor, and never looked at `totalFetched` at all. A state is then resumed
  // by handing it straight back to a paginator, so a bogus strategy silently
  // selected the wrong fetcher, a numeric cursor was stringified into a query
  // parameter, and a missing totalFetched became `undefined + n` = NaN.
  const enc = (o: unknown) => btoa(JSON.stringify(o));
  const base = {
    strategy: "page",
    page: 1,
    offset: 0,
    cursor: null,
    prevCursor: null,
    token: null,
    done: false,
    totalFetched: 0,
  };
  for (const bad of [
    { ...base, strategy: "not-a-strategy" },
    { ...base, strategy: "" },
    { ...base, strategy: "PAGE" },
    { ...base, strategy: 1 },
    { ...base, cursor: 12345 },
    { ...base, cursor: { $ne: null } },
    { ...base, prevCursor: 7 },
    { ...base, token: [] },
    { ...base, totalFetched: "0" },
    { ...base, totalFetched: null },
  ]) {
    assert.throws(
      () => deserializePaginationState(enc(bad)),
      /Invalid pagination state string/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }

  // Non-finite numbers have to be built as raw JSON text. `JSON.stringify`
  // writes both `NaN` and `Infinity` as `null`, so encoding a state holding
  // one and asserting on the result silently tests `null` instead — which is
  // already refused for being the wrong type, so the check would pass whether
  // or not the finiteness test existed.
  //
  // `1e999` is valid JSON and `JSON.parse` returns `Infinity` for it, so a
  // serialized state really can carry one; each of these must be refused. A
  // resumed state with `offset: Infinity` would compute every subsequent
  // offset as Infinity and stop paginating, silently, having fetched nothing
  // more.
  for (const [field, lit] of [
    ["page", "1e999"],
    ["page", "-1e999"],
    ["offset", "1e999"],
    ["offset", "-1e999"],
    ["totalFetched", "1e999"],
    ["totalFetched", "-1e999"],
  ] as const) {
    const json =
      `{"strategy":"page","page":1,"offset":0,"cursor":null,"prevCursor":null,` +
      `"token":null,"done":false,"totalFetched":0,${JSON.stringify(field)}:${lit}}`;
    assert.equal(
      JSON.parse(json)[field] === Infinity || JSON.parse(json)[field] === -Infinity,
      true,
      `the payload for ${field}=${lit} really does parse to a non-finite number`,
    );
    assert.throws(
      () => deserializePaginationState(btoa(json)),
      /Invalid pagination state string/,
      `${field}=${lit} must be refused`,
    );
  }

  // NaN is the one non-finite number JSON cannot express at all: `JSON.parse`
  // rejects the bare `NaN` literal, and `JSON.stringify(NaN)` is `null`. No
  // serialized state can therefore ever carry one, so the `NaN` arm of the
  // finiteness check is unreachable from this entry point and is documented as
  // such rather than tested with a payload that could not exist.
  // A *missing* totalFetched is not a state either.
  const { totalFetched: _omitted, ...withoutTotal } = base;
  assert.throws(
    () => deserializePaginationState(enc(withoutTotal)),
    /Invalid pagination state string/,
    "a state with no totalFetched",
  );
  // The three cursor fields are optional — an older state legitimately omits
  // them, and there is no version tag to tell the two apart — but a wrong type
  // for one is still refused, which is what the check is for.
  const { cursor: _c, prevCursor: _p, token: _t, ...noCursors } = base;
  const withoutCursorFields = deserializePaginationState(enc(noCursors));
  assertEqual(
    withoutCursorFields,
    noCursors,
    "omitted cursor fields are accepted, and come back absent rather than set to null",
  );
  assert.equal(
    Object.hasOwn(withoutCursorFields, "cursor"),
    false,
    "JSON drops an undefined field, so no key is invented for it",
  );
  // Every real strategy round-trips, and an unusual but valid state — a
  // negative page, a cursor on a cursor strategy — is not over-rejected.
  for (const strategy of [
    "offset",
    "page",
    "cursor",
    "relay",
    "link-header",
    "token",
    "keyset",
  ] as const) {
    const state: PaginationState = {
      strategy,
      page: 3,
      offset: 30,
      cursor: "c",
      prevCursor: "p",
      token: "t",
      done: true,
      totalFetched: 30,
    };
    assertEqual(
      deserializePaginationState(serializePaginationState(state)),
      state,
      `strategy "${strategy}"`,
    );
  }
  assertEqual(
    deserializePaginationState(
      serializePaginationState({
        ...base,
        strategy: "cursor",
        page: 0,
        offset: 0,
        cursor: "start",
        prevCursor: null,
        token: null,
        done: false,
        totalFetched: 0,
      }),
    ).cursor,
    "start",
    "a first-page cursor state",
  );
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
