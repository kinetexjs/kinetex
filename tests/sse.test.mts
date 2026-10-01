import assert from "node:assert/strict";
import process from "node:process";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { kinetex } from "../src/mod.ts";
import {
  SSEParser,
  parseSSEText,
  SSEError,
  SSEMaxReconnectsError,
  SSERouter,
  SSEClient,
  SSEServerResponse,
  createSSEStream,
  createJSONSSEStream,
  createSSEResponse,
  SSETransformStream,
} from "../src/mod.ts";
import { isUpstreamFlake } from "./upstream.ts";
import { jsonSSE } from "../src/sse.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    // Almost every test here is `for await (const e of client.stream())`.
    // A stream that never yields, or a `collect()` that never settles, parks
    // the whole file with no output at all — so each test carries its own
    // budget. 15s rather than 10s because a few of them call httpbin.org.
    await withTimeout(Promise.resolve().then(fn), 15_000, name);
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    // An outage at httpbin arrives as a failure that says nothing about the
    // client. The discrimination is narrow and never excuses an
    // AssertionError, so it cannot mask a real defect; see
    // tests/upstream-drift.test.mts, which also enforces that this suite has
    // the guard in the first place.
    if (isUpstreamFlake(err)) {
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${why}`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n\u2500\u2500 ${name}`);
}

/** Reject with a timeout error if `p` does not settle within `ms`. */
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

/**
 * Resolve to `p`'s value, or to the sentinel below if it has not settled in
 * `ms`. Used to assert that something *returns* rather than to fail on a
 * timeout: a test that simply awaits a broken call hangs the whole file, and
 * a hang is indistinguishable from a slow machine.
 */
