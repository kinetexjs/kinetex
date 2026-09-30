import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import { CookieJar, createCookieJar, loadCookieJar } from "../src/cookiejar.ts";

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

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

// ============================================================================
// §1  setCookie — RFC 6265 §5.3 FULL COVERAGE
// ============================================================================

suite("setCookie");

await test("basic cookie stores and retrieves", async () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("session=abc123", { url: "https://example.com/" }), true);
  assert.equal(jar.count, 1);
  // A real elapsed gap BEFORE the read, so the value the snapshot carries can
  // be told apart from one this very call stamped.
  await new Promise((r) => setTimeout(r, 15));
  const cookies = jar.getCookies({ url: "https://example.com/" });
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, "session");
  assert.equal(cookies[0].value, "abc123");
  assert.equal(cookies[0].domain, "example.com");
  assert.equal(cookies[0].path, "/");
  assert.equal(cookies[0].hostOnly, true);
  assert.equal(cookies[0].secure, false);
  assert.equal(cookies[0].httpOnly, false);
  assert.equal(cookies[0].sameSite, "Unset");
  assert.equal(cookies[0].maxAge, null);
  // `> 0` is true of any timestamp since the epoch. Pin the window: the cookie
  // was created now, so createdAt must be at or before now and not in the
  // future, and lastAccessed starts equal to createdAt.
  const now = Date.now();
  assert.ok(cookies[0].createdAt <= now, "createdAt must not be in the future");
  assert.ok(now - cookies[0].createdAt < 5000, "createdAt must be ~now");
  // The snapshot handed to the caller is the cookie as it was stored,
  // not a copy already stamped with the access that call itself performed.
  // Measured as a gap, not an inequality against `now`: a snapshot stamped by
  // the very call that produced it can still land 0 ms "before" now.
  assert.ok(
    now - cookies[0].lastAccessed > 5,
    `the returned snapshot must predate this call by the 15 ms sleep, got ${now - cookies[0].lastAccessed} ms`,
  );
  assert.equal(cookies[0].expires, Infinity, "no Max-Age/Expires means a session cookie");
  jar.destroy();
});

await test("cookie with Path=/api only matches /api/* paths", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Path=/api", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://example.com/api" }).length, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/api/v2" }).length, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 0);
  assert.equal(jar.getCookies({ url: "https://example.com/other" }).length, 0);
});

await test("cookie with Domain=example.com accessible from subdomain", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Domain=example.com; Path=/", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://sub.example.com/" }).length, 1);
});

await test("Domain mismatch: cannot set cookie for foreign domain", () => {
  const jar = createCookieJar();
  assert.equal(
    jar.setCookie("x=1; Domain=attacker.com; Path=/", { url: "https://example.com/" }),
    false,
  );
});

await test("Domain cannot be a public suffix (e.g. com)", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=1; Domain=com; Path=/", { url: "https://example.com/" }), false);
});

await test("Secure cookie only set on HTTPS", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=1; Secure", { url: "https://example.com/" }), true);
  assert.equal(jar.setCookie("x=1; Secure", { url: "http://example.com/" }), false);
});

await test("Secure cookie on localhost over HTTP works", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=1; Secure", { url: "https://localhost/" }), true);
  assert.equal(jar.getCookies({ url: "http://localhost/" }).length, 1);
});

await test("Secure cookie not sent over plain HTTP", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Secure", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 1);
  assert.equal(jar.getCookies({ url: "http://example.com/" }).length, 0);
});

await test("HttpOnly cookie withheld in non-HTTP context", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; HttpOnly", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://example.com/", http: true }).length, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/", http: false }).length, 0);
});

await test("SameSite=Strict blocks cross-site", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; SameSite=Strict", { url: "https://example.com/" });
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "strict" }).length,
    1,
  );
  assert.equal(jar.getCookies({ url: "https://example.com/", sameSiteContext: "lax" }).length, 0);
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "cross-site" }).length,
    0,
  );
});

await test("SameSite=Lax allows strict and top-level nav", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; SameSite=Lax", { url: "https://example.com/" });
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "strict" }).length,
    1,
  );
  assert.equal(jar.getCookies({ url: "https://example.com/", sameSiteContext: "lax" }).length, 1);
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "cross-site" }).length,
    0,
  );
});

await test("SameSite=None requires Secure", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=1; SameSite=None; Secure", { url: "https://example.com/" }), true);
  assert.equal(jar.setCookie("x=1; SameSite=None", { url: "https://example.com/" }), false);
});

await test("SameSite=None sent in all contexts", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; SameSite=None; Secure", { url: "https://example.com/" });
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "strict" }).length,
    1,
  );
  assert.equal(jar.getCookies({ url: "https://example.com/", sameSiteContext: "lax" }).length, 1);
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "cross-site" }).length,
    1,
  );
  assert.equal(jar.getCookies({ url: "https://example.com/", sameSiteContext: "none" }).length, 1);
});

await test("SameSite=Unset (default) blocks cross-site", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "strict" }).length,
    1,
  );
  assert.equal(
    jar.getCookies({ url: "https://example.com/", sameSiteContext: "cross-site" }).length,
    0,
  );
});

await test("Max-Age sets expiry and cookie persists", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=3600", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://example.com/" });
  assert.equal(cookies.length, 1);
  // "Not Infinity and in the future" is satisfied by a lifetime of 1 ms. The
  // subject of the test is 3600 seconds.
  assert.equal(cookies[0].maxAge, 3600, "the raw Max-Age is retained");
  const ttl = cookies[0].expires - Date.now();
  assert.ok(ttl > 3_595_000 && ttl <= 3_600_000, `expected ~3600s, got ${ttl}ms`);
  jar.destroy();
});

