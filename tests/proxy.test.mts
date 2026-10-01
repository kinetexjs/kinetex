/**
 * kinetex — HTTP(S) CONNECT proxy tunneling.
 *
 * Drives a real CONNECT proxy in front of a real target server, because the
 * things most likely to break here are protocol-level: the status line, header
 * termination, credential encoding, and what happens on a refusal. A mock
 * would not catch a malformed request head.
 *
 * The target speaks plain HTTP over a raw socket so the tests need no
 * certificate, but the tunnel itself is the real thing: TCP connect, CONNECT,
 * status validation, byte relay.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { connect as netConnect, createServer as netCreateServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectThroughProxy } from "../src/proxy.ts";
import { NodeHTTP2Transport } from "../src/core.ts";
import { Kinetex } from "../src/client.ts";
import { KinetexError } from "../src/types.ts";

let passed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    // A hung socket must fail the test, never stall the whole run.
    await withTimeout(Promise.resolve().then(fn), 10_000, name);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
  }
}

function suite(name: string): void {
  console.log("\n── " + name);
}

/** Reject with a timeout error if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`test "${name}" timed out after ${ms}ms`)), ms);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ── Fakes ───────────────────────────────────────────────────────────────────

/** What the fake proxy should answer with. */
interface ProxyBehaviour {
  /** Raw status line to return, e.g. "HTTP/1.1 403 Forbidden". */
  status?: string;
  /** Refuse the TCP connection outright. */
  refuse?: boolean;
  /** Accept the CONNECT but never reply. */
  hang?: boolean;
  /** Require this exact Proxy-Authorization header. */
  expectAuth?: string;
  /** Status to return when the auth header does not match. */
  authFailureStatus?: string;
}

interface FakeProxy {
  url: string;
  /** CONNECT request heads the proxy received, in order. */
  seen: string[];
  close: () => Promise<void>;
}

/**
 * Starts a minimal CONNECT proxy.
 *
 * On a valid request it replies 200 and then pipes the client socket to the
 * requested authority — a byte relay, exactly like a real proxy.
 */
async function startProxy(behaviour: ProxyBehaviour = {}): Promise<FakeProxy> {
  const seen: string[] = [];
  // A CONNECT socket is detached from the HTTP server's own connection
  // tracking, so `closeAllConnections()` does NOT reach it and `close()` would
  // never call back. Track them explicitly.
  const tunnelled = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    // Plain HTTP (not CONNECT) — not used by these tests.
    res.writeHead(405).end();
  });
  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    tunnelled.add(clientSocket);
    clientSocket.once("close", () => tunnelled.delete(clientSocket));
    seen.push(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${JSON.stringify(req.headers)}`);

    if (behaviour.hang) return; // never answer

    const fail = (status: string): void => {
      clientSocket.end(`${status}\r\nContent-Length: 0\r\n\r\n`);
    };

    if (
      behaviour.expectAuth !== undefined &&
      req.headers["proxy-authorization"] !== behaviour.expectAuth
    ) {
      fail(behaviour.authFailureStatus ?? "HTTP/1.1 407 Proxy Authentication Required");
      return;
    }
    if (
      behaviour.status !== undefined &&
      behaviour.status !== "HTTP/1.1 200 Connection established"
    ) {
      fail(behaviour.status);
      return;
    }

    const [host, port] = (req.url ?? "").split(":");
    const upstream = netConnect({ host: host ?? "", port: Number(port ?? 80) });
    clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of tunnelled) s.destroy();
        tunnelled.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A trivial HTTP origin that echoes what it was asked for. */
interface Target {
  url: string;
  /** Number of requests the origin has served so far. */
  hits: () => number;
  close: () => Promise<void>;
}

async function startTarget(): Promise<Target> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`tunnelled:${req.url}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hello`,
    // A getter, not a snapshot: returning the number by value froze it at 0.
    hits: () => hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * Read a response head from a socket.
 *
 * Resolves on the first chunk that contains the head terminator. A peer that
 * dies, resets, or simply stops talking first rejects with that reason, so a
 * broken relay surfaces here as a named failure instead of a stalled run.
 */
async function readHead(socket: Socket, ms = 5_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (err?: Error): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (c: Buffer): void => {
      buf += c.toString("latin1");
      if (buf.includes("\r\n\r\n")) done();
    };
    const onEnd = (): void =>
      done(
        buf.includes("\r\n\r\n")
          ? undefined
          : new Error(`peer ended after ${buf.length} bytes without a complete head`),
      );
    const onError = (e: Error): void => done(e);
    const timer = setTimeout(
      () => done(new Error(`no response head within ${ms}ms (got ${buf.length} bytes)`)),
      ms,
    );
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
}

/**
 * Parse the JSON header block a recorded CONNECT head ends with.
 *
 * Substring matching over the recorded line is too weak: it cannot tell
 * `{"proxy-authorization":""}` from a header that is genuinely absent, which
 * is exactly the distinction the credential tests turn on.
 */
function recordedHeaders(recorded: string): Record<string, string> {
  const nl = recorded.indexOf("\r\n");
  assert.ok(nl !== -1, `recorded head has no header section: ${recorded}`);
  return JSON.parse(recorded.slice(nl + 2)) as Record<string, string>;
}

// ── Tests ───────────────────────────────────────────────────────────────────

suite("CONNECT proxy tunneling");

await test("tunnels a request through the proxy to the target", async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url));
  try {
    socket.write(`GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    const head = await readHead(socket);
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.match(head, /tunnelled:\/hello/);
    assert.equal(target.hits(), 1, "the target must have received exactly one request");
  } finally {
    socket.destroy();
    await proxy.close();
    await target.close();
  }
});

await test("sends CONNECT with the target authority in the request line", async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url));
  try {
    assert.equal(proxy.seen.length, 1, "exactly one tunnel must have been requested");
    const t = new URL(target.url);
    // The whole request line, not a prefix: a proxy that answered
    // `CONNECT host:port HTTP/1.1` where the authority carries the *proxy's*
    // port, or where the target port is missing, would still pass a
    // `startsWith` on the hostname.
    const [method, url, version] = proxy.seen[0].split("\r\n", 1)[0]!.split(" ");
    assert.equal(method, "CONNECT");
    assert.equal(url, `${t.hostname}:${t.port}`);
    assert.equal(version, "HTTP/1.1");
    // And the Host header must agree with the request-target authority.
    assert.equal(recordedHeaders(proxy.seen[0]).host, `${t.hostname}:${t.port}`);
  } finally {
    socket.destroy();
    await proxy.close();
  }
});

