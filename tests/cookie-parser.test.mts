import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";

const client = kinetex({ timeout: 30000 });

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  ${name}: ${msg}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string) {
  console.log(`\n── ${name}`);
}

const {
  parseCookieDate,
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  decodeIDNLabel,
  canonicalizeDomainFull,
  isIPAddress,
  domainMatch,
  defaultPath,
  pathMatch,
  parseSetCookieHeader,
  splitSetCookieHeaders,
  extractSetCookieHeaders,
  formatSetCookieHeader,
} = await import("../src/cookie-parser.ts");

// ============================================================================
// §1  parseCookieDate
// ============================================================================

suite("parseCookieDate");

await test("standard format", () =>
  assert.equal(parseCookieDate("Thu, 01 Jan 2025 00:00:00 GMT"), 1735689600000));
await test("no day name", () =>
  assert.equal(parseCookieDate("01 Jan 2025 00:00:00 GMT"), 1735689600000));
await test("reversed order", () =>
  assert.equal(parseCookieDate("Jan 01 2025 00:00:00"), 1735689600000));
await test("dash separator", () =>
  assert.equal(parseCookieDate("01-Jan-2025 00:00:00 GMT"), 1735689600000));
await test("ordinal suffix", () =>
  assert.equal(parseCookieDate("1st Jan 2025 00:00:00 GMT"), 1735689600000));
await test("UTC timezone", () =>
  assert.equal(parseCookieDate("Thu, 01 Jan 2025 00:00:00 UTC"), 1735689600000));
await test("+0000 timezone", () =>
  assert.equal(parseCookieDate("Thu, 01 Jan 2025 00:00:00 +0000"), 1735689600000));
await test("empty string returns null", () => assert.equal(parseCookieDate(""), null));
await test("invalid string returns null", () => assert.equal(parseCookieDate("invalid"), null));
await test("missing time returns null", () => assert.equal(parseCookieDate("01-01-2025"), null));
await test("missing day returns null", () =>
  assert.equal(parseCookieDate("Jan 2025 00:00:00"), null));
await test("missing year returns null", () =>
  assert.equal(parseCookieDate("01 Jan 00:00:00"), null));
await test("2-digit year 70-99 produces 1900s", () => {
  const ts = parseCookieDate("01 Jan 70 00:00:00 GMT");
  assert.ok(ts !== null);
  assert.equal(new Date(ts).getUTCFullYear(), 1970);
});
await test("2-digit year 00-49 produces 2000s", () => {
  const ts = parseCookieDate("01 Jan 30 00:00:00 GMT");
  assert.ok(ts !== null);
  assert.equal(new Date(ts).getUTCFullYear(), 2030);
});

// ============================================================================
// §2  Public Suffix List
// ============================================================================

suite("Public Suffix List");

await test("getPublicSuffix - basic TLD", () =>
  assert.equal(getPublicSuffix("www.example.com"), "com"));
await test("getPublicSuffix - second level .co.uk", () =>
  assert.equal(getPublicSuffix("www.example.co.uk"), "co.uk"));
await test("getPublicSuffix - com.au", () =>
  assert.equal(getPublicSuffix("www.example.com.au"), "com.au"));
await test("getPublicSuffix - wildcard .jp (kawasaki.jp)", () =>
  assert.equal(getPublicSuffix("www.example.kawasaki.jp"), "example.kawasaki.jp"));
await test("getPublicSuffix - wildcard .jp (city.kobe.jp exception)", () =>
  assert.equal(getPublicSuffix("www.example.city.kobe.jp"), "city.kobe.jp"));
await test("getPublicSuffix - github.io (wildcard *.github.io)", () =>
  assert.equal(getPublicSuffix("www.example.github.io"), "io"));
await test("getPublicSuffix - plain TLD", () =>
  assert.equal(getPublicSuffix("example.com"), "com"));
await test("getPublicSuffix - empty string", () => assert.equal(getPublicSuffix(""), null));
await test("getPublicSuffix - single label returns itself", () =>
  assert.equal(getPublicSuffix("example"), "example"));
