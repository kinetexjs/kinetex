/**
 * kinetex — Local HTTP/2 harness for NodeHTTP2Transport header validation.
 *
 * Node-only (uses node:http2 + node:test); excluded from Deno/Bun CI jobs,
 * which only run their runtime-specific suites.
 *
 * Spins up a local `http2.createSecureServer` with a throwaway self-signed
 * localhost certificate generated at test time with openssl into the
 * gitignored tmp/ directory — no key material is ever committed (gitleaks in
 * CI would flag it). If openssl is unavailable the suite skips cleanly.
 *
 * Exercises the REAL HTTP/2 wire path so the forbidden-control-character
 * handling in `_sendHTTP2` is covered end to end:
 *
 *  - non-strict + callback: invalid header is DROPPED (never sent), callback fires
 *  - non-strict without callback: console.warn fires, request still succeeds
 *  - strict: KinetexError EVALIDATION, request never reaches the server
 *  - clean headers: sent verbatim, response OK (no false positives)
 *  - second request on the same session also validated (loop is per-hop)
 *  - regression: a caller-supplied `:path` / `:authority` cannot redirect or
 *    spoof the request, strict mode refuses them, and FetchTransport drops
 *    the identical header (the two transports must agree)
 *  - regression: a `__proto__` header is sent as a real header rather than
 *    being eaten by the inherited setter
 *
 * The transport is given the generated cert via the transport's `ca` option,
 * so no env manipulation (NODE_TLS_REJECT_UNAUTHORIZED) and no external services.
 */

import assert from "node:assert/strict";
import { before, after, test, type TestOptions } from "node:test";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FetchTransport, NodeHTTP2Transport } from "../src/core.ts";
import { KinetexError } from "../src/types.ts";
import type { KinetexRequest } from "../src/types.ts";
import { requireCapability } from "./capability.ts";

// ── Throwaway TLS material (generated per run; nothing committed) ────────────

let opensslAvailable = false;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
  opensslAvailable = true;
} catch {
  // openssl not on PATH — tests below skip with a reason.
}

const SKIP_REASON = opensslAvailable
  ? false
  : requireCapability("openssl", false, "these tests generate their own TLS material with it")
    ? false
    : "openssl is not available on this machine";

/** Per-run temp dir (gitignored); the pid suffix keeps concurrent runs apart. */
const REPO_TMP = fileURLToPath(new URL("../tmp/", import.meta.url));
mkdirSync(REPO_TMP, { recursive: true });
const TMP_DIR = mkdtempSync(join(tmpdir() === "/tmp" ? REPO_TMP : tmpdir(), `h2-${process.pid}-`));
const TLS_KEY_PATH = join(TMP_DIR, "localhost-key.pem");
const TLS_CERT_PATH = join(TMP_DIR, "localhost-cert.pem");

// ── Local HTTP/2 server ───────────────────────────────────────────────────────

let server: Http2SecureServer | null = null;
let baseURL = "";
let TLS_CERT = "";

/**
 * One entry per request received.
 *
 * `headers` is null-prototype on purpose. A plain `{}` has an inherited
 * `__proto__` setter, so recording a header literally named `__proto__` would
 * have assigned the prototype instead of the value — the harness would have
 * hidden exactly the case one of these tests exists to catch. `:authority` and
 * `:scheme` are pulled out alongside `:path` because they are request-line
 * facts the regressions assert on.
 */
interface SeenRequest {
  path: string;
  authority: string;
  scheme: string;
  headers: Record<string, string>;
}
const receivedRequests: SeenRequest[] = [];

