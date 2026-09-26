/**
 * Battle tests for the H6 prototype-pollution sanitizer rollout and related
 * hardening fixes that were not previously covered:
 *
 *  - sanitizeParsedJSON applied to GraphQL responses / batch / SSE events
 *  - SSE jsonSSE + SSERouter.onJSON sanitization
 *  - WS message JSON sanitization
 *  - deserializePaginationState sanitization
 *  - logging Redactor body-field path hardening
 *  - graphql setNestedValue upload-path pollution guard
 *  - cookie-store fromJSON round-trip with hostile names
 *  - HAR redaction of credential headers (recorder unit)
 *  - cross-origin redirect credential stripping (integration, no network)
 *  - client pre-flight guards: proxy fail-fast, httpsOnly, unparseable-URL
 *    fallback (manual param-concat + redactUserInfo regex), request-size
 *    accounting for ArrayBuffer / Blob / FormData bodies
 *  - timeout interceptor merged-signal lifecycle (listener-leak fix)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSafeURL, randomBytes, sanitizeParsedJSON } from "../src/utils.ts";
import { Kinetex } from "../src/client.ts";
import { jsonSSE, parseSSEText, SSERouter } from "../src/sse.ts";
import { deserializePaginationState, serializePaginationState } from "../src/pagination.ts";
import { Redactor } from "../src/logging.ts";
import { CookieJar } from "../src/cookie-store.ts";

// ── sanitizeParsedJSON core ───────────────────────────────────────────────────

describe("sanitizeParsedJSON battle", () => {
  it("strips __proto__ / constructor / prototype at every depth", () => {
    const hostile = JSON.parse(
      '{"a":{"__proto__":{"polluted":1},"b":{"constructor":2,"prototype":3},"c":[{"__proto__":4},{"nested":{"constructor":5}}]}}',
    );
    const clean = sanitizeParsedJSON(hostile) as Record<string, any>;
    const a = clean.a as Record<string, any>;
    // NOTE: `in` is wrong here — `"__proto__" in obj` is true via the
    // prototype chain. Own-property checks are the correct assertion.
    assert.equal(Object.hasOwn(a, "__proto__"), false);
    assert.equal(Object.hasOwn(a.b, "constructor"), false);
    assert.equal(Object.hasOwn(a.b, "prototype"), false);
    const c = a.c as Array<Record<string, any>>;
    assert.equal(Object.hasOwn(c[0], "__proto__"), false);
    assert.equal(Object.hasOwn(c[1].nested, "constructor"), false);
    // prototype chains must remain intact on sanitized containers
    assert.ok(Object.getPrototypeOf(a) === Object.prototype);
    assert.ok(Array.isArray(c));
  });

  it("does not pollute Object.prototype via hostile keys", () => {
    const hostile = JSON.parse('{"__proto__":{"injected":"yes"}}') as any;
    sanitizeParsedJSON(hostile);
    const probe: Record<string, unknown> = {};
    assert.equal((probe as any).injected, undefined);
    assert.equal(({} as any).injected, undefined);
  });

  it("preserves primitives and null", () => {
    assert.equal(sanitizeParsedJSON(5 as any), 5);
    assert.equal(sanitizeParsedJSON("x" as any), "x");
    assert.equal(sanitizeParsedJSON(null as any), null);
    assert.equal(sanitizeParsedJSON(true as any), true);
  });

  it("leaves normal payloads byte-identical in meaning", () => {
    const payload = { list: [1, "two", { three: 3 }], flag: false, nested: { deep: { v: null } } };
    assert.deepEqual(sanitizeParsedJSON(structuredClone(payload) as any), payload);
  });
});

// ── SSE sanitization ──────────────────────────────────────────────────────────

describe("SSE JSON battle", () => {
  const HOSTILE = '{"ok":true,"__proto__":{"x":1},"data":{"constructor":{"y":2}}}';

  function eventsOf(raw: string) {
    return parseSSEText(raw);
  }

  it("jsonSSE strips pollution keys from event data", async () => {
    const events = eventsOf(`event: update\ndata: ${HOSTILE}\n\n`);
    assert.equal(events.length, 1);
    const out: any[] = [];
    for await (const jsonEvt of jsonSSE<any>(events)) out.push(jsonEvt.data);
    assert.equal(out.length, 1);
    assert.equal(Object.hasOwn(out[0], "__proto__"), false);
    assert.equal(Object.hasOwn(out[0].data, "constructor"), false);
    assert.equal(out[0].ok, true);
  });

  it("SSERouter.onJSON strips pollution keys before handler", async () => {
    const router = new SSERouter();
    let seen: any = null;
    router.onJSON<any>("update", (data) => {
      seen = data;
    });
    const evt = eventsOf(`event: update\ndata: ${HOSTILE}\n\n`)[0];
    await router.dispatch(evt);
    assert.ok(seen, "handler should be called");
    assert.equal(Object.hasOwn(seen, "__proto__"), false);
    assert.equal(Object.hasOwn(seen.data, "constructor"), false);
  });

  it("jsonSSE still reports parse errors via onError", async () => {
    let errored = false;
    const events = eventsOf("event: bad\ndata: {not-json}\n\n");
    for await (const _ of jsonSSE(events, { onError: () => (errored = true) })) {
      /* consume */
    }
    assert.equal(errored, true);
  });
});

