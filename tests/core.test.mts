import nodeAssert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import { isUpstreamFlake, isUpstreamStatusDrift } from "./upstream.ts";

const assert = nodeAssert;

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

/**
 * Skip the remaining assertions in the current test when `status` is an
 * upstream failure rather than `expected`. Returns true when it skipped.
 *
 * `isUpstreamFlake` cannot catch this on its own: a mismatched
 * `assert.equal(status, 200)` throws an `AssertionError`, which it
 * deliberately excludes so a genuine assertion failure is never mistaken for
 * a network problem. The status has to be inspected before the assert.
 */
function skipOnUpstreamDrift(name: string, status: number, expected: number): boolean {
  if (!isUpstreamStatusDrift(status, expected)) return false;
  console.log(
    `  ⚠  ${name} — assertions skipped (transient: httpbin answered ${status}, not ${expected})`,
  );
  return true;
}

/**
 * Assert an upstream 200 without failing the run when httpbin answered with a
 * transient error instead. The status has to be inspected before the assert,
 * exactly as `skipOnUpstreamDrift` does — a `502 !== 200` from the third
 * party says nothing about the transport under test.
 *
 * Both classifiers, and the reasoning behind their narrowness, live in
 * `tests/upstream.ts` and are pinned by `tests/upstream-drift.test.mts`.
 */
function assertOkStatus(status: number, label = "httpbin answered 200"): void {
  if (skipOnUpstreamDrift(label, status, 200)) return;
  assert.equal(status, 200);
}

/**
 * Per-test budget. Every client here is built with a 30s timeout, so 45s leaves
 * headroom for the slowest legitimate case while still naming the test that
 * stopped making progress — a hang in this file is otherwise silent, because a
 * top-level `await run(...)` that never settles prints nothing further. The
 * sentinel is a message rather than a flag, so the transient classifier below
 * cannot quietly turn a hang into a skip.
 */
const TEST_BUDGET_MS = 45_000;

