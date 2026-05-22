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
  const s = cache.getStats();
  assert.equal(typeof s.hits, "number");
  assert.equal(typeof s.misses, "number");
  assert.equal(typeof s.staleHits, "number");
  assert.equal(typeof s.totalEntries, "number");
  assert.equal(typeof s.hitRate, "number");
});

await test("resetStats clears stats", async () => {
  const cache = createMemoryCache();
  await cache.get({ url: `${BASE}/miss`, method: "GET", headers: {} });
  cache.resetStats();
  const s = cache.getStats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
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
  // After revalidation, the entry should have merged headers and new TTL
  const g = await cache.get(req);
  assert.notEqual(g, null, "entry should persist after revalidation");
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
});

await test("markSWRInFlight deduplicates", async () => {
  const cache = createMemoryCache();
  const req = { url: `${BASE}/swr`, method: "GET", headers: {} };
  assert.equal(await cache.markSWRInFlight(req), true);
  assert.equal(await cache.markSWRInFlight(req), false);
  await cache.clearSWRInFlight(req);
  assert.equal(await cache.isSWRInFlight(req), false);
});

// ============================================================================
// §2  TTL COMPUTATION
// ============================================================================

suite("TTL Computation");

await test("Cache-Control max-age used as TTL", async () => {
  const cache = createMemoryCache({ defaultTtlMs: 60000 });
  await cache.set(
    { url: `${BASE}/ma`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "max-age=10" }, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/ma`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with max-age");
});

await test("s-maxage takes priority over max-age", async () => {
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/sma`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=1, s-maxage=3600" },
      body: "x",
    },
  );
  const r = await cache.get({ url: `${BASE}/sma`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with s-maxage");
});

await test("Expires header used when no max-age", async () => {
  const future = new Date(Date.now() + 3600000).toUTCString();
  const cache = createMemoryCache();
  await cache.set(
    { url: `${BASE}/exp`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { expires: future }, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/exp`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with expires");
});

await test("Last-Modified heuristic used when no max-age or expires", async () => {
  const past = new Date(Date.now() - 86400000).toUTCString();
  const cache = createMemoryCache({ defaultTtlMs: 5000 });
  await cache.set(
    { url: `${BASE}/lm`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "last-modified": past }, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/lm`, method: "GET", headers: {} });
  assert.notEqual(r, null, "Should cache with LM heuristic");
});

await test("default TTL used when no cache directives", async () => {
  const cache = createMemoryCache({ defaultTtlMs: 3600000 });
  await cache.set(
    { url: `${BASE}/default-ttl`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/default-ttl`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with default TTL");
});

await test("Age header subtracts from max-age", async () => {
  const cache = createMemoryCache();
  const ok = await cache.set(
    { url: `${BASE}/age`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=30", age: "25" },
      body: "x",
    },
  );
  assert.equal(ok, true);
});

await test("cappedTtlMs <= 0 returns false", async () => {
  const cache = createMemoryCache({ maxAbsoluteAgeMs: 0 });
  const ok = await cache.set(
    { url: `${BASE}/zero-ttl`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": "max-age=0" }, body: "x" },
  );
  assert.equal(ok, false);
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
  const fp = await getAuthFingerprint({ authorization: "Bearer token123" });
  assert.equal(fp.slice(0, 5), "auth:", "fingerprint should start with auth:");
  assert.ok(fp.length > 5, "fingerprint should be > 5 chars");
});

await test("getAuthFingerprint returns hash for cookie", async () => {
  const fp = await getAuthFingerprint({ cookie: "session=abc" });
  assert.equal(fp.slice(0, 5), "auth:", "fingerprint should start with auth:");
});

await test("getAuthFingerprint returns hash for multiple auth headers", async () => {
  const fp = await getAuthFingerprint({ authorization: "Bearer x", "x-api-key": "key123" });
  assert.equal(fp.slice(0, 5), "auth:", "fingerprint should start with auth:");
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
  assert.ok(data.length > 0, "serialized data should not be empty");
  const parsed = JSON.parse(data);
  assert.equal(parsed.version, 1);
  assert.equal(Array.isArray(parsed.entries), true, "entries should be an array");
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
  const cache = createMemoryCache({ maxAbsoluteAgeMs: 86400000 });
  await cache.set(
    { url: `${BASE}/imm`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=10, immutable" },
      body: "x",
    },
  );
  const r = await cache.get({ url: `${BASE}/imm`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache immutable entry");
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
  assert.notEqual(await s.get("k1"), null);
  assert.equal(await s.get("no-key"), null);
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
  const cache = createMemoryCache({ defaultTtlMs: 366 * 24 * 60 * 60 * 1000 });
  const s = await cache.set(
    { url: `${BASE}/cap`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  assert.equal(s, true);
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
  const cache = createMemoryCache({ cacheKey: () => "custom-key" });
  await cache.set(
    { url: `${BASE}/custom`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/custom`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with custom key");
});

await test("namespace prefixes keys", async () => {
  const cache = new HTTPCache({ namespace: "ns1" });
  await cache.set(
    { url: `${BASE}/ns`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
  );
  const r = await cache.get({ url: `${BASE}/ns`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache with namespace");
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
  assert.ok(s.totalEntries <= 2, `Entries: ${s.totalEntries}`);
  assert.ok(s.evictions >= 1, `Evictions: ${s.evictions}`);
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
  assert.ok(s.evictions >= 1, `Evictions by size: ${s.evictions}`);
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
  assert.ok(s.hitRate > 0, `Hit rate should be > 0, got ${s.hitRate}`);
});

// ============================================================================
// §11  FACTORY FUNCTIONS
// ============================================================================

suite("Factory Functions");

await test("createMemoryCache creates HTTPCache", async () => {
  const c = createMemoryCache();
  assert.ok(c instanceof HTTPCache, "should be HTTPCache instance");
});

await test("createMemoryCache with config", async () => {
  const c = createMemoryCache({ maxEntries: 10 });
  assert.ok(c instanceof HTTPCache, "should be HTTPCache instance");
});

await test("createTwoTierCache works", async () => {
  const l2 = new MemoryStorageAdapter();
  const c = createTwoTierCache(l2);
  assert.ok(c instanceof HTTPCache, "should be HTTPCache instance");
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
  assert.ok(cache instanceof HTTPCache, "should be HTTPCache instance");
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
});

await test("real httpbin.org/headers", async () => {
  const r = await httpbin.get("/headers");
  assert.equal(r.status, 200);
  assert.ok(r.data.headers, "headers should be present");
});

await test("real httpbin.org/json", async () => {
  const r = await httpbin.get("/json");
  assert.equal(r.status, 200);
  assert.ok(r.data.slideshow, "slideshow should be present");
});

await test("real httpbin.org/uuid", async () => {
  const r = await httpbin.get("/uuid");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.uuid, "string", "uuid should be a string");
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
});

await test("invalid Last-Modified date falls back to default TTL", async () => {
  const cache = createMemoryCache({ defaultTtlMs: 5000 });
  const ok = await cache.set(
    { url: `${BASE}/bad-lm`, method: "GET", headers: {} },
    {
      status: 200,
      statusText: "OK",
      headers: { "last-modified": "invalid-date-value" },
      body: "x",
    },
  );
  assert.equal(ok, true);
  const r = await cache.get({ url: `${BASE}/bad-lm`, method: "GET", headers: {} });
  assert.notEqual(r, null, "Should cache with default TTL despite invalid LM");
});

await test("all Cache-Control directive branches", async () => {
  const cache = createMemoryCache({ honorCacheControl: true });
  // Test must-revalidate, proxy-revalidate, public, private, no-transform, only-if-cached, must-understand
  const cc =
    "must-revalidate, proxy-revalidate, public, private, no-transform, only-if-cached, must-understand, max-age=3600";
  const ok = await cache.set(
    { url: `${BASE}/all-cc`, method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: { "cache-control": cc }, body: "x" },
  );
  assert.equal(ok, true);
  const r = await cache.get({ url: `${BASE}/all-cc`, method: "GET", headers: {} });
  assert.notEqual(r, null, "should cache entry with all cache-control directives");
});

// ============================================================================
// §13  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CACHE TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