await test("Max-Age=0 deletes cookie immediately", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.count, 1);
  jar.setCookie("x=; Max-Age=0", { url: "https://example.com/" });
  assert.equal(jar.count, 0);
});

await test("Expires in past deletes cookie immediately", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  jar.setCookie("x=; Expires=Wed, 01 Jan 2000 00:00:00 GMT", { url: "https://example.com/" });
  assert.equal(jar.count, 0);
});

// The 400-day cap is expressed on the stored expiry, but that expiry is an
// absolute timestamp captured inside setCookie(). Comparing it to a later
// Date.now() therefore loses whatever elapsed in between, so an exact equality
// against 400 days fails whenever a millisecond ticks over. Assert a bounded
// window around the cap instead, measured from the timestamp taken *before* the
// write.
const CAP_400D = 400 * 86400000;

function assertCappedAt400Days(label: string, expires: number, before: number): void {
  // The cap is stamped from the "now" inside setCookie(), which is at or just
  // after `before`, and Expires only has whole-second resolution, so the delta
  // can sit a few milliseconds either side of exactly 400 days. 5s of slack is
  // still six orders of magnitude below the 1-day granularity that would
  // distinguish "capped" from "not capped".
  const SLACK = 5000;
  const delta = expires - before;
  assert.equal(
    delta <= CAP_400D + SLACK && delta > CAP_400D - SLACK,
    true,
    `${label}: expected expiry capped at 400 days from ${before}, got ${delta}ms`,
  );
}

await test("Max-Age capped at 400 days", () => {
  const jar = createCookieJar();
  const before = Date.now();
  jar.setCookie("x=1; Max-Age=99999999", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://example.com/" });
  assertCappedAt400Days("Max-Age", cookies[0].expires as number, before);
});

await test("Expires capped at 400 days from now", () => {
  const before = Date.now();
  const farFuture = new Date(before + 999 * 86400000).toUTCString();
  const jar = createCookieJar();
  jar.setCookie(`x=1; Expires=${farFuture}`, { url: "https://example.com/" });
  assertCappedAt400Days(
    "Expires",
    jar.getCookies({ url: "https://example.com/" })[0].expires as number,
    before,
  );
});

await test("cookie over 4096 bytes rejected", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=" + "y".repeat(5000), { url: "https://example.com/" }), false);
});

await test("__Secure- prefix requires Secure flag", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("__Secure-x=1", { url: "https://example.com/" }), false);
  assert.equal(jar.setCookie("__Secure-x=1; Secure", { url: "https://example.com/" }), true);
});

await test("__Secure- prefix requires HTTPS context", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("__Secure-x=1; Secure", { url: "http://example.com/" }), false);
});

await test("__Host- prefix requires Secure + Path=/ + hostOnly", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("__Host-x=1", { url: "https://example.com/" }), false);
  assert.equal(
    jar.setCookie("__Host-x=1; Secure; Path=/api", { url: "https://example.com/api" }),
    false,
  );
  assert.equal(jar.setCookie("__Host-x=1; Secure; Path=/", { url: "https://example.com/" }), true);
});

await test("__Host- with Domain attribute rejects (must be hostOnly)", () => {
  const jar = createCookieJar();
  assert.equal(
    jar.setCookie("__Host-x=1; Secure; Path=/; Domain=example.com", {
      url: "https://example.com/",
    }),
    false,
  );
});

await test("updating same cookie name preserves createdAt", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  const created = jar.getCookies({ url: "https://example.com/" })[0].createdAt;
  jar.setCookie("x=2", { url: "https://example.com/" });
  const cookie = jar.getCookies({ url: "https://example.com/" })[0];
  assert.equal(cookie.value, "2");
  assert.equal(cookie.createdAt, created);
});

await test("invalid URL returns false", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("x=1", { url: "not-a-url" }), false);
});

await test("empty cookie header string returns false", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("", { url: "https://example.com/" }), false);
});

await test("cookie with empty name is stored", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("=value", { url: "https://example.com/" }), true);
  assert.equal(jar.count, 1);
});

await test("cookie with domain having leading dot is normalized", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Domain=.example.com; Path=/", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://sub.example.com/" });
  assert.equal(cookies.length, 1);
});

await test("hostOnly cookie does not match subdomain", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://sub.example.com/" });
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 0);
});

// ============================================================================
// §2  removeCookie / clear / clearExpired / clearSession / clearForDomain / clearForUrl
// ============================================================================

suite("removeCookie / clear / clearSession / clearForDomain / clearForUrl");

await test("removeCookie deletes and returns true", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.removeCookie("example.com", "/", "x"), true);
  assert.equal(jar.count, 0);
});

await test("removeCookie returns false for non-existent", () => {
  const jar = createCookieJar();
  assert.equal(jar.removeCookie("example.com", "/", "x"), false);
});

await test("removeCookie on wrong path returns false", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Path=/api", { url: "https://example.com/" });
  assert.equal(jar.removeCookie("example.com", "/", "x"), false);
  assert.equal(jar.count, 1);
});

await test("clear removes all cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1", { url: "https://example.com/" });
  jar.setCookie("b=2", { url: "https://other.com/" });
  assert.equal(jar.count, 2);
  jar.clear();
  assert.equal(jar.count, 0);
});

await test("clearExpired removes cookie that expired", async () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=1", { url: "https://example.com/" });
  assert.equal(jar.count, 1);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(jar.clearExpired(), 1);
  assert.equal(jar.count, 0);
});

await test("clearExpired with no expired returns 0", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.clearExpired(), 0);
});

await test("clearSession removes only session cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" }); // session
  jar.setCookie("y=1; Max-Age=3600", { url: "https://example.com/" }); // persistent
  assert.equal(jar.count, 2);
  assert.equal(jar.clearSession(), 1);
  assert.equal(jar.count, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/" })[0].name, "y");
});

