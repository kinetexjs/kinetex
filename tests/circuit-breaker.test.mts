import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
} from "../src/mod.ts";

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

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

function netErr(): Error {
  return Object.assign(new Error("network"), { code: "ENETWORK" });
}

function timedOutErr(): Error {
  return Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
}

// ============================================================================
// §1  STATE MACHINE
// ============================================================================

suite("State Machine");

await test("initial state is CLOSED", async () => {
  assert.equal(new CircuitBreaker("x").state, "CLOSED");
});

await test("sliding window: 3 failures with threshold 3 opens circuit", async () => {
  const cb = new CircuitBreaker("s1", {
    windowSize: 5,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED"); // 2 < 3
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN"); // 3 >= 3
});

await test("OPEN state rejects all requests with CircuitOpenError", async () => {
  const cb = new CircuitBreaker("s2", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  const err = await cb.execute(() => Promise.resolve(42)).catch((e) => e);
  assert.ok(err instanceof CircuitOpenError);
  assert.equal(err.code, "ECIRCUITOPEN");
  assert.equal(err.state.state, "OPEN");
  assert.equal(err.state.totalRejected, 1);
});

await test("OPEN → HALF_OPEN after resetTimeoutMs elapses, then closes on success", async () => {
  const cb = new CircuitBreaker("s3", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    successThreshold: 1,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
  await new Promise((r) => setTimeout(r, 500));

  let halfOpenAt: number | null = null;
  const original = cb.snapshot;
  // Next execute triggers _checkTransition → goes HALF_OPEN, then probe → closes
  const result = await cb.execute(async () => {
    halfOpenAt = cb.snapshot.halfOpenAt;
    return (await httpbin.get("/get")).status;
  });
  assert.equal(result, 200);
  assert.equal(cb.state, "CLOSED");
  assert.ok(halfOpenAt !== null, "Half-open timestamp should be set");
});

await test("OPEN → HALF_OPEN → failed probe re-opens circuit immediately", async () => {
  const cb = new CircuitBreaker("s4", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
});

await test("HALF_OPEN concurrency limit rejects additional probes", async () => {
  const cb = new CircuitBreaker("s5", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    halfOpenConcurrency: 1,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await new Promise((r) => setTimeout(r, 500));
  // Start slow probe in HALF_OPEN
  const slowProbe = cb.execute(async () => {
    await new Promise((r) => setTimeout(r, 800));
    return 42;
  });
  await new Promise((r) => setTimeout(r, 50));
  // Second attempt should be rejected (concurrency limit)
  const err = await cb.execute(() => Promise.resolve(1)).catch((e) => e);
  assert.ok(err instanceof CircuitOpenError, "Second probe should be rejected");
  assert.equal(cb.snapshot.totalRejected, 1);
  await slowProbe;
});

// ============================================================================
// §2  CONSECUTIVE MODE (windowSize=0)
// ============================================================================

suite("Consecutive Mode");

await test("windowSize=0: 2 consecutive failures open circuit", async () => {
  const cb = new CircuitBreaker("c1", {
    windowSize: 0,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED"); // 1 < 2
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN"); // 2 >= 2
});

await test("windowSize=0: success resets failure counter", async () => {
  const cb = new CircuitBreaker("c2", {
    windowSize: 0,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await cb.execute(async () => (await httpbin.get("/get")).status); // success resets
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED"); // counter was reset, only 1 consecutive now
});

await test("snapshot failureCount uses consecutive count when windowSize=0", async () => {
  const cb = new CircuitBreaker("c3", {
    windowSize: 0,
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 1);
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 2);
});

// ============================================================================
// §3  SLIDING WINDOW EDGE CASES
// ============================================================================

suite("Sliding Window Edge Cases");

await test("window shift on success: old entries shift out when window fills", async () => {
  const cb = new CircuitBreaker("w1", {
    windowSize: 3,
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  // Push 2 failures, then 3 successes = 5 entries total in window of size 3
  // After 5 entries, window should have exactly 3 entries (2 oldest shifted out)
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await cb.execute(async () => (await httpbin.get("/get")).status);
  await cb.execute(async () => (await httpbin.get("/get")).status);
  await cb.execute(async () => (await httpbin.get("/get")).status);
  // Window has [true, true, true] (3 successes, failures shifted out)
  // snapshot uses window filter, failureCount should be 0
  assert.equal(cb.snapshot.failureCount, 0);
  assert.equal(cb.state, "CLOSED");
});

await test("window shift on failure: old failures shift out when window fills", async () => {
  const cb = new CircuitBreaker("w2", {
    windowSize: 2,
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  // Push 3 failures into window of size 2
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  // Window should have exactly 2 entries (oldest shifted out)
  // With failureThreshold=5, circuit stays CLOSED
  assert.equal(cb.state, "CLOSED");
  // failureCount should be 2 (window length clamped to size)
  assert.equal(cb.snapshot.failureCount, 2);
});

await test("snapshot failureCount uses window filter when windowSize > 0", async () => {
  const cb = new CircuitBreaker("w3", {
    windowSize: 5,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 2);
});

// ============================================================================
// §4  FAILURE FILTERS
// ============================================================================

suite("Failure Filters");

await test("ENETWORK counted when networkErrors is true", async () => {
  const cb = new CircuitBreaker("f1", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
});

await test("ETIMEOUT counted when timeouts is true", async () => {
  const cb = new CircuitBreaker("f2", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { timeouts: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(timedOutErr())));
  assert.equal(cb.state, "OPEN");
});

await test("HTTP 500 counted when serverErrors is true", async () => {
  const cb = new CircuitBreaker("f3", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { serverErrors: true },
  });
  await assert.rejects(() =>
    cb.execute(() => Promise.reject(Object.assign(new Error("500"), { status: 500 }))),
  );
  assert.equal(cb.state, "OPEN");
});

await test("custom status code 429 counted when in statusCodes list", async () => {
  const cb = new CircuitBreaker("f4", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { statusCodes: [429] },
  });
  await assert.rejects(() =>
    cb.execute(() => Promise.reject(Object.assign(new Error("429"), { status: 429 }))),
  );
  assert.equal(cb.state, "OPEN");
});

await test("plain Error without code is NOT countable", async () => {
  const cb = new CircuitBreaker("f5", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(new Error("plain"))));
  assert.equal(cb.state, "CLOSED");
});

await test("thrown non-Error values (string, null, undefined) are NOT countable", async () => {
  const cb = new CircuitBreaker("f6", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject("string")));
  assert.equal(cb.state, "CLOSED");
  await assert.rejects(() => cb.execute(() => Promise.reject(null)));
  assert.equal(cb.state, "CLOSED");
  await assert.rejects(() => cb.execute(() => Promise.reject(undefined)));
  assert.equal(cb.state, "CLOSED");
});

await test("ENETWORK not counted when networkErrors is false", async () => {
  const cb = new CircuitBreaker("f7", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: false },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED");
});

await test("multiple failure filters compose: only matching codes count", async () => {
  const cb = new CircuitBreaker("f8", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: false, timeouts: true },
  });
  // ENETWORK doesn't count
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED");
  // ETIMEOUT does count
  await assert.rejects(() => cb.execute(() => Promise.reject(timedOutErr())));
  assert.equal(cb.state, "OPEN");
});

// ============================================================================
// §5  CALLBACKS
// ============================================================================

suite("Callbacks");

await test("onOpen fires on failure threshold reached (sliding window)", async () => {
  let count = 0;
  const cb = new CircuitBreaker("cb1", {
    windowSize: 5,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
    onOpen: () => count++,
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 0); // not yet open
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 1); // open now
});

await test("onOpen fires on trip()", async () => {
  let fired = false;
  const cb = new CircuitBreaker("cb2", {
    onOpen: () => {
      fired = true;
    },
  });
  cb.trip();
  assert.equal(fired, true);
});

await test("onOpen fires on consecutive mode threshold reached", async () => {
  let count = 0;
  const cb = new CircuitBreaker("cb3", {
    windowSize: 0,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
    onOpen: () => count++,
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 0);
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 1);
});

await test("onOpen fires again when HALF_OPEN probe fails (re-opens)", async () => {
  let count = 0;
  const cb = new CircuitBreaker("cb4", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    failures: { networkErrors: true },
    onOpen: () => count++,
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 1);
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(count, 2);
});

await test("onClose fires on reset()", async () => {
  let fired = false;
  const cb = new CircuitBreaker("cb5", {
    onClose: () => {
      fired = true;
    },
  });
  cb.trip();
  cb.reset();
  assert.equal(fired, true);
});

await test("onClose fires when HALF_OPEN probe succeeds (circuit closes)", async () => {
  let closeCount = 0;
  const cb = new CircuitBreaker("cb6", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    successThreshold: 1,
    failures: { networkErrors: true },
    onClose: () => closeCount++,
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await new Promise((r) => setTimeout(r, 500));
  await cb.execute(async () => (await httpbin.get("/get")).status);
  assert.equal(closeCount, 1);
});

await test("onHalfOpen fires when OPEN transitions to HALF_OPEN", async () => {
  let fired = false;
  const cb = new CircuitBreaker("cb7", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    successThreshold: 1,
    failures: { networkErrors: true },
    onHalfOpen: () => {
      fired = true;
    },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await new Promise((r) => setTimeout(r, 500));
  await cb.execute(async () => (await httpbin.get("/get")).status);
  assert.equal(fired, true);
});

await test("onRejected fires when request rejected in OPEN state", async () => {
  let fired = false;
  const cb = new CircuitBreaker("cb8", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
    onRejected: () => {
      fired = true;
    },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.resolve(42)));
  assert.equal(fired, true);
});

await test("onRejected fires when probe rejected in HALF_OPEN (concurrency limit)", async () => {
  let rejectCount = 0;
  const cb = new CircuitBreaker("cb9", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 400,
    halfOpenConcurrency: 1,
    failures: { networkErrors: true },
    onRejected: () => rejectCount++,
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await new Promise((r) => setTimeout(r, 500));
  const slowProbe = cb.execute(async () => {
    await new Promise((r) => setTimeout(r, 800));
    return 42;
  });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(() => cb.execute(() => Promise.resolve(1)));
  assert.equal(rejectCount, 1);
  await slowProbe;
});

// ============================================================================
// §6  MANUAL TRIP / RESET
// ============================================================================

suite("Manual Trip / Reset");

await test("trip() transitions CLOSED → OPEN", async () => {
  const cb = new CircuitBreaker("m1");
  assert.equal(cb.state, "CLOSED");
  cb.trip();
  assert.equal(cb.state, "OPEN");
  assert.ok(cb.snapshot.openedAt !== null);
});

await test("trip() on already OPEN is a no-op", async () => {
  const cb = new CircuitBreaker("m2");
  cb.trip();
  const s1 = cb.snapshot;
  cb.trip();
  const s2 = cb.snapshot;
  assert.equal(s2.state, "OPEN");
  assert.equal(s2.openedAt, s1.openedAt); // timestamp unchanged
});

await test("reset() transitions any state → CLOSED and clears counters", async () => {
  const cb = new CircuitBreaker("m3");
  cb.trip();
  cb.reset();
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.failureCount, 0);
  assert.equal(cb.snapshot.openedAt, null);
  assert.equal(cb.snapshot.halfOpenAt, null);
});

// ============================================================================
// §7  REGISTRY
// ============================================================================

suite("CircuitBreakerRegistry");

await test("get creates breaker on first call, returns cached on second", async () => {
  const r = new CircuitBreakerRegistry();
  const a = r.get("https://httpbin.org");
  assert.ok(a instanceof CircuitBreaker);
  const b = r.get("https://httpbin.org");
  assert.equal(a, b);
});

await test("registry.execute makes real HTTP call via breaker", async () => {
  const r = new CircuitBreakerRegistry();
  const result = await r.execute(
    "https://httpbin.org",
    async () => (await httpbin.get("/get")).status,
  );
  assert.equal(result, 200);
});

await test("registry.execute rejects with CircuitOpenError when breaker is open", async () => {
  const r = new CircuitBreakerRegistry({
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => r.execute("https://httpbin.org", () => Promise.reject(netErr())));
  await assert.rejects(
    () => r.execute("https://httpbin.org", async () => (await httpbin.get("/get")).status),
    CircuitOpenError,
  );
});

await test("registry.trip and registry.reset control breaker state", async () => {
  const r = new CircuitBreakerRegistry();
  r.trip("https://httpbin.org");
  assert.equal(r.get("https://httpbin.org").state, "OPEN");
  r.reset("https://httpbin.org");
  assert.equal(r.get("https://httpbin.org").state, "CLOSED");
});

await test("registry.snapshots returns state for all registered breakers", async () => {
  const r = new CircuitBreakerRegistry();
  await r.execute("https://httpbin.org", async () => (await httpbin.get("/get")).status);
  const snaps = r.snapshots();
  assert.ok(snaps["https://httpbin.org"]);
  assert.equal(snaps["https://httpbin.org"].totalSuccesses, 1);
});

await test("registry.size, delete, clear", async () => {
  const r = new CircuitBreakerRegistry();
  r.get("a");
  r.get("b");
  r.get("c");
  assert.equal(r.size, 3);
  r.delete("a");
  assert.equal(r.size, 2);
  r.clear();
  assert.equal(r.size, 0);
});

// ============================================================================
// §8  FACTORY FUNCTIONS
// ============================================================================

suite("Factory Functions");

await test("createCircuitBreaker returns CircuitBreaker", async () => {
  const cb = createCircuitBreaker("factory", { failureThreshold: 10 });
  assert.ok(cb instanceof CircuitBreaker);
  assert.equal(cb.snapshot.state, "CLOSED");
});

await test("createCircuitBreakerRegistry returns CircuitBreakerRegistry", async () => {
  const r = createCircuitBreakerRegistry({ failureThreshold: 3 });
  assert.ok(r instanceof CircuitBreakerRegistry);
});

// ============================================================================
// §9  INTEGRATION (REAL HTTP + CIRCUIT BREAKER)
// ============================================================================

suite("Integration (Real HTTP + Circuit Breaker)");

await test("healthy endpoint keeps circuit CLOSED over many requests", async () => {
  const cb = new CircuitBreaker("i1", {
    windowSize: 5,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  for (let i = 0; i < 5; i++) {
    await cb.execute(async () => (await httpbin.get("/get")).status);
  }
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.totalRequests, 5);
  assert.equal(cb.snapshot.totalSuccesses, 5);
  assert.equal(cb.snapshot.totalFailures, 0);
});

await test("real HTTP call with circuit breaker via kinetex client", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableCircuitBreaker({ windowSize: 5, failureThreshold: 5, resetTimeoutMs: 30000 });
  const r = await client.get("/get");
  assert.equal(r.status, 200);
  const snaps = client.circuitSnapshots;
  assert.ok(Object.values(snaps).some((s: any) => s.totalSuccesses >= 1));
});

await test("tripCircuit and resetCircuit through kinetex client", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org" });
  client.enableCircuitBreaker();
  client.tripCircuit("https://httpbin.org");
  const before = client.circuitSnapshots["https://httpbin.org"];
  assert.equal(before?.state, "OPEN");
  client.resetCircuit("https://httpbin.org");
  const after = client.circuitSnapshots["https://httpbin.org"];
  assert.equal(after?.state, "CLOSED");
});

// ============================================================================
// §10  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CIRCUIT BREAKER TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
