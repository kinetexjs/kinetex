/**
 * kinetex — axios config-object compatibility (KX-05 / KX-06).
 *
 * Every test uses a local HTTP/1.1 server. Nothing here touches the public
 * network, and the server records exactly what reaches the wire.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import { kinetex, KinetexError, HTTPStatusError } from "../src/mod.ts";

interface EchoBody {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
let server: Server;
let client: ReturnType<typeof kinetex>;
let baseURL: string;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/echo") {
      const body = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
        } satisfies EchoBody),
      );
      return;
    }
    if (url.pathname === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/json-as-text") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end('{"a":1}');
      return;
    }
    if (url.pathname === "/invalid-json") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("{not json");
      return;
    }
    if (url.pathname === "/binary") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(BINARY.byteLength),
      });
      res.end(BINARY);
      return;
    }
    if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(1024));
      return;
    }
    if (url.pathname === "/gzip") {
      const compressed = gzipSync("hello gzip");
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(compressed.byteLength),
      });
      res.end(compressed);
      return;
    }
    if (url.pathname.startsWith("/status/")) {
      const code = Number(url.pathname.split("/").pop());
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(`status ${code}`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${port}`;
  client = kinetex({
    baseURL,
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("request(config) sends method, data and headers", async () => {
  const res = await client.request<EchoBody>({
    url: "/echo",
    method: "post",
    data: "axios-style",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.method, "POST");
  assert.equal(res.data.body, "axios-style");
  assert.equal(res.data.headers["content-type"], "text/plain");
});

test("request(config) JSON-encodes an object body", async () => {
  const res = await client.request<EchoBody>({
    url: "/echo",
    method: "POST",
    data: { hello: "world", count: 2 },
  });
  assert.equal(res.data.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.data.body), { hello: "world", count: 2 });
});

test("request(config) rejects body/data together and a missing URL", async () => {
  await assert.rejects(
    client.request({ url: "/echo", method: "POST", body: "a", data: "b" }),
    (err: unknown) => err instanceof KinetexError && err.code === "EVALIDATION",
  );
  await assert.rejects(
    client.request({ method: "GET" }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /non-empty `url`/.test(err.message),
  );
});

test("request(config) rejects Node HTTP agents instead of dropping them", async () => {
  await assert.rejects(
    client.request({ url: "/json", httpAgent: {} }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /httpAgent\/httpsAgent are not supported/.test(err.message),
  );
});

test("validateStatus decides success, and null accepts everything", async () => {
  const accepted = await client.get<{ status: number }>("/status/418", {
    validateStatus: () => true,
  });
  assert.equal(accepted.status, 418);

  await assert.rejects(
    client.get("/status/404", { validateStatus: (status) => status < 400 }),
    (err: unknown) => err instanceof HTTPStatusError && err.response?.status === 404,
  );

  const all = await client.get<{ status: number }>("/status/500", { validateStatus: null });
  assert.equal(all.status, 500);
});

test("responseType text/json/arraybuffer/blob decode explicitly", async () => {
  const text = await client.get<string>("/json", { responseType: "text" });
  assert.equal(text.data, '{"ok":true}');

  const json = await client.get<{ a: number }>("/json-as-text", { responseType: "json" });
  assert.deepEqual(json.data, { a: 1 });

  const bytes = await client.get<Uint8Array>("/binary", { responseType: "arraybuffer" });
  assert.ok(bytes.data instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes.data), Array.from(BINARY));

  const blob = await client.get<Blob>("/binary", { responseType: "blob" });
  assert.equal(blob.data.size, BINARY.byteLength);
  assert.deepEqual(Array.from(new Uint8Array(await blob.data.arrayBuffer())), Array.from(BINARY));
});

test("responseType json rejects malformed JSON", async () => {
  await assert.rejects(
    client.get("/invalid-json", { responseType: "json" }),
    (err: unknown) => err instanceof KinetexError && err.code === "EPARSE",
  );
});

test("responseType stream returns a readable body", async () => {
  const res = await client.get<NodeJS.ReadableStream & AsyncIterable<Uint8Array>>("/binary", {
    responseType: "stream",
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res.data) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Array.from(Buffer.concat(chunks)), Array.from(BINARY));
});

test("maxContentLength and maxBodyLength aliases are enforced", async () => {
  await assert.rejects(
    client.get("/big", { maxContentLength: 16 }),
    (err: unknown) => err instanceof KinetexError && err.code === "ESIZELIMIT",
  );
  await assert.rejects(
    client.post("/echo", "12345", { maxBodyLength: 4 }),
    (err: unknown) => err instanceof KinetexError && err.code === "EVALIDATION",
  );
  const unlimited = await client.get("/big", { maxContentLength: Infinity });
  assert.equal((unlimited.data as string).length, 1024);
});

test("paramsSerializer replaces the default query encoding", async () => {
  const fn = await client.get<EchoBody>("/echo", {
    params: { a: ["1", "2"] },
    paramsSerializer: () => "custom=1&custom=2",
  });
  assert.equal(fn.data.url, "/echo?custom=1&custom=2");

  const obj = await client.get<EchoBody>("/echo", {
    params: { a: "1" },
    paramsSerializer: { serialize: () => "?from=object" },
  });
  assert.equal(obj.data.url, "/echo?from=object");
});

test("per-request transformResponse runs before the caller sees data", async () => {
  const res = await client.get<{ ok: boolean; transformed: boolean }>("/json", {
    transformResponse: (data) => ({ ...(data as object), transformed: true }),
  });
  assert.deepEqual(res.data, { ok: true, transformed: true });
});

test("decompress false returns the compressed bytes on the Node transport", async () => {
  // A custom `fetch` (the default for plain HTTP here) decompresses before
  // kinetex sees the body, so `ca` is used purely to select the raw Node
  // transport for this assertion. The value is never presented to a TLS peer.
  const nodeClient = kinetex({
    baseURL,
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
    ca: "unused-for-plain-http",
  });
  const raw = await nodeClient.get<Uint8Array>("/gzip", {
    responseType: "arraybuffer",
    decompress: false,
  });
  assert.deepEqual(Array.from(raw.data.slice(0, 2)), [0x1f, 0x8b]);

  const decoded = await nodeClient.get<string>("/gzip", { responseType: "text" });
  assert.equal(decoded.data, "hello gzip");
  await nodeClient.destroy();
});