async function run(
  name: string,
  fn: () => void | Promise<void>,
  opts: { transient?: string } = {},
) {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<void>((_resolve, race) => {
        timer = setTimeout(
          () => race(new Error("__RACE_EXPIRED__ the test never settled")),
          TEST_BUDGET_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    if (opts.transient && isUpstreamFlake(err)) {
      // Tolerance is scoped to errors that genuinely indicate a flaky third
      // party. A TypeError from our own code, or a failed assertion, is a real
      // defect and must fail the run — otherwise this escape hatch silently
      // converts bugs into green CI.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠  ${name} skipped (transient: ${opts.transient}) — ${msg}`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

import {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  HAS_NATIVE_FETCH,
  FetchTransport,
  NodeHTTP2Transport,
  createTransport,
  parseBody,
  setRuntime,
  getEffectiveRuntime,
} from "../src/mod.ts";
import { sendWithTimeout, readRawBody, decompressBodyStream } from "../src/core.ts";
import { KinetexError, SizeLimitError } from "../src/types.ts";

// ============================================================================
// §1  RUNTIME DETECTION
// ============================================================================

suite("Runtime detection");

await run("detectRuntime returns a known runtime string", () => {
  // Exactly the `Runtime` union, no more. "workerd" was in this list and is
  // not a `Runtime` — `detectRuntime` has no branch that can return it — so it
  // could only ever pad the assertion.
  const valid: string[] = [
    "node",
    "deno",
    "bun",
    "browser",
    "cloudflare-workers",
    "edge",
    "unknown",
  ];
  assert.ok(valid.includes(detectRuntime()), `unexpected runtime: ${detectRuntime()}`);
  // The constant and the effective value answer with members of the same set.
  assert.ok(valid.includes(RUNTIME));
  assert.ok(valid.includes(getEffectiveRuntime()));
  // And it is the one this suite's HTTP/2 branch depends on, not merely a
  // plausible-looking string.
  assert.equal(detectRuntime(), "node", "the NodeHTTP2Transport section below needs Node");
});

await run("RUNTIME constant matches detectRuntime()", () => assert.equal(RUNTIME, detectRuntime()));

await run("IS_NODE is true in Node.js", () => assert.equal(IS_NODE, true));

await run("HAS_NATIVE_FETCH is true in Node 18+", () => assert.equal(HAS_NATIVE_FETCH, true));

await run("setRuntime/getEffectiveRuntime override", () => {
  const prev = getEffectiveRuntime();
  setRuntime("deno");
  assert.equal(getEffectiveRuntime(), "deno");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), prev);
  setRuntime("bun");
  assert.equal(getEffectiveRuntime(), "bun");
  setRuntime(null);
});

// ============================================================================
// §2  TRANSPORT CREATION
// ============================================================================

suite("Transport creation");

await run("createTransport returns transport with send", () => {
  assert.equal(typeof createTransport().send, "function");
});

await run("createTransport with custom fetch (HTTP/1.1)", async () => {
  let called = 0;
  let seenUrl = "";
  // preferHTTP2 is left at its default here on purpose: a custom fetch must
  // force FetchTransport even then, because NodeHTTP2Transport drives node:http2
  // and has nowhere to put one. The test set `called` and never looked at it,
  // so a createTransport that dropped the caller's fetch on the floor passed.
  const t = createTransport(async (url, init) => {
    called++;
    seenUrl = String(url);
    return globalThis.fetch(url, init);
  });
  assert.ok(
    t instanceof FetchTransport,
    `expected FetchTransport, got ${(t as { constructor: { name: string } }).constructor.name}`,
  );
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  assert.equal(called, 1, "the supplied fetch must be the one that runs");
  assert.equal(seenUrl, "https://httpbin.org/get", "and it must receive the resolved URL");
});

// ============================================================================
// §3  FetchTransport
// ============================================================================

suite("FetchTransport");

await run("GET returns 200", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  // A RawResponse with the right status and nothing else — no statusText, no
  // headers, a null body, a wrong protocol — satisfied a status check alone.
  assert.equal(typeof raw.statusText, "string");
  assert.ok(raw.statusText.length > 0, "the reason phrase must be carried through");
  assert.match(raw.headers["content-type"] ?? "", /application\/json/);
  assert.equal(raw.url, "https://httpbin.org/get");
  assert.equal(raw.redirected, false, "a 200 on the URL that was sent is not a redirect");
  assert.equal(raw.httpVersion, "HTTP/1.1", "no runtime evidence, so HTTP/1.1 is reported");
  assert.equal(raw.alreadyDecompressed, true, "fetch() already decoded the body");
  assert.ok(raw.body, "the body must be a stream, not null");
  const decoded = (await new Response(raw.body).json()) as { url?: string };
  assert.equal(decoded.url, "https://httpbin.org/get", "and the bytes must be readable");
});

await run("strict mode rejects invalid headers", async () => {
  // `assert.rejects(fn)` with no predicate is satisfied by *any* rejection,
  // so this passed on a DNS failure, on an EABORT, and on the EVALIDATION it
  // was written for. Pinned to the class, the code, the message, and the fact
  // that the request was never opened.
  let opened = false;
  const t = new FetchTransport({
    strict: true,
    fetchFn: async () => {
      opened = true;
      return new Response("ok");
    },
  });
  await assert.rejects(
    () =>
      t.send({
        url: "https://httpbin.org/get",
        method: "GET",
        headers: { x: "bad\x00header" },
        body: null,
        signal: null,
        meta: {},
        httpVersion: "HTTP/1.1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected a KinetexError, got ${String(err)}`);
      assert.equal((err as { code?: string }).code, "EVALIDATION");
      assert.equal((err as { name?: string }).name, "KinetexError");
      assert.match((err as Error).message, /Invalid header dropped in strict mode/);
      assert.match((err as Error).message, /"x"/, "the offending header is named");
      // The offending request is attached, which is the only way a caller can
      // find out which request it was.
      assert.equal((err as { request?: { url?: string } }).request?.url, "https://httpbin.org/get");
      return true;
    },
    "strict mode must reject an invalid header value",
  );
  assert.equal(opened, false, "the request must never be opened");
});

await run("POST with JSON body returns 200", async () => {
  const t = new FetchTransport();
  const payload = JSON.stringify({ test: true, n: 42 });
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  // A GET returns 200 too. This is the *POST* test and nothing here looked at
  // the body, so a transport that dropped it, sent it as a query parameter or
  // double-encoded it answered 200 and passed.
  const echoed = (await new Response(raw.body).json()) as {
    json: unknown;
    data: string;
    headers: Record<string, string>;
  };
  assert.deepEqual(echoed.json, { test: true, n: 42 }, "the server must see the parsed body");
  assert.equal(echoed.data, payload, "and the exact bytes that were sent");
  assert.match(echoed.headers["Content-Type"] ?? "", /application\/json/);
});

await run("accept-encoding header default value is removed by FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/headers",
    method: "GET",
    headers: { "accept-encoding": "gzip, deflate, br" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  const body = (await new Response(raw.body!).json()) as { headers: Record<string, string> };
  const ae = (body.headers["Accept-Encoding"] ?? "").toLowerCase();
  // Our default "gzip, deflate, br" value should be stripped so fetch()
  // can set its own. Node's fetch adds its own accept-encoding.
  assert.ok(
    !ae.startsWith("gzip"),
    `Our default accept-encoding value should be stripped. Got: ${ae}`,
  );
});

await run("explicit accept-encoding value is preserved by FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/headers",
    method: "GET",
    headers: { "accept-encoding": "identity" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  const body = (await new Response(raw.body!).json()) as { headers: Record<string, string> };
  const ae = (body.headers["Accept-Encoding"] ?? "").toLowerCase();
  // Explicit "identity" should be preserved by FetchTransport
  assert.ok(ae.includes("identity"), `Explicit accept-encoding should be preserved. Got: ${ae}`);
});

await run(
  "FetchTransport reports the URL it was finally served from",
  async () => {
    // `url: response.url || req.url` is the one line that tells a caller where a
    // request actually ended up after a redirect. Nothing in this file exercised
    // it on the fetch path: the only redirect tests go through
    // NodeHTTP2Transport, so a FetchTransport that reported the URL it was *sent*
    // to — the difference a caller needs in order to follow a relative `Location`
    // or to log where the request landed — passed everything here.
    const t = new FetchTransport();
    const raw = await t.send({
      url: "https://httpbin.org/redirect/1",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    });
    assertOkStatus(raw.status, "redirect follow reports redirected");
    assert.equal(raw.redirected, true, "the hop happened");
    assert.ok(
      !raw.url.includes("/redirect/"),
      `the reported URL is the destination, not the request: ${raw.url}`,
    );
    assert.equal(raw.url, "https://httpbin.org/get", "and it is the redirect target itself");
  },
  { transient: "httpbin.org intermittently answers 502 for redirects" },
);

await run("abort signal rejects immediately", async () => {
  const t = new FetchTransport();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  const start = Date.now();
  // The endpoint holds the response open for 5s, so "immediately" is a claim
  // about time and nothing measured it: the only check was that some message
  // contained the word "aborted".
  await assert.rejects(
    () =>
      t.send({
        url: "https://httpbin.org/delay/5",
        method: "GET",
        headers: {},
        body: null,
        signal: ctrl.signal,
        meta: {},
        httpVersion: "HTTP/1.1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected a KinetexError, got ${String(err)}`);
      assert.equal((err as { code?: string }).code, "EABORT");
      assert.equal((err as { name?: string }).name, "KinetexError");
      assert.match((err as Error).message, /aborted/);
      // The runtime's own AbortError survives as the cause rather than being
      // flattened into a message.
      assert.equal((err as { cause?: { name?: string } }).cause?.name, "AbortError");
      return true;
    },
    "an aborted request must reject with EABORT",
  );
  assert.ok(
    Date.now() - start < 4_000,
    `must reject when the signal fires, not when the server answers (${Date.now() - start}ms)`,
  );
});

await run("network error on bad URL", async () => {
  const t = new FetchTransport();
  // TEST-NET-1: guaranteed not routable, so this is a connect failure rather
  // than an answer. `assert.rejects(fn)` with no predicate would be satisfied
  // by any failure at all, including one of our own.
  await assert.rejects(
    () =>
      t.send({
        url: "https://192.0.2.99/nonexistent",
        method: "GET",
        headers: {},
        body: null,
        signal: null,
        meta: {},
        httpVersion: "HTTP/1.1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected a KinetexError, got ${String(err)}`);
      assert.equal((err as { code?: string }).code, "ENETWORK");
      // The underlying failure is kept, so the cause of a network error is
      // still diagnosable.
      assert.ok((err as { cause?: unknown }).cause, "the underlying error is attached as cause");
      return true;
    },
    "an unreachable host must reject with ENETWORK",
  );
});

// ============================================================================
// §4  NodeHTTP2Transport
// ============================================================================

suite("NodeHTTP2Transport");

await run("GET via HTTP/2 returns 200", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  assertOkStatus(raw.status, "GET via HTTP/2 returns 200");
  assert.equal(raw.httpVersion, "HTTP/2");
});

await run("POST with JSON body via HTTP/2", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "h2" }),
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  });
  assertOkStatus(raw.status, "POST with JSON body via HTTP/2");
  // Same gap as the FetchTransport POST above: only the status was checked, so
  // the HTTP/2 body-attachment path — the one with its own serializer, because
  // it bypasses fetch — was never observed actually sending anything.
  const echoed = (await new Response(raw.body).json()) as { json: unknown };
  assert.deepEqual(echoed.json, { hello: "h2" });
});

