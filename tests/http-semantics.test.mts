/**
 * kinetex — URL, header, query and redirect semantics (KX-17 / KX-18 /
 * KX-19 / KX-20 / KX-21).
 *
 * Every test uses a local HTTP/1.1 server and inspects what reached the wire.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { kinetex, KinetexError, type Kinetex } from "../src/mod.ts";

interface Echo {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let baseURL: string;
let client: Kinetex;
let redirectHops: Echo[];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function echo(req: IncomingMessage, body: string): Echo {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  return {
    method: req.method ?? "",
    url: req.url ?? "",
    path: parsed.pathname,
    headers: req.headers,
    body,
  };
}

function sendJSON(res: import("node:http").ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

before(async () => {
  server = createServer(async (req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);

    if (parsed.pathname.startsWith("/redirect/")) {
      const status = Number(parsed.pathname.slice("/redirect/".length));
      redirectHops.push(echo(req, body));
      res.writeHead(status, { location: "/final" });
      res.end();
      return;
    }

    if (parsed.pathname === "/none") {
      res.writeHead(200);
      res.end("plain body");
      return;
    }

    if (parsed.pathname === "/octet") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "10",
      });
      res.end("octet body");
      return;
    }

    if (parsed.pathname === "/final") {
      const record = echo(req, body);
      redirectHops.push(record);
      sendJSON(res, record);
      return;
    }

    sendJSON(res, echo(req, body));
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
  redirectHops = [];
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

function newClient(baseURLOverride: string, extra: Record<string, unknown> = {}): Kinetex {
  return kinetex({
    baseURL: baseURLOverride,
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
    ...extra,
  });
}

function queryOf(echo: Echo): URLSearchParams {
  return new URL(echo.url, baseURL).searchParams;
}

// ============================================================================
// KX-17 — baseURL path and query
// ============================================================================

test("baseURL keeps its path and query when joining a relative URL", async () => {
  const c = newClient(`${baseURL}/v1?key=abc`);
  const res = await c.get<Echo>("/users", { params: { p: "1" } });
  assert.equal(res.data.path, "/v1/users");
  assert.deepEqual(queryOf(res.data).getAll("key"), ["abc"]);
  assert.deepEqual(queryOf(res.data).getAll("p"), ["1"]);
  await c.destroy();
});

test("baseURL trailing slash, query-only request, and fragment", async () => {
  const c = newClient(`${baseURL}/v1/?key=abc#not-sent`);
  const joined = await c.get<Echo>("users");
  assert.equal(joined.data.path, "/v1/users");
  assert.deepEqual(queryOf(joined.data).getAll("key"), ["abc"]);

  const queryOnly = await c.get<Echo>("?page=2");
  assert.equal(queryOnly.data.path, "/v1/");
  assert.deepEqual(queryOf(queryOnly.data).getAll("key"), ["abc"]);
  assert.deepEqual(queryOf(queryOnly.data).getAll("page"), ["2"]);

  const fragment = await c.get<Echo>("users#details");
  assert.equal(fragment.data.path, "/v1/users");
  assert.ok(!fragment.request.url.includes("not-sent"), "a base fragment must not leak");
  await c.destroy();
});

test("absolute URLs ignore the base path and query", async () => {
  const c = newClient(`${baseURL}/v1?key=abc`);
  const res = await c.get<Echo>(`${baseURL}/absolute?z=9`);
  assert.equal(res.data.path, "/absolute");
  assert.deepEqual(queryOf(res.data).getAll("z"), ["9"]);
  assert.deepEqual(queryOf(res.data).getAll("key"), []);
  await c.destroy();
});

// ============================================================================
// KX-18 — Headers and array-of-pairs inputs
// ============================================================================

test("Headers instances and [name, value] pairs reach the wire", async () => {
  const headers = new Headers({ "x-from-headers": "yes" });
  const fromHeaders = await client.get<Echo>("/echo", { headers });
  assert.equal(fromHeaders.data.headers["x-from-headers"], "yes");

  const fromPairs = await client.get<Echo>("/echo", {
    headers: [
      ["x-pair", "one"],
      ["x-array", "two"],
    ],
  });
  assert.equal(fromPairs.data.headers["x-pair"], "one");
  assert.equal(fromPairs.data.headers["x-array"], "two");
  assert.equal(fromPairs.data.headers["0"], undefined);
});

test("unsupported and malformed header sources are rejected", async () => {
  await assert.rejects(
    client.get("/echo", {
      headers: new Map([["x-map", "no"]]) as unknown as Record<string, string>,
    }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /Unsupported headers value/.test(err.message),
  );

  await assert.rejects(
    client.get("/echo", {
      headers: [["only-a-name"]] as unknown as string[][],
    }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /\[name, value\] pairs/.test(err.message),
  );
});

// ============================================================================
// KX-19 — Query serialisation
// ============================================================================

test("scalar params append instead of replacing an existing query value", async () => {
  const res = await client.get<Echo>("/q?x=old", { params: { x: "new" } });
  assert.deepEqual(queryOf(res.data).getAll("x"), ["old", "new"]);
});

test("array params default to the axios bracket form", async () => {
  const res = await client.get<Echo>("/q", { params: { a: ["1", "2"] } });
  assert.deepEqual(queryOf(res.data).getAll("a[]"), ["1", "2"]);
  assert.deepEqual(queryOf(res.data).getAll("a"), []);
});

test("arrayFormat repeat and client-level override are honoured", async () => {
  const perRequest = await client.get<Echo>("/q", {
    params: { a: ["1", "2"] },
    arrayFormat: "repeat",
  });
  assert.deepEqual(queryOf(perRequest.data).getAll("a"), ["1", "2"]);

  const c = newClient(baseURL, { arrayFormat: "repeat" });
  const clientLevel = await c.get<Echo>("/q", { params: { a: ["1", "2"] } });
  assert.deepEqual(queryOf(clientLevel.data).getAll("a"), ["1", "2"]);
  await c.destroy();
});

test("null and undefined params are dropped", async () => {
  const res = await client.get<Echo>("/q", {
    params: { a: "1", b: undefined, c: null },
  });
  assert.deepEqual(queryOf(res.data).getAll("a"), ["1"]);
  assert.deepEqual(queryOf(res.data).getAll("b"), []);
  assert.deepEqual(queryOf(res.data).getAll("c"), []);
});

test("nested object params are rejected instead of stringified", async () => {
  await assert.rejects(
    client.get("/q", { params: { a: { b: "c" } } as never }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /nested objects are not supported/.test(err.message),
  );

  await assert.rejects(
    client.get("/q", { params: { a: [{ b: "c" }] } as never }),
    (err: unknown) =>
      err instanceof KinetexError &&
      err.code === "EVALIDATION" &&
      /nested objects are not supported/.test(err.message),
  );
});

// ============================================================================
// KX-20 — explicit decoding for non-text content types
// ============================================================================

test("responseType text decodes no-content-type and octet-stream bodies", async () => {
  const noType = await client.get<string>("/none", { responseType: "text" });
  assert.equal(noType.data, "plain body");

  const octet = await client.get<string>("/octet", { responseType: "text" });
  assert.equal(octet.data, "octet body");

  const bytes = await client.get<Uint8Array>("/octet", { responseType: "arraybuffer" });
  assert.ok(bytes.data instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes.data), Array.from(Buffer.from("octet body")));

  // The default content-type parser still preserves binary bodies. Callers
  // that want axios' string default opt into responseType: "text".
  const implicit = await client.get<Uint8Array>("/octet");
  assert.ok(implicit.data instanceof Uint8Array);
});

// ============================================================================
// KX-21 — redirect method and entity headers
// ============================================================================

async function redirect(
  status: number,
  method: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ first: Echo; hop: Echo; final: Echo | null }> {
  redirectHops.length = 0;
  const res = await client.request<Echo | null>({
    url: `/redirect/${status}`,
    method,
    ...(body !== undefined ? { data: body } : {}),
    ...(headers !== undefined ? { headers } : {}),
    responseType: "json",
  });
  assert.equal(redirectHops.length, 2, "the redirect and its final target must both be hit");
  return { first: redirectHops[0]!, hop: redirectHops[1]!, final: res.data };
}

test("301/302/303 keep HEAD as HEAD", async () => {
  for (const status of [301, 302, 303]) {
    const { first, hop, final } = await redirect(status, "HEAD");
    assert.equal(first.method, "HEAD");
    assert.equal(hop.method, "HEAD", `status ${status} must not turn HEAD into GET`);
    assert.equal(final, null);
  }
});

test("301/302/303 convert POST to GET and drop entity headers", async () => {
  for (const status of [301, 302, 303]) {
    const { first, hop } = await redirect(status, "POST", "payload", {
      "content-type": "text/plain",
      "content-language": "en",
      "content-location": "/old",
      "content-md5": "deadbeef",
      "x-keep": "yes",
    });
    assert.equal(first.method, "POST");
    assert.equal(hop.method, "GET", `status ${status} must follow a POST with GET`);
    assert.equal(hop.body, "");
    assert.equal(hop.headers["content-type"], undefined);
    assert.equal(hop.headers["content-language"], undefined);
    assert.equal(hop.headers["content-location"], undefined);
    assert.equal(hop.headers["content-md5"], undefined);
    assert.equal(hop.headers["x-keep"], "yes");
  }
});

test("301/302 preserve non-POST methods and their bodies", async () => {
  for (const status of [301, 302]) {
    const { hop } = await redirect(status, "PUT", "payload", {
      "content-type": "text/plain",
    });
    assert.equal(hop.method, "PUT");
    assert.equal(hop.body, "payload");
    assert.equal(hop.headers["content-type"], "text/plain");
  }
});

test("303 converts PUT to GET", async () => {
  const { hop } = await redirect(303, "PUT", "payload", {
    "content-type": "text/plain",
  });
  assert.equal(hop.method, "GET");
  assert.equal(hop.body, "");
  assert.equal(hop.headers["content-type"], undefined);
});

test("307/308 preserve method, body and entity headers", async () => {
  for (const status of [307, 308]) {
    const { hop, final } = await redirect(status, "POST", "payload", {
      "content-type": "text/plain",
    });
    assert.equal(hop.method, "POST");
    assert.equal(hop.body, "payload");
    assert.equal(hop.headers["content-type"], "text/plain");
    assert.equal(final?.body, "payload");
  }
});

test("301/302 GET stays GET", async () => {
  for (const status of [301, 302]) {
    const { hop } = await redirect(status, "GET");
    assert.equal(hop.method, "GET");
    assert.equal(hop.body, "");
  }
});
