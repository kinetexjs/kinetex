import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { createServer, Server } from "node:net";
import {
  parseSocks5Url,
  createSocks5Tunnel,
  Socks5Error,
  nodeTcpConnector,
  socks5Connector,
  denoTcpConnector,
} from "../src/mod.ts";
import type { Socks5ProxyConfig, Socks5Tunnel, TcpConnector } from "../src/socks5.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

/**
 * Assert that a value is a usable `Socks5Tunnel`.
 *
 * These tests used `assert.notStrictEqual(tunnel.conn, undefined)`, which any
 * object satisfies — including one with no `read`, no `write`, or a `conn`
 * that is a string. The contract the rest of the file then depends on is that
 * `conn` is a working TcpConn and that `boundAddr`/`boundPort` are the types
 * the interface promises, so that is what gets checked.
 */
function assertTunnel(t: unknown, note: string): asserts t is Socks5Tunnel {
  assert.ok(t !== null && typeof t === "object", `${note}: a tunnel object is returned`);
  const tun = t as Socks5Tunnel;
  assert.ok(tun.conn !== null && typeof tun.conn === "object", `${note}: conn is a TcpConn`);
  assert.strictEqual(typeof tun.conn.read, "function", `${note}: conn.read`);
  assert.strictEqual(typeof tun.conn.write, "function", `${note}: conn.write`);
  assert.strictEqual(typeof tun.conn.close, "function", `${note}: conn.close`);
  assert.strictEqual(typeof tun.boundAddr, "string", `${note}: boundAddr is a string`);
  assert.strictEqual(typeof tun.boundPort, "number", `${note}: boundPort is a number`);
  assert.ok(Number.isInteger(tun.boundPort), `${note}: boundPort is an integer`);
  assert.ok(tun.boundPort >= 0 && tun.boundPort <= 65535, `${note}: boundPort is in range`);
}

