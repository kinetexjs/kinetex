/**
 * kinetex — Regression tests for the full-codebase review fixes.
 *
 * Every test here corresponds to a specific finding; the finding id is in the
 * test name so a failure points straight at the fix that regressed.
 *
 *   P0-1  redirect hops re-run the SSRF gate + httpsOnly
 *   P0-2  download-progress wrapper cancelled itself (crash / wrong error)
 *   P0-3  dedupe interceptor coalesced across auth identities
 *   P0-4  custom credential headers forwarded cross-origin without a cookie jar
 *   P0-5  cross-origin hop lost the cookies the jar had just scoped for it
 *   P1-6  HAR recorded URLs, query strings and bodies unredacted
 *   P1-7  progress wrappers buffered the whole body (no backpressure)
 *   P1-8  digest auth never incremented the nonce count
 *   P1-9  cache/dedup auth fingerprint missed most credential headers
 *   P2-*  method casing, SWR cleanup, retry with stream body, re-send loop,
 *         OTel span leak, destroy() purging the cache, BatchQueue validation,
 *         dedup stale timer, ws double reconnect, pagination sleep listener,
 *         xhrFetch listener leak, socks5 timer leak + EOF hang, getClientIP
 *         trust, cookie Domain casing, public-suffix check, Response props,
 *         maxRequestSize on a circular body, sync throws
 *   P3-*  dead code, priority ordering, cache statuses, IMDS encoding,
 *         accept-encoding intent, tag-index cleanup, worker docs
 *
 * Everything is offline and deterministic: mock transports, in-process TCP for
 * the SOCKS5 connector, and a fake WebSocket. No public network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Kinetex, BatchQueue } from "../src/client.ts";
import { KinetexError, SizeLimitError } from "../src/types.ts";
import type { KinetexRequest } from "../src/types.ts";
import type { RawResponse } from "../src/core.ts";
import { FetchTransport } from "../src/core.ts";
import { HTTPCache, getAuthFingerprint, CREDENTIAL_HEADERS } from "../src/cache.ts";
import { DedupMap } from "../src/dedup.ts";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { InterceptorManager, createDedupeInterceptor } from "../src/interceptors.ts";
import { withUploadProgress, withDownloadProgress, ProgressTracker } from "../src/progress.ts";
import { createDigestAuthorization, createDigestAuthorizer } from "../src/digest.ts";
import { getClientIP, HttpHeaders } from "../src/headers.ts";
import { domainMatch, isPublicSuffix } from "../src/cookie-parser.ts";
import { CookieJar } from "../src/cookie-store.ts";
import { nodeTcpConnector } from "../src/socks5.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRaw(
  status: number,
  headers: Record<string, string>,
  body: string,
  url: string,
): RawResponse {
  const enc = new TextEncoder().encode(body);
  return {
    status,
    statusText: String(status),
    headers,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc);
        c.close();
      },
    }),
    url,
    redirected: false,
    httpVersion: "HTTP/1.1",
    alreadyDecompressed: true,
  };
}

interface Hop {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  body: unknown;
}

function mockTransport(
  respond: (
    req: KinetexRequest,
    hop: number,
  ) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  } = () => ({}),
) {
  const hops: Hop[] = [];
  const transport = {
    async send(req: KinetexRequest): Promise<RawResponse> {
      hops.push({
        url: req.url,
        method: req.method,
        headers: { ...(req.headers as Record<string, string>) },
        redirect: req.redirect,
        body: req.body,
      });
      const r = respond(req, hops.length - 1);
      return mockRaw(
        r.status ?? 200,
        { "content-type": "application/json", ...(r.headers ?? {}) },
        r.body ?? '{"ok":true}',
        req.url,
      );
    },
  };
  return { transport, hops };
}

function withTransport<K extends Kinetex>(
  client: K,
  transport: unknown,
): { client: K; restore: () => void } {
  const c = client as unknown as { transport: unknown };
  const original = c.transport;
  c.transport = transport;
  return { client, restore: () => void (c.transport = original) };
}

/** Counting wrapper around an AbortSignal so listener add/remove is observable. */
function countedSignal(signal: AbortSignal): {
  signal: AbortSignal;
  added: number;
  removed: number;
} {
  const state = { added: 0, removed: 0 };
  const proxy = Object.create(signal, {
    addEventListener: {
      value: (type: string, fn: () => void, opts?: AddEventListenerOptions) => {
        state.added++;
        signal.addEventListener(type, fn, opts);
      },
    },
    removeEventListener: {
      value: (type: string, fn: () => void, opts?: EventListenerOptions) => {
        state.removed++;
        signal.removeEventListener(type, fn, opts);
      },
    },
  }) as AbortSignal;
  return {
    signal: proxy,
    get added() {
      return state.added;
    },
    get removed() {
      return state.removed;
    },
  };
}

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks));
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════════
// P0-1 — redirect hops re-run the SSRF gate
// ═══════════════════════════════════════════════════════════════════════════════