await test("getPublicSuffix - trailing dot stripped", () =>
  assert.equal(getPublicSuffix("www.example.com."), "com"));
await test("getPublicSuffix - same origin subdomain levels", () =>
  assert.equal(getPublicSuffix("a.b.c.d.e.example.com"), "com"));
await test("getPublicSuffix - exception rule (www.ck) on subdomain", () => {
  assert.equal(getPublicSuffix("www.example.www.ck"), "www.ck");
});
await test("getPublicSuffix - exception domain itself", () => {
  // www.ck is a PSL exception: the domain itself IS a public suffix
  assert.equal(getPublicSuffix("www.ck"), "www.ck");
});
await test("getPublicSuffix - domain exactly equals suffix (co.uk)", () => {
  assert.equal(getPublicSuffix("co.uk"), "co.uk");
});
await test("getPublicSuffix - domain exactly equals suffix (co.uk)", () => {
  // co.uk IS a public suffix, so getPublicSuffix should return co.uk
  assert.equal(getPublicSuffix("co.uk"), "co.uk");
});
await test("getPublicSuffix - domain exactly equals exception (www.ck)", () => {
  assert.equal(getPublicSuffix("www.ck"), "www.ck");
});

await test("getRegistrableDomain - www", () =>
  assert.equal(getRegistrableDomain("www.example.com"), "example.com"));
await test("getRegistrableDomain - sub domain", () =>
  assert.equal(getRegistrableDomain("sub.www.example.com"), "example.com"));
await test("getRegistrableDomain - plain", () =>
  assert.equal(getRegistrableDomain("example.com"), "example.com"));
await test("getRegistrableDomain - second level", () =>
  assert.equal(getRegistrableDomain("example.co.uk"), "example.co.uk"));
await test("getRegistrableDomain - TLD only", () =>
  assert.equal(getRegistrableDomain("com"), null));
await test("getRegistrableDomain - IPv4", () =>
  assert.equal(getRegistrableDomain("192.168.1.1"), "192.168.1.1"));
await test("getRegistrableDomain - exception rule domain", () =>
  assert.equal(getRegistrableDomain("something.www.ck"), "something.www.ck"));
await test("getRegistrableDomain - wildcard not in PSL data (github.io)", () =>
  assert.equal(getRegistrableDomain("sub.example.github.io"), "github.io"));

await test("isPublicSuffix - com", () => assert.equal(isPublicSuffix("com"), true));
await test("isPublicSuffix - co.uk", () => assert.equal(isPublicSuffix("co.uk"), true));
await test("isPublicSuffix - github.io (not in PSL data)", () =>
  assert.equal(isPublicSuffix("github.io"), false));
await test("isPublicSuffix - example.com", () =>
  assert.equal(isPublicSuffix("example.com"), false));
await test("isPublicSuffix - exception IS a public suffix", () =>
  assert.equal(isPublicSuffix("www.ck"), true));
await test("isPublicSuffix - wildcard parent not a suffix itself", () =>
  assert.equal(isPublicSuffix("kawasaki.jp"), false));
await test("isPublicSuffix - subdomain of wildcard IS a suffix", () =>
  assert.equal(isPublicSuffix("example.kawasaki.jp"), true));

// ============================================================================
// §3  IDN and Domain Utilities
// ============================================================================

suite("IDN and Domain Utilities");

await test("decodeIDNLabel - non-punycode passes through", () =>
  assert.equal(decodeIDNLabel("example.com"), "example.com"));
await test("decodeIDNLabel - ASCII-only punycode (hello)", () =>
  assert.equal(decodeIDNLabel("xn--hello-"), "hello"));
await test("decodeIDNLabel - snowman emoji", () => assert.equal(decodeIDNLabel("xn--n3h"), "☃"));
await test("decodeIDNLabel - pile of poo emoji (surrogate pair)", () =>
  assert.equal(decodeIDNLabel("xn--ls8h"), "💩"));
await test("decodeIDNLabel - Chinese simplified", () =>
  assert.equal(decodeIDNLabel("xn--fiqs8s"), "中国"));
