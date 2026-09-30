/**
 * headers.ts — Real-world battle tests
 * Tests all HTTP headers features with real network calls.
 *
 * Run: npx tsx tests/headers.test.mts
 *
 * APIs: httpbin.org, jsonplaceholder.typicode.com
 */

import assert from "node:assert/strict";
import process from "node:process";
import {
  kinetex,
  HttpHeaders,
  RichHeaders,
  HeaderName,
  isValidHeaderName,
  isValidHeaderValue,
  formatContentType,
  parseContentDisposition,
  formatContentDisposition,
  parseCacheControl,
  formatCacheControl,
  parseAuthorization,
  parseWWWAuthenticate,
  formatBearer,
  formatBasic,
  parseAccept,
  parseAcceptEncoding,
  parseAcceptLanguage,
  negotiateContentType,
  parseRange,
  parseContentRange,
  parseLinkHeader,
  formatLinkHeader,
  parseForwarded,
  normalizeForwardedHeaders,
  getClientIP,
  parseRetryAfter,
  parseHSTS,
  formatHSTS,
  parseCSP,
  formatCSP,
  parseServerTiming,
  formatServerTiming,
  parseAltSvc,
  parseWarning,
  parseParams,
  securityHeaders,
  corsHeaders,
  fromNodeHeaders,
  toNodeHeaders,
  fromWebHeaders,
  RichHeaders,
  createHeaders,
  createRequestHeaders,
  createResponseHeaders,
  createImmutableHeaders,
} from "../src/mod.ts";
// `parseContentType` exists in two places and `mod.ts` re-exports
// `response.ts`'s — a deliberately narrowed, DoS-guarded wrapper. Importing it
// from `mod.ts` meant this suite exercised the wrapper and never the
// `headers.ts` function it exists to test, whose `params` field was therefore
// untested. Take the module's own, like the three names above.
import {
  parseContentLanguage,
  parseWarning,
  parseParams,
  parseContentType,
} from "../src/headers.ts";
import { parseContentType as parseContentTypeResponse } from "../src/mod.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    let msg = String(err);
    if (err instanceof Error) {
      if (err.message && err.message !== "undefined") {
        msg = err.message;
      } else if ("cause" in err && err.cause instanceof Error && err.cause.message) {
        msg = err.cause.message;
      } else if ("errors" in err && Array.isArray((err as AggregateError).errors)) {
        const agErr = err as AggregateError;
        msg = agErr.errors.map((e) => e.message || String(e)).join("; ");
      } else if (typeof err === "object" && err !== null) {
        const str = JSON.stringify(err, Object.getOwnPropertyNames(err), 2).substring(0, 500);
        if (str !== "{}") msg = str;
      }
    }
    console.log(`  ❌  ${name}: ${msg || "Unknown error"}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

const T = 30_000;

// Real HTTP client for external API calls
const bin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

suite("HttpHeaders - basic operations");

await test("HttpHeaders constructor from object", async () => {
  const h = new HttpHeaders({ "content-type": "application/json", "x-custom": "value" });
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(h.get("x-custom"), "value");
});

await test("HttpHeaders append and get", async () => {
  const h = new HttpHeaders();
  h.append("x-test", "value1");
  h.append("x-test", "value2");
  assert.equal(h.get("x-test"), "value1, value2");
});

await test("HttpHeaders getAll returns array", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const all = h.getAll("set-cookie");
  assert.deepEqual(all, ["a=1", "b=2"]);
});

await test("HttpHeaders has check", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  assert.equal(h.has("x-test"), true);
  assert.equal(h.has("x-none"), false);
});

await test("HttpHeaders delete", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  h.delete("x-test");
  assert.equal(h.has("x-test"), false);
});

await test("HttpHeaders set overwrites", async () => {
  const h = new HttpHeaders();
  h.append("x-test", "value1");
  h.set("x-test", "value2");
  assert.equal(h.get("x-test"), "value2");
});

await test("HttpHeaders keys/values/entries iteration", async () => {
  const h = new HttpHeaders({ a: "1", b: "2" });
  // Exact sets: `includes` would not catch a duplicated or spurious entry.
  assert.deepEqual([...h.keys()].sort(), ["a", "b"]);
  assert.deepEqual([...h.values()].sort(), ["1", "2"]);
  assert.deepEqual(
    [...h.entries()].map(([k, v]) => [k, v]),
    [
      ["a", "1"],
      ["b", "2"],
    ],
  );
});

await test("HttpHeaders toObject", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const obj = h.toObject();
  assert.equal(obj["x-test"], "value");
});

await test("HttpHeaders toFlatObject", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const obj = h.toFlatObject();
  // `typeof === "string"` was satisfied by "" and by any non-string coercion;
  // a flat object that dropped the value entirely would also need a key.
  assert.deepEqual(obj, { "x-test": "value" });
  assert.deepEqual(Object.keys(obj), ["x-test"]);
  // A multi-valued header stays a single comma-joined string, not an array.
  const h2 = new HttpHeaders();
  h2.append("x-test", "a");
  h2.append("x-test", "b");
  assert.deepEqual(h2.toFlatObject(), { "x-test": "a, b" });
});

await test("HttpHeaders clone", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const clone = h.clone();
  assert.equal(clone.get("x-test"), "value");
});

await test("HttpHeaders freeze creates immutable", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const frozen = h.freeze();
  assert.equal(frozen.get("x-test"), "value");
});

await test("HttpHeaders size property", async () => {
  const h = new HttpHeaders({ a: "1", b: "2" });
  assert.equal(h.size, 2);
});

await test("HttpHeaders pick selects headers", async () => {
  const h = new HttpHeaders({ a: "1", b: "2", c: "3" });
  const picked = h.pick("a", "c");
  assert.equal(picked.get("a"), "1");
  assert.equal(picked.get("c"), "3");
  assert.equal(picked.has("b"), false);
});

await test("HttpHeaders omit removes headers", async () => {
  const h = new HttpHeaders({ a: "1", b: "2", c: "3" });
  const omitted = h.omit("b");
  assert.equal(omitted.get("a"), "1");
  assert.equal(omitted.has("b"), false);
});

await test("HttpHeaders redact sensitive values", async () => {
  const h = new HttpHeaders({ authorization: "secret", "x-public": "safe" });
  const redacted = h.redact("authorization");
  assert.equal(redacted.get("authorization"), "**REDACTED**");
  assert.equal(redacted.get("x-public"), "safe");
});

await test("HttpHeaders merge with append", async () => {
  const h = new HttpHeaders({ a: "1" });
  h.merge({ b: "2" }, { append: true });
  assert.equal(h.get("a"), "1");
  assert.equal(h.get("b"), "2");
});

await test("HttpHeaders diff returns differences", async () => {
  const h1 = new HttpHeaders({ a: "1" });
  const h2 = new HttpHeaders({ a: "1", b: "2" });
  const diff = h1.diff(h2);
  assert.equal(diff.get("b"), "2");
});

suite("HttpHeaders - guards");

await test("freeze() creates immutable copy", async () => {
  const h = new HttpHeaders({ a: "1" });
  const frozen = h.freeze();
  assert.equal(frozen.get("a"), "1");
});

await test("request guard forbids certain headers", async () => {
  const h = new HttpHeaders({}, "request");
  assert.throws(
    () => h.set("host", "example.com"),
    /forbidden|not allowed|request/i,
    "setting a forbidden request header must throw",
  );
  // The guard must not have silently written the value. (get() returns null
  // for a missing header, per its `string | null` signature.)
  assert.equal(h.get("host"), null);
  // ...and a permitted header on the same instance still works.
  h.set("x-allowed", "yes");
  assert.equal(h.get("x-allowed"), "yes");
});

await test("response guard forbids set-cookie", async () => {
  const h = new HttpHeaders({}, "response");
  assert.throws(
    () => h.set("set-cookie", "a=b"),
    /forbidden|not allowed|response/i,
    "setting a forbidden response header must throw",
  );
  assert.equal(h.get("set-cookie"), null);
  h.set("content-type", "application/json");
  assert.equal(h.get("content-type"), "application/json");
});

suite("HeaderName constants");

await test("HeaderName has known headers", async () => {
  assert.equal(HeaderName.ContentType, "content-type");
  assert.equal(HeaderName.Authorization, "authorization");
  assert.equal(HeaderName.CacheControl, "cache-control");
});

suite("isValidHeaderName / isValidHeaderValue");

await test("valid header names", async () => {
  assert.equal(isValidHeaderName("content-type"), true);
  assert.equal(isValidHeaderName("x-custom-header"), true);
  assert.equal(isValidHeaderName(""), false);
});

await test("valid header values", async () => {
  assert.equal(isValidHeaderValue("application/json"), true);
  assert.equal(isValidHeaderValue(""), true);
});

suite("parseContentType");

await test("the root and headers parseContentType are different by design", async () => {
  // `response.ts` exports its own `parseContentType` under the same name, and
  // the package root re-exports that one. Its JSDoc says it "delegates to
  // headers.ts for the actual parsing", and it deliberately differs in two
  // ways: it caps the input at 8 KB, and it narrows the result by dropping
  // `params`. Both are worth stating, because a user who reads the headers
  // documentation and imports from the root gets the other one.
  const viaHeaders = parseContentType("text/html; charset=utf-8; extra=1")!;
  assert.deepEqual(Object.keys(viaHeaders).sort(), [
    "boundary",
    "charset",
    "mediaType",
    "params",
    "subtype",
    "type",
  ]);
  assert.ok(viaHeaders.params instanceof Map);
  assert.deepEqual(
    [...viaHeaders.params],
    [
      ["charset", "utf-8"],
      ["extra", "1"],
    ],
  );

  const viaRoot = parseContentTypeResponse("text/html; charset=utf-8; extra=1")!;
  assert.deepEqual(Object.keys(viaRoot).sort(), [
    "boundary",
    "charset",
    "mediaType",
    "subtype",
    "type",
  ]);
  assert.equal("params" in (viaRoot as object), false);
  assert.equal(viaRoot.charset, "utf-8");
  assert.equal(viaRoot.mediaType, viaHeaders.mediaType);

  // The 8 KB guard exists only on the root export.
  const huge = `text/html; x=${"a".repeat(9000)}`;
  assert.notEqual(parseContentType(huge), null, "headers.ts does not cap its input");
  assert.equal(parseContentTypeResponse(huge), null, "the root export refuses it");
  assert.equal(parseContentTypeResponse(""), null);
});

await test("parseContentType basic", async () => {
  const ct = parseContentType("application/json");
  assert.equal(ct?.mediaType, "application/json");
  assert.equal(ct?.type, "application");
  assert.equal(ct?.subtype, "json");
});

await test("parseContentType with charset", async () => {
  const ct = parseContentType("text/html; charset=utf-8");
  assert.equal(ct?.charset, "utf-8");
});

await test("parseContentType with boundary", async () => {
  const ct = parseContentType("multipart/form-data; boundary=----abc");
  assert.equal(ct?.boundary, "----abc");
});

await test("formatContentType builds string", async () => {
  const ct = formatContentType({ mediaType: "text/html", charset: "utf-8" });
  assert.equal(ct, "text/html; charset=utf-8");
  // charset must be omitted entirely when not supplied.
  assert.equal(formatContentType({ mediaType: "text/html" }), "text/html");
});

suite("parseContentDisposition");

await test("parseContentDisposition attachment", async () => {
  const cd = parseContentDisposition('attachment; filename="test.txt"');
  assert.equal(cd?.type, "attachment");
  assert.equal(cd?.filename, "test.txt");
});

await test("parseContentDisposition form-data", async () => {
  const cd = parseContentDisposition('form-data; name="field"');
  assert.equal(cd?.type, "form-data");
  assert.equal(cd?.name, "field");
});

await test("formatContentDisposition builds string", async () => {
  const cd = formatContentDisposition({ type: "attachment", filename: "test.txt" });
  assert.equal(cd, 'attachment; filename="test.txt"');
  assert.equal(
    formatContentDisposition({ type: "form-data", name: "field" }),
    'form-data; name="field"',
  );
});

suite("parseCacheControl");

await test("parseCacheControl basic directives", async () => {
  const cc = parseCacheControl("no-cache, no-store, max-age=3600");
  assert.equal(cc.noCache, true);
  assert.equal(cc.noStore, true);
  assert.equal(cc.maxAge, 3600);
});

await test("parseCacheControl with stale-while-revalidate", async () => {
  const cc = parseCacheControl("max-age=3600, stale-while-revalidate=60");
  assert.equal(cc.staleWhileRevalidate, 60);
});

await test("formatCacheControl builds string", async () => {
  const cc = formatCacheControl({ maxAge: 3600, noCache: true });
  assert.equal(cc, "no-cache, max-age=3600");
  assert.equal(formatCacheControl({ public: true, maxAge: 60 }), "public, max-age=60");
  // An empty directive set must not emit stray separators.
  assert.equal(formatCacheControl({}), "");
});

suite("parseAuthorization");

await test("parseAuthorization Bearer", async () => {
  const auth = parseAuthorization("Bearer token123");
  assert.equal(auth?.scheme, "bearer");
  assert.equal(auth?.token, "token123");
});

await test("parseAuthorization Basic", async () => {
  const auth = parseAuthorization("Basic dXNlcjpwYXNz");
  assert.equal(auth?.scheme, "basic");
  assert.equal(auth?.basic?.username, "user");
  assert.equal(auth?.basic?.password, "pass");
});

await test("formatBearer builds string", async () => {
  const b = formatBearer("my-token");
  assert.equal(b, "Bearer my-token");
});

await test("formatBasic builds string", async () => {
  const b = formatBasic("user", "pass");
  // Exact base64 of "user:pass" — a wrong encoding would still start with "Basic ".
  assert.equal(b, "Basic dXNlcjpwYXNz");
  assert.equal(formatBasic("u", "p"), `Basic ${Buffer.from("u:p").toString("base64")}`);
});

suite("parseWWWAuthenticate");

await test("parseWWWAuthenticate Bearer challenge", async () => {
  const challenges = parseWWWAuthenticate('Bearer realm="test"');
  assert.equal(challenges[0]?.scheme, "bearer");
  assert.equal(challenges[0]?.realm, "test");
});

suite("parseAccept / Accept-Encoding / Accept-Language");

await test("parseAccept with quality", async () => {
  const accept = parseAccept("text/html, application/json;q=0.9");
  assert.equal(accept[0]?.value, "text/html");
  assert.equal(accept[0]?.quality, 1);
});

await test("parseAccept sorts by quality", async () => {
  const accept = parseAccept("text/plain;q=0.5, text/html;q=0.8, text/xml;q=0.7");
  assert.equal(accept[0]?.value, "text/html");
});

await test("negotiateContentType picks wildcard match", async () => {
  const match = negotiateContentType("text/*", ["text/html", "image/png"]);
  assert.equal(match, "text/html");
});

await test("negotiateContentType wildcard no match returns null", async () => {
  const match = negotiateContentType("audio/*", ["text/html", "image/png"]);
  assert.equal(match, null);
});

await test("negotiateContentType star-star with empty available", async () => {
  const match = negotiateContentType("*/*", []);
  assert.equal(match, null);
});

await test("negotiateContentType star-star returns first available", async () => {
  const match = negotiateContentType("*/*", ["text/html", "image/png"]);
  assert.equal(match, "text/html");
});

suite("parseRange / parseContentRange");

await test("parseRange bytes", async () => {
  const range = parseRange("bytes=0-99");
  assert.equal(range?.unit, "bytes");
  assert.equal(range?.ranges[0]?.start, 0);
  assert.equal(range?.ranges[0]?.end, 99);
});

await test("parseContentRange", async () => {
  const cr = parseContentRange("bytes 200-999/1234");
  assert.equal(cr?.unit, "bytes");
  assert.equal(cr?.start, 200);
  assert.equal(cr?.end, 999);
  assert.equal(cr?.total, 1234);
});

suite("parseLinkHeader");

await test("parseLinkHeader basic", async () => {
  const links = parseLinkHeader('<https://example.com>; rel="preload"');
  assert.equal(links[0]?.uri, "https://example.com");
  assert.equal(links[0]?.rel, "preload");
});

await test("formatLinkHeader builds string", async () => {
  const links = formatLinkHeader([{ uri: "https://example.com", rel: "preload" }]);
  assert.equal(links, '<https://example.com>; rel="preload"');
  assert.equal(
    formatLinkHeader([
      { uri: "https://a.com/x", rel: "next", title: "Next page", type: "text/html" },
    ]),
    '<https://a.com/x>; rel="next"; type="text/html"; title="Next page"',
  );
});

suite("parseForwarded / normalizeForwardedHeaders");

await test("parseForwarded header", async () => {
  const fwd = parseForwarded("by=192.168.1.1; for=10.0.0.1");
  assert.deepEqual(fwd.for, ["10.0.0.1"]);
  assert.equal(fwd.host, null);
  assert.equal(fwd.proto, null);
  // Two elements, the second carrying all three parameters.
  const two = parseForwarded("for=192.0.2.43, for=198.51.100.17;by=203.0.113.60;proto=http");
  assert.deepEqual(two.for, ["192.0.2.43", "198.51.100.17"]);
  assert.equal(two.by, "203.0.113.60");
  assert.equal(two.proto, "http");
  // A quoted IPv6 node: the quotes are removed, the brackets and port are not
  // — parseForwarded does not strip ports, only getClientIP does.
  assert.deepEqual(parseForwarded('for="[2001:db8::1]:8080"').for, ["[2001:db8::1]:8080"]);
  assert.deepEqual(parseForwarded("for=192.0.2.43:1234").for, ["192.0.2.43:1234"]);
});

await test("normalizeForwardedHeaders from X-Forwarded-For", async () => {
  const h = new HttpHeaders();
  h.set("x-forwarded-for", "203.0.113.1, 70.41.3.18");
  const fwd = normalizeForwardedHeaders(h);
  assert.deepEqual(fwd.for, ["203.0.113.1", "70.41.3.18"]);
  assert.deepEqual(
    { by: fwd.by, host: fwd.host, proto: fwd.proto },
    { by: null, host: null, proto: null },
  );
});

await test("getClientIP returns client IP", async () => {
  const h = new HttpHeaders();
  h.set("x-forwarded-for", "203.0.113.1");
  const ip = getClientIP(h);
  assert.equal(ip, "203.0.113.1");
});

suite("parseRetryAfter");

await test("parseRetryAfter delta-seconds", async () => {
  const ra = parseRetryAfter("3600");
  assert.equal(ra.delay, 3600);
});

await test("parseRetryAfter HTTP-date", async () => {
  const ra = parseRetryAfter("Fri, 01 Jan 2038 00:00:00 GMT");
  assert.notEqual(ra.date, null);
});

suite("parseHSTS / formatHSTS");

await test("parseHSTS basic", async () => {
  const hsts = parseHSTS("max-age=31536000; includeSubDomains");
  assert.equal(hsts?.maxAge, 31536000);
  assert.equal(hsts?.includeSubDomains, true);
});

await test("formatHSTS builds string", async () => {
  const hsts = formatHSTS({ maxAge: 31536000, includeSubDomains: true, preload: false });
  // preload:false must not emit the directive.
  assert.equal(hsts, "max-age=31536000; includeSubDomains");
});

suite("parseCSP / formatCSP");

await test("parseCSP basic", async () => {
  const csp = parseCSP("default-src 'self'; script-src 'unsafe-inline'");
  assert.deepEqual(Array.from(csp.entries()), [
    ["default-src", ["'self'"]],
    ["script-src", ["'unsafe-inline'"]],
  ]);
});

await test("formatCSP builds string", async () => {
  const csp = formatCSP(new Map([["default-src", ["'self'"]]]));
  assert.equal(csp, "default-src 'self'");
  // A directive with no values must be emitted bare, without a trailing space.
  assert.equal(
    formatCSP(new Map([["upgrade-insecure-requests", []]])),
    "upgrade-insecure-requests",
  );
});

suite("parseServerTiming / formatServerTiming");

await test("parseServerTiming basic", async () => {
  const st = parseServerTiming('db;dur=50;desc="Query"');
  assert.equal(st[0]?.name, "db");
  assert.equal(st[0]?.duration, 50);
});

await test("formatServerTiming builds string", async () => {
  const st = formatServerTiming([{ name: "db", duration: 50, description: "Query" }]);
  assert.equal(st, 'db;dur=50;desc="Query"');
});

suite("parseAltSvc");

await test("parseAltSvc clear", async () => {
  const entries = parseAltSvc("clear");
  assert.equal(entries.length, 0);
});

await test("parseAltSvc with entries", async () => {
  const entries = parseAltSvc('h2="example.com:443"; ma=3600');
  assert.equal(entries[0]?.host, "example.com");
});

suite("securityHeaders");

await test("securityHeaders default creates secure headers", async () => {
  const h = securityHeaders();
  assert.deepEqual(h.toObject(), {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
});

await test("securityHeaders with options", async () => {
  const h = securityHeaders({ hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } });
  const hsts = h.get("strict-transport-security");
  console.log("    Generated HSTS:", hsts);
  assert.equal(hsts, "max-age=31536000; includeSubDomains; preload");
});

suite("corsHeaders");

await test("corsHeaders basic", async () => {
  const h = corsHeaders({ origin: "https://example.com" });
  assert.equal(h.get("access-control-allow-origin"), "https://example.com");
});

await test("corsHeaders with credentials", async () => {
  const h = corsHeaders({ origin: "https://example.com", credentials: true });
  assert.equal(h.get("access-control-allow-credentials"), "true");
});

suite("fromNodeHeaders / toNodeHeaders");

await test("fromNodeHeaders converts Node-style headers", async () => {
  const nodeHeaders = { "content-type": "application/json", "x-custom": "value" };
  const h = fromNodeHeaders(nodeHeaders);
  assert.equal(h.get("content-type"), "application/json");
});

await test("toNodeHeaders converts to Node-style", async () => {
  const h = new HttpHeaders({ "content-type": "application/json" });
  const nodeHeaders = toNodeHeaders(h);
  assert.deepEqual(nodeHeaders, { "content-type": "application/json" });
});

suite("fromWebHeaders");

await test("fromWebHeaders converts WHATWG Headers", async () => {
  const webHeaders = new Headers({ "content-type": "application/json" });
  const h = fromWebHeaders(webHeaders);
  assert.equal(h.get("content-type"), "application/json");
});

suite("REAL HTTP CALLS - httpbin.org Headers API");

await test("GET /headers returns request headers", async () => {
  const r = await bin.get<{ headers: Record<string, string> }>("/headers");
  assert.equal(r.status, 200);
  assert.ok(r.data.headers);
});

await test("GET /response-headers returns custom headers", async () => {
  const r = await bin.get<Record<string, string>>("/response-headers", {
    params: { "x-custom-header": "test-value" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data["x-custom-header"], "test-value");
});

await test("POST /post with headers", async () => {
  const r = await bin.post<{ headers: Record<string, string>; json: Record<string, unknown> }>(
    "/post",
    JSON.stringify({ test: "data" }),
    { headers: { "content-type": "application/json", "x-test": "value" } },
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.json.test, "data");
});

suite("REAL HTTP CALLS - httpbin.org IP detection");

await test("GET /ip returns origin IP", async () => {
  const r = await bin.get<{ origin: string }>("/ip");
  console.log("    Real API origin (IP):", r.data.origin);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ["origin"]);
  // httpbin echoes the caller's address, so it is either a dotted quad or an
  // IPv6 literal. `includes(".")` passed for "..." and for "1.2.3".
  assert.match(r.data.origin, /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i);
  const octets = r.data.origin.split(".");
  if (octets.length === 4) {
    for (const o of octets) assert.ok(Number(o) <= 255, `octet out of range: ${o}`);
  }
});

suite("REAL HTTP CALLS - httpbin.org/uuid");

await test("GET /uuid returns unique ID", async () => {
  const r = await bin.get<{ uuid: string }>("/uuid");
  console.log("    Real API uuid:", r.data.uuid);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ["uuid"]);
  // A v4 UUID: 8-4-4-4-12 hex, version nibble 4, RFC 4122 variant. `includes("-")`
  // passed for "a-b".
  assert.match(
    r.data.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // ...and it must actually be unique.
  assert.notEqual(r.data.uuid, (await bin.get<{ uuid: string }>("/uuid")).data.uuid);
});

suite("REAL HTTP CALLS - httpbin.org JSON endpoint");

const json = kinetex({
  baseURL: "https://httpbin.org",
  timeout: T,
});

await test("GET /json returns JSON response with headers", async () => {
  const r = await json.get<{ slides?: { title: string; text: string } }>("/json");
  console.log("    Response headers:", r.headers);
  assert.equal(r.status, 200);
});

await test("GET /get with custom header", async () => {
  const r = await json.get<{ headers: Record<string, string> }>("/get", {
    headers: { "x-api-key": "test-key" },
  });
  console.log("    Custom header value:", r.data.headers["X-Api-Key"]);
  assert.equal(r.status, 200);
  assert.equal(r.data.headers["X-Api-Key"], "test-key");
});

suite("Edge cases for header parsing");

await test("parseContentType returns null for empty", async () => {
  const ct = parseContentType("");
  assert.equal(ct, null);
});

await test("parseCacheControl handles unknown directives", async () => {
  const cc = parseCacheControl("unknown-directive=123");
  assert.deepEqual([...cc.unknown.entries()], [["unknown-directive", "123"]]);
});

await test("HttpHeaders handles case-insensitive keys", async () => {
  const h = new HttpHeaders({ "Content-Type": "application/json" });
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(h.get("CONTENT-TYPE"), "application/json");
});

await test("HttpHeaders toHTTP1String", async () => {
  const h = new HttpHeaders({ a: "1", b: "2" });
  const http1 = h.toHTTP1String();
  assert.equal(http1, "a: 1\r\nb: 2");
});

suite("Headers guard edge cases");

await test("freeze() can create immutable copy", async () => {
  const h = new HttpHeaders({ a: "1" });
  const frozen = h.freeze();
  assert.equal(frozen.get("a"), "1");
});

await test("request guard - can be created", async () => {
  const h = new HttpHeaders({ a: "1" }, "request");
  assert.equal(h.size, 1);
});

await test("response guard - can be created", async () => {
  const h = new HttpHeaders({ a: "1" }, "response");
  assert.equal(h.size, 1);
});

suite("RichHeaders - typed getters");

await test("RichHeaders contentType getter", async () => {
  const h = new RichHeaders();
  h.set("content-type", "text/html; charset=utf-8");
  const ct = h.contentType;
  assert.equal(ct?.mediaType, "text/html");
});

await test("RichHeaders contentType setter (string)", async () => {
  const h = new RichHeaders();
  h.contentType = "application/json";
  assert.equal(h.get("content-type"), "application/json");
});

await test("RichHeaders contentType setter (object)", async () => {
  const h = new RichHeaders();
  h.contentType = { mediaType: "text/html", charset: "utf-8" };
  assert.equal(h.get("content-type"), "text/html; charset=utf-8");
});

await test("RichHeaders contentLength getter", async () => {
  const h = new RichHeaders();
  h.set("content-length", "1234");
  assert.equal(h.contentLength, 1234);
});

await test("RichHeaders contentLength setter", async () => {
  const h = new RichHeaders();
  h.contentLength = 5678;
  assert.equal(h.get("content-length"), "5678");
});

await test("RichHeaders cacheControl getter", async () => {
  const h = new RichHeaders();
  h.set("cache-control", "max-age=3600, no-cache");
  const cc = h.cacheControl;
  assert.equal(cc?.maxAge, 3600);
});

await test("RichHeaders cacheControl setter", async () => {
  const h = new RichHeaders();
  h.cacheControl = { maxAge: 7200, noStore: true };
  assert.equal(h.get("cache-control"), "no-store, max-age=7200");
});

suite("Factory helpers");

await test("createHeaders default", async () => {
  const h = createHeaders({ a: "1" });
  assert.equal(h.get("a"), "1");
});

await test("createRequestHeaders", async () => {
  const h = createRequestHeaders({ a: "1" });
  assert.equal(h.get("a"), "1");
});

await test("createResponseHeaders", async () => {
  const h = createResponseHeaders({ a: "1" });
  assert.equal(h.get("a"), "1");
});

await test("createImmutableHeaders", async () => {
  try {
    const h = createImmutableHeaders({ a: "1" });
    assert.equal(h.size, 1);
  } catch (e) {
    console.log("    createImmutableHeaders error:", (e as Error).message);
  }
});

suite("RichHeaders - additional typed getters");

await test("RichHeaders date getter", async () => {
  const h = new RichHeaders();
  h.set("date", "Wed, 06 May 2026 12:00:00 GMT");
  const d = h.date;
  assert.equal(d instanceof Date ? d.toISOString() : null, "2026-05-06T12:00:00.000Z");
});

await test("RichHeaders age getter", async () => {
  const h = new RichHeaders();
  h.set("age", "3600");
  assert.equal(h.age, 3600);
});

await test("RichHeaders vary getter", async () => {
  const h = new RichHeaders();
  h.set("vary", "Accept, Accept-Encoding");
  const vary = h.vary;
  assert.deepEqual(vary, ["accept", "accept-encoding"]);
});

await test("RichHeaders clientIP getter", async () => {
  const h = new RichHeaders();
  h.set("x-forwarded-for", "203.0.113.1");
  assert.equal(h.clientIP, "203.0.113.1");
});

await test("RichHeaders forwarded getter", async () => {
  const h = new RichHeaders();
  h.set("x-forwarded-for", "203.0.113.1");
  const fwd = h.forwarded;
  assert.equal(fwd.for.length, 1);
  assert.equal(fwd.for[0], "203.0.113.1");
});

await test("RichHeaders host getter", async () => {
  const h = new RichHeaders();
  h.set("host", "example.com");
  assert.equal(h.host, "example.com");
});

await test("RichHeaders origin getter", async () => {
  const h = new RichHeaders();
  h.set("origin", "https://example.com");
  assert.equal(h.origin, "https://example.com");
});

await test("RichHeaders userAgent getter", async () => {
  const h = new RichHeaders();
  h.set("user-agent", "TestAgent/1.0");
  assert.equal(h.userAgent, "TestAgent/1.0");
});

await test("RichHeaders location getter", async () => {
  const h = new RichHeaders();
  h.set("location", "https://example.com/page");
  assert.equal(h.location, "https://example.com/page");
});

await test("RichHeaders date null case", async () => {
  const h = new RichHeaders();
  assert.equal(h.date, null);
});

await test("RichHeaders age null case", async () => {
  const h = new RichHeaders();
  assert.equal(h.age, null);
});

await test("RichHeaders contentLength null setter", async () => {
  const h = new RichHeaders();
  h.set("content-length", "100");
  h.contentLength = null;
  assert.equal(h.has("content-length"), false);
});

await test("RichHeaders contentType null setter", async () => {
  const h = new RichHeaders();
  h.set("content-type", "text/html");
  h.contentType = null;
  assert.equal(h.has("content-type"), false);
});

await test("RichHeaders cacheControl null setter", async () => {
  const h = new RichHeaders();
  h.set("cache-control", "max-age=3600");
  h.cacheControl = null;
  assert.equal(h.has("cache-control"), false);
});

suite("Additional RichHeaders getters");

await test("RichHeaders etag getter", async () => {
  const h = new RichHeaders();
  h.set("etag", '"abc123"');
  assert.equal(h.etag, '"abc123"');
});

await test("RichHeaders lastModified getter", async () => {
  const h = new RichHeaders();
  h.set("last-modified", "Wed, 06 May 2026 12:00:00 GMT");
  const lm = h.lastModified;
  assert.equal(lm instanceof Date ? lm.toISOString() : null, "2026-05-06T12:00:00.000Z");
});

await test("RichHeaders expires getter", async () => {
  const h = new RichHeaders();
  h.set("expires", "Thu, 07 May 2027 12:00:00 GMT");
  assert.equal(
    h.expires instanceof Date ? h.expires.toISOString() : null,
    "2027-05-07T12:00:00.000Z",
  );
});

await test("RichHeaders contentEncoding getter", async () => {
  const h = new RichHeaders();
  h.set("content-encoding", "gzip");
  console.log("    contentEncoding:", h.contentEncoding);
  assert.equal(h.contentEncoding, "gzip");
});

await test("RichHeaders contentLanguage getter", async () => {
  const h = new RichHeaders();
  h.set("content-language", "en-US");
  console.log("    contentLanguage:", h.contentLanguage);
  assert.equal(h.contentLanguage, "en-US");
});

await test("RichHeaders contentLocation getter", async () => {
  const h = new RichHeaders();
  h.set("content-location", "https://example.com/page");
  console.log("    contentLocation:", h.contentLocation);
  assert.equal(h.contentLocation, "https://example.com/page");
});

await test("RichHeaders hsts getter", async () => {
  const h = new RichHeaders();
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  const hsts = h.hsts;
  assert.equal(hsts?.maxAge, 31536000);
});

await test("RichHeaders hsts setter", async () => {
  const h = new RichHeaders();
  h.hsts = { maxAge: 31536000, includeSubDomains: true, preload: false };
  assert.equal(h.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
});

await test("RichHeaders csp getter", async () => {
  const h = new RichHeaders();
  h.set("content-security-policy", "default-src 'self'");
  const csp = h.csp;
  assert.equal(csp?.get("default-src")?.[0], "'self'");
});

await test("RichHeaders csp setter", async () => {
  const h = new RichHeaders();
  h.csp = "default-src 'self'";
  assert.equal(h.get("content-security-policy"), "default-src 'self'");
});

await test("RichHeaders serverTiming getter", async () => {
  const h = new RichHeaders();
  h.set("server-timing", "db;dur=50");
  const st = h.serverTiming;
  assert.equal(st.length, 1);
  assert.equal(st[0].name, "db");
  assert.equal(st[0].duration, 50);
});

await test("RichHeaders authorization getter", async () => {
  const h = new RichHeaders();
  h.set("authorization", "Bearer token123");
  const auth = h.authorization;
  assert.equal(auth?.scheme, "bearer");
  assert.equal(auth?.token, "token123");
});

await test("RichHeaders authorization setter", async () => {
  const h = new RichHeaders();
  h.authorization = formatBearer("test-token");
  assert.equal(h.get("authorization"), "Bearer test-token");
});

await test("RichHeaders wwwAuthenticate getter", async () => {
  const h = new RichHeaders();
  h.set("www-authenticate", 'Bearer realm="test"');
  const www = h.wwwAuthenticate;
  assert.equal(www?.[0]?.scheme, "bearer");
  assert.equal(www?.[0]?.realm, "test");
});

await test("RichHeaders accept getter", async () => {
  const h = new RichHeaders();
  h.set("accept", "application/json");
  const accept = h.accept;
  assert.equal(accept?.[0]?.value, "application/json");
  assert.equal(accept?.[0]?.quality, 1);
});

await test("RichHeaders acceptEncoding getter", async () => {
  const h = new RichHeaders();
  h.set("accept-encoding", "gzip, deflate");
  const ae = h.acceptEncoding;
  assert.equal(ae?.[0]?.value, "gzip");
  assert.equal(ae?.[1]?.value, "deflate");
});

await test("RichHeaders acceptLanguage getter", async () => {
  const h = new RichHeaders();
  h.set("accept-language", "en-US");
  const al = h.acceptLanguage;
  assert.equal(al?.[0]?.value, "en-US");
});

await test("RichHeaders link getter", async () => {
  const h = new RichHeaders();
  h.set("link", '<https://example.com>; rel="preload"');
  const link = h.link;
  assert.equal(link?.uri, "https://example.com");
  assert.equal(link?.rel, "preload");
});

await test("RichHeaders contentDisposition getter", async () => {
  const h = new RichHeaders();
  h.set("content-disposition", 'attachment; filename="test.txt"');
  const cd = h.contentDisposition;
  assert.equal(cd?.type, "attachment");
  assert.equal(cd?.filename, "test.txt");
});

await test("RichHeaders contentDisposition setter", async () => {
  const h = new RichHeaders();
  h.contentDisposition = { type: "attachment", filename: "test.txt" };
  assert.equal(h.get("content-disposition"), 'attachment; filename="test.txt"');
});

await test("RichHeaders retryAfter getter", async () => {
  const h = new RichHeaders();
  h.set("retry-after", "3600");
  const ra = h.retryAfter;
  assert.equal(ra?.delay, 3600);
});

await test("RichHeaders altSvc getter", async () => {
  const h = new RichHeaders();
  h.set("alt-svc", 'h2="example.com:443"; ma=3600');
  const as = h.altSvc;
  assert.equal(as?.[0]?.protocol, "h2");
  assert.equal(as?.[0]?.host, "example.com");
  assert.equal(as?.[0]?.port, 443);
});

await test("RichHeaders xRequestedWith getter", async () => {
  const h = new RichHeaders();
  h.set("x-requested-with", "XMLHttpRequest");
  assert.equal(h.xRequestedWith, "XMLHttpRequest");
});

suite("More RichHeaders getters");

await test("RichHeaders range getter", async () => {
  const h = new RichHeaders();
  h.set("range", "bytes=0-99");
  const range = h.range;
  assert.equal(range?.ranges[0]?.start, 0);
});

await test("RichHeaders contentRange getter", async () => {
  const h = new RichHeaders();
  h.set("content-range", "bytes 200-999/1234");
  const cr = h.contentRange;
  assert.equal(cr?.start, 200);
});

await test("RichHeaders etag setter with quotes", async () => {
  const h = new RichHeaders();
  h.etag = "abc123";
  const etagValue = h.etag;
  console.log("    etag value:", etagValue);
  assert.equal(etagValue, '"abc123"');
});

await test("RichHeaders etag setter null", async () => {
  const h = new RichHeaders();
  h.set("etag", '"abc"');
  h.etag = null;
  assert.equal(h.has("etag"), false);
});

await test("RichHeaders links getter", async () => {
  const h = new RichHeaders();
  h.set("link", '<https://a.com>; rel="a", <https://b.com>; rel="b"');
  const links = h.links;
  assert.deepEqual(
    links?.map((l) => [l.uri, l.rel]),
    [
      ["https://a.com", "a"],
      ["https://b.com", "b"],
    ],
  );
});

await test("RichHeaders allow getter", async () => {
  const h = new RichHeaders();
  h.set("allow", "GET, POST");
  console.log("    allow:", h.allow);
  assert.equal(h.allow, "GET, POST");
});

await test("RichHeaders server getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    server from httpbin:", h.server);
  assert.equal(r.status, 200);
});

await test("RichHeaders acceptRanges getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    acceptRanges from httpbin:", h.acceptRanges);
  assert.equal(r.status, 200);
});

await test("RichHeaders accessControlAllowOrigin getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    accessControlAllowOrigin from httpbin:", h.accessControlAllowOrigin);
  assert.equal(r.status, 200);
});

await test("RichHeaders accessControlAllowMethods getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    accessControlAllowMethods from httpbin:", h.accessControlAllowMethods);
  assert.equal(r.status, 200);
});

await test("RichHeaders accessControlAllowHeaders getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    accessControlAllowHeaders from httpbin:", h.accessControlAllowHeaders);
  assert.equal(r.status, 200);
});

await test("RichHeaders accessControlMaxAge getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    accessControlMaxAge from httpbin:", h.accessControlMaxAge);
  assert.equal(r.status, 200);
});

await test("RichHeaders accessControlCredentials getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    accessControlCredentials from httpbin:", h.accessControlCredentials);
  assert.equal(r.status, 200);
});

await test("RichHeaders xPoweredBy getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    xPoweredBy from httpbin:", h.xPoweredBy);
  assert.equal(r.status, 200);
});

await test("RichHeaders xRequestID getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    xRequestID from httpbin:", h.xRequestID);
  assert.equal(r.status, 200);
});

await test("RichHeaders xCorrelationID getter", async () => {
  const h = new RichHeaders();
  h.set("x-correlation-id", "corr-456");
  console.log("    xCorrelationID:", h.xCorrelationID);
  assert.equal(h.xCorrelationID, "corr-456");
});

await test("RichHeaders xRateLimitLimit getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    xRateLimitLimit from httpbin:", h.xRateLimitLimit);
  assert.equal(r.status, 200);
});

await test("RichHeaders xRateLimitRemaining getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    xRateLimitRemaining from httpbin:", h.xRateLimitRemaining);
  assert.equal(r.status, 200);
});

await test("RichHeaders xRateLimitReset getter - real HTTP", async () => {
  const r = await bin.get("/get");
  const h = new RichHeaders(r.headers as Record<string, string>);
  console.log("    xRateLimitReset from httpbin:", h.xRateLimitReset);
  assert.equal(r.status, 200);
});

await test("RichHeaders secFetchSite getter", async () => {
  const h = new RichHeaders();
  assert.equal(h.secFetchSite, null, "unset header must read as null");
  h.set("sec-fetch-site", "same-origin");
  assert.equal(h.secFetchSite, "same-origin");
  // Header names are case-insensitive on the wire.
  h.set("SEC-FETCH-SITE", "cross-site");
  assert.equal(h.secFetchSite, "cross-site", "lookup must be case-insensitive");
});

await test("RichHeaders secFetchMode getter", async () => {
  const h = new RichHeaders();
  assert.equal(h.secFetchMode, null, "unset header must read as null");
  h.set("sec-fetch-mode", "cors");
  assert.equal(h.secFetchMode, "cors");
});

await test("RichHeaders secFetchUser getter", async () => {
  const h = new RichHeaders();
  assert.equal(h.secFetchUser, null, "unset header must read as null");
  h.set("sec-fetch-user", "?1");
  // The value is opaque: "?1" must survive verbatim, not become `true`.
  assert.equal(h.secFetchUser, "?1");
});

await test("RichHeaders secFetchDest getter", async () => {
  const h = new RichHeaders();
  assert.equal(h.secFetchDest, null, "unset header must read as null");
  h.set("sec-fetch-dest", "empty");
  assert.equal(h.secFetchDest, "empty");
});

await test("RichHeaders earlyData getter", async () => {
  const h = new RichHeaders();
  assert.equal(h.earlyData, null, "unset header must read as null");
  h.set("early-data", "1");
  assert.equal(h.earlyData, 1, "earlyData is parsed as a number, not left a string");
  // A value that is not a number must be null, not NaN — NaN would propagate
  // silently into any comparison the caller makes.
  h.set("early-data", "nope");
  assert.equal(h.earlyData, null, "a non-numeric value must read as null, not NaN");
});

await test("RichHeaders priority getter", async () => {
  const h = new RichHeaders();
  h.set("priority", "u=high");
  console.log("    priority:", h.priority);
  assert.equal(h.priority, "u=high");
});

await test("corsHeaders with maxAge option", async () => {
  const h = corsHeaders({ origin: "https://example.com", maxAge: 3600 });
  console.log("    corsHeaders maxAge:", h.get("access-control-max-age"));
  assert.equal(h.get("access-control-max-age"), "3600");
});

await test("RichHeaders xRateLimitLimit with invalid value", async () => {
  const h = new RichHeaders();
  h.set("x-ratelimit-limit", "not-a-number");
  console.log("    xRateLimitLimit invalid:", h.xRateLimitLimit);
  assert.equal(h.xRateLimitLimit, null);
});

await test("RichHeaders xRateLimitRemaining with invalid value", async () => {
  const h = new RichHeaders();
  h.set("x-ratelimit-remaining", "invalid");
  console.log("    xRateLimitRemaining invalid:", h.xRateLimitRemaining);
  assert.equal(h.xRateLimitRemaining, null);
});

await test("RichHeaders xRateLimitReset with invalid value", async () => {
  const h = new RichHeaders();
  h.set("x-ratelimit-reset", "abc");
  console.log("    xRateLimitReset invalid:", h.xRateLimitReset);
  assert.equal(h.xRateLimitReset, null);
});

await test("RichHeaders accessControlMaxAge with invalid value", async () => {
  const h = new RichHeaders();
  h.set("access-control-max-age", "notanumber");
  console.log("    accessControlMaxAge invalid:", h.accessControlMaxAge);
  assert.equal(h.accessControlMaxAge, null);
});

await test("headers.forEach iteration", async () => {
  const h = new RichHeaders({ a: "1", b: "2" });
  let count = 0;
  h.forEach((value, name) => {
    count++;
  });
  console.log("    Iterated over", count, "headers");
  assert.equal(count, 2);
});

await test("headers.toWebHeaders", async () => {
  const h = new RichHeaders({ "x-a": "1", "content-type": "application/json" });
  const webH = h.toWebHeaders();
  assert.ok(webH instanceof Headers, "toWebHeaders must return a Headers instance");
  assert.equal(webH.get("x-a"), "1");
  assert.equal(webH.get("content-type"), "application/json");
  // Round-trip: a Headers object built from these values reads back identically.
  const round = new RichHeaders(webH);
  assert.equal(round.get("x-a"), "1");
});

await test("headers.toHTTP1String format", async () => {
  const h = new HttpHeaders({ "content-type": "application/json" });
  const str = h.toHTTP1String();
  console.log("    HTTP/1.1 string:", str);
  assert.equal(str, "content-type: application/json");
});

await test("HttpHeaders from constructed with array of pairs", async () => {
  const h = new HttpHeaders([
    ["a", "1"],
    ["b", "2"],
  ]);
  assert.equal(h.get("a"), "1");
  assert.equal(h.get("b"), "2");
});

await test("HttpHeaders from constructed with null", async () => {
  const h = new HttpHeaders(null);
  assert.equal(h.size, 0);
});

suite("Bug fix: HT (tab) allowed in header values");

await test("isValidHeaderValue allows HT (tab) characters", async () => {
  assert.equal(isValidHeaderValue("application/json"), true);
  assert.equal(isValidHeaderValue(""), true);
});

suite("Bug fix: parseAltSvc host without port");

await test("parseAltSvc hostname without port", async () => {
  const entries = parseAltSvc('h2="example.com"; ma=3600');
  assert.equal(entries[0]?.host, "example.com");
  assert.equal(entries[0]?.port, 443);
});

await test("parseAltSvc IPv6 without port", async () => {
  const entries = parseAltSvc('h2="[::1]"; ma=3600');
  assert.equal(entries[0]?.host, "[::1]");
  assert.equal(entries[0]?.port, 443);
});

await test("parseAltSvc with all options", async () => {
  const entries = parseAltSvc('h2=":8080"; ma=3600, h3="other.com:443"; ma=86400; persist=1');
  assert.equal(entries.length, 2);
  assert.equal(entries[1]?.host, "other.com");
  assert.equal(entries[1]?.port, 443);
  assert.equal(entries[1]?.maxAge, 86400);
  assert.equal(entries[1]?.persist, true);
});

suite("Bug fix: wwwAuthenticate setter");

await test("RichHeaders wwwAuthenticate setter produces correct output", async () => {
  const h = new RichHeaders();
  h.wwwAuthenticate = [{ scheme: "bearer", realm: "test", params: new Map([["realm", "test"]]) }];
  const v = h.get("www-authenticate");
  assert.equal(v, 'bearer realm="test"');
});

await test("RichHeaders wwwAuthenticate setter with extra params", async () => {
  const h = new RichHeaders();
  h.wwwAuthenticate = [
    {
      scheme: "digest",
      realm: "test",
      params: new Map([
        ["realm", "test"],
        ["nonce", "abc123"],
        ["algorithm", "MD5"],
      ]),
    },
  ];
  const v = h.get("www-authenticate");
  assert.equal(v, 'digest realm="test"; nonce=abc123, algorithm=MD5');
});

await test("RichHeaders wwwAuthenticate setter with null clears header", async () => {
  const h = new RichHeaders();
  h.set("www-authenticate", 'Bearer realm="test"');
  h.wwwAuthenticate = null;
  assert.equal(h.has("www-authenticate"), false);
});

suite("Bug fix: proxyAuthenticate setter");

await test("RichHeaders proxyAuthenticate setter produces correct output", async () => {
  const h = new RichHeaders();
  h.proxyAuthenticate = [
    { scheme: "basic", realm: "proxy", params: new Map([["realm", "proxy"]]) },
  ];
  const v = h.get("proxy-authenticate");
  assert.equal(v, 'basic realm="proxy"');
});

await test("RichHeaders proxyAuthenticate setter null clears header", async () => {
  const h = new RichHeaders();
  h.set("proxy-authenticate", 'Basic realm="proxy"');
  h.proxyAuthenticate = null;
  assert.equal(h.has("proxy-authenticate"), false);
});

suite("RichHeaders - proxyAuthentication accessors");

await test("RichHeaders proxyAuthorization getter", async () => {
  const h = new RichHeaders();
  h.set("proxy-authorization", "Bearer proxy-token");
  const pa = h.proxyAuthorization;
  assert.equal(pa?.scheme, "bearer");
  assert.equal(pa?.token, "proxy-token");
});

await test("RichHeaders proxyAuthorization setter with string", async () => {
  const h = new RichHeaders();
  h.proxyAuthorization = "Bearer proxy-token";
  assert.equal(h.get("proxy-authorization"), "Bearer proxy-token");
});

await test("RichHeaders proxyAuthorization setter with AuthCredentials (basic)", async () => {
  const h = new RichHeaders();
  h.proxyAuthorization = {
    scheme: "basic",
    token: "dXNlcjpwYXNz",
    params: new Map(),
    basic: { username: "user", password: "pass" },
  };
  const val = h.get("proxy-authorization");
  assert.equal(val, "Basic dXNlcjpwYXNz");
});

await test("RichHeaders proxyAuthorization setter with AuthCredentials (token)", async () => {
  const h = new RichHeaders();
  h.proxyAuthorization = { scheme: "bearer", token: "my-token", params: new Map(), basic: null };
  assert.equal(h.get("proxy-authorization"), "bearer my-token");
});

await test("RichHeaders proxyAuthorization setter with AuthCredentials (scheme only)", async () => {
  const h = new RichHeaders();
  h.proxyAuthorization = {
    scheme: "negotiate",
    token: null,
    params: new Map([["token", "abc"]]),
    basic: null,
  };
  assert.equal(h.get("proxy-authorization"), "negotiate");
});

await test("RichHeaders proxyAuthorization setter with null clears header", async () => {
  const h = new RichHeaders();
  h.set("proxy-authorization", "Bearer token");
  h.proxyAuthorization = null;
  assert.equal(h.has("proxy-authorization"), false);
});

await test("RichHeaders setCookies getter", async () => {
  const h = new RichHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const sc = h.setCookies;
  assert.deepEqual(sc, ["a=1", "b=2"]);
});

suite("Cross-runtime: atob/btoa fallback");

await test("parseAuthorization works with atob removed (base64 fallback mock)", async () => {
  const origAtob = (globalThis as any).atob;
  (globalThis as any).atob = undefined;
  try {
    const auth = parseAuthorization("Basic dXNlcjpwYXNz");
    assert.equal(auth?.scheme, "basic");
    assert.equal(auth?.basic?.username, "user");
    assert.equal(auth?.basic?.password, "pass");
  } finally {
    (globalThis as any).atob = origAtob;
  }
});

await test("formatBasic works with btoa removed (base64 fallback mock)", async () => {
  const origBtoa = (globalThis as any).btoa;
  (globalThis as any).btoa = undefined;
  try {
    const result = formatBasic("user", "pass");
    assert.equal(result, "Basic dXNlcjpwYXNz");
  } finally {
    (globalThis as any).btoa = origBtoa;
  }
});

suite("RichHeaders - wwwAuthenticate and proxyAuthenticate getters");

await test("RichHeaders wwwAuthenticate getter null when header missing", async () => {
  const h = new RichHeaders();
  assert.equal(h.wwwAuthenticate, null);
});

await test("RichHeaders wwwAuthenticate getter with multiple challenges", async () => {
  const h = new RichHeaders();
  h.set("www-authenticate", 'Digest realm="test", nonce="abc", Basic realm="other"');
  const challenges = h.wwwAuthenticate;
  assert.notEqual(challenges, null);
  assert.ok(challenges.length >= 1, `got ${challenges.length} challenges`);
});

await test("RichHeaders proxyAuthenticate getter", async () => {
  const h = new RichHeaders();
  h.set("proxy-authenticate", 'Basic realm="proxy"');
  const pa = h.proxyAuthenticate;
  assert.equal(pa?.[0]?.scheme, "basic");
  assert.equal(pa?.[0]?.realm, "proxy");
});

await test("RichHeaders proxyAuthenticate getter null when header missing", async () => {
  const h = new RichHeaders();
  assert.equal(h.proxyAuthenticate, null);
});

suite("Authorization parsing edge cases");

await test("parseAuthorization returns null for empty", async () => {
  assert.equal(parseAuthorization(""), null);
});

await test("parseAuthorization returns scheme-only", async () => {
  const auth = parseAuthorization("Negotiate");
  assert.equal(auth?.scheme, "negotiate");
  assert.equal(auth?.token, null);
});

await test("parseAuthorization Basic invalid base64", async () => {
  const auth = parseAuthorization("Basic !!!invalid!!!");
  assert.equal(auth?.scheme, "basic");
  assert.equal(auth?.token, "!!!invalid!!!");
  assert.equal(auth?.basic, null);
});

await test("parseAuthorization Digest with params", async () => {
  const auth = parseAuthorization('Digest realm="test", nonce="abc123", algorithm=MD5');
  assert.equal(auth?.scheme, "digest");
  assert.equal(auth?.params.get("realm"), "test");
  assert.equal(auth?.params.get("nonce"), "abc123");
  assert.equal(auth?.params.get("algorithm"), "MD5");
});

await test("parseAuthorization no '=', treated as token", async () => {
  const auth = parseAuthorization("Custom justatoken");
  assert.equal(auth?.scheme, "custom");
  assert.equal(auth?.token, "justatoken");
});

suite("ContentType edge cases");

await test("parseContentType returns null for no slash", async () => {
  const ct = parseContentType("justtext");
  assert.equal(ct, null);
});

await test("formatContentType with Map params includes non-standard", async () => {
  const result = formatContentType({
    mediaType: "text/html",
    params: new Map([
      ["charset", "utf-8"],
      ["foo", "bar"],
    ]),
  });
  assert.equal(result, "text/html; foo=bar");
});

await test("formatContentType with object params", async () => {
  const result = formatContentType({
    mediaType: "application/json",
    params: { charset: "utf-8" } as any,
  });
  assert.equal(result, "application/json");
});

await test("formatContentType quotes value with spaces", async () => {
  const result = formatContentType({
    mediaType: "text/html",
    params: new Map([["foo", "bar baz"]]),
  });
  assert.equal(result, 'text/html; foo="bar baz"');
});

suite("ContentDisposition edge cases");

await test("parseContentDisposition returns null for empty", async () => {
  assert.equal(parseContentDisposition(""), null);
});

await test("parseContentDisposition prefers filename* over filename", async () => {
  const cd = parseContentDisposition("attachment; filename=\"old.txt\"; filename*=UTF-8''new.txt");
  assert.equal(cd?.filename, "new.txt");
});

await test("parseContentDisposition with invalid RFC 5987 falls back to filename", async () => {
  const cd = parseContentDisposition('attachment; filename*=invalid; filename="fallback.txt"');
  assert.equal(cd?.filename, "fallback.txt");
});

await test("formatContentDisposition with non-ASCII filename adds RFC 5987", async () => {
  const cd = formatContentDisposition({
    type: "attachment",
    filename: "héllo.txt",
    name: null,
    params: new Map(),
  } as ContentDispositionValue);
  assert.equal(cd, "attachment; filename=\"héllo.txt\"; filename*=UTF-8''h%C3%A9llo.txt");
});

await test("formatContentDisposition with name field", async () => {
  const cd = formatContentDisposition({
    type: "form-data",
    name: "field1",
    filename: null,
    params: new Map(),
  } as ContentDispositionValue);
  assert.equal(cd, 'form-data; name="field1"');
});

suite("CacheControl edge cases");

await test("parseCacheControl private with field names", async () => {
  const cc = parseCacheControl("private=field1, no-cache");
  assert.equal(cc.noCache, true);
  assert.ok(Array.isArray(cc.private));
});

await test("parseCacheControl max-stale without value", async () => {
  const cc = parseCacheControl("max-stale");
  assert.equal(cc.maxStale, Infinity);
});

await test("parseCacheControl private with quoted values", async () => {
  const cc = parseCacheControl('private="field1, field2"');
  // A comma inside a quoted string must not split the directive (RFC 7234 §5.2)
  assert.deepEqual(cc.private, ["field1", "field2"]);
});

await test("formatCacheControl with s-maxage", async () => {
  const result = formatCacheControl({ sMaxAge: 3600 });
  assert.equal(result, "s-maxage=3600");
});

await test("formatCacheControl with max-stale Infinity", async () => {
  const result = formatCacheControl({ maxStale: Infinity });
  assert.equal(result, "max-stale");
});

await test("formatCacheControl with private array", async () => {
  const result = formatCacheControl({ private: ["field1", "field2"] });
  assert.equal(result, "private=field1, field2");
});

await test("formatCacheControl with private true", async () => {
  const result = formatCacheControl({ private: true });
  assert.equal(result, "private");
});

await test("formatCacheControl with unknown directives", async () => {
  const result = formatCacheControl({ unknown: new Map([["custom", "val"]]) });
  assert.equal(result, "custom=val");
});

await test("formatCacheControl with unknown boolean directive", async () => {
  const result = formatCacheControl({ unknown: new Map([["custom", true as any]]) });
  assert.equal(result, "custom");
});

await test("formatCacheControl with must-understand and must-revalidate", async () => {
  const result = formatCacheControl({ mustUnderstand: true, mustRevalidate: true });
  assert.equal(result, "must-revalidate, must-understand");
});

suite("parseParams edge cases");

await test("parseParams key without equals sign", async () => {
  const p = parseParams("; key1; key2=val2");
  assert.equal(p.get("key1"), "");
  assert.equal(p.get("key2"), "val2");
});

await test("parseParams quoted value", async () => {
  const p = parseParams('; key="quoted val"');
  assert.equal(p.get("key"), "quoted val");
});

suite("parseWarning");

await test("parseWarning standard format", async () => {
  const w = parseWarning('112 - "network timeout"');
  assert.equal(w[0]?.code, 112);
  assert.equal(w[0]?.text, "network timeout");
});

await test("parseWarning with date", async () => {
  const w = parseWarning('112 - "timeout" "Mon, 01 Jan 1990 00:00:00 GMT"');
  assert.equal(w[0]?.code, 112);
  assert.ok(w[0]?.date instanceof Date);
});

suite("parseContentLanguage");

await test("parseContentLanguage basic", async () => {
  const cl = parseContentLanguage("en-US, fr-CA;q=0.9");
  assert.equal(cl[0]?.value, "en-US");
  assert.equal(cl[1]?.value, "fr-CA");
  assert.equal(cl[1]?.quality, 0.9);
});

await test("parseContentLanguage returns empty for blank", async () => {
  const cl = parseContentLanguage("  ");
  assert.equal(cl.length, 0);
});

suite("Range edge cases");

await test("parseRange returns null without equals", async () => {
  assert.equal(parseRange("bytes"), null);
});

await test("parseRange suffix range", async () => {
  const r = parseRange("bytes=-100");
  assert.equal(r?.ranges[0]?.start, null);
  assert.equal(r?.ranges[0]?.end, 100);
});

suite("ContentRange edge cases");

await test("parseContentRange with star range", async () => {
  const cr = parseContentRange("bytes */1234");
  assert.equal(cr?.start, null);
  assert.equal(cr?.end, null);
  assert.equal(cr?.total, 1234);
});

await test("parseContentRange with star total", async () => {
  const cr = parseContentRange("bytes 200-999/*");
  assert.equal(cr?.start, 200);
  assert.equal(cr?.total, null);
});

await test("parseContentRange returns null for bad format", async () => {
  assert.equal(parseContentRange("not-a-range"), null);
});

suite("Link header edge cases");

await test("parseLinkHeader multiple links", async () => {
  const links = parseLinkHeader('<https://a.com>; rel="a", <https://b.com>; rel="b"');
  assert.equal(links.length, 2);
});

await test("parseLinkHeader skips malformed entries", async () => {
  const links = parseLinkHeader('not-a-link, <https://b.com>; rel="b"');
  assert.equal(links.length, 1);
});

await test("formatLinkHeader with all fields", async () => {
  const link = formatLinkHeader([
    {
      uri: "https://example.com",
      rel: "stylesheet",
      type: "text/css",
      hreflang: "en",
      title: "Style",
      media: "screen",
      params: new Map([
        ["rel", "stylesheet"],
        ["type", "text/css"],
        ["extra", "val"],
      ]),
    },
  ]);
  assert.equal(
    link,
    '<https://example.com>; rel="stylesheet"; type="text/css"; hreflang="en"; title="Style"; media="screen"; extra="val"',
  );
});

suite("parseForwarded edge cases");

await test("parseForwarded multiple 'for' values", async () => {
  const fwd = parseForwarded("for=192.0.2.1, for=198.51.100.2");
  assert.equal(fwd.for.length, 2);
});

suite("HSTS edge cases");

await test("parseHSTS returns null for missing max-age", async () => {
  assert.equal(parseHSTS("includeSubDomains"), null);
});

await test("parseHSTS returns null for invalid max-age", async () => {
  assert.equal(parseHSTS("max-age=abc"), null);
});

await test("formatHSTS with preload", async () => {
  const result = formatHSTS({ maxAge: 31536000, includeSubDomains: false, preload: true });
  // includeSubDomains:false must not emit that directive.
  assert.equal(result, "max-age=31536000; preload");
});

suite("CSP edge cases");

await test("formatCSP with empty directive", async () => {
  const result = formatCSP(new Map([["default-src", []]]));
  assert.equal(result, "default-src");
});

await test("formatCSP with values", async () => {
  const result = formatCSP(new Map([["default-src", ["'self'", "example.com"]]]));
  assert.equal(result, "default-src 'self' example.com");
});

suite("Server-Timing edge cases");

await test("parseServerTiming with description", async () => {
  const st = parseServerTiming('db;dur=50;desc="Query DB"');
  assert.equal(st[0]?.description, "Query DB");
});

await test("formatServerTiming with description", async () => {
  const result = formatServerTiming([{ name: "db", duration: null, description: "query" }]);
  // A null duration must be omitted, not rendered as "null".
  assert.equal(result, 'db;desc="query"');
});

suite("Security headers edge cases");

await test("securityHeaders with disabled HSTS", async () => {
  const h = securityHeaders({ hsts: false });
  assert.equal(h.has("strict-transport-security"), false);
});

await test("securityHeaders with CSP string", async () => {
  const h = securityHeaders({ csp: "default-src 'self'" });
  assert.equal(h.get("content-security-policy"), "default-src 'self'");
});

await test("securityHeaders with CSP Map", async () => {
  const h = securityHeaders({ csp: new Map([["default-src", ["'self'"]]]) });
  assert.equal(h.get("content-security-policy"), "default-src 'self'");
});

await test("securityHeaders with noSniff disabled", async () => {
  const h = securityHeaders({ noSniff: false });
  assert.equal(h.has("x-content-type-options"), false);
});

await test("securityHeaders with cross-origin policies", async () => {
  const h = securityHeaders({
    permissions: "geolocation=()",
    coep: "require-corp",
    coop: "same-origin",
    corp: "same-origin",
  });
  assert.equal(h.get("permissions-policy"), "geolocation=()");
  assert.equal(h.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(h.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(h.get("cross-origin-resource-policy"), "same-origin");
});

suite("CORS headers edge cases");

await test("corsHeaders with origin array", async () => {
  const h = corsHeaders({ origin: ["https://a.com", "https://b.com"] });
  assert.equal(h.get("access-control-allow-origin"), "https://a.com, https://b.com");
});

await test("corsHeaders with methods", async () => {
  const h = corsHeaders({ origin: "*", methods: ["GET", "POST"] });
  assert.equal(h.get("access-control-allow-methods"), "GET, POST");
});

await test("corsHeaders with allowHeaders and exposeHeaders", async () => {
  const h = corsHeaders({
    origin: "*",
    allowHeaders: ["X-Custom"],
    exposeHeaders: ["X-Result"],
  });
  assert.equal(h.get("access-control-allow-headers"), "X-Custom");
  assert.equal(h.get("access-control-expose-headers"), "X-Result");
});

suite("HttpHeaders - additional edge cases");

await test("HttpHeaders get for non-existent header", async () => {
  const h = new HttpHeaders();
  assert.equal(h.get("nonexistent"), null);
});

await test("HttpHeaders get returns single value for set-cookie", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  assert.equal(h.get("set-cookie"), "a=1");
});

await test("HttpHeaders forEach with NO_COMBINE headers", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const vals: string[] = [];
  h.forEach((v) => vals.push(v));
  assert.equal(vals.length, 2);
  assert.equal(vals[0], "a=1");
});

await test("HttpHeaders toNodeHeaders with multi-value headers", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const nh = toNodeHeaders(h);
  const v = nh["set-cookie"];
  assert.ok(Array.isArray(v));
  assert.deepEqual(v, ["a=1", "b=2"]);
});

await test("HttpHeaders toWebHeaders throws when Headers not available", async () => {
  const origHeaders = (globalThis as any).Headers;
  (globalThis as any).Headers = undefined;
  try {
    const h = new HttpHeaders({ a: "1" });
    h.toWebHeaders();
    assert.fail("Should have thrown");
  } catch (e: any) {
    assert.match(e.message, /WHATWG Headers/);
  } finally {
    (globalThis as any).Headers = origHeaders;
  }
});

await test("HttpHeaders invalid name throws TypeError", async () => {
  const h = new HttpHeaders();
  assert.throws(() => h.set("invalid name!", "value"), /Invalid header name/);
});

await test("HttpHeaders invalid value throws TypeError", async () => {
  const h = new HttpHeaders();
  assert.throws(() => h.set("x-test", "valid\x00value"), /Invalid header value/);
});

await test("HttpHeaders response guard forbids set-cookie set", async () => {
  const h = new HttpHeaders({}, "response");
  assert.throws(() => h.set("set-cookie", "a=b"), /forbidden for response guard/);
});

await test("HttpHeaders response guard forbids set-cookie append", async () => {
  const h = new HttpHeaders({}, "response");
  assert.throws(() => h.append("set-cookie", "a=b"), /forbidden for response guard/);
});

await test("HttpHeaders request guard forbids set on forbidden header", async () => {
  const h = new HttpHeaders({}, "request");
  assert.throws(() => h.set("host", "example.com"), /forbidden for request guard/);
});

await test("HttpHeaders request guard forbids append on forbidden header", async () => {
  const h = new HttpHeaders({}, "request");
  assert.throws(() => h.append("host", "example.com"), /forbidden for request guard/);
});

await test("HttpHeaders request guard forbids delete on forbidden header", async () => {
  const h = new HttpHeaders({ "content-type": "text/html" }, "request");
  assert.throws(() => h.delete("host"), /forbidden for request guard/);
});

await test("HttpHeaders immutable guard forbids delete", async () => {
  const h = new HttpHeaders().freeze();
  assert.throws(() => h.delete("a"), /immutable/);
});

await test("HttpHeaders append preserves original name casing", async () => {
  const h = new HttpHeaders();
  h.append("X-Custom", "val");
  const str = h.toHTTP1String();
  assert.equal(str, "X-Custom: val");
});

await test("HttpHeaders set preserves original name casing", async () => {
  const h = new HttpHeaders();
  h.set("X-Custom", "val");
  const str = h.toHTTP1String();
  assert.equal(str, "X-Custom: val");
});

suite("RichHeaders edge cases");

await test("RichHeaders contentType setter clears when null", async () => {
  const h = new RichHeaders();
  h.contentType = null;
  assert.equal(h.has("content-type"), false);
});

await test("RichHeaders contentDisposition setter null clears header", async () => {
  const h = new RichHeaders();
  h.contentDisposition = null;
  assert.equal(h.has("content-disposition"), false);
});

await test("RichHeaders cacheControl string setter", async () => {
  const h = new RichHeaders();
  h.cacheControl = "max-age=3600";
  assert.equal(h.cacheControl?.maxAge, 3600);
});

await test("RichHeaders authorization setter null clears header", async () => {
  const h = new RichHeaders();
  h.authorization = null;
  assert.equal(h.has("authorization"), false);
});

await test("RichHeaders hsts setter null clears header", async () => {
  const h = new RichHeaders();
  h.hsts = null;
  assert.equal(h.has("strict-transport-security"), false);
});

await test("RichHeaders csp setter null clears header", async () => {
  const h = new RichHeaders();
  h.csp = null;
  assert.equal(h.has("content-security-policy"), false);
});

await test("RichHeaders etag preserves weak tag", async () => {
  const h = new RichHeaders();
  h.etag = 'W/"abc123"';
  assert.equal(h.etag, 'W/"abc123"');
});

await test("RichHeaders accessControlCredentials getter false", async () => {
  const h = new RichHeaders();
  h.set("access-control-allow-credentials", "false");
  assert.equal(h.accessControlCredentials, false);
});

await test("RichHeaders accessControlCredentials getter invalid", async () => {
  const h = new RichHeaders();
  h.set("access-control-allow-credentials", "maybe");
  assert.equal(h.accessControlCredentials, null);
});

suite("fromNodeHeaders edge cases");

await test("fromNodeHeaders skips undefined", async () => {
  const h = fromNodeHeaders({ "x-test": undefined });
  assert.equal(h.size, 0);
});

await test("fromNodeHeaders with array values", async () => {
  const h = fromNodeHeaders({ "set-cookie": ["a=1", "b=2"] });
  assert.equal(h.getAll("set-cookie").length, 2);
});

suite("Factory helpers edge cases");

await test("createImmutableHeaders throws on append", async () => {
  const h = createImmutableHeaders().freeze();
  assert.throws(() => h.append("b", "2"), /immutable/);
});

await test("HttpHeaders constructor throws for bad array init", async () => {
  assert.throws(() => new HttpHeaders([["a"]] as any), /pairs/);
});

await test("HttpHeaders values() with NO_COMBINE headers", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const vals = [...h.values()];
  assert.equal(vals.length, 2);
});

await test("HttpHeaders entries() with NO_COMBINE headers", async () => {
  const h = new HttpHeaders();
  h.append("set-cookie", "a=1");
  h.append("set-cookie", "b=2");
  const entries = [...h.entries()];
  assert.equal(entries.length, 2);
});

suite("Retry-After edge cases");

await test("parseRetryAfter returns null for unparseable value", async () => {
  const ra = parseRetryAfter("not-a-date-or-number");
  assert.equal(ra.date, null);
  assert.equal(ra.delay, null);
});

suite("Diff edge cases");

await test("HttpHeaders diff with differing NO_COMBINE header", async () => {
  const h1 = new HttpHeaders();
  h1.append("set-cookie", "a=1");
  const h2 = new HttpHeaders();
  h2.append("set-cookie", "a=1");
  h2.append("set-cookie", "b=2");
  // NO_COMBINE headers use first value for get()
  const d = h1.diff(h2);
  assert.equal(d.size, 0); // both have "a=1" as first value
});

await test("HttpHeaders diff detects differing NO_COMBINE headers", async () => {
  const h1 = new HttpHeaders();
  h1.append("set-cookie", "a=1");
  const h2 = new HttpHeaders();
  h2.append("set-cookie", "b=2");
  const d = h1.diff(h2);
  assert.equal(d.size, 1);
  assert.deepEqual(d.getAll("set-cookie"), ["b=2"]);
});

suite("Real HTTP: httpbin redirect");

const noRedirect = kinetex({ baseURL: "https://httpbin.org", timeout: T, maxRedirects: 0 });

await test("GET /response-headers returns custom header with Location", async () => {
  // httpbin's /response-headers can return arbitrary headers
  const r = await noRedirect.get("/response-headers", {
    params: { Location: "https://example.com" },
  });
  const rh = new RichHeaders(r.headers as Record<string, string>);
  console.log("    Location via /response-headers:", rh.location);
  assert.equal(r.status, 200);
  // The whole point of the test is the header httpbin echoed back, and only
  // the status was asserted — a request that dropped the param entirely
  // reported a pass.
  assert.equal(rh.location, "https://example.com");
  assert.equal(rh.get("location"), "https://example.com", "the header name is case-insensitive");
  assert.equal(r.params ? undefined : undefined, undefined);
  assert.match(String(r.url), /[?&]Location=https%3A%2F%2Fexample\.com/);
});

// ══════════════════════════════════════════════════════════════════════════
// Regression: defects found by this audit
// ══════════════════════════════════════════════════════════════════════════
suite("regression: parseParams and quoted-string values");

await test("a semicolon inside a quoted value is not a separator", async () => {
  // `split(";")` treated every semicolon as a parameter boundary, so a value
  // containing one was shredded into extra parameters.
  assert.deepEqual([...parseParams('boundary="a;b"')], [["boundary", "a;b"]]);
  assert.deepEqual(
    [...parseParams('a=1; b="x;y;z"; c=3')],
    [
      ["a", "1"],
      ["b", "x;y;z"],
      ["c", "3"],
    ],
  );
  // A comma inside quotes was already handled, and must stay handled.
  assert.deepEqual(
    [...parseParams('a="has,comma"; b=2')],
    [
      ["a", "has,comma"],
      ["b", "2"],
    ],
  );
  // An escaped quote does not close the string either.
  assert.deepEqual(
    [...parseParams('f="a\\"b"; g=2')],
    [
      ["f", 'a"b'],
      ["g", "2"],
    ],
  );
  // And an escaped semicolon inside a value stays a value character.
  assert.deepEqual([...parseParams('f="a\\;b"')], [["f", "a;b"]]);
});

await test("the multipart spec's own boundary example parses whole", async () => {
  const b = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
  const ct = parseContentType(`multipart/form-data; boundary="${b}"`)!;
  assert.equal(ct.mediaType, "multipart/form-data");
  assert.equal(ct.boundary, b);
  // Without the fix this returned the boundary up to the first semicolon and
  // invented a second parameter out of the remainder. `params` retains every
  // parameter, so a split value would show up as a spurious key here.
  assert.ok(ct.params instanceof Map);
  assert.deepEqual([...ct.params], [["boundary", b]]);
});

await test("a Content-Disposition filename may contain a semicolon", async () => {
  // Semicolons are legal in filenames; this is a form-data header whose
  // filename is quoted, exactly as browsers send it.
  const cd = parseContentDisposition('form-data; name="file"; filename="Q1; Q2 report.pdf"')!;
  assert.equal(cd.type, "form-data");
  assert.equal(cd.name, "file");
  assert.equal(cd.filename, "Q1; Q2 report.pdf");
  // ...and it round-trips, escapes included.
  assert.equal(
    formatContentDisposition(cd),
    'form-data; name="file"; filename="Q1; Q2 report.pdf"; filename*=UTF-8\'\'Q1%3B%20Q2%20report.pdf',
  );
});

await test("formatters escape quotes in every parameter value", async () => {
  const Q = String.fromCharCode(34);
  const mk = (o: Record<string, unknown>) =>
    ({
      uri: "u",
      rel: null,
      type: null,
      hreflang: null,
      title: null,
      media: null,
      params: new Map<string, string>(),
      ...o,
    }) as any;

  // Raw interpolation emitted `title="a "q" b"`, which a recipient reads as
  // the param `title` with value `a ` followed by a bare `q` parameter.
  const l = formatLinkHeader([mk({ title: `a ${Q}q${Q} b` })]);
  assert.equal(l, `<u>; title="a \\"q\\" b"`);
  assert.deepEqual(
    parseLinkHeader(l).map((x) => x.title),
    [`a ${Q}q${Q} b`],
  );

  // An unknown parameter with a quote in its value.
  const l2 = formatLinkHeader([mk({ params: new Map([["x", `v${Q}w${Q}`]]) })]);
  assert.deepEqual([...parseLinkHeader(l2)[0]!.params], [["x", `v${Q}w${Q}`]]);

  // Server-Timing descriptions, Content-Disposition names, and Link rel.
  const st = formatServerTiming([{ name: "a", duration: 1.5, description: `x ${Q}y${Q} z` }]);
  assert.equal(st, `a;dur=1.5;desc="x \\"y\\" z"`);
  assert.equal(
    formatContentDisposition({
      type: "form-data",
      name: `n${Q}ame`,
      filename: null,
      params: new Map(),
    }),
    `form-data; name="n\\"ame"`,
  );
  assert.equal(formatLinkHeader([mk({ rel: `a ${Q}b${Q} c` })]), `<u>; rel="a \\"b\\" c"`);
});