await run(
  "session reuse to same origin",
  async () => {
    const t = new NodeHTTP2Transport();
    const r1 = await t.send({
      url: "https://httpbin.org/get",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/2",
    });
    const r2 = await t.send({
      url: "https://httpbin.org/uuid",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/2",
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  },
  { transient: "httpbin.org intermittently answers 502 for h2 session reuse" },
);

await run("request timeout fires", async () => {
  const t = new NodeHTTP2Transport({ requestTimeoutMs: 500 });
  const start = Date.now();
  try {
    await t.send({
      url: "https://httpbin.org/delay/5",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/2",
    });
    assert.fail("should have timed out");
  } catch (err: any) {
    assert.ok(Date.now() - start < 10_000, "must fail at the timeout, not hang");
    // The code, not "ETIMEOUT or a message that happens to mention it": a
    // generic network error carrying the word "timed out" used to satisfy this.
    assert.equal(err.code, "ETIMEOUT", "the failure must carry the timeout code");
    // A transport-level request timeout is a plain KinetexError carrying
    // ETIMEOUT, not the client-level `TimeoutError` the timeout interceptor
    // throws. Pinning the distinction keeps the two paths from drifting into
    // one another unnoticed.
    assert.equal(
      err.name,
      "KinetexError",
      "the transport timeout is a KinetexError, not a client-level TimeoutError",
    );
    const { KinetexError } = await import("../src/types.ts");
    assert.ok(
      err instanceof KinetexError,
      `expected a KinetexError, got ${err?.constructor?.name ?? typeof err}`,
    );
  }
});

await run("HTTP/1.1 fallback", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assertOkStatus(raw.status);
  assert.equal(raw.httpVersion, "HTTP/1.1");
});

await run("follows redirect", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/redirect/1",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
    redirect: "follow",
  });
  assertOkStatus(raw.status);
  // Was a bare truthiness check on the flag, which is false by default and so
  // only ever proved the constructor set it. Pin the flag and the hop itself.
  assert.equal(raw.redirected, true);
  // The hop itself, without coupling to httpbin's redirect target: the
  // returned URL must no longer be the /redirect/1 URL that was sent.
  assert.ok(
    !raw.url.includes("/redirect/"),
    `transport should report the post-redirect url, got ${raw.url}`,
  );
});

await run("redirect manual returns 3xx", async () => {
  const t = new NodeHTTP2Transport();
  const raw = await t.send({
    url: "https://httpbin.org/redirect/1",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
    redirect: "manual",
  });
  // The remaining assertions all read `raw.status`, and a range check is not a
  // status comparison, so it was the one assertion here an httpbin outage
  // could fail. `skipOnUpstreamDrift` is asked first, exactly as the status
  // assertions elsewhere in this file do it.
  if (skipOnUpstreamDrift("redirect manual returns 3xx", raw.status, 302)) return;
  assert.ok(raw.status >= 300 && raw.status < 400);
  // `assert.ok(raw.headers["location"])` is true of any non-empty string, and
  // of a boolean, and of a number. The status is pinned to the two a single-hop
  // redirect can return, and the target is pinned to the hop itself.
  assert.ok(
    raw.status === 302 || raw.status === 303,
    `a one-hop redirect answers 302 or 303, got ${raw.status}`,
  );
  assert.equal(typeof raw.headers["location"], "string");
  // RFC 9110 §10.2.2 allows Location to be a relative reference, and this
  // origin sends one ("/get"), so the shape that matters is that it is *not*
  // the URL that was sent — i.e. the hop was computed, not echoed.
  assert.ok(
    !raw.headers["location"]!.includes("/redirect/"),
    `the target must be the destination, got ${raw.headers["location"]}`,
  );
  assert.match(raw.headers["location"]!, /^(\/|https?:)/, "a path or an absolute URL");
  // Nothing followed it: the URL reported is still the one that was sent.
  assert.equal(raw.url, "https://httpbin.org/redirect/1");
  assert.equal(raw.redirected, false, "with redirect: manual nothing is followed");
});

