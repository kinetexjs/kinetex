import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import {
  ConsoleTransport,
  createDevelopmentLogger,
  createLogger,
  createProductionLogger,
  HTTPLogger,
  JSONTransport,
  LogLevel,
  MultiTransport,
  Redactor,
  RemoteTransport,
  BatchingTransport,
  toOTelSpan,
} from "../src/logging.ts";
import type { ErrorLogEntry, LogLevelName, LogTransport, LogEntry } from "../src/logging.ts";

const bin = kinetex({ baseURL: "https://httpbin.org", maxAttempts: 1 });

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
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

function assertOk(val: unknown, msg?: string) {
  assert.ok(val, msg);
}

const makeReq = (o: Partial<LogEntry> = {}): LogEntry => ({
  type: "request",
  requestId: "test-123",
  timestamp: "2024-01-01T00:00:00.000Z",
  timestampMs: 0,
  level: "INFO",
  method: "GET",
  url: "/",
  headers: {},
  bodySize: null,
  body: null,
  attempt: 1,
  meta: {},
  ...o,
});

const makeRes = (o: Partial<LogEntry> = {}): LogEntry =>
  ({
    type: "response",
    requestId: "test-123",
    timestamp: "2024-01-01T00:00:00.000Z",
    timestampMs: 0,
    level: "INFO",
    method: "GET",
    url: "/",
    headers: {},
    status: 200,
    bodySize: 100,
    body: null,
    attempt: 1,
    meta: {},
    durationMs: 150,
    ...o,
  }) as LogEntry;

const makeErr = (o: Partial<LogEntry> = {}): LogEntry =>
  ({
    type: "error",
    requestId: "test-123",
    timestamp: "2024-01-01T00:00:00.000Z",
    timestampMs: 0,
    level: "ERROR",
    method: "GET",
    url: "/",
    headers: {},
    error: { name: "Error", message: "test" },
    status: 500,
    durationMs: 100,
    attempt: 1,
    meta: {},
    ...o,
  }) as LogEntry;

// ── Log levels ─────────────────────────────────────────────────────────────

suite("Log levels");

await test("LogLevel numeric values", async () => {
  assertEqual(LogLevel.TRACE, 0);
  assertEqual(LogLevel.DEBUG, 1);
  assertEqual(LogLevel.INFO, 2);
  assertEqual(LogLevel.WARN, 3);
  assertEqual(LogLevel.ERROR, 4);
  assertEqual(LogLevel.SILENT, 5);
});

await test("HTTPLogger stores correct numeric level", async () => {
  for (const level of ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "SILENT"] as LogLevelName[]) {
    const logger = new HTTPLogger({ level });
    assertEqual((logger as any).level, LogLevel[level]);
  }
});

// ── Redactor headers ──────────────────────────────────────────────────────

suite("Redactor headers");

await test("Redactor redacts auth header with default list", async () => {
  const r = new Redactor();
  const h = r.redactHeaders({ authorization: "Bearer secret", "content-type": "application/json" });
  assertEqual(h.authorization, "***");
  assertEqual(h["content-type"], "application/json");
});

await test("Redactor redacts custom header fields", async () => {
  const r = new Redactor({ headers: ["x-secret"] });
  const h = r.redactHeaders({ "x-secret": "val", "x-public": "ok" });
  assertEqual(h["x-secret"], "***");
  assertEqual(h["x-public"], "ok");
});

await test("Redactor does not modify non-matching headers", async () => {
  const r = new Redactor({ headers: ["authorization"] });
  const h = r.redactHeaders({ "content-type": "text/plain", accept: "*/*" });
  assertEqual(h["content-type"], "text/plain");
  assertEqual(h.accept, "*/*");
});

// ── Redactor URL ──────────────────────────────────────────────────────────

suite("Redactor URL");

await test("Redactor redacts query params", async () => {
  const r = new Redactor({ queryParams: ["api_key", "secret"] });
  assertEqual(
    r.redactURL("https://example.com/data?api_key=secret123&q=test"),
    "https://example.com/data?api_key=***&q=test",
  );
});

await test("Redactor keeps safe URLs unchanged", async () => {
  const r = new Redactor({});
  assertEqual(r.redactURL("https://httpbin.org/json"), "https://httpbin.org/json");
});

await test("Redactor returns invalid URL unchanged", async () => {
  const r = new Redactor({});
  assertEqual(r.redactURL("not-a-valid-url"), "not-a-valid-url");
});

// ── Redactor body ─────────────────────────────────────────────────────────

suite("Redactor body");

await test("Redactor returns null body when shouldLog is false", async () => {
  const r = new Redactor({ logRequestBody: false, logResponseBody: false });
  const res = r.redactBody("hello", "text/plain", false);
  assertEqual(res.body, null);
  assertEqual(res.size, 5);
});

await test("Redactor returns null for null body", async () => {
  const r = new Redactor({ logRequestBody: true });
  const res = r.redactBody(null, "text/plain", false);
  assertEqual(res.body, null);
  assertEqual(res.size, null);
});

await test("Redactor returns binary marker for disallowed content type", async () => {
  const r = new Redactor({ logRequestBody: true });
  const res = r.redactBody("data", "application/octet-stream", false);
  assertEqual(res.body, "[application/octet-stream]");
});

await test("Redactor decodes Uint8Array body", async () => {
  const r = new Redactor({ logRequestBody: true });
  const res = r.redactBody(new Uint8Array([104, 101, 108, 108, 111]), "application/json", false);
  assertEqual(res.body, "hello");
});

await test("Redactor handles Uint8Array with invalid UTF-8", async () => {
  const r = new Redactor({ logRequestBody: true });
  const res = r.redactBody(new Uint8Array([0xfe, 0xff]), "application/json", false);
  // TextDecoder with default (fatal=false) replaces invalid bytes with U+FFFD
  assert.equal(res.body, "\uFFFD\uFFFD");
  assert.equal(res.size, 2);
});

