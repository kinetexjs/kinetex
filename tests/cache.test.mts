import assert from "node:assert/strict";
import { kinetex, HTTPCache, MemoryStorageAdapter, createTwoTierCache } from "../src/mod.ts";
import { createMemoryCache } from "../src/mod.ts";
import { getAuthFingerprint } from "../src/cache.ts";

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

const BASE = "https://httpbin.org";

// ============================================================================
// §1  HTTPCache CORE
// ============================================================================

suite("HTTPCache Core");

await test("set and get work", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/get`, method: "GET", headers: {} };
  const res = {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: '{"test":true}',
  };
  assert.equal(await cache.set(req, res), true);
  const r = await cache.get(req);
  assert.notEqual(r, null, "should return cached entry");
  assert.equal(r.entry.response.body, '{"test":true}');
  assert.equal(r.stale, false);
});

await test("get returns null for non-cacheable method", async () => {
  const cache = createMemoryCache();
  const r = await cache.get({ url: `${BASE}/post`, method: "POST", headers: {} });
  assert.equal(r, null);
});

await test("set skips non-cacheable method", async () => {
  const cache = createMemoryCache();
  const ok = await cache.set(
    { url: `${BASE}/post`, method: "POST", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  assert.equal(ok, false);
});

await test("set skips non-cacheable status codes", async () => {
  const cache = createMemoryCache();
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 500, statusText: "Error", headers: {}, body: "err" },
  );
  assert.equal(ok, false);
});

await test("set respects honorCacheControl: no-store", async () => {
  const cache = createMemoryCache({ honorCacheControl: true });
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "no-store" }, body: "x" },
  );
  assert.equal(ok, false);
});

await test("set with honorCacheControl disabled caches no-store", async () => {
  const cache = createMemoryCache({ honorCacheControl: false });
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "no-store" }, body: "x" },
  );
  assert.equal(ok, true);
});

await test("set with force bypasses no-store", async () => {
  const cache = createMemoryCache({ honorCacheControl: true });
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "no-store" }, body: "x" },
    { force: true },
  );
  assert.equal(ok, true);
});

await test("set rejects body > maxBodySizeBytes", async () => {
  const cache = createMemoryCache({ maxBodySizeBytes: 5 });
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "this is too long" },
  );
  assert.equal(ok, false);
});

await test("set with custom ttlMs", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/custom-ttl`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { ttlMs: 500 },
  );
  const r = await cache.get({ url: `${BASE}/custom-ttl`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should return entry with custom ttl");
  assert.equal(r.stale, false);
});

await test("set with Vary: * returns false (uncacheable)", async () => {
  const cache = createMemoryCache();
  const ok = await cache.set(
    { url: `${BASE}/x`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { vary: "*" }, body: "x" },
  );
  assert.equal(ok, false);
});

await test("set with Vary header differentiates requests", async () => {
  const cache = createMemoryCache();
  const reqA = { url: `${BASE}/vary`, method: "GET", headers: { "accept-language": "en" } };
  const reqB = { url: `${BASE}/vary`, method: "GET", headers: { "accept-language": "fr" } };
  const res = {
    status: 200,
    statusText: "OK",
    headers: { vary: "accept-language" },
    body: "content",
  };
  await cache.set(reqA, res);
  const r1 = await cache.get(reqA);
  const r2 = await cache.get(reqB);
  assert.notEqual(r1, null, "should hit for matching vary");
  assert.equal(r2, null, "should miss for different vary");
});

await test("set with tags stores them", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/tagged`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { tags: ["a", "b"] },
  );
  const r = await cache.get({ url: `${BASE}/tagged`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should return entry with tags");
  assert.deepEqual(r.entry.tags, ["a", "b"]);
});

await test("delete removes entry", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/del`, method: "GET", headers: {} };
  await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.equal(await cache.delete(req), true);
  assert.equal(await cache.get(req), null);
});

await test("delete returns false for missing entry", async () => {
  const cache = createMemoryCache();
  const ok = await cache.delete({ url: `${BASE}/no-such`, method: "GET", headers: {} });
  assert.equal(ok, false);
});

await test("clear removes all entries", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/c1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  await cache.set(
    { url: `${BASE}/c2`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
  );
  await cache.clear();
  assert.equal(cache.getStats().totalEntries, 0);
  assert.equal(await cache.get({ url: `${BASE}/c1`, method: "GET", headers: {} }), null);
});

await test("getStats returns correct structure", async () => {
  const cache = createMemoryCache();
  // Was five `typeof x === "number"` checks, satisfied by NaN, by -1 and by
  // any number at all. Pin the exact zeroed shape of a fresh cache instead.
  const s = cache.getStats();
  assert.deepEqual(s, {
    hits: 0,
    misses: 0,
    staleHits: 0,
    errors: 0,
    evictions: 0,
    totalEntries: 0,
    totalSizeBytes: 0,
    hitRate: 0,
  });
});

await test("resetStats clears stats", async () => {
  const cache = createMemoryCache();
  // Build up every counter first, so "reset" has something to actually reset.
  const req = { url: `${BASE}/miss`, method: "GET", headers: {} };
  await cache.get(req);
  await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  await cache.get(req);
  const before = cache.getStats();
  assert.equal(before.misses, 1, "the miss must have been counted");
  assert.equal(before.hits, 1, "the hit must have been counted");
  assert.equal(before.totalEntries, 1);
  assert.ok(before.totalSizeBytes > 0);

  cache.resetStats();
  const s = cache.getStats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.staleHits, 0);
  assert.equal(s.evictions, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.hitRate, 0);
  // Entry accounting is storage state, not a counter: it must survive a reset,
  // or a reset would silently orphan every cached entry.
  assert.equal(s.totalEntries, 1, "entries are still stored after resetStats");
  assert.equal(s.totalSizeBytes, before.totalSizeBytes);
});

await test("buildConditionalHeaders with etag and last-modified", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/etag`, method: "GET", headers: {} };
  await cache.set(
    req,
    {
      status: 200,
      statusText: "OK",
      headers: { etag: '"abc"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" },
      body: "x",
    },
    { force: true },
  );
  const r = await cache.get(req);
  assert.notEqual(r, null, "should return entry with etag/lm headers");
  const h = cache.buildConditionalHeaders(r.entry);
  assert.equal(h["if-none-match"], '"abc"');
  assert.equal(h["if-modified-since"], "Mon, 01 Jan 2024 00:00:00 GMT");
});

await test("buildConditionalHeaders returns empty for no etag/lm", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/no-etag`, method: "GET", headers: {} };
  await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  const r = await cache.get(req);
  assert.notEqual(r, null, "should return entry for conditional headers");
  const h = cache.buildConditionalHeaders(r.entry);
  assert.deepEqual(h, {});
});

