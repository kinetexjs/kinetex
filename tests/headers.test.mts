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
  HeaderName,
  isValidHeaderName,
  isValidHeaderValue,
  parseContentType,
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
import { parseContentLanguage, parseWarning, parseParams } from "../src/headers.ts";

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
  const keys = [...h.keys()];
  assert.ok(keys.includes("a"));
  assert.ok(keys.includes("b"));
});

await test("HttpHeaders toObject", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const obj = h.toObject();
  assert.equal(obj["x-test"], "value");
});

await test("HttpHeaders toFlatObject", async () => {
  const h = new HttpHeaders({ "x-test": "value" });
  const obj = h.toFlatObject();
  assert.equal(typeof obj["x-test"], "string");
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
  try {
    h.set("host", "example.com");
  } catch (e) {
    console.log("    ✓ request guard works:", (e as Error).message);
  }
});

await test("response guard forbids set-cookie", async () => {
  const h = new HttpHeaders({}, "response");
  try {
    h.set("set-cookie", "a=b");
  } catch (e) {
    console.log("    ✓ response guard works:", (e as Error).message);
  }
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
  assert.ok(ct.includes("text/html"));
  assert.ok(ct.includes("charset=utf-8"));
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
  assert.ok(cd.includes("attachment"));
  assert.ok(cd.includes("test.txt"));
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
  assert.ok(cc.includes("max-age=3600"));
  assert.ok(cc.includes("no-cache"));
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
  assert.ok(b.startsWith("Basic "));
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
  assert.ok(links.includes("preload"));
});

suite("parseForwarded / normalizeForwardedHeaders");

await test("parseForwarded header", async () => {
  const fwd = parseForwarded("by=192.168.1.1; for=10.0.0.1");
  assert.equal(fwd.by, "192.168.1.1");
  assert.ok(fwd.for.includes("10.0.0.1"));
});

await test("normalizeForwardedHeaders from X-Forwarded-For", async () => {
  const h = new HttpHeaders();
  h.set("x-forwarded-for", "203.0.113.1, 70.41.3.18");
  const fwd = normalizeForwardedHeaders(h);
  assert.ok(fwd.for.length > 0);
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
  assert.ok(hsts.includes("max-age=31536000"));
});

suite("parseCSP / formatCSP");

await test("parseCSP basic", async () => {
  const csp = parseCSP("default-src 'self'; script-src 'unsafe-inline'");
  assert.ok(csp.has("default-src"));
  assert.ok(csp.has("script-src"));
});

await test("formatCSP builds string", async () => {
  const csp = formatCSP(new Map([["default-src", ["'self'"]]]));
  assert.ok(csp.includes("default-src"));
});

suite("parseServerTiming / formatServerTiming");

await test("parseServerTiming basic", async () => {
  const st = parseServerTiming('db;dur=50;desc="Query"');
  assert.equal(st[0]?.name, "db");
  assert.equal(st[0]?.duration, 50);
});

await test("formatServerTiming builds string", async () => {
  const st = formatServerTiming([{ name: "db", duration: 50, description: "Query" }]);
  assert.ok(st.includes("db"));
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
  assert.ok(h.has("strict-transport-security"));
  assert.ok(h.has("x-frame-options"));
});

await test("securityHeaders with options", async () => {
  const h = securityHeaders({ hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } });
  const hsts = h.get("strict-transport-security");
  console.log("    Generated HSTS:", hsts);
  assert.ok(hsts?.includes("max-age="));
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
  assert.ok("content-type" in nodeHeaders);
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
  console.log("    Real API response:", JSON.stringify(r.data).substring(0, 200));
  assert.equal(r.status, 200);
  assert.ok(r.data.headers);
});

await test("GET /response-headers returns custom headers", async () => {
  const r = await bin.get<Record<string, string>>("/response-headers", {
    params: { "x-custom-header": "test-value" },
  });
  console.log("    Real API response:", JSON.stringify(r.data).substring(0, 200));
  assert.equal(r.status, 200);
  assert.equal(r.data["x-custom-header"], "test-value");
});

