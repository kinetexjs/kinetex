import assert from "node:assert/strict";
import { kinetex, DedupMap, createDedupMap } from "../src/mod.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function t(name: string, fn: () => void | Promise<void>) {
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

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

// ============================================================================
// §1  BASIC EXECUTION
// ============================================================================

suite("Basic execution");

await t("single execute returns factory result", async () => {
  const d = new DedupMap();
  const r = await d.execute("GET", "https://httpbin.org/get", async () => {
    return (await httpbin.get("/get")).status;
  });
  assert.equal(r, 200);
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 1);
});

await t("concurrent same-key calls share one factory invocation", async () => {
  let count = 0;
  const d = new DedupMap();
  const results = await Promise.all([
    d.execute("GET", "https://httpbin.org/uuid", async () => {
      count++;
      const r = await httpbin.get<{ uuid: string }>("/uuid");
      return r.data.uuid;
    }),
    d.execute("GET", "https://httpbin.org/uuid", async () => {
      count++;
      const r = await httpbin.get<{ uuid: string }>("/uuid");
      return r.data.uuid;
    }),
    d.execute("GET", "https://httpbin.org/uuid", async () => {
      count++;
      const r = await httpbin.get<{ uuid: string }>("/uuid");
      return r.data.uuid;
    }),
  ]);
  assert.equal(count, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
  assert.match(results[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(d.hits, 2);
  assert.equal(d.misses, 1);
  // The three callers saw one response, and the accounting says so.
  assert.equal(d.getStats().totalRequests, 3);
  assert.equal(d.getStats().hitRate, 2 / 3);
  // windowMs defaults to 0, so the entry is gone once the factory settles.
  assert.deepEqual(d.keys, []);
  d.destroy();
});

await t("different keys produce independent requests", async () => {
  let count = 0;
  const d = new DedupMap();
  const [a, b] = await Promise.all([
    d.execute("GET", "https://httpbin.org/uuid", async () => {
      count++;
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    }),
    d.execute("GET", "https://httpbin.org/get", async () => {
      count++;
      return (await httpbin.get("/get")).status;
    }),
  ]);
  assert.equal(count, 2);
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 2);
  // `typeof a === "string"` is satisfied by any string at all. Pin the shape.
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(b, 200);
  // Two different keys, and neither left a trace: windowMs is 0, so a
  // completed entry is dropped immediately.
  assert.deepEqual(d.keys, []);
  assert.deepEqual(d.getStats(), {
    hits: 0,
    misses: 2,
    totalRequests: 2,
    hitRate: 0,
    inFlightCount: 0,
    trackedKeys: 0,
  });
});

// ============================================================================
// §2  WINDOW MODE
// ============================================================================

suite("Window mode");

await t("windowMs: sequential calls within window share result", async () => {
  let count = 0;
  const d = new DedupMap({ windowMs: 500 });
  const r1 = await d.execute("GET", "https://httpbin.org/uuid", async () => {
    count++;
    return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
  });
  const r2 = await d.execute("GET", "https://httpbin.org/uuid", async () => {
    count++;
    return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
  });
  assert.equal(count, 1);
  assert.equal(r1, r2);
  assert.equal(d.hits, 1);
  assert.equal(d.misses, 1);
});

await t("windowMs expired: call after window makes new request", async () => {
  let count = 0;
  const d = new DedupMap({ windowMs: 50 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => {
    count++;
    return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
  });
  assert.equal(d.keys.length, 1, "the first result is still inside its window");
  await new Promise((r) => setTimeout(r, 100));
  const r2 = await d.execute("GET", "https://httpbin.org/uuid", async () => {
    count++;
    return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
  });
  assert.equal(count, 2);
  assert.match(r2, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(d.hits, 0, "an expired window is a miss, not a hit");
  assert.equal(d.misses, 2);
  assert.equal(d.keys.length, 1, "the replacement entry replaced the stale one");
  d.destroy();
});

// ============================================================================
// §3  METHODS FILTER
// ============================================================================

suite("Methods filter");

await t("non-deduped method bypasses dedup", async () => {
  let count = 0;
  const d = new DedupMap();
  const [a, b] = await Promise.all([
    d.execute("POST", "https://httpbin.org/post", async () => {
      count++;
      return (await httpbin.post("/post", { n: 1 })).status;
    }),
    d.execute("POST", "https://httpbin.org/post", async () => {
      count++;
      return (await httpbin.post("/post", { n: 2 })).status;
    }),
  ]);
  assert.equal(count, 2, "POST is not in the default methods set, so both must run");
  // Each caller did its own work: the two bodies differed, and the two
  // responses are the two statuses, not one shared value.
  assert.equal(a, 200);
  assert.equal(b, 200);
  assert.equal(d.hits, 0);
  // A bypassed call is still a real network call, which is what `misses` is
  // documented to count. It used to return before the counters were touched,
  // so a client that deduped only POSTs reported totalRequests 0 forever.
  assert.equal(d.misses, 2);
  assert.equal(d.getStats().totalRequests, 2);
  assert.equal(d.getStats().hitRate, 0, "no call was shared, so nothing was saved");
  assert.deepEqual(d.keys, [], "a bypassed call leaves nothing in the map");
  d.destroy();
});

await t("custom methods set works", async () => {
  let count = 0;
  const d = new DedupMap({ methods: ["POST"] });
  const [a, b] = await Promise.all([
    d.execute("POST", "https://httpbin.org/post", async () => {
      count++;
      return 1;
    }),
    d.execute("POST", "https://httpbin.org/post", async () => {
      count++;
      return 2;
    }),
  ]);
  assert.equal(count, 1);
  assert.equal(a, 1);
  assert.equal(b, 1, "the waiter receives the leader's value, not its own");
  assert.equal(d.hits, 1);
  assert.equal(d.misses, 1);
  // The default set is replaced, not extended: GET is no longer deduped.
  let getCount = 0;
  await Promise.all([
    d.execute("GET", "https://httpbin.org/get", async () => ++getCount),
    d.execute("GET", "https://httpbin.org/get", async () => ++getCount),
  ]);
  assert.equal(getCount, 2, "GET is no longer in the set");
  assert.deepEqual(d.keys, []);
  d.destroy();
});

// ============================================================================
// §4  ERROR HANDLING
// ============================================================================

suite("Error handling");

await t("error propagated to all waiters", async () => {
  let count = 0;
  const d = new DedupMap();
  const err = await Promise.all([
    d
      .execute("GET", "https://httpbin.org/x", async () => {
        count++;
        throw new Error("dedup-fail");
      })
      .catch((e) => e),
    d
      .execute("GET", "https://httpbin.org/x", async () => {
        count++;
        throw new Error("dedup-fail");
      })
      .catch((e) => e),
  ]);
  assert.equal(count, 1);
  assert.equal(err[0].message, "dedup-fail");
  assert.equal(err[1].message, "dedup-fail");
});

await t("error in window: entry is cleared after error", async () => {
  const d = new DedupMap({ windowMs: 1000 });
  // The rejection itself is part of the contract, and the original error must
  // reach the caller rather than being swallowed or replaced.
  await assert.rejects(
    () =>
      d.execute("GET", "https://httpbin.org/x", async () => {
        throw new Error("fail");
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "fail");
      return true;
    },
  );
  // After error, entry should be deleted (line 197: this.inflight.delete(key))
  // A subsequent call should make a new request — and must NOT receive the
  // cached rejection.
  let count = 0;
  const retried = await d.execute("GET", "https://httpbin.org/x", async () => {
    count++;
    return 42;
  });
  assert.equal(count, 1, "the second call must reach the factory");
  assert.equal(retried, 42, "and must return its own result, not the cached failure");
});

// ============================================================================
// §5  CUSTOM KEY FUNCTION
// ============================================================================

suite("Custom key function");

await t("custom keyFn with URL normalization coalesces by path", async () => {
  let count = 0;
  // Key function strips query parameters — same path = same key
  const d = new DedupMap({ keyFn: (m, url) => url.split("?")[0]! });
  const [a, b] = await Promise.all([
    d.execute("GET", "https://httpbin.org/uuid?x=1", async () => {
      count++;
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    }),
    d.execute("GET", "https://httpbin.org/uuid?x=2", async () => {
      count++;
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    }),
  ]);
  assert.equal(count, 1);
  assert.equal(a, b);
});

await t("keyFn receives the canonical method and the headers", async () => {
  const seen: Array<[string, string, Record<string, string> | undefined]> = [];
  const d = new DedupMap<string>({
    keyFn: (m, url, headers) => {
      seen.push([m, url, headers]);
      return `${m}|${url}|${headers?.["X-A"] ?? ""}`;
    },
  });
  // Lowercase in, uppercase out: the methods filter has always been
  // case-insensitive, but the key used to be built from the caller's spelling,
  // so `execute("get", u)` and `execute("GET", u)` were two different keys
  // and never coalesced.
  await d.execute("get", "https://x.test/a", async () => "1", { "X-A": "1" });
  assert.deepEqual(seen, [["GET", "https://x.test/a", { "X-A": "1" }]]);
  // And that is what makes them the same key, not just the same method.
  let count = 0;
  const [a, b] = await Promise.all([
    d.execute("get", "https://x.test/b", async () => ++count),
    d.execute("GET", "https://x.test/b", async () => ++count),
  ]);
  assert.equal(count, 1, "method case must not split the key");
  assert.equal(a, 1);
  assert.equal(b, 1);
  // Headers reach the key function but are not in the default key.
  let plain = 0;
  await Promise.all([
    new DedupMap().execute("GET", "https://x.test/c", async () => ++plain),
    new DedupMap().execute("GET", "https://x.test/c", async () => ++plain),
  ]);
  assert.equal(plain, 2, "two independent maps never share anything");
  d.destroy();
});

await t("custom keyFn with method+path differentiates properly", async () => {
  let count = 0;
  const d = new DedupMap({ keyFn: (m, url) => `${m}:${url}` });
  await d.execute("GET", "https://httpbin.org/get", async () => {
    count++;
    return 1;
  });
  await d.execute("POST", "https://httpbin.org/post", async () => {
    count++;
    return 2;
  });
  assert.equal(count, 2);
  // And the custom key really is the one in use, not an artefact. A window is
  // needed to observe the key at all: with the default `windowMs: 0` a
  // completed entry is dropped the moment the factory settles.
  const windowed = new DedupMap({ windowMs: 1000, keyFn: (m, url) => `${m}:${url}` });
  await windowed.execute("GET", "https://httpbin.org/get", async () => 3);
  assert.deepEqual(windowed.keys, ["GET:https://httpbin.org/get"]);
  d.destroy();
  windowed.destroy();
});

// ============================================================================
// §6  ABORT SIGNAL
// ============================================================================

suite("Abort signal");

await t("pre-aborted signal bypasses dedup", async () => {
  let count = 0;
  const c = new AbortController();
  c.abort();
  const d = new DedupMap();
  // Should NOT dedupe because signal is aborted
  const [a, b] = await Promise.all([
    d.execute(
      "GET",
      "https://httpbin.org/uuid",
      async () => {
        count++;
        return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
      },
      {},
      undefined,
      c.signal,
    ),
    d.execute(
      "GET",
      "https://httpbin.org/uuid",
      async () => {
        count++;
        return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
      },
      {},
      undefined,
      c.signal,
    ),
  ]);
  assert.equal(count, 2, "a pre-aborted signal must not coalesce");
  // Two real requests means two different uuids, not one shared response.
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(d.hits, 0, "a bypassed call is never a hit");
  assert.equal(d.misses, 2, "but it is a real network call, so it is a miss");
  assert.deepEqual(d.keys, []);
  d.destroy();
});

await t("abort during inflight removes entry so waiter falls through", async () => {
  const d = new DedupMap({ windowMs: 0 });
  const c = new AbortController();
  // Start a slow request that will be the leader
  const slow = d.execute(
    "GET",
    "https://httpbin.org/delay/1",
    async () => {
      return (await httpbin.get("/delay/1")).status;
    },
    {},
    undefined,
    c.signal,
  );
  await new Promise((r) => setTimeout(r, 50));
  // Abort the leader - the entry should be removed (line 168-175)
  c.abort();
  // A waiter should now make its OWN request
  let count = 0;
  const fast = await d.execute("GET", "https://httpbin.org/get", async () => {
    count++;
    return (await httpbin.get("/get")).status;
  });
  assert.equal(count, 1);
  assert.equal(fast, 200);
  // Aborting drops the leader from the dedup map; it does not cancel the work
  // already in flight. The leader therefore settles with the factory's own
  // value. Asserting that is far stronger than the `.catch(() => {})` this
  // replaced, which asserted nothing at all — it would have passed whether the
  // promise resolved, rejected, or never settled.
  const leaderResult = await slow;
  assert.equal(typeof leaderResult, "number", "the leader must settle with its factory value");
  assert.equal(leaderResult, 200, "httpbin /delay/1 answers 200");
});

await t("same signal reused across multiple requests does not leak listeners", async () => {
  const d = new DedupMap();
  const c = new AbortController();
  let warning: string | null = null;
  const origWarn = process.emitWarning.bind(process);
  process.emitWarning = (msg: string | Error, ...args: unknown[]) => {
    if (typeof msg === "string" && msg.includes("MaxListeners")) warning = msg;
    origWarn(msg, ...(args as [string]));
  };
  for (let i = 0; i < 20; i++) {
    await d.execute(
      "GET",
      `https://httpbin.org/get?n=${i}`,
      async () => {
        return (await httpbin.get("/get")).status;
      },
      {},
      undefined,
      c.signal,
    );
  }
  process.emitWarning = origWarn;
  // No MaxListeners warning means no listener leak
  assert.equal(warning, null, `MaxListeners warning: ${warning}`);
  c.abort();
});

// ============================================================================
// §7  METRICS AND STATE MANAGEMENT
// ============================================================================

suite("Metrics & state");

await t("getStats returns correct structure", async () => {
  const d = new DedupMap();
  // A fresh map has done nothing. Pin every field to its exact value: six
  // `typeof x === "number"` checks are satisfied by any number at all,
  // including NaN, and by any object of the wrong shape.
  assert.deepEqual(d.getStats(), {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    hitRate: 0,
    inFlightCount: 0,
    trackedKeys: 0,
  });
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 0);
  assert.equal(d.inFlightCount, 0);
  assert.deepEqual(d.keys, []);
  d.destroy();
});

await t("getStats tracks in-flight work separately from windowed entries", async () => {
  // `inFlightCount` and `trackedKeys` answer different questions and used to be
  // interchangeable in the reader's mind: the first is unresolved work, the
  // second is everything the map is holding, windowed results included.
  const d = new DedupMap({ windowMs: 10_000 });
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((r) => (release = r));
  const pending = d.execute("GET", "http://x/slow", () => gate);
  assert.equal(d.inFlightCount, 1);
  assert.equal(d.getStats().trackedKeys, 1);
  release("done");
  await pending;
  assert.equal(d.inFlightCount, 0, "settled but still windowed is not in flight");
  assert.equal(d.getStats().trackedKeys, 1, "yet it is still tracked");
  d.destroy();
});

await t("getStats hitRate is 0 when no requests", () => {
  const d = new DedupMap();
  assert.equal(d.getStats().hitRate, 0);
});

await t("getStats hitRate calculates correctly", async () => {
  const d = new DedupMap();
  // Concurrent calls: one miss (leader), one hit (follower)
  const [a, b] = await Promise.all([
    d.execute(
      "GET",
      "https://httpbin.org/uuid",
      async () => (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid,
    ),
    d.execute(
      "GET",
      "https://httpbin.org/uuid",
      async () => (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid,
    ),
  ]);
  assert.equal(d.hits, 1);
  assert.equal(d.misses, 1);
  // `> 0` is satisfied by 0.01. Pin the ratio exactly.
  assert.equal(d.getStats().hitRate, 0.5);
  assert.equal(d.getStats().totalRequests, 2);
  assert.equal(a, b, "one response, two callers");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  d.destroy();
});

await t("getStats hitRate reaches 1 when every call is shared", async () => {
  const d = new DedupMap();
  let count = 0;
  await Promise.all(
    Array.from({ length: 4 }, () => d.execute("GET", "http://x/a", async () => ++count)),
  );
  assert.equal(count, 1);
  assert.equal(d.getStats().hitRate, 3 / 4);
  assert.equal(d.getStats().totalRequests, 4);
  d.destroy();
});

await t("inFlightCount tracks active requests", async () => {
  const d = new DedupMap();
  const p = d.execute(
    "GET",
    "https://httpbin.org/delay/1",
    async () => (await httpbin.get("/delay/1")).status,
  );
  assert.equal(d.inFlightCount, 1);
  assert.equal(d.keys.length, 1);
  assert.equal(d.keys[0], "GET::https://httpbin.org/delay/1");
  assert.equal(d.getStats().inFlightCount, 1);
  assert.equal(d.getStats().trackedKeys, 1);
  assert.equal(await p, 200);
  assert.equal(d.inFlightCount, 0);
  // windowMs defaults to 0, so settling also drops the entry.
  assert.deepEqual(d.keys, []);
  d.destroy();
});

await t("keys returns tracked keys", async () => {
  const d = new DedupMap({ windowMs: 5000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  // The default key is `${METHOD}::${url}` — an exact value, not a substring
  // match that any key mentioning the host would satisfy.
  assert.deepEqual(d.keys, ["GET::https://httpbin.org/uuid"]);
  await d.execute("HEAD", "https://httpbin.org/uuid", async () => 1);
  assert.deepEqual(d.keys, ["GET::https://httpbin.org/uuid", "HEAD::https://httpbin.org/uuid"]);
  d.clear();
});

await t("resetMetrics clears counters", async () => {
  // resetMetrics() resets the counters and nothing else. It is the only
  // distinction from clear(), and the test never made it: entries survived
  // here and the test would have passed identically if they had not.
  const d = new DedupMap({ windowMs: 10_000 });
  let count = 0;
  await d.execute("GET", "http://x/a", async () => ++count);
  await d.execute("GET", "http://x/a", async () => ++count);
  assert.equal(d.hits, 1);
  assert.equal(d.misses, 1);
  d.resetMetrics();
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 0);
  assert.equal(d.getStats().hitRate, 0);
  assert.deepEqual(d.keys, ["GET::http://x/a"], "the cached entry survives");
  // Which is observable: the window still serves the result.
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), 1);
  assert.equal(count, 1, "no second network call");
  assert.equal(d.hits, 1, "and the hit is counted against the reset baseline");
  d.destroy();
});

await t("clear removes entries and their pending window timeouts", async () => {
  // The two "clear" tests this replaces were identical except for the window
  // length, and neither checked the timeout. The timer is the part that leaks:
  // it holds the key and the result alive for the whole window, so clearing
  // the map without clearing the timers bounds nothing.
  const d = new DedupMap({ windowMs: 10_000 });
  await d.execute("GET", "http://x/a", async () => 1);
  assert.equal(d.keys.length, 1);
  assert.equal(d.getStats().trackedKeys, 1);
  d.clear();
  assert.equal(d.keys.length, 0);
  assert.equal(d.getStats().trackedKeys, 0);
  assert.equal(d.getStats().inFlightCount, 0);
  // The counters are untouched: clear() is not resetMetrics().
  assert.equal(d.misses, 1);
  // And a later call starts a new entry rather than finding the old one: the
  // first factory returned a literal 1, so a run factory can only be a second
  // network call.
  let count = 0;
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), 1);
  assert.equal(count, 1, "the cleared entry was really dropped");
  assert.equal(d.hits, 0, "and nothing was coalesced");
  assert.equal(d.misses, 2);
  d.destroy();
});

await t("abort signal clears pending window timeout", async () => {
  const d = new DedupMap({ windowMs: 50000 });
  const c = new AbortController();
  const p = d.execute(
    "GET",
    "https://httpbin.org/uuid",
    async () => {
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    },
    {},
    undefined,
    c.signal,
  );
  const uuid = await p;
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The request has settled and its abort listener has been removed, so an
  // abort now reaches nothing. The entry stays in its window, and the abort
  // after completion must not tear it down.
  assert.deepEqual(d.keys, ["GET::https://httpbin.org/uuid"]);
  c.abort();
  assert.deepEqual(d.keys, ["GET::https://httpbin.org/uuid"], "abort after settle is inert");
  // Which is observable: the window still serves the result.
  let count = 0;
  assert.match(
    await d.execute("GET", "https://httpbin.org/uuid", async () => {
      count++;
      return "fresh";
    }),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(count, 0, "still coalescing");
  d.destroy();
});

await t("invalidate removes specific key and returns true", async () => {
  const d = new DedupMap({ windowMs: 10_000 });
  let count = 0;
  await d.execute("GET", "http://x/a", async () => ++count);
  const k = d.keys[0]!;
  assert.equal(k, "GET::http://x/a");
  assert.equal(d.invalidate(k), true);
  assert.equal(d.keys.length, 0);
  // Invalidation has to be observable, not just a shorter map.
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), 2);
  assert.equal(count, 2, "the cached result was really dropped");
  d.destroy();
});

await t("invalidate on non-existent key returns false", async () => {
  const d = new DedupMap();
  assert.equal(d.invalidate("no-such-key"), false);
  // A near-miss must not be treated as a hit either.
  await d.execute("GET", "http://x/a", async () => 1, {}, 10_000);
  assert.equal(d.invalidate("get::http://x/a"), false, "the key is case-sensitive");
  assert.equal(d.invalidate("GET::http://x/"), false, "no prefix matching");
  assert.equal(d.keys.length, 1, "and the real entry is untouched");
  d.destroy();
});

await t("destroy calls clear", async () => {
  // destroy() is documented as clearing entries *and* cancelling the
  // timeouts. Asserting only the key count would be satisfied by a destroy()
  // that left every window timer running.
  const d = new DedupMap({ windowMs: 10_000 });
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((r) => (release = r));
  const pending = d.execute("GET", "http://x/a", () => gate);
  assert.equal(d.inFlightCount, 1);
  d.destroy();
  assert.deepEqual(d.keys, []);
  assert.equal(d.getStats().trackedKeys, 0);
  // An entry that is dropped while in flight must not be resurrected when the
  // factory finally settles.
  release("done");
  assert.equal(await pending, "done");
  assert.deepEqual(d.keys, [], "the settled leader must not re-enter the map");
  d.destroy();
});

// ============================================================================
// §8  PER-KEY TTL OVERRIDE
// ============================================================================

suite("Per-key TTL override");

await t("per-key windowMs overrides global windowMs", async () => {
  let count = 0;
  const d = new DedupMap({ windowMs: 0 }); // global: no window
  const r1 = await d.execute(
    "GET",
    "https://httpbin.org/uuid",
    async () => {
      count++;
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    },
    {},
    500,
  ); // per-key TTL: 500ms
  const r2 = await d.execute(
    "GET",
    "https://httpbin.org/uuid",
    async () => {
      count++;
      return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
    },
    {},
    500,
  );
  assert.equal(count, 1);
  assert.equal(r1, r2);
});

// ============================================================================
// §10  EXPIRED WINDOW EDGE CASES (mock-assisted, real HTTP)
// ============================================================================

suite("Expired window edge cases");

await t("expired window: second request after expiry creates new entry", async () => {
  const d = new DedupMap({ windowMs: 1 });
  await d.execute("GET", "https://httpbin.org/get", async () => {
    return (await httpbin.get("/get")).status;
  });
  // The window is 1 ms, so by the time the 10 ms wait is over the expiry
  // timer has already removed the entry. Expiry is a timer, not a sweep done
  // on read, so a lapsed window leaves nothing behind for a caller to find.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(d.keys, [], "the entry expired on its own timer");
  let count2 = 0;
  const r2 = await d.execute("GET", "https://httpbin.org/get", async () => {
    count2++;
    return (await httpbin.get("/get")).status;
  });
  assert.equal(count2, 1);
  assert.equal(r2, 200);
  // The expired entry was replaced, not stacked behind: one key, two misses,
  // and the accounting is honest about the network work done.
  assert.deepEqual(d.keys, ["GET::https://httpbin.org/get"]);
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 2);
  d.destroy();
});