describe("P0-1 redirect hops re-validate the target (SSRF)", () => {
  const unsafeTargets = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]:9200/",
    "http://[fd00::1]/",
    "http://0.0.0.0/",
  ];

  for (const target of unsafeTargets) {
    it(`blocks a redirect to ${target}`, async () => {
      const { transport, hops } = mockTransport((req) =>
        req.url.endsWith("/start") ? { status: 302, headers: { location: target } } : {},
      );
      const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
      const s = withTransport(c, transport);
      await assert.rejects(
        () => s.client.get("/start"),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError, "expected KinetexError");
          assert.equal(err.code, "EVALIDATION");
          assert.match(err.message, /Unsafe redirect target/);
          return true;
        },
      );
      assert.equal(hops.length, 1, "the unsafe hop must never be dispatched");
    });
  }

  it("still blocks a redirect to a non-HTTP scheme", async () => {
    const { transport, hops } = mockTransport(() => ({
      status: 302,
      headers: { location: "file:///etc/passwd" },
    }));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    await assert.rejects(
      () => s.client.get("/start", { retry: false }),
      (err: unknown) => err instanceof KinetexError && /only HTTP\(S\) allowed/.test(err.message),
    );
    assert.equal(hops.length, 1);
    assert.equal(
      hops.some((h) => h.url.startsWith("file:")) && hops.length > 1,
      false,
      "a file: URL must never be dispatched",
    );
  });

  it("retries are not amplified by a blocked redirect target", async () => {
    const { transport, hops } = mockTransport(() => ({
      status: 302,
      headers: { location: "http://169.254.169.254/" },
    }));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    await assert.rejects(() => s.client.get("/start"));
    assert.equal(hops.length, 1, "EVALIDATION must not be retried");
  });

  it("allows a redirect to a public host (no false positive)", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("cdn.example.com")
        ? {}
        : { status: 302, headers: { location: "https://cdn.example.com/asset" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    const res = await s.client.get("/start");
    assert.equal(res.status, 200);
    assert.equal(hops.length, 2);
  });

  it("allows a same-origin relative redirect", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.endsWith("/final") ? {} : { status: 302, headers: { location: "/final" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    assert.equal((await s.client.get("/start")).status, 200);
    assert.equal(hops.length, 2);
  });

  it("httpsOnly is enforced on redirect legs (no downgrade)", async () => {
    const { transport, hops } = mockTransport(() => ({
      status: 302,
      headers: { location: "http://api.example.test/plain" },
    }));
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      cookieJar: true,
      httpsOnly: true,
    });
    const s = withTransport(c, transport);
    await assert.rejects(
      () => s.client.get("/start"),
      (err: unknown) =>
        err instanceof KinetexError &&
        /HTTPS-only mode enabled but redirect target/.test(err.message),
    );
    assert.equal(hops.length, 1, "the downgraded hop must never be dispatched");
  });

  it("httpsOnly still permits an https→https redirect", async () => {
    const { transport } = mockTransport((req) =>
      req.url.endsWith("/b")
        ? {}
        : { status: 302, headers: { location: "https://api.example.test/b" } },
    );
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      cookieJar: true,
      httpsOnly: true,
    });
    const s = withTransport(c, transport);
    assert.equal((await s.client.get("/a")).status, 200);
  });

  it("maxRedirects: 0 returns the 3xx instead of following it", async () => {
    const { transport, hops } = mockTransport(() => ({
      status: 302,
      headers: { location: "/elsewhere" },
    }));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    const res = await s.client.get("/start", { maxRedirects: 0 });
    assert.equal(res.status, 302);
    assert.equal(res.headers["location"], "/elsewhere");
    assert.equal(hops.length, 1);
  });

  it("followRedirects: false returns the 3xx instead of following it", async () => {
    const { transport, hops } = mockTransport(() => ({
      status: 301,
      headers: { location: "https://api.example.test/moved" },
    }));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    const res = await s.client.get("/start", { followRedirects: false });
    assert.equal(res.status, 301);
    assert.equal(hops.length, 1);
  });

  it("honours a per-request maxRedirects limit", async () => {
    let n = 0;
    const { transport } = mockTransport(() => {
      n++;
      return { status: 302, headers: { location: `/hop${n}` } };
    });
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    await assert.rejects(
      () => s.client.get("/start", { maxRedirects: 2, retry: false }),
      (err: unknown) =>
        err instanceof KinetexError && /Too many redirects \(exceeded 2\)/.test(err.message),
    );
  });

  it("honours a client-level maxRedirects limit", async () => {
    const { transport } = mockTransport((req) =>
      req.url.endsWith("/b") ? {} : { status: 302, headers: { location: "/b" } },
    );
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      cookieJar: true,
      maxRedirects: 5,
    });
    const s = withTransport(c, transport);
    assert.equal((await s.client.get("/a")).status, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P0-5 / P0-4 — cross-origin credential handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("P0-5 cross-origin hop keeps the NEW origin's cookies", () => {
  it("sends the target origin's cookies on the cross-origin hop", async () => {
    const jar = new CookieJar();
    jar.setCookie("sid=target-value; Domain=cdn.example.com; Path=/", {
      url: "https://cdn.example.com/",
    });
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("cdn.example.com")
        ? {}
        : { status: 302, headers: { location: "https://cdn.example.com/asset" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: jar });
    const s = withTransport(c, transport);
    await s.client.get("/start");
    assert.equal(hops.length, 2);
    assert.equal(
      hops[1]!.headers["cookie"],
      "sid=target-value",
      "the jar-scoped cookie for the new origin must be attached",
    );
  });

  it("does not leak the original origin's cookies cross-origin", async () => {
    const jar = new CookieJar();
    jar.setCookie("sid=api-secret; Path=/", { url: "https://api.example.test/" });
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: jar });
    const s = withTransport(c, transport);
    await s.client.get("/start");
    assert.equal(hops[0]!.headers["cookie"], "sid=api-secret");
    assert.equal(hops[1]!.headers["cookie"], undefined);
  });

  it("keeps cookies on a same-origin redirect", async () => {
    const jar = new CookieJar();
    jar.setCookie("sid=api-secret; Path=/", { url: "https://api.example.test/" });
    const { transport, hops } = mockTransport((req) =>
      req.url.endsWith("/final") ? {} : { status: 302, headers: { location: "/final" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: jar });
    const s = withTransport(c, transport);
    await s.client.get("/start");
    assert.equal(hops[1]!.headers["cookie"], "sid=api-secret");
  });
});