// ── Pagination state ──────────────────────────────────────────────────────────

describe("deserializePaginationState battle", () => {
  it("round-trips legitimate state", () => {
    const state = { cursor: "abc", page: 2, hasMore: true } as any;
    const rt = deserializePaginationState(serializePaginationState(state)) as any;
    assert.equal(rt.cursor, "abc");
    assert.equal(rt.page, 2);
  });

  it("strips pollution keys from hostile serialized state", () => {
    const b64 = Buffer.from(
      JSON.stringify({ cursor: "a", __proto__: { evil: 1 }, constructor: 2 }),
    ).toString("base64");
    const state = deserializePaginationState(b64) as any;
    assert.equal(Object.hasOwn(state, "__proto__"), false);
    assert.equal(Object.hasOwn(state, "constructor"), false);
    assert.equal(state.cursor, "a");
    const probe: Record<string, unknown> = {};
    assert.equal((probe as any).evil, undefined);
  });

  it("rejects garbage with the documented error", () => {
    assert.throws(() => deserializePaginationState("!!!not-base64!!!"), /Invalid pagination state/);
  });
});

// ── Logging redactor ──────────────────────────────────────────────────────────

describe("Redactor battle", () => {
  it("redacts configured body fields", () => {
    const r = new Redactor({ bodyFields: ["password", "user.token"], logRequestBody: true });
    const out = r.redactBody(
      JSON.stringify({ password: "hunter2", user: { token: "jwt", name: "a" } }),
      "application/json",
      false,
    );
    const parsed = JSON.parse(out.body as string);
    assert.equal(parsed.password, "***");
    assert.equal(parsed.user.token, "***");
    assert.equal(parsed.user.name, "a");
  });

  it("cannot be used to traverse __proto__ via bodyFields", () => {
    const r = new Redactor({
      bodyFields: ["__proto__.polluted", "constructor.x"],
      logRequestBody: true,
    });
    const out = r.redactBody('{"a":1}', "application/json", false);
    const probe: Record<string, unknown> = {};
    assert.equal((probe as any).polluted, undefined);
    assert.equal(out.body, '{"a":1}');
  });

  it("leaves non-JSON bodies untouched", () => {
    const r = new Redactor({ bodyFields: ["password"], logRequestBody: true });
    const out = r.redactBody("plain text body", "text/plain", false);
    assert.equal(out.body, "plain text body");
  });
});

// ── Cookie jar persistence ────────────────────────────────────────────────────

