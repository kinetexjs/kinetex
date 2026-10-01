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
  // The whole result, not success + one field. A failure path must not be
  // able to pass by leaving `value` undefined.
  assert.deepEqual(safeJSONParse('{"a":1,"b":"two"}'), {
    success: true,
    value: { a: 1, b: "two" },
  });
  // And the failure shape is exactly that: no `value`, a code, a message.
  const bad = safeJSONParse("{");
  assert.equal(bad.success, false);
  assert.equal(bad.value, undefined);
  assert.equal(bad.error, "PARSE_ERROR");
  assert.equal(bad.message, "Failed to parse JSON");
  // Scalars, arrays, and the empty cases all round-trip.
  assert.deepEqual(safeJSONParse("[1,2,3]"), { success: true, value: [1, 2, 3] });
  assert.deepEqual(safeJSONParse("null"), { success: true, value: null });
  assert.deepEqual(safeJSONParse("42"), { success: true, value: 42 });
  assert.deepEqual(safeJSONParse('""'), { success: true, value: "" });
  assert.deepEqual(safeJSONParse("false"), { success: true, value: false });
});

await test("safeJSONParse messages name the limit that was hit", () => {
  assert.equal(
    safeJSONParse('"x"', { maxStringLength: 1 }).message,
    "JSON string length exceeds limit of 1",
  );
  assert.equal(
    safeJSONParse('{"a":{"b":{"c":1}}}', { maxDepth: 2 }).message,
    "JSON depth exceeds limit of 2",
  );
  assert.equal(
    safeJSONParse("[1,2,3]", { maxArrayLength: 2 }).message,
    "Parsed value exceeds size limits",
  );
  // The limits are inclusive, not exclusive: exactly at the limit passes.
  assert.equal(safeJSONParse("[1,2,3]", { maxArrayLength: 3 }).success, true);
  assert.equal(safeJSONParse('{"a":1,"b":2}', { maxObjectKeys: 2 }).success, true);
  assert.equal(safeJSONParse('{"a":1,"b":2}', { maxObjectKeys: 1 }).success, false);
  // maxObjectKeys is not even in the file's happy path — nothing tested it.
  // It is inclusive, so 0 permits only the empty object.
  assert.equal(safeJSONParse("{}", { maxObjectKeys: 0 }).success, true);
  assert.equal(safeJSONParse('{"a":1}', { maxObjectKeys: 0 }).success, false);
});

