import assert from "node:assert/strict";
import process from "node:process";
import http from "node:http";
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
import { jsonSSE } from "../src/sse.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n\u2500\u2500 ${name}`);
}

function assertDeepEq<T>(a: T, b: T) {
  assert.deepStrictEqual(a, b);
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
  assert.strictEqual(parseSSEText("data: hi\n\n").length, 1);
});

await test("flush incomplete", async () => {
  assert.strictEqual(parseSSEText("data: a\ndata: b").length, 1);
});

// ── SSEServerResponse output via stream reader ──────────────────────────

suite("SSEServerResponse output");

await test("sendJSON produces correct event", async () => {
  const s = new SSEServerResponse();
  s.sendJSON("evt", { x: 1 }, { id: "abc" });
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.ok(value!.includes("event: evt"));
  assert.ok(value!.includes('data: {"x":1}'));
  assert.ok(value!.includes("id: abc"));
  s.close();
});

await test("heartbeat sends comment", async () => {
  const s = new SSEServerResponse();
  s.heartbeat();
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.ok(value!.includes("heartbeat"));
  s.close();
});

await test("setReconnectDelay enqueues retry", async () => {
  const s = new SSEServerResponse();
  s.setReconnectDelay(5000);
  const r = s.stream.getReader();
  const { value } = await r.read();
  assert.ok(value!.includes("retry: 5000"));
  s.close();
});

await test("sendEvent multiline produces two data lines", async () => {
  const s = new SSEServerResponse();
  s.sendEvent("c", "line1\nline2");
  const r = s.stream.getReader();
  const { value } = await r.read();
  const dataLines = value!.split("\n").filter((l) => l.startsWith("data: "));
  assert.strictEqual(dataLines.length, 2);
  assert.ok(dataLines[0]!.includes("line1"));
  assert.ok(dataLines[1]!.includes("line2"));
  s.close();
});

await test("send after close is no-op", async () => {
  const s = new SSEServerResponse();
  s.close();
  s.send("x");
  s.sendEvent("e", "d");
  s.heartbeat();
  s.setReconnectDelay(1000);
  assert.ok(s.closed);
});

// ── SSETransformStream ──────────────────────────────────────────────────

suite("SSETransformStream");

await test("constructs with parser and decoder", async () => {
  const ts = new SSETransformStream();
  assert.ok(ts instanceof TransformStream);
  assert.ok(ts.readable instanceof ReadableStream);
  assert.ok(ts.writable instanceof WritableStream);
});

await test("accepts onParseError option", async () => {
  let called = false;
  const ts = new SSETransformStream({
    onParseError: () => {
      called = true;
    },
  });
  assert.ok(ts instanceof TransformStream);
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
  for await (const e of c.stream()) {
    assert.strictEqual(e.event, "user");
    c.close();
    break;
  }
});

await test("retry from server", async () => {
  const c = new SSEClient({ url: "http://localhost:5630", validateResponse: () => true });
  const evts = await c.collect({ limit: 3 });
  assert.strictEqual(evts[2].retry, 5000);
  c.close();
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
  for await (const e of c.on("user")) {
    assert.strictEqual(e.event, "user");
    c.close();
    break;
  }
});

await test("401 throws SSEError", async () => {
  const c = new SSEClient({ url: "http://localhost:5631", validateResponse: () => true });
  let threw = false;
  try {
    for await (const _ of c.stream()) {
    }
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
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
  assert.ok(!called);
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
  assert.ok(!new SSEServerResponse().closed);
});

await test("send and close", async () => {
  const s = new SSEServerResponse();
  s.send("t");
  s.close();
  assert.ok(s.closed);
});

await test("toResponse returns correct content-type", async () => {
  const res = new SSEServerResponse().toResponse();
  assert.strictEqual(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
});

await test("createSSEResponse handles generator error", async () => {
  const res = createSSEResponse(async (_sse) => {
    throw new Error("gen crash");
  });
  assert.strictEqual(res.status, 200);
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
  const e = new SSEError("msg", 500, null);
  assert.strictEqual(e.name, "SSEError");
  assert.strictEqual(e.status, 500);
  assert.strictEqual(e.message, "msg");
});

await test("SSEMaxReconnectsError properties", async () => {
  const e = new SSEMaxReconnectsError(5, "http://t");
  assert.strictEqual(e.code, "ESSEMAXRECONNECTS");
  assert.strictEqual(e.attempts, 5);
  assert.ok(e.message.includes("5"));
});

// ── Factory functions ───────────────────────────────────────────────────

suite("Factory");

await test("createSSEStream returns async iterable", async () => {
  const s = createSSEStream({ url: "http://localhost:5630", validateResponse: () => true });
  assert.ok(Symbol.asyncIterator in s);
});

await test("createJSONSSEStream returns async iterable", async () => {
  const s = createJSONSSEStream({ url: "http://localhost:5630", validateResponse: () => true });
  assert.ok(Symbol.asyncIterator in s);
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
