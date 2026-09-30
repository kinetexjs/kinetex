import assert from "node:assert/strict";
import {
  collectStream,
  formatBytes,
  formatETA,
  formatProgress,
  formatRate,
  MultiPartProgressAggregator,
  ProgressTracker,
  streamWithProgress,
  throttleProgress,
  withDownloadProgress,
  withUploadProgress,
} from "../src/progress.ts";

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
    // Structural, not textual. `JSON.stringify` compared key ORDER, so the
    // same content in a different insertion order failed, and it could not
    // distinguish an absent key from one holding `undefined`.
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
  // `Object.is`, so NaN, -0 and +0 are told apart where it matters.
  if (!Object.is(a as unknown, b as unknown)) {
    throw new Error(`Expected ${JSON.stringify(b)} got ${JSON.stringify(a)}${suffix}`);
  }
}

function assertOk(val: unknown) {
  if (!val) throw new Error(`Expected truthy got ${String(val)}`);
}

/**
 * Assert that `fn` throws, and return the error.
 *
 * The previous `let threw = false` version accepted any throw at all, so a
 * `TypeError` from a typo in the code under test counted as the expected
 * validation error.
 */
function assertThrows(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("Expected the call to throw, but it returned normally");
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── ProgressTracker ──────────────────────────────────────────────────────

suite("ProgressTracker");

await test("update increments loaded and computes percent", async () => {
  const t = new ProgressTracker(1000);
  const s = t.update(250);
  // The whole snapshot, not three of its eight fields.
  assertEqual(Object.keys(s).sort(), [
    "done",
    "elapsed",
    "eta",
    "loaded",
    "percent",
    "rate",
    "total",
  ]);
  assertEqual(s.loaded, 250);
  assertEqual(s.total, 1000);
  assertEqual(s.percent, 25);
  assertEqual(s.done, false);
  // A rate exists the moment any time has passed, so the ETA does too — and
  // it must be finite and non-negative rather than Infinity.
  assertOk(Number.isFinite(s.eta), `a finite ETA, got ${s.eta}`);
  assertOk(s.eta >= 0, `a non-negative ETA, got ${s.eta}`);
  assertOk(Number.isFinite(s.rate) && s.rate >= 0, `a non-negative finite rate, got ${s.rate}`);
  assertOk(s.elapsed >= 0, `a non-negative elapsed, got ${s.elapsed}`);
  assertEqual(t.bytesLoaded, 250, "and the getter agrees");
  assertEqual(t.isDone, false);
  // snapshot() is a pure read: it must not change the running totals.
  const before = t.snapshot();
  const after = t.snapshot();
  assertEqual(after.loaded, before.loaded);
  assertEqual(t.bytesLoaded, 250);
});

await test("update multiple times accumulates", async () => {
  const t = new ProgressTracker(1000);
  t.update(100);
  t.update(200);
  const s = t.update(300);
  assertEqual(s.loaded, 600);
  assertEqual(s.percent, 60);
  // `typeof s.rate === "number"` is satisfied by NaN, by Infinity, and by a
  // negative rate. A rate is bytes per second: finite and non-negative, and
  // over 20 ms of work for 300 bytes it must actually be a plausible number.
  assertOk(Number.isFinite(s.rate), `a finite rate, got ${s.rate}`);
  assertOk(s.rate >= 0, `a non-negative rate, got ${s.rate}`);
  assertOk(s.rate > 0, `a positive rate after 600 bytes of work, got ${s.rate}`);
  assertEqual(t.bytesLoaded, 600);
});

await test("complete marks done and sets percent to 100", async () => {
  const t = new ProgressTracker(500);
  t.update(250);
  const s = t.complete();
  assertEqual(s.done, true);
  assertEqual(s.percent, 100);
  // Half the body arrived, and `complete()` still reports 100%. That is the
  // documented "the transfer is over" contract, and it is why `done` has to
  // be read alongside `percent` — recorded here because the two disagree and
  // a test that only checked `done` would not have noticed.
  assertEqual(s.loaded, 250);
  assertEqual(s.total, 500);
  assertEqual(s.eta, 0, "no remaining time once done");
  assertEqual(t.isDone, true);
  // ...and it stays done, even as more bytes are counted afterwards.
  const after = t.update(250);
  assertEqual(after.done, true);
  assertEqual(after.percent, 100);
  assertEqual(after.loaded, 500);
  assertEqual(t.bytesLoaded, 500);
});

await test("percent is clamped to [0, 100]", async () => {
  // The upper clamp was there; the lower one was not. A negative chunk — a
  // caller bug, or a Content-Length revised downward mid-transfer — put
  // `percent` below zero and every progress line rendered "(-50.0%)".
  const neg = new ProgressTracker(1000);
  assertEqual(neg.update(-500).percent, 0, "a negative chunk cannot go below zero");
  assertEqual(neg.bytesLoaded, -500, "the running total still reflects what was passed");
  // ...and it recovers, so the clamp is on the ratio and not on the counter.
  assertEqual(neg.update(600).percent, 10);
  // Overrunning the total clamps at the top.
  const over = new ProgressTracker(1000);
  over.update(100);
  assertEqual(over.update(2000).percent, 100);
  assertEqual(over.bytesLoaded, 2100, "the byte count is never clamped — only the ratio");
  // With no total there is no ratio to clamp.
  const unknown = new ProgressTracker(null);
  assertEqual(unknown.update(-10).percent, null);
  // A zero total is not a division by zero.
  const zero = new ProgressTracker(0);
  assertEqual(zero.update(100).percent, null);
  assertEqual(zero.update(0).percent, null);
  // A negative total is not a ratio either.
  assertEqual(new ProgressTracker(-100).update(50).percent, null);
});

await test("complete emits final snapshot via onProgress", async () => {
  let last: any = null;
  const t = new ProgressTracker(500, {
    onProgress: (s) => {
      last = s;
    },
  });
  t.update(100);
  t.complete();
  assertEqual(last.done, true);
  assertEqual(last.loaded, 100);
});

await test("null total yields null percent and ETA", async () => {
  const t = new ProgressTracker(null);
  t.update(100);
  const s = t.snapshot();
  assertEqual(s.percent, null);
  assertEqual(s.total, null);
});

await test("snapshot returns current state without side effects", async () => {
  const t = new ProgressTracker(1000);
  t.update(100);
  const s1 = t.snapshot();
  t.update(200);
  const s2 = t.snapshot();
  assertEqual(s1.loaded, 100);
  assertEqual(s2.loaded, 300);
});

await test("bytesLoaded getter", async () => {
  const t = new ProgressTracker(100);
  assertEqual(t.bytesLoaded, 0);
  t.update(33);
  assertEqual(t.bytesLoaded, 33);
});

await test("isDone getter", async () => {
  const t = new ProgressTracker(100);
  assertEqual(t.isDone, false);
  t.complete();
  assertEqual(t.isDone, true);
});

await test("throttle limits callbacks", async () => {
  let count = 0;
  const t = new ProgressTracker(10000, { throttleHz: 10, onProgress: () => count++ });
  // Rapid updates below minInterval should NOT trigger callback
  t.update(100);
  t.update(100);
  t.update(100);
  const afterUpdates = count;
  // complete bypasses throttle
  t.complete();
  // three updates inside one throttle window collapse to at most one callback
  assert.equal(
    afterUpdates <= 1,
    true,
    `throttle must collapse rapid updates, got ${afterUpdates}`,
  );
  assert.equal(count, afterUpdates + 1, "complete() must emit a final event");
});

await test("complete bypasses throttle", async () => {
  let last: any = null;
  const t = new ProgressTracker(1000, {
    throttleHz: 100,
    onProgress: (s) => {
      last = s;
    },
  });
  t.update(500);
  t.complete();
  assertEqual(last.done, true);
});

await test("ETA calculated when rate > 0 and total known", async () => {
  const t = new ProgressTracker(10000);
  t.update(100);
  await delay(50);
  t.update(200);
  const s = t.snapshot();
  assert.equal(s.loaded, 300);
  assert.equal(s.total, 10000);
  assert.equal(s.percent, 3);
  assert.equal(s.done, false);
  assert.equal(s.eta !== null && s.eta >= 0, true, `eta must be non-negative, got ${s.eta}`);
});

await test("zero total yields null percent", async () => {
  const t = new ProgressTracker(0);
  t.update(0);
  const s = t.snapshot();
  assertEqual(s.percent, null);
  assertEqual(s.total, 0);
});

await test("after complete eta is 0", async () => {
  const t = new ProgressTracker(1000);
  t.update(500);
  t.complete();
  assertEqual(t.snapshot().eta, 0);
});

await test("after complete percent is 100 when total known", async () => {
  const t = new ProgressTracker(1000);
  t.complete();
  assertEqual(t.snapshot().percent, 100);
});

await test("after complete percent is null when total null", async () => {
  const t = new ProgressTracker(null);
  t.complete();
  assertEqual(t.snapshot().percent, null);
});

await test("hasNext call in buildPage is eliminated", async () => {
  let nextCalls = 0;
  const t = new ProgressTracker(100);
  t.update(50);
  // internal _snapshot should not call anything external
  const s = t.snapshot();
  assertEqual(s.loaded, 50);
});

// ── formatBytes ──────────────────────────────────────────────────────────

suite("formatBytes");

await test("returns correct units", async () => {
  assertEqual(formatBytes(0), "0 B");
  assertEqual(formatBytes(1), "1 B");
  assertEqual(formatBytes(1023), "1023 B");
  assertEqual(formatBytes(1024), "1 KB");
  assertEqual(formatBytes(1536), "1.5 KB");
  assertEqual(formatBytes(1048576), "1 MB");
  assertEqual(formatBytes(1073741824), "1 GB");
});

await test("custom decimals", async () => {
  assertEqual(formatBytes(1234, 0), "1 KB");
  assertEqual(formatBytes(1234, 4), "1.2051 KB");
});

await test("regression: a sub-byte value never indexes past the unit table", async () => {
  // Math.log(0.5) / Math.log(1024) floors to -1, which indexed before UNITS
  // and rendered the scaled nonsense "512 undefined".
  assertEqual(formatBytes(0.5), "0.5 B");
  assertEqual(formatBytes(0.125), "0.13 B");
  assertEqual(formatBytes(0.999), "1 B");
  // Every unit boundary, in both directions. A guard that clamped only one
  // end of the index range passes the sub-byte cases and misses the rest.
  assertEqual(formatBytes(0), "0 B");
  assertEqual(formatBytes(1), "1 B");
  assertEqual(formatBytes(1023), "1023 B");
  assertEqual(formatBytes(1024), "1 KB");
  assertEqual(formatBytes(1024 ** 2), "1 MB");
  assertEqual(formatBytes(1024 ** 3), "1 GB");
  assertEqual(formatBytes(1024 ** 4), "1 TB");
  assertEqual(formatBytes(1.5), "1.5 B");
  assertEqual(formatBytes(1536), "1.5 KB");
  assertEqual(formatBytes(1234567), "1.18 MB");
  // `decimals` is a count, not a precision: a negative one is floored at 0
  // rather than reaching `toFixed`, and a fractional one is truncated.
  assertEqual(formatBytes(1234, 0), "1 KB");
  assertEqual(formatBytes(1234, 1), "1.2 KB");
  assertEqual(formatBytes(1234, 4), "1.2051 KB");
  assertEqual(formatBytes(1234, -1), "1 KB", "a negative decimal count floors at 0");
  assertEqual(formatBytes(1234, 2.9), "1.21 KB", "a fractional one is truncated, not rounded");
  assertEqual(formatBytes(1234, 0), formatBytes(1234, 0.5), "and 0.5 behaves as 0");
});

await test("regression: a sub-byte rate is not rendered as hundreds of an unknown unit", async () => {
  // A rate below 1 byte/s is ordinary on a slow link; this reached the
  // progress line verbatim.
  assertEqual(formatRate(0.5), "0.5 B/s");
  assert.ok(!formatRate(0.5).includes("undefined"));
  assert.ok(!formatRate(0.5).includes("NaN"));
});

await test("regression: negative byte counts keep their sign and a real unit", async () => {
  // Math.log(-1) is NaN -> UNITS[NaN] -> "NaN undefined".
  assertEqual(formatBytes(-1), "-1 B");
  assertEqual(formatBytes(-1024), "-1 KB");
  assertEqual(formatRate(-2048), "-2 KB/s");
});

await test("regression: non-finite byte counts do not produce NaN garbage", async () => {
  assertEqual(formatBytes(NaN), "NaN B");
  assertEqual(formatBytes(Infinity), "∞");
  assertEqual(formatBytes(-Infinity), "-∞");
  assert.ok(!formatRate(NaN).includes("undefined"));
});

await test("beyond the largest unit keeps the true magnitude", async () => {
  // Clamping the index alone used to report 1e15 bytes as "1 TB".
  assertEqual(formatBytes(1024 ** 5), "1024 TB");
  assert.ok(!formatBytes(1024 ** 5).includes("undefined"));
});

// ── formatRate ───────────────────────────────────────────────────────────

suite("formatRate");

await test("formats rate string", async () => {
  assertEqual(formatRate(0), "0 B/s");
  assertEqual(formatRate(1024), "1 KB/s");
  assertEqual(formatRate(1048576), "1 MB/s");
});

// ── formatETA ────────────────────────────────────────────────────────────

suite("formatETA");

await test("formats ETA durations", async () => {
  assertEqual(formatETA(0), "0s");
  assertEqual(formatETA(1000), "1s");
  assertEqual(formatETA(5000), "5s");
  assertEqual(formatETA(60000), "1m 0s");
  assertEqual(formatETA(61000), "1m 1s");
  assertEqual(formatETA(3600000), "1h 0m 0s");
  assertEqual(formatETA(3661000), "1h 1m 1s");
});

await test("handles Infinity and negative", async () => {
  // No estimate is not "0 seconds remaining" — an infinite ETA is shown as
  // such, and a negative one (which would mean the transfer is over) too.
  assertEqual(formatETA(Infinity), "∞");
  assertEqual(formatETA(-Infinity), "∞");
  assertEqual(formatETA(-1), "∞");
  assertEqual(formatETA(NaN), "∞");
});

await test("rounds to the nearest second, and every unit boundary", async () => {
  // The rounding boundary in each unit, which is where a wrong rounding mode
  // or a floor-instead-of-round shows up.
  assertEqual(formatETA(0), "0s");
  assertEqual(formatETA(1), "0s");
  assertEqual(formatETA(499), "0s");
  assertEqual(formatETA(500), "1s", "half a second rounds up, not down");
  assertEqual(formatETA(999), "1s");
  assertEqual(formatETA(1000), "1s");
  assertEqual(formatETA(59_499), "59s");
  assertEqual(formatETA(59_500), "1m 0s", "59.5s crosses into minutes");
  assertEqual(formatETA(59_000), "59s");
  assertEqual(formatETA(60_000), "1m 0s");
  assertEqual(formatETA(90_000), "1m 30s");
  assertEqual(formatETA(119_999), "2m 0s", "and 119.999s is two minutes");
  assertEqual(formatETA(3_599_000), "59m 59s");
  assertEqual(formatETA(3_600_000), "1h 0m 0s", "exactly an hour");
  assertEqual(formatETA(3_661_000), "1h 1m 1s");
  assertEqual(formatETA(86_400_000), "24h 0m 0s", "hours are not wrapped into days");
  assertEqual(formatETA(359_999_999), "100h 0m 0s", "and a very long ETA is not wrapped either");
  assertEqual(formatETA(3_600_000_000), "1000h 0m 0s", "however large it gets");
});

// ── formatProgress ───────────────────────────────────────────────────────

suite("formatProgress");

await test("with total", async () => {
  const t = new ProgressTracker(1000);
  t.update(456);
  const fp = formatProgress(t.snapshot());
  // Every component, in order. A regex with `.+` for the rate accepted any
  // rate string at all, including an empty one.
  assert.match(fp, /^456 B \/ 1000 B \(45\.6%\) @ [\d.]+ [KMGT]?B\/s ETA \d+s$/);
  // The rate is a real unit, not a bare number.
  assert.match(fp, /@ [\d.]+ [KMGT]?B\/s/, `a rate with a real unit in ${JSON.stringify(fp)}`);
  // ...and the four parts are individually right.
  assertEqual(fp.slice(0, 5), "456 B");
  assertOk(fp.includes(" / 1000 B"), "the total");
  assertOk(fp.includes("(45.6%)"), "the percentage to one decimal");
});

await test("without total", async () => {
  const t = new ProgressTracker(null);
  t.update(456);
  const fp = formatProgress(t.snapshot());
  // The whole string, not two substring checks: with no total there is no
  // ` / …`, no percentage, and no ETA (there is nothing to estimate against).
  assert.match(fp, /^456 B( @ [\d.]+ [KMGT]?B\/s)?$/);
  assertEqual(fp.includes(" / "), false, "no total");
  assertEqual(fp.includes("%"), false, "no percentage");
  assertEqual(fp.includes("ETA"), false, "no ETA");
});

await test("done snapshot", async () => {
  const t = new ProgressTracker(1000);
  t.update(1000);
  t.complete();
  const fp = formatProgress(t.snapshot());
  // Done drops the ETA, whatever the snapshot said.
  assertEqual(fp.includes("ETA"), false);
  assertOk(fp.includes("100.0%"));
  // 1000 is still under the 1024 boundary, so it is rendered as bytes.
  assertEqual(fp.slice(0, 4), "1000");
  // An ETA of 0 is *not* rendered — "ETA 0s" on a finished transfer is noise.
  assert.match(fp, /^1000 B \/ 1000 B \(100\.0%\)( @ [\d.]+ [KMGT]?B\/s)?$/);
});

await test("a zero rate is omitted rather than shown as 0 B/s", async () => {
  const fp = formatProgress({
    loaded: 0,
    total: 100,
    percent: 0,
    rate: 0,
    eta: null,
    elapsed: 0,
    done: false,
  });
  // No rate, no ETA (eta is null), and the percentage is still shown.
  assertEqual(fp, "0 B / 100 B (0.0%)");
});

await test("percent is never rendered outside [0, 100]", async () => {
  // The formatter prints whatever it is given; the tracker is what clamps.
  // Pin that the two compose: a tracker that emitted a negative percent would
  // put a "(-50.0%)" on the line.
  const t = new ProgressTracker(1000);
  t.update(-500);
  // The *byte count* legitimately keeps its sign — the value passed in was
  // negative — so the assertion is on the percentage, which must not go below
  // zero and become "(-50.0%)".
  assertEqual(t.snapshot().percent, 0);
  assertEqual(formatProgress(t.snapshot()).includes("(-"), false, "no negative percentage");
  const over = new ProgressTracker(1000);
  over.update(5000);
  assertEqual(over.snapshot().percent, 100, "and none above 100 either");
  assertEqual(formatProgress(over.snapshot()).includes("(100.0%)"), true);
  assertEqual(formatProgress(over.snapshot()).includes("500.0%"), false);
});

// ── throttleProgress ─────────────────────────────────────────────────────

suite("throttleProgress");

await test("throttleProgress emits the first call and every done snapshot", async () => {
  let count = 0;
  const fn = throttleProgress(() => count++, 0.1); // very low Hz → 10s window
  fn({ loaded: 100, total: 200, percent: 50, rate: 0, eta: null, elapsed: 100, done: false });
  // The first call is never throttled. It used to be: the baseline was 0 and
  // the gate is `now - last >= interval` against `performance.now()`, so for
  // the first 10 seconds of the process's life nothing was emitted at all.
  assertEqual(count, 1, "the first update is always delivered");
  // A second non-done call inside the window is dropped.
  fn({ loaded: 150, total: 200, percent: 75, rate: 0, eta: null, elapsed: 150, done: false });
  assertEqual(count, 1, "a repeat inside the window is throttled");
  // done=true always fires, throttle or not.
  fn({ loaded: 200, total: 200, percent: 100, rate: 0, eta: 0, elapsed: 200, done: true });
  assertEqual(count, 2, "the final snapshot is never throttled");
});

// ── withUploadProgress ───────────────────────────────────────────────────

suite("withUploadProgress");

await test("uploaded bytes are the bytes, in order", async () => {
  // The upload tests drained the wrapper and summed `byteLength`, which a
  // wrapper that emitted the right *count* of the wrong chunks would satisfy.
  const { stream, tracker } = withUploadProgress("hello world", 11);
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(new TextDecoder().decode(chunk as Uint8Array));
  }
  assertEqual(chunks.join(""), "hello world", "the body arrives intact and in order");
  assertEqual(tracker.bytesLoaded, 11, "and exactly 11 bytes were counted");
  assertEqual(tracker.snapshot().loaded, 11);
  assertEqual(tracker.snapshot().total, 11);
  assertEqual(tracker.snapshot().percent, 100);
  assertEqual(tracker.snapshot().done, true);
  // Multi-byte characters are counted in bytes, not characters.
  const uni = withUploadProgress("héllo", null);
  for await (const _c of uni.stream) {
    /* drain */
  }
  assertEqual(uni.tracker.bytesLoaded, 6, "é is two bytes in UTF-8");
});

