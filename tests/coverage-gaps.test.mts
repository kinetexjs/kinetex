/**
 * kinetex — regression tests for bug fixes whose new branches were otherwise
 * unreachable from the normal suites.
 *
 * Each block here corresponds to a fix recorded in CHANGELOG 1.3.0 whose
 * guarded code path no existing test executed, so a future refactor could
 * silently undo it.
 */

import assert from "node:assert/strict";
import { imdsCredentials } from "../src/aws-sigv4.ts";
import { DedupMap } from "../src/dedup.ts";
import { HTTPCache, MemoryStorageAdapter } from "../src/cache.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// IMDS role name must be percent-encoded
// ============================================================================

suite("IMDS credential provider");

/** Swap globalThis.fetch for `fn`, restoring it afterwards. */
async function withFetch<T>(
  fn: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = fn as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    g.fetch = prev;
  }
}

await test("percent-encodes an IMDS role name before building the credentials URL", async () => {
  // The role name comes from the metadata response. Interpolated raw, a role of
  // `../user-data` would have redirected the credentials request to a different
  // path on the metadata endpoint.
  const urls: string[] = [];
  const creds = await withFetch(
    async (url) => {
      urls.push(url);
      if (url.endsWith("/latest/api/token")) return new Response("TOKEN123");
      if (url.endsWith("/security-credentials/")) return new Response("../../user-data\n");
      return new Response(
        JSON.stringify({
          AccessKeyId: "AKIAEXAMPLE",
          SecretAccessKey: "secret",
          Token: "session",
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    () => imdsCredentials()(),
  );

  assert.equal(creds.accessKeyId, "AKIAEXAMPLE");
  const credsUrl = urls[urls.length - 1];
  assert.ok(
    credsUrl.includes("..%2F..%2Fuser-data"),
    `role name must be percent-encoded, got ${credsUrl}`,
  );
  // The raw traversal must not survive into the path.
  assert.ok(!credsUrl.includes("/../"), `role name must not traverse, got ${credsUrl}`);
});

await test("rejects an endpoint outside the IMDS allowlist", () => {
  assert.throws(
    () => imdsCredentials({ endpoint: "http://evil.example.com" }),
    /Invalid IMDS endpoint/,
  );
  assert.throws(() => imdsCredentials({ endpoint: "http://169.254.169.254.evil.com" }), /Invalid/);
});

// ============================================================================
// DedupMap: a new dedup window must clear the previous key's timer
// ============================================================================

suite("DedupMap window handling");

await test("registering a new window clears the previous timer for that key", async () => {
  const dedup = new DedupMap<string>({ windowMs: 60_000 });
  // `timeouts` is internal bookkeeping; reading it is the point of this test.
  const timeouts = (
    dedup as unknown as {
      timeouts: Map<string, ReturnType<typeof setTimeout>>;
    }
  ).timeouts;
  let calls = 0;
  const factory = async () => {
    calls++;
    return `result-${calls}`;
  };

  // First call: registers a 60s timer for this key.
  assert.equal(await dedup.execute("GET", "https://example.com/x", factory), "result-1");
  assert.equal(timeouts.size, 1);

  // Second call with a window that has already elapsed: the entry is treated as
  // expired, so a fresh request runs. Its resolution must clear the stale 60s
  // timer — otherwise that timer fires later and deletes the *new* entry from
  // `inflight` while callers are still sharing it.
  await delay(5);
  assert.equal(
    await dedup.execute("GET", "https://example.com/x", factory, undefined, 1),
    "result-2",
  );
  assert.equal(calls, 2);
  assert.equal(timeouts.size, 1, "the stale timer must be replaced, not duplicated");
  dedup.clear();
});

// ============================================================================
// Cache: tag references must be cleaned even when storage already lost the entry
// ============================================================================

suite("Cache tag index cleanup");

await test("a tag index reference is dropped even when storage has no entry", async () => {
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage });

  await cache.set(
    { url: "https://example.com/a", method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { tags: ["user"] },
  );

  // Simulate the entry vanishing from storage while the tag index still points
  // at it (eviction out from under the index, a cleared backend, a TTL race).
  await storage.clear();

  const tagIndex = (cache as unknown as { tagIndex: Map<string, Set<string>> }).tagIndex;
  assert.equal(tagIndex.get("user")?.size, 1, "precondition: the tag still references the key");

  const count = await cache.invalidateByTag("user");
  assert.equal(count, 1);

  // The regression this guards: the stale reference used to be left behind
  // forever, growing tagIndex on every eviction.
  assert.equal(tagIndex.get("user"), undefined, "the tag set must not outlive its entries");
});

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