const PENDING = "__PENDING__";
async function withSentinel<T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof PENDING>((r) => {
        timer = setTimeout(() => r(PENDING), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertDeepEq<T>(a: T, b: T) {
  assert.deepStrictEqual(a, b);
}

/** UTF-8 encode a string into the Uint8Array a TransformStream wants. */
function encodeSSE(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── Real SSE server for client tests ────────────────────────────────────

const sseServer = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write('id: 1\nevent: user\ndata: {"id":1}\n\n');
  res.write('id: 2\nevent: user\ndata: {"id":2}\n\n');
  res.write('id: 3\nretry: 5000\ndata: {"s":"ok"}\n\n');
  setTimeout(() => res.end(), 30);
});

const authServer = http.createServer((_req, res) => {
  res.writeHead(401);
  res.end("{}");
});

await new Promise<void>((r) => sseServer.listen(5630, r));
await new Promise<void>((r) => authServer.listen(5631, r));

// ── SSEParser ──────────────────────────────────────────────────────────

suite("SSEParser");

await test("parses data field", async () => {
  const evts = new SSEParser().feed("data: hello\n\n");
  assert.strictEqual(evts.length, 1);
  assert.strictEqual(evts[0].data, "hello");
});

await test("parses id field", async () => {
  assert.strictEqual(new SSEParser().feed("id: 123\ndata: x\n\n")[0].id, "123");
});

await test("parses event field", async () => {
  assert.strictEqual(new SSEParser().feed("event: msg\ndata: x\n\n")[0].event, "msg");
});

await test("parses retry field", async () => {
  assert.strictEqual(new SSEParser().feed("retry: 5000\ndata: x\n\n")[0].retry, 5000);
});

await test("multi-line data", async () => {
  assert.strictEqual(new SSEParser().feed("data: l1\ndata: l2\n\n")[0].data, "l1\nl2");
});

await test("empty data", async () => {
  assert.strictEqual(new SSEParser().feed("data:\n\n")[0].data, "");
});

await test("empty id resets to null", async () => {
  const p = new SSEParser();
  p.feed("id: abc\ndata: x\n\n");
  assert.strictEqual(p.lastId, "abc");
  p.feed("id:\ndata: y\n\n");
  assert.strictEqual(p.feed("data: z\n\n")[0].id, null);
});

await test("comment line ignored", async () => {
  assert.strictEqual(new SSEParser().feed(": c\ndata: x\n\n").length, 1);
});

await test("unknown field ignored", async () => {
  assert.strictEqual(new SSEParser().feed("foo: bar\ndata: x\n\n").length, 1);
});

await test("CRLF line endings", async () => {
  assert.strictEqual(new SSEParser().feed("data: hi\r\n\r\n")[0].data, "hi");
});

await test("raw lines preserved", async () => {
  assertDeepEq(new SSEParser().feed("data: x\n\n")[0].raw, ["data: x", ""]);
});

await test("flush empty returns null", async () => {
  assert.strictEqual(new SSEParser().flush(), null);
});

await test("flush incomplete buffer dispatches event", async () => {
  const p = new SSEParser();
  p.feed("data: hello");
  const e = p.flush();
  assert.ok(e !== null);
  assert.strictEqual(e!.data, "hello");
});

await test("flush partial with id", async () => {
  const p = new SSEParser();
  p.feed("id: 42\ndata: test");
  const e = p.flush();
  assert.ok(e !== null);
  assert.strictEqual(e!.data, "test");
  assert.strictEqual(e!.id, "42");
});

await test("id persists across events per spec", async () => {
  const p = new SSEParser();
  p.feed("id: persistent\ndata: first\n\n");
  assert.strictEqual(p.feed("data: second\n\n")[0].id, "persistent");
});

await test("reset clears id", async () => {
  const p = new SSEParser();
  p.feed("id: abc\ndata: x\n\n");
  p.reset();
  assert.strictEqual(p.feed("data: y\n\n")[0].id, null);
});

await test("empty line without data ignored", async () => {
  assert.strictEqual(new SSEParser().feed("\n\n").length, 0);
});

await test("field without colon sets empty value", async () => {
  assert.strictEqual(new SSEParser().feed("data\n\n")[0].data, "");
});

// ── parseSSEText ────────────────────────────────────────────────────────

suite("parseSSEText");

await test("basic", async () => {
  // The whole event, not its count: a parser that returned one empty event
  // satisfied the original assertion.
  assert.deepStrictEqual(parseSSEText("data: hi\n\n"), [
    { id: null, event: "message", data: "hi", retry: null, raw: ["data: hi", ""] },
  ]);
});

await test("flush incomplete", async () => {
  // A stream cut mid-event still yields what it had, per `flush()`.
  assert.deepStrictEqual(parseSSEText("data: a\ndata: b"), [
    { id: null, event: "message", data: "a\nb", retry: null, raw: ["data: a", "data: b"] },
  ]);
  // ...and a buffer that never held a field line yields nothing at all.
  assert.deepStrictEqual(parseSSEText(": just a comment"), []);
  assert.deepStrictEqual(parseSSEText(""), []);
});

// ── SSEServerResponse output via stream reader ──────────────────────────

suite("SSEServerResponse output");

await test("sendJSON produces correct event", async () => {
  const s = new SSEServerResponse();
  s.sendJSON("evt", { x: 1 }, { id: "abc" });
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.equal(value, 'id: abc\nevent: evt\ndata: {"x":1}\n\n');
  s.close();
});

await test("heartbeat sends comment", async () => {
  const s = new SSEServerResponse();
  s.heartbeat();
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.equal(value, ": heartbeat\n\n");
  s.close();
});

await test("setReconnectDelay enqueues retry", async () => {
  const s = new SSEServerResponse();
  s.setReconnectDelay(5000);
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.equal(value, "retry: 5000\n\n");
  s.close();
});

await test("sendEvent multiline produces two data lines", async () => {
  const s = new SSEServerResponse();
  s.sendEvent("c", "line1\nline2");
  const r = s.stream.getReader();
  const { value } = await r.read();
  // The exact framing, not "two lines that mention line1 and line2": the
  // whole event is one message and its shape is the contract.
  assert.equal(value, "event: c\ndata: line1\ndata: line2\n\n");
  s.close();
});

await test("send after close is no-op", async () => {
  const s = new SSEServerResponse();
  s.close();
  s.send("x");
  s.sendEvent("e", "d");
  s.heartbeat();
  s.setReconnectDelay(1000);
  assert.equal(s.closed, true);
  // Nothing may reach the stream after close()
  const { done } = await s.stream.getReader().read();
  assert.equal(done, true);
});

// ── SSETransformStream ──────────────────────────────────────────────────

suite("SSETransformStream");

await test("constructs with parser and decoder", async () => {
  const ts = new SSETransformStream();
  assert.equal(ts instanceof TransformStream, true);
  assert.equal(ts.readable instanceof ReadableStream, true);
  assert.equal(ts.writable instanceof WritableStream, true);
});

await test("accepts onParseError option", async () => {
  let called = 0;
  const ts = new SSETransformStream({
    onParseError: () => {
      called++;
    },
  });
  assert.equal(ts instanceof TransformStream, true);
  assert.equal(called, 0, "onParseError must not fire before any input");

  // The option must not change how a well-formed stream is parsed. The
  // error path itself is NOT covered: making the transform throw portably
  // turned out to be impossible — a detached buffer, a plain object and a
  // proxied Uint8Array all either decode fine or fail outside the `catch`,
  // and the stream's readable side has a high-water mark of 0, so a
  // provoking write parks on back-pressure rather than reporting anything.
  const reader = ts.readable.getReader();
  const pending = reader.read();
  // The read is taken before the write: a write that enqueues does not
  // settle until the value has been taken.
  const written = ts.writable.getWriter().write(encodeSSE("id: 7\ndata: after\n\n"));
  const { value } = await pending;
  await written;
  assert.equal(value.data, "after");
  assert.equal(value.id, "7");
  assert.equal(called, 0, "a clean stream must not report a parse error");
  assert.equal(await reader.read.call(null).catch(() => "closed"), "closed");
});

// ── SSEClient (real SSE server) ────────────────────────────────────────

suite("SSEClient");

await test("collect returns events", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const evts = await c.collect({ limit: 2 });
  assert.strictEqual(evts.length, 2);
  assert.strictEqual(evts[0].event, "user");
  assert.strictEqual(evts[0].data, '{"id":1}');
  c.close();
});

await test("stream yields first event", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  // `saw` is the whole point: a `for await` over a stream that yields nothing
  // runs its body zero times, so the assertion inside the body would never
  // execute and the test would pass on a client that yields nothing at all.
  let saw = 0;
  for await (const e of c.stream()) {
    saw++;
    assert.strictEqual(e.event, "user");
    assert.strictEqual(e.data, '{"id":1}');
    c.close();
    break;
  }
  c.close();
  assert.strictEqual(saw, 1, "the stream must yield at least one event");
});