await test("Redactor truncates body exceeding maxBodyLength", async () => {
  const r = new Redactor({ maxBodyLength: 10, logRequestBody: true });
  const res = r.redactBody("a".repeat(100), "text/plain", false);
  assertOk(res.body!.includes("truncated"));
  assertEqual(res.size, 100);
});

await test("Redactor redacts JSON body fields", async () => {
  const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify({ user: "john", password: "secret" }),
    "application/json",
    false,
  );
  const p = JSON.parse(res.body!);
  assertEqual(p.password, "***");
});

await test("Redactor redacts nested JSON body fields", async () => {
  const r = new Redactor({ bodyFields: ["user.pass"], logRequestBody: true });
  const res = r.redactBody(JSON.stringify({ user: { pass: "s" } }), "application/json", false);
  const p = JSON.parse(res.body!);
  assertEqual(p.user.pass, "***");
});

await test("Redactor redacts deeply nested JSON fields", async () => {
  const r = new Redactor({ bodyFields: ["a.b.c"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify({ a: { b: { c: "secret" } } }),
    "application/json",
    false,
  );
  const p = JSON.parse(res.body!);
  assertEqual(p.a.b.c, "***");
});

await test("regression: Redactor redacts fields inside a JSON array body", async () => {
  // A bulk payload is an array, and the configured field used to be applied
  // only to the top-level object, so every element logged in clear.
  const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify([
      { user: "a", password: "p1" },
      { user: "b", password: "p2" },
    ]),
    "application/json",
    false,
  );
  const parsed = JSON.parse(res.body!);
  assertEqual(parsed.length, 2);
  assertEqual(parsed[0].password, "***");
  assertEqual(parsed[1].password, "***");
  // The non-sensitive fields must survive — a redactor that blanks the whole
  // body would also pass the assertions above.
  assertEqual(parsed[0].user, "a");
  assertEqual(parsed[1].user, "b");
  assert.ok(!res.body!.includes("p1"), "the secret must not survive anywhere in the body");
  assert.ok(!res.body!.includes("p2"));
});

await test("regression: Redactor redacts nested fields inside an array body", async () => {
  const r = new Redactor({ bodyFields: ["user.token"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify([{ user: { token: "t1", id: 7 } }]),
    "application/json",
    false,
  );
  const parsed = JSON.parse(res.body!);
  assertEqual(parsed[0].user.token, "***");
  assertEqual(parsed[0].user.id, 7);
});

await test("regression: Redactor redacts array elements behind a wrapper key", async () => {
  // `bodyFields` is a dot-path from the root, so the documented path for this
  // shape is "items.password" — which previously stopped at the array.
  const r = new Redactor({ bodyFields: ["items.password"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify({ items: [{ password: "p", id: 1 }, { password: "q" }] }),
    "application/json",
    false,
  );
  const items = JSON.parse(res.body!).items;
  assertEqual(items[0].password, "***");
  assertEqual(items[1].password, "***");
  assertEqual(items[0].id, 1);
});

await test("regression: Redactor leaves an empty array intact", async () => {
  const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
  const res = r.redactBody(JSON.stringify([]), "application/json", false);
  assertEqual(res.body, "[]");
});

await test("regression: Redactor redacts every element of a mixed array", async () => {
  const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
  const res = r.redactBody(
    JSON.stringify([{ keep: 1 }, { password: "x" }, null, 5, "s"]),
    "application/json",
    false,
  );
  const parsed = JSON.parse(res.body!);
  assertEqual(parsed[0].keep, 1);
  assertEqual(parsed[1].password, "***");
  assertEqual(parsed[2], null);
  assertEqual(parsed[3], 5);
  assertEqual(parsed[4], "s");
});

await test("Redactor handles JSON parse error gracefully", async () => {
  const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
  const res = r.redactBody("not json", "application/json", false);
  assertEqual(res.body, "not json");
});

await test("Redactor applies body regex patterns", async () => {
  const r = new Redactor({ bodyPatterns: [/secret/gi], logRequestBody: true });
  const res = r.redactBody("my secret is safe", "text/plain", false);
  assertEqual(res.body, "my *** is safe");
});

await test("Redactor measures body size as UTF-8 bytes", async () => {
  const r = new Redactor({});
  const res = r.redactBody("héllo", "text/plain", false);
  assertEqual(res.size, 6);
});

// ── ConsoleTransport ──────────────────────────────────────────────────────

suite("ConsoleTransport");

await test("ConsoleTransport pretty-prints request", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeReq());
  assert.equal(out, "[00:00:00.000] INFO  ← GET / [test-123]");
});

await test("ConsoleTransport pretty-prints response", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeRes());
  assert.equal(out, "[00:00:00.000] INFO  → 200 GET / 150ms [test-123]");
});

await test("ConsoleTransport pretty-prints error", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeErr());
  assert.equal(out, "[00:00:00.000] ERROR ✗ GET / test [test-123]");
});

await test("ConsoleTransport JSON output when not pretty", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: false, onWrite: (s) => (out = s) });
  t.write(makeReq());
  const p = JSON.parse(out);
  assertEqual(p.type, "request");
  assertEqual(p.requestId, "test-123");
});

await test("ConsoleTransport marks cached responses", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeRes({ cached: true }));
  assert.equal(out, "[00:00:00.000] INFO  → 200 GET / 150ms (cached) [test-123]");
});

// ── JSONTransport ─────────────────────────────────────────────────────────

suite("JSONTransport");

await test("JSONTransport serializes entry", async () => {
  let out = "";
  const t = new JSONTransport((s) => (out = s));
  t.write(makeReq({ method: "POST" }));
  const p = JSON.parse(out);
  assertEqual(p.type, "request");
  assertEqual(p.method, "POST");
});

