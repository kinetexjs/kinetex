import assert from "node:assert/strict";
import {
  safeJSONParse,
  tryParseJSON,
  parseUntrustedJSON,
  isUint8Array,
  isArrayBuffer,
  isReadableStream,
  isHeaders,
  isAbortSignal,
  isPlainObject,
  isFormData,
  isBlob,
  isURLSearchParams,
  isValidHeaderName,
  isValidHeaderValue,
  isSafeURL,
  sanitizeURL,
  createStructuredError,
  formatError,
  perfNow,
  sleep,
  concatUint8Arrays,
  toUint8Array,
  uint8ArrayToBase64,
  deepClone,
  mergeSignals,
  isAbortError,
  getRuntime,
  isNodeEnvironment,
  isBrowserEnvironment,
  hasNativeFetch,
  normalizeHeaders,
} from "../src/utils.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

// ============================================================================
// §1  safeJSONParse
// ============================================================================

suite("safeJSONParse");

await test("parses valid JSON", () => {
  const r = safeJSONParse('{"a":1,"b":"two"}');
  assert.equal(r.success, true);
  if (r.success) assert.deepEqual(r.value, { a: 1, b: "two" });
});

await test("returns PARSE_ERROR for invalid JSON", () => {
  const r = safeJSONParse("not json");
  assert.equal(r.success, false);
  assert.equal(r.error, "PARSE_ERROR");
});

await test("returns STRING_TOO_LONG when input exceeds maxStringLength", () => {
  const r = safeJSONParse('"x"', { maxStringLength: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error, "STRING_TOO_LONG");
});

await test("returns DEPTH_EXCEEDED when depth limit exceeded", () => {
  const deep = '{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}';
  const r = safeJSONParse(deep, { maxDepth: 3 });
  assert.equal(r.success, false);
  assert.equal(r.error, "DEPTH_EXCEEDED");
});

await test("returns ARRAY_LENGTH_EXCEEDED when array too long", () => {
  const r = safeJSONParse("[1,2,3,4,5,6,7,8,9,10]", { maxArrayLength: 5 });
  assert.equal(r.success, false);
  assert.equal(r.error, "VALIDATION_FAILED");
});

await test("rejects numeric overflow (1e309 → Infinity) when allowNonFinite false", () => {
  const text = '{"value": 1e309}';
  const r = safeJSONParse(text, { allowNonFinite: false });
  assert.equal(r.success, false);
  assert.equal(r.error, "NON_FINITE_NUMBER");
});

await test("accepts numeric overflow when allowNonFinite true", () => {
  const text = '{"value": 1e309}';
  const r = safeJSONParse(text, { allowNonFinite: true });
  assert.equal(r.success, true);
  if (r.success) assert.ok(!Number.isFinite(r.value.value));
});

await test("rejects -1e309 (negative overflow) when allowNonFinite false", () => {
  const text = '{"value": -1e309}';
  const r = safeJSONParse(text, { allowNonFinite: false });
  assert.equal(r.success, false);
  assert.equal(r.error, "NON_FINITE_NUMBER");
});

await test("default options allow standard JSON", () => {
  const r = safeJSONParse(JSON.stringify({ a: 1, b: [2, 3] }));
  assert.equal(r.success, true);
});

// ============================================================================
// §2  tryParseJSON
// ============================================================================

suite("tryParseJSON");

await test("returns parsed value for valid JSON", () => {
  const r = tryParseJSON<{ x: number }>('{"x":1}');
  assert.equal(typeof r, "object");
  assert.equal((r as any).x, 1);
});

await test("returns input string on parse failure", () => {
  const r = tryParseJSON("not-json");
  assert.equal(r, "not-json");
});

// ============================================================================
// §3  parseUntrustedJSON
// ============================================================================

suite("parseUntrustedJSON");

await test("parses simple JSON", () => {
  const r = parseUntrustedJSON('{"ok":true}');
  assert.equal(r.success, true);
});

await test("fails on invalid input", () => {
  const r = parseUntrustedJSON("broken");
  assert.equal(r.success, false);
});

// ============================================================================
// §4  Type guards
// ============================================================================

suite("Type guards");

await test("isUint8Array with Uint8Array", () => {
  assert.equal(isUint8Array(new Uint8Array(5)), true);
});

await test("isUint8Array with non-Uint8Array", () => {
  assert.equal(isUint8Array("string"), false);
  assert.equal(isUint8Array(null), false);
  assert.equal(isUint8Array(undefined), false);
});

await test("isArrayBuffer with ArrayBuffer", () => {
  assert.equal(isArrayBuffer(new ArrayBuffer(8)), true);
});

await test("isArrayBuffer with non-ArrayBuffer", () => {
  assert.equal(isArrayBuffer(new Uint8Array(5)), false);
});

await test("isReadableStream with ReadableStream", () => {
  const s = new ReadableStream({
    start(c) {
      c.close();
    },
  });
  assert.equal(isReadableStream(s), true);
});

await test("isReadableStream with non-stream", () => {
  assert.equal(isReadableStream({}), false);
});

await test("isHeaders with Headers", () => {
  assert.equal(isHeaders(new Headers()), true);
});

await test("isHeaders with non-Headers", () => {
  assert.equal(isHeaders({}), false);
});

await test("isAbortSignal with AbortSignal", () => {
  assert.equal(isAbortSignal(new AbortController().signal), true);
});

await test("isAbortSignal with non-signal", () => {
  assert.equal(isAbortSignal("string"), false);
  assert.equal(isAbortSignal(42), false);
  assert.equal(isAbortSignal(null), false);
  assert.equal(isAbortSignal(undefined), false);
});

await test("isPlainObject with plain object", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
});