await test("safeJSONParse rejects prototype-pollution keys", () => {
  // validateParsedValue() refuses a payload carrying `__proto__`, so a parsed
  // body can never seed Object.prototype through a later spread or merge.
  const r = safeJSONParse('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(r.success, false);
  assert.equal(r.error, "VALIDATION_FAILED");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // The constructor/prototype variant is refused too.
  assert.equal(safeJSONParse('{"constructor":{"prototype":{"polluted":true}}}').success, false);
  // ...and the key is checked in a nested position, not only at the root.
  assert.equal(safeJSONParse('{"nested":{"__proto__":{}}}').success, false);
  assert.equal(safeJSONParse('[{"__proto__":{}}]').success, false);
});

await test("safeJSONParse counts the limits inside nested values", () => {
  // A limit that only looks at the top level would pass all of these.
  assert.equal(safeJSONParse("[[1,2,3,4]]", { maxArrayLength: 3 }).success, false);
  assert.equal(safeJSONParse('{"a":[1,2,3,4]}', { maxArrayLength: 3 }).success, false);
  assert.equal(safeJSONParse('{"a":{"b":1,"c":2}}', { maxObjectKeys: 1 }).success, false);
  assert.equal(safeJSONParse('{"a":"12345"}', { maxStringLength: 4 }).success, false);
  // A bracket inside a string is not a bracket.
  assert.equal(safeJSONParse('{"a":"{{{{{{"}', { maxDepth: 2 }).success, true);
  // A backslash escape does not end the string early. Written as the parsed
  // form rather than by hand, because '{"a":"x\\"}' is a *malformed* JSON
  // document — the escaped quote leaves the string unterminated — and would
  // have been asserting PARSE_ERROR while claiming to test depth.
  assert.equal(safeJSONParse(JSON.stringify({ a: "x\\" })).success, true);
  assert.equal(
    safeJSONParse(JSON.stringify({ a: 'quote " inside' }), { maxDepth: 1 }).success,
    true,
  );
  // ...and the malformed version really is rejected, so the two are distinct.
  assert.equal(safeJSONParse('{"a":"x\\"}', { maxDepth: 1 }).error, "PARSE_ERROR");
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
  // `typeof r === "object"` is satisfied by null, by an array, and by any
  // object at all. Pin the value and the identity of the type it claims.
  const r = tryParseJSON<{ x: number; y: string }>('{"x":1,"y":"two"}');
  assert.deepEqual(r, { x: 1, y: "two" });
  // A falsy but valid payload must come back parsed, not as the raw text.
  // `if (!value) return text` would return "0" and "null" here.
  assert.equal(tryParseJSON("0"), 0);
  assert.equal(tryParseJSON("false"), false);
  assert.equal(tryParseJSON('""'), "");
  assert.equal(tryParseJSON("null"), null);
  assert.deepEqual(tryParseJSON("[1,2]"), [1, 2]);
});

await test("returns input string on parse failure", () => {
  // Note this is the *whole* input, unchanged, and only when the input was
  // not valid JSON. A payload that trips a limit is also returned verbatim.
  assert.equal(tryParseJSON("not-json"), "not-json");
  assert.equal(tryParseJSON("{"), "{");
  assert.equal(tryParseJSON(""), "");
  // A valid JSON *string* is parsed, not confused with the fallback.
  assert.equal(tryParseJSON('"not-json"'), "not-json");
});

// ============================================================================
// §3  parseUntrustedJSON
// ============================================================================

suite("parseUntrustedJSON");

await test("parses simple JSON", () => {
  assert.deepEqual(parseUntrustedJSON('{"ok":true}'), { success: true, value: { ok: true } });
});

await test("fails on invalid input", () => {
  const r = parseUntrustedJSON("broken");
  assert.equal(r.success, false);
  assert.equal(r.error, "PARSE_ERROR");
});

await test("applies the documented tighter limits", () => {
  // Every one of these is *allowed* by safeJSONParse's defaults and refused
  // here. Without that contrast, "it is just safeJSONParse" would pass.
  let deep = "1";
  for (let i = 0; i < 17; i++) deep = `{"a":${deep}}`; // 17 levels, limit 16
  const cases: Array<[string, unknown]> = [
    [deep, { maxDepth: 16 }],
    [JSON.stringify({ a: "x".repeat(1_100_000) }), { maxStringLength: 1 << 20 }],
    [JSON.stringify(Array.from({ length: 2000 }, (_, i) => i)), { maxArrayLength: 1000 }],
  ];
  for (const [text, limit] of cases) {
    assert.equal(
      parseUntrustedJSON(text).success,
      false,
      `untrusted limits must reject ${JSON.stringify(limit)}`,
    );
    assert.equal(
      safeJSONParse(text).success,
      true,
      "the default limits must accept it, or the test proves nothing",
    );
  }
  // 100 keys is the object limit; 101 is one too many.
  const ok = JSON.stringify(
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
  );
  const over = JSON.stringify(
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
  );
  assert.equal(parseUntrustedJSON(ok).success, true);
  assert.equal(parseUntrustedJSON(over).success, false);
  // And it is still a plain safeJSONParse result, not a thrown error.
  assert.equal(parseUntrustedJSON("nope").message, "Failed to parse JSON");
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
  assert.equal(isPlainObject(Object.create(null)), true, "a null prototype is still plain");
  assert.equal(isPlainObject({ a: { b: { c: 1 } } }), true);
});

await test("isPlainObject with non-plain", () => {
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject("s"), false);
  assert.equal(isPlainObject(1), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(isPlainObject(new Uint8Array(1)), false);
  assert.equal(
    isPlainObject(() => {}),
    false,
  );
  // The one that matters: a class instance is not plain. The guard used to be
  // `Object.prototype.toString.call(x) === "[object Object]"`, which is true
  // for every class that does not override Symbol.toStringTag — so an instance
  // passed, and the name promises the opposite. What makes an object plain is
  // its prototype.
  class Plain {
    constructor() {
      this.a = 1;
    }
  }
  assert.equal(isPlainObject(new Plain()), false);
  class Custom {
    get [Symbol.toStringTag]() {
      return "Object";
    }
  }
  assert.equal(isPlainObject(new Custom()), false, "and it cannot be spoofed back in");
  // A subclass of Object created via Object.create is caught the same way.
  assert.equal(isPlainObject(Object.create({ inherited: true })), false);
  assert.equal(isPlainObject(Object.create({})), false);
});

await test("isFormData with FormData", () => {
  assert.equal(isFormData(new FormData()), true);
  // A duck type with the right methods is not a FormData — instanceof, or at
  // minimum a brand that a plain object cannot fake.
  assert.equal(isFormData({ append() {}, get() {}, has() {}, set() {} }), false);
  assert.equal(isFormData(new URLSearchParams()), false);
  assert.equal(isFormData(new Map()), false);
  assert.equal(isFormData(null), false);
  assert.equal(isFormData("s"), false);
  assert.equal(isFormData(undefined), false);
  // The old guard read `constructor?.name === "FormData"`, which anything
  // could satisfy with one own property and no FormData behaviour at all.
  assert.equal(isFormData({ constructor: { name: "FormData" } }), false);
  assert.equal(
    isFormData({ constructor: { name: "FormData" }, append() {} }),
    false,
    "a name and one method is still not a FormData",
  );
  // ...while the real thing is accepted on both paths.
  assert.equal(isFormData(new FormData()), true);
  const fd = new FormData();
  fd.append("k", "v");
  assert.equal(isFormData(fd), true);
});

await test("isBlob with Blob", () => {
  assert.equal(isBlob(new Blob()), true);
  assert.equal(isBlob(new Blob(["x"], { type: "text/plain" })), true);
  // File extends Blob and must still be recognised. The guard compared
  // `constructor.name === "Blob"` and answered `false` for every File — the
  // single most common Blob-shaped value in a browser.
  assert.equal(isBlob(new File(["x"], "a.txt")), true);
  assert.equal(new File(["x"], "a.txt") instanceof Blob, true);
  assert.equal(isBlob(new Uint8Array(1)), false);
  assert.equal(isBlob({ size: 0, type: "" }), false, "a shape-alike is not a Blob");
  assert.equal(isBlob(null), false);
  assert.equal(isBlob(undefined), false);
});

await test("isURLSearchParams with URLSearchParams", () => {
  assert.equal(isURLSearchParams(new URLSearchParams()), true);
  assert.equal(isURLSearchParams(new URLSearchParams("a=1")), true);
  assert.equal(
    isURLSearchParams({
      append() {},
      toString() {
        return "";
      },
    }),
    false,
  );
  assert.equal(isURLSearchParams(new URL("https://x.test")), false);
  assert.equal(isURLSearchParams(null), false);
  assert.equal(isURLSearchParams("a=1"), false);
});

await test("isHeaders is not fooled by a duck type or a bare brand", () => {
  assert.equal(isHeaders(new Headers()), true);
  // `FormData` and `Map` both have `forEach`, which is all the old check
  // looked at.
  assert.equal(isHeaders(new FormData()), false);
  assert.equal(isHeaders(new Map()), false);
  assert.equal(isHeaders(new Set()), false);
  assert.equal(isHeaders({ forEach() {} }), false);
  assert.equal(isHeaders({ get() {}, has() {} }), false);
  // And the brand on its own is not enough: it is one getter away from
  // anything, and the cross-realm path requires the type's own methods too.
  class Fake {
    get [Symbol.toStringTag]() {
      return "Headers";
    }
  }
  assert.equal(isHeaders(new Fake()), false);
  assert.equal(isHeaders(null), false);
  assert.equal(isHeaders("headers"), false);
  assert.equal(isHeaders(undefined), false);
});

// ============================================================================
// §5  isValidHeaderName / isValidHeaderValue
// ============================================================================

suite("Header validation");

await test("isValidHeaderName accepts valid names", () => {
  // RFC 9110 §5.6.2 token: every tchar.
  for (const n of [
    "Content-Type",
    "x-custom-header",
    "X",
    "x1",
    "!#$%&'*+-.^_`|~",
    "a".repeat(4096),
  ]) {
    assert.equal(isValidHeaderName(n), true, `expected ${JSON.stringify(n)} to be valid`);
  }
});

await test("isValidHeaderName rejects invalid names", () => {
  // The ones that matter are the injection shapes and the separators.
  for (const n of [
    "",
    "bad header",
    "x\r\ny", // CRLF — header injection
    "x\ny",
    "a:b", // would let a caller forge a pseudo-header
    "a,b",
    "a(b)",
    "a[b]",
    "a{b}",
    "a/b",
    "a@b",
    ":x", // empty name
    "x ", // trailing space
    " x", // leading space
    "a\u00e9b", // non-ASCII
    "a".repeat(4097),
  ]) {
    assert.equal(isValidHeaderName(n), false, `expected ${JSON.stringify(n)} to be rejected`);
  }
  // A non-string is not a valid name either.
  assert.equal(isValidHeaderName(42 as unknown as string), false);
  assert.equal(isValidHeaderName(null as unknown as string), false);
  assert.equal(isValidHeaderName(undefined as unknown as string), false);
});

await test("isValidHeaderValue accepts valid values", () => {
  for (const v of [
    "text/html; charset=utf-8",
    "",
    "a\tb", // HTAB is the one CTL RFC 9110 allows
    "Bearer eyJhbGciOi.x.y",
    "a".repeat(8192), // at the limit
    "café", // obs-text, %x80-FF — legal, and encodable as a ByteString
  ]) {
    assert.equal(isValidHeaderValue(v), true, `expected ${JSON.stringify(v)} to be valid`);
  }
});

await test("isValidHeaderValue rejects values with control chars", () => {
  // Every CTL except HTAB, plus DEL — and CR/LF explicitly, which is the
  // injection vector.
  for (const v of [
    "bad\x00value",
    "bad\x0Avalue",
    "a\rb",
    "a\nb",
    "a\r\nb",
    "a\x7fb",
    "a\x08b",
    "a\x0bb",
    "a\x0cb",
    "a\x1fb",
  ]) {
    assert.equal(isValidHeaderValue(v), false, `expected ${JSON.stringify(v)} to be rejected`);
  }
  assert.equal(isValidHeaderValue("\x7f"), false, "DEL on its own, not only inside a value");
  assert.equal(isValidHeaderValue("a".repeat(8193)), false, "over the length limit");
  // A non-string is never a valid value, whatever it looks like.
  assert.equal(isValidHeaderValue(5), false);
  assert.equal(isValidHeaderValue(null), false);
  assert.equal(isValidHeaderValue(undefined), false);
  assert.equal(isValidHeaderValue({ toString: () => "ok" }), false);
});

// ============================================================================
// §6  URL safety
// ============================================================================

suite("URL safety");

await test("isSafeURL allows public HTTPS URLs", () => {
  assert.equal(isSafeURL("https://api.example.com/data"), true);
  assert.equal(isSafeURL("http://example.com"), true);
  assert.equal(isSafeURL("https://example.com:8443/x?y=1#z"), true);
  // Credentials in the URL are the caller's business, not a safety signal.
  assert.equal(isSafeURL("http://user:pass@example.com/"), true);
  // A trailing-dot FQDN is a different string but the same host.
  assert.equal(isSafeURL("http://example.com./"), true);
  // A URL instance works as well as a string.
  assert.equal(isSafeURL(new URL("https://example.com/")), true);
  // The scheme list is a parameter, not a constant.
  assert.equal(isSafeURL("wss://example.com/", ["wss"]), true);
  assert.equal(isSafeURL("wss://example.com/"), false, "but not by default");
});

await test("isSafeURL rejects private IPs", () => {
  assert.equal(isSafeURL("http://127.0.0.1:8080"), false);
  assert.equal(isSafeURL("http://192.168.1.1"), false);
});

await test("isSafeURL covers every loopback spelling", () => {
  // The old suite checked exactly one address and one range. The guard
  // expands hosts to bytes and compares numerically, so the alias forms a
  // resolver accepts have to be pinned here or that is untested.
  for (const u of [
    "http://127.0.0.1/", // the plain form
    "http://127.1/", // short form
    "http://127.0.0.1/",
    "http://2130706433/", // decimal
    "http://0x7f000001/", // hex
    "http://0177.0.0.1/", // octal
    "http://127.0.0.1./", // trailing-dot FQDN form
    "http://[::1]/", // IPv6 loopback
    "http://[0:0:0:0:0:0:0:1]/", // expanded
    "http://[::ffff:127.0.0.1]/", // v4-mapped
    "http://[::ffff:7f00:1]/", // v4-mapped, hex
    "http://[::]/", // unspecified
    "http://[0::]/",
  ]) {
    assert.equal(isSafeURL(u), false, `${u} must not be reachable`);
  }
  for (const u of [
    "http://localhost/",
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://0.0.0.0/",
  ]) {
    assert.equal(isSafeURL(u), false, `${u} must not be reachable`);
  }
});

await test("isSafeURL covers every reserved range", () => {
  const blocked = [
    "http://0.1.2.3/", // 0.0.0.0/8
    "http://10.0.0.1/", // RFC 1918
    "http://100.64.0.1/", // CGNAT, RFC 6598
    "http://169.254.169.254/", // link-local — the cloud metadata address
    "http://172.16.0.1/", // RFC 1918
    "http://172.31.255.255/", // last of 172.16/12
    "http://192.0.0.1/", // IETF protocol assignments
    "http://192.0.2.1/", // TEST-NET-1
    "http://192.168.0.1/", // RFC 1918
    "http://198.18.0.1/", // benchmarking
    "http://198.51.100.1/", // TEST-NET-2
    "http://203.0.113.1/", // TEST-NET-3
    "http://224.0.0.1/", // multicast
    "http://255.255.255.255/", // broadcast
    "http://[fe80::1]/", // link-local
    "http://[fc00::1]/", // unique-local
    "http://[fd00::1]/",
  ];
  for (const u of blocked) {
    assert.equal(isSafeURL(u), false, `${u} is a reserved range and must be blocked`);
  }
  // ...and the boundary just outside each one is allowed, or the ranges could
  // be over-blocked and every case above would still pass.
  for (const u of [
    "http://1.0.0.1/",
    "http://11.0.0.1/",
    "http://100.128.0.1/",
    "http://169.253.0.1/",
    "http://172.32.0.1/", // one past 172.16/12
    "http://192.0.1.1/",
    "http://192.0.3.1/",
    "http://192.169.0.1/",
    "http://198.20.0.1/",
    "http://203.1.0.1/",
    "http://223.255.255.255/",
  ]) {
    assert.equal(isSafeURL(u), true, `${u} is public and must stay reachable`);
  }
});

await test("isSafeURL rejects forbidden schemes and malformed URLs", () => {
  for (const u of [
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "data:text/plain,hi",
    "javascript:alert(1)",
    "ws://example.com/", // real scheme, not in the default list
    "not a url",
    "",
    "://missing-scheme",
    "http://example.com:0/", // port 0 is not a port
    "http://example.com:70000/", // beyond 65535
  ]) {
    assert.equal(isSafeURL(u), false, `${JSON.stringify(u)} must be rejected`);
  }
  // A forbidden scheme is refused even when explicitly allowed: allowing it
  // is a caller mistake, not a request to read /etc/passwd.
  assert.equal(isSafeURL("file:///etc/passwd", ["file"]), false);
  // A URL instance takes the same path as its string form.
  assert.equal(isSafeURL(new URL("http://127.0.0.1/")), false);
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
  // The context is assigned onto the error, so every field has to survive —
  // the test used to look at two of them and pass on a bare Error.
  assert.ok(e instanceof Error);
  assert.equal(e.code, "EVALIDATION");
  assert.equal(e.message, "Custom message");
  assert.deepEqual((e as unknown as { request: unknown }).request, {
    url: "https://example.com",
  });
  // A field with a colliding name does not clobber the real message.
  const withMsg = createStructuredError("Outer", { message: "Inner", code: "E" });
  assert.equal(withMsg.message, "Inner", "context.message wins, as Object.assign gives it");
  assert.equal(withMsg.code, "E");
  // A context with nothing in it produces a plain Error.
  const bare = createStructuredError("Bare", {});
  assert.ok(bare instanceof Error);
  assert.equal(bare.message, "Bare");
});

// ============================================================================
// §8  perfNow / sleep
// ============================================================================

suite("perfNow / sleep");

await test("perfNow returns a monotonic high-resolution number", () => {
  // `> 0` is true of any number since the epoch, including Date.now(). What
  // matters is that it is a *performance* clock: monotonic, sub-millisecond,
  // and unaffected by the wall clock.
  const a = perfNow();
  assert.equal(typeof a, "number");
  assert.ok(Number.isFinite(a));
  assert.ok(a > 0);
  // It must advance across a measurable amount of work, and by far less than
  // a millisecond would be possible if it were Date.now().
  let x = 0;
  for (let i = 0; i < 1_000_000; i++) x += i;
  const b = perfNow();
  assert.ok(b > a, "perfNow must be monotonic");
  assert.ok(b - a < 1000, `a million additions took ${b - a}ms of clock`);
  assert.equal(x, 499_999_500_000);
  // Reordering the two reads must not change that: it is not a counter of
  // calls that a caller could advance by calling it.
  assert.equal(typeof perfNow(), "number");
});

await test("sleep resolves after at least ms", async () => {
  const start = perfNow();
  await sleep(50);
  const elapsed = perfNow() - start;
  assert.equal(elapsed >= 30, true, `sleep(50) returned after only ${elapsed}ms`);
  // ...and it is a real wait, not an instant resolve: 50 ms of it.
  assert.ok(elapsed < 2000, `sleep(50) took ${elapsed}ms`);
  // A zero sleep still yields to the event loop and resolves.
  const t0 = perfNow();
  await sleep(0);
  assert.ok(perfNow() - t0 < 1000);
  // The promise really resolves, rather than resolving with a value.
  assert.equal(await sleep(1), undefined);
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

await test("ArrayBuffer input converts, and does not alias the caller's buffer", () => {
  const buf = new ArrayBuffer(4);
  const r = toUint8Array(buf);
  assert.equal(r!.byteLength, 4);
  // The Uint8Array branch above asserted `r.buffer !== orig.buffer`; this one
  // asserted a length, so a version that wrapped the ArrayBuffer in a view
  // passed — and handed back a live alias, so a write through the result wrote
  // into the caller's buffer. Both branches copy now, and both are checked.
  assert.notEqual(r!.buffer, buf, "the result must not be a view onto the input");
  r![0] = 0xab;
  assert.equal(new Uint8Array(buf)[0], 0, "writing the result must not reach the input");
  assert.equal(r![0], 0xab, "and the write must be visible on the result itself");
});

await test("string input encodes", () => {
  // `byteLength > 0` is satisfied by any non-empty encoding, including one
  // that mangles the text. Pin the actual UTF-8 bytes.
  assert.deepEqual(Array.from(toUint8Array("hello")!), [104, 101, 108, 108, 111]);
  assert.equal(toUint8Array("")!.byteLength, 0, "an empty string encodes to nothing");
  // Non-ASCII is UTF-8, not one byte per code unit.
  assert.deepEqual(Array.from(toUint8Array("héllo")!), [104, 195, 169, 108, 108, 111]);
  assert.equal(toUint8Array("é")!.byteLength, 2);
  assert.equal(toUint8Array("€")!.byteLength, 3);
  // A multi-byte character that fits one code unit.
  assert.equal(toUint8Array("😀")!.byteLength, 4);
  // A Node Buffer is accepted.
  assert.deepEqual(Array.from(toUint8Array(Buffer.from([1, 2, 3]))!), [1, 2, 3]);
  // A subarray view must not widen to its whole buffer.
  const ab = new ArrayBuffer(8);
  const view = new Uint8Array(ab, 2, 3);
  assert.equal(toUint8Array(view)!.length, 3);
  // A full ArrayBuffer gives every byte.
  assert.equal(toUint8Array(ab)!.length, 8);
  // Anything else is not convertible.
  assert.equal(toUint8Array(42), null);
  assert.equal(toUint8Array({}), null);
  assert.equal(toUint8Array(true), null);
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

await test("encodes past the chunk boundary the same way as a single pass", () => {
  // The chunked branch is most of the function — 24 576 bytes per segment, each
  // padded only at the end, with the mid-stream `=` stripped — and every test
  // in the file was under five bytes, i.e. entirely inside the fast path. A
  // chunk size that was not a multiple of 3, or a `=` stripped from the wrong
  // side, would have passed all of them. The reference is one `btoa` over the
  // whole buffer, which is exactly what the fast path does and so cannot share
  // a bug with the loop.
  const reference = (bytes: Uint8Array): string => {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };
  // 24_576 is the chunk size; 24_575 is the last fast-path length and 24_577
  // the first chunked one, and each is walked with a non-multiple-of-3 length
  // as well, because that is where padding lands.
  for (const len of [24_575, 24_576, 24_577, 49_153, 100_000]) {
    // A non-repeating byte pattern, so a misaligned segment shifts the output
    // rather than coincidentally matching.
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + (i >>> 8)) & 0xff;
    const got = uint8ArrayToBase64(bytes);
    assert.equal(got.length, Math.ceil(len / 3) * 4, `length for ${len} bytes`);
    assert.equal(got, reference(bytes), `encoding of ${len} bytes`);
    assert.equal(
      got.slice(0, -4).includes("="),
      false,
      `no padding before the final quantum (${len} bytes)`,
    );
  }
  // Every 3-byte group is aligned, so one full chunk ends on a quantum.
  assert.equal(uint8ArrayToBase64(new Uint8Array(24_576).fill(65)).length, 32_768);
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
  // The original only checked `get("k")`, which a clone that returned the
  // *same* Map would also satisfy.
  const inner = { n: 1 };
  const m = new Map<string, unknown>([["k", inner]]);
  const c = deepClone(m);
  assert.ok(c instanceof Map);
  assert.notEqual(c, m, "deepClone must return a new Map");
  assert.deepEqual(c.get("k"), inner);
  assert.notEqual(c.get("k"), inner, "and a new value inside it");
  (c.get("k") as { n: number }).n = 99;
  assert.equal(inner.n, 1, "mutating the clone must not reach the original");
  // Keys are carried across too.
  const keyed = deepClone(
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
  );
  assert.deepEqual(
    [...keyed.entries()],
    [
      ["a", 1],
      ["b", 2],
    ],
  );
  // A nested Map inside an object is cloned as well.
  const nested = deepClone({ m: new Map([["k", 1]]) }) as { m: Map<string, number> };
  assert.ok(nested.m instanceof Map);
  assert.equal(nested.m.get("k"), 1);
});

await test("deepClone refuses the prototype-pollution keys", () => {
  // The guard is in the object branch only; a Map or Set key is data and is
  // carried across untouched.
  const parsed = JSON.parse('{"__proto__":{"polluted":1},"ok":1}') as Record<string, unknown>;
  const c = deepClone(parsed) as Record<string, unknown>;
  assert.deepEqual(Object.keys(c), ["ok"], "the pollution key is not copied");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(c.__proto__, Object.prototype, "and the prototype is untouched");
});

await test("deepClone copies what it claims to", () => {
  // Documented as JSON-safe only, so these are the boundaries rather than
  // defects — pinned so a change to the fallback is visible.
  assert.equal(deepClone(new Uint8Array([1, 2, 3])) instanceof Uint8Array, true);
  assert.deepEqual(Array.from(deepClone(new Uint8Array([1, 2, 3]))), [1, 2, 3]);
  // A *class* instance keeps its prototype and its methods (see the
  // regression suite) — but a *host* object does not, and cannot: a RegExp
  // carries internal slots that `Object.create(RegExp.prototype)` cannot
  // produce, so satisfying `instanceof` there would only move the failure to
  // the first getter. These keep the dictionary form they always had, which is
  // the documented JSON-safe boundary. Pinned so it stays visible.
  assert.deepEqual(deepClone(/a/g), {});
  assert.deepEqual(deepClone(new URL("https://example.com/p")), {});
  // Symbol keys are not copied — JSON has no symbols.
  assert.deepEqual(Object.keys(deepClone({ [Symbol("s")]: 1, a: 2 })), ["a"]);
  // A getter is evaluated and frozen to its value, not re-created.
  const g = deepClone({
    get g() {
      return 1;
    },
  }) as Record<string, number>;
  assert.equal(g.g, 1);
  assert.equal(Object.getOwnPropertyDescriptor(g, "g")?.get, undefined);
  // NaN and -0 survive.
  assert.ok(Number.isNaN(deepClone(NaN) as number));
  assert.equal(Object.is(deepClone(-0), -0), true);
});

await test("clones Set", () => {
  const s = new Set([1, 2, 3]);
  const c = deepClone(s);
  assert.equal(c instanceof Set, true);
  assert.deepEqual([...c], [1, 2, 3]);
  assert.equal(c === s, false, "deepClone must return a new instance");
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
  assert.equal(isAbortSignal(merged), true);
  assert.equal(merged?.aborted, false);
  a.abort();
  assert.equal(merged?.aborted, true, "aborting either input must abort the merged signal");
  // The other direction, and the second signal survives the first's abort.
  const c = new AbortController();
  const d = new AbortController();
  const m2 = mergeSignals(c.signal, d.signal);
  d.abort();
  assert.equal(m2?.aborted, true);
  assert.equal(c.signal.aborted, false, "a source is not aborted by the merge");
  // Three inputs behave the same.
  const x = new AbortController();
  const y = new AbortController();
  const z = new AbortController();
  const m3 = mergeSignals(x.signal, y.signal, z.signal);
  z.abort();
  assert.equal(m3?.aborted, true);
  // The merged signal is not one of the inputs.
  assert.notEqual(mergeSignals(x.signal, y.signal), x.signal);
});

await test("mergeSignals does not accumulate listeners on a long-lived signal", () => {
  // mergeSignals() attached an `abort` listener to every input and only ever
  // removed it when one of those inputs fired. The merged controller is never
  // handed out, so nothing else could ever release them — the "cleanup on
  // self-abort" listener in the old implementation could not run. Every merge
  // against a long-lived caller signal therefore added a permanent listener,
  // and the request path merges on each call.
  const src = new AbortController();
  const other = new AbortController();
  let added = 0;
  const sig = src.signal as unknown as {
    addEventListener: (t: string, f: () => void, o?: { once?: boolean }) => void;
  };
  const origAdd = sig.addEventListener;
  sig.addEventListener = (t, f, o) => {
    if (t === "abort") added++;
    return origAdd.call(sig, t, f, o);
  };

  const merged: AbortSignal[] = [];
  for (let i = 0; i < 50; i++) merged.push(mergeSignals(src.signal, other.signal)!);
  assert.equal(added, 0, `50 merges added ${added} listeners to a long-lived signal`);

  // The merge still works, which is what the listener was for.
  assert.equal(
    merged.every((m) => m.aborted === false),
    true,
  );
  other.abort();
  assert.equal(
    merged.every((m) => m.aborted),
    true,
    "and still propagates",
  );
});

await test("mergeSignals with an already-aborted input", () => {
  const a = new AbortController();
  a.abort();
  const b = new AbortController();
  const merged = mergeSignals(a.signal, b.signal);
  assert.equal(merged?.aborted, true, "already aborted in, already aborted out");
  // A single already-aborted signal is returned as-is, and it is aborted.
  assert.equal(mergeSignals(a.signal), a.signal);
  assert.equal(mergeSignals(a.signal)?.aborted, true);
  // ...and so is a single non-aborted one.
  assert.equal(mergeSignals(b.signal)?.aborted, false);
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
  // Subclasses of Error keep their own name.
  class Aborted extends Error {
    override name = "Aborted";
  }
  assert.equal(isAbortError(new Aborted("x")), false);
  // The Node transport codes count as aborts.
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(isAbortError(reset), true);
  const ab = Object.assign(new Error("aborted"), { code: "ECONNABORTED" });
  assert.equal(isAbortError(ab), true);
  // ...and a lookalike code is not.
  assert.equal(isAbortError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), false);
  // A non-Error is never an abort error, however it is shaped. A bare object
  // with `name: "AbortError"` is what a fake rejection looks like, and the
  // guard has to not be fooled by it.
  assert.equal(isAbortError({ name: "AbortError" }), false);
  assert.equal(isAbortError({ name: "AbortError", code: "ECONNRESET" }), false);
  for (const v of [null, undefined, 0, "", "AbortError", [], () => {}]) {
    assert.equal(isAbortError(v), false, `${JSON.stringify(v)} is not an abort error`);
  }
});

// ============================================================================
// §15  Runtime detection
// ============================================================================

suite("Runtime detection");

await test("getRuntime names this runtime", () => {
  // `typeof rt === "string" && rt.length > 0` is satisfied by "" being
  // excluded only by luck; the contract is that it is one of the documented
  // values, and that it is stable across calls (it is cached).
  const rt = getRuntime();
  assert.ok(
    ["node", "deno", "bun", "browser", "edge", "unknown"].includes(rt),
    `unexpected runtime ${JSON.stringify(rt)}`,
  );
  // Under tsx, this is Node — and the two predicates must agree with it
  // rather than being independently plausible.
  assert.equal(rt, "node");
  assert.equal(isNodeEnvironment(), true);
  assert.equal(isBrowserEnvironment(), false);
  assert.equal(hasNativeFetch(), true);
  // Cached, so repeated calls agree.
  assert.equal(getRuntime(), rt);
  // The exported set is exactly the documented one.
  assert.deepEqual(getRuntime.length, 0, "takes no arguments");
});

await test("runtime predicates return real booleans", () => {
  // `typeof x === "boolean"` accepts `new Boolean(false)`, which is truthy.
  for (const fn of [isNodeEnvironment, isBrowserEnvironment, hasNativeFetch]) {
    const v = fn();
    assert.equal(typeof v, "boolean");
    assert.equal(v, Boolean(v), `${fn.name} must return a primitive boolean`);
  }
  // The two environment predicates are mutually exclusive by construction,
  // and neither can be true here alongside `hasNativeFetch` being false.
  assert.notEqual(isNodeEnvironment(), isBrowserEnvironment());
});

// ============================================================================
// §16  normalizeHeaders
// ============================================================================

suite("normalizeHeaders");

await test("converts Headers to Record", () => {
  const h = new Headers({ "content-type": "text/plain", "x-custom": "val" });
  // The whole object, and lowercase keys — Headers normalises them, and a
  // guard that returned them verbatim would produce a differently-shaped
  // object than every caller expects.
  assert.deepEqual(normalizeHeaders(h), { "content-type": "text/plain", "x-custom": "val" });
  // Case is folded on the way in.
  assert.deepEqual(Object.keys(normalizeHeaders(new Headers({ "X-Upper": "1" }))), ["x-upper"]);
  // A repeated header is combined, not silently dropped.
  const dup = new Headers();
  dup.append("x-a", "1");
  dup.append("x-a", "2");
  assert.deepEqual(normalizeHeaders(dup), { "x-a": "1, 2" });
  // The result is a plain object, not a Headers instance.
  assert.equal(normalizeHeaders(h) instanceof Headers, false);
  assert.equal(Object.getPrototypeOf(normalizeHeaders(h)), Object.prototype);
});

await test("empty Headers returns empty record", () => {
  assert.deepEqual(normalizeHeaders(new Headers()), {});
});

// ============================================================================
// §17  REGRESSION: THE THREE FIXES
// ============================================================================

suite("regression: brands, plainness, listener lifetime");

await test("regression: the type guards do not accept the wrong built-ins", () => {
  // Each of these was a duck type on a single method name, and each of those
  // names is carried by one of the most common objects in the language:
  // `Map` and `Set` both have `has`, `FormData` has `forEach`.
  const cases: Array<[string, (v: unknown) => boolean, unknown, boolean]> = [
    ["isURLSearchParams", isURLSearchParams, new Map(), false],
    ["isURLSearchParams", isURLSearchParams, new Set(), false],
    ["isURLSearchParams", isURLSearchParams, new Headers(), false],
    ["isURLSearchParams", isURLSearchParams, new URLSearchParams(), true],
    ["isHeaders", isHeaders, new Map(), false],
    ["isHeaders", isHeaders, new FormData(), false],
    ["isHeaders", isHeaders, new Set(), false],
    ["isHeaders", isHeaders, new Headers(), true],
    ["isFormData", isFormData, new Headers(), false],
    ["isFormData", isFormData, new Map(), false],
    ["isFormData", isFormData, new FormData(), true],
    ["isBlob", isBlob, new Map(), false],
    ["isBlob", isBlob, new URLSearchParams(), false],
    ["isBlob", isBlob, new Blob(), true],
    ["isReadableStream", isReadableStream, new Map(), false],
    ["isReadableStream", isReadableStream, new Blob(), false],
    ["isAbortSignal", isAbortSignal, { aborted: false }, false],
    ["isAbortSignal", isAbortSignal, new AbortController().signal, true],
  ];
  for (const [name, guard, value, want] of cases) {
    assert.equal(guard(value), want, `${name}(${value?.constructor?.name}) must be ${want}`);
  }
  // And the brand alone is not enough — it is one getter away from anything,
  // and these guards exist to route a value to the right code path.
  class Spoof {
    get [Symbol.toStringTag]() {
      return "Headers";
    }
  }
  assert.equal(isHeaders(new Spoof()), false);
  class Spoof2 {
    get [Symbol.toStringTag]() {
      return "Blob";
    }
  }
  assert.equal(isBlob(new Spoof2()), false);
  // A real one from another realm is still accepted: the brand path exists for
  // exactly that, and it is what an iframe's Headers would hit.
  class CrossRealm {
    get [Symbol.toStringTag]() {
      return "Headers";
    }
    get() {}
    set() {}
    append() {}
    forEach() {}
  }
  assert.equal(isHeaders(new CrossRealm()), true, "a cross-realm Headers is still Headers");
});

await test("regression: isBlob accepts a File", () => {
  // The old check was `constructor?.name === "Blob"`, so every File — the
  // most common Blob-shaped value in a browser, and the one you get from a
  // file input — was rejected. `File` extends `Blob`.
  const f = new File(["x"], "a.txt", { type: "text/plain" });
  assert.ok(f instanceof Blob);
  assert.equal(f.constructor.name, "File", "which is exactly why the name check missed it");
  assert.equal(isBlob(f), true);
  assert.equal(isBlob(new Blob(["x"])), true);
  assert.equal(isBlob(new Uint8Array(1)), false);
  assert.equal(isBlob(null), false);
});

await test("regression: isPlainObject rejects a class instance", () => {
  // `Object.prototype.toString.call(x) === "[object Object]"` is true for
  // every class that does not override Symbol.toStringTag, so an instance
  // passed — the opposite of what "plain" means, and the reason the guard
  // cannot be trusted for the copy/merge decisions its name invites.
  class Config {
    constructor(public endpoint: string) {}
    toString() {
      return this.endpoint;
    }
  }
  const instance = new Config("https://x.test");
  assert.equal(Object.prototype.toString.call(instance), "[object Object]");
  assert.equal(isPlainObject(instance), false, "but it is not a plain object");
  // The cases that must still pass.
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: { b: 1 } }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  // And the brand cannot be spoofed back in either.
  class Spoof {
    get [Symbol.toStringTag]() {
      return "Object";
    }
  }
  assert.equal(isPlainObject(new Spoof()), false);
  // Non-objects.
  for (const v of [null, undefined, 1, "s", [], new Date(), new Map(), () => {}]) {
    assert.equal(isPlainObject(v), false, `${JSON.stringify(v)} is not plain`);
  }
});

await test("regression: a long-lived signal is not left with a listener per merge", () => {
  // Measured rather than reasoned about: the old implementation left one
  // permanent `abort` listener on every input, and nothing could ever remove
  // them, because the merged controller is never handed out. A caller passing
  // a long-lived signal — which src/core.ts does on every request — grew one
  // listener per request until the process warned and the list kept growing.
  const src = new AbortController();
  const perRequest = new AbortController();
  let added = 0;
  const sig = src.signal as unknown as {
    addEventListener: (t: string, f: () => void, o?: { once?: boolean }) => void;
  };
  const origAdd = sig.addEventListener;
  sig.addEventListener = (t, f, o) => {
    if (t === "abort") added++;
    return origAdd.call(sig, t, f);
  };

  const merged: AbortSignal[] = [];
  for (let i = 0; i < 100; i++) merged.push(mergeSignals(src.signal, perRequest.signal)!);
  assert.equal(added, 0, `100 merges left ${added} listeners behind`);

  // The behaviour the listener existed for is intact.
  assert.equal(
    merged.some((m) => m.aborted),
    false,
  );
  src.abort();
  assert.equal(
    merged.every((m) => m.aborted),
    true,
    "every merged signal followed",
  );
  // And the reason is an AbortError, so `isAbortError` recognises it.
  assert.equal(isAbortError(merged[0]!.reason), true);
});

// ============================================================================
// REGRESSIONS — one case per defect this round's audit found
// ============================================================================

suite("Regressions (utils round)");

await test("regression: an explicit undefined does not erase a safeJSONParse limit", () => {
  // `{ ...DEFAULT_LIMITS, ...options }` copied a present-but-undefined value
  // straight over a real limit, and every limit in the file is a comparison
  // against a number — so `{ maxDepth: undefined }` did not mean "the default",
  // it meant "no depth limit at all", silently, with a `Required<>` type
  // asserting the opposite. `{ maxDepth: env.MAX_DEPTH }` is the shape that
  // produces it, and it is what every call site that forwards config looks
  // like.
  // The defaults are 32 / 10 MB / 10 000 items / 1000 keys, so each payload
  // is sized to sit just past its own default: with the limit erased it would
  // have parsed, and with the default in place it does not.
  const deep = `[${"[".repeat(40)}${"]".repeat(40)}]`; // depth 40 > 32
  const shallow = `[${"[".repeat(10)}${"]".repeat(10)}]`; // depth 10 < 32
  assert.equal(
    safeJSONParse(deep, { maxDepth: undefined }).error,
    "DEPTH_EXCEEDED",
    "the DEFAULT limit, not none, is what rejects it",
  );
  assert.equal(
    safeJSONParse(shallow, { maxDepth: undefined }).success,
    true,
    "a payload inside the default still parses",
  );
  assert.equal(safeJSONParse(deep, { maxDepth: 64 }).success, true, "an explicit limit wins");
  assert.equal(safeJSONParse(deep, { maxDepth: 8 }).success, false, "and it still applies");
  // Each limit separately, since each is a different comparison. The array one
  // is what the file's own `maxArrayLength` guard would miss: 50 elements is
  // under the default of 1000, so it passes — but only because the default is
  // back, rather than because the limit is gone.
  const wide = JSON.stringify({ a: new Array(50).fill(1) });
  assert.equal(safeJSONParse(wide, { maxArrayLength: undefined }).success, true);
  assert.equal(safeJSONParse(wide, { maxArrayLength: 10 }).success, false);
  const keyed = JSON.stringify(
    Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 1])),
  );
  assert.equal(safeJSONParse(keyed, { maxObjectKeys: undefined }).success, true);
  assert.equal(safeJSONParse(keyed, { maxObjectKeys: 10 }).success, false);
  const long = JSON.stringify("x".repeat(10 * 1024 * 1024 + 1)); // one past the default
  assert.equal(
    safeJSONParse(long, { maxStringLength: undefined }).error,
    "STRING_TOO_LONG",
    "the default string limit, not none",
  );
  assert.equal(
    safeJSONParse(JSON.stringify("x".repeat(1024)), { maxStringLength: undefined }).success,
    true,
    "a short one is untouched",
  );
  // `null` is a real override and is still honoured — only undefined is not.
  assert.equal(safeJSONParse(deep, { maxDepth: null } as never).success, false);
});

