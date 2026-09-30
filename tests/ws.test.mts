import assert from "node:assert/strict";
import process from "node:process";
import {
  WSClient,
  WSError,
  WSMaxReconnectsError,
  WSConnectTimeoutError,
  WSRateLimitError,
  connectWS,
  kinetex,
} from "../src/mod.ts";
import type { WSMessage } from "../src/ws.ts";

/** True only for a genuine connection-level failure. */
function isTransportFailure(e: unknown): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ETIMEOUT|timeout|socket hang up|network/i.test(
    describe(e),
  );
}

function describe(e: unknown): string {
  return `${(e as { name?: string })?.name ?? ""}: ${(e as { message?: string })?.message ?? String(e)}`;
}

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}
function suite(name: string): void {
  console.log(`\n\u2500\u2500 ${name}`);
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const ECHO_WS = "wss://echo.websocket.org/";

async function waitUntil(pred: () => boolean, deadlineMs: number): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!pred() && Date.now() < end) await delay(50);
}

// ── Share one connection for all echo tests to avoid rate limiting ──────

let sharedWs: WSClient;
let sharedReceived: WSMessage[] = [];

suite("Setup shared connection");

await test("connect to echo server", async () => {
  sharedWs = new WSClient({
    url: ECHO_WS,
    pingIntervalMs: 0,
    connectTimeoutMs: 30_000,
    maxReconnects: 0,
    onMessage: (m) => {
      sharedReceived.push(m);
    },
  });
  await sharedWs.connect();
  assert.equal(sharedWs.state, "OPEN");
});

// ── Real echo tests using shared connection ─────────────────────────────

suite("Echo server tests");

await test("send and receive text", async () => {
  sharedReceived.length = 0;
  sharedWs.send("hello-ws");
  await waitUntil(
    () =>
      sharedReceived.some((m) => typeof m.data === "string" && (m.data as string) === "hello-ws"),
    10_000,
  );
  const found = sharedReceived.find(
    (m) => typeof m.data === "string" && (m.data as string) === "hello-ws",
  );
  assert.notEqual(found, undefined);
  assert.equal(found!.data, "hello-ws");
  assert.ok(sharedReceived[0].timestamp > 0);
});

await test("send and receive large message", async () => {
  sharedReceived.length = 0;
  const large = "A".repeat(5000);
  sharedWs.send(large);
  await waitUntil(
    () => sharedReceived.some((m) => typeof m.data === "string" && m.data.length === 5000),
    10_000,
  );
  const echo = sharedReceived.find((m) => typeof m.data === "string" && m.data.length === 5000);
  assert.notEqual(echo, undefined);
  assert.equal(echo!.data.length, 5000);
});

await test("sendJSON echoes back", async () => {
  sharedReceived.length = 0;
  sharedWs.sendJSON({ type: "test", value: 42 });
  await waitUntil(() => sharedReceived.length >= 1, 10_000);
  assert.equal(sharedReceived.length >= 1, true, "the echo server must return the message");
  assert.deepEqual(JSON.parse(String(sharedReceived[0]!.data)), { type: "test", value: 42 });
});

await test("sendBinary echoes correctly", async () => {
  sharedReceived.length = 0;
  const data = new Uint8Array([10, 20, 30, 40, 50]);
  sharedWs.sendBinary(data);
  await waitUntil(() => sharedReceived.length >= 1, 10_000);
  assert.equal(sharedReceived.length >= 1, true, "the echo server must return the message");
  const echoed = sharedReceived[0]!.data;
  assert.equal(echoed instanceof Uint8Array || typeof echoed === "string", true);
  // The public echo server may hand back either a binary or a text frame, so
  // the two branches cannot be collapsed — but both must carry the same five
  // bytes. The text arm previously accepted any non-empty string, so a server
  // echoing the wrong payload entirely would still have passed.
  if (echoed instanceof Uint8Array) {
    assert.deepEqual([...echoed], [10, 20, 30, 40, 50]);
  } else {
    assert.deepEqual(
      [...String(echoed)].map((c) => c.charCodeAt(0)),
      [10, 20, 30, 40, 50],
    );
  }
});

await test("sendBinary subarray sends 3 bytes not 100", async () => {
  const prev = sharedWs.metrics.bytesSent;
  sharedWs.sendBinary(new Uint8Array(100).subarray(0, 3));
  assert.equal(sharedWs.metrics.bytesSent - prev, 3);
});

await test("metrics update after messages", async () => {
  assert.ok(sharedWs.metrics.messagesSent >= 5);
  assert.ok(sharedWs.metrics.messagesReceived >= 4);
  assert.equal(sharedWs.metrics.totalConnectAttempts, 1);
  assert.notEqual(sharedWs.metrics.connectedAt, null);
});

await test("request matches echo reply", async () => {
  const result = await sharedWs.request(
    "hello-req",
    (m) => typeof m.data === "string" && (m.data as string) === "hello-req",
    undefined,
    10_000,
  );
  assert.equal(result, "hello-req");
});

await test("async iterator yields echo messages", async () => {
  sharedWs.send("iter-test-unique");
  const iter = sharedWs[Symbol.asyncIterator]();
  const first = await Promise.race([
    iter.next(),
    delay(10_000).then(() => ({ done: true as const, value: undefined })),
  ]);
  assert.equal(first.done, false);
  assert.notEqual(first.value, undefined);
  assert.ok(typeof (first.value as WSMessage).timestamp === "number");
  await iter.return?.();
});

await test("close with code 1000 closes cleanly", async () => {
  sharedWs.close(1000, "Test complete");
  assert.equal(sharedWs.state, "CLOSED");
  assert.equal(sharedWs.metrics.closedAt, sharedWs.metrics.closedAt);
});

// ── Construction & config (no connection needed) ────────────────────────

suite("Construction and config");

await test("WSClient created with URL has CLOSED state", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  assert.equal(ws.state, "CLOSED");
  assert.equal(ws.connected, false);
  ws.destroy();
});

await test("scheduling a reconnect clears the previous pending timer", async () => {
  // Two paths can schedule a reconnect: the send-error path (which also closes
  // the socket, firing onclose → another schedule) and onclose itself. If the
  // pending timer is not cleared first, the first one stays alive and produces a
  // duplicate connection and a double-counted attempt.
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    reconnectBaseMs: 60_000,
  });
  const internals = ws as unknown as {
    _scheduleRecon: () => void;
    _reconnTimer: ReturnType<typeof setTimeout> | null;
    _reconnAttempt: number;
  };

  internals._scheduleRecon();
  const firstTimer = internals._reconnTimer;
  assert.ok(firstTimer, "the first schedule must install a timer");
  assert.equal(internals._reconnAttempt, 1);

  internals._scheduleRecon();
  const secondTimer = internals._reconnTimer;
  assert.ok(secondTimer, "the second schedule must install a timer");
  assert.notEqual(secondTimer, firstTimer, "the stale timer handle must be replaced");
  assert.equal(internals._reconnAttempt, 2, "only one attempt may be counted per schedule");

  // The superseded timer must no longer be able to fire a connection attempt.
  assert.equal(internals._reconnTimer, secondTimer);
  ws.destroy();
});

await test("WSClient getters return initial values", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  assert.equal(ws.bufferedCount, 0);
  assert.equal(ws.metrics.totalConnectAttempts, 0);
  assert.equal(ws.metrics.messagesSent, 0);
  assert.equal(ws.metrics.messagesReceived, 0);
  assert.equal(ws.metrics.reconnectCount, 0);
  ws.destroy();
});

await test("destroy() cleans up resources", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.destroy();
  assert.equal(ws.state, "CLOSED");
  assert.equal(ws.bufferedCount, 0);
  assert.equal(ws.bufferedCount, 0);
  assert.equal(ws.rooms.length, 0);
  assert.deepEqual(ws.drainBuffer(), []);
});

await test("close() without connect transitions to CLOSED", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.close(1000, "test");
  assert.equal(ws.state, "CLOSED");
});

await test("connect() while OPEN returns resolved", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "OPEN";
  // Nothing was asserted: a connect() that reconnected, or one that rejected,
  // both satisfied the old body. Pin that it is a no-op on an OPEN socket.
  await assert.doesNotReject(() => ws.connect());
  assert.equal(ws.state, "OPEN", "state must be unchanged");
  assert.equal(
    ws.metrics.totalConnectAttempts,
    0,
    "an already-open socket must not start a new connection attempt",
  );
  ws.destroy();
});

await test("waitForOpen resolves when already OPEN", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "OPEN";
  // It resolved for the wrong reason before: nothing proved it resolved
  // *immediately* rather than sitting out the 1000 ms timeout first.
  const t0 = Date.now();
  await assert.doesNotReject(() => ws.waitForOpen(1000));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `waitForOpen must resolve immediately, took ${elapsed}ms`);
  assert.equal(ws.metrics.totalConnectAttempts, 0);
  ws.destroy();
});

await test("waitForOpen rejects on timeout", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "CONNECTING";
  await assert.rejects(() => ws.waitForOpen(100), WSConnectTimeoutError);
  ws.destroy();
});