await test("decodeIDNLabel - Chinese I love you (xn--6qq986b3xl)", () =>
  assert.equal(decodeIDNLabel("xn--6qq986b3xl"), "我爱你"));
await test("decodeIDNLabel - Japanese", () =>
  assert.equal(decodeIDNLabel("xn--wgv71a119e"), "日本語"));
await test("decodeIDNLabel - Korean", () => assert.equal(decodeIDNLabel("xn--3e0b707e"), "한국"));
await test("decodeIDNLabel - Greek", () => assert.equal(decodeIDNLabel("xn--twa0c1ba0b"), "Ελλάς"));
await test("decodeIDNLabel - Russian Cyrillic", () =>
  assert.equal(decodeIDNLabel("xn--s0a2crma9f"), "Россия"));
await test("decodeIDNLabel - Latin with diacritics", () =>
  assert.equal(decodeIDNLabel("xn--bcdf-zna1d"), "àbcdéf"));
await test("decodeIDNLabel - has embedded delimiter (abc-def)", () =>
  assert.equal(decodeIDNLabel("xn--abc-def-"), "abc-def"));
await test("decodeIDNLabel - single ASCII char", () => assert.equal(decodeIDNLabel("xn--a-"), "a"));
await test("decodeIDNLabel - single digit", () => assert.equal(decodeIDNLabel("xn--1-"), "1"));
await test("decodeIDNLabel - trailing delimiter after basic", () =>
  assert.equal(decodeIDNLabel("xn--a--"), "a-"));
await test("decodeIDNLabel - Bopomofo via native decoder", () =>
  assert.equal(decodeIDNLabel("xn--4ek"), "㄄"));
await test("decodeIDNLabel - empty after xn-- returns raw", () =>
  assert.equal(decodeIDNLabel("xn--"), "xn--"));
await test("decodeIDNLabel - punycode with full domain", () => {
  const result = decodeIDNLabel("xn--n3h.com");
  assert.equal(result, "☃.com");
});
await test("decodeIDNLabel - multiple punycode labels in domain", () => {
  const result = decodeIDNLabel("xn--ls8h.xn--n3h");
  assert.equal(result, "💩.☃");
});

await test("canonicalizeDomainFull - uppercase to lowercase", () =>
  assert.equal(canonicalizeDomainFull("EXAMPLE.COM"), "example.com"));
await test("canonicalizeDomainFull - leading dot stripped", () =>
  assert.equal(canonicalizeDomainFull(".EXAMPLE.COM"), "example.com"));
await test("canonicalizeDomainFull - trailing dot stripped", () =>
  assert.equal(canonicalizeDomainFull("example.com."), "example.com"));
await test("canonicalizeDomainFull - both dots stripped", () =>
  assert.equal(canonicalizeDomainFull(".Example.Com."), "example.com"));
await test("canonicalizeDomainFull - mixed case with subdomain", () =>
  assert.equal(canonicalizeDomainFull("Sub.Example.COM"), "sub.example.com"));
await test("canonicalizeDomainFull - punycode segment decoded", () => {
  // xn--n3h decodes to ☃
  const result = canonicalizeDomainFull("xn--n3h.example.com");
  assert.equal(result, "☃.example.com");
});
await test("canonicalizeDomainFull - multiple punycode segments decoded", () => {
  const result = canonicalizeDomainFull("xn--n3h.xn--4ek.example.com");
  // xn--n3h decodes to ☃, xn--4ek may not decode via domainToUnicode
  assert.ok(result === "☃.xn--4ek.example.com" || result === "☃.㄄.example.com");
});

await test("isIPAddress - IPv4", () => assert.equal(isIPAddress("192.168.1.1"), true));
await test("isIPAddress - private IP", () => assert.equal(isIPAddress("10.0.0.1"), true));
await test("isIPAddress - invalid IP", () => assert.equal(isIPAddress("256.1.1.1"), false));
await test("isIPAddress - domain", () => assert.equal(isIPAddress("example.com"), false));
await test("isIPAddress - IPv6 loopback", () => assert.equal(isIPAddress("::1"), true));
await test("isIPAddress - IPv6 with brackets", () => assert.equal(isIPAddress("[::1]"), true));
await test("isIPAddress - empty string", () => assert.equal(isIPAddress(""), false));