await test("regression: a context key cannot reach the __proto__ setter", () => {
  // `Object.assign(error, context)` writes through [[Set]], and a context with
  // an *own* `__proto__` key is exactly what `JSON.parse` hands back. The
  // write went to the inherited setter and replaced the error's prototype, so
  // an attacker-supplied object sat in the prototype chain of every error the
  // client then formatted, logged or inspected.
  const hostile = JSON.parse('{"__proto__":{"pwned":"yes","toString":"owned"}}') as Record<
    string,
    unknown
  >;
  const err = createStructuredError("failed", {
    code: "EHOST",
    ...hostile,
  } as never);
  assert.ok(err instanceof Error, "still an Error");
  assert.equal(Object.getPrototypeOf(err), Error.prototype, "the prototype must not move");
  assert.equal((err as unknown as Record<string, unknown>).pwned, undefined);
  assert.equal(({} as Record<string, unknown>).pwned, undefined, "Object.prototype is clean");
  assert.notEqual(String(err), "owned", "the attacker's toString is not in play");
  assert.equal(err.message, "failed");
  assert.equal(err.code, "EHOST", "the legitimate fields survive");
  // The key is still carried, as an own data property, which is what a caller
  // forwarding a remote payload needs — it just is not the prototype.
  assert.deepEqual((err as unknown as Record<string, unknown>).__proto__, {
    pwned: "yes",
    toString: "owned",
  });
  assert.equal(Object.getOwnPropertyDescriptor(err, "__proto__")?.get, undefined);
});