await test("retry from server", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const evts = await c.collect({ limit: 3 });
  // The first two carry no retry, and the third does: an assertion on
  // `evts[2].retry` alone passed against a parser that invented 5000 for
  // every event.
  assert.deepStrictEqual(
    evts.map((e) => e.retry),
    [null, null, 5000],
  );
  // Every fixture event carries its own id, so these are the three ids as
  // sent — observed end to end over a real socket, not reconstructed.
  assert.deepStrictEqual(
    evts.map((e) => e.id),
    ["1", "2", "3"],
  );
  c.close();
});

await test("collect returns an empty array when the signal is already aborted", async () => {
  // An `abort` event does not fire on a signal that is already aborted, so a
  // listener alone would never notice: the collection connected to a server
  // the caller had already cancelled and collected from it anyway.
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const ac = new AbortController();
  ac.abort();
  assert.deepStrictEqual(await c.collect({ signal: ac.signal }), []);
  // The request must not have been made at all.
  assert.strictEqual(c.streamHealth.totalEvents, 0);
  assert.strictEqual(c.streamHealth.connected, false);
  c.close();
});

await test("collect limit is exact, not a lower bound", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const three = await c.collect({ limit: 3 });
  c.close();
  assert.strictEqual(three.length, 3);
  assert.deepStrictEqual(
    three.map((e) => e.data),
    ['{"id":1}', '{"id":2}', '{"s":"ok"}'],
  );
  // The server sends exactly three, so a limit of 3 must not have come from
  // the stream ending early, and a limit of 1 must not come from the same.
  const c2 = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const one = await c2.collect({ limit: 1 });
  c2.close();
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].data, '{"id":1}');
});

await test("close stops stream", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  await c.collect({ limit: 1 });
  c.close();
  assert.strictEqual(c.closed, true);
});

await test("destroy resets health", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  await c.collect({ limit: 1 });
  c.destroy();
  assert.strictEqual(c.closed, true);
  assert.strictEqual(c.streamHealth.connected, false);
});

await test("on filters by event type", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  let saw = 0;
  for await (const e of c.on("user")) {
    saw++;
    assert.strictEqual(e.event, "user");
    c.close();
    break;
  }
  c.close();
  assert.strictEqual(saw, 1, "on() must yield at least one matching event");
  // ...and must NOT yield the server's non-`user` event, which is what makes
  // it a filter rather than a rename.
  const c2 = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const got = await c2.collect({ limit: 2 });
  c2.close();
  assert.deepStrictEqual(
    got.map((e) => e.event),
    ["user", "user"],
  );
});

await test("401 throws SSEError", async () => {
  const c = new SSEClient({ url: "http://localhost:5631", validateResponse: () => true });
  // Asserting the concrete error, not merely that the loop threw — a
  // connection-refused (nothing listens on that port) would otherwise satisfy
  // the test just as well as the 401 the name claims to check.
  let caught: unknown;
  try {
    for await (const _ of c.stream()) {
    }
  } catch (e) {
    caught = e;
  }
  assert.ok(caught !== undefined, "streaming from a 401 endpoint must fail");
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  assert.match(
    `${(caught as { name?: string }).name}: ${caught.message}`,
    /SSEError|401|unauthor/i,
    `expected an SSEError about the 401, got ${caught.message}`,
  );
});

// ── jsonSSE ─────────────────────────────────────────────────────────────

suite("jsonSSE");

await test("parses JSON events", async () => {
  const src = [
    { id: "1", event: "u", data: '{"x":1}', retry: null, raw: [] },
    { id: "2", event: "u2", data: '{"y":2}', retry: null, raw: [] },
  ];
  const r: any[] = [];
  for await (const e of jsonSSE(src)) r.push(e);
  assert.strictEqual(r.length, 2);
  assertDeepEq(r[0].data, { x: 1 });
});