/** Assert that `p` rejects with a Socks5Error carrying `code`. */
function assertFailsWithCode(
  p: Promise<unknown>,
  code: string,
  note: string,
  retriable?: boolean,
): Promise<Socks5Error> {
  return p.then(
    (v) => {
      throw new Error(`${note}: expected ${code}, but it resolved with ${String(v)}`);
    },
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `${note}: expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, code, `${note}: error code`);
      if (retriable !== undefined) {
        assert.strictEqual(err.retriable, retriable, `${note}: retriable`);
      }
      return err;
    },
  );
}

// ── Embedded SOCKS5 proxy (always requires auth) ──────────────────────────

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 1080;
const PROXY_USERNAME = "testuser";
const PROXY_PASSWORD = "testpass";

let proxyProcess: ChildProcess | null = null;

async function startProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
    // A startup that never completes must fail the suite loudly instead of
    // hanging it: before this, a child that started but never printed its
    // readiness line left the promise pending forever, and the run produced
    // no output and no failing test at all.
    const timer = setTimeout(() => {
      reject(
        new Error(
          `embedded SOCKS5 proxy did not become ready on ${PROXY_HOST}:${PROXY_PORT} within 10s`,
        ),
      );
    }, 10_000);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    proxyProcess = spawn(
      process.execPath,
      [
        "-e",
        `
        const net = require('net');
        const USERNAME = "${PROXY_USERNAME}";
        const PASSWORD = "${PROXY_PASSWORD}";
        const PORT = ${PROXY_PORT};

        const server = net.createServer((client) => {
          let buf = Buffer.alloc(0);
          let state = "greeting";

          function handleData(chunk) {
            buf = Buffer.concat([buf, chunk]);

            if (state === "greeting") {
              if (buf.length < 2) return;
              const nMethods = buf[1];
              if (buf.length < 2 + nMethods) return;
              const methods = buf.slice(2, 2 + nMethods);
              const hasAuth = methods.includes(2);
              if (hasAuth) {
                client.write(Buffer.from([5, 2]));
              } else {
                client.write(Buffer.from([5, 255]));
                client.end();
                return;
              }
              buf = buf.slice(2 + nMethods);
              state = "auth";
            }

            if (state === "auth") {
              if (buf.length < 2) return;
              const uLen = buf[1];
              if (buf.length < 2 + uLen + 1) return;
              const pLen = buf[2 + uLen];
              if (buf.length < 3 + uLen + pLen) return;
              const username = buf.slice(2, 2 + uLen).toString();
              const password = buf.slice(3 + uLen, 3 + uLen + pLen).toString();
              const ok = username === USERNAME && password === PASSWORD;
              client.write(Buffer.from([1, ok ? 0 : 1]));
              buf = buf.slice(3 + uLen + pLen);
              state = "request";
              if (!ok) { client.end(); return; }
            }

            if (state === "request") {
              if (buf.length < 4) return;
              const atyp = buf[3];
              let needed = 0;
              if (atyp === 1) needed = 10;
              else if (atyp === 3) needed = 5 + buf[4] + 2;
              else if (atyp === 4) needed = 22;
              else {
                client.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
                client.end();
                return;
              }
              if (buf.length < needed) return;

              let host, port;
              if (atyp === 1) {
                host = buf[4] + "." + buf[5] + "." + buf[6] + "." + buf[7];
                port = buf.readUInt16BE(8);
              } else if (atyp === 3) {
                host = buf.slice(5, 5 + buf[4]).toString();
                port = buf.readUInt16BE(5 + buf[4]);
              } else {
                host = buf.slice(4, 20).toString("hex");
                port = buf.readUInt16BE(20);
              }

              const target = net.createConnection({ host, port });
              target.on("connect", () => {
                client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                if (buf.length > needed) {
                  target.write(buf.slice(needed));
                }
                buf = Buffer.alloc(0);
                client.removeAllListeners("data");
                client.on("data", (d) => target.write(d));
                target.on("data", (d) => client.write(d));
                client.on("end", () => target.end());
                target.on("end", () => client.end());
              });
              target.on("error", () => {
                client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
                client.end();
              });
              state = "relay";
            }
          }

          client.on("data", handleData);
          client.on("error", () => {});
        });
        server.listen(PORT, "127.0.0.1", () => {
          console.log("EMBEDDED_PROXY_READY");
        });
        `,
      ],
      { stdio: ["inherit", "pipe", "pipe"] },
    );

    proxyProcess.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("EMBEDDED_PROXY_READY")) settle(resolve);
    });

    proxyProcess.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString();
      if (msg.includes("EADDRINUSE")) {
        // Resolving here is what the suite has always done, and it is why
        // every test below would quietly run against whatever else is holding
        // 1080. Say so rather than letting the failures look mysterious.
        console.warn(
          `  ⚠️  ${PROXY_HOST}:${PROXY_PORT} was already in use (EADDRINUSE); ` +
            `the auth-dependent tests may run against a different process.`,
        );
        settle(resolve);
      }
    });

    proxyProcess.on("error", (e) => settle(() => reject(e)));
    proxyProcess.on("exit", (code) =>
      settle(() => reject(new Error(`embedded SOCKS5 proxy exited early with code ${code}`))),
    );
  });
}

function stopProxy(): void {
  if (proxyProcess) {
    proxyProcess.kill("SIGTERM");
    proxyProcess = null;
  }
}

// ── Malicious TCP server for protocol edge-case tests ─────────────────────

function createMockServer(
  behavior:
    | "bad-version"
    | "unsupported-method"
    | "bad-auth-version"
    | "ipv6-bound"
    | "conn-refused-after-auth"
    | "domain-bound"
    | "bad-reply-version"
    | "unknown-reply",
): Server {
  return createServer((socket) => {
    let buf = Buffer.alloc(0);
    let state: "greeting" | "auth" | "request" = "greeting";

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (state === "greeting") {
        if (buf.length < 2) return;
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;

        if (behavior === "bad-version") {
          socket.write(Buffer.from([0x04, 0x00]));
          socket.end();
          return;
        }
        if (behavior === "unsupported-method") {
          socket.write(Buffer.from([0x05, 0x01]));
          socket.end();
          return;
        }

        // Normal: reply with auth required
        socket.write(Buffer.from([0x05, 0x02]));
        buf = buf.slice(2 + nMethods);
        state = "auth";
      }

      if (state === "auth") {
        if (buf.length < 2) return;
        const uLen = buf[1];
        if (buf.length < 2 + uLen + 1) return;
        const pLen = buf[2 + uLen];
        if (buf.length < 3 + uLen + pLen) return;

        if (behavior === "bad-auth-version") {
          socket.write(Buffer.from([0x03, 0x00]));
          socket.end();
          return;
        }

        // Normal: auth success
        socket.write(Buffer.from([0x01, 0x00]));
        buf = buf.slice(3 + uLen + pLen);
        state = "request";
      }

      if (state === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let needed = 0;
        if (atyp === 1) needed = 10;
        else if (atyp === 3) needed = 5 + buf[4] + 2;
        else if (atyp === 4) needed = 22;
        else {
          socket.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }
        if (buf.length < needed) return;

        if (behavior === "ipv6-bound") {
          const ipv6Addr = Buffer.alloc(16);
          ipv6Addr.fill(0);
          ipv6Addr[15] = 1;
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x04]),
              ipv6Addr,
              Buffer.from([0x00, 0x50]),
            ]),
          );
          socket.on("data", () => {});
          return;
        }

        if (behavior === "conn-refused-after-auth") {
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        if (behavior === "bad-reply-version") {
          // The greeting was fine; the CONNECT *reply* carries a bogus version.
          socket.write(Buffer.from([0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        if (behavior === "unknown-reply") {
          // 0x63 is not a reply code this module has a message for.
          socket.write(Buffer.from([0x05, 0x63, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        if (behavior === "domain-bound") {
          // A proxy is allowed to report the bound address as a domain name.
          const name = Buffer.from("gateway.internal", "utf8");
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x03, name.length]),
              name,
              Buffer.from([0x1f, 0x90]),
            ]),
          );
          socket.on("data", () => {});
          return;
        }

        buf = buf.slice(needed);
        state = "request";
      }
    });

    socket.on("error", () => {});
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as import("node:net").AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// ── parseSocks5Url ──────────────────────────────────────────────────────

suite("parseSocks5Url");

await test("basic socks5://host", () => {
  const c = parseSocks5Url("socks5://proxy.example.com");
  assert.strictEqual(c.host, "proxy.example.com");
  assert.strictEqual(c.port, 1080);
  assert.strictEqual(c.remoteDns, false);
});

await test("socks5h:// with remote DNS", () => {
  const c = parseSocks5Url("socks5h://proxy.example.com");
  assert.strictEqual(c.remoteDns, true);
});

await test("with custom port", () => {
  const c = parseSocks5Url("socks5://proxy.example.com:3128");
  assert.strictEqual(c.port, 3128);
});

await test("with username and password", () => {
  const c = parseSocks5Url("socks5://user:pass@proxy.example.com");
  assert.strictEqual(c.username, "user");
  assert.strictEqual(c.password, "pass");
});

await test("with encoded credentials", () => {
  const c = parseSocks5Url("socks5://user%40domain:pass%23@proxy.example.com");
  assert.strictEqual(c.username, "user@domain");
  assert.strictEqual(c.password, "pass#");
});

await test("socks5h with auth+port", () => {
  const c = parseSocks5Url("socks5h://u:p@host:3128");
  assert.strictEqual(c.port, 3128);
  assert.strictEqual(c.remoteDns, true);
  assert.strictEqual(c.username, "u");
});

await test("throws SOCKS5_BAD_SCHEME for http://", () => {
  assert.throws(
    () => parseSocks5Url("http://proxy.example.com"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_SCHEME", "code");
      assert.strictEqual(err.retriable, false, "a bad scheme is not retriable");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for malformed URL", () => {
  assert.throws(
    () => parseSocks5Url("://invalid"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for empty host", () => {
  assert.throws(
    () => parseSocks5Url("socks5://:1080"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for totally invalid string", () => {
  assert.throws(
    () => parseSocks5Url("not a url"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for invalid port", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:abc"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for port out of range (0)", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:0"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

await test("throws SOCKS5_BAD_URL for port out of range (99999)", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:99999"),
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
      return true;
    },
  );
});

// ── Socks5Error ─────────────────────────────────────────────────────────

suite("Socks5Error");

await test("has name Socks5Error", () => {
  assert.strictEqual(new Socks5Error("msg", "CODE").name, "Socks5Error");
});

await test("has code property", () => {
  assert.strictEqual(new Socks5Error("msg", "CODE").code, "CODE");
});

await test("has retriable property", () => {
  assert.strictEqual(new Socks5Error("msg", "CODE", true).retriable, true);
  assert.strictEqual(new Socks5Error("msg", "CODE", false).retriable, false);
});

await test("default retriable is false", () => {
  assert.strictEqual(new Socks5Error("msg", "CODE").retriable, false);
});

await test("extends Error", () => {
  assert.strictEqual(new Socks5Error("msg", "CODE") instanceof Error, true);
});

// ── socks5Connector ─────────────────────────────────────────────────────

suite("socks5Connector");

await test("returns a TcpConnector function", () => {
  const fn = socks5Connector({ host: "127.0.0.1" }, async () => {
    throw new Error();
  });
  assert.strictEqual(typeof fn, "function");
});

await test("throws on connection failure", async () => {
  const fn = socks5Connector(
    { host: "127.0.0.1", port: 1, connectTimeoutMs: 1000, maxRetries: 0 },
    nodeTcpConnector,
  );
  // A refused dial must surface as a Socks5Error, not as a bare ECONNREFUSED
  // from node:net: the whole point of the wrapper is one error vocabulary. A
  // raw node error used to pass this test, because it was `assert.rejects`
  // with no predicate at all.
  const err = await assertFailsWithCode(
    fn("example.com", 80, 500),
    "SOCKS5_CONNECT_FAILED",
    "connection failure through the wrapper",
    true,
  );
  assert.ok(
    err.message.includes("127.0.0.1:1"),
    `the message names the PROXY, not the target: ${err.message}`,
  );
});

// ── nodeTcpConnector ────────────────────────────────────────────────────

suite("nodeTcpConnector");

await test("returns a promise", async () => {
  const p = nodeTcpConnector("localhost", 80, 1000);
  assert.strictEqual(typeof p.then, "function");
  // The floating promise is asserted, not silenced: this dials a port nothing
  // listens on, so it must reject rather than hang or resolve with a socket
  // that was never connected. `.catch(() => {})` proved neither.
  await assert.rejects(
    () => p,
    (err: unknown) => {
      assert.ok(err instanceof Error, "a refused dial must reject with an Error");
      return true;
    },
  );
});

await test("a refused proxy dial is retried, an unresolvable one is not", async () => {
  // `withRetry` only retries an error that is a Socks5Error with `retriable`
  // set. A dial refusal used to escape as a raw node:net Error, so it was
  // never retried — the one failure most worth retrying was the one failure
  // the exponential backoff in this module never saw. Counted here rather
  // than inferred from a duration, and the non-retriable case is counted too,
  // so a wrapper that simply always retried would fail this.
  let dials = 0;
  const counting = socks5Connector(
    { host: "127.0.0.1", port: 1, maxRetries: 2, retryDelayMs: 1, connectTimeoutMs: 500 },
    async () => {
      dials++;
      const err = new Error("connect ECONNREFUSED 127.0.0.1:1") as Error & { code: string };
      err.code = "ECONNREFUSED";
      throw err;
    },
  );
  await assert.rejects(() => counting("example.com", 80, 500));
  assert.strictEqual(dials, 3, "one initial attempt plus maxRetries=2");

  let dials2 = 0;
  const nonRetriable = socks5Connector(
    { host: "127.0.0.1", port: 1, maxRetries: 2, retryDelayMs: 1, connectTimeoutMs: 500 },
    async () => {
      dials2++;
      const err = new Error("getaddrinfo ENOTFOUND proxy.invalid") as Error & {
        code: string;
      };
      err.code = "ENOTFOUND";
      throw err;
    },
  );
  const e2 = await assertFailsWithCode(
    nonRetriable("example.com", 80, 500),
    "SOCKS5_CONNECT_FAILED",
    "an unresolvable proxy hostname",
    false,
  );
  assert.ok(e2.message.includes("ENOTFOUND"), "the underlying cause is preserved");
  assert.strictEqual(dials2, 1, "a name that does not resolve is not retried");
});

await test("connection refused throws", async () => {
  // The proxy port is refused, so this is pinned exactly. `maxRetries: 0`
  // keeps it to a single dial — the retry behaviour is asserted
  // separately below, where it is counted rather than inferred from a
  // duration.
  const refused = await assertFailsWithCode(
    createSocks5Tunnel(
      { host: "127.0.0.1", port: 1, connectTimeoutMs: 3000, maxRetries: 0 },
      { host: "httpbin.org", port: 80 },
      nodeTcpConnector,
    ),
    "SOCKS5_CONNECT_FAILED",
    "connection refused",
    true,
  );
  assert.ok(
    !refused.message.includes("httpbin.org"),
    `the message names the PROXY, never the target: ${refused.message}`,
  );
});

// ── denoTcpConnector ────────────────────────────────────────────────────

suite("denoTcpConnector");

await test("is exported as function", () => {
  assert.strictEqual(typeof denoTcpConnector, "function");
});

// denoTcpConnector reads globalThis.Deno at call time, so the whole body is
// exercisable under Node by stubbing the global. Without these the Deno-only
// connector shipped with no behavioural coverage at all.
type FakeDenoConn = {
  read: (buf: Uint8Array) => Promise<number | null>;
  write: (data: Uint8Array) => Promise<number>;
  close: () => void;
};

/**
 * Install a stub `globalThis.Deno.connect` for the duration of `fn`.
 * Restores the previous value (or deletes the key) afterwards.
 */
async function withFakeDeno<T>(
  connect: (opts: { hostname: string; port: number; transport: string }) => Promise<FakeDenoConn>,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const had = "Deno" in g;
  const prev = g.Deno;
  g.Deno = { connect };
  try {
    return await fn();
  } finally {
    if (had) g.Deno = prev;
    else delete g.Deno;
  }
}

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

await test("passes hostname, port and tcp transport to Deno.connect", async () => {
  let seen: { hostname: string; port: number; transport: string } | null = null;
  await withFakeDeno(
    async (opts) => {
      seen = opts;
      return { read: async () => null, write: async () => 0, close: () => {} };
    },
    async () => {
      await denoTcpConnector("proxy.internal", 1080, 1000);
    },
  );
  assert.deepStrictEqual(seen, { hostname: "proxy.internal", port: 1080, transport: "tcp" });
});

await test("read returns the byte count from the underlying conn", async () => {
  const conn = await withFakeDeno(
    async () => ({ read: async () => 7, write: async () => 0, close: () => {} }),
    () => denoTcpConnector("h", 1, 1000),
  );
  assert.strictEqual(await conn.read(new Uint8Array(16)), 7);
});

await test("read yields null at EOF (underlying read resolves null)", async () => {
  const conn = await withFakeDeno(
    async () => ({ read: async () => null, write: async () => 0, close: () => {} }),
    () => denoTcpConnector("h", 1, 1000),
  );
  assert.strictEqual(await conn.read(new Uint8Array(16)), null);
});

await test("a failing read resolves to null instead of rejecting", async () => {
  // Deno's conn.read() rejects on a torn socket; the connector must degrade to
  // EOF (null) so the SOCKS5 loop treats it as a closed tunnel.
  const conn = await withFakeDeno(
    async () => ({
      read: async () => {
        throw new Error("connection reset");
      },
      write: async () => 0,
      close: () => {},
    }),
    () => denoTcpConnector("h", 1, 1000),
  );
  assert.strictEqual(await conn.read(new Uint8Array(16)), null);
});

await test("write delegates to the underlying conn and returns its count", async () => {
  let written: Uint8Array | null = null;
  const conn = await withFakeDeno(
    async () => ({
      read: async () => null,
      write: async (d: Uint8Array) => {
        written = d;
        return d.length;
      },
      close: () => {},
    }),
    () => denoTcpConnector("h", 1, 1000),
  );
  const payload = new Uint8Array([5, 1, 0]);
  assert.strictEqual(await conn.write(payload), 3);
  assert.deepStrictEqual(written, payload);
});

await test("close delegates to the underlying conn", async () => {
  let closed = 0;
  const conn = await withFakeDeno(
    async () => ({ read: async () => null, write: async () => 0, close: () => void closed++ }),
    () => denoTcpConnector("h", 1, 1000),
  );
  conn.close();
  assert.strictEqual(closed, 1);
});

await test("close swallows an error thrown by the underlying conn", async () => {
  const conn = await withFakeDeno(
    async () => ({
      read: async () => null,
      write: async () => 0,
      close: () => {
        throw new Error("already closed");
      },
    }),
    () => denoTcpConnector("h", 1, 1000),
  );
  // Must not throw: close() is documented as idempotent and safe to call
  // twice. Stated explicitly so a synchronous throw is distinguishable from a
  // silently-skipped close.
  assert.doesNotThrow(() => conn.close());
  assert.doesNotThrow(() => conn.close());
});

await test("a connect failure propagates the underlying error unchanged", async () => {
  await withFakeDeno(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      await assert.rejects(
        () => denoTcpConnector("h", 1, 1000),
        (err: any) => err.message === "ECONNREFUSED" && !(err instanceof Socks5Error),
      );
    },
  );
});

await test("connect timeout raises a retriable SOCKS5_TIMEOUT", async () => {
  await withFakeDeno(
    () => never<Promise<FakeDenoConn>>(),
    async () => {
      await assert.rejects(
        () => denoTcpConnector("h", 1, 20),
        (err: any) => {
          assert.strictEqual(err instanceof Socks5Error, true);
          assert.strictEqual(err.code, "SOCKS5_TIMEOUT");
          assert.strictEqual(err.retriable, true);
          assert.strictEqual(err.message, "TCP connect to proxy timed out");
          return true;
        },
      );
    },
  );
});

await test("read timeout raises a retriable SOCKS5_TIMEOUT", async () => {
  const conn = await withFakeDeno(
    async () => ({ read: () => never<number | null>(), write: async () => 0, close: () => {} }),
    () => denoTcpConnector("h", 1, 20),
  );
  await assert.rejects(
    () => conn.read(new Uint8Array(8)),
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_TIMEOUT");
      assert.strictEqual(err.retriable, true);
      assert.strictEqual(err.message, "TCP read timed out");
      return true;
    },
  );
});

await test("timeoutMs of 0 disables the connect timeout", async () => {
  // Proves the timeout really is skipped rather than merely generous: the
  // connect resolves well after any plausible timeout, and still succeeds.
  const started = Date.now();
  const conn = await withFakeDeno(
    async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { read: async () => null, write: async () => 0, close: () => {} };
    },
    () => denoTcpConnector("h", 1, 0),
  );
  assert.ok(Date.now() - started >= 35, "connect must actually have waited");
  assert.strictEqual(typeof conn.read, "function");
});

await test("timeoutMs of 0 disables the read timeout", async () => {
  const conn = await withFakeDeno(
    async () => ({
      read: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return 5;
      },
      write: async () => 0,
      close: () => {},
    }),
    () => denoTcpConnector("h", 1, 0),
  );
  assert.strictEqual(await conn.read(new Uint8Array(8)), 5);
});

await test("a settled operation leaves no pending timeout timer", async () => {
  // The timers used to be created per read and never cleared, which kept a
  // closure (and the Deno event loop) alive for the full timeout window. If the
  // clearTimeout were removed this read would still pass, so assert on the
  // observable consequence: nothing must still be scheduled afterwards.
  const conn = await withFakeDeno(
    async () => ({ read: async () => 3, write: async () => 0, close: () => {} }),
    () => denoTcpConnector("h", 1, 50_000),
  );
  await conn.read(new Uint8Array(8));
  const handles = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.();
  // Not `if (Array.isArray(handles))`: that made the whole test a no-op
  // wherever the introspection is unavailable, so a reintroduced timer leak
  // would pass silently. Failing is the right answer — if this ever cannot
  // be observed here, the test needs a different mechanism, not a skip.
  assert.ok(
    Array.isArray(handles),
    "this test needs process._getActiveHandles to observe pending timers",
  );
  const longTimers = (handles as unknown[]).filter(
    (h) => h && (h as { _idleTimeout?: number })._idleTimeout === 50_000,
  );
  assert.deepStrictEqual(
    longTimers,
    [],
    "the 50s timeout timer must be cleared once the read settles",
  );
});

// ── Timeout behavior ────────────────────────────────────────────────────

suite("Timeout behavior");

await test("connection timeout throws SOCKS5_TIMEOUT", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        { host: "10.255.255.1", connectTimeoutMs: 500, handshakeTimeoutMs: 500 },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => err.code === "SOCKS5_TIMEOUT",
  );
});

// ── Protocol edge-case tests ────────────────────────────────────────────

suite("Protocol edge cases");

await test("bad SOCKS version in method response throws", async () => {
  const port = await getFreePort();
  const server = createMockServer("bad-version");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        { host: "127.0.0.1", port, connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_BAD_VERSION");
      return true;
    },
  );

  server.close();
});

await test("unsupported auth method throws", async () => {
  const port = await getFreePort();
  const server = createMockServer("unsupported-method");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        { host: "127.0.0.1", port, connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_UNSUPPORTED_METHOD");
      return true;
    },
  );

  server.close();
});

await test("bad auth sub-negotiation version throws", async () => {
  const port = await getFreePort();
  const server = createMockServer("bad-auth-version");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u",
          password: "p",
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_BAD_AUTH_VERSION");
      return true;
    },
  );

  server.close();
});

await test("IPv6 bound address in reply is decoded", async () => {
  const port = await getFreePort();
  const server = createMockServer("ipv6-bound");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const tunnel = await createSocks5Tunnel(
    {
      host: "127.0.0.1",
      port,
      username: "u",
      password: "p",
      connectTimeoutMs: 5000,
      handshakeTimeoutMs: 5000,
    },
    { host: "example.com", port: 80 },
    nodeTcpConnector,
  );
  // `includes(":")` is satisfied by any string with a colon in it. The mock
  // binds ::1, so the decoded form is checked exactly: sixteen bytes read as
  // eight big-endian hextets, the last of which is 1.
  assert.strictEqual(
    tunnel.boundAddr,
    "0:0:0:0:0:0:0:1",
    "the 16 bound bytes decoded as eight hextets",
  );
  tunnel.conn.close();
  server.close();
});

await test("proxy reply error with connection refused code", async () => {
  const port = await getFreePort();
  const server = createMockServer("conn-refused-after-auth");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u",
          password: "p",
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_REPLY_5");
      assert.strictEqual(err.retriable, false);
      return true;
    },
  );

  server.close();
});

await test("only username without password does not trigger auth", async () => {
  const port = await getFreePort();
  let receivedMethods: number[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const nMethods = data[1];
      receivedMethods = Array.from(data.slice(2, 2 + nMethods));
      // Reply no-auth
      socket.write(Buffer.from([5, 0]));
      // Then reply success to CONNECT
      socket.once("data", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.on("data", () => {});
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const tunnel = await createSocks5Tunnel(
    {
      host: "127.0.0.1",
      port,
      username: "onlyuser",
      connectTimeoutMs: 5000,
      handshakeTimeoutMs: 5000,
    },
    { host: "example.com", port: 80 },
    nodeTcpConnector,
  );
  // Should have offered NoAuth only (method 0), not UserPassword (method 2)
  assert.strictEqual(receivedMethods.includes(2), false);
  tunnel.conn.close();
  server.close();
});

// ── Regression suite (self-contained: no network, no embedded proxy) ────
// Every case here drives a recording connector or a local listener, so none
// of them depends on httpbin.org or on the spawned proxy above.

suite("regression: address encoding, URL parsing, timeouts");

/**
 * Drive a full handshake against a scripted connector and return the bytes
 * of the CONNECT request that went on the wire.
 */
async function connectRequestFor(targetHost: string): Promise<{
  atyp: number;
  addr: Buffer;
  port: number;
}> {
  const writes: Buffer[] = [];
  const scripted: import("../src/mod.ts").TcpConnector = async () => {
    let step = 0;
    const replies = [
      Buffer.from([5, 0]), // NoAuth accepted
      Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]), // CONNECT succeeded
    ];
    return {
      read: async (b: Uint8Array) => {
        const next = replies[step++];
        if (!next) return null;
        b.set(next.subarray(0, Math.min(next.length, b.length)));
        return Math.min(next.length, b.length);
      },
      write: async (d: Uint8Array) => {
        writes.push(Buffer.from(d));
        return d.length;
      },
      close: () => {},
    };
  };
  const tunnel = await createSocks5Tunnel(
    {
      host: "proxy.invalid",
      port: 1080,
      connectTimeoutMs: 2000,
      handshakeTimeoutMs: 2000,
      maxRetries: 0,
    },
    { host: targetHost, port: 80 },
    scripted,
  );
  tunnel.conn.close();
  const all = Buffer.concat(writes);
  const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
  assert.ok(i !== -1, "a CONNECT request was sent");
  const atyp = all[i + 3]!;
  const len = atyp === 0x04 ? 16 : atyp === 0x01 ? 4 : all[i + 4]! + 1;
  return {
    atyp,
    addr: all.subarray(i + 4, i + 4 + len),
    port: all.subarray(i + 4 + len, i + 6 + len).readUInt16BE(0),
  };
}

await test("regression: a colon-bearing hostname is never encoded as an IPv6 literal", async () => {
  // `isIPv6` was `s.includes(":")`, so `g:h:i:j:k:l:m:n` was taken for an IPv6
  // literal. Its eight groups were all `NaN`, and every comparison with NaN is
  // false — so all eight passed the `g < 0 || g > 0xffff` range check, and
  // `NaN >> 8 & 0xff` is 0. The request went out as ATYP=IPv4-family 0x04
  // with sixteen ZERO bytes, the proxy connected to the unspecified address
  // `::`, and `createSocks5Tunnel` RESOLVED. A tunnel to the wrong place, with
  // no error anywhere — the worst possible outcome for a proxy.
  for (const host of [
    "g:h:i:j:k:l:m:n",
    "zz:yy:xx:ww:vv:uu:tt:ss",
    "not:an:ipv6:address:at:all:here:either",
  ]) {
    const r = await connectRequestFor(host);
    assert.notStrictEqual(
      r.atyp,
      0x04,
      `${host} must not be sent as an IPv6 literal (got ATYP=0x${r.atyp.toString(16)})`,
    );
    // A DOMAINNAME address on the wire is [length, ...bytes].
    assert.strictEqual(r.addr[0], host.length, `${host} is sent with its correct length prefix`);
    assert.strictEqual(
      r.addr.subarray(1).toString("utf8"),
      host,
      `${host} is sent verbatim as a domain name for the proxy to resolve`,
    );
  }
  // A genuine IPv6 literal is still recognised and still encoded.
  const real = await connectRequestFor("::1");
  assert.strictEqual(real.atyp, 0x04, "::1 is still an IPv6 literal");
  assert.strictEqual(
    real.addr.toString("hex"),
    "00000000000000000000000000000001",
    "::1 encodes as fifteen zero bytes and a one",
  );
  const real2 = await connectRequestFor("2001:db8::1");
  assert.strictEqual(
    real2.addr.toString("hex"),
    "20010db8000000000000000000000001",
    "a compressed literal expands correctly",
  );
  // And IPv4 and plain names are untouched.
  assert.strictEqual((await connectRequestFor("1.2.3.4")).atyp, 0x01, "IPv4 stays IPv4");
  assert.strictEqual(
    (await connectRequestFor("example.com")).atyp,
    0x03,
    "a hostname stays a domain name",
  );
});

await test("regression: an out-of-range or malformed hextet is refused", async () => {
  // `parseInt(g, 16)` is not validation: it accepts trailing garbage
  // ("12zz" -> 18) and yields NaN for non-hex. Both used to be encoded.
  // "1:2:3:4:5:6:7:10000" has a five-digit group and "1:2:3:4:5:6:7:8:9" has
  // nine; neither is an IPv6 literal, so neither may claim to be one.
  for (const host of ["1:2:3:4:5:6:7:10000", "1:2:3:4:5:6:7:8:9", "12zz:2:3:4:5:6:7:8"]) {
    const r = await connectRequestFor(host);
    assert.notStrictEqual(
      r.atyp,
      0x04,
      `${host} is not a valid IPv6 literal and must not be encoded as one`,
    );
  }
});

await test("regression: a malformed percent-escape is a Socks5Error, not a URIError", async () => {
  // `decodeURIComponent` was called unguarded, so `socks5://user%ZZ:pw@host`
  // threw a raw `URIError: URI malformed` straight out of a function
  // documented to throw Socks5Error. A caller switching on `err.code` saw a
  // URIError with no `code` at all, and the module's error vocabulary did not
  // hold.
  const SECRET = "sup3rs3cr3t";
  for (const url of [
    `socks5://user%ZZ:${SECRET}@proxy.example.com`,
    `socks5://user%3:${SECRET}@proxy.example.com`,
    `socks5://user:pa%ss@proxy.example.com:${SECRET}`,
  ]) {
    assert.throws(
      () => parseSocks5Url(url),
      (err: unknown) => {
        assert.ok(
          err instanceof Socks5Error,
          `${url} must throw a Socks5Error, got ${String(err)}`,
        );
        assert.strictEqual(err.code, "SOCKS5_BAD_URL", "code");
        // The URL carries credentials and must not be echoed. A distinctive
        // value is used so the check cannot match a field name in the prose
        // ("...in the password" contains "pass").
        assert.ok(
          !err.message.includes(SECRET),
          `the message must not echo the credentials: ${err.message}`,
        );
        assert.ok(!err.message.includes("proxy.example.com"), `nor the host: ${err.message}`);
        return true;
      },
    );
  }
  // Well-formed escapes still decode, both sides.
  const ok = parseSocks5Url("socks5://user%40domain:pass%23@proxy.example.com");
  assert.strictEqual(ok.username, "user@domain", "a valid escape in the username still decodes");
  assert.strictEqual(ok.password, "pass#", "and in the password");
});

