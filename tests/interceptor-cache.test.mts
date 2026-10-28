/**
 * kinetex — Regression tests for interceptor short-circuiting and cache safety.
 *
 * Covered:
 *  - KX-13  a request interceptor can return a synthetic response and skip the
 *           network; the response comes back through the normal pipeline
 *  - KX-14  cache hits are served, isolated by auth credentials and `Vary`,
 *           and `Cache-Control: private` is not stored
 *  - KX-22  overwriting a cache key replaces its accounting instead of
 *           inflating totalEntries/totalSizeBytes
 *
 * Every test uses a local server; no public network.
 *
 * Run: npx tsx tests/interceptor-cache.test.mts
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { HTTPCache, createCacheInterceptor, kinetex } from "../src/mod.ts";
import type { InterceptorRequest } from "../src/interceptors.ts";

let origin = "";
let server: Server;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no default route");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function json(res: import("node:http").ServerResponse, body: unknown, headers = {}): void {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

test("KX-13: a request interceptor can short-circuit with a response", async () => {
  let network = 0;
  const target = createServer((_req, res) => {
    network++;
    json(res, { network: true });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address() as AddressInfo;
  const client = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1", timeout: 5_000 });
  client.useRequest((ctx) => ({
    status: 203,
    statusText: "Non-Authoritative Information",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ synthetic: true }),
    request: ctx.request,
  }));
  try {
    const res = await client.get<{ synthetic: boolean }>(`http://127.0.0.1:${port}/`);
    assert.equal(network, 0, "the network must not be touched");
    assert.equal(res.status, 203);
    assert.deepEqual(res.data, { synthetic: true });
    assert.equal(res.cached, false);
  } finally {
    await client.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("KX-14: a fresh cache hit is served and skips the network", async () => {
  let hits = 0;
  const target = createServer((_req, res) => {
    hits++;
    json(res, { hit: hits }, { "cache-control": "max-age=60" });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address() as AddressInfo;
  const cache = createCacheInterceptor();
  const client = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1", timeout: 5_000 });
  client.useRequest(cache.requestInterceptor);
  client.useResponse(cache.responseInterceptor);
  try {
    const first = await client.get<{ hit: number }>(`http://127.0.0.1:${port}/`);
    const second = await client.get<{ hit: number }>(`http://127.0.0.1:${port}/`);
    assert.equal(hits, 1, "the second GET must be served from the interceptor cache");
    assert.deepEqual(first.data, { hit: 1 });
    assert.deepEqual(second.data, { hit: 1 });
    assert.equal(second.cached, true);
  } finally {
    await client.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("KX-14: cache entries are isolated by credential headers", async () => {
  let hits = 0;
  const target = createServer((req, res) => {
    hits++;
    json(
      res,
      { auth: req.headers.authorization ?? null, hit: hits },
      { "cache-control": "max-age=60" },
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address() as AddressInfo;
  const cache = createCacheInterceptor();
  const client = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1", timeout: 5_000 });
  client.useRequest(cache.requestInterceptor);
  client.useResponse(cache.responseInterceptor);
  try {
    const alice = await client.get<{ auth: string; hit: number }>(`http://127.0.0.1:${port}/`, {
      headers: { authorization: "Bearer alice" },
    });
    const bob = await client.get<{ auth: string; hit: number }>(`http://127.0.0.1:${port}/`, {
      headers: { authorization: "Bearer bob" },
    });
    const aliceAgain = await client.get<{ auth: string; hit: number }>(
      `http://127.0.0.1:${port}/`,
      { headers: { authorization: "Bearer alice" } },
    );
    assert.equal(hits, 2, "only the two distinct credentials may reach the network");
    assert.equal(alice.data.auth, "Bearer alice");
    assert.equal(bob.data.auth, "Bearer bob");
    assert.equal(aliceAgain.data.auth, "Bearer alice");
    assert.equal(aliceAgain.cached, true);
  } finally {
    await client.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("KX-14: Vary separates cached responses by request header", async () => {
  let hits = 0;
  const target = createServer((req, res) => {
    hits++;
    json(
      res,
      { lang: req.headers["accept-language"] ?? null, hit: hits },
      { "cache-control": "max-age=60", vary: "accept-language" },
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address() as AddressInfo;
  const cache = createCacheInterceptor();
  const client = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1", timeout: 5_000 });
  client.useRequest(cache.requestInterceptor);
  client.useResponse(cache.responseInterceptor);
  const url = `http://127.0.0.1:${port}/`;
  try {
    await client.get(url, { headers: { "accept-language": "en" } });
    const en = await client.get<{ lang: string; hit: number }>(url, {
      headers: { "accept-language": "en" },
    });
    await client.get(url, { headers: { "accept-language": "fr" } });
    const fr = await client.get<{ lang: string; hit: number }>(url, {
      headers: { "accept-language": "fr" },
    });
    assert.equal(hits, 2, "each Vary value gets its own entry");
    assert.equal(en.data.lang, "en");
    assert.equal(fr.data.lang, "fr");
    assert.equal(en.cached, true);
    assert.equal(fr.cached, true);
  } finally {
    await client.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("KX-14: Cache-Control: private is not stored", async () => {
  let hits = 0;
  const target = createServer((_req, res) => {
    hits++;
    json(res, { hit: hits }, { "cache-control": "private, max-age=60" });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address() as AddressInfo;
  const cache = createCacheInterceptor();
  const client = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1", timeout: 5_000 });
  client.useRequest(cache.requestInterceptor);
  client.useResponse(cache.responseInterceptor);
  try {
    const first = await client.get<{ hit: number }>(`http://127.0.0.1:${port}/`);
    const second = await client.get<{ hit: number }>(`http://127.0.0.1:${port}/`);
    assert.equal(hits, 2, "a private response must reach the network every time");
    assert.deepEqual(first.data, { hit: 1 });
    assert.deepEqual(second.data, { hit: 2 });
    assert.equal(second.cached, false);
  } finally {
    await client.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("KX-22: overwriting a key replaces its accounting", async () => {
  const cache = new HTTPCache({ maxEntries: 2, maxSizeBytes: 1_000_000, defaultTtlMs: 60_000 });
  const req: InterceptorRequest = {
    url: `${origin}/same`,
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  };
  const make = (body: string) => ({
    status: 200,
    statusText: "OK",
    headers: { "cache-control": "max-age=60" },
    body,
  });

  assert.equal(await cache.set(req, make("a")), true);
  const afterFirst = cache.getStats();
  assert.equal(afterFirst.totalEntries, 1);
  assert.equal(afterFirst.totalSizeBytes, 1 + 256);

  assert.equal(await cache.set(req, make("bb")), true);
  const afterReplace = cache.getStats();
  assert.equal(afterReplace.totalEntries, 1, "replacing must not add an entry");
  assert.equal(
    afterReplace.totalSizeBytes,
    2 + 256,
    "replacing must subtract the old entry size, not add both",
  );
  assert.equal(
    (await cache.get(req))?.entry.response.body,
    "bb",
    "the replacement must be readable",
  );
});