await test("revalidate handles 304 with new headers", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/reval`, method: "GET", headers: {} };
  await cache.set(
    req,
    {
      status: 200,
      statusText: "OK",
      headers: { etag: '"abc"', "cache-control": "max-age=60" },
      body: "orig",
    },
    { force: true },
  );
  const r = await cache.revalidate(req, {
    status: 304,
    statusText: "Not Modified",
    headers: { "cache-control": "max-age=120" },
    body: null,
  });
  assert.notEqual(r, null, "revalidate should succeed");
  // After revalidation, the entry should have merged headers and new TTL.
  // Only `notEqual(null)` was asserted, so a revalidate() that did nothing at
  // all — returning the entry untouched — passed.
  const g = await cache.get(req);
  assert.notEqual(g, null, "entry should persist after revalidation");
  // The 304's validator replaces the old one ...
  assert.equal(g.entry.etag, '"abc"', "the 304 carried no etag, so the old one is kept");
  // ... the body and status of the original 200 are preserved, not the 304's null body ...
  assert.equal(g.entry.response.body, "orig", "a 304 has no body; the cached body must survive");
  assert.equal(g.entry.response.status, 200, "a 304 must not be stored as the entry status");
  // ... and the freshness lifetime is recomputed from the 304's Cache-Control.
  const ttl = g.entry.expiresAt - g.entry.createdAt;
  assert.equal(ttl, 120_000, "the 304 said max-age=120, not the original 60");
});

await test("revalidate returns null when entry not found", async () => {
  const cache = createMemoryCache();
  const r = await cache.revalidate(
    { url: `${BASE}/no-entry`, method: "GET", headers: {} },
    { status: 304, statusText: "Not Modified", headers: {}, body: null },
  );
  assert.equal(r, null);
});

await test("invalidateByURL removes matching entries", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/api/users`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "users" },
    { force: true },
  );
  await cache.set(
    { url: `${BASE}/api/posts`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "posts" },
    { force: true },
  );
  const count = await cache.invalidateByURL(`${BASE}/api/`);
  assert.equal(count, 2);
  // A count alone would also be produced by a no-op that returns 2; the
  // entries must actually be gone.
  assert.equal(await cache.get({ url: `${BASE}/api/users`, method: "GET", headers: {} }), null);
  assert.equal(await cache.get({ url: `${BASE}/api/posts`, method: "GET", headers: {} }), null);
  assert.equal(cache.getStats().totalEntries, 0);
});

await test("invalidateByURL with namespace", async () => {
  const cache = new HTTPCache({ namespace: "v1" });
  await cache.set(
    { url: `${BASE}/api/ns`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { force: true },
  );
  const count = await cache.invalidateByURL(`${BASE}/api/`);
  assert.equal(count, 1);
});

await test("invalidateByTag removes tagged entries", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/t1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { tags: ["user"] },
  );
  await cache.set(
    { url: `${BASE}/t2`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
    { tags: ["post"] },
  );
  assert.equal(await cache.invalidateByTag("user"), 1);
  assert.equal(await cache.get({ url: `${BASE}/t1`, method: "GET", headers: {} }), null);
  // The untagged-by-that-name entry must be untouched.
  assert.notEqual(await cache.get({ url: `${BASE}/t2`, method: "GET", headers: {} }), null);
  assert.equal(
    await cache.invalidateByTag("user"),
    0,
    "the tag index must not still point at the removed key",
  );
});

await test("invalidateByTag returns 0 for unknown tag", async () => {
  const cache = createMemoryCache();
  assert.equal(await cache.invalidateByTag("no-such"), 0);
});

await test("warm preloads entries", async () => {
  const cache = createMemoryCache();
  await cache.warm([
    {
      req: { url: `${BASE}/w1`, method: "GET", headers: {} },
      res: { status: 200, statusText: "OK", headers: {}, body: "d1" },
    },
    {
      req: { url: `${BASE}/w2`, method: "GET", headers: {} },
      res: { status: 200, statusText: "OK", headers: {}, body: "d2" },
      tags: ["tag-w"],
    },
  ]);
  assert.equal(cache.getStats().totalEntries, 2);
  const w1 = await cache.get({ url: `${BASE}/w1`, method: "GET", headers: {} });
  const w2 = await cache.get({ url: `${BASE}/w2`, method: "GET", headers: {} });
  assert.equal(w1.entry.response.body, "d1", "warm must store the body, not a placeholder");
  assert.equal(w2.entry.response.body, "d2");
  assert.deepEqual(w1.entry.tags, []);
  assert.deepEqual(w2.entry.tags, ["tag-w"], "per-entry tags must be carried through warm()");
});

await test("markSWRInFlight deduplicates", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/swr`, method: "GET", headers: {} };
  assert.equal(await cache.isSWRInFlight(req), false, "nothing is in flight yet");
  assert.equal(await cache.markSWRInFlight(req), true, "the first caller wins the race");
  assert.equal(await cache.isSWRInFlight(req), true, "the mark must be observable");
  assert.equal(
    await cache.markSWRInFlight(req),
    false,
    "a second caller must be told to stand down",
  );
  // Concurrent callers: exactly one may win.
  const req2 = { url: `${BASE}/swr2`, method: "GET", headers: {} };
  const winners = (
    await Promise.all(Array.from({ length: 8 }, () => cache.markSWRInFlight(req2)))
  ).filter(Boolean).length;
  assert.equal(winners, 1, `exactly one of 8 concurrent callers may win, got ${winners}`);

  await cache.clearSWRInFlight(req);
  assert.equal(await cache.isSWRInFlight(req), false);
  // Clearing must make the slot reusable, not permanently poison the key.
  assert.equal(await cache.markSWRInFlight(req), true, "the slot must be reusable after clearing");
});

// ============================================================================
// §2  TTL COMPUTATION
// ============================================================================

suite("TTL Computation");

/** The freshness lifetime actually stored for a request, in ms. */
const ttlOf = async (
  cache: ReturnType<typeof createMemoryCache>,
  req: { url: string; method: string; headers: Record<string, string> },
): Promise<number> => {
  const r = await cache.get(req);
  assert.notEqual(r, null, "the entry must be stored to measure its TTL");
  return r.entry.expiresAt - r.entry.createdAt;
};

await test("Cache-Control max-age used as TTL", async () => {
  // Was `assert.notEqual(r, null)` — satisfied by the 60 s default TTL, by an
  // Infinity TTL, by any TTL at all. The subject of the test is the number.
  const cache = createMemoryCache({ defaultTtlMs: 60000 });
  const req = { url: `${BASE}/ma`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=10" },
    body: "x",
  });
  assert.equal(await ttlOf(cache, req), 10_000, "max-age is in seconds");
  const r = await cache.get(req);
  assert.equal(r.stale, false);
});

await test("s-maxage takes priority over max-age", async () => {
  // Only asserted the entry existed. With `max-age=1` the two directives are
  // 3,599,999 ms apart, so the assertion can tell them apart — if it checked.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/sma`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=1, s-maxage=3600" },
    body: "x",
  });
  assert.equal(await ttlOf(cache, req), 3_600_000, "s-maxage overrides max-age for a shared cache");
});

await test("Expires header used when no max-age", async () => {
  // The HTTP-date has one-second resolution, so the derived TTL is the
  // distance to the next whole second: bound it rather than pin it exactly.
  const future = new Date(Date.now() + 3600000).toUTCString();
  const cache = createMemoryCache();
  const req = { url: `${BASE}/exp`, method: "GET", headers: {} };
  await cache.set(req, { status: 200, statusText: "OK", headers: { expires: future }, body: "x" });
  const ttl = await ttlOf(cache, req);
  assert.ok(
    ttl > 3_595_000 && ttl <= 3_600_000,
    `Expires one hour out must give ~3600s, got ${ttl}ms`,
  );
  // And it must be the Expires header, not the 60 s default.
  assert.ok(ttl > 60_000, "the default TTL must not be used when Expires is present");
});