await test("omits Proxy-Authorization when no credentials are configured", async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url));
  try {
    assert.equal(proxy.seen.length, 1, "the tunnel must have been requested");
    const headers = recordedHeaders(proxy.seen[0]);
    assert.ok(
      !("proxy-authorization" in headers),
      `must not send empty credentials, got ${JSON.stringify(headers)}`,
    );
    // The keep-alive hint real clients send, so the shape of the head is
    // pinned as well as the absence of the credential.
    assert.equal(headers["proxy-connection"], "Keep-Alive");
  } finally {
    socket.destroy();
    await proxy.close();
  }
});

await test("sends Basic Proxy-Authorization when credentials are configured", async () => {
  const target = await startTarget();
  const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
  const proxy = await startProxy({ expectAuth: expected });
  const socket = await connectThroughProxy(
    { url: proxy.url, username: "alice", password: "s3cret" },
    new URL(target.url),
  );
  try {
    assert.equal(proxy.seen.length, 1);
    assert.equal(recordedHeaders(proxy.seen[0])["proxy-authorization"], expected);
  } finally {
    socket.destroy();
    await proxy.close();
  }
});

await test("treats an empty password as a real credential", async () => {
  const target = await startTarget();
  const expected = `Basic ${Buffer.from("token:").toString("base64")}`;
  const proxy = await startProxy({ expectAuth: expected });
  const socket = await connectThroughProxy(
    { url: proxy.url, username: "token", password: "" },
    new URL(target.url),
  );
  try {
    // The exact value, not merely "a header is present": an empty password
    // must encode as `Basic <btoa("token:")>`, which is a different string
    // from `Basic `, from `token:token`, and from an unencoded literal.
    assert.equal(proxy.seen.length, 1);
    assert.equal(recordedHeaders(proxy.seen[0])["proxy-authorization"], expected);
    assert.equal(expected, `Basic ${Buffer.from("token:").toString("base64")}`);
  } finally {
    socket.destroy();
    await proxy.close();
  }
});

await test("treats an empty username as a real credential", async () => {
  // The mirror of the empty-password case, and the branch the encoding
  // function's own doc comment calls out: "an empty username is still a
  // deliberate (if unusual) credential, so it is encoded rather than
  // skipped". Some proxies authenticate on the secret alone, so `:pass` is a
  // usable identity — dropping the header would send nothing at all and the
  // request would fail as 407 instead of connecting.
  const target = await startTarget();
  const expected = `Basic ${Buffer.from(":s3cret").toString("base64")}`;
  const proxy = await startProxy({ expectAuth: expected });
  const socket = await connectThroughProxy(
    { url: proxy.url, username: "", password: "s3cret" },
    new URL(target.url),
  );
  try {
    assert.equal(proxy.seen.length, 1);
    assert.equal(recordedHeaders(proxy.seen[0])["proxy-authorization"], expected);
  } finally {
    socket.destroy();
    await proxy.close();
    await target.close();
  }
});

await test("rejects a 407 with actionable auth guidance", async () => {
  const target = await startTarget();
  const proxy = await startProxy({ status: "HTTP/1.1 407 Proxy Authentication Required" });
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, new URL(target.url)),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        assert.match(err.message, /407/);
        assert.match(err.message, /username/);
        assert.match(err.message, /password/);
        // The remediation is named precisely, not left as a shrug.
        assert.ok(
          err.message.includes("Set `username`/`password` on the proxy config"),
          `407 guidance must name the setting to change: ${err.message}`,
        );
        // The credentials themselves must never be echoed back to the caller.
        assert.doesNotMatch(err.message, /s3cret/);
        return true;
      },
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