await test("connectWS factory", async () => {
  const ws = await connectWS({
    url: ECHO_WS,
    pingIntervalMs: 0,
    connectTimeoutMs: 30_000,
    maxReconnects: 0,
  });
  assert.equal(ws.state, "OPEN");
  ws.close();
});

// ── Error handling ──────────────────────────────────────────────────────

suite("Error handling");

await test("connect to invalid host throws WSConnectTimeoutError", async () => {
  const ws = new WSClient({
    url: "wss://this-host-does-not-exist-xyz.invalid:9",
    connectTimeoutMs: 3000,
    maxReconnects: 0,
    pingIntervalMs: 0,
  });
  await assert.rejects(() => ws.connect(), WSConnectTimeoutError);
  ws.destroy();
});

await test("connection timeout with unlimited reconnects enters RECONNECTING", async () => {
  const ws = new WSClient({
    url: "wss://this-host-does-not-exist-xyz.invalid:9",
    connectTimeoutMs: 2000,
    maxReconnects: 0,
    pingIntervalMs: 0,
  });
  await assert.rejects(() => ws.connect(), WSConnectTimeoutError);
  // maxReconnects=0 means unlimited — the client enters RECONNECTING state
  assert.equal(ws.state, "RECONNECTING");
  ws.destroy();
});

// ── Message buffering ───────────────────────────────────────────────────

suite("Message buffering");

await test("send while closed buffers", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.send("hello");
  ws.send("world");
  assert.equal(ws.bufferedCount, 2);
  assert.equal(ws.backpressure.bufferedBytes, 10);
  ws.destroy();
});

await test("sendJSON while closed buffers", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.sendJSON({ x: 1 });
  assert.equal(ws.bufferedCount, 1);
  ws.destroy();
});

await test("sendBinary while closed buffers", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.sendBinary(new Uint8Array([1]));
  assert.equal(ws.bufferedCount, 1);
  ws.destroy();
});

await test("send without buffering drops", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: false });
  ws.send("dropped");
  assert.equal(ws.bufferedCount, 0);
  ws.destroy();
});

await test("maxBufferSize drops oldest", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    bufferMessages: true,
    maxBufferSize: 2,
  });
  ws.send("a");
  ws.send("b");
  ws.send("c");
  assert.equal(ws.bufferedCount, 2);
  ws.destroy();
});

await test("maxBufferSize drops oldest binary evicts bytes", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    bufferMessages: true,
    maxBufferSize: 2,
  });
  ws.send("first");
  // Send binary to cover ArrayBuffer eviction path (line 938)
  ws.sendBinary(new Uint8Array([1, 2, 3, 4, 5]));
  ws.sendBinary(new Uint8Array([10, 20, 30]));
  // "first" was evicted, binary messages remain
  assert.equal(ws.bufferedCount, 2);
  assert.ok(ws.backpressure.bufferedBytes > 0);
  ws.destroy();
});

await test("drainBuffer returns FIFO", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.send("first");
  ws.send("second");
  const buf = ws.drainBuffer();
  assert.equal(buf.length, 2);
  assert.equal(buf[0], "first");
  assert.equal(buf[1], "second");
  ws.destroy();
});

await test("drainBuffer resets bufferedBytes", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.send("some data");
  assert.ok(ws.backpressure.bufferedBytes > 0);
  ws.drainBuffer();
  assert.equal(ws.backpressure.bufferedBytes, 0);
  ws.destroy();
});

// ── Listeners ───────────────────────────────────────────────────────────

suite("Listeners");

await test("onMessage unsubscribe works", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  let calls = 0;
  const unsub = ws.onMessage(() => {
    calls++;
  });
  for (const fn of (ws as any)._msgListeners) fn({ data: "t", timestamp: 1 });
  assert.equal(calls, 1);
  unsub();
  assert.equal((ws as any)._msgListeners.length, 0);
  ws.destroy();
});

await test("onClose unsubscribe works", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  let calls = 0;
  const unsub = ws.onClose(() => {
    calls++;
  });
  for (const fn of (ws as any)._closeListeners) fn({ code: 1000, reason: "t" });
  assert.equal(calls, 1);
  unsub();
  assert.equal((ws as any)._closeListeners.length, 0);
  ws.destroy();
});

// ── Error classes ───────────────────────────────────────────────────────

suite("Error classes");

await test("WSError name and code", async () => {
  const e = new WSError("msg", new Error("cause"));
  assert.equal(e.name, "WSError");
  assert.equal(e.code, "EWSCONNECT");
  assert.notEqual(e.originalCause, undefined);
});

await test("WSMaxReconnectsError properties", async () => {
  const e = new WSMaxReconnectsError(3);
  assert.equal(e.name, "WSMaxReconnectsError");
  assert.equal(e.code, "EWSMAXRECONNECTS");
  assert.equal(e.attempts, 3);
});

await test("WSConnectTimeoutError properties", async () => {
  const e = new WSConnectTimeoutError("wss://example.com", 5000);
  assert.equal(e.name, "WSConnectTimeoutError");
  assert.equal(e.code, "EWSCONNECTTIMEOUT");
  assert.match(e.message, /5000/);
});

await test("WSRateLimitError name and code", async () => {
  const e = new WSRateLimitError(1000);
  assert.equal(e.name, "WSRateLimitError");
  assert.equal(e.code, "EWSRATELIMIT");
  assert.equal(e.delayMs, 1000);
});

// ── Edge cases ──────────────────────────────────────────────────────────

suite("Edge cases");

await test("sendBinary with ArrayBuffer (not Uint8Array)", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  ws.sendBinary(ab);
  assert.equal(ws.bufferedCount, 1);
  ws.destroy();
});

await test("onMessage isolates listener errors", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  const calls: string[] = [];
  ws.onMessage((m) => {
    calls.push("first");
  });
  ws.onMessage((m) => {
    calls.push("second");
  });
  // No try/catch around listener dispatch: the `catch { /* isolate */ }`
  // this replaced meant a listener that threw mid-invocation still passed,
  // as long as it had recorded its call first. A throw is a defect.
  for (const fn of (ws as any)._msgListeners) {
    fn({ data: "t", timestamp: 1 });
  }
  assert.deepEqual(calls, ["first", "second"]);
  ws.destroy();
});

await test("onClose isolates listener errors", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  const calls: string[] = [];
  ws.onClose(() => {
    calls.push("first");
  });
  ws.onClose(() => {
    calls.push("second");
  });
  // No try/catch around listener dispatch: the `catch { /* isolate */ }`
  // this replaced meant a listener that threw mid-invocation still passed,
  // as long as it had recorded its call first. A throw is a defect.
  for (const fn of (ws as any)._closeListeners) {
    fn({ code: 1000, reason: "t" });
  }
  assert.deepEqual(calls, ["first", "second"]);
  ws.destroy();
});

await test("async iterator queues overflow at maxBufferSize", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", maxBufferSize: 2 });
  const iter = ws[Symbol.asyncIterator]();
  // The old body pushed through the *listener* list and asserted nothing, so
  // it passed whether or not a single message was ever queued. Seed the
  // iterator queue the way the socket handler does and pin the cap.
  const internals = ws as unknown as {
    _iterQueue: Array<{ data: string }>;
    _maxBufferSize: number;
  };
  assert.equal(internals._maxBufferSize, 2, "the configured cap must be what the handler uses");
  for (let i = 0; i < 5; i++) {
    if (internals._iterQueue.length >= internals._maxBufferSize) internals._iterQueue.shift();
    internals._iterQueue.push({ data: `msg-${i}`, timestamp: i } as never);
  }
  assert.equal(internals._iterQueue.length, 2, "the queue must never grow past maxBufferSize");
  // Oldest-first eviction: the survivors are the newest two.
  assert.deepEqual(
    internals._iterQueue.map((m) => m.data),
    ["msg-3", "msg-4"],
  );
  const first = await iter.next!();
  assert.equal((first.value as WSMessage).data, "msg-3", "a consumer must drain from the queue");
  await iter.return!();
  ws.destroy();
});

await test("connect() while RECONNECTING queues waiter", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "RECONNECTING";
  const p = ws.connect();
  assert.equal(p instanceof Promise, true);
  assert.equal(typeof p.then, "function");
  // The queued waiter is not a leak: destroying the client must settle it.
  // A silent `.catch` would have let a waiter that never settles pass.
  ws.destroy();
  await assert.rejects(
    () => p,
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /destroy/i);
      return true;
    },
  );
});

await test("onMessage registered listener receives messages", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  const received: WSMessage[] = [];
  ws.onMessage((m) => received.push(m));
  // No try/catch around listener dispatch: the `catch { /* isolate */ }`
  // this replaced meant a listener that threw mid-invocation still passed,
  // as long as it had recorded its call first. A throw is a defect.
  for (const fn of (ws as any)._msgListeners) {
    fn({ data: "msg", timestamp: 1 });
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].data, "msg");
  ws.destroy();
});

await test("sendBinary while OPEN with subarray uses correct buffer", async () => {
  const full = new Uint8Array(100);
  const view = full.subarray(0, 3);
  assert.equal(view.byteLength, 3);
  assert.equal(full.subarray(0, 3).slice().buffer.byteLength, 3);
});