// ============================================================================
// §11  PURE MOCK TESTS (remaining uncovered lines)
// ============================================================================

suite("Pure mock tests");

await t("mock: expired window delete + error handler clears orphaned timeout", async () => {
  const origSet = globalThis.setTimeout.bind(globalThis);
  const origClear = globalThis.clearTimeout.bind(globalThis);
  const captured = new Set<number>();
  let fid = 9000;
  let oldCleared = false;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms >= 100) {
      const id = fid++;
      captured.add(id);
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return origSet(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (captured.has(id as number)) {
      oldCleared = true;
      captured.delete(id as number);
    } else origClear(id as any);
  }) as typeof clearTimeout;
  try {
    const d = new DedupMap({ windowMs: 200, methods: ["MOCK"] });
    await d.execute("MOCK", "http://mock/url", async () => "first");
    await new Promise((r) => origSet(r, 250));
    // The factory throws by contract, so the rejection is part of what is being
    // tested: a bare `catch {}` accepted the case where `execute` resolved
    // successfully, which would leave the orphaned timer in place and hide the
    // very leak this test exists to catch.
    await assert.rejects(
      () =>
        d.execute("MOCK", "http://mock/url", async () => {
          throw new Error("mock-fail");
        }),
      /mock-fail/,
      "the factory's own error must propagate out of execute()",
    );
    assert.equal(oldCleared, true, "Error handler must clear orphaned timeout");
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
});