await test("rejects a non-2xx CONNECT status and reports it", async () => {
  const target = await startTarget();
  const proxy = await startProxy({ status: "HTTP/1.1 403 Forbidden" });
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, new URL(target.url)),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        assert.match(err.message, /403/);
        const t = new URL(target.url);
        assert.ok(
          err.message.includes(`Proxy refused CONNECT to ${t.hostname}:${t.port}: 403 Forbidden`),
          `refusal must name the status and the authority: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

await test("times out when the proxy never answers", async () => {
  const target = await startTarget();
  const proxy = await startProxy({ hang: true });
  const t = new URL(target.url);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, t, { connectTimeoutMs: 250 }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "ETIMEOUT");
        // The message must say which authority went unanswered and how long
        // the caller was willing to wait -- a bare "ETIMEOUT" leaves the user
        // guessing whether the proxy or the target was slow.
        assert.equal(
          err.message,
          `Proxy did not respond to CONNECT for ${t.hostname}:${t.port} within 250ms`,
        );
        return true;
      },
    );
    // It really waited for its own budget rather than failing some other way.
    assert.ok(
      Date.now() - t0 >= 200,
      `gave up after ${Date.now() - t0}ms, before the 250ms budget expired`,
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

await test("rejects a malformed proxy URL", async () => {
  await assert.rejects(
    () => connectThroughProxy({ url: "not a url" }, new URL("http://example.com/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
      assert.equal(err.message, 'proxy url "not a url" is not a valid URL');
      // The underlying parse failure is attached, not swallowed.
      assert.ok(err.cause instanceof Error, "the URL parser error must be preserved as the cause");
      return true;
    },
  );
});

await test("rejects an unsupported proxy scheme", async () => {
  await assert.rejects(
    () => connectThroughProxy({ url: "ftp://proxy.example.com" }, new URL("http://example.com/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
      assert.match(err.message, /ftp:/);
      // The message must also say what is supported, or the fix is a guess.
      assert.match(err.message, /http:/);
      assert.match(err.message, /https:/);
      assert.match(err.message, /socks5:/);
      return true;
    },
  );
});

await test("points SOCKS5 users at kinetex/socks5 instead of trying to tunnel", async () => {
  await assert.rejects(
    () => connectThroughProxy({ url: "socks5://127.0.0.1:1080" }, new URL("http://example.com/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
      assert.match(err.message, /socks5/i);
      return true;
    },
  );
});

await test("reports an unreachable proxy as ENETWORK", async () => {
  // Port 1 is reserved and never listening.
  await assert.rejects(
    () => connectThroughProxy({ url: "http://127.0.0.1:1" }, new URL("http://example.com/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "ENETWORK");
      // ECONNREFUSED, and the address that refused -- a dial failure reported
      // as a bare ENETWORK cannot be told apart from a TLS failure.
      assert.equal(err.message, "Cannot reach proxy 127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1");
      assert.ok(err.cause instanceof Error, "the socket error must be preserved as the cause");
      return true;
    },
  );
});

await test("aborts an in-flight CONNECT when the signal fires", async () => {
  const target = await startTarget();
  const proxy = await startProxy({ hang: true });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  try {
    await assert.rejects(
      () =>
        connectThroughProxy({ url: proxy.url }, new URL(target.url), {
          connectTimeoutMs: 5_000,
          signal: ac.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        // Pinned, not "EABORT or ETIMEOUT": the budget is 5s and the abort
        // lands at 40ms, so only the abort can explain the rejection.
        assert.equal(err.code, "EABORT");
        assert.equal(err.message, "Proxy connection aborted");
        return true;
      },
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

await test("rejects immediately when the signal is already aborted", async () => {
  const target = await startTarget();
  const proxy = await startProxy();
  const ac = new AbortController();
  ac.abort();
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, new URL(target.url), { signal: ac.signal }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EABORT");
        assert.equal(err.message, "Proxy connection aborted");
        return true;
      },
    );
    // The proxy must never have been contacted.
    assert.equal(proxy.seen.length, 0);
  } finally {
    await proxy.close();
    await target.close();
  }
});

// ── TLS paths ───────────────────────────────────────────────────────────────
//
// A CONNECT tunnel only does half the job for an `https:` target: the socket
// it returns is still plain TCP and must be wrapped in TLS to the *target*.
// That step, and the separate case of an `https:` proxy, are the paths that
// only a real certificate can exercise — so a throwaway self-signed
// localhost cert is generated per run into the gitignored tmp/ directory and
// nothing is ever committed.

let openssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  openssl = false;
}

let tmpDir: string | null = null;
let ca: string | null = null;

if (openssl) {
  const repoTmp = fileURLToPath(new URL("../tmp/", import.meta.url));
  mkdirSync(repoTmp, { recursive: true });
  tmpDir = mkdtempSync(join(tmpdir() === "/tmp" ? repoTmp : tmpdir(), `proxytls-${process.pid}-`));
  const key = join(tmpDir, "k.pem");
  const cert = join(tmpDir, "c.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  ca = readFileSync(cert, "utf8");
  (globalThis as Record<string, unknown>).__KINETEX_TLS_KEY = readFileSync(key, "utf8");
}

suite("CONNECT proxy — TLS");

const tlsKey = (): string => (globalThis as Record<string, unknown>).__KINETEX_TLS_KEY as string;

/**
 * Closes a TLS server deterministically.
 *
 * A half-open TLS session is not always covered by `closeAllConnections()`,
 * and `close()` would then never call back. Sockets are tracked explicitly
 * and a fallback timer guarantees the promise settles either way.
 */
function closeTls(server: TlsServer, sockets: Set<Socket>): Promise<void> {
  return new Promise<void>((r) => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    server.closeAllConnections?.();
    const guard = setTimeout(r, 500);
    if (typeof (guard as unknown as { unref?: () => void }).unref === "function") {
      (guard as unknown as { unref: () => void }).unref();
    }
    server.close(() => {
      clearTimeout(guard);
      r();
    });
  });
}

/** An HTTPS origin that echoes the path. */
async function startTlsTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: TlsServer = createTlsServer({ key: tlsKey(), cert: ca as string }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tls-through-proxy");
  });
  server.on("secureConnection", (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/secure`,
    close: () => closeTls(server, sockets),
  };
}

/** A proxy that speaks TLS to the client, then relays. */
async function startTlsProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const tunnelled = new Set<Socket>();
  const server: TlsServer = createTlsServer({ key: tlsKey(), cert: ca as string });
  server.on("connect", (req, clientSocket: Socket) => {
    tunnelled.add(clientSocket);
    clientSocket.once("close", () => tunnelled.delete(clientSocket));
    const [host, port] = (req.url ?? "").split(":");
    const upstream = netConnect({ host: host ?? "", port: Number(port ?? 80) });
    clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const inbound = new Set<Socket>();
  server.on("secureConnection", (s: Socket) => {
    inbound.add(s);
    s.once("close", () => inbound.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    close: () => closeTls(server, new Set<Socket>([...tunnelled, ...inbound])),
  };
}

if (!openssl) {
  console.log("  ⏭  skipped: openssl is not available on this machine");
} else {
  await test("tunnels to an HTTPS target and completes TLS to it", async () => {
    const target = await startTlsTarget();
    const proxy = await startProxy();
    try {
      const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url), {
        ca: ca as string,
      });
      try {
        assert.equal((socket as { encrypted?: boolean }).encrypted, true, "socket must be TLS");
        socket.write("GET /secure HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        const head = await readHead(socket);
        assert.match(head, /tls-through-proxy/);
      } finally {
        socket.destroy();
      }
    } finally {
      await target.close();
      await proxy.close();
    }
  });

  await test("rejects an untrusted target certificate", async () => {
    const target = await startTlsTarget();
    const proxy = await startProxy();
    try {
      // No `ca` — the self-signed cert must be rejected rather than trusted.
      await assert.rejects(
        () => connectThroughProxy({ url: proxy.url }, new URL(target.url)),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError);
          assert.equal(err.code, "ENETWORK");
          // Named as a *verification* failure, not merely "something TLS":
          // a generic TLS error would also be produced by a truncated
          // handshake, which is a different bug.
          assert.match(err.message, /^TLS handshake through proxy failed for 127\.0\.0\.1: /);
          assert.match(err.message, /self[- ]signed|unable to verify|DEPTH_ZERO_SELF_SIGNED/i);
          return true;
        },
      );
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  await test("tunnels through an HTTPS proxy", async () => {
    const target = await startTarget();
    const proxy = await startTlsProxy();
    try {
      const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url), {
        ca: ca as string,
      });
      try {
        socket.write("GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert.match(await readHead(socket), /tunnelled:\/hello/);
      } finally {
        socket.destroy();
      }
    } finally {
      await target.close();
      await proxy.close();
    }
  });

  await test("reports an untrusted HTTPS proxy certificate", async () => {
    const proxy = await startTlsProxy();
    try {
      await assert.rejects(
        () => connectThroughProxy({ url: proxy.url }, new URL("http://127.0.0.1:1/x")),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError);
          assert.equal(err.code, "ENETWORK");
          assert.match(err.message, /Cannot reach proxy/);
          return true;
        },
      );
    } finally {
      await proxy.close();
    }
  });

  await test("reports a TLS handshake failure when the target drops the socket", async () => {
    // A plain HTTP server does not fail fast against a TLS client — it can
    // just hold the socket open forever, which is a hang, not an error. A raw
    // TCP peer that drops the connection makes the TLS wrap fail at once.
    const rude = netCreateServer((s) => s.destroy());
    await new Promise<void>((r) => rude.listen(0, "127.0.0.1", r));
    const { port } = rude.address() as AddressInfo;
    const proxy = await startProxy();
    try {
      await assert.rejects(
        () =>
          connectThroughProxy({ url: proxy.url }, new URL(`https://127.0.0.1:${port}/x`), {
            ca: ca as string,
          }),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError);
          assert.equal(err.code, "ENETWORK");
          assert.match(err.message, /TLS handshake through proxy failed/);
          return true;
        },
      );
    } finally {
      await proxy.close();
    }
  });
}