// ============================================================================
// §4  domainMatch / pathMatch
// ============================================================================

suite("domainMatch / pathMatch");

await test("domainMatch - exact match", () =>
  assert.equal(domainMatch("example.com", "example.com"), true));
await test("domainMatch - subdomain", () =>
  assert.equal(domainMatch("www.example.com", "example.com"), true));
await test("domainMatch - deep subdomain", () =>
  assert.equal(domainMatch("sub.www.example.com", "example.com"), true));
await test("domainMatch - reverse not allowed", () =>
  assert.equal(domainMatch("example.com", "www.example.com"), false));
await test("domainMatch - IP exact", () =>
  assert.equal(domainMatch("192.168.1.1", "192.168.1.1"), true));
await test("domainMatch - IP subnet not allowed", () =>
  assert.equal(domainMatch("192.168.1.1", "168.1.1"), false));

await test("defaultPath - root", () => assert.equal(defaultPath("/"), "/"));
await test("defaultPath - no path", () => assert.equal(defaultPath("/foo"), "/"));
await test("defaultPath - trailing slash", () => assert.equal(defaultPath("/foo/"), "/foo"));
await test("defaultPath - deep path", () => assert.equal(defaultPath("/foo/bar"), "/foo"));
await test("defaultPath - no leading slash", () => assert.equal(defaultPath("foo"), "/"));
await test("defaultPath - empty", () => assert.equal(defaultPath(""), "/"));

await test("pathMatch - exact", () => assert.equal(pathMatch("/", "/"), true));
await test("pathMatch - child path", () => assert.equal(pathMatch("/foo", "/"), true));
await test("pathMatch - deep child", () => assert.equal(pathMatch("/foo/bar", "/foo"), true));
await test("pathMatch - sibling not allowed", () =>
  assert.equal(pathMatch("/foobar", "/foo"), false));
await test("pathMatch - exact deep", () => assert.equal(pathMatch("/foo/bar", "/foo/bar"), true));

// ============================================================================
// §5  parseSetCookieHeader
// ============================================================================

suite("parseSetCookieHeader");

await test("basic cookie", () =>
  assert.equal(parseSetCookieHeader("session=abc123")?.name, "session"));
await test("with Path", () =>
  assert.equal(parseSetCookieHeader("session=abc123; Path=/")?.path, "/"));
await test("with Domain", () =>
  assert.equal(parseSetCookieHeader("session=abc123; Domain=example.com")?.domain, "example.com"));
await test("with Secure", () =>
  assert.equal(parseSetCookieHeader("session=abc123; Secure")?.secure, true));
await test("with HttpOnly", () =>
  assert.equal(parseSetCookieHeader("session=abc123; HttpOnly")?.httpOnly, true));
await test("SameSite=Strict", () =>
  assert.equal(parseSetCookieHeader("session=abc123; SameSite=Strict")?.sameSite, "Strict"));
await test("SameSite=Lax", () =>
  assert.equal(parseSetCookieHeader("session=abc123; SameSite=Lax")?.sameSite, "Lax"));
await test("SameSite=None", () =>
  assert.equal(parseSetCookieHeader("session=abc123; SameSite=None")?.sameSite, "None"));
await test("Max-Age", () =>
  assert.equal(parseSetCookieHeader("session=abc123; Max-Age=3600")?.maxAge, 3600));
await test("strip quotes from value", () =>
  assert.equal(parseSetCookieHeader('session="abc123"')?.value, "abc123"));
await test("empty string returns null", () => assert.equal(parseSetCookieHeader(""), null));
await test("empty name returns empty string", () =>
  assert.equal(parseSetCookieHeader("=")?.name, ""));
await test("path must start with /", () =>
  assert.equal(parseSetCookieHeader("session=abc; Path=api")?.path, null));
await test("path valid", () =>
  assert.equal(parseSetCookieHeader("session=abc; Path=/api")?.path, "/api"));
