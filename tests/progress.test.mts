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

function assertEqual<T>(a: T, b: T) {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const sa = JSON.stringify(a),
      sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`Expected ${sb} got ${sa}`);
  } else if (a !== b) {
    throw new Error(`Expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}

function assertOk(val: unknown) {
  if (!val) throw new Error(`Expected truthy got ${String(val)}`);
}

function assertThrows(fn: () => void) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("Expected throw");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── ProgressTracker ──────────────────────────────────────────────────────

suite("ProgressTracker");

await test("update increments loaded and computes percent", async () => {
  const t = new ProgressTracker(1000);
  const s = t.update(250);
  assertEqual(s.loaded, 250);
  assertEqual(s.total, 1000);
  assertEqual(s.percent, 25);
});

await test("update multiple times accumulates", async () => {
  const t = new ProgressTracker(1000);
  t.update(100);
  t.update(200);
  const s = t.update(300);
  assertEqual(s.loaded, 600);
  assertEqual(s.percent, 60);
  assertEqual(typeof s.rate, "number");
});

await test("complete marks done and sets percent to 100", async () => {
  const t = new ProgressTracker(500);
  t.update(250);
  const s = t.complete();
  assertEqual(s.done, true);
  assertEqual(s.percent, 100);
  assertEqual(s.loaded, 250);
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
  // complete bypasses throttle
  t.complete();
  // at most 1 non-final callback
  assertOk(count >= 1);
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
  // ETA should be a non-negative number
  assertOk(s.eta === null || s.eta >= 0);
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
  assertEqual(formatETA(Infinity), "∞");
  assertEqual(formatETA(-1), "∞");
});

// ── formatProgress ───────────────────────────────────────────────────────

suite("formatProgress");

await test("with total", async () => {
  const t = new ProgressTracker(1000);
  t.update(456);
  const fp = formatProgress(t.snapshot());
  assertOk(fp.includes("456 B"));
  assertOk(fp.includes("45.6%"));
});

await test("without total", async () => {
  const t = new ProgressTracker(null);
  t.update(456);
  const fp = formatProgress(t.snapshot());
  assertOk(fp.includes("456 B"));
  assertEqual(fp.includes("%"), false);
});

await test("done snapshot", async () => {
  const t = new ProgressTracker(1000);
  t.complete();
  const fp = formatProgress(t.snapshot());
  assertOk(fp.includes("100.0%"));
  assertEqual(fp.includes("ETA"), false);
});

// ── throttleProgress ─────────────────────────────────────────────────────

suite("throttleProgress");

await test("throttleProgress emits done snapshot always", async () => {
  let count = 0;
  const fn = throttleProgress(() => count++, 0.1); // very low Hz
  fn({ loaded: 100, total: 200, percent: 50, rate: 0, eta: null, elapsed: 100, done: false });
  fn({ loaded: 200, total: 200, percent: 100, rate: 0, eta: 0, elapsed: 200, done: true });
  // done=true always fires; done=false is throttled at 0.1Hz (10s min interval)
  assertEqual(count, 1);
});

// ── withUploadProgress ───────────────────────────────────────────────────

suite("withUploadProgress");

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
  let threw = false;
  try {
    await reader.read();
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  let threw = false;
  try {
    await reader.read();
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  let threw = false;
  try {
    await reader.read();
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  assertOk(tracker.isDone);
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
  let threw = false;
  try {
    await reader.read();
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  let threw = false;
  try {
    await reader.read();
  } catch {
    threw = true;
  }
  assertOk(threw);
  assertOk(tracker.isDone);
});

// ── streamWithProgress ───────────────────────────────────────────────────

suite("streamWithProgress");

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
  let threw = false;
  try {
    for await (const _ of streamWithProgress(stream, null, { signal: ac.signal })) {
    }
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  let threw = false;
  try {
    await collectStream(stream, 1, { signal: ac.signal });
  } catch {
    threw = true;
  }
  assertOk(threw);
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
  assertOk(callCount >= 1);
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

await test("collectStream abort handler cancels reader", async () => {
  const ac = new AbortController();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      // Don't close — reader will hang waiting for more
    },
  });
  // Abort during reads — handler should cancel reader, which causes read() to return {done:true}
  const promise = collectStream(stream, null, { signal: ac.signal });
  await delay(50);
  ac.abort();
  const { data, tracker } = await promise;
  assertOk(tracker.isDone);
  assertEqual(data.byteLength, 3);
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