/**
 * A TCP peer that accepts and then says nothing at all.
 *
 * Used to stall a TLS handshake deterministically: an HTTP server would answer
 * the ClientHello with 400 and close, erroring long before a timeout or abort
 * could fire. `closeAllConnections()` is an http.Server API and is a no-op
 * here, so sockets are tracked and destroyed directly — otherwise `close()`
 * waits forever on a socket whose peer has already gone.
 */
async function startSilentPeer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = netCreateServer((s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        const guard = setTimeout(r, 500);
        if (typeof (guard as unknown as { unref?: () => void }).unref === "function") {
          (guard as unknown as { unref: () => void }).unref();
        }
        server.close(() => {
          clearTimeout(guard);
          r();
        });
      }),
  };
}

suite("CONNECT proxy — remaining branches");

await test("encodes Basic auth without btoa", async () => {
  // The fallback path matters for runtimes (and future Node versions) that
  // lack the global btoa; a non-Latin1 username would also mangle through it.
  const target = await startTarget();
  const expected = `Basic ${Buffer.from("user:pä").toString("base64")}`;
  const proxy = await startProxy({ expectAuth: expected });
  const g = globalThis as Record<string, unknown>;
  const had = "btoa" in g;
  const prev = g.btoa;
  delete g.btoa;
  try {
    const socket = await connectThroughProxy(
      { url: proxy.url, username: "user", password: "pä" },
      new URL(target.url),
    );
    socket.destroy();
    assert.equal(proxy.seen.length, 1);
    // The non-Latin1 password must survive the Buffer fallback byte-exactly.
    assert.equal(recordedHeaders(proxy.seen[0])["proxy-authorization"], expected);
  } finally {
    if (had) g.btoa = prev;
    // `socket` is scoped to the try above, so the harness handles the only
    // receivers this finally can reach.
    await proxy.close();
    await target.close();
  }
});

await test("times out while opening the TCP connection to the proxy", async () => {
  // RFC 5737 TEST-NET-1 is reserved and never routable, so the connect hangs.
  await assert.rejects(
    () =>
      connectThroughProxy({ url: "http://192.0.2.1:8080" }, new URL("http://example.invalid/"), {
        connectTimeoutMs: 150,
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "ETIMEOUT");
      // Whether the dial or the CONNECT handshake stalls depends on how the
      // host routes TEST-NET-1, so only the failure class is asserted.
      assert.match(err.message, /proxy/i);
      return true;
    },
  );
});

await test("aborts while opening the TCP connection to the proxy", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(
    () =>
      connectThroughProxy({ url: "http://192.0.2.1:8080" }, new URL("http://example.invalid/"), {
        connectTimeoutMs: 5_000,
        signal: ac.signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EABORT");
      return true;
    },
  );
});

await test("aborts while connecting to an HTTPS proxy", async () => {
  if (!openssl) return;
  // A raw TCP listener that never speaks TLS stalls the handshake, so the
  // abort has somewhere to land. An HTTP server would answer the ClientHello
  // with 400 and close, erroring long before the abort fires.
  const stall = await startSilentPeer();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  try {
    await assert.rejects(
      () =>
        connectThroughProxy(
          { url: `https://127.0.0.1:${stall.port}` },
          new URL("http://example.invalid/"),
          { connectTimeoutMs: 5_000, signal: ac.signal, ca: ca as string },
        ),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EABORT");
        assert.equal(err.message, "Proxy connection aborted");
        return true;
      },
    );
  } finally {
    stall.close();
  }
});

await test("times out connecting to an HTTPS proxy", async () => {
  if (!openssl) return;
  const stall = await startSilentPeer();
  try {
    await assert.rejects(
      () =>
        connectThroughProxy(
          { url: `https://127.0.0.1:${stall.port}` },
          new URL("http://example.invalid/"),
          { connectTimeoutMs: 150, ca: ca as string },
        ),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        // The *dial* to the proxy, not the CONNECT handshake: the message
        // says so, and the port is the one actually dialled.
        assert.equal(err.code, "ETIMEOUT");
        assert.match(err.message, new RegExp(`^Connecting to proxy 127\\.0\\.0\\.1:${stall.port}`));
        return true;
      },
    );
  } finally {
    stall.close();
  }
});

if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });

// ── Remaining protocol edge cases ───────────────────────────────────────────

suite("CONNECT proxy — protocol edge cases");