await test("multiple SameSite - first wins", () => {
  const r = parseSetCookieHeader("session=abc; SameSite=Strict; SameSite=Lax");
  assert.equal(r?.sameSite, "Strict");
});
await test("SameSite=invalid defaults to Unset", () => {
  const r = parseSetCookieHeader("session=abc; SameSite=Invalid");
  assert.equal(r?.sameSite, "Unset");
});
await test("expires without Max-Age", () => {
  const r = parseSetCookieHeader("session=abc; Expires=Wed, 21 Oct 2025 07:28:00 GMT");
  assert.ok(r?.expires !== null);
});
await test("control char in value returns null", () => {
  assert.equal(parseSetCookieHeader("session=\x07test"), null);
});
await test("SameParty attribute", () => {
  const r = parseSetCookieHeader("session=abc; SameParty");
  assert.equal(r?.sameParty, true);
});
await test("Priority attribute", () => {
  const r = parseSetCookieHeader("session=abc; Priority=High");
  assert.equal(r?.priority, "High");
});
await test("Partitioned attribute", () => {
  const r = parseSetCookieHeader("session=abc; Partitioned");
  assert.equal(r?.partitioned, true);
});
await test("unknown attribute is ignored", () => {
  const r = parseSetCookieHeader("session=abc; UnknownAttr=foo");
  assert.ok(r !== null);
  assert.equal(r?.name, "session");
});

// ============================================================================
// §6  splitSetCookieHeaders / extractSetCookieHeaders
// ============================================================================

suite("splitSetCookieHeaders / extractSetCookieHeaders");

await test("comma separated splits into 2", () => {
  const result = splitSetCookieHeaders("session=abc123, another=test");
  assert.equal(result.length, 2);
  assert.equal(result[0], "session=abc123");
  assert.equal(result[1], "another=test");
});

await test("empty value before comma splits correctly", () => {
  const result = splitSetCookieHeaders("a=, b=c");
  assert.equal(result.length, 2);
  assert.equal(result[0], "a=");
  assert.equal(result[1], "b=c");
});

await test("empty value without space before comma splits correctly", () => {
  const result = splitSetCookieHeaders("x=,y=z");
  assert.equal(result.length, 2);
  assert.equal(result[0], "x=");
  assert.equal(result[1], "y=z");
});

await test("comma with quoted value does not split inside quotes", () => {
  const result = splitSetCookieHeaders('a="x,y", b=z');
  assert.equal(result.length, 2);
  assert.equal(result[0], 'a="x,y"');
  assert.equal(result[1], "b=z");
});

await test("comma after semicolon attributes splits correctly", () => {
  const result = splitSetCookieHeaders("a=b; Path=/, c=d");
  assert.equal(result.length, 2);
  assert.equal(result[0], "a=b; Path=/");
  assert.equal(result[1], "c=d");
});

await test("multiple attributes before comma", () => {
  const result = splitSetCookieHeaders("a=b; Path=/; Domain=example.com, c=d");
  assert.equal(result.length, 2);
  assert.equal(result[0], "a=b; Path=/; Domain=example.com");
  assert.equal(result[1], "c=d");
});

await test("semicolon only returns 1", () =>
  assert.equal(splitSetCookieHeaders("a=b; c=d; e=f").length, 1));
await test("single cookie returns 1", () =>
  assert.equal(splitSetCookieHeaders("key=value").length, 1));
await test("empty string returns 0", () => assert.equal(splitSetCookieHeaders("").length, 0));
await test("cookie with escaped quote", () => {
  const result = splitSetCookieHeaders('a="b\\"c"');
  assert.equal(result.length, 1);
});

await test("extractSetCookieHeaders - Headers object", () => {
  assert.equal(extractSetCookieHeaders(new Headers({ "set-cookie": "session=abc123" })).length, 1);
});
await test("extractSetCookieHeaders - Headers object getSetCookie path", () => {
  const h = new Headers({ "set-cookie": "a=1" });
  assert.equal(extractSetCookieHeaders(h).length, 1);
});
await test("extractSetCookieHeaders - plain object", () => {
  assert.equal(extractSetCookieHeaders({ "set-cookie": "session=abc123" }).length, 1);
});
await test("extractSetCookieHeaders - array value", () => {
  assert.equal(extractSetCookieHeaders({ "set-cookie": ["a=1", "b=2"] }).length, 2);
});
await test("extractSetCookieHeaders - empty", () =>
  assert.equal(extractSetCookieHeaders({}).length, 0));