await run("destroy cleanly", () => {
  let t: NodeHTTP2Transport | undefined;
  assert.doesNotThrow(() => {
    t = new NodeHTTP2Transport();
  });
  assert.ok(t !== undefined, "the constructor must return a transport");
  // destroy() is documented as idempotent; a second call must also not throw.
  assert.doesNotThrow(() => t!.destroy());
  assert.doesNotThrow(() => t!.destroy());
  assert.equal(typeof t!.send, "function", "destroy must leave a usable-shaped object");
});

await run("custom session options construct", () => {
  let t: NodeHTTP2Transport | undefined;
  assert.doesNotThrow(() => {
    t = new NodeHTTP2Transport({ sessionTTLMs: 100, pingIntervalMs: 0 });
  });
  assert.ok(t !== undefined);
  // The options must actually land on the instance, not just be accepted.
  // This read `_sessionTTLMs`, which is not a field the transport has at all —
  // the real ones carry no underscore — so the assertion reduced to
  // `undefined === 100 || undefined === undefined`, which is true of a
  // constructor that ignored every option it was handed.
  const priv = t as unknown as Record<string, unknown>;
  assert.equal(priv.sessionTTLMs, 100, "sessionTTLMs must reach the instance");
  assert.equal(priv.pingIntervalMs, 0, "and 0 must survive rather than become the default");
  // The rest of the option surface, including the three this test did not
  // mention at all — a `maxSessions` that never arrives is what let the pool
  // grow without bound.
  const full = new NodeHTTP2Transport({
    maxSessions: 3,
    connectTimeoutMs: 1111,
    requestTimeoutMs: 2222,
    http1MaxSockets: 7,
    strict: true,
    ca: "-----BEGIN CERTIFICATE-----",
  }) as unknown as Record<string, unknown>;
  assert.equal(full.maxSessions, 3, "maxSessions");
  assert.equal(full._connectTimeoutMs, 1111, "connectTimeoutMs");
  assert.equal(full._requestTimeoutMs, 2222, "requestTimeoutMs");
  assert.equal(full._http1MaxSockets, 7, "http1MaxSockets");
  assert.equal(full._strict, true, "strict");
  assert.equal(full._ca, "-----BEGIN CERTIFICATE-----", "ca");
  // And the documented defaults when nothing is passed.
  const def = new NodeHTTP2Transport() as unknown as Record<string, unknown>;
  assert.equal(def.sessionTTLMs, 300_000, "sessionTTLMs default");
  assert.equal(def.pingIntervalMs, 30_000, "pingIntervalMs default");
  assert.equal(def.maxSessions, 100, "maxSessions default");
  assert.equal(def._connectTimeoutMs, 30_000, "connectTimeoutMs default");
  assert.equal(def._requestTimeoutMs, 30_000, "requestTimeoutMs default");
  assert.equal(def._http1KeepAlive, true, "http1KeepAlive default");
  assert.equal(def._http1MaxSockets, 16, "http1MaxSockets default");
  assert.equal(def._strict, false, "strict default");
  for (const x of [t!, full, def] as unknown as Array<{ destroy(): void }>) {
    assert.doesNotThrow(() => x.destroy());
  }
});

// ============================================================================
// §5  sendWithTimeout
// ============================================================================

suite("sendWithTimeout");

await run("timeout=0 passes through", async () => {
  const raw = await sendWithTimeout(
    new FetchTransport(),
    {
      url: "https://httpbin.org/get",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    },
    0,
  );
  assertOkStatus(raw.status);
});

await run("normal request completes", async () => {
  const raw = await sendWithTimeout(
    new FetchTransport(),
    {
      url: "https://httpbin.org/get",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    },
    10000,
  );
  assertOkStatus(raw.status);
});

await run("throws TimeoutError on timeout", async () => {
  try {
    await sendWithTimeout(
      new FetchTransport(),
      {
        url: "https://httpbin.org/delay/5",
        method: "GET",
        headers: {},
        body: null,
        signal: null,
        meta: {},
        httpVersion: "HTTP/1.1",
      },
      500,
    );
    assert.fail("should have timed out");
  } catch (err: any) {
    assert.equal(err.code, "ETIMEOUT");
  }
});

// ============================================================================
// §6  readRawBody
// ============================================================================

suite("readRawBody");

await run("null stream returns empty", async () => {
  assert.equal((await readRawBody(null, 0, "")).byteLength, 0);
});

await run("reads bytes from stream", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  assert.deepEqual(Array.from(await readRawBody(s, 0, "")), [1, 2, 3]);
});

await run("enforces size limit", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(100));
      c.close();
    },
  });
  await assert.rejects(
    () => readRawBody(s, 50, ""),
    (err: unknown) => {
      assert.ok(err instanceof SizeLimitError, `expected a SizeLimitError, got ${String(err)}`);
      assert.match((err as Error).message, /size limit/i);
      // The counts are the diagnostic — how much arrived against what was
      // allowed. A regex over the message cannot tell 100 bytes from 50.
      const e = err as SizeLimitError & { limit?: number };
      assert.equal(e.limit, 50, "the configured limit is reported");
      assert.match((err as Error).message, /100 bytes/, "and how much had arrived");
      return true;
    },
    "a body over the limit must be refused",
  );
  // The limit is inclusive: a body of exactly maxBytes is allowed through, and
  // this is the boundary the old regex-over-a-single-oversized-chunk test never
  // reached.
  const exact = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(25));
      c.enqueue(new Uint8Array(25));
      c.close();
    },
  });
  assert.equal((await readRawBody(exact, 50, "")).byteLength, 50);
});

await run("abort signal cancels", async () => {
  const s = new ReadableStream({
    start(c) {
      /* never close */
    },
  });
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(
    () => readRawBody(s, 0, "", c.signal),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError, `expected a KinetexError, got ${String(err)}`);
      assert.equal((err as { code?: string }).code, "EABORT");
      assert.equal((err as Error).message, "Response reading aborted");
      return true;
    },
    "an abort mid-read must reject with EABORT",
  );
});