await test("string body reads all bytes", async () => {
  const { stream, tracker } = withUploadProgress("hello", 5);
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assertEqual(total, 5);
  assertOk(tracker.isDone);
});

await test("Uint8Array body", async () => {
  const data = new TextEncoder().encode("test data");
  const { stream, tracker } = withUploadProgress(data, data.byteLength);
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assertEqual(total, 9);
  assertOk(tracker.isDone);
});

await test("null body creates empty stream", async () => {
  const { stream, tracker } = withUploadProgress(null, null);
  const reader = stream.getReader();
  const { done } = await reader.read();
  assertEqual(done, true);
  assertOk(tracker.isDone);
});

await test("ReadableStream body", async () => {
  const src = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const { stream, tracker } = withUploadProgress(src as any, 3);
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assertEqual(total, 3);
  assertOk(tracker.isDone);
});

await test("with abort signal already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const { stream } = withUploadProgress("test", 4, { signal: ac.signal });
  const reader = stream.getReader();
  let caught: unknown = null;
  try {
    await reader.read();
  } catch (e) {
    caught = e;
  }
  assert.equal((caught as Error | null)?.name, "AbortError");
  assert.equal((caught as Error | null)?.message, "Upload aborted");
});

await test("with abort signal during stream", async () => {
  const ac = new AbortController();
  const { stream, tracker } = withUploadProgress(
    new ReadableStream({
      async start(c) {
        for (let i = 0; i < 3; i++) {
          await delay(50);
          c.enqueue(new Uint8Array([i]));
        }
        c.close();
      },
    }),
    3,
    { signal: ac.signal },
  );
  const reader = stream.getReader();
  await reader.read(); // first chunk
  ac.abort();
  let caught: unknown = null;
  try {
    await reader.read();
  } catch (e) {
    caught = e;
  }
  assert.equal(caught !== null, true, "aborting mid-stream must reject the pending read");
  assert.equal((caught as Error).name, "AbortError");
});