await test("regression: a zero timeout disables the timeout", async () => {
  // The Deno connector documents and tests 0 as "no timeout". The Node
  // connector passed 0 straight to setTimeout, which fires on the next tick,
  // so `connectTimeoutMs: 0` — the conventional way to say "wait as long as
  // it takes" — failed the dial in 2ms. The two connectors ship side by side
  // and meant opposite things by the same value.
  const port = await getFreePort();
  const acceptor = createServer(() => {
    /* accept and stay silent */
  });
  await new Promise<void>((r) => acceptor.listen(port, "127.0.0.1", r));
  try {
    const started = Date.now();
    const conn = await nodeTcpConnector("127.0.0.1", port, 0);
    assert.ok(Date.now() - started < 1000, "the dial was not failed immediately");
    conn.close();
  } finally {
    acceptor.close();
  }
});

await test("regression: socks5Connector honours the per-call timeout", async () => {
  // The wrapper built `{ connectTimeoutMs: timeoutMs, ...proxyConfig }` — the
  // caller's value spread FIRST, so a `connectTimeoutMs` in the proxy config
  // silently overrode it. A caller asking for 5s was dialled with the
  // config's 99s and nothing said so. The per-call value also never reached
  // the handshake timeout at all.
  const seen: number[] = [];
  const spy: import("../src/mod.ts").TcpConnector = async (_h, _p, timeoutMs) => {
    seen.push(timeoutMs);
    throw Object.assign(new Error("stop here"), { code: "ECONNREFUSED" });
  };
  const connector = socks5Connector(
    { host: "proxy.invalid", port: 1080, connectTimeoutMs: 99_000, maxRetries: 0 },
    spy,
  );
  await assert.rejects(() => connector("target.example", 443, 5_000));
  assert.deepStrictEqual(
    seen,
    [5_000],
    "the base connector is dialled with the CALLER's timeout, not the config's",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Socket error paths
// ═══════════════════════════════════════════════════════════════════════

suite("Socket error paths");

/**
 * Run a handshake to completion (or failure) against a scripted connector
 * whose reads are taken from `replies`, and return what was written.
 */
async function driveHandshake(
  config: Socks5ProxyConfig,
  target: { host: string; port: number },
  replies: Array<Uint8Array | null>,
  opts: { eofAsZero?: boolean } = {},
): Promise<{ tunnel: Socks5Tunnel; writes: Buffer[] }> {
  const writes: Buffer[] = [];
  let step = 0;
  const scripted: TcpConnector = async () => ({
    read: async (b: Uint8Array) => {
      const next = step < replies.length ? replies[step++] : null;
      if (next === null) return opts.eofAsZero ? 0 : null;
      b.set(next.subarray(0, Math.min(next.length, b.length)));
      return Math.min(next.length, b.length);
    },
    write: async (d: Uint8Array) => {
      writes.push(Buffer.from(d));
      return d.length;
    },
    close: () => {},
  });
  const tunnel = await createSocks5Tunnel(config, target, scripted);
  return { tunnel, writes };
}

/** The standard "greeting accepted, CONNECT succeeded" reply script. */
const OK_REPLIES = [Buffer.from([5, 0]), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])];

const NO_RETRY: Socks5ProxyConfig = { host: "proxy.invalid", port: 1080, maxRetries: 0 };

await test("a proxy reply code with no known message is reported verbatim", async () => {
  // `REPLY_MESSAGES` covers 0x00-0x08. A proxy that answers with anything
  // else produced `SOCKS5 proxy error: undefined`, so a caller could not
  // tell a real failure from a bug in the message table.
  const port = await getFreePort();
  const server = createMockServer("unknown-reply");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const err = await assertFailsWithCode(
      createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u",
          password: "p",
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      ),
      "SOCKS5_REPLY_99",
      "an unrecognised reply code still yields a Socks5Error",
      false,
    );
    assert.match(
      err.message,
      /Unknown reply code 0x63/,
      `the numeric code is echoed, got: ${err.message}`,
    );
  } finally {
    server.close();
  }
});