await test("JSONTransport default constructor does not throw", async () => {
  let t: JSONTransport | undefined;
  assert.doesNotThrow(() => {
    t = new JSONTransport();
  });
  assert.ok(t !== undefined);
  // write() on the default sink must also not throw, and must be callable twice.
  assert.doesNotThrow(() => t!.write(makeReq()));
  assert.doesNotThrow(() => t!.write(makeReq()));
});

// ── BatchingTransport ─────────────────────────────────────────────────────

suite("BatchingTransport");

await test("BatchingTransport buffers under batch size", async () => {
  const written: LogEntry[] = [];
  const inner: LogTransport = {
    write: (e) => {
      written.push(e);
    },
    flush: async () => {},
  };
  const b = new BatchingTransport(inner, { maxBatch: 3 });
  b.write(makeReq({ requestId: "a" }));
  b.write(makeReq({ requestId: "b" }));
  assertEqual(written.length, 0);
  await b.flush();
  assertEqual(written.length, 2);
});

await test("BatchingTransport flushes at batch size", async () => {
  const written: LogEntry[] = [];
  const inner: LogTransport = {
    write: (e) => {
      written.push(e);
    },
    flush: async () => {},
  };
  const b = new BatchingTransport(inner, { maxBatch: 2 });
  b.write(makeReq({ requestId: "a" }));
  b.write(makeReq({ requestId: "b" }));
  assertEqual(written.length, 2);
});

await test("BatchingTransport flush on empty buffer no-ops", async () => {
  let flushed = false;
  let writes = 0;
  const inner: LogTransport = {
    write: () => {
      writes++;
    },
    flush: async () => {
      flushed = true;
    },
  };
  const b = new BatchingTransport(inner);
  await b.flush();
  // The test was named "no-ops" but only asserted that the inner flush ran.
  assert.equal(writes, 0, "an empty flush must not write anything");
  assert.equal(flushed, true);
});

// ── RemoteTransport ───────────────────────────────────────────────────────

suite("RemoteTransport");

await test("RemoteTransport small batch uses direct JSON", async () => {
  let body = "";
  const t = new RemoteTransport("https://httpbin.org/post", {
    batchSize: 100,
    flushMs: 60000,
    fetch: async (_u, o) => {
      body = o?.body as string;
      return new Response("ok");
    },
    onError: () => {},
  });
  t.write(makeReq({ requestId: "r1" }));
  await t.flush();
  const p = JSON.parse(body);
  assertEqual(p.length, 1);
  assertEqual(p[0].requestId, "r1");
});

await test("RemoteTransport flush empty buffer no-ops", async () => {
  let called = false;
  const t = new RemoteTransport("https://httpbin.org/post", {
    fetch: async () => {
      called = true;
      return new Response("ok");
    },
    onError: () => {},
  });
  await t.flush();
  assertEqual(called, false);
});

// ── MultiTransport ────────────────────────────────────────────────────────

suite("MultiTransport");

await test("MultiTransport writes to all transports", async () => {
  let c = 0;
  const t1: LogTransport = { write: () => c++, flush: async () => {} };
  const t2: LogTransport = { write: () => c++, flush: async () => {} };
  new MultiTransport([t1, t2]).write(makeReq());
  assertEqual(c, 2);
});

await test("MultiTransport flush calls inner flushes", async () => {
  let f1 = false,
    f2 = false;
  const t1: LogTransport = {
    write: () => {},
    flush: async () => {
      f1 = true;
    },
  };
  const t2: LogTransport = {
    write: () => {},
    flush: async () => {
      f2 = true;
    },
  };
  await new MultiTransport([t1, t2]).flush();
  assert.equal(f1, true);
  assert.equal(f2, true);
});

await test("MultiTransport isolates transport errors", async () => {
  let c = 0;
  const t1: LogTransport = {
    write: () => {
      throw new Error("fail");
    },
    flush: async () => {},
  };
  const t2: LogTransport = {
    write: () => {
      c++;
    },
    flush: async () => {},
  };
  new MultiTransport([t1, t2]).write(makeReq());
  assertEqual(c, 1);
});

// ── Factory helpers ──────────────────────────────────────────────────────

suite("Factory helpers");

await test("createLogger default level is INFO", async () => {
  assertEqual((createLogger({}) as any).level, LogLevel.INFO);
});

await test("createLogger with custom level", async () => {
  assertEqual((createLogger({ level: "DEBUG" }) as any).level, LogLevel.DEBUG);
});

await test("createLogger with context", async () => {
  const logger = createLogger({ context: { svc: "test" } });
  assertEqual((logger as any).cfg.context.svc, "test");
});

await test("createDevelopmentLogger defaults", async () => {
  const logger = createDevelopmentLogger();
  assertEqual((logger as any).level, LogLevel.DEBUG);
  assertEqual((logger as any).cfg.redaction.logRequestBody, true);
  assertEqual((logger as any).cfg.redaction.maxBodyLength, 2048);
});

await test("createDevelopmentLogger with logBodies disabled", async () => {
  const cfg = (createDevelopmentLogger({ logBodies: false }) as any).cfg;
  assertEqual(cfg.redaction.logRequestBody, false);
});

await test("createProductionLogger with endpoint uses MultiTransport", async () => {
  const logger = createProductionLogger({ endpoint: "https://example.com/log" });
  assertEqual((logger as any).level, LogLevel.INFO);
  assertOk((logger as any).cfg.transports[0] instanceof MultiTransport);
});

await test("createProductionLogger without endpoint", async () => {
  const logger = createProductionLogger({});
  assert.equal((logger as any).cfg.transports.length, 1);
  assert.equal((logger as any).cfg.transports[0] instanceof MultiTransport, true);
});

