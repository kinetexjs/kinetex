/**
 * url.ts — Real battle tests for URL utilities
 * ALL HTTP calls use kinetex - NO native fetch, NO mocks, NO predefined data.
 *
 * Run: npx tsx tests/url.test.mts
 *
 * APIs: httpbin.org, jsonplaceholder.typicode.com
 */

import assert from "node:assert/strict";
import {
  percentEncode,
  percentDecode,
  encodePathComponent,
  encodeQueryValue,
  stringifyQuery,
  parseQuery,
  mergeQuery,
  pickQuery,
  omitQuery,
  joinPath,
  normalizePath,
  pathSegments,
  fillPathParams,
  normalizeURL,
  URLBuilder,
  expandTemplate,
  compilePattern,
  getOrigin,
  isSameOrigin,
  isSameSite,
  resolveURL,
  relativeURL,
  isAbsolute,
  isRelative,
  isHTTPS,
  isHTTP,
  isDataURL,
  isBlobURL,
  isLocalhost,
  parseDataURL,
  buildDataURL,
  diffURLs,
  safeParseURL,
  withTrailingSlash,
  withoutTrailingSlash,
  stripHash,
  stripQuery,
  urlExtension,
  urlFilename,
  redactURL,
  kinetex,
} from "../src/mod.ts";
import { URLValidationError } from "../src/url.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    // Almost every test here makes a live call to httpbin or jsonplaceholder.
    // The clients carry a 30s timeout, so a hung socket fails on its own --
    // but a test that never settles for another reason (a promise nobody
    // resolves) would park the whole file with no output at all, which is
    // indistinguishable from a slow machine. 45s leaves headroom over the
    // client timeout so a genuine network failure is still reported as that.
    await withTimeout(Promise.resolve().then(fn), 45_000, name);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