await run("pre-aborted signal throws immediately", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(5));
      c.close();
    },
  });
  const c = new AbortController();
  c.abort();
  const start = Date.now();
  await assert.rejects(
    () => readRawBody(s, 0, "", c.signal),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal((err as { code?: string }).code, "EABORT");
      return true;
    },
    "an already-aborted signal must reject with EABORT",
  );
  // "Immediately" is a claim about time. The stream enqueues and closes, so a
  // version that read it first and consulted the signal afterwards would
  // resolve with the bytes and pass a substring check on some other error.
  assert.ok(Date.now() - start < 50, "and without draining the stream first");
});

await run("readRawBody with stream that errors on read", async () => {
  const s = new ReadableStream({
    start(c) {
      c.error(new Error("stream-error"));
    },
  });
  await assert.rejects(() => readRawBody(s, 0, ""), /stream-error/);
});

// ============================================================================
// §7  parseBody
// ============================================================================

suite("parseBody");

await run("parses JSON", () => {
  const r = parseBody(new TextEncoder().encode(JSON.stringify({ a: 1 })), "application/json");
  assert.equal((r as any).a, 1);
});

await run("text content-type returns string", () => {
  assert.equal(parseBody(new TextEncoder().encode("hi"), "text/plain"), "hi");
});

await run("binary returns Uint8Array", () => {
  // `instanceof` alone is satisfied by a Uint8Array of the wrong bytes, or of
  // none at all.
  const r = parseBody(new Uint8Array([0xff, 0xaa]), "application/octet-stream");
  assert.ok(r instanceof Uint8Array);
  assert.deepEqual(Array.from(r as Uint8Array), [0xff, 0xaa], "the bytes are carried through");
  // A content type carrying parameters takes the same branch.
  const withParams = parseBody(
    new Uint8Array([1]),
    "application/octet-stream; charset=binary",
  ) as Uint8Array;
  assert.deepEqual(Array.from(withParams), [1]);
});

await run("empty body returns null", () =>
  assert.equal(parseBody(new Uint8Array(0), "application/json"), null),
);

await run("JSON parse failure falls back to text", () => {
  assert.equal(parseBody(new TextEncoder().encode("not-json"), "application/json"), "not-json");
  // The hook is the designed way to learn the parse failed, and nothing in this
  // file had ever passed one.
  const seen: Array<{ bytes: number; code: string; message: string }> = [];
  const raw = new TextEncoder().encode("not-json");
  assert.equal(
    parseBody(raw, "application/json", undefined, (bytes, err) => {
      seen.push({
        bytes: bytes.byteLength,
        code: (err as { code?: string }).code ?? "",
        message: err.message,
      });
    }),
    "not-json",
  );
  assert.equal(seen.length, 1, "the hook fires exactly once");
  assert.equal(seen[0]!.bytes, raw.byteLength, "and receives the raw bytes, not the text");
  assert.equal(seen[0]!.code, "PARSE_ERROR", "with the reason on the error");
  assert.match(seen[0]!.message, /falling back to raw text/);
  // A hook that throws must not take the response down with it.
  assert.equal(
    parseBody(new TextEncoder().encode("not-json"), "application/json", undefined, () => {
      throw new Error("hook exploded");
    }),
    "not-json",
  );
});

await run("custom parser", () => {
  const r = parseBody(
    new TextEncoder().encode("x"),
    "text/plain",
    (b) => `p:${new TextDecoder().decode(b)}`,
  );
  assert.equal(r, "p:x");
});

await run("+json content-type", () => {
  const r = parseBody(
    new TextEncoder().encode(JSON.stringify({ ok: true })),
    "application/vnd.api+json",
  );
  assert.equal((r as any).ok, true);
});

// ============================================================================
// §8  decompressBodyStream
// ============================================================================

suite("decompressBodyStream");

await run("null body returns null", async () =>
  assert.equal(await decompressBodyStream(null, {}), null),
);

await run("no content-encoding returns stream as-is", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const r = await decompressBodyStream(s, {});
  const reader = r!.getReader();
  assert.deepEqual(Array.from((await reader.read()).value!), [1, 2, 3]);
});

await run("identity encoding strips header", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([4, 5, 6]));
      c.close();
    },
  });
  const h: Record<string, string> = { "content-encoding": "identity" };
  await decompressBodyStream(s, h);
  assert.equal(h["content-encoding"], undefined);
});

await run("gzip decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ gzipped: boolean }>("/gzip");
  assert.equal(r.status, 200);
  assert.equal(r.data.gzipped, true);
});

await run("deflate decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ deflated: boolean }>("/deflate");
  assert.equal(r.status, 200);
  assert.equal(r.data.deflated, true);
});

await run("brotli decompression via httpbin", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T });
  const r = await client.get<{ brotli: boolean }>("/brotli");
  assert.equal(r.status, 200);
  assert.equal(r.data.brotli, true);
});

// ============================================================================
// §9  REAL HTTP CALLS
// ============================================================================

suite("Real HTTP");

await run("GET /get returns 200", async () =>
  assert.equal((await httpbin.get("/get")).status, 200),
);