await test("ping pong echo keeps connection open", async () => {
  await delay(2000);
  try {
    const ws = new WSClient({
      url: ECHO_WS,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
      pingIntervalMs: 200,
      pingPayload: "ping",
      pongMatcher: "ping",
      pongTimeoutMs: 1000,
    });
    await ws.connect();
    await delay(500);
    assert.equal(ws.state, "OPEN");
    assert.ok(ws.metrics.messagesSent >= 1);
    ws.close();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

await test("buffer messages then flush on connect", async () => {
  await delay(1000);
  try {
    const ws = new WSClient({
      url: ECHO_WS,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
      pingIntervalMs: 0,
      bufferMessages: true,
    });
    ws.send("buffered-1");
    ws.send("buffered-2");
    assert.equal(ws.bufferedCount, 2);
    await ws.connect();
    assert.equal(ws.bufferedCount, 0);
    assert.ok(ws.metrics.messagesSent >= 2);
    ws.close();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

// ── Backpressure ───────────────────────────────────────────────────────

suite("Backpressure");

await test("backpressure getter returns initial state", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  const bp = ws.backpressure;
  assert.equal(bp.bufferedBytes, 0);
  assert.equal(bp.highWaterMark, 65536);
  assert.equal(bp.lowWaterMark, 16384);
  assert.equal(bp.isBackpressured, false);
  ws.destroy();
});

await test("bufferedMessages accumulates byte count", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", bufferMessages: true });
  ws.send("hello");
  ws.send("world");
  assert.equal(ws.backpressure.bufferedBytes, 10);
  assert.equal(ws.backpressure.isBackpressured, false);
  ws.destroy();
});

await test("drain() rejects when CLOSED", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.destroy();
  await assert.rejects(() => ws.drain(100), WSError);
});

await test("highWaterMark triggers backpressure", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    bufferMessages: true,
    highWaterMark: 1,
    lowWaterMark: 1,
  });
  ws.send("big payload");
  assert.equal(ws.backpressure.isBackpressured, true);
  ws.destroy();
});

await test("onBackpressure callback fires on threshold crossing", async () => {
  let bpReceived: boolean | null = null;
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    bufferMessages: true,
    highWaterMark: 1,
    lowWaterMark: 1,
    onBackpressure: (bp) => {
      bpReceived = bp;
    },
  });
  ws.send("x");
  assert.equal(bpReceived, true);
  ws.destroy();
});

await test("drain resolves when buffer cleared via drainBuffer", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    bufferMessages: true,
    highWaterMark: 1,
    lowWaterMark: 1,
  });
  // drain() requires state != CLOSED — simulate reconnecting state
  (ws as any)._state = "RECONNECTING";
  ws.send("trigger backpressure");
  assert.equal(ws.backpressure.isBackpressured, true);
  const drainP = ws.drain(5000);
  ws.drainBuffer();
  await drainP;
  assert.equal(ws.backpressure.bufferedBytes, 0);
  assert.equal(ws.backpressure.isBackpressured, false);
  ws.destroy();
});

await test("drain() resolves immediately when already below lowWaterMark", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    highWaterMark: 65536,
    lowWaterMark: 16384,
  });
  (ws as any)._state = "RECONNECTING";
  // Assert the "immediately" in the name.
  const t0 = Date.now();
  await assert.doesNotReject(() => ws.drain(100));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `drain() must short-circuit below the low-water mark, took ${elapsed}ms`);
  ws.destroy();
});

// ── Rate limiting ──────────────────────────────────────────────────────

suite("Rate limiting");

await test("maxSendRate=0 means unlimited", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", maxSendRate: 0 });
  ws.send("msg1");
  ws.send("msg2");
  assert.equal(ws.bufferedCount, 2);
  ws.destroy();
});

await test("maxSendRate > 0 buffers when token bucket empty", async () => {
  // Set rate so low that second message must buffer
  const ws = new WSClient({ url: "wss://placeholder.example/ws", maxSendRate: 1000 });
  // Token bucket starts with maxSendRate tokens, so first sends succeed
  // Reset internal state to simulate empty bucket
  (ws as any)._tokens = 0;
  (ws as any)._lastToken = Date.now();
  ws.send("this should buffer");
  assert.equal(ws.bufferedCount, 1);
  ws.destroy();
});

// ── Rooms ──────────────────────────────────────────────────────────────

suite("Rooms");

await test("join tracks room", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.join("room-a");
  assert.equal(ws.rooms.length, 1);
  assert.equal(ws.rooms[0].room, "room-a");
  assert.equal(ws.rooms[0].namespace, undefined);
  ws.destroy();
});

await test("join same room twice is idempotent", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.join("room-a");
  ws.join("room-a");
  assert.equal(ws.rooms.length, 1);
  ws.destroy();
});

await test("leave removes room", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.join("room-a");
  ws.join("room-b");
  ws.leave("room-a");
  assert.equal(ws.rooms.length, 1);
  assert.equal(ws.rooms[0].room, "room-b");
  ws.destroy();
});

await test("leave non-existent room is no-op", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.leave("nonexistent");
  assert.equal(ws.rooms.length, 0);
  ws.destroy();
});

await test("join with namespace", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.join("chat", "ns1");
  assert.equal(ws.rooms.length, 1);
  assert.equal(ws.rooms[0].namespace, "ns1");
  ws.destroy();
});

await test("rooms config pre-subscribes rooms", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", rooms: ["room-a", "room-b"] });
  assert.equal(ws.rooms.length, 2);
  assert.equal(ws.rooms[0].room, "room-a");
  assert.equal(ws.rooms[1].room, "room-b");
  ws.destroy();
});

await test("rooms config with keepRooms=false", async () => {
  const ws = new WSClient({
    url: "wss://placeholder.example/ws",
    rooms: ["room-a"],
    keepRooms: false,
  });
  assert.equal(ws.rooms.length, 1);
  assert.equal(ws.rooms[0].room, "room-a");
  ws.destroy();
});

// ── Sticky session ─────────────────────────────────────────────────────

suite("Sticky session");

await test("serverEndpoint is null before connect", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  assert.equal(ws.serverEndpoint, null);
  ws.destroy();
});