await test("Last-Modified heuristic used when no max-age or expires", async () => {
  // The old version used `defaultTtlMs: 5000` with a day-old Last-Modified.
  // The heuristic gives min(86400000 * 0.1, 5000) = 5000 and the default gives
  // 5000, so the test passed identically whether or not the heuristic ran at
  // all — it could not detect the heuristic being deleted. Give the default a
  // value the heuristic can beat, and pin the 10% arithmetic.
  const DAY = 86_400_000;
  const HEURISTIC = DAY * 0.1; // 8_640_000
  // The default must sit well ABOVE the heuristic for the two to be
  // distinguishable; the heuristic is `min(10% of age, defaultTtl)`.
  const cache = createMemoryCache({ defaultTtlMs: 60_000_000 });
  const req = { url: `${BASE}/lm`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "last-modified": new Date(Date.now() - DAY).toUTCString() },
    body: "x",
  });
  const ttl = await ttlOf(cache, req);
  assert.ok(
    Math.abs(ttl - HEURISTIC) < 1000,
    `10% of a one-day-old response is ${HEURISTIC}ms, got ${ttl}ms`,
  );
  assert.ok(ttl < 60_000_000, "the heuristic must beat the default TTL");
});

await test("default TTL used when no cache directives", async () => {
  const cache = createMemoryCache({ defaultTtlMs: 3600000 });
  const req = { url: `${BASE}/default-ttl`, method: "GET", headers: {} };
  await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.equal(await ttlOf(cache, req), 3_600_000);
});

await test("Age header subtracts from max-age", async () => {
  // Only asserted `ok === true`. Age was ignored entirely and this passed.
  // 30 s of freshness, 25 s already elapsed, leaves 5 s.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/age`, method: "GET", headers: {} };
  const ok = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=30", age: "25" },
    body: "x",
  });
  assert.equal(ok, true);
  assert.equal(await ttlOf(cache, req), 5_000, "Age must be subtracted from max-age");

  // Age larger than max-age means the response is already stale: not stored.
  const c2 = createMemoryCache();
  const req2 = { url: `${BASE}/age-over`, method: "GET", headers: {} };
  const ok2 = await c2.set(req2, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=30", age: "40" },
    body: "x",
  });
  assert.equal(ok2, false, "Age >= max-age leaves no freshness at all");
  assert.equal(await c2.get(req2), null);

  // Age only applies alongside max-age; with no cache directives the default
  // TTL is used and Age is not subtracted from it.
  const c3 = createMemoryCache({ defaultTtlMs: 60_000 });
  const req3 = { url: `${BASE}/age-only`, method: "GET", headers: {} };
  await c3.set(req3, { status: 200, statusText: "OK", headers: { age: "25" }, body: "x" });
  assert.equal(await ttlOf(c3, req3), 60_000, "Age does not shorten the default TTL");
});

await test("cappedTtlMs <= 0 returns false", async () => {
  const cache = createMemoryCache({ maxAbsoluteAgeMs: 0 });
  const req = { url: `${BASE}/zero-ttl`, method: "GET", headers: {} };
  const ok = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=0" },
    body: "x",
  });
  assert.equal(ok, false);
  assert.equal(await cache.get(req), null, "a refused entry must not be readable");
  assert.equal(cache.getStats().totalEntries, 0, "and must not be counted");

  // ...unless the caller forces it.
  const forced = await cache.set(
    req,
    { status: 200, statusText: "OK", headers: { "cache-control": "max-age=0" }, body: "x" },
    { force: true },
  );
  assert.equal(forced, true, "force must override the absolute-age cap");
});

// ============================================================================
// §3  VARY HEADER
// ============================================================================

suite("Vary Header");

await test("Vary check - varyKey mismatch returns miss", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/vary-x`, method: "GET", headers: { accept: "json" } },
    { status: 200, statusText: "OK", headers: { vary: "accept" }, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/vary-x`, method: "GET", headers: { accept: "xml" } });
  assert.equal(r, null, "Should miss when vary values differ");
});

// ============================================================================
// §4  AUTH FINGERPRINT
// ============================================================================

suite("Auth Fingerprint");

await test("getAuthFingerprint returns empty for no auth headers", async () => {
  assert.equal(await getAuthFingerprint({ "content-type": "text/plain" }), "");
});

await test("getAuthFingerprint returns hash for authorization", async () => {
  // Was: starts with "auth:" and is longer than 5 chars. The constant string
  // "auth:xxxxx" satisfies both, so a fingerprint that ignored its input
  // entirely — collapsing every user to one bucket — passed.
  const fp = await getAuthFingerprint({ authorization: "Bearer token123" });
  assert.match(fp, /^auth:[0-9a-f]{32}$/, "auth: plus a 128-bit hex digest");
  // Deterministic: the same credentials must map to the same key.
  assert.equal(
    await getAuthFingerprint({ authorization: "Bearer token123" }),
    fp,
    "the fingerprint must be stable across calls",
  );
  // Sensitive: a different token must map somewhere else, or two users share
  // one cache entry.
  assert.notEqual(
    await getAuthFingerprint({ authorization: "Bearer OTHER" }),
    fp,
    "a different bearer token must not share a fingerprint",
  );
  // Header names are case-insensitive, so the casing of the caller's object
  // literal must not change the key.
  assert.equal(await getAuthFingerprint({ Authorization: "Bearer token123" }), fp);
});

await test("getAuthFingerprint returns hash for cookie", async () => {
  const fp = await getAuthFingerprint({ cookie: "session=abc" });
  assert.match(fp, /^auth:[0-9a-f]{32}$/);
  assert.notEqual(
    await getAuthFingerprint({ cookie: "session=xyz" }),
    fp,
    "a different cookie must not share a fingerprint",
  );
});

await test("getAuthFingerprint returns hash for multiple auth headers", async () => {
  const both = await getAuthFingerprint({ authorization: "Bearer x", "x-api-key": "key123" });
  const authOnly = await getAuthFingerprint({ authorization: "Bearer x" });
  const keyOnly = await getAuthFingerprint({ authorization: "Bearer x", "x-api-key": "other" });
  assert.match(both, /^auth:[0-9a-f]{32}$/);
  assert.notEqual(both, authOnly, "the api key must contribute to the fingerprint, not be dropped");
  assert.notEqual(both, keyOnly, "changing only the api key must change the fingerprint");
  // The fingerprint must not be reversible into the credential itself.
  for (const fp of [both, authOnly, keyOnly]) {
    assert.ok(!fp.includes("token123"));
    assert.ok(!fp.includes("key123"));
    assert.ok(!fp.toLowerCase().includes("bearer"));
  }
});

// ============================================================================
// §5  SERIALIZATION / DESERIALIZATION
// ============================================================================

suite("Serialization");

await test("serialize produces valid JSON", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/s1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const data = await cache.serialize();
  const parsed = JSON.parse(data);
  assert.deepEqual(Object.keys(parsed).sort(), ["entries", "version"], "exact payload shape");
  assert.equal(parsed.version, 1);
  assert.equal(Array.isArray(parsed.entries), true, "entries should be an array");
  assert.equal(parsed.entries.length, 1, "the one stored entry must be serialized");
  // entries is a [key, entry] tuple list, and the entry must round-trip.
  const [key, entry] = parsed.entries[0];
  assert.equal(typeof key, "string");
  assert.match(key, /^GET:/, "keys are METHOD:normalized-url");
  assert.equal(entry.response.body, "x");
  assert.equal(entry.response.status, 200);
  assert.equal(typeof entry.createdAt, "number");
  assert.equal(typeof entry.expiresAt, "number");
  assert.ok(entry.expiresAt > entry.createdAt);
});