await run("POST echoes body", async () => {
  const r = await httpbin.post("/post", { x: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.json, { x: 1 });
});

await run("redirect followed", async () =>
  assert.equal((await httpbin.get("/redirect/2")).status, 200),
);

await run("/uuid returns UUID", async () => {
  const r = await httpbin.get("/uuid");
  assert.equal(r.status, 200);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(typeof r.data.uuid, "string");
  assert.ok(uuidPattern.test(r.data.uuid), `Expected valid UUID, got: ${r.data.uuid}`);
});

await run("/ip returns IP", async () => {
  const r = await httpbin.get("/ip");
  assert.equal(r.status, 200);
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  assert.equal(typeof r.data.origin, "string");
  assert.ok(ipv4Pattern.test(r.data.origin), `Expected valid IPv4, got: ${r.data.origin}`);
});

await run("/json returns slideshow", async () => {
  const r = await httpbin.get("/json");
  assert.equal(r.status, 200);
  assert.ok(r.data.slideshow, "slideshow should exist");
  assert.equal(typeof r.data.slideshow, "object");
  assert.equal(r.data.slideshow.author, "Yours Truly");
  assert.ok(Array.isArray(r.data.slideshow.slides));
});

await run("/anything echoes json", async () => {
  const r = await httpbin.post("/anything", { msg: "core-test" });
  assert.equal(r.status, 200);
  assert.equal(r.data.json.msg, "core-test");
});

await run("/base64 decodes", async () => {
  const r = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(r.status, 200);
  assert.equal(String(r.data).trim(), "Hello World");
});

await run("multiple sequential requests", async () => {
  for (const p of ["/get", "/ip", "/uuid", "/headers"]) {
    assert.equal((await httpbin.get(p)).status, 200);
  }
});

// ============================================================================
// REGRESSIONS — one case per defect this round's audit found
// ============================================================================

suite("Regressions (core round)");

const kreq = (over: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    url: "https://httpbin.org/get",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
    ...over,
  }) as never;

await run("regression: a runtime's protocol string is normalised to HTTPVersion", async () => {
  // Deno answered "2.0" and was translated; Bun answers "1.1" and was returned
  // unchanged, so a plain HTTP/1.1 response on Bun reported the string "1.1" —
  // outside the `HTTPVersion` union, reaching every consumer of
  // `res.httpVersion` through a type the compiler had already agreed with. A
  // consumer switching on "HTTP/1.1" fell through silently, and the runtimes
  // where it happens are the ones CI does not execute.
  const versionOf = async (httpVersion: string | undefined): Promise<string> => {
    const res = new Response("x");
    if (httpVersion !== undefined) {
      (res as unknown as Record<string, unknown>).httpVersion = httpVersion;
    }
    const t = new FetchTransport(async () => res as never);
    return (await t.send(kreq())).httpVersion;
  };
  // Every spelling Deno and Bun actually use, plus the union's own members.
  for (const [raw, expected] of [
    ["1.1", "HTTP/1.1"],
    ["1", "HTTP/1.0"],
    ["1.0", "HTTP/1.0"],
    ["2", "HTTP/2"],
    ["2.0", "HTTP/2"],
    ["HTTP/1.1", "HTTP/1.1"],
    ["HTTP/1.0", "HTTP/1.0"],
    ["HTTP/2", "HTTP/2"],
    // Case and surrounding whitespace must not be a way to widen the field.
    ["  1.1  ", "HTTP/1.1"],
    ["HTTP/2 ", "HTTP/2"],
    ["h2", "HTTP/2"],
  ] as const) {
    assert.equal(await versionOf(raw), expected, `httpVersion ${JSON.stringify(raw)}`);
  }
  // A protocol this library cannot speak says nothing, so it falls through to
  // the evidence rather than being reported as one.
  assert.equal(await versionOf("3"), "HTTP/1.1", "an unknown version is not reported as one");
  assert.equal(await versionOf("quic"), "HTTP/1.1");
  assert.equal(await versionOf(undefined), "HTTP/1.1", "and no property at all is the default");
  // With the field normalised, no value outside the union can be produced.
  const allowed = new Set(["HTTP/1.0", "HTTP/1.1", "HTTP/2"]);
  for (const raw of ["1.1", "2", "2.0", "1", "3", "h2", "", "HTTP/3"]) {
    assert.ok(allowed.has(await versionOf(raw)), `${JSON.stringify(raw)} left the union`);
  }
});

await run("regression: a request header named __proto__ is sent, not swallowed", async () => {
  // `__proto__` is made of token characters, so it passed the header-name check
  // — and then `sanitizedHeaders[name] = value` is a [[Set]], which sent it to
  // the inherited setter, which ignores a primitive. The header did not
  // overwrite anything: it disappeared, and the caller was never told. A
  // caller whose headers came from a JSON config is exactly who sends it.
  let seen: Record<string, string> = {};
  const t = new FetchTransport(async (_u, init) => {
    seen = init.headers as Record<string, string>;
    return new Response("ok");
  });
  // A literal `__proto__:` in an object literal sets the prototype and creates
  // no own key, so the header has to be built the way a parsed config builds it.
  const headers = JSON.parse('{"__proto__":"polluted","X-Kept":"1"}') as Record<string, string>;
  await t.send(kreq({ headers }));
  assert.equal(seen["__proto__"], "polluted", "the header must be sent");
  assert.equal(seen["X-Kept"], "1", "and the rest of the headers with it");
  assert.deepEqual(Object.getOwnPropertyNames(seen).sort(), ["X-Kept", "__proto__"]);
  assert.equal(Object.getPrototypeOf(seen), Object.prototype, "and nothing else moves");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype is clean");
  // The accept-encoding strip and the validity check still run on it: an
  // invalid value under that name is still dropped.
  // The NUL is spelled as a JSON escape, so it survives JSON.parse and arrives
  // as a real control character in the header value.
  const bad = JSON.parse('{"__proto__":"bad\\u0000value"}') as Record<string, string>;
  let seen2: Record<string, string> = {};
  const t2 = new FetchTransport({
    fetchFn: async (_u, init) => {
      seen2 = init.headers as Record<string, string>;
      return new Response("ok");
    },
  });
  await t2.send(kreq({ headers: bad }));
  // `in` is useless here: `__proto__` is an accessor on Object.prototype, so
  // `"__proto__" in {}` is true of every object. The own-key list is the check.
  assert.equal(
    Object.getOwnPropertyNames(seen2).includes("__proto__"),
    false,
    "an invalid value is still refused",
  );
  assert.deepEqual(Object.getOwnPropertyNames(seen2), []);
});

