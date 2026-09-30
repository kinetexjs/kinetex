/**
 * kinetex — dispatcher passthrough.
 *
 * `FetchTransport` forwards an opaque `dispatcher` into the fetch init so a
 * caller can supply an `undici` Agent, ProxyAgent or MockAgent. kinetex never
 * constructs or type-checks one, so the tests assert on the *value the runtime
 * receives* rather than on undici's behaviour — which is the whole contract,
 * and keeps the suite dependency-free.
 *
 * The subtle part is that a dispatcher forces the fetch transport: the Node
 * HTTP/2 transport talks to `node:http2` and has no notion of one, so letting
 * it through would be a silent no-op.
 */

import assert from "node:assert/strict";
import { createTransport, FetchTransport, NodeHTTP2Transport } from "../src/core.ts";
import { Kinetex } from "../src/client.ts";

let passed = 0;
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
  }
}

function suite(name: string): void {
  console.log("\n── " + name);
}

/** Captures the init object the transport hands to the runtime's fetch. */
function capturingFetch(): {
  fn: typeof globalThis.fetch;
  inits: RequestInit[];
  urls: string[];
} {
  const inits: RequestInit[] = [];
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init ?? {});
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof globalThis.fetch;
  return { fn, inits, urls };
}

const dispatcher = (): unknown => ({ __marker: "test-dispatcher" });

/** Suppresses the HTTP/2-downgrade warning createTransport emits. */
async function quietly<T>(fn: () => T): Promise<T> {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

// ── Strict ──────────────────────────────────────────────────────────────────

suite("dispatcher — strict");

await test("forwards the dispatcher into the fetch init", async () => {
  const { fn, inits } = capturingFetch();
  const d = dispatcher();
  const transport = new FetchTransport({ fetchFn: fn, dispatcher: d });
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  assert.equal((inits[0] as unknown as { dispatcher?: unknown }).dispatcher, d);
});

await test("omits the key entirely when no dispatcher is set", async () => {
  const { fn, inits } = capturingFetch();
  const transport = new FetchTransport({ fetchFn: fn });
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  // Must be absent, not `undefined`: an explicit undefined would override a
  // dispatcher installed globally on the runtime.
  assert.ok(
    !("dispatcher" in (inits[0] as object)),
    "dispatcher key must not be present when unset",
  );
});

await test("the function-form constructor clears the dispatcher", async () => {
  const { fn, inits } = capturingFetch();
  const transport = new FetchTransport(fn);
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  assert.ok(!("dispatcher" in (inits[0] as object)));
});

await test("createTransport forwards the dispatcher to FetchTransport", async () => {
  const d = dispatcher();
  const transport = await quietly(() =>
    createTransport(undefined, true, undefined, { dispatcher: d }),
  );
  assert.ok(
    transport instanceof FetchTransport,
    "a dispatcher must not leave the request on the HTTP/2 transport",
  );
  assert.equal((transport as unknown as { dispatcher: unknown }).dispatcher, d);
});

await test("client dispatcher reaches the transport", async () => {
  const d = dispatcher();
  const client = await quietly(() => new Kinetex({ dispatcher: d }));
  const transport = (client as unknown as { transport: unknown }).transport;
  assert.ok(transport instanceof FetchTransport);
  assert.equal((transport as unknown as { dispatcher: unknown }).dispatcher, d);
  client.destroy();
});

// ── Regression ─────────────────────────────────────────────────────────────

suite("dispatcher — regression");

await test("regression: a dispatcher forces FetchTransport, not a silent no-op", async () => {
  // The Node HTTP/2 transport has no dispatcher concept. Routing around it is
  // the fix; previously the option would have been accepted and dropped.
  const transport = await quietly(() =>
    createTransport(undefined, true, undefined, { dispatcher: dispatcher() }),
  );
  assert.ok(
    !(transport instanceof NodeHTTP2Transport),
    "must not be an HTTP/2 session that silently ignores the dispatcher",
  );
});

await test("regression: warns when a dispatcher downgrades HTTP/2", async () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await createTransport(undefined, true, undefined, { dispatcher: dispatcher() });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, "expected exactly one warning");
  assert.match(warnings[0], /dispatcher/);
  assert.match(warnings[0], /HTTP\/2/);
});

await test("regression: an explicit undefined dispatcher does not warn or forward", async () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  let transport: unknown;
  try {
    transport = createTransport(undefined, true, undefined, {
      dispatcher: undefined,
    });
  } finally {
    console.warn = original;
  }
  assert.ok(
    transport instanceof NodeHTTP2Transport,
    "an undefined dispatcher must not force the fetch transport",
  );
  assert.equal(warnings.length, 0);
});

await test("regression: a custom fetch and a dispatcher both select FetchTransport", async () => {
  const { fn } = capturingFetch();
  const transport = await quietly(() =>
    createTransport(fn, true, undefined, { dispatcher: dispatcher() }),
  );
  assert.ok(transport instanceof FetchTransport);
  assert.equal((transport as unknown as { fetchFn: unknown }).fetchFn, fn);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

suite("dispatcher — edge cases");

await test("edge: an arbitrary object is accepted without inspection", async () => {
  const { fn, inits } = capturingFetch();
  // Not an Agent, not a function — kinetex must not type-check or unwrap it.
  const weird = { anything: [1, 2, 3], nested: { deep: true } };
  const transport = new FetchTransport({ fetchFn: fn, dispatcher: weird });
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  assert.equal((inits[0] as unknown as { dispatcher?: unknown }).dispatcher, weird);
});

await test("edge: null is forwarded, not treated as absent", async () => {
  const { fn, inits } = capturingFetch();
  const transport = new FetchTransport({ fetchFn: fn, dispatcher: null });
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  assert.equal((inits[0] as unknown as { dispatcher?: unknown }).dispatcher, null);
});

await test("edge: dispatcher survives every request, not just the first", async () => {
  const { fn, inits } = capturingFetch();
  const d = dispatcher();
  const transport = new FetchTransport({ fetchFn: fn, dispatcher: d });
  for (let i = 0; i < 3; i++) {
    await transport.send({
      url: `https://example.com/${i}`,
      method: "GET",
      headers: {},
      body: null,
      signal: null,
      meta: {},
    } as never);
  }
  assert.equal(inits.length, 3);
  for (const init of inits) {
    assert.equal((init as unknown as { dispatcher?: unknown }).dispatcher, d);
  }
});

await test("edge: httpVersion HTTP/1.1 plus a dispatcher still works", async () => {
  const { fn, inits } = capturingFetch();
  const d = dispatcher();
  const transport = await quietly(() => createTransport(fn, false, undefined, { dispatcher: d }));
  await transport.send({
    url: "https://example.com/x",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
  } as never);
  assert.equal((inits[0] as unknown as { dispatcher?: unknown }).dispatcher, d);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err);
  }
  process.exit(1);
}