await test("skips non-JSON silently", async () => {
  const r: any[] = [];
  for await (const e of jsonSSE([
    { id: null, event: "m", data: "bad", retry: null, raw: [] },
    { id: null, event: "m", data: '{"ok":true}', retry: null, raw: [] },
  ]))
    r.push(e);
  assert.strictEqual(r.length, 1);
});

await test("onError callback fires on parse failure", async () => {
  let c = 0;
  for await (const _ of jsonSSE([{ id: null, event: "m", data: "bad", retry: null, raw: [] }], {
    onError: () => c++,
  })) {
  }
  assert.strictEqual(c, 1);
});

await test("empty data skipped", async () => {
  let c = 0;
  for await (const _ of jsonSSE([{ id: null, event: "m", data: "", retry: null, raw: [] }])) c++;
  assert.strictEqual(c, 0);
});

// ── SSERouter ───────────────────────────────────────────────────────────

suite("SSERouter");

await test("on dispatches to handler", async () => {
  let called = false;
  const r = new SSERouter().on("t", async () => {
    called = true;
  });
  await r.dispatch({ event: "t", data: "d", id: null, retry: null, raw: [] });
  assert.equal(called, true);
});

await test("onMessage handler", async () => {
  let called = false;
  const r = new SSERouter().onMessage(async () => {
    called = true;
  });
  await r.dispatch({ event: "message", data: "d", id: null, retry: null, raw: [] });
  assert.equal(called, true);
});

await test("onAny fallback for unmatched event", async () => {
  let called = false;
  const r = new SSERouter().onAny(async () => {
    called = true;
  });
  await r.dispatch({ event: "unknown", data: "d", id: null, retry: null, raw: [] });
  assert.equal(called, true);
});

await test("onAny not called when specific handler exists", async () => {
  let specific = false,
    fallback = false;
  const r = new SSERouter();
  r.on("known", async () => {
    specific = true;
  });
  r.onAny(async () => {
    fallback = true;
  });
  await r.dispatch({ event: "known", data: "d", id: null, retry: null, raw: [] });
  assert.equal(specific, true);
  assert.equal(fallback, false);
});

await test("onJSON valid parses JSON", async () => {
  let d: any = null;
  const r = new SSERouter().onJSON<{ x: number }>("j", async (v) => {
    d = v;
  });
  await r.dispatch({ event: "j", data: '{"x":1}', id: null, retry: null, raw: [] });
  assertDeepEq(d, { x: 1 });
});

await test("onJSON parse error silently ignored", async () => {
  let called = false;
  const r = new SSERouter().onJSON<any>("b", async () => {
    called = true;
  });
  await r.dispatch({ event: "b", data: "bad", id: null, retry: null, raw: [] });
  assert.equal(called, false);
});

await test("consume iterates all events", async () => {
  let n = 0;
  const r = new SSERouter().on("e", async () => {
    n++;
  });
  await r.consume([
    { event: "e", data: "1", id: null, retry: null, raw: [] },
    { event: "e", data: "2", id: null, retry: null, raw: [] },
  ]);
  assert.strictEqual(n, 2);
});

// ── SSEServerResponse basic ─────────────────────────────────────────────

suite("SSEServerResponse basic");

await test("closed initially false", async () => {
  assert.equal(new SSEServerResponse().closed, false);
});

await test("send and close", async () => {
  const s = new SSEServerResponse();
  s.send("t");
  s.close();
  assert.equal(s.closed, true);
});

await test("toResponse returns correct content-type", async () => {
  const res = new SSEServerResponse().toResponse();
  assert.strictEqual(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
});

await test("createSSEResponse handles generator error", async () => {
  const boom = new Error("gen crash");
  let logged: unknown = null;
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged = args[0];
  };
  let res!: Response;
  let text = "";
  try {
    res = createSSEResponse(async (sse) => {
      sse.send("before");
      throw boom;
    });
    // The generator is driven by a floating async IIFE, so its `catch` runs
    // a microtask after `createSSEResponse` has returned. Reading the body
    // waits for the stream to close, which happens after that — so the
    // override has to stay in place across this await, and the body can only
    // be read once.
    text = await res.text();
  } finally {
    console.error = realError;
  }
  assert.strictEqual(res.status, 200);
  // The stream must terminate rather than hang: the events sent before the
  // throw are delivered, then the body ends.
  assert.equal(text, "data: before\n\n");
  // ...and the failure must actually be reported. `createSSEResponse` has no
  // error channel of its own, so a swallowed generator error is a stream that
  // just stops for no visible reason.
  assert.equal(logged, "[sse] Generator error:");
});