await run(
  "regression: the HTTP/2 path validates headers exactly as FetchTransport does",
  async () => {
    // The HTTP/2 loop had its own hand-rolled control-character scan over the
    // value, so it never checked the header *name* at all and had no upper
    // bound: a name that is not a token reached `session.request()` and came back
    // as a raw ERR_INVALID_HTTP2_HEADER instead of being dropped (non-strict) or
    // raising EVALIDATION (strict), and a value above U+00FF — which
    // FetchTransport refuses because no ByteString header value can carry it —
    // was sent on this path and dropped on that one. Same request, two
    // transports, two answers, and HTTP/2 is the default on Node.
    const strict = new NodeHTTP2Transport({ strict: true, requestTimeoutMs: 20_000 });
    try {
      for (const [label, headers, needle] of [
        ["a name that is not a token", JSON.parse('{"X Bad":"1"}'), /not a valid header name/],
        ["a value above U+00FF", JSON.parse('{"X-A":"\ud83d\ude00"}'), /control characters/],
        ["a NUL in a value", { "X-A": "a\u0000b" }, /control characters/],
      ] as const) {
        await assert.rejects(
          () =>
            strict.send(
              kreq({ headers: headers as Record<string, string>, httpVersion: "HTTP/2" }),
            ),
          (err: unknown) => {
            assert.ok(err instanceof KinetexError, `${label}: expected a KinetexError`);
            assert.equal((err as { code?: string }).code, "EVALIDATION", label);
            assert.match((err as Error).message, needle, label);
            assert.match((err as Error).message, /^Strict mode: header /, label);
            return true;
          },
          `strict HTTP/2 must reject ${label}`,
        );
      }
    } finally {
      strict.destroy();
    }
    // Non-strict drops rather than throwing, and the request still completes —
    // which is the whole point of the non-strict mode and is what a raw
    // ERR_INVALID_HTTP2_HEADER would have prevented.
    //
    // It also has to *say* what it dropped. The `onDroppedHeader` callback and
    // the console warning are the entire reporting mechanism for a silently
    // removed header, and this file never passed a callback to the HTTP/2
    // transport at all — a version that dropped the header and told nobody
    // satisfied every assertion above.
    const dropped: Array<[string, string]> = [];
    const lenient = new NodeHTTP2Transport({
      requestTimeoutMs: 20_000,
      onDroppedHeader: (name, value) => dropped.push([name, value]),
    });
    try {
      const raw = await lenient.send(
        kreq({ headers: JSON.parse('{"X Bad":"1","X-Kept":"1"}'), httpVersion: "HTTP/2" }),
      );
      assertOkStatus(raw.status, "lenient headers request still goes through");
      const echoed = (await new Response(raw.body).json()) as { headers: Record<string, string> };
      assert.equal(echoed.headers["X-Bad"], undefined, "the invalid name is dropped");
      assert.equal(echoed.headers["X-Kept"], "1", "and the valid one is not");
      assert.deepEqual(dropped, [["X Bad", "1"]], "the callback names the header and its value");
    } finally {
      lenient.destroy();
    }
    // A value refused for its *content* is reported the same way, so a caller
    // can find out which header went missing.
    const dropped2: Array<[string, string]> = [];
    const lenient2 = new NodeHTTP2Transport({
      requestTimeoutMs: 20_000,
      onDroppedHeader: (name, value) => dropped2.push([name, value]),
    });
    try {
      await lenient2.send(
        kreq({ headers: JSON.parse('{"X-A":"bad\\u0000value"}'), httpVersion: "HTTP/2" }),
      );
      assert.deepEqual(
        dropped2.map(([n]) => n),
        ["X-A"],
        "an invalid value is reported by name",
      );
    } finally {
      lenient2.destroy();
    }
    // The same callback is what FetchTransport uses, and it receives the same
    // pair — one mechanism, two transports.
    const dropped3: Array<[string, string]> = [];
    await new FetchTransport({
      onDroppedHeader: (name, value) => dropped3.push([name, value]),
      fetchFn: async () => new Response("ok"),
    }).send(kreq({ headers: { "X-Bad": "a\u0000b" } }));
    assert.deepEqual(dropped3, [["X-Bad", "a\u0000b"]]);
  },
  { transient: "httpbin.org intermittently answers 502" },
);

await run("regression: parseBody names the limit that rejected the body", async () => {
  // A body that is perfectly valid JSON and merely larger than the limits
  // parseBody chose silently became a raw string, and onParseFailure was told
  // "JSON parse failed" — so the one piece of information that would let a
  // caller tell a malformed body from an oversized one was discarded. The code
  // is on the error so a handler can branch on it.
  // The two limits report differently, and both are distinguishable from a
  // malformed body: the depth guard is a pre-parse scan that names itself,
  // while the post-parse size guard reports the one code it uses for every
  // post-parse refusal. Both are pinned as they are, so a change to either is
  // visible rather than silent.
  const cases: Array<[label: string, text: string, code: string, message: RegExp]> = [
    [
      "depth",
      `[${"[".repeat(200)}${"]".repeat(200)}]`,
      "DEPTH_EXCEEDED",
      /depth exceeds limit of 100/,
    ],
    [
      "array length",
      JSON.stringify(new Array(100_001).fill(1)),
      "VALIDATION_FAILED",
      /exceeds size limits/,
    ],
  ];
  for (const [label, text, code, message] of cases) {
    const raw = new TextEncoder().encode(text);
    let seen: { code: string; message: string; bytes: number } | null = null;
    const out = parseBody(raw, "application/json", undefined, (bytes, err) => {
      seen = {
        code: (err as { code?: string }).code ?? "",
        message: err.message,
        bytes: bytes.byteLength,
      };
    });
    assert.equal(out, text, `${label}: the raw text is returned`);
    assert.ok(seen, `${label}: the hook fires`);
    assert.equal(seen!.code, code, `${label}: the limit is named on the error`);
    assert.match(seen!.message, message, `${label}: and named in the message`);
    assert.match(seen!.message, /falling back to raw text/, label);
    assert.equal(seen!.bytes, raw.byteLength, `${label}: the raw bytes are handed over`);
  }
  // Malformed JSON keeps its own code, so the two are distinguishable.
  let malformed: string | null = null;
  parseBody(new TextEncoder().encode("{oops"), "application/json", undefined, (_b, err) => {
    malformed = (err as { code?: string }).code ?? "";
  });
  assert.equal(malformed, "PARSE_ERROR", "a malformed body has its own code");
  // And the three are all different, so a handler can tell them apart without
  // parsing prose.
  assert.equal(new Set([malformed, "DEPTH_EXCEEDED", "VALIDATION_FAILED"]).size, 3);
  // And a body inside every limit still parses, with no hook call at all.
  let called = 0;
  assert.deepEqual(
    parseBody(new TextEncoder().encode('{"a":1}'), "application/json", undefined, () => {
      called++;
    }),
    { a: 1 },
  );
  assert.equal(called, 0, "a successful parse reports no failure");
});