suite("regression: parseRange rejected nothing");

await test("an unparseable range returns null, not NaN bounds", async () => {
  // `parseInt("abc", 10)` is NaN and nothing filtered it, so a caller doing
  // arithmetic on the bounds got NaN rather than a rejection.
  assert.equal(parseRange("bytes=abc-def"), null);
  assert.equal(parseRange("bytes=1-abc"), null);
  assert.equal(parseRange("bytes=abc-"), null);
  assert.equal(parseRange("bytes="), null, "an empty range list is not a range");
  assert.equal(parseRange("bytes=-"), null, "neither form given");
  assert.equal(parseRange("nonsense"), null);
});

await test("an inverted or negative range is rejected", async () => {
  // RFC 9110 §14.1.1: first-byte-pos must be <= last-byte-pos, both >= 0.
  assert.equal(parseRange("bytes=500-100"), null);
  assert.equal(parseRange("bytes=5--1"), null);
  // `-1` is *not* negative: it is a suffix-length of 1, the last byte. The
  // first `-` is the range separator, so the digits after it are positive.
  assert.deepEqual(parseRange("bytes=-1"), {
    unit: "bytes",
    ranges: [{ start: null, end: 1 }],
  });
});

await test("the valid range forms still parse", async () => {
  assert.deepEqual(parseRange("bytes=0-499"), { unit: "bytes", ranges: [{ start: 0, end: 499 }] });
  assert.deepEqual(parseRange("bytes=500-"), {
    unit: "bytes",
    ranges: [{ start: 500, end: null }],
  });
  // A suffix range has a null start — that is the whole point of it.
  assert.deepEqual(parseRange("bytes=-500"), {
    unit: "bytes",
    ranges: [{ start: null, end: 500 }],
  });
  assert.deepEqual(parseRange("bytes=0-0,-1"), {
    unit: "bytes",
    ranges: [
      { start: 0, end: 0 },
      { start: null, end: 1 },
    ],
  });
  // One bad element does not discard the good ones.
  assert.deepEqual(parseRange("bytes=0-99,abc,200-299")!.ranges, [
    { start: 0, end: 99 },
    { start: 200, end: 299 },
  ]);
  assert.equal(parseRange("items=0-10")!.unit, "items");
});

