/**
 * kinetex — Regression tests for the transport and request-lifecycle fixes.
 *
 * One test per audit finding, each against a real local server. No public
 * network is used: plain HTTP, TLS with a throwaway openssl certificate, and
 * HTTP/2 over that certificate.
 *
 * Covered:
 *  - KX-07  ALPN refusal falls back to HTTP/1.1, including a replayable body
 *  - KX-08  `ca` survives a forced HTTP/1.1 config; `allowPrivateNetwork`
 *           reaches the fetch fallback
 *  - KX-10  URL userinfo becomes Basic auth and is absent from errors
 *  - KX-11  `timeout` covers a stalled response body
 *  - KX-12  `destroy()` aborts an in-flight body read
 *  - KX-34  `httpVersion` spellings are normalised; unknown values fail fast
 *  - KX-35  an HTTP/2 one-shot exits without `destroy()`
 *  - KX-36  `Alt-Svc` does not rewrite the reported protocol
 *
 * Run: npx tsx tests/transport-fixes.test.mts
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createSecureServer as createH2Server, type Http2SecureServer } from "node:http2";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { kinetex } from "../src/mod.ts";
import type { HTTPVersion } from "../src/types.ts";

// ── Throwaway TLS material (generated per run; nothing committed) ─────────────

let opensslAvailable = false;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
  opensslAvailable = true;
} catch {
  // Tests that need TLS are skipped with a reason below.
}

const TLS_SKIP = opensslAvailable
  ? false
  : "openssl is not available on this machine (TLS tests skipped)";

const REPO_TMP = fileURLToPath(new URL("../tmp/", import.meta.url));
mkdirSync(REPO_TMP, { recursive: true });
const TMP_DIR = mkdtempSync(
  join(tmpdir() === "/tmp" ? REPO_TMP : tmpdir(), `transport-${process.pid}-`),
);
const KEY_PATH = join(TMP_DIR, "key.pem");
const CERT_PATH = join(TMP_DIR, "cert.pem");

let KEY = "";
let CERT = "";

before(() => {
  if (!opensslAvailable) return;
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    KEY_PATH,
    "-out",
    CERT_PATH,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  KEY = readFileSync(KEY_PATH, "utf8");
  CERT = readFileSync(CERT_PATH, "utf8");
});

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function listen(server: Server | HttpsServer | Http2SecureServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeServer(server: Server | HttpsServer | Http2SecureServer): Promise<void> {
  const withIdle = server as typeof server & { closeIdleConnections?: () => void };
  withIdle.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A port that was just bound and released, so connecting to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/**
 * Fail the test instead of hanging the whole file if `promise` never settles.
 * The losing promise is already handled by the caller's then/catch.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A server whose handler writes one byte and then never ends the response. */
interface StallServer {
  port: number;
  headersSent: Promise<void>;
  close: () => Promise<void>;
}

async function startStallServer(): Promise<StallServer> {
  let signalSent: () => void = () => {};
  const headersSent = new Promise<void>((resolve) => {
    signalSent = resolve;
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
    res.write("x");
    signalSent();
    // Deliberately never end.
  });
  const port = await listen(server);
  return {
    port,
    headersSent,
    close: () => closeServer(server),
  };
}

// ── KX-07: ALPN fallback ──────────────────────────────────────────────────────