await test("rejects an oversized CONNECT response", async () => {
  // A proxy that streams megabytes without ever terminating the head must not
  // be allowed to grow the buffer without bound.
  const held = new Set<Socket>();
  const server = createServer();
  server.on("connect", (_req: unknown, s: Socket) => {
    held.add(s);
    s.once("close", () => held.delete(s));
    s.write("X".repeat(80 * 1024));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: `http://127.0.0.1:${port}` }, new URL("http://x.invalid/")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        // The whole message: an "oversized" wording change is a doc-drift
        // break, and a message that merely mentioned the word would pass.
        assert.equal(err.message, "Proxy sent an oversized CONNECT response");
        return true;
      },
    );
  } finally {
    for (const s of held) s.destroy();
    held.clear();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

await test("rejects a malformed CONNECT status line", async () => {
  const server = createServer();
  server.on("connect", (_req: unknown, s: Socket) => {
    s.end("NOT-HTTP AT ALL\r\n\r\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: `http://127.0.0.1:${port}` }, new URL("http://x.invalid/")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        // The offending first line is quoted back, JSON-escaped.
        assert.equal(err.message, 'Proxy returned a malformed CONNECT response: "NOT-HTTP AT ALL"');
        return true;
      },
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

await test("reports a socket error raised after a successful CONNECT", async () => {
  // The tunnel is established, then the peer dies before the TLS handshake
  // finishes. That error arrives on the already-connected socket, not on the
  // dial, and must still surface as ENETWORK rather than hanging.
  const server = createServer();
  server.on("connect", (_req: unknown, s: Socket) => {
    s.write("HTTP/1.1 200 Connection established\r\n\r\n");
    setTimeout(() => s.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () =>
        connectThroughProxy(
          { url: `http://127.0.0.1:${port}` },
          new URL(`https://127.0.0.1:${port}/x`),
        ),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        // Pinned, not "ENETWORK or EABORT": the peer is destroyed with no
        // signal involved, so there is no abort to report. Accepting a
        // disjunction here would let a regression in abort handling pass.
        assert.equal(err.code, "ENETWORK");
        assert.match(err.message, /reset|ECONNRESET|EPIPE|socket/i);
        return true;
      },
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

await test("defaults the proxy port when the URL omits one", async () => {
  // `http://host` must mean port 80, not a rejected URL. Nothing listens on
  // port 80 here, so the dial fails — which is what proves the default was
  // applied and the parse succeeded.
  await assert.rejects(
    () => connectThroughProxy({ url: "http://127.0.0.1" }, new URL("http://x.invalid/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      // ENETWORK, not merely "not EVALIDATION": the URL parsed, the default
      // port 80 was applied, and the dial to it failed. Anything else means
      // the default was not what we think it is.
      assert.equal(err.code, "ENETWORK");
      assert.match(err.message, /:80|port 80/);
      assert.match(err.message, /proxy/i);
      return true;
    },
  );
});

// ── Regressions ─────────────────────────────────────────────────────────────
//
// Four defects surfaced by auditing what this file's assertions claim to
// cover against what actually happens on the wire. Every test below passed at
// the time its defect was live.

/**
 * A CONNECT proxy that answers with `head` verbatim and then relays to the
 * requested authority.
 *
 * `splitAt` writes the head in two pieces, the second after a short delay. That
 * is not artificial: TCP does not preserve write boundaries, so a proxy that
 * forwards in chunks routinely delivers the head terminator and the first
 * tunnel bytes in a single read on the client.
 */
async function startHeadProxy(
  head: string,
  opts: { relay: boolean; splitAt?: number },
): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const tunnelled = new Set<Socket>();
  const server: Server = createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, clientSocket: Socket, extra: Buffer) => {
    tunnelled.add(clientSocket);
    clientSocket.once("close", () => tunnelled.delete(clientSocket));
    seen.push(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${JSON.stringify(req.headers)}`);
    const at = opts.splitAt ?? -1;
    if (at > 0) {
      clientSocket.write(head.slice(0, at));
      setTimeout(() => clientSocket.write(head.slice(at)), 25);
    } else {
      clientSocket.write(head);
    }
    if (opts.relay) {
      const [host, port] = (req.url ?? "").split(":");
      const upstream = netConnect({ host: host ?? "", port: Number(port ?? 80) });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      if (extra.length) upstream.write(extra);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of tunnelled) s.destroy();
        tunnelled.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

suite("CONNECT proxy — regressions");

await test("delivers tunnel bytes coalesced with the CONNECT head", async () => {
  // Defect: the head reader resolved on the first chunk containing "\r\n\r\n"
  // and threw the rest of that chunk away. A relay to a target that speaks
  // first -- an SMTP/FTP greeting, or any protocol where the server greets --
  // can only deliver that banner after the tunnel exists, so it arrives
  // alongside the head, and the head reader dropped it on the floor. The
  // caller got a socket that was missing the first bytes of the conversation.
  const target = await startTarget();
  // The head terminator and the banner leave the proxy in one write.
  const proxy = await startHeadProxy(
    "HTTP/1.1 200 Connection established\r\n\r\nHELLO-FROM-TARGET\r\n",
    { relay: false, splitAt: 17 },
  );
  try {
    const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url), {
      connectTimeoutMs: 2_000,
    });
    try {
      // Collected until the peer has been quiet for 200ms, so the assertion
      // is over everything the tunnel delivered rather than over whatever had
      // arrived by the time the first banner byte showed up.
      const body = await new Promise<string>((resolve, reject) => {
        let got = "";
        const deadline = setTimeout(
          () => reject(new Error(`banner never arrived; received ${JSON.stringify(got)}`)),
          3_000,
        );
        let quiet: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          clearTimeout(deadline);
          resolve(got);
        }, 200);
        socket.on("data", (c: Buffer) => {
          got += c.toString("latin1");
          clearTimeout(quiet);
          quiet = setTimeout(() => {
            clearTimeout(deadline);
            resolve(got);
          }, 200);
        });
        socket.once("error", (e: Error) => {
          clearTimeout(deadline);
          reject(e);
        });
      });
      // Byte-exact: the banner, and nothing else. A head read one chunk too
      // few (so the banner is dropped) and one chunk too many (so the head
      // terminator leaks into the tunnelled stream) both fail here.
      assert.equal(body, "HELLO-FROM-TARGET\r\n");
    } finally {
      socket.destroy();
    }
  } finally {
    await proxy.close();
    await target.close();
  }
});

await test("treats every 2xx CONNECT status as an established tunnel", async () => {
  // Defect: only a literal 200 was accepted. RFC 9110 section 9.3.6 says any
  // 2xx switches the proxy to tunnel mode, so a proxy answering 201 or 204
  // was reported as a refusal and the request never left the machine.
  const target = await startTarget();
  try {
    for (const status of ["201 Created", "202 Accepted", "204 No Content", "299 Odd"]) {
      const proxy = await startHeadProxy(`HTTP/1.1 ${status}\r\n\r\n`, { relay: true });
      // `hits` is cumulative across the loop, so the baseline is per-iteration.
      const before = target.hits();
      try {
        const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url), {
          connectTimeoutMs: 2_000,
        });
        try {
          socket.write("GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
          const head = await readHead(socket);
          // The tunnel is not merely "accepted" -- it is usable end to end.
          assert.match(head, /^HTTP\/1\.1 200/);
          assert.match(head, /tunnelled:\/hello/);
          assert.equal(target.hits(), before + 1, `the tunnel must be usable for "${status}"`);
        } finally {
          socket.destroy();
        }
      } finally {
        await proxy.close();
      }
    }

    // And the boundary is real: 3xx is a redirect to a *different* proxy
    // target, never a tunnel, and must still be a refusal.
    const redirect = await startHeadProxy("HTTP/1.1 300 Multiple Choices\r\n\r\n", {
      relay: true,
    });
    try {
      await assert.rejects(
        () =>
          connectThroughProxy({ url: redirect.url }, new URL(target.url), {
            connectTimeoutMs: 2_000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError);
          assert.equal(err.code, "EPROXY");
          assert.ok(
            err.message.endsWith(": 300 Multiple Choices"),
            `refusal must quote the status and reason: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      await redirect.close();
    }
  } finally {
    await target.close();
  }
});

await test("times out while the TLS handshake to the target stalls", async () => {
  // Defect: the CONNECT handshake's timeout and abort listeners are torn down
  // the moment the tunnel is up, and the TLS-to-target step installed neither.
  // A peer that accepts the tunnel and then says nothing therefore hung
  // forever -- connectTimeoutMs was simply not applied to the step that
  // actually takes the time.
  const stall = await startSilentPeer();
  const proxy = await startProxy();
  const target = new URL(`https://127.0.0.1:${stall.port}/x`);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, target, { connectTimeoutMs: 300 }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "ETIMEOUT");
        // Distinguishable from the CONNECT handshake timeout, which reads
        // "did not respond to CONNECT": this one names the TLS step and its
        // own budget.
        assert.equal(
          err.message,
          `TLS handshake through proxy to ${target.hostname} did not complete within 300ms`,
        );
        return true;
      },
    );
    const ms = Date.now() - t0;
    assert.ok(ms >= 250, `gave up after ${ms}ms, before the 300ms budget expired`);
    assert.ok(ms < 5_000, `took ${ms}ms, so the timeout was not what settled it`);
  } finally {
    await proxy.close();
    stall.close();
  }
});

await test("aborts while the TLS handshake to the target stalls", async () => {
  // The same gap, for the signal: the abort reached the CONNECT (there is a
  // separate test for that) and was then dropped on the floor, so a request
  // cancelled while its tunnel was already up could not be cancelled at all.
  const stall = await startSilentPeer();
  const proxy = await startProxy();
  const target = new URL(`https://127.0.0.1:${stall.port}/x`);
  const ac = new AbortController();
  try {
    setTimeout(() => ac.abort(), 120);
    const t0 = Date.now();
    await assert.rejects(
      () =>
        connectThroughProxy({ url: proxy.url }, target, {
          connectTimeoutMs: 5_000,
          signal: ac.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        // Pinned, not "EABORT or ETIMEOUT": the budget is 5s and the abort
        // lands at 120ms, so only the abort can explain the rejection.
        assert.equal(err.code, "EABORT");
        assert.equal(err.message, "Proxy connection aborted");
        return true;
      },
    );
    assert.ok(
      Date.now() - t0 < 2_000,
      "the abort must be observed during the TLS step, not wait out the timeout",
    );
  } finally {
    await proxy.close();
    stall.close();
  }
});

// ── Final branch coverage ───────────────────────────────────────────────────

suite("CONNECT proxy — final branches");

/** Starts a proxy that accepts CONNECT and then dies without responding. */
async function startRudeProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const held = new Set<Socket>();
  // A raw TCP peer, not an http.Server: CONNECT framing detaches the socket
  // and the http layer will not propagate a mid-handshake reset reliably.
  const server = netCreateServer((s: Socket) => {
    held.add(s);
    s.once("close", () => held.delete(s));
    // A partial head proves the client is mid-handshake, then the peer dies
    // so the error lands on the handshake socket rather than on the dial.
    s.write("HTTP/1.1 200 Con");
    setTimeout(() => s.destroy(), 30);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of held) s.destroy();
        held.clear();
        const guard = setTimeout(r, 500);
        if (typeof (guard as unknown as { unref?: () => void }).unref === "function") {
          (guard as unknown as { unref: () => void }).unref();
        }
        server.close(() => {
          clearTimeout(guard);
          r();
        });
      }),
  };
}

await test("fails fast when the proxy closes mid-handshake (clean FIN)", async () => {
  // Regression: a clean close emits no `error` event, so this used to hang
  // until the 30s connect timeout expired.
  const proxy = await startRudeProxy();
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => connectThroughProxy({ url: proxy.url }, new URL("http://x.invalid/")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        assert.match(err.message, /closed the connection before answering CONNECT/);
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 5_000, "must not wait for the connect timeout");
  } finally {
    await proxy.close();
  }
});

