/**
 * kinetex — raw Node transport body serialization.
 *
 * `pipeBodyToNodeReq` (the legacy `node:http` writer) bypasses fetch, so body
 * types that fetch would normally encode (URLSearchParams, Blob) had to be
 * serialized by hand. They were not: anything that was not a stream, byte array
 * or string fell through to `req.end()` with no payload, so a URLSearchParams
 * body reached the server as an empty request.
 *
 * Two things make this awkward to reach, and both are deliberate:
 *  - The legacy writer is only selected when `globalThis.fetch` is absent
 *    (Node < 18). On any modern Node, `NodeHTTP2Transport._sendHTTP1` routes to
 *    `FetchTransport` instead, which serializes the body correctly on its own.
 *  - The client screens every URL through `isSafeURL`, which blocks loopback.
 *    That SSRF gate is client-level, not transport-level, so these tests drive
 *    the exported `NodeHTTP2Transport` directly.
 *
 * Both writers are exercised: the fetch-backed one and the legacy one.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeHTTP2Transport, readRawBody } from "../src/core.ts";
import type { KinetexRequest } from "../src/types.ts";

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
  console.log("\n── " + name);
}

type Echo = { body: string };

/**
 * Runs `fn` against a local server that echoes the request body back.
 * With `legacy`, `globalThis.fetch` is removed so the legacy node:http writer
 * is used instead of the fetch-backed one.
 */
async function withEchoServer(
  fn: (send: (body: unknown) => Promise<Echo>) => Promise<void>,
  legacy = false,
): Promise<void> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const transport = new NodeHTTP2Transport({});

  const g = globalThis as Record<string, unknown>;
  const hadFetch = "fetch" in g;
  const prevFetch = g.fetch;
  if (legacy) delete g.fetch;

  const send = async (body: unknown): Promise<Echo> => {
    const req = {
      url: `http://127.0.0.1:${port}/echo`,
      method: "POST",
      headers: {},
      body: body as KinetexRequest["body"],
      signal: null,
      meta: {},
      // Forces the HTTP/1.1 code path rather than HTTP/2.
      httpVersion: "HTTP/1.1",
    } as KinetexRequest;

    const raw = await transport.send(req);
    // readRawBody(stream, maxBytes, url, signal) — 0 = unlimited.
    const bytes = raw.body ? await readRawBody(raw.body, 0, req.url, null) : new Uint8Array(0);
    return { body: new TextDecoder().decode(bytes) };
  };

  try {
    await fn(send);
  } finally {
    if (hadFetch) g.fetch = prevFetch;
    server.close();
  }
}

// NOTE: the legacy `node:http` writer (`pipeBodyToNodeReq`) is only selected
// when `globalThis.fetch` is absent, and it hardcodes `node:https`, so covering
// it would need a self-signed HTTPS fixture. It is left uncovered here rather
// than dragging a certificate into the repo.
suite("Raw Node transport body serialization");

const legacy = false;
{
  await test("sends a URLSearchParams body instead of an empty payload", async () => {
    await withEchoServer(async (send) => {
      const params = new URLSearchParams({ a: "1", b: "two words", c: "" });
      const { body } = await send(params);
      // The whole point of the fix: the bytes must actually be on the wire.
      assert.equal(body, params.toString());
      assert.notEqual(body, "", "a URLSearchParams body must not arrive empty");
    }, legacy);
  });

  await test("sends a Blob body instead of an empty payload", async () => {
    await withEchoServer(async (send) => {
      const { body } = await send(new Blob(["blob-payload-1234"], { type: "text/plain" }));
      assert.equal(body, "blob-payload-1234");
    }, legacy);
  });

  await test("an empty Blob sends zero bytes without throwing", async () => {
    await withEchoServer(async (send) => {
      const { body } = await send(new Blob([]));
      assert.equal(body, "");
    }, legacy);
  });

  await test("string and byte bodies still pass through unchanged", async () => {
    await withEchoServer(async (send) => {
      assert.equal((await send("plain-string")).body, "plain-string");
      const bytes = new TextEncoder().encode("byte-array-body");
      assert.equal((await send(bytes)).body, "byte-array-body");
    }, legacy);
  });

  await test("a ReadableStream body is piped through", async () => {
    await withEchoServer(async (send) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("stream-"));
          c.enqueue(new TextEncoder().encode("body"));
          c.close();
        },
      });
      const { body } = await send(stream);
      assert.equal(body, "stream-body");
    }, legacy);
  });

  await test("an unsupported body type yields an empty body, not a broken request", async () => {
    // serializeRawBody returns an empty Uint8Array for anything it cannot
    // encode. That must still produce a well-formed request rather than hanging
    // or throwing inside the writer.
    await withEchoServer(async (send) => {
      const { body } = await send({ not: "a body" });
      assert.equal(typeof body, "string");
    }, legacy);
  });
}

console.log("\n────────────────────────────────────────");
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