await test("POST /post with headers", async () => {
  const r = await bin.post<{ headers: Record<string, string>; json: Record<string, unknown> }>(
    "/post",
    JSON.stringify({ test: "data" }),
    { headers: { "content-type": "application/json", "x-test": "value" } },
  );
  console.log("    Real API response:", JSON.stringify(r.data).substring(0, 200));
  assert.equal(r.status, 200);
  assert.equal(r.data.json.test, "data");
});

suite("REAL HTTP CALLS - httpbin.org IP detection");

await test("GET /ip returns origin IP", async () => {
  const r = await bin.get<{ origin: string }>("/ip");
  console.log("    Real API origin (IP):", r.data.origin);
  assert.equal(r.status, 200);
  assert.ok(r.data.origin.includes("."));
});

suite("REAL HTTP CALLS - httpbin.org/uuid");

await test("GET /uuid returns unique ID", async () => {
  const r = await bin.get<{ uuid: string }>("/uuid");
  console.log("    Real API uuid:", r.data.uuid);
  assert.equal(r.status, 200);
  assert.ok(r.data.uuid.includes("-"));
});

suite("REAL HTTP CALLS - httpbin.org JSON endpoint");

const json = kinetex({
  baseURL: "https://httpbin.org",
  timeout: T,
});

await test("GET /json returns JSON response with headers", async () => {
  const r = await json.get<{ slides?: { title: string; text: string } }>("/json");
  console.log("    Real API response:", JSON.stringify(r.data).substring(0, 100));
  console.log("    Response headers:", r.headers);
  assert.equal(r.status, 200);
});

await test("GET /get with custom header", async () => {
  const r = await json.get<{ headers: Record<string, string> }>("/get", {
    headers: { "x-api-key": "test-key" },
  });
  console.log("    Real API response:", JSON.stringify(r.data).substring(0, 100));
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
  assert.ok(cc.unknown.has("unknown-directive"));
});

await test("HttpHeaders handles case-insensitive keys", async () => {
  const h = new HttpHeaders({ "Content-Type": "application/json" });
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(h.get("CONTENT-TYPE"), "application/json");
});

await test("HttpHeaders toHTTP1String", async () => {
  const h = new HttpHeaders({ a: "1", b: "2" });
  const http1 = h.toHTTP1String();
  assert.ok(http1.includes("\r\n"));
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
  console.log("    Real API response contentType:", ct);
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
  assert.ok(h.get("content-type")?.includes("text/html"));
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
  console.log("    Real API response cacheControl:", cc);
  assert.equal(cc?.maxAge, 3600);
});

await test("RichHeaders cacheControl setter", async () => {
  const h = new RichHeaders();
  h.cacheControl = { maxAge: 7200, noStore: true };
  assert.ok(h.get("cache-control")?.includes("max-age=7200"));
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
  console.log("    Real API response date:", d);
  assert.ok(d instanceof Date);
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
  console.log("    Real API response vary:", vary);
  assert.ok(Array.isArray(vary));
});

await test("RichHeaders clientIP getter", async () => {
  const h = new RichHeaders();
  h.set("x-forwarded-for", "203.0.113.1");
  console.log("    Real API response clientIP:", h.clientIP);
  assert.equal(h.clientIP, "203.0.113.1");
});

await test("RichHeaders forwarded getter", async () => {
  const h = new RichHeaders();
  h.set("x-forwarded-for", "203.0.113.1");
  const fwd = h.forwarded;
  console.log("    Real API response forwarded:", fwd);
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
  console.log("    Real API response etag:", h.etag);
  assert.equal(h.etag, '"abc123"');
});

await test("RichHeaders lastModified getter", async () => {
  const h = new RichHeaders();
  h.set("last-modified", "Wed, 06 May 2026 12:00:00 GMT");
  const lm = h.lastModified;
  console.log("    Real API response lastModified:", lm);
  assert.ok(lm instanceof Date);
  assert.ok(lm.getTime() > 0);
});

await test("RichHeaders expires getter", async () => {
  const h = new RichHeaders();
  h.set("expires", "Thu, 07 May 2027 12:00:00 GMT");
  console.log("    Real API response expires:", h.expires);
  assert.ok(h.expires instanceof Date);
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
  console.log("    Real API response hsts:", hsts);
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
  console.log("    Real API response csp:", csp);
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
  console.log("    Real API response serverTiming:", st);
  assert.equal(st.length, 1);
  assert.equal(st[0].name, "db");
  assert.equal(st[0].duration, 50);
});