await test("isPlainObject with non-plain", () => {
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});

await test("isFormData with FormData", () => {
  assert.equal(isFormData(new FormData()), true);
});

await test("isBlob with Blob", () => {
  assert.equal(isBlob(new Blob()), true);
});

await test("isURLSearchParams with URLSearchParams", () => {
  assert.equal(isURLSearchParams(new URLSearchParams()), true);
});

// ============================================================================
// §5  isValidHeaderName / isValidHeaderValue
// ============================================================================

suite("Header validation");

await test("isValidHeaderName accepts valid names", () => {
  assert.equal(isValidHeaderName("Content-Type"), true);
  assert.equal(isValidHeaderName("x-custom-header"), true);
});

await test("isValidHeaderName rejects invalid names", () => {
  assert.equal(isValidHeaderName(""), false);
  assert.equal(isValidHeaderName("bad header"), false);
});

await test("isValidHeaderValue accepts valid values", () => {
  assert.equal(isValidHeaderValue("text/html; charset=utf-8"), true);
  assert.equal(isValidHeaderValue(""), true);
});

await test("isValidHeaderValue rejects values with control chars", () => {
  assert.equal(isValidHeaderValue("bad\x00value"), false);
  assert.equal(isValidHeaderValue("bad\x0Avalue"), false);
});

// ============================================================================
// §6  URL safety
// ============================================================================

suite("URL safety");

await test("isSafeURL allows public HTTPS URLs", () => {
  assert.equal(isSafeURL("https://api.example.com/data"), true);
});

await test("isSafeURL rejects private IPs", () => {
  assert.equal(isSafeURL("http://127.0.0.1:8080"), false);
  assert.equal(isSafeURL("http://192.168.1.1"), false);
});

await test("sanitizeURL strips credentials from URL with query params", () => {
  const r = sanitizeURL("https://user:pass@api.example.com/data?token=secret");
  assert.equal(r, "https://api.example.com/data?token=secret");
});

await test("sanitizeURL strips credentials from URL without query", () => {
  const r = sanitizeURL("https://user@api.example.com/data");
  assert.equal(r, "https://api.example.com/data");
});

await test("sanitizeURL returns null for SSRF risk", () => {
  assert.equal(sanitizeURL("http://127.0.0.1:8080/secret"), null);
});

// ============================================================================
// §7  createStructuredError / formatError
// ============================================================================

suite("Structured error");

await test("createStructuredError returns error with code and request", () => {
  const e = createStructuredError("Custom message", {
    code: "EVALIDATION",
    message: "Custom message",
    request: { url: "https://example.com" },
  });
  assert.equal(e.code, "EVALIDATION");
  assert.equal(e.message, "Custom message");
});

// ============================================================================
// §8  perfNow / sleep
// ============================================================================

suite("perfNow / sleep");

await test("perfNow returns positive number", () => {
  const n = perfNow();
  assert.equal(typeof n, "number");
  assert.ok(n > 0);
});

await test("sleep resolves after at least ms", async () => {
  const start = perfNow();
  await sleep(50);
  assert.ok(perfNow() - start >= 30);
});

await test("sleep with pre-aborted signal rejects", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => sleep(1000, ctrl.signal));
});

await test("sleep with abort during wait rejects", async () => {
  const ctrl = new AbortController();
  const p = sleep(1000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p);
});

// ============================================================================
// §9  concatUint8Arrays
// ============================================================================

suite("concatUint8Arrays");

await test("empty input returns empty array", () => {
  const r = concatUint8Arrays([]);
  assert.equal(r.byteLength, 0);
});

await test("single chunk returns copy", () => {
  const data = new Uint8Array([1, 2, 3]);
  const r = concatUint8Arrays([data]);
  assert.deepEqual(Array.from(r), [1, 2, 3]);
  assert.notEqual(r.buffer, data.buffer);
});