await test("a CONNECT reply carrying a bad version is rejected", async () => {
  // The method-selection reply was version-checked; the CONNECT reply was not.
  // A proxy answering 0x04 there had its four reply bytes walked as if they
  // were an address.
  const port = await getFreePort();
  const server = createMockServer("bad-reply-version");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    await assertFailsWithCode(
      createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u",
          password: "p",
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      ),
      "SOCKS5_BAD_VERSION",
      "a bad version in the CONNECT reply",
    );
  } finally {
    server.close();
  }
});

await test("a domain bound address in the reply is decoded", async () => {
  // ATYP=0x03 in the reply is legal. It fell through to the IPv4 branch, so
  // the length byte was read as an address octet and the bound port came back
  // as garbage.
  const port = await getFreePort();
  const server = createMockServer("domain-bound");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const tunnel = await createSocks5Tunnel(
      {
        host: "127.0.0.1",
        port,
        username: "u",
        password: "p",
        connectTimeoutMs: 5000,
        handshakeTimeoutMs: 5000,
      },
      { host: "example.com", port: 80 },
      nodeTcpConnector,
    );
    assertTunnel(tunnel, "a domain bound address");
    assert.strictEqual(tunnel.boundAddr, "gateway.internal", "the bound domain is decoded");
    assert.strictEqual(tunnel.boundPort, 8080, "the bound port is decoded after the name");
    tunnel.conn.close();
  } finally {
    server.close();
  }
});

