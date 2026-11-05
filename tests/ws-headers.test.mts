/**
 * kinetex — KX-25: WebSocket handshake headers must reach the wire.
 *
 * Node 22+'s global WebSocket has no `setHeader`, so the old implementation
 * silently dropped every configured header — often the `Authorization` one.
 * These tests capture the actual Upgrade request at a local server.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import { kinetex, WSClient, WSError } from "../src/mod.ts";

interface CapturedHandshake {
  headers: IncomingMessage["headers"];
  protocol: string | undefined;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let server: Server;
let url: string;
let captured: CapturedHandshake[] = [];
const sockets = new Set<Socket>();

function accept(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

function onUpgrade(req: IncomingMessage, socket: Socket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));

  const protocolHeader = req.headers["sec-websocket-protocol"];
  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader?.split(",")[0]?.trim();
  captured.push({ headers: { ...req.headers }, protocol });

  const key = req.headers["sec-websocket-key"];
  if (!key || Array.isArray(key)) {
    socket.destroy();
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n` +
      (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
      "\r\n",
  );

  // Answer the client's close frame so `close()` does not wait for a timeout.
  socket.once("data", () => {
    socket.write(Buffer.from([0x88, 0x00]));
    socket.end();
  });
}

before(async () => {
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
  });
  server.on("upgrade", onUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a direct WSClient sends handshake headers on Node 22+", async () => {
  captured = [];
  const ws = new WSClient({
    url,
    headers: {
      authorization: "Bearer test-token",
      "x-api-key": "key-123",
    },
    maxReconnects: 0,
    pingIntervalMs: 0,
    connectTimeoutMs: 5_000,
  });
  try {
    await ws.connect();
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.headers.authorization, "Bearer test-token");
    assert.equal(captured[0]!.headers["x-api-key"], "key-123");
  } finally {
    ws.close();
  }
});

test("protocols still negotiate when headers use the init object", async () => {
  captured = [];
  const ws = new WSClient({
    url,
    protocols: "chat",
    headers: { authorization: "Bearer chat-token" },
    maxReconnects: 0,
    pingIntervalMs: 0,
    connectTimeoutMs: 5_000,
  });
  try {
    await ws.connect();
    assert.equal(captured[0]!.protocol, "chat");
    assert.equal(captured[0]!.headers["sec-websocket-protocol"], "chat");
    assert.equal(captured[0]!.headers.authorization, "Bearer chat-token");
  } finally {
    ws.close();
  }
});

test("client.ws() forwards client-level and per-call headers", async () => {
  captured = [];
  const client = kinetex({
    headers: { "x-client": "client-level" },
    allowPrivateNetwork: true,
    timeout: 5_000,
  });
  const ws = await client.ws(url, {
    headers: { "x-call": "per-call" },
    maxReconnects: 0,
    pingIntervalMs: 0,
    connectTimeoutMs: 5_000,
  });
  try {
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.headers["x-client"], "client-level");
    assert.equal(captured[0]!.headers["x-call"], "per-call");
  } finally {
    ws.close();
    await client.destroy();
  }
});

test("a runtime that cannot send headers fails loudly instead of dropping them", async () => {
  const NativeWebSocket = globalThis.WebSocket;

  class NoHeaderWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    constructor(_url: string, init?: unknown) {
      // Reject the WebSocketInit object; plain construction "works".
      if (init !== undefined && typeof init === "object" && !Array.isArray(init)) {
        throw new TypeError("init object unsupported");
      }
    }
    close(): void {
      this.readyState = 3;
    }
  }

  (globalThis as { WebSocket: unknown }).WebSocket = NoHeaderWebSocket;
  try {
    const ws = new WSClient({
      url,
      headers: { authorization: "Bearer must-not-be-dropped" },
      maxReconnects: 0,
      pingIntervalMs: 0,
      connectTimeoutMs: 1_000,
    });
    await assert.rejects(
      () => ws.connect(),
      (err: unknown) =>
        err instanceof WSError && /cannot send custom handshake headers/.test(err.message),
    );
  } finally {
    (globalThis as { WebSocket: unknown }).WebSocket = NativeWebSocket;
  }
});