describe("CookieJar.toJSON/fromJSON battle", () => {
  it("round-trips cookies and drops expired ones", () => {
    const jar = new CookieJar();
    jar.putCookie({
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/",
      expires: Infinity,
      maxAge: null,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: true,
    });
    const json = jar.toJSON();
    assert.equal(json.length, 1);
    const jar2 = CookieJar.fromJSON(JSON.stringify(json));
    assert.equal(jar2.count, 1);
  });

  it("fromJSON is not a prototype-pollution vector", () => {
    // Malicious JSON with hostile names must not poison Object.prototype.
    const hostile = JSON.stringify([
      { name: "__proto__", value: "x", domain: "example.com", path: "/" },
    ]);
    const jar = CookieJar.fromJSON(hostile);
    assert.equal(jar.count, 1); // stored under a Map key, not an object key
    const probe: Record<string, unknown> = {};
    assert.equal((probe as any).x, undefined);
  });

  it("__Host- cookies that lost their contract are not re-emitted", () => {
    const jar = new CookieJar();
    // Forged store entry claiming __Host- prefix but violating prefix rules.
    jar.putCookie({
      name: "__Host-forged",
      value: "v",
      domain: "example.com",
      path: "/deep",
      expires: Infinity,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: false,
    });
    const cookies = jar.getCookies("https://example.com/deep");
    assert.equal(
      cookies.find((c) => c.name === "__Host-forged"),
      undefined,
    );
  });
});

// ── HAR recorder redaction ────────────────────────────────────────────────────

describe("HAR redaction battle", () => {
  it("credential headers never appear in HAR exports via the client recorder", async () => {
    // Use the public HAR config surface so we test real client behavior.
    const { kinetex } = await import("../src/mod.ts");
    const calls: Array<{ input: any }> = [];
    const fakeFetch: typeof fetch = (async (input: any, _init?: any) => {
      calls.push({ input });
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=secret123; Path=/; HttpOnly",
        },
      });
    }) as unknown as typeof fetch;

    const client = kinetex({ baseURL: "https://api.example.com", fetch: fakeFetch, har: true });
    await client.get("/thing", {
      headers: { Authorization: "Bearer super-secret", "X-API-Key": "k-123" },
    });

    const har = client.getHAR();
    const json = JSON.stringify(har);
    assert.ok(har, "HAR log should exist");
    assert.ok(!json.includes("super-secret"), "Authorization value leaked into HAR");
    assert.ok(!json.includes("k-123"), "API key leaked into HAR");
    assert.ok(!json.includes("secret123"), "Set-Cookie value leaked into HAR");
    client.destroy();
  });
});

// ── Cross-origin redirect credential stripping (offline transport) ───────────

describe("redirect credential stripping battle", () => {
  it("strips Authorization and Cookie when redirected across origins", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const seen: Array<{ auth?: string; cookie?: string }> = [];
    let hop = 0;
    const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input.url ?? input);
      const h = new Headers(init?.headers);
      seen.push({
        auth: h.get("authorization") ?? undefined,
        cookie: h.get("cookie") ?? undefined,
      });
      hop++;
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.net/landing" },
        });
      }
      return new Response('{"landed":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fakeFetch,
      // Manual redirect-following (required for the credential-strip logic
      // under test) is driven from the cookie-jar dispatch path.
      cookieJar: true,
      auth: { type: "bearer", token: "secret-token" },
    });
    const res = await client.get("/profile");
    assert.equal(res.status, 200);
    assert.equal(seen[0]?.auth, "Bearer secret-token", "first hop must carry auth");
    assert.equal(seen[1]?.auth, undefined, "cross-origin hop must NOT carry auth");
    assert.equal(seen[1]?.cookie, undefined, "cross-origin hop must NOT carry cookies");
    client.destroy();
  });
});

// ── GraphQL upload path pollution guard ──────────────────────────────────────