await test("serialize skips expired entries", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/old`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "max-age=0" }, body: "x" },
    { ttlMs: -1 },
  );
  const data = await cache.serialize();
  const parsed = JSON.parse(data);
  assert.equal(parsed.entries.length, 0);
});

await test("deserialize restores entries", async () => {
  const c1 = createMemoryCache();
  await c1.set(
    { url: `${BASE}/d1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "data" },
  );
  const data = await c1.serialize();
  const c2 = createMemoryCache();
  await c2.deserialize(data);
  const r = await c2.get({ url: `${BASE}/d1`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should restore deserialized entry");
  assert.equal(r.stale, false, "a restored entry is fresh if it has not expired");
  assert.equal(r.entry.response.body, "data", "the body must survive the round trip");
  assert.equal(r.entry.response.status, 200);
  assert.ok(
    r.entry.expiresAt - r.entry.createdAt > 0,
    "the restored entry must not be born expired",
  );
  assert.equal(c2.getStats().totalEntries, 1, "the count must be rebuilt, not just the entry");
});

await test("deserialize restores entries with tags", async () => {
  const c1 = createMemoryCache();
  await c1.set(
    { url: `${BASE}/d1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "data" },
    { tags: ["my-tag"] },
  );
  const data = await c1.serialize();
  const c2 = createMemoryCache();
  await c2.deserialize(data);
  // Invalidate by tag should find the restored entry
  const count = await c2.invalidateByTag("my-tag");
  assert.equal(count, 1, "Tag index should be rebuilt after deserialize");
});

await test("deserialize throws on invalid JSON", async () => {
  const cache = createMemoryCache();
  await assert.rejects(() => cache.deserialize("not json"), /invalid JSON/);
});

await test("deserialize throws on wrong format (not version 1)", async () => {
  const cache = createMemoryCache();
  await assert.rejects(() => cache.deserialize('{"version":2,"entries":[]}'), /unexpected format/);
});

await test("deserialize throws on missing fields", async () => {
  const cache = createMemoryCache();
  await assert.rejects(() => cache.deserialize('{"version":1}'), /unexpected format/);
});

await test("deserialize skips invalid entries", async () => {
  const cache = createMemoryCache();
  const valid = {
    version: 1,
    entries: [["not-an-array"], ["key1", { notValid: true }], ["key2", null]],
  };
  await cache.deserialize(JSON.stringify(valid));
  assert.equal(cache.getStats().totalEntries, 0);
});

// ============================================================================
// §6  STALE-WHILE-REVALIDATE / STALE-IF-ERROR
// ============================================================================

suite("Stale-While-Revalidate");

await test("stale-while-revalidate returns stale entry within SWR window", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/swr-test`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=1, stale-while-revalidate=3600" },
      body: "stale",
    },
  );
  // Wait for the entry to expire (past max-age)
  await new Promise((r) => setTimeout(r, 1100));
  const g = await cache.get({ url: `${BASE}/swr-test`, method: "GET", headers: {} });
  assert.notEqual(g, null, "should return stale entry within SWR window");
  assert.equal(g.stale, true);
  assert.equal(g.entry.response.body, "stale", "the stale body is what gets served");
  // The window has to be the declared 3600 s, and it has to start where the
  // freshness lifetime ended.
  assert.equal(g.entry.expiresAt - g.entry.createdAt, 1000, "fresh for max-age=1");
  assert.equal(
    g.entry.staleUntil - g.entry.expiresAt,
    3_600_000,
    "the SWR window must be stale-while-revalidate=3600",
  );
  assert.ok(Date.now() < g.entry.staleUntil, "we must still be inside the SWR window, not past it");
});

await test("stale-if-error returns stale entry within SIE window", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/sie-test`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=1, stale-if-error=3600" },
      body: "stale-sie",
    },
  );
  await new Promise((r) => setTimeout(r, 1100));
  const g = await cache.get({ url: `${BASE}/sie-test`, method: "GET", headers: {} });
  assert.notEqual(g, null, "should return stale entry within SIE window");
  assert.equal(g.stale, true);
  assert.equal(g.entry.response.body, "stale-sie");
  assert.equal(g.entry.expiresAt - g.entry.createdAt, 1000);
  assert.equal(
    g.entry.staleOnError - g.entry.expiresAt,
    3_600_000,
    "the SIE window must be stale-if-error=3600",
  );
  assert.equal(
    g.entry.staleUntil - g.entry.expiresAt,
    0,
    "stale-if-error must not extend the SWR window",
  );
});

await test("expired entry beyond SWR/SIE window returns null", async () => {
  const cache = createMemoryCache();
  // Store with 1ms TTL and no SWR - will expire immediately
  await cache.set(
    { url: `${BASE}/expired`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "max-age=0" }, body: "gone" },
    { force: true },
  );
  // Entry is stored with force, but expiresAt = 0 + cappedTtlMs
  // cappedTtlMs = Math.min(0, absoluteCap) = 0
  // expiresAt = now + 0 = now
  // So the entry is immediately expired
  // After 5ms it's definitely past staleUntil and staleOnError (both === expiresAt)
  await new Promise((r) => setTimeout(r, 10));
  const r = await cache.get({ url: `${BASE}/expired`, method: "GET", headers: {} });
  assert.equal(r, null, "Fully expired entry should return null");
});

await test("immutable sets very long TTL", async () => {
  // Was `notEqual(r, null)`. `immutable` replaces a 10 s lifetime with a
  // year, which is then capped by maxAbsoluteAgeMs — the test must show both.
  const cache = createMemoryCache({ maxAbsoluteAgeMs: 86400000 });
  const req = { url: `${BASE}/imm`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=10, immutable" },
    body: "x",
  });
  const r = await cache.get(req);
  assert.notEqual(r, null, "should cache immutable entry");
  assert.equal(r.entry.expiresAt - r.entry.createdAt, 86_400_000, "capped to maxAbsoluteAgeMs");

  // Without the cap, immutable must reach the full year, not the 10 s max-age.
  const long = createMemoryCache({ maxAbsoluteAgeMs: Infinity });
  const req2 = { url: `${BASE}/imm2`, method: "GET", headers: {} };
  await long.set(req2, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=10, immutable" },
    body: "x",
  });
  assert.equal(
    (await long.get(req2)).entry.expiresAt - (await long.get(req2)).entry.createdAt,
    365 * 24 * 60 * 60 * 1000,
    "immutable means a year, whatever max-age said",
  );
});

// ============================================================================
// §7  STORAGE ADAPTERS
// ============================================================================

suite("Storage Adapters");

await test("MemoryStorageAdapter set/get/delete/clear/keys/size", async () => {
  const s = new MemoryStorageAdapter();
  assert.equal(s.size, 0);
  const e = {
    response: { status: 200, statusText: "OK", headers: {}, body: "x" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    staleUntil: Date.now() + 60000,
    staleOnError: Date.now() + 60000,
    etag: null,
    lastModified: null,
    varyKey: null,
    tags: [],
    size: 10,
  };
  await s.set("k1", e);
  assert.equal(s.size, 1);
  assert.deepEqual(await s.get("k1"), e, "the entry must come back byte-for-byte");
  assert.equal(await s.get("no-key"), null);
  // Overwriting a key must replace, not accumulate.
  const e2 = { ...e, size: 20 };
  await s.set("k1", e2);
  assert.equal(s.size, 1, "an overwrite must not add a second entry");
  assert.deepEqual(await s.get("k1"), e2, "the newer value must win");
  await s.set("k1", e);
  const ks = await s.keys();
  assert.ok(ks.includes("k1"), "keys should include k1");
  await s.delete("k1");
  assert.equal(await s.get("k1"), null);
  await s.set("k2", e);
  await s.clear();
  assert.equal(await s.get("k2"), null);
  assert.equal(s.size, 0);
});

await test("TwoTierStorageAdapter promotes L2 to L1", async () => {
  const l2 = new MemoryStorageAdapter();
  const cache = createTwoTierCache(l2);
  await cache.set(
    { url: `${BASE}/tier`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/tier`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should return entry from two-tier cache");
});