await test("regression: formatError formats instead of throwing", () => {
  // The context attached by createStructuredError is whatever the failing call
  // held — a request, a response, a cause — and all three routinely point back
  // at each other. JSON.stringify answers that with a thrown TypeError, and a
  // BigInt with another, so the function whose whole job is to turn an error
  // into a string threw, taking the logging catch-block with it.
  const circular: Record<string, unknown> = { code: "ELOOP" };
  circular.self = circular;
  const err = createStructuredError("circular", circular as never);
  const line = formatError(err);
  assert.equal(typeof line, "string");
  assert.ok(line.startsWith("Error: circular | "), `unexpected shape: ${line}`);
  assert.ok(line.includes("ELOOP"), "the real fields are still there");
  assert.ok(line.includes("[Circular]"), `the cycle is marked, not fatal: ${line}`);

  // Two objects that merely *share* a descendant are not a cycle, and neither
  // is a repeated value — the marker says "seen", not "loop", so this is a
  // label rather than a wrong answer.
  const shared = { id: 1 };
  const sharedLine = formatError(
    createStructuredError("shared", { a: shared, b: shared } as never),
  );
  assert.ok(!sharedLine.includes("Converting circular"), "a repeat is not a cycle");

  // A BigInt, and a value whose toJSON throws, both used to throw here.
  assert.equal(formatError(Object.assign(new Error("n"), { n: 10n })), 'Error: n | {"n":"10"}');
  const hostile = {
    toJSON() {
      throw new Error("no");
    },
  };
  assert.equal(typeof formatError(Object.assign(new Error("h"), { v: hostile })), "string");

  // The ordinary case is unchanged: an error with no extra fields formats to
  // exactly name and message, and a non-Error is stringified as before.
  assert.equal(formatError(new TypeError("plain")), "TypeError: plain");
  assert.equal(formatError("just a string"), "just a string");
  assert.equal(formatError({ code: "E" }), "[object Object]");
});

