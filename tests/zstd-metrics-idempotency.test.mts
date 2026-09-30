/**
 * kinetex — zstd decompression, OTel metrics, and Idempotency-Key.
 *
 * Three unrelated features grouped because each is small; together they cover
 * the rest of the new surface.
 *
 *  - zstd: Cloudflare and other CDNs negotiate it by default, and kinetex used
 *    to warn and hand back still-compressed bytes. The decode path differs by
 *    runtime (Bun has `DecompressionStream("zstd")`; Node does not and needs
 *    `node:zlib`), so both routes are exercised plus the give-up path.
 *  - metrics: `OTelTracer` gained two optional methods. Optional means a
 *    tracer that implements only `startSpan` must keep working.
 *  - idempotency: a generated key must be unique, correctly formatted, and
 *    safe to put in a header.
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decompressStream, applyDecompression } from "../src/response.ts";
import { decompressBodyStream } from "../src/core.ts";
import { generateIdempotencyKey, isValidIdempotencyKey, HeaderName } from "../src/headers.ts";
import { Kinetex } from "../src/client.ts";
import type { OTelSpan } from "../src/client.ts";
import { requireCapability } from "./capability.ts";

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

/** Compress `text` with zstd using whichever API this runtime provides. */
function zstdCompress(text: string): Uint8Array {
  if (typeof zlib.zstdCompressSync === "function") {
    return new Uint8Array(zlib.zstdCompressSync(Buffer.from(text)));
  }
  throw new Error("this runtime has no zstd compressor; cannot build a fixture");
}

const zstdAvailable = typeof zlib.zstdCompressSync === "function";

// Throws in CI when the runtime has no zstd compressor, rather than skipping:
// the round-trip is the only thing proving the decode path works, and a skip
// would report success on a runtime that never exercised it.
const HAVE_ZSTD = requireCapability(
  "a zstd compressor (zlib.zstdCompressSync)",
  zstdAvailable,
  "the zstd round-trip cannot build its own fixture without one",
);

/** Wrap bytes in a one-chunk web stream. */
function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

// ── zstd ────────────────────────────────────────────────────────────────────

suite("zstd decompression");

if (!HAVE_ZSTD) {
  console.log("  ⏭  skipped: this runtime has no zstd compressor");
} else {
  await test("round-trips zstd through decompressStream", async () => {
    const text = "the quick brown fox ".repeat(200);
    const out = await new Response(decompressStream(toStream(zstdCompress(text)), "zstd")).text();
    assert.equal(out, text);
  });

  await test("is case- and whitespace-insensitive on the encoding", async () => {
    const text = "case test payload";
    for (const enc of ["zstd", "ZSTD", " zstd "]) {
      const out = await new Response(decompressStream(toStream(zstdCompress(text)), enc)).text();
      assert.equal(out, text, `failed for ${JSON.stringify(enc)}`);
    }
  });

  await test("handles a multi-chunk compressed stream", async () => {
    const text = "x".repeat(100_000);
    const compressed = zstdCompress(text);
    // Feed it in pieces so the bridge's read loop actually iterates.
    const chunked = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < compressed.length; i += 512) {
          c.enqueue(compressed.slice(i, i + 512));
        }
        c.close();
      },
    });
    const out = await new Response(decompressStream(chunked, "zstd")).text();
    assert.equal(out, text);
  });

  await test("applies zstd through applyDecompression using the header", async () => {
    const text = "header-driven decode";
    const headers = { "content-encoding": "zstd" };
    const out = await new Response(
      applyDecompression(toStream(zstdCompress(text)), headers),
    ).text();
    assert.equal(out, text);
  });

  await test("decompressBodyStream now accepts zstd instead of warning", async () => {
    const text = "core gate allows zstd";
    const headers: Record<string, string> = { "content-encoding": "zstd" };
    const out = await new Response(
      (await decompressBodyStream(toStream(zstdCompress(text)), headers)) as ReadableStream,
    ).text();
    assert.equal(out, text);
  });

  await test("handles an empty zstd payload", async () => {
    const out = await new Response(decompressStream(toStream(zstdCompress("")), "zstd")).text();
    assert.equal(out, "");
  });
}

await test("regression: an unknown encoding passes through untouched", async () => {
  // `decompressStream` has no warn of its own — the gate lives in core.ts,
  // which is asserted separately below.
  const raw = new TextEncoder().encode("passthrough payload");
  const out = await new Response(decompressStream(toStream(raw), "exotic-v9")).text();
  assert.equal(out, "passthrough payload", "unknown encodings must not be decoded");
});

