/**
 * Patch-coverage tests for src/proxy.ts changed regions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectThroughProxy } from "../src/proxy.ts";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { Buffer } from "node:buffer";

const proxySrc = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");

async function startEchoProxy(behaviour: { expectAuth?: string } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on("connect", (req, clientSocket: Socket) => {
    if (
      behaviour.expectAuth !== undefined &&
      req.headers["proxy-authorization"] !== behaviour.expectAuth
    ) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const upstream = netConnect({ host: host ?? "", port: Number(port ?? 80) });
    // Push the 200 head in two writes so the client's drain loop sees a
    // partial head on the first read and terminator + tail on the next.
    clientSocket.write("HTTP/1.1 200 Connection established\r\n");
    clientSocket.write("\r\nx-extra: 1\r\n\r\nHEAD-TAIL-EXTRA");
    upstream.on("connect", () => {
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    clientSocket.on("close", () => upstream.destroy());
    clientSocket.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSocket.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function startEchoTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`tunneled:${req.url}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ok`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

test("patch-coverage: proxy.ts has no static node: imports and uses a globalThis Buffer accessor", () => {
  // The globalThis Buffer accessor (lines 24-30) exists so proxy.ts never
  // names a bare global `Buffer` or a static `node:` import, keeping the
  // browser bundle (node: -> shim aliasing) working.
  assert.ok(
    proxySrc.includes("const g = globalThis as"),
    "proxy.ts must reach Buffer through a typed globalThis accessor",
  );
  assert.ok(
    /g\.Buffer!\.from\([^)]*\)\.toString\("base64"\)/.test(proxySrc),
    "proxy auth fallback must encode through the globalThis Buffer accessor",
  );
  assert.equal(
    proxySrc.match(/^import .*from "node:/m)?.length ?? 0,
    0,
    "proxy.ts must not statically import node: modules",
  );
});

test("patch-coverage: unshift tail path (latin1 chunk cast + g.Buffer unshift)", async () => {
  const target = await startEchoTarget();
  const proxy = await startEchoProxy();
  const socket = await connectThroughProxy({ url: proxy.url }, new URL(target.url));
  try {
    socket.write(`GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    const buf = await new Promise<string>((resolve) => {
      let out = "";
      const t = setTimeout(() => resolve(out), 3000);
      socket.on("data", (c: Buffer) => {
        out += c.toString("latin1");
        if (out.includes("tunneled:")) {
          clearTimeout(t);
          resolve(out);
        }
      });
    });
    assert.match(buf, /tunneled:/);
  } finally {
    socket.destroy();
    await proxy.close();
    await target.close();
  }
});