await test("upload error marks tracker complete", async () => {
  // Create a source stream that errors on second chunk
  const errStream = new ReadableStream({
    async start(c) {
      c.enqueue(new Uint8Array([1]));
      await delay(10);
      c.error(new Error("source failed"));
    },
  });
  const { stream, tracker } = withUploadProgress(errStream, null);
  const reader = stream.getReader();
  const first = await reader.read();
  assertEqual(first.done, false);
  // `let threw = false; try {} catch { threw = true }` only proves that
  // *something* was thrown — a bug that rejected with the wrong error, or with
  // a plain string, passed just as readily.
  await assert.rejects(
    () => reader.read(),
    (err: unknown) => {
      assert.ok(err instanceof Error, "the wrapper must reject with an Error");
      return true;
    },
    "reading past a failed upload must reject",
  );
  assertOk(tracker.isDone);
});

// ── withDownloadProgress ─────────────────────────────────────────────────

suite("withDownloadProgress");

await test("intercepts response body", async () => {
  const res = new Response("hello world");
  const { response, tracker } = withDownloadProgress(res);
  const text = await response.text();
  assertEqual(text, "hello world");
  assertOk(tracker.isDone);
});

await test("null body marks complete immediately", async () => {
  const res = new Response(null);
  const { tracker } = withDownloadProgress(res);
  assert.equal(tracker.isDone, true);
});