await test("regression: decompressBodyStream still rejects unknown encodings", async () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    const raw = new TextEncoder().encode("passthrough payload");
    const headers: Record<string, string> = { "content-encoding": "exotic-v9" };
    const out = await new Response(
      (await decompressBodyStream(toStream(raw), headers)) as ReadableStream,
    ).text();
    assert.equal(out, "passthrough payload");
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, "the core gate must still warn");
  assert.match(warnings[0], /exotic-v9/);
});

await test("regression: gzip and brotli still work (refactor did not break them)", async () => {
  const text = "still works after the zstd refactor";
  const gz = new Uint8Array(zlib.gzipSync(Buffer.from(text)));
  assert.equal(await new Response(decompressStream(toStream(gz), "gzip")).text(), text);
  const br = new Uint8Array(zlib.brotliCompressSync(Buffer.from(text)));
  assert.equal(await new Response(decompressStream(toStream(br), "br")).text(), text);
  const def = new Uint8Array(zlib.deflateSync(Buffer.from(text)));
  assert.equal(await new Response(decompressStream(toStream(def), "deflate")).text(), text);
});

// ── Decompression fallback branches ─────────────────────────────────────────
//
// `decompressStream` is a three-layer ladder per encoding: the WHATWG
// `DecompressionStream`, then `node:zlib`, then pass the bytes through. On any
// current Node only the first two layers are live, so the lower rungs need
// simulated runtimes to be reachable at all — and each one is a place where a
// silent passthrough could hand a caller compressed bytes with a 200 status.

suite("decompressStream — runtime fallback ladder");

/** Hide a global for the duration of `fn`, restoring it even on throw. */
function withoutGlobals<T>(names: string[], fn: () => T): T {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const n of names) {
    saved.set(n, Object.getOwnPropertyDescriptor(globalThis, n));
    delete (globalThis as Record<string, unknown>)[n];
  }
  try {
    return fn();
  } finally {
    for (const [n, d] of saved) {
      if (d) Object.defineProperty(globalThis, n, d);
    }
  }
}

await test("strict: gzip passes through when DecompressionStream is absent", () => {
  const raw = new TextEncoder().encode("not really gzip");
  const src = toStream(raw);
  const out = withoutGlobals(["DecompressionStream"], () => decompressStream(src, "gzip"));
  assert.equal(out, src, "the same stream object must come back, not a new one");
});

await test("strict: brotli passes through when the runtime is not Node", () => {
  const src = toStream(new TextEncoder().encode("brotli bytes"));
  const out = withoutGlobals(["process"], () => decompressStream(src, "br"));
  assert.equal(out, src, "non-Node runtimes cannot decode br and must not pretend to");
});

await test("strict: zstd passes through when neither decoder is available", () => {
  const src = toStream(new TextEncoder().encode("zstd bytes"));
  const out = withoutGlobals(["DecompressionStream", "process"], () =>
    decompressStream(src, "zstd"),
  );
  assert.equal(out, src);
});

await test("strict: isNodeRuntime survives a `process` getter that throws", () => {
  // A hostile or exotic embedder can make reading `globalThis.process` throw.
  // `isNodeRuntime` is the gate every decompressor consults, so an escaping
  // exception there would abort the response rather than fall through.
  const raw = new TextEncoder().encode("bytes behind a throwing global");
  const src = toStream(raw);
  const saved = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    get() {
      throw new Error("hostile global");
    },
  });
  try {
    const out = decompressStream(src, "br");
    assert.equal(out, src, "must degrade to passthrough, not throw");
  } finally {
    if (saved) Object.defineProperty(globalThis, "process", saved);
  }
});

await test("strict: isNodeRuntime is false when versions.node is not a string", () => {
  const raw = new TextEncoder().encode("bytes behind a spoofed process");
  const src = toStream(raw);
  const saved = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value: { versions: { node: 42 } },
  });
  try {
    assert.equal(decompressStream(src, "br"), src);
  } finally {
    if (saved) Object.defineProperty(globalThis, "process", saved);
  }
});

await test("strict: cancelling the returned stream cancels the source", async () => {
  // The node:zlib bridge owns a reader on the source. If cancelling the
  // output does not cancel the source, an aborted request leaks the upstream
  // connection for the lifetime of the response.
  let cancelled = false;
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(zstdCompress("payload"));
    },
    cancel() {
      cancelled = true;
    },
  });

  const out = decompressStream(src, "zstd");
  await out.cancel();
  // The underlying `cancel()` algorithm runs as a microtask, so assert after
  // yielding rather than racing it.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(cancelled, true, "cancel must propagate to the upstream stream");
});