before(async () => {
  if (!opensslAvailable) return;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      TLS_KEY_PATH,
      "-out",
      TLS_CERT_PATH,
      "-days",
      "3",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  TLS_CERT = readFileSync(TLS_CERT_PATH, "utf8");

  server = createSecureServer({
    key: readFileSync(TLS_KEY_PATH),
    cert: readFileSync(TLS_CERT_PATH),
  });
  server.on("stream", (stream, reqHeaders) => {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(reqHeaders)) {
      if (name.startsWith(":")) continue; // strip :method/:path/:authority/...
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    receivedRequests.push({
      path: String(reqHeaders[":path"] ?? ""),
      authority: String(reqHeaders[":authority"] ?? ""),
      scheme: String(reqHeaders[":scheme"] ?? ""),
      headers,
    });
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("h2 server failed to bind");
  baseURL = `https://localhost:${addr.port}`;
});

after(async () => {
  if (server) {
    // closeIdleConnections (Node >= 18.4) makes close() deterministic even if a
    // session leaked; fall back to a short grace timeout on older runtimes.
    const withIdle = server as Http2SecureServer & { closeIdleConnections?: () => void };
    if (typeof withIdle.closeIdleConnections === "function") withIdle.closeIdleConnections();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 500);
      if (typeof t.unref === "function") t.unref();
      server!.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
    server = null;
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const BAD_HEADER = "x-kinetex-bad"; // value carries a 0x07 control char (BEL)

function mkReq(headers: Record<string, string>): KinetexRequest {
  return {
    url: `${baseURL}/echo`,
    method: "GET",
    headers,
    body: null,
    signal: null,
    meta: {},
  };
}

function mkTransport(
  opts: { strict?: boolean; onDroppedHeader?: (name: string, value: string) => void } = {},
): NodeHTTP2Transport {
  return new NodeHTTP2Transport({
    ca: TLS_CERT,
    pingIntervalMs: 0, // no keepalive timers in tests
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    ...opts,
  });
}

/** True once the callback has fired (it is called synchronously during send). */
async function waitForDrop(
  dropped: Array<{ name: string; value: string }>,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (dropped.length === 0 && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  return dropped.length > 0;
}

/** Let any stray event-loop callbacks settle before assertions. */
async function settleTicks(ticks = 2): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise<void>((r) => setTimeout(r, 1));
}

/**
 * A hung test must fail, not stall the runner. The default budget is infinite,
 * so a session that never opens would leave the whole file hanging with no
 * diagnostic; 45 s is far above the ~10 s transport timeouts configured below
 * and still bounded.
 */
const TEST_BUDGET_MS = 45_000;

function h2Test(name: string, options: TestOptions, fn: () => void | Promise<void>): void {
  test(name, { ...options, timeout: TEST_BUDGET_MS, skip: SKIP_REASON || options.skip }, fn);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

h2Test(
  "non-strict: forbidden header is dropped, callback fires, request succeeds",
  {},
  async () => {
    const dropped: Array<{ name: string; value: string }> = [];
    const transport = mkTransport({
      onDroppedHeader: (name, value) => dropped.push({ name, value }),
    });
    try {
      // Accounting is relative to what the server has already seen, like every
      // other test in this file. An absolute index made this one test fail if
      // a stray request ever arrived first, which is the wrong diagnosis.
      const seenBefore = receivedRequests.length;
      const raw = await transport.send(mkReq({ "x-clean": "yes", [BAD_HEADER]: "bad\u0007value" }));
      assert.equal(raw.status, 200);
      assert.ok(await waitForDrop(dropped), "onDroppedHeader was not called");

      assert.equal(dropped.length, 1, "exactly the one invalid header is reported");
      assert.equal(dropped[0]!.name, BAD_HEADER);
      assert.equal(dropped[0]!.value, "bad\u0007value");

      // The invalid header must NOT have reached the server; the clean one must.
      assert.equal(receivedRequests.length, seenBefore + 1, "exactly one request must be sent");
      const seen = receivedRequests[seenBefore]!;
      assert.equal(seen.path, "/echo");
      assert.equal(seen.headers["x-clean"], "yes");
      assert.ok(!(BAD_HEADER in seen.headers));
      // Nothing else rode along, and no header was invented on the way.
      assert.deepEqual(Object.keys(seen.headers).sort(), ["x-clean"]);
    } finally {
      transport.destroy();
    }
  },
);

h2Test("non-strict without callback: warns on console, request still succeeds", {}, async () => {
  const transport = mkTransport();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const seenBefore = receivedRequests.length;
    const raw = await transport.send(mkReq({ [BAD_HEADER]: "bad\u001Bvalue" }));
    assert.equal(raw.status, 200);
    await settleTicks();
    assert.ok(
      warnings.some((w) => w.includes("Invalid header dropped (HTTP/2)") && w.includes(BAD_HEADER)),
      `expected an HTTP/2 drop warning, got: ${JSON.stringify(warnings)}`,
    );
    // The request still goes out (without the invalid header).
    assert.equal(receivedRequests.length, seenBefore + 1);
    assert.ok(!(BAD_HEADER in receivedRequests[seenBefore]!.headers));
  } finally {
    console.warn = origWarn;
    await settleTicks(); // let in-flight warns finish before restoring listeners
    transport.destroy();
  }
});

h2Test(
  "strict mode: forbidden header throws KinetexError EVALIDATION before send",
  {},
  async () => {
    const transport = mkTransport({ strict: true });
    const seenBefore = receivedRequests.length;
    try {
      await assert.rejects(
        () => transport.send(mkReq({ [BAD_HEADER]: "bad\u0000value" })),
        (err: unknown) => {
          assert.ok(err instanceof KinetexError, `expected KinetexError, got ${String(err)}`);
          assert.equal((err as KinetexError).code, "EVALIDATION");
          assert.match((err as Error).message, /forbidden control characters/);
          return true;
        },
      );
      assert.equal(
        receivedRequests.length,
        seenBefore,
        "request must not reach the server in strict mode",
      );
    } finally {
      transport.destroy();
    }
  },
);

h2Test("baseline: clean headers are sent verbatim over HTTP/2", {}, async () => {
  const transport = mkTransport();
  try {
    const seenBefore = receivedRequests.length;
    const raw = await transport.send(mkReq({ "x-kinetex-h2": "yes" }));
    assert.equal(raw.status, 200);
    assert.equal(receivedRequests.length, seenBefore + 1);
    assert.equal(receivedRequests[seenBefore]!.headers["x-kinetex-h2"], "yes");
  } finally {
    transport.destroy();
  }
});

// ── Regressions (h2 header-drop round) ───────────────────────────────────
//
// The request line belongs to the transport. A caller-supplied pseudo-header
// used to be spread over the transport's own `:path` / `:authority` /
// `:method` / `:scheme`, and the validation loop skipped every name starting
// with ":" — so the URL that `isSafeURL` screened was not the URL that got
// dialled, `strict: true` returned 200 for a hijacked `:path`, and
// `FetchTransport` dropped the very same header. The tests below pin the
// refusal, the parity, and the fact that the refusal is *reported* rather
// than silent.

/** A `KinetexRequest` whose URL is the local server's own `/echo`. */
function mkReqAt(headers: Record<string, string>, path = "/echo"): KinetexRequest {
  return { ...mkReq(headers), url: `${baseURL}${path}` };
}

h2Test("regression: a caller-supplied :path cannot redirect the request", {}, async () => {
  const dropped: Array<{ name: string; value: string }> = [];
  const transport = mkTransport({
    onDroppedHeader: (name, value) => dropped.push({ name, value }),
  });
  try {
    const seenBefore = receivedRequests.length;
    const raw = await transport.send(mkReqAt({ ":path": "/hijacked", "x-clean": "yes" }));
    assert.equal(raw.status, 200);
    assert.ok(await waitForDrop(dropped), "a refused pseudo-header must be reported");
    assert.deepEqual(
      dropped.map((d) => d.name),
      [":path"],
    );
    assert.equal(dropped[0]!.value, "/hijacked");
    // The path on the wire is the one the URL argument carried.
    assert.equal(receivedRequests.length, seenBefore + 1);
    assert.equal(receivedRequests[seenBefore]!.path, "/echo");
    // The path on the wire is exactly the URL argument's — not the override,
    // and not a second hop somewhere else.
    assert.equal(receivedRequests.length, seenBefore + 1);
  } finally {
    transport.destroy();
  }
});

h2Test("regression: a caller-supplied :authority cannot spoof the Host", {}, async () => {
  const dropped: string[] = [];
  const transport = mkTransport({ onDroppedHeader: (name) => dropped.push(name) });
  try {
    const seenBefore = receivedRequests.length;
    const raw = await transport.send(mkReq({ ":authority": "evil.example.com" }));
    assert.equal(raw.status, 200);
    assert.ok(await waitForDrop(dropped), "a refused pseudo-header must be reported");
    assert.deepEqual(dropped, [":authority"]);
    // The authority is this server's own host:port, not the spoofed name.
    const port = new URL(baseURL).port;
    assert.equal(receivedRequests[seenBefore]!.authority, `localhost:${port}`);
    assert.equal(receivedRequests[seenBefore]!.scheme, "https");
  } finally {
    transport.destroy();
  }
});

h2Test("regression: strict mode refuses a pseudo-header before dialling", {}, async () => {
  const transport = mkTransport({ strict: true });
  const seenBefore = receivedRequests.length;
  try {
    await assert.rejects(
      () => transport.send(mkReq({ ":path": "/strict-hijack" })),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError, `expected KinetexError, got ${String(err)}`);
        assert.equal((err as KinetexError).code, "EVALIDATION");
        assert.match((err as Error).message, /is not a valid header name/);
        return true;
      },
    );
    assert.equal(
      receivedRequests.length,
      seenBefore,
      "nothing may reach the server in strict mode",
    );
  } finally {
    transport.destroy();
  }
});

h2Test("regression: both transports refuse the same pseudo-header", {}, async () => {
  // Parity, stated as a contract rather than left to a reader of the two
  // code paths: one request, two transports, one answer.
  const h2Dropped: string[] = [];
  const h2 = mkTransport({ onDroppedHeader: (name) => h2Dropped.push(name) });
  try {
    await h2.send(mkReq({ ":path": "/parity" }));
  } finally {
    h2.destroy();
  }
  assert.deepEqual(h2Dropped, [":path"]);

  const fetchDropped: string[] = [];
  const ft = new FetchTransport({
    fetchFn: (async () =>
      new Response("{}", {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    onDroppedHeader: (name) => fetchDropped.push(name),
  });
  await ft.send(mkReq({ ":path": "/parity" }));
  assert.deepEqual(
    fetchDropped,
    [":path"],
    "FetchTransport must refuse the identical header, or the two disagree",
  );
});

h2Test("regression: a __proto__ header is sent, not silently eaten", {}, async () => {
  // `{ __proto__: "v" }` written as an object *literal* sets the prototype and
  // never becomes an own property, so the hostile map has to be built by
  // parse — which is also how it arrives from JSON in the real world.
  const headers = JSON.parse('{"__proto__":"polluted","x-clean":"yes"}') as Record<string, string>;
  assert.ok(Object.hasOwn(headers, "__proto__"), "the fixture must own the key");

  const dropped: string[] = [];
  const warns: string[] = [];
  const transport = mkTransport({ onDroppedHeader: (name) => dropped.push(name) });
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const seenBefore = receivedRequests.length;
    const raw = await transport.send(mkReq(headers));
    assert.equal(raw.status, 200);
    await settleTicks();
    // `__proto__` is made of token characters, so it is a *valid* header name:
    // it must be sent, and it must not be reported as dropped either.
    assert.deepEqual(dropped, [], "a valid header must not be reported as dropped");
    assert.ok(
      !warns.some((w) => w.includes("__proto__")),
      `a valid header must not warn: ${JSON.stringify(warns)}`,
    );
    const seen = receivedRequests[seenBefore]!;
    assert.equal(seen.headers["x-clean"], "yes");
    assert.equal(seen.headers["__proto__"], "polluted");
    // And the assignment must not have touched the prototype chain.
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  } finally {
    console.warn = origWarn;
    transport.destroy();
  }
});

h2Test("validation runs per hop: a dropped header does not poison the session", {}, async () => {
  const dropped: Array<{ name: string; value: string }> = [];
  const transport = mkTransport({
    onDroppedHeader: (name, value) => dropped.push({ name, value }),
  });
  try {
    const seenBefore = receivedRequests.length;
    // First request drops the bad header (the request still proceeds with the
    // remaining headers), second is fully clean — the shared session must stay
    // usable and validation must apply again per request.
    await transport.send(mkReq({ [BAD_HEADER]: "bad\u0007value" }));
    const raw = await transport.send(mkReq({ "x-after-drop": "ok" }));
    assert.equal(raw.status, 200);
    assert.equal(await waitForDrop(dropped), true);
    assert.equal(dropped.length, 1, "the clean second hop must not report a drop");
    assert.equal(receivedRequests.length, seenBefore + 2);
    assert.ok(!(BAD_HEADER in receivedRequests[seenBefore]!.headers));
    assert.equal(receivedRequests[seenBefore + 1]!.headers["x-after-drop"], "ok");
  } finally {
    transport.destroy();
  }
});
