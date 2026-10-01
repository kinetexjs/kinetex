/**
 * kinetex — regression tests for bug fixes whose new branches were otherwise
 * unreachable from the normal suites.
 *
 * Each block here corresponds to a fix recorded in CHANGELOG 1.3.0 whose
 * guarded code path no existing test executed, so a future refactor could
 * silently undo it.
 */

import assert from "node:assert/strict";
import { imdsCredentials } from "../src/aws-sigv4.ts";
import { DedupMap } from "../src/dedup.ts";
import { HTTPCache, MemoryStorageAdapter } from "../src/cache.ts";
import { kinetex } from "../src/mod.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

const TEST_BUDGET_MS = 45_000;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(
          () => reject(new Error(`exceeded the ${TEST_BUDGET_MS}ms per-test budget`)),
          TEST_BUDGET_MS,
        );
      }),
    ]);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// IMDS role name must be percent-encoded
// ============================================================================

suite("IMDS credential provider");

/** Swap globalThis.fetch for `fn`, restoring it afterwards. */
async function withFetch<T>(
  fn: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = fn as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    g.fetch = prev;
  }
}

await test("percent-encodes an IMDS role name before building the credentials URL", async () => {
  // The role name comes from the metadata response. Interpolated raw, a role of
  // `../user-data` would have redirected the credentials request to a different
  // path on the metadata endpoint.
  const urls: string[] = [];
  const creds = await withFetch(
    async (url) => {
      urls.push(url);
      if (url.endsWith("/latest/api/token")) return new Response("TOKEN123");
      if (url.endsWith("/security-credentials/")) return new Response("../../user-data\n");
      return new Response(
        JSON.stringify({
          AccessKeyId: "AKIAEXAMPLE",
          SecretAccessKey: "secret",
          Token: "session",
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    () => imdsCredentials()(),
  );

  assert.equal(creds.accessKeyId, "AKIAEXAMPLE");
  const credsUrl = urls[urls.length - 1];
  assert.ok(
    credsUrl.includes("..%2F..%2Fuser-data"),
    `role name must be percent-encoded, got ${credsUrl}`,
  );
  // The raw traversal must not survive into the path.
  assert.ok(!credsUrl.includes("/../"), `role name must not traverse, got ${credsUrl}`);
});

await test("rejects an endpoint outside the IMDS allowlist", () => {
  assert.throws(
    () => imdsCredentials({ endpoint: "http://evil.example.com" }),
    /Invalid IMDS endpoint/,
  );
  assert.throws(() => imdsCredentials({ endpoint: "http://169.254.169.254.evil.com" }), /Invalid/);
});

// ============================================================================
// DedupMap: a new dedup window must clear the previous key's timer
// ============================================================================

suite("DedupMap window handling");

await test("registering a new window clears the previous timer for that key", async () => {
  const dedup = new DedupMap<string>({ windowMs: 60_000 });
  // `timeouts` is internal bookkeeping; reading it is the point of this test.
  const timeouts = (
    dedup as unknown as {
      timeouts: Map<string, ReturnType<typeof setTimeout>>;
    }
  ).timeouts;
  let calls = 0;
  const factory = async () => {
    calls++;
    return `result-${calls}`;
  };

  // First call: registers a 60s timer for this key.
  assert.equal(await dedup.execute("GET", "https://example.com/x", factory), "result-1");
  assert.equal(timeouts.size, 1);

  // Second call with a window that has already elapsed: the entry is treated as
  // expired, so a fresh request runs. Its resolution must clear the stale 60s
  // timer — otherwise that timer fires later and deletes the *new* entry from
  // `inflight` while callers are still sharing it.
  await delay(5);
  assert.equal(
    await dedup.execute("GET", "https://example.com/x", factory, undefined, 1),
    "result-2",
  );
  assert.equal(calls, 2);
  assert.equal(timeouts.size, 1, "the stale timer must be replaced, not duplicated");
  dedup.clear();
});

await test("an in-flight request is coalesced regardless of the window", async () => {
  // `execute` treats a *resolved* entry as cacheable and gates that on the
  // window, but an entry that is still in flight is always shared — "this is
  // coalescing, not caching, so it is not gated on the window". A zero window
  // is therefore not a way to force a duplicate request, and the timer test
  // above ("a fresh request runs") only means that because its first call had
  // already completed. Nothing pinned that distinction, and reading the test
  // above the other way round would assert the opposite of the design.
  const dedup = new DedupMap<string>({ windowMs: 60_000 });
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const factory = async (): Promise<string> => {
    calls++;
    await gate;
    return "shared";
  };

  const first = dedup.execute("GET", "https://example.com/y", factory, undefined, 0);
  // windowMs: 0 — an expired window — while the first is still running.
  const second = dedup.execute("GET", "https://example.com/y", factory, undefined, 0);
  release!();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, "shared");
  assert.equal(b, "shared");
  assert.equal(
    calls,
    1,
    "an in-flight request must be shared even with a zero window — that is coalescing, not caching",
  );

  // Once it has resolved, the same zero window does start a new request.
  const third = await dedup.execute("GET", "https://example.com/y", factory, undefined, 0);
  assert.equal(third, "shared");
  assert.equal(calls, 2, "a resolved entry with an elapsed window must not be reused");
  dedup.clear();
});

// ============================================================================
// Cache: tag references must be cleaned even when storage already lost the entry
// ============================================================================

suite("Cache tag index cleanup");

await test("a tag index reference is dropped even when storage has no entry", async () => {
  const storage = new MemoryStorageAdapter();
  const cache = new HTTPCache({ storage });

  await cache.set(
    { url: "https://example.com/a", method: "GET", headers: {} },
    { status: 200, statusText: "OK", headers: {}, body: "x" },
    { tags: ["user"] },
  );

  // Simulate the entry vanishing from storage while the tag index still points
  // at it (eviction out from under the index, a cleared backend, a TTL race).
  await storage.clear();

  const tagIndex = (cache as unknown as { tagIndex: Map<string, Set<string>> }).tagIndex;
  assert.equal(tagIndex.get("user")?.size, 1, "precondition: the tag still references the key");

  const count = await cache.invalidateByTag("user");
  assert.equal(count, 1);

  // The regression this guards: the stale reference used to be left behind
  // forever, growing tagIndex on every eviction.
  assert.equal(tagIndex.get("user"), undefined, "the tag set must not outlive its entries");
});

// ============================================================================
// Client: trace propagation and the retry debug log
// ============================================================================

suite("W3C trace context propagation");

await test("a caller-supplied meta.traceId produces a traceparent header", async () => {
  // With no OTel tracer set, a caller who already has a trace id should still
  // get it propagated, otherwise the hop silently breaks the trace.
  let traceparent: unknown = null;
  const client = kinetex({
    baseURL: "https://example.invalid",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    interceptors: {
      request: [
        (ctx) => {
          traceparent = ctx.request.headers.traceparent;
          return ctx;
        },
      ],
    },
  });

  await client.get("/x", { meta: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" } });
  client.destroy();

  assert.match(
    String(traceparent),
    /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    `expected a version-00 traceparent carrying the caller's trace id, got ${String(traceparent)}`,
  );
});

await test("an explicit traceparent header is not overwritten", async () => {
  let traceparent: unknown = null;
  const client = kinetex({
    baseURL: "https://example.invalid",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    interceptors: {
      request: [
        (ctx) => {
          traceparent = ctx.request.headers.traceparent;
          return ctx;
        },
      ],
    },
  });

  await client.get("/x", {
    headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    meta: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" },
  });
  client.destroy();

  assert.equal(traceparent, "00-11111111111111111111111111111111-2222222222222222-01");
});

// ============================================================================
// Client: OTel span lifecycle on a pre-dispatch failure
// ============================================================================

suite("OpenTelemetry span lifecycle");

/** Records what the client does to a span. */
function recordingSpan() {
  const events: string[] = [];
  return {
    events,
    span: {
      spanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      }),
      setAttribute() {
        return this;
      },
      setStatus(s: { code: number; message?: string }) {
        events.push(`status:${s.code}`);
        return this;
      },
      recordException() {
        events.push("exception");
        return this;
      },
      end() {
        events.push("end");
      },
    },
  };
}

await test("a span is ended and marked as errored when a pre-dispatch step throws", async () => {
  // The span is created before the dispatch try/catch. If something between
  // startSpan() and dispatch throws (here the SDK's own spanContext()), the
  // span used to be abandoned: never exported, never reporting the error, and
  // holding its attributes in the tracer's memory.
  const { events, span } = recordingSpan();
  const client = kinetex({
    baseURL: "https://example.invalid",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  const broken = {
    ...span,
    spanContext: () => {
      throw new Error("spanContext exploded");
    },
  };
  client.setTracer({ startSpan: () => broken as never });

  await assert.rejects(
    () => client.get("/x"),
    (err: Error) => err.message === "spanContext exploded",
  );
  client.destroy();

  assert.ok(events.includes("end"), `the span must be ended, saw ${events.join(",")}`);
  assert.ok(
    events.includes("status:2"),
    `the span must be marked as errored, saw ${events.join(",")}`,
  );
});

await test("a successful request ends its span normally", async () => {
  const { events, span } = recordingSpan();
  const client = kinetex({
    baseURL: "https://example.invalid",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  client.setTracer({ startSpan: () => span as never });

  await client.get("/x");
  client.destroy();

  assert.ok(events.includes("end"), `the span must be ended, saw ${events.join(",")}`);
  assert.ok(!events.includes("status:2"), "a successful request must not error the span");
  // `end` exactly once: a span ended twice is exported twice, which double
  // counts every request in the trace and is a very common SDK misuse.
  assert.equal(
    events.filter((e) => e === "end").length,
    1,
    `the span must be ended exactly once, saw ${events.join(",")}`,
  );
  assert.ok(
    !events.includes("exception"),
    "a successful request must not record an exception on the span",
  );
});

// ============================================================================
// Client: retry debug logging
// ============================================================================

suite("Retry diagnostics");

await test("__KINETEX_DEBUG_RETRY logs the retry decision on failure", async () => {
  // An opt-in diagnostic for debugging retry behaviour. It has to stay working:
  // it is the only visibility into why a request is being retried.
  const g = globalThis as Record<string, unknown>;
  g.__KINETEX_DEBUG_RETRY = true;
  const logged: unknown[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith("DBG")) logged.push(args[0]);
  };
  try {
    // The diagnostics live on the failure path, so the attempt has to throw —
    // a plain 503 with throwOnError:false is a response, not an error.
    const client = kinetex({
      baseURL: "https://example.invalid",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, jitter: 0 },
    });
    // Asserted, not swallowed: `throwOnError: false` suppresses HTTP-status
    // errors, not transport failures, so a TypeError from fetch must still
    // surface. A bare `.catch(() => {})` would hide a regression that made
    // this request succeed — which is the very thing that would stop the
    // retry diagnostics from being emitted.
    await assert.rejects(
      () => client.get("/x", { throwOnError: false }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "a transport failure must still reject");
        assert.equal((err as { code?: string }).code, "ENETWORK");
        return true;
      },
    );
    client.destroy();
  } finally {
    console.log = realLog;
    delete g.__KINETEX_DEBUG_RETRY;
  }

  assert.ok(logged.includes("DBG catch"), "the retry catch path must log when debugging is on");
});

// ============================================================================
// REGRESSIONS (coverage-gaps round)
// One case per defect found while auditing this file and its siblings
// cross-runtime-node.test.mts and core-unit.test.mts.
// ============================================================================

suite("Regressions (coverage-gaps round)");

/** Stub `globalThis.fetch` for one call and restore it afterwards. */
async function withStubbedFetch<T>(
  body: string,
  status: number,
  run: () => Promise<T>,
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/latest/api/token")) return new Response("T", { status: 200 });
    if (u.includes("security-credentials")) {
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ role: "r" }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    g.fetch = prev;
  }
}

await test("regression: a non-JSON IMDS body fails as ENETWORK, not a raw SyntaxError", async () => {
  // Every other failure in imdsCredentials is a NetworkError. A proxy's HTML
  // error page instead escaped from `Response.json()` as a bare SyntaxError
  // with no `code` at all, so a caller branching on `err.code === "ENETWORK"`
  // never saw it and the message said nothing about IMDS.
  await assert.rejects(
    () => withStubbedFetch("<html>502 Bad Gateway</html>", 200, () => imdsCredentials()()),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.equal((err as { code?: string }).code, "ENETWORK");
      assert.match(err.message, /IMDS/);
      assert.match(err.message, /not JSON/);
      return true;
    },
  );
});

await test("regression: a shapeless IMDS body cannot produce credentials", async () => {
  // `{}` parsed fine and produced accessKeyId: undefined, and a body of nulls
  // produced nulls — both "succeeded". They then went on to produce a SigV4
  // signature AWS rejects as `SignatureDoesNotMatch`, which points at the
  // caller rather than at the metadata endpoint that answered with nonsense.
  for (const body of [
    "{}",
    '{"AccessKeyId":null,"SecretAccessKey":null,"Token":null}',
    // Empty strings are present but unusable: an empty access key cannot sign,
    // so "is it a string" is not the question — "is it a non-empty string" is.
    '{"AccessKeyId":"","SecretAccessKey":"","Token":""}',
    '{"AccessKeyId":"AKIA","SecretAccessKey":"","Token":""}',
    // Only the access key empty: a partial check that validates the secret and
    // token but not the access key would let this through.
    '{"AccessKeyId":"","SecretAccessKey":"secret","Token":"session"}',
  ]) {
    await assert.rejects(
      () => withStubbedFetch(body, 200, () => imdsCredentials()()),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "ENETWORK");
        assert.match(
          (err as Error).message,
          /missing/,
          `body ${body} must be reported as missing fields`,
        );
        return true;
      },
      `body ${body} must be refused`,
    );
  }
});

await test("regression: the IMDS error names every missing field at once", async () => {
  // An operator should not have to re-fetch the metadata endpoint to discover
  // the second missing field.
  await assert.rejects(
    () => withStubbedFetch("{}", 200, () => imdsCredentials()()),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /AccessKeyId/);
      assert.match(m, /SecretAccessKey/);
      assert.match(m, /Token/);
      return true;
    },
  );
});

await test("regression: a complete IMDS body still signs", async () => {
  // The guard added above must not reject the shape IMDS actually returns.
  const good = JSON.stringify({
    AccessKeyId: "AKIAEXAMPLE",
    SecretAccessKey: "secret",
    Token: "session",
    Expiration: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const creds = await withStubbedFetch(good, 200, () => imdsCredentials()());
  assert.equal(creds.accessKeyId, "AKIAEXAMPLE");
  assert.equal(creds.secretAccessKey, "secret");
  assert.equal(creds.sessionToken, "session");
  assert.equal(typeof creds.expiration, "string");
});

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