await test("response with content-length", async () => {
  const body = JSON.stringify({ a: 1 });
  const res = new Response(body, { headers: { "content-length": String(body.length) } });
  const { response, tracker } = withDownloadProgress(res);
  await response.text();
  assertOk(tracker.isDone);
  assertEqual(tracker.snapshot().total, body.length);
});

await test("response without content-length has null total", async () => {
  const res = new Response("test", { headers: {} });
  const { response, tracker } = withDownloadProgress(res);
  await response.text();
  assertEqual(tracker.snapshot().total, null);
});

await test("abort during download triggers abort handler", async () => {
  const ac = new AbortController();
  // Stream that yields one chunk and doesn't close
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      await delay(500); // hang — simulates slow response
    },
  });
  const res = new Response(stream);
  const { response, tracker } = withDownloadProgress(res, { signal: ac.signal });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEqual(first.done, false);
  ac.abort();
  await assert.rejects(
    () => reader.read(),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an aborted download must reject with an Error");
      return true;
    },
    "an aborted download must reject rather than hang or resolve",
  );
});

await test("cancelling the wrapper cancels the source reader", async () => {
  // A consumer that stops early (or the size-limit path) cancels the wrapper
  // stream. The underlying reader must be cancelled too, or the socket keeps
  // streaming a body nobody is reading.
  let sourceCancelled: unknown = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("chunk-1"));
    },
    cancel(reason) {
      sourceCancelled = reason;
    },
  });
  const { response, tracker } = withDownloadProgress(
    new Response(stream, { headers: { "content-length": "1000" } }),
    {},
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEqual(first.done, false);

  await reader.cancel("no-longer-needed");

  assertEqual(sourceCancelled, "no-longer-needed");
  // A cancelled download is not a completed one.
  assertEqual(tracker.isDone, false);
});

