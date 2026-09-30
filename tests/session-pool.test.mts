/**
 * kinetex — connection pooling behaviour.
 *
 * Covers the gaps found while auditing the transport layer:
 *
 *  - `createTransport` accepted a session-options bag but never forwarded
 *    `maxSessions`, so the documented LRU cap was unreachable and the pool
 *    grew without bound. Asserted against the real private field, because the
 *    cap has no public accessor.
 *  - The client config had no way to reach the session pool at all:
 *    `client.ts` passed `undefined` for the session-options argument, so the
 *    `NodeHTTP2Transport` options were unreachable from `kinetex({...})`.
 *  - The legacy `node:https` HTTP/1.1 path called `https.request()` with no
 *    agent, so it inherited `https.globalAgent` — whose `keepAlive` default
 *    flipped on in Node 19. The same code handshaked per request on Node 18
 *    and pooled on Node 20+. It now uses a dedicated, bounded agent. (An
 *    earlier draft of this file claimed the path never pooled; that is wrong
 *    on Node 19+ and the "keep-alive off" case below asserts on the agent we
 *    build rather than on socket counts, which the global agent defeats.)
 *  - The `ca` transport option never reached that path, so a private or
 *    self-signed peer could not be reached without disabling verification
 *    process-wide.
 *
 * The keep-alive test drives a real TLS server with a throwaway self-signed
 * certificate generated at test time into the gitignored tmp/ directory, so no
 * key material is ever committed. If openssl is unavailable it skips cleanly.
 * The client screens URLs through `isSafeURL` (which blocks loopback), so the
 * transport is driven directly rather than through a `Kinetex` instance.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { createSecureServer, type SecureServer } from "node:http2";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTransport, NodeHTTP2Transport, readRawBody } from "../src/core.ts";
import { Kinetex } from "../src/client.ts";
import type { KinetexRequest } from "../src/types.ts";
import { requireCapability } from "./capability.ts";

// ── Throwaway TLS material (generated per run; nothing committed) ────────────

let opensslAvailable = false;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
  opensslAvailable = true;
} catch {
  /* openssl not on PATH — the TLS tests below skip with a reason. */
}

// In CI a missing openssl throws rather than skipping: a skipped block still
// reports success, so the suite would vanish from every green build silently.
// requireCapability returns false only on a developer machine that lacks it.
const HAVE_OPENSSL = requireCapability(
  "openssl",
  opensslAvailable,
  "these suites generate their own TLS material with it",
);

const REPO_TMP = fileURLToPath(new URL("../tmp/", import.meta.url));
let tmpDir: string | null = null;
let ca: string | null = null;

if (opensslAvailable) {
  mkdirSync(REPO_TMP, { recursive: true });
  tmpDir = mkdtempSync(join(tmpdir() === "/tmp" ? REPO_TMP : tmpdir(), `pool-${process.pid}-`));
  const keyPath = join(tmpDir, "localhost-key.pem");
  const certPath = join(tmpDir, "localhost-cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  ca = readFileSync(certPath, "utf8");
}

// ── Minimal harness (mirrors tests/raw-body.test.mts) ────────────────────────

let passed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

function suite(name: string): void {
  console.log("\n── " + name);
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
  }
}

/** Reads a private field for white-box assertions on plumbing, not behaviour. */
function priv<T>(obj: unknown, key: string): T {
  return (obj as Record<string, T>)[key];
}

// ── Local HTTPS server that records socket identity ─────────────────────────

interface Harness {
  url: string;
  /** Distinct TLS sockets the server accepted, in arrival order. */
  sockets: TLSSocket[];
  close: () => Promise<void>;
}

/**
 * Starts an HTTPS server that echoes a short body and reports the `remotePort`
 * of each accepted socket, so a test can tell a reused socket from a new one.
 */