await test("serverEndpoint populated after connect", async () => {
  try {
    const ws = new WSClient({
      url: ECHO_WS,
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    await ws.connect();
    assert.equal(typeof ws.serverEndpoint, "string");
    assert.ok(ws.serverEndpoint!.length > 0);
    ws.close();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────

suite("Graceful shutdown");

await test("drainAndClose on CLOSED client returns immediately", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  ws.destroy();
  await ws.drainAndClose(100);
  assert.equal(ws.state, "CLOSED");
});

await test("drainAndClose with connected echo server", async () => {
  try {
    const ws = new WSClient({
      url: ECHO_WS,
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    await ws.connect();
    ws.send("drain-me");
    await ws.drainAndClose(5000);
    assert.equal(ws.state, "CLOSED");
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

// ── Correlation rejection ──────────────────────────────────────────────

suite("Correlation rejection");

await test("request rejects when connection fails permanently", async () => {
  const ws = new WSClient({
    url: "wss://this-host-does-not-exist-xyz.invalid:9",
    connectTimeoutMs: 2000,
    maxReconnects: 0,
    pingIntervalMs: 0,
  });
  // Start a request while connecting; it should reject when the timeout fires
  const reqP = ws.request(
    "ping",
    (m) => typeof m.data === "string" && m.data === "pong",
    undefined,
    5000,
  );
  await assert.rejects(() => ws.connect(), WSConnectTimeoutError);
  await assert.rejects(() => reqP, WSError);
  ws.destroy();
});

// ── Kinetex client integration ─────────────────────────────────────────

suite("Kinetex integration");

await test("regression: client.ws() accepts a wss:// URL", async () => {
  // `buildURL` screens every URL through the SSRF check, whose default scheme
  // list is ["http", "https"]. `client.ws()` did not opt `ws`/`wss` in, so the
  // documented call — `client.ws("wss://…")`, the form in the README and in the
  // method's own JSDoc — threw EVALIDATION every time and `ws()` could not
  // connect at all. The echo-server tests above only "passed" because a
  // catch-all discarded the failure.
  const client = kinetex({ baseURL: "https://echo.websocket.org" });
  try {
    try {
      const ws = await client.ws("wss://echo.websocket.org/", {
        connectTimeoutMs: 10_000,
        maxReconnects: 0,
        pingIntervalMs: 0,
      });
      // Reached the server: the endpoint is both allowed and reachable.
      assert.ok(ws.state !== "CLOSED", "a connected WSClient must not be CLOSED");
      ws.close();
    } catch (err) {
      // Whether the public echo server is reachable is environmental. What must
      // never happen is the SSRF scheme rejection, which is what the missing
      // opt-in caused.
      assert.ok(err instanceof Error);
      assert.doesNotMatch(
        err.message,
        /failed safety check|forbidden scheme/,
        "a wss:// endpoint must not be rejected as a forbidden scheme",
      );
    }
  } finally {
    client.destroy();
  }
});

await test("regression: a wss:// baseURL passes the WebSocket origin guard", async () => {
  // The guard compared the WebSocket scheme only against `https:`, so a client
  // configured with a WebSocket base URL — `kinetex({ baseURL: "wss://…" })`,
  // then a relative path — was rejected even though the two origins it printed
  // in the error were identical. Every other ws() test here uses an https base,
  // so this branch was otherwise unverified.
  const client = kinetex({ baseURL: "wss://ws.postman-echo.com", timeout: 10_000 });
  try {
    await client.ws("/raw", { connectTimeoutMs: 4_000, maxReconnects: 0, pingIntervalMs: 0 }).then(
      (ws) => {
        ws.close();
      },
      (err: unknown) => {
        // Reaching the network is environmental; being rejected by the origin
        // guard is not. Only a transport failure may escape this branch.
        assert.ok(err instanceof Error);
        assert.doesNotMatch(
          err.message,
          /does not match baseURL origin/,
          "a wss:// endpoint against a wss:// baseURL must pass the origin guard",
        );
      },
    );
  } finally {
    await client.destroy();
  }
});

await test("regression: an https:// baseURL still refuses a ws:// endpoint", async () => {
  // The counterweight: widening the base-URL side to accept `wss:` must not
  // have made a downgraded plaintext socket acceptable against an https origin.
  const client = kinetex({ baseURL: "https://ws.postman-echo.com" });
  try {
    await assert.rejects(
      () => client.ws("ws://ws.postman-echo.com/raw"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /does not match baseURL origin/);
        return true;
      },
      "a plaintext ws:// socket must not be accepted for an https origin",
    );
  } finally {
    await client.destroy();
  }
});

await test("regression: an http request may not target a ws:// URL", async () => {
  // The counterweight to the fix above: widening the scheme list for `ws()`
  // must not have widened it for ordinary HTTP requests, which would let a
  // `ws://` URL slip past the SSRF screen.
  const client = kinetex({ baseURL: "https://echo.websocket.org" });
  try {
    await assert.rejects(
      () => client.get("ws://echo.websocket.org/"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /safety check|forbidden scheme/i);
        return true;
      },
      "an HTTP request to a ws:// URL must still be refused",
    );
  } finally {
    client.destroy();
  }
});

await test("regression: the SSRF check still applies to wss:// loopback", async () => {
  // Widening the scheme list must not have widened anything else: loopback is
  // still refused, for WebSocket URLs exactly as for HTTP ones.
  const client = kinetex({});
  try {
    await assert.rejects(
      () => client.ws("ws://127.0.0.1:9/"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /safety check/i);
        return true;
      },
      "a loopback ws:// endpoint must still be refused",
    );
  } finally {
    client.destroy();
  }
});

await test("kinetex ws() creates connected WSClient", async () => {
  try {
    const client = kinetex({ baseURL: "https://echo.websocket.org" });
    // `ws()` documents an absolute ws:// / wss:// endpoint. Passing "/"
    // resolved against the https:// baseURL to an https:// URL, which the
    // origin guard rejects — and the catch-all below reported a pass anyway.
    const ws = await client.ws("wss://echo.websocket.org/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.state, "OPEN");
    ws.close();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

await test("kinetex ws() propagates ws config", async () => {
  try {
    const client = kinetex({
      baseURL: "https://echo.websocket.org",
      ws: { highWaterMark: 8192, lowWaterMark: 1024, maxSendRate: 50, keepRooms: false },
    });
    // `ws()` documents an absolute ws:// / wss:// endpoint. Passing "/"
    // resolved against the https:// baseURL to an https:// URL, which the
    // origin guard rejects — and the catch-all below reported a pass anyway.
    const ws = await client.ws("wss://echo.websocket.org/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.backpressure.highWaterMark, 8192);
    assert.equal((ws as any)._maxSendRate, 50);
    assert.equal((ws as any)._keepRooms, false);
    client.destroy();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

await test("kinetex destroy() closes tracked WS clients", async () => {
  const client = kinetex({ baseURL: "https://echo.websocket.org" });
  const ws = new WSClient({
    url: ECHO_WS,
    pingIntervalMs: 0,
    connectTimeoutMs: 5000,
    maxReconnects: 0,
  });
  (client as any)._wsClients.add(ws);
  await client.destroy();
  assert.equal((client as any)._wsClients.size, 0);
  assert.equal(ws.state, "CLOSED");
});

await test("kinetex ws() with bearer auth injects authorization header", async () => {
  try {
    const client = kinetex({
      baseURL: "https://echo.websocket.org",
      auth: { type: "bearer", token: "test-token" },
    });
    // `ws()` documents an absolute ws:// / wss:// endpoint. Passing "/"
    // resolved against the https:// baseURL to an https:// URL, which the
    // origin guard rejects — and the catch-all below reported a pass anyway.
    const ws = await client.ws("wss://echo.websocket.org/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.state, "OPEN");
    const headers = (ws as any)._headers;
    assert.equal(headers["authorization"], "Bearer test-token");
    ws.close();
  } catch (e) {
    // The bare `catch {}` this replaced encloses the assertions above, so it
    // reported a pass for a genuinely broken WebSocket. Only a transport-level
    // failure may skip; anything else fails the suite.
    assert.ok(
      isTransportFailure(e),
      `echo-server test failed for a non-network reason and must not be skipped: ${describe(e)}`,
    );
    console.log(`    → echo server unavailable, skipping: ${describe(e)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Socket error paths
//
// Everything above this block reaches a real WebSocket, so every failure
// mode below the handshake is reached only by a live network event. The
// fake below installs a `WebSocket` the test drives by hand, which is the
// only way to reach the close/destroy waiter drains, the connect timeout,
// and the socket error handlers at all.
// ═══════════════════════════════════════════════════════════════════════

suite("Socket error paths");

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  /** When set, the next construction throws it (a bad URL, a CSP refusal). */
  static failConstruct: Error | null = null;
  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.failConstruct = null;
  }
  static get last(): FakeWebSocket {
    const i = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    assert.ok(i, "a WebSocket was constructed");
    return i!;
  }

  url: string;
  protocols: string | string[] | undefined;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  sent: unknown[] = [];
  closeCalls: Array<[number, string]> = [];
  headers: Record<string, string> = {};
  /** Make close() throw, to reach the guarded call in close()/destroy(). */
  throwOnClose = false;
  /** Make send() throw, to reach the guarded send in _tx()/_startPing(). */
  throwOnSend: Error | null = null;

  constructor(url: string, protocols?: string | string[]) {
    if (FakeWebSocket.failConstruct) {
      const e = FakeWebSocket.failConstruct;
      FakeWebSocket.failConstruct = null;
      throw e;
    }
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  send(data: unknown): void {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.throwOnClose) throw new Error("close() refused by the socket");
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
  }

  // ── test-side drivers ──
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown): void {
    void this.onmessage?.({ data });
  }
  error(message = "socket exploded"): void {
    this.onerror?.({ message, error: new Error(message) });
  }
  /** A non-1000 close: the client treats it as a drop and reconnects. */
  remoteClose(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Install the fake and return a restore function. */
function withFakeWebSocket(): () => void {
  const real = (globalThis as Record<string, unknown>)["WebSocket"];
  (globalThis as Record<string, unknown>)["WebSocket"] = FakeWebSocket;
  FakeWebSocket.reset();
  return () => {
    if (real === undefined) delete (globalThis as Record<string, unknown>)["WebSocket"];
    else (globalThis as Record<string, unknown>)["WebSocket"] = real;
    FakeWebSocket.reset();
  };
}

/** A client wired to the fake, with nothing that can outlive the test. */
function fakeClient(over: Partial<ConstructorParameters<typeof WSClient>[0]> = {}): WSClient {
  return new WSClient({
    url: "wss://socket.invalid/ws",
    pingIntervalMs: 0,
    connectTimeoutMs: 0,
    maxReconnects: 0,
    ...over,
  });
}

await test("waitForOpen rejects with WSConnectTimeoutError when the socket never opens", async () => {
  // The waiter is spliced out before the rejection, so a later `open()` cannot
  // resolve an already-timed-out promise and leave the caller hanging on a
  // second, unowned waiter.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    const started = Date.now();
    await assert.rejects(
      () => ws.waitForOpen(30),
      (err: unknown) => {
        assert.ok(err instanceof WSConnectTimeoutError, `got ${String(err)}`);
        assert.match(err.message, /timed out after 30ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 25, "it waited for the timeout rather than failing early");
    assert.equal((ws as any)._openWaiters.length, 0, "the waiter was removed from the queue");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("waitForOpen with a zero budget has no timeout to fire", async () => {
  // `timeoutMs: 0` documents "wait indefinitely". Registering a zero-length
  // timer would reject the caller's promise on the next tick instead.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    let settled = false;
    const p = ws.waitForOpen(0).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(settled, false, "no timeout fired");
    assert.equal((ws as any)._openWaiters.length, 1, "the waiter is still queued");
    // Resolving it on open must clear nothing and resolve exactly once.
    void ws.connect();
    await FakeWebSocket.last.open();
    await p;
    assert.equal(settled, true, "it resolved when the socket opened");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("close() drains drain-waiters, open-waiters and correlations, and notifies close listeners", async () => {
  // close() is the terminal operation. Anything still parked on the client
  // when it is called has to be settled there, or the caller waits forever on
  // a promise the client no longer knows about.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ lowWaterMark: 0 });
    const closes: Array<{ code: number; reason: string }> = [];
    ws.onClose((e) => closes.push(e));

    // An open waiter, a drain waiter, and a correlation, all pending.
    const openP = ws.waitForOpen(0);
    (ws as any)._state = "CONNECTING";
    const drainP = ws.drain(0);
    const corrP = ws.request("ping", () => false, undefined, 0);
    ws.join("room-a");
    assert.equal((ws as any)._openWaiters.length, 1, "an open waiter is queued");
    assert.equal((ws as any)._drainWaiters.length, 1, "a drain waiter is queued");
    assert.equal((ws as any)._correlations.size, 1, "a correlation is registered");

    ws.close(4002, "going away");

    await assert.rejects(() => openP, /Client closed/);
    await drainP;
    await assert.rejects(() => corrP, /Client closed/);

    assert.equal(closes.length, 1, "the close listener fired");
    assert.equal(closes[0]!.code, 4002);
    assert.equal(closes[0]!.reason, "going away");
    assert.equal(ws.state, "CLOSED");
    assert.equal(ws.rooms.length, 0, "the room list is cleared");
    assert.equal((ws as any)._correlations.size, 0, "the correlation map is emptied");
  } finally {
    restore();
  }
});

await test("a throwing close listener does not stop the others", async () => {
  // Close listeners are user code. One that throws must not prevent the rest
  // from running, or a single bad listener silently swallows the close event.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    const seen: string[] = [];
    ws.onClose(() => {
      throw new Error("listener exploded");
    });
    ws.onClose(() => seen.push("second"));
    ws.close();
    assert.deepEqual(seen, ["second"], "the second listener still ran");
    assert.equal(ws.state, "CLOSED", "and the client still reached CLOSED");
  } finally {
    restore();
  }
});

await test("close() survives a socket whose close() throws", async () => {
  // A socket that refuses to close must not strand the client in CLOSING.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.throwOnClose = true;
    sock.readyState = 0;
    ws.close();
    assert.equal(ws.state, "CLOSED", "the client still reached CLOSED");
  } finally {
    restore();
  }
});

await test("destroy() settles every waiter and clears the buffer", async () => {
  // destroy() is the aggressive form: it also has to release an in-flight
  // async-iterator `next()` and fold uptime into the metrics.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ lowWaterMark: 0 });
    const closes: Array<{ code: number; reason: string }> = [];
    ws.onClose((e) => closes.push(e));

    const openP = ws.waitForOpen(0);
    (ws as any)._state = "CONNECTING";
    const drainP = ws.drain(0);
    const corrP = ws.request("ping", () => false, undefined, 0);
    // A pending `next()`: the iterator is suspended and must be completed.
    const iter = ws[Symbol.asyncIterator]();
    const nextP = iter.next();
    assert.equal((ws as any)._iterWaiter !== null, true, "the iterator is parked");

    ws.destroy();

    await assert.rejects(() => openP, /Client destroyed/);
    await drainP;
    await assert.rejects(() => corrP, /Client destroyed/);
    const r = await nextP;
    assert.equal(r.done, true, "the parked iterator was completed");

    assert.equal(closes.length, 1, "the close listener fired");
    assert.equal(closes[0]!.code, 1000);
    assert.equal(closes[0]!.reason, "Destroyed");
    assert.equal(ws.state, "CLOSED");
    assert.equal(ws.bufferedCount, 0, "the outgoing buffer is dropped");
  } finally {
    restore();
  }
});

await test("destroy() folds uptime in and survives a throwing listener and socket", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    let opened = false;
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    opened = ws.state === "OPEN";
    assert.equal(opened, true, "the socket is OPEN");
    await new Promise((r) => setTimeout(r, 5));

    ws.onClose(() => {
      throw new Error("listener exploded");
    });
    sock.throwOnClose = true;

    ws.destroy();
    assert.equal(ws.state, "CLOSED");
    assert.ok(
      ws.metrics.uptimeMs > 0,
      `uptime was folded in before the client was torn down, got ${ws.metrics.uptimeMs}`,
    );
    assert.ok(ws.metrics.closedAt !== null, "closedAt is stamped");
  } finally {
    restore();
  }
});

await test("a connect timeout with reconnects left schedules a reconnect", async () => {
  // The socket neither opens nor errors. The connect timeout is the only
  // thing that can end the wait, and with budget left it must hand off to the
  // backoff scheduler rather than declaring the client dead.
  const restore = withFakeWebSocket();
  try {
    const reconnects: Array<[number, number]> = [];
    const ws = fakeClient({
      connectTimeoutMs: 40,
      maxReconnects: 2,
      reconnectBaseMs: 20,
      reconnectJitter: 0,
      onReconnect: (n, d) => reconnects.push([n, d]),
    });
    await assert.rejects(() => ws.connect(), WSConnectTimeoutError);
    assert.equal(ws.state, "RECONNECTING", "it handed off to the reconnect scheduler");
    assert.deepEqual(reconnects, [[1, 20]], "onReconnect reported the attempt and the delay");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a connect timeout with no budget left goes CLOSED and rejects its waiters", async () => {
  // Out of reconnect attempts. The open waiters and correlations parked on
  // this attempt must be rejected here, not left to a socket that is gone.
  const restore = withFakeWebSocket();
  try {
    const errors: Error[] = [];
    const ws = fakeClient({
      connectTimeoutMs: 40,
      maxReconnects: 1,
      onError: (e) => errors.push(e),
    });
    (ws as any)._reconnAttempt = 9; // budget already spent
    const openP = ws.waitForOpen(0);
    const corrP = ws.request("ping", () => false, undefined, 0);

    await assert.rejects(() => ws.connect(), WSConnectTimeoutError);
    await assert.rejects(() => openP, WSConnectTimeoutError);
    await assert.rejects(() => corrP, /Connection timeout/);

    assert.equal(ws.state, "CLOSED", "the client is CLOSED, not RECONNECTING");
    assert.equal(errors.length, 1, "onError was told about the timeout");
    assert.ok(errors[0] instanceof WSConnectTimeoutError);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a WebSocket constructor that throws is reported as a WSError", async () => {
  // A bad URL, or a CSP refusal, makes `new WebSocket` throw synchronously.
  // That has to reject the connect promise; escaping it would surface as an
  // unhandled error with no client attached.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    FakeWebSocket.failConstruct = new Error("refused by policy");
    await assert.rejects(
      () => ws.connect(),
      (err: unknown) => {
        assert.ok(err instanceof WSError, `got ${String(err)}`);
        assert.match(err.message, /Failed to construct WebSocket/);
        assert.match(
          (err as WSError).originalCause instanceof Error
            ? (err as WSError).originalCause!.message
            : String((err as WSError).originalCause),
          /refused by policy/,
          "the constructor's own error is carried as the cause",
        );
        return true;
      },
    );
    assert.equal(ws.state, "CLOSED", "the client is CLOSED after a construction failure");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("protocols are passed to the WebSocket constructor", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ protocols: ["graphql-ws", "chat"] });
    void ws.connect();
    assert.deepEqual(FakeWebSocket.last.protocols, ["graphql-ws", "chat"]);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("headers go through setHeader when the runtime supports it", async () => {
  // Deno and Bun accept a `setHeader` extension; Node ignores headers because
  // its WebSocket has no such method. The check must be a capability test,
  // not an assumption, or the header is silently dropped on one runtime.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ headers: { authorization: "Bearer t", "x-trace": "abc" } });
    void ws.connect();
    const sock = FakeWebSocket.last;
    assert.deepEqual(sock.headers, { authorization: "Bearer t", "x-trace": "abc" });
    ws.destroy();
  } finally {
    restore();
  }
});

await test("open resolves waiters, fires onOpen, and rejoins rooms after a reconnect", async () => {
  // The reconnect path is the one place three things have to line up: the
  // waiter queue, the onOpen callback, and the room re-subscription. Dropping
  // the rejoin leaves a client that reports OPEN and receives nothing.
  const restore = withFakeWebSocket();
  try {
    const opens: number[] = [];
    const reconnects: Array<[number, number]> = [];
    const ws = fakeClient({
      maxReconnects: 2,
      reconnectBaseMs: 20,
      reconnectJitter: 0,
      rooms: ["news"],
      onOpen: (n) => opens.push(n),
      onReconnect: (n, d) => reconnects.push([n, d]),
    });
    const first = ws.connect();
    const waiterP = ws.waitForOpen(0);
    FakeWebSocket.last.open();
    await first;
    await waiterP;
    assert.deepEqual(opens, [0], "onOpen reported a first connection");
    assert.equal(ws.state, "OPEN");
    assert.equal(ws.serverEndpoint, "wss://socket.invalid/ws", "the server endpoint is recorded");

    // Drop it abnormally, so the client reconnects.
    FakeWebSocket.last.remoteClose();
    assert.equal(ws.state, "RECONNECTING");
    await waitUntil(() => FakeWebSocket.instances.length === 2, 2000);
    assert.deepEqual(reconnects, [[1, 20]], "one reconnect was scheduled");
    FakeWebSocket.last.open();
    await waitUntil(() => ws.state === "OPEN", 2000);

    assert.deepEqual(opens, [0, 1], "onOpen reported the reconnect (reconnectCount 1)");
    assert.equal(ws.metrics.reconnectCount, 1, "the reconnect is counted");
    const rejoins = FakeWebSocket.last.sent.filter(
      (m) => typeof m === "string" && m.includes("room:join"),
    );
    assert.equal(
      rejoins.length,
      1,
      `the room was re-joined, sent: ${JSON.stringify(FakeWebSocket.last.sent)}`,
    );
    assert.equal(ws.rooms.length, 1, "and it is still tracked");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a socket error is reported through onError", async () => {
  // `onerror` is the only signal a browser WebSocket gives for a failed
  // handshake. Swallowing it leaves a connect() that only the timeout ends.
  const restore = withFakeWebSocket();
  try {
    const errors: Error[] = [];
    const ws = fakeClient({ onError: (e) => errors.push(e) });
    void ws.connect();
    FakeWebSocket.last.error("handshake failed");
    assert.equal(errors.length, 1, "onError fired once");
    assert.ok(errors[0] instanceof WSError);
    assert.match(errors[0]!.message, /handshake failed/);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a socket close with no reconnect budget gives up and rejects waiters", async () => {
  // Abnormal close, budget spent. The client must give up loudly: reject the
  // open waiters, reject the correlations, and end the async iterator.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxReconnects: 1 });
    // The socket is deliberately never opened: the waiter has to still be
    // parked when the close handler runs, or it is resolved by the open and
    // there is nothing left to reject. The connect promise itself rejects
    // too, so it needs a handler of its own.
    void ws.connect().catch(() => {});
    const openP = ws.waitForOpen(0);
    // `remoteClose` below runs the client's close handler synchronously, which
    // rejects these in the same tick. Attach the handlers up front, or Node
    // sees an unhandled rejection and kills the process before the
    // assertions run.
    const corrP = ws.request("ping", () => false, undefined, 0);
    const openResult = openP.then(
      () => null,
      (e: unknown) => e,
    );
    const corrResult = corrP.then(
      () => null,
      (e: unknown) => e,
    );
    const iter = ws[Symbol.asyncIterator]();
    const nextP = iter.next();
    (ws as any)._reconnAttempt = 9; // budget already spent

    FakeWebSocket.last.remoteClose(1011, "server restarting");

    const openErr = await openResult;
    assert.ok(
      openErr instanceof WSMaxReconnectsError,
      `the open waiter rejected, got ${String(openErr)}`,
    );
    assert.equal(openErr.attempts, 9, "the give-up error carries the attempt count");
    const corrErr = await corrResult;
    assert.ok(corrErr instanceof WSError, `the correlation rejected, got ${String(corrErr)}`);
    assert.match(corrErr.message, /Max reconnects exceeded/);
    assert.equal((await nextP).done, true, "the iterator was ended");
    assert.equal(ws.state, "CLOSED", "the client is CLOSED");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a normal close ends the iterator and clears the waiters", async () => {
  // code 1000 is a clean shutdown, not a drop: no reconnect is scheduled.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxReconnects: 5 });
    void ws.connect();
    FakeWebSocket.last.open();
    const iter = ws[Symbol.asyncIterator]();
    const nextP = iter.next();
    FakeWebSocket.last.remoteClose(1000, "bye");
    assert.equal((await nextP).done, true, "the iterator was ended");
    assert.equal(ws.state, "CLOSED", "and no reconnect was scheduled");
    // A subsequent next() on a finished iterator resolves immediately.
    assert.equal((await iter.next()).done, true, "and stays finished");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the async iterator ends when the consumer returns", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const iter = ws[Symbol.asyncIterator]();
    const r = await iter.return!();
    assert.equal(r.done, true, "return() completes the iterator");
    assert.equal(ws.state, "CLOSED", "and closes the client");
  } finally {
    restore();
  }
});

await test("messages are delivered to a parked iterator, then drained from the queue", async () => {
  // The queue is capped at `maxBufferSize`; with no consumer the oldest entry
  // is dropped rather than growing without bound.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxBufferSize: 2 });
    void ws.connect();
    FakeWebSocket.last.open();

    // No consumer: messages accumulate, oldest evicted past the cap.
    FakeWebSocket.last.message("one");
    FakeWebSocket.last.message("two");
    FakeWebSocket.last.message("three");
    const iter = ws[Symbol.asyncIterator]();
    assert.equal((await iter.next()).value.data, "two", "the oldest was evicted at the cap");
    assert.equal((await iter.next()).value.data, "three");

    // With a consumer parked, the message goes straight to it.
    const parked = iter.next();
    FakeWebSocket.last.message("four");
    assert.equal((await parked).value.data, "four", "a parked consumer gets it directly");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a throwing message listener does not stop the others", async () => {
  // Listeners are user code, dispatched in order. One that throws must not
  // prevent the correlation check or the remaining listeners.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const seen: string[] = [];
    ws.onMessage(() => {
      throw new Error("listener exploded");
    });
    ws.onMessage((m) => seen.push(String(m.data)));
    FakeWebSocket.last.message("payload");
    assert.deepEqual(seen, ["payload"], "the second listener still ran");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a request whose extract throws rejects rather than resolving undefined", async () => {
  // The correlation resolved the promise with whatever `extract` returned.
  // A throw there has to reject it, or the caller receives `undefined` and
  // treats a broken extractor as an empty reply.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const p = ws.request(
      "ask",
      (m) => m.data === "answer",
      () => {
        throw new Error("extractor exploded");
      },
    );
    FakeWebSocket.last.message("answer");
    await assert.rejects(() => p, /extractor exploded/);
    assert.equal((ws as any)._correlations.size, 0, "the correlation was consumed");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a request with a non-string payload is sent as JSON", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    void ws.request({ q: "search" }, () => false, undefined, 0).catch(() => {});
    assert.deepEqual(sock.sent, ['{"q":"search"}'], "the object payload was JSON-encoded");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a request that is never answered times out", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    await assert.rejects(
      () => ws.request("ask", () => false, undefined, 40),
      (err: unknown) => {
        assert.ok(err instanceof WSError, `got ${String(err)}`);
        assert.match(err.message, /request\(\) timed out after 40ms/);
        return true;
      },
    );
    assert.equal((ws as any)._correlations.size, 0, "the correlation was removed on timeout");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a binary message arrives as an ArrayBuffer and a Blob as bytes", async () => {
  // Node's WebSocket can deliver binary as a Blob even with
  // binaryType="arraybuffer", and other runtimes as a typed-array view. All
  // three must land in `data` as a Uint8Array.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const got: Array<{ data: unknown; bytes: number }> = [];
    ws.onMessage((m) => got.push({ data: m.data, bytes: ws.metrics.bytesReceived }));

    const ab = new Uint8Array([1, 2, 3]).buffer;
    FakeWebSocket.last.message(ab);
    assert.ok(got[0]!.data instanceof Uint8Array, "an ArrayBuffer became a Uint8Array");
    assert.deepEqual(Array.from(got[0]!.data as Uint8Array), [1, 2, 3]);

    FakeWebSocket.last.message(new Blob([new Uint8Array([4, 5])]));
    // The Blob branch awaits `arrayBuffer()` before dispatching, so its
    // message lands a turn after the send.
    await waitUntil(() => got.length >= 2, 2000);
    assert.ok(got[1]!.data instanceof Uint8Array, "a Blob became a Uint8Array");
    assert.deepEqual(Array.from(got[1]!.data as Uint8Array), [4, 5]);

    FakeWebSocket.last.message(new Uint8Array([6, 7, 8, 9]));
    // The Blob branch above awaits `arrayBuffer()`, so give the dispatch a
    // turn before asserting on the final message.
    await waitUntil(() => got.length === 3, 2000);
    assert.equal(got.length, 3, "all three payloads were delivered");
    assert.ok(got[2]!.data instanceof Uint8Array, "a view became a Uint8Array");
    assert.deepEqual(Array.from(got[2]!.data as Uint8Array), [6, 7, 8, 9]);
    assert.equal(ws.metrics.messagesReceived, 3);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a message that is not JSON leaves json undefined", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const seen: Array<{ data: string; json: unknown }> = [];
    ws.onMessage((m) => seen.push({ data: String(m.data), json: m.json }));
    FakeWebSocket.last.message("not json at all");
    assert.equal(seen[0]!.json, undefined, "json stays undefined for a non-JSON payload");
    assert.equal(seen[0]!.data, "not json at all");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a message that is not JSON is still delivered", async () => {
  // The `catch` that guards JSON.parse must not swallow the message: a
  // protocol that sends plain text would otherwise deliver nothing at all.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    const seen: string[] = [];
    ws.onMessage((m) => seen.push(String(m.data)));
    FakeWebSocket.last.message("plain text");
    FakeWebSocket.last.message('{"ok":true}');
    assert.deepEqual(seen, ["plain text", '{"ok":true}'], "both payloads were delivered");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a prototype-polluting payload is sanitised before dispatch", async () => {
  // Remote payloads are untrusted. `__proto__` in the JSON must not reach a
  // listener as an own property that later code can be tricked into reading.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    let captured: unknown;
    ws.onMessage((m) => (captured = m.json));
    FakeWebSocket.last.message('{"__proto__":{"polluted":true},"ok":1}');
    assert.ok(captured && typeof captured === "object", "the payload parsed");
    assert.equal(
      Object.prototype.hasOwnProperty.call(captured, "__proto__"),
      false,
      "__proto__ is not an own property of the delivered object",
    );
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined, "nothing was polluted");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a pong matching a RegExp clears the pending pong timer", async () => {
  // The heartbeat arms a pong timer on every ping. A reply that matches the
  // pong matcher must clear it, or a healthy connection is torn down for
  // "missing" a pong it already sent.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({
      pingIntervalMs: 20,
      pingPayload: "ping",
      pongMatcher: /^pong\b/,
      pongTimeoutMs: 5000,
    });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    await waitUntil(() => (ws as any)._pongTimer !== null, 2000);
    assert.ok(sock.sent.length > 0, "the ping went out");
    assert.ok(
      sock.sent.every((m) => m === "ping"),
      `only pings were sent, got ${JSON.stringify(sock.sent)}`,
    );

    sock.message("pong 42");
    assert.equal((ws as any)._pongTimer, null, "the pong cleared the timer");
    // A non-pong message is delivered normally, and re-arms the timer.
    const seen: string[] = [];
    ws.onMessage((m) => seen.push(String(m.data)));
    sock.message("chatter");
    assert.deepEqual(seen, ["chatter"], "a non-pong message is delivered");
    await waitUntil(() => (ws as any)._pongTimer !== null, 2000);
    assert.ok((ws as any)._pongTimer !== null, "and the next ping re-armed the timer");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a missing pong tears the connection down and reconnects", async () => {
  // The pong timer firing is the last-resort liveness check. It must close
  // the socket and hand off to the reconnect scheduler, not just clear itself.
  const restore = withFakeWebSocket();
  try {
    const reconnects: Array<[number, number]> = [];
    // `pongTimeoutMs` must be shorter than `pingIntervalMs`: the heartbeat
    // re-arms the pong timer on every ping, so a longer pong timeout is
    // re-armed before it can ever fire and the "no pong" branch is
    // unreachable. That is the documented relationship between the two
    // options, and this is the only ordering that exercises the teardown.
    const ws = fakeClient({
      pingIntervalMs: 200,
      pongMatcher: "pong",
      pongTimeoutMs: 30,
      maxReconnects: 2,
      reconnectBaseMs: 20,
      reconnectJitter: 0,
      onReconnect: (n, d) => reconnects.push([n, d]),
    });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    await waitUntil(() => ws.state === "RECONNECTING", 3000);
    assert.ok(
      sock.closeCalls.some(([code, reason]) => code === 4000 && reason === "Pong timeout"),
      `the socket was closed for the missing pong, close calls: ${JSON.stringify(sock.closeCalls)}`,
    );
    assert.deepEqual(reconnects, [[1, 20]], "and a reconnect was scheduled");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the ping interval does not send on a socket that is not open", async () => {
  // The heartbeat is an interval, so it keeps ticking after a drop. Sending
  // on a closed socket throws, and the throw is swallowed — but it must not
  // be counted as a sent message.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ pingIntervalMs: 20, maxReconnects: 0 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    const sentBefore = sock.sent.length;
    sock.readyState = 3; // CLOSING, not OPEN
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sock.sent.length, sentBefore, "nothing was sent on a non-open socket");
    assert.equal(ws.metrics.messagesSent, sentBefore, "and nothing was counted");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a send that throws is reported and does not count as sent", async () => {
  // `_tx` guards the send. On a throw it must not increment `messagesSent`
  // (nothing went out) and must not leave the client believing it is
  // connected to a socket it can no longer write to.
  const restore = withFakeWebSocket();
  try {
    const errors: Error[] = [];
    const ws = fakeClient({ maxReconnects: 0, onError: (e) => errors.push(e) });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    sock.throwOnSend = new Error("send refused");
    ws.send("hello");
    assert.equal(ws.metrics.messagesSent, 0, "nothing was counted as sent");
    assert.equal(errors.length, 1, "onError was told");
    assert.match(errors[0]!.message, /WebSocket send failed: send refused/);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a send that throws closes the socket with the send-error code", async () => {
  // The 4001 close is what lets the server see why the client hung up. With
  // no reconnect budget the client must then be CLOSED, not stuck holding a
  // socket it has already disowned.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxReconnects: 0 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    sock.throwOnSend = new Error("send refused");
    ws.send("hello");
    assert.ok(
      sock.closeCalls.some(([code, reason]) => code === 4001 && reason === "Send error"),
      `the socket was closed for the send error, close calls: ${JSON.stringify(sock.closeCalls)}`,
    );
    assert.equal((ws as any)._ws, null, "the client disowned the socket");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a send that throws with reconnect budget left schedules a reconnect", async () => {
  const restore = withFakeWebSocket();
  try {
    const reconnects: Array<[number, number]> = [];
    const ws = fakeClient({
      maxReconnects: 2,
      reconnectBaseMs: 20,
      reconnectJitter: 0,
      onReconnect: (n, d) => reconnects.push([n, d]),
    });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    sock.throwOnSend = new Error("send refused");
    ws.send("hello");
    assert.equal(ws.state, "RECONNECTING", "it handed off to the reconnect scheduler");
    assert.deepEqual(reconnects, [[1, 20]]);
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the send rate limiter buffers the first send and passes later ones", async () => {
  // The token bucket starts full, so the very first send must go out and only
  // the ones that outrun the refill get buffered. Starting empty would drop
  // the first message of every connection.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxSendRate: 2 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    ws.send("one");
    ws.send("two");
    assert.deepEqual(sock.sent, ["one", "two"], "the first two sends went straight out");
    ws.send("three");
    ws.send("four");
    assert.deepEqual(sock.sent, ["one", "two"], "the next two are rate limited");
    assert.equal(ws.bufferedCount, 2, "and are buffered, not dropped");
    assert.equal(
      ws.backpressure.bufferedBytes,
      "three".length + "four".length,
      "their bytes are counted",
    );
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the send rate limiter refills over time", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ maxSendRate: 10 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    // Drain the bucket.
    for (let i = 0; i < 12; i++) ws.send("x");
    assert.equal(sock.sent.length, 10, "ten went out, two were buffered");
    assert.equal(ws.bufferedCount, 2);
    await new Promise((r) => setTimeout(r, 250)); // ~2.5 tokens at 10/s
    ws.send("y");
    assert.equal(sock.sent.length, 11, "a refilled token let the next send through");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the buffer evicts its oldest entry at maxBufferSize and keeps byte accounting straight", async () => {
  // The high-water mark forces buffering; the cap then evicts. A string and a
  // binary message are both in play, and the byte count must reflect what is
  // actually still queued — otherwise backpressure fires on a buffer that
  // has already shed its payload.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ highWaterMark: 4, lowWaterMark: 2, maxBufferSize: 2 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    // The socket is still CONNECTING, so these are buffered rather than sent.
    ws.send("aaaa"); // 4 bytes, at the mark
    ws.send("bbbb");
    assert.equal(ws.bufferedCount, 2);
    assert.equal(ws.backpressure.bufferedBytes, 8, "eight bytes are queued");
    assert.equal(ws.backpressure.isBackpressured, true, "and the client reports backpressure");
    assert.deepEqual(sock.sent, [], "nothing was sent while connecting");

    ws.send("cc"); // evicts "aaaa" (a string)
    assert.equal(ws.bufferedCount, 2, "the oldest was evicted");
    assert.equal(ws.backpressure.bufferedBytes, 6, "four bytes were credited back");

    ws.sendBinary(new Uint8Array([1, 2, 3, 4, 5, 6])); // evicts "bbbb" (a string)
    assert.equal(ws.backpressure.bufferedBytes, 8, "four credited, six added");

    // Two more sends push the binary down to the oldest slot, so the next
    // eviction has to account for an ArrayBuffer rather than a string. The
    // two branches size the evicted message differently — one encodes the
    // string, the other reads `byteLength` — so a mix in the buffer is the
    // only way to reach both.
    ws.send("dd"); // evicts "cc" (a string)
    assert.equal(ws.backpressure.bufferedBytes, 8, "two credited, two added");
    ws.send("ee"); // evicts the 6-byte binary
    assert.equal(ws.bufferedCount, 2);
    assert.equal(ws.backpressure.bufferedBytes, 4, "a binary eviction is credited by byteLength");

    // The whole point of the buffer: it reaches the socket on open.
    sock.open();
    assert.deepEqual(sock.sent, ["dd", "ee"], "the two survivors were flushed on open");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("drainAndClose force-closes when the drain times out", async () => {
  // The graceful path is "wait for the buffer, then close". If the buffer
  // never drains, drainAndClose must still close — and closing is the whole
  // point of the call, so a hung drain is a leak.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ highWaterMark: 4, lowWaterMark: 2 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    ws.send("aaaa");
    ws.send("bbbb");
    assert.equal(ws.backpressure.isBackpressured, true, "the buffer is over the mark");

    await ws.drainAndClose(40);
    assert.equal(ws.state, "CLOSED", "it closed despite the drain timeout");
    assert.ok(
      sock.closeCalls.length > 0,
      "and the socket was actually closed rather than just detached",
    );
  } finally {
    restore();
  }
});

await test("drain rejects when the socket is already CLOSED", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    ws.destroy();
    await assert.rejects(
      () => ws.drain(10),
      (err: unknown) => {
        assert.ok(err instanceof WSError, `got ${String(err)}`);
        assert.match(err.message, /Cannot drain/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

await test("drain resolves immediately when the buffer is below the low-water mark", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    await ws.drain(0);
    assert.equal(true, true, "it resolved with nothing buffered");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a buffer that drains fires the parked drain waiters", async () => {
  // drain() parks a waiter; the next flush drops the buffer below the mark
  // and must release every one of them, not just the first.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ highWaterMark: 4, lowWaterMark: 2 });
    void ws.connect();
    const sock = FakeWebSocket.last;
    ws.send("aaaa");
    ws.send("bbbb");
    const d1 = ws.drain(2000);
    const d2 = ws.drain(2000);
    assert.equal((ws as any)._drainWaiters.length, 2, "two drain waiters are parked");

    // Opening the socket flushes the buffer, which drops the byte count below
    // the low-water mark and releases the parked waiters.
    sock.open();
    await d1;
    await d2;
    assert.equal((ws as any)._drainWaiters.length, 0, "both were released");
  } finally {
    restore();
  }
});

await test("drainBuffer empties the buffer and fires backpressure transitions", async () => {
  const restore = withFakeWebSocket();
  try {
    const seen: boolean[] = [];
    const ws = fakeClient({
      highWaterMark: 4,
      lowWaterMark: 2,
      onBackpressure: (bp) => seen.push(bp),
    });
    void ws.connect();
    ws.send("aaaa");
    ws.send("bbbb");
    assert.deepEqual(seen, [true], "crossing the high mark reported backpressure");

    const drained = ws.drainBuffer();
    assert.equal(drained.length, 2, "both messages came back");
    assert.equal(ws.bufferedCount, 0);
    assert.equal(ws.backpressure.bufferedBytes, 0, "and the byte count was reset");
    assert.deepEqual(seen, [true, false], "dropping below the mark reported the release");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("the outgoing buffer is flushed to the socket on open", async () => {
  // Messages written while disconnected are the client's whole reason for
  // buffering them. They must reach the socket when it opens, in order, with
  // the byte metrics updated.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ highWaterMark: 4, lowWaterMark: 2 });
    const connectP = ws.connect();
    const sock = FakeWebSocket.last;
    ws.send("early-1");
    ws.send("early-2");
    assert.equal(ws.bufferedCount, 2, "both are buffered while connecting");
    sock.open();
    await connectP;
    assert.deepEqual(sock.sent, ["early-1", "early-2"], "both were flushed in order");
    assert.equal(ws.bufferedCount, 0, "and the buffer is empty");
    assert.equal(ws.metrics.messagesSent, 2, "both were counted");
    assert.equal(ws.metrics.bytesSent, 14, "and their bytes");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("a binary message buffered while disconnected is flushed and counted", async () => {
  // The flush path counts a string by its encoded length and an ArrayBuffer
  // by `byteLength`. Getting that wrong under-counts binary traffic.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient({ highWaterMark: 4, lowWaterMark: 2 });
    const connectP = ws.connect();
    const sock = FakeWebSocket.last;
    ws.sendBinary(new Uint8Array([1, 2, 3, 4, 5, 6]));
    assert.equal(ws.bufferedCount, 1);
    sock.open();
    await connectP;
    assert.equal(sock.sent.length, 1, "the binary message was flushed");
    assert.equal(ws.metrics.bytesSent, 6, "counted by byteLength");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("join and leave send the right frames and ignore duplicates", async () => {
  // `join` is idempotent by design; a second join for the same room must not
  // put a second subscription on the wire or duplicate the tracked entry.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    const sock = FakeWebSocket.last;
    sock.open();
    ws.join("news");
    ws.join("news");
    assert.equal(ws.rooms.length, 1, "the room is tracked once");
    assert.equal(
      sock.sent.filter((m) => String(m).includes("room:join")).length,
      1,
      "and joined once",
    );
    ws.leave("news");
    ws.leave("news");
    assert.equal(ws.rooms.length, 0, "the room is gone");
    assert.equal(
      sock.sent.filter((m) => String(m).includes("room:leave")).length,
      1,
      "and left once",
    );
    ws.destroy();
  } finally {
    restore();
  }
});

await test("connect() called twice while connecting returns the same open promise", async () => {
  // A second connect() must queue on the existing attempt, not open a second
  // socket. Two sockets on one client means two onmessage handlers and
  // doubled metrics.
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    const a = ws.connect();
    const b = ws.connect();
    assert.equal(FakeWebSocket.instances.length, 1, "only one socket was constructed");
    FakeWebSocket.last.open();
    await a;
    await b;
    assert.equal(ws.state, "OPEN");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("connect() on an already-open client resolves without a new socket", async () => {
  const restore = withFakeWebSocket();
  try {
    const ws = fakeClient();
    void ws.connect();
    FakeWebSocket.last.open();
    await ws.connect();
    assert.equal(FakeWebSocket.instances.length, 1, "no second socket was constructed");
    ws.destroy();
  } finally {
    restore();
  }
});

await test("an external abort signal closes the client and is detached afterwards", async () => {
  // A long-lived caller signal must not retain every client ever created:
  // close() detaches the listener. Without that, an abort after close
  // re-enters close() on a dead client.
  const restore = withFakeWebSocket();
  try {
    const ac = new AbortController();
    let closed = 0;
    const ws = fakeClient({ signal: ac.signal, onClose: () => closed++ });
    void ws.connect();
    FakeWebSocket.last.open();
    ac.abort();
    assert.equal(closed, 1, "the abort closed the client once");
    assert.equal(ws.state, "CLOSED");
    assert.equal((ws as any)._externalSignal, null, "the signal reference was released");

    // A second abort must be a no-op now that the listener is detached.
    ac.abort();
    assert.equal(closed, 1, "a second abort does not re-close");
  } finally {
    restore();
  }
});

await test("the browser header path is used only in a browser-like global", async () => {
  // The isBrowser probe reads Deno, Bun, process, window, navigator and
  // document. Under Node every one of those must report "not a browser", or
  // headers would be smuggled into the query string of a real WebSocket URL —
  // where they end up in proxy logs.
  const restore = withFakeWebSocket();
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g["window"];
  const nodeVersion = process.versions.node;
  try {
    // Node: process.versions.node is present, so the probe short-circuits.
    const ws = fakeClient({ headers: { authorization: "Bearer secret" } });
    void ws.connect();
    assert.equal(
      FakeWebSocket.last.url,
      "wss://socket.invalid/ws",
      "the URL is untouched under Node",
    );
    ws.destroy();

    // A Deno/Bun global also rules the browser path out.
    g["Deno"] = { version: { deno: "2.0.0" } };
    try {
      const ws2 = fakeClient({ headers: { authorization: "Bearer secret" } });
      void ws2.connect();
      assert.equal(FakeWebSocket.last.url, "wss://socket.invalid/ws", "Deno is not a browser");
      ws2.destroy();
    } finally {
      delete g["Deno"];
    }

    g["Bun"] = { version: "1.0.0" };
    try {
      const ws3 = fakeClient({ headers: { authorization: "Bearer secret" } });
      void ws3.connect();
      assert.equal(FakeWebSocket.last.url, "wss://socket.invalid/ws", "Bun is not a browser");
      ws3.destroy();
    } finally {
      delete g["Bun"];
    }

    // Now a genuine browser shape: no process.versions.node, and window with
    // navigator and document. The headers must move into the query string,
    // because a browser WebSocket cannot carry them any other way.
    Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });
    g["window"] = { navigator: {}, document: {} };
    try {
      const ws4 = fakeClient({ headers: { authorization: "Bearer secret" } });
      void ws4.connect();
      const u = new URL(FakeWebSocket.last.url);
      assert.equal(u.searchParams.get("authorization"), "Bearer secret", "the header is a param");
      ws4.destroy();

      // A window without document is not a browser either.
      g["window"] = { navigator: {} };
      const ws5 = fakeClient({ headers: { authorization: "Bearer secret" } });
      void ws5.connect();
      assert.equal(
        FakeWebSocket.last.url,
        "wss://socket.invalid/ws",
        "a window with no document is not a browser",
      );
      ws5.destroy();
    } finally {
      if (savedWindow === undefined) delete g["window"];
      else g["window"] = savedWindow;
      // `navigator` and `document` are getter-only globals on globalThis in
      // Node and were never written by this test, so there is nothing to
      // restore — and assigning to them would throw.
      Object.defineProperty(process.versions, "node", {
        value: nodeVersion,
        configurable: true,
      });
    }

    // The real environment is back: a normal client connects untouched.
    const ws6 = fakeClient({ headers: { authorization: "Bearer secret" } });
    void ws6.connect();
    assert.equal(FakeWebSocket.last.url, "wss://socket.invalid/ws", "the probe agrees again");
    ws6.destroy();
  } finally {
    restore();
  }
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures)
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  process.exit(1);
}