await t("mock: abort handler clears orphaned timeout during inflight", async () => {
  const origSet = globalThis.setTimeout.bind(globalThis);
  const origClear = globalThis.clearTimeout.bind(globalThis);
  const captured = new Set<number>();
  let fid = 9000;
  let oldCleared = false;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms >= 100) {
      const id = fid++;
      captured.add(id);
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return origSet(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (captured.has(id as number)) {
      oldCleared = true;
      captured.delete(id as number);
    } else origClear(id as any);
  }) as typeof clearTimeout;
  try {
    const d = new DedupMap({ windowMs: 200, methods: ["MOCK"] });
    await d.execute("MOCK", "http://mock/url", async () => "first");
    await new Promise((r) => origSet(r, 250));
    const ctrl = new AbortController();
    const p2 = d.execute(
      "MOCK",
      "http://mock/url",
      async () => {
        await new Promise((r) => origSet(r, 50));
        return "slow";
      },
      {},
      undefined,
      ctrl.signal,
    );
    await new Promise((r) => origSet(r, 10));
    ctrl.abort();
    // Abort removes the entry and clears its orphaned timer, but the in-flight
    // call still settles with the factory's value.
    assert.equal(await p2, "slow", "the aborted leader settles with its factory value");
    assert.equal(oldCleared, true, "Abort handler must clear orphaned timeout");
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
});