await test("multiple chunks concatenated in order", () => {
  const r = concatUint8Arrays([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  assert.deepEqual(Array.from(r), [1, 2, 3, 4]);
});

// ============================================================================
// §10  toUint8Array
// ============================================================================

suite("toUint8Array");

await test("Uint8Array input returns slice", () => {
  const orig = new Uint8Array([5, 6, 7]);
  const r = toUint8Array(orig);
  assert.deepEqual(Array.from(r!), [5, 6, 7]);
  assert.notEqual(r!.buffer, orig.buffer);
});

await test("ArrayBuffer input converts", () => {
  const buf = new ArrayBuffer(4);
  const r = toUint8Array(buf);
  assert.equal(r!.byteLength, 4);
});

await test("string input encodes", () => {
  const r = toUint8Array("hello");
  assert.notEqual(r, null);
  assert.ok(r!.byteLength > 0);
});

await test("null/undefined return null", () => {
  assert.equal(toUint8Array(null), null);
  assert.equal(toUint8Array(undefined), null);
});

// ============================================================================
// §11  uint8ArrayToBase64
// ============================================================================

suite("uint8ArrayToBase64");

await test("encodes small buffer", () => {
  const r = uint8ArrayToBase64(new Uint8Array([72, 101, 108, 108, 111]));
  assert.equal(r, "SGVsbG8=");
});

await test("encodes empty buffer", () => {
  assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
});

// ============================================================================
// §12  deepClone
// ============================================================================

suite("deepClone");

await test("clones plain object", () => {
  const o = { a: 1, b: { c: 2 } };
  const c = deepClone(o);
  assert.deepEqual(c, o);
  assert.notEqual(c, o);
  assert.notEqual(c.b, o.b);
});

await test("clones array", () => {
  const a = [1, [2, 3]];
  const c = deepClone(a);
  assert.deepEqual(c, a);
  assert.notEqual(c, a);
});

await test("clones Date", () => {
  const d = new Date("2024-01-01");
  const c = deepClone(d);
  assert.equal(c.getTime(), d.getTime());
  assert.notEqual(c, d);
});

await test("clones Map", () => {
  const m = new Map([["k", "v"]]);
  const c = deepClone(m);
  assert.equal(c.get("k"), "v");
});

await test("clones Set", () => {
  const s = new Set([1, 2, 3]);
  const c = deepClone(s);
  assert.ok(c.has(1));
});

await test("returns primitives as-is", () => {
  assert.equal(deepClone(42), 42);
  assert.equal(deepClone("hello"), "hello");
  assert.equal(deepClone(null), null);
  assert.equal(deepClone(undefined), undefined);
  assert.equal(deepClone(true), true);
});

// ============================================================================
// §13  mergeSignals
// ============================================================================

suite("mergeSignals");

await test("single signal returns same signal", () => {
  const ctrl = new AbortController();
  const merged = mergeSignals(ctrl.signal);
  assert.equal(merged, ctrl.signal);
});

await test("null/undefined inputs filtered out", () => {
  const ctrl = new AbortController();
  const merged = mergeSignals(null, ctrl.signal, undefined);
  assert.equal(merged, ctrl.signal);
});

await test("all null returns undefined", () => {
  const merged = mergeSignals(null, undefined);
  assert.equal(merged, undefined);
});

await test("two signals merged", () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = mergeSignals(a.signal, b.signal);
  assert.ok(isAbortSignal(merged));
});

await test("aborting merged signal propagates", async () => {
  const a = new AbortController();
  const b = new AbortController();
  const merged = mergeSignals(a.signal, b.signal);
  a.abort();
  assert.ok(merged?.aborted);
  // Reason is structurally equal (same message, same name)
  assert.equal((merged as AbortSignal).reason?.constructor?.name, "DOMException");
});

// ============================================================================
// §14  isAbortError
// ============================================================================

suite("isAbortError");

await test("detects DOMException AbortError", () => {
  const err = new DOMException("Aborted", "AbortError");
  assert.equal(isAbortError(err), true);
});

await test("detects Error with AbortError name", () => {
  const err = new Error("Aborted");
  err.name = "AbortError";
  assert.equal(isAbortError(err), true);
});

await test("rejects non-abort errors", () => {
  assert.equal(isAbortError(new Error("regular")), false);
  assert.equal(isAbortError(new TypeError("type")), false);
});

// ============================================================================
// §15  Runtime detection
// ============================================================================

suite("Runtime detection");

await test("getRuntime returns string", () => {
  const rt = getRuntime();
  assert.equal(typeof rt, "string");
  assert.ok(rt.length > 0);
});

await test("isNodeEnvironment returns boolean", () => {
  assert.equal(typeof isNodeEnvironment(), "boolean");
});

await test("isBrowserEnvironment returns boolean", () => {
  assert.equal(typeof isBrowserEnvironment(), "boolean");
});

await test("hasNativeFetch returns boolean", () => {
  assert.equal(typeof hasNativeFetch(), "boolean");
});

// ============================================================================
// §16  normalizeHeaders
// ============================================================================

suite("normalizeHeaders");

await test("converts Headers to Record", () => {
  const h = new Headers({ "content-type": "text/plain", "x-custom": "val" });
  const r = normalizeHeaders(h);
  assert.equal(r["content-type"], "text/plain");
  assert.equal(r["x-custom"], "val");
});

await test("empty Headers returns empty record", () => {
  assert.deepEqual(normalizeHeaders(new Headers()), {});
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`  Utils tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
console.log(`════════════════════════════════════════════════════════════`);

if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
  process.exit(1);
}
process.exit(0);
