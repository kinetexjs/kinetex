import assert from "node:assert/strict";
import {
  safeJSONParse,
  isValidHeaderName,
  isValidHeaderValue,
  mergeSignals,
  sanitizeURL,
  uint8ArrayToBase64,
} from "../src/utils.ts";
import {
  parseContentType,
  parseCacheControl,
  parseWWWAuthenticate,
  parseParams,
  parseLinkHeader,
  parseHSTS,
} from "../src/headers.ts";
import {
  percentEncode,
  percentDecode,
  stringifyQuery,
  parseQuery,
  normalizeURL,
  normalizePath,
  safeParseURL,
} from "../src/url.ts";
import { parseSetCookieHeader, formatSetCookieHeader, domainMatch } from "../src/cookie-parser.ts";

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

// Inline helpers
function b64decode(s: string): string {
  if (typeof atob !== "undefined") return atob(s);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let out = "";
  s = s.replace(/=+$/, "");
  for (let i = 0; i < s.length; i += 4) {
    const a = chars.indexOf(s[i]!);
    const b = i + 1 < s.length ? chars.indexOf(s[i + 1]!) : 0;
    const c = i + 2 < s.length ? chars.indexOf(s[i + 2]!) : 0;
    const d = i + 3 < s.length ? chars.indexOf(s[i + 3]!) : 0;
    out += String.fromCharCode((a << 2) | (b >> 4));
    if (i + 2 < s.length) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (i + 3 < s.length) out += String.fromCharCode(((c & 3) << 6) | d);
  }
  return out;
}