async function startEchoServer(): Promise<Harness> {
  const sockets: TLSSocket[] = [];
  const server: Server = createServer(
    { key: readFileSync(join(tmpDir as string, "localhost-key.pem")), cert: ca as string },
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
  );
  server.on("secureConnection", (s: TLSSocket) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/echo`,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

interface H2Harness {
  /** Same server, two origin spellings — two distinct HTTP/2 origins. */
  urlA: string;
  urlB: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts an HTTP/2 TLS server. The throwaway certificate carries SANs for both
 * `DNS:localhost` and `IP:127.0.0.1`, so one server answers two distinct
 * origins — enough to drive the LRU cap without standing up a second listener.
 */
async function startH2Server(): Promise<H2Harness> {
  const server: SecureServer = createSecureServer({
    key: readFileSync(join(tmpDir as string, "localhost-key.pem")),
    cert: ca as string,
    allowHTTP1: false,
  });
  server.on("stream", (stream, headers) => {
    void headers;
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    urlA: `https://localhost:${port}/echo`,
    urlB: `https://127.0.0.1:${port}/echo`,
    port,
    close: () =>
      new Promise<void>((r) => {
        // closeAllConnections() drops the *accepted* sockets but leaves the
        // listener open, so the handle kept the event loop alive and the suite
        // never exited — it printed "17 passed, 0 failed" and then hung until
        // the runner killed it. `server.close()` is what actually releases the
        // listening handle; the HTTPS harness above already does both.
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A request that will actually negotiate HTTP/2. */
function h2Request(url: string, caPem: string): KinetexRequest {
  return {
    url,
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion: "HTTP/2",
  } as KinetexRequest & { _ca?: string };
}

/** Runs `fn` with `globalThis.fetch` removed, so the legacy path is selected. */
async function withoutFetch<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const had = "fetch" in g;
  const prev = g.fetch;
  delete g.fetch;
  try {
    return await fn();
  } finally {
    if (had) g.fetch = prev;
  }
}

function echoRequest(url: string, transportCa?: string): KinetexRequest {
  return {
    url,
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    // HTTP/1.1 skips the HTTP/2 attempt and goes straight to the fallback.
    httpVersion: "HTTP/1.1",
  } as KinetexRequest;
}

// ── Suite ───────────────────────────────────────────────────────────────────

suite("Connection pooling");

await test("createTransport forwards maxSessions to the transport", () => {
  const t = createTransport(undefined, true, { maxSessions: 7 });
  assert.ok(t instanceof NodeHTTP2Transport, "expected the Node HTTP/2 transport on Node");
  // No public accessor for the cap, so assert the field the LRU check reads.
  assert.equal(priv<number>(t, "maxSessions"), 7);
});

await test("createTransport leaves maxSessions at the default when unset", () => {
  const t = createTransport(undefined, true);
  assert.equal(priv<number>(t, "maxSessions"), 100);
});

await test("createTransport forwards sessionTTLMs and pingIntervalMs", () => {
  const t = createTransport(undefined, true, { sessionTTLMs: 1_234, pingIntervalMs: 5_678 });
  assert.equal(priv<number>(t, "sessionTTLMs"), 1_234);
  assert.equal(priv<number>(t, "pingIntervalMs"), 5_678);
});

await test("client sessionPool config reaches the transport", () => {
  const client = new Kinetex({ sessionPool: { maxSessions: 3, sessionTTLMs: 9_999 } });
  const t = priv<unknown>(client, "transport");
  assert.ok(t instanceof NodeHTTP2Transport, "expected the Node HTTP/2 transport on Node");
  assert.equal(priv<number>(t, "maxSessions"), 3);
  assert.equal(priv<number>(t, "sessionTTLMs"), 9_999);
  client.destroy();
});

await test("client without sessionPool keeps the transport defaults", () => {
  const client = new Kinetex({});
  const t = priv<unknown>(client, "transport");
  assert.equal(priv<number>(t, "maxSessions"), 100);
  assert.equal(priv<number>(t, "sessionTTLMs"), 300_000);
  client.destroy();
});

await test("createTransport forwards every option it claims to", () => {
  // The original defect in this area was an options bag that was accepted and
  // then partially dropped, so each option is asserted against the field the
  // transport actually reads. `maxSessions` was the one that shipped broken.
  const onDroppedHeader = (): void => {
    /* marker */
  };
  const t = createTransport(undefined, true, {
    sessionTTLMs: 11,
    pingIntervalMs: 22,
    maxSessions: 33,
    http1KeepAlive: false,
    http1MaxSockets: 44,
    connectTimeoutMs: 55,
    requestTimeoutMs: 66,
  });
  try {
    assert.ok(t instanceof NodeHTTP2Transport);
    assert.equal(priv<number>(t, "sessionTTLMs"), 11);
    assert.equal(priv<number>(t, "pingIntervalMs"), 22);
    assert.equal(priv<number>(t, "maxSessions"), 33);
    assert.equal(priv<boolean>(t, "_http1KeepAlive"), false);
    assert.equal(priv<number>(t, "_http1MaxSockets"), 44);
    assert.equal(priv<number>(t, "_connectTimeoutMs"), 55);
    assert.equal(priv<number>(t, "_requestTimeoutMs"), 66);
  } finally {
    t.destroy();
  }
});

await test("createTransport forwards ca, strict, onDroppedHeader and proxy", () => {
  const onDroppedHeader = (): void => {
    /* marker */
  };
  const proxy = { url: "http://127.0.0.1:1" };
  const t = createTransport(undefined, true, undefined, {
    ca: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
    strict: true,
    onDroppedHeader,
    proxy,
  });
  try {
    assert.ok(t instanceof NodeHTTP2Transport);
    assert.equal(typeof priv<string>(t, "_ca"), "string", "ca must reach the transport");
    assert.equal(priv<boolean>(t, "_strict"), true);
    assert.equal(priv<unknown>(t, "_onDroppedHeader"), onDroppedHeader);
    assert.deepEqual(priv<unknown>(t, "_proxy"), proxy);
  } finally {
    t.destroy();
  }
});

await test("http1KeepAlive defaults to on and is configurable", () => {
  assert.equal(priv<boolean>(new NodeHTTP2Transport({}), "_http1KeepAlive"), true);
  assert.equal(
    priv<boolean>(new NodeHTTP2Transport({ http1KeepAlive: false }), "_http1KeepAlive"),
    false,
  );
  assert.equal(priv<number>(new NodeHTTP2Transport({}), "_http1MaxSockets"), 16);
});

suite("Legacy HTTP/1.1 keep-alive (node:https)");

if (!HAVE_OPENSSL) {
  console.log("  ⏭  skipped: openssl is not available on this machine");
} else {
  await test("reuses one TLS socket across sequential requests", async () => {
    const h = await startEchoServer();
    const transport = new NodeHTTP2Transport({ ca: ca as string });
    try {
      await withoutFetch(async () => {
        for (let i = 0; i < 4; i++) {
          const raw = await transport.send(echoRequest(h.url));
          if (raw.body) await readRawBody(raw.body, 0, h.url, null);
          assert.equal(raw.status, 200);
        }
      });
      // The whole point: one handshake, not four.
      assert.equal(
        h.sockets.length,
        1,
        `expected 1 reused socket, saw ${h.sockets.length} — keep-alive is not working`,
      );
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("the keep-alive agent is built lazily and only once", async () => {
    const h = await startEchoServer();
    const transport = new NodeHTTP2Transport({ ca: ca as string, http1MaxSockets: 4 });
    try {
      assert.equal(priv(transport, "_http1Agent"), null, "no agent before the first request");
      await withoutFetch(async () => {
        for (let i = 0; i < 3; i++) {
          const raw = await transport.send(echoRequest(h.url));
          if (raw.body) await readRawBody(raw.body, 0, h.url, null);
        }
      });
      const agent = priv<{ maxSockets: number; options: { keepAlive?: boolean } }>(
        transport,
        "_http1Agent",
      );
      assert.ok(agent, "agent should exist after a request");
      assert.equal(agent.options.keepAlive, true);
      // Bounded, unlike the global agent's 256 free sockets.
      assert.equal(agent.maxSockets, 4);
      assert.equal(h.sockets.length, 1, "the pooled socket should be reused");
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("http1KeepAlive:false builds no agent", async () => {
    const h = await startEchoServer();
    const transport = new NodeHTTP2Transport({ ca: ca as string, http1KeepAlive: false });
    try {
      // Socket counts cannot prove this: on Node 19+ the global agent we fall
      // back to keeps sockets alive anyway. Assert we build no agent instead.
      const raw = await withoutFetch(() => transport.send(echoRequest(h.url)));
      if (raw.body) await readRawBody(raw.body, 0, h.url, null);
      assert.equal(raw.status, 200);
      assert.equal(priv(transport, "_http1Agent"), null, "opt-out must skip the dedicated agent");
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("the legacy path trusts the configured ca", async () => {
    // Without `ca` reaching this path, the self-signed cert would be rejected
    // and the request would fail rather than return 200.
    const h = await startEchoServer();
    const transport = new NodeHTTP2Transport({ ca: ca as string });
    try {
      const raw = await withoutFetch(() => transport.send(echoRequest(h.url)));
      if (raw.body) await readRawBody(raw.body, 0, h.url, null);
      assert.equal(raw.status, 200);
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("destroy() drains the legacy keep-alive pool", async () => {
    const h = await startEchoServer();
    const transport = new NodeHTTP2Transport({ ca: ca as string });
    await withoutFetch(async () => {
      const raw = await transport.send(echoRequest(h.url));
      if (raw.body) await readRawBody(raw.body, 0, h.url, null);
    });
    assert.ok(priv(transport, "_http1Agent"), "agent should exist after a request");
    transport.destroy();
    assert.equal(priv(transport, "_http1Agent"), null, "destroy() must release the agent");
    h.close();
  });
}

await test("createTransport forwards strict and onDroppedHeader to the fetch transport", () => {
  // The fetch path has its own copy of these two options; forwarding them only
  // on the HTTP/2 path would silently drop them whenever a custom `fetch` or a
  // `dispatcher` selected FetchTransport.
  const onDroppedHeader = (): void => {
    /* marker */
  };
  const t = createTransport(
    (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
    false,
    undefined,
    { strict: true, onDroppedHeader },
  );
  try {
    assert.equal(priv<boolean>(t, "strict"), true, "strict must reach FetchTransport");
    assert.equal(priv<unknown>(t, "onDroppedHeader"), onDroppedHeader);
  } finally {
    t.destroy?.();
  }
});

// ── HTTP/2 session LRU eviction ─────────────────────────────────────────────

suite("HTTP/2 session pool — LRU cap");

if (!HAVE_OPENSSL) {
  console.log("  ⏭  skipped: openssl is not available on this machine");
} else {
  await test("evicts the least-recently-used session once maxSessions is reached", async () => {
    const h = await startH2Server();
    const transport = new NodeHTTP2Transport({ ca: ca as string, maxSessions: 1 });
    try {
      const first = await transport.send(h2Request(h.urlA, ca as string));
      if (first.body) await readRawBody(first.body, 0, h.urlA, null);
      assert.equal(first.status, 200, "the first origin must connect");
      assert.equal(priv<Map<string, unknown>>(transport, "sessions").size, 1);

      // A second, distinct origin pushes the pool past its cap of 1.
      const second = await transport.send(h2Request(h.urlB, ca as string));
      if (second.body) await readRawBody(second.body, 0, h.urlB, null);
      assert.equal(second.status, 200, "the second origin must connect");

      const sessions = priv<Map<string, unknown>>(transport, "sessions");
      assert.equal(sessions.size, 1, "the cap must hold at maxSessions");
      assert.ok(
        sessions.has(h.urlA.replace(/\/echo$/, "")) === false,
        "the least-recently-used origin should have been evicted",
      );
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("a session older than sessionTTLMs is evicted before reuse", async () => {
    // Stale eviction runs before the LRU cap and destroys the old session.
    // Without it a cached session past its TTL would be handed out forever and
    // a dead connection would surface as a request failure rather than a
    // transparent reconnect.
    const h = await startH2Server();
    const transport = new NodeHTTP2Transport({
      ca: ca as string,
      maxSessions: 10,
      sessionTTLMs: 1,
    });
    try {
      const first = await transport.send(h2Request(h.urlA, ca as string));
      if (first.body) await readRawBody(first.body, 0, h.urlA, null);
      assert.equal(first.status, 200);
      assert.equal(priv<Map<string, unknown>>(transport, "sessions").size, 1);

      await new Promise((r) => setTimeout(r, 25));

      const second = await transport.send(h2Request(h.urlA, ca as string));
      if (second.body) await readRawBody(second.body, 0, h.urlA, null);
      assert.equal(second.status, 200, "a stale session must be replaced, not reused");
      assert.equal(priv<Map<string, unknown>>(transport, "sessions").size, 1);
    } finally {
      transport.destroy();
      h.close();
    }
  });

  await test("a repeated request reuses the cached session instead of evicting", async () => {
    const h = await startH2Server();
    const transport = new NodeHTTP2Transport({ ca: ca as string, maxSessions: 1 });
    try {
      for (let i = 0; i < 3; i++) {
        const raw = await transport.send(h2Request(h.urlA, ca as string));
        if (raw.body) await readRawBody(raw.body, 0, h.urlA, null);
        assert.equal(raw.status, 200);
      }
      // Same origin every time: the pool is full but nothing needs evicting.
      assert.equal(priv<Map<string, unknown>>(transport, "sessions").size, 1);
    } finally {
      transport.destroy();
      h.close();
    }
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err);
  }
  process.exit(1);
}