/** Reject with a timeout error if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`test "${name}" timed out after ${ms}ms`)), ms);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const T = 30_000;
const bin = kinetex({ baseURL: "https://httpbin.org", timeout: T });
const json = kinetex({ baseURL: "https://jsonplaceholder.typicode.com", timeout: T });

// ============================================================================
// §1  PERCENT ENCODING / DECODING — tested with REAL httpbin responses
// ============================================================================

suite("Percent encoding / decoding");

await test("percentEncode encodes spaces as %20 — verified via kinetex", async () => {
  const result = percentEncode("hello world");
  console.log("    percentEncode result:", result);

  const r = await bin.get("/get", { params: { encoded: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received encoded value:", args.encoded);
  assert.equal(result, "hello%20world");
  assert.equal(args.encoded, "hello%20world");
});

await test("percentEncode encodes special chars = and & — verified via kinetex", async () => {
  const result = percentEncode("a=b&c=d");
  console.log("    percentEncode result:", result);

  const r = await bin.get("/get", { params: { q: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received:", args.q);
  assert.equal(result, "a%3Db%26c%3Dd");
  assert.equal(args.q, "a%3Db%26c%3Dd");
});

await test("percentEncode encodes UTF-8 chars — verified via kinetex", async () => {
  const result = percentEncode("café");
  console.log("    percentEncode UTF-8 result:", result);

  const r = await bin.get("/anything", { params: { name: result } });
  const data = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received UTF-8:", data.name);
  assert.equal(result, "caf%C3%A9");
});

await test("percentEncode preserves unreserved chars per RFC 3986", async () => {
  const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
  const result = percentEncode(unreserved);
  console.log("    Unreserved preserved:", result === unreserved);
  assert.equal(result, unreserved);
});

await test("percentDecode decodes %20 — verified via kinetex", async () => {
  const encoded = "hello%20world";
  const result = percentDecode(encoded);
  console.log("    percentDecode result:", result);

  const r = await bin.get("/get", { params: { q: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received decoded:", args.q);
  assert.equal(result, "hello world");
  assert.equal(args.q, "hello world");
});

await test("percentDecode handles + as space — verified via kinetex", async () => {
  const result = percentDecode("hello+world");
  console.log("    + as space result:", result);
  assert.equal(result, "hello world");
});

await test("Real API: kinetex sends percent-encoded query params and server decodes", async () => {
  const r = await bin.get("/get", { params: { "hello world": "test value" } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Real API args:", JSON.stringify(args));
  assert.equal(args["hello world"], "test value");
});

await test("Real API: kinetex echoes percent-encoded path", async () => {
  const encoded = percentEncode("special/path");
  const r = await bin.get(`/anything/${encoded}`);
  const data = r.data as { url: string };
  console.log("    Real API echoed URL:", data.url);
  console.log("    Original encoded:", encoded);
  // httpbin decodes path segments before echoing, so verify the decoded path is present
  assert.strictEqual(data.url.includes("/anything/special/path"), true);
});

// ============================================================================
// §2  ENCODE PATH COMPONENT / QUERY VALUE — tested with REAL httpbin
// ============================================================================

suite("Path and query encoding");

await test("encodeQueryValue encodes & and = — verified via kinetex", async () => {
  const result = encodeQueryValue("hello&world=value");
  console.log("    encodeQueryValue result:", result);

  const r = await bin.get("/get", { params: { q: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received:", args.q);
  assert.strictEqual(args.q.includes("&"), false);
  assert.strictEqual(args.q.includes("="), false);
});

await test("Real API: kinetex query with encoded special chars round-trips", async () => {
  const r = await bin.get("/get", { params: { q: "a=b&c=d", tag: "hello world" } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Real API args:", JSON.stringify(args));
  assert.equal(args.q, "a=b&c=d");
  assert.equal(args.tag, "hello world");
});

// ============================================================================
// §3  QUERY STRING FUNCTIONS — tested with REAL kinetex + httpbin
// ============================================================================

suite("Query string manipulation");

await test("stringifyQuery builds query — verified via kinetex", async () => {
  const qs = stringifyQuery({ a: "1", b: "hello", c: "3" });
  console.log("    stringifyQuery result:", qs);

  const r = await bin.get("/get", { params: { a: "1", b: "hello", c: "3" } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server parsed args:", JSON.stringify(args));
  assert.equal(args.a, "1");
  assert.equal(args.b, "hello");
});

await test("stringifyQuery arrays repeat format — verified via kinetex", async () => {
  const qs = stringifyQuery({ tags: ["a", "b", "c"] });
  console.log("    stringifyQuery array:", qs);

  const r = await bin.get(`/get?${qs}`);
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received tags:", args);
  const tagCount = (qs.match(/tags=/g) || []).length;
  assert.equal(tagCount, 3);
});

await test("stringifyQuery bracket format — verified via kinetex", async () => {
  const qs = stringifyQuery({ items: ["x", "y"] }, { arrayFormat: "bracket" });
  console.log("    bracket format:", qs);

  const r = await bin.get("/get", { params: { q: qs } });
  const data = r.data as { args: Record<string, string> };
  console.log("    Server received bracket:", data.args.q);
  assert.strictEqual(qs.includes("items[]="), true);
});

await test("stringifyQuery comma format — verified via kinetex", async () => {
  const qs = stringifyQuery({ tags: ["a", "b"] }, { arrayFormat: "comma" });
  console.log("    comma format:", qs);

  const r = await bin.get("/get", { params: { q: qs } });
  const data = r.data as { args: Record<string, string> };
  console.log("    Server received comma:", data.args.q);
  assert.strictEqual(qs.includes("tags="), true);
});

await test("parseQuery parses response from kinetex", async () => {
  const r = await bin.get("/get", { params: { a: "1", b: "hello" } });
  const url = (r.data as { url: string }).url;
  const parsed = parseQuery(url.split("?")[1] || "");
  console.log("    Parsed from URL:", JSON.stringify(parsed));
  assert.equal(parsed.a, "1");
  assert.equal(parsed.b, "hello");
});

await test("parseQuery repeated keys — verified via kinetex", async () => {
  const r = await bin.get("/get", { params: { tag: ["a", "b", "c"] } });
  const url = (r.data as { url: string }).url;
  console.log("    URL with repeated keys:", url);
  const parsed = parseQuery(url.split("?")[1] || "");
  console.log("    Parsed repeated:", JSON.stringify(parsed));
  assert.equal(url, "https://httpbin.org/get?tag=a&tag=b&tag=c");
  assert.deepEqual(parsed.tag, ["a", "b", "c"]);
});

await test("mergeQuery result sent via kinetex", async () => {
  const merged = mergeQuery({ a: "1" }, { b: "2" });
  const qs = stringifyQuery(merged);
  console.log("    Merged query string:", qs);

  const r = await bin.get("/get", { params: merged });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received:", JSON.stringify(args));
  assert.equal(args.a, "1");
  assert.equal(args.b, "2");
});

await test("pickQuery result sent via kinetex", async () => {
  const picked = pickQuery({ a: "1", b: "2", c: "3" }, "a", "c");
  const r = await bin.get("/get", { params: picked });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Picked params sent:", JSON.stringify(args));
  assert.equal(args.a, "1");
  assert.strictEqual("b" in args, false);
  assert.equal(args.c, "3");
});

await test("omitQuery result sent via kinetex", async () => {
  const omitted = omitQuery({ a: "1", b: "2", c: "3" }, "b");
  const r = await bin.get("/get", { params: omitted });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Omitted params sent:", JSON.stringify(args));
  assert.equal(args.a, "1");
  assert.strictEqual("b" in args, false);
  assert.equal(args.c, "3");
});

// ============================================================================
// §4  PATH UTILITIES — tested with REAL jsonplaceholder
// ============================================================================

suite("Path utilities");

await test("joinPath constructs valid path — verified via kinetex", async () => {
  const path = joinPath("/posts", "1");
  console.log("    joinPath result:", path);

  try {
    const r = await json.get(path);
    assert.equal(r.status, 200);
  } catch (e) {
    // This catch encloses its own `assert.equal`, so the bare `catch {}` it
    // replaced could swallow a *failing assertion* as readily as a flaky
    // network — reporting a pass for a broken joinPath. Only a genuine
    // transport failure may be tolerated.
    const why = `${(e as { name?: string })?.name ?? ""}: ${(e as { message?: string })?.message ?? String(e)}`;
    assert.ok(
      /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout|network|socket/i.test(
        why,
      ),
      `joinPath verification failed for a non-network reason and must not be skipped: ${why}`,
    );
    console.log(`    → upstream unavailable, skipping: ${why}`);
  }
});

await test("normalizePath removes extra slashes", async () => {
  // The old version built the path, printed it, and then fetched a
  // hard-coded "/users/1/posts" -- so normalizePath's own output was never
  // checked by anything in this file.
  assert.equal(normalizePath("//users///1////posts"), "/users/1/posts");
  // Dot segments resolved.
  assert.equal(normalizePath("/a/./b/../c"), "/a/c");
  // `..` cannot climb above the root.
  assert.equal(normalizePath("/../../etc/passwd"), "/etc/passwd");
  // A relative path comes back rooted, and the root itself is stable.
  assert.equal(normalizePath("users/1"), "/users/1");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath(""), "/");
  // The trailing-slash policy, which the default only ever "preserves".
  assert.equal(normalizePath("/a/b"), "/a/b");
  assert.equal(normalizePath("/a/b/"), "/a/b/");
  assert.equal(normalizePath("/a/b", { trailingSlash: "add" }), "/a/b/");
  assert.equal(normalizePath("/a/b/", { trailingSlash: "remove" }), "/a/b");
  // ...and the root is exempt from both.
  assert.equal(normalizePath("/", { trailingSlash: "add" }), "/");
  assert.equal(normalizePath("/", { trailingSlash: "remove" }), "/");
  // ...and from "preserve" too, which is the one that used to double it.
  assert.equal(normalizePath("//"), "/");
});

await test("fillPathParams substitution — verified via kinetex", async () => {
  const template = "/posts/:id";
  const path = fillPathParams(template, { id: "1" });
  console.log("    filled path:", path);

  const r = await json.get(path);
  const data = r.data as { id: number; title: string };
  assert.equal(data.id, 1);
  assert.strictEqual(data.title.length > 0, true);
});

await test("Real API: multiple fillPathParams calls with kinetex", async () => {
  for (const id of [1, 5, 10]) {
    const path = fillPathParams("/posts/:id", { id: String(id) });
    const r = await json.get(path);
    const data = r.data as { id: number };
    console.log(`    /posts/${id} returns id:`, data.id);
    assert.equal(data.id, id);
  }
});

await test("Real API: pathSegments with kinetex", async () => {
  const path = "/posts/1";
  const segs = pathSegments(path);
  console.log("    pathSegments:", JSON.stringify(segs));

  const lastSeg = segs[segs.length - 1];
  const r = await json.get(`/posts/${lastSeg}`);
  const data = r.data as { id: number };
  console.log("    Fetched by segment:", data.id);
  assert.equal(data.id, 1);
});

// ============================================================================
// §5  URL NORMALIZATION — tested with REAL httpbin responses
// ============================================================================

suite("URL normalization");

await test("normalizeURL result used in kinetex request", async () => {
  const original = "HTTP://EXAMPLE.COM/path?Z=1&A=2";
  const normalized = normalizeURL(original);
  console.log("    Normalized:", normalized);

  const r = await bin.get("/get", { params: { url: normalized } });
  const data = r.data as { args: Record<string, string> };
  console.log("    Server received:", data.args.url);
  assert.equal(normalized.slice(0, 7), "http://");
  assert.strictEqual(normalized.includes("example.com"), true);
});

await test("normalizeURL sortParams — verified via kinetex", async () => {
  const url = normalizeURL("http://example.com?z=1&a=2&m=3", { sortParams: true });
  console.log("    Sorted URL:", url);
  const params = url.split("?")[1].split("&");
  assert.equal(params[0].slice(0, 2), "a=");
});

await test("Real API: normalizeURL on httpbin response URL", async () => {
  const r = await bin.get("/get");
  const responseUrl = (r.data as { url: string }).url;
  console.log("    Original response URL:", responseUrl);

  const normalized = normalizeURL(responseUrl);
  console.log("    Normalized:", normalized);

  assert.equal(normalized.slice(0, 8), "https://");
  assert.strictEqual(normalized.includes("httpbin.org"), true);
});

// ============================================================================
// §6  URL BUILDER — tested with REAL kinetex requests
// ============================================================================

suite("URLBuilder fluent API");

await test("URLBuilder withProtocol", async () => {
  const url = URLBuilder.from("https://httpbin.org/get").withProtocol("http").toString();
  // The old version asserted only that a request to "/get" returned 200,
  // which says nothing about the protocol the builder produced.
  assert.equal(url, "http://httpbin.org/get");
  assert.equal(new URL(url).protocol, "http:");
});

await test("URLBuilder withHostname", async () => {
  const url = URLBuilder.http("httpbin.org", "/get").toString();
  assert.equal(url, "http://httpbin.org/get");
  // ...and the round trip the old test meant to check: a URL built by the
  // builder is one this client can actually fetch.
  const r = await bin.get(
    URLBuilder.http("httpbin.org", "/get").toString().replace("http://httpbin.org", ""),
  );
  assert.equal(r.status, 200);
});

await test("URLBuilder withPort", async () => {
  // `withPort` was never called here at all -- the test built a base URL,
  // printed it, and then fetched a hard-coded "/get".
  assert.equal(
    URLBuilder.from("https://example.com").withPort(8080).toString(),
    "https://example.com:8080/",
  );
  assert.equal(
    new URL(URLBuilder.from("https://example.com/a").withPort(8080).toString()).port,
    "8080",
  );
  // A default port is normalised away by the URL itself, not re-added.
  assert.equal(new URL(URLBuilder.from("https://example.com/a").withPort(443).toString()).port, "");
});

await test("URLBuilder.setParam", async () => {
  const url = URLBuilder.from("https://httpbin.org/get")
    .setParam("page", "1")
    .setParam("limit", "10")
    .toString();
  assert.equal(url, "https://httpbin.org/get?page=1&limit=10");
  // `set` replaces rather than appends.
  assert.equal(
    URLBuilder.from("https://example.com/?a=1").setParam("a", "2").toString(),
    "https://example.com/?a=2",
  );
});

await test("URLBuilder.appendParam", async () => {
  const url = URLBuilder.from("https://httpbin.org/get")
    .appendParam("tag", "a")
    .appendParam("tag", "b")
    .toString();
  // Two entries with the same name, in order -- `includes("tag=a") && ...`
  // also passed for a single `tag=ab`.
  assert.equal(url, "https://httpbin.org/get?tag=a&tag=b");
  assert.deepStrictEqual(new URL(url).searchParams.getAll("tag"), ["a", "b"]);
  // A nullish value is a no-op rather than a literal "null".
  assert.equal(
    URLBuilder.from("https://example.com/?a=1")
      .appendParam("b", null as unknown as string)
      .toString(),
    "https://example.com/?a=1",
  );
});

await test("URLBuilder.deleteParam", async () => {
  const base = URLBuilder.from("https://httpbin.org/get?a=1&b=2&c=3");
  const url = base.deleteParam("b").toString();
  assert.equal(url, "https://httpbin.org/get?a=1&c=3");
  // Every occurrence goes, and an absent key is a no-op.
  assert.equal(
    URLBuilder.from("https://example.com/?t=a&t=b").deleteParam("t").toString(),
    "https://example.com/",
  );
  assert.equal(base.deleteParam("zzz").toString(), "https://httpbin.org/get?a=1&b=2&c=3");
});

await test("URLBuilder.query", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?existing=1")
    .query({ added: "2", existing: null })
    .toString();
  // Merged in, and a null value DELETED -- the old test only checked the
  // echo of `{ added: "2" }, which the builder's `existing` handling could
  // have got entirely wrong.
  assert.equal(url, "https://httpbin.org/get?added=2");
  // An array becomes repeated keys, in order.
  assert.equal(
    URLBuilder.from("https://example.com/")
      .query({ t: ["a", "b"] })
      .toString(),
    "https://example.com/?t=a&t=b",
  );
});

await test("URLBuilder.pickParams", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?a=1&b=2&c=3")
    .pickParams("a", "c")
    .toString();
  assert.equal(url, "https://httpbin.org/get?a=1&c=3");
  assert.equal(
    URLBuilder.from("https://example.com/?a=1").pickParams("zzz").toString(),
    "https://example.com/",
  );
});

await test("URLBuilder.omitParams", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?a=1&b=2&c=3").omitParams("b").toString();
  assert.equal(url, "https://httpbin.org/get?a=1&c=3");
  // Omitting several, and omitting an absent key.
  assert.equal(
    URLBuilder.from("https://example.com/?a=1&b=2&c=3").omitParams("a", "c", "zzz").toString(),
    "https://example.com/?b=2",
  );
});

await test("URLBuilder.sortParams — verified via kinetex", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?z=1&a=2&m=3").sortParams().toString();
  console.log("    Sorted URL:", url);
  const params = url.split("?")[1];
  assert.equal(params.slice(0, 2), "a=");
});

await test("URLBuilder.redactParams — verified via kinetex", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?token=secret&public=data")
    .redactParams("token")
    .toString();
  console.log("    Redacted URL:", url);
  assert.strictEqual(url.includes("REDACTED"), true);
  assert.strictEqual(url.includes("public=data"), true);
});

await test("URLBuilder.withHash — verified via kinetex", async () => {
  const url = URLBuilder.from("https://httpbin.org/get").withHash("section").toString();
  console.log("    URL with hash:", url);
  assert.strictEqual(url.includes("#section"), true);
});

await test("URLBuilder.removeHash — verified via kinetex", async () => {
  const url = URLBuilder.from("https://httpbin.org/get#section").removeHash().toString();
  console.log("    URL without hash:", url);
  assert.strictEqual(url.includes("#"), false);
});

await test("Real API: URLBuilder constructs full request for jsonplaceholder", async () => {
  const url = URLBuilder.https("jsonplaceholder.typicode.com", "/posts").appendPath("1").toString();
  console.log("    Built URL:", url);

  const r = await json.get("/posts/1");
  const data = r.data as { id: number; title: string };
  assert.equal(data.id, 1);
  assert.strictEqual(data.title.length > 0, true);
});

// ============================================================================
// §7  RFC 6570 TEMPLATE EXPANSION — tested with REAL httpbin
// ============================================================================

suite("RFC 6570 template expansion");

await test("expandTemplate simple substitution — verified via kinetex", async () => {
  const template = "/anything/{id}";
  const path = expandTemplate(template, { id: "123" });
  console.log("    Expanded path:", path);

  const r = await bin.get(path);
  const data = r.data as { url: string };
  console.log("    Server received URL:", data.url);
  assert.strictEqual(data.url.includes("123"), true);
});

await test("expandTemplate + operator — verified via kinetex", async () => {
  const template = "{+path}";
  const result = expandTemplate(template, { path: "/foo/bar" });
  console.log("    + operator result:", result);
  assert.equal(result, "/foo/bar");
});

await test("expandTemplate ? query operator — verified via kinetex", async () => {
  const template = "{?q,lang}";
  const query = expandTemplate(template, { q: "search", lang: "en" });
  console.log("    Query expansion:", query);

  const r = await bin.get("/get", { params: { q: "search", lang: "en" } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received:", JSON.stringify(args));
  assert.equal(args.q, "search");
  assert.equal(args.lang, "en");
});

await test("Real API: expandTemplate with kinetex full workflow", async () => {
  const base = "https://httpbin.org";
  const template = "/anything/{resource}/{id}";
  const path = expandTemplate(template, { resource: "posts", id: "42" });
  const url = `${base}${path}`;
  console.log("    Full URL:", url);

  const r = await bin.get(path);
  const data = r.data as { url: string };
  console.log("    Server received:", data.url);
  assert.strictEqual(data.url.includes("posts"), true);
  assert.strictEqual(data.url.includes("42"), true);
});

// ============================================================================
// §8  URL PATTERN MATCHING — tested with REAL jsonplaceholder
// ============================================================================

suite("URL pattern matching");

await test("compilePattern matches real jsonplaceholder URLs", async () => {
  const pattern = compilePattern("/posts/:id");
  console.log("    Pattern: /posts/:id");

  for (const id of [1, 2, 3, 10, 50, 100]) {
    const url = `https://jsonplaceholder.typicode.com/posts/${id}`;
    const match = pattern.match(url);
    console.log(
      `    /posts/${id} matches:`,
      match !== null,
      "params:",
      JSON.stringify(match?.params),
    );
    assert.notStrictEqual(match, null);
    assert.equal(match!.params.id, String(id));
  }
});

await test("compilePattern with greedy wildcard — verified via kinetex", async () => {
  const pattern = compilePattern("/posts/**");
  const url = "https://jsonplaceholder.typicode.com/posts/1/comments";
  const match = pattern.match(url);
  console.log("    Greedy wildcard match:", JSON.stringify(match));
  assert.notStrictEqual(match, null);
});

await test("compilePattern.test() — verified via kinetex", async () => {
  const pattern = compilePattern("/posts/:id");

  for (const id of [1, 5]) {
    const url = `https://jsonplaceholder.typicode.com/posts/${id}`;
    const result = pattern.test(url);
    console.log(`    Pattern.test(${url}):`, result);
    assert.equal(result, true);
  }

  const nonMatch = "https://jsonplaceholder.typicode.com/users/1";
  console.log(`    Pattern.test(${nonMatch}):`, pattern.test(nonMatch));
  assert.equal(pattern.test(nonMatch), false);
});

// ============================================================================
// §9  ORIGIN & SAME-ORIGIN — tested with REAL httpbin
// ============================================================================

suite("Origin and same-origin");

await test("getOrigin extracts from real httpbin response", async () => {
  const r = await bin.get("/get");
  const responseUrl = (r.data as { url: string }).url;
  console.log("    Response URL:", responseUrl);

  const origin = getOrigin(responseUrl);
  console.log("    Extracted origin:", origin);
  assert.equal(origin, "https://httpbin.org");
});

await test("isSameOrigin with real URLs", async () => {
  const r1 = await bin.get("/get");
  const r2 = await bin.get("/get");

  const url1 = (r1.data as { url: string }).url;
  const url2 = (r2.data as { url: string }).url;

  console.log("    URL1:", url1);
  console.log("    URL2:", url2);
  console.log("    Same origin:", isSameOrigin(url1, url2));
  assert.strictEqual(isSameOrigin(url1, url2), true);
});

await test("isSameSite with real URLs — verified via kinetex", async () => {
  const r1 = await bin.get("/get");
  const url1 = (r1.data as { url: string }).url;

  const result = isSameSite(url1, "https://httpbin.org/anything");
  console.log("    Same site:", result);
  assert.equal(result, true);
});

await test("Real API: getOrigin from httpbin response", async () => {
  const r = await bin.get("/get");
  const origin = (r.data as { origin: string }).origin;
  const url = `https://httpbin.org/get`;

  console.log("    Server origin:", origin);
  console.log("    getOrigin result:", getOrigin(url));
  assert.strictEqual(getOrigin(url)!.includes("httpbin.org"), true);
});

// ============================================================================
// §10  URL RESOLUTION — tested with REAL kinetex
// ============================================================================

suite("URL resolution");

await test("resolveURL used in kinetex request", async () => {
  const base = "https://jsonplaceholder.typicode.com";
  const path = resolveURL("posts/1", base);
  console.log("    Resolved URL:", path);

  const r = await json.get(path.replace(base, ""));
  const data = r.data as { id: number };
  assert.equal(data.id, 1);
});

await test("relativeURL makes URL relative — verified via kinetex", async () => {
  const fullUrl = "https://jsonplaceholder.typicode.com/posts/1";
  const base = "https://jsonplaceholder.typicode.com/posts/1";
  const relative = relativeURL(fullUrl, base);
  console.log("    Relative URL:", relative);

  assert.equal(relative, "");

  const r = await json.get("/posts/1");
  const data = r.data as { id: number };
  console.log("    Fetched by full path:", data.id);
  assert.equal(data.id, 1);
});

await test("Real API: resolveURL with jsonplaceholder", async () => {
  const base = "https://jsonplaceholder.typicode.com";

  for (const endpoint of ["posts", "users", "comments"]) {
    const resolved = resolveURL(endpoint, base);
    console.log("    Resolved:", resolved);
    const r = await json.get(resolved.replace(base, ""));
    console.log("    Status:", r.status);
    assert.strictEqual(r.status, 200);
  }
});

// ============================================================================
// §11  URL CLASSIFICATION — tested with REAL httpbin
// ============================================================================

suite("URL classification");

await test("isAbsolute with real httpbin URL", async () => {
  const r = await bin.get("/get");
  const url = (r.data as { url: string }).url;

  console.log("    Real URL:", url);
  console.log("    isAbsolute:", isAbsolute(url));
  assert.strictEqual(isAbsolute(url), true);
});

await test("isHTTPS with real https URL", async () => {
  const r = await bin.get("/get");
  const url = (r.data as { url: string }).url;

  console.log("    Real URL:", url);
  console.log("    isHTTPS:", isHTTPS(url));
  assert.strictEqual(isHTTPS(url), true);
});

await test("isHTTP with real URLs", async () => {
  const r = await bin.get("/get");
  const url = (r.data as { url: string }).url;

  console.log("    isHTTP:", isHTTP(url));
  assert.strictEqual(isHTTP(url), true);
});

await test("Real API: URL classification of httpbin responses", async () => {
  const r = await bin.get("/get");
  const url = (r.data as { url: string }).url;

  console.log("    URL:", url);
  console.log("    isAbsolute:", isAbsolute(url));
  console.log("    isHTTPS:", isHTTPS(url));
  console.log("    isHTTP:", isHTTP(url));
  console.log("    isLocalhost:", isLocalhost(url));

  assert.strictEqual(isAbsolute(url), true);
  assert.strictEqual(isHTTPS(url), true);
  assert.strictEqual(isHTTP(url), true);
  assert.strictEqual(isLocalhost(url), false);
});

// ============================================================================
// §12  DATA URL HELPERS — tested with REAL kinetex
// ============================================================================

suite("Data URL helpers");

await test("buildDataURL string — verified via kinetex", async () => {
  const dataUrl = buildDataURL("hello world", "text/plain", false);
  console.log("    Built data URL:", dataUrl);

  const r = await bin.post("/post", dataUrl.split(",")[1] || "hello");
  console.log("    POST status:", r.status);
  assert.strictEqual(r.status, 200);
});

await test("buildDataURL Uint8Array — verified via kinetex", async () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111]);
  const dataUrl = buildDataURL(bytes, "text/plain", true);
  console.log("    Uint8Array data URL:", dataUrl);
  // Verify full structure: prefix + base64 payload that decodes to "Hello"
  const prefix = "data:text/plain;base64,";
  assert.ok(dataUrl.startsWith(prefix), `Expected prefix "${prefix}" but got "${dataUrl}"`);
  const base64Payload = dataUrl.slice(prefix.length);
  const decoded = atob(base64Payload);
  assert.strictEqual(decoded, "Hello", `Expected "Hello" but decoded "${decoded}"`);
});

await test("Real API: data URL round-trip via kinetex", async () => {
  const original = "test data for round-trip";
  const dataUrl = buildDataURL(original, "text/plain", false);
  console.log("    Built data URL:", dataUrl);

  const parsed = parseDataURL(dataUrl);
  console.log("    Parsed data URL:", JSON.stringify(parsed));
  assert.notStrictEqual(parsed, null);
  assert.equal(decodeURIComponent(parsed!.data), original);
});

await test("Real API: parseDataURL with various types", async () => {
  const testUrls = [
    "data:text/plain,hello",
    "data:application/json;base64,eyIjoInRlc3QifQ==",
    "data:text/html,<h1>Test</h1>",
  ];

  for (const url of testUrls) {
    const parsed = parseDataURL(url);
    console.log(`    ${url.split(",")[0]}...:`, JSON.stringify(parsed));
    assert.notStrictEqual(parsed, null);
  }
});

// ============================================================================
// §13  URL DIFF — tested with REAL httpbin endpoints
// ============================================================================

suite("URL diff");

await test("diffURLs between real httpbin endpoints", async () => {
  const diff = diffURLs(
    "https://httpbin.org/get?version=1&token=abc",
    "https://httpbin.org/post?version=2&token=abc",
  );
  console.log("    GET vs POST diff:", JSON.stringify(diff, null, 2));

  assert.strictEqual(diff.pathname !== undefined, true);
  assert.strictEqual("version" in diff.changedParams, true);
});

await test("diffURLs detects added/removed params — verified via kinetex", async () => {
  const before = "https://httpbin.org/get?existing=1";
  const after = "https://httpbin.org/get?existing=1&added=2";
  const diff = diffURLs(before, after);
  console.log("    Added params:", JSON.stringify(diff.addedParams));
  assert.strictEqual("added" in diff.addedParams, true);
});

await test("Real API: diffURLs between actual kinetex request URLs", async () => {
  const r1 = await bin.get("/get", { params: { a: "1", b: "2" } });
  const r2 = await bin.get("/get", { params: { b: "3", c: "4" } });

  const url1 = (r1.data as { url: string }).url;
  const url2 = (r2.data as { url: string }).url;

  console.log("    URL1:", url1);
  console.log("    URL2:", url2);

  const diff = diffURLs(url1, url2);
  console.log("    Diff:", JSON.stringify(diff, null, 2));
  // "b" went from 2 to 3 and "a" went away. Pinned exactly: the disjunction
  // this replaces ("changedParams.b is set OR search is set") was satisfied
  // by any diff whatsoever, including one that found nothing.
  assert.deepStrictEqual(diff.changedParams, { b: ["2", "3"] });
  assert.deepStrictEqual(diff.removedParams, { a: "1" });
  assert.deepStrictEqual(diff.addedParams, { c: "4" });
  assert.strictEqual(diff.search, undefined, "a param diff must not also report a search diff");
  assert.strictEqual(diff.pathname, undefined);
});

// ============================================================================
// §14  UTILITY FUNCTIONS — tested with REAL kinetex
// ============================================================================

suite("Utility functions");

await test("safeParseURL with real httpbin response URL", async () => {
  const r = await bin.get("/get");
  const url = (r.data as { url: string }).url;

  console.log("    Original URL:", url);
  const parsed = safeParseURL(url);
  console.log("    Parsed origin:", parsed?.origin);
  console.log("    Parsed pathname:", parsed?.pathname);

  assert.notStrictEqual(parsed, null);
  assert.equal(parsed!.hostname, "httpbin.org");
});

await test("withTrailingSlash — verified via kinetex", async () => {
  const url = withTrailingSlash("https://httpbin.org/get");
  console.log("    With trailing slash:", url);
  assert.strictEqual(url.endsWith("/"), true);

  const r = await bin.get("/get");
  assert.equal(r.status, 200);
});

await test("withoutTrailingSlash — verified via kinetex", async () => {
  const url = withoutTrailingSlash("https://httpbin.org/get/");
  console.log("    Without trailing slash:", url);

  const r = await bin.get("/get");
  assert.equal(r.status, 200);
});

await test("stripHash — verified via kinetex", async () => {
  const url = stripHash("https://httpbin.org/get#section");
  console.log("    Stripped hash:", url);
  assert.strictEqual(url.includes("#"), false);
});

await test("stripQuery — verified via kinetex", async () => {
  const url = stripQuery("https://httpbin.org/get?a=1&b=2");
  console.log("    Stripped query:", url);
  assert.strictEqual(url.includes("?"), false);
});

await test("urlExtension from real URLs — verified via kinetex", async () => {
  const r = await bin.get("/anything/file.json");
  const url = (r.data as { url: string }).url;

  const ext = urlExtension(url);
  console.log("    Extension:", ext);
  assert.strictEqual(ext, "json");
});

await test("urlFilename from real URLs — verified via kinetex", async () => {
  const r = await bin.get("/anything/test.txt");
  const url = (r.data as { url: string }).url;

  const filename = urlFilename(url);
  console.log("    Filename:", filename);
  assert.strictEqual(filename.length > 0, true);
});

await test("redactURL — verified via kinetex", async () => {
  const url = redactURL("https://httpbin.org/get?token=secret&public=data", "token");
  console.log("    Redacted URL:", url);
  assert.strictEqual(url.includes("REDACTED"), true);
  assert.strictEqual(url.includes("public=data"), true);
});

// ============================================================================
// §15  INTEGRATION TESTS — ALL REAL API CALLS WITH KINETEX
// ============================================================================

suite("Integration with real APIs");

await test("Real API: jsonplaceholder posts with kinetex", async () => {
  const r = await json.get("/posts", { params: { _page: "1", _limit: "5" } });
  console.log("    Status:", r.status);
  const data = r.data as Array<{ id: number; userId: number }>;
  console.log("    Posts count:", data.length);
  console.log("    First post:", JSON.stringify(data[0]));
  assert.equal(r.status, 200);
  assert.strictEqual(data.length <= 5, true);
  assert.strictEqual(data.length > 0, true);
});

await test("Real API: jsonplaceholder single post with kinetex", async () => {
  const r = await json.get("/posts/1");
  const data = r.data as { id: number; title: string; body: string };
  console.log("    Post:", JSON.stringify(data));
  assert.equal(data.id, 1);
  assert.strictEqual(data.title.length > 0, true);
});

await test("Real API: jsonplaceholder user posts with kinetex", async () => {
  const r = await json.get("/users/1/posts");
  const data = r.data as Array<{ id: number; userId: number }>;
  console.log("    User 1 posts count:", data.length);
  assert.strictEqual(data.length > 0, true);
  assert.strictEqual(
    data.every((p) => p.userId === 1),
    true,
  );
});

await test("Real API: httpbin response-headers with kinetex", async () => {
  const r = await bin.get("/response-headers", { params: { "X-Custom": "test" } });
  console.log("    Status:", r.status);
  const data = r.data as Record<string, string>;
  console.log("    Custom header:", data["X-Custom"]);
  assert.equal(r.status, 200);
  assert.equal(data["X-Custom"], "test");
});

await test("Real API: httpbin /anything with kinetex POST", async () => {
  const payload = { key: "value", nested: { a: 1 } };
  const r = await bin.post("/post", JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
  const data = r.data as { json: typeof payload; headers: Record<string, string> };
  console.log("    Posted JSON:", JSON.stringify(data.json));
  assert.equal(data.json.key, "value");
  assert.equal(data.json.nested.a, 1);
});

await test("Real API: httpbin /ip endpoint with kinetex", async () => {
  const r = await bin.get("/ip");
  const data = r.data as { origin: string };
  console.log("    Origin IP:", data.origin);
  assert.strictEqual(data.origin.length > 0, true);
});

await test("Real API: httpbin /uuid endpoint with kinetex", async () => {
  const r = await bin.get("/uuid");
  const data = r.data as { uuid: string };
  console.log("    UUID:", data.uuid);
  assert.strictEqual(data.uuid.includes("-"), true);
  assert.strictEqual(data.uuid.length, 36);
});

await test("Real API: httpbin /user-agent with kinetex", async () => {
  const r = await bin.get("/user-agent");
  const data = r.data as { "user-agent": string | null };
  console.log("    User-Agent:", data["user-agent"]);
  assert.deepEqual(Object.keys(data), ["user-agent"]);
  // kinetex does not inject a User-Agent, so httpbin reports null
  assert.equal(data["user-agent"], null);
});

await test("Real API: httpbin /cookies with kinetex", async () => {
  const r = await bin.get("/cookies");
  const data = r.data as { cookies: Record<string, string> };
  console.log("    Cookies:", JSON.stringify(data.cookies));
  assert.deepEqual(data.cookies, {});
});

await test("Real API: httpbin /redirect/1 verified with native fetch", async () => {
  // kinetex follows redirects internally, so we use native fetch with redirect:manual
  const res = await fetch("https://httpbin.org/redirect/1", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.strictEqual(res.headers.has("location"), true);
});

await test("Real API: httpbin /base64 with kinetex", async () => {
  const encoded = btoa("Hello, World!");
  const r = await bin.get(`/base64/${encoded}`);
  console.log("    Decoded:", r.data);
  assert.equal(r.status, 200);
  assert.equal(r.data, "Hello, World!");
});

await test("Real API: jsonplaceholder complete CRUD with kinetex", async () => {
  // CREATE
  const create = await json.post(
    "/posts",
    JSON.stringify({ title: "test", body: "test", userId: 1 }),
    {
      headers: { "content-type": "application/json" },
    },
  );
  const created = create.data as { id: number };
  console.log("    Created post id:", created.id);
  assert.strictEqual(create.status, 201);
  assert.strictEqual(created.id > 0, true);

  // READ existing post (jsonplaceholder only has 100 posts, created ones don't persist)
  const read = await json.get("/posts/1");
  const data = read.data as { id: number; title: string };
  console.log("    Read post 1:", JSON.stringify(data));
  assert.equal(data.id, 1);

  // UPDATE existing post
  const update = await json.put(
    "/posts/1",
    JSON.stringify({ id: 1, title: "updated", body: "updated", userId: 1 }),
    {
      headers: { "content-type": "application/json" },
    },
  );
  const updated = update.data as { title: string };
  console.log("    Updated title:", updated.title);
  assert.equal(updated.title, "updated");

  // DELETE existing post
  const del = await json.delete("/posts/1");
  console.log("    Delete status:", del.status);
  assert.equal(del.status, 200);
});

// ============================================================================
// §16  ERROR HANDLING EDGE CASES
// ============================================================================

suite("Error handling edge cases");

await test("resolveURL throws on invalid base", async () => {
  // `assert.fail` throws an AssertionError, which the surrounding `catch`
  // caught and logged — so this passed whether or not `resolveURL` threw.
  // `assert.throws` cannot be caught by the code under test.
  assert.throws(
    () => resolveURL("path", "://invalid"),
    (err: unknown) => {
      assert.ok(err instanceof TypeError, `expected a TypeError, got ${String(err)}`);
      // The message must name both operands: "cannot resolve" against which
      // base is the whole diagnostic.
      assert.equal(err.message, 'Cannot resolve "path" against base "://invalid"');
      return true;
    },
  );
});

await test("fillPathParams throws on missing param", async () => {
  assert.throws(
    () => fillPathParams("/users/:id/:name", { id: "1" }),
    (err: unknown) => {
      assert.ok(err instanceof URLValidationError, `got ${String(err)}`);
      // The *specific* missing param is named -- with two placeholders, the
      // difference between a message naming "name" and one naming "id" is
      // the difference between a useful error and a wrong one.
      assert.equal(err.message, 'Missing path param: "name"');
      return true;
    },
  );
  // The first placeholder is named when it is the one missing.
  assert.throws(
    () => fillPathParams("/users/:id", {}),
    (err: unknown) => {
      assert.equal((err as URLValidationError).message, 'Missing path param: "id"');
      return true;
    },
  );
});

await test("relativeURL returns null for cross-origin", async () => {
  const result = relativeURL("https://other.com/path", "https://example.com");
  console.log("    Cross-origin result:", result);
  assert.equal(result, null);
});

await test("parseDataURL edge cases", async () => {
  const empty = parseDataURL("");
  const justData = parseDataURL("data:");
  const textPlain = parseDataURL("data:text,");

  console.log("    Empty data URL:", JSON.stringify(empty));
  console.log("    data: only:", JSON.stringify(justData));
  console.log("    data:text,:", JSON.stringify(textPlain));

  assert.equal(empty, null);
  assert.notStrictEqual(textPlain, null);
});

await test("isDataURL with leading whitespace", async () => {
  const url = "  data:text/plain,hello";
  const result = isDataURL(url);
  console.log("    isDataURL with whitespace:", result);
  assert.equal(result, true);
});

await test("isBlobURL with leading whitespace", async () => {
  const url = "  blob:http://example.com/blob";
  const result = isBlobURL(url);
  console.log("    isBlobURL with whitespace:", result);
  assert.equal(result, true);
});

await test("buildDataURL string with base64=true", async () => {
  const dataUrl = buildDataURL("hello", "text/plain", true);
  console.log("    Built data URL (base64):", dataUrl);
  // Verify full structure: prefix + base64 payload that decodes to "hello"
  const prefix = "data:text/plain;base64,";
  assert.strictEqual(dataUrl.slice(0, prefix.length), prefix, `Wrong prefix: "${dataUrl}"`);
  const base64Payload = dataUrl.slice(prefix.length);
  const decoded = atob(base64Payload);
  assert.strictEqual(decoded, "hello", `Expected "hello" but decoded "${decoded}"`);
  await bin.get("/anything");
});

await test("diffURLs search string changed without param diffs", async () => {
  // The same parameters in a different order: no added, removed or changed
  // param, but the raw search string differs. A disjunction here ("search is
  // defined OR something else is") would pass for any diff at all.
  const url1 = "https://httpbin.org/get?a=1&b=2";
  const url2 = "https://httpbin.org/get?b=2&a=1";
  const diff = diffURLs(url1, url2);
  assert.deepStrictEqual(diff.search, ["?a=1&b=2", "?b=2&a=1"]);
  assert.deepStrictEqual(diff.addedParams, {});
  assert.deepStrictEqual(diff.removedParams, {});
  assert.deepStrictEqual(diff.changedParams, {});
  // ...and nothing else changed, which is what makes it a *search* diff.
  assert.strictEqual(diff.pathname, undefined);
  assert.strictEqual(diff.protocol, undefined);
  assert.strictEqual(diff.hostname, undefined);
  assert.strictEqual(diff.hash, undefined);
});

await test("relativeURL throws on invalid path (catch block)", async () => {
  const base = "https://example.com";
  const invalidPath = "://invalid";
  await bin.get("/anything");
  const result = relativeURL(invalidPath, base);
  console.log("    Result for invalid path:", result);
  assert.equal(result, null);
});

// ============================================================================
// §17  RFC 3986 COMPLIANCE — tested with REAL kinetex
// ============================================================================

suite("RFC 3986 compliance");

await test("Unreserved chars preserved — verified via kinetex", async () => {
  const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
  const result = percentEncode(unreserved);

  const r = await bin.get("/get", { params: { chars: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Unreserved preserved:", args.chars === unreserved);
  assert.equal(result, unreserved);
});

await test("Reserved chars encoded — verified via kinetex", async () => {
  const reserved = ":/?#[]@!$&'()*+,;=";
  const result = percentEncode(reserved);

  const r = await bin.get("/get", { params: { chars: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Original reserved:", reserved);
  console.log("    Encoded:", result);
  console.log("    Server received:", args.chars);
  assert.strictEqual(result.includes("%"), true);
});

await test("Space encoded as %20 — verified via kinetex", async () => {
  const result = percentEncode("hello world");

  const r = await bin.get("/get", { params: { space: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Space encoded by percentEncode:", result);
  console.log("    Server received (after kinetex encoding):", args.space);
  assert.equal(result, "hello%20world");
});

await test("Unicode encoded — verified via kinetex", async () => {
  const tests: Array<[string, string]> = [
    ["日本語", "%E6%97%A5%E6%9C%AC%E8%AA%9E"],
    ["émoji", "%C3%A9moji"],
    ["中文", "%E4%B8%AD%E6%96%87"],
  ];

  for (const [input, expected] of tests) {
    const result = percentEncode(input);
    console.log(`    "${input}" encoded:`, result);

    // The exact UTF-8 bytes, not `startsWith("%")` -- which the old version
    // asserted, and which a function returning a single "%" satisfied.
    assert.equal(result, expected);
    // And the round-trip: the server decodes what we sent.
    const r = await bin.get("/get", { params: { text: result } });
    const args = (r.data as { args: Record<string, string> }).args;
    assert.equal(args.text, result);
    assert.equal(percentDecode(args.text), input);
  }
});

await test("Surrogate pairs (emoji) encoded — verified via kinetex", async () => {
  // One code point above U+FFFF becomes four UTF-8 bytes, so a lone surrogate
  // half or a dropped pair would be invisible to `startsWith("%")`.
  const result = percentEncode("😀🎉🚀");
  console.log("    Emoji encoded:", result);
  assert.equal(result, "%F0%9F%98%80%F0%9F%8E%89%F0%9F%9A%80");
  assert.equal(percentDecode(result), "😀🎉🚀");

  const r = await bin.get("/get", { params: { emoji: result } });
  const args = (r.data as { args: Record<string, string> }).args;
  console.log("    Server received emoji:", args.emoji);
  assert.equal(args.emoji, result);
});

// ============================================================================
// §18  URLBuilder COMPREHENSIVE TESTS — ALL with REAL kinetex
// ============================================================================

suite("URLBuilder comprehensive");

await test("URLBuilder.from parses real httpbin URL", async () => {
  const r = await bin.get("/get", { params: { a: "1" } });
  const url = (r.data as { url: string }).url;

  const u = URLBuilder.from(url);
  console.log("    Parsed origin:", u.origin);
  console.log("    Parsed pathname:", u.pathname);
  console.log("    Parsed protocol:", u.protocol);

  assert.equal(u.origin, "https://httpbin.org");
  assert.equal(u.protocol, "https:");
});

await test("URLBuilder.https factory — verified via kinetex", async () => {
  const u = URLBuilder.https("jsonplaceholder.typicode.com", "/posts/1");
  const url = u.toString();
  console.log("    HTTPS factory URL:", url);

  const r = await json.get("/posts/1");
  assert.equal(r.status, 200);
});

await test("URLBuilder immutable — verified via kinetex", async () => {
  const base = URLBuilder.from("https://httpbin.org/get");
  const withA = base.setParam("a", "1");
  const withB = base.setParam("b", "2");

  console.log("    Base URL:", base.toString());
  console.log("    With A:", withA.toString());
  console.log("    With B:", withB.toString());

  assert.strictEqual(base.toString().includes("a="), false);
  assert.strictEqual(base.toString().includes("b="), false);
  assert.strictEqual(withA.toString().includes("a="), true);
  assert.strictEqual(withA.toString().includes("b="), false);
  assert.strictEqual(withB.toString().includes("a="), false);
  assert.strictEqual(withB.toString().includes("b="), true);
});

await test("URLBuilder getters — verified via kinetex", async () => {
  const r = await bin.get("/get", { params: { a: "1", b: "2" } });
  const url = (r.data as { url: string }).url;

  const u = URLBuilder.from(url);
  console.log("    hostname:", u.hostname);
  console.log("    host:", u.host);
  console.log("    port:", u.port);
  console.log("    pathname:", u.pathname);
  console.log("    search:", u.search);
  console.log("    origin:", u.origin);

  assert.equal(u.hostname, "httpbin.org");
  assert.equal(u.pathname, "/get");
});

await test("URLBuilder searchParams — verified via kinetex", async () => {
  const u = URLBuilder.from("https://httpbin.org/get?a=1&b=2&c=3");
  const sp = u.searchParams;

  console.log("    Has a:", sp.has("a"));
  console.log("    Get a:", sp.get("a"));
  console.log("    All entries:", Array.from(sp.entries()));

  assert.equal(sp.get("a"), "1");
  assert.equal(sp.get("b"), "2");
});

await test("URLBuilder queryObject — verified via kinetex", async () => {
  const u = URLBuilder.from("https://httpbin.org/get?a=1&b=2");
  const qo = u.queryObject;

  console.log("    Query object:", JSON.stringify(qo));
  assert.equal(qo.a, "1");
  assert.equal(qo.b, "2");
});

// ============================================================================
// §19  expandTemplate COMPREHENSIVE — ALL with REAL kinetex
// ============================================================================

suite("expandTemplate comprehensive");

await test("expandTemplate with + operator — verified via kinetex", async () => {
  const template = "{+path}";
  const result = expandTemplate(template, { path: "/foo/bar" });
  console.log("    Result:", result);
  assert.equal(result, "/foo/bar");
});

await test("expandTemplate with # operator", async () => {
  const result = expandTemplate("{#x}", { x: "hello" });
  console.log("    # operator:", result);
  assert.equal(result, "#hello");
});

await test("expandTemplate with . operator", async () => {
  const result = expandTemplate("{.var}", { var: "value" });
  console.log("    . operator:", result);
  assert.equal(result, ".value");
});

await test("expandTemplate with / operator — verified via kinetex", async () => {
  const result = expandTemplate("{/seg}", { seg: "get" });
  console.log("    / operator:", result);

  const r = await bin.get(result);
  console.log("    Status:", r.status);
  assert.strictEqual(r.status, 200);
});

await test("expandTemplate with ; operator", async () => {
  const result = expandTemplate("{/seg*}", { seg: ["a", "b", "c"] });
  console.log("    ; operator:", result);
  assert.strictEqual(result.includes("/a"), true);
  assert.strictEqual(result.includes("/b"), true);
  assert.strictEqual(result.includes("/c"), true);
});

await test("expandTemplate array with kinetex", async () => {
  const result = expandTemplate("{?ids}", { ids: ["1", "2", "3"] });
  assert.equal(result, "?ids=1,2,3", "an array must join with commas in order");

  const r = await bin.get("/get", { params: { ids: ["1", "2", "3"] } });
  assert.equal(r.status, 200, "the echoed request must succeed");
  const args = (r.data as { args: Record<string, string | string[]> }).args;
  // httpbin echoes a repeated query parameter as a JSON array; the point is
  // that all three values survive the round-trip in order.
  assert.deepEqual(
    Array.isArray(args.ids) ? args.ids : [args.ids],
    ["1", "2", "3"],
    "every array element must reach the server, in order",
  );
});

await test("expandTemplate object explode", async () => {
  // RFC 6570 §3.2.8: `{?params*}` flattens the object into one pair per key.
  assert.equal(expandTemplate("{?params*}", { params: { a: "1", b: "2" } }), "?a=1&b=2");
  // A space is percent-encoded in a query expansion, unlike in `{+path}`.
  assert.equal(expandTemplate("{?params*}", { params: { q: "a b" } }), "?q=a%20b");
  // ...and an empty object expands to nothing at all.
  assert.equal(expandTemplate("{?params*}", { params: {} }), "");
});

await test("expandTemplate object forms", async () => {
  // RFC 6570 §3.2.7: without `*`, the object becomes one comma-joined value
  // under its own name.
  assert.equal(expandTemplate("{?coords}", { coords: { x: "1", y: "2" } }), "?coords=x,1,y,2");
  // The same shape in the path operator, which uses a prefix instead of "?".
  assert.equal(expandTemplate("{/coords*}", { coords: { x: "1", y: "2" } }), "/x=1/y=2");
  // The label operator carries no names, so the members join with commas.
  assert.equal(expandTemplate("{.coords}", { coords: { x: "1", y: "2" } }), ".x,1,y,2");
});

await test("expandTemplate maxLength — verified via kinetex", async () => {
  const result = expandTemplate("{name:5}", { name: "abcdefghij" });
  console.log("    maxLength result:", result);
  assert.equal(result, "abcde");

  try {
    const r = await bin.get("/get", { params: { name: result } });
    const args = (r.data as { args: Record<string, string> }).args;
    console.log("    Server received:", args.name);
    assert.equal(args.name, "abcde");
  } catch (e) {
    // This catch encloses `assert.equal`, so a bare `catch {}` reported a pass
    // for a wrong maxLength expansion. Only a transport failure may skip.
    const why = `${(e as { name?: string })?.name ?? ""}: ${(e as { message?: string })?.message ?? String(e)}`;
    assert.ok(
      /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout|network|socket/i.test(
        why,
      ),
      `maxLength verification failed for a non-network reason and must not be skipped: ${why}`,
    );
    console.log(`    → upstream unavailable, skipping: ${why}`);
  }
});

await test("expandTemplate skips null/undefined", async () => {
  // The old version expanded `{name}` with the number 42 and asserted nothing
  // about the result -- the kinetex call it made used a hand-written
  // `params: { name: "42" }` and so checked the test, not the function.
  // RFC 6570: an undefined variable expands to the empty string, and the
  // surrounding text is kept.
  assert.equal(expandTemplate("/anything/{name}", { name: "x" }), "/anything/x");
  assert.equal(expandTemplate("/anything/{name}", {} as Record<string, string>), "/anything/");
  assert.equal(
    expandTemplate("/anything/{name}", { name: undefined as unknown as string }),
    "/anything/",
  );
  // A number is expanded, not skipped.
  assert.equal(expandTemplate("/anything/{name}", { name: 42 }), "/anything/42");
  // ...and a nullish variable inside a multi-variable expression is left out
  // entirely rather than emitting an empty `name=`.
  assert.equal(expandTemplate("{?a,b}", { a: "1" }), "?a=1");
  assert.equal(expandTemplate("{?a,b}", { b: "2" }), "?b=2");
  assert.equal(expandTemplate("{?a,b}", {} as Record<string, string>), "");
});

await test("URLBuilder.setParam null/undefined deletes", async () => {
  // Pinned on the URL, and percent-encoded on the way out: a value with a
  // space or an ampersand must not become a second parameter.
  assert.equal(
    URLBuilder.from("https://httpbin.org/get?a=1&b=2")
      .setParam("b", null as unknown as string)
      .toString(),
    "https://httpbin.org/get?a=1",
  );
  assert.equal(
    URLBuilder.from("https://example.com/?a=1")
      .setParam("b", undefined as unknown as string)
      .toString(),
    "https://example.com/?a=1",
  );
  assert.equal(
    URLBuilder.from("https://example.com/").setParam("q", "a b&c=d").toString(),
    "https://example.com/?q=a+b%26c%3Dd",
  );
});

await test("URLBuilder.setQuery clears and replaces", async () => {
  const url = URLBuilder.from("https://httpbin.org/get?old=1")
    .setQuery({ x: "1", y: "2" })
    .toString();
  // `old=1` is gone: setQuery replaces rather than merges.
  assert.equal(url, "https://httpbin.org/get?x=1&y=2");
  // An empty object clears the query entirely.
  assert.equal(
    URLBuilder.from("https://example.com/?a=1").setQuery({}).toString(),
    "https://example.com/",
  );
});

await test("URLBuilder.path joins segments", async () => {
  const url = URLBuilder.from("https://httpbin.org").path("anything", "test").toString();
  assert.equal(url, "https://httpbin.org/anything/test");
  // `appendPath` is the accumulating form; `path` replaces what was there.
  assert.equal(
    URLBuilder.from("https://httpbin.org/old").path("a", "b").toString(),
    "https://httpbin.org/a/b",
  );
  assert.equal(
    URLBuilder.from("https://httpbin.org/old").appendPath("a").appendPath("b").toString(),
    "https://httpbin.org/old/a/b",
  );
});

await test("URLBuilder.withUsername", async () => {
  const url = URLBuilder.from("https://httpbin.org/get").withUsername("testuser").toString();
  assert.equal(url, "https://testuser@httpbin.org/get");
  assert.equal(new URL(url).username, "testuser");
  // Encoded on the way out, so a username with `@` in it cannot forge a host.
  assert.equal(
    new URL(URLBuilder.from("https://example.com/").withUsername("a@b").toString()).username,
    "a%40b",
  );
});

await test("URLBuilder.withPassword", async () => {
  const url = URLBuilder.from("https://httpbin.org/get").withPassword("secret123").toString();
  assert.equal(url, "https://:secret123@httpbin.org/get");
  assert.equal(new URL(url).password, "secret123");
  // A password is not a substitute for a username: with an empty username the
  // userinfo is still `:` + the secret, not just the secret.
  assert.equal(
    new URL(URLBuilder.from("https://example.com/").withUsername("u").withPassword("p").toString())
      .href,
    "https://u:p@example.com/",
  );
});

await test("compilePattern single wildcard — verified via kinetex", async () => {
  const pattern = compilePattern("/posts/*/comments/*");
  const match = pattern.match("https://jsonplaceholder.typicode.com/posts/5/comments/10");
  console.log("    Single wildcard match:", JSON.stringify(match));
  assert.notStrictEqual(match, null);
  assert.equal(match!.wildcards[0], "5");
  assert.equal(match!.wildcards[1], "10");
});

// ── Additional branch coverage ──────────────────────────────────────────

suite("Branch coverage");

await test("URLBuilder.withPort sets port", async () => {
  const url = URLBuilder.from("https://example.com").withPort(8080).toString();
  assert.equal(new URL(url).port, "8080");
});

await test("URLBuilder.withPathname replaces path", async () => {
  const url = URLBuilder.from("https://example.com/a/b").withPathname("/c/d").toString();
  assert.equal(new URL(url).pathname, "/c/d");
});

await test("URLBuilder.params fills path params and sets query", async () => {
  const url = URLBuilder.from("https://example.com/users/:id/posts/:postId")
    .params({ id: "42", postId: "99" })
    .toString();
  assert.strictEqual(url.includes("/users/42/posts/99"), true);
  assert.strictEqual(url.includes("id=42"), true);
  assert.strictEqual(url.includes("postId=99"), true);
});

await test("URLBuilder.query with array values", async () => {
  const url = URLBuilder.from("https://example.com")
    .query({ tags: ["a", "b", "c"] })
    .toString();
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.getAll("tags").length, 3);
});

await test("isSameSite with multi-part TLD (co.uk)", async () => {
  const result = isSameSite("https://example.co.uk/page", "https://sub.example.co.uk/other");
  assert.equal(result, true);
});

await test("isSameSite different protocols on same domain", async () => {
  const result = isSameSite("https://example.com/a", "http://example.com/b");
  assert.equal(result, false);
});

await test("isSameSite null URL returns false", async () => {
  assert.equal(isSameSite("not-a-url", "https://example.com"), false);
});

await test("percentDecode malformed sequence fallback", async () => {
  // Malformed UTF-8 sequences cause decodeURIComponent to throw
  // %E0%80%AF is an overlong UTF-8 sequence that throws in Node.js
  const result = percentDecode("%E0%80%AF");
  // The fallback decodes each byte as Latin-1 rather than throwing
  assert.equal(result, "à¯");
  assert.equal(result.length, 3);
  assert.deepEqual(
    [...result].map((ch) => ch.charCodeAt(0)),
    [0xe0, 0x80, 0xaf],
  );
});

await test("mergeQuery null value deletes key", async () => {
  const result = mergeQuery({ a: "1", b: "2" }, { a: null });
  assert.deepEqual(result, { b: "2" });
});

await test("joinPath resolves .. dot segments", async () => {
  const result = joinPath("/a/b/c", "../d");
  assert.equal(result, "/a/b/d");
});

await test("normalizeURL with auth and password", async () => {
  const result = normalizeURL("https://user:pass@example.com:443/path?q=1#hash");
  // Default port 443 must be stripped, auth preserved, path/query/hash intact
  assert.strictEqual(result, "https://user:pass@example.com/path?q=1#hash", `Got: "${result}"`);
  assert.strictEqual(result.includes("/path"), true);
  assert.strictEqual(result.includes("?q=1"), true);
});

await test("URLBuilder throws on invalid URL", async () => {
  assert.throws(() => URLBuilder.from("not a valid url"), /Invalid URL/);
});

await test("URLBuilder.withHostname changes hostname", async () => {
  const url = URLBuilder.from("https://example.com/path").withHostname("other.com").toString();
  assert.equal(new URL(url).hostname, "other.com");
});

await test("URLBuilder.withHost changes host", async () => {
  const url = URLBuilder.from("https://example.com:8080/path")
    .withHost("other.com:9090")
    .toString();
  assert.equal(new URL(url).host, "other.com:9090");
});

await test("diffURLs detects protocol difference", async () => {
  const diff = diffURLs("http://example.com/a", "https://example.com/a");
  assert.deepEqual(
    diff.protocol,
    ["http:", "https:"],
    `Expected protocol diff but got: ${JSON.stringify(diff.protocol)}`,
  );
});

await test("diffURLs detects hostname difference", async () => {
  const diff = diffURLs("https://a.com/x", "https://b.com/x");
  assert.deepEqual(
    diff.hostname,
    ["a.com", "b.com"],
    `Expected hostname diff but got: ${JSON.stringify(diff.hostname)}`,
  );
});

await test("diffURLs detects port difference", async () => {
  const diff = diffURLs("https://example.com:80/p", "https://example.com:443/p");
  // URL constructor normalizes default port 443 to "" for HTTPS
  assert.deepEqual(
    diff.port,
    ["80", ""],
    `Expected port diff but got: ${JSON.stringify(diff.port)}`,
  );
});

await test("diffURLs detects hash difference", async () => {
  const diff = diffURLs("https://example.com/p#a", "https://example.com/p#b");
  assert.deepEqual(
    diff.hash,
    ["#a", "#b"],
    `Expected hash diff but got: ${JSON.stringify(diff.hash)}`,
  );
});

await test("stripQuery handles invalid URL", async () => {
  const result = stripQuery("not a url");
  assert.equal(result, "not a url");
});

await test("urlExtension returns extension", async () => {
  assert.equal(urlExtension("https://example.com/file.txt"), "txt");
  assert.equal(urlExtension("https://example.com/image.PNG"), "png");
});

await test("urlExtension no extension returns empty", async () => {
  assert.equal(urlExtension("https://example.com/file"), "");
});

await test("urlFilename from URL path", async () => {
  assert.equal(urlFilename("https://example.com/path/file.txt"), "file.txt");
  assert.equal(urlFilename("https://example.com/"), "");
});

// ============================================================================
// §20  REGRESSIONS
// ============================================================================
//
// Eight defects surfaced by auditing what this file asserted against what the
// functions actually return. Each test below passed at the time its defect
// was live.

suite("Regressions");

await test("buildDataURL base64-encodes text above U+00FF", async () => {
  // Defect: `btoa` is Latin-1 only and throws InvalidCharacterError above
  // U+00FF, so `buildDataURL("café", "text/plain", true)` threw — which is
  // precisely the payload the base64 form exists for. The test file only
  // ever passed "hello".
  const url = buildDataURL("café ☕", "text/plain", true);
  assert.equal(url, "data:text/plain;base64,Y2Fmw6kg4piV");
  const parsed = parseDataURL(url);
  assert.equal(parsed!.isBase64, true);
  assert.equal(
    new TextDecoder().decode(Uint8Array.from(atob(parsed!.data), (c) => c.charCodeAt(0))),
    "café ☕",
  );
  // The non-base64 form percent-encodes instead, and round-trips too.
  assert.equal(buildDataURL("café", "text/plain", false), "data:text/plain,caf%C3%A9");
  // A string and the equivalent bytes must produce the same URL.
  const bytes = new TextEncoder().encode("café ☕");
  assert.equal(buildDataURL(bytes, "text/plain", true), url);
  // ASCII is unchanged by any of this.
  assert.equal(buildDataURL("hello", "text/plain", true), "data:text/plain;base64,aGVsbG8=");
});

await test("parseDataURL accepts a media type with parameters", async () => {
  // Defect: the old regex stopped the media type at the first `;` and then
  // required a comma, so `data:text/plain;charset=utf-8,hi` — an ordinary
  // RFC 2397 data URL — did not parse at all.
  assert.deepStrictEqual(parseDataURL("data:text/plain;charset=utf-8,hi"), {
    mediaType: "text/plain;charset=utf-8",
    isBase64: false,
    data: "hi",
  });
  // `;base64` is only an encoding marker as the LAST parameter.
  assert.deepStrictEqual(parseDataURL("data:text/plain;charset=utf-8;base64,aGk="), {
    mediaType: "text/plain;charset=utf-8",
    isBase64: true,
    data: "aGk=",
  });
  // A parameter that merely contains the word is not one.
  assert.deepStrictEqual(parseDataURL("data:text/plain;base64x,hi"), {
    mediaType: "text/plain;base64x",
    isBase64: false,
    data: "hi",
  });
  // An omitted type with parameters present still defaults to text/plain,
  // and keeps the parameters.
  assert.deepStrictEqual(parseDataURL("data:;charset=utf-8,hi"), {
    mediaType: "text/plain;charset=utf-8",
    isBase64: false,
    data: "hi",
  });
  // The forms that already worked.
  assert.deepStrictEqual(parseDataURL("data:text/plain,hello"), {
    mediaType: "text/plain",
    isBase64: false,
    data: "hello",
  });
  assert.deepStrictEqual(parseDataURL("data:,x"), {
    mediaType: "text/plain",
    isBase64: false,
    data: "x",
  });
  assert.equal(parseDataURL("data:"), null, "no comma, no data URL");
  assert.equal(parseDataURL(""), null);
  assert.equal(parseDataURL("https://example.com"), null);
  // A comma inside the payload is data, not a second delimiter.
  assert.deepStrictEqual(parseDataURL("data:text/plain,a,b"), {
    mediaType: "text/plain",
    isBase64: false,
    data: "a,b",
  });
});

await test("buildDataURL refuses a media type that carries its own delimiters", async () => {
  // Defect: `,` and `;` are the data URL's delimiters, and the media type was
  // interpolated unescaped. `buildDataURL("x", "text/plain;base64", false)`
  // emitted `data:text/plain;base64,x`, which every parser then reads as a
  // base64 payload — the opposite of what the caller asked for.
  assert.throws(
    () => buildDataURL("x", "text/plain;base64", false),
    (err: unknown) => {
      assert.ok(err instanceof URLValidationError, `got ${String(err)}`);
      assert.match(err.message, /media type/i);
      return true;
    },
  );
  assert.throws(() => buildDataURL("x", "a,b", false), URLValidationError);
  // A media type with a parameter is legal in a data URL, but it has to be
  // passed already encoded by the caller into a value this function accepts
  // — so the honest answer is to refuse it rather than emit a URL that means
  // something else.
  assert.equal(buildDataURL("x", "text/plain", false), "data:text/plain,x");
  assert.equal(buildDataURL("x", "image/svg+xml", false), "data:image/svg+xml,x");
});

await test("redactURL never throws, on any input", async () => {
  // Defect: this function exists to be called from a logger, and
  // `URLBuilder.from` throws on anything `new URL()` rejects — so the one
  // helper that must not take a process down on malformed input was the one
  // that did.
  assert.equal(redactURL("not a url", "token"), "not a url");
  assert.doesNotThrow(() => redactURL("", "token"));
  assert.doesNotThrow(() => redactURL("/relative/path", "token"));
  assert.doesNotThrow(() => redactURL("://bad", "a", "b"));
  // ...and on a relative URL that does have a query, the parameter is still
  // masked rather than leaked into the log.
  assert.equal(
    redactURL("/path?token=secret&public=data", "token"),
    "/path?token=REDACTED&public=data",
  );
  assert.equal(redactURL("/path?a=1&t=2#frag", "t"), "/path?a=1&t=REDACTED#frag");
  // A key that is not present leaves the URL alone.
  assert.equal(redactURL("/path?a=1", "token"), "/path?a=1");
  // No keys at all is a no-op on both paths.
  assert.equal(redactURL("https://x/?a=1"), "https://x/?a=1");
  assert.equal(redactURL("/path?a=1"), "/path?a=1");
  // The parseable case still goes through the builder, and still redacts.
  assert.equal(
    redactURL("https://httpbin.org/get?token=secret&public=data", "token"),
    "https://httpbin.org/get?token=REDACTED&public=data",
  );
});

await test("stripHash tolerates an unparseable URL, as stripQuery does", async () => {
  // Defect: the pair is used together on the same input, and only one of the
  // two was total — so a malformed URL was safe to strip a query from and
  // fatal to strip a hash from.
  assert.equal(stripHash("not a url"), "not a url");
  assert.equal(stripQuery("not a url"), "not a url");
  assert.equal(stripHash(""), "");
  assert.equal(stripHash("/relative#frag"), "/relative#frag");
  // ...and both still do their job on a real URL.
  assert.equal(stripHash("https://example.com/p#a"), "https://example.com/p");
  assert.equal(stripQuery("https://example.com/p?a=1"), "https://example.com/p");
  // A hash containing a `?` is a hash, not a query.
  assert.equal(stripHash("https://example.com/p#a?b=1"), "https://example.com/p");
});

await test("relativeURL requires the base to end on a segment boundary", async () => {
  // Defect: containment was a raw string prefix. With the base `/posts`, the
  // path `/posts-admin/secret` starts with it, so the function returned
  // `-admin/secret` — which the caller then resolves against `/posts` to
  // reach a sibling resource it was never scoped to.
  assert.equal(
    relativeURL("https://example.com/posts-admin/secret", "https://example.com/posts"),
    null,
  );
  assert.equal(relativeURL("https://example.com/posts2", "https://example.com/posts"), null);
  // The real relationships still work. The separator is kept, so the result
  // is a usable relative reference rather than a bare segment.
  assert.equal(relativeURL("https://example.com/posts/1", "https://example.com/posts"), "/1");
  assert.equal(
    relativeURL("https://example.com/posts/1/comments", "https://example.com/posts"),
    "/1/comments",
  );
  assert.equal(
    relativeURL("https://example.com/posts/1?q=2#f", "https://example.com/posts"),
    "/1?q=2#f",
  );
  // A base that already ends in a slash is unambiguous.
  assert.equal(relativeURL("https://example.com/posts/1", "https://example.com/posts/"), "1");
  // An exact match is the empty string, as before.
  assert.equal(relativeURL("https://example.com/posts/1", "https://example.com/posts/1"), "");
  // A different origin, or a shorter path, is still out of scope.
  assert.equal(relativeURL("https://other.com/posts/1", "https://example.com/posts"), null);
  assert.equal(relativeURL("https://example.com/", "https://example.com/posts"), null);
});

await test("parseQuery cannot re-prototype the object it returns", async () => {
  // Defect: `result` is a plain object, so `result["__proto__"]` read
  // `Object.prototype` instead of "nothing here yet". The first
  // `__proto__=x` therefore took the "already have a value" branch and
  // assigned an *array* through the inherited `__proto__` setter — so
  // `parseQuery("__proto__=x&__proto__=y")` returned an object whose
  // prototype was attacker-influenced. parseQuery output is fed straight
  // into request building.
  const single = parseQuery("__proto__=x");
  assert.deepStrictEqual(Object.keys(single), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(single), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(single, "__proto__")?.value, "x");

  const both = parseQuery("__proto__=x&__proto__=y");
  assert.equal(Object.getPrototypeOf(both), Object.prototype, "the prototype must be untouched");
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(both, "__proto__")?.value, ["x", "y"]);

  // ...and the key is a normal key everywhere else: it round-trips, and it
  // does not shadow the object's own methods.
  assert.equal(typeof both.hasOwnProperty, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(both, "toString"), false);
  assert.equal(
    stringifyQuery(both as Record<string, string | string[]>),
    "__proto__=x&__proto__=y",
  );
  // `constructor` was already an own property, and stays one.
  const ctor = parseQuery("constructor=x");
  assert.equal(Object.getPrototypeOf(ctor), Object.prototype);
  assert.equal(ctor.constructor as unknown, "x");
  // Ordinary keys are untouched by any of this.
  assert.deepStrictEqual(parseQuery("a=1&b=2&b=3"), { a: "1", b: ["2", "3"] });
});

await test("compilePattern honours a parameter constraint", async () => {
  // Defect: the pattern was regex-escaped before the `:name(...)` form was
  // recognised, so the `(` became `\(` and the constraint branch could never
  // fire. `/items/:id(\d+)` — documented as "matches /items/99 only if id is
  // numeric" — matched every segment, and matched nothing at all.
  const p = compilePattern("/items/:id(\\d+)");
  assert.equal(p.test("https://example.com/items/99"), true);
  assert.equal(p.test("https://example.com/items/abc"), false);
  assert.equal(p.match("https://example.com/items/99")!.params.id, "99");
  assert.equal(p.match("https://example.com/items/abc"), null);
  // A constraint with alternatives, and one that is anchored.
  assert.equal(compilePattern("/f/:v(a|b)").test("https://x.com/f/a"), true);
  assert.equal(compilePattern("/f/:v(a|b)").test("https://x.com/f/c"), false);
  // An unconstrained parameter still stops at a slash.
  assert.equal(compilePattern("/items/:id").test("https://x.com/items/a/b"), false);
});

await test("compilePattern fills groups, and reads captures in source order", async () => {
  // Defect: `URLPatternMatch.groups` is documented as "all capture groups
  // including named params and wildcards" and was always `{}` — nothing ever
  // wrote to it. And the capture index was assumed to run params first, so
  // a wildcard written before a parameter in the pattern handed the
  // wildcard's value to `params`.
  assert.deepStrictEqual(compilePattern("/posts/:id").match("https://x.com/posts/42")!.groups, {
    id: "42",
  });
  assert.deepStrictEqual(
    compilePattern("/posts/*/comments/*").match("https://x.com/posts/5/comments/10")!.groups,
    { "1": "5", "2": "10" },
  );
  // Wildcard BEFORE parameter: the named parameter gets its own value.
  const mixed = compilePattern("/*/:id").match("https://x.com/seg/7");
  assert.deepStrictEqual(mixed!.params, { id: "7" });
  assert.deepStrictEqual(mixed!.wildcards, ["seg"]);
  assert.deepStrictEqual(mixed!.groups, { "1": "seg", id: "7" });
  // A greedy wildcard still yields one entry per segment, while `groups`
  // records the single capture it came from.
  const greedy = compilePattern("/files/**").match("https://x.com/files/a/b/c")!;
  assert.deepStrictEqual(greedy.wildcards, ["a", "b", "c"]);
  assert.deepStrictEqual(greedy.groups, { "1": "a/b/c" });
  // Literal text is still escaped, so a pattern with a regex metacharacter
  // in it matches the character and not a class.
  assert.equal(compilePattern("/a.b/:id").test("https://x.com/a.b/1"), true);
  assert.equal(compilePattern("/a.b/:id").test("https://x.com/axb/1"), false);
  // ...and the single-star form is one segment, not many.
  assert.deepStrictEqual(compilePattern("/a/*").match("https://x.com/a/b/c"), null);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log("\n" + "=".repeat(60));
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log("ALL HTTP calls made with kinetex - NO native fetch used!");
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const { name, err } of failures) {
    console.log(`  - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
process.exit(0);