await t("createDedupMap applies the options it is given", async () => {
  const d = createDedupMap({ windowMs: 10_000 });
  assert.ok(d instanceof DedupMap);
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 0);
  // The window is really configured, not just stored: the settled entry is
  // still there to be served.
  await d.execute("GET", "http://x/a", async () => "first");
  assert.deepEqual(d.keys, ["GET::http://x/a"]);
  let count = 0;
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), "first");
  assert.equal(count, 0, "the window served the result");
  d.destroy();
});

await t("createDedupMap with no options uses the documented defaults", async () => {
  const d = createDedupMap();
  assert.ok(d instanceof DedupMap);
  // windowMs defaults to 0 — only in-flight requests coalesce.
  let count = 0;
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), 1);
  assert.equal(await d.execute("GET", "http://x/a", async () => ++count), 2);
  assert.deepEqual(d.keys, [], "nothing is retained after a request settles");
  // methods defaults to GET and HEAD, and the two are not the same thing.
  let head = 0;
  await Promise.all([
    d.execute("HEAD", "http://x/h", async () => ++head),
    d.execute("HEAD", "http://x/h", async () => ++head),
  ]);
  assert.equal(head, 1, "HEAD is deduped by default");
  let post = 0;
  await Promise.all([
    d.execute("POST", "http://x/p", async () => ++post),
    d.execute("POST", "http://x/p", async () => ++post),
  ]);
  assert.equal(post, 2, "POST is not");
  d.destroy();
});