await test("strict: a source error propagates to the consumer", async () => {
  // The read loop is wrapped in try/catch precisely so a mid-stream upstream
  // failure becomes a rejected response instead of a hung promise.
  const boom = new Error("upstream exploded");
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(zstdCompress("partial"));
      c.error(boom);
    },
  });

  const out = decompressStream(src, "zstd");
  await assert.rejects(() => new Response(out).text(), /exploded|upstream/i);
});

await test("edge: a non-Error upstream failure is wrapped before it reaches zlib", async () => {
  // The read loop is typed to reject with anything the source chose, and a
  // bespoke `ReadableStream` can error with a bare string. `Duplex.destroy()`
  // requires an Error or it throws inside node, taking the request down.
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(zstdCompress("partial"));
      c.error("a bare string, not an Error");
    },
  });

  const out = decompressStream(src, "zstd");
  await assert.rejects(() => new Response(out).text());
});

await test("edge: a source whose cancel rejects does not surface an unhandled rejection", async () => {
  // Releasing the upstream connection can fail — a socket already torn down, a
  // pooled source disposed. The bridge swallows that: the consumer already
  // cancelled, so there is nobody left to tell, and an escaping rejection here
  // would be an unhandled promise rejection that can kill the process.
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(zstdCompress("payload"));
    },
    cancel() {
      return Promise.reject(new Error("release failed"));
    },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const out = decompressStream(src, "zstd");
    // Yield first so the cancel lands *after* the bridge has locked the
    // source, exercising the in-flight cancel path rather than the early one.
    await new Promise((r) => setTimeout(r, 10));
    await out.cancel();
    // Let the rejection settle before checking that nothing escaped.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, [], "a failed source release must stay contained");
});

await test("edge: cancelling before the bridge is ready still releases the source", async () => {
  // `start()` awaits the dynamic `node:zlib` import before it locks the
  // source, so an immediately-cancelled request arrives in that window. If the
  // early cancel is dropped the upstream connection is never released.
  let cancelled = false;
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(zstdCompress("payload"));
    },
    cancel() {
      cancelled = true;
    },
  });

  // No await between construction and cancel: this is the race window.
  const out = decompressStream(src, "zstd");
  await out.cancel();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(cancelled, true, "the early cancel must not be swallowed");
});

await test("edge: an empty zstd payload still round-trips through the bridge", async () => {
  const out = await new Response(decompressStream(toStream(new Uint8Array(0)), "zstd")).text();
  assert.equal(out, "");
});