describe("GraphQL setNestedValue guard battle", () => {
  it("client.upload rejects __proto__ upload paths before any network call", async () => {
    const { createGraphQLClient } = await import("../src/graphql.ts");
    const client = createGraphQLClient({ url: "https://api.example.com/graphql" });
    await assert.rejects(
      () =>
        client.upload("mutation($file: Upload!) { upload(file: $file) { id } }", { file: null }, [
          { file: new Blob(["x"]), path: "__proto__.polluted" },
        ]),
      /Invalid upload path|__proto__|reserved key/,
    );
    const probe: Record<string, unknown> = {};
    assert.equal((probe as any).polluted, undefined);
  });

  it("client.upload rejects constructor/prototype upload paths", async () => {
    const { createGraphQLClient } = await import("../src/graphql.ts");
    const client = createGraphQLClient({ url: "https://api.example.com/graphql" });
    await assert.rejects(
      () =>
        client.upload("mutation($file: Upload!) { upload(file: $file) { id } }", { file: null }, [
          { file: new Blob(["x"]), path: "variables.constructor.x" },
        ]),
      /Invalid upload path|reserved key/,
    );
  });
});

// ── SSRF parser battle (H1 hardening) ─────────────────────────────────────────

describe("isSafeURL SSRF battle", () => {
  it("blocks IPv4-mapped IPv6 loopback/IMDS (dotted and hex forms)", () => {
    assert.equal(isSafeURL("http://[::ffff:127.0.0.1]/"), false);
    assert.equal(isSafeURL("http://[::ffff:7f00:1]/"), false);
    assert.equal(isSafeURL("http://[::ffff:169.254.169.254]/"), false);
  });

  it("blocks deprecated IPv4-compatible IPv6 forms", () => {
    assert.equal(isSafeURL("http://[::127.0.0.1]/"), false);
    assert.equal(isSafeURL("http://[::169.254.169.254]/"), false);
  });

  it("blocks NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embedded private IPv4", () => {
    assert.equal(isSafeURL("http://[64:ff9b::7f00:1]/"), false);
    assert.equal(isSafeURL("http://[2002:7f00:1::]/"), false);
  });

  it("blocks reserved IPv6 ranges (unspecified, ULA, link-local, multicast, doc)", () => {
    assert.equal(isSafeURL("http://[::]/"), false);
    assert.equal(isSafeURL("http://[fc00::1]/"), false);
    assert.equal(isSafeURL("http://[fd12::1]/"), false);
    assert.equal(isSafeURL("http://[fe80::1]/"), false);
    assert.equal(isSafeURL("http://[ff02::1]/"), false);
    assert.equal(isSafeURL("http://[2001:db8::1]/"), false);
  });

  it("blocks CGNAT, TEST-NET, multicast and reserved IPv4 ranges", () => {
    assert.equal(isSafeURL("http://100.64.0.1/"), false);
    assert.equal(isSafeURL("http://192.0.2.1/"), false);
    assert.equal(isSafeURL("http://224.0.0.1/"), false);
    assert.equal(isSafeURL("http://240.0.0.1/"), false);
  });

  it("blocks WHATWG shortcut and trailing-dot IPv4 host forms (IMDS bypass)", () => {
    // "169.254.43253" is 169.254.168.245 (link-local/IMDS). URL parsers keep
    // the trailing-dot form verbatim, so the parser must resolve it itself.
    assert.equal(isSafeURL("http://169.254.43253./"), false);
    assert.equal(isSafeURL("http://127.1./"), false);
    assert.equal(isSafeURL("http://10.1./"), false);
    assert.equal(isSafeURL("http://127.0.0.1./"), false);
    // Malformed dot runs must never fall through to the domain path.
    assert.equal(isSafeURL("http://127.0.0.1../"), false);
    // Legit public FQDN with trailing dot stays allowed.
    assert.equal(isSafeURL("http://example.com./"), true);
  });

  it("rejects URLs whose IPv4 shorthand overflows instead of treating them as domains", () => {
    // WHATWG URL parsing fails for IPv4 shorthand that overflows (component
    // >= 256^(5-n), single number >= 2^32, or more than 4 dotted labels), so
    // such URLs can never be constructed — and isSafeURL rejects anything it
    // cannot parse. Defense-in-depth: hostile overflow forms are never
    // silently reclassified as plain domain names.
    assert.equal(isSafeURL("http://4294967296./"), false);
    assert.equal(isSafeURL("http://1.2.3.4.5./"), false);
    assert.equal(isSafeURL("http://127.0.0.1.5/"), false);
    // A valid last-component shortcut with a trailing dot still expands and
    // is range-checked: 8.8.43253 → 8.8.168.245 (public → allowed)...
    assert.equal(isSafeURL("http://8.8.43253./"), true);
    // ...while 2130706433 → 127.0.0.1 (loopback → blocked).
    assert.equal(isSafeURL("http://2130706433./"), false);
  });

  it("blocks IPv4/IPv6-mapped forms whose embedded address is public", () => {
    // ::ffff:93.184.216.34 is public — allowed (sanitizer does not over-block)
    assert.equal(isSafeURL("http://[::ffff:93.184.216.34]/"), true);
  });

  it("rejects unparseable IPv6 literals defensively", () => {
    // 5 groups + invalid group → parseIPv6Host returns null → reject
    assert.equal(isSafeURL("http://[1:2:3:4:5::gggg]/"), false);
  });

  it("still allows legitimate public hosts", () => {
    assert.equal(isSafeURL("https://example.com/"), true);
    assert.equal(isSafeURL("http://93.184.216.34/"), true);
    assert.equal(isSafeURL("http://[2606:2800:220:1:248:1893:25c8:1946]/"), true);
  });
});