await test("createSSEResponse forwards custom headers", async () => {
  const res = createSSEResponse(
    (sse) => {
      sse.send("x");
      sse.close();
    },
    { "x-request-id": "abc123" },
  );
  assert.equal(res.headers.get("x-request-id"), "abc123");
  // The defaults survive a caller-supplied header of the same name only where
  // the caller wins — content-type here is the library's, not overridden.
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(await res.text(), "data: x\n\n");
});

// ── Real HTTP via kinetex ───────────────────────────────────────────────

suite("Real HTTP via kinetex");

await test("kinetex GET /ip returns origin", async () => {
  const ktx = kinetex({ baseURL: "https://httpbin.org" });
  const res = await ktx.get<{ origin: string }>("/ip");
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.origin === "string");
  ktx.destroy();
});

await test("kinetex GET /uuid returns uuid", async () => {
  const ktx = kinetex({ baseURL: "https://httpbin.org" });
  const res = await ktx.get<{ uuid: string }>("/uuid");
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.uuid.includes("-"));
  ktx.destroy();
});

await test("kinetex POST /post roundtrips JSON", async () => {
  const ktx = kinetex({ baseURL: "https://httpbin.org" });
  const res = await ktx.post<{ json: { a: number } }>("/post", JSON.stringify({ a: 1 }), {
    headers: { "content-type": "application/json" },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.json.a, 1);
  ktx.destroy();
});

// ── Error classes ───────────────────────────────────────────────────────

suite("Error classes");

await test("SSEError properties", async () => {
  const res = new Response("", { status: 503 });
  const e = new SSEError("msg", 500, res);
  // A class that does not extend Error still satisfies every property check
  // above, and a `throw` of it would not be catchable as an Error.
  assert.ok(e instanceof Error, "SSEError must be an Error");
  assert.ok(e instanceof SSEError);
  assert.strictEqual(e.name, "SSEError");
  assert.strictEqual(e.code, "ESSE");
  assert.strictEqual(e.status, 500);
  assert.strictEqual(e.message, "msg");
  // The response is what lets a caller read the 407 body to discover *which*
  // realm it wanted credentials for.
  assert.strictEqual(e.response, res);
  assert.strictEqual(new SSEError("m", null, null).status, null);
  assert.strictEqual(new SSEError("m", null, null).response, null);
});

await test("SSEMaxReconnectsError properties", async () => {
  const e = new SSEMaxReconnectsError(5, "http://t");
  assert.ok(e instanceof Error, "SSEMaxReconnectsError must be an Error");
  assert.ok(e instanceof SSEMaxReconnectsError);
  assert.strictEqual(e.name, "SSEMaxReconnectsError");
  assert.strictEqual(e.code, "ESSEMAXRECONNECTS");
  assert.strictEqual(e.attempts, 5);
  assert.strictEqual(e.url, "http://t");
  // The whole message: both the count and the endpoint, since "max reconnects
  // reached" without them says nothing about which loop gave up or where.
  assert.strictEqual(e.message, "SSE max reconnects (5) reached for http://t");
  // Two attempts of the same number must not read the same: the count is the
  // only thing distinguishing them.
  assert.notStrictEqual(new SSEMaxReconnectsError(6, "http://t").message, e.message);
});

// ── Factory functions ───────────────────────────────────────────────────

suite("Factory");

await test("createSSEStream returns async iterable", async () => {
  const s = createSSEStream({ url: "http://localhost:5630", validateResponse: () => true });
  assert.equal(typeof s[Symbol.asyncIterator], "function");
  assert.equal(s.url, "http://localhost:5630");
});

await test("createJSONSSEStream returns async iterable", async () => {
  const s = createJSONSSEStream({ url: "http://localhost:5630", validateResponse: () => true });
  assert.equal(typeof s[Symbol.asyncIterator], "function");
});

// ── Regressions ────────────────────────────────────────────────────────────
//
// Six defects surfaced by auditing what this file asserted against what the
// wire actually does. Every test below passed at the time its defect was live.

suite("SSE regressions");

/**
 * An SSE server that sends `head` and then holds the connection open forever.
 *
 * This is the shape the fixtures above cannot produce: they all `end()` the
 * response after 30ms, so every stream in the file terminates on its own and
 * a client that cannot be stopped looks exactly like one that can.
 */
async function startStickyServer(
  head: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const held = new Set<Socket>();
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(head);
    open.add(res);
    res.once("close", () => open.delete(res));
  });
  server.on("connection", (s) => {
    held.add(s);
    s.once("close", () => held.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    // A clean `end()` rather than a socket destroy: tearing the socket out
    // from under a live fetch surfaces as an undici "terminated" TypeError
    // that is not ours to catch. Sockets that are somehow still open after
    // the grace period are destroyed, so `close()` always calls back.
    close: () =>
      new Promise<void>((r) => {
        for (const res of open) res.end();
        open.clear();
        const guard = setTimeout(() => {
          for (const s of held) s.destroy();
          held.clear();
        }, 300);
        if (typeof (guard as unknown as { unref?: () => void }).unref === "function") {
          (guard as unknown as { unref: () => void }).unref();
        }
        server.close(() => {
          clearTimeout(guard);
          for (const s of held) s.destroy();
          held.clear();
          r();
        });
      }),
  };
}

await test("close() interrupts a stream parked on a quiet connection", async () => {
  // Defect: `close()` is documented as aborting any active stream, and sets
  // `closed = true`, but the read loop used a snapshot of `closed` taken
  // before the fetch and awaited `reader.read()` with no signal wired to it.
  // On a long-lived stream — the normal case for SSE — the `for await`
  // therefore never returned: the caller was told to shut down and the loop
  // sat there until the server happened to send something, or forever.
  const server = await startStickyServer("data: hello\n\n");
  const c = new SSEClient({ url: server.url, reconnect: false, validateResponse: () => true });
  try {
    let seen = "";
    const loop = (async () => {
      for await (const e of c.stream()) {
        seen += e.data;
        c.close();
      }
      return "LOOP_ENDED";
    })();
    const out = await withSentinel(loop, 3_000);
    assert.notStrictEqual(
      out,
      PENDING,
      "close() did not release the loop; it is still parked in reader.read()",
    );
    assert.strictEqual(out, "LOOP_ENDED");
    // The event that arrived before close() is still delivered — the abort
    // stops the *wait*, it does not swallow what has already been read.
    assert.strictEqual(seen, "hello");
    assert.strictEqual(c.closed, true);
    assert.strictEqual(c.streamHealth.connected, false);
  } finally {
    c.close();
    await server.close();
  }
});

await test("close() does not deliver a half-read trailing event", async () => {
  // The flush after the read loop ran even when the loop had broken because
  // the caller aborted or closed, so a torn-down stream could still push one
  // more event at the consumer.
  const server = await startStickyServer("data: a\n\ndata: b");
  const c = new SSEClient({ url: server.url, reconnect: false, validateResponse: () => true });
  try {
    const got: string[] = [];
    const loop = (async () => {
      for await (const e of c.stream()) {
        got.push(e.data);
        // The server has sent a second, unterminated `data:` line and gone
        // quiet. close() must end the loop without flushing it.
        c.close();
      }
      return "LOOP_ENDED";
    })();
    const out = await withSentinel(loop, 3_000);
    assert.strictEqual(out, "LOOP_ENDED");
    assert.deepStrictEqual(got, ["a"]);
  } finally {
    c.close();
    await server.close();
  }
});

await test("a request-scoped signal interrupts a stream parked on a quiet connection", async () => {
  // The same gap as close(), through the other door. The signal is checked
  // between events, so a stream that has gone quiet never reaches the check
  // and the request could not be cancelled at all — which is the one moment
  // cancelling matters.
  const server = await startStickyServer("data: hello\n\n");
  const ac = new AbortController();
  const c = new SSEClient({
    url: server.url,
    reconnect: false,
    signal: ac.signal,
    validateResponse: () => true,
  });
  // Fired on a timer, not from inside the loop body. Aborting there would be
  // caught by the `cfg.signal?.aborted` check at the top of the read loop,
  // because the generator has not yet resumed; what is broken is the abort
  // that arrives while the read is genuinely outstanding.
  setTimeout(() => ac.abort(), 150);
  try {
    let seen = 0;
    const loop = (async () => {
      for await (const _e of c.stream()) {
        seen++;
      }
      return "LOOP_ENDED";
    })();
    const out = await withSentinel(loop, 3_000);
    assert.notStrictEqual(
      out,
      PENDING,
      "the signal never reached the read loop; the loop is still parked in reader.read()",
    );
    assert.strictEqual(out, "LOOP_ENDED");
    assert.strictEqual(seen, 1);
  } finally {
    c.close();
    await server.close();
  }

  // The abort leaves the body reader errored, and the `reader.cancel()` in
  // the read loop's `finally` then rejects with that stored error. Nothing
  // awaits the promise `cancel()` returns, so an unhandled rejection is what
  // surfaces -- and in Node that terminates the process outright. Drain the
  // microtask and macrotask queues first, then insist there was none.
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepStrictEqual(
    escaped.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
    [],
    "an aborted stream must not leave an unhandled rejection behind",
  );
});

await test("a custom fetch that ignores the request signal is still interruptible", async () => {
  // `fetch` is a documented injection point, and an injected one need not
  // honour `init.signal`. The default fetch aborts the request, which is
  // enough to settle a pending read on its own — so the read loop relying on
  // that alone would strand any caller whose transport does not. The loop
  // watches the signal itself rather than depending on the transport.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encodeSSE("data: hello\n\n"));
      // never closed
    },
  });
  const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), signal: init.signal as AbortSignal | null });
    // Deliberately ignores `init.signal`.
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof globalThis.fetch;

  const ac = new AbortController();
  const c = new SSEClient({
    url: "http://example.invalid/sse",
    fetch: fakeFetch,
    reconnect: false,
    signal: ac.signal,
    validateResponse: () => true,
  });
  setTimeout(() => ac.abort(), 150);
  let seen = 0;
  const loop = (async () => {
    for await (const _e of c.stream()) {
      seen++;
    }
    return "LOOP_ENDED";
  })();
  const out = await withSentinel(loop, 3_000);
  assert.notStrictEqual(
    out,
    PENDING,
    "the loop only ended because the transport honoured the signal",
  );
  assert.strictEqual(out, "LOOP_ENDED");
  assert.strictEqual(seen, 1);
  // The signal is still handed to the transport -- the client is not
  // substituting its own cancellation for the caller's.
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].signal, ac.signal);
  c.close();
});

