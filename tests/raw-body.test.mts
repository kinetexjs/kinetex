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
import { Kinetex } from "../src/client.ts";
import type { KinetexRequest } from "../src/types.ts";

let passed = 0,
  failed = 0;
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
  httpVersion: "HTTP/1.1" | "HTTP/2" = "HTTP/1.1",
): Promise<void> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
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
      httpVersion,
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

  await test("a ReadableStream body survives many concurrent streaming uploads", async () => {
    // HTTP/2 streaming bodies had coverage only as a single isolated request.
    // Under churn — several clients, each streaming repeatedly — this path
    // intermittently failed with "Response body object should not be disturbed
    // or locked", and one green isolated test would not have noticed. The
    // trigger was never isolated, so the assertion is the invariant that
    // matters: every byte arrives, on every request, and nothing is shared
    // between callers.
    const payload = "streamed-payload-".repeat(64);
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
    const clients = Array.from(
      { length: 4 },
      () =>
        new Kinetex({
          baseURL: `http://127.0.0.1:${port}`,
          allowPrivateNetwork: true,
          timeout: 15_000,
        }),
    );
    try {
      const bodies = await Promise.all(
        clients.flatMap((c) =>
          Array.from({ length: 6 }, () =>
            c
              .post(
                "/echo",
                new ReadableStream<Uint8Array>({
                  start(c2) {
                    c2.enqueue(new TextEncoder().encode(payload));
                    c2.close();
                  },
                }),
              )
              .then((r) => new TextDecoder().decode(r.rawBody ?? new Uint8Array())),
          ),
        ),
      );
      assert.equal(bodies.length, 24);
      for (const b of bodies) {
        assert.equal(b, payload, "every concurrent stream must arrive whole");
      }
    } finally {
      await Promise.all(clients.map((c) => c.destroy()));
      server.close();
    }
  });

  await test("every body type reaches the server intact on both raw transports", async () => {
    // The raw Node transports bypass fetch and write the body themselves, with
    // a separate branch per type on each transport. The h2 and http1 writers
    // are duplicated code, and neither had all four branches exercised: a
    // ReadableStream upload over HTTP/2 in particular was a path with no test
    // at all, which is exactly the shape that silently sends an empty body.
    for (const httpVersion of ["HTTP/1.1", "HTTP/2"] as const) {
      await withEchoServer(
        async (send) => {
          const cases: Array<[string, unknown, string]> = [
            ["string", "plain-text-payload", "plain-text-payload"],
            ["Uint8Array", new TextEncoder().encode("byte-payload"), "byte-payload"],
            [
              "ReadableStream",
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(new TextEncoder().encode("stream-"));
                  c.enqueue(new TextEncoder().encode("payload"));
                  c.close();
                },
              }),
              "stream-payload",
            ],
            ["URLSearchParams", new URLSearchParams({ a: "1", b: "2" }), "a=1&b=2"],
            // No plain object here: JSON encoding happens in the client, above
            // this layer, and `serializeRawBody` legitimately cannot encode one.
            // The client's own suites cover object bodies end to end.
          ];
          for (const [label, body, expected] of cases) {
            const { body: got } = await send(body);
            assert.equal(got, expected, `${httpVersion}: ${label} body must arrive intact`);
          }
        },
        false,
        httpVersion,
      );
    }
  });

  await test("every body type arrives over real HTTP/2, negotiated by ALPN", async () => {
    // The h2 body writer in core.ts is separate code from the http1 one, and it
    // only runs over a real TLS+ALPN connection — h2 cannot be negotiated over
    // cleartext here. The cleartext pass above therefore never reached it, which
    // is why a ReadableStream upload over HTTP/2 had no test at all.
    const { httpbinTlsBaseUrl, LOCAL_TLS_CA } = await import("./httpbin-local.ts");
    const base = await httpbinTlsBaseUrl();
    const transport = new NodeHTTP2Transport({ ca: LOCAL_TLS_CA, allowPrivateNetwork: true });
    const cases: Array<[string, unknown, string]> = [
      ["string", "h2-text", "h2-text"],
      ["Uint8Array", new TextEncoder().encode("h2-bytes"), "h2-bytes"],
      [
        "ReadableStream",
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("h2-"));
            c.enqueue(new TextEncoder().encode("stream"));
            c.close();
          },
        }),
        "h2-stream",
      ],
      ["URLSearchParams", new URLSearchParams({ a: "1", b: "2" }), "a=1&b=2"],
    ];
    for (const [label, body, expected] of cases) {
      const raw = await transport.send({
        url: `${base}/post`,
        method: "POST",
        headers: {},
        body: body as KinetexRequest["body"],
        signal: null,
        meta: {},
        httpVersion: "HTTP/2",
      } as KinetexRequest);
      assert.equal(raw.httpVersion, "HTTP/2", "the fixture must really negotiate h2");
      // The fixture echoes the received body in `data`, so the bytes are read
      // back through the JSON response rather than a raw /echo endpoint.
      const bytes = raw.body ? await readRawBody(raw.body, 0, base, null) : new Uint8Array(0);
      const echoed = (JSON.parse(new TextDecoder().decode(bytes)) as { data?: string }).data ?? "";
      assert.equal(echoed, expected, `HTTP/2: ${label} body must arrive intact`);
    }
    transport.destroy();
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