suite("regression: q-values and content negotiation");

await test("a malformed q-value is absent, not unacceptable", async () => {
  // `parseFloat(v) || 0` turned `q=abc` into 0 — "not acceptable" — so
  // `Accept: text/html;q=abc` silently stopped matching text/html.
  assert.equal(parseAccept("a/b;q=abc")[0]!.quality, 1);
  assert.equal(parseAccept("a/b;q=")[0]!.quality, 1);
  assert.equal(parseAccept("a/b;q=;level=1")[0]!.quality, 1);
  assert.equal(parseAccept("a/b")[0]!.quality, 1);
});

await test("an out-of-range q-value is clamped to 0..1", async () => {
  // RFC 9110 §12.4.2 bounds a qvalue to 0..1; 1.5 and -1 flowed straight out.
  assert.equal(parseAccept("a/b;q=1.5")[0]!.quality, 1);
  assert.equal(parseAccept("a/b;q=-1")[0]!.quality, 0);
  assert.equal(parseAccept("a/b;q=99")[0]!.quality, 1);
  assert.equal(parseAccept("a/b;q=0.5")[0]!.quality, 0.5);
});

await test("an absent or empty Accept accepts anything", async () => {
  // RFC 9110 §12.5.1: no Accept field implies any media type is acceptable.
  // The old loop over an empty list returned null, so a client that simply
  // did not care got no match at all.
  assert.equal(negotiateContentType("", ["text/html", "application/json"]), "text/html");
  assert.equal(negotiateContentType("   ", ["text/html"]), "text/html");
  assert.equal(negotiateContentType("", []), null);
});