await test("regression: Node without createZstdDecompress reports a clear error", () => {
  // kinetex supports Node 18+, which predates `zlib.createZstdDecompress`
  // (Node 22). The fallback path must name the problem rather than surface an
  // opaque "create is not a function". The ESM namespace of a builtin is
  // frozen, so this can only be simulated by intercepting the specifier — and
  // `registerHooks` is process-wide, hence the child process.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "kinetex-zstd-"));
  const script = join(dir, "no-zstd.mts");
  try {
    writeFileSync(
      script,
      [
        `import { registerHooks, createRequire } from "node:module";`,
        `import { decompressStream } from ${JSON.stringify(join(repoRoot, "src", "response.ts"))};`,
        ``,
        `// Captured before the hook is installed, so this require is not intercepted.`,
        `const real = createRequire(import.meta.url)("node:zlib");`,
        `globalThis.__kinetexRealZlib = real;`,
        `const names = Object.keys(real).filter((n) => n !== "createZstdDecompress");`,
        `const source =`,
        `  "const z = globalThis.__kinetexRealZlib;\\n" +`,
        `  names.map((n) => \`export const \${n} = z[\${JSON.stringify(n)}];\`).join("\\n");`,
        ``,
        `registerHooks({`,
        `  load(url, ctx, next) {`,
        `    if (url === "node:zlib") return { format: "module", shortCircuit: true, source };`,
        `    return next(url, ctx);`,
        `  },`,
        `});`,
        ``,
        `const src = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });`,
        `try {`,
        `  await new Response(decompressStream(src, "zstd")).text();`,
        `  console.log("THREW_NOTHING");`,
        `} catch (e) {`,
        `  console.log("MESSAGE:" + (e instanceof Error ? e.message : String(e)));`,
        `}`,
      ].join("\n"),
    );

    const r = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    const stdout = r.stdout ?? "";
    assert.equal(
      stdout.includes("THREW_NOTHING"),
      false,
      `the bridge must fail, not silently pass compressed bytes through: ${stdout}${r.stderr ?? ""}`,
    );
    assert.match(stdout, /zstd decompression is not available/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("regression: a decompression bomb is stopped by the size limiter", async () => {
  // `applyDecompression` wraps every decode in a byte counter. Without it a
  // few kilobytes of zstd can expand to an arbitrary amount of memory.
  const bomb = zstdCompress("A".repeat(120_000_000));
  assert.ok(bomb.length < 200_000, `fixture should be tiny, got ${bomb.length} bytes`);

  const out = applyDecompression(toStream(bomb), { "content-encoding": "zstd" });
  const reader = out.getReader();
  let bytes = 0;
  let limitError: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } catch (e) {
    limitError = e;
  }
  assert.ok(limitError !== null, "the limit must trip rather than reading 120MB");
  assert.match(String((limitError as Error).message), /limit|exceed/i);
  assert.ok(bytes <= 100_000_000, `stopped early, read ${bytes} bytes`);
});

// ── Idempotency key ─────────────────────────────────────────────────────────

suite("Idempotency-Key");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

await test("generates a well-formed v4 UUID", () => {
  const key = generateIdempotencyKey();
  assert.match(key, UUID_V4, `malformed key: ${key}`);
  assert.equal(key.length, 36);
});

await test("sets the version and variant bits", () => {
  for (let i = 0; i < 50; i++) {
    const key = generateIdempotencyKey();
    assert.equal(key[14], "4", "version nibble must be 4");
    assert.ok("89ab".includes(key[19] ?? ""), `variant nibble wrong: ${key[19]}`);
  }
});

await test("generates unique keys", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5_000; i++) seen.add(generateIdempotencyKey());
  assert.equal(seen.size, 5_000, "collision in 5000 generated keys");
});

await test("accepts valid keys and rejects unsafe ones", () => {
  assert.equal(isValidIdempotencyKey("abc-123"), true);
  assert.equal(isValidIdempotencyKey(generateIdempotencyKey()), true);
  assert.equal(isValidIdempotencyKey(""), false);
  assert.equal(isValidIdempotencyKey("a".repeat(256)), false);
  assert.equal(isValidIdempotencyKey("a".repeat(255)), true);
  assert.equal(isValidIdempotencyKey("bad\r\nX-Injected: 1"), false, "CRLF must be rejected");
  assert.equal(isValidIdempotencyKey("bad\nvalue"), false);
  assert.equal(isValidIdempotencyKey("bad value"), false, "space is not visible-ASCII");
  assert.equal(isValidIdempotencyKey("naïve"), false, "non-ASCII must be rejected");
  assert.equal(isValidIdempotencyKey(null), false);
  assert.equal(isValidIdempotencyKey(42), false);
});

await test("exposes the header constant", () => {
  assert.equal(HeaderName.IdempotencyKey, "idempotency-key");
});

await test("fluent .idempotencyKey() generates and sets the header", async () => {
  let sent: Record<string, string> = {};
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent = (init?.headers ?? {}) as Record<string, string>;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
  });
  try {
    await client.POST("/charges").withJSON({ amount: 1 }).idempotencyKey().json();
    const key = sent["idempotency-key"];
    assert.ok(key, "header must be set");
    assert.match(key, UUID_V4);
  } finally {
    client.destroy();
  }
});

await test("fluent .idempotencyKey(value) honours an explicit key", async () => {
  let sent: Record<string, string> = {};
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent = (init?.headers ?? {}) as Record<string, string>;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
  });
  try {
    await client.POST("/charges").withJSON({}).idempotencyKey("my-own-key").json();
    assert.equal(sent["idempotency-key"], "my-own-key");
  } finally {
    client.destroy();
  }
});

await test("regression: an unsafe key is refused, not sent", async () => {
  const client = new Kinetex({ baseURL: "https://example.invalid" });
  try {
    assert.throws(
      () => client.POST("/x").withJSON({}).idempotencyKey("bad\r\nX-Injected: 1"),
      TypeError,
    );
    assert.throws(() => client.POST("/x").withJSON({}).idempotencyKey(""), TypeError);
    assert.throws(
      () =>
        client
          .POST("/x")
          .withJSON({})
          .idempotencyKey(123 as unknown as string),
      TypeError,
    );
  } finally {
    client.destroy();
  }
});