// ── HTTPLogger request ID ──────────────────────────────────────────────────

suite("HTTPLogger request ID");

await test("generateRequestId returns non-empty string", async () => {
  const id = createLogger().generateRequestId();
  assert.equal(typeof id, "string");
  assert.match(id, /^[a-z0-9]+-\d{4}-[a-z0-9]+$/i);
  assert.equal(createLogger().generateRequestId() !== id, true, "ids must be unique");
});

await test("generateRequestId with custom generator", async () => {
  assertEqual(createLogger({ generateId: () => "custom" }).generateRequestId(), "custom");
});

await test("generateRequestId produces unique IDs", async () => {
  const ids = new Set(Array.from({ length: 50 }, () => createLogger().generateRequestId()));
  assertEqual(ids.size, 50);
});

// ── HTTPLogger logRequest ─────────────────────────────────────────────────

suite("HTTPLogger logRequest");

async function captureWrite(
  t?: LogTransport,
): Promise<{ written: LogEntry[]; logger: HTTPLogger }> {
  const written: LogEntry[] = [];
  const transport: LogTransport = t ?? {
    write: (e) => {
      written.push(e);
    },
    flush: async () => {},
  };
  return { written, logger: createLogger({ transports: [transport] }) };
}

await test("logRequest writes request entry", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  assertEqual(written.length, 1);
  assertEqual(written[0].type, "request");
  assertEqual((written[0] as any).method, "GET");
});

await test("logRequest redacts sensitive headers", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", { authorization: "Bearer tok" }, null, 1);
  assertEqual((written[0] as any).headers.authorization, "***");
});

await test("logRequest redacts URL params", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "https://example.com?token=abc", {}, null, 1);
  assert.equal((written[0] as any).url, "https://example.com/?token=***");
});

// ── HTTPLogger logResponse ────────────────────────────────────────────────

suite("HTTPLogger logResponse");

await test("logResponse writes response entry", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 200, "OK", {}, null, 1, false);
  assertEqual(written[1].type, "response");
  assertEqual((written[1] as any).status, 200);
});

await test("logResponse assigns WARN for 4xx", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 404, "NF", {}, null, 1, false);
  assertEqual((written[1] as any).level, "WARN");
});

await test("logResponse assigns ERROR for 5xx", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 500, "ISE", {}, null, 1, false);
  assertEqual((written[1] as any).level, "ERROR");
});

await test("logResponse without prior request uses defaults", async () => {
  const { written, logger } = await captureWrite();
  logger.logResponse("unknown", 200, "OK", {}, null, 1, false);
  assertEqual((written[0] as any).method, "GET");
  assertEqual((written[0] as any).url, "");
});

await test("logResponse marks cached responses", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 200, "OK", {}, null, 1, true);
  assertEqual((written[1] as any).cached, true);
});

await test("logResponse redacts body", async () => {
  const written: LogEntry[] = [];
  const logger = new HTTPLogger({
    redaction: { logResponseBody: true },
    transports: [
      {
        write: (e) => {
          written.push(e);
        },
        flush: async () => {},
      },
    ],
  });
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 200, "OK", { "content-type": "text/plain" }, "resp", 1, false);
  assertEqual((written[1] as any).body, "resp");
});

// ── HTTPLogger logError ──────────────────────────────────────────────────

suite("HTTPLogger logError");

await test("logError writes error entry", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logError("r1", new Error("boom"), 500, 1);
  assertEqual(written[1].type, "error");
  assertEqual((written[1] as any).error.message, "boom");
});

await test("logError without prior request uses defaults", async () => {
  const { written, logger } = await captureWrite();
  logger.logError("unknown", new Error("err"), 500, 1);
  assertEqual((written[0] as any).method, "GET");
  assertEqual((written[0] as any).url, "");
});

await test("logError with non-Error object", async () => {
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logError("r1", "string error", 500, 1);
  assertEqual((written[1] as any).error.message, "string error");
});

await test("logError serializes error code and stack", async () => {
  const { written, logger } = await captureWrite();
  const err = new Error("test") as Error & { code: string };
  err.code = "ERR_TEST";
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logError("r1", err, 500, 1);
  assertEqual((written[1] as any).error.code, "ERR_TEST");
  assertOk((written[1] as any).error.stack !== undefined);
});

// ── HTTPLogger flush ──────────────────────────────────────────────────────

suite("HTTPLogger flush");

await test("flush delegates to transport flush", async () => {
  let flushed = false;
  const logger = createLogger({
    transports: [
      {
        write: () => {},
        flush: async () => {
          flushed = true;
        },
      },
    ],
  });
  await logger.flush();
  assert.equal(flushed, true);
});

// ── HTTPLogger child ──────────────────────────────────────────────────────

suite("HTTPLogger child");

await test("child inherits parent level", async () => {
  const p = createLogger({ level: "DEBUG" });
  const c = p.child({ uid: "u1" });
  assertEqual((c as any).cfg.level, (p as any).cfg.level);
});

await test("child merges context", async () => {
  const p = createLogger({ context: { svc: "api" } });
  const c = p.child({ uid: "u1" });
  assertEqual((c as any).cfg.context.svc, "api");
  assertEqual((c as any).cfg.context.uid, "u1");
});

await test("child context does not mutate parent", async () => {
  const p = createLogger({ context: { svc: "api" } });
  p.child({ extra: "val" });
  assertEqual((p as any).cfg.context.extra, undefined);
});

// ── HTTPLogger filters ───────────────────────────────────────────────────

suite("HTTPLogger filters");

async function makeFilteredLogger(opts: Record<string, unknown>) {
  const counter = { count: 0 };
  const logger = new HTTPLogger({
    ...opts,
    transports: [
      {
        write: () => {
          counter.count++;
        },
        flush: async () => {},
      },
    ],
  } as any);
  return { logger, counter };
}

