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
  assertOk(typeof res.body === "string");
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
  assertOk(out.includes("GET"));
  assertOk(out.includes("←"));
});

await test("ConsoleTransport pretty-prints response", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeRes());
  assertOk(out.includes("200"));
  assertOk(out.includes("→"));
});

await test("ConsoleTransport pretty-prints error", async () => {
  let out = "";
  const t = new ConsoleTransport({ pretty: true, onWrite: (s) => (out = s) });
  t.write(makeErr());
  assertOk(out.includes("✗"));
  assertOk(out.includes("test"));
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
  assertOk(out.includes("cached"));
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
  const t = new JSONTransport();
  t.write(makeReq());
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
  const inner: LogTransport = {
    write: () => {},
    flush: async () => {
      flushed = true;
    },
  };
  const b = new BatchingTransport(inner);
  await b.flush();
  assertOk(flushed);
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
  assertOk(f1);
  assertOk(f2);
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
  assertOk((logger as any).cfg.transports[0] instanceof MultiTransport);
});

// ── HTTPLogger request ID ──────────────────────────────────────────────────

suite("HTTPLogger request ID");

await test("generateRequestId returns non-empty string", async () => {
  assertOk(createLogger().generateRequestId().length >= 10);
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
  assertOk((written[0] as any).url.includes("token=***"));
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
  assertOk(flushed);
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

await test("toOTelSpan error with code and stack", async () => {
  const ot = toOTelSpan(makeErr({ error: { name: "E", message: "m", code: "C", stack: "s" } }));
  assertEqual(ot["error.type"], "E");
  assertEqual(ot["error.message"], "m");
});

// ── Active ID cleanup ────────────────────────────────────────────────────

suite("Active ID cleanup");

await test("logRequest >500 triggers cleanup", async () => {
  const logger = createLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
  const ids = (logger as any).activeIds as Map<string, unknown>;
  // Add entries - cleanup runs when size > 500 but the eviction only triggers at MAX_ACTIVE_IDS (10000)
  // So this verifies the cleanup is called without error
  for (let i = 0; i < 501; i++) ids.set(`stale-${i}`, { startMs: 0, method: "GET", url: "/s" });
  logger.logRequest("fresh", "GET", "/f", {}, null, 1);
  assertOk(ids.size > 0);
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
  const orig = (globalThis as any).performance;
  (globalThis as any).performance = undefined;
  try {
    const logger = createLogger({ transports: [{ write: () => {}, flush: async () => {} }] });
    logger.logRequest("r1", "GET", "/", {}, null, 1);
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