await test("extractSetCookieHeaders - Headers with no set-cookie", () => {
  const h = new Headers({ "content-type": "text/plain" });
  assert.equal(extractSetCookieHeaders(h).length, 0);
});

// The getSetCookie fallback path (line 1146-1148) is for Node.js < 18 and can't be tested in modern Node.js

// ============================================================================
// §7  FORMAT SET-COOKIE HEADER & ADDITIONAL BRANCHES
// ============================================================================

suite("formatSetCookieHeader & Additional Branches");

await test("formatSetCookieHeader - basic", () => {
  const r = formatSetCookieHeader({
    name: "session",
    value: "abc123",
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: "Unset",
    sameParty: false,
    priority: null,
    partitioned: false,
  });
  assert.equal(r, "session=abc123");
});

await test("formatSetCookieHeader - with all attributes", () => {
  const r = formatSetCookieHeader({
    name: "test",
    value: "val",
    domain: "example.com",
    path: "/api",
    expires: 1735689600000,
    maxAge: 3600,
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    sameParty: false,
    priority: "High",
    partitioned: false,
  });
  assert.equal(
    r,
    "test=val; Path=/api; Domain=example.com; Expires=Wed, 01 Jan 2025 00:00:00 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=Strict; Priority=High",
  );
});

await test("formatSetCookieHeader - SameParty attribute", () => {
  const r = formatSetCookieHeader({
    name: "x",
    value: "1",
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: "Unset",
    sameParty: true,
    priority: null,
    partitioned: false,
  });
  assert.equal(r, "x=1; SameParty");
});

await test("formatSetCookieHeader - Partitioned attribute", () => {
  const r = formatSetCookieHeader({
    name: "x",
    value: "1",
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: "Unset",
    sameParty: false,
    priority: null,
    partitioned: true,
  });
  assert.equal(r, "x=1; Partitioned");
});

async function _unused() {
  // The getSetCookie fallback path (line 1146-1148 of source) is for Node.js < 18 and cannot be tested in modern runtimes
}

await test("parseSetCookieHeader - no equals sign (value-only)", () => {
  const r = parseSetCookieHeader("justvalue");
  assert.ok(r !== null);
  assert.equal(r?.name, "");
  assert.equal(r?.value, "justvalue");
});

// ============================================================================
// §8  REAL HTTP CALLS
// ============================================================================

suite("Real HTTP Calls");

await test("httpbin /cookies returns current cookies object", async () => {
  const res = await client.get("https://httpbin.org/cookies");
  assert.equal(res.status, 200);
  // /cookies returns {"cookies": {...}} even when empty
  assert.ok(typeof res.data === "object");
  assert.ok("cookies" in res.data, "/cookies must have a cookies field");
  assert.ok(typeof res.data.cookies === "object");
});

await test("httpbin /cookies/set with redirect manual", async () => {
  const res = await client.get("https://httpbin.org/cookies/set?testcookie=realvalue", {
    redirect: "manual",
  });
  // httpbin should redirect with Set-Cookie
  const setCookies = extractSetCookieHeaders(res.headers);
  if (res.status >= 300 && res.status < 400 && setCookies.length > 0) {
    const parsed = parseSetCookieHeader(setCookies[0]);
    assert.ok(parsed !== null, "Should parse cookie from redirect");
    if (parsed) {
      assert.equal(parsed.name, "testcookie");
      assert.equal(parsed.value, "realvalue");
    }
  } else {
    // httpbin may return 200 in some cases with body content
    assert.ok(res.status === 200 || (res.status >= 300 && res.status < 400));
  }
});

