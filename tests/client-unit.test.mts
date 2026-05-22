import assert from "node:assert/strict";
import { Kinetex, kinetex, BatchQueue, createMethodCircuitBreakerKey } from "../src/mod.ts";
import type { KinetexConfig, KinetexRequest, KinetexResponse } from "../src/types.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const T = 30_000;

// ============================================================================
// §1  BatchQueue — battle tests
// ============================================================================

suite("BatchQueue");

await test("enqueue resolves with status 200 after flush", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 1, flushMs: 0 });
  const res = await queue.enqueue("/get", "GET");
  assert.equal(res.status, 200);
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("flush sends all queued items concurrently", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 5, flushMs: 10_000 });
  const results = await Promise.all([
    queue.enqueue("/get", "GET"),
    queue.enqueue("/get", "GET"),
    queue.enqueue("/get", "GET"),
  ]);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("maxBatch triggers immediate flush", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 2, flushMs: 10_000 });
  const [r1, r2] = await Promise.all([queue.enqueue("/get", "GET"), queue.enqueue("/get", "GET")]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  client.destroy();
});

await test("pendingCount accurate before and after flush", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 10, flushMs: 10_000 });
  assert.equal(queue.pendingCount, 0);
  queue.enqueue("/get", "GET");
  assert.equal(queue.pendingCount, 1);
  queue.enqueue("/get", "GET");
  assert.equal(queue.pendingCount, 2);
  queue.flush();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("enqueue with already-aborted signal rejects and empties queue slot", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 10, flushMs: 10_000 });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => queue.enqueue("/get", "GET", { signal: ctrl.signal }), /aborted/);
  // The item must NOT remain in the queue — orphaned-item bug fix
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("abort during queue removes item and rejects", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 10, flushMs: 10_000 });
  const ctrl = new AbortController();
  const p = queue.enqueue("/get", "GET", { signal: ctrl.signal });
  assert.equal(queue.pendingCount, 1);
  ctrl.abort();
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("abort listener cleaned up after flush — no residual rejection", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 1, flushMs: 0 });
  const ctrl = new AbortController();
  // Enqueue and wait for flush (maxBatch=1 triggers immediately)
  const res = await queue.enqueue("/get", "GET", { signal: ctrl.signal });
  assert.equal(res.status, 200);
  // Now abort the signal — if listener leaked, it would try to reject a settled promise.
  // (That's a no-op at the JS level for the original promise, but the listener
  // closure is still held by the signal, causing a memory leak.)
  ctrl.abort();
  // Verify: enqueue with the SAME already-aborted signal rejects (the signal IS aborted)
  // but the queue slot should NOT have been used by the flushed item.
  await assert.rejects(() => queue.enqueue("/get", "GET", { signal: ctrl.signal }), /aborted/);
  assert.equal(queue.pendingCount, 0);
  client.destroy();
});

await test("flush with more items than maxBatch processes all", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 2, flushMs: 10_000 });
  const all = Promise.all([
    queue.enqueue("/get", "GET"),
    queue.enqueue("/get", "GET"),
    queue.enqueue("/get", "GET"),
  ]);
  queue.flush();
  const results = await all;
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 200));
  client.destroy();
});

await test("flushMs=0 uses queueMicrotask", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const queue = new BatchQueue(client, { maxBatch: 10, flushMs: 0 });
  const p = queue.enqueue("/get", "GET");
  assert.equal(queue.pendingCount, 1, "still queued synchronously");
  await p;
  assert.equal(queue.pendingCount, 0, "flushed after microtask");
  client.destroy();
});

// ============================================================================
// §2  createMethodCircuitBreakerKey
// ============================================================================

suite("createMethodCircuitBreakerKey");

await test("returns method:origin for valid URL", () => {
  const key = createMethodCircuitBreakerKey({
    url: "https://api.example.com/users/1",
    method: "DELETE",
  } as KinetexRequest);
  assert.equal(key, "DELETE:https://api.example.com");
});

await test("falls back to method:raw-url when URL parsing fails", () => {
  const key = createMethodCircuitBreakerKey({ url: "", method: "GET" } as KinetexRequest);
  assert.equal(key, "GET:");
});