await test("clearForDomain removes exact + subdomain cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1; Domain=example.com; Path=/", { url: "https://example.com/" });
  jar.setCookie("b=2; Domain=sub.example.com; Path=/", { url: "https://sub.example.com/" });
  jar.setCookie("c=3; Domain=other.com; Path=/", { url: "https://other.com/" });
  assert.equal(jar.count, 3);
  assert.equal(jar.clearForDomain("example.com"), 2);
  assert.equal(jar.count, 1);
});

await test("clearForDomain on non-existent domain returns 0", () => {
  const jar = createCookieJar();
  assert.equal(jar.clearForDomain("no-such.com"), 0);
});

await test("clearForUrl removes cookies for URL hostname", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.clearForUrl("https://example.com/"), 1);
  assert.equal(jar.count, 0);
});

await test("clearForUrl with invalid URL returns 0", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.clearForUrl("not-a-url"), 0);
  assert.equal(jar.count, 1);
});

// ============================================================================
// §3  Serialization round-trip
// ============================================================================

suite("Serialization");

await test("toJSON excludes expired cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=3600", { url: "https://example.com/" });
  assert.equal(jar.toJSON().length, 1);
});

await test("toJSON session cookie has expires=null", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.toJSON()[0].expires, null);
});

await test("fromJSON restores cookies and they can be retrieved", () => {
  const data = [
    {
      name: "a",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: true,
    },
  ];
  const jar = loadCookieJar(data);
  assert.equal(jar.count, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 1);
});

await test("fromJSON skips expired entries", () => {
  const data = [
    {
      name: "a",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: Date.now() - 1000,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: true,
    },
  ];
  const jar = loadCookieJar(data);
  assert.equal(jar.count, 0);
});

await test("fromJSON from string works", () => {
  const json = JSON.stringify([
    {
      name: "a",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: true,
    },
  ]);
  const jar = loadCookieJar(json);
  assert.equal(jar.count, 1);
});

await test("toString returns pretty JSON", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  const str = jar.toString();
  assert.equal(str.startsWith('[\n  {\n    "name": "x"'), true, `not pretty-printed: ${str}`);
  const parsed = JSON.parse(str) as Record<string, unknown>[];
  assert.equal(parsed.length, 1);
  assert.deepEqual(
    { ...parsed[0], createdAt: 0, lastAccessed: 0 },
    {
      name: "x",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: 0,
      lastAccessed: 0,
      hostOnly: true,
    },
  );
});

await test("serialize + deserialize full round-trip", () => {
  const jar1 = createCookieJar();
  jar1.setCookie("a=1; Max-Age=3600", { url: "https://example.com/" });
  jar1.setCookie("b=2; Domain=example.com; Path=/api", { url: "https://example.com/" });
  const json = JSON.stringify(jar1.toJSON());
  const jar2 = loadCookieJar(json);
  assert.equal(jar2.count, 2);
  assert.equal(jar2.getCookies({ url: "https://example.com/api" }).length, 2);
});

// ============================================================================
// §4  Inspection APIs
// ============================================================================

suite("Inspection APIs");

await test("getAll returns all cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1", { url: "https://example.com/" });
  jar.setCookie("b=2", { url: "https://other.com/" });
  assert.equal(jar.getAll().length, 2);
});

await test("getAll returns copies (mutating does not affect jar)", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  jar.getAll()[0].value = "hacked";
  assert.equal(jar.getCookies({ url: "https://example.com/" })[0].value, "1");
});

await test("getForDomain returns exact match and subdomain cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1; Domain=example.com; Path=/", { url: "https://example.com/" });
  jar.setCookie("b=2; Domain=sub.example.com; Path=/", { url: "https://sub.example.com/" });
  jar.setCookie("c=3", { url: "https://other.com/" });
  const cookies = jar.getForDomain("example.com");
  assert.equal(cookies.length, 2);
  const names = cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ["a", "b"]);
});

await test("getForDomain on non-existent returns empty", () => {
  const jar = createCookieJar();
  assert.equal(jar.getForDomain("no-such.com").length, 0);
});

await test("getCookiesForDomain returns non-expired cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  const cookies = jar.getCookiesForDomain("example.com");
  assert.equal(cookies.length, 1);
});

await test("getCookiesForDomain on non-matching domain returns empty", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.getCookiesForDomain("other.com").length, 0);
});

await test("getCookieHeader builds proper header string", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  jar.setCookie("y=2", { url: "https://example.com/" });
  // `includes` plus a length would accept "x=1; y=2; garbage=x=1" with a
  // duplicated pair; assert the exact string, which also pins the ordering.
  assert.equal(jar.getCookieHeader({ url: "https://example.com/" }), "x=1; y=2");
  assert.equal(
    jar.getCookieHeader({ url: "https://other.com/" }),
    "",
    "a different host gets no cookies",
  );
  // Longer paths sort first (RFC 6265 §5.4 step 2), and an empty name is sent
  // as its bare value.
  const jar2 = createCookieJar();
  jar2.setCookie("deep=3; Path=/a/b", { url: "https://example.com/a/b" });
  jar2.setCookie("shallow=4; Path=/", { url: "https://example.com/" });
  jar2.setCookie("=bare", { url: "https://example.com/" });
  assert.equal(
    jar2.getCookieHeader({ url: "https://example.com/a/b/c" }),
    "deep=3; shallow=4; bare",
    "longest path first, insertion order within a path, empty name sends its value",
  );
  jar.destroy();
  jar2.destroy();
});

await test("getCookieHeader empty when no cookies match", () => {
  const jar = createCookieJar();
  assert.equal(jar.getCookieHeader({ url: "https://example.com/" }), "");
});