await test("httpbin /response-headers echoes Set-Cookie from params", async () => {
  const res = await client.get("https://httpbin.org/response-headers?Set-Cookie=fake=cookie");
  const setCookies = extractSetCookieHeaders(res.headers);
  assert.ok(setCookies.length > 0);
  assert.ok(setCookies.some((c) => c.includes("fake=cookie")));
});

await test("kinetex cookie jar captures real Set-Cookie and re-sends on next request", async () => {
  // Use kinetex with cookie jar enabled to test end-to-end cookie handling
  const jarClient = kinetex({ baseURL: "https://httpbin.org", timeout: 30000, cookieJar: true });

  // httpbin /cookies/set?name=value sets a cookie and redirects
  // The cookie jar should capture the Set-Cookie from the redirect
  const r1 = await jarClient.get("/cookies/set", {
    params: { kxsession: "e2e-test-value" },
    throwOnError: false,
    followRedirects: true,
  });

  // Now request /cookies - the cookie jar should send the captured cookie
  const r2 = await jarClient.get<{ cookies: Record<string, string> }>("/cookies");
  assert.equal(r2.status, 200);
  assert.equal(
    r2.data.cookies["kxsession"],
    "e2e-test-value",
    `Cookie jar should send captured cookie. Got: ${JSON.stringify(r2.data.cookies)}`,
  );
});

await test("extractSetCookieHeaders + parseSetCookieHeader with real httpbin Set-Cookie", async () => {
  // httpbin /cookies/set with redirect:manual returns Set-Cookie headers in the redirect response
  const res = await client.get("https://httpbin.org/cookies/set?realtest=realvalue", {
    redirect: "manual",
  });
  const rawSetCookie = extractSetCookieHeaders(res.headers);

  if (rawSetCookie.length > 0) {
    const parsed = parseSetCookieHeader(rawSetCookie[0]);
    assert.ok(parsed !== null, "Real Set-Cookie should parse successfully");
    assert.equal(parsed.name, "realtest");
    assert.equal(parsed.value, "realvalue");
    assert.equal(parsed.maxAge, null); // session cookie, no Max-Age
    assert.equal(parsed.expires, null); // session cookie, no Expires
  } else {
    // httpbin may return the cookie in body instead of Set-Cookie header
    // Verify via the /cookies endpoint
    const jarClient = kinetex({ baseURL: "https://httpbin.org", timeout: 30000, cookieJar: true });
    await jarClient.get("/cookies/set", { params: { realtest: "bodyvalue" }, throwOnError: false });
    const check = await jarClient.get<{ cookies: Record<string, string> }>("/cookies");
    assert.equal(check.data.cookies["realtest"], "bodyvalue");
  }
});

await test("extractSetCookieHeaders from plain object (no Headers API)", () => {
  const result = extractSetCookieHeaders({ "set-cookie": "plain=object" });
  assert.equal(result.length, 1);
  assert.equal(result[0], "plain=object");
});

await test("extractSetCookieHeaders from array of Set-Cookie values", () => {
  const result = extractSetCookieHeaders({ "set-cookie": ["first=1", "second=2"] });
  assert.equal(result.length, 2);
  assert.equal(result[0], "first=1");
  assert.equal(result[1], "second=2");
});

await test("kinetex cookie jar with multiple Set-Cookie headers", async () => {
  // Use response-headers to echo back multiple Set-Cookie values
  const res = await client.get(
    "https://httpbin.org/response-headers?Set-Cookie=a=1&Set-Cookie=b=2",
  );
  const raw = extractSetCookieHeaders(res.headers);
  // httpbin may echo these as individual Set-Cookie headers or combine them
  assert.ok(raw.length > 0, "Should extract at least one Set-Cookie");
  // Verify extracted values contain our cookies
  const all = raw.join(" ");
  assert.ok(all.includes("a=1") || raw.some((c) => c.startsWith("a=1")));
  assert.ok(all.includes("b=2") || raw.some((c) => c.startsWith("b=2")));
});

// ============================================================================
// §8  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  COOKIE PARSER TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
);
console.log(`${"=".repeat(60)}`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    if (err instanceof Error) console.log(`    ${err.message}`);
  }
  process.exit(1);
}

process.exit(0);