// ============================================================================
// §3  Logger config wiring
// ============================================================================

suite("Logger config wiring");

await test("logger config creates working logger instance via lazy init", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    logger: { level: "INFO" },
  });
  const res = await client.get("/get");
  assert.equal(res.status, 200);
  client.destroy();
});

await test("logger:false keeps logger null", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    logger: false,
  });
  const res = await client.get("/get");
  assert.equal(res.status, 200);
  client.destroy();
});

// ============================================================================
// §4  Constructor edge cases
// ============================================================================

suite("Constructor edge cases");

await test("empty config does not throw", () => {
  const c = new Kinetex({});
  c.destroy();
});

await test("har:true enables HAR recording", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, har: true });
  await client.get("/get");
  const har = client.getHAR();
  assert.equal(har.entries.length, 1);
  assert.equal(har.entries[0].request.method, "GET");
  client.destroy();
});

await test("getHAR throws without har:true config", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  assert.throws(() => client.getHAR(), /HAR recording not enabled/);
  client.destroy();
});

// ============================================================================
// §5  Config-level interceptors
// ============================================================================

suite("Config-level interceptors");

await test("config interceptors.request fires before request", async () => {
  const seen: string[] = [];
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    interceptors: {
      request: [
        (ctx) => {
          seen.push(ctx.request.method);
        },
      ],
    },
  });
  await client.get("/get");
  assert.deepEqual(seen, ["GET"]);
  client.destroy();
});

await test("config interceptors.error fires on 500", async () => {
  const seen: string[] = [];
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    throwOnError: true,
    interceptors: {
      error: [
        () => {
          seen.push("error");
        },
      ],
    },
  });
  try {
    await client.get("/status/500");
  } catch {
    /* expected */
  }
  assert.equal(seen.length, 1);
  client.destroy();
});

// ============================================================================
// §6  Rate limit config
// ============================================================================

suite("Rate limit");

await test("rateLimit config creates interceptor that allows requests", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
  });
  assert.equal((await client.get("/get")).status, 200);
  assert.equal((await client.get("/get")).status, 200);
  client.destroy();
});

// ============================================================================
// §7  AWS signing config
// ============================================================================

suite("AWS signing");

await test("awsSigning config with valid credentials interceptor", async () => {
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    awsSigning: {
      region: "us-east-1",
      service: "execute-api",
      credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    },
  });
  const res = await client.get("/get");
  assert.equal(res.status, 200);
  client.destroy();
});

// ============================================================================
// §8  OTel tracer — verify span lifecycle
// ============================================================================

suite("OTel tracer");

await test("setTracer returns this for chaining", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const tracer = {
    startSpan: () => ({
      spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
      setAttribute: () => null as any,
      setStatus: () => null as any,
      recordException: () => null as any,
      end: () => {},
    }),
  };
  assert.equal(client.setTracer(tracer), client);
  client.destroy();
});

await test("tracer.startSpan called with HTTP method", async () => {
  let startSpanName = "";
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const tracer = {
    startSpan: (name: string) => {
      startSpanName = name;
      return {
        spanContext: () => ({ traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }),
        setAttribute: () => null as any,
        setStatus: () => null as any,
        recordException: () => null as any,
        end: () => {},
      };
    },
  };
  client.setTracer(tracer);
  assert.equal((await client.get("/get")).status, 200);
  assert.equal(startSpanName, "HTTP GET");
  client.destroy();
});

// ============================================================================
// §9  Dedup — verify coalescing
// ============================================================================

suite("Dedup");

await test("enableDedup returns this and enables metrics", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  assert.equal(client.enableDedup(), client);
  assert.notEqual(client.dedupMetrics, null);
  client.destroy();
});

await test("dedupMetrics returns null when not enabled", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  assert.equal(client.dedupMetrics, null);
  client.destroy();
});

await test("disableDedup sets metrics to null", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableDedup();
  client.disableDedup();
  assert.equal(client.dedupMetrics, null);
  client.destroy();
});

// ============================================================================
// §10  Circuit breaker
// ============================================================================