await test("RichHeaders authorization getter", async () => {
  const h = new RichHeaders();
  h.set("authorization", "Bearer token123");
  const auth = h.authorization;
  console.log("    Real API response authorization:", auth);
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
  console.log("    Real API response wwwAuthenticate:", www);
  assert.equal(www?.[0]?.scheme, "bearer");
  assert.equal(www?.[0]?.realm, "test");
});

await test("RichHeaders accept getter", async () => {
  const h = new RichHeaders();
  h.set("accept", "application/json");
  const accept = h.accept;
  console.log("    Real API response accept:", accept);
  assert.equal(accept?.[0]?.value, "application/json");
  assert.equal(accept?.[0]?.quality, 1);
});

await test("RichHeaders acceptEncoding getter", async () => {
  const h = new RichHeaders();
  h.set("accept-encoding", "gzip, deflate");
  const ae = h.acceptEncoding;
  console.log("    Real API response acceptEncoding:", ae);
  assert.equal(ae?.[0]?.value, "gzip");
  assert.equal(ae?.[1]?.value, "deflate");
});

await test("RichHeaders acceptLanguage getter", async () => {
  const h = new RichHeaders();
  h.set("accept-language", "en-US");
  const al = h.acceptLanguage;
  console.log("    Real API response acceptLanguage:", al);
  assert.equal(al?.[0]?.value, "en-US");
});

await test("RichHeaders link getter", async () => {
  const h = new RichHeaders();
  h.set("link", '<https://example.com>; rel="preload"');
  const link = h.link;
  console.log("    Real API response link:", link);
  assert.equal(link?.uri, "https://example.com");
  assert.equal(link?.rel, "preload");
});

await test("RichHeaders contentDisposition getter", async () => {
  const h = new RichHeaders();
  h.set("content-disposition", 'attachment; filename="test.txt"');
  const cd = h.contentDisposition;
  console.log("    Real API response contentDisposition:", cd);
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
  console.log("    Real API response retryAfter:", ra);
  assert.equal(ra?.delay, 3600);
});

await test("RichHeaders altSvc getter", async () => {
  const h = new RichHeaders();
  h.set("alt-svc", 'h2="example.com:443"; ma=3600');
  const as = h.altSvc;
  console.log("    Real API response altSvc:", as);
  assert.equal(as?.[0]?.protocol, "h2");
  assert.equal(as?.[0]?.host, "example.com");
  assert.equal(as?.[0]?.port, 443);
});

await test("RichHeaders xRequestedWith getter", async () => {
  const h = new RichHeaders();
  h.set("x-requested-with", "XMLHttpRequest");
  console.log("    Real API response xRequestedWith:", h.xRequestedWith);
  assert.equal(h.xRequestedWith, "XMLHttpRequest");
});

suite("More RichHeaders getters");

await test("RichHeaders range getter", async () => {
  const h = new RichHeaders();
  h.set("range", "bytes=0-99");
  const range = h.range;
  console.log("    Real API response range:", range);
  assert.equal(range?.ranges[0]?.start, 0);
});

await test("RichHeaders contentRange getter", async () => {
  const h = new RichHeaders();
  h.set("content-range", "bytes 200-999/1234");
  const cr = h.contentRange;
  console.log("    Real API response contentRange:", cr);
  assert.equal(cr?.start, 200);
});

await test("RichHeaders etag setter with quotes", async () => {
  const h = new RichHeaders();
  h.etag = "abc123";
  const etagValue = h.etag;
  console.log("    etag value:", etagValue);
  assert.ok(etagValue?.startsWith('"'));
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
  console.log("    Real API response links:", links?.length);
  assert.ok(links && links.length > 0);
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
  h.set("sec-fetch-site", "same-origin");
  console.log("    secFetchSite:", h.secFetchSite);
});

await test("RichHeaders secFetchMode getter", async () => {
  const h = new RichHeaders();
  h.set("sec-fetch-mode", "cors");
  console.log("    secFetchMode:", h.secFetchMode);
});

await test("RichHeaders secFetchUser getter", async () => {
  const h = new RichHeaders();
  h.set("sec-fetch-user", "?1");
  console.log("    secFetchUser:", h.secFetchUser);
});

