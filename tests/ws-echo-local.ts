import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

// A dependency-free RFC 6455 echo server. The public echo hosts
// (echo.websocket.org, ws.postman-echo.com) were the last live dependency in
// tests/ws.test.mts, and they rate-limit, go down, and make CI depend on a
// third party's uptime. `ws` is not a dependency of this project and adding it
// to test a client is not worth it: the handshake and the framing rules the
// client actually depends on are small enough to implement here.
//
// Supported deliberately: the opening handshake, text/binary echo, ping/pong,
// and close. Compression is not implemented, so the `Sec-WebSocket-Extensions`
// response header is omitted entirely — RFC 6455 §9.1 has no "none" value, and
// echoing an extension the server did not actually negotiate makes a strict
// client (Node's built-in WebSocket among them) abort with 1006.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WS_LOCAL_PORT = 18081;
export const WS_LOCAL_ORIGIN = `ws://127.0.0.1:${WS_LOCAL_PORT}`;

function accept(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

/**
 * Frames one message from the socket. Only the lengths a test can produce are
 * handled; anything larger than `MAX_FRAME` is closed rather than buffered, so a
 * buggy client cannot make the fixture allocate without bound.
 */
const MAX_FRAME = 1 << 20;

type Frame = { fin: boolean; opcode: number; payload: Buffer };

function readFrames(sock: Socket, onFrame: (f: Frame) => void, onEnd: () => void): void {
  let buf = Buffer.alloc(0);
  let fragmentOpcode = 0;
  let fragments: Buffer[] = [];

  const pump = (): void => {
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        if (big > BigInt(MAX_FRAME)) {
          sock.destroy();
          return;
        }
        len = Number(big);
        off += 8;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;

      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }
      buf = buf.subarray(off + len);

      if (opcode === 0x8) {
        onFrame({ fin: true, opcode: 0x8, payload });
        return;
      }
      if (opcode === 0x9) {
        // RFC 6455 §5.5.2: a ping must be answered with a pong carrying the
        // identical application data.
        send(sock, 0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          onFrame({ fin: true, opcode: fragmentOpcode, payload: Buffer.concat(fragments) });
          fragments = [];
          fragmentOpcode = 0;
        }
        continue;
      }
      fragmentOpcode = opcode;
      if (fin) onFrame({ fin: true, opcode, payload });
      else fragments = [payload];
    }
  };

  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  sock.on("error", onEnd);
  sock.on("close", onEnd);
  sock.on("end", onEnd);
}

function send(sock: Socket, opcode: number, payload: Buffer): void {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  sock.write(Buffer.concat([head, payload]));
}

let server: Server | undefined;
let starting: Promise<Server> | undefined;

/** True when the echo server can answer, without starting one. */
export function isLocalWsEchoRunning(): boolean {
  return server !== undefined;
}

/** Starts the echo server if it is not already up. Idempotent and race-free. */
export function wsEchoServer(): Promise<Server> {
  if (starting !== undefined) return starting;
  starting = new Promise<Server>((resolve, reject) => {
    const s = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Upgrade Required");
    });
    s.on("upgrade", handleUpgrade);
    // Never hold the process open on the server's account.
    s.unref();
    s.once("error", reject);
    s.listen(WS_LOCAL_PORT, "127.0.0.1", () => {
      server = s;
      resolve(s);
    });
  });
  return starting;
}

// Started on import, so a suite only has to import the origin and use it.
void wsEchoServer();

/** Stop the server. */
export function stopLocalWsEcho(): void {
  server?.close();
  server = undefined;
  starting = undefined;
}

function handleUpgrade(req: IncomingMessage, rawSock: Socket): void {
  {
    const sock = rawSock;
    const raw = Array.isArray(req.headers["sec-websocket-key"])
      ? req.headers["sec-websocket-key"][0]!
      : req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];

    if (!raw || version !== "13") {
      sock.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      sock.destroy();
      return;
    }
    // Echo servers ignore the requested subprotocol rather than closing, which
    // is what the client's fallback behaviour is written against.
    const proto = req.headers["sec-websocket-protocol"];
    sock.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept(raw)}\r\n` +
        (proto ? `Sec-WebSocket-Protocol: ${Array.isArray(proto) ? proto[0] : proto}\r\n` : "") +
        "\r\n",
    );

    const socket = sock as Socket;
    readFrames(
      socket,
      (f) => {
        if (f.opcode === 0x8) {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          send(socket, 0x8, f.payload.length >= 2 ? f.payload : Buffer.alloc(0));
          socket.end();
          if (code === 1006 || code === 1005) socket.destroy();
          return;
        }
        send(socket, f.opcode, f.payload);
      },
      () => {},
    );
  }
}

/** Proxies a plain TCP connection to the echo server, so tests can kill the peer. */
export function rawConnect(port = WS_LOCAL_PORT): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

/** A syntactically valid client handshake for {@link rawConnect}. */
export function handshakeRequest(path = "/"): string {
  return (
    "GET " +
    path +
    " HTTP/1.1\r\n" +
    `Host: 127.0.0.1:${WS_LOCAL_PORT}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n"
  );
}

export const __testing = { accept, send, readFrames };