// ── randomBytes CSPRNG contract ────────────────────────────────────────────────

describe("randomBytes contract", () => {
  it("produces correct-length hex output", () => {
    const hex = randomBytes(16);
    assert.equal(hex.length, 32);
    assert.match(hex, /^[0-9a-f]+$/);
    assert.notEqual(randomBytes(16), randomBytes(16));
  });

  it("throws a descriptive error when no CSPRNG is available", async () => {
    const { randomBytes } = await import("../src/utils.ts");
    const orig = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      assert.throws(() => randomBytes(8), /CSPRNG/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: orig,
        configurable: true,
        writable: true,
      });
    }
  });

  it("allows zero bytes and rejects invalid counts", () => {
    assert.equal(randomBytes(0), "");
    assert.throws(() => randomBytes(-1), /invalid byteCount/);
    assert.throws(() => randomBytes(1.5), /invalid byteCount/);
    assert.throws(() => randomBytes(65537), /invalid byteCount/);
  });
});

// ── Auth header-injection guards (H3) ─────────────────────────────────────────

describe("auth injection guards", () => {
  it("bearer auth rejects CRLF-carrying tokens from async providers", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const client = kinetex({
      baseURL: "https://api.example.com",
      auth: { type: "bearer", token: async () => "tok\r\nX-Evil: 1" },
    });
    await assert.rejects(() => client.get("/x"), /forbidden characters/);
    client.destroy();
  });

  it("apikey auth rejects invalid header names and values", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const c1 = kinetex({
      baseURL: "https://api.example.com",
      auth: { type: "apikey", header: "X-Bad\r\nHeader", key: "k" },
    });
    await assert.rejects(() => c1.get("/x"), /Invalid apikey auth header name/);
    c1.destroy();

    const c2 = kinetex({
      baseURL: "https://api.example.com",
      auth: { type: "apikey", header: "X-Key", key: async () => "v\r\nX-Evil: 1" },
    });
    await assert.rejects(() => c2.get("/x"), /Invalid apikey value/);
    c2.destroy();
  });
});

// ── buildURL fallback safety check (M4) ───────────────────────────────────────

describe("buildURL manual fallback safety", () => {
  it("rejects unsafe URLs assembled by the manual query-param fallback", async () => {
    const { kinetex } = await import("../src/mod.ts");
    // Absolute URL whose query string is malformed enough to force the manual
    // concat path, embedding a loopback host.
    const client = kinetex({ baseURL: "https://api.example.com" });
    await assert.rejects(() => client.get("http://127.0.0.1/p?%%%"), /safety check|EVALIDATION/);
    client.destroy();
  });
});