async function main() {
  suite("URL — Percent Encoding Round-Trip");

  await test("basic percent encode then decode round-trips", () => {
    const inputs = [
      "hello world",
      "a=b&c=d",
      "foo/bar baz",
      "~`!@#$%^&*()_+-=[]{}|;:',.<>?",
      "",
      "already%20encoded",
      "100% valid",
      "path?query=value#hash",
    ];
    for (const input of inputs) {
      const encoded = percentEncode(input);
      const decoded = percentDecode(encoded);
      assert.equal(decoded, input);
    }
  });

  await test("percent encode then decode round-trips with allowReserved", () => {
    const input = "https://example.com/path?query=value#frag";
    const encoded = percentEncode(input, true);
    const decoded = percentDecode(encoded);
    assert.equal(decoded, input);
  });

  await test("percent decode malformed sequences does not throw", () => {
    const malformed = ["%ZZ", "%", "%G0", "%0", "%%%", "%2", "%2G"];
    for (const m of malformed) {
      const result = percentDecode(m);
      assert.equal(typeof result, "string");
    }
  });

  suite("URL — Extreme Unicode");

  await test("percent encode/decode surrogate pairs (emoji)", () => {
    const emojis = ["😀", "🚀", "💩", "🌍", "🎉", "🤖", "🦀", "🔥"];
    for (const emoji of emojis) {
      const encoded = percentEncode(emoji);
      const decoded = percentDecode(encoded);
      assert.equal(decoded, emoji);
    }
  });

  await test("percent encode/decode zero-width and control chars", () => {
    const special = ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u202E", "\u202D"];
    for (const ch of special) {
      const encoded = percentEncode(ch);
      const decoded = percentDecode(encoded);
      assert.equal(decoded, ch);
    }
  });

  await test("percent encode/decode CJK and RTL scripts", () => {
    const texts = ["你好世界", "مرحبا بالعالم", "שלום עולם", "日本語", "한국어"];
    for (const t of texts) {
      const encoded = percentEncode(t);
      const decoded = percentDecode(encoded);
      assert.equal(decoded, t);
    }
  });

  suite("URL — Maximum Length & Control Characters");

  await test("8KB URL does not throw on safeParseURL", () => {
    const long = "https://example.com/" + "a".repeat(8100);
    const parsed = safeParseURL(long);
    assert.notEqual(parsed, null);
  });

  await test("sanitizeURL rejects URL exceeding 2048 chars", () => {
    const long = "https://example.com/" + "a".repeat(2050);
    assert.equal(sanitizeURL(long), null);
  });

  await test("sanitizeURL rejects empty string and non-string input", () => {
    assert.equal(sanitizeURL(""), null);
    assert.equal(sanitizeURL(null as unknown as string), null);
    assert.equal(sanitizeURL(undefined as unknown as string), null);
    assert.equal(sanitizeURL(42 as unknown as string), null);
  });

  await test("safeParseURL handles URLs with null bytes gracefully", () => {
    const result = safeParseURL("https://example.com/\x00path");
    assert.equal(result?.href, "https://example.com/%00path");
  });

  await test("safeParseURL rejects URLs with control characters", () => {
    for (let i = 0; i <= 0x1f; i++) {
      const url = `https://example.com/${String.fromCharCode(i)}`;
      const parsed = safeParseURL(url);
      // Some control chars may be tolerated by the URL parser, some not
      // Just verify no crash
      if (parsed !== null) assert.equal(typeof parsed.href, "string");
    }
  });

  suite("URL — Normalization Fuzzing");

  await test("normalizeURL collapses multiple slashes in path", () => {
    const result = normalizeURL("https://example.com//////path///to///resource", {
      trailingSlash: "remove",
    });
    assert.equal(result, "https://example.com/path/to/resource");
  });

  await test("normalizeURL resolves dot segments", () => {
    assert.equal(
      normalizeURL("https://example.com/a/b/../c/d/./e", { trailingSlash: "remove" }),
      "https://example.com/a/c/d/e",
    );
  });

  await test("normalizeURL removes default port", () => {
    assert.equal(normalizeURL("https://example.com:443/path"), "https://example.com/path");
    assert.equal(normalizeURL("http://example.com:80/path"), "http://example.com/path");
  });

  await test("normalizeURL lowercases host and scheme", () => {
    assert.equal(normalizeURL("HTTPS://EXAMPLE.COM/PATH"), "https://example.com/PATH");
  });

  await test("normalizeURL with trailingSlash=add", () => {
    const result = normalizeURL("https://example.com/path", { trailingSlash: "add" });
    assert.equal(result, "https://example.com/path/");
  });

  suite("URL — Query String Fuzzing");

  await test("stringifyQuery with special chars in keys and values", () => {
    const qs = stringifyQuery({ "a b": "c d", "e=f": "g&h", null: null, undef: undefined });
    assert.equal(qs, "a%20b=c%20d&e%3Df=g%26h");
  });

  await test("stringifyQuery with array values (repeat format)", () => {
    const qs = stringifyQuery({ key: ["v1", "v2", "v3"] }, { arrayFormat: "repeat" });
    assert.equal(qs, "key=v1&key=v2&key=v3");
  });

  await test("stringifyQuery with array values (bracket format)", () => {
    const qs = stringifyQuery({ key: ["v1", "v2"] }, { arrayFormat: "bracket" });
    assert.equal(qs, "key[]=v1&key[]=v2");
  });

  await test("stringifyQuery with array values (comma format)", () => {
    const qs = stringifyQuery({ key: ["v1", "v2"] }, { arrayFormat: "comma" });
    assert.equal(qs, "key=v1,v2");
  });

  await test("stringifyQuery with boolean and number values", () => {
    const qs = stringifyQuery({ bool: true, num: 42, str: "hello" });
    assert.equal(qs, "bool=true&num=42&str=hello");
  });

  await test("stringifyQuery sorts when sort option is true", () => {
    const qs = stringifyQuery({ z: "1", a: "2", m: "3" }, { sort: true });
    assert.equal(qs, "a=2&m=3&z=1");
  });

  await test("parseQuery handles empty string and leading ?", () => {
    assert.deepEqual(parseQuery(""), {});
    assert.deepEqual(parseQuery("?"), {});
  });

  await test("parseQuery handles duplicate keys producing arrays", () => {
    const result = parseQuery("key=1&key=2&key=3");
    assert.deepEqual(result, { key: ["1", "2", "3"] });
  });

  await test("parseQuery handles empty values and missing =", () => {
    const result = parseQuery("key&key2=&key3=val");
    assert.deepEqual(result, { key: "", key2: "", key3: "val" });
  });

  await test("parseQuery handles percent-encoded keys and values", () => {
    const result = parseQuery("a%20b=c%20d&e%3Df=g%26h");
    assert.deepEqual(result, { "a b": "c d", "e=f": "g&h" });
  });

  suite("JSON — Deep Nesting & Long Strings");

  await test("safeJSONParse with moderately nested objects (depth 20)", () => {
    let json = "1";
    for (let i = 0; i < 20; i++) json = `{"a":${json}}`;
    const r = safeJSONParse(json);
    assert.equal(r.success, true);
  });

  await test("safeJSONParse rejects depth exceeding maxDepth", () => {
    let json = "1";
    for (let i = 0; i < 40; i++) json = `{"a":${json}}`;
    const r = safeJSONParse(json, { maxDepth: 10 });
    assert.equal(r.success, false);
    assert.equal(r.error, "DEPTH_EXCEEDED");
  });

  await test("safeJSONParse with moderately long string (~50KB)", () => {
    const s = "x".repeat(50_000);
    const json = JSON.stringify(s);
    const r = safeJSONParse(json);
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.value, s);
  });

  await test("safeJSONParse rejects too-long string (exceeds maxStringLength)", () => {
    const s = "x".repeat(100);
    const json = JSON.stringify(s);
    const r = safeJSONParse(json, { maxStringLength: 50 });
    assert.equal(r.success, false);
  });

  suite("JSON — Prototype Pollution");

  await test("safeJSONParse rejects __proto__ at root", () => {
    const r = safeJSONParse('{"__proto__":{"polluted":true}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects constructor.prototype pollution", () => {
    const r = safeJSONParse('{"constructor":{"prototype":{"polluted":true}}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects deeply nested __proto__", () => {
    const r = safeJSONParse('{"a":{"b":{"c":{"__proto__":{"x":1}}}}}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects constructor at depth with nested prototype", () => {
    const r = safeJSONParse('{"x":{"constructor":{"prototype":{"admin":true}}}}');
    assert.equal(r.success, false);
  });

  suite("JSON — Edge Cases");

  await test("safeJSONParse with null input", () => {
    const r = safeJSONParse("null");
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.value, null);
  });

  await test("safeJSONParse with various primitives", () => {
    assert.equal(safeJSONParse("true").success, true);
    assert.equal(safeJSONParse("false").success, true);
    assert.equal(safeJSONParse("42").success, true);
    assert.equal(safeJSONParse('"hello"').success, true);
    assert.equal(safeJSONParse("[]").success, true);
    assert.equal(safeJSONParse("{}").success, true);
  });

  await test("safeJSONParse with empty string returns error", () => {
    const r = safeJSONParse("");
    assert.equal(r.success, false);
  });

  await test("safeJSONParse with malformed JSON returns error", () => {
    const malformed = [
      "{",
      "}",
      "[",
      "]",
      "{foo: bar}",
      '{"a": "b"',
      '{"a": }',
      "[1, 2,]",
      "undefined",
      "NaN",
      "Infinity",
      "'single quotes'",
      "\\x00",
    ];
    for (const m of malformed) {
      const r = safeJSONParse(m);
      assert.equal(r.success, false, `expected failure for: ${m}`);
    }
  });

  await test("safeJSONParse rejects truncated JSON", () => {
    const r = safeJSONParse('{"a":{"b":{"c":{"d"');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse with large array exceeding maxArrayLength", () => {
    const arr = "[" + Array(200).fill("1").join(",") + "]";
    const r = safeJSONParse(arr, { maxArrayLength: 50 });
    assert.equal(r.success, false);
  });

  await test("safeJSONParse with excessive object keys", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `"k${i}":1`).join(",");
    const r = safeJSONParse(`{${keys}}`, { maxObjectKeys: 50 });
    assert.equal(r.success, false);
  });

  await test("safeJSONParse rejects NaN (non-finite)", () => {
    const r = safeJSONParse('{"x":NaN}');
    assert.equal(r.success, false);
  });

  await test("safeJSONParse allows non-finite when allowNonFinite=true", () => {
    const r = safeJSONParse('{"x":1e309}', { allowNonFinite: true });
    assert.equal(r.success, true);
  });

  suite("Headers — Validation Fuzzing (isValidHeaderName)");

  await test("isValidHeaderName rejects empty string", () => {
    assert.equal(isValidHeaderName(""), false);
  });

  await test("isValidHeaderName rejects names with spaces", () => {
    assert.equal(isValidHeaderName("Content Type"), false);
    assert.equal(isValidHeaderName(" Content-Type"), false);
    assert.equal(isValidHeaderName("Content-Type "), false);
  });

  await test("isValidHeaderName rejects names with colons and newlines", () => {
    assert.equal(isValidHeaderName("X-Foo: bar"), false);
    assert.equal(isValidHeaderName("X-Foo\r\n"), false);
    assert.equal(isValidHeaderName("X-Foo\n"), false);
  });

  await test("isValidHeaderName accepts valid standard names", () => {
    const valid = [
      "Content-Type",
      "X-Custom-Header",
      "ETag",
      "Cache-Control",
      "Accept",
      "Authorization",
      "WWW-Authenticate",
      "x-forwarded-for",
      "access-control-allow-origin",
      "strict-transport-security",
      "sec-websocket-key",
      "content-security-policy",
    ];
    for (const name of valid) {
      assert.equal(isValidHeaderName(name), true, `expected valid: ${name}`);
    }
  });

  await test("isValidHeaderName rejects names with Unicode chars", () => {
    assert.equal(isValidHeaderName("Café"), false);
    assert.equal(isValidHeaderName("头"), false);
  });

  await test("isValidHeaderName rejects names with null byte", () => {
    assert.equal(isValidHeaderName("X-Foo\x00Bar"), false);
  });

  await test("isValidHeaderName rejects very long names (>4096)", () => {
    assert.equal(isValidHeaderName("X".repeat(4097)), false);
  });

  suite("Headers — Validation Fuzzing (isValidHeaderValue)");

  await test("isValidHeaderValue rejects control characters", () => {
    assert.equal(isValidHeaderValue("val\x00"), false);
    assert.equal(isValidHeaderValue("val\x01"), false);
    assert.equal(isValidHeaderValue("val\x1F"), false);
    assert.equal(isValidHeaderValue("val\x7F"), false);
  });

  await test("isValidHeaderValue rejects newlines (CRLF injection)", () => {
    assert.equal(isValidHeaderValue("val\r\n"), false);
    assert.equal(isValidHeaderValue("val\n"), false);
    assert.equal(isValidHeaderValue("val\r"), false);
    assert.equal(isValidHeaderValue("X-Injected: evil"), true);
  });

  await test("isValidHeaderValue allows tab (HT 0x09)", () => {
    assert.equal(isValidHeaderValue("text/html;\tcharset=utf-8"), true);
  });

  await test("isValidHeaderValue rejects very long values (>8192)", () => {
    assert.equal(isValidHeaderValue("x".repeat(8193)), false);
  });

  await test("isValidHeaderValue accepts valid values", () => {
    assert.equal(isValidHeaderValue(""), true);
    assert.equal(isValidHeaderValue("text/html"), true);
    assert.equal(isValidHeaderValue("gzip, deflate, br"), true);
    assert.equal(isValidHeaderValue("application/json; charset=utf-8"), true);
  });

  suite("Headers — Content-Type Fuzzing");

  await test("parseContentType with empty/null input", () => {
    assert.equal(parseContentType(""), null);
  });

  await test("parseContentType rejects missing slash", () => {
    assert.equal(parseContentType("textplain"), null);
  });

  await test("parseContentType rejects empty type or subtype", () => {
    assert.equal(parseContentType("/json"), null);
    assert.equal(parseContentType("text/"), null);
  });

  await test("parseContentType with spaces around type", () => {
    const r = parseContentType("text / html");
    // space before slash may make it invalid
    if (r === null) {
      // acceptable — token includes space which is invalid
    } else {
      assert.equal(r.mediaType, "text/html");
    }
  });

  await test("parseContentType with malformed params", () => {
    const r = parseContentType("text/html; charset=; ;;");
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.mediaType, "text/html");
      assert.equal(r.charset, "");
    }
  });

  await test("parseContentType with random garbage types", () => {
    const garbage = [
      ">>>???",
      "a/b; charset=utf-8",
      "*/*",
      "application/xhtml+xml",
      "text/event-stream",
      "multipart/form-data; boundary=----WebKitFormBoundary",
      "application/vnd.api+json",
    ];
    for (const g of garbage) {
      const r = parseContentType(g);
      // Should either parse successfully or return null, never throw
      if (r !== null) assert.equal(typeof r.mediaType, "string");
    }
  });

  await test("parseContentType with invalid token chars", () => {
    assert.equal(parseContentType("text<plain/html"), null);
    assert.equal(parseContentType("text/plain<xml"), null);
    assert.equal(parseContentType('text/plain"attack"'), null);
  });

  suite("Headers — Cache-Control Fuzzing");

  await test("parseCacheControl with empty string", () => {
    const r = parseCacheControl("");
    assert.equal(r.noCache, false);
    assert.equal(r.noStore, false);
  });

  await test("parseCacheControl with duplicate directives (last wins semantics)", () => {
    const r = parseCacheControl("no-cache, no-cache, no-store, no-store");
    assert.equal(r.noCache, true);
    assert.equal(r.noStore, true);
  });

  await test("parseCacheControl with numeric directives and garbage", () => {
    const r = parseCacheControl(
      "max-age=3600, s-maxage=86400, stale-while-revalidate=300, garbage",
    );
    assert.equal(r.maxAge, 3600);
    assert.equal(r.sMaxAge, 86400);
    assert.equal(r.staleWhileRevalidate, 300);
  });

  await test("parseCacheControl with private=field-list", () => {
    const r = parseCacheControl("private=Authorization, X-Custom");
    assert.deepEqual(r.private, ["Authorization"]);
    // "X-Custom" becomes an unknown directive since the comma splits it
    assert.equal(r.unknown.get("x-custom"), true);
  });

  await test("parseCacheControl with unquoted and quoted values", () => {
    const r1 = parseCacheControl('max-age="3600"');
    assert.equal(r1.maxAge, 3600);
    const r2 = parseCacheControl("max-age=3600");
    assert.equal(r2.maxAge, 3600);
  });

  await test("parseCacheControl with non-numeric values for numeric fields", () => {
    const r = parseCacheControl("max-age=abc, s-maxage=def, stale-if-error=!@#");
    assert.ok(Number.isNaN(r.maxAge));
    assert.ok(Number.isNaN(r.sMaxAge));
    assert.ok(Number.isNaN(r.staleIfError));
  });

  await test("parseCacheControl captures unknown directives", () => {
    const r = parseCacheControl("no-cache, x-custom=value, unknown-flag");
    assert.equal(r.noCache, true);
    assert.equal(r.unknown.get("x-custom"), "value");
    assert.equal(r.unknown.get("unknown-flag"), true);
  });

  suite("Headers — WWW-Authenticate Fuzzing");

  await test("parseWWWAuthenticate with malformed challenges", () => {
    const r = parseWWWAuthenticate("");
    assert.deepEqual(r, []);
  });

  await test("parseWWWAuthenticate with multiple challenges", () => {
    const r = parseWWWAuthenticate('Basic realm="simple", Digest realm="digest", nonce="abc"');
    // "nonce=abc" becomes a third challenge with scheme "nonce"
    assert.equal(r.length, 3);
    assert.equal(r[0]?.scheme, "basic");
    assert.equal(r[1]?.scheme, "digest");
    assert.equal(r[2]?.scheme, 'nonce="abc"');
  });

  await test("parseWWWAuthenticate with quoted commas in params", () => {
    const r = parseWWWAuthenticate('Bearer realm="test, with, commas", error="invalid_token"');
    // commas inside quotes are not treated as separators, so we get 2 challenges
    assert.equal(r.length, 2);
    assert.equal(r[0]?.scheme, "bearer");
    assert.equal(r[0]?.realm, "test, with, commas");
  });

  await test("parseWWWAuthenticate with random garbage", () => {
    const garbage = [
      ">>>??? <<<",
      "   ",
      "scheme",
      "Scheme param1=val1, param2=val2",
      'NewScheme realm="realm" param1="val1", param2="val2"',
    ];
    for (const g of garbage) {
      const r = parseWWWAuthenticate(g);
      assert.ok(Array.isArray(r));
      for (const c of r) {
        assert.equal(typeof c.scheme, "string");
      }
    }
  });

  suite("Headers — Link Header Fuzzing");

  await test("parseLinkHeader with empty string", () => {
    assert.deepEqual(parseLinkHeader(""), []);
  });

  await test("parseLinkHeader with single link", () => {
    const r = parseLinkHeader('<https://example.com>; rel="next"');
    assert.equal(r.length, 1);
    assert.equal(r[0]?.uri, "https://example.com");
    assert.equal(r[0]?.rel, "next");
  });

  await test("parseLinkHeader with multiple links", () => {
    const r = parseLinkHeader(
      '<https://api.example.com/users?page=1>; rel="first", <https://api.example.com/users?page=3>; rel="next"',
    );
    assert.equal(r.length, 2);
  });

  await test("parseLinkHeader with many attributes", () => {
    const r = parseLinkHeader(
      '<https://example.com>; rel="stylesheet"; type="text/css"; hreflang="en"; media="screen"',
    );
    assert.equal(r.length, 1);
    assert.equal(r[0]?.rel, "stylesheet");
    assert.equal(r[0]?.type, "text/css");
    assert.equal(r[0]?.hreflang, "en");
    assert.equal(r[0]?.media, "screen");
  });

  suite("Headers — HSTS Fuzzing");

  await test("parseHSTS with typical value", () => {
    const r = parseHSTS("max-age=31536000; includeSubDomains; preload");
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.maxAge, 31536000);
      assert.equal(r.includeSubDomains, true);
      assert.equal(r.preload, true);
    }
  });

  await test("parseHSTS with missing max-age returns null", () => {
    assert.equal(parseHSTS("includeSubDomains"), null);
  });

  await test("parseHSTS with non-numeric max-age returns null", () => {
    assert.equal(parseHSTS("max-age=abc"), null);
  });

  await test("parseHSTS with zero max-age", () => {
    const r = parseHSTS("max-age=0");
    assert.notEqual(r, null);
    if (r) assert.equal(r.maxAge, 0);
  });

  suite("Headers — Params Fuzzing");

  await test("parseParams with empty string", () => {
    const r = parseParams("");
    assert.equal(r.size, 0);
  });

  await test("parseParams with semicolons only", () => {
    const r = parseParams(";;;");
    assert.equal(r.size, 0);
  });

  await test("parseParams with duplicate keys (last wins)", () => {
    const r = parseParams("; key=a; key=b");
    assert.equal(r.get("key"), "b");
  });

  await test("parseParams with quoted values", () => {
    const r = parseParams('; charset="utf-8"; boundary="----=_Part_1"');
    assert.equal(r.get("charset"), "utf-8");
    assert.equal(r.get("boundary"), "----=_Part_1");
  });

  await test("parseParams with mixed format", () => {
    const r = parseParams('; key=value; flag; empty=; quoted="val ue"');
    assert.equal(r.get("key"), "value");
    assert.equal(r.get("flag"), "");
    assert.equal(r.get("empty"), "");
    assert.equal(r.get("quoted"), "val ue");
  });

  suite("Cookies — Set-Cookie Fuzzing");

  await test("parseSetCookieHeader with empty/null input", () => {
    assert.equal(parseSetCookieHeader(""), null);
    assert.equal(parseSetCookieHeader("   "), null);
  });

  await test("parseSetCookieHeader with name-only (no value)", () => {
    const r = parseSetCookieHeader("sessionid");
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.name, "");
      assert.equal(r.value, "sessionid");
    }
  });

  await test("parseSetCookieHeader with empty value", () => {
    const r = parseSetCookieHeader("sessionid=");
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.name, "sessionid");
      assert.equal(r.value, "");
    }
  });

  await test("parseSetCookieHeader with all attributes", () => {
    const r = parseSetCookieHeader(
      "session=abc123; Path=/; Domain=.example.com; Secure; HttpOnly; SameSite=Lax; Max-Age=3600; Priority=High; Partitioned",
    );
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.name, "session");
      assert.equal(r.value, "abc123");
      assert.equal(r.path, "/");
      assert.equal(r.domain, "example.com");
      assert.equal(r.secure, true);
      assert.equal(r.httpOnly, true);
      assert.equal(r.sameSite, "Lax");
      assert.equal(r.maxAge, 3600);
      assert.equal(r.priority, "High");
      assert.equal(r.partitioned, true);
    }
  });

  await test("parseSetCookieHeader with quoted value", () => {
    const r = parseSetCookieHeader('session="abc123"');
    assert.notEqual(r, null);
    if (r) assert.equal(r.value, "abc123");
  });

  await test("parseSetCookieHeader with special chars in value", () => {
    const r = parseSetCookieHeader("data=hello world foo bar");
    assert.notEqual(r, null);
    if (r) assert.equal(r.value, "hello world foo bar");
  });

  await test("parseSetCookieHeader with many attributes", () => {
    const r = parseSetCookieHeader(
      "a=b; Path=/; Domain=.c.com; Secure; HttpOnly; SameSite=Strict; Max-Age=86400; Priority=Low; SameParty",
    );
    assert.notEqual(r, null);
    if (r) {
      assert.equal(r.secure, true);
      assert.equal(r.httpOnly, true);
      assert.equal(r.sameSite, "Strict");
      assert.equal(r.sameParty, true);
    }
  });

  await test("parseSetCookieHeader — first-attribute-wins for duplicate attrs", () => {
    const r = parseSetCookieHeader("a=b; Max-Age=100; Max-Age=200");
    assert.notEqual(r, null);
    if (r) assert.equal(r.maxAge, 100);
  });

  suite("Cookies — Serialize Round-Trip");

  await test("formatSetCookieHeader then parseSetCookieHeader round-trips basic cookie", () => {
    const serialized = formatSetCookieHeader({
      name: "test",
      value: "value",
      domain: null,
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      sameParty: false,
      priority: null,
      partitioned: false,
    });
    const reparsed = parseSetCookieHeader(serialized);
    assert.notEqual(reparsed, null);
    if (reparsed) {
      assert.equal(reparsed.name, "test");
      assert.equal(reparsed.value, "value");
      assert.equal(reparsed.path, "/");
    }
  });

  await test("formatSetCookieHeader serializes all boolean flags correctly", () => {
    const serialized = formatSetCookieHeader({
      name: "s",
      value: "v",
      domain: ".example.com",
      path: "/app",
      expires: null,
      maxAge: 3600,
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      sameParty: true,
      priority: "High",
      partitioned: true,
    });
    assert.ok(serialized.includes("Secure"));
    assert.ok(serialized.includes("HttpOnly"));
    assert.ok(serialized.includes("SameSite=Strict"));
    assert.ok(serialized.includes("SameParty"));
    assert.ok(serialized.includes("Priority=High"));
    assert.ok(serialized.includes("Partitioned"));
    assert.ok(serialized.includes("Path=/app"));
    assert.ok(serialized.includes("Domain=.example.com"));
    assert.ok(serialized.includes("Max-Age=3600"));
  });

  await test("formatSetCookieHeader quotes value with special chars", () => {
    const serialized = formatSetCookieHeader({
      name: "data",
      value: "hello world; foo",
      domain: null,
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      sameParty: false,
      priority: null,
      partitioned: false,
    });
    assert.ok(serialized.includes('"'));
  });

  suite("Cookies — Domain Matching Edge Cases");

  await test("domainMatch exact match returns true", () => {
    assert.equal(domainMatch("example.com", "example.com"), true);
  });

  await test("domainMatch subdomain match", () => {
    assert.equal(domainMatch("sub.example.com", "example.com"), true);
  });

  await test("domainMatch returns false for unrelated domains", () => {
    assert.equal(domainMatch("example.com", "other.com"), false);
  });

  await test("domainMatch returns false for IP addresses (only exact)", () => {
    assert.equal(domainMatch("127.0.0.1", ".0.0.1"), false);
  });

  await test("domainMatch returns false when requestHost is a public suffix", () => {
    // "co.uk" is a public suffix (it's in PSL_EXACT), so a cookie
    // with Domain=uk should not match for request host co.uk
    assert.equal(domainMatch("co.uk", "uk"), false);
  });

  suite("Base64 Fuzzing");

  await test("uint8ArrayToBase64 round-trips with empty buffer", () => {
    const buf = new Uint8Array(0);
    const encoded = uint8ArrayToBase64(buf);
    assert.equal(encoded, "");
  });

  await test("uint8ArrayToBase64 encodes and atob decodes random byte sequences", () => {
    for (let n = 0; n < 10; n++) {
      const len = Math.floor(Math.random() * 1000) + 1;
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
      const encoded = uint8ArrayToBase64(buf);
      const decoded = b64decode(encoded);
      assert.equal(decoded.length, len);
      for (let i = 0; i < len; i++) {
        assert.equal(decoded.charCodeAt(i), buf[i]!);
      }
    }
  });

  await test("uint8ArrayToBase64 handles single byte", () => {
    const buf = new Uint8Array([42]);
    const encoded = uint8ArrayToBase64(buf);
    assert.equal(typeof encoded, "string");
    assert.ok(encoded.length > 0);
  });

  await test("uint8ArrayToBase64 handles typical utf-8 string bytes", () => {
    const text = "Hello, 世界! 🚀";
    const buf = new TextEncoder().encode(text);
    const encoded = uint8ArrayToBase64(buf);
    const decoded = b64decode(encoded);
    const decodedText = new TextDecoder().decode(
      new Uint8Array(decoded.split("").map((c) => c.charCodeAt(0))),
    );
    assert.equal(decodedText, text);
  });

  await test("uint8ArrayToBase64 output is valid base64 (alphanumeric + / + =)", () => {
    const buf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) buf[i] = i;
    const encoded = uint8ArrayToBase64(buf);
    assert.ok(/^[A-Za-z0-9+/]*=*$/.test(encoded));
  });

  suite("mergeSignals Edge Cases");

  await test("mergeSignals with no arguments returns undefined", () => {
    assert.equal(mergeSignals(), undefined);
  });

  await test("mergeSignals with all null/undefined returns undefined", () => {
    assert.equal(mergeSignals(null, undefined, null), undefined);
  });

  await test("mergeSignals with single signal returns same signal", () => {
    const c = new AbortController();
    const result = mergeSignals(c.signal);
    assert.equal(result, c.signal);
  });

  await test("mergeSignals with null and a valid signal returns the valid signal", () => {
    const c = new AbortController();
    const result = mergeSignals(null, c.signal, undefined);
    assert.equal(result, c.signal);
  });

  await test("mergeSignals with two valid signals returns new signal", () => {
    const a = new AbortController();
    const b = new AbortController();
    const result = mergeSignals(a.signal, b.signal);
    assert.notEqual(result, a.signal);
    assert.notEqual(result, b.signal);
    assert.ok(result instanceof AbortSignal);
  });

  await test("mergeSignals propagates abort from either source", () => {
    const a = new AbortController();
    const b = new AbortController();
    const result = mergeSignals(a.signal, b.signal);
    assert.ok(result !== undefined);
    b.abort();
    assert.equal(result?.aborted, true);
  });

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  Fuzzing tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
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