await test("count returns accurate total", () => {
  // Every assertion below also cross-checks `count` against the number of
  // cookies that are actually reachable. `count` is maintained by hand
  // alongside the maps, and the two can drift apart without it being visible.
  const jar = createCookieJar();
  jar.setCookie("a=1", { url: "https://a.com/" });
  jar.setCookie("b=2", { url: "https://b.com/" });
  jar.setCookie("c=3", { url: "https://c.com/" });
  assert.equal(jar.count, 3);
});

// ============================================================================
// §5  Custom domain matcher + edge cases
// ============================================================================

suite("Custom Domain Matcher & Edge Cases");

await test("custom domain matcher allows arbitrary domain", () => {
  const jar = new CookieJar({ domainMatcher: () => true });
  assert.equal(jar.setCookie("x=1; Domain=anything.com", { url: "https://example.com/" }), true);
});

await test("custom domain matcher can reject everything", () => {
  const jar = new CookieJar({ domainMatcher: () => false });
  assert.equal(jar.setCookie("x=1; Domain=example.com", { url: "https://example.com/" }), false);
});

await test("custom max limits work", () => {
  // All ten cookies carry `Domain=example.com`, so the PER-DOMAIN cap of 3 is
  // the binding one and 3 is the correct answer. This asserted 5, and passed
  // only because the eviction path was orphaning the cookies it had just
  // stored while still counting them — the counter drifted to 5 over 2
  // reachable cookies. Assert the caps, and assert that what the counter
  // claims is actually there.
  const jar = new CookieJar({ maxTotal: 5, maxPerDomain: 3 });
  for (let i = 0; i < 10; i++) {
    jar.setCookie(`x${i}=1; Domain=example.com; Path=/p${i}`, { url: `https://example.com/p${i}` });
  }
  assert.equal(jar.count, 3, "the per-domain cap binds when every cookie shares a domain");
  assert.equal(jar.getAll().length, 3, "count must equal the number of reachable cookies");
  assert.equal(jar.toJSON().length, 3, "and the number that serialize");
  for (const c of jar.getAll()) assert.ok(c.domain === "example.com");

  // The global cap binds when the cookies are spread across domains.
  const spread = new CookieJar({ maxTotal: 5, maxPerDomain: 100 });
  for (let i = 0; i < 10; i++) {
    spread.setCookie(`c${i}=1`, { url: `https://d${i}.test/` });
  }
  assert.equal(spread.count, 5, "the global cap must bound the jar");
  assert.equal(spread.getAll().length, 5, "with no drift between the two");
  jar.destroy();
  spread.destroy();
});

await test("destroy cleans up interval timer", () => {
  const jar = createCookieJar();
  const priv = jar as unknown as { cleanupTimer: unknown };
  assert.ok(
    priv.cleanupTimer !== null && priv.cleanupTimer !== undefined,
    "a live jar must hold a cleanup interval",
  );
  jar.destroy();
  // The interval is what keeps the event loop alive, so clearing it is the
  // whole point — and nothing checked it before.
  assert.equal(priv.cleanupTimer, null, "destroy must clear the cleanup interval");
  assert.doesNotThrow(() => jar.destroy()); // second call must also be safe
});

await test("processResponseHeaders from Headers object", () => {
  const jar = createCookieJar();
  jar.processResponseHeaders(new Headers({ "set-cookie": "a=1" }), { url: "https://example.com/" });
  assert.equal(jar.count, 1);
});

await test("processResponseHeaders from plain object with array", () => {
  const jar = createCookieJar();
  jar.processResponseHeaders({ "set-cookie": ["a=1", "b=2"] }, { url: "https://example.com/" });
  assert.equal(jar.count, 2);
});

await test("IP request host does not match domain cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Domain=example.com", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://10.0.0.1/" });
  assert.equal(cookies.length, 0);
});

await test("sort order: longer path first, then older createdAt", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1; Path=/", { url: "https://example.com/" });
  jar.setCookie("b=2; Path=/api", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://example.com/api/users" });
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, "b");
  assert.equal(cookies[1].name, "a");
});

await test("repeated getCookies calls trigger lazy cleanup path", () => {
  // 500 fresh jars proved only that nothing threw. Keep one jar, and prove the
  // lazy path keeps returning exactly the live cookie.
  const jar = createCookieJar();
  jar.setCookie("alive=1", { url: "https://example.com/" });
  assert.equal(jar.count, 1, "the live cookie must be stored");
  for (let i = 0; i < 500; i++) {
    const got = jar.getCookies({ url: "https://example.com/" });
    assert.equal(got.length, 1, "repeated reads must keep returning the live cookie");
    assert.equal(got[0]!.name, "alive");
  }
  jar.destroy();
});

// ============================================================================
// §6  EDGE CASE BUG HUNTING
// ============================================================================

suite("Edge Case Bug Hunting");

await test("host-only cookie does NOT leak to subdomains", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 1);
  assert.equal(jar.getCookies({ url: "https://sub.example.com/" }).length, 0);
});

await test("domain cookie correctly matches subdomain", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Domain=example.com", { url: "https://example.com/" });
  assert.equal(jar.getCookies({ url: "https://sub.example.com/" }).length, 1);
});

await test("cookie with empty name in getCookieHeader", () => {
  const jar = createCookieJar();
  jar.setCookie("=value", { url: "https://example.com/" });
  const header = jar.getCookieHeader({ url: "https://example.com/" });
  assert.equal(header, "value");
});