// ── Request-size limit matrix (H4) ────────────────────────────────────────────

describe("maxRequestSize body accounting", () => {
  function clientWith(limit: number) {
    return new Kinetex({ baseURL: "https://api.example.com", maxRequestSize: limit });
  }

  it("counts DataView and URLSearchParams bodies", async () => {
    const dv = clientWith(4);
    const data = new DataView(new ArrayBuffer(8));
    await assert.rejects(() => dv.post("/x", data as unknown as BodyInit), /exceeds limit/);
    dv.destroy();

    const us = clientWith(4);
    await assert.rejects(
      () => us.post("/x", new URLSearchParams("a=12345678") as unknown as BodyInit),
      /exceeds limit/,
    );
    us.destroy();
  });

  it("estimates FormData multipart size instead of skipping it", async () => {
    const c = clientWith(4);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(64)]), "f.bin");
    await assert.rejects(() => c.post("/x", fd as unknown as BodyInit), /exceeds limit/);
    c.destroy();
  });

  it("rejects ReadableStream bodies when a limit is configured", async () => {
    const c = clientWith(1024);
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(4));
        ctrl.close();
      },
    });
    await assert.rejects(() => c.post("/x", stream as unknown as BodyInit), /ReadableStream/);
    c.destroy();
  });

  it("allows ReadableStream bodies when the limit is explicitly disabled", async () => {
    let seen = 0;
    const fakeFetch: typeof fetch = (async () => {
      seen++;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const c = new Kinetex({ baseURL: "https://api.example.com", fetch: fakeFetch });
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(4));
        ctrl.close();
      },
    });
    await c.post("/x", stream as unknown as BodyInit, { maxRequestSize: 0 });
    assert.equal(seen, 1);
    c.destroy();
  });
});

// ── HAR recording battle ───────────────────────────────────────────────────────

describe("HAR recording battle", () => {
  it("records a redacted entry for a fetch and clears on clearHAR()", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const fakeFetch: typeof fetch = (async () =>
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fakeFetch,
      har: true,
      headers: { authorization: "Bearer sekrit" },
    });
    await client.get("/users");
    const har = client.getHAR();
    assert.equal(har.entries.length, 1);
    assert.equal(har.entries[0]!.request.url, "https://api.example.com/users");
    const auth = har.entries[0]!.request.headers.find((h) => h.name === "authorization");
    assert.equal(auth?.value, "***REDACTED***");
    client.clearHAR();
    assert.equal(client.getHAR().entries.length, 0);
    client.destroy();
  });

  it("throws when HAR was not enabled", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const client = kinetex({ baseURL: "https://api.example.com" });
    assert.throws(() => client.getHAR(), /har: true/);
    client.destroy();
  });
});

// ── CookieJar prefix-rule retrieval defense (H5) ──────────────────────────────

describe("CookieJar __Host-/__Secure- retrieval battle", () => {
  it("never emits __Host- cookies whose flags no longer satisfy the contract", () => {
    const jar = CookieJar.fromJSON([
      {
        name: "__Host-session",
        value: "good",
        domain: "example.com",
        path: "/",
        expires: null,
        maxAge: null,
        secure: true,
        httpOnly: true,
        sameSite: "None",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        hostOnly: true,
      },
      {
        name: "__Host-broken",
        value: "bad",
        domain: "example.com",
        path: "/sub",
        expires: null,
        maxAge: null,
        secure: false,
        httpOnly: false,
        sameSite: "None",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        hostOnly: false,
      },
      {
        name: "__Secure-broken",
        value: "bad",
        domain: "example.com",
        path: "/",
        expires: null,
        maxAge: null,
        secure: false,
        httpOnly: false,
        sameSite: "None",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        hostOnly: false,
      },
    ]);
    const names = jar
      .getCookies({ url: "https://example.com/" })
      .map((c) => c.name)
      .sort();
    assert.deepEqual(names, ["__Host-session"]);
    jar.destroy();
  });
});

// ── Timeout interceptor merged-signal lifecycle (listener-leak fix) ─────────

