/**
 * kinetex — concurrency limiter (bulkhead).
 *
 * The rate limiter releases its token at dispatch, so `rateLimit: 100` per
 * minute still permits 100 simultaneous sockets. This bounds requests *in
 * flight* instead. Everything below is about the permit accounting: a leaked
 * permit permanently shrinks the pool, and an over-eager release lets the
 * client exceed the very limit it was configured with.
 *
 * Tests are grouped as strict (the documented contract), regression (failures
 * that were live at some point), and edge (the boundaries).
 */

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ConcurrencyLimiter, ConcurrencyLimitError } from "../src/interceptors.ts";
import { Kinetex } from "../src/client.ts";
import { KinetexError } from "../src/types.ts";

let passed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await withTimeout(Promise.resolve().then(fn), 10_000, name);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
  }
}

function suite(name: string): void {
  console.log("\n── " + name);
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`test "${name}" timed out after ${ms}ms`)), ms);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Yield to the event loop enough for queued microtasks to run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── Strict: the documented contract ─────────────────────────────────────────

suite("ConcurrencyLimiter — strict");

await test("never exceeds maxConcurrent", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 3 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      await limiter.acquire();
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      limiter.release();
    }),
  );
  assert.equal(peak, 3, `peak concurrency was ${peak}, must cap at 3`);
  assert.equal(limiter.highWaterMark, 3);
});

await test("acquire resolves immediately when a permit is free", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });
  await limiter.acquire();
  await limiter.acquire();
  assert.equal(limiter.inFlight, 2);
  assert.equal(limiter.waiting, 0);
});

await test("a saturated limiter queues rather than rejecting by default", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  let released = false;
  const queued = limiter.acquire().then(() => {
    released = true;
  });
  await tick();
  assert.equal(released, false, "must not resolve while saturated");
  assert.equal(limiter.waiting, 1);
  limiter.release();
  await queued;
  assert.equal(released, true);
});

await test("rejects when queueing is disabled", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, queue: false });
  await limiter.acquire();
  await assert.rejects(
    () => limiter.acquire(),
    (err: unknown) => {
      assert.ok(err instanceof ConcurrencyLimitError);
      assert.equal((err as { code: string }).code, "ECONCURRENCY");
      assert.match(err.message, /queueing is disabled/);
      return true;
    },
  );
});

await test("rejects when the queue is full", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 2 });
  await limiter.acquire();
  const a = limiter.acquire();
  const b = limiter.acquire();
  await tick();
  assert.equal(limiter.waiting, 2);
  await assert.rejects(
    () => limiter.acquire(),
    (err: unknown) => {
      assert.ok(err instanceof ConcurrencyLimitError);
      assert.match(err.message, /queue is full/);
      return true;
    },
  );
  limiter.release();
  await a;
  limiter.release();
  await b;
});

await test("defaults match the documented values", async () => {
  const limiter = new ConcurrencyLimiter();
  assert.equal(limiter.inFlight, 0);
  // Default maxConcurrent is 10, so an 11th acquire must queue.
  const ten = Array.from({ length: 10 }, () => limiter.acquire());
  assert.equal(limiter.inFlight, 10);
  assert.equal(limiter.waiting, 0);
  let eleventhRan = false;
  const eleventh = limiter.acquire().then(() => {
    eleventhRan = true;
  });
  await tick();
  // The original test stopped here, so a default of 11 — or of 1 — both passed:
  // it only ever counted the ten it had itself requested.
  assert.equal(limiter.waiting, 1, "the 11th acquire must queue against a default of 10");
  assert.equal(eleventhRan, false, "the 11th must not resolve while ten are held");
  limiter.release();
  await eleventh;
  assert.equal(eleventhRan, true, "releasing promotes the queued 11th");
  assert.equal(limiter.waiting, 0);
  for (let i = 0; i < 10; i++) limiter.release();
  assert.equal(limiter.inFlight, 0, "every permit is returned");
  assert.equal(limiter.highWaterMark, 10, "the peak is the documented default, exactly");
  return Promise.all(ten);
});