await test("an already-aborted signal errors the stream on first read", async () => {
  // The pre-flight check in start(): a signal that is already aborted must fail
  // the stream immediately rather than reading the body at all.
  const ac = new AbortController();
  ac.abort();
  let pulled = false;
  const stream = new ReadableStream({
    pull() {
      pulled = true;
    },
  });
  void pulled;
  const { response } = withDownloadProgress(new Response(stream), { signal: ac.signal });
  const reader = response.body!.getReader();
  let name = "";
  let message = "";
  try {
    await reader.read();
  } catch (err: any) {
    name = err.name;
    message = err.message;
  }
  assertEqual(name, "AbortError");
  assertEqual(message, "Download aborted");
});

await test("a clean EOF completes the tracker and closes the stream", async () => {
  // The done branch of pull(): the tracker must be marked complete and the
  // wrapper closed, otherwise a completed download reports as unfinished.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("hello"));
      c.close();
    },
  });
  const { response, tracker } = withDownloadProgress(
    new Response(stream, { headers: { "content-length": "5" } }),
    {},
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEqual(first.done, false);
  const last = await reader.read();
  assertEqual(last.done, true);
  assertEqual(tracker.isDone, true);
  assertEqual(tracker.bytesLoaded, 5);
  assertEqual(tracker.snapshot().percent, 100);
});

await test("error during read is caught and tracker completes", async () => {
  // Stream that errors after first chunk
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(new Uint8Array([1]));
      await delay(10);
      c.error(new Error("stream error"));
    },
  });
  const res = new Response(stream);
  const { response, tracker } = withDownloadProgress(res);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assertEqual(first.done, false);
  await assert.rejects(
    () => reader.read(),
    (err: unknown) => {
      assert.ok(err instanceof Error, "a failed download must reject with an Error");
      return true;
    },
    "reading past a failed download must reject",
  );
  assertOk(tracker.isDone);
});

// ── streamWithProgress ───────────────────────────────────────────────────

suite("streamWithProgress");

await test("downloads are the bytes, in order, and counted once", async () => {
  const body = "the quick brown fox";
  const res = new Response(body, {
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
  });
  const { response, tracker } = withDownloadProgress(res);
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body!) chunks.push(chunk as Uint8Array);
  const joined = new TextDecoder().decode(concat(chunks));
  assertEqual(joined, body, "the body arrives intact and in order");
  assertEqual(tracker.bytesLoaded, body.length, "and every byte was counted exactly once");
  assertEqual(tracker.snapshot().total, body.length, "total came from content-length");
  assertEqual(tracker.snapshot().percent, 100);
  assertEqual(tracker.snapshot().done, true);
  // The reconstructed Response keeps what downstream code reads off it.
  assertEqual(response.status, 200);
  assertEqual(response.headers.get("content-length"), String(body.length));
  assertEqual(response.url, res.url, "url is preserved across the wrapper");
  assertEqual(response.redirected, res.redirected);
  assertEqual(response.type, res.type);
});

await test("yields chunks with progress", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  let chunks = 0,
    dataBytes = 0;
  for await (const { chunk, progress } of streamWithProgress(stream, 3)) {
    if (chunk.length > 0) {
      chunks++;
      dataBytes += chunk.length;
    }
    if (progress.done) assertEqual(chunk.length, 0); // final empty chunk
  }
  assertEqual(chunks, 1);
  assertEqual(dataBytes, 3);
});

await test("null total streams without percent", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([42]));
      c.close();
    },
  });
  for await (const { progress } of streamWithProgress(stream, null)) {
    assertEqual(progress.percent, null);
  }
});

await test("abort signal stops iteration", async () => {
  const ac = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      // Don't close — would hang unless aborted
    },
  });
  // Abort before iterating
  ac.abort();
  let caught: unknown = null;
  try {
    for await (const _ of streamWithProgress(stream, null, { signal: ac.signal })) {
    }
  } catch (e) {
    caught = e;
  }
  assert.equal((caught as Error | null)?.name, "AbortError");
  assert.equal((caught as Error | null)?.message, "Stream aborted");
});

// ── collectStream ────────────────────────────────────────────────────────

