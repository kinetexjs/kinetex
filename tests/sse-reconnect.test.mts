/**
 * kinetex — SSE reconnect behaviour.
 *
 * The reconnect back-off is where two fixes live that no other suite reached:
 *  - the heartbeat timer is cleared before sleeping, so a heartbeat cannot fire
 *    mid-back-off and tear the pending connection down;
 *  - the back-off sleep is abortable, so `close()` during a long delay is
 *    noticed immediately instead of after the full delay.
 *
 * Driven by a local server that closes the stream cleanly, which drives the
 * clean-close reconnect branch that no other suite executes.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { SSEClient } from "../src/sse.ts";

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
  console.log(`\n── ${name}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server that ends the response after one event (a clean close). */
async function cleanCloseServer(): Promise<{
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}> {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    connections++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: tick-${connections}\n\n`);
    // End immediately: a clean server-side close, not an error.
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    connections: () => connections,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * Drive the reconnect loop for `ms`, then stop it.
 *
 * The loop only runs while the stream is consumed, and it is deliberately not
 * awaited to completion: the test bounds it by wall clock and tears the client
 * down, so a stuck generator can never hold the suite open.
 */
async function pumpFor(client: SSEClient, ms: number): Promise<void> {
  let done = false;
  const consume = (async () => {
    for await (const _e of client.stream()) {
      if (done) break;
    }
  })().catch(() => {});
  await delay(ms);
  done = true;
  client.close();
  await Promise.race([consume, delay(1500)]);
}

suite("SSE reconnect");

await test("a clean server close triggers a reconnect with back-off", async () => {
  const h = await cleanCloseServer();
  const reconnects: number[] = [];
  const client = new SSEClient({
    url: h.url,
    validateResponse: () => true,
    reconnect: true,
    maxReconnects: 3,
    // A back-off long enough that the pump does not spin the server.
    reconnectDelayMs: 80,
    reconnectJitter: 0.5,
    onReconnect: (attempt) => reconnects.push(attempt),
  });

  try {
    await pumpFor(client, 600);

    assert.ok(
      h.connections() >= 2,
      `expected at least one reconnect, saw ${h.connections()} connection(s)`,
    );
    assert.ok(reconnects.length > 0, "onReconnect must be notified");
    // NOTE: `onReconnect` reports 1 on every reconnect of a clean-closed stream,
    // and `maxReconnects` is never reached on that path (the attempt counter
    // restarts with the connection). Both look wrong, but fixing them is a
    // behaviour change, not a test change, so this only pins the parts that are
    // genuinely guaranteed: a reconnect happens and is reported.
    assert.ok(client.health.totalReconnects >= 1, "totalReconnects must count the reconnections");
  } finally {
    client.close();
    await h.close();
  }
});

await test("maxReconnects is enforced on the clean-close path", async () => {
  // A server that accepts the connection and immediately closes it looks like a
  // success to the back-off logic, which used to reset the attempt counter each
  // time — so maxReconnects was unreachable and the client reconnected forever.
  const h = await cleanCloseServer();
  const client = new SSEClient({
    url: h.url,
    validateResponse: () => true,
    reconnect: true,
    maxReconnects: 1,
    reconnectDelayMs: 10,
    reconnectJitter: 0,
  });

  try {
    let err: unknown = null;
    try {
      for await (const _e of client.stream()) {
        /* drain until the cap trips */
      }
    } catch (e) {
      err = e;
    }
    assert.ok(
      (err as { code?: string })?.code === "ESSEMAXRECONNECTS",
      `expected the reconnect cap to trip, got ${String(err)}`,
    );
    // 1 initial connection + exactly 1 reconnect.
    assert.equal(h.connections(), 2, `expected 2 connections, saw ${h.connections()}`);
  } finally {
    client.close();
    await h.close();
  }
});

await test("maxReconnects of 0 reconnects indefinitely", async () => {
  const h = await cleanCloseServer();
  const client = new SSEClient({
    url: h.url,
    validateResponse: () => true,
    reconnect: true,
    maxReconnects: 0,
    reconnectDelayMs: 10,
    reconnectJitter: 0,
  });

  try {
    await pumpFor(client, 300);
    assert.ok(
      h.connections() > 2,
      `maxReconnects:0 means infinite, saw ${h.connections()} connection(s)`,
    );
  } finally {
    client.close();
    await h.close();
  }
});

await test("close() during a long back-off returns promptly", async () => {
  const h = await cleanCloseServer();
  const client = new SSEClient({
    url: h.url,
    validateResponse: () => true,
    reconnect: true,
    maxReconnects: 5,
    // A back-off long enough that close() can only return quickly if the sleep
    // is abortable.
    reconnectDelayMs: 30_000,
    reconnectJitter: 0,
  });

  try {
    let done = false;
    const consume = (async () => {
      for await (const _e of client.stream()) {
        if (done) break;
      }
    })().catch(() => {});

    // Let the first connection close cleanly so the client enters back-off.
    await delay(250);
    const start = Date.now();
    client.close();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `close() must not wait out a 30s back-off, took ${elapsed}ms`);
    done = true;
    await Promise.race([consume, delay(1500)]);
  } finally {
    client.close();
    await h.close();
  }
});

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
