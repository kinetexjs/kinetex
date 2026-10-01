import assert from "node:assert/strict";
import { isUpstreamFlake } from "./upstream.ts";
import { TimeoutError } from "../src/types.ts";
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
  sendWithTimeout,
  readRawBody,
  decompressBodyStream,
  normalizeHeaders,
} from "../src/core.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

// A hung socket must fail the test, not park the suite. Without this the
// timeout path itself is what regresses silently.
const TEST_BUDGET_MS = 45_000;

async function test(name: string, fn: () => void | Promise<void>) {
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
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

// ============================================================================
// §1  RUNTIME DETECTION — edge cases (Node.js specific)
// ============================================================================

suite("Runtime detection edge cases");

await test("detectRuntime returns node in this environment", () => {
  assert.equal(detectRuntime(), "node");
});

await test("RUNTIME constant is node", () => {
  assert.equal(RUNTIME, "node");
});

await test("IS_NODE is true", () => {
  assert.equal(IS_NODE, true);
});

await test("HAS_NATIVE_FETCH is true", () => {
  assert.equal(HAS_NATIVE_FETCH, true);
});

await test("setRuntime/getEffectiveRuntime round-trip resets correctly", () => {
  const orig = getEffectiveRuntime();
  setRuntime("deno");
  assert.equal(getEffectiveRuntime(), "deno");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), orig);
  setRuntime("cloudflare-workers");
  assert.equal(getEffectiveRuntime(), "cloudflare-workers");
  setRuntime(null);
  assert.equal(getEffectiveRuntime(), orig);
});

// ============================================================================
// §2  FetchTransport — header sanitization
// ============================================================================

suite("FetchTransport header sanitization");

await test("onDroppedHeader callback fires for invalid value", async () => {
  const dropped: string[] = [];
  const t = new FetchTransport({ strict: false, onDroppedHeader: (n) => dropped.push(n) });
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: { "x-valid": "ok", "x-bad": "bad\x00value" },
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  assert.ok(dropped.includes("x-bad"), "x-bad should be dropped");
  assert.ok(!dropped.includes("x-valid"), "x-valid should not be dropped");
});