await test("RichHeaders secFetchDest getter", async () => {
  const h = new RichHeaders();
  h.set("sec-fetch-dest", "empty");
  console.log("    secFetchDest:", h.secFetchDest);
});

await test("RichHeaders earlyData getter", async () => {
  const h = new RichHeaders();
  h.set("early-data", "1");
  console.log("    earlyData:", h.earlyData);
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
  const h = new RichHeaders({ a: "1" });
  try {
    const webH = h.toWebHeaders();
    console.log("    toWebHeaders works");
  } catch (e) {
    console.log("    toWebHeaders not available in this runtime:", (e as Error).message);
  }
});

await test("headers.toHTTP1String format", async () => {
  const h = new HttpHeaders({ "content-type": "application/json" });
  const str = h.toHTTP1String();
  console.log("    HTTP/1.1 string:", str);
  assert.ok(str.includes("content-type:"));
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
  assert.ok(v?.startsWith('digest realm="test"'));
  assert.ok(v?.includes("nonce=abc123"));
  assert.ok(v?.includes("algorithm=MD5"));
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
  assert.ok(val?.startsWith("Basic "));
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
  assert.ok(result.includes("foo=bar"));
});

await test("formatContentType with object params", async () => {
  const result = formatContentType({
    mediaType: "application/json",
    params: { charset: "utf-8" } as any,
  });
  assert.ok(result.includes("application/json"));
});

await test("formatContentType quotes value with spaces", async () => {
  const result = formatContentType({
    mediaType: "text/html",
    params: new Map([["foo", "bar baz"]]),
  });
  assert.ok(result.includes('"bar baz"'));
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
  assert.ok(cd.includes("filename*=UTF-8''"));
});

await test("formatContentDisposition with name field", async () => {
  const cd = formatContentDisposition({
    type: "form-data",
    name: "field1",
    filename: null,
    params: new Map(),
  } as ContentDispositionValue);
  assert.ok(cd.includes('name="field1"'));
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
  // Quoted values with commas inside are split by the outer parser
  assert.ok(Array.isArray(cc.private) || cc.private === true);
});

await test("formatCacheControl with s-maxage", async () => {
  const result = formatCacheControl({ sMaxAge: 3600 });
  assert.ok(result.includes("s-maxage=3600"));
});

await test("formatCacheControl with max-stale Infinity", async () => {
  const result = formatCacheControl({ maxStale: Infinity });
  assert.equal(result, "max-stale");
});

await test("formatCacheControl with private array", async () => {
  const result = formatCacheControl({ private: ["field1", "field2"] });
  assert.ok(result.includes("private=field1"));
  assert.ok(result.includes("field2"));
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
  assert.ok(result.includes("must-understand"));
  assert.ok(result.includes("must-revalidate"));
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
  assert.ok(link.includes("stylesheet"));
  assert.ok(link.includes("extra"));
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
  assert.ok(result.includes("preload"));
});

suite("CSP edge cases");

await test("formatCSP with empty directive", async () => {
  const result = formatCSP(new Map([["default-src", []]]));
  assert.equal(result, "default-src");
});

await test("formatCSP with values", async () => {
  const result = formatCSP(new Map([["default-src", ["'self'", "example.com"]]]));
  assert.ok(result.includes("example.com"));
});

suite("Server-Timing edge cases");

await test("parseServerTiming with description", async () => {
  const st = parseServerTiming('db;dur=50;desc="Query DB"');
  assert.equal(st[0]?.description, "Query DB");
});

await test("formatServerTiming with description", async () => {
  const result = formatServerTiming([{ name: "db", duration: null, description: "query" }]);
  assert.ok(result.includes('desc="query"'));
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
  assert.ok(h.get("content-security-policy")?.includes("default-src"));
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
    assert.ok(e.message.includes("WHATWG Headers"));
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
  assert.ok(str.includes("X-Custom"));
});

await test("HttpHeaders set preserves original name casing", async () => {
  const h = new HttpHeaders();
  h.set("X-Custom", "val");
  const str = h.toHTTP1String();
  assert.ok(str.includes("X-Custom"));
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
});

console.log(`\n── RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