await test("rejects a non-positive or non-finite maxConcurrent", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new ConcurrencyLimiter({ maxConcurrent: bad }),
      // The message names the field and the offending value: this config
      // arrives from `kinetex({ concurrencyLimit })`, so a caller reading only
      // the message has nothing else to go on.
      (err: unknown) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${String(err)}`);
        assert.match(
          (err as Error).message,
          /concurrencyLimit\.maxConcurrent must be a finite number >= 1/,
        );
        assert.ok(
          (err as Error).message.includes(String(bad)),
          `the message must name the offending value, got ${JSON.stringify((err as Error).message)}`,
        );
        return true;
      },
      `maxConcurrent=${String(bad)} must throw`,
    );
  }
});

await test("drain rejects everyone still queued", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  const a = limiter.acquire();
  const b = limiter.acquire();
  await tick();
  limiter.drain();
  await assert.rejects(() => a, ConcurrencyLimitError);
  await assert.rejects(() => b, ConcurrencyLimitError);
  assert.equal(limiter.waiting, 0);
});

// ── Abort contract ─────────────────────────────────────────────────────
//
// `acquire()`'s JSDoc promises a rejection "with code EABORT" when the signal
// fires while queued, and every other abort path in the library raises
// `KinetexError(..., "EABORT")`. The implementation used to reject with a bare
// `new Error("Concurrency acquire aborted")`, which has no `code` and no
// `isAbort` — so a caller following the documented contract
// (`if (err.code === "EABORT")`) silently fell through to its generic error
// branch, and an abort became indistinguishable from a queue overflow.

await test("regression: aborting while queued rejects with code EABORT", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const held = limiter.acquire();
  const ac = new AbortController();
  const queued = limiter.acquire(ac.signal);
  await tick();
  ac.abort();

  await assert.rejects(
    () => queued,
    (err: unknown) => {
      assert.ok(
        err instanceof KinetexError,
        `an abort must surface as a KinetexError, got ${String(err)}`,
      );
      assert.equal((err as KinetexError).code, "EABORT");
      assert.equal((err as KinetexError).isAbort, true);
      assert.equal((err as KinetexError).name, "KinetexError");
      return true;
    },
  );

  // The aborted waiter must not have consumed a permit: the queue is empty and
  // the single held permit is still the only one outstanding.
  assert.equal(limiter.waiting, 0, "the aborted waiter must be removed from the queue");
  await held;
  assert.equal(limiter.active, 1, "the aborted waiter must not have taken a permit");
  limiter.release();
  assert.equal(limiter.active, 0, "releasing the held permit must return to idle");
  assert.equal(limiter.highWaterMark, 1, "the aborted acquire must not raise the peak");
});

await test("regression: an already-aborted signal rejects with code EABORT", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 3 });
  const held = limiter.acquire();
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () => limiter.acquire(ac.signal),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected KinetexError, got ${String(err)}`);
      assert.equal((err as KinetexError).code, "EABORT");
      assert.equal((err as KinetexError).isAbort, true);
      return true;
    },
  );
  // Never enqueued, so the queue is untouched.
  assert.equal(limiter.waiting, 0, "an already-aborted acquire must not enqueue");
  await held;
});

await test("regression: an abort is distinguishable from a queue overflow", async () => {
  // The two failures must be told apart by code: a caller that retries on
  // EABORT must not also retry on a saturated queue.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
  const held = limiter.acquire();
  // Fill the single queue slot, so the next acquire overflows.
  const queued = limiter.acquire();
  assert.equal(limiter.waiting, 1, "the second acquire must queue, not reject");

  const overflow = await limiter
    .acquire()
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(
    overflow instanceof ConcurrencyLimitError,
    `overflow must reject with ConcurrencyLimitError, got ${String(overflow)}`,
  );
  assert.equal((overflow as unknown as { code: string }).code, "ECONCURRENCY");
  assert.notEqual(
    (overflow as unknown as { code: string }).code,
    "EABORT",
    "a saturated queue is not an abort",
  );

  limiter.release();
  await held;
  await queued;
  limiter.release();
});

