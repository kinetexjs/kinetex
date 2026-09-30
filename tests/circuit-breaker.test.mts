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

/** A call that always succeeds. Several tests used a live httpbin request
 *  purely to obtain a success, which made them slow and network-flaky while
 *  adding nothing the breaker could observe. */
const succeed =
  (value: unknown = 200) =>
  (): Promise<unknown> =>
    Promise.resolve(value);

/** A call that always fails with a countable ENETWORK error. */
const failNet = (): Promise<never> => Promise.reject(netErr());

/** Run `ms` of real time. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capture console.warn for the duration of `fn`. */
async function withWarnings<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

// ============================================================================
// §1  STATE MACHINE
// ============================================================================

suite("State Machine");

await test("initial state is CLOSED with a fully zeroed snapshot", async () => {
  const cb = new CircuitBreaker("x");
  assert.equal(cb.state, "CLOSED");
  // Every field, not just the state: a snapshot that reported a plausible
  // non-zero totalRequests or a null-instead-of-0 count passed the old check.
  assert.deepEqual(cb.snapshot, {
    state: "CLOSED",
    failureCount: 0,
    successCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    halfOpenAt: null,
    totalRequests: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    totalRejected: 0,
    inFlightProbes: 0,
  });
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
  assert.equal(cb.snapshot.failureCount, 2, "both failures must be in the window");
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN"); // 3 >= 3
  const s = cb.snapshot;
  assert.equal(s.failureCount, 3);
  assert.equal(s.totalRequests, 3);
  assert.equal(s.totalFailures, 3);
  assert.equal(s.totalSuccesses, 0);
  assert.equal(s.totalRejected, 0, "nothing has been rejected yet");
  assert.ok(s.openedAt !== null, "opening must stamp the time");
  assert.ok(s.lastFailureAt !== null);
  assert.equal(s.lastSuccessAt, null, "no success has happened");
  assert.ok(s.openedAt >= s.lastFailureAt, "openedAt is the last failure");
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
  assert.ok(err instanceof CircuitOpenError, `got ${err?.constructor?.name}`);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "CircuitOpenError");
  assert.equal(err.code, "ECIRCUITOPEN");
  assert.equal(err.message, 'Circuit breaker OPEN for "s2" — request rejected');
  // The key must appear: with one breaker per origin, the message is often the
  // only place the operator learns which dependency is down.
  assert.ok(err.message.includes('"s2"'), "the message must name the breaker key");
  assert.equal(err.state.state, "OPEN");
  assert.equal(err.state.totalRejected, 1);
  assert.equal(err.state.totalRequests, 1, "a rejection is not a request attempt");
  // The snapshot is a copy, not a live view.
  err.state.totalRejected = 999;
  assert.equal(cb.snapshot.totalRejected, 1, "the snapshot must be detached");
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
  await wait(500);

  // The old test only checked that `halfOpenAt` was non-null *somewhere*
  // afterwards, and held an unused `const original = cb.snapshot`. The state
  // the probe actually ran in was never observed.
  let seenState: string | null = null;
  let halfOpenAt: number | null = null;
  let sawProbeSlot = false;
  const result = await cb.execute(async () => {
    seenState = cb.snapshot.state;
    halfOpenAt = cb.snapshot.halfOpenAt;
    sawProbeSlot = cb.snapshot.inFlightProbes === 1;
    return 200;
  });
  assert.equal(result, 200);
  assert.equal(seenState, "HALF_OPEN", "the probe must have run in HALF_OPEN");
  assert.equal(sawProbeSlot, true, "the probe must have held the single probe slot");
  assert.ok(halfOpenAt !== null, "Half-open timestamp should be set");
  assert.ok(
    halfOpenAt >= cb.snapshot.openedAt,
    "halfOpenAt must not precede the moment the circuit opened",
  );
  assert.equal(cb.state, "CLOSED", "successThreshold 1 closes on the first success");
  assert.equal(cb.snapshot.successCount, 0, "closing clears the success run");
  assert.equal(cb.snapshot.inFlightProbes, 0, "the probe slot must be released");
  assert.equal(cb.snapshot.totalSuccesses, 1);
  assert.equal(cb.snapshot.totalRequests, 2, "the failed attempt and the probe");
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
  await wait(500);
  // Start slow probe in HALF_OPEN
  const slowProbe = cb.execute(async () => {
    await new Promise((r) => setTimeout(r, 800));
    return 42;
  });
  await wait(50);
  assert.equal(cb.snapshot.inFlightProbes, 1, "the slow probe holds the only slot");
  // Second attempt should be rejected (concurrency limit)
  const err = await cb.execute(() => Promise.resolve(1)).catch((e) => e);
  assert.ok(err instanceof CircuitOpenError, "Second probe should be rejected");
  // The circuit is not OPEN — it is HALF_OPEN and simply busy. The old
  // assertion accepted any CircuitOpenError, so a rejection from the wrong
  // branch looked the same.
  assert.equal(err.state.state, "HALF_OPEN", "rejected for the slot, not because OPEN");
  assert.equal(
    err.message,
    'Circuit breaker HALF_OPEN for "s5" — request rejected',
    "the message must not claim OPEN while the circuit is half-open",
  );
  assert.equal(cb.snapshot.totalRejected, 1);
  assert.equal(
    cb.snapshot.totalRequests,
    2,
    "the failed attempt and the slow probe are attempts; the rejected one is not",
  );
  await slowProbe;
  assert.equal(
    cb.snapshot.inFlightProbes,
    0,
    "the slot must be released when the probe settles, or it is lost for the rest of the window",
  );
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
  assert.equal(cb.snapshot.failureCount, 1);
  await cb.execute(succeed()); // success resets
  assert.equal(
    cb.snapshot.failureCount,
    0,
    "in consecutive mode a single success must clear the run",
  );
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED"); // counter was reset, only 1 consecutive now
  assert.equal(cb.snapshot.failureCount, 1);
  assert.equal(cb.snapshot.totalFailures, 2, "lifetime failures are not reset");
  assert.equal(cb.snapshot.totalSuccesses, 1);
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
  // `windowSize: 3` with `failureThreshold: 5` was an unreachable
  // configuration: the window holds at most 3 results, so the count could
  // never reach 5 and the circuit could not open. The breaker now widens the
  // window to the threshold, so this test has to use a reachable pair to say
  // anything about sliding at all.
  const cb = new CircuitBreaker("w1", {
    windowSize: 3,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 2, "two failures resident");
  await cb.execute(succeed());
  assert.equal(
    cb.snapshot.failureCount,
    2,
    "a success does not evict a failure that is still inside the window",
  );
  await cb.execute(succeed());
  assert.equal(
    cb.snapshot.failureCount,
    1,
    "the oldest failure shifts out once the window is full",
  );
  await cb.execute(succeed());
  assert.equal(cb.snapshot.failureCount, 0, "window is [success, success, success]");
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.totalFailures, 2, "but lifetime failures are not forgotten");
  assert.equal(cb.snapshot.totalSuccesses, 3);
});