await test("TwoTierStorageAdapter L1-miss L2-hit promotes", async () => {
  const { TwoTierStorageAdapter } = await import("../src/cache.ts");
  const l2 = new MemoryStorageAdapter();
  const twoTier = new TwoTierStorageAdapter(l2);
  const entry = {
    response: { status: 200, statusText: "OK", headers: {}, body: "promoted" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    staleUntil: Date.now() + 60000,
    staleOnError: Date.now() + 60000,
    etag: null,
    lastModified: null,
    varyKey: null,
    tags: [],
    size: 10,
  };
  // Put in L2 directly - L1 won't have it
  await l2.set("pk", entry);
  // Get through TwoTier - should miss L1, hit L2, promote to L1
  const result = await twoTier.get("pk");
  assert.notEqual(result, null, "should return promoted entry");
  assert.equal(result.response.body, "promoted");
  // Now L1 should have it promoted - verify by deleting from L2 and getting from TwoTier
  await l2.delete("pk");
  const resultAfterL2Deleted = await twoTier.get("pk");
  assert.notEqual(resultAfterL2Deleted, null, "Should still be in L1 after promotion");
  // Direct method tests
  const e2 = { ...entry, response: { ...entry.response, body: "direct" } };
  await twoTier.set("dk", e2);
  assert.notEqual(await twoTier.get("dk"), null, "should get directly-set entry");
  const ks = await twoTier.keys();
  assert.ok(ks.includes("dk"), "keys should include dk");
  await twoTier.delete("dk");
  assert.equal(await twoTier.get("dk"), null);
  await twoTier.clear();
});

// ============================================================================
// §8  CONFIG EDGE CASES
// ============================================================================

suite("Config Edge Cases");

await test("defaultTtlMs capped to 1 year", async () => {
  // Was `assert.equal(s, true)` — which says nothing about capping. There are
  // two ceilings in play: the config-level 1-year cap on defaultTtlMs, and the
  // per-entry maxAbsoluteAgeMs cap, which defaults to 7 days and is the one
  // that actually determines the stored lifetime.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  let cache;
  try {
    cache = createMemoryCache({ defaultTtlMs: 366 * 24 * 60 * 60 * 1000 });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, "an over-year default must warn");
  assert.match(
    warnings[0],
    new RegExp(String(366 * 24 * 60 * 60 * 1000)),
    "the warning names the rejected value in ms",
  );
  assert.match(warnings[0], /1 year/, "and the ceiling it applied");

  const req = { url: `${BASE}/cap`, method: "GET", headers: {} };
  const stored = await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.equal(stored, true);
  // 366 d is capped to 1 y by the config, then to 7 days by maxAbsoluteAgeMs.
  assert.equal(
    (await cache.get(req)).entry.expiresAt - (await cache.get(req)).entry.createdAt,
    7 * 24 * 60 * 60 * 1000,
    "the stored lifetime is maxAbsoluteAgeMs, which defaults to 7 days",
  );

  // With maxAbsoluteAgeMs raised, the 1-year config cap becomes the ceiling.
  const wide = createMemoryCache({
    defaultTtlMs: 366 * 24 * 60 * 60 * 1000,
    maxAbsoluteAgeMs: Infinity,
  });
  const req2 = { url: `${BASE}/cap2`, method: "GET", headers: {} };
  await wide.set(req2, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.equal(
    (await wide.get(req2)).entry.expiresAt - (await wide.get(req2)).entry.createdAt,
    365 * 24 * 60 * 60 * 1000,
    "the config-level 1-year cap applies once the absolute cap is lifted",
  );
});

await test("maxAbsoluteAgeMs expires old entries on get", async () => {
  const cache = createMemoryCache({ maxAbsoluteAgeMs: 1, honorCacheControl: false });
  await cache.set(
    { url: `${BASE}/abs-old`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { force: true },
  );
  // Wait 2ms to ensure the entry is older than maxAbsoluteAgeMs
  await new Promise((r) => setTimeout(r, 5));
  const r = await cache.get({ url: `${BASE}/abs-old`, method: "GET", headers: {} });
  assert.equal(r, null, "Should be expired by maxAbsoluteAgeMs");
});

await test("custom cacheKey function", async () => {
  // Was `notEqual(r, null)`, which a cache ignoring `cacheKey` entirely also
  // passes. `createMemoryCache` always installs its own adapter, so the key
  // can only be observed through an injected one.
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage, cacheKey: () => "custom-key" });
  await cache.set(
    { url: `${BASE}/custom`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  assert.deepEqual(await storage.keys(), ["custom-key"], "the custom key must be used verbatim");

  // A different URL must collide onto the same key — that is the point of a
  // custom key, and it only holds if the option is really consulted.
  await cache.set(
    { url: `${BASE}/other`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
  );
  assert.deepEqual(await storage.keys(), ["custom-key"], "one key, two URLs");
  const r = await cache.get({ url: `${BASE}/custom`, method: "GET", headers: {} });
  assert.equal(r.entry.response.body, "y", "the second write must have won");
});

await test("namespace prefixes keys", async () => {
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage, namespace: "ns1" });
  await cache.set(
    { url: `${BASE}/ns`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  assert.deepEqual(
    await storage.keys(),
    ["ns1:GET:https://httpbin.org/ns"],
    "the namespace prefixes METHOD:url",
  );

  // Two caches sharing a backend must not collide.
  const other = new HTTPCache({ storage, namespace: "ns2" });
  await other.set(
    { url: `${BASE}/ns`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "from-ns2" },
  );
  const r = await cache.get({ url: `${BASE}/ns`, method: "GET", headers: {} });
  assert.equal(r.entry.response.body, "x", "the ns1 entry must be untouched by ns2");
  const r2 = await other.get({ url: `${BASE}/ns`, method: "GET", headers: {} });
  assert.equal(r2.entry.response.body, "from-ns2");
});

await test("default cache key normalizes method, query order, hash and auth", async () => {
  // The key is the cache's entire correctness surface: two requests that should
  // share an entry must produce one key, and two that must not must differ.
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage });
  await cache.set(
    { url: `${BASE}/n?b=2&a=1#frag`, method: "get", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  assert.deepEqual(
    await storage.keys(),
    ["GET:https://httpbin.org/n?a=1&b=2"],
    "method upper-cased, query sorted, fragment dropped",
  );

  const authed = new MemoryStorageAdapter();
  const c2 = new HTTPCache({ storage: authed });
  await c2.set(
    { url: `${BASE}/n`, method: "GET", headers: { authorization: "Bearer t" } },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const [key] = await authed.keys();
  assert.match(key, /^GET:https:\/\/httpbin\.org\/n:auth:[0-9a-f]{32}$/);
  // Two different users must never share a cache entry.
  const c3 = new HTTPCache({ storage: authed });
  await c3.set(
    { url: `${BASE}/n`, method: "GET", headers: { authorization: "Bearer other" } },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
  );
  assert.equal((await authed.keys()).length, 2, "different credentials must not share a key");
});

await test("non-GET method not cacheable by default", async () => {
  const cache = createMemoryCache();
  const r = await cache.get({ url: `${BASE}/x`, method: "POST", headers: {} });
  assert.equal(r, null);
});

await test("InvalidateByURL with namespace and trailing slash normalization", async () => {
  const cache = new HTTPCache({ namespace: "app" });
  await cache.set(
    { url: `${BASE}/api/v1/users/`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const count = await cache.invalidateByURL(`${BASE}/api/v1/users`);
  assert.equal(count, 1);
});

// ============================================================================
// §9  LRU EVICTION
// ============================================================================

suite("LRU Eviction");

await test("eviction by maxEntries", async () => {
  const cache = createMemoryCache({ maxEntries: 2, maxSizeBytes: 10000 });
  await cache.set(
    { url: `${BASE}/e1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  await cache.set(
    { url: `${BASE}/e2`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
  );
  await cache.set(
    { url: `${BASE}/e3`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "z" },
  );
  const s = cache.getStats();
  assert.equal(s.totalEntries, 2);
  assert.equal(s.evictions, 1);
});

await test("LRU touch promotes accessed key", async () => {
  const cache = createMemoryCache({ maxEntries: 2, maxSizeBytes: 10000 });
  await cache.set(
    { url: `${BASE}/lru1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "a" },
  );
  await cache.set(
    { url: `${BASE}/lru2`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "b" },
  );
  // Access lru1 to make it MRU
  await cache.get({ url: `${BASE}/lru1`, method: "GET", headers: {} });
  // Add third - should evict lru2 (LRU), not lru1
  await cache.set(
    { url: `${BASE}/lru3`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "c" },
  );
  const r1 = await cache.get({ url: `${BASE}/lru1`, method: "GET", headers: {} });
  const r2 = await cache.get({ url: `${BASE}/lru2`, method: "GET", headers: {} });
  assert.notEqual(r1, null, "lru1 should survive (was accessed)");
  assert.equal(r2, null, "lru2 should be evicted (was LRU)");
});

await test("eviction by maxSizeBytes", async () => {
  const cache = createMemoryCache({ maxEntries: 100, maxSizeBytes: 100 });
  // Each entry adds body size + 256 bytes overhead. 3 entries of body "x" (1 byte) = 3*257 = 771 bytes
  // With maxSizeBytes: 100, the second set should trigger eviction
  await cache.set(
    { url: `${BASE}/s-e1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  await cache.set(
    { url: `${BASE}/s-e2`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "y" },
  );
  await cache.set(
    { url: `${BASE}/s-e3`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "z" },
  );
  const s = cache.getStats();
  assert.equal(s.evictions, 2);
  assert.equal(s.totalEntries, 1);
  assert.equal(s.totalSizeBytes, 257);
});

await test("hitRate computed correctly", async () => {
  const cache = createMemoryCache();
  // Miss
  await cache.get({ url: `${BASE}/hr1`, method: "GET", headers: {} });
  // Hit
  await cache.set(
    { url: `${BASE}/hr1`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  await cache.get({ url: `${BASE}/hr1`, method: "GET", headers: {} });
  const s = cache.getStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.hitRate, 0.5);
});

// ============================================================================
// §11  FACTORY FUNCTIONS
// ============================================================================

suite("Factory Functions");

await test("createMemoryCache creates HTTPCache", async () => {
  const c = createMemoryCache();
  assert.equal(c instanceof HTTPCache, true, "should be HTTPCache instance");
});

await test("createMemoryCache with config", async () => {
  const c = createMemoryCache({ maxEntries: 10 });
  assert.equal(c instanceof HTTPCache, true, "should be HTTPCache instance");
});

await test("createTwoTierCache works", async () => {
  const l2 = new MemoryStorageAdapter();
  const c = createTwoTierCache(l2);
  assert.equal(c instanceof HTTPCache, true, "should be HTTPCache instance");
});

await test("createLocalStorageCache throws in Node.js", async () => {
  const { createLocalStorageCache: fn } = await import("../src/cache.ts");
  assert.throws(() => fn(), /localStorage is not available/);
});

await test("createSessionStorageCache throws in Node.js", async () => {
  const { createSessionStorageCache: fn } = await import("../src/cache.ts");
  assert.throws(() => fn(), /sessionStorage is not available/);
});

await test("createKVCache creates HTTPCache", async () => {
  const { createKVCache } = await import("../src/cache.ts");
  const cache = createKVCache({} as any);
  assert.equal(cache instanceof HTTPCache, true, "should be HTTPCache instance");
});

// ============================================================================
// §12  REAL HTTP CALLS VIA KINETEX
// ============================================================================

suite("Real HTTP Calls via Kinetex");

await test("real httpbin.org/get", async () => {
  assert.equal((await httpbin.get("/get")).status, 200);
});

await test("real httpbin.org/ip", async () => {
  const r = await httpbin.get("/ip");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.origin, "string", "origin should be a string");
  assert.ok(r.data.origin.length > 0, "and must not be empty");
});

await test("real httpbin.org/headers", async () => {
  const r = await httpbin.get("/headers", { headers: { "X-Test": "val" } });
  assert.equal(r.status, 200);
  // A truthy check on `r.data.headers` is satisfied by `{}`. Echo the header
  // back so the request actually has to have carried it.
  assert.equal(typeof r.data.headers, "object");
  assert.equal(
    String(r.data.headers["X-Test"]).toLowerCase(),
    "val",
    "the request header must reach the server",
  );
});

await test("real httpbin.org/json", async () => {
  const r = await httpbin.get("/json");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.slideshow, "object", "not merely truthy");
  assert.ok(Array.isArray(r.data.slideshow.slides), "slides must be a list");
  assert.ok(r.data.slideshow.slides.length > 0, "and must not be empty");
  assert.equal(typeof r.data.slideshow.title, "string");
});

await test("real httpbin.org/uuid", async () => {
  const r = await httpbin.get("/uuid");
  assert.equal(r.status, 200);
  assert.match(
    r.data.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "must be a well-formed UUID",
  );
});

await test("real httpbin.org/post with JSON", async () => {
  const r = await httpbin.post("/post", { test: "data" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.json, { test: "data" });
});

await test("real httpbin.org/anything", async () => {
  const r = await httpbin.post("/anything", { msg: "cache-test" });
  assert.equal(r.status, 200);
  assert.equal(r.data.json.msg, "cache-test");
});

await test("real httpbin.org/base64 decode", async () => {
  const r = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(r.status, 200);
  assert.equal(String(r.data).trim(), "Hello World");
});

await test("real httpbin.org/delay/0 with timing", async () => {
  const start = Date.now();
  const r = await httpbin.get("/delay/0");
  assert.equal(r.status, 200);
  assert.ok(Date.now() - start < 2000, "response should arrive within 2s");
});

await test("real httpbin.org/response-headers", async () => {
  const r = await httpbin.get("/response-headers", { headers: { "X-Test": "val" } });
  assert.equal(r.status, 200);
});

await test("Multiple sequential httpbin endpoints", async () => {
  const a = await httpbin.get("/get");
  const b = await httpbin.get("/ip");
  const c = await httpbin.get("/uuid");
  const d = await httpbin.get("/headers");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(d.status, 200);
});

await test("invalid URL in cache key triggers fallback path", async () => {
  const cache = createMemoryCache();
  // An invalid URL that can't be parsed will trigger the catch path in defaultCacheKey
  const req = { url: "not-a-valid-url", method: "GET", headers: {} };
  const ok = await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.equal(ok, true);
  const r = await cache.get(req);
  assert.notEqual(r, null, "should cache entry with invalid URL");
  assert.equal(r.entry.response.body, "x");
  // The fallback key must still be stable and method-qualified, or an
  // unparseable URL would collide with every other unparseable URL.
  const storage = new MemoryStorageAdapter();
  const c2 = new HTTPCache({ storage });
  await c2.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  assert.deepEqual(await storage.keys(), ["GET:not-a-valid-url"]);
});

await test("invalid Last-Modified date falls back to default TTL", async () => {
  // `Date.parse("invalid-date-value")` is NaN, so the heuristic must fall back
  // to the default rather than to NaN. The old assertion — that it was cached
  // at all — would also have been satisfied by a NaN lifetime that then
  // happened to survive the comparison.
  const cache = createMemoryCache({ defaultTtlMs: 5000 });
  const req = { url: `${BASE}/bad-lm`, method: "GET", headers: {} };
  const ok = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "last-modified": "invalid-date-value" },
    body: "x",
  });
  assert.equal(ok, true);
  const r = await cache.get(req);
  assert.notEqual(r, null, "Should cache with default TTL despite invalid LM");
  assert.equal(
    r.entry.expiresAt - r.entry.createdAt,
    5000,
    "an unparseable Last-Modified must fall back to defaultTtlMs exactly",
  );
  assert.ok(Number.isFinite(r.entry.expiresAt), "never NaN");
});

await test("all Cache-Control directive branches", async () => {
  const cache = createMemoryCache({ honorCacheControl: true });
  // Test must-revalidate, proxy-revalidate, public, private, no-transform, only-if-cached, must-understand
  const cc =
    "must-revalidate, proxy-revalidate, public, private, no-transform, only-if-cached, must-understand, max-age=3600";
  const req = { url: `${BASE}/all-cc`, method: "GET", headers: {} };
  const ok = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": cc },
    body: "x",
  });
  assert.equal(ok, true);
  const r = await cache.get(req);
  assert.notEqual(r, null, "should cache entry with all cache-control directives");
  assert.equal(r.entry.expiresAt - r.entry.createdAt, 3_600_000, "max-age still parsed");
  assert.equal(
    r.entry.mustRevalidate,
    true,
    "must-revalidate must survive alongside the other directives",
  );
  assert.equal(r.stale, true, "must-revalidate forbids a fresh hit");
});

// ============================================================================
// §13  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
suite("regression: cache-control max-age drives the TTL");

await test("regression: `cache-control: max-age` is converted seconds -> ms", async () => {
  // The conversion was multiplied by 0 — i.e. seconds treated as
  // milliseconds — and the whole cache suite still passed, because every
  // other test supplies an explicit `ttlMs` instead of a Cache-Control.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/ma`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=60" },
    body: "fresh",
  });
  const entry = (await cache.get(req)) as unknown as {
    entry: { expiresAt: number; createdAt: number };
  };
  assert.ok(entry !== null, "the entry must be cached");
  const ttlMs = entry.entry.expiresAt - entry.entry.createdAt;
  // 60 s = 60_000 ms. The bug produced 60.
  assert.equal(ttlMs, 60_000, "max-age is in SECONDS; the stored TTL must be in ms");
});

await test("regression: a one-second max-age entry expires after ~1s, not ~1ms", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/ma1`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=1" },
    body: "s",
  });
  // Well under the 1 s window: still fresh.
  assert.notEqual(await cache.get(req), null, "must be fresh before the window closes");
});

await test("regression: `no-store` is never stored or served", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/ns-no-store`, method: "GET", headers: {} };
  const stored = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "no-store" },
    body: "x",
  });
  assert.equal(stored, false, "no-store must not be stored at all");
  assert.equal(await cache.get(req), null);
});

await test("regression: `no-cache` is stored but never served as fresh", async () => {
  // RFC 9111 §5.2.2.4. The response was reported as a plain fresh hit with
  // nothing recorded, so an origin that said "ask me again" was ignored and
  // its body was served indefinitely from cache.
  for (const cc of ["no-cache", "private, no-cache", "max-age=600, no-cache"]) {
    const cache = createMemoryCache();
    const req = { url: `${BASE}/nc-${cc}`, method: "GET", headers: {} };
    const stored = await cache.set(req, {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": cc },
      body: "x",
    });
    assert.equal(stored, true, `${cc} may be stored`);
    const hit = await cache.get(req);
    assert.notEqual(hit, null, `${cc} should still be retrievable for revalidation`);
    assert.equal(hit.stale, true, `${cc} must not be reported as a fresh hit`);
    assert.equal(hit.entry.mustRevalidate, true, `${cc} must record the directive`);
  }
});

await test("regression: `must-revalidate` is stored but never served as fresh", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/mr`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=600, must-revalidate" },
    body: "x",
  });
  const hit = await cache.get(req);
  assert.equal(hit.stale, true, "must-revalidate requires a check with the origin");
  assert.equal(hit.entry.mustRevalidate, true);
});

await test("regression: an ordinary `max-age` response is still a fresh hit", async () => {
  // The control: the change above must not turn every cache hit stale.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/fresh`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=600" },
    body: "x",
  });
  const hit = await cache.get(req);
  assert.equal(hit.stale, false, "a plain max-age response must still be fresh");
  assert.equal(hit.entry.mustRevalidate, false);
});

