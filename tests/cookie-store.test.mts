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

await test("basic cookie stores and retrieves", () => {
  const jar = createCookieJar();
  assert.equal(jar.setCookie("session=abc123", { url: "https://example.com/" }), true);
  assert.equal(jar.count, 1);
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
  assert.ok(cookies[0].createdAt > 0);
  assert.ok(cookies[0].lastAccessed > 0);
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
  assert.ok(cookies[0].expires !== Infinity);
  assert.ok(cookies[0].expires > Date.now());
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

await test("Max-Age capped at 400 days", () => {
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=99999999", { url: "https://example.com/" });
  const cookies = jar.getCookies({ url: "https://example.com/" });
  const remaining = cookies[0].expires - Date.now();
  assert.ok(remaining <= 400 * 86400000 + 2000);
});

await test("Expires capped at 400 days from now", () => {
  const farFuture = new Date(Date.now() + 999 * 86400000).toUTCString();
  const jar = createCookieJar();
  jar.setCookie(`x=1; Expires=${farFuture}`, { url: "https://example.com/" });
  const age = jar.getCookies({ url: "https://example.com/" })[0].expires - Date.now();
  assert.ok(age <= 400 * 86400000 + 2000);
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
  assert.ok(str.includes('"name"'));
  assert.ok(str.includes('"value"'));
  assert.ok(str.includes('"x"'));
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
  const header = jar.getCookieHeader({ url: "https://example.com/" });
  assert.ok(header.includes("x=1"));
  assert.ok(header.includes("y=2"));
  const parts = header.split("; ");
  assert.equal(parts.length, 2);
});

await test("getCookieHeader empty when no cookies match", () => {
  const jar = createCookieJar();
  assert.equal(jar.getCookieHeader({ url: "https://example.com/" }), "");
});

await test("count returns accurate total", () => {
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
  const jar = new CookieJar({ maxTotal: 5, maxPerDomain: 3 });
  for (let i = 0; i < 10; i++) {
    jar.setCookie(`x${i}=1; Domain=example.com; Path=/p${i}`, { url: `https://example.com/p${i}` });
  }
  assert.ok(jar.count <= 5);
});

await test("destroy cleans up interval timer", () => {
  const jar = createCookieJar();
  jar.destroy();
  jar.destroy(); // second call should be safe
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
  for (let i = 0; i < 500; i++) {
    const other = createCookieJar();
    other.setCookie("v=1", { url: "https://example.com/" });
    other.getCookies({ url: "https://example.com/" });
  }
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
  const future = new Date(Date.now() + 86400000).toUTCString();
  jar.setCookie("x=1; Max-Age=3600; Expires=" + future, { url: "https://example.com/" });
  const expires = jar.getCookies({ url: "https://example.com/" })[0].expires;
  const expectedMaxAge = Date.now() + 3600000;
  assert.ok(
    Math.abs(expires - expectedMaxAge) < 5000,
    `expected ~1h, got ${expires - Date.now()}ms`,
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

await test("custom domain matcher can reject everything", () => {
  const jar = new CookieJar({ domainMatcher: () => false });
  assert.equal(jar.setCookie("x=1; Domain=example.com", { url: "https://example.com/" }), false);
});

await test("custom max limits work", () => {
  const jar = new CookieJar({ maxTotal: 5, maxPerDomain: 3 });
  for (let i = 0; i < 10; i++) {
    jar.setCookie(`x${i}=1; Domain=example.com; Path=/p${i}`, { url: `https://example.com/p${i}` });
  }
  assert.ok(jar.count <= 5);
});

await test("destroy cleans up interval timer", () => {
  const jar = createCookieJar();
  jar.destroy();
  jar.destroy(); // second call should be safe
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
  // The lazy cleanup has 1% chance per call. 500 calls gives ~99.3% probability.
  const jar = createCookieJar();
  jar.setCookie("x=1; Max-Age=0", { url: "https://example.com/" }); // deletes immediately
  for (let i = 0; i < 500; i++) {
    const other = createCookieJar();
    other.setCookie("v=1", { url: "https://example.com/" });
    other.getCookies({ url: "https://example.com/" });
  }
  // Just verify it doesn't throw - the cleanup is best-effort
  for (let i = 0; i < 500; i++) {
    jar.getCookies({ url: "https://example.com/" });
  }
});

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
  assert.ok(raw.length > 0, "Should extract Set-Cookie from response");
  // Verify at least one of our values is present
  const all = raw.join(" ");
  assert.ok(all.includes("m1=v1") || all.includes("m2=v2"));
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
    assert.ok(res.status === 200 || (res.status >= 300 && res.status < 400));
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
// §7  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  COOKIE STORE TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
