/**
 * kinetex — browser Node-builtin shims.
 *
 * `src/shims/browser-node.ts` is aliased over `node:*` in the browser build so
 * esbuild can resolve Node-only imports that the browser path never executes.
 * None of those branches run in the Node suite, which left the whole shim file
 * outside coverage even though a broken shim would break the published bundle.
 *
 * These tests import the module directly and pin its contract: safe fallbacks
 * degrade, transports fail with a clear message, and nothing accidentally
 * starts depending on a Node builtin.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as shims from "../src/shims/browser-node.ts";

function unsupported(name: string): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof Error, `${name} must throw an Error`);
    assert.match(err.message, /is not available in this runtime/);
    return true;
  };
}

test("lookup fails the callback with ENOTSUP so the preflight is skipped", () => {
  let seen: unknown = null;
  let called = 0;
  shims.lookup("example.com", {}, (err) => {
    called++;
    seen = err;
  });
  assert.equal(called, 1, "the callback must run synchronously");
  assert.ok(seen instanceof Error);
  assert.equal((seen as NodeJS.ErrnoException).code, "ENOTSUP");
});

test("isIP reports no literal so the Node-only caller takes its fallback", () => {
  assert.equal(shims.isIP("127.0.0.1"), 0);
  assert.equal(shims.isIP("::1"), 0);
});

test("connect and request fail instead of returning a fake socket", () => {
  assert.throws(() => shims.connect(), unsupported("connect"));
  assert.throws(() => shims.request(), unsupported("request"));
});

test("Node-only classes fail at construction", () => {
  assert.throws(() => new shims.Agent(), unsupported("Agent"));
  assert.throws(() => new shims.Readable(), unsupported("Readable"));
  assert.throws(() => new shims.TLSSocket(), unsupported("TLSSocket"));
  assert.throws(() => new shims.Socket(), unsupported("Socket"));
});

test("decompressors fail instead of silently returning empty bytes", () => {
  assert.throws(() => shims.createBrotliDecompress(), unsupported("brotli"));
  assert.throws(() => shims.createZstdDecompress(), unsupported("zstd"));
  assert.throws(() => shims.createGunzip(), unsupported("gunzip"));
  assert.throws(() => shims.createInflate(), unsupported("inflate"));
});

test("safe fallbacks keep their documented values", () => {
  assert.equal(shims.domainToUnicode("xn--bcher-kva.example"), "xn--bcher-kva.example");
  assert.deepEqual(shims.globalAgent, {});
  assert.deepEqual(shims.constants, {});
});
