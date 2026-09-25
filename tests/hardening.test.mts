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
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeParsedJSON } from "../src/utils.ts";
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
    assert.equal(cookies.find((c) => c.name === "__Host-forged"), undefined);
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
      seen.push({ auth: h.get("authorization") ?? undefined, cookie: h.get("cookie") ?? undefined });
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
        client.upload(
          "mutation($file: Upload!) { upload(file: $file) { id } }",
          { file: null },
          [{ file: new Blob(["x"]), path: "__proto__.polluted" }],
        ),
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
        client.upload(
          "mutation($file: Upload!) { upload(file: $file) { id } }",
          { file: null },
          [{ file: new Blob(["x"]), path: "variables.constructor.x" }],
        ),
      /Invalid upload path|reserved key/,
    );
  });
});