await test("methods filter excludes GET when POST only", async () => {
  const { logger, counter } = await makeFilteredLogger({ methods: ["POST"] });
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  assertEqual(counter.count, 0);
});

await test("methods filter allows POST", async () => {
  const { logger, counter } = await makeFilteredLogger({ methods: ["POST"] });
  logger.logRequest("r1", "POST", "/", {}, null, 1);
  assertEqual(counter.count, 1);
});

await test("excludeURLs prevents matching URLs", async () => {
  const { logger, counter } = await makeFilteredLogger({ excludeURLs: [/health/] });
  logger.logRequest("r1", "GET", "https://example.com/health", {}, null, 1);
  assertEqual(counter.count, 0);
});

await test("excludeURLs allows non-matching URLs", async () => {
  const { logger, counter } = await makeFilteredLogger({ excludeURLs: [/health/] });
  logger.logRequest("r1", "GET", "https://example.com/api", {}, null, 1);
  assertEqual(counter.count, 1);
});

await test("status filter excludes non-matching on logResponse", async () => {
  let responseWrites = 0;
  const logger = new HTTPLogger({
    statuses: [500],
    transports: [
      {
        write: (e: LogEntry) => {
          if (e.type === "response") responseWrites++;
        },
        flush: async () => {},
      },
    ],
  });
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logResponse("r1", 200, "OK", {}, null, 1, false);
  assertEqual(responseWrites, 0);
  // Nothing written is only half the contract: a filtered response also has to
  // release its active ID, or every filtered request leaks one entry.
  const ids = (logger as any).activeIds as Map<string, unknown>;
  assert.equal(ids.has("r1"), false, "a filtered response must still release its active id");
});

await test("level filter suppresses below-threshold entries via _write", async () => {
  const { logger, counter } = await makeFilteredLogger({ level: "ERROR" });
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  assertEqual(counter.count, 0);
});

// ── toOTelSpan ────────────────────────────────────────────────────────────

suite("toOTelSpan");

await test("toOTelSpan request entry", async () => {
  const ot = toOTelSpan(makeReq({ requestId: "r1", method: "POST", url: "https://ex.com" }));
  assertEqual(ot["http.request.id"], "r1");
  assertEqual(ot["http.request.method"], "POST");
  assertEqual(ot["url.full"], "https://ex.com");
});

await test("toOTelSpan response entry", async () => {
  const ot = toOTelSpan(makeRes({ status: 201, bodySize: 50, durationMs: 25 }));
  assertEqual(ot["http.response.status_code"], 201);
  assertEqual(ot["http.response.body.size"], 50);
  assertEqual(ot["http.time_to_first_byte"], 25);
});

await test("toOTelSpan error entry", async () => {
  const ot = toOTelSpan(makeErr({ error: { name: "TypeError", message: "bad" } }));
  assertEqual(ot["error"], true);
  assertEqual(ot["error.type"], "TypeError");
  assertEqual(ot["error.message"], "bad");
  assertEqual(ot["http.status_code"], 500);
});

await test("toOTelSpan error entry maps exactly the documented fields", async () => {
  // The old test built an error carrying a `code` and a `stack` and then only
  // asserted the two fields the mapping already produced, so it could not
  // notice a field going missing. Pin the documented set exactly — and the
  // fact that `error.code` is *not* mapped is now stated here rather than left
  // to be assumed, since `SerializedError.code` is otherwise dropped.
  const ot = toOTelSpan(makeErr({ error: { name: "E", message: "m", code: "C" } }));
  assert.deepEqual(Object.keys(ot).sort(), [
    "error",
    "error.message",
    "error.type",
    "http.request.id",
    "http.request.method",
    "http.status_code",
    "url.full",
  ]);
  assertEqual(ot["error.type"], "E");
  assertEqual(ot["error.message"], "m");
});

// ── Active ID cleanup ────────────────────────────────────────────────────

suite("Active ID cleanup");

await test("logRequest >500 triggers cleanup", async () => {
  const logger = createLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
  const ids = (logger as any).activeIds as Map<string, unknown>;
  // startMs far in the past so every seeded entry is unambiguously idle
  for (let i = 0; i < 501; i++) ids.set(`stale-${i}`, { startMs: -1e9, method: "GET", url: "/s" });
  assert.equal(ids.size, 501);
  logger.logRequest("fresh", "GET", "/f", {}, null, 1);
  // Crossing the 500 threshold runs the stale sweep, leaving only the fresh id
  assert.deepEqual([...ids.keys()], ["fresh"]);
});

await test("activeIds deleted after logResponse", async () => {
  const logger = createLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
  const ids = (logger as any).activeIds as Map<string, unknown>;
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  assertOk(ids.has("r1"));
  logger.logResponse("r1", 200, "OK", {}, null, 1, false);
  assertEqual(ids.has("r1"), false);
});

await test("activeIds deleted after logError", async () => {
  const logger = createLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
  const ids = (logger as any).activeIds as Map<string, unknown>;
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logError("r1", new Error("err"), 500, 1);
  assertEqual(ids.has("r1"), false);
});

// ── Cross-runtime ─────────────────────────────────────────────────────────

suite("Cross-runtime");

await test("perfNow fallback without performance", async () => {
  // The transport was a no-op sink, so the entry it should have received was
  // never checked. Capture it.
  const written: unknown[] = [];
  const orig = (globalThis as any).performance;
  (globalThis as any).performance = undefined;
  try {
    const logger = createLogger({
      transports: [
        {
          write: (e: unknown) => {
            written.push(e);
          },
          flush: async () => {},
        },
      ],
    });
    logger.logRequest("r1", "GET", "/", {}, null, 1);
    assert.equal(written.length, 1, "the Date-less runtime must still produce an entry");
    const entry = written[0] as {
      type: string;
      requestId: string;
      timestamp: string;
      timestampMs: number;
    };
    assert.equal(entry.type, "request");
    assert.equal(entry.requestId, "r1");
    // perfNow falls back to Date.now(), so a real timestamp must still exist.
    assert.equal(typeof entry.timestampMs, "number");
    assert.ok(Number.isFinite(entry.timestampMs), "timestampMs must be a real number");
    assert.ok(Math.abs(Date.now() - entry.timestampMs) < 60_000, "timestampMs must be ~now");
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), "timestamp must be a parseable date");
  } finally {
    (globalThis as any).performance = orig;
  }
});