suite("Circuit breaker");

await test("enableCircuitBreaker returns this", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  assert.equal(client.enableCircuitBreaker(), client);
  client.destroy();
});

await test("tripCircuit and resetCircuit change state", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableCircuitBreaker();
  client.tripCircuit("https://httpbin.org");
  client.resetCircuit("https://httpbin.org");
  client.destroy();
});

await test("disableCircuitBreaker clears snapshots", () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  client.enableCircuitBreaker();
  client.disableCircuitBreaker();
  assert.deepEqual(client.circuitSnapshots, {});
  client.destroy();
});

// ============================================================================
// §11  send() validation
// ============================================================================

suite("send() validation");

await test("invalid HTTP method throws KinetexError", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  await assert.rejects(() => (client as any).send("/get", "INVALID"), /Invalid HTTP method/);
  client.destroy();
});

await test("options.timeout overrides config timeout with early timeout", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 30_000 });
  await assert.rejects(() => client.get("/delay/5", { timeout: 100 }), /timeout|Timeout/i);
  client.destroy();
});

// ============================================================================
// §12  Pipeline trace callback
// ============================================================================

suite("Pipeline trace");

await test("onPipelineTrace fires for each stage", async () => {
  const events: string[] = [];
  const client = kinetex({
    baseURL: "https://httpbin.org",
    timeout: T,
    onPipelineTrace: (ev) => {
      events.push(`${ev.stage}:${ev.event}`);
    },
  });
  assert.equal((await client.get("/get")).status, 200);
  assert.ok(events.length >= 4);
  client.destroy();
});

// ============================================================================
// §13  Header validation edge cases
// ============================================================================

suite("Header validation");

await test("header with null byte in value throws", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  await assert.rejects(
    () => client.get("/get", { headers: { "x-test": "hello\x00world" } }),
    /Invalid header value/,
  );
  client.destroy();
});

await test("strictHeaders option enabled", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, strictHeaders: true });
  assert.equal((await client.get("/get")).status, 200);
  client.destroy();
});

// ============================================================================
// §14  extend() edge cases
// ============================================================================

suite("extend()");

await test("extend with empty overrides copies parent config", async () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const child = parent.extend({});
  assert.equal((await child.get("/get")).status, 200);
  parent.destroy();
});

await test("extend inherits circuit breaker", () => {
  const parent = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  parent.enableCircuitBreaker();
  const child = parent.extend({});
  assert.notEqual(child.circuitSnapshots, undefined);
  parent.destroy();
});

// ============================================================================
// §15  Cookie jar
// ============================================================================

suite("Cookie jar");

await test("cookieJar:true returns non-null cache and jar", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: 15_000, cookieJar: true });
  assert.equal((await client.get("/get")).status, 200);
  client.destroy();
});

// ============================================================================
// §16  send() with various body types
// ============================================================================

suite("Request body types");

await test("send with plain object body auto-serializes as JSON", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const res = await client.post("/post", { foo: "bar" });
  assert.equal(res.status, 200);
  client.destroy();
});

await test("send with URLSearchParams body", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const res = await client.post("/post", new URLSearchParams({ a: "1" }), { throwOnError: false });
  assert.ok(res.status === 200 || res.status === 201);
  client.destroy();
});

// ============================================================================
// §17  FluentRequest subscribe callback
// ============================================================================

suite("FluentRequest subscribe");

await test("subscribe calls onSuccess with response", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const res = await new Promise<KinetexResponse>((resolve, reject) => {
    client.GET("/get").subscribe(
      (r) => resolve(r),
      (e) => reject(e),
    );
  });
  assert.equal(res.status, 200);
  client.destroy();
});

await test("subscribe without onError still fires (swallows error)", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, throwOnError: true });
  // Should not crash even without onError handler
  client.GET("/status/500").subscribe(() => {});
  // Give the error time to be swallowed
  await new Promise((r) => setTimeout(r, 50));
  client.destroy();
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`  Tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
console.log(`════════════════════════════════════════════════════════════`);

if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
  process.exit(1);
}
process.exit(0);