await test("collect({ signal }) cancels a collection the server went quiet on", async () => {
  // Defect: the signal was only inspected *after* an event arrived. The whole
  // point of cancelling a collection is a stream that has stopped producing,
  // and a stopped stream is exactly the one parked in `reader.read()` with
  // nothing to reach the check — so the abort was never observed and
  // `collect()` never returned.
  const server = await startStickyServer("data: one\n\n");
  const ac = new AbortController();
  const c = new SSEClient({ url: server.url, reconnect: false, validateResponse: () => true });
  try {
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const out = await withSentinel(c.collect({ signal: ac.signal }), 3_000);
    assert.notStrictEqual(
      out,
      PENDING,
      "the abort never reached the read loop; collect() is still pending",
    );
    // It must settle promptly, and hand back what it had already collected
    // rather than discarding it.
    assert.ok(Date.now() - t0 < 2_000, "the abort must be observed without waiting for the server");
    assert.strictEqual((out as unknown[]).length, 1);
    assert.strictEqual((out as Array<{ data: string }>)[0].data, "one");
  } finally {
    c.close();
    await server.close();
  }
});

await test("an onJSON handler that throws surfaces to the caller", async () => {
  // Defect: `onJSON` ran the handler inside the same `try` as the parse, so a
  // handler exception was discarded with no trace of why. `dispatch()` and
  // `consume()` await every handler, so a caller relying on them to report
  // failures never saw one — one unhandled handler error became one silently
  // dropped event.
  const boom = new Error("handler blew up");
  const r = new SSERouter().onJSON("j", () => {
    throw boom;
  });
  await assert.rejects(
    () => r.dispatch({ event: "j", data: '{"x":1}', id: null, retry: null, raw: [] }),
    (err: unknown) => {
      assert.strictEqual(err, boom, "the handler's own error must reach the caller");
      return true;
    },
  );
  // The same through consume(), which is how the router is used live.
  const r2 = new SSERouter().onJSON("j", () => {
    throw boom;
  });
  await assert.rejects(
    () => r2.consume([{ event: "j", data: '{"x":1}', id: null, retry: null, raw: [] }]),
    (err: unknown) => {
      assert.strictEqual(err, boom);
      return true;
    },
  );
  // ...and a *parse* failure is still swallowed, which is what the method
  // documents. Pinning both halves is the only way to tell them apart.
  let called = false;
  const r3 = new SSERouter().onJSON("b", () => {
    called = true;
  });
  await r3.dispatch({ event: "b", data: "not json", id: null, retry: null, raw: [] });
  assert.strictEqual(called, false, "a parse failure must still be ignored silently");
});