test("KX-07: an HTTP/1.1-only TLS origin falls back from HTTP/2", { skip: TLS_SKIP }, async () => {
  const seen: string[] = [];
  const bodies: string[] = [];
  const server = createHttpsServer(
    { key: KEY, cert: CERT, ALPNProtocols: ["http/1.1"] },
    (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        seen.push(req.httpVersion);
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`tls-ok:${body}`);
      });
    },
  );
  const port = await listen(server);
  const url = `https://localhost:${port}/`;

  const client = kinetex({
    ca: CERT,
    allowPrivateNetwork: true,
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
  const poster = kinetex({
    ca: CERT,
    allowPrivateNetwork: true,
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
  try {
    // The h2 handshake is refused; the request must be replayed over h1.
    const first = await client.get(url);
    assert.equal(first.status, 200);
    assert.equal(first.data, "tls-ok:");
    assert.equal(first.httpVersion, "HTTP/1.1", "the response must report the protocol used");

    // The origin is remembered: a second request goes straight to h1.
    const second = await client.get(url);
    assert.equal(second.status, 200);
    assert.equal(second.data, "tls-ok:");

    // A replayable body must survive the fallback. A fresh client makes the
    // POST itself the request that loses the h2 handshake.
    const posted = await poster.post(`${url}echo`, "payload", {
      headers: { "content-type": "text/plain" },
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.data, "tls-ok:payload");
  } finally {
    await client.destroy();
    await poster.destroy();
    await closeServer(server);
  }

  assert.deepEqual(seen, ["1.1", "1.1", "1.1"], "every request must reach the origin as h1");
  assert.deepEqual(bodies, ["", "", "payload"]);
});

// ── KX-08: configuration survives the HTTP/1.1 path ──────────────────────────

test("KX-08: custom ca is honoured when HTTP/1.1 is forced", { skip: TLS_SKIP }, async () => {
  const server = createHttpsServer({ key: KEY, cert: CERT }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ca-ok");
  });
  const port = await listen(server);
  const client = kinetex({
    ca: CERT,
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
  try {
    const res = await client.get(`https://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.data, "ca-ok");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("KX-08: allowPrivateNetwork reaches the fetch fallback", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("private-ok");
  });
  const port = await listen(server);
  // A hostname, not an IP literal: only the DNS pre-flight can decide this,
  // and the pre-flight lives on the fetch fallback.
  const client = kinetex({
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
  try {
    const res = await client.get(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.ok(res.rawBody, "the response must expose its raw body");
    assert.equal(new TextDecoder().decode(res.rawBody), "private-ok");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

// ── KX-10: URL userinfo ──────────────────────────────────────────────────────

test("KX-10: URL userinfo becomes Basic auth and is removed from the URL", async () => {
  let seenAuth: string | undefined;
  let seenPath: string | undefined;
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("userinfo-ok");
  });
  const port = await listen(server);
  const client = kinetex({ allowPrivateNetwork: true, retry: { maxRetries: 0 }, timeout: 5_000 });
  try {
    const res = await client.get(`http://user:pa%40ss@127.0.0.1:${port}/path`);
    const expected = `Basic ${Buffer.from("user:pa@ss").toString("base64")}`;
    assert.equal(res.status, 200);
    assert.equal(res.data, "userinfo-ok");
    assert.equal(seenAuth, expected, "the percent-decoded userinfo must be sent as Basic auth");
    assert.equal(seenPath, "/path");
    assert.ok(!res.url.includes("pa%40ss"), `response URL leaked credentials: ${res.url}`);
    assert.ok(!res.url.includes("user:"), `response URL retained userinfo: ${res.url}`);
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("KX-10: a credential URL is absent from connection errors", async () => {
  const port = await closedPort();
  const client = kinetex({ allowPrivateNetwork: true, retry: { maxRetries: 0 }, timeout: 2_000 });
  try {
    await assert.rejects(
      () => client.get(`http://user:supersecret@127.0.0.1:${port}/`),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          !err.message.includes("supersecret"),
          `error message leaked the password: ${err.message}`,
        );
        const cause = (err as { cause?: unknown }).cause;
        assert.ok(
          !String(cause ?? "").includes("supersecret"),
          `error cause leaked the password: ${String(cause)}`,
        );
        const request = (err as { request?: { url?: string } }).request;
        assert.ok(
          !String(request?.url ?? "").includes("supersecret"),
          `error request leaked the password: ${String(request?.url)}`,
        );
        return true;
      },
    );
  } finally {
    await client.destroy();
  }
});

test("KX-10: a redirect Location carrying userinfo is rejected and redacted", async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits++;
    res.end("should-not-arrive");
  });
  const targetPort = await listen(target);
  const origin = createServer((_req, res) => {
    res.writeHead(302, {
      location: `http://redirectuser:redirectsecret@127.0.0.1:${targetPort}/steal`,
    });
    res.end();
  });
  const originPort = await listen(origin);
  const client = kinetex({ allowPrivateNetwork: true, retry: { maxRetries: 0 }, timeout: 5_000 });
  try {
    await assert.rejects(
      () => client.get(`http://127.0.0.1:${originPort}/start`),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          (err as { code?: string }).code,
          "EVALIDATION",
          `unexpected code: ${(err as { code?: string }).code}`,
        );
        assert.match(err.message, /credential/i);
        assert.ok(
          !err.message.includes("redirectsecret"),
          `redirect error leaked the password: ${err.message}`,
        );
        return true;
      },
    );
    assert.equal(targetHits, 0, "the redirect target must never be contacted");
  } finally {
    await client.destroy();
    await closeServer(origin);
    await closeServer(target);
  }
});

// ── KX-11 / KX-12: the body is part of the request lifecycle ─────────────────

test("KX-11: timeout covers a response body that stalls after headers", async () => {
  const stall = await startStallServer();
  const client = kinetex({
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 400,
  });
  const started = Date.now();
  try {
    const outcome = await settleWithin(
      client.get(`http://127.0.0.1:${stall.port}/`).then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "error" as const, err }),
      ),
      4_000,
      "stalled body request",
    );
    const elapsed = Date.now() - started;
    assert.equal(outcome.kind, "error", "a stalled body must not resolve");
    if (outcome.kind === "error") {
      assert.equal(
        (outcome.err as { code?: string }).code,
        "ETIMEOUT",
        `unexpected error: ${String(outcome.err)}`,
      );
    }
    assert.ok(elapsed < 3_000, `timeout fired late: ${elapsed}ms`);
  } finally {
    await client.destroy();
    await stall.close();
  }
});