await test("a proxy demanding user/password with no credentials configured is refused", async () => {
  // The mock always answers the greeting with 0x02 (username/password). With
  // no username/password configured, `chosenMethod` is 2 and the client has
  // nothing to send — the failure is `SOCKS5_AUTH_REQUIRED`, not a zero-length
  // auth frame written to the wire.
  const port = await getFreePort();
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf.length < 2 + n) return;
      socket.write(Buffer.from([0x05, 0x02])); // UserPassword required
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const err = await assertFailsWithCode(
      createSocks5Tunnel(
        { host: "127.0.0.1", port, connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      ),
      "SOCKS5_AUTH_REQUIRED",
      "a required auth method with no credentials",
    );
    assert.match(err.message, /requires username\/password/);
  } finally {
    server.close();
  }
});

await test("a handshake that reads zero bytes is an EOF, not a hang", async () => {
  // A connector whose read resolves 0 forever (some TLS-wrapped transports do
  // this) must terminate the handshake. `nRead === 0` was not checked, so the
  // loop spun until the timeout fired and the caller saw SOCKS5_TIMEOUT
  // instead of SOCKS5_EOF.
  const err = await assertFailsWithCode(
    driveHandshake(
      { ...NO_RETRY, handshakeTimeoutMs: 300 },
      { host: "example.com", port: 80 },
      [],
      { eofAsZero: true },
    ),
    "SOCKS5_EOF",
    "a connector that reads 0 bytes",
  );
  assert.match(err.message, /Connection closed during SOCKS5 handshake/);
});