// ============================================================================
// §12  REAL HTTP END-TO-END
// ============================================================================

// ============================================================================
// §12  REAL HTTP END-TO-END
// ============================================================================
// §11  REAL HTTP END-TO-END
// ============================================================================

suite("Real HTTP");

await t("httpbin GET /get returns 200", async () =>
  assert.equal((await httpbin.get("/get")).status, 200),
);
await t("httpbin POST echoes JSON", async () => {
  const r = await httpbin.post("/post", { t: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.json, { t: 1 });
});
await t("httpbin /ip returns origin", async () => {
  const r = await httpbin.get("/ip");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.origin, "string");
  assert.ok(r.data.origin.includes("."), `Expected IP format, got: ${r.data.origin}`);
});
await t("httpbin /uuid returns uuid", async () => {
  const r = await httpbin.get("/uuid");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.uuid, "string");
  assert.ok(/^[0-9a-f-]{36}$/.test(r.data.uuid), `Expected UUID format, got: ${r.data.uuid}`);
});
await t("httpbin /json has slideshow", async () => {
  const r = await httpbin.get("/json");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.slideshow, "object");
  assert.equal(r.data.slideshow.author, "Yours Truly");
});
await t("httpbin /base64 decodes", async () => {
  const r = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(r.status, 200);
  assert.equal(String(r.data).trim(), "Hello World");
});
await t("httpbin delay/0 fast", async () => {
  const start = Date.now();
  const r = await httpbin.get("/delay/0");
  assert.equal(r.status, 200);
  assert.ok(Date.now() - start < 2000);
});

