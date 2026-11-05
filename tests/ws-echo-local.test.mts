import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { WS_LOCAL_PORT, isLocalWsEchoRunning, wsEchoServer } from "./ws-echo-local.ts";

/**
 * The local echo server replaces echo.websocket.org and ws.postman-echo.com.
 * These pin the RFC 6455 behaviours the WebSocket client under test depends on,
 * because a regression in the fixture would otherwise look like a client bug.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

/** A masked client frame, as RFC 6455 requires of clients. */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ key[i % 4]!;

  const head =
    payload.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
      : (() => {
          const h = Buffer.alloc(4);
          h[0] = (fin ? 0x80 : 0) | opcode;
          h[1] = 0x80 | 126;
          h.writeUInt16BE(payload.length, 2);
          return h;
        })();
  return Buffer.concat([head, key, masked]);
}

/**
 * One socket, one buffer. Reading the head and then the frames needs the bytes
 * that arrive in the same TCP segment, so a listener per read drops data that
 * lands before the next read attaches — which is exactly what happens when the
 * echo comes back immediately after the 101.
 */
class Reader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];

  constructor(sock: Socket) {
    sock.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  private take(n: number): Buffer {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Waits until `enough()` holds. Never consumes — `head` needs to peek. */
  private async waitUntil(enough: () => boolean): Promise<void> {
    while (!enough()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  bytes(n: number): Promise<Buffer> {
    return this.waitUntil(() => this.buf.length >= n).then(() => this.take(n));
  }

  /** Everything up to and including the blank line that ends the head. */
  async head(): Promise<Buffer> {
    // Peeking is the point: polling byte by byte would eat the first byte of
    // the response.
    await this.waitUntil(() => this.buf.indexOf("\r\n\r\n") !== -1);
    return this.take(this.buf.indexOf("\r\n\r\n") + 4);
  }
}

async function open(version = "13"): Promise<{ sock: Socket; r: Reader }> {
  const sock = connect(WS_LOCAL_PORT, "127.0.0.1");
  const r = new Reader(sock);
  await new Promise<void>((res) => sock.once("connect", () => res()));
  sock.write(
    "GET / HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${WS_LOCAL_PORT}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
      `Sec-WebSocket-Version: ${version}\r\n\r\n`,
  );
  return { sock, r };
}

await wsEchoServer();

await test("the server is up and stays up across repeated calls", async () => {
  assert.ok(isLocalWsEchoRunning(), "the fixture must bind on import");
  const again = await wsEchoServer();
  assert.ok(again.listening);
});

await test("the handshake returns 101 with a valid accept key", async () => {
  const key = randomBytes(16).toString("base64");
  const sock = connect(WS_LOCAL_PORT, "127.0.0.1");
  const r = new Reader(sock);
  await new Promise<void>((res) => sock.once("connect", () => res()));
  sock.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${WS_LOCAL_PORT}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const head = (await r.head()).toString("latin1");
  sock.destroy();

  assert.match(head, /^HTTP\/1\.1 101/);
  assert.match(head, /upgrade: websocket/i);
  assert.match(head, /connection: upgrade/i);
  assert.ok(
    head.includes(
      createHash("sha1")
        .update(key + GUID)
        .digest("base64"),
    ),
    "Sec-WebSocket-Accept must be SHA-1(client key + RFC 6455 GUID), base64",
  );
});

await test("a non-websocket request is answered 426", async () => {
  const r = await fetch(`http://127.0.0.1:${WS_LOCAL_PORT}/`);
  assert.equal(r.status, 426);
});

await test("an unsupported version is rejected", async () => {
  const { sock, r } = await open("8");
  const head = (await r.head()).toString("latin1");
  sock.destroy();
  assert.match(head, /^HTTP\/1\.1 400/);
});

await test("text frames echo back byte for byte, including multi-byte UTF-8", async () => {
  const { sock, r } = await open();
  await r.head(); // discard the 101 head

  const text = Buffer.from("hello é世界", "utf8");
  sock.write(frame(0x1, text));
  const head = await r.bytes(2);
  assert.equal(head[0]!, 0x81, "the text opcode comes back");
  assert.equal(head[1]! & 0x7f, text.length);
  assert.deepEqual(await r.bytes(text.length), text);
  sock.destroy();
});

await test("a binary payload larger than 125 bytes uses the 16-bit length form", async () => {
  const { sock, r } = await open();
  await r.head();

  const bin = randomBytes(300);
  sock.write(frame(0x2, bin));
  const head = await r.bytes(4);
  assert.equal(head[0]!, 0x82, "the binary opcode comes back");
  assert.equal(head[1]! & 0x7f, 126, "300 bytes cannot use the 7-bit length form");
  assert.equal(head.readUInt16BE(2), 300);
  assert.deepEqual(await r.bytes(300), bin);
  sock.destroy();
});

await test("a ping is answered with a pong carrying identical data", async () => {
  const { sock, r } = await open();
  await r.head();

  sock.write(frame(0x9, Buffer.from("hb")));
  const out = await r.bytes(4);
  assert.equal(out[0]!, 0x8a, "pong opcode");
  assert.equal(out[1]! & 0x7f, 2);
  assert.deepEqual(out.subarray(2, 4), Buffer.from("hb"), "RFC 6455 §5.5.2");
  sock.destroy();
});

await test("a close frame is mirrored back with its code", async () => {
  const { sock, r } = await open();
  await r.head();

  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(1000, 0);
  sock.write(frame(0x8, payload));
  const out = await r.bytes(4);
  assert.equal(out[0]!, 0x88, "close opcode");
  assert.equal(out.readUInt16BE(2), 1000);
  sock.destroy();
});

await test("fragmented messages are reassembled before echoing", async () => {
  const { sock, r } = await open();
  await r.head();

  sock.write(frame(0x1, Buffer.from("one"), false));
  sock.write(frame(0x0, Buffer.from("two")));
  const head = await r.bytes(2);
  assert.equal(head[1]! & 0x7f, 6, "both fragments arrive as one six-byte message");
  assert.equal((await r.bytes(6)).toString(), "onetwo");
  sock.destroy();
});

console.log(`\nLOCAL WS ECHO: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n`, f.err);
  process.exit(1);
}