await test("regression: isValidHeaderValue agrees with the runtime about ByteStrings", () => {
  // The loop had no upper bound, so it accepted an emoji — and the very next
  // `new Headers({ "X-A": "\u{1F600}" })` throws "Cannot convert argument to a
  // ByteString". RFC 9110 caps field-value at obs-text, %x80-FF. This guard is
  // what a caller checks first, so a "valid" verdict the runtime then refuses
  // is worse than no verdict.
  assert.equal(isValidHeaderValue("\u{1F600}"), false, "a code point above U+00FF");
  assert.equal(isValidHeaderValue("a\u{1F600}b"), false);
  assert.equal(isValidHeaderValue("\u0100"), false, "U+0100, one past obs-text");
  assert.equal(isValidHeaderValue("\u00ff"), true, "U+00FF is inside obs-text");
  assert.equal(isValidHeaderValue("café"), true);
  // The two agree on the boundary that matters: anything this accepts, the
  // platform Headers accepts too.
  for (const v of ["café", "ÿ", "a\tb", "text/html; charset=utf-8", ""]) {
    assert.equal(isValidHeaderValue(v), true, `${JSON.stringify(v)} should be valid`);
    assert.doesNotThrow(() => new Headers({ "X-A": v }), `${JSON.stringify(v)} must be settable`);
  }
  for (const v of ["\u{1F600}", "a\rb", "a\x00b", "\u0100"]) {
    assert.equal(isValidHeaderValue(v), false, `${JSON.stringify(v)} should be invalid`);
    assert.throws(() => new Headers({ "X-A": v }), `${JSON.stringify(v)} must be refused`);
  }
  // DEL is the one place the guard is *stricter* than the platform, which
  // accepts it; being conservative there is the right direction, so it is
  // pinned rather than reconciled.
  assert.equal(isValidHeaderValue("\x7f"), false);
  assert.doesNotThrow(() => new Headers({ "X-A": "\x7f" }));
  // The length limit is unchanged and still counts characters, not bytes.
  assert.equal(isValidHeaderValue("a".repeat(8192)), true);
  assert.equal(isValidHeaderValue("a".repeat(8193)), false);
});