await test("a non-finite handshake timeout disables the timeout", async () => {
  // `handshakeTimeoutMs: NaN` is what a config assembled from arithmetic on
  // missing values produces. `Number.isFinite` is the check, so NaN means "no
  // timeout" exactly as 0 does — the handshake must still complete.
  const { tunnel } = await driveHandshake(
    { ...NO_RETRY, handshakeTimeoutMs: Number.NaN },
    { host: "example.com", port: 80 },
    OK_REPLIES,
  );
  assertTunnel(tunnel, "a NaN handshake timeout");
  tunnel.conn.close();
});

await test("an Infinity handshake timeout also disables the timeout", async () => {
  const { tunnel } = await driveHandshake(
    { ...NO_RETRY, handshakeTimeoutMs: Number.POSITIVE_INFINITY },
    { host: "example.com", port: 80 },
    OK_REPLIES,
  );
  assertTunnel(tunnel, "an infinite handshake timeout");
  tunnel.conn.close();
});

await test("a bracketed IPv6 target is encoded as an IPv6 literal", async () => {
  // `encodeAddress` strips brackets before validating, so "[::1]" — the form
  // every URL parser hands back — is recognised rather than sent as a domain
  // name with a colon and a bracket in it.
  const { writes } = await driveHandshake(NO_RETRY, { host: "[::1]", port: 80 }, OK_REPLIES);
  const all = Buffer.concat(writes);
  const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
  assert.ok(i !== -1, "a CONNECT request was sent");
  assert.strictEqual(all[i + 3], 0x04, "a bracketed IPv6 literal is ATYP=IPv6");
  assert.strictEqual(
    all.subarray(i + 4, i + 20).toString("hex"),
    "00000000000000000000000000000001",
    "the brackets are stripped and ::1 is encoded",
  );
});

await test("an uncompressed eight-group IPv6 literal is encoded verbatim", async () => {
  // The uncompressed branch of `expandIPv6` never ran: every literal in the
  // suite used "::" compression, so a full eight-group address — what a
  // caller reading one back off `socket.remoteAddress` actually has — was
  // unverified.
  const { writes } = await driveHandshake(
    NO_RETRY,
    { host: "2001:0db8:0000:0000:0000:ff00:0042:8329", port: 80 },
    OK_REPLIES,
  );
  const all = Buffer.concat(writes);
  const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
  assert.ok(i !== -1, "a CONNECT request was sent");
  assert.strictEqual(all[i + 3], 0x04, "an eight-group literal is ATYP=IPv6");
  assert.strictEqual(
    all.subarray(i + 4, i + 20).toString("hex"),
    "20010db8000000000000ff0000428329",
    "each group is encoded big-endian in place",
  );
});

await test("two compressed runs are not an IPv6 literal", async () => {
  // `"1::2::3"` splits into three halves. The old structural check accepted it
  // and the address was encoded as sixteen bytes of nonsense; it must go to
  // the proxy as a name and get host-unreachable, not resolve to `::`.
  const { writes } = await driveHandshake(NO_RETRY, { host: "1::2::3", port: 80 }, OK_REPLIES);
  const all = Buffer.concat(writes);
  const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
  assert.ok(i !== -1, "a CONNECT request was sent");
  assert.strictEqual(all[i + 3], 0x03, "an ambiguous literal is sent as a domain name");
  const nameLen = all[i + 4]!;
  assert.strictEqual(
    all.subarray(i + 5, i + 5 + nameLen).toString("utf8"),
    "1::2::3",
    "and it is sent verbatim, at its correct length",
  );
});

await test("a compressed run that omits nothing is not an IPv6 literal", async () => {
  // `"1:2:3:4:5:6:7::8"` is eight groups with a `::` in the middle, so `::`
  // stands for zero omitted groups — which the encoding cannot represent.
  // Left+right is 8, over the limit of 7, so it is a name, not an address.
  const { writes } = await driveHandshake(
    NO_RETRY,
    { host: "1:2:3:4:5:6:7::8", port: 80 },
    OK_REPLIES,
  );
  const all = Buffer.concat(writes);
  const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
  assert.ok(i !== -1, "a CONNECT request was sent");
  assert.strictEqual(all[i + 3], 0x03, "a `::` that omits nothing is sent as a domain name");
});

await test("a hostname with remoteDns=false is still sent, with a warning", async () => {
  // `remoteDns: false` means the caller resolved the name themselves. Getting
  // a name anyway is a caller mistake, not a reason to fail: the bytes are
  // still written, ATYP=DOMAINNAME, and the proxy resolves it.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.join(" "));
  };
  try {
    const { writes } = await driveHandshake(
      { ...NO_RETRY, remoteDns: false },
      { host: "example.com", port: 80 },
      OK_REPLIES,
    );
    const all = Buffer.concat(writes);
    const i = all.indexOf(Buffer.from([5, 1, 0]), 1);
    assert.ok(i !== -1, "a CONNECT request was sent");
    assert.strictEqual(all[i + 3], 0x03, "the name is still sent as a domain name");
    assert.strictEqual(all[i + 4], "example.com".length, "with its correct length prefix");
    assert.strictEqual(
      all.subarray(i + 5, i + 5 + "example.com".length).toString("utf8"),
      "example.com",
      "and it is sent verbatim",
    );
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((w) => /remoteDns=false but got a hostname/.test(w)),
    `a warning is emitted, got: ${JSON.stringify(warnings)}`,
  );
});

await test("a hostname longer than 255 bytes is refused before any write", async () => {
  // The length check happens after the greeting, so the failure is a
  // Socks5Error rather than a truncated frame on the wire.
  const long = "a".repeat(300);
  const err = await assertFailsWithCode(
    driveHandshake(NO_RETRY, { host: long, port: 80 }, OK_REPLIES),
    "SOCKS5_ADDR_TOO_LONG",
    "a 300-byte hostname",
  );
  assert.match(err.message, /max 255 bytes/);
});

await test("a username or password longer than 255 bytes is refused", async () => {
  // RFC 1929 puts both in a single octet length field. A 256-byte username
  // cannot be expressed, and the frame was written with a wrapped length.
  const port = await getFreePort();
  const server = createMockServer("ipv6-bound");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    await assertFailsWithCode(
      createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u".repeat(256),
          password: "p",
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      ),
      "SOCKS5_AUTH_TOO_LONG",
      "a 256-byte username",
    );
    await assertFailsWithCode(
      createSocks5Tunnel(
        {
          host: "127.0.0.1",
          port,
          username: "u",
          password: "p".repeat(256),
          connectTimeoutMs: 5000,
          handshakeTimeoutMs: 5000,
        },
        { host: "example.com", port: 80 },
        nodeTcpConnector,
      ),
      "SOCKS5_AUTH_TOO_LONG",
      "a 256-byte password",
    );
  } finally {
    server.close();
  }
});

await test("a config with no connectTimeoutMs uses the documented default", async () => {
  // Every test above passed a connectTimeoutMs explicitly, so the documented
  // 10s default was never the value actually in force.
  const seen: number[] = [];
  const spy: TcpConnector = async (_h, _p, timeoutMs) => {
    seen.push(timeoutMs);
    throw new Socks5Error("stop here", "SOCKS5_EOF");
  };
  await assertFailsWithCode(
    createSocks5Tunnel({ host: "proxy.invalid" }, { host: "example.com", port: 80 }, spy),
    "SOCKS5_EOF",
    "a config with no timeouts at all",
  );
  assert.deepStrictEqual(seen, [10_000], "the documented 10s default is dialled");
});