await test("non-strict mode console.warn for invalid headers", async () => {
  // The test asserted only the status, so it passed whether or not the
  // transport said anything. Non-strict mode is specified to drop the header
  // AND report it; silence is a bug, not a quieter success.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  let raw: { status: number };
  try {
    const t = new FetchTransport();
    raw = await t.send({
      url: "https://httpbin.org/get",
      method: "GET",
      headers: { "x-bad": "bad\x00value" },
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(raw.status, 200, "the request still goes out, minus the bad header");
  const ours = warnings.filter((w) => w.includes("x-bad"));
  assert.equal(
    ours.length,
    1,
    `expected exactly one warning naming x-bad, got ${JSON.stringify(warnings)}`,
  );
  assert.match(ours[0], /Invalid header dropped/);
  assert.match(ours[0], /x-bad/);
});

await test("strict mode throws EVALIDATION instead of warning", async () => {
  // The counterpart to the case above: with `strict`, the same header must
  // refuse the request rather than quietly drop it.
  const t = new FetchTransport({ strict: true });
  await assert.rejects(
    () =>
      t.send({
        url: "https://httpbin.org/get",
        method: "GET",
        headers: { "x-bad": "bad\x00value" },
        body: null,
        signal: null,
        meta: {},
        httpVersion: "HTTP/1.1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      assert.equal((err as { code?: string }).code, "EVALIDATION");
      assert.match(err.message, /x-bad/);
      return true;
    },
  );
});

await test("null headers object does not throw", async () => {
  // The test is named for a null `headers` and used to pass `{}` instead, so
  // the case it describes was never exercised. `send()` reads `req.headers`
  // for the accept-encoding strip and the validation loop, either of which
  // would throw on a null.
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: null as unknown as Record<string, string>,
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

await test("getReader body check: duplex added for Node ReadableStream", async () => {
  // The duplex: half logic only triggers for ReadableStream bodies in Node
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    }),
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
});

// ============================================================================
// §3  FetchTransport — network error path
// ============================================================================

suite("FetchTransport network error");

await test("network error on invalid host wraps in KinetexError", async () => {
  const t = new FetchTransport();
  let error: any;
  try {
    await t.send({
      url: "https://192.0.2.99/nonexistent",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
      httpVersion: "HTTP/1.1",
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.code, "ENETWORK");
});

// ============================================================================
// §4  sendWithTimeout — edge cases
// ============================================================================

suite("sendWithTimeout edge cases");

await test("timeout=0 returns immediately", async () => {
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
  assert.equal(raw.status, 200);
});

await test("pre-aborted signal propagates as EABORT", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let error: any;
  try {
    await sendWithTimeout(
      new FetchTransport(),
      {
        url: "https://httpbin.org/delay/3",
        method: "GET",
        headers: {},
        body: null,
        signal: ctrl.signal,
        meta: {},
        httpVersion: "HTTP/1.1",
      },
      5000,
    );
  } catch (err) {
    error = err;
  }
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, "KinetexError");
  assert.equal(error.code, "EABORT");
  assert.equal(error.isAbort, true);
});

// ============================================================================
// §5  readRawBody — edge cases
// ============================================================================

suite("readRawBody edge cases");

await test("maxBytes=0 reads all", async () => {
  const data = new Uint8Array(1000);
  const s = new ReadableStream({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const result = await readRawBody(s, 0, "");
  assert.equal(result.byteLength, 1000);
});

await test("abort signal during read cancels and throws", async () => {
  // Stream that never closes — read blocks forever until abort
  const s = new ReadableStream({
    start(c) {
      /* never close */
    },
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  let error: any;
  try {
    await readRawBody(s, 0, "", ctrl.signal);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.code, "EABORT");
});

await test("abort listener cleaned up on success — no leak", async () => {
  const ctrl = new AbortController();
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(5));
      c.close();
    },
  });
  const bytes = await readRawBody(s, 0, "", ctrl.signal);
  assert.deepEqual([...bytes], [0, 0, 0, 0, 0]);
  // Aborting after a completed read must not throw — the listener was removed
  ctrl.abort();
  assert.equal(ctrl.signal.aborted, true);
});

await test("stream that errors during read", async () => {
  const s = new ReadableStream({
    start(c) {
      c.error(new Error("stream-error"));
    },
  });
  await assert.rejects(() => readRawBody(s, 0, ""), /stream-error/);
});

// ============================================================================
// §6  parseBody — edge cases
// ============================================================================

suite("parseBody edge cases");

await test("onParseFailure called when JSON parse fails", () => {
  let called = false;
  const r = parseBody(new TextEncoder().encode("not-json"), "application/json", undefined, () => {
    called = true;
  });
  assert.equal(r, "not-json");
  assert.equal(called, true);
});

await test("onParseFailure does not throw when it throws", () => {
  const r = parseBody(new TextEncoder().encode("not-json"), "application/json", undefined, () => {
    throw new Error("onParseFailure threw");
  });
  assert.equal(r, "not-json");
});

await test("content-type with charset works", () => {
  const r = parseBody(
    new TextEncoder().encode(JSON.stringify({ a: 1 })),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(r, { a: 1 });
});

await test("content-type text/html returns string", () => {
  const r = parseBody(new TextEncoder().encode("<html>"), "text/html");
  assert.equal(r, "<html>");
});

await test("custom parser receives empty headers and url", () => {
  const r = parseBody(
    new TextEncoder().encode("data"),
    "application/json",
    (raw, headers, url) => `p:${raw.byteLength}:${Object.keys(headers).length}:${url}`,
  );
  assert.equal(r, "p:4:0:");
});

await test("null content-type", () => {
  const r = parseBody(new Uint8Array([1, 2, 3]), null);
  assert.equal(r instanceof Uint8Array, true);
  assert.deepEqual(r, new Uint8Array([1, 2, 3]));
});

await test("unknown content-type returns raw bytes", () => {
  const r = parseBody(new Uint8Array([0xff]), "application/x-unknown");
  assert.equal(r instanceof Uint8Array, true);
  assert.deepEqual(r, new Uint8Array([0xff]));
});

// ============================================================================
// §7  decompressBodyStream — edge cases
// ============================================================================

suite("decompressBodyStream edge cases");

await test("null body returns null", async () => {
  assert.equal(await decompressBodyStream(null, {}), null);
});

await test("no content-encoding returns stream as-is", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const r = await decompressBodyStream(s, {});
  const reader = r!.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Array.from(value!), [1, 2, 3]);
});

await test("identity encoding stripped", async () => {
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

await test("unsupported encoding returns compressed body with warning", async () => {
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  // Was `zstd` until zstd became supported; kept on a genuinely unknown
  // encoding, which is what this test is actually about.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  let result: ReadableStream<Uint8Array> | null;
  try {
    result = await decompressBodyStream(s, { "content-encoding": "exotic-v9" });
  } finally {
    console.warn = realWarn;
  }
  // Unsupported encoding should return the body as-is (compressed), not throw
  assert.notEqual(result, null);
  const reader = result!.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Array.from(value!), [1], "the bytes must pass through untouched");
  // Passing the body through silently is indistinguishable from not
  // decompressing at all, so the transport says which encoding it gave up on.
  const ours = warnings.filter((w) => w.includes("exotic-v9"));
  assert.equal(
    ours.length,
    1,
    `expected one warning naming the encoding, got ${JSON.stringify(warnings)}`,
  );
  assert.match(ours[0], /Unsupported Content-Encoding/);
});

// ============================================================================
// §8  normalizeHeaders
// ============================================================================

suite("normalizeHeaders");

await test("converts Headers to Record<string, string>", () => {
  const h = new Headers({ "content-type": "application/json", "x-custom": "value" });
  const r = normalizeHeaders(h);
  assert.equal(r["content-type"], "application/json");
  assert.equal(r["x-custom"], "value");
});

await test("empty Headers returns empty record", () => {
  const r = normalizeHeaders(new Headers());
  assert.deepEqual(r, {});
});

// ============================================================================
// §9  FetchTransport constructor polymorphism
// ============================================================================

suite("FetchTransport constructor");

await test("FetchTransport with custom fetch function", async () => {
  let called = false;
  const t = new FetchTransport(async (url, init) => {
    called = true;
    return globalThis.fetch(url, init);
  });
  // The old body caught every error and logged it, so a transport that
  // ignored the function entirely still "passed". The whole point of the
  // positional-function constructor is that it is used, so a failure here is
  // a failure.
  const raw = await t.send({
    url: "https://httpbin.org/get",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.status, 200);
  assert.equal(called, true, "the custom fetch function must be the one used");
});

await test("FetchTransport with options object only", () => {
  // `assert.notEqual(t, null)` is true of any value a constructor returns,
  // including `undefined`. The options have to be shown to land: a transport
  // that silently dropped `strict` would still pass.
  const t = new FetchTransport({ strict: true });
  assert.ok(t instanceof FetchTransport);
  assert.equal((t as unknown as { strict: boolean }).strict, true);
  const lenient = new FetchTransport({ strict: false });
  assert.equal((lenient as unknown as { strict: boolean }).strict, false);
  // The default is non-strict: a bad header is dropped, not thrown.
  assert.equal((new FetchTransport() as unknown as { strict: boolean }).strict, false);
});

// ============================================================================
// §10  HTTP/2 and HTTP/3 detection via FetchTransport
// ============================================================================

suite("HTTP version detection");

await test("Cloudflare returns HTTP/2 via FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://www.cloudflare.com/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  assert.equal(raw.httpVersion, "HTTP/2");
});

await test("Google returns HTTP/2 with h3 alt-svc via FetchTransport", async () => {
  const t = new FetchTransport();
  const raw = await t.send({
    url: "https://www.google.com/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/1.1",
  });
  // Google serves HTTP/1.1 from some edges (ALPN/geo dependent). Accept either
  // version but require the transport to report a valid detected protocol.
  assert.equal(
    ["HTTP/2", "HTTP/1.1"].includes(raw.httpVersion),
    true,
    `unexpected httpVersion: ${raw.httpVersion}`,
  );
});

// ============================================================================
// §11  NodeHTTP2Transport — edge cases
// ============================================================================

suite("NodeHTTP2Transport edge cases");

await test("request timeout fires", async () => {
  // Deterministic offline check of the timeout mechanism: a transport that
  // never resolves is raced against sendWithTimeout. Verifies TimeoutError
  // surfaces promptly instead of the request hanging forever.
  const neverTransport = {
    send(): Promise<never> {
      return new Promise(() => {});
    },
  };
  const start = Date.now();
  let err: unknown;
  try {
    await sendWithTimeout(
      neverTransport,
      {
        url: "https://api.example.test/slow",
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
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `timeout should fire promptly, took ${elapsed}ms`);
  assert.ok(elapsed >= 400, `timeout fired too early: ${elapsed}ms`);
  assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
  assert.equal((err as TimeoutError).timeoutMs, 500);
});

await test("custom session options", () => {
  let t: NodeHTTP2Transport | undefined;
  assert.doesNotThrow(() => {
    t = new NodeHTTP2Transport({ sessionTTLMs: 100, pingIntervalMs: 0, maxSessions: 7 });
  });
  assert.ok(t !== undefined, "construction must return a transport");
  assert.equal(typeof t!.send, "function");
  // The old version only proved the constructor did not throw, so every
  // option could have been dropped and the test stayed green — which is
  // exactly what happened to `maxSessions` before it was threaded through
  // `createTransport`. These read the real fields, under their actual names
  // (no leading underscore) so a rename shows up here.
  const priv = t as unknown as Record<string, unknown>;
  assert.equal(priv["sessionTTLMs"], 100, "sessionTTLMs must be stored");
  assert.equal(priv["pingIntervalMs"], 0, "pingIntervalMs must be stored");
  assert.equal(priv["maxSessions"], 7, "maxSessions must be stored");
  // And the defaults, so a constructor that stored nothing but echoed what it
  // was given cannot pass both halves.
  const d = new NodeHTTP2Transport();
  const dpriv = d as unknown as Record<string, unknown>;
  assert.notEqual(dpriv["maxSessions"], 7, "the default must not be the value passed above");
  assert.ok(typeof dpriv["maxSessions"] === "number", "a default maxSessions must exist");
  assert.doesNotThrow(() => d.destroy());
  assert.doesNotThrow(() => t!.destroy());
});

await test("redirect: error throws", async () => {
  const t = new NodeHTTP2Transport();
  try {
    // `assert.rejects(fn)` with no matcher is satisfied by a DNS failure, a
    // connection reset or a timeout — none of which is a redirect refusal.
    await assert.rejects(
      () =>
        t.send({
          url: "https://httpbin.org/redirect/1",
          method: "GET",
          headers: {},
          body: null,
          signal: null,
          meta: {},
          httpVersion: "HTTP/2",
          redirect: "error",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected an Error");
        // `redirect: "error"` is specified by Fetch as a *network* error —
        // the request is not followed and the failure surfaces at the
        // transport level — so ENETWORK is the right code here, not
        // EREDIRECT. What matters is that the message names the policy and
        // the target, so the caller can tell a refusal from a dead socket.
        assert.equal((err as { code?: string }).code, "ENETWORK");
        assert.match(err.message, /Redirect not allowed/);
        assert.match(err.message, /redirect:"error"/);
        assert.match(err.message, /\/get/, "the refused target must be named");
        return true;
      },
    );
  } finally {
    t.destroy();
  }
});

// ============================================================================
// REGRESSIONS (core-unit round)
// One case per defect found while auditing this file. Each names the exact
// behaviour that regressed, so a future change that reintroduces it fails
// here with a readable message.
// ============================================================================

suite("Regressions (core-unit round)");

await test("regression: normalizeHeaders keeps every Set-Cookie", () => {
  // `Headers.forEach` is the ONE header the Fetch spec does not combine: it
  // yields each cookie separately, while every other repeated header arrives
  // already joined with ", ". The loop assigned, so a two-cookie response
  // normalized to the last cookie only and the first vanished with no error
  // anywhere. This is the shape `FetchTransport` hands to the cookie jar.
  const h = new Headers();
  h.append("set-cookie", "first=1; Path=/");
  h.append("set-cookie", "second=2; Path=/");
  const r = normalizeHeaders(h);
  assert.match(r["set-cookie"] ?? "", /first=1/);
  assert.match(r["set-cookie"] ?? "", /second=2/);
  // The record must agree with what the Headers object itself reports, or a
  // caller comparing the two sees a phantom difference.
  assert.equal(r["set-cookie"], h.get("set-cookie"));
});

await test("regression: the combined form splits back into both cookies", async () => {
  // The fix is only safe if the downstream splitter still understands what
  // normalizeHeaders now produces. This is the round trip: combine, then
  // split, and both cookies must come back.
  const { splitSetCookieHeaders } = await import("../src/cookie-parser.ts");
  const h = new Headers();
  h.append("set-cookie", "a=1; Path=/");
  h.append("set-cookie", "b=2; Path=/");
  const combined = normalizeHeaders(h)["set-cookie"]!;
  assert.deepEqual(splitSetCookieHeaders(combined), ["a=1; Path=/", "b=2; Path=/"]);

  // And the case that is easy to get wrong: `Expires` itself contains a
  // comma, so a naive split would tear the cookie in half.
  const tricky = "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/, theme=dark; Path=/";
  assert.deepEqual(splitSetCookieHeaders(tricky), [
    "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/",
    "theme=dark; Path=/",
  ]);
});

await test("regression: a single Set-Cookie is unchanged", () => {
  // Guard against over-correction: one cookie must not gain a trailing
  // separator or be double-wrapped.
  const h = new Headers({ "set-cookie": "only=1; Path=/" });
  assert.equal(normalizeHeaders(h)["set-cookie"], "only=1; Path=/");
});

await test("regression: other repeated headers stay combined once", () => {
  // Only `set-cookie` is special. A header the spec already joins must not be
  // joined a second time by this function.
  const h = new Headers();
  h.append("x-multi", "one");
  h.append("x-multi", "two");
  const r = normalizeHeaders(h);
  assert.equal(r["x-multi"], "one, two");
  assert.equal(r["x-multi"], h.get("x-multi"));
});

await test("regression: readRawBody accepts a body exactly at the limit", async () => {
  // Off-by-one in either direction is silent: too strict truncates a valid
  // response, too loose lets an oversized body through. `maxBytes` is a
  // ceiling, not an exclusive bound.
  const make = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        c.close();
      },
    });
  const ok = await readRawBody(make(), 5, "");
  assert.equal(ok.byteLength, 5, "a body exactly at the limit must be returned whole");
  await assert.rejects(
    () => readRawBody(make(), 4, ""),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "ESIZELIMIT");
      return true;
    },
  );
});

await test("regression: parseBody reads a +json content type", async () => {
  // Vendor media types ending in `+json` are extremely common
  // (`application/vnd.api+json`, `application/hal+json`). Treating one as
  // opaque bytes turns a structured response into a Uint8Array, and the
  // caller sees a different type for the same JSON.
  const body = new TextEncoder().encode(JSON.stringify({ data: { id: 7 } }));
  const parsed = parseBody<{ data: { id: number } }>(body, "application/vnd.api+json");
  assert.equal(parsed.data.id, 7);
});

await test("regression: an empty body parses to null, not empty bytes", async () => {
  // A 204 or a zero-length 200 has no body at all. Returning an empty
  // Uint8Array makes `res.data` truthy-looking but not JSON, so callers guard
  // on the wrong thing.
  assert.equal(parseBody(new Uint8Array(0), "application/json"), null);
  assert.equal(parseBody(new Uint8Array(0), "text/plain"), null);
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`  CORE UNIT TESTS: ${passed}/${passed + failed} passed`);
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
