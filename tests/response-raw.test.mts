/**
 * kinetex — KX-29: `KinetexResponse.raw` carries the transport's runtime
 * response object.
 *
 * The field was declared and documented but never populated. These tests pin
 * both Node paths: the HTTP/1 `IncomingMessage` (default transport falling
 * back from HTTP/2 against a plain-HTTP origin) and the fetch `Response`
 * (`FetchTransport`, used when a custom fetch is configured).
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { kinetex, type Kinetex, type RequestInterceptor } from "../src/mod.ts";

let server: Server;
let baseURL: string;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-fixture": "raw",
    });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(extra: Record<string, unknown> = {}): Kinetex {
  return kinetex({
    baseURL,
    allowPrivateNetwork: true,
    timeout: 5_000,
    retry: { maxRetries: 0 },
    ...extra,
  });
}

test("the Node HTTP/1 transport populates raw with the IncomingMessage", async () => {
  // `ca` forces the legacy node:http(s) path even for a plain-HTTP URL; the
  // default Node fallback is fetch(), which is covered by the next test.
  const client = makeClient({ httpVersion: "HTTP/1.1", ca: "unused-for-http" });
  try {
    const res = await client.get<{ ok: boolean }>("/raw");
    assert.equal(res.data.ok, true);
    assert.ok(res.raw !== undefined, "raw must not be undefined for a network response");
    const raw = res.raw as {
      statusCode?: number;
      headers?: Record<string, string | string[] | undefined>;
    };
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers?.["x-fixture"], "raw");
  } finally {
    await client.destroy();
  }
});

test("the fetch transport populates raw with the fetch Response", async () => {
  const client = makeClient({ fetch: globalThis.fetch, httpVersion: "HTTP/1.1" });
  try {
    const res = await client.get<{ ok: boolean }>("/raw");
    assert.equal(res.data.ok, true);
    assert.ok(res.raw instanceof Response, "raw must be the Response fetch returned");
    assert.equal(res.raw.status, 200);
    assert.equal(res.raw.headers.get("x-fixture"), "raw");
  } finally {
    await client.destroy();
  }
});

test("raw is absent on a synthesized response", async () => {
  const synthetic: RequestInterceptor = (ctx) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: '{"synthetic":true}',
    request: ctx.request,
  });
  const client = makeClient({
    httpVersion: "HTTP/1.1",
    interceptors: { request: [synthetic] },
  });
  try {
    const res = await client.get<{ synthetic: boolean }>("/not-sent");
    assert.equal(res.data.synthetic, true);
    assert.equal("raw" in res, false, "raw must be absent, not present-and-undefined");
  } finally {
    await client.destroy();
  }
});