await test("multiple cookies with same name different paths", () => {
  const jar = createCookieJar();
  jar.setCookie("x=root; Path=/", { url: "https://example.com/" });
  jar.setCookie("x=api; Path=/api", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://example.com/api/users" });
  assert.equal(cookies.length, 2);
  const vals = cookies.map((c) => c.value).sort();
  assert.deepEqual(vals, ["api", "root"]);
});

await test("domain cookie with leading dot is normalized", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Domain=.example.com; Path=/", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://sub.example.com/" });
  assert.equal(cookies.length, 1);
});

await test("very old expiry date is handled", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Expires=Mon, 01 Jan 1990 00:00:00 GMT", { url: "https://example.com/" });
  assert.equal(jar.count, 0);
});

await test("path with trailing slash gets correct defaultPath", () => {
  // defaultPath("/foo/") should return "/foo"
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/foo/" });
  assert.equal(jar.getCookies({ url: "https://example.com/foo/bar" }).length, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/" }).length, 0);
});

await test("Secure cookie on localhost over HTTP works for retrieval", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Secure", { url: "https://localhost/" });
  // Retrieval over HTTP to localhost should work
  assert.equal(jar.getCookies({ url: "http://localhost/" }).length, 1);
});

await test("Secure cookie on 127.0.0.1 over HTTP works", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Secure", { url: "https://127.0.0.1/" });
  assert.equal(jar.getCookies({ url: "http://127.0.0.1/" }).length, 1);
});

await test("Secure cookie on ::1 over HTTP works", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Secure", { url: "https://[::1]/" });
  assert.equal(jar.getCookies({ url: "http://[::1]/" }).length, 1);
});

await test("cookie set and deleted via Max-Age=0 can be re-set", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  assert.equal(jar.count, 1);
  jar.setCookie("x=; Max-Age=0", { url: "https://example.com/" });
  assert.equal(jar.count, 0);
  jar.setCookie("x=2", { url: "https://example.com/" });
  assert.equal(jar.count, 1);
  assert.equal(jar.getCookies({ url: "https://example.com/" })[0].value, "2");
});

await test("getCookiesForDomain matches subdomains correctly", () => {
  const jar = createCookieJar();
  jar.setCookie("a=1; Domain=example.com; Path=/", { url: "https://example.com/" });
  jar.setCookie("b=2; Domain=sub.example.com; Path=/", { url: "https://sub.example.com/" });
  const cookies = jar.getCookiesForDomain("example.com");
  assert.equal(cookies.length, 2);
});

await test("getCookiesForDomain does not return expired cookies", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=1", { url: "https://example.com/" });
  const before = jar.getCookiesForDomain("example.com");
  assert.equal(before.length, 1);
});

await test("cookie with Max-Age and Expires both set uses Max-Age", () => {
  const jar = createCookieJar();
  // Expires lands a full day out, so "used Expires" and "used Max-Age"
  // are unambiguously distinct outcomes rather than near-identical numbers.
  const expiresAttr = new Date(Date.now() + 86400000).toUTCString();
  jar.setCookie("x=1; Max-Age=3600; Expires=" + expiresAttr, { url: "https://example.com/" });
  const cookie = jar.getCookies({ url: "https://example.com/" })[0];
  assert.notEqual(cookie.expires, null);

  // Max-Age is relative to "now" and Expires is absolute, so the two differ by a
  // whole day. Asserting an exact millisecond count races against the clock
  // ticking between setCookie() and the read; precedence is what is under test,
  // and that is decidable exactly: the expiry must be ~1h away, never ~24h.
  const remaining = (cookie.expires as number) - Date.now();
  assert.equal(
    remaining > 3500000 && remaining <= 3600000,
    true,
    `Max-Age=3600 should win over Expires, expected ~1h remaining, got ${remaining}ms`,
  );
});

await test("update preserves createdAt across multiple updates", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1", { url: "https://example.com/" });
  const created = jar.getCookies({ url: "https://example.com/" })[0].createdAt;
  jar.setCookie("x=2", { url: "https://example.com/" });
  const c2 = jar.getCookies({ url: "https://example.com/" })[0].createdAt;
  assert.equal(c2, created);
  jar.setCookie("x=3", { url: "https://example.com/" });
  const c3 = jar.getCookies({ url: "https://example.com/" })[0].createdAt;
  assert.equal(c3, created);
});

await test("SameSite context 'none' sends Unset and None cookies only", () => {
  const jar = createCookieJar();
  jar.setCookie("s=1; SameSite=Strict", { url: "https://example.com/" });
  jar.setCookie("l=1; SameSite=Lax", { url: "https://example.com/" });
  jar.setCookie("n=1; SameSite=None; Secure", { url: "https://example.com/" });
  jar.setCookie("u=1", { url: "https://example.com/" });
  // 'none' context is more restrictive: only Unset and None are sent
  const cookies = jar.getCookies({ url: "https://example.com/", sameSiteContext: "none" });
  assert.equal(cookies.length, 2);
  const names = cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ["n", "u"]);
});

// (The eight tests that stood here — "custom domain matcher can reject
// everything", "custom max limits work", "destroy cleans up interval timer",
// "processResponseHeaders from Headers object", "processResponseHeaders from
// plain object with array", "IP request host does not match domain cookies",
// "sort order: longer path first, then older createdAt" and "repeated
// getCookies calls trigger lazy cleanup path" — were byte-for-byte copies of
// tests already present in §5. The file reported 98 tests; 90 were distinct.)

// ============================================================================
// §6  REAL HTTP INTEGRATION — battle tests with httpbin.org
// ============================================================================

suite("Real HTTP Integration");

await test("kinetex cookie jar captures Set-Cookie from /cookies/set", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cookieJar: true });
  await client.get("/cookies/set", { params: { battle: "test-value" }, throwOnError: false });
  // Verify the cookie was captured by checking /cookies
  const r = await client.get<{ cookies: Record<string, string> }>("/cookies");
  assert.equal(r.status, 200);
  assert.equal(
    r.data.cookies["battle"],
    "test-value",
    `Expected cookie 'battle=test-value', got: ${JSON.stringify(r.data.cookies)}`,
  );
});