await test("a connector rejecting with a non-Error is still classified", async () => {
  // `err instanceof Error ? err.message : String(err)` — a connector that
  // rejects with a plain object or a string (a Deno `Deno.errors` wrapper
  // sometimes does) must still produce a Socks5Error naming the failure,
  // and must not be treated as retriable without a string `code`.
  const forString: TcpConnector = async () => {
    throw "proxy is down";
  };
  const err1 = await assertFailsWithCode(
    createSocks5Tunnel(
      { host: "proxy.invalid", maxRetries: 0 },
      { host: "e.com", port: 80 },
      forString,
    ),
    "SOCKS5_CONNECT_FAILED",
    "a connector rejecting with a bare string",
    false,
  );
  assert.match(err1.message, /proxy is down/, `the value is stringified: ${err1.message}`);

  const forNull: TcpConnector = async () => {
    throw null;
  };
  const err2 = await assertFailsWithCode(
    createSocks5Tunnel(
      { host: "proxy.invalid", maxRetries: 0 },
      { host: "e.com", port: 80 },
      forNull,
    ),
    "SOCKS5_CONNECT_FAILED",
    "a connector rejecting with null",
    false,
  );
  assert.match(err2.message, /null/, `null is stringified: ${err2.message}`);

  // A non-string `code` is not in the transient set either.
  const forNumericCode: TcpConnector = async () => {
    throw Object.assign(new Error("refused"), { code: 111 });
  };
  await assertFailsWithCode(
    createSocks5Tunnel(
      { host: "proxy.invalid", maxRetries: 0 },
      { host: "e.com", port: 80 },
      forNumericCode,
    ),
    "SOCKS5_CONNECT_FAILED",
    "a connector rejecting with a numeric code",
    false,
  );
});

await test("socks5Connector with a zero per-call timeout falls back to the config", async () => {
  // `timeoutMs: 0` means "no timeout" to every caller in this codebase, and
  // the wrapper's own rule says a non-positive budget is not a per-call
  // override. It must therefore fall back to the config's value rather than
  // dialling with 0.
  const seen: number[] = [];
  const spy: TcpConnector = async (_h, _p, timeoutMs) => {
    seen.push(timeoutMs);
    throw new Socks5Error("stop here", "SOCKS5_EOF");
  };
  const connector = socks5Connector(
    { host: "proxy.invalid", port: 1080, connectTimeoutMs: 99_000, maxRetries: 0 },
    spy,
  );
  await assert.rejects(() => connector("target.example", 443, 0));
  assert.deepStrictEqual(
    seen,
    [99_000],
    "a zero per-call timeout falls back to the configured one",
  );
});

await test("socks5Connector with neither a per-call nor a configured timeout uses the default", async () => {
  // With `connectTimeoutMs` absent from the config *and* a non-positive
  // per-call value, the wrapper must omit both keys and let the documented
  // 10s default apply rather than passing `undefined` through.
  const seen: number[] = [];
  const spy: TcpConnector = async (_h, _p, timeoutMs) => {
    seen.push(timeoutMs);
    throw new Socks5Error("stop here", "SOCKS5_EOF");
  };
  const connector = socks5Connector({ host: "proxy.invalid", port: 1080, maxRetries: 0 }, spy);
  await assert.rejects(() => connector("target.example", 443, 0));
  assert.deepStrictEqual(seen, [10_000], "the documented default applies");
});

await test("parseSocks5Url rejects a URL with no host at all", async () => {
  // `"socks5://"` parses as a URL with an empty hostname, so it reaches the
  // host check. Only the `"socks5://:1080"` form was covered, and that one
  // fails earlier, in the URL parser itself.
  for (const url of ["socks5://", "socks5h://"]) {
    assert.throws(
      () => parseSocks5Url(url),
      (err: unknown) => {
        assert.ok(err instanceof Socks5Error, `${url}: expected a Socks5Error`);
        assert.strictEqual((err as Socks5Error).code, "SOCKS5_BAD_URL", `${url}: code`);
        assert.match(
          (err as Socks5Error).message,
          /no hostname specified/,
          `${url}: the message names the missing host`,
        );
        return true;
      },
    );
  }
});

// ── nodeTcpConnector socket-state paths ────────────────────────────────

suite("nodeTcpConnector — socket state");

/** Start a TCP server that runs `onSocket` and return its port. */
async function withServer(
  onSocket: (socket: import("node:net").Socket) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  const server = createServer(onSocket);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

await test("data that arrived before the read is returned by it", async () => {
  // `flushBuffer` had no pending reader when the bytes landed, so they sat in
  // the buffer. A read issued afterwards must find them rather than park —
  // and must return the *buffered* count, not the caller's buffer length.
  await withServer(
    (socket) => {
      socket.write(Buffer.from("abcdefgh"));
    },
    async (port) => {
      const conn = await nodeTcpConnector("127.0.0.1", port, 5000);
      // Give the socket's 'data' event time to land with no reader waiting.
      await new Promise((r) => setTimeout(r, 100));
      const buf = new Uint8Array(4096);
      const n = await conn.read(buf);
      assert.strictEqual(n, 8, "the read returns the 8 bytes that were already buffered");
      assert.strictEqual(
        new TextDecoder().decode(buf.subarray(0, n)),
        "abcdefgh",
        "and they are the bytes the server sent",
      );
      // A second read now genuinely parks, so close the socket and expect EOF.
      conn.close();
    },
  );
});

await test("a read in flight is rejected when the socket is reset", async () => {
  // `rejectPending` only fires the stored reject when one exists. A read
  // already waiting when the socket died must be rejected, not abandoned:
  // nothing else will ever resolve it. The server resets (RST) rather than
  // closing cleanly, so the client sees a socket error and not an EOF.
  await withServer(
    (socket) => {
      socket.on("error", () => {});
      setTimeout(() => socket.resetAndDestroy(), 50);
    },
    async (port) => {
      const conn = await nodeTcpConnector("127.0.0.1", port, 5000);
      const buf = new Uint8Array(16);
      await assert.rejects(
        () => conn.read(buf),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
          return true;
        },
        "a read in flight is rejected when the socket is reset",
      );
      conn.close();
    },
  );
});

await test("a read issued after the socket errored rejects with that same error", async () => {
  // The error is latched into `lastError`, so a read issued *afterwards*
  // rejects immediately with it rather than parking forever on a socket that
  // will never emit again. Without the latch this awaited until the process
  // exited, which is not a failure a timeout would ever catch.
  await withServer(
    (socket) => {
      socket.on("error", () => {});
      setTimeout(() => socket.resetAndDestroy(), 50);
    },
    async (port) => {
      const conn = await nodeTcpConnector("127.0.0.1", port, 5000);
      // Provoke and absorb the first error so the socket is in its errored
      // state and `lastError` is latched.
      await assert.rejects(() => conn.read(new Uint8Array(16)));
      // Now a *second* read. It has no pending counterpart and no data; only
      // the latch can end it.
      await assert.rejects(
        () => conn.read(new Uint8Array(16)),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
          assert.match(
            err.message,
            /ECONNRESET|socket hang up/i,
            `it is the latched socket error, got: ${err.message}`,
          );
          return true;
        },
        "a read after the socket already errored rejects immediately",
      );
      conn.close();
    },
  );
});

await test("a write to a reset socket rejects", async () => {
  await withServer(
    (socket) => {
      socket.on("error", () => {});
      setTimeout(() => socket.resetAndDestroy(), 50);
    },
    async (port) => {
      const conn = await nodeTcpConnector("127.0.0.1", port, 5000);
      await new Promise((r) => setTimeout(r, 150));
      await assert.rejects(
        () => conn.write(new Uint8Array([1])),
        (err: unknown) => {
          assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
          return true;
        },
        "the write callback reports the error instead of resolving",
      );
      conn.close();
    },
  );
});

await test("a read after a clean EOF returns null, not a rejection", async () => {
  await withServer(
    (socket) => {
      socket.end();
    },
    async (port) => {
      const conn = await nodeTcpConnector("127.0.0.1", port, 5000);
      // Wait for 'end'/'close' to be latched.
      await new Promise((r) => setTimeout(r, 100));
      const buf = new Uint8Array(16);
      assert.strictEqual(await conn.read(buf), null, "a clean EOF reads as null");
      conn.close();
    },
  );
});