await run("regression: setRuntime refuses a value the library cannot act on", async () => {
  // The parameter is typed, but nothing checked it at runtime, and the callers
  // that matter read the value from configuration. A typo was stored verbatim
  // and became the effective runtime, and every `RUNTIME === "..."` branch in
  // the library then missed: no fetch, no HTTP/2, no proxy, no Node-only path,
  // with nothing thrown and nothing logged.
  const before = getEffectiveRuntime();
  for (const rt of ["node", "deno", "bun", "browser", "cloudflare-workers", "edge", "unknown"]) {
    setRuntime(rt as never);
    assert.equal(getEffectiveRuntime(), rt);
  }
  for (const bad of ["denno", "workerd", "", "Node", "HTTP/2", "node "]) {
    assert.throws(
      () => setRuntime(bad as never),
      (err: unknown) => {
        assert.ok(err instanceof TypeError, `${JSON.stringify(bad)}: expected a TypeError`);
        assert.match((err as Error).message, /setRuntime: unknown runtime/);
        // The message names the offender and lists what is acceptable, because
        // a bare "invalid value" sends the reader to the source.
        assert.match((err as Error).message, new RegExp(JSON.stringify(bad).slice(1, -1)));
        assert.match((err as Error).message, /cloudflare-workers/);
        return true;
      },
      `setRuntime must refuse ${JSON.stringify(bad)}`,
    );
    // A refused value must not have been stored either — otherwise the first
    // bad call poisons every later getEffectiveRuntime().
    assert.equal(getEffectiveRuntime(), "unknown", "the previous value stands");
  }
  // `null` still restores, and the round trip is clean.
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), before);
});

// ── detectRuntime: every answer, not just this environment's ────────────────
//
// The existing coverage asserts `detectRuntime() === "node"`, which is this
// environment's own answer and is the one answer that cannot be wrong here.
// The other five come from globals read at call time, so they are reachable by
// stubbing — and a mis-detection is silent and total: the choice decides
// whether HTTP/2, the proxy path and the Node-only transports exist.

suite("detectRuntime - every branch");

await run("detectRuntime answers for each runtime, in precedence order", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const set = (key: string, value: unknown): void => {
    if (!saved.has(key)) saved.set(key, g[key]);
    if (value === undefined) delete g[key];
    else g[key] = value;
  };

  // Each row: globals to install, the answer expected, and why that answer wins.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["deno", { Deno: { version: "1.40.0" } }, "deno"],
    // Deno without a `version` is not a Deno: the first arm tests both halves.
    ["deno without version", { Deno: {} }, "node"],
    ["bun", { Bun: { version: "1.1.0" } }, "bun"],
    ["cloudflare-workers", { caches: {} }, "cloudflare-workers"],
    ["browser", { window: {}, document: {} }, "browser"],
    // `window` alone is not a browser — Workers stub `window`, which is exactly
    // what the comment in the source warns about.
    ["window without document", { window: {} }, "node"],
    ["node", {}, "node"],
  ];

  try {
    for (const [label, globals, expected] of cases) {
      for (const key of ["Deno", "Bun", "caches", "window", "document"]) set(key, undefined);
      for (const [key, value] of Object.entries(globals)) set(key, value);
      assert.equal(
        detectRuntime(),
        expected,
        `${label}: expected ${expected}, got ${detectRuntime()}`,
      );
    }

    // Deno outranks Bun, and Bun outranks Workers: the first match wins, so an
    // environment exposing more than one global resolves the same way every
    // time rather than depending on which check runs.
    set("Deno", { version: "1.40.0" });
    set("Bun", {});
    set("caches", {});
    assert.equal(detectRuntime(), "deno", "Deno outranks Bun and Workers");

    set("Deno", undefined);
    assert.equal(detectRuntime(), "bun", "Bun outranks Workers");

    set("Bun", undefined);
    set("caches", undefined);
    set("window", undefined);
    set("document", undefined);

    // The WinterCG tail: no runtime marker, no fetch, so nothing identifies it.
    const realProcess = g["process"];
    const realFetch = g["fetch"];
    try {
      g["process"] = undefined;
      g["fetch"] = () => undefined;
      assert.equal(detectRuntime(), "edge", "fetch alone means a WinterCG edge runtime");
      g["fetch"] = undefined;
      assert.equal(detectRuntime(), "unknown", "nothing at all means unknown");
    } finally {
      g["process"] = realProcess;
      g["fetch"] = realFetch;
    }
  } finally {
    for (const key of ["Deno", "Bun", "caches", "window", "document"]) {
      const original = saved.get(key);
      if (original === undefined) delete g[key];
      else g[key] = original;
    }
  }

  // The real environment is restored: the next detection agrees with the first.
  assert.equal(detectRuntime(), "node", "stubbing must not leak past the test");
});

// ============================================================================
// §10  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  CORE TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
);
console.log(`${"=".repeat(60)}`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    if (err instanceof Error) console.log(`    ${err.message}`);
  }
  process.exit(1);
}

process.exit(0);