describe("P0-4 credential headers are stripped cross-origin without a cookie jar", () => {
  it("strips a known credential header on a cross-origin redirect (no jar)", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start", { headers: { "x-session-token": "tok-abc" } });
    assert.equal(hops.length, 2, "the request must be followed hop-by-hop");
    assert.equal(hops[0]!.headers["x-session-token"], "tok-abc");
    assert.equal(
      hops[1]!.headers["x-session-token"],
      undefined,
      "credentials must not cross the origin boundary",
    );
  });

  it("keeps a known credential header on a same-origin redirect (no jar)", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.endsWith("/final") ? {} : { status: 302, headers: { location: "/final" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start", { headers: { "x-session-token": "tok-abc" } });
    assert.equal(hops[1]!.headers["x-session-token"], "tok-abc");
  });

  it("strips an application-named apikey header cross-origin (declared auth)", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start", {
      auth: { type: "apikey", header: "X-Company-Key", key: "k-123" },
    });
    assert.equal(hops.length, 2);
    assert.equal(hops[0]!.headers["x-company-key"], "k-123");
    assert.equal(
      hops[1]!.headers["x-company-key"],
      undefined,
      "a declared apikey header name is unknown to the library, so declaring it must force manual redirects",
    );
  });

  it("strips client-configured apikey auth cross-origin too", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      auth: { type: "apikey", header: "X-Tenant-Token", key: "t-9" },
    });
    const s = withTransport(c, transport);
    await s.client.get("/start");
    assert.equal(hops[1]!.headers["x-tenant-token"], undefined);
  });

  it("passes redirect:manual through for a request with a caller credential header", async () => {
    const { transport, hops } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start", { headers: { "x-session-token": "t" } });
    assert.equal(hops[0]!.redirect, "manual");
  });

  it("uses manual redirect following for a plain request, with no auth or headers", async () => {
    // Every request is followed hop-by-hop by kinetex itself. Handing an
    // unauthenticated request to fetch's own following would bypass the
    // per-hop SSRF / httpsOnly / maxRedirects / loop gates entirely, which
    // is how a 302 to 169.254.169.254 used to reach the metadata service.
    const { transport, hops } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start");
    assert.equal(
      hops[0]!.redirect,
      "manual",
      "kinetex must screen every hop itself, not delegate to fetch",
    );
  });

  it("drops a caller cookie header cross-origin on the manual path", async () => {
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    // The apikey auth is what forces manual following; fetch() would have
    // stripped `cookie` on its own, but the manual path must do it too.
    await s.client.get("/start", {
      headers: { cookie: "a=b" },
      auth: { type: "apikey", header: "X-Key", key: "k" },
    });
    assert.equal(hops[0]!.headers["cookie"], "a=b");
    assert.equal(hops[1]!.headers["cookie"], undefined);
  });

  it("drops a cookie header cross-origin even with no auth configured", async () => {
    // Same guarantee as the apikey case above, but reached without any
    // declared credential: a plain caller-supplied `cookie` header is still
    // removed by kinetex's own follower, never by the transport.
    const { transport, hops } = mockTransport((req) =>
      req.url.includes("evil.example.com")
        ? {}
        : { status: 302, headers: { location: "https://evil.example.com/p" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.get("/start", { headers: { cookie: "a=b" } });
    assert.equal(hops.length, 2, "the hop must be followed by kinetex, not fetch");
    assert.equal(hops[0]!.headers["cookie"], "a=b");
    assert.equal(hops[1]!.headers["cookie"], undefined);
  });

  it("reports redirected:true for a manually followed chain", async () => {
    const { transport } = mockTransport((req) =>
      req.url.endsWith("/final") ? {} : { status: 302, headers: { location: "/final" } },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    const res = await s.client.get("/start");
    assert.equal(res.redirected, true);
  });

  it("reports redirected:false for a single hop", async () => {
    const { transport } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const s = withTransport(c, transport);
    assert.equal((await s.client.get("/start")).redirected, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P0-2 — download progress wrapper cancellation
// ═══════════════════════════════════════════════════════════════════════════════

describe("P0-2 download-progress wrapper cancels the SOURCE, not itself", () => {
  it("raises SizeLimitError (not a TypeError) when maxResponseSize is exceeded", async () => {
    const big = "x".repeat(50_000);
    const { transport } = mockTransport(() => ({
      headers: { "content-type": "text/plain" },
      body: big,
    }));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    const seen: number[] = [];
    await assert.rejects(
      () =>
        s.client.get("/big", {
          maxResponseSize: 1024,
          onDownloadProgress: (e) => seen.push(e.loaded),
        }),
      (err: unknown) => {
        assert.ok(
          err instanceof SizeLimitError,
          `expected SizeLimitError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
        );
        return true;
      },
    );
    assert.ok(seen.length > 0, "progress must have been reported before the limit");
  });

  it("does not raise an unhandled rejection when the download is cancelled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { transport } = mockTransport(() => ({ body: "y".repeat(20_000) }));
      const c = new Kinetex({ baseURL: "https://api.example.test" });
      const s = withTransport(c, transport);
      await assert.rejects(() =>
        s.client.get("/big", { maxResponseSize: 512, onDownloadProgress: () => {} }),
      );
      // Give the microtask queue a chance to surface a rejection.
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(
      unhandled.map((u) => (u as Error)?.message ?? String(u)),
      [],
    );
  });

  it("still reads the whole body when the limit is not exceeded", async () => {
    const { transport } = mockTransport(() => ({ body: "small-body" }));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    const res = await s.client.get("/ok", {
      onDownloadProgress: () => {},
    });
    assert.equal(res.data, "small-body");
  });

  it("propagates an abort during download without a self-cancel error", async () => {
    const controller = new AbortController();
    const { transport } = mockTransport(() => ({ body: "z".repeat(200_000) }));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    const p = s.client.get("/big", { signal: controller.signal, onDownloadProgress: () => {} });
    controller.abort();
    await assert.rejects(
      () => p,
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.doesNotMatch(err.message, /ReadableStream is locked/);
        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P0-3 — dedupe interceptor auth isolation
// ═══════════════════════════════════════════════════════════════════════════════

function dedupeCtx(overrides: Partial<KinetexRequest> = {}, signal: AbortSignal | null = null) {
  const ctx = {
    request: {
      url: "https://api.example.test/v1/me",
      method: "GET",
      headers: {},
      body: null,
      signal,
      meta: {},
      ...overrides,
    } as KinetexRequest,
    response: null,
    error: null,
    startedAt: 0,
    attempt: 1,
    aborted: false,
    store: new Map<symbol | string, unknown>(),
  };
  return ctx;
}

describe("P0-3 dedupe interceptor isolates auth identities", () => {
  it("does NOT coalesce requests with different Authorization headers", async () => {
    const { requestInterceptor, responseInterceptor } = createDedupeInterceptor();
    const a = dedupeCtx({ headers: { authorization: "Bearer alice" } });
    const b = dedupeCtx({ headers: { authorization: "Bearer bob" } });

    await requestInterceptor(a);
    const queued = requestInterceptor(b);
    assert.ok(queued instanceof Promise, "different users must NOT share the leader's result");

    const response = { status: 200, statusText: "OK", headers: {}, url: a.request.url } as never;
    a.response = response;
    await responseInterceptor(a);
    assert.notEqual(await queued, response, "bob must never receive alice's response object");
  });

  it("does NOT coalesce requests with different Cookie headers", async () => {
    const { requestInterceptor } = createDedupeInterceptor();
    const a = dedupeCtx({ headers: { cookie: "sid=1" } });
    const b = dedupeCtx({ headers: { cookie: "sid=2" } });
    await requestInterceptor(a);
    assert.equal(requestInterceptor(b) instanceof Promise, true);
  });

  it("does NOT coalesce requests with different x-session-token headers", async () => {
    const { requestInterceptor } = createDedupeInterceptor();
    const a = dedupeCtx({ headers: { "x-session-token": "t1" } });
    const b = dedupeCtx({ headers: { "x-session-token": "t2" } });
    await requestInterceptor(a);
    assert.equal(requestInterceptor(b) instanceof Promise, true);
  });

  it("DOES coalesce identical anonymous requests", async () => {
    const { requestInterceptor, responseInterceptor } = createDedupeInterceptor();
    const a = dedupeCtx();
    await requestInterceptor(a);
    const queued = requestInterceptor(dedupeCtx());
    assert.ok(
      queued instanceof Promise,
      "the follower must queue on the leader, not start a request",
    );
    // The follower registers itself asynchronously (the key is hashed); without
    // this flush the leader would finish first and the follower would start a
    // second request instead of joining the first.
    await new Promise((r) => setTimeout(r, 0));

    const response = { status: 200, statusText: "OK", headers: {}, url: a.request.url } as never;
    a.response = response;
    await responseInterceptor(a);
    assert.equal(await queued, response, "identical requests must share the leader's response");
  });

  it("does not dedupe non-GET/HEAD methods", async () => {
    const { requestInterceptor } = createDedupeInterceptor();
    assert.equal(await requestInterceptor(dedupeCtx({ method: "POST" })), undefined);
    assert.equal(await requestInterceptor(dedupeCtx({ method: "POST" })), undefined);
    assert.equal(await requestInterceptor(dedupeCtx({ method: "DELETE" })), undefined);
  });

  it("dedupes HEAD as well as GET", async () => {
    const { requestInterceptor } = createDedupeInterceptor();
    const leader = dedupeCtx({ method: "HEAD" });
    assert.equal(await requestInterceptor(leader), undefined);
    assert.ok(requestInterceptor(dedupeCtx({ method: "HEAD" })) instanceof Promise);
  });

  it("rejects a queued waiter whose signal aborts, and drops it from the leader", async () => {
    const { requestInterceptor, responseInterceptor } = createDedupeInterceptor();
    const ac = new AbortController();
    const leader = dedupeCtx();
    await requestInterceptor(leader);
    const follower = dedupeCtx({}, ac.signal);
    const queued = requestInterceptor(follower);
    assert.ok(queued instanceof Promise);
    await new Promise((r) => setTimeout(r, 0)); // let the waiter register
    ac.abort();
    await assert.rejects(() => queued as Promise<unknown>, /aborted while queued/);

    // The leader finishing must not blow up on the departed waiter.
    leader.response = { status: 200, statusText: "OK", headers: {} } as never;
    await responseInterceptor(leader);
  });

  it("rejects immediately when the follower signal is already aborted", async () => {
    const { requestInterceptor } = createDedupeInterceptor();
    await requestInterceptor(dedupeCtx());
    const ac = new AbortController();
    ac.abort();
    const queued = requestInterceptor(dedupeCtx({}, ac.signal));
    assert.ok(queued instanceof Promise);
    await assert.rejects(() => queued as Promise<unknown>, /aborted while queued/);
  });

  it("does not create a slot for a request that is aborted before deduping", async () => {
    const { requestInterceptor, responseInterceptor } = createDedupeInterceptor();
    const ac = new AbortController();
    ac.abort();
    const ctx = dedupeCtx({}, ac.signal);
    // Already-aborted signal + no existing leader → this request is the leader
    // and is not aborted out of the pipeline, only followers are.
    assert.equal(await requestInterceptor(ctx), undefined);
    ctx.response = { status: 200, statusText: "OK", headers: {} } as never;
    await responseInterceptor(ctx);
  });

  it("error interceptor rejects every waiter of the failed leader", async () => {
    const { requestInterceptor, errorInterceptor } = createDedupeInterceptor();
    const leader = dedupeCtx();
    await requestInterceptor(leader);
    const queued = requestInterceptor(dedupeCtx()) as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 0)); // let the waiter register
    leader.error = new Error("boom");
    errorInterceptor(leader);
    await assert.rejects(() => queued, /boom/);
  });

  it("removes the abort listener once the leader resolves", async () => {
    const { requestInterceptor, responseInterceptor } = createDedupeInterceptor();
    const ac = new AbortController();
    const counters = countedSignal(ac.signal);
    const leader = dedupeCtx({}, counters.signal);
    await requestInterceptor(leader);
    const queued = requestInterceptor(dedupeCtx({}, counters.signal)) as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 0));
    leader.response = { status: 200, statusText: "OK", headers: {} } as never;
    await responseInterceptor(leader);
    await queued;
    assert.equal(counters.added - counters.removed, 0, "no listener may be left behind");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1-6 — HAR redaction
// ═══════════════════════════════════════════════════════════════════════════════

describe("P1-6 HAR redacts URLs, query strings, locations and bodies", () => {
  const harFor = async (
    url: string,
    respond: () => { headers?: Record<string, string>; body?: string } = () => ({}),
  ) => {
    const { transport } = mockTransport(respond);
    const c = new Kinetex({ baseURL: "https://api.example.test", har: true });
    const s = withTransport(c, transport);
    await s.client.get(url);
    const har = s.client.getHAR();
    assert.equal(har.entries.length, 1);
    return har.entries[0]!;
  };

  it("redacts api_key in the recorded URL and query string", async () => {
    const entry = await harFor("/v1/items?api_key=SUPERSECRET&page=2");
    assert.doesNotMatch(entry.request.url, /SUPERSECRET/);
    assert.match(entry.request.url, /\*\*\*REDACTED\*\*\*/);
    assert.match(entry.request.url, /page=2/, "non-sensitive params must survive");
    const key = entry.request.queryString.find((q) => q.name === "api_key");
    assert.equal(key?.value, "***REDACTED***");
    const page = entry.request.queryString.find((q) => q.name === "page");
    assert.equal(page?.value, "2");
  });

  it("redacts access_token, signature and password params", async () => {
    for (const [param, secret] of [
      ["access_token", "AAA"],
      ["signature", "BBB"],
      ["password", "CCC"],
      ["x-amz-signature", "DDD"],
    ] as const) {
      const entry = await harFor(`/v1/x?${param}=${secret}`);
      assert.doesNotMatch(entry.request.url, new RegExp(secret), `${param} leaked`);
    }
  });

  it("redacts the Location header", async () => {
    const entry = await harFor("/v1/x", () => ({
      headers: { location: "https://other.example.com/?token=LEAKME" },
    }));
    assert.doesNotMatch(entry.response.redirectURL, /LEAKME/);
  });

  it("records text bodies but never HTML bodies", async () => {
    const text = await harFor("/v1/x", () => ({
      headers: { "content-type": "text/plain" },
      body: "plain-body",
    }));
    assert.equal(text.response.content.text, "plain-body");
    const html = await harFor("/v1/y", () => ({
      headers: { "content-type": "text/html" },
      body: "<html>secret</html>",
    }));
    assert.equal(html.response.content.text, undefined);
  });

  it("truncates a recorded body at 8192 characters", async () => {
    const entry = await harFor("/v1/x", () => ({ body: "a".repeat(20_000) }));
    assert.equal(entry.response.content.text?.length, 8192);
  });

  it("redacts a URL fragment", async () => {
    const entry = await harFor("/v1/x#access_token=FRAGSECRET");
    assert.doesNotMatch(entry.request.url, /FRAGSECRET/);
  });

  it("still redacts credential headers (pre-existing behaviour)", async () => {
    const { transport } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test", har: true });
    const s = withTransport(c, transport);
    await s.client.get("/v1/x", { headers: { authorization: "Bearer tok" } });
    const headers = s.client.getHAR().entries[0]!.request.headers;
    assert.equal(headers.find((h) => h.name === "authorization")?.value, "***REDACTED***");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1-7 — progress wrappers are pull-based (backpressure)
// ═══════════════════════════════════════════════════════════════════════════════

describe("P1-7 progress wrappers apply backpressure instead of buffering", () => {
  it("withUploadProgress does not drain the source before the consumer reads", async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) return (c.close(), undefined);
        c.enqueue(new Uint8Array(1024));
      },
    });
    const { stream } = withUploadProgress(source, 51 * 1024, {});
    // The wrapper must not have pulled the whole source on construction — that
    // was the old start()-based behaviour, which buffered everything in memory.
    assert.ok(pulled <= 2, `source was drained eagerly (${pulled} pulls before any read)`);

    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel();
  });

  it("withUploadProgress still delivers every byte and completes the tracker", async () => {
    const bytes = new Uint8Array(4096).fill(7);
    const { stream, tracker } = withUploadProgress(bytes, bytes.byteLength, {});
    const text = await readAll(stream);
    assert.equal(text.length, bytes.byteLength);
    assert.equal(tracker.bytesLoaded, bytes.byteLength);
    assert.equal(tracker.isDone, true);
  });

  it("withUploadProgress reports progress across multiple chunks", async () => {
    const seen: number[] = [];
    const { stream } = withUploadProgress(new Uint8Array(300), 300, {
      onProgress: (s) => seen.push(s.loaded),
      throttleHz: 0,
    });
    await readAll(stream);
    assert.ok(seen.length > 0, "progress callbacks must fire");
    assert.equal(seen[seen.length - 1], 300);
  });

  it("withUploadProgress errors immediately for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const { stream } = withUploadProgress(new Uint8Array(10), 10, { signal: ac.signal });
    await assert.rejects(() => readAll(stream), /Upload aborted/);
  });

  it("withUploadProgress aborts mid-stream", async () => {
    const ac = new AbortController();
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled === 2) ac.abort();
        c.enqueue(new Uint8Array(64));
      },
    });
    const { stream } = withUploadProgress(source, null, { signal: ac.signal });
    await assert.rejects(() => readAll(stream), /Upload aborted/);
  });

  it("withUploadProgress reports a null total for an unknown-size stream", async () => {
    const { stream, tracker } = withUploadProgress(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(4));
          c.close();
        },
      }),
      null,
      {},
    );
    await readAll(stream);
    assert.equal(tracker.total, null);
  });

  it("withUploadProgress on an empty body completes immediately", async () => {
    const { stream, tracker } = withUploadProgress(null, 0, {});
    assert.equal(await readAll(stream), "");
    assert.equal(tracker.isDone, true);
  });

  it("withDownloadProgress preserves url and redirected on the rebuilt Response", async () => {
    const original = new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "5" },
    });
    Object.defineProperty(original, "url", { value: "https://api.example.test/v1/x" });
    Object.defineProperty(original, "redirected", { value: true });
    const { response, tracker } = withDownloadProgress(original, {});
    assert.equal(response.url, "https://api.example.test/v1/x");
    assert.equal(response.redirected, true);
    assert.equal(await response.text(), "hello");
    assert.equal(tracker.bytesLoaded, 5);
  });

  it("withDownloadProgress does not buffer the whole body before the first read", async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) return (c.close(), undefined);
        c.enqueue(new Uint8Array(1024));
      },
    });
    const original = new Response(source, { status: 200 });
    withDownloadProgress(original, {});
    assert.equal(pulled, 0, `the wrapper must not pull until the first read, got ${pulled} pulls`);
  });

  it("withDownloadProgress passes the body through unchanged", async () => {
    const original = new Response("payload", { status: 200 });
    const { response } = withDownloadProgress(original, {});
    assert.equal(await response.text(), "payload");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1-8 — digest nonce count
// ═══════════════════════════════════════════════════════════════════════════════

const CHALLENGE =
  'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="op"';
const ncOf = (header: string): string => /nc=([0-9a-fA-F]{8})/.exec(header)?.[1] ?? "";

describe("P1-8 digest auth increments the nonce count", () => {
  it("createDigestAuthorizer increments nc for the same nonce", async () => {
    const auth = createDigestAuthorizer();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(ncOf(await auth(CHALLENGE, "user", "pass", "GET", "/x")));
    }
    assert.deepEqual(seen, ["00000001", "00000002", "00000003"]);
  });

  it("resets the counter when the server issues a new nonce", async () => {
    const auth = createDigestAuthorizer();
    const rotated = CHALLENGE.replace(
      "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      "ffffffffffffffffffffffffffffffff",
    );
    assert.equal(ncOf(await auth(CHALLENGE, "u", "p", "GET", "/x")), "00000001");
    assert.equal(ncOf(await auth(CHALLENGE, "u", "p", "GET", "/x")), "00000002");
    assert.equal(ncOf(await auth(rotated, "u", "p", "GET", "/x")), "00000001");
    assert.equal(ncOf(await auth(rotated, "u", "p", "GET", "/x")), "00000002");
  });

  it("produces a different cnonce per call (replay resistance)", async () => {
    const auth = createDigestAuthorizer();
    const a = await auth(CHALLENGE, "u", "p", "GET", "/x");
    const b = await auth(CHALLENGE, "u", "p", "GET", "/x");
    const cnonce = (h: string) => /cnonce="([^"]+)"/.exec(h)?.[1];
    assert.notEqual(cnonce(a), cnonce(b));
  });

  it("stateless createDigestAuthorization keeps nc=00000001 (unchanged API)", async () => {
    const h = await createDigestAuthorization(CHALLENGE, "u", "p", "GET", "/x");
    assert.equal(ncOf(h), "00000001");
  });

  it("the client's digest interceptor increments nc across 401 retries", async () => {
    const challenges: string[] = [];
    const { transport, hops } = mockTransport((req) => {
      if (req.headers["authorization"]) {
        challenges.push(req.headers["authorization"]);
        return {};
      }
      return { status: 401, headers: { "www-authenticate": CHALLENGE } };
    });
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      auth: { type: "digest", username: "u", password: "p" },
    });
    const s = withTransport(c, transport);
    await s.client.get("/x", { retry: false });
    assert.equal(challenges.length, 1);
    assert.equal(ncOf(challenges[0]!), "00000001");
    // A second request must send nc=00000002, not repeat 00000001.
    await s.client.get("/x", { retry: false });
    assert.equal(challenges.length, 2);
    assert.equal(ncOf(challenges[1]!), "00000002");
    assert.equal(hops.length, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1-9 — shared credential-header list
// ═══════════════════════════════════════════════════════════════════════════════

describe("P1-9 cache/dedup auth fingerprint covers every credential header", () => {
  it("fingerprints x-session-token, apikey and x-access-token", async () => {
    const a = await getAuthFingerprint({ authorization: "Bearer a" });
    for (const header of [
      "x-session-token",
      "apikey",
      "x-access-token",
      "api-key",
      "proxy-authorization",
    ]) {
      const b = await getAuthFingerprint({ [header]: "zzz" });
      assert.notEqual(a, b, `${header} must change the fingerprint`);
    }
  });

  it("returns an empty fingerprint for anonymous requests", async () => {
    assert.equal(await getAuthFingerprint({ accept: "application/json" }), "");
    assert.equal(await getAuthFingerprint({}), "");
  });

  it("is case-insensitive on the header name", async () => {
    assert.equal(
      await getAuthFingerprint({ Authorization: "Bearer a" }),
      await getAuthFingerprint({ authorization: "Bearer a" }),
    );
    assert.notEqual(
      await getAuthFingerprint({ Authorization: "Bearer a" }),
      await getAuthFingerprint({ authorization: "Bearer b" }),
    );
  });

  it("separates two users' cache entries", async () => {
    const cache = new HTTPCache({ defaultTtlMs: 60_000 });
    const reqA = {
      url: "https://api.example.test/v1/me",
      method: "GET",
      headers: { "x-session-token": "alice" },
    };
    const reqB = {
      url: "https://api.example.test/v1/me",
      method: "GET",
      headers: { "x-session-token": "bob" },
    };
    const res = {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"user":"alice"}'),
    };
    await cache.set(reqA, res);
    const hitB = await cache.get(reqB);
    assert.equal(hitB, null, "bob must not read alice's cached entry");
    const hitA = await cache.get(reqA);
    // Was a bare truthiness check: any non-null hit passed, including one
    // holding bob's data. Pin the body alice stored.
    assert.ok(hitA, "alice must still hit her own cached entry");
    assert.equal(new TextDecoder().decode(hitA.entry.response.body), '{"user":"alice"}');
    assert.equal(hitA.stale, false);
  });

  it("still serves a shared entry to identical credentials", async () => {
    const cache = new HTTPCache({ defaultTtlMs: 60_000 });
    const req = {
      url: "https://api.example.test/v1/me",
      method: "GET",
      headers: { authorization: "Bearer t" },
    };
    await cache.set(req, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    });
    const hit = await cache.get(req);
    assert.ok(hit, "an identical credential must still hit the shared entry");
    assert.equal(hit.stale, false);
    assert.equal(hit.entry.response.status, 200);
    assert.equal(new TextDecoder().decode(hit.entry.response.body), "{}");
  });

  it("CREDENTIAL_HEADERS is the single source of truth and is non-empty", () => {
    assert.deepEqual(
      [...CREDENTIAL_HEADERS],
      [
        "authorization",
        "proxy-authorization",
        "cookie",
        "x-api-key",
        "apikey",
        "api-key",
        "x-auth-token",
        "x-access-token",
        "x-refresh-token",
        "x-session-id",
        "x-session-token",
        "x-secret",
        "x-secret-key",
        "x-private-key",
        "x-csrf-token",
      ],
    );
    assert.equal(CREDENTIAL_HEADERS.length, new Set(CREDENTIAL_HEADERS).size, "no duplicates");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2 — the rest
// ═══════════════════════════════════════════════════════════════════════════════

describe("P2 method casing is normalized on the wire", () => {
  it("sends PATCH uppercase when the caller passes lowercase", async () => {
    const { transport, hops } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    await s.client.send("/x", "patch" as never, { body: { a: 1 } });
    assert.equal(hops[0]!.method, "PATCH");
  });

  it("normalizes every accepted method spelling", async () => {
    const { transport, hops } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    for (const m of ["get", "post", "put", "delete", "head", "options"] as const) {
      await s.client.send("/x", m);
    }
    assert.deepEqual(
      hops.map((h) => h.method),
      ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    );
  });

  it("still rejects an unknown method", async () => {
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    await assert.rejects(
      () => c.send("/x", "BREW" as never),
      (err: unknown) => err instanceof KinetexError && err.code === "EVALIDATION",
    );
  });
});

describe("P2 retry refuses to replay a consumed stream body", () => {
  it("fails loudly on the retry instead of sending an empty body", async () => {
    let calls = 0;
    const transport = {
      async send(req: KinetexRequest): Promise<RawResponse> {
        calls++;
        if (calls === 1) throw new KinetexError("boom", "ENETWORK");
        return mockRaw(200, { "content-type": "text/plain" }, "ok", req.url);
      },
    };
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("payload"));
        ctrl.close();
      },
    });
    await assert.rejects(
      () =>
        s.client.post("/upload", body as never, {
          retry: {
            maxRetries: 2,
            baseDelayMs: 1,
            onNetworkError: true,
            methods: ["POST"],
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError, `got ${(err as Error)?.name}`);
        assert.equal(err.code, "EVALIDATION");
        assert.match(err.message, /Cannot retry a request whose body is a stream or Blob/);
        return true;
      },
    );
    assert.equal(calls, 1, "the replay must never be attempted");
  });

  it("still retries a replayable string body", async () => {
    let calls = 0;
    const transport = {
      async send(req: KinetexRequest): Promise<RawResponse> {
        calls++;
        if (calls === 1) throw new KinetexError("boom", "ENETWORK");
        return mockRaw(200, { "content-type": "text/plain" }, "ok", req.url);
      },
    };
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    const res = await s.client.post("/x", "replayable", {
      retry: {
        maxRetries: 2,
        baseDelayMs: 1,
        onNetworkError: true,
        methods: ["POST"],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });
});

describe("P2 response-interceptor re-send is depth-capped", () => {
  it("refuses an interceptor that re-sends forever", async () => {
    const { transport, hops } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    c.interceptors.addResponse(
      (ctx) =>
        ({
          ...ctx.request,
          headers: {
            ...ctx.request.headers,
            "x-n": String(Number(ctx.request.meta.__interceptorResendDepth ?? 0) + 1),
          },
        }) as never,
    );
    await assert.rejects(
      () => s.client.get("/x"),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.match(err.message, /re-send limit reached/);
        return true;
      },
    );
    assert.ok(hops.length <= 7, `re-send loop must be bounded (was ${hops.length})`);
  });

  it("allows a bounded refresh chain (digest-style) to complete", async () => {
    let n = 0;
    const { transport } = mockTransport((req) =>
      n++ === 0 ? { status: 401, headers: { "www-authenticate": "" } } : {},
    );
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    c.interceptors.addResponse((ctx) => {
      if (ctx.response?.status !== 401) return;
      if (ctx.request.meta.__interceptorResendDepth) return;
      return {
        ...ctx.request,
        headers: { ...ctx.request.headers, authorization: "Bearer refreshed" },
      } as never;
    });
    const res = await s.client.get("/x", { retry: false });
    assert.equal(res.status, 200);
  });
});

describe("P2 OTel span is ended even when setup fails", () => {
  it("ends the span when a pre-dispatch step throws", async () => {
    const ended: string[] = [];
    const span = {
      setAttribute: () => {},
      setStatus: () => {},
      recordException: () => {},
      end: () => ended.push("end"),
    };
    const c = new Kinetex({ baseURL: "https://api.example.test", dedup: true });
    c.setTracer({
      startSpan: () => ({
        ...span,
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: 1,
        }),
      }),
    } as never);
    // Make the auth fingerprint throw by removing Web Crypto for this call.
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { digest: () => Promise.reject(new Error("no subtle crypto")) } },
      configurable: true,
    });
    try {
      await assert.rejects(() => c.get("/x", { headers: { authorization: "Bearer t" } }));
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }
    assert.deepEqual(ended, ["end"], "the span must be ended exactly once");
  });

  it("ends the span on a normal response", async () => {
    const ended: string[] = [];
    const { transport } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test" });
    const s = withTransport(c, transport);
    c.setTracer({
      startSpan: () => ({
        setAttribute: () => {},
        setStatus: () => {},
        recordException: () => {},
        end: () => ended.push("end"),
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: 1,
        }),
      }),
    } as never);
    await s.client.get("/x");
    assert.equal(ended.length, 1);
  });
});

describe("P2 destroy() releases resources without purging data", () => {
  it("does not clear the cache it was given", async () => {
    const cache = new HTTPCache({ defaultTtlMs: 60_000 });
    const { transport } = mockTransport(() => ({}));
    const c = new Kinetex({ baseURL: "https://api.example.test", cache: true });
    // Inject the instance the way a user would share one across clients.
    (c as unknown as { _cache: HTTPCache })._cache = cache;
    const s = withTransport(c, transport);
    await s.client.get("/v1/me");
    const before = cache.getStats().totalEntries;
    assert.ok(before > 0, "precondition: the entry is cached");
    await c.destroy();
    assert.equal(
      cache.getStats().totalEntries,
      before,
      "destroy() must not delete persisted cache data",
    );
    assert.ok(
      await cache.get({ url: "https://api.example.test/v1/me", method: "GET", headers: {} }),
    );
  });
});

describe("P2 BatchQueue validates its configuration", () => {
  const stubClient = () =>
    ({ send: async () => mockRaw(200, {}, "{}", "https://x.test/") }) as never;

  it("rejects maxBatch = 0 (used to hang flush() forever)", () => {
    assert.throws(
      () => new BatchQueue(stubClient(), { maxBatch: 0 }),
      /maxBatch must be a positive integer/,
    );
  });

  it("rejects a negative or fractional maxBatch", () => {
    assert.throws(() => new BatchQueue(stubClient(), { maxBatch: -1 }), RangeError);
    assert.throws(() => new BatchQueue(stubClient(), { maxBatch: 2.5 }), RangeError);
  });

  it("rejects a negative flushMs", () => {
    assert.throws(() => new BatchQueue(stubClient(), { flushMs: -1 }), /flushMs/);
    assert.throws(() => new BatchQueue(stubClient(), { flushMs: Number.NaN }), /flushMs/);
  });

  it("accepts the defaults and a valid configuration", () => {
    assert.equal(new BatchQueue(stubClient()) instanceof BatchQueue, true);
    assert.equal(
      new BatchQueue(stubClient(), { maxBatch: 1, flushMs: 0 }) instanceof BatchQueue,
      true,
    );
  });

  it("flush() drains the queue", async () => {
    const q = new BatchQueue(stubClient(), { maxBatch: 10, flushMs: 10_000 });
    const p1 = q.enqueue("/a");
    const p2 = q.enqueue("/b");
    const p3 = q.enqueue("/c");
    assert.equal(q.pendingCount, 3);
    q.flush();
    assert.equal(q.pendingCount, 0);
    await Promise.all([p1, p2, p3]);
  });
});

describe("P2 dedup does not let a stale window timer wipe a new entry", () => {
  it("a second window survives the first window's timer", async () => {
    const d = new DedupMap({ windowMs: 25 });
    const factory = async () => "v";
    assert.equal(await d.execute("GET", "u", factory), "v");
    // Second request inside the first window is a hit.
    assert.equal(await d.execute("GET", "u", factory), "v");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(d.keys.length, 0, "the first window expired");
    // New request registers a fresh entry; the old timer must not delete it early.
    assert.equal(await d.execute("GET", "u", factory), "v");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(d.keys.length, 1, "the fresh entry must still be tracked");
  });

  it("counts hits and misses separately", async () => {
    const d = new DedupMap({ windowMs: 50 });
    const f = async () => 1;
    await d.execute("GET", "a", f);
    await d.execute("GET", "a", f);
    const stats = d.getStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 1);
  });
});

describe("P2 circuit breaker contract", () => {
  it("returns a rejected promise when fn throws synchronously", async () => {
    const b = new CircuitBreaker("k");
    const p = b.execute(() => {
      throw new Error("sync boom");
    });
    assert.ok(p instanceof Promise, "execute() must never throw synchronously");
    await assert.rejects(() => p, /sync boom/);
  });

  it("releases the half-open probe slot and closes after a successful probe", async () => {
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 5,
      successThreshold: 1,
      halfOpenConcurrency: 1,
    });
    await assert.rejects(() =>
      b.execute(async () => {
        throw new KinetexError("down", "ENETWORK");
      }),
    );
    assert.equal(b.state, "OPEN");
    // The OPEN → HALF_OPEN transition happens on the next execute().
    await new Promise((r) => setTimeout(r, 12));
    assert.equal(await b.execute(async () => "ok"), "ok");
    assert.equal(b.state, "CLOSED");
    assert.equal(
      b.snapshot.inFlightProbes,
      0,
      "the probe slot must be released even though the state already moved on",
    );
  });

  it("counts only configured failure kinds in the sliding window", async () => {
    // `windowSize: 4` with `failureThreshold: 10` was another unreachable
    // pair: the window can hold at most 4 results, so the threshold could
    // never be reached. The breaker now widens a window that is smaller than
    // the threshold (and warns), which would have silently made this window 10
    // and turned "never grow past windowSize" into a statement about 10. A
    // reachable pair keeps the FIFO behaviour under test.
    const b = new CircuitBreaker("k2", { failureThreshold: 4, windowSize: 4 });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() =>
        b.execute(async () => {
          throw new KinetexError("boom", "ENETWORK");
        }),
      );
    }
    assert.equal(b.snapshot.failureCount, 3);
    await b.execute(async () => "ok");
    assert.equal(b.snapshot.failureCount, 3, "a success does not erase recorded failures");
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() =>
        b.execute(async () => {
          throw new KinetexError("boom", "ENETWORK");
        }),
      );
    }
    // 7 results have gone through (3 failures, a success, 3 failures) and the
    // window holds the last 4: [success, fail, fail, fail]. The three original
    // failures have aged out and the newest three remain.
    assert.equal(
      b.snapshot.failureCount,
      3,
      "the window is FIFO: the oldest entries age out, the newest stay",
    );
    assert.ok(b.snapshot.failureCount <= 4, "the sliding window must never grow past windowSize");
    assert.equal(b.state, "CLOSED", "and the circuit must not have opened");
  });

  it("ignores non-countable failures by default", async () => {
    const b = new CircuitBreaker("k3", { failureThreshold: 1, windowSize: 4 });
    await assert.rejects(() =>
      b.execute(async () => {
        throw new Error("app error");
      }),
    );
    assert.equal(b.state, "CLOSED");
  });
});

describe("P2 getClientIP honours a trusted-proxy count", () => {
  const hdrs = (o: Record<string, string>) => new HttpHeaders(o);

  it("defaults to the left-most (spoofable) entry", () => {
    assert.equal(getClientIP(hdrs({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" })), "1.1.1.1");
  });

  it("trustedHops=1 selects the address the nearest proxy appended", () => {
    assert.equal(
      getClientIP(hdrs({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }), { trustedHops: 1 }),
      "3.3.3.3",
    );
  });

  it("trustedHops=2 selects the next one in", () => {
    assert.equal(
      getClientIP(hdrs({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }), { trustedHops: 2 }),
      "2.2.2.2",
    );
  });

  it("falls back to the left-most entry when there are fewer hops than trusted", () => {
    assert.equal(
      getClientIP(hdrs({ "x-forwarded-for": "9.9.9.9" }), { trustedHops: 3 }),
      "9.9.9.9",
    );
  });

  it("strips ports, brackets and RFC 7239 quoting", () => {
    assert.equal(getClientIP(hdrs({ forwarded: 'for=\"203.0.113.9:4711\"' })), "203.0.113.9");
    assert.equal(getClientIP(hdrs({ forwarded: 'for="[2001:db8::1]:443"' })), "2001:db8::1");
  });

  it("falls back to x-real-ip", () => {
    assert.equal(getClientIP(hdrs({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
  });

  it("returns null when nothing is present", () => {
    assert.equal(getClientIP(hdrs({ accept: "*/*" })), null);
  });

  it("clamps a negative trustedHops to 0", () => {
    assert.equal(
      getClientIP(hdrs({ "x-forwarded-for": "5.5.5.5, 6.6.6.6" }), { trustedHops: -2 }),
      "5.5.5.5",
    );
  });
});

describe("P2/P3 cookie domain handling", () => {
  it("stores a mixed-case Domain attribute in a matchable form", () => {
    const jar = new CookieJar();
    assert.equal(
      jar.setCookie("sid=1; Domain=Example.COM; Path=/", { url: "https://www.example.com/" }),
      true,
    );
    const cookies = jar.getCookies({ url: "https://www.example.com/" });
    assert.equal(cookies.length, 1, "a Domain=Example.COM cookie must still be sent");
    assert.equal(cookies[0]!.value, "1");
  });

  it("matchDomain is case-insensitive for directly inserted cookies", () => {
    const jar = new CookieJar();
    jar.putCookie({
      name: "a",
      value: "1",
      domain: "Example.COM",
      path: "/",
      expires: Date.now() + 60_000,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: false,
    });
    assert.equal(jar.getCookies({ url: "https://sub.example.com/" }).length, 1);
  });

  it("domainMatch rejects a public-suffix cookie domain", () => {
    assert.equal(domainMatch("example.com", "com"), false);
    assert.equal(domainMatch("shop.example.co.uk", "co.uk"), false);
    assert.equal(isPublicSuffix("com"), true);
  });

  it("domainMatch still accepts a registrable domain and subdomains", () => {
    assert.equal(domainMatch("www.example.com", "example.com"), true);
    assert.equal(domainMatch("example.com", "example.com"), true);
    assert.equal(domainMatch("www.example.com", "other.com"), false);
  });

  it("the jar refuses Domain=com outright", () => {
    const jar = new CookieJar();
    assert.equal(jar.setCookie("sid=1; Domain=com", { url: "https://example.com/" }), false);
  });

  it("rejects a Secure cookie from an insecure context", () => {
    const jar = new CookieJar();
    assert.equal(jar.setCookie("sid=1; Secure", { url: "http://example.com/" }), false);
    assert.equal(jar.setCookie("sid=1; Secure", { url: "https://example.com/" }), true);
  });

  it("rejects SameSite=None without Secure", () => {
    const jar = new CookieJar();
    assert.equal(jar.setCookie("sid=1; SameSite=None", { url: "https://example.com/" }), false);
  });
});

describe("P3 cache defaults and housekeeping", () => {
  it("304 is not in the default cacheable statuses (the client never stores it)", async () => {
    const cache = new HTTPCache();
    const stored = await cache.set(
      { url: "https://api.example.test/x", method: "GET", headers: {} },
      { status: 304, statusText: "Not Modified", headers: {}, body: null },
    );
    assert.equal(stored, false);
  });

  it("200 and the other default statuses are still stored", async () => {
    const cache = new HTTPCache();
    const req = { url: "https://api.example.test/x", method: "GET", headers: {} };
    const res = {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    };
    assert.equal(await cache.set(req, res), true);
  });

  it("does not cache non-GET/HEAD by default", async () => {
    const cache = new HTTPCache();
    const stored = await cache.set(
      { url: "https://api.example.test/x", method: "POST", headers: {} },
      { status: 200, statusText: "OK", headers: {}, body: null },
    );
    assert.equal(stored, false);
  });

  it("normalizes query-param order and the fragment in cache keys", async () => {
    const cache = new HTTPCache({ defaultTtlMs: 60_000 });
    const res = {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    };
    await cache.set(
      { url: "https://api.example.test/x?b=2&a=1#frag", method: "GET", headers: {} },
      res,
    );
    const hit = await cache.get({
      url: "https://api.example.test/x?a=1&b=2",
      method: "GET",
      headers: {},
    });
    assert.ok(hit, "param order and the fragment must not affect the cache key");
    assert.equal(new TextDecoder().decode(hit.entry.response.body), "{}");
  });

  it("cleans tag references for entries that vanish from storage", async () => {
    const cache = new HTTPCache({ maxEntries: 1, defaultTtlMs: 60_000 });
    const mk = (p: string) => ({
      url: `https://api.example.test/${p}`,
      method: "GET",
      headers: {},
    });
    const res = {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    };
    await cache.set(mk("a"), res, { tags: ["t1"] });
    await cache.set(mk("b"), res, { tags: ["t1"] });
    // t1 must still resolve to the surviving key only.
    const invalidated = await cache.invalidateByTag("t1");
    assert.ok(invalidated >= 1);
    assert.equal(await cache.get(mk("a")), null);
    assert.equal(await cache.get(mk("b")), null);
  });
});

describe("P2/P3 interceptor manager ordering and once semantics", () => {
  const imReq = (): never =>
    ({
      url: "https://x.test/",
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    }) as never;

  const okResponse = {
    status: 200,
    statusText: "OK",
    headers: {},
    url: "https://x.test/",
  } as never;

  it("runs interceptors in ascending priority regardless of registration order", async () => {
    const m = new InterceptorManager();
    const order: number[] = [];
    m.useRequest(() => void order.push(30));
    m.useRequest(() => void order.push(10), { priority: 10 });
    m.useRequest(() => void order.push(20), { priority: 20 });
    m.useRequest(() => void order.push(0), { priority: 0 });
    await m.execute(imReq(), async () => okResponse);
    // The first interceptor registered with the default priority 0 keeps its
    // place ahead of the later priority-0 entry (stable ordering), then the
    // explicitly prioritised ones run in ascending order.
    assert.deepEqual(order, [30, 0, 10, 20]);
  });

  it("preserves registration order for equal priorities", async () => {
    const m = new InterceptorManager();
    const order: string[] = [];
    m.useRequest(() => void order.push("first"));
    m.useRequest(() => void order.push("second"));
    await m.execute(imReq(), async () => okResponse);
    assert.deepEqual(order, ["first", "second"]);
  });

  it("ejects a `once` interceptor after it runs", async () => {
    const m = new InterceptorManager();
    let runs = 0;
    const id = m.useRequest(() => void runs++, { once: true });
    await m.execute(imReq(), async () => okResponse);
    await m.execute(imReq(), async () => okResponse);
    assert.equal(runs, 1);
    assert.equal(m.has(id), false);
  });

  it("honours a condition predicate", async () => {
    const m = new InterceptorManager();
    let runs = 0;
    m.useRequest(() => void runs++, { condition: (ctx) => ctx.request.url.includes("never") });
    await m.execute(imReq(), async () => okResponse);
    assert.equal(runs, 0);
  });

  it("eject() removes a registered interceptor", () => {
    const m = new InterceptorManager();
    const id = m.useRequest(() => {});
    assert.equal(m.eject(id), true);
    assert.equal(m.has(id), false);
    assert.equal(m.eject(id), false);
  });

  it("routes to the error phase and recovers", async () => {
    const m = new InterceptorManager();
    m.useRequest(() => {
      throw new KinetexError("nope", "EVALIDATION");
    });
    let sawError: unknown = null;
    m.useError((ctx) => {
      sawError = ctx.error;
      // A synthetic response must carry `request` for the pipeline to
      // recognise it as a response rather than a replacement request.
      return {
        status: 200,
        statusText: "Recovered",
        headers: {},
        url: ctx.request.url,
        request: ctx.request,
      } as never;
    });
    const res = await m.execute(imReq(), async () => okResponse);
    assert.equal(res.status, 200);
    assert.equal((sawError as { code?: string })?.code, "EVALIDATION");
  });
});

describe("P2 maxRequestSize reports a KinetexError for a circular body", () => {
  it("wraps the JSON.stringify failure", async () => {
    const c = new Kinetex({ baseURL: "https://api.example.test", maxRequestSize: 1024 });
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    await assert.rejects(
      () => c.post("/x", { body: circular as never }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError, `got ${(err as Error)?.name}`);
        assert.equal(err.code, "EVALIDATION");
        assert.match(err.message, /Cannot measure request body size/);
        return true;
      },
    );
  });

  it("still enforces the limit for a plain object body", async () => {
    const c = new Kinetex({ baseURL: "https://api.example.test", maxRequestSize: 8 });
    await assert.rejects(
      () => c.post("/x", { body: { key: "a-much-longer-value-than-8-bytes" } as never }),
      (err: unknown) => err instanceof KinetexError && /exceeds limit/.test(err.message),
    );
  });
});

describe("P3 transformResponse receives the real response", () => {
  it("passes status, headers and url instead of an empty object", async () => {
    const { transport } = mockTransport(() => ({
      headers: { "content-type": "text/plain", "x-custom": "v" },
      body: "raw-body",
    }));
    let seen: Record<string, unknown> | null = null;
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      transformResponse: (data, res) => {
        seen = res as unknown as Record<string, unknown>;
        return data;
      },
    });
    const s = withTransport(c, transport);
    const res = await s.client.get("/v1/x");
    assert.ok(seen, "transformResponse must be called");
    assert.equal(seen!["status"], 200);
    assert.equal((seen!["headers"] as Record<string, string>)["x-custom"], "v");
    assert.equal(seen!["url"], "https://api.example.test/v1/x");
    assert.equal(res.data, "raw-body");
  });

  it("still allows transforming the data", async () => {
    const { transport } = mockTransport(() => ({
      headers: { "content-type": "text/plain" },
      body: "abc",
    }));
    const c = new Kinetex({
      baseURL: "https://api.example.test",
      transformResponse: (data) => `<${String(data)}>`,
    });
    const s = withTransport(c, transport);
    assert.equal((await s.client.get("/x")).data, "<abc>");
  });
});

describe("P2 socks5 Node connector does not leak timers or hang after EOF", () => {
  it("resolves a read after the socket ends instead of hanging forever", async () => {
    const { createServer } = await import("node:net");
    const server = createServer((socket) => {
      socket.write("hello");
      setTimeout(() => socket.end(), 5);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const conn = await nodeTcpConnector("127.0.0.1", port, 2000);
      const buf = new Uint8Array(16);
      const first = await conn.read(buf);
      // The server writes exactly "hello" (5 bytes) before ending, so the first
      // read is 5 — not merely "something or null". Accepting `null` here let a
      // regression that dropped the greeting entirely pass.
      assert.equal(first, 5, "the 5-byte greeting must be readable in one read");
      assert.equal(
        String.fromCharCode(...[...buf.slice(0, first!)]),
        "hello",
        "the bytes read must be the greeting",
      );
      // Wait for the server to end the socket, then read again: previously this
      // promise never settled.
      await new Promise((r) => setTimeout(r, 30));
      const afterEof = await Promise.race([
        conn.read(new Uint8Array(16)),
        new Promise<symbol>((r) => setTimeout(() => r("TIMEOUT"), 500)),
      ]);
      assert.notEqual(afterEof, "TIMEOUT", "a read after EOF must settle");
      assert.equal(afterEof, null, "EOF must be reported as null");
      conn.close();
    } finally {
      server.close();
    }
  });

  it("still reads buffered data written before EOF", async () => {
    const { createServer } = await import("node:net");
    const server = createServer((socket) => {
      socket.end("payload");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const conn = await nodeTcpConnector("127.0.0.1", port, 2000);
      const buf = new Uint8Array(32);
      const n = await conn.read(buf);
      assert.equal(n, 7);
      assert.equal(new TextDecoder().decode(buf.subarray(0, 7)), "payload");
      conn.close();
    } finally {
      server.close();
    }
  });
});

describe("P2/P3 FetchTransport keeps caller accept-encoding intent", () => {
  const transport = new FetchTransport(async (_url: string, init: RequestInit) => {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  it("removes kinetex's own injected default so fetch can negotiate", async () => {
    const sent: string | null = await (async () => {
      let captured: string | null = null;
      const t = new FetchTransport(async (_u, init) => {
        captured = (init.headers as Record<string, string>)["accept-encoding"] ?? null;
        return new Response("{}", { status: 200 });
      });
      await t.send({
        url: "https://api.example.test/",
        method: "GET",
        headers: { "accept-encoding": "gzip, deflate, br" },
        body: null,
        signal: null,
        meta: {},
      });
      return captured;
    })();
    assert.equal(sent, null);
  });

  it("preserves a caller-set encoding list that differs from the default", async () => {
    let captured: string | undefined;
    const t = new FetchTransport(async (_u, init) => {
      captured = (init.headers as Record<string, string>)["accept-encoding"];
      return new Response("{}", { status: 200 });
    });
    await t.send({
      url: "https://api.example.test/",
      method: "GET",
      headers: { "accept-encoding": "gzip, deflate, br, zstd" },
      body: null,
      signal: null,
      meta: {},
    });
    assert.equal(captured, "gzip, deflate, br, zstd");
  });

  it("still throws for a CRLF header in strict mode", async () => {
    const strict = new FetchTransport({
      strict: true,
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    await assert.rejects(
      () =>
        strict.send({
          url: "https://api.example.test/",
          method: "GET",
          headers: { "x-bad": "a\r\nb" },
          body: null,
          signal: null,
          meta: {},
        }),
      (err: unknown) => err instanceof KinetexError && err.code === "EVALIDATION",
    );
  });

  it("drops (and reports) a CRLF header in non-strict mode", async () => {
    const dropped: Array<[string, string]> = [];
    let captured: Record<string, string> = {};
    const t = new FetchTransport({
      onDroppedHeader: (name, value) => dropped.push([name, value]),
      fetchFn: async (_u, init) => {
        captured = init.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      },
    });
    await t.send({
      url: "https://api.example.test/",
      method: "GET",
      headers: { "x-bad": "a\r\nb", "x-ok": "fine" },
      body: null,
      signal: null,
      meta: {},
    });
    assert.equal(captured["x-bad"], undefined);
    assert.equal(captured["x-ok"], "fine");
    assert.deepEqual(dropped, [["x-bad", "a\r\nb"]]);
  });
});