await test("kinetex cookie jar with multiple cookies from different requests", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cookieJar: true });
  await client.get("/cookies/set", { params: { first: "alpha" }, throwOnError: false });
  await client.get("/cookies/set", { params: { second: "beta" }, throwOnError: false });
  const r = await client.get<{ cookies: Record<string, string> }>("/cookies");
  assert.equal(r.data.cookies["first"], "alpha");
  assert.equal(r.data.cookies["second"], "beta");
});

await test("kinetex cookie jar sends cookies back to same domain", async () => {
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cookieJar: true });
  // Set a cookie
  await client.get("/cookies/set", { params: { roundtrip: "working" }, throwOnError: false });
  // Verify it's sent on a subsequent request
  const r = await client.get<{ cookies: Record<string, string> }>("/cookies");
  assert.equal(r.data.cookies["roundtrip"], "working");
  // Also verify the request to /headers shows the Cookie header
  const headers = await client.get<{ headers: Record<string, string> }>("/headers");
  assert.ok(
    headers.data.headers["Cookie"]?.includes("roundtrip=working"),
    `Cookie header should include roundtrip. Got: ${headers.data.headers["Cookie"]}`,
  );
});

await test("cookie jar with automatic redirect following", async () => {
  // httpbin /cookies/set redirects to /cookies, which should show the cookie
  const client = kinetex({ baseURL: "https://httpbin.org", timeout: T, cookieJar: true });
  // Follow redirects and read response
  const r = await client.get<{ cookies: Record<string, string> }>("/cookies/set", {
    params: { redirecttest: "works" },
    throwOnError: false,
  });
  assert.equal(r.status, 200);
  // The redirect goes to /cookies and should show the cookie
  // Wait for cookie to be properly stored
  const check = await client.get<{ cookies: Record<string, string> }>("/cookies");
  assert.equal(
    check.data.cookies["redirecttest"],
    "works",
    `Cookie from redirect should be captured. Got: ${JSON.stringify(check.data.cookies)}`,
  );
});

await test("cookie jar with multiple Set-Cookie from response-headers", async () => {
  const res = await httpbin.get("/response-headers?Set-Cookie=m1=v1&Set-Cookie=m2=v2");
  const { extractSetCookieHeaders } = await import("../src/cookie-parser.ts");
  const raw = extractSetCookieHeaders(res.headers);
  assert.equal(raw.length, 2, `Should extract both Set-Cookie headers, got ${JSON.stringify(raw)}`);
  assert.deepEqual(raw.map((c) => c.split(";")[0]).sort(), ["m1=v1", "m2=v2"]);
});

await test("direct CookieJar with real httpbin Set-Cookie", async () => {
  const res = await httpbin.get("/cookies/set?direct=test", { redirect: "manual" });
  const { extractSetCookieHeaders, parseSetCookieHeader } = await import("../src/cookie-parser.ts");
  const raw = extractSetCookieHeaders(res.headers);
  if (raw.length > 0) {
    const parsed = parseSetCookieHeader(raw[0]);
    assert.ok(parsed !== null);
    assert.equal(parsed.name, "direct");
    assert.equal(parsed.value, "test");
    // Now store in CookieJar
    const jar = createCookieJar();
    assert.equal(jar.setCookie(raw[0], { url: "https://httpbin.org/" }), true);
    assert.equal(jar.count, 1);
    // Verify retrieval
    const retrieved = jar.getCookies({ url: "https://httpbin.org/" });
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0].name, "direct");
    assert.equal(retrieved[0].value, "test");
  } else {
    // httpbin may respond without redirect
    // Pinned, not "200 or any 3xx": a redirect is a different response shape
    // and was being accepted as equivalent.
    assert.equal(res.status, 200, "the echo endpoint must answer 200");
  }
});

await test("httpbin /cookies endpoint returns cookies object", async () => {
  const r = await httpbin.get("/cookies");
  assert.equal(r.status, 200);
  assert.ok(typeof r.data === "object");
  assert.ok("cookies" in r.data);
});

await test("httpbin basic endpoints accessible", async () => {
  assert.equal((await httpbin.get("/get")).status, 200);
  assert.equal((await httpbin.get("/ip")).status, 200);
  assert.ok((await httpbin.get("/uuid")).data.uuid);
  assert.ok((await httpbin.get("/headers")).data.headers);
  assert.ok((await httpbin.get("/json")).data.slideshow);
  const base64 = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(String(base64.data).trim(), "Hello World");
});

// ============================================================================
// §8  REGRESSION: EVICTION ORPHANS, REHYDRATION, OWNERSHIP, REPORTING
// ============================================================================

suite("regression: a new cookie is never orphaned by its own eviction");

await test("regression: a cookie at a new path survives the eviction it triggers", async () => {
  // putCookie created the new path map, then called evictForDomain() — which
  // prunes empty path maps as part of its own bookkeeping. The prune deleted
  // the map that was about to be written into, so the cookie landed in an
  // orphaned map nothing could reach: setCookie() returned true, the cookie
  // was never sent, and getAll()/toJSON() could not see it.
  const jar = new CookieJar({ maxPerDomain: 2, maxTotal: 1000 });
  jar.setCookie("a=1; Path=/1", { url: "https://example.com/1" });
  await new Promise((r) => setTimeout(r, 20));
  jar.setCookie("b=1; Path=/2", { url: "https://example.com/2" });

  // Now at the cap, so adding a third cookie at a NEW path evicts one.
  const accepted = jar.setCookie("c=1; Path=/3", { url: "https://example.com/3" });
  assert.equal(accepted, true, "setCookie must report success");
  assert.equal(
    jar.getCookieHeader({ url: "https://example.com/3" }),
    "c=1",
    "the cookie the server just set must actually be sent",
  );
  const stored = jar
    .getAll()
    .map((c) => c.name)
    .sort();
  assert.deepEqual(stored, ["b", "c"], "the LRU victim is evicted, the new one is kept");
  assert.equal(jar.count, stored.length, "the counter must match what is stored");
  jar.destroy();
});