await test("window shift on failure: old failures shift out when window fills", async () => {
  // Saturation and eviction, with a window that can actually hold the
  // threshold. A window smaller than the threshold is no longer expressible —
  // see the regression block — because it made the threshold unreachable.
  const cb = new CircuitBreaker("w2", {
    windowSize: 3,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  const F = () => assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  const S = () => cb.execute(succeed());
  await F();
  await F();
  assert.equal(cb.snapshot.failureCount, 2, "window is [F, F]");
  assert.equal(cb.state, "CLOSED", "two is below the threshold of three");

  // A success is a result too: it occupies a slot but evicts nothing yet.
  await S();
  assert.equal(cb.snapshot.failureCount, 2, "window is [F, F, S] — full, nothing evicted");

  // The next call evicts the oldest. A failure arrives, so the count holds at
  // 2 rather than rising: the window is bounded, not a running total.
  await F();
  assert.equal(cb.snapshot.failureCount, 2, "window is [F, S, F]");
  assert.equal(cb.state, "CLOSED");

  // A success evicts the older of the two remaining failures.
  await S();
  assert.equal(cb.snapshot.failureCount, 1, "window is [S, F, S]");
  await S();
  assert.equal(cb.snapshot.failureCount, 1, "window is [F, S, S] — the failure survives");
  await S();
  assert.equal(cb.snapshot.failureCount, 0, "window is [S, S, S]");
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.totalFailures, 3, "lifetime failures are not the window");

  // A window filled entirely with failures does open the circuit.
  await F();
  await F();
  await F();
  assert.equal(cb.snapshot.failureCount, 3, "window is [F, F, F]");
  assert.equal(cb.state, "OPEN", "three failures in a window of three opens it");

  // And the eviction is real: successes push the failures back out.
  cb.reset();
  const cb2 = new CircuitBreaker("w2b", {
    windowSize: 3,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(() => cb2.execute(() => Promise.reject(netErr())));
  for (let i = 0; i < 3; i++) await cb2.execute(succeed());
  assert.equal(cb2.snapshot.failureCount, 0, "three successes evict all three slots");
  assert.equal(cb2.state, "CLOSED");
  assert.equal(cb2.snapshot.totalFailures, 2, "but the lifetime count remembers");
  assert.equal(cb2.snapshot.totalSuccesses, 3);
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

  // The filter is a 5xx test, not a "has a status" test: a 404 is a healthy
  // answer from a healthy server and must never trip the breaker.
  for (const status of [200, 201, 301, 400, 401, 403, 404, 429, 499]) {
    const c = new CircuitBreaker("f3b", {
      windowSize: 5,
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      failures: { serverErrors: true },
    });
    await assert.rejects(() =>
      c.execute(() => Promise.reject(Object.assign(new Error(String(status)), { status }))),
    );
    assert.equal(c.state, "CLOSED", `${status} is not a server error`);
    assert.equal(c.snapshot.totalFailures, 0);
  }

  // And it defaults to off: serverErrors is false unless asked for.
  const off = new CircuitBreaker("f3c", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() =>
    off.execute(() => Promise.reject(Object.assign(new Error("500"), { status: 500 }))),
  );
  assert.equal(off.state, "CLOSED", "serverErrors defaults to false");
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

  // Membership only — a neighbouring status must not be swept in.
  for (const status of [428, 430, 500]) {
    const c = new CircuitBreaker("f4b", {
      windowSize: 5,
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      failures: { statusCodes: [429] },
    });
    await assert.rejects(() =>
      c.execute(() => Promise.reject(Object.assign(new Error(String(status)), { status }))),
    );
    assert.equal(c.state, "CLOSED", `${status} is not in the list`);
  }

  // Several codes, and it composes with serverErrors.
  const multi = new CircuitBreaker("f4c", {
    windowSize: 5,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { statusCodes: [429, 503], serverErrors: true },
  });
  await assert.rejects(() =>
    multi.execute(() => Promise.reject(Object.assign(new Error("429"), { status: 429 }))),
  );
  assert.equal(multi.state, "CLOSED", "one of two");
  await assert.rejects(() =>
    multi.execute(() => Promise.reject(Object.assign(new Error("503"), { status: 503 }))),
  );
  assert.equal(multi.state, "OPEN", "and the second opens it");
});

await test("plain Error without code is NOT countable", async () => {
  const cb = new CircuitBreaker("f5", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  // `assert.rejects` resolves to undefined, so catch explicitly: the point is
  // that the caller's own error comes back, not one the breaker substituted.
  const err = await cb.execute(() => Promise.reject(new Error("plain"))).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.message, "plain", "the original error must propagate unchanged");
  assert.equal(err.code, undefined, "and must not be tagged as a network failure");
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.failureCount, 0, "an app-level error is not an outage");
  assert.equal(cb.snapshot.totalFailures, 0);
  // ...but it WAS an attempt. The source documents that totalRequests is never
  // decremented for non-countable failures; nothing checked that.
  assert.equal(cb.snapshot.totalRequests, 1, "a non-countable failure is still a request");
  assert.equal(cb.snapshot.totalSuccesses, 0);
  assert.equal(cb.snapshot.lastFailureAt, null, "and it must not be stamped as a failure");
});

await test("thrown non-Error values (string, null, undefined) are NOT countable", async () => {
  const cb = new CircuitBreaker("f6", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  for (const thrown of ["string", null, undefined, 42, { code: "ENETWORK" }]) {
    const cb = new CircuitBreaker("f6", {
      windowSize: 5,
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      failures: { networkErrors: true },
    });
    // The bare object carries the matching code but is not an Error, so
    // `instanceof Error` rejects it. A caller that throws a plain object was
    // never counted as an outage.
    await assert.rejects(() => cb.execute(() => Promise.reject(thrown)));
    assert.equal(cb.state, "CLOSED", `${JSON.stringify(thrown) ?? "undefined"} must not count`);
    assert.equal(cb.snapshot.totalFailures, 0);
    assert.equal(cb.snapshot.totalRequests, 1);
  }
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

await test("onOpen fires on trip() and receives the OPEN snapshot", async () => {
  let fired = false;
  let seen: { state: string; openedAt: number | null } | null = null;
  const cb = new CircuitBreaker("cb2", {
    onOpen: (state) => {
      fired = true;
      seen = state;
    },
  });
  cb.trip();
  assert.equal(fired, true);
  // The callback's argument is the whole point — a monitoring hook that cannot
  // see the state it fired for is of no use. The old flag-only check passed
  // even if onOpen were called with undefined.
  assert.ok(seen !== null, "onOpen must receive a state snapshot");
  assert.equal((seen as unknown as { state: string }).state, "OPEN");
  assert.ok(
    (seen as unknown as { openedAt: number | null }).openedAt !== null,
    "openedAt must already be stamped when onOpen runs",
  );
  // `snapshot` builds a new object per read, so compare by value: the values
  // must match what a caller reading the breaker immediately afterwards sees.
  assert.deepEqual(seen, cb.snapshot, "the snapshot is taken at the moment of opening");
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

await test("onClose fires on reset() with a CLOSED snapshot", async () => {
  let fired = false;
  let seen: string | null = null;
  let calls = 0;
  const cb = new CircuitBreaker("cb5", {
    onClose: (state) => {
      fired = true;
      calls++;
      seen = state.state;
    },
  });
  cb.trip();
  cb.reset();
  assert.equal(fired, true);
  assert.equal(seen, "CLOSED", "the state must already be CLOSED when onClose runs");
  assert.equal(calls, 1, "exactly one close");
  // Resetting a closed breaker is a legitimate no-op, but re-firing the
  // callback would make a "circuit recovered" alert fire on every admin ping.
  cb.reset();
  assert.equal(calls, 2, "each reset notifies");
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

await test("onRejected fires once per rejection in OPEN state", async () => {
  let calls = 0;
  const seen: string[] = [];
  const cb = new CircuitBreaker("cb8", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
    onRejected: (state) => {
      calls++;
      seen.push(state.state);
    },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(calls, 0, "the failure that opened it is not a rejection");
  await assert.rejects(() => cb.execute(() => Promise.resolve(42)));
  assert.equal(calls, 1);
  await assert.rejects(() => cb.execute(() => Promise.resolve(43)));
  assert.equal(calls, 2, "every rejected caller is counted");
  assert.deepEqual(seen, ["OPEN", "OPEN"]);
  assert.equal(cb.snapshot.totalRejected, 2);
  // A rejection must not be recorded as a failure or a request.
  assert.equal(cb.snapshot.totalFailures, 1);
  assert.equal(cb.snapshot.totalRequests, 1);
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

await test("reset() transitions any state → CLOSED and clears the window state", async () => {
  const cb = new CircuitBreaker("m3", {
    windowSize: 3,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  for (let i = 0; i < 3; i++)
    await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
  const before = cb.snapshot;
  assert.equal(before.failureCount, 3);
  assert.ok(before.totalFailures > 0);

  cb.reset();
  assert.equal(cb.state, "CLOSED");
  const after = cb.snapshot;
  assert.equal(after.failureCount, 0, "the window must be empty, or the circuit re-opens at once");
  assert.equal(after.openedAt, null);
  assert.equal(after.halfOpenAt, null);
  assert.equal(after.successCount, 0);
  assert.equal(after.inFlightProbes, 0);
  // The old test name claimed reset "clears counters"; it does not, and that
  // is correct — these are documented as lifetime totals. Nothing asserted it.
  assert.equal(after.totalFailures, before.totalFailures, "lifetime counters survive a reset");
  assert.equal(after.totalRequests, before.totalRequests);
  assert.equal(after.totalSuccesses, before.totalSuccesses);
  assert.equal(after.totalRejected, before.totalRejected);
  // And the cleared window really is empty: three more failures must be
  // needed to re-open, not zero.
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED", "the old failures must not still be in the window");
  assert.equal(cb.snapshot.failureCount, 2);
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
});

await test("trip() during HALF_OPEN holds the circuit open past the probe", async () => {
  // An operator tripping the breaker for a maintenance window must not have a
  // probe that was already in flight quietly close it again.
  const cb = new CircuitBreaker("m4", {
    windowSize: 5,
    failureThreshold: 1,
    // 300 ms: long enough that the initial open → half-open transition happens
    // during the test's setup wait, short enough that the window trip() opens
    // has not elapsed by the time the 60 ms probe settles.
    resetTimeoutMs: 300,
    successThreshold: 5,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await wait(400);
  assert.equal(cb.state, "HALF_OPEN", "the reset window has elapsed");
  const probe = cb.execute(async () => {
    await wait(60);
    return 200;
  });
  assert.equal(cb.state, "HALF_OPEN", "the probe is running");
  assert.equal(cb.snapshot.successCount, 0);
  cb.trip();
  assert.equal(cb.state, "OPEN", "trip() must win over the in-flight probe");
  await probe;
  assert.equal(
    cb.state,
    "OPEN",
    "a successful probe must not close a circuit an operator tripped by hand",
  );
  assert.equal(cb.snapshot.successCount, 0, "the success was not credited to the half-open run");
  // And the circuit is genuinely closed off: the next caller is rejected.
  const err = await cb.execute(succeed()).catch((e) => e);
  assert.ok(err instanceof CircuitOpenError, "requests must be rejected after a manual trip");
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
  await r.execute("a", succeed());
  await r.execute("b", succeed());
  await r.execute("b", succeed());
  const snaps = r.snapshots();
  // A truthy check on one key proved neither that the other was included nor
  // that the counts were per-key rather than shared.
  assert.deepEqual(Object.keys(snaps).sort(), ["a", "b"]);
  assert.equal(snaps.a.totalSuccesses, 1);
  assert.equal(snaps.b.totalSuccesses, 2, "counters are per-key");
  assert.equal(snaps.a.state, "CLOSED");
  assert.deepEqual(
    Object.keys(snaps.a).sort(),
    [
      "failureCount",
      "halfOpenAt",
      "inFlightProbes",
      "lastFailureAt",
      "lastSuccessAt",
      "openedAt",
      "state",
      "successCount",
      "totalFailures",
      "totalRejected",
      "totalRequests",
      "totalSuccesses",
    ],
    "a monitoring payload needs a stable, complete shape",
  );
});

await test("registry isolates breakers per key", async () => {
  // The entire point of a registry: one dead origin must not take the others
  // down with it.
  const r = new CircuitBreakerRegistry({
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => r.execute("dead", () => Promise.reject(netErr())));
  assert.equal(r.get("dead").state, "OPEN");
  assert.equal(r.get("healthy").state, "CLOSED", "a different origin is unaffected");
  const result = await r.execute("healthy", succeed("still here"));
  assert.equal(result, "still here", "and it still serves traffic");
  const snaps = r.snapshots();
  assert.equal(snaps.dead.state, "OPEN");
  assert.equal(snaps.healthy.state, "CLOSED");
  assert.equal(snaps.healthy.totalSuccesses, 1);
  assert.equal(r.size, 2);
});

await test("registry.get applies overrides only when the breaker is created", async () => {
  // A breaker holds live state, so re-creating it on a later get() with
  // different overrides would silently discard a tripped circuit. The
  // overrides are therefore creation-time only — which the docs have to say.
  const r = new CircuitBreakerRegistry({ failureThreshold: 5 });
  const first = r.get("k");
  const second = r.get("k", { failureThreshold: 1 });
  assert.equal(first, second, "the same instance is returned");
  await assert.rejects(() => second.execute(() => Promise.reject(netErr())));
  assert.equal(
    second.state,
    "CLOSED",
    "a later override cannot reach an existing breaker, or its state would be discarded",
  );
  // A fresh key does get its override.
  const fresh = r.get("fresh", { failureThreshold: 1 });
  await assert.rejects(() => fresh.execute(() => Promise.reject(netErr())));
  assert.equal(fresh.state, "OPEN", "overrides do apply at creation");
});

await test("registry.delete drops the breaker and its state", async () => {
  const r = new CircuitBreakerRegistry({
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => r.execute("k", () => Promise.reject(netErr())));
  assert.equal(r.get("k").state, "OPEN");
  r.delete("k");
  assert.equal(r.size, 0);
  assert.equal(r.snapshots().k, undefined, "the snapshot is gone too");
  // Re-getting must produce a fresh, closed breaker, not resurrect the tripped one.
  const recreated = r.get("k");
  assert.equal(recreated.state, "CLOSED");
  assert.equal(recreated.snapshot.totalFailures, 0, "counters start from zero again");
  assert.equal(r.size, 1);
  // Deleting a key that was never registered is a no-op.
  r.delete("never-existed");
  assert.equal(r.size, 1);
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

await test("createCircuitBreaker returns a configured CircuitBreaker", async () => {
  const cb = createCircuitBreaker("factory", {
    windowSize: 3,
    failureThreshold: 2,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  assert.ok(cb instanceof CircuitBreaker);
  assert.equal(cb.snapshot.state, "CLOSED");
  // `instanceof` is satisfied by a breaker that dropped the config entirely.
  for (let i = 0; i < 2; i++)
    await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN", "the factory must apply the configuration it was given");
  const err = await cb.execute(succeed()).catch((e) => e);
  assert.ok(err.message.includes('"factory"'), "the key must survive the factory");
});

await test("createCircuitBreakerRegistry applies its default config", async () => {
  const r = createCircuitBreakerRegistry({
    windowSize: 3,
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  assert.equal(r instanceof CircuitBreakerRegistry, true);
  // A breaker that ignored the inherited defaults would never open.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => r.execute("k", () => Promise.reject(netErr())));
  }
  assert.equal(r.get("k").state, "OPEN", "registry defaults must reach the breakers");
  // And a per-key override still applies at creation.
  const lenient = r.get("other", { failureThreshold: 99 });
  await assert.rejects(() => lenient.execute(() => Promise.reject(netErr())));
  assert.equal(lenient.state, "CLOSED");
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
  // `Object.values(snaps).some((s: any) => ...)` passed on any breaker
  // anywhere, and the `any` hid the fact that the key was never checked.
  const keys = Object.keys(snaps);
  assert.equal(keys.length, 1, `expected exactly one breaker, got ${keys.join(", ")}`);
  assert.equal(keys[0], "https://httpbin.org", "breakers are keyed by origin");
  const snap = snaps["https://httpbin.org"];
  assert.equal(snap.state, "CLOSED");
  assert.equal(snap.totalSuccesses, 1);
  assert.equal(snap.totalRequests, 1);
  assert.equal(snap.totalFailures, 0);
  assert.ok(snap.lastSuccessAt !== null);
  assert.equal(snap.openedAt, null);
});

await test("client circuit breaker is per-origin and isolated", async () => {
  // `circuitSnapshots` is keyed by origin, so one failing host must not take
  // the others down. Nothing checked that the keying was real.
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableCircuitBreaker({ windowSize: 5, failureThreshold: 5, resetTimeoutMs: 30000 });
  const r = await client.get("/get");
  assert.equal(r.status, 200);
  const snaps = client.circuitSnapshots;
  const keys = Object.keys(snaps);
  assert.ok(
    keys.every((k) => k.startsWith("https://")),
    `keys must be origins: ${keys.join(", ")}`,
  );
  assert.ok(keys.includes("https://httpbin.org"));
  // A breaker for an unrelated origin starts fresh when first used.
  client.tripCircuit("https://other.example.com");
  assert.equal(client.circuitSnapshots["https://other.example.com"].state, "OPEN");
  assert.equal(
    client.circuitSnapshots["https://httpbin.org"].state,
    "CLOSED",
    "tripping one origin must not affect another",
  );
});

await test("tripCircuit and resetCircuit through kinetex client", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org" });
  client.enableCircuitBreaker();
  client.tripCircuit("https://httpbin.org");
  const before = client.circuitSnapshots["https://httpbin.org"];
  // `before?.state` silently passed when the key was absent, turning a
  // missing breaker into a successful-looking assertion.
  assert.ok(before !== undefined, "tripping must create the breaker");
  assert.equal(before.state, "OPEN");
  assert.ok(before.openedAt !== null, "trip() must stamp openedAt");
  // While OPEN the client must not reach the network.
  const err = await client.get("/get").catch((e) => e);
  assert.ok(err instanceof CircuitOpenError, "an open circuit must reject the request");
  assert.equal(err.code, "ECIRCUITOPEN");
  assert.equal(err.message, 'Circuit breaker OPEN for "https://httpbin.org" — request rejected');
  assert.equal(client.circuitSnapshots["https://httpbin.org"].totalRejected, 1);

  client.resetCircuit("https://httpbin.org");
  const after = client.circuitSnapshots["https://httpbin.org"];
  assert.ok(after !== undefined);
  assert.equal(after.state, "CLOSED");
  assert.equal(after.openedAt, null, "reset must clear openedAt");
  // And the client works again.
  const recovered = await client.get("/get");
  assert.equal(recovered.status, 200, "a reset circuit must serve traffic again");
  assert.equal(client.circuitSnapshots["https://httpbin.org"].state, "CLOSED");
});

// ============================================================================
// §10  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
// ============================================================================
// §11  REGRESSION: REACHABLE THRESHOLDS, HONEST STATE, HONEST ERRORS
// ============================================================================

await test("regression: a single failed probe re-opens via the half-open branch alone", async () => {
  // The existing "failed probe re-opens" test used `windowSize: 5` with
  // `failureThreshold: 1`, so the sliding-window CLOSED branch re-opened the
  // circuit just as well — the half-open branch could be deleted entirely and
  // the test still passed. This configuration removes every other route to
  // OPEN: consecutive-count mode with a threshold of 5, and a circuit opened
  // by `trip()` rather than by accumulating failures, so no CLOSED-branch
  // count is anywhere near the threshold when the probe fails.
  const cb = new CircuitBreaker("rh", {
    windowSize: 0,
    failureThreshold: 5,
    resetTimeoutMs: 100,
    failures: { networkErrors: true },
  });
  cb.trip();
  assert.equal(cb.state, "OPEN");
  await wait(150);
  assert.equal(cb.state, "HALF_OPEN", "the reset window has elapsed");

  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(
    cb.state,
    "OPEN",
    "one failed probe must re-open immediately, regardless of the threshold",
  );
  // A full resetTimeoutMs must pass again before it probes once more, i.e. it
  // really re-entered OPEN rather than lingering in HALF_OPEN.
  assert.ok(cb.snapshot.openedAt !== null, "openedAt must be restamped on the re-open");
  const reopenedAt = cb.snapshot.openedAt;
  await wait(150);
  assert.equal(cb.state, "HALF_OPEN", "and the reset window restarts from the re-open");
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
  assert.ok(cb.snapshot.openedAt >= reopenedAt, "openedAt advances on each re-open");
});

suite("regression: window smaller than the threshold");

await test("regression: a window smaller than the threshold is widened, not ignored", async () => {
  // The window is a sliding buffer of the most recent `windowSize` results, so
  // it can hold at most `windowSize` failures. With `windowSize` below
  // `failureThreshold` the test `failures >= failureThreshold` can never be
  // true, and the circuit could not open — a breaker that silently does
  // nothing, with no error, no warning and no other symptom.
  // `{ windowSize: 2, failureThreshold: 5 }` stayed CLOSED through 50
  // consecutive failures. Two of this file's own tests were written around
  // exactly that configuration.
  const { result: cb, warnings } = await withWarnings(
    () =>
      new CircuitBreaker("r1", {
        windowSize: 2,
        failureThreshold: 5,
        resetTimeoutMs: 60000,
        failures: { networkErrors: true },
      }),
  );
  assert.equal(warnings.length, 1, "a silently-disabled breaker must at least warn");
  assert.match(warnings[0], /windowSize/);
  assert.match(warnings[0], /failureThreshold/);
  assert.match(warnings[0], /never (be reached|open)/);

  for (let i = 0; i < 50; i++)
    await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(
    cb.state,
    "OPEN",
    "fifty consecutive failures must open the circuit, whatever the window size",
  );
  assert.equal(cb.snapshot.failureCount, 5, "the window now holds the threshold");
});

await test("regression: the widened window still slides", async () => {
  const { result: cb } = await withWarnings(
    () =>
      new CircuitBreaker("r2", {
        windowSize: 1,
        failureThreshold: 4,
        resetTimeoutMs: 60000,
        failures: { networkErrors: true },
      }),
  );
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
  cb.reset();
  // After the widening, the window is 4 — a single success must not erase the
  // run, and the eviction must still be one-result-at-a-time.
  // The window is now 4, so the single failure survives two results.
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 1, "window is [F]");
  await cb.execute(succeed());
  assert.equal(cb.snapshot.failureCount, 1, "window is [F, S] — the failure survives");
  await cb.execute(succeed());
  assert.equal(cb.snapshot.failureCount, 1, "window is [F, S, S] — still inside");
  await cb.execute(succeed());
  assert.equal(cb.snapshot.failureCount, 1, "window is [F, S, S, S] — full, nothing evicted");
  await cb.execute(succeed());
  assert.equal(
    cb.snapshot.failureCount,
    0,
    "window is [S, S, S, S] — the failure is evicted, one result at a time",
  );
  // Eviction is one result per call, so it took four successes, not one. Before
  // the widening the window was 1 and a single success sufficed.
});

await test("regression: windowSize 0 consecutive mode is left alone", async () => {
  // 0 is the documented consecutive-count mode, not a too-small window, and
  // must not be "repaired" into a sliding window.
  const { result: cb, warnings } = await withWarnings(
    () =>
      new CircuitBreaker("r3", {
        windowSize: 0,
        failureThreshold: 3,
        resetTimeoutMs: 60000,
        failures: { networkErrors: true },
      }),
  );
  assert.equal(warnings.length, 0, "consecutive mode is a valid configuration, not a mistake");
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.snapshot.failureCount, 2);
  // A success clears the whole run in consecutive mode.
  await cb.execute(succeed());
  assert.equal(cb.snapshot.failureCount, 0);
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "CLOSED", "two is below three again");
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN");
});

suite("regression: the state getter must not go stale");

await test("regression: `state` reflects the elapsed reset window without traffic", async () => {
  // The OPEN → HALF_OPEN transition was evaluated only inside `execute()`.
  // A health endpoint or dashboard polling `state` therefore saw a stale OPEN
  // for as long as no request arrived, and could not tell a circuit that was
  // about to probe from one that had been down for an hour.
  const cb = new CircuitBreaker("r4", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 100,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  assert.equal(cb.state, "OPEN", "immediately after opening");
  assert.equal(cb.snapshot.state, "OPEN");
  await wait(150);
  assert.equal(
    cb.state,
    "HALF_OPEN",
    "the reset window has elapsed, so a reader must be told the circuit is probeable",
  );
  assert.equal(cb.snapshot.state, "HALF_OPEN", "the snapshot must agree with the getter");
  // Reading must not mutate: no callback fires, and the next request is the
  // thing that performs the transition.
  let halfOpenFired = 0;
  const observed = new CircuitBreaker("r5", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 100,
    failures: { networkErrors: true },
    onHalfOpen: () => halfOpenFired++,
  });
  await assert.rejects(() => observed.execute(() => Promise.reject(netErr())));
  await wait(150);
  for (let i = 0; i < 5; i++) observed.snapshot; // poll like a dashboard would
  assert.equal(observed.state, "HALF_OPEN");
  assert.equal(halfOpenFired, 0, "observing the state must not fire onHalfOpen");
  // The transition — and the callback — happen when traffic arrives.
  await observed.execute(succeed());
  assert.equal(halfOpenFired, 1, "onHalfOpen fires once, on the first request after the window");
});

await test("regression: a request after the window is admitted, and probes", async () => {
  const cb = new CircuitBreaker("r6", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 100,
    successThreshold: 1,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await wait(150);
  // Must NOT be rejected: the elapsed window makes the circuit probeable.
  const result = await cb.execute(succeed("probed"));
  assert.equal(result, "probed", "the probe must be admitted and its result returned");
  assert.equal(cb.state, "CLOSED");
  assert.equal(cb.snapshot.totalRejected, 0, "no caller was turned away while recovering");
});

suite("regression: the rejection message must tell the truth");

await test("regression: a half-open rejection does not claim the circuit is OPEN", async () => {
  // The half-open probe limit rejects callers too, and there
  // `state.state` is HALF_OPEN: the circuit is recovering, not open. The
  // message said "OPEN" regardless, pointing operators at the wrong problem
  // during exactly the window they were watching to see recovery.
  const cb = new CircuitBreaker("r7", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 100,
    halfOpenConcurrency: 1,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  await wait(150);
  const probe = cb.execute(async () => {
    await wait(120);
    return 200;
  });
  await wait(30);
  assert.equal(cb.state, "HALF_OPEN");
  const err = await cb.execute(succeed()).catch((e) => e);
  assert.ok(err instanceof CircuitOpenError);
  assert.equal(err.state.state, "HALF_OPEN", "the snapshot says HALF_OPEN");
  assert.equal(
    err.message,
    `Circuit breaker HALF_OPEN for "r7" — request rejected`,
    "so the message must say HALF_OPEN too",
  );
  assert.ok(
    err.message.startsWith("Circuit breaker HALF_OPEN "),
    "the state in the message must be the state in the snapshot",
  );
  await probe;
});

await test("regression: a genuinely open circuit still says OPEN", async () => {
  // The control for the message fix: only the half-open branch changes.
  const cb = new CircuitBreaker("r8", {
    windowSize: 5,
    failureThreshold: 1,
    resetTimeoutMs: 60000,
    failures: { networkErrors: true },
  });
  await assert.rejects(() => cb.execute(() => Promise.reject(netErr())));
  const err = await cb.execute(succeed()).catch((e) => e);
  assert.equal(err.state.state, "OPEN");
  assert.equal(err.message, `Circuit breaker OPEN for "r8" — request rejected`);
  assert.equal(err.name, "CircuitOpenError");
  assert.equal(err.code, "ECIRCUITOPEN");
  assert.ok(err instanceof Error, "must remain a real Error for `catch (e) { e.message }`");
});

console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CIRCUIT BREAKER TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