// ============================================================================
// §14  REGRESSION: CAPACITY GAUGES, STALE WINDOWS, AND CLOCK SKEW
// ============================================================================

suite("regression: resetStats must not zero the capacity gauges");

await test("regression: resetStats keeps enforcing maxSizeBytes", async () => {
  // `resetStats()` zeroed `totalEntries` and `totalSizeBytes` along with the
  // counters, but those two are gauges of what is actually stored, and
  // `_ensureCapacity()` reads them as the authoritative figures for the caps.
  // Eviction then compared against a fiction: a cache configured with
  // `maxSizeBytes: 600` was measured holding 1028 bytes across 4 entries after
  // a reset, and a monitoring call on a scrape interval silently removed the
  // memory bound.
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage, maxEntries: 1000, maxSizeBytes: 600 });
  const put = (i: number) =>
    cache.set(
      { url: `${BASE}/gauge-${i}`, method: "GET", headers: {} },
      { status: 200, statusText: "OK", headers: {}, body: "x" },
    );
  await put(0);
  await put(1);
  cache.resetStats();
  // Check the counters straight away: the puts below evict, so reading
  // `evictions` after them would no longer be testing the reset.
  const justReset = cache.getStats();
  assert.equal(justReset.evictions, 0, "evictions is a counter and must reset");
  assert.equal(justReset.totalEntries, 2, "but the entry count is a gauge and must not");
  assert.ok(justReset.totalSizeBytes > 0, "nor the byte total");
  for (let i = 2; i < 10; i++) await put(i);

  const keys = await storage.keys();
  let realBytes = 0;
  for (const k of keys) realBytes += (await storage.get(k)).size;
  assert.ok(
    realBytes <= 600,
    `storage holds ${realBytes} bytes against a 600-byte cap across ${keys.length} entries`,
  );
  assert.equal(keys.length, 2, "two 257-byte entries is all that fits");
  // The reported gauge must match reality.
  const s = cache.getStats();
  assert.equal(s.totalEntries, keys.length, "getStats must not under-report");
  assert.equal(s.totalSizeBytes, realBytes);
  // Evictions really did happen, so the size cap was doing work rather than
  // the cache simply having stopped storing.
  assert.ok(s.evictions > 0, "the cap must have been enforced by evicting");
});