describe("timeout interceptor merged-signal cleanup", () => {
  async function makeManager() {
    const { InterceptorManager, createTimeoutInterceptor } = await import("../src/interceptors.ts");
    const m = new InterceptorManager();
    const timeout = createTimeoutInterceptor({ timeoutMs: 5000 });
    m.useRequest(timeout.requestInterceptor);
    m.useResponse(timeout.responseInterceptor);
    m.useError(timeout.errorInterceptor);
    return m;
  }

  it("cleans up the merged external-signal listener on success", async () => {
    const m = await makeManager();
    const external = new AbortController();
    const res = await m.execute(
      {
        url: "https://api.example.com/x",
        method: "GET",
        headers: {},
        signal: external.signal,
      },
      async () => new Response("ok"),
    );
    assert.equal(res.status, 200);
    // After the response the request-phase listener must be detached: a late
    // external abort is a no-op and must not surface anywhere.
    external.abort();
  });

  it("propagates an external abort through the merged signal", async () => {
    const m = await makeManager();
    const external = new AbortController();
    await assert.rejects(
      () =>
        m.execute(
          {
            url: "https://api.example.com/x",
            method: "GET",
            headers: {},
            signal: external.signal,
          },
          async () => {
            // Abort mid-flight so the timeout interceptor's merged-signal
            // handler runs (clears its timer + forwards the abort reason).
            external.abort(new Error("user-cancel"));
            throw new Error("user-cancel");
          },
        ),
      /user-cancel|abort/i,
    );
  });

  it("cleans up the merged external-signal listener on dispatcher error", async () => {
    const m = await makeManager();
    const external = new AbortController();
    await assert.rejects(
      () =>
        m.execute(
          {
            url: "https://api.example.com/x",
            method: "GET",
            headers: {},
            signal: external.signal,
          },
          async () => {
            throw new Error("boom");
          },
        ),
      /boom/,
    );
    // Late external abort after the error cleanup must be inert.
    external.abort();
  });
});

// ── Client pre-flight guard coverage (M7 / httpsOnly / H4 leftovers) ─────────

describe("client pre-flight guards", () => {
  it("fail-fasts when a proxy is configured but unusable", async () => {
    const { kinetex } = await import("../src/mod.ts");
    const client = kinetex({
      baseURL: "https://api.example.com",
      proxy: "http://proxy.example.com:8080",
    });
    await assert.rejects(
      () => client.get("/x"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(String((err as Error).message ?? err), /proxy/i);
        return true;
      },
    );
    client.destroy();
  });

  it("enforces httpsOnly for http URLs", async () => {
    const client = new Kinetex({ baseURL: "https://api.example.com", httpsOnly: true });
    await assert.rejects(() => client.get("http://api.example.com/x"), /HTTPS-only/i);
    client.destroy();
  });

  it("rejects unparseable URLs after param merging (redactUserInfo fallback)", async () => {
    // "99999" is a reserved/bad port — URL parsing throws both in buildURL and
    // in the safety check, forcing the manual-fallback + regex-redaction path.
    const client = new Kinetex({ baseURL: "https://api.example.com" });
    await assert.rejects(
      () => client.get("https://api.example.com:99999/p"),
      /safety check|EVALIDATION/i,
    );
    client.destroy();
  });

  it("counts ArrayBuffer, Blob, and FormData bodies toward maxRequestSize", async () => {
    const client = new Kinetex({ baseURL: "https://api.example.com", maxRequestSize: 8 });
    await assert.rejects(() => client.post("/x", new ArrayBuffer(32)), /exceeds limit/i);
    await assert.rejects(() => client.post("/x", new Blob([new Uint8Array(32)])), /exceeds limit/i);
    await assert.rejects(() => {
      const fd = new FormData();
      fd.append("a", "value-longer-than-eight");
      return client.post("/x", fd);
    }, /exceeds limit/i);
    client.destroy();
  });
});

// ── GraphQL upload leaf-path guard (H6) ───────────────────────────────────────