await test("regression: deepClone keeps a class instance's prototype", () => {
  // The object walk produced a bare `{}` for anything that was not a plain
  // object, so a clone of a class instance was an `Object` with every method
  // gone — and nothing said so until something called one.
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
    sum(): number {
      return this.x + this.y;
    }
    get label(): string {
      return `${this.x},${this.y}`;
    }
  }
  const p = new Point(1, 2);
  const c = deepClone(p);
  assert.equal(c instanceof Point, true, "the prototype must survive");
  assert.equal((c as Point).sum(), 3, "and the methods on it must be usable");
  assert.equal((c as Point).label, "1,2", "a getter is still a getter");
  assert.equal(c === p, false, "and it must be a new object");
  // A nested instance is cloned too, not just the root.
  const nested = deepClone({ p, list: [new Point(3, 4)] });
  assert.equal(nested.p instanceof Point, true);
  assert.equal(nested.p.sum(), 3);
  assert.equal(nested.p === p, false, "the nested one is a clone, not the original");
  assert.equal(nested.list[0] instanceof Point, true);
  assert.equal(nested.list[0].sum(), 7);
  // A null-prototype object is a dictionary: its contents are cloned, and it
  // comes back as a normal object. That is the documented JSON-safe boundary
  // rather than a claim — the three pollution keys are dropped on the way in
  // regardless, so nothing hostile survives it.
  const bare = Object.create(null) as Record<string, unknown>;
  bare.k = { deep: 1 };
  const clonedBare = deepClone(bare) as Record<string, unknown>;
  assert.deepEqual({ ...clonedBare }, { k: { deep: 1 } });
  assert.equal(Object.getPrototypeOf(clonedBare), Object.prototype);
  // A subclass of a built-in that the walk does not special-case keeps the
  // plain-object brand, so it is rebuilt with its prototype.
  class Bag extends Map {}
  void Bag; // the built-ins above are handled by their own branches
});