// ── Real HTTP ─────────────────────────────────────────────────────────────

suite("Real HTTP");

await test("GET /get returns 200", async () => {
  assertEqual((await bin.get("/get")).status, 200);
});

await test("GET /headers returns headers", async () => {
  const r = await bin.get<{ headers: Record<string, string> }>("/headers");
  assertEqual(r.status, 200);
  assertOk(r.data.headers);
});

await test("POST /post roundtrips JSON", async () => {
  const r = await bin.post<{ json: Record<string, unknown> }>(
    "/post",
    JSON.stringify({ test: "data" }),
    { headers: { "content-type": "application/json" } },
  );
  assertEqual(r.status, 200);
  assertEqual(r.data.json.test, "data");
});

await test("GET /uuid returns ID", async () => {
  const r = await bin.get<{ uuid: string }>("/uuid");
  assertEqual(r.status, 200);
  assertOk(r.data.uuid.length > 0);
});

// ── Regression: defects found by the strictest-assertion audit ──────────
suite("Regression: audit fixes");

await test("regression: ConsoleTransport works with partial options", async () => {
  // `onWrite` was a required field of the options type but the constructor's
  // default parameter only supplied it when the whole object was omitted, so
  // `new ConsoleTransport({})` — which any caller building options at runtime
  // reaches — threw "this.onWrite is not a function" on the first write.
  const origLog = console.log;
  const seen: string[] = [];
  console.log = (s: string) => seen.push(s);
  try {
    const t = new ConsoleTransport({});
    assert.doesNotThrow(() => t.write(makeReq()), "a bare options object must not throw");
    assert.equal(seen.length, 1, "and it must still emit the entry");
    // `{}` resolves `pretty` from NODE_ENV exactly like every other form, so
    // which of the two renderings appears is environment-dependent — the point
    // here is that something is written at all.
    assert.ok(
      seen[0]!.includes("test-123"),
      `the entry must reach the default sink, got ${JSON.stringify(seen[0]!.slice(0, 40))}`,
    );

    // An explicit sink still wins over the default.
    let captured = "";
    new ConsoleTransport({ onWrite: (s) => (captured = s) }).write(makeRes());
    assert.ok(captured.length > 0, "an explicit onWrite must be used");
  } finally {
    console.log = origLog;
  }
});

await test("regression: ConsoleTransport pretty default does not depend on the call form", async () => {
  // The no-argument form hard-coded `pretty: false` while any other form
  // resolved it against NODE_ENV, so the two ways of constructing the same
  // transport produced different output — the opposite of the documented
  // "Defaults to true in non-production".
  const origLog = console.log;
  const seen: string[] = [];
  console.log = (s: string) => seen.push(s);
  try {
    new ConsoleTransport().write(makeReq());
  } finally {
    console.log = origLog;
  }
  const noArg = seen[0]!;
  assert.ok(
    noArg.startsWith("[") && noArg.includes("←"),
    `a no-arg ConsoleTransport must use the same pretty default as every other form, got ${JSON.stringify(noArg.slice(0, 30))}`,
  );

  // ...and the explicit forms are unaffected.
  let json = "";
  new ConsoleTransport({ pretty: false, onWrite: (s) => (json = s) }).write(makeReq());
  assert.equal(JSON.parse(json).type, "request", "pretty:false must still produce JSON");
});

await test("regression: redactBody measures and truncates in UTF-8 bytes", async () => {
  // Both the reported size and the truncation used `String.length`, which is
  // UTF-16 code units, while `maxBodyLength` is documented in bytes and the
  // truncation message labelled the count "bytes". An emoji body was reported
  // at half its size and truncated at half the requested budget.
  const r = new Redactor({ logRequestBody: true });
  assertEqual(r.redactBody("😀".repeat(10), "application/json", false).size, 40);
  assertEqual(r.redactBody("日本語", "application/json", false).size, 9);
  assertEqual(r.redactBody("héllo", "application/json", false).size, 6);

  const capped = new Redactor({ logRequestBody: true, maxBodyLength: 10 });
  const emoji = capped.redactBody("😀".repeat(10), "application/json", false);
  // 10 bytes of budget fits two 4-byte emoji, and the message must count the
  // 32 bytes actually dropped — not 10 characters.
  assert.ok(emoji.body!.startsWith("😀😀"), `got ${JSON.stringify(emoji.body)}`);
  assert.ok(emoji.body!.includes("truncated 32 bytes"), `got ${JSON.stringify(emoji.body)}`);
  // Never split a character in half.
  assert.ok(!emoji.body!.includes("\ufffd"), "truncation must not split a multi-byte character");

  // ASCII is unchanged by the unit fix.
  const ascii = capped.redactBody("a".repeat(20), "application/json", false);
  assert.ok(ascii.body!.startsWith("a".repeat(10)), `got ${JSON.stringify(ascii.body)}`);
  assert.ok(ascii.body!.includes("truncated 10 bytes"));

  // A body already inside the budget is not marked truncated.
  const small = capped.redactBody("abc", "application/json", false);
  assertEqual(small.body, "abc");

  // The two units disagree here: 12 characters but 14 bytes, against a 12-byte
  // budget. Reading the budget as a character count concludes the body already
  // fits and emits all 14 bytes; reading it as bytes drops the emoji. The
  // budget has to sit strictly between the two readings, which is why this
  // case needs its own Redactor rather than the 10-byte one above.
  const tight = new Redactor({ logRequestBody: true, maxBodyLength: 12 });
  const nearMiss = tight.redactBody("a".repeat(10) + "😀", "application/json", false);
  assert.equal(nearMiss.size, 14, "the size is the body as received");
  assert.ok(
    nearMiss.body!.startsWith("a".repeat(10)) && !nearMiss.body!.includes("😀"),
    `the over-budget emoji must be dropped, got ${JSON.stringify(nearMiss.body)}`,
  );
  // 14 bytes in, 10 kept, 4 removed.
  assert.ok(nearMiss.body!.includes("truncated 4 bytes"), JSON.stringify(nearMiss.body));

  // A body inside the budget under both readings is returned untouched.
  assertEqual(tight.redactBody("a".repeat(12), "application/json", false).body, "a".repeat(12));
});

