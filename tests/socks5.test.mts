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
import type { Socks5ProxyConfig, TcpConnector } from "../src/socks5.ts";

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

// ── Embedded SOCKS5 proxy (always requires auth) ──────────────────────────

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 1080;
const PROXY_USERNAME = "testuser";
const PROXY_PASSWORD = "testpass";

let proxyProcess: ChildProcess | null = null;

async function startProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
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
      if (d.toString().includes("EMBEDDED_PROXY_READY")) resolve();
    });

    proxyProcess.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString();
      if (msg.includes("EADDRINUSE")) {
        resolve();
      }
    });

    proxyProcess.on("error", reject);
  });
}

function stopProxy(): void {
  if (proxyProcess) {
    proxyProcess.kill("SIGTERM");
    proxyProcess = null;
  }
}

// ── Malicious TCP server for protocol edge-case tests ─────────────────────

function createMockServer(behavior: "bad-version" | "unsupported-method" | "bad-auth-version" | "ipv6-bound" | "conn-refused-after-auth"): Server {
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
    (err: any) => err.code === "SOCKS5_BAD_SCHEME",
  );
});

await test("throws SOCKS5_BAD_URL for malformed URL", () => {
  assert.throws(
    () => parseSocks5Url("://invalid"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
  );
});

await test("throws SOCKS5_BAD_URL for empty host", () => {
  assert.throws(
    () => parseSocks5Url("socks5://:1080"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
  );
});

await test("throws SOCKS5_BAD_URL for totally invalid string", () => {
  assert.throws(
    () => parseSocks5Url("not a url"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
  );
});

await test("throws SOCKS5_BAD_URL for invalid port", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:abc"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
  );
});

await test("throws SOCKS5_BAD_URL for port out of range (0)", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:0"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
  );
});

await test("throws SOCKS5_BAD_URL for port out of range (99999)", () => {
  assert.throws(
    () => parseSocks5Url("socks5://proxy.example.com:99999"),
    (err: any) => err.code === "SOCKS5_BAD_URL",
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
    { host: "127.0.0.1", port: 1, connectTimeoutMs: 1000 },
    nodeTcpConnector,
  );
  await assert.rejects(async () => {
    await fn("example.com", 80, 500);
  });
});

// ── nodeTcpConnector ────────────────────────────────────────────────────

suite("nodeTcpConnector");

await test("returns a promise", () => {
  const p = nodeTcpConnector("localhost", 80, 1000);
  assert.strictEqual(typeof p.then, "function");
  p.catch(() => {});
});

await test("connection refused throws", async () => {
  await assert.rejects(async () => {
    await createSocks5Tunnel(
      { host: "127.0.0.1", port: 1, connectTimeoutMs: 3000 },
      { host: "httpbin.org", port: 80 },
      nodeTcpConnector,
    );
  });
});

// ── denoTcpConnector ────────────────────────────────────────────────────

suite("denoTcpConnector");

await test("is exported as function", () => {
  assert.strictEqual(typeof denoTcpConnector, "function");
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
        { host: "127.0.0.1", port, username: "u", password: "p", connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
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
    { host: "127.0.0.1", port, username: "u", password: "p", connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
    { host: "example.com", port: 80 },
    nodeTcpConnector,
  );
  assert.strictEqual(tunnel.boundAddr.includes(":"), true);
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
        { host: "127.0.0.1", port, username: "u", password: "p", connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
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
    { host: "127.0.0.1", port, username: "onlyuser", connectTimeoutMs: 5000, handshakeTimeoutMs: 5000 },
    { host: "example.com", port: 80 },
    nodeTcpConnector,
  );
  // Should have offered NoAuth only (method 0), not UserPassword (method 2)
  assert.strictEqual(receivedMethods.includes(2), false);
  tunnel.conn.close();
  server.close();
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
  assert.notStrictEqual(tunnel.conn, undefined);
  assert.strictEqual(typeof tunnel.boundAddr, "string");
  assert.strictEqual(typeof tunnel.boundPort, "number");
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
  assert.notStrictEqual(n, null);
  assert.strictEqual(n! > 0, true);

  const response = new TextDecoder().decode(buf.subarray(0, n!));
  assert.strictEqual(response.startsWith("HTTP/1.1"), true);
  assert.strictEqual(response.includes("200"), true);

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
  assert.notStrictEqual(tunnel.conn, undefined);

  const request = new TextEncoder().encode(
    "GET / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n",
  );
  await tunnel.conn.write(request);

  const buf = new Uint8Array(4096);
  const n = await tunnel.conn.read(buf);
  assert.notStrictEqual(n, null);
  assert.strictEqual(n! > 0, true);

  const response = new TextDecoder().decode(buf.subarray(0, n!));
  assert.strictEqual(response.startsWith("HTTP/1.1"), true);

  tunnel.conn.close();
});

await test("tunnel to domain target with remoteDns=true", async () => {
  const tunnel = await createSocks5Tunnel(
    { ...validConfig, remoteDns: true },
    { host: "jsonplaceholder.typicode.com", port: 80 },
    nodeTcpConnector,
  );

  const request = new TextEncoder().encode(
    "GET /posts/1 HTTP/1.1\r\nHost: jsonplaceholder.typicode.com\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
  );
  await tunnel.conn.write(request);

  const buf = new Uint8Array(4096);
  const n = await tunnel.conn.read(buf);
  assert.notStrictEqual(n, null);
  assert.strictEqual(n! > 0, true);

  const response = new TextDecoder().decode(buf.subarray(0, n!));
  assert.strictEqual(response.includes("200"), true);
  assert.strictEqual(response.includes("userId"), true);

  tunnel.conn.close();
});

await test("socks5Connector wrapper tunnels HTTP through proxy", async () => {
  const connector = socks5Connector(validConfig, nodeTcpConnector);
  const conn = await connector("httpbin.org", 80, 10_000);
  assert.notStrictEqual(conn, undefined);
  assert.strictEqual(typeof conn.read, "function");
  assert.strictEqual(typeof conn.write, "function");
  assert.strictEqual(typeof conn.close, "function");

  const request = new TextEncoder().encode(
    "GET /status/200 HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n",
  );
  await conn.write(request);

  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  assert.notStrictEqual(n, null);
  assert.strictEqual(n! > 0, true);

  const response = new TextDecoder().decode(buf.subarray(0, n!));
  assert.strictEqual(response.includes("200"), true);

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
    (err: any) => err.code === "SOCKS5_AUTH_FAILED",
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
    (err: any) => {
      assert.strictEqual(err instanceof Socks5Error, true);
      assert.strictEqual(
        err.code === "SOCKS5_AUTH_FAILED" ||
          err.code === "SOCKS5_NO_ACCEPTABLE_METHOD" ||
          err.code === "SOCKS5_AUTH_REQUIRED",
        true,
      );
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
  tunnel.conn.close();
  tunnel.conn.close();
  tunnel.conn.close();
});

await test("multiple sequential tunnels succeed", async () => {
  const tunnels = await Promise.all(
    Array.from({ length: 3 }, async () =>
      createSocks5Tunnel(
        validConfig,
        { host: "httpbin.org", port: 80 },
        nodeTcpConnector,
      ),
    ),
  );

  assert.strictEqual(tunnels.length, 3);
  for (const tunnel of tunnels) {
    assert.notStrictEqual(tunnel.conn, undefined);
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
      await createSocks5Tunnel(
        validConfig,
        { host: "127.0.0.1", port: 1 },
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