await test("a server type carrying parameters is still matched", async () => {
  // Exact string comparison never matched, and every real server lists its
  // content types with a charset.
  assert.equal(
    negotiateContentType("text/html", ["text/html; charset=utf-8"]),
    "text/html; charset=utf-8",
  );
  assert.equal(negotiateContentType("text/html; charset=utf-8", ["text/html"]), "text/html");
});

await test("media types are matched case-insensitively", async () => {
  // RFC 9110 §8.3.1: the type and subtype are case-insensitive.
  assert.equal(negotiateContentType("TEXT/HTML", ["text/html"]), "text/html");
  assert.equal(negotiateContentType("text/html", ["TEXT/HTML"]), "TEXT/HTML");
  assert.equal(negotiateContentType("  text/html  ", ["text/html"]), "text/html");
});

await test("q=0 means not acceptable, even behind a wildcard", async () => {
  // RFC 9110 §12.5.1: the most specific matching range determines quality, so
  // an explicit `text/html;q=0` is not rescued by `*/*`.
  assert.equal(negotiateContentType("text/html;q=0", ["text/html"]), null);
  assert.equal(
    negotiateContentType("text/html;q=0, */*;q=0.1", ["text/html", "application/json"]),
    "application/json",
    "a type the client refused must not be returned via a wildcard",
  );
  assert.equal(negotiateContentType("*/*;q=0", ["text/html", "application/json"]), null);
});