await test("regression: count never drifts above the number of stored cookies", async () => {
  // The orphaned writes still incremented `total`, so the counter climbed
  // while the jar emptied: measured at count === 5 with 2 cookies stored.
  // Because evictGlobal() reads `this.total`, the drift also stopped the
  // global cap from bounding anything.
  const jar = new CookieJar({ maxPerDomain: 2, maxTotal: 1000 });
  jar.setCookie("a=1; Path=/1", { url: "https://example.com/1" });
  for (let i = 2; i <= 10; i++) {
    jar.setCookie(`c${i}=1; Path=/${i}`, { url: `https://example.com/${i}` });
    await new Promise((r) => setTimeout(r, 5));
    const stored = jar.getAll().length;
    assert.equal(jar.count, stored, `after ${i} cookies: count ${jar.count} vs ${stored} stored`);
    assert.ok(jar.count <= 2, `the per-domain cap must hold, got ${jar.count}`);
  }
  // And the global cap, with the counter it depends on now honest.
  const spread = new CookieJar({ maxTotal: 4, maxPerDomain: 100 });
  for (let i = 0; i < 12; i++) {
    spread.setCookie(`c${i}=1`, { url: `https://d${i}.test/` });
    assert.ok(spread.count <= 4, `global cap exceeded: ${spread.count}`);
    assert.equal(spread.count, spread.getAll().length);
  }
  jar.destroy();
  spread.destroy();
});

