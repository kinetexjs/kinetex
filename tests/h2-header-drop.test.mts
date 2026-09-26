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

import { NodeHTTP2Transport } from "../src/core.ts";
import { KinetexError } from "../src/types.ts";
import type { KinetexRequest } from "../src/types.ts";

// ── Throwaway TLS material (generated per run; nothing committed) ────────────

let opensslAvailable = false;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
  opensslAvailable = true;
} catch {
  // openssl not on PATH — tests below skip with a reason.
}

const SKIP_REASON = opensslAvailable ? false : "openssl is not available on this machine";

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

/** One entry per request received: pseudo-headers stripped, all others kept. */
const receivedRequests: Array<{ path: string; headers: Record<string, string> }> = [];

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
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(reqHeaders)) {
      if (name.startsWith(":")) continue; // strip :method/:path/:authority/...
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    receivedRequests.push({ path: String(reqHeaders[":path"] ?? ""), headers });
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

function h2Test(name: string, options: TestOptions, fn: () => void | Promise<void>): void {
  test(name, { ...options, skip: SKIP_REASON || options.skip }, fn);
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
      const raw = await transport.send(mkReq({ "x-clean": "yes", [BAD_HEADER]: "bad\u0007value" }));
      assert.equal(raw.status, 200);
      assert.ok(await waitForDrop(dropped), "onDroppedHeader was not called");

      assert.equal(dropped[0]!.name, BAD_HEADER);
      assert.equal(dropped[0]!.value, "bad\u0007value");

      // The invalid header must NOT have reached the server; the clean one must.
      assert.equal(receivedRequests.length, 1);
      assert.equal(receivedRequests[0]!.path, "/echo");
      assert.equal(receivedRequests[0]!.headers["x-clean"], "yes");
      assert.ok(!(BAD_HEADER in receivedRequests[0]!.headers));
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
    assert.equal(receivedRequests.length, seenBefore + 2);
    assert.ok(!(BAD_HEADER in receivedRequests[seenBefore]!.headers));
    assert.equal(receivedRequests[seenBefore + 1]!.headers["x-after-drop"], "ok");
  } finally {
    transport.destroy();
  }
});