suite("collectStream");

await test("collects bytes and returns tracker", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("test"));
      c.close();
    },
  });
  const { data, tracker } = await collectStream(stream, 4);
  assertEqual(data.byteLength, 4);
  assertOk(tracker.isDone);
  assertEqual(tracker.snapshot().loaded, 4);
});

await test("null total", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("x"));
      c.close();
    },
  });
  const { tracker } = await collectStream(stream, null);
  assertEqual(tracker.snapshot().total, null);
});

await test("already aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  let caught: unknown = null;
  try {
    await collectStream(stream, 1, { signal: ac.signal });
  } catch (e) {
    caught = e;
  }
  assert.equal((caught as Error | null)?.name, "AbortError");
  assert.equal((caught as Error | null)?.message, "Stream aborted");
});

// ── MultiPartProgressAggregator ──────────────────────────────────────────

suite("MultiPartProgressAggregator");

await test("overall aggregates multiple part trackers", async () => {
  const agg = new MultiPartProgressAggregator(2);
  const t1 = agg.createPartTracker(0, 1000);
  const t2 = agg.createPartTracker(1, 2000);
  t1.update(500);
  t2.update(1000);
  const o = agg.getOverall();
  assertEqual(o.overall.loaded, 1500);
  assertEqual(o.overall.total, 3000);
  assertEqual(o.overall.percent, 50);
});

await test("overall done when all parts complete", async () => {
  const agg = new MultiPartProgressAggregator(2);
  const t1 = agg.createPartTracker(0, 500);
  const t2 = agg.createPartTracker(1, 500);
  t1.complete();
  assertEqual(agg.getOverall().overall.done, false);
  t2.complete();
  assertEqual(agg.getOverall().overall.done, true);
});

await test("getOverall before any parts created", async () => {
  const agg = new MultiPartProgressAggregator(2);
  const o = agg.getOverall();
  assertEqual(o.overall.loaded, 0);
  assertEqual(o.overall.done, false);
});

await test("createPartTracker triggers onOverall callback", async () => {
  let callCount = 0;
  const agg = new MultiPartProgressAggregator(2, () => {
    callCount++;
  });
  const t1 = agg.createPartTracker(0, 1000);
  t1.update(100);
  assert.equal(callCount, 1);
  const { parts, overall } = agg.getOverall();
  assert.equal(parts.length, 2);
  assert.equal(overall.loaded, 100);
  assert.equal(overall.percent, 10);
  assert.equal(overall.done, false);
});

await test("overall ETA null when rate is 0", async () => {
  const agg = new MultiPartProgressAggregator(1);
  agg.createPartTracker(0, 1000);
  const o = agg.getOverall();
  assertEqual(o.overall.eta, null);
});

// ── withBlobUploadProgress ───────────────────────────────────────────────

suite("withBlobUploadProgress");

await test("blob upload wraps blob stream", async () => {
  const { withBlobUploadProgress } = await import("../src/progress.ts");
  const blob = new Blob(["hello world"]);
  const { stream, tracker } = withBlobUploadProgress(blob);
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assertEqual(total, 11);
  assertOk(tracker.isDone);
});

// ── collectStream abort signal ───────────────────────────────────────────

suite("collectStream signal");

await test("collectStream rejects with AbortError when aborted mid-stream", async () => {
  const ac = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      // Don't close — reader will hang waiting for more
    },
  });
  // Aborting during reads used to resolve with `{ data: 3 bytes, isDone: true }`:
  // `reader.cancel()` resolves the pending read with `{ done: true }`, which is
  // indistinguishable from an ordinary end-of-stream, so the loop broke out
  // normally, completed the tracker and returned the truncated buffer as a
  // success. A caller collecting a 100-byte body got 3 bytes and no error.
  // The sibling `streamWithProgress` throws for the same event.
  const promise = collectStream(stream, 100, { signal: ac.signal });
  await delay(50);
  ac.abort();
  await assert.rejects(
    () => promise,
    (err: unknown) => {
      assert.ok(err instanceof Error, "an abort must surface as an Error");
      assert.equal((err as DOMException).name, "AbortError");
      assert.equal((err as Error).message, "Stream aborted");
      return true;
    },
    "an aborted collectStream must not resolve with partial data",
  );
  // The source must be left readable rather than permanently locked, so the
  // reader released on the way out.
  assert.equal(stream.locked, false, "the source reader was released");
});

await test("collectStream still resolves for a complete stream", async () => {
  // The counterpart, so the rejection above cannot be satisfied by simply
  // never resolving at all.
  const ac = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.enqueue(new Uint8Array([4, 5]));
      c.close();
    },
  });
  const { data, tracker } = await collectStream(stream, 5, { signal: ac.signal });
  assertEqual(Array.from(data), [1, 2, 3, 4, 5], "every byte, in order");
  assertOk(tracker.isDone);
});

// ── Regression: the two fixes ───────────────────────────────────────────

suite("regression: first emit, percent clamping");

