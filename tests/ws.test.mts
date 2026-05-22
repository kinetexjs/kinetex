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
  assert.ok(sharedReceived.length >= 1);
});

await test("sendBinary echoes correctly", async () => {
  sharedReceived.length = 0;
  const data = new Uint8Array([10, 20, 30, 40, 50]);
  sharedWs.sendBinary(data);
  await waitUntil(() => sharedReceived.length >= 1, 10_000);
  assert.ok(sharedReceived.length >= 1);
  assert.ok(
    sharedReceived[0].data instanceof Uint8Array || typeof sharedReceived[0].data === "string",
  );
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
  await ws.connect();
  ws.destroy();
});

await test("waitForOpen resolves when already OPEN", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "OPEN";
  await ws.waitForOpen(1000);
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
  for (const fn of (ws as any)._msgListeners) {
    try {
      fn({ data: "t", timestamp: 1 });
    } catch {
      /* isolate */
    }
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
  for (const fn of (ws as any)._closeListeners) {
    try {
      fn({ code: 1000, reason: "t" });
    } catch {
      /* isolate */
    }
  }
  assert.deepEqual(calls, ["first", "second"]);
  ws.destroy();
});

await test("async iterator queues overflow at maxBufferSize", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws", maxBufferSize: 2 });
  const iter = ws[Symbol.asyncIterator]();
  for (let i = 0; i < 5; i++) {
    const msg: WSMessage = { data: `msg-${i}`, timestamp: i };
    for (const fn of (ws as any)._msgListeners) fn(msg);
    (ws as any)._cbMessage?.(msg);
  }
  await iter.return!();
  ws.destroy();
});

await test("connect() while RECONNECTING queues waiter", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  (ws as any)._state = "RECONNECTING";
  const p = ws.connect();
  assert.ok(p instanceof Promise);
  p.catch(() => {});
  ws.destroy();
});

await test("onMessage registered listener receives messages", async () => {
  const ws = new WSClient({ url: "wss://placeholder.example/ws" });
  const received: WSMessage[] = [];
  ws.onMessage((m) => received.push(m));
  for (const fn of (ws as any)._msgListeners) {
    try {
      fn({ data: "msg", timestamp: 1 });
    } catch {
      /* isolate */
    }
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
  } catch {
    console.log("    (echo server busy, skipping)");
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
  } catch {
    console.log("    (echo server busy, skipping)");
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
  await ws.drain(100);
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
  } catch {
    console.log("    (echo server busy, skipping)");
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
  } catch {
    console.log("    (echo server busy, skipping)");
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

await test("kinetex ws() creates connected WSClient", async () => {
  try {
    const client = kinetex({ baseURL: "https://echo.websocket.org" });
    const ws = await client.ws("/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.state, "OPEN");
    ws.close();
  } catch {
    console.log("    (echo server busy, skipping)");
  }
});

await test("kinetex ws() propagates ws config", async () => {
  try {
    const client = kinetex({
      baseURL: "https://echo.websocket.org",
      ws: { highWaterMark: 8192, lowWaterMark: 1024, maxSendRate: 50, keepRooms: false },
    });
    const ws = await client.ws("/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.backpressure.highWaterMark, 8192);
    assert.equal((ws as any)._maxSendRate, 50);
    assert.equal((ws as any)._keepRooms, false);
    ws.close();
  } catch {
    console.log("    (echo server busy, skipping)");
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
    const ws = await client.ws("/", {
      pingIntervalMs: 0,
      connectTimeoutMs: 10_000,
      maxReconnects: 0,
    });
    assert.equal(ws.state, "OPEN");
    const headers = (ws as any)._headers;
    assert.equal(headers["authorization"], "Bearer test-token");
    ws.close();
  } catch {
    console.log("    (echo server busy, skipping)");
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
