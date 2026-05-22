import assert from "node:assert/strict";
import {
  isSafeURL,
  sanitizeURL,
  safeJSONParse,
  isValidHeaderName,
  isValidHeaderValue,
} from "../src/utils.ts";
import {
  parseContentType,
  createRequestHeaders,
  createResponseHeaders,
  createImmutableHeaders,
} from "../src/headers.ts";

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

async function main() {
  suite("SSRF Protection (isSafeURL / sanitizeURL)");

  await test("rejects private IPv4 loopback", () => {
    assert.equal(isSafeURL("http://127.0.0.1:8080/secret"), false);
    assert.equal(isSafeURL("http://127.0.0.1/"), false);
  });

  await test("rejects private IPv4 10.x.x.x", () => {
    assert.equal(isSafeURL("http://10.0.0.1/admin"), false);
    assert.equal(isSafeURL("http://10.1.2.3/"), false);
  });

  await test("rejects private IPv4 172.16-31.x.x", () => {
    assert.equal(isSafeURL("http://172.16.0.1/"), false);
    assert.equal(isSafeURL("http://172.31.255.255/"), false);
  });

  await test("rejects private IPv4 192.168.x.x", () => {
    assert.equal(isSafeURL("http://192.168.0.1/"), false);
    assert.equal(isSafeURL("http://192.168.1.1:3000/"), false);
  });

  await test("rejects IPv6 loopback", () => {
    assert.equal(isSafeURL("http://[::1]:8080/"), false);
  });

  await test("rejects link-local IPv4 169.254.x.x", () => {
    assert.equal(isSafeURL("http://169.254.169.254/latest/meta-data/"), false);
  });

  await test("rejects link-local IPv6 fe80::", () => {
    assert.equal(isSafeURL("http://[fe80::1]/"), false);
  });

  await test("allows public HTTPS URLs", () => {
    assert.equal(isSafeURL("https://api.example.com/data"), true);
    assert.equal(isSafeURL("https://httpbin.org/get"), true);
    assert.equal(isSafeURL("https://jsonplaceholder.typicode.com/posts/1"), true);
  });

  await test("allows public HTTP URLs (non-private)", () => {
    assert.equal(isSafeURL("http://example.com/"), true);
  });

  await test("sanitizeURL blocks SSRF URLs", () => {
    assert.equal(sanitizeURL("http://127.0.0.1:8080/secret"), null);
    assert.equal(sanitizeURL("http://169.254.169.254/latest/meta-data/"), null);
    assert.equal(sanitizeURL("http://10.0.0.1/admin"), null);
  });

  await test("sanitizeURL strips credentials from public URLs", () => {
    assert.equal(
      sanitizeURL("https://user:pass@api.example.com/data"),
      "https://api.example.com/data",
    );
    assert.equal(sanitizeURL("https://token@api.example.com/"), "https://api.example.com/");
  });

  await test("sanitizeURL preserves safe URLs unchanged", () => {
    assert.equal(sanitizeURL("https://httpbin.org/get?key=val"), "https://httpbin.org/get?key=val");
  });

  suite("Safe JSON Parsing (Prototype Pollution)");

  await test("safeJSONParse rejects __proto__ pollution", () => {
    const r = safeJSONParse('{"__proto__":{"admin":true}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects constructor.prototype pollution", () => {
    const r = safeJSONParse('{"constructor":{"prototype":{"admin":true}}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects deeply nested __proto__", () => {
    const r = safeJSONParse('{"a":{"b":{"c":{"__proto__":{"polluted":true}}}}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse parses regular objects safely", () => {
    const r = safeJSONParse('{"a":1,"b":[2,3]}');
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.value, { a: 1, b: [2, 3] });
  });

  await test("safeJSONParse rejects infinite recursion depth", () => {
    const r = safeJSONParse('{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}', { maxDepth: 3 });
    assert.equal(r.success, false);
    assert.equal(r.error, "DEPTH_EXCEEDED");
  });

  await test("safeJSONParse rejects excessively large arrays", () => {
    const arr = "[" + Array(100).fill("1").join(",") + "]";
    const r = safeJSONParse(arr, { maxArrayLength: 50 });
    assert.equal(r.success, false);
    assert.equal(r.error, "VALIDATION_FAILED");
  });

  await test("safeJSONParse rejects numeric overflow (Infinity)", () => {
    const r = safeJSONParse('{"val":1e309}', { allowNonFinite: false });
    assert.equal(r.success, false);
    assert.equal(r.error, "NON_FINITE_NUMBER");
  });

  suite("Header Validation (Injection Prevention)");

  await test("isValidHeaderName rejects empty name", () => {
    assert.equal(isValidHeaderName(""), false);
  });

  await test("isValidHeaderName rejects names with spaces", () => {
    assert.equal(isValidHeaderName("bad header"), false);
    assert.equal(isValidHeaderName(" header"), false);
    assert.equal(isValidHeaderName("header "), false);
  });

  await test("isValidHeaderName rejects names with colons", () => {
    assert.equal(isValidHeaderName("Content-Type: extra"), false);
  });

  await test("isValidHeaderName rejects names with newlines", () => {
    assert.equal(isValidHeaderName("X-Injected\r\n"), false);
    assert.equal(isValidHeaderName("X-Injected\n"), false);
  });

  await test("isValidHeaderValue rejects control characters", () => {
    assert.equal(isValidHeaderValue("value\x00"), false);
    assert.equal(isValidHeaderValue("value\x0A"), false);
    assert.equal(isValidHeaderValue("value\x0D"), false);
    assert.equal(isValidHeaderValue("value\x1F"), false);
  });

  await test("isValidHeaderValue allows valid values", () => {
    assert.equal(isValidHeaderValue("text/html; charset=utf-8"), true);
    assert.equal(isValidHeaderValue(""), true);
  });

  await test("isValidHeaderValue allows HT (tab) per RFC", () => {
    assert.equal(isValidHeaderValue("text/html;\tcharset=utf-8"), true);
  });

  suite("Content-Type Validation");

  await test("parseContentType rejects empty type", () => {
    assert.equal(parseContentType("/json"), null);
  });

  await test("parseContentType rejects empty subtype", () => {
    assert.equal(parseContentType("text/"), null);
  });

  await test("parseContentType rejects DoS-length values", () => {
    assert.equal(parseContentType("a".repeat(9000)), null);
  });

  await test("parseContentType rejects invalid token characters in type", () => {
    assert.equal(parseContentType("text<plain/foo"), null);
  });

  await test("parseContentType rejects invalid token characters in subtype", () => {
    assert.equal(parseContentType("text/plain<xml"), null);
  });

  suite("Header Guards (Request/Response Security)");

  await test("request guard forbids forbidden headers", () => {
    const h = createRequestHeaders({});
    assert.throws(() => h.set("host", "evil.com"), /forbidden/i);
    assert.throws(() => h.set("content-length", "999"), /forbidden/i);
    assert.throws(() => h.set("transfer-encoding", "chunked"), /forbidden/i);
    assert.throws(() => h.set("connection", "keep-alive"), /forbidden/i);
  });

  await test("response guard forbids set-cookie", () => {
    const h = createResponseHeaders({});
    assert.throws(() => h.set("set-cookie", "session=evil"), /forbidden/i);
    assert.throws(() => h.append("set-cookie", "session=evil"), /forbidden/i);
  });

  await test("response guard allows normal headers", () => {
    const h = createResponseHeaders({});
    h.set("content-type", "application/json");
    assert.equal(h.get("content-type"), "application/json");
  });

  await test("request guard allows safe custom headers", () => {
    const h = createRequestHeaders({});
    h.set("x-custom", "safe-value");
    assert.equal(h.get("x-custom"), "safe-value");
  });

  await test("immutable headers reject modifications", () => {
    const h = createImmutableHeaders({});
    assert.throws(() => h.set("x-test", "val"), /immutable/i);
    assert.throws(() => h.delete("x-test"), /immutable/i);
    assert.throws(() => h.append("x-test", "val"), /immutable/i);
  });

  suite("Credential Leakage Prevention");

  await test("sanitizeURL removes user:password from URLs", () => {
    assert.equal(sanitizeURL("https://user:pass@host.com/path"), "https://host.com/path");
    assert.equal(sanitizeURL("https://user@host.com/path"), "https://host.com/path");
  });

  await test("sanitizeURL removes credentials even with query params", () => {
    const result = sanitizeURL("https://user:pass@host.com/path?token=secret");
    assert.equal(result, "https://host.com/path?token=secret");
  });

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  Security tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
  console.log(`════════════════════════════════════════════════════════════`);

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures)
      console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