test("KX-12: destroy() settles a request blocked on a body read", async () => {
  const stall = await startStallServer();
  const client = kinetex({
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 10_000,
  });
  const pending = client.get(`http://127.0.0.1:${stall.port}/`).then(
    () => ({ kind: "resolved" as const }),
    (err: unknown) => ({ kind: "error" as const, err }),
  );
  try {
    await stall.headersSent;
    // Give the client time to actually enter the body read, not just the
    // transport wait.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const destroyStarted = Date.now();
    await client.destroy();
    const outcome = await settleWithin(pending, 2_000, "request after destroy()");
    const settledMs = Date.now() - destroyStarted;

    assert.equal(outcome.kind, "error", "destroy() must reject an in-flight request");
    assert.ok(settledMs < 1_500, `request settled ${settledMs}ms after destroy()`);
  } finally {
    await client.destroy();
    await stall.close();
  }
});

// ── KX-34: httpVersion normalisation ─────────────────────────────────────────

test(
  "KX-34: httpVersion spellings select HTTP/1.x and unknown values fail fast",
  { skip: TLS_SKIP },
  async () => {
    const seen: string[] = [];
    const server = createH2Server({ key: KEY, cert: CERT, allowHTTP1: true });
    server.on("request", (req, res) => {
      seen.push(req.httpVersion);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ saw: req.httpVersion }));
    });
    const port = await listen(server);
    const url = `https://localhost:${port}/`;

    try {
      for (const value of ["HTTP/1.1", "http/1.1", "1.1", "HTTP/1.0"]) {
        const client = kinetex({
          ca: CERT,
          allowPrivateNetwork: true,
          httpVersion: value as unknown as HTTPVersion,
          retry: { maxRetries: 0 },
          timeout: 5_000,
        });
        try {
          const res = await client.get<{ saw: string }>(url);
          assert.equal(res.data.saw, "1.1", `"${value}" must select HTTP/1.x`);
          assert.equal(res.httpVersion, "HTTP/1.1", `"${value}" must report HTTP/1.1`);
        } finally {
          await client.destroy();
        }
      }

      const h2 = kinetex({
        ca: CERT,
        allowPrivateNetwork: true,
        httpVersion: "HTTP/2",
        retry: { maxRetries: 0 },
        timeout: 5_000,
      });
      try {
        const res = await h2.get<{ saw: string }>(url);
        assert.equal(res.data.saw, "2.0");
        assert.equal(res.httpVersion, "HTTP/2");
      } finally {
        await h2.destroy();
      }

      const before = seen.length;
      const bad = kinetex({
        ca: CERT,
        allowPrivateNetwork: true,
        httpVersion: "3" as unknown as HTTPVersion,
        retry: { maxRetries: 0 },
        timeout: 5_000,
      });
      try {
        await assert.rejects(
          () => bad.get(url),
          (err: unknown) => {
            assert.equal(
              (err as { code?: string }).code,
              "EVALIDATION",
              `expected EVALIDATION, got ${String(err)}`,
            );
            return true;
          },
        );
      } finally {
        await bad.destroy();
      }
      assert.equal(seen.length, before, "an invalid version must not reach the server");
    } finally {
      await closeServer(server);
    }
  },
);

// ── KX-35: a one-shot HTTP/2 request lets Node exit ──────────────────────────

test("KX-35: an HTTP/2 one-shot exits without destroy()", { skip: TLS_SKIP }, async () => {
  const moduleUrl = new URL("../src/mod.ts", import.meta.url).href;
  const script = `
import http2 from "node:http2";
import fs from "node:fs";
const { kinetex } = await import(${JSON.stringify(moduleUrl)});
const key = fs.readFileSync(${JSON.stringify(KEY_PATH)});
const cert = fs.readFileSync(${JSON.stringify(CERT_PATH)});
const server = http2.createSecureServer({ key, cert });
server.on("stream", (stream) => {
  stream.respond({ ":status": 200, "content-type": "text/plain" });
  stream.end("ok");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const client = kinetex({ ca: cert, allowPrivateNetwork: true, retry: { maxRetries: 0 }, timeout: 5000, httpVersion: "HTTP/2" });
const res = await client.get("https://localhost:" + port + "/");
console.log("got", res.status, res.httpVersion);
server.close();
// Deliberately no client.destroy().
`;

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, stdout, stderr: `${stderr}\nworker hung until killed` });
      }, 8_000);
      timer.unref?.();
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );

  assert.equal(result.code, 0, `one-shot process did not exit: ${result.stderr}`);
  assert.match(result.stdout, /got 200 HTTP\/2/);
});

// ── KX-36: Alt-Svc is a capability, not the protocol used ────────────────────

test("KX-36: Alt-Svc does not rewrite the reported protocol", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "alt-svc": 'h3=":443"; ma=86400, h2=":443"; ma=86400',
    });
    res.end("h1");
  });
  const port = await listen(server);
  const client = kinetex({
    allowPrivateNetwork: true,
    httpVersion: "HTTP/1.1",
    retry: { maxRetries: 0 },
    timeout: 5_000,
  });
  try {
    const res = await client.get(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(
      res.httpVersion,
      "HTTP/1.1",
      "Alt-Svc advertises what the origin supports, not what answered this request",
    );
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});