await test("drain accepts a custom reason", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  const a = limiter.acquire();
  await tick();
  const reason = new Error("shutting down");
  limiter.drain(reason);
  await assert.rejects(
    () => a,
    (err: unknown) => {
      assert.equal(err, reason);
      return true;
    },
  );
});

// ── Regression: each of these was a live defect ────────────────────────────

suite("ConcurrencyLimiter — regression");

await test("regression: release hands the permit over without overshooting", async () => {
  // The naive implementation decrements `active` and then promotes a waiter,
  // which momentarily reports active === 0 and lets a newcomer jump the queue.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });
  await limiter.acquire();
  await limiter.acquire();
  const queued = limiter.acquire();
  await tick();
  assert.equal(limiter.inFlight, 2, "saturated");

  limiter.release();
  assert.equal(limiter.inFlight, 2, "permit must transfer, not free up");
  await queued;

  // A newcomer arriving in the same tick must still queue.
  let newcomerRan = false;
  const newcomer = limiter.acquire().then(() => {
    newcomerRan = true;
  });
  await tick();
  assert.equal(newcomerRan, false, "newcomer must not bypass the queue");
  limiter.release();
  await newcomer;
});

await test("regression: aborting while queued consumes no permit", async () => {
  // A waiter that aborts must remove itself; if it instead resolved later it
  // would take a permit nobody releases, permanently shrinking the pool.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  const ac = new AbortController();
  const queued = limiter.acquire(ac.signal);
  await tick();
  assert.equal(limiter.waiting, 1);
  ac.abort();
  await assert.rejects(() => queued);
  assert.equal(limiter.waiting, 0, "aborted waiter must leave the queue");

  limiter.release();
  assert.equal(limiter.inFlight, 0);
  // The pool must still be fully usable afterwards.
  await limiter.acquire();
  assert.equal(limiter.inFlight, 1);
});

await test("regression: an already-aborted signal never enqueues", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => limiter.acquire(ac.signal));
  assert.equal(limiter.waiting, 0);
  assert.equal(limiter.inFlight, 1, "must not have consumed a permit");
});

await test("regression: release with nothing held is a no-op", async () => {
  // Without this guard, a double-release drives `active` negative and the
  // limiter silently admits more than maxConcurrent forever after.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  limiter.release();
  limiter.release();
  assert.equal(limiter.inFlight, 0);
  await limiter.acquire();
  assert.equal(limiter.inFlight, 1);
  limiter.release();
  limiter.release();
  assert.equal(limiter.inFlight, 0, "must never go negative");
});

await test("regression: an aborted waiter does not fire after promotion", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  await limiter.acquire();
  const ac = new AbortController();
  const queued = limiter.acquire(ac.signal);
  await tick();
  // Release promotes the waiter; the abort listener must be detached first,
  // or the later abort() would reject an already-settled promise path.
  limiter.release();
  await queued;
  ac.abort(); // must be a no-op now
  await tick();
  assert.equal(limiter.inFlight, 1);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

suite("ConcurrencyLimiter — edge cases");

await test("edge: maxConcurrent of 1 serialises completely", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  const order: number[] = [];
  await Promise.all(
    [0, 1, 2].map(async (i) => {
      await limiter.acquire();
      order.push(i);
      await tick();
      limiter.release();
    }),
  );
  assert.deepEqual(order, [0, 1, 2], "FIFO order must be preserved");
});

await test("edge: a large burst drains completely", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 4, maxQueue: 500 });
  let done = 0;
  await Promise.all(
    Array.from({ length: 200 }, async () => {
      await limiter.acquire();
      done++;
      limiter.release();
    }),
  );
  assert.equal(done, 200);
  assert.equal(limiter.inFlight, 0);
  assert.equal(limiter.waiting, 0);
  // Exactly 4, not `<= 4`: 200 requests over a 4-permit pool must saturate it,
  // and a limiter that handed out zero permits at a time — while still
  // completing every request — would pass a `<=` bound.
  assert.equal(limiter.highWaterMark, 4, "the pool must actually saturate");
});