await test("regression: the first progress event is never throttled away", async () => {
  // The throttle baseline was 0 and the gate is `now - last >= intervalMs`,
  // with `now` coming from `performance.now()` — time since *process* start.
  // So for the first interval of the process's life nothing was emitted at
  // all. Measured in a process 200 ms old: at 1 Hz, 5 Hz and 0.5 Hz alike, the
  // first update produced no callback. A transfer that starts early in a CLI
  // and finishes inside the first second reported nothing but the forced
  // snapshot from complete() — a progress bar that never moves, on the
  // feature whose whole purpose is to move.
  const seen: number[] = [];

  const t1 = new ProgressTracker(1000, { throttleHz: 1, onProgress: (s) => seen.push(s.loaded) });
  t1.update(10);
  assertEqual(seen.length, 1, "the first update is delivered");
  t1.update(10);
  assertEqual(seen.length, 1, "a repeat inside the window is throttled");

  for (const hz of [0.5, 5, 10, 100]) {
    const got: number[] = [];
    const t = new ProgressTracker(1000, { throttleHz: hz, onProgress: (s) => got.push(s.loaded) });
    t.update(1);
    assertEqual(got.length, 1, `throttleHz ${hz} must still deliver the first update`);
  }

  // A whole short transfer, at a throttle far below its own duration.
  const events: number[] = [];
  const t2 = new ProgressTracker(1000, {
    throttleHz: 0.5,
    onProgress: (s) => events.push(s.loaded),
  });
  for (let i = 0; i < 20; i++) t2.update(50);
  const final = t2.complete();
  assertEqual(final.loaded, 1000);
  assertEqual(events[0], 50, "progress was reported from the first chunk, not only at the end");
  assertEqual(events[events.length - 1], 1000, "and the final snapshot still arrives");
  assertEqual(t2.isDone, true);

  // `throttleProgress`, the standalone helper, had the identical flaw.
  let n = 0;
  const throttled = throttleProgress(() => n++, 0.1);
  throttled({ loaded: 1, total: null, percent: null, rate: 0, eta: null, elapsed: 0, done: false });
  assertEqual(n, 1, "the standalone helper delivers its first call too");
  throttled({ loaded: 2, total: null, percent: null, rate: 0, eta: null, elapsed: 1, done: false });
  assertEqual(n, 1, "and throttles the second");
  throttled({ loaded: 3, total: null, percent: null, rate: 0, eta: null, elapsed: 2, done: true });
  assertEqual(n, 2, "while done always passes");
  throttled({ loaded: 4, total: null, percent: null, rate: 0, eta: null, elapsed: 3, done: true });
  assertEqual(n, 3, "every time");

  // hz 0 means "no throttle" and must still deliver everything.
  let all = 0;
  const unthrottled = throttleProgress(() => all++, 0);
  for (let i = 0; i < 5; i++) {
    unthrottled({
      loaded: i,
      total: null,
      percent: null,
      rate: 0,
      eta: null,
      elapsed: 0,
      done: false,
    });
  }
  assertEqual(all, 5);
});

await test("regression: percent is bounded below as well as above", async () => {
  // The upper clamp existed; the lower one did not. A negative chunk — a
  // caller bug, or a Content-Length revised downward mid-transfer — put
  // `percent` below zero, and every progress line rendered "(-50.0%)".
  const t = new ProgressTracker(1000);
  assertEqual(t.update(-500).percent, 0, "not -50");
  assertEqual(t.update(-500).percent, 0, "and not -100 either");
  // The running byte total is NOT clamped — only the ratio. Silently flooring
  // the counter would hide the caller's bug.
  assertEqual(t.bytesLoaded, -1000);
  // It recovers as real bytes arrive.
  assertEqual(t.update(1500).percent, 50);
  // ...and the top of the range is still clamped.
  assertEqual(new ProgressTracker(1000).update(99999).percent, 100);
  // formatProgress inherits the bound.
  assertEqual(formatProgress(t.snapshot()).includes("(-"), false);
  // A tracker with no usable total has no ratio to clamp.
  for (const total of [null, 0, -1]) {
    assertEqual(new ProgressTracker(total).update(-10).percent, null, `total ${total}`);
  }
  // A frozen snapshot still reports a bounded percent, so a value read later
  // is bounded too.
  const snap = new ProgressTracker(1000);
  snap.update(-100);
  const frozen = snap.snapshot();
  assertEqual(frozen.percent, 0);
  assertEqual(frozen.loaded, -100, "while loaded is reported as given");
});

suite("regression: abort, clamping, part identity");

await test("regression: an aborted upload is not reported as 100% complete", async () => {
  // The abort handler called `tracker.complete()`, and `done` is what forces
  // the final percent — so an upload aborted 10 bytes into a 100-byte body was
  // announced to every onProgress listener as a finished, 100%-complete
  // transfer. Removing that call alone was not enough: cancelling the reader
  // resolves the *pending* read inside `pull` with `{ done: true }`, which is
  // indistinguishable from an end-of-stream, so the pull completed the tracker
  // and closed the wrapper on the very path that was aborting it. The upload
  // side needed the same `aborted` flag the download side already had.
  const ac = new AbortController();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
      // never closes, so only the abort can end this
    },
  });
  const seen: ProgressSnapshot[] = [];
  const { stream, tracker } = withUploadProgress(source, 100, {
    signal: ac.signal,
    onProgress: (s) => seen.push(s),
  });

  const reader = stream.getReader();
  await reader.read();
  // Start the next read and leave it pending. This is what puts the wrapper's
  // `pull` inside `await reader.read()` when the abort arrives — without it
  // the pull is never entered, the `done` branch is never reached, and a
  // tracker completed on the abort path would go unnoticed.
  const pending = reader.read();
  await delay(20);
  ac.abort();
  await assert.rejects(
    () => pending,
    (err: unknown) => {
      assert.equal((err as DOMException).name, "AbortError");
      assert.equal((err as Error).message, "Upload aborted");
      return true;
    },
    "the in-flight read rejects with AbortError",
  );
  await delay(30);

  const snap = tracker.snapshot();
  assertEqual(tracker.isDone, false, "an aborted transfer is not a completed one");
  assertEqual(snap.done, false, "and the snapshot does not claim otherwise");
  assertEqual(snap.percent, 10, "percent reflects the 10 of 100 bytes that actually went, not 100");
  assertEqual(snap.loaded, 10, "and the byte count is the truth");
  // No listener was ever told the transfer finished.
  assertEqual(
    seen.filter((s) => s.done || s.percent === 100).length,
    0,
    "no progress callback was told a 100% complete upload",
  );
  // The stream stays errored afterwards, so the caller cannot accidentally
  // read a "clean end of stream" out of the aborted transfer.
  await assert.rejects(
    () => reader.read(),
    (err: unknown) => {
      assert.equal((err as DOMException).name, "AbortError");
      return true;
    },
    "the upload stream remains errored after the abort",
  );

  // A clean end-of-stream still completes — the guard must not swallow the
  // normal path.
  const clean = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(100));
      c.close();
    },
  });
  const cleanSeen: ProgressSnapshot[] = [];
  const ok = withUploadProgress(clean, 100, { onProgress: (s) => cleanSeen.push(s) });
  await new Response(ok.stream).arrayBuffer();
  assertEqual(ok.tracker.isDone, true, "a completed upload is still done");
  assertEqual(ok.tracker.snapshot().percent, 100, "and still 100%");
  assertEqual(
    cleanSeen.filter((s) => s.done).length,
    1,
    "and still emits exactly one final snapshot",
  );
});