await test("regression: resetStats leaves the entry count and size intact", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/rs`, method: "GET", headers: {} };
  await cache.set(req, { status: 200, statusText: "OK", headers: {}, body: "x" });
  const before = cache.getStats();
  assert.equal(before.totalEntries, 1);
  assert.ok(before.totalSizeBytes > 0);

  await cache.get(req);
  await cache.get({ url: `${BASE}/nope`, method: "GET", headers: {} });
  cache.resetStats();

  const after = cache.getStats();
  assert.equal(after.hits, 0, "hits must reset");
  assert.equal(after.misses, 0, "misses must reset");
  assert.equal(after.hitRate, 0);
  assert.equal(after.totalEntries, 1, "the entry is still stored, so the count must survive");
  assert.equal(after.totalSizeBytes, before.totalSizeBytes);
  assert.notEqual(
    await cache.get(req),
    null,
    "an entry must not become unservable because stats were reset",
  );
});

await test("regression: resetStats on an empty cache is a no-op", async () => {
  const cache = createMemoryCache();
  cache.resetStats();
  assert.deepEqual(cache.getStats(), {
    hits: 0,
    misses: 0,
    staleHits: 0,
    errors: 0,
    evictions: 0,
    totalEntries: 0,
    totalSizeBytes: 0,
    hitRate: 0,
  });
});

suite("regression: a stale window makes a zero-TTL response storable");

await test("regression: `max-age=0, stale-while-revalidate` is cached", async () => {
  // `computeTTL` reported `shouldCache: true` for this, then the very next
  // guard in `set()` threw that decision away because the lifetime was zero.
  // `max-age=0, stale-while-revalidate=N` is the canonical CDN recipe — serve
  // the cached copy while one request revalidates in the background — and it
  // was not cached at all.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/swr0`, method: "GET", headers: {} };
  const stored = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=0, stale-while-revalidate=60" },
    body: "swr-body",
  });
  assert.equal(stored, true, "a stale-while-revalidate window must permit storage");

  const hit = await cache.get(req);
  assert.notEqual(hit, null, "and it must be retrievable");
  assert.equal(hit.stale, true, "already stale, so it is not a fresh hit");
  assert.equal(hit.entry.response.body, "swr-body");
  assert.equal(hit.entry.expiresAt - hit.entry.createdAt, 0, "no freshness lifetime");
  assert.equal(
    hit.entry.staleUntil - hit.entry.expiresAt,
    60_000,
    "the 60 s SWR window must be recorded and reachable",
  );
  assert.ok(Date.now() < hit.entry.staleUntil, "and we must be inside it");
});