await test("edge: maxQueue of 0 rejects the first overflow", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0 });
  await limiter.acquire();
  await assert.rejects(() => limiter.acquire(), ConcurrencyLimitError);
});

await test("edge: numeric-string maxConcurrent is rejected, not coerced", async () => {
  assert.throws(
    () => new ConcurrencyLimiter({ maxConcurrent: "4" as unknown as number }),
    RangeError,
  );
});

await test("edge: highWaterMark tracks the true peak across bursts", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 5 });
  for (let i = 0; i < 5; i++) await limiter.acquire();
  for (let i = 0; i < 5; i++) limiter.release();
  await limiter.acquire();
  assert.equal(limiter.highWaterMark, 5);
  limiter.release();
});

// ── Abort-listener lifetime ─────────────────────────────────────────────────
//
// A caller-supplied AbortSignal normally outlives a single request, so the
// limiter must actively detach its `{ once: true }` listener when a queued
// waiter is resolved or drained. Nulling the handler is not the same thing:
// the closure stays reachable from the signal and leaks.

suite("ConcurrencyLimiter — abort listener detachment");

await test("strict: release() detaches the queued waiter's abort listener", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 4 });
  const ac = new AbortController();
  assert.equal(getEventListeners(ac.signal, "abort").length, 0, "clean signal");

  await limiter.acquire(); // saturate
  const queued = limiter.acquire(ac.signal);

  assert.equal(getEventListeners(ac.signal, "abort").length, 1, "one listener while queued");

  limiter.release(); // hands the permit to the queued waiter
  await queued;
  limiter.release();

  assert.equal(
    getEventListeners(ac.signal, "abort").length,
    0,
    "listener must not outlive the resolved waiter",
  );
});

await test("strict: drain() detaches the abort listener of every waiter", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 8 });
  const signals = Array.from({ length: 5 }, () => new AbortController());

  await limiter.acquire(); // saturate
  const queued = signals.map((c) => limiter.acquire(c.signal));
  for (const c of signals) {
    assert.equal(getEventListeners(c.signal, "abort").length, 1);
  }

  limiter.drain();

  await assert.rejects(() => queued[0]!, ConcurrencyLimitError);
  for (const p of queued.slice(1)) await assert.rejects(() => p, ConcurrencyLimitError);

  for (const c of signals) {
    assert.equal(
      getEventListeners(c.signal, "abort").length,
      0,
      "drain must detach, not merely neutralise",
    );
  }
  assert.equal(limiter.waiting, 0, "queue is emptied");
});

await test("regression: a post-grant abort leaves the granted permit intact", async () => {
  // A stale listener is harmless to the promise (it already resolved, so the
  // late `reject` is a no-op) but still pins the waiter and its signal in
  // memory. This pins the behaviour that matters: aborting *after* the permit
  // was transferred must not turn a granted acquire into a failure, and must
  // not leave the permit double-counted.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 4 });
  const ac = new AbortController();

  await limiter.acquire();
  const granted = limiter.acquire(ac.signal);
  limiter.release();

  ac.abort(); // fires after the permit was transferred

  await granted; // must resolve, not reject
  assert.equal(limiter.inFlight, 1, "the permit is genuinely held");
  limiter.release();
  assert.equal(limiter.inFlight, 0);
});

await test("edge: a signal reused across many queued requests accumulates nothing", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 50 });
  const ac = new AbortController();

  for (let i = 0; i < 20; i++) {
    await limiter.acquire();
    const queued = limiter.acquire(ac.signal);
    limiter.release();
    await queued;
    limiter.release();
    assert.equal(
      getEventListeners(ac.signal, "abort").length,
      0,
      `round ${i} must leave the signal untouched`,
    );
  }
});

await test("edge: a waiter aborted while queued detaches itself too", async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 4 });
  const ac = new AbortController();

  await limiter.acquire();
  const queued = limiter.acquire(ac.signal);
  assert.equal(limiter.waiting, 1);

  ac.abort();
  await assert.rejects(() => queued, /aborted/i);

  assert.equal(limiter.waiting, 0, "an aborted waiter leaves the queue");
  assert.equal(
    getEventListeners(ac.signal, "abort").length,
    0,
    "`once: true` consumed the listener, so none may linger",
  );

  limiter.release();
  assert.equal(limiter.inFlight, 0, "the saturated permit is returned");
});