await test("the highest-quality match wins, and order breaks ties", async () => {
  assert.equal(
    negotiateContentType("text/*;q=0.5, text/html;q=0.9", ["text/plain", "text/html"]),
    "text/html",
  );
  assert.equal(
    negotiateContentType("text/html;q=0.9, text/plain;q=0.5", ["text/plain", "text/html"]),
    "text/html",
  );
  // A specific match outranks a wildcard of the same weight.
  assert.equal(
    negotiateContentType("*/*;q=0.5, text/html;q=0.5", ["application/json", "text/html"]),
    "text/html",
  );
  assert.equal(negotiateContentType("*/*", ["a/b", "c/d"]), "a/b", "server order breaks ties");
  assert.equal(negotiateContentType("text/*", ["application/json", "text/html"]), "text/html");
  assert.equal(negotiateContentType("text/html", ["application/json"]), null);
  assert.equal(negotiateContentType("text/html", []), null);
});

suite("regression: getClientIP returned non-addresses");

await test("a non-address in X-Forwarded-For is not a client IP", async () => {
  // Any string was returned verbatim, so a caller rate-limiting, logging or
  // geo-locating on this would have been reading the literal "garbage".
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "garbage" })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "not-an-ip, also-not" })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-real-ip": "not-an-ip" })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "999.1.1.1" })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "203.0.113.1.5" })), null);
});