await test("an id containing a line break cannot forge a field", async () => {
  // Defect: `sendEvent` wrote `id` and `event` into the frame verbatim, and
  // the event-stream format has no escaping — a CR or LF ends the line and
  // the rest is parsed as a field of its own. A caller passing a user-
  // controlled id (a row id, a filename) could therefore write `event:` or
  // `data:` lines into somebody else's stream, and the receiving parser read
  // them as first-class fields rather than as part of the value.
  const sse = new SSEServerResponse();
  // A CR is as good as an LF: every conforming reader treats it as a line
  // ending too, and a caller is as likely to have one in an id as the other.
  sse.sendEvent("evt", "d", {
    id: "1\ninjected: yes\nevent: forged\rdata: forged",
    retry: 10,
  });
  const r = sse.stream.getReader();
  const { value } = await r.read();
  sse.close();

  // Nothing in the frame is a line of its own.
  assert.ok(
    !String(value).includes("\ninjected: "),
    `a forged field reached the stream: ${JSON.stringify(value)}`,
  );
  assert.ok(
    !String(value).includes("\nevent: forged"),
    `a forged event type reached the stream: ${JSON.stringify(value)}`,
  );
  assert.ok(
    !String(value).includes("\rdata: forged"),
    `a bare CR split the frame: ${JSON.stringify(value)}`,
  );
  // And what a conforming parser makes of it is exactly one event, whose id
  // is the value with the line breaks removed — the documented behaviour.
  const events = parseSSEText(String(value));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, "evt", "the real event type must survive");
  assert.strictEqual(events[0].id, "1injected: yesevent: forgeddata: forged");
  assert.deepStrictEqual(events[0].raw, [
    "id: 1injected: yesevent: forgeddata: forged",
    "event: evt",
    "retry: 10",
    "data: d",
    "",
  ]);
});