await test("edge: drain() on an empty queue is a no-op", () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });
  limiter.drain();
  assert.equal(limiter.waiting, 0);
  assert.equal(limiter.inFlight, 0);
});

// ── Client integration ─────────────────────────────────────────────────────

suite("Kinetex + concurrencyLimit");

/**
 * In-flight requests observed at the transport boundary.
 *
 * The client blocks loopback URLs in `isSafeURL` (an SSRF gate that is
 * deliberately not weakened for tests), so these use an injected `fetch`
 * rather than a real server. The limiter sits directly above the transport, so
 * concurrency at the `fetch` boundary is exactly what it bounds — and a real
 * socket would only add TLS and kernel scheduling noise to the same number.
 */
interface Probe {
  concurrent: number;
  peak: number;
  hits: number;
  /** Set to make the next call reject. */
  failNext: boolean;
}

function makeFetch(probe: Probe, holdMs: number): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    probe.hits++;
    probe.concurrent++;
    probe.peak = Math.max(probe.peak, probe.concurrent);
    try {
      await new Promise((r) => setTimeout(r, holdMs));
      if (probe.failNext) {
        probe.failNext = false;
        throw new Error("synthetic transport failure");
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    } finally {
      probe.concurrent--;
    }
  }) as typeof globalThis.fetch;
}

const newProbe = (): Probe => ({ concurrent: 0, peak: 0, hits: 0, failNext: false });

await test("client caps real in-flight requests at maxConcurrent", async () => {
  const probe = newProbe();
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: makeFetch(probe, 30),
    concurrencyLimit: { maxConcurrent: 3, maxQueue: 50 },
  });
  try {
    await Promise.all(Array.from({ length: 12 }, () => client.get("/x", { retry: false })));
    assert.equal(probe.peak, 3, `transport saw ${probe.peak} concurrent, cap was 3`);
    assert.equal(probe.hits, 12);
  } finally {
    client.destroy();
  }
});

await test("client releases the permit when a request fails", async () => {
  // A leaked permit permanently shrinks the pool, so a failure must still
  // return its permit — otherwise the client deadlocks after maxConcurrent
  // errors.
  const probe = newProbe();
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: makeFetch(probe, 0),
    concurrencyLimit: { maxConcurrent: 1 },
  });
  try {
    probe.failNext = true;
    // `retry: false` is per-request only — a client-level `false` is spread
    // into the retry config and silently ignored, which would let the request
    // retry and succeed, hiding the permit accounting under test.
    await assert.rejects(
      () => client.get("/boom", { retry: false }),
      // A bare `assert.rejects(fn)` is satisfied by any rejection at all —
      // including one from a bug in the limiter itself, which is the half of
      // this test that matters.
      (err: unknown) => {
        assert.ok(err instanceof KinetexError, `expected KinetexError, got ${String(err)}`);
        assert.equal((err as KinetexError).code, "ENETWORK");
        assert.equal((err as KinetexError).message, "synthetic transport failure");
        return true;
      },
    );
    // The pool must be whole again.
    await client.get("/ok");
    await client.get("/ok");
    assert.equal(probe.hits, 3);
  } finally {
    client.destroy();
  }
});

await test("client releases the permit across a retry storm", async () => {
  const probe = newProbe();
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: makeFetch(probe, 0),
    concurrencyLimit: { maxConcurrent: 2 },
    retry: { maxRetries: 2, baseDelayMs: 1, statuses: [503], methods: ["GET"] },
  });
  try {
    // Six requests against a cap of two, each allowed to retry.
    await Promise.all(Array.from({ length: 6 }, () => client.get("/x")));
    assert.equal(probe.hits, 6);
    // Exactly 2, not `<= 2`: a limiter that serialised the whole storm would
    // complete all six requests and satisfy the upper bound while never
    // letting two run together.
    assert.equal(probe.peak, 2, `transport saw ${probe.peak} concurrent, cap was 2`);
  } finally {
    client.destroy();
  }
});