await test("regression: retries reuse the same key", async () => {
  // The point of the header is deduplication across attempts; regenerating it
  // per attempt would defeat it entirely.
  const keys: string[] = [];
  let calls = 0;
  const client = new Kinetex({
    baseURL: "https://example.invalid",
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      keys.push(((init?.headers ?? {}) as Record<string, string>)["idempotency-key"] ?? "");
      return new Response("nope", { status: 503 });
    }) as typeof globalThis.fetch,
    retry: { maxRetries: 2, baseDelayMs: 1, statuses: [503], methods: ["POST"] },
  });
  try {
    const builder = client.POST("/charges").withJSON({}).idempotencyKey("stable-key");
    await assert.rejects(() => builder.json());
    assert.equal(calls, 3, "expected the initial attempt plus two retries");
    assert.equal(new Set(keys).size, 1, `keys changed across attempts: ${keys.join(", ")}`);
    assert.equal(keys[0], "stable-key");
  } finally {
    client.destroy();
  }
});

await test("edge: generateIdempotencyKey refuses to run without a CSPRNG", () => {
  // Falling back to Math.random or a counter would silently weaken the one
  // guarantee the header exists for. If the runtime has no CSPRNG the call must
  // fail loudly rather than mint a guessable key.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: undefined },
  });
  try {
    assert.throws(
      () => generateIdempotencyKey(),
      /no CSPRNG|crypto\.getRandomValues/,
      "a runtime without a CSPRNG must not produce a key",
    );
  } finally {
    if (saved) Object.defineProperty(globalThis, "crypto", saved);
  }
});

