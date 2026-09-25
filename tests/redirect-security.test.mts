/**
 * kinetex — Redirect security battle tests (offline, deterministic).
 *
 * Covers:
 *  - FIX H2: credential-bearing headers are stripped when a redirect crosses origins
 *  - Same-origin redirects PRESERVE Authorization (no false positives)
 *  - Auth re-application is suppressed on cross-origin hops
 *  - Redirect loop limits are enforced
 *  - Unsafe redirect schemes are rejected
 *
 * Manual redirect-following (and thus these tests) requires cookieJar: true,
 * which activates _sendFollowingRedirects. Mock transports only — isSafeURL
 * blocks loopback hosts by design (SSRF protection), so no local server.
 *
 * Run: npx tsx tests/redirect-security.test.mts
 */

import assert from "node:assert/strict";
import { Kinetex } from "../src/client.ts";
import { KinetexError } from "../src/types.ts";
import type { KinetexRequest } from "../src/types.ts";
import type { RawResponse as CoreRawResponse } from "../src/core.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// ── Mock transport ────────────────────────────────────────────────────────────
// Obeys the client's redirect:"manual" contract so _sendFollowingRedirects
// walks hop-by-hop, letting us assert exactly what headers each hop received.

function mockRaw(
  status: number,
  headers: Record<string, string>,
  body: string,
  url: string,
): CoreRawResponse {
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

interface MockBehavior {
  kind: "redirect" | "ok";
  location?: string;
  status?: number;
  body?: string;
}

function makeMock(behavior: (req: KinetexRequest) => MockBehavior) {
  const received: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport = {
    async send(req: KinetexRequest): Promise<CoreRawResponse> {
      received.push({ url: req.url, headers: { ...(req.headers as Record<string, string>) } });
      const b = behavior(req);
      if (b.kind === "redirect") {
        return mockRaw(
          b.status ?? 302,
          { location: b.location ?? "/", "content-type": "text/plain" },
          "",
          req.url,
        );
      }
      return mockRaw(200, { "content-type": "application/json" }, b.body ?? '{"ok":true}', req.url);
    },
  };
  return { transport, received };
}

function swapTransport(client: Kinetex, transport: unknown): () => void {
  const anyC = client as unknown as { transport: unknown };
  const original = anyC.transport;
  anyC.transport = transport;
  return () => {
    anyC.transport = original;
  };
}

// ============================================================================

async function main(): Promise<void> {
  // ── §1 Same-origin redirects must preserve credentials ─────────────────────

  suite("Same-origin redirect preserves credentials");

  await test("302 same-origin → Authorization preserved on final hop", async () => {
    const mk = makeMock((req) =>
      req.url.endsWith("/final") ? { kind: "ok" } : { kind: "redirect", location: "/final" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      const res = await c.get("/start", {
        auth: { type: "bearer", token: "same-token" },
      });
      assert.equal(res.status, 200);
    } finally {
      restore();
    }
    assert.equal(mk.received.length, 2, `expected two hops, got ${mk.received.length}`);
    const final = mk.received[1];
    assert.equal(new URL(final.url).pathname, "/final");
    assert.equal(
      final.headers["authorization"],
      "Bearer same-token",
      "same-origin redirect must keep Authorization",
    );
  });

  await test("301 POST → GET downgrade keeps Authorization on final hop", async () => {
    const mk = makeMock((req) =>
      req.url.endsWith("/final")
        ? { kind: "ok" }
        : { kind: "redirect", location: "/final", status: 301 },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.post("/start", JSON.stringify({ a: 1 }), {
        auth: { type: "bearer", token: "p-token" },
        headers: { "content-type": "application/json" },
      });
    } finally {
      restore();
    }
    assert.ok(mk.received.length >= 2);
    const final = mk.received[mk.received.length - 1];
    assert.equal(final.headers["authorization"], "Bearer p-token");
  });

  // ── §2 Cross-origin redirects must strip credentials (FIX H2) ──────────────

  suite("Cross-origin redirect strips credentials (FIX H2)");

  await test("Authorization is NOT forwarded to cross-origin target", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/steal" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        auth: { type: "bearer", token: "SECRET-TOKEN" },
        headers: { "x-api-key": "SECRET-KEY" },
      });
    } finally {
      restore();
    }
    assert.ok(mk.received.length >= 2);
    const crossHop = mk.received[1];
    assert.ok(crossHop.url.startsWith("https://evil.example.test/"), "should reach cross-origin hop");
    assert.equal(
      crossHop.headers["authorization"],
      undefined,
      "Authorization must NOT be forwarded cross-origin",
    );
    assert.equal(
      crossHop.headers["x-api-key"],
      undefined,
      "x-api-key must NOT be forwarded cross-origin",
    );
  });

  await test("Cookie header is NOT forwarded cross-origin", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/c" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        headers: { cookie: "session=abc123" },
      });
    } finally {
      restore();
    }
    const crossHop = mk.received[1];
    assert.ok(crossHop.url.startsWith("https://evil.example.test/"));
    assert.equal(crossHop.headers["cookie"], undefined, "Cookie must NOT be forwarded cross-origin");
  });

  await test("proxy-authorization is stripped cross-origin", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/p" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        headers: { "proxy-authorization": "Basic cHJveHk6c2VjcmV0" },
      });
    } finally {
      restore();
    }
    assert.equal(mk.received[1].headers["proxy-authorization"], undefined);
  });

  await test("x-csrf-token and www-authenticate are stripped cross-origin", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/s" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        headers: { "x-csrf-token": "csrf-123", "www-authenticate": "Basic realm=x" },
      });
    } finally {
      restore();
    }
    const crossHop = mk.received[1];
    assert.equal(crossHop.headers["x-csrf-token"], undefined);
    assert.equal(crossHop.headers["www-authenticate"], undefined);
  });

  await test("applyAuth does NOT re-inject Authorization on cross-origin hop", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/a" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        auth: { type: "bearer", token: "RETRY-LEAK" },
      });
    } finally {
      restore();
    }
    assert.equal(
      mk.received[1].headers["authorization"],
      undefined,
      "applyAuth re-application must be suppressed on cross-origin hops",
    );
  });

  await test("apikey auth header is stripped cross-origin", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/k" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        auth: { type: "apikey", header: "X-API-Key", key: "key-123" },
      });
    } finally {
      restore();
    }
    assert.equal(mk.received[1].headers["x-api-key"], undefined);
  });

  await test("x-auth-token / x-access-token / x-refresh-token stripped cross-origin", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://evil.example.test") ? { kind: "ok" } : { kind: "redirect", location: "https://evil.example.test/t" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        headers: {
          "x-auth-token": "a",
          "x-access-token": "b",
          "x-refresh-token": "c",
        },
      });
    } finally {
      restore();
    }
    const crossHop = mk.received[1];
    assert.equal(crossHop.headers["x-auth-token"], undefined);
    assert.equal(crossHop.headers["x-access-token"], undefined);
    assert.equal(crossHop.headers["x-refresh-token"], undefined);
  });

  // ── §3 Protocol downgrade / cross-scheme ───────────────────────────────────

  suite("Cross-scheme (https→http) strips credentials");

  await test("https → http downgrade drops Authorization", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("http://insecure.example.test") ? { kind: "ok" } : { kind: "redirect", location: "http://insecure.example.test/x" },
    );
    const c = new Kinetex({ baseURL: "https://secure.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    try {
      await c.get("/start", {
        auth: { type: "bearer", token: "DOWNGRADE-LEAK" },
      });
    } finally {
      restore();
    }
    assert.equal(mk.received[1].headers["authorization"], undefined);
  });

  // ── §4 Redirect loops and unsafe schemes ───────────────────────────────────

  suite("Redirect loop and unsafe-scheme protection");

  await test("infinite redirect loop terminates with error", async () => {
    const mk = makeMock(() => ({ kind: "redirect", location: "/loop" }));
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    let error: unknown;
    try {
      await c.get("/loop", { timeout: 5_000 });
    } catch (err) {
      error = err;
    } finally {
      restore();
    }
    assert.ok(error instanceof Error, "expected error for redirect loop");
    assert.ok(
      mk.received.length <= 25,
      `should not exceed ~21 hops, got ${mk.received.length}`,
    );
  });

  await test("redirect to file:// scheme is rejected", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://api.example.test") && req.url.endsWith("/start")
        ? { kind: "redirect", location: "file:///etc/passwd" }
        : { kind: "redirect", location: "/again" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    let error: unknown;
    try {
      await c.get("/start");
    } catch (err) {
      error = err;
    } finally {
      restore();
    }
    assert.ok(error instanceof Error, "expected rejection for file:// redirect");
    const msg = (error as Error).message.toLowerCase();
    assert.ok(
      msg.includes("unsafe") || msg.includes("scheme") || msg.includes("redirect") || msg.includes("location"),
      `unexpected error: ${msg}`,
    );
  });

  await test("redirect to data: scheme is rejected", async () => {
    const mk = makeMock((req) =>
      req.url.startsWith("https://api.example.test") && req.url.endsWith("/start")
        ? { kind: "redirect", location: "data:text/html,evil" }
        : { kind: "redirect", location: "/again" },
    );
    const c = new Kinetex({ baseURL: "https://api.example.test", cookieJar: true });
    const restore = swapTransport(c, mk.transport);
    let error: unknown;
    try {
      await c.get("/start");
    } catch (err) {
      error = err;
    } finally {
      restore();
    }
    assert.ok(error instanceof Error, "expected rejection for data: redirect");
  });

  // ── FINAL ──────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  REDIRECT SECURITY TESTS: ${passed}/${passed + failed} passed`);
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
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
