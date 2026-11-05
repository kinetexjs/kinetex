/**
 * Patch-coverage tests for src/client.ts changed regions: the HARRecorder
 * timing-breakdown lines 618-622. Line 619 (the direct getEntriesByName
 * branch) is live on Node; lines 620-622 are the getEntriesByType
 * .filter fallback that fires when getEntriesByName is undefined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Kinetex } from "../src/client.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const clientSrc = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

test("patch-coverage: client.ts uses a local ResourceTimingEntry interface, not DOM types", () => {
  assert.ok(
    clientSrc.includes("interface ResourceTimingEntry {"),
    "HARRecorder must read timing through a local interface, not a DOM lib type",
  );
  assert.ok(
    clientSrc.includes("as unknown as ResourceTimingEntry[]"),
    "the resource-timing fallback must cast through the local interface",
  );
  assert.ok(!clientSrc.includes("PerformanceResourceTiming"), "DOM lib types must not leak in");
});

async function startEchoTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

test("patch-coverage: HARRecorder records a request, exercising the timing-breakdown lines", async () => {
  // Lines 618/619 are live on Node (getEntriesByName is a function there).
  const target = await startEchoTarget();
  try {
    const client = new Kinetex({
      baseURL: target.url,
      har: true,
      allowPrivateNetwork: true,
    });
    const res = await client.get("/");
    assert.equal(res.status, 200);
    const har = client.getHAR();
    assert.equal(har.entries.length, 1);
  } finally {
    await target.close();
  }
});

test("patch-coverage: HARRecorder falls back to getEntriesByType when getEntriesByName is missing", async () => {
  // Lines 620-622 (.filter fallback) are only taken when getEntriesByName is
  // undefined. Simulate that by overwriting it on the global performance.
  const target = await startEchoTarget();
  const hadByName = "getEntriesByName" in performance;
  const origByName = performance.getEntriesByName;
  try {
    Object.defineProperty(performance, "getEntriesByName", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const client = new Kinetex({
      baseURL: target.url,
      har: true,
      allowPrivateNetwork: true,
    });
    const res = await client.get("/");
    assert.equal(res.status, 200);
    const har = client.getHAR();
    assert.equal(har.entries.length, 1);
  } finally {
    if (hadByName && origByName) {
      Object.defineProperty(performance, "getEntriesByName", {
        value: origByName,
        writable: true,
        configurable: true,
      });
    }
    await target.close();
  }
});