await test("reports a proxy that resets mid-handshake", async () => {
  // Same situation, but a TCP reset rather than a clean close, so the error
  // arrives as an `error` event instead.
  const held = new Set<Socket>();
  const server = netCreateServer((s: Socket) => {
    held.add(s);
    s.once("close", () => held.delete(s));
    s.write("HTTP/1.1 200 Con");
    setTimeout(() => s.resetAndDestroy(), 30);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: `http://127.0.0.1:${port}` }, new URL("http://x.invalid/")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        // ENETWORK, and specifically the *socket* error path -- a clean FIN
        // on the same code reports EPROXY ("closed the connection before
        // answering"), so the two must not be conflated.
        assert.equal(err.code, "ENETWORK");
        assert.equal(err.message, "Proxy connection failed: read ECONNRESET");
        assert.ok(err.cause instanceof Error, "the socket error must be preserved as the cause");
        return true;
      },
    );
  } finally {
    for (const s of held) s.destroy();
    held.clear();
  }
});

await test("handles a status line with no reason phrase", async () => {
  const held = new Set<Socket>();
  const server = createServer();
  server.on("connect", (_req: unknown, s: Socket) => {
    held.add(s);
    s.once("close", () => held.delete(s));
    s.end("HTTP/1.1 403\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => connectThroughProxy({ url: `http://127.0.0.1:${port}` }, new URL("http://x.invalid/")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EPROXY");
        // The reason phrase is empty, so the composed message must not end in
        // "undefined" -- nor leave a dangling separator behind.
        assert.equal(err.message, "Proxy refused CONNECT to x.invalid:80: 403");
        assert.doesNotMatch(err.message, /undefined/);
        return true;
      },
    );
  } finally {
    for (const s of held) s.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

await test("recognises the socks5h scheme", async () => {
  await assert.rejects(
    () => connectThroughProxy({ url: "socks5h://127.0.0.1:1080" }, new URL("http://x.invalid/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "EVALIDATION");
      assert.match(err.message, /SOCKS/);
      return true;
    },
  );
});

await test("treats an omitted password as empty", async () => {
  const target = await startTarget();
  const expected = `Basic ${Buffer.from("user:").toString("base64")}`;
  const proxy = await startProxy({ expectAuth: expected });
  try {
    // `password` omitted entirely, not merely empty.
    const socket = await connectThroughProxy(
      { url: proxy.url, username: "user" },
      new URL(target.url),
    );
    socket.destroy();
    assert.equal(proxy.seen.length, 1);
    assert.equal(recordedHeaders(proxy.seen[0])["proxy-authorization"], expected);
  } finally {
    // `socket` is scoped to the try above; only the harness handles are reachable.
    await proxy.close();
    await target.close();
  }
});

await test("defaults an https proxy URL to port 443", async () => {
  // Parses fine, then fails to connect — proving the 443 default was applied
  // rather than the URL being rejected.
  await assert.rejects(
    () => connectThroughProxy({ url: "https://127.0.0.1" }, new URL("http://x.invalid/")),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "ENETWORK");
      assert.match(err.message, /:443|port 443/);
      return true;
    },
  );
});

await test("times out dialing a plain-HTTP proxy, naming the proxy", async () => {
  // The plain-TCP dial has its own timer, separate from the CONNECT handshake
  // and from the HTTPS-proxy TLS dial. The only way to exercise it is a host
  // that silently drops SYNs, so this points at an RFC1918 address: unroutable
  // on any normal network, and therefore a black hole rather than a refusal.
  // Environments that happen to route 10/8 (some CI VPCs) skip rather than
  // assert something the network, not the code, decides.
  const blackhole = "10.255.255.1";
  const reachable = await new Promise<boolean>((resolve) => {
    const s = netConnect({ host: blackhole, port: 81 });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(750, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(true));
  });

  if (reachable) {
    console.log(`  ⏭  skipped: this environment routes ${blackhole}`);
    return;
  }

  await assert.rejects(
    () =>
      connectThroughProxy({ url: `http://${blackhole}:81` }, new URL("http://x.invalid/"), {
        connectTimeoutMs: 250,
      }),
    (err: unknown) => {
      assert.ok(err instanceof KinetexError);
      assert.equal(err.code, "ETIMEOUT", "a dropped SYN must surface as a dial timeout");
      assert.match(err.message, /Connecting to proxy/);
      return true;
    },
  );
});

await test("times out dialing an HTTPS proxy, naming the proxy", async () => {
  if (!openssl) return;
  const stall = await startSilentPeer();
  try {
    await assert.rejects(
      () =>
        connectThroughProxy(
          { url: `https://127.0.0.1:${stall.port}` },
          new URL("http://x.invalid/"),
          { connectTimeoutMs: 150, ca: ca as string },
        ),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "ETIMEOUT");
        // Distinguishes the *dial* timeout from the CONNECT handshake one.
        assert.match(err.message, /Connecting to proxy/);
        return true;
      },
    );
  } finally {
    stall.close();
  }
});