await test("regression: `max-age=0, stale-if-error` is cached", async () => {
  // Same defect, second window: `computeTTL`'s `shouldCache` did not consider
  // stale-if-error at all, so this was rejected one guard earlier still.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/sie0`, method: "GET", headers: {} };
  const stored = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=0, stale-if-error=60" },
    body: "sie-body",
  });
  assert.equal(stored, true);
  const hit = await cache.get(req);
  assert.notEqual(hit, null);
  assert.equal(hit.stale, true);
  assert.equal(
    hit.entry.staleOnError - hit.entry.expiresAt,
    60_000,
    "the 60 s stale-if-error window must be recorded",
  );
});

await test("regression: a zero TTL with no stale window is still refused", async () => {
  // The control: widening `shouldCache` must not start storing responses that
  // are stale with nowhere to serve them from.
  const cache = createMemoryCache();
  const req = { url: `${BASE}/nostale`, method: "GET", headers: {} };
  const stored = await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=0" },
    body: "x",
  });
  assert.equal(stored, false, "nowhere to serve a permanently stale response from");
  assert.equal(await cache.get(req), null);
});

suite("regression: Last-Modified heuristic under clock skew");

await test("regression: a future Last-Modified never yields a negative lifetime", async () => {
  // RFC 9111 §4.2.2 computes the heuristic as 10% of (Date - Last-Modified).
  // When the origin's clock runs ahead of the client's — routine, and the
  // whole reason this library has clock-skew correction for AWS signing — that
  // interval is negative, and there was no lower clamp. The entry was stored
  // with a negative freshness lifetime and a `staleUntil` *before* its
  // `createdAt`, so no window could ever cover it.
  const cache = createMemoryCache();
  const future = new Date(Date.now() + 3_600_000).toUTCString();
  const req = { url: `${BASE}/skew`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "last-modified": future, "cache-control": "stale-while-revalidate=60" },
    body: "skewed",
  });
  const hit = await cache.get(req);
  assert.notEqual(hit, null, "a 60 s SWR window must make it storable and servable");
  assert.ok(
    hit.entry.expiresAt >= hit.entry.createdAt,
    `expiresAt ${hit.entry.expiresAt} must not precede createdAt ${hit.entry.createdAt}`,
  );
  assert.ok(hit.entry.staleUntil >= hit.entry.createdAt, "staleUntil must not be in the past");
  assert.equal(hit.stale, true);
  assert.equal(hit.entry.response.body, "skewed");
});

await test("regression: a forced entry with a future Last-Modified stores a 0 TTL", async () => {
  // `force` bypasses every guard, so it is the one path that could persist the
  // negative lifetime into storage.
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage });
  const req = { url: `${BASE}/skew-force`, method: "GET", headers: {} };
  await cache.set(
    req,
    {
      status: 200,
      statusText: "OK",
      headers: { "last-modified": new Date(Date.now() + 3_600_000).toUTCString() },
      body: "x",
    },
    { force: true },
  );
  const [key] = await storage.keys();
  const entry = await storage.get(key);
  assert.ok(
    entry.expiresAt >= entry.createdAt,
    "a stored entry must never expire before it was created",
  );
  assert.equal(entry.expiresAt - entry.createdAt, 0, "clamped to 0, the RFC's 'already stale'");
});

await test("regression: a past Last-Modified still uses the 10% heuristic", async () => {
  // The control for the clamp: it must not have flattened the heuristic.
  const DAY = 86_400_000;
  const cache = createMemoryCache({ defaultTtlMs: 60_000_000 });
  const req = { url: `${BASE}/skew-past`, method: "GET", headers: {} };
  await cache.set(req, {
    status: 200,
    statusText: "OK",
    headers: { "last-modified": new Date(Date.now() - DAY).toUTCString() },
    body: "x",
  });
  const ttl = (await cache.get(req)).entry.expiresAt - (await cache.get(req)).entry.createdAt;
  assert.ok(Math.abs(ttl - DAY * 0.1) < 1000, `expected ~${DAY * 0.1}, got ${ttl}`);
});

console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CACHE TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
);
console.log(`${"=".repeat(60)}`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    if (err instanceof Error) console.log(`    ${err.message}`);
  }
  process.exit(1);
}

process.exit(0);