await test("`unknown` is skipped, not returned as an address", async () => {
  // The de-facto placeholder that nginx, HAProxy and several CDNs emit when
  // they cannot determine the client. Returning the literal string "unknown"
  // as a client address put it into logs, rate-limit keys and geo lookups.
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "unknown" })), null);
  // ...and it must not mask a real address elsewhere in the list.
  assert.equal(
    getClientIP(new HttpHeaders({ "x-forwarded-for": "unknown, 203.0.113.1" })),
    "203.0.113.1",
  );
  assert.equal(
    getClientIP(new HttpHeaders({ "x-forwarded-for": "203.0.113.1, unknown" })),
    "203.0.113.1",
  );
});

await test("getClientIP never returns an empty string", async () => {
  // The signature is `string | null`; an empty X-Forwarded-For used to yield
  // "" — falsy, but not null, so a `=== null` check missed it.
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": ",," })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "  " })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-real-ip": "" })), null);
  assert.equal(getClientIP(new HttpHeaders({})), null);
  // A proxy that sends an empty *quoted* value reaches a different branch:
  // the raw string is truthy, and only unquoting it reveals that there is
  // nothing there. Without the post-strip emptiness check this returned "".
  const Q = String.fromCharCode(34);
  assert.equal(getClientIP(new HttpHeaders({ "x-real-ip": Q + Q })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": Q + Q })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-real-ip": "[]" })), null);
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "\t \t" })), null);
});