await test("client without concurrencyLimit is unaffected", async () => {
  const probe = newProbe();
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: makeFetch(probe, 30),
  });
  try {
    await Promise.all(Array.from({ length: 8 }, () => client.get("/x")));
    // Exactly 8: an unconfigured client dispatches all eight at once, so a
    // stray cap of 7 — or a serialising regression — is now visible.
    assert.equal(probe.peak, 8, `an unconfigured client dispatched ${probe.peak} at once`);
    assert.equal(probe.hits, 8);
  } finally {
    client.destroy();
  }
});

await test("client.destroy() drains waiters so shutdown cannot hang", async () => {
  const probe = newProbe();
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: makeFetch(probe, 400),
    concurrencyLimit: { maxConcurrent: 1, maxQueue: 20 },
  });
  try {
    const inflight = Array.from({ length: 10 }, () => client.get("/x").catch(() => "err"));
    await tick();
    const startedAt = Date.now();
    client.destroy();
    const settled = await withTimeout(Promise.all(inflight), 5_000, "settle after destroy");
    const elapsed = Date.now() - startedAt;

    // `settled.length` was the whole assertion, and `.catch(() => "err")`
    // means it is 10 for any ten settled promises — including a `destroy()`
    // that did nothing at all, since 10 x 400ms of serial work is 4s and the
    // budget was 5s. What has to hold is that the nine *queued* callers were
    // rejected rather than served.
    const rejected = settled.filter((r) => r === "err").length;
    const served = settled.length - rejected;
    assert.equal(rejected, 9, `the drain must reject all 9 queued callers, rejected ${rejected}`);
    assert.equal(served, 1, "only the request already holding the permit completes");
    assert.equal(probe.hits, 1, "a drained waiter must never reach the transport");
    assert.ok(elapsed < 1_500, `drain settled in ${elapsed}ms; a no-op destroy would take ~4000ms`);
  } finally {
    client.destroy();
  }
});

// ── Regressions: the three defects this round found ─────────────────────────
//
// All three lived in the same function, and all three are about `acquire()`
// answering differently depending on how busy the pool happened to be: the
// already-aborted check sat below the fast path, so an idle pool granted the
// permit and dropped the abort, and a saturated pool with queueing off or the
// queue full reported the abort as a queue overflow. The fourth is that
// `maxQueue` was never validated, so `NaN` made the cap fail open.

suite("Regressions (concurrency round)");