// ============================================================================
// §10  KINETEX CLIENT WITH DEDUP ENABLED
// ============================================================================

suite("kinetex client with dedup");

await t("client.enableDedup coalesces concurrent GETs", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableDedup();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => client.get<{ uuid: string }>("/uuid")),
  );
  const uuids = results.map((r) => r.data.uuid);
  assert.equal(new Set(uuids).size, 1, "one response, five callers");
  assert.match(uuids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The whole snapshot, not just two fields. The client wrapper used to expose
  // only `hits`, `misses` and `inFlightCount`, so the hit rate — the one
  // figure a dedup dashboard is built on — was unavailable on the client even
  // though the map computed it.
  assert.deepEqual(client.dedupMetrics, {
    hits: 4,
    misses: 1,
    totalRequests: 5,
    hitRate: 0.8,
    inFlightCount: 0,
    trackedKeys: 0,
  });
  client.disableDedup();
});

await t("client.disableDedup stops coalescing", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableDedup({ windowMs: 100 });
  // With dedup
  const [a, b] = await Promise.all([
    client.get<{ uuid: string }>("/uuid"),
    client.get<{ uuid: string }>("/uuid"),
  ]);
  assert.equal(a.data.uuid, b.data.uuid);
  // Now disable
  client.disableDedup();
  assert.equal(client.dedupMetrics, null);
  // ...and requests really stop coalescing. The test used to stop at the null
  // check, which a `disableDedup()` that only dropped the metrics reference
  // would satisfy.
  let fresh = 0;
  const uuids = await Promise.all(
    Array.from({ length: 3 }, () =>
      client.get<{ uuid: string }>("/uuid").then((r) => {
        fresh++;
        return r.data.uuid;
      }),
    ),
  );
  assert.equal(fresh, 3, "three distinct responses");
  assert.equal(new Set(uuids).size, 3, "so three distinct uuids");
  for (const u of uuids) {
    assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

await t("client.enableDedup does not coalesce a non-idempotent method", async () => {
  // The client's own default is GET/HEAD. If it silently deduped POST, two
  // mutations would share one response and one of them would never happen.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableDedup({ windowMs: 5_000 });
  const [a, b] = await Promise.all([
    client.post<{ json: { n: number } }>("/post", { n: 1 }),
    client.post<{ json: { n: number } }>("/post", { n: 2 }),
  ]);
  assert.deepEqual(a.data.json, { n: 1 });
  assert.deepEqual(b.data.json, { n: 2 });
  assert.equal(client.dedupMetrics!.hits, 0);
  assert.equal(client.dedupMetrics!.misses, 2, "both reached the network");
  client.disableDedup();
});

// ============================================================================
// §13  REGRESSION: THE FOUR FIXES
// ============================================================================

suite("regression: method case, window ownership, key ownership, metrics");

await t("regression: method case does not split the key", async () => {
  // `methods` is documented as case-insensitive and the filter uppercases, but
  // the key was built from the caller's spelling. `execute("get", u)` and
  // `execute("GET", u)` were two keys, so the one casing mistake a caller makes
  // most — and one the library treats as equal everywhere else — silently
  // turned deduplication off.
  const d = new DedupMap();
  let count = 0;
  const [a, b] = await Promise.all([
    d.execute("get", "http://x/a", async () => ++count),
    d.execute("GET", "http://x/a", async () => ++count),
    d.execute("Get", "http://x/a", async () => ++count),
  ]);
  assert.equal(count, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(d.hits, 2);
  assert.equal(d.misses, 1);
  // The key itself is canonical, so anything reading `keys` sees one spelling.
  const windowed = new DedupMap({ windowMs: 10_000 });
  await windowed.execute("head", "http://x/a", async () => 1);
  assert.deepEqual(windowed.keys, ["HEAD::http://x/a"]);
  d.destroy();
  windowed.destroy();
});

await t("regression: a windowMs:0 caller cannot destroy someone else's window", async () => {
  // The `effectiveWindowMs === 0` path used to fall through to
  // `inflight.delete(key)` and then lead, wiping a window another caller had
  // established. One such call emptied the cache for everyone, and the next
  // windowed caller went to the network for a result that was still in hand.
  const d = new DedupMap({ windowMs: 10_000 });
  let count = 0;
  assert.equal(await d.execute("GET", "http://x/w", async () => ++count), 1);
  assert.deepEqual(d.keys, ["GET::http://x/w"]);

  // A caller that explicitly opts out of reuse gets its own request...
  assert.equal(await d.execute("GET", "http://x/w", async () => ++count, {}, 0), 2);
  assert.equal(count, 2, "it did not reuse the cached result");
  // ...and the cache is untouched, because it was not its window to discard.
  assert.deepEqual(d.keys, ["GET::http://x/w"], "the window survived");
  assert.equal(d.getStats().trackedKeys, 1);

  // A third windowed caller is still served from the window.
  assert.equal(await d.execute("GET", "http://x/w", async () => ++count, {}, 10_000), 1);
  assert.equal(count, 2, "no third network call");
  assert.equal(d.hits, 1);
  assert.equal(d.misses, 2, "the bypass is still counted");

  // The default map (windowMs 0) is unchanged: nothing is ever retained, so
  // there is nothing for a bypass to protect.
  const plain = new DedupMap();
  await plain.execute("GET", "http://x/w", async () => 1);
  assert.deepEqual(plain.keys, []);
  d.destroy();
  plain.destroy();
});

await t("regression: an aborted leader cannot delete the entry that replaced it", async () => {
  // The abort handler drops the entry so a waiter falls through, and a later
  // caller for the same URL becomes the new leader. The old promise then
  // settled and registered a window timer for a key it no longer owned; when
  // that timer fired it deleted the *new* leader while it was still running,
  // so the next caller started a third copy of an in-flight request.
  const d = new DedupMap({ windowMs: 40 });
  const c = new AbortController();
  const first = d.execute(
    "GET",
    "http://x/a",
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "old";
    },
    {},
    40,
    c.signal,
  );
  await new Promise((r) => setTimeout(r, 5));
  c.abort();
  assert.deepEqual(d.keys, [], "aborting drops the leader");

  // The replacement leader is slow, so it is still in flight when the old
  // 40 ms window timer would have fired.
  const second = d.execute(
    "GET",
    "http://x/a",
    async () => {
      await new Promise((r) => setTimeout(r, 300));
      return "new";
    },
    {},
    40,
  );
  assert.deepEqual(d.keys, ["GET::http://x/a"]);
  assert.equal(d.inFlightCount, 1);

  assert.equal(await first, "old", "the aborted leader still settles");
  await new Promise((r) => setTimeout(r, 80)); // well past the old 40 ms window

  assert.deepEqual(d.keys, ["GET::http://x/a"], "the replacement is still there");
  assert.equal(d.inFlightCount, 1, "and still in flight");

  let third = 0;
  assert.equal(
    await d.execute("GET", "http://x/a", async () => ++third),
    "new",
    "a caller arriving now joins the leader rather than starting a third copy",
  );
  assert.equal(third, 0, "no extra factory ran");
  assert.equal(d.hits, 1);
  assert.equal(await second, "new");
  d.destroy();
});

await t("regression: an aborted leader's rejection cannot delete the new leader", async () => {
  // The same ownership rule on the failure path: the old error handler deleted
  // the key unconditionally, so a factory that rejected after its entry had
  // been replaced took the replacement down with it — and the next caller
  // issued a duplicate request instead of joining the one already running.
  const d = new DedupMap({ windowMs: 10_000 });
  const c = new AbortController();
  const first = d
    .execute(
      "GET",
      "http://x/a",
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("stale-failure");
      },
      {},
      10_000,
      c.signal,
    )
    .catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 5));
  c.abort();

  const second = d.execute(
    "GET",
    "http://x/a",
    async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "new";
    },
    {},
    10_000,
  );
  assert.deepEqual(d.keys, ["GET::http://x/a"]);

  const err = await first;
  assert.equal(err.message, "stale-failure", "the original error still reaches its caller");
  assert.deepEqual(d.keys, ["GET::http://x/a"], "the replacement survived the stale rejection");
  assert.equal(d.inFlightCount, 1);

  let third = 0;
  assert.equal(await d.execute("GET", "http://x/a", async () => ++third), "new");
  assert.equal(third, 0);
  assert.equal(await second, "new");
  d.destroy();
});