await test("regression: the aggregate percent is bounded below as well as above", async () => {
  // `ProgressTracker` was clamped to [0, 100] in an earlier round because a
  // negative chunk rendered "(-50.0%)". The aggregate sums those same
  // snapshots but was left with a top clamp only, so the overall view — the
  // one a multipart uploader actually displays — was the single place the fix
  // never reached.
  const agg = new MultiPartProgressAggregator(1);
  const t = agg.createPartTracker(0, 100);
  t.update(-50);
  const overall = agg.getOverall().overall;
  assertEqual(overall.percent, 0, "a negative chunk cannot push the aggregate below zero");
  // The per-part view clamps, and the aggregate must agree with it rather than
  // reporting a different number for the same bytes.
  assertEqual(t.snapshot().percent, 0, "the part itself clamps too");
  assertEqual(overall.percent, t.snapshot().percent, "aggregate and part agree");

  // And the top end is still bounded, so the two clamps are both real.
  const over = new MultiPartProgressAggregator(1);
  over.createPartTracker(0, 100).update(500);
  assertEqual(over.getOverall().overall.percent, 100, "still capped at 100");

  // A multi-part aggregate clamps the same way, and a negative part does not
  // drag the others negative either.
  const multi = new MultiPartProgressAggregator(2);
  const p1 = multi.createPartTracker(0, 100);
  const p2 = multi.createPartTracker(1, 100);
  p1.update(50);
  p2.update(-20);
  assertEqual(multi.getOverall().overall.percent, 15, "30 of 200 bytes, floored at zero");
  // Without a filter on the parts there is no path to a negative aggregate, so
  // the value has to come from the clamp rather than from the arithmetic.
  assertEqual(multi.getOverall().overall.percent >= 0, true, "and never negative");
});

await test("regression: createPartTracker retrieves the part it already made", async () => {
  // The method documents itself as "Create or retrieve", and always created. A
  // second call for the same index built a fresh tracker and overwrote the
  // stored one, so the bytes already recorded for that part were silently
  // discarded and the aggregate fell back to zero — a caller re-acquiring a
  // tracker it had lost a handle to erased the part's progress instead of
  // recovering it.
  const agg = new MultiPartProgressAggregator(2);
  const first = agg.createPartTracker(0, 1000);
  first.update(400);
  const other = agg.createPartTracker(1, 1000);
  other.update(100);

  const again = agg.createPartTracker(0, 1000);
  assertEqual(again === first, true, "the same tracker instance is returned");
  assertEqual(again.bytesLoaded, 400, "and it still holds the bytes already recorded");

  // The aggregate is undisturbed by the second call.
  const overall = agg.getOverall().overall;
  assertEqual(overall.loaded, 500, "500 bytes across the two parts, not 100");
  assertEqual(overall.total, 2000, "totals unchanged");

  // Re-acquiring must not re-emit progress for a part that has not moved: the
  // aggregate callback is wired to the per-part onProgress, and re-creating a
  // tracker used to build a second one that immediately reported nothing.
  let emits = 0;
  const watched = new MultiPartProgressAggregator(1, () => {
    emits++;
  });
  const w1 = watched.createPartTracker(0, 100);
  w1.update(50);
  const before = emits;
  watched.createPartTracker(0, 100);
  assertEqual(emits, before, "re-acquiring a part emits nothing on its own");
  assertEqual(watched.getOverall().overall.loaded, 50, "and does not reset the bytes");

  // A DIFFERENT part index is still created, and the first call's size wins
  // for a part that already exists, because changing the total would restate
  // what the recorded bytes were counted against.
  const sized = new MultiPartProgressAggregator(1);
  const s1 = sized.createPartTracker(0, 500);
  s1.update(250);
  const s2 = sized.createPartTracker(0, 999);
  assertEqual(s2 === s1, true, "still the same tracker");
  assertEqual(sized.getOverall().overall.total, 500, "the original part size is kept");
});

await test("regression: a consumer cancel mid-read is not a completed upload", async () => {
  // The third way an upload can stop: the CONSUMER cancels the wrapper rather
  // than aborting the signal. `cancel()` nulls the shared `reader` and cancels
  // the source, which resolves the in-flight read as `{ done: true }` — the
  // same value EOF produces. The pull therefore resumes and the `done` branch
  // runs with `aborted === false`, so `tracker.complete()` would announce a
  // finished, 100%-complete transfer for a body that was thrown away.
  //
  // Cancelling is not an error, so the transfer must simply stop where it was:
  // not done, with the bytes already read still accounted for.
  const source = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(10));
      // Deliberately never closed — the consumer's cancel is the only exit.
    },
  });

  const { stream, tracker } = withUploadProgress(source, 100);
  const reader = stream.getReader();
  const first = await reader.read();
  assertEqual(first.done, false, "the first chunk came through");
  assertEqual(tracker.bytesLoaded, 10, "and was counted");

  await reader.cancel("consumer gave up");
  // Yield so the pull's post-await continuation runs to completion.
  await new Promise((r) => setTimeout(r, 20));

  const snap = tracker.snapshot();
  assertEqual(tracker.isDone, false, "a cancelled upload is not reported as done");
  assertEqual(snap.done, false, "and the snapshot agrees");
  assertEqual(snap.percent, 10, "the percent stays where the transfer stopped");
  assertEqual(snap.loaded, 10, "the bytes already read are still accounted for");
  assertEqual(snap.total, 100, "against the declared body size");

  // Cancelling a wrapper that never started reading is a no-op, not a throw,
  // and must not fabricate completion either.
  const idle = withUploadProgress(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(1));
      },
    }),
    10,
  );
  await idle.stream.getReader().cancel("never read");
  await new Promise((r) => setTimeout(r, 20));
  assertEqual(idle.tracker.isDone, false, "an unread, cancelled upload is not done");
  assertEqual(idle.tracker.bytesLoaded, 0, "and never counted a byte it never read");
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