// ── Transport integration ───────────────────────────────────────────────────
//
// The unit tests above cover the tunnel in isolation. These drive the real
// transport so the wiring is proven: that a `proxy` on `NodeHTTP2Transport`
// actually routes the request, and that it does so over both the HTTP/1.1
// keep-alive agent and the HTTP/2 session.
//
// Both were real bugs. `createConnection` must return a socket
// synchronously — node:http2 does not await it and https.Agent adopts a
// truthy return value — so handing either one a Promise produced a session
// built on a thenable and failed deep in the stream layer with
// "stream.pause is not a function".

suite("Transport routing through a proxy");

/** Builds a request object the transport accepts directly. */
function transportRequest(
  url: string,
  httpVersion: "HTTP/1.1" | "HTTP/2",
  signal: AbortSignal | null = null,
): never {
  return {
    url,
    method: "GET",
    headers: {},
    body: null,
    signal,
    meta: {},
    httpVersion,
  } as never;
}

/** Runs `fn` with `globalThis.fetch` removed so the Node path is forced. */
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

if (!openssl) {
  console.log("  ⏭  skipped: openssl is not available on this machine");
} else {
  await test("HTTP/1.1 request is routed through the proxy", async () => {
    // The legacy node:https path is HTTPS-only, and the tunnel hands back an
    // already-TLS-wrapped socket, so the target must be https.
    const target = await startTlsTarget();
    const proxy = await startProxy();
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url }, ca: ca as string });
    try {
      const raw = await withoutFetch(() =>
        transport.send(transportRequest(target.url, "HTTP/1.1")),
      );
      const text = raw.body ? await new Response(raw.body).text() : "";
      assert.equal(raw.status, 200);
      assert.match(text, /tls-through-proxy/);
      assert.equal(proxy.seen.length, 1, "the request must go through the proxy");
      const t = new URL(target.url);
      assert.equal(
        proxy.seen[0].split("\r\n", 1)[0],
        `CONNECT ${t.hostname}:${t.port} HTTP/1.1`,
        "the tunnel must be opened to the TARGET, not to the proxy itself",
      );
    } finally {
      transport.destroy();
      await proxy.close();
      await target.close();
    }
  });

  await test("HTTP/2 request opens its session through the proxy tunnel", async () => {
    const target = await startTlsTarget();
    const proxy = await startProxy();
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url }, ca: ca as string });
    try {
      // The target is an https (not h2) server, so the session cannot be
      // established — what matters is that the tunnel was opened first and
      // that the failure is not the thenable-socket crash.
      await assert.rejects(
        () => transport.send(transportRequest(target.url, "HTTP/2")),
        (err: unknown) => {
          // The old predicate was `assert.ok(!(err instanceof Error) || !/…/)`,
          // which is true for every error ever thrown. Pin what actually
          // happens: the tunnel opens, the socket reaches node:http2 as a
          // real TLSSocket, and the failure is the expected ALPN mismatch
          // against a non-h2 origin.
          assert.ok(err instanceof KinetexError, `unexpected rejection: ${String(err)}`);
          assert.equal(err.code, "ENETWORK");
          assert.ok(
            !/stream\.pause is not a function/.test(err.message),
            "createConnection must not hand node:http2 a promise",
          );
          assert.match(err.message, /protocol|negotiat|alpn|http2/i);
          return true;
        },
      );
      assert.equal(proxy.seen.length, 1, "http2 must open its session via the tunnel");
      assert.ok(
        proxy.seen[0].startsWith("CONNECT "),
        `the session must be dialled with CONNECT, got ${proxy.seen[0]}`,
      );
    } finally {
      transport.destroy();
      await proxy.close();
      await target.close();
    }
  });

  await test("a proxied request with no ca and no signal still uses the tunnel", async () => {
    // The mirror of the two tests above: with neither `ca` nor a request signal
    // configured, the agent and the dial must both be built from defaults. A
    // tunnel must still be attempted rather than short-circuiting.
    const proxy = await startProxy({ status: "HTTP/1.1 403 Forbidden" });
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url } });
    try {
      await withoutFetch(async () => {
        await assert.rejects(
          () => transport.send(transportRequest("https://127.0.0.1:1/echo", "HTTP/1.1")),
          (err: unknown) => {
            assert.ok(err instanceof KinetexError);
            assert.equal(err.code, "EPROXY");
            return true;
          },
        );
      });
      assert.equal(proxy.seen.length, 1, "the tunnel must still have been attempted");
      assert.equal(
        (transport as unknown as { _proxy: { url: string } })._proxy.url,
        proxy.url,
        "the transport must still hold the proxy url it was given",
      );
      const agent = (transport as unknown as { _http1Agent?: { options: { ca?: string } } })
        ._http1Agent;
      assert.ok(agent, "the agent must be built even without a ca");
      assert.equal(agent.options.ca, undefined, "no ca must not be invented");
    } finally {
      transport.destroy();
      await proxy.close();
    }
  });

  await test("the proxied HTTP/1.1 agent is built with the configured ca", async () => {
    // The agent is constructed before the tunnel exists, and it is the agent
    // that hands the socket to node:https. If `ca` is missing from the agent,
    // a pooled socket is created without the trust override and only fails on
    // reuse — so the override has to be on the agent, not just the request.
    const target = await startTlsTarget();
    const proxy = await startProxy();
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url }, ca: ca as string });
    try {
      const raw = await withoutFetch(() =>
        transport.send(transportRequest(target.url, "HTTP/1.1")),
      );
      const text = raw.body ? await new Response(raw.body).text() : "";
      assert.equal(raw.status, 200);

      const agent = (transport as unknown as { _http1Agent: { options: { ca?: string } } })
        ._http1Agent;
      assert.ok(agent, "the keep-alive agent must have been created");
      assert.equal(
        agent.options.ca,
        ca,
        "the agent must carry the ca, or pooled sockets fail on reuse",
      );
      assert.match(text, /tls-through-proxy/);
    } finally {
      transport.destroy();
      await proxy.close();
      await target.close();
    }
  });

  await test("a request-scoped signal is threaded into the proxy dial", async () => {
    // The tunnel is opened before the transport hands the socket over, so an
    // abort that lands during the dial has to reach the CONNECT, not just the
    // stream that was never created.
    //
    // The old version of this test asserted `ac.signal.aborted === true`,
    // which the test itself had just made true by calling `ac.abort()` and
    // which said nothing whatsoever about the dial. Here the proxy accepts
    // CONNECT and never answers, so the connect would sit for the full
    // 30s default budget unless the abort reaches it: a prompt EABORT is
    // therefore proof that the signal crossed into `connectThroughProxy`.
    const target = await startTlsTarget();
    const proxy = await startProxy({ hang: true });
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url }, ca: ca as string });
    const ac = new AbortController();
    try {
      const t0 = Date.now();
      const pending = withoutFetch(() =>
        transport.send(transportRequest(target.url, "HTTP/1.1", ac.signal)),
      );
      setTimeout(() => ac.abort(), 60);
      await assert.rejects(
        () => pending,
        (err: unknown) => {
          assert.ok(err instanceof KinetexError, `unexpected rejection: ${String(err)}`);
          assert.equal(err.code, "EABORT");
          return true;
        },
      );
      assert.ok(
        Date.now() - t0 < 5_000,
        "the abort must reach the CONNECT, not wait out the 30s connect timeout",
      );
      assert.equal(ac.signal.aborted, true);
    } finally {
      transport.destroy();
      await proxy.close();
      await target.close();
    }
  });

  await test("a refused proxy surfaces EPROXY to the caller", async () => {
    const target = await startTlsTarget();
    const proxy = await startProxy({ status: "HTTP/1.1 403 Forbidden" });
    const transport = new NodeHTTP2Transport({ proxy: { url: proxy.url }, ca: ca as string });
    try {
      await withoutFetch(async () => {
        await assert.rejects(
          () => transport.send(transportRequest(target.url, "HTTP/1.1")),
          (err: unknown) => {
            assert.ok(err instanceof KinetexError);
            assert.equal(err.code, "EPROXY");
            // The status the proxy refused with must survive the transport
            // hop -- a caller debugging a 403 through a proxy needs to see it.
            assert.match(err.message, /403/);
            return true;
          },
        );
      });
    } finally {
      transport.destroy();
      await proxy.close();
      await target.close();
    }
  });
}

await test("a client-level proxy reaches the transport", async () => {
  const d = { url: "http://127.0.0.1:1" };
  const client = new Kinetex({ baseURL: "https://example.invalid", proxy: d });
  try {
    const transport = (client as unknown as { transport: unknown }).transport;
    assert.ok(transport instanceof NodeHTTP2Transport);
    assert.deepEqual(
      (transport as unknown as { _proxy: unknown })._proxy,
      d,
      "the proxy must reach the transport, not be dropped",
    );
  } finally {
    client.destroy();
  }
});

await test("a per-request proxy is refused with an accurate reason", async () => {
  const client = new Kinetex({ baseURL: "https://example.invalid" });
  try {
    await assert.rejects(
      () => client.get("/x", { proxy: { url: "http://127.0.0.1:1" } }),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EVALIDATION");
        assert.match(err.message, /per-request/);
        return true;
      },
    );
  } finally {
    client.destroy();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err);
  }
  process.exit(1);
}
process.exit(0);