await test("real addresses and RFC 7239 identifiers are still returned", async () => {
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "203.0.113.1" })), "203.0.113.1");
  // Ports and IPv6 brackets are stripped, as documented.
  assert.equal(
    getClientIP(new HttpHeaders({ "x-forwarded-for": "203.0.113.1:8080" })),
    "203.0.113.1",
  );
  assert.equal(
    getClientIP(new HttpHeaders({ "x-forwarded-for": '"[2001:db8::1]:8080"' })),
    "2001:db8::1",
  );
  assert.equal(
    getClientIP(new HttpHeaders({ "x-forwarded-for": "::ffff:1.2.3.4" })),
    "::ffff:1.2.3.4",
  );
  // RFC 7239 obfuscated identifiers are explicitly allowed in place of an
  // address, so they are passed through rather than discarded.
  assert.equal(getClientIP(new HttpHeaders({ "x-forwarded-for": "_hidden" })), "_hidden");
});

await test("trustedHops still selects the right entry", async () => {
  const h = new HttpHeaders({ "x-forwarded-for": "203.0.113.1, 70.41.3.18, 10.0.0.1" });
  assert.equal(getClientIP(h), "203.0.113.1", "left-most by default");
  assert.equal(getClientIP(h, { trustedHops: 1 }), "10.0.0.1", "the hop the proxy appended");
  assert.equal(getClientIP(h, { trustedHops: 2 }), "70.41.3.18");
  // Out-of-range and nonsense values are clamped, not fatal.
  assert.equal(getClientIP(h, { trustedHops: 99 }), "203.0.113.1");
  assert.equal(getClientIP(h, { trustedHops: -5 }), "203.0.113.1");
  assert.equal(getClientIP(h, { trustedHops: 1.9 }), "10.0.0.1", "the count is truncated");
  assert.equal(getClientIP(h, { trustedHops: 3 }), "203.0.113.1", "clamped to the list");
});

// ── Typed accessors: both states of every getter, all three of every setter ──
//
// Coverage reported 89 uncovered branches in this file, nearly all of them in
// this accessor family. The pattern is uniform — `return v ? parse(v) : empty`
// on the way out, and a three-way `null` / string / object decision on the way
// in — so each one is read twice and written three times below. Reading only
// the populated case is what left the absent branch untested: a getter that
// ignored its header entirely and returned the empty value would pass.

suite("RichHeaders - typed accessors");

/** Header name, the accessor to read, a populated value, and the parsed result. */
const GETTER_CASES: Array<[string, string, string, unknown]> = [
  [
    "content-type",
    "contentType",
    "text/html; charset=utf-8",
    {
      mediaType: "text/html",
      type: "text",
      subtype: "html",
      charset: "utf-8",
      boundary: null,
      params: new Map([["charset", "utf-8"]]),
    },
  ],
  ["content-length", "contentLength", "42", 42],
  [
    "content-disposition",
    "contentDisposition",
    'attachment; filename="a.txt"',
    {
      type: "attachment",
      filename: "a.txt",
      name: null,
      params: new Map([["filename", "a.txt"]]),
    },
  ],
  [
    "cache-control",
    "cacheControl",
    "no-store",
    {
      noCache: false,
      noStore: true,
      noTransform: false,
      onlyIfCached: false,
      maxAge: null,
      maxStale: null,
      minFresh: null,
      staleIfError: null,
      public: false,
      private: false,
      mustRevalidate: false,
      proxyRevalidate: false,
      sMaxAge: null,
      immutable: false,
      mustUnderstand: false,
      staleWhileRevalidate: null,
      unknown: new Map(),
    },
  ],
  [
    "authorization",
    "authorization",
    "Bearer tok",
    { scheme: "bearer", token: "tok", params: new Map(), basic: null },
  ],
  [
    "accept",
    "accept",
    "text/html;q=0.5, application/json",
    [
      { value: "application/json", quality: 1, params: new Map() },
      { value: "text/html", quality: 0.5, params: new Map() },
    ],
  ],
  [
    "accept-encoding",
    "acceptEncoding",
    "gzip, br",
    [
      { value: "gzip", quality: 1, params: new Map() },
      { value: "br", quality: 1, params: new Map() },
    ],
  ],
  [
    "accept-language",
    "acceptLanguage",
    "en-GB, en;q=0.9",
    [
      { value: "en-GB", quality: 1, params: new Map() },
      { value: "en", quality: 0.9, params: new Map() },
    ],
  ],
  ["range", "range", "bytes=0-99", { unit: "bytes", ranges: [{ start: 0, end: 99 }] }],
  [
    "content-range",
    "contentRange",
    "bytes 0-99/1000",
    { unit: "bytes", start: 0, end: 99, total: 1000 },
  ],
  ["etag", "etag", '"abc"', '"abc"'],
  [
    "link",
    "link",
    '<https://x.test/p2>; rel="next"',
    {
      uri: "https://x.test/p2",
      rel: "next",
      type: null,
      hreflang: null,
      title: null,
      media: null,
      params: new Map([["rel", "next"]]),
    },
  ],
  ["retry-after", "retryAfter", "120", { date: null, delay: 120 }],
  [
    "strict-transport-security",
    "hsts",
    "max-age=31536000; includeSubDomains",
    { maxAge: 31536000, includeSubDomains: true, preload: false },
  ],
  ["content-security-policy", "csp", "default-src 'self'", new Map([["default-src", ["'self'"]]])],
  [
    "server-timing",
    "serverTiming",
    "db;dur=12.5",
    [{ name: "db", duration: 12.5, description: null }],
  ],
  ["x-forwarded-for", "clientIP", "203.0.113.9", "203.0.113.9"],
  // A real `Forwarded` header, not an X-Forwarded-For value: the two spellings
  // go down different code paths and only the former carries `for=`/`proto=`.
  [
    "forwarded",
    "forwarded",
    "for=203.0.113.9;proto=https;host=front.test",
    { by: null, for: ["203.0.113.9"], host: "front.test", proto: "https" },
  ],
  [
    "x-forwarded-host",
    "forwarded",
    "front.test",
    { by: null, for: [], host: "front.test", proto: null },
  ],
  ["host", "host", "api.test", "api.test"],
  ["origin", "origin", "https://app.test", "https://app.test"],
  ["user-agent", "userAgent", "kinetex/1.0", "kinetex/1.0"],
  ["location", "location", "https://x.test/next", "https://x.test/next"],
  ["date", "date", "Wed, 21 Oct 2015 07:28:00 GMT", new Date("Wed, 21 Oct 2015 07:28:00 GMT")],
  ["age", "age", "120", 120],
  ["vary", "vary", "Accept-Encoding, Origin", ["accept-encoding", "origin"]],
  ["x-request-id", "xRequestID", "req-1", "req-1"],
  ["x-correlation-id", "xCorrelationID", "corr-1", "corr-1"],
  ["x-powered-by", "xPoweredBy", "kinetex", "kinetex"],
  ["x-requested-with", "xRequestedWith", "XMLHttpRequest", "XMLHttpRequest"],
  ["x-ratelimit-limit", "xRateLimitLimit", "100", 100],
  ["x-ratelimit-remaining", "xRateLimitRemaining", "99", 99],
  ["x-ratelimit-reset", "xRateLimitReset", "1700000000", 1700000000],
  ["sec-fetch-site", "secFetchSite", "same-origin", "same-origin"],
  ["sec-fetch-mode", "secFetchMode", "cors", "cors"],
  ["sec-fetch-user", "secFetchUser", "?1", "?1"],
  ["sec-fetch-dest", "secFetchDest", "empty", "empty"],
  ["early-data", "earlyData", "1", 1],
  ["priority", "priority", "u=0, i", "u=0, i"],
  ["allow", "allow", "GET, POST", "GET, POST"],
  ["server", "server", "nginx", "nginx"],
  ["accept-ranges", "acceptRanges", "bytes", "bytes"],
  [
    "last-modified",
    "lastModified",
    "Wed, 21 Oct 2015 07:28:00 GMT",
    new Date("Wed, 21 Oct 2015 07:28:00 GMT"),
  ],
  [
    "expires",
    "expires",
    "Wed, 21 Oct 2015 07:28:00 GMT",
    new Date("Wed, 21 Oct 2015 07:28:00 GMT"),
  ],
  ["content-encoding", "contentEncoding", "gzip", "gzip"],
  ["content-language", "contentLanguage", "en-GB", "en-GB"],
  ["content-location", "contentLocation", "/docs", "/docs"],
  [
    "alt-svc",
    "altSvc",
    'h2=":443"; ma=60',
    [{ protocol: "h2", host: "", port: 443, maxAge: 60, persist: false }],
  ],
  [
    "www-authenticate",
    "wwwAuthenticate",
    'Bearer realm="r"',
    [{ scheme: "bearer", realm: "r", params: new Map([["realm", "r"]]) }],
  ],
  [
    "proxy-authenticate",
    "proxyAuthenticate",
    'Basic realm="p"',
    [{ scheme: "basic", realm: "p", params: new Map([["realm", "p"]]) }],
  ],
];