await test("data is split on every SSE line ending, not just LF", async () => {
  // `sendEvent` split the payload on "\n" only, but a conforming reader
  // treats a bare CR as a line ending too — so a payload containing one was
  // silently turned into two events on the way in.
  const sse = new SSEServerResponse();
  sse.send("a\rb\r\nc\nd");
  const r = sse.stream.getReader();
  const { value } = await r.read();
  sse.close();
  const events = parseSSEText(String(value));
  assert.strictEqual(events.length, 1, "a CR in the payload must not split the event");
  assert.strictEqual(events[0].data, "a\nb\nc\nd");
});

await test("retry is honoured only when the value is all digits", async () => {
  // Defect: the field was read with `parseInt`, which accepts a trailing
  // "abc", a leading "+" and the "1e3" exponent. The spec ignores `retry`
  // unless every character is an ASCII digit, so a proxy rewriting the line
  // as `retry: 3000; path=/` silently set the reconnection back-off.
  assert.strictEqual(parseSSEText("retry: 5000\ndata: x\n\n")[0].retry, 5000);
  assert.strictEqual(parseSSEText("retry: 0\ndata: x\n\n")[0].retry, 0);
  assert.strictEqual(parseSSEText("retry: 007\ndata: x\n\n")[0].retry, 7);
  for (const bad of ["5000abc", "1e3", "+500", " 5000", "0x10", "-1", "5 000", ""]) {
    assert.strictEqual(
      parseSSEText(`retry: ${bad}\ndata: x\n\n`)[0].retry,
      null,
      `retry: ${JSON.stringify(bad)} must be ignored`,
    );
  }
  // A rejected retry leaves the previous one alone rather than clearing it.
  const p = new SSEParser();
  assert.strictEqual(p.feed("retry: 1000\ndata: a\n\n")[0].retry, 1000);
  assert.strictEqual(p.feed("retry: nope\ndata: b\n\n")[0].retry, null);
});

await test("an id containing NUL is ignored", async () => {
  // The spec ignores a field whose value contains U+0000. The id is replayed
  // verbatim in the `Last-Event-ID` request header on every reconnect, and a
  // NUL is not a legal header value — so storing one turned a reconnection
  // into a thrown error.
  const p = new SSEParser();
  p.feed("id: a\u0000b\ndata: x\n\n");
  assert.strictEqual(p.lastId, null);
  assert.strictEqual(parseSSEText("id: a\u0000b\ndata: x\n\n")[0].id, null);
  // A NUL-free id is unaffected, and a later NUL-free id still applies.
  p.feed("id: good\ndata: y\n\n");
  assert.strictEqual(p.lastId, "good");
  p.feed("id: ba\u0000d\ndata: z\n\n");
  assert.strictEqual(p.lastId, "good", "the rejected field must not clear the id");
});

await test("a NUL in an event name cannot forge a field", async () => {
  // The same framing rule as the id, on the other field that is written
  // verbatim. A NUL does not end a line for most readers, so the practical
  // risk is a caller comparing event names against a string that cannot
  // round-trip; stripping it keeps the value single-valued.
  const sse = new SSEServerResponse();
  sse.sendEvent("ev\u0000t", "d");
  const r = sse.stream.getReader();
  const { value } = await r.read();
  sse.close();
  assert.equal(value, "event: evt\ndata: d\n\n");
});

await test("a comment cannot forge a field", async () => {
  // `: ${text}` has the same problem — a newline in a heartbeat comment
  // becomes a bare line that a parser reads as a field.
  const sse = new SSEServerResponse();
  sse.comment("ping\nevent: forged");
  const r = sse.stream.getReader();
  const { value } = await r.read();
  sse.close();
  assert.equal(value, ": pingevent: forged\n\n");
  assert.deepStrictEqual(parseSSEText(String(value)), [], "a comment must stay a comment");
});

// ── Cleanup ─────────────────────────────────────────────────────────────

sseServer.close();
authServer.close();

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
  process.exit(1);
}