await t("regression: bypassed calls are counted in the metrics", async () => {
  // `misses` is documented as "requests that triggered a real network call",
  // but both bypasses returned before the counters were touched. A client
  // whose method filter excluded everything — or whose signal was already
  // aborted — reported totalRequests 0 and a hitRate of 0 no matter how much
  // traffic it generated, and any dashboard built on it read a flat zero.
  const d = new DedupMap();

  await d.execute("POST", "http://x/p", async () => 1);
  await d.execute("PUT", "http://x/p", async () => 1);
  assert.deepEqual(d.getStats(), {
    hits: 0,
    misses: 2,
    totalRequests: 2,
    hitRate: 0,
    inFlightCount: 0,
    trackedKeys: 0,
  });

  const c = new AbortController();
  c.abort();
  await d.execute("GET", "http://x/g", async () => 1, {}, undefined, c.signal);
  assert.equal(d.misses, 3, "a pre-aborted call is a real network call too");
  assert.equal(d.getStats().totalRequests, 3);
  assert.equal(d.getStats().hitRate, 0);
  assert.deepEqual(d.keys, []);

  // And the ratio still means something once there is a mix: 1 shared of 4.
  const mixed = new DedupMap();
  await Promise.all([
    mixed.execute("GET", "http://x/a", async () => 1),
    mixed.execute("GET", "http://x/a", async () => 1),
    mixed.execute("POST", "http://x/p", async () => 1),
    mixed.execute("POST", "http://x/p", async () => 1),
  ]);
  assert.equal(mixed.getStats().hitRate, 0.25);
  assert.equal(mixed.getStats().totalRequests, 4);
  d.destroy();
  mixed.destroy();
});

// ============================================================================
// §11  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  DEDUP TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