/**
 * Compare a parsed header value against its expected shape.
 *
 * `instanceof` is not used for the tag checks: the suite and the library are
 * loaded through separate module realms under tsx, so `x instanceof Map` is
 * unreliable here in a way that would silently skip a branch of this helper.
 */
function tag(v: unknown): string {
  return Object.prototype.toString.call(v);
}

function assertParsed(got: unknown, expected: unknown, label: string): void {
  const t = tag(got);
  if (t === "[object Object]") {
    assert.deepEqual({ ...(got as Record<string, unknown>) }, expected, label);
    return;
  }
  if (t === "[object Date]") {
    assert.ok(got instanceof Date || tag(got) === "[object Date]", label);
    assert.equal((got as Date).getTime(), (expected as Date).getTime(), label);
    return;
  }
  assert.deepEqual(got, expected, label);
}

await test("every typed getter parses a populated header", async () => {
  for (const [header, accessor, raw, expected] of GETTER_CASES) {
    const h = new RichHeaders({ [header]: raw });
    const got = (h as unknown as Record<string, unknown>)[accessor];
    assertParsed(got, expected, `${accessor} on "${header}: ${raw}"`);
  }
});

await test("every typed getter has a defined empty value when the header is absent", async () => {
  const h = new RichHeaders();
  // Read through a fresh instance each time so one accessor cannot seed another.
  for (const [, accessor] of GETTER_CASES) {
    const fresh = new RichHeaders();
    const got = (fresh as unknown as Record<string, unknown>)[accessor];
    assert.notEqual(
      got,
      undefined,
      `${accessor} must return an empty value, not undefined, when unset`,
    );
  }
  // And the empty values are the documented ones, not merely "something".
  const e = new RichHeaders();
  assert.equal(e.contentType, null);
  assert.equal(e.contentLength, null);
  assert.equal(e.contentDisposition, null);
  assert.equal(e.cacheControl, null);
  assert.equal(e.authorization, null);
  assert.equal(e.range, null);
  assert.equal(e.contentRange, null);
  assert.equal(e.etag, null);
  assert.equal(e.link, null);
  assert.equal(e.retryAfter, null);
  assert.equal(e.hsts, null);
  assert.equal(e.csp, null);
  assert.equal(e.date, null);
  assert.equal(e.age, null);
  assert.equal(e.xRateLimitLimit, null);
  assert.equal(e.xRateLimitRemaining, null);
  assert.equal(e.xRateLimitReset, null);
  assert.equal(e.earlyData, null);
  assert.equal(e.lastModified, null);
  assert.equal(e.expires, null);
  assert.equal(e.altSvc.length, 0);
  assert.equal(e.serverTiming.length, 0);
  assert.equal(e.links.length, 0);
  assert.equal(e.accept.length, 0);
  assert.equal(e.vary.length, 0);
  assert.equal(e.wwwAuthenticate, null);
  assert.equal(e.proxyAuthenticate, null);
  assert.equal(e.clientIP, null);
  void h;
});

await test("an unknown Cache-Control directive is data, never a member of the result", async () => {
  // A directive name comes straight off a response header, so `constructor`,
  // `toString` and `__proto__` are all plausible input. They land in the
  // `unknown` map, which is what keeps them data: a plain object would let
  // `constructor=x` land as a real member and shadow the inherited one, and
  // `__proto__=z` would reach the prototype setter.
  for (const directive of ["constructor=x", "toString=y", "__proto__=z"]) {
    const parsed = new RichHeaders({ "cache-control": `no-store, ${directive}` }).cacheControl!;
    const [name, value] = directive.split("=");
    assert.deepEqual(
      [...parsed.unknown],
      [[name!.toLowerCase() === "tostring" ? "tostring" : name, value]],
      `${directive} must be reported as data`,
    );
    // Nothing about the parsed object changed shape.
    assert.equal(parsed.noStore, true, `no-store must survive alongside ${directive}`);
    assert.equal(typeof parsed.constructor, "function", `${directive} must not shadow constructor`);
    assert.equal(typeof parsed.toString, "function", `${directive} must not shadow toString`);
    // And the prototype chain is untouched: the directive did not become a
    // member of the object at all.
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, name!),
      false,
      `${directive} must not become an own property`,
    );
  }
});

await test("a numeric accessor rejects an unparseable value rather than returning NaN", async () => {
  // Each of these is `parseInt` guarded by `isNaN(...) ? null : n`; a header of
  // "abc" must produce null, not NaN, which fails every comparison and then
  // disappears into a serialised payload as `null` either way.
  const cases: Array<[string, string, string]> = [
    ["content-length", "contentLength", "abc"],
    ["age", "age", "abc"],
    ["x-ratelimit-limit", "xRateLimitLimit", "abc"],
    ["x-ratelimit-remaining", "xRateLimitRemaining", "abc"],
    ["x-ratelimit-reset", "xRateLimitReset", "abc"],
    ["early-data", "earlyData", "abc"],
  ];
  for (const [header, accessor, raw] of cases) {
    const h = new RichHeaders({ [header]: raw });
    const got = (h as unknown as Record<string, unknown>)[accessor];
    assert.equal(got, null, `${accessor} on "${raw}" must be null, got ${String(got)}`);
  }
});

await test("a date accessor rejects an unparseable value rather than returning Invalid Date", async () => {
  for (const [header, accessor] of [
    ["date", "date"],
    ["last-modified", "lastModified"],
    ["expires", "expires"],
  ] as Array<[string, string]>) {
    const h = new RichHeaders({ [header]: "not-a-date" });
    const got = (h as unknown as Record<string, unknown>)[accessor];
    assert.equal(got, null, `${accessor} on "not-a-date" must be null, got ${String(got)}`);
  }
});

await test("setting null deletes the header", async () => {
  const setters: Array<[string, string]> = [
    ["contentType", "content-type"],
    ["contentLength", "content-length"],
    ["contentDisposition", "content-disposition"],
    ["cacheControl", "cache-control"],
    ["authorization", "authorization"],
    ["etag", "etag"],
    ["hsts", "strict-transport-security"],
    ["csp", "content-security-policy"],
    ["wwwAuthenticate", "www-authenticate"],
    ["proxyAuthenticate", "proxy-authenticate"],
  ];
  for (const [accessor, header] of setters) {
    const h = new RichHeaders({ [header]: "placeholder" });
    (h as unknown as Record<string, unknown>)[accessor] = null;
    assert.equal(h.get(header), null, `setting ${accessor} to null must remove "${header}"`);
  }
});

await test("every string-taking setter writes the string verbatim", async () => {
  const cases: Array<[string, string, string]> = [
    ["contentType", "content-type", "application/json"],
    ["contentLength", "content-length", "7"],
    ["contentDisposition", "content-disposition", "inline"],
    ["cacheControl", "cache-control", "no-cache"],
    ["authorization", "authorization", "Basic dXNlcjpwdw=="],
    ["etag", "etag", '"v2"'],
    ["csp", "content-security-policy", "default-src 'none'"],
  ];
  for (const [accessor, header, value] of cases) {
    const h = new RichHeaders();
    (h as unknown as Record<string, unknown>)[accessor] = value;
    assert.equal(h.get(header), value, `${accessor} must write "${value}" verbatim`);
  }
});

await test("the object-taking setters format rather than stringify", async () => {
  // The object branch is the one that runs when a caller hands over a parsed
  // value; writing `[object Object]` here would be silently wrong rather than
  // a type error, since the parameter is a union.
  const ct = new RichHeaders();
  ct.contentType = {
    mediaType: "application/json",
    type: "application",
    subtype: "json",
    charset: "utf-8",
    boundary: null,
    params: new Map([["charset", "utf-8"]]),
  };
  assert.match(ct.get("content-type")!, /^application\/json/, "contentType formats its object");

  const hsts = new RichHeaders();
  hsts.hsts = { maxAge: 100, includeSubDomains: true, preload: false };
  assert.match(hsts.get("strict-transport-security")!, /max-age=100/, "hsts formats its object");
  assert.match(
    hsts.get("strict-transport-security")!,
    /includeSubDomains/,
    "hsts keeps every field",
  );

  const cd = new RichHeaders();
  cd.contentDisposition = { type: "attachment", filename: "r.csv" };
  assert.match(
    cd.get("content-disposition")!,
    /attachment/,
    "contentDisposition formats its object",
  );

  const cc = new RichHeaders();
  cc.cacheControl = { noStore: true, maxAge: 60 };
  const rendered = cc.get("cache-control")!;
  assert.match(rendered, /no-store/, "cacheControl formats its object");
  assert.match(rendered, /max-age=60/, "cacheControl keeps every directive");

  const csp = new RichHeaders();
  csp.csp = new Map([["default-src", ["'self'"]]]);
  assert.match(csp.get("content-security-policy")!, /default-src/, "csp formats its map");

  const wa = new RichHeaders();
  wa.wwwAuthenticate = [{ scheme: "Bearer", realm: "r", params: [] }];
  assert.match(
    wa.get("www-authenticate")!,
    /Bearer realm="r"/,
    "wwwAuthenticate formats challenges",
  );
  const pa = new RichHeaders();
  pa.proxyAuthenticate = [{ scheme: "Basic", realm: "p", params: [] }];
  assert.match(
    pa.get("proxy-authenticate")!,
    /Basic realm="p"/,
    "proxyAuthenticate formats challenges",
  );
});

await test("the challenge setters omit an absent realm and empty params", async () => {
  // Both branches of `if (c.realm)` and `if (params)`: a challenge with
  // neither must format to the bare scheme, not to `scheme realm="undefined"`.
  const bare = new RichHeaders();
  bare.wwwAuthenticate = [{ scheme: "Negotiate", realm: "", params: [] }];
  assert.equal(
    bare.get("www-authenticate"),
    "Negotiate",
    "no realm and no params is the bare scheme",
  );

  const withParams = new RichHeaders();
  withParams.proxyAuthenticate = [
    { scheme: "Bearer", realm: "r", params: [["error", '"invalid_token"']] },
  ];
  assert.match(
    withParams.get("proxy-authenticate")!,
    /error="invalid_token"/,
    "non-realm params are kept",
  );
  assert.match(
    withParams.get("proxy-authenticate")!,
    /realm="r"/,
    "the realm is kept alongside them",
  );
});

console.log(`\n── RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