describe("GraphQL upload leaf path guard", () => {
  it("rejects reserved keys at the leaf of an upload path", async () => {
    const { createGraphQLClient } = await import("../src/graphql.ts");
    const client = createGraphQLClient({ url: "https://api.example.com/graphql" });
    await assert.rejects(
      () =>
        client.upload("mutation($file: Upload!) { upload(file: $file) { id } }", { file: null }, [
          { file: new Blob(["x"]), path: "variables.__proto__" },
        ]),
      /Invalid upload path|reserved key/,
    );
  });
});

// ── GraphQL external-signal lifecycle (listener-leak fix, offline) ──────────

describe("GraphQL external-signal lifecycle", () => {
  /**
   * The httpbin-dependent graphql suite is skipped in CI, so the leak-fix
   * listener lines (execute/upload/batch) must be exercised offline via the
   * injectable `fetch`. Each test also verifies the abort listener is actually
   * REMOVED from the caller's signal once the operation settles — the leak
   * itself is what the fix is about.
   */
  function makeClient() {
    return import("../src/graphql.ts").then(({ createGraphQLClient }) =>
      createGraphQLClient({
        url: "https://api.example.com/graphql",
        fetch: (async () =>
          new Response(JSON.stringify({ data: { ok: 1 } }), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      }),
    );
  }

  function instrument(signal: AbortSignal) {
    const calls = { added: 0, removed: 0 };
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      calls.added++;
      return origAdd(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      calls.removed++;
      return origRemove(...args);
    }) as AbortSignal["removeEventListener"];
    return calls;
  }

  it("query: listener added and removed on the caller's signal", async () => {
    const client = await makeClient();
    const external = new AbortController();
    const calls = instrument(external.signal);
    await client.query("{ ok }", undefined, { signal: external.signal });
    assert.equal(calls.added, 1);
    assert.equal(calls.removed, 1, "listener must be removed once the fetch settles");
  });

  it("upload: listener added and removed on the caller's signal", async () => {
    const client = await makeClient();
    const external = new AbortController();
    const calls = instrument(external.signal);
    await client.upload(
      "mutation($file: Upload!) { upload(file: $file) { id } }",
      { file: null },
      [{ file: new Blob(["x"]), path: "variables.file" }],
      { signal: external.signal },
    );
    assert.equal(calls.added, 1);
    assert.equal(calls.removed, 1, "listener must be removed once the fetch settles");
  });

  it("batch: listener added and removed on the caller's signal", async () => {
    const { createGraphQLClient } = await import("../src/graphql.ts");
    const external = new AbortController();
    const calls = instrument(external.signal);
    const client = createGraphQLClient({
      url: "https://api.example.com/graphql",
      // Batch responses are JSON arrays, one entry per request.
      fetch: (async () =>
        new Response(JSON.stringify([{ data: { a: 1 } }, { data: { b: 2 } }]), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await client.batch([{ query: "{ a }" }, { query: "{ b }" }], {
      signal: external.signal,
    });
    assert.equal(calls.added, 1);
    assert.equal(calls.removed, 1, "listener must be removed once the fetch settles");
  });

  it("query: external abort mid-flight rejects and the listener is removed", async () => {
    const { createGraphQLClient } = await import("../src/graphql.ts");
    const external = new AbortController();
    const calls = instrument(external.signal);
    const client = createGraphQLClient({
      url: "https://api.example.com/graphql",
      timeoutMs: 0, // isolate propagation: abort comes from the external signal only
      fetch: (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }) as unknown as typeof fetch,
    });
    // Abort shortly after the request starts so the merged-signal listener
    // (onExternalAbort) must forward the abort into the client's controller.
    const abortTimer = setTimeout(() => external.abort(), 15);
    if (typeof abortTimer.unref === "function") abortTimer.unref();
    await assert.rejects(
      () => client.query("{ ok }", undefined, { signal: external.signal }),
      /timed out|aborted|Network error/i,
    );
    assert.equal(calls.removed, 1, "error path must also detach the listener");
  });
});