await test("regression: an already-aborted signal is refused on an idle limiter", async () => {
  // Every other already-aborted test in this file saturates the limiter first,
  // so they all take the enqueue path — the fast path, which is the one a real
  // request almost always takes, was untested.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 4 });
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () => limiter.acquire(ac.signal),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected KinetexError, got ${String(err)}`);
      assert.equal((err as KinetexError).code, "EABORT");
      assert.equal((err as KinetexError).isAbort, true);
      return true;
    },
  );
  assert.equal(limiter.inFlight, 0, "no permit may be taken for a refused acquire");
  assert.equal(limiter.highWaterMark, 0, "and the peak must not move");
  // The pool is untouched, so the next caller is served immediately.
  await limiter.acquire();
  assert.equal(limiter.inFlight, 1);
  limiter.release();
});

await test("regression: the same call gives the same answer on every path", async () => {
  // The contract is `EABORT`. Measured before the fix: EABORT only when the
  // limiter was saturated *and* queueing was on; ECONCURRENCY when queueing
  // was off or the queue was full; and a resolved promise when a permit was
  // free. A caller branching on `err.code === "EABORT"` therefore saw a
  // cancelled request reported as a capacity failure — and a policy that
  // retries on ECONCURRENCY would retry a request the caller had cancelled.
  const cases: Array<{ label: string; build: () => ConcurrencyLimiter }> = [
    {
      label: "idle pool",
      build: () => new ConcurrencyLimiter({ maxConcurrent: 4 }),
    },
    {
      label: "saturated, queueing on",
      build: () => new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 4 }),
    },
    {
      label: "saturated, queueing off",
      build: () => new ConcurrencyLimiter({ maxConcurrent: 1, queue: false }),
    },
    {
      label: "saturated, queue full",
      build: () => new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0 }),
    },
  ];

  for (const { label, build } of cases) {
    const limiter = build();
    await limiter.acquire(); // saturate, except for the idle case which now holds 1 of 4
    const ac = new AbortController();
    ac.abort();

    const err = await limiter.acquire(ac.signal).then(
      () => null,
      (e: unknown) => e as KinetexError,
    );
    assert.ok(err !== null, `${label}: an aborted acquire must never resolve`);
    assert.equal(
      (err as KinetexError).code,
      "EABORT",
      `${label}: an abort must not be reported as a queue overflow`,
    );
    assert.equal((err as KinetexError).isAbort, true, `${label}: isAbort must be set`);
    limiter.release();
  }
});

await test("regression: a non-finite or negative maxQueue is refused at construction", async () => {
  // The cap is tested as `waiters.length >= maxQueue`. `NaN` makes every
  // comparison false, so the queue stopped bounding anything at all: each
  // request parked a waiter holding its promise, signal and closures, and
  // nothing was ever rejected. `maxConcurrent` was validated; this was not.
  for (const bad of [Number.NaN, -1, -Number.POSITIVE_INFINITY, 0.5, 2.5]) {
    assert.throws(
      () => new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: bad }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${String(err)}`);
        assert.match(
          (err as Error).message,
          /concurrencyLimit\.maxQueue must be a non-negative integer or Infinity/,
        );
        assert.ok(
          (err as Error).message.includes(String(bad)),
          `the message must name the offending value, got ${JSON.stringify((err as Error).message)}`,
        );
        return true;
      },
      `maxQueue=${String(bad)} must throw`,
    );
  }

  // `Infinity` is the documented unbounded queue and must keep working.
  const unbounded = new ConcurrencyLimiter({
    maxConcurrent: 1,
    maxQueue: Number.POSITIVE_INFINITY,
  });
  await unbounded.acquire();
  const waiters = Array.from({ length: 25 }, () => unbounded.acquire());
  await tick();
  assert.equal(unbounded.waiting, 25, "Infinity means unbounded, and must not reject");
  // Each of these 25 releases hands its permit to a waiter rather than
  // decrementing, so `inFlight` holds at 1 for the whole promotion run.
  for (let i = 0; i < 25; i++) unbounded.release();
  await Promise.all(waiters);
  assert.equal(unbounded.waiting, 0, "every waiter was promoted");
  assert.equal(unbounded.inFlight, 1, "a transfer does not create a permit");
  unbounded.release();
  assert.equal(unbounded.inFlight, 0, "the last release returns the pool to idle");
});

await test("regression: a refused maxQueue never leaves a waiter behind", async () => {
  // The construction-time check is the one that matters, but a limiter built
  // with a valid cap and then overflowed must still be exactly as empty as it
  // was — a rejection that enqueued first would leak a permit on release.
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 2 });
  await limiter.acquire();
  const a = limiter.acquire();
  const b = limiter.acquire();
  await tick();
  assert.equal(limiter.waiting, 2);

  await assert.rejects(
    () => limiter.acquire(),
    (err: unknown) => {
      assert.ok(err instanceof ConcurrencyLimitError, `got ${String(err)}`);
      assert.equal((err as { code: string }).code, "ECONCURRENCY");
      return true;
    },
  );
  assert.equal(limiter.waiting, 2, "a rejected acquire must not join the queue");
  assert.equal(limiter.inFlight, 1);

  // Three permits were taken — the original, `a` and `b` — so it takes three
  // releases: the first two hand the permit over without decrementing.
  limiter.release();
  await a;
  limiter.release();
  await b;
  assert.equal(limiter.inFlight, 1, "the permit transfers rather than being recreated");
  limiter.release();
  assert.equal(limiter.inFlight, 0, "every permit is returned");
  assert.equal(limiter.waiting, 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err);
  }
  process.exit(1);
}