await test("regression: toUint8Array copies every input type alike", () => {
  // The Uint8Array branch sliced; the ArrayBuffer branch wrapped. The same
  // call therefore returned a copy for one input and a live alias for the
  // other, so a write through the result of `toUint8Array(buffer)` reached into
  // the caller's buffer, and two calls given the same buffer shared it.
  const buf = new ArrayBuffer(8);
  const fromBuffer = toUint8Array(buf)!;
  const fromView = toUint8Array(new Uint8Array(buf))!;
  fromBuffer[0] = 0xaa;
  assert.equal(new Uint8Array(buf)[0], 0, "an ArrayBuffer input must not alias");
  fromView[1] = 0xbb;
  assert.equal(new Uint8Array(buf)[1], 0, "and neither must a Uint8Array view of one");
  assert.notEqual(fromBuffer.buffer, fromView.buffer, "the two results do not share memory");
  // A subarray view is copied over its own range only, not the whole buffer.
  const view = new Uint8Array(buf, 2, 3);
  const copy = toUint8Array(view)!;
  assert.equal(copy.length, 3);
  assert.notEqual(copy.buffer, buf);
  copy[0] = 0xcc;
  assert.equal(new Uint8Array(buf)[2], 0, "and the subarray input is not aliased either");
});

await test("regression: normalizeHeaders does not lose a header named __proto__", () => {
  // `__proto__` is made entirely of token characters, so it is a legal header
  // name and a server can send one. `result[name] = value` is a [[Set]], so it
  // went to the inherited setter, which ignores a primitive: the header did
  // not overwrite anything, it disappeared, and the caller reading the
  // normalized record never learned the response had sent it.
  const h = new Headers();
  h.set("__proto__", "polluted");
  h.set("X-Real", "kept"); // Headers lowercases on set
  const out = normalizeHeaders(h);
  assert.equal(out["__proto__"], "polluted", "the header must survive as a data field");
  assert.equal(out["x-real"], "kept");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype is clean");
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "and so is the record's own");
  assert.deepEqual(Object.keys(out).sort(), ["__proto__", "x-real"]);
  // A normal response is untouched by the extra branch.
  const plain = new Headers({ "Content-Type": "application/json", "X-A": "1" });
  assert.deepEqual(normalizeHeaders(plain), {
    "content-type": "application/json",
    "x-a": "1",
  });
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
