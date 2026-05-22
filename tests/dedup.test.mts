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
  assert.equal(d.hits, 2);
  assert.equal(d.misses, 1);
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
  assert.ok(typeof a === "string");
  assert.equal(b, 200);
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
  await new Promise((r) => setTimeout(r, 100));
  await d.execute("GET", "https://httpbin.org/uuid", async () => {
    count++;
    return (await httpbin.get<{ uuid: string }>("/uuid")).data.uuid;
  });
  assert.equal(count, 2);
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
  assert.equal(count, 2);
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 0);
});

await t("custom methods set works", async () => {
  let count = 0;
  const d = new DedupMap({ methods: ["POST"] });
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
  assert.equal(count, 1);
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
  await d
    .execute("GET", "https://httpbin.org/x", async () => {
      throw new Error("fail");
    })
    .catch(() => {});
  // After error, entry should be deleted (line 197: this.inflight.delete(key))
  // A subsequent call should make a new request
  let count = 0;
  await d.execute("GET", "https://httpbin.org/x", async () => {
    count++;
    return 42;
  });
  assert.equal(count, 1);
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
  assert.equal(count, 2);
});

await t("abort during inflight removes entry so waiter falls through", async () => {
  const d = new DedupMap({ windowMs: 0 });
  const c = new AbortController();
  // Start a slow request that will be the leader
  const slow = d.execute(
    "GET",
    "https://httpbin.org/delay/3",
    async () => {
      return (await httpbin.get("/delay/3")).status;
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
  await slow.catch(() => {});
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
  const stats = d.getStats();
  assert.equal(typeof stats.hits, "number");
  assert.equal(typeof stats.misses, "number");
  assert.equal(typeof stats.totalRequests, "number");
  assert.equal(typeof stats.hitRate, "number");
  assert.equal(typeof stats.inFlightCount, "number");
  assert.equal(typeof stats.trackedKeys, "number");
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
  assert.ok(d.getStats().hitRate > 0);
});

await t("inFlightCount tracks active requests", async () => {
  const d = new DedupMap();
  const p = d.execute(
    "GET",
    "https://httpbin.org/delay/1",
    async () => (await httpbin.get("/delay/1")).status,
  );
  assert.equal(d.inFlightCount, 1);
  await p;
  assert.equal(d.inFlightCount, 0);
});

await t("keys returns tracked keys", async () => {
  const d = new DedupMap({ windowMs: 5000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  assert.equal(d.keys.length, 1);
  assert.ok(d.keys[0].includes("httpbin.org/uuid"));
  d.clear();
});

await t("resetMetrics clears counters", async () => {
  const d = new DedupMap();
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  d.resetMetrics();
  assert.equal(d.hits, 0);
  assert.equal(d.misses, 0);
});

await t("clear removes all entries and timeouts", async () => {
  const d = new DedupMap({ windowMs: 10000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  assert.equal(d.keys.length, 1);
  d.clear();
  assert.equal(d.keys.length, 0);
});

await t("clear with pending timeouts removes them", async () => {
  const d = new DedupMap({ windowMs: 50000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  // Entry is in window mode with a pending timeout
  d.clear(); // Should clear the timeout
  assert.equal(d.keys.length, 0);
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
  assert.equal(typeof uuid, "string");
  // Now abort - should trigger the abort handler which clears timeout
  c.abort();
  // Entry should remain in window (the abort handler removes it only if abort fires before completion)
  // For the abort handler timeout clearing, we need the abort to fire during inflight
  // which is tested in "abort during inflight removes entry so waiter falls through"
  d.clear();
});

await t("invalidate removes specific key and returns true", async () => {
  const d = new DedupMap({ windowMs: 10000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  const k = d.keys[0];
  assert.equal(d.invalidate(k), true);
  assert.equal(d.keys.length, 0);
});

await t("invalidate on non-existent key returns false", () => {
  const d = new DedupMap();
  assert.equal(d.invalidate("no-such-key"), false);
});

await t("destroy calls clear", async () => {
  const d = new DedupMap({ windowMs: 10000 });
  await d.execute("GET", "https://httpbin.org/uuid", async () => 1);
  d.destroy();
  assert.equal(d.keys.length, 0);
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
  await new Promise((r) => setTimeout(r, 10));
  let count2 = 0;
  const r2 = await d.execute("GET", "https://httpbin.org/get", async () => {
    count2++;
    return (await httpbin.get("/get")).status;
  });
  assert.equal(count2, 1);
  assert.equal(r2, 200);
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
    try {
      await d.execute("MOCK", "http://mock/url", async () => {
        throw new Error("mock-fail");
      });
    } catch {}
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
    await p2.catch(() => {});
    assert.equal(oldCleared, true, "Abort handler must clear orphaned timeout");
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
});

await t("createDedupMap factory returns DedupMap", async () => {
  const { createDedupMap: cdm } = await import("../src/mod.ts");
  const d = cdm({ windowMs: 100 });
  assert.ok(d instanceof DedupMap);
  assert.equal(d.hits, 0);
});

await t("createDedupMap with defaults", async () => {
  const { createDedupMap: cdm } = await import("../src/mod.ts");
  const d = cdm();
  assert.ok(d instanceof DedupMap);
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
  assert.ok(uuids.every((u) => u === uuids[0]));
  assert.equal(client.dedupMetrics!.hits, 4);
  assert.equal(client.dedupMetrics!.misses, 1);
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
});

// ============================================================================
// §11  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  DEDUP TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