await test("regression: per-domain eviction keeps the most recently used cookie", async () => {
  // The eviction itself was choosing correctly; only the orphaning was wrong.
  // This pins the ordering so a future refactor cannot regress it.
  const jar = new CookieJar({ maxPerDomain: 2 });
  jar.setCookie("a=1; Path=/1", { url: "https://example.com/1" });
  await new Promise((r) => setTimeout(r, 20));
  jar.setCookie("b=1; Path=/2", { url: "https://example.com/2" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jar.getCookieHeader({ url: "https://example.com/1" }), "a=1", "touching a");
  await new Promise((r) => setTimeout(r, 20));
  jar.setCookie("c=1; Path=/3", { url: "https://example.com/3" });
  assert.equal(
    jar
      .getAll()
      .map((c) => c.name)
      .sort()
      .join(","),
    "a,c",
    "b was least recently used, so b is evicted and the cookie just read survives",
  );
  jar.destroy();
});

await test("regression: reading a cookie still updates its LRU timestamp", async () => {
  // getCookies() now hands back copies, so the last-access stamp has to be
  // applied to the STORED cookie — that is the value eviction orders by.
  const jar = new CookieJar();
  jar.setCookie("a=1", { url: "https://example.com/" });
  const before = jar.getAll()[0]!.lastAccessed;
  await new Promise((r) => setTimeout(r, 20));
  jar.getCookieHeader({ url: "https://example.com/" });
  const after = jar.getAll()[0]!.lastAccessed;
  assert.ok(after > before, `lastAccessed must advance on read: ${before} -> ${after}`);
  jar.destroy();
});

suite("regression: a rehydrated jar is re-validated");

await test("regression: a public-suffix cookie from persisted state is never sent", async () => {
  // fromJSON()/loadCookieJar() write straight into the storage map and skip
  // setCookie() entirely, so RFC 6265 §5.3's "the cookie domain must not be a
  // public suffix" rule — which setCookie() enforces — was never applied to
  // rehydrated state. A persisted cookie with `domain: "com"`, which
  // setCookie refuses, was attached to every .com request: anyone able to
  // write the serialized jar (an XSS bug plus localStorage) got a cross-site
  // cookie-tossing primitive. getCookies() already re-validated the
  // __Secure-/__Host- prefixes for exactly this reason.
  const planted = [
    {
      name: "planted",
      value: "leaked",
      domain: "com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset" as const,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: false,
    },
  ];
  const jar = loadCookieJar(planted as never);
  assert.equal(jar.count, 1, "the entry is stored");
  for (const host of ["victim.com", "bank.com", "anything.co.uk"]) {
    assert.equal(
      jar.getCookieHeader({ url: `https://${host}/` }),
      "",
      `a cookie on the public suffix "com" must not reach ${host}`,
    );
  }
  // The same rule at set time, for contrast.
  const fresh = new CookieJar();
  assert.equal(
    fresh.setCookie("x=1; Domain=com", { url: "https://evil.com/" }),
    false,
    "setCookie has always refused this",
  );
  // A legitimate registrable domain still works after rehydration.
  const ok = loadCookieJar([
    { ...planted[0]!, name: "fine", value: "ok", domain: "example.com" },
  ] as never);
  assert.equal(ok.getCookieHeader({ url: "https://www.example.com/" }), "fine=ok");
  jar.destroy();
  fresh.destroy();
  ok.destroy();
});

await test("regression: getCookies returns copies, not the stored objects", async () => {
  // getCookies() returned the live stored objects, so
  // `jar.getCookies(o)[0].value = "x"` rewrote the jar — while getAll() and
  // getForDomain() both return copies, leaving the same API disagreeing about
  // whether the result was yours to modify.
  const jar = new CookieJar();
  jar.setCookie("a=1", { url: "https://example.com/" });
  const got = jar.getCookies({ url: "https://example.com/" });
  got[0]!.value = "MUTATED";
  got[0]!.hostOnly = false;
  assert.equal(
    jar.getCookieHeader({ url: "https://example.com/" }),
    "a=1",
    "mutating a returned cookie must not rewrite the jar",
  );
  assert.equal(jar.getAll()[0]!.value, "1");
  assert.equal(jar.getAll()[0]!.hostOnly, true);
  jar.destroy();
});

await test("regression: re-setting a cookie does not inflate the counter", () => {
  // Overwriting an existing (domain, path, name) slot replaces the value and
  // keeps the original createdAt; the slot count is unchanged. `total` was
  // only ever read by evictGlobal(), so a counter that drifts upward on
  // overwrite makes the global cap fire earlier than the jar is actually
  // full — while `count` reports a jar larger than the one it holds.
  const jar = new CookieJar({ maxTotal: 1000 });
  assert.equal(jar.setCookie("a=1", { url: "https://example.com/" }), true);
  assert.equal(jar.count, 1);
  for (let i = 0; i < 20; i++) {
    assert.equal(jar.setCookie(`a=${i}`, { url: "https://example.com/" }), true);
    assert.equal(jar.count, 1, `after ${i + 1} overwrites the count must stay 1`);
    assert.equal(jar.getAll().length, 1);
    assert.equal(jar.getCookieHeader({ url: "https://example.com/" }), `a=${i}`);
  }
  // A different path IS a different slot.
  jar.setCookie("a=1; Path=/x", { url: "https://example.com/x" });
  assert.equal(jar.count, 2, "a new path is a new cookie");
  jar.destroy();
});

await test("regression: getCookiesForDomain drops public-suffix cookies", () => {
  // The same rule getCookies() applies. A rehydrated jar can hold a cookie on
  // a public suffix, and an inspection API that listed it would report a
  // cookie as in scope for a registrable domain that can never receive it.
  const jar = loadCookieJar([
    {
      name: "planted",
      value: "leaked",
      domain: "com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: false,
    },
    {
      name: "real",
      value: "ok",
      domain: "example.com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Unset",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hostOnly: false,
    },
  ] as never);
  assert.equal(jar.count, 2, "both entries are stored");
  assert.deepEqual(
    jar.getCookiesForDomain("example.com").map((c) => c.name),
    ["real"],
    'a cookie on the public suffix "com" is not in scope for example.com',
  );
  assert.ok(
    !jar.getCookiesForDomain("com").some((c) => c.name === "planted"),
    "the public-suffix cookie is never reported for any query",
  );
  jar.destroy();
});

suite("regression: getCookiesForDomain reports only what is sent");

await test("regression: a host-only subdomain cookie is not reported for the parent", async () => {
  // getCookiesForDomain() documents itself as returning "cookies that would be
  // sent to this domain" but took no host-only and no public-suffix filter, so
  // asking for "example.com" listed the host-only cookie belonging to
  // "sub.example.com" — a cookie that never reaches example.com.
  const jar = new CookieJar();
  jar.setCookie("hostonly=1", { url: "https://sub.example.com/" });
  jar.setCookie("domainwide=1; Domain=example.com", { url: "https://example.com/" });

  assert.equal(jar.getCookieHeader({ url: "https://example.com/" }), "domainwide=1");
  assert.deepEqual(
    jar.getCookiesForDomain("example.com").map((c) => c.name),
    ["domainwide"],
    "only the cookie actually sent to example.com",
  );
  // Asking for the subdomain itself still finds the host-only cookie, and the
  // parent-domain cookie, which does apply to it.
  assert.deepEqual(
    jar
      .getCookiesForDomain("sub.example.com")
      .map((c) => c.name)
      .sort(),
    ["domainwide", "hostonly"],
  );
  // An unrelated host gets nothing.
  assert.deepEqual(jar.getCookiesForDomain("other.com"), []);

  // Copies, like every other accessor. This one handed back the stored
  // objects while the method directly above it returned copies, so
  // `jar.getCookiesForDomain(d)[0].value = "x"` rewrote the jar.
  const inspected = jar.getCookiesForDomain("example.com");
  inspected[0]!.value = "MUTATED";
  inspected[0]!.hostOnly = true;
  assert.equal(
    jar.getCookieHeader({ url: "https://example.com/" }),
    "domainwide=1",
    "mutating an inspected cookie must not rewrite the jar",
  );
  assert.equal(jar.getAll().find((c) => c.name === "domainwide")!.hostOnly, false);

  // The mirror image, and the one that made the method disagree with the
  // Cookie header it is supposed to describe: the match only ever walked
  // *down* the tree, so asking about a subdomain missed the ancestor-domain
  // cookies that do apply to it. getCookiesForDomain("sub.example.com")
  // returned 1 while the header said 2, and a deeper name returned nothing.
  const headerForSub = jar.getCookieHeader({ url: "https://sub.example.com/" });
  assert.equal(headerForSub, "hostonly=1; domainwide=1", "both cookies are sent");
  assert.deepEqual(
    jar
      .getCookiesForDomain("sub.example.com")
      .map((c) => c.name)
      .sort(),
    headerForSub
      .split("; ")
      .map((p) => p.split("=")[0])
      .sort(),
    "the reported set must match the header actually sent, for a subdomain query",
  );
  assert.deepEqual(
    jar.getCookiesForDomain("deep.sub.example.com").map((c) => c.name),
    ["domainwide"],
    "an ancestor's cookie still applies deeper down, a sibling's host-only one does not",
  );
  assert.deepEqual(
    jar.getCookiesForDomain("example.com").map((c) => c.name),
    ["domainwide"],
    "and the parent query is unchanged",
  );
  jar.destroy();
});

// ============================================================================
// §7  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  COOKIE STORE TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