await test("regression: redactBody size is the body as received, not the re-encoding", async () => {
  // Two invalid UTF-8 bytes decode to two U+FFFD characters that re-encode to
  // 6 bytes. Reporting 6 for a 2-byte body describes nothing the caller sent.
  const r = new Redactor({ logRequestBody: true });
  const res = r.redactBody(new Uint8Array([0xfe, 0xff]), "application/json", false);
  assert.equal(res.body, "\uFFFD\uFFFD");
  assertEqual(res.size, 2);
  assertEqual(r.redactBody(new Uint8Array([104, 105]), "application/json", false).size, 2);
});

await test("regression: a filtered response and error still release their active id", async () => {
  // The delete sat after the filter's early return, so any entry dropped by
  // `statuses`, `methods`, `level`, `excludeURLs` or sampling left its record
  // in `activeIds` forever. The only cleanup is a size-triggered sweep inside
  // `logRequest`, so a service logging with a narrow filter accumulated one
  // dead entry per request until it hit the 10000 cap and began evicting live
  // ones.
  const activeIdsOf = (logger: HTTPLogger): Map<string, unknown> =>
    (logger as any).activeIds as Map<string, unknown>;

  for (const cfg of [
    { name: "statuses", opts: { statuses: [200] } },
    { name: "methods", opts: { methods: ["POST"] } },
    { name: "level", opts: { level: "SILENT" as const } },
    { name: "excludeURLs", opts: { excludeURLs: [/health/] } },
  ]) {
    const logger = new HTTPLogger({
      ...(cfg.opts as any),
      transports: [{ write: () => {}, flush: async () => {} }],
    });
    for (let i = 0; i < 25; i++) {
      // Two tracked requests per iteration: one resolved through logResponse
      // and one through logError. Both must be registered first, or the release
      // being tested is a delete of an id that was never there.
      logger.logRequest(`res-${i}`, "GET", "https://x.test/health", {}, null, 1);
      logger.logResponse(`res-${i}`, 404, "Not Found", {}, null, 1, false);
      logger.logRequest(`err-${i}`, "GET", "https://x.test/health", {}, null, 1);
      logger.logError(`err-${i}`, new Error("x"), null, 1);
    }
    assertEqual(activeIdsOf(logger).size, 0, `the ${cfg.name} filter must not leak active ids`);
  }

  // Control: an unfiltered logger still holds the id of a request with no
  // response yet, so the assertions above are not vacuously true.
  const open = new HTTPLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
  open.logRequest("pending", "GET", "https://x.test/a", {}, null, 1);
  assertEqual(activeIdsOf(open).size, 1, "an in-flight request must still be tracked");

  // Every filter above drops the *logRequest* as well, so for `methods`,
  // `level` and `excludeURLs` the ids were never registered and the releases
  // being checked are deletes of absent keys. Only `statuses` reaches
  // `logResponse` with a live id, because `logError` passes no status and so
  // is never subject to that filter — which is why a status filter is the one
  // case that had to move the delete ahead of the early return.
  const statusOnly = new HTTPLogger({
    statuses: [200],
    transports: [{ write: () => {}, flush: async () => {} }],
  });
  statusOnly.logRequest("r", "GET", "https://x.test/a", {}, null, 1);
  assert.equal(activeIdsOf(statusOnly).has("r"), true, "a 200-eligible request is tracked");
  statusOnly.logError("r", new Error("x"), null, 1);
  assert.equal(
    activeIdsOf(statusOnly).has("r"),
    false,
    "logError releases its id even though the status filter does not apply to it",
  );
});

await test("regression: a size-triggered flush disarms the batching timer", async () => {
  // The flush triggered from write() left the interval armed, so write()'s
  // `if (!this.timer)` guard stayed false and the next entry got no timer of
  // its own — it waited out the remainder of the previous batch's interval.
  const written: string[] = [];
  const inner: LogTransport = {
    write: (e) => {
      written.push((e as any).requestId);
    },
    flush: async () => {},
  };
  const b = new BatchingTransport(inner, { maxBatch: 2, flushMs: 10_000 });
  b.write(makeReq({ requestId: "a" }));
  assert.equal((b as any).timer !== null, true, "the first entry arms the timer");
  b.write(makeReq({ requestId: "b" }));
  assert.equal(written.length, 2, "reaching maxBatch flushes immediately");
  assert.equal((b as any).timer, null, "a size-triggered flush must disarm the timer");

  b.write(makeReq({ requestId: "c" }));
  assert.equal((b as any).buffer.length, 1, "the third entry is buffered");
  assert.equal((b as any).timer !== null, true, "and must get a timer of its own");
  await b.flush();
  assert.deepEqual(written, ["a", "b", "c"]);
  assert.equal((b as any).timer, null, "an explicit flush disarms it too");

  // The same defect existed in RemoteTransport, which shares the shape.
  const posted: number[] = [];
  const remote = new RemoteTransport("https://example.com/log", {
    batchSize: 2,
    flushMs: 10_000,
    fetch: async () => {
      posted.push(1);
      return new Response("ok");
    },
    onError: () => {},
  });
  remote.write(makeReq({ requestId: "r1" }));
  remote.write(makeReq({ requestId: "r2" }));
  assert.equal((remote as any).timer, null, "RemoteTransport must also disarm on a size flush");
  remote.write(makeReq({ requestId: "r3" }));
  assert.equal((remote as any).timer !== null, true, "and re-arm for the next entry");
  await remote.flush();
  assert.equal((remote as any).buffer.length, 0);
  assert.ok(posted.length >= 1, "the buffered entry still ships");
});