await test("edge: generateIdempotencyKey works again once the CSPRNG is restored", () => {
  // Proves the previous test restored the global rather than leaving the
  // process without a CSPRNG for every later test.
  assert.match(
    generateIdempotencyKey(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

// ── OTel metrics ────────────────────────────────────────────────────────────

suite("OTel metrics");

/** Minimal span stub. */
const stubSpan = (): OTelSpan => ({
  spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
  setAttribute: () => stubSpan(),
  setStatus: () => stubSpan(),
  setError: () => stubSpan(),
  end: () => undefined,
});

interface MetricCall {
  kind: "histogram" | "counter";
  name: string;
  value: number;
  attributes?: Record<string, string | number | boolean>;
}

/** A tracer that records metrics and can be told to throw. */
function recordingTracer(
  sink: MetricCall[],
  throwOnRecord = false,
): {
  startSpan: (name: string, options?: { kind?: number }) => OTelSpan;
  recordHistogram: (n: string, v: number, a?: Record<string, string | number | boolean>) => void;
  incrementCounter: (n: string, v?: number, a?: Record<string, string | number | boolean>) => void;
} {
  const record = <T,>(
    kind: "histogram" | "counter",
    name: string,
    value: number,
    a?: Record<string, string | number | boolean>,
  ): T => {
    if (throwOnRecord) throw new Error("metrics backend down");
    sink.push({ kind, name, value, attributes: a });
    return undefined as T;
  };
  return {
    startSpan: () => stubSpan(),
    recordHistogram: (n, v, a) => void record("histogram", n, v, a),
    incrementCounter: (n, v = 1, a) => void record("counter", n, v, a),
  };
}

const okFetch = (): typeof globalThis.fetch =>
  (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;

await test("records a duration histogram and a request counter", async () => {
  const sink: MetricCall[] = [];
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  client.setTracer(recordingTracer(sink));
  try {
    await client.get("/users", { retry: false });
  } finally {
    client.destroy();
  }
  assert.deepEqual(
    sink.map((m) => m.name),
    ["http.client.request.duration", "http.client.request.count"],
    "exactly these two instruments, once each, in this order",
  );
  const [hist, count] = sink;
  assert.equal(hist!.kind, "histogram");
  assert.equal(typeof hist!.value, "number", "the histogram value is a number");
  // Seconds, not milliseconds. The mock fetch resolves immediately, so a
  // seconds value is a tiny fraction; a value in the thousands means the
  // conversion was skipped. `>= 0` alone would pass for a hardcoded zero.
  assert.ok(
    hist!.value >= 0 && hist!.value < 1,
    `duration must be seconds, got ${String(hist!.value)}`,
  );
  assert.equal(count!.kind, "counter");
  assert.equal(count!.value, 1);
  // Both instruments must carry the same attributes.
  assert.deepEqual(hist!.attributes, count!.attributes);
});

await test("attributes carry method, host and status", async () => {
  const sink: MetricCall[] = [];
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  client.setTracer(recordingTracer(sink));
  try {
    await client.get("/users", { retry: false });
  } finally {
    client.destroy();
  }
  const m = sink.find((x) => x.name === "http.client.request.count");
  // Assert the metric exists *before* reading it. `sink.find(...)?.attributes?.[k]`
  // yields `undefined` for a missing metric, so field-by-field reads pass
  // vacuously when the whole instrument disappears.
  assert.ok(m, "the request counter must be recorded");
  // deepEqual, not three field checks: this also fails if kinetex starts
  // emitting an attribute this test has not agreed to.
  assert.deepEqual(m.attributes, {
    "http.request.method": "GET",
    "server.address": "api.example.com",
    "http.response.status_code": 200,
  });
});

await test("a failing request records an error counter with error.type", async () => {
  const sink: MetricCall[] = [];
  const client = new Kinetex({
    baseURL: "https://api.example.com",
    fetch: (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch,
  });
  client.setTracer(recordingTracer(sink));
  try {
    await assert.rejects(() => client.get("/x", { retry: false }));
  } finally {
    client.destroy();
  }
  assert.deepEqual(
    sink.map((m) => m.name),
    ["http.client.request.duration", "http.client.request.count", "http.client.error.count"],
    "a failed request still records duration and count, plus the error counter",
  );
  const err = sink.find((m) => m.name === "http.client.error.count");
  assert.ok(err, "error counter must be recorded");
  assert.equal(err.value, 1);
  // The concrete KinetexError code, not merely "some string" — a metric that
  // reported "ENETWORK" for every failure would otherwise pass.
  assert.deepEqual(err.attributes, {
    "http.request.method": "GET",
    "server.address": "api.example.com",
    "error.type": "ENETWORK",
  });
  // No status attribute: there was no response to have a status from.
  assert.equal("http.response.status_code" in (err.attributes ?? {}), false);
});

await test("regression: a span-only tracer keeps working", async () => {
  // The new methods are optional; an existing tracer must not break.
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  client.setTracer({ startSpan: () => stubSpan() });
  try {
    const res = await client.get("/users", { retry: false });
    assert.equal(res.status, 200);
  } finally {
    client.destroy();
  }
});

await test("regression: a throwing metrics backend never fails the request", async () => {
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  client.setTracer(recordingTracer([], true));
  try {
    const res = await client.get("/users", { retry: false });
    assert.equal(res.status, 200, "telemetry must never break a successful request");
  } finally {
    client.destroy();
  }
});

await test("regression: no tracer means no metrics and no crash", async () => {
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  try {
    assert.equal((await client.get("/users", { retry: false })).status, 200);
  } finally {
    client.destroy();
  }
});

await test("edge: metrics measure the whole logical request including retries", async () => {
  const sink: MetricCall[] = [];
  let calls = 0;
  const client = new Kinetex({
    baseURL: "https://api.example.com",
    fetch: (async () => {
      calls++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
  });
  client.setTracer(recordingTracer(sink));
  try {
    await client.get("/x");
  } finally {
    client.destroy();
  }
  assert.equal(calls, 1);
  const counts = sink.filter((m) => m.name === "http.client.request.count");
  assert.equal(counts.length, 1, "exactly one metric per logical request, not per attempt");
});

await test("edge: server.address is derived from the request URL", async () => {
  const sink: MetricCall[] = [];
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  client.setTracer(recordingTracer(sink));
  try {
    await client.get("/x", { retry: false });
  } finally {
    client.destroy();
  }
  const duration = sink.find((c) => c.name === "http.client.request.duration");
  assert.ok(duration, "the histogram must be recorded");
  assert.equal(
    duration!.attributes["server.address"],
    "api.example.com",
    "the hostname is a required OTel attribute",
  );
});

await test("edge: a client with no tracer records nothing and still succeeds", async () => {
  // `_recordMetrics` is called on every request now, so the no-tracer path is
  // the hot path for the majority of clients. It must be a no-op, not a throw.
  const client = new Kinetex({ baseURL: "https://api.example.com", fetch: okFetch() });
  try {
    const res = await client.get("/x", { retry: false });
    assert.equal(res.status, 200);
  } finally {
    client.destroy();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err);
  }
  process.exit(1);
}