// ── Start embedded proxy ────────────────────────────────────────────────

console.log("\n── Starting embedded SOCKS5 proxy...");
await startProxy();
console.log("  ✅ Embedded proxy ready on 127.0.0.1:1080");

// ── Real proxy tests — embedded SOCKS5 ──────────────────────────────────

suite("Real SOCKS5 tunnel — embedded proxy");

const validConfig: Socks5ProxyConfig = {
  host: PROXY_HOST,
  port: PROXY_PORT,
  username: PROXY_USERNAME,
  password: PROXY_PASSWORD,
  remoteDns: true,
  connectTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
};

await test("establishes tunnel with valid credentials", async () => {
  const tunnel = await createSocks5Tunnel(
    validConfig,
    { host: "httpbin.org", port: 80 },
    nodeTcpConnector,
  );
  assertTunnel(tunnel, "establishes tunnel with valid credentials");
  tunnel.conn.close();
});

await test("sends HTTP GET through tunnel and receives valid response", async () => {
  const tunnel = await createSocks5Tunnel(
    validConfig,
    { host: "httpbin.org", port: 80 },
    nodeTcpConnector,
  );

  const request = new TextEncoder().encode(
    "GET /get HTTP/1.1\r\nHost: httpbin.org\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
  );
  await tunnel.conn.write(request);

  const buf = new Uint8Array(8192);
  const n = await tunnel.conn.read(buf);
  assert.ok(n !== null, "the read returned data, not EOF");
  assert.ok(n > 0, `the read returned ${n} bytes`);

  const response = new TextDecoder().decode(buf.subarray(0, n));
  assert.ok(response.startsWith("HTTP/1.1"), `status line was: ${response.slice(0, 40)}`);
  assert.ok(response.includes("200"), "a 200 response");

  tunnel.conn.close();
});

await test("sends HTTP POST with body through tunnel", async () => {
  const tunnel = await createSocks5Tunnel(
    validConfig,
    { host: "httpbin.org", port: 80 },
    nodeTcpConnector,
  );

  const body = JSON.stringify({ kinetex: "test", proxy: "socks5" });
  const request = new TextEncoder().encode(
    `POST /post HTTP/1.1\r\n` +
      `Host: httpbin.org\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `Accept: application/json\r\n` +
      `Connection: close\r\n\r\n` +
      body,
  );
  await tunnel.conn.write(request);

  let fullResponse = "";
  const buf = new Uint8Array(8192);
  let n: number | null;
  do {
    n = await tunnel.conn.read(buf);
    if (n !== null && n > 0) {
      fullResponse += new TextDecoder().decode(buf.subarray(0, n));
    }
  } while (n !== null && n > 0);

  assert.strictEqual(fullResponse.startsWith("HTTP/1.1"), true);
  assert.strictEqual(fullResponse.includes("200"), true);
  assert.strictEqual(fullResponse.includes("kinetex"), true);

  tunnel.conn.close();
});

await test("tunnel to IPv4 target works", async () => {
  const tunnel = await createSocks5Tunnel(
    validConfig,
    { host: "1.1.1.1", port: 80 },
    nodeTcpConnector,
  );
  assertTunnel(tunnel, "tunnel to IPv4 target");

  const request = new TextEncoder().encode(
    "GET / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n",
  );
  await tunnel.conn.write(request);

  const buf = new Uint8Array(4096);
  const n = await tunnel.conn.read(buf);
  assert.ok(n !== null, "the read returned data, not EOF");
  assert.ok(n > 0, `the read returned ${n} bytes`);

  const response = new TextDecoder().decode(buf.subarray(0, n));
  assert.ok(response.startsWith("HTTP/1.1"), `status line was: ${response.slice(0, 40)}`);

  tunnel.conn.close();
});

await test("socks5Connector wrapper tunnels HTTP through proxy", async () => {
  const connector = socks5Connector(validConfig, nodeTcpConnector);
  const conn = await connector("httpbin.org", 80, 10_000);
  assert.ok(conn !== null && typeof conn === "object", "the wrapper resolves with a TcpConn");
  assert.strictEqual(typeof conn.read, "function", "read");
  assert.strictEqual(typeof conn.write, "function", "write");
  assert.strictEqual(typeof conn.close, "function", "close");

  const request = new TextEncoder().encode(
    "GET /status/200 HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n",
  );
  await conn.write(request);

  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  assert.ok(n !== null, "the read returned data, not EOF");
  assert.ok(n > 0, `the read returned ${n} bytes`);

  const response = new TextDecoder().decode(buf.subarray(0, n));
  assert.ok(response.includes("200"), "a 200 response through the wrapper");

  conn.close();
});

await test("fails with wrong password (auth failure)", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        { ...validConfig, password: "wrongpassword" },
        { host: "httpbin.org", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(err.code, "SOCKS5_AUTH_FAILED");
      assert.strictEqual(err.retriable, false);
      return true;
    },
  );
});

await test("fails with wrong username (auth failure)", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        { ...validConfig, username: "wronguser" },
        { host: "httpbin.org", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      assert.strictEqual(err.code, "SOCKS5_AUTH_FAILED", "code");
      assert.strictEqual(err.retriable, false, "bad credentials are not retriable");
      return true;
    },
  );
});

await test("fails with no credentials when proxy requires auth", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        {
          host: PROXY_HOST,
          port: PROXY_PORT,
          remoteDns: true,
          connectTimeoutMs: 10_000,
          handshakeTimeoutMs: 10_000,
        },
        { host: "httpbin.org", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof Socks5Error, `expected a Socks5Error, got ${String(err)}`);
      // The client offers NO_AUTH alone, the proxy has no method it accepts,
      // and answers 0xFF — so this is NO_ACCEPTABLE_METHOD specifically, not
      // "one of three". AUTH_FAILED would mean credentials were offered and
      // rejected, which is a different bug with a different fix.
      assert.strictEqual(
        err.code,
        "SOCKS5_NO_ACCEPTABLE_METHOD",
        "the proxy rejected the offered methods",
      );
      assert.strictEqual(err.retriable, false, "and it is not retriable");
      return true;
    },
  );
});

await test("tunnel close is idempotent", async () => {
  const tunnel = await createSocks5Tunnel(
    validConfig,
    { host: "httpbin.org", port: 80 },
    nodeTcpConnector,
  );
  assert.doesNotThrow(() => tunnel.conn.close());
  assert.doesNotThrow(() => tunnel.conn.close());
  assert.doesNotThrow(() => tunnel.conn.close());
});

await test("multiple sequential tunnels succeed", async () => {
  const tunnels = await Promise.all(
    Array.from({ length: 3 }, async () =>
      createSocks5Tunnel(validConfig, { host: "httpbin.org", port: 80 }, nodeTcpConnector),
    ),
  );

  assert.strictEqual(tunnels.length, 3, "three tunnels");
  // Distinct connections, not the same one handed back three times.
  assert.strictEqual(
    new Set(tunnels.map((t) => t.conn)).size,
    3,
    "each tunnel has its own connection",
  );
  for (const [i, tunnel] of tunnels.entries()) {
    assertTunnel(tunnel, `tunnel ${i}`);
    tunnel.conn.close();
  }
});

await test("tunnel to non-existent host returns proxy error", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(
        validConfig,
        { host: "this-domain-definitely-does-not-exist-xyz123.com", port: 80 },
        nodeTcpConnector,
      );
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(
        err.code.startsWith("SOCKS5_REPLY_") || err.code === "SOCKS5_TIMEOUT",
        true,
      );
      return true;
    },
  );
});

await test("tunnel to refused port returns proxy error", async () => {
  await assert.rejects(
    async () => {
      await createSocks5Tunnel(validConfig, { host: "127.0.0.1", port: 1 }, nodeTcpConnector);
    },
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(
        err.code.startsWith("SOCKS5_REPLY_") || err.code === "SOCKS5_TIMEOUT",
        true,
      );
      return true;
    },
  );
});

// ── Stop embedded proxy ─────────────────────────────────────────────────

stopProxy();
console.log("\n── Embedded proxy stopped");

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