await test("regression: redactURL redacts a relative URL's query", async () => {
  // Anything the URL constructor rejects was returned untouched, so
  // `logRequest(id, "GET", "/users?token=abc", ...)` — the shape used by
  // HTTPLogger.child's own doc example — wrote the token in clear while the
  // absolute spelling of the same request redacted it.
  const r = new Redactor();
  assertEqual(r.redactURL("/users?token=SECRET&ok=1"), "/users?token=***&ok=1");
  assertEqual(r.redactURL("a/b?api_key=SECRET"), "a/b?api_key=***");
  assertEqual(r.redactURL("?password=hunter2"), "?password=***");
  assertEqual(
    r.redactURL("/users?token=***#frag"),
    "/users?token=***#frag",
    "the fragment is kept",
  );
  assertEqual(r.redactURL("/users?token=***&x=1#f"), "/users?token=***&x=1#f");
  assertEqual(r.redactURL("/users"), "/users", "no query, nothing to do");
  assertEqual(r.redactURL("/users?ok=1"), "/users?ok=1", "a safe query is untouched");
  assertEqual(
    r.redactURL("/users?token"),
    "/users?token=***",
    "a valueless secret is still masked",
  );

  for (const u of ["/users?token=SECRET&ok=1", "a/b?api_key=SECRET", "?password=hunter2"]) {
    assert.ok(!r.redactURL(u).includes("SECRET"), `${u} must not leak`);
    assert.ok(!r.redactURL(u).includes("hunter2"), `${u} must not leak`);
  }

  // A percent-encoded name is still recognised.
  assertEqual(r.redactURL("/u?%74oken=SECRET"), "/u?%74oken=***");
  // A malformed escape must not throw.
  assertEqual(r.redactURL("/u?%zz=1&token=SECRET"), "/u?%zz=1&token=***");

  // The absolute path is unchanged, including its normalisation.
  assertEqual(
    r.redactURL("https://example.com/data?token=abc&q=1"),
    "https://example.com/data?token=***&q=1",
  );
});

await test("regression: a structured rejection keeps its message and code", async () => {
  // Anything that was not an Error went through String(err), so a rejected
  // object — what a custom fetch, a GraphQL client or a worker throws — logged
  // the message "[object Object]" and dropped its code entirely.
  const { written, logger } = await captureWrite();
  logger.logRequest("r1", "GET", "/", {}, null, 1);
  logger.logError(
    "r1",
    { name: "FetchError", message: "connection refused", code: "ENETWORK" },
    null,
    1,
  );
  const entry = written[1] as ErrorLogEntry;
  assert.equal(entry.error.name, "FetchError");
  assert.equal(entry.error.message, "connection refused");
  assert.equal(entry.error.code, "ENETWORK");

  // A plain object with no message is stringified structurally, not "[object Object]".
  const { written: w2, logger: l2 } = await captureWrite();
  l2.logRequest("r2", "GET", "/", {}, null, 1);
  l2.logError("r2", { status: 503, detail: "upstream down" }, 503, 1);
  const e2 = w2[1] as ErrorLogEntry;
  assert.equal(e2.error.name, "Error");
  assert.ok(
    e2.error.message.includes("upstream down") && e2.error.message !== "[object Object]",
    `got ${JSON.stringify(e2.error.message)}`,
  );

  // A circular object must not throw out of the logger. The fixture carries no
  // `message`, so serialization has to fall through to the structural
  // stringifier — a circular one carrying a message takes the message branch
  // and never reaches it.
  const circular: any = { detail: "loop" };
  circular.self = circular;
  const { written: w3, logger: l3 } = await captureWrite();
  l3.logRequest("r3", "GET", "/", {}, null, 1);
  assert.doesNotThrow(() => l3.logError("r3", circular, null, 1));
  const circ = (w3[1] as ErrorLogEntry).error.message;
  assert.ok(circ.length > 0, "a circular rejection must still produce a message");
  assert.ok(circ.includes("loop"), `got ${JSON.stringify(circ)}`);
  assert.ok(circ.includes("[circular]"), `the cycle must be marked, got ${JSON.stringify(circ)}`);

  // A circular object that also has a message keeps it, unchanged.
  const circularWithMessage: any = { message: "loop" };
  circularWithMessage.self = circularWithMessage;
  l3.logError("r3", circularWithMessage, null, 1);
  assert.equal((w3[2] as ErrorLogEntry).error.message, "loop", "its message still wins");

  // Primitives and real Errors are unchanged.
  const { written: w4, logger: l4 } = await captureWrite();
  l4.logRequest("r4", "GET", "/", {}, null, 1);
  l4.logError("r4", "plain string failure", null, 1);
  assert.equal((w4[1] as ErrorLogEntry).error.message, "plain string failure");

  l4.logError("r4", new TypeError("typed"), 500, 1);
  const e5 = w4[2] as ErrorLogEntry;
  assert.equal(e5.error.name, "TypeError");
  assert.equal(e5.error.message, "typed");
  assertOk(e5.error.stack !== undefined, "a real Error still carries its stack");
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
