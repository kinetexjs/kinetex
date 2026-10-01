import assert from "node:assert/strict";
import { isUpstreamFlake } from "./upstream.ts";
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
    // An outage at httpbin arrives as a failure that says nothing about the
    // client. The discrimination is narrow and never excuses an
    // AssertionError, so it cannot mask a real defect; see
    // tests/upstream-drift.test.mts, which also enforces that this suite has
    // the guard in the first place.
    if (isUpstreamFlake(err)) {
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${why}`);
      return;
    }
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
  // Was `assert.ok(ts !== null)` plus a getUTCFullYear check: any timestamp in
  // 1970 satisfied it, and a null-propagating parser returning 0 would too.
  // The exact epoch is the assertion.
  assert.equal(parseCookieDate("01 Jan 70 00:00:00 GMT"), Date.UTC(1970, 0, 1));
  assert.equal(parseCookieDate("01 Jan 99 00:00:00 GMT"), Date.UTC(1999, 0, 1));
});
await test("2-digit year 00-69 produces 2000s", () => {
  assert.equal(parseCookieDate("01 Jan 30 00:00:00 GMT"), Date.UTC(2030, 0, 1));
  assert.equal(parseCookieDate("01 Jan 00 00:00:00 GMT"), Date.UTC(2000, 0, 1));
  assert.equal(parseCookieDate("01 Jan 69 00:00:00 GMT"), Date.UTC(2069, 0, 1));
});

await test("2-digit year mapping pivots exactly at 69/70", () => {
  // RFC 6265 §5.1.1 step 3: 00-69 -> 2000s, 70-99 -> 1900s. A mapping that
  // used a different pivot would pass both tests above if they only checked
  // "some year in the right century".
  const yearOf = (s: string) => {
    const ts = parseCookieDate(s);
    assert.notEqual(ts, null, `${s} must parse`);
    return new Date(ts).getUTCFullYear();
  };
  assert.equal(yearOf("01 Jan 68 00:00:00 GMT"), 2068);
  assert.equal(yearOf("01 Jan 69 00:00:00 GMT"), 2069);
  assert.equal(yearOf("01 Jan 70 00:00:00 GMT"), 1970);
  assert.equal(yearOf("01 Jan 71 00:00:00 GMT"), 1971);
});

await test("out-of-range components are rejected rather than rolled over", () => {
  // `Date.UTC` silently rolls month 13 into the next year and day 32 into the
  // next month, so an unclamped parser invents a plausible wrong instant
  // instead of refusing. Every one of these must be null.
  for (const bad of [
    "01 Jan 2025 25:00:00 GMT", // hour 25
    "01 Jan 2025 00:60:00 GMT", // minute 60
    "01 Jan 2025 00:00:60 GMT", // second 60
  ]) {
    assert.equal(parseCookieDate(bad), null, `${bad} must be rejected`);
  }
  // A year outside the RFC's 1601-9999 range.
  assert.equal(parseCookieDate("01 Jan 1600 00:00:00 GMT"), null, "1600 is before 1601");
  assert.equal(parseCookieDate("01 Jan 1601 00:00:00 GMT"), Date.UTC(1601, 0, 1));
});

await test("day and month are clamped to the calendar, not rolled into the next month", () => {
  // Day 31 in a 30-day month: Date.UTC(2025, 0, 31) is 31 January (January has
  // 31 days, so this one is real) — use February, which does not.
  assert.equal(parseCookieDate("31 Feb 2025 00:00:00 GMT"), Date.UTC(2025, 1, 31));
  assert.equal(
    new Date(parseCookieDate("31 Feb 2025 00:00:00 GMT") as number).getUTCMonth(),
    2,
    "a day past the end of February lands in March — RFC 6265 only range-checks 1-31, so document that",
  );
});

await test("a garbage string with enough digits does not parse into a date", () => {
  // Tokenizing is lenient, so the danger is a non-date that assembles all four
  // required components. These must all be null.
  for (const bad of ["", "   ", "not a date at all", "0", "00", "99", "1 1 1 1", "GMT"]) {
    assert.equal(parseCookieDate(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
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
// (The two identical "domain exactly equals suffix (co.uk)" tests that stood
// here were byte-for-byte duplicates of the tests above; the second was
// removed rather than renamed.)

await test("getPublicSuffix - falls back to the last label for an unknown TLD", () => {
  // The PSL's default rule: with no matching rule the prevailing rule is "*",
  // so the public suffix is the rightmost label. Untested, and it is the path
  // every brand-new gTLD takes.
  assert.equal(getPublicSuffix("www.example.invalidtld"), "invalidtld");
  assert.equal(getPublicSuffix("a.b.c.example.zzzz"), "zzzz");
  assert.equal(getRegistrableDomain("www.example.invalidtld"), "example.invalidtld");
  assert.equal(isPublicSuffix("invalidtld"), false, "the default rule is not an exact PSL entry");
});

await test("getPublicSuffix is case-insensitive and tolerates surrounding dots", () => {
  assert.equal(getPublicSuffix("WWW.EXAMPLE.CO.UK"), "co.uk");
  assert.equal(getPublicSuffix("www.example.co.uk."), "co.uk");
  assert.equal(getRegistrableDomain("WWW.Example.CO.UK"), "example.co.uk");
  assert.equal(getRegistrableDomain("www.example.co.uk."), "example.co.uk");
  assert.equal(isPublicSuffix("CO.UK"), true);
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
  // Both punycode labels decode: xn--n3h → ☃ and xn--4ek → ㄄
  assert.equal(result, "☃.㄄.example.com");
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

// The next two were the file's largest security hole: the public-suffix
// rejection in domainMatch had no test at all, and a leading dot — the
// spelling RFC 6265 §5.2.3 says to ignore, and this function's own JSDoc
// gives as its example — was compared literally and matched nothing.

await test("domainMatch - rejects a public suffix as the cookie domain", () => {
  // RFC 6265 §5.3: the cookie domain must not be a public suffix. A
  // `Domain=com` cookie must never be sent to any .com host.
  for (const [host, suffix] of [
    ["www.example.com", "com"],
    ["www.example.co.uk", "co.uk"],
    ["a.b.example.com.au", "com.au"],
    ["shop.example.co.jp", "co.jp"],
  ] as const) {
    assert.equal(
      domainMatch(host, suffix),
      false,
      `${host} must not match the public suffix ${suffix}`,
    );
  }
  // ...and a genuine registrable domain still works, so the check is not simply
  // refusing everything.
  assert.equal(domainMatch("www.example.com", "example.com"), true);
  assert.equal(domainMatch("www.example.co.uk", "example.co.uk"), true);
});

await test("domainMatch - a leading dot in the cookie domain is ignored", () => {
  // RFC 6265 §5.2.3: a leading %x2E is ignored. `parseSetCookieHeader` strips
  // it, but this is an exported helper and its JSDoc documents
  // `cookieDomain` as e.g. ".example.com" — which it answered false for, so
  // the common `Domain=.example.com` spelling matched neither the host itself
  // nor any subdomain of it.
  assert.equal(domainMatch("www.example.com", ".example.com"), true);
  assert.equal(domainMatch("example.com", ".example.com"), true);
  assert.equal(domainMatch("a.b.example.com", ".example.com"), true);
  assert.equal(domainMatch("www.example.com", ".EXAMPLE.COM"), true);
  // The dot must not smuggle a suffix past the public-suffix check.
  assert.equal(domainMatch("www.example.com", ".com"), false);
  // And it must not widen the match in the reverse direction.
  assert.equal(domainMatch("example.com", ".www.example.com"), false);
  assert.equal(domainMatch("evilexample.com", ".example.com"), false);
});

await test("domainMatch - is case-insensitive and rejects suffix look-alikes", () => {
  assert.equal(domainMatch("WWW.EXAMPLE.COM", "example.COM"), true);
  // A host that merely ends with the same letters is not a subdomain.
  assert.equal(domainMatch("notexample.com", "example.com"), false);
  assert.equal(domainMatch("example.com.evil.net", "example.com"), false);
});

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

await test("pathMatch - a cookie path with a trailing slash still matches below it", () => {
  // The `/` case: "/foo/" is a prefix of "/foo/bar" but the next character is
  // not "/", so the plain endsWith check would refuse.
  assert.equal(pathMatch("/foo/bar", "/foo/"), true);
  assert.equal(pathMatch("/foo", "/foo/"), true, "normalizePath collapses the trailing slash");
  assert.equal(pathMatch("/foo/bar", "/foo"), true);
  assert.equal(pathMatch("/foobar", "/foo/"), false, "but not a sibling");
});

await test("pathMatch - the root path matches everything", () => {
  for (const p of ["/", "/foo", "/foo/bar", "/foobar"]) {
    assert.equal(pathMatch(p, "/"), true, `${p} must match the root path`);
  }
});

await test("pathMatch - dot segments are resolved on both sides", () => {
  // Without normalisation a cookie scoped to /foo would not match a request
  // for /foo/../foo/bar, and /foo/./bar would not match /foo/bar.
  assert.equal(pathMatch("/foo/../foo/bar", "/foo"), true);
  assert.equal(pathMatch("/foo/bar", "/foo/./bar"), true);
  // Traversal must not widen the match: /foo/../bar resolves to /bar, which is
  // not under /foo.
  assert.equal(pathMatch("/foo/../bar", "/foo"), false);
  assert.equal(pathMatch("/foo/bar", "/foo/../baz"), false);
});

// ============================================================================
// §5  parseSetCookieHeader
// ============================================================================

suite("parseSetCookieHeader");

/** The full ParsedCookie every attribute-bearing test must produce. */
const FULL_SHAPE = {
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
} as const;

await test("basic cookie produces the complete default shape", () => {
  // The rest of this section checked one field each — `?.name`, `?.path`, and
  // so on. Every other attribute could be wrong, or left at whatever the
  // parser happened to initialise, and all of those tests still passed. Pin
  // the whole object.
  assert.deepEqual(parseSetCookieHeader("session=abc123"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc123",
  });
});
await test("with Path", () =>
  assert.deepEqual(parseSetCookieHeader("session=abc123; Path=/"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc123",
    path: "/",
  }));
await test("with Domain", () =>
  assert.deepEqual(parseSetCookieHeader("session=abc123; Domain=example.com"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc123",
    domain: "example.com",
  }));
await test("a leading dot in Domain is stripped", () => {
  // RFC 6265 §5.2.3. A stored `.example.com` would never match anything.
  assert.equal(parseSetCookieHeader("session=abc; Domain=.example.com")?.domain, "example.com");
  assert.equal(parseSetCookieHeader("session=abc; Domain=EXAMPLE.COM")?.domain, "example.com");
  // An empty Domain attribute is ignored, not turned into "".
  assert.equal(parseSetCookieHeader("session=abc; Domain=")?.domain, null);
});
await test("with Secure", () => {
  assert.equal(parseSetCookieHeader("session=abc123; Secure")?.secure, true);
  // The attribute names are case-insensitive, and a valueless flag is still a
  // flag whatever follows an `=`.
  assert.equal(parseSetCookieHeader("session=abc; SECURE")?.secure, true);
  assert.equal(parseSetCookieHeader("session=abc; secure=false")?.secure, true);
  assert.deepEqual(parseSetCookieHeader("session=abc; secure=false"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc",
    secure: true,
  });
});
await test("with HttpOnly", () => {
  assert.equal(parseSetCookieHeader("session=abc123; HttpOnly")?.httpOnly, true);
  assert.equal(parseSetCookieHeader("session=abc; HTTPONLY")?.httpOnly, true);
  assert.deepEqual(parseSetCookieHeader("session=abc; HTTPONLY=1"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc",
    httpOnly: true,
  });
});
await test("SameSite values are case-insensitive", () => {
  for (const v of ["strict", "STRICT", "StRiCt"]) {
    assert.equal(
      parseSetCookieHeader(`session=abc; SameSite=${v}`)?.sameSite,
      "Strict",
      `${v} must parse as Strict`,
    );
  }
  // SameSite=None is the modern cross-site form and is frequently lower-cased.
  assert.equal(parseSetCookieHeader("session=abc; SameSite=none")?.sameSite, "None");
  assert.equal(parseSetCookieHeader("session=abc; SAMESITE=Lax")?.sameSite, "Lax");
});

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
  assert.equal(r?.expires, Date.parse("Wed, 21 Oct 2025 07:28:00 GMT"));
  assert.equal(r?.maxAge, null, "Max-Age must win when present, but it is absent here");
});

await test("Max-Age wins over Expires", () => {
  // RFC 6265 §5.2.2: Max-Age takes precedence. The previous test only covered
  // the Expires-present / Max-Age-absent direction, so an implementation that
  // always parsed Expires, or always preferred Expires, passed the section.
  const r = parseSetCookieHeader("session=abc; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Max-Age=60");
  assert.equal(r?.maxAge, 60);
  assert.equal(
    r?.expires,
    null,
    "Expires must not be parsed once Max-Age is present, or the two can disagree",
  );
  // Order in the header must not matter.
  const r2 = parseSetCookieHeader("session=abc; Max-Age=60; Expires=Wed, 21 Oct 2025 07:28:00 GMT");
  assert.equal(r2?.maxAge, 60);
  assert.equal(r2?.expires, null);
});

await test("Max-Age is only accepted as a bare integer", () => {
  // `^-?\d+$` — no sign-plus, no decimal, no leading word. Anything else is
  // ignored so the cookie falls back to Expires rather than to a wrong number.
  for (const [header, expected] of [
    ["Max-Age=0", 0],
    ["Max-Age=3600", 3600],
    ["Max-Age=-1", -1],
    ["Max-Age= 60 ", 60],
    ["Max-Age=+60", null],
    ["Max-Age=60.5", null],
    ["Max-Age=abc", null],
    ["Max-Age=", null],
  ] as const) {
    assert.equal(
      parseSetCookieHeader(`a=1; ${header}`)?.maxAge,
      expected,
      `${header} must yield ${expected}`,
    );
  }
});
await test("control char in value returns null", () => {
  assert.equal(parseSetCookieHeader("session=\x07test"), null);
});
await test("SameParty attribute", () => {
  const r = parseSetCookieHeader("session=abc; SameParty");
  assert.equal(r?.sameParty, true);
});
await test("Priority attribute", () => {
  for (const [v, expected] of [
    ["High", "High"],
    ["high", "High"],
    ["Medium", "Medium"],
    ["low", "Low"],
    ["bogus", null],
  ] as const) {
    assert.equal(
      parseSetCookieHeader(`session=abc; Priority=${v}`)?.priority,
      expected,
      `Priority=${v}`,
    );
  }
  assert.equal(parseSetCookieHeader("session=abc; Priority=")?.priority, null);
});
await test("Partitioned attribute", () => {
  const r = parseSetCookieHeader("session=abc; Partitioned");
  assert.equal(r?.partitioned, true);
});
await test("unknown attribute is ignored", () => {
  // Not merely "does not return null": the cookie must come back exactly as it
  // would have without the attribute.
  assert.deepEqual(parseSetCookieHeader("session=abc; UnknownAttr=foo"), {
    ...FULL_SHAPE,
    name: "session",
    value: "abc",
  });
});

await test("name and value are trimmed; later equals signs belong to the value", () => {
  assert.equal(parseSetCookieHeader("  spaced  =  value  ")?.name, "spaced");
  assert.equal(parseSetCookieHeader("  spaced  =  value  ")?.value, "value");
  // Base64 padding and JWTs both contain "="; taking only up to the first one
  // would silently truncate the value.
  assert.equal(parseSetCookieHeader("t=YWJjZA==")?.value, "YWJjZA==");
  assert.equal(parseSetCookieHeader("t=a=b=c")?.value, "a=b=c");
  // An empty value is a value, not a missing one.
  assert.equal(parseSetCookieHeader("a=; Secure")?.value, "");
  assert.equal(parseSetCookieHeader("a=; Secure")?.secure, true);
  // Surrounding quotes are stripped once, not repeatedly.
  assert.equal(parseSetCookieHeader('a=""')?.value, "");
  assert.equal(parseSetCookieHeader('a="""')?.value, '"');
  // A single leading quote is data, not a quote pair.
  assert.equal(parseSetCookieHeader('a="x')?.value, '"x');
});

await test("only true control characters are rejected in the value", () => {
  // The validator is deliberately lenient — space and comma are allowed — but
  // a CTL could smuggle a second header through.
  assert.equal(parseSetCookieHeader("a=\x07bell"), null);
  assert.equal(parseSetCookieHeader("a=\x00nul"), null);
  assert.equal(parseSetCookieHeader("a=\x1funit-sep"), null);
  assert.equal(parseSetCookieHeader("a=\x7fdel"), null);
  assert.equal(parseSetCookieHeader("a=\r\nX-Injected: 1"), null);
  // Tab (0x09) and a plain space are inside the accepted range.
  assert.notEqual(parseSetCookieHeader("a=has space"), null);
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

// The cases below are the reason this function exists, and none of them were
// tested: its own doc comment names the Expires comma as "non-trivial", and
// the split condition ("have we seen a value or attribute yet") is true the
// instant the first "=" is read, so it committed on every comma.

await test("an Expires date is not split on its internal comma", () => {
  assert.deepEqual(splitSetCookieHeaders("a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT"), [
    "a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
  ]);
  assert.deepEqual(splitSetCookieHeaders("sid=x; Expires=Wed, 09 Jun 2021 10:18:14 GMT"), [
    "sid=x; Expires=Wed, 09 Jun 2021 10:18:14 GMT",
  ]);
});

await test("a full attribute set with Expires survives intact", () => {
  const raw =
    "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/; Domain=example.com; Secure; HttpOnly";
  assert.deepEqual(splitSetCookieHeaders(raw), [raw]);
  // And the survivor must still parse into a cookie that carries its expiry.
  const [only] = splitSetCookieHeaders(raw);
  const parsed = parseSetCookieHeader(only as string);
  assert.equal(parsed?.name, "sid");
  assert.equal(parsed?.expires, Date.parse("Wed, 09 Jun 2021 10:18:14 GMT"));
  assert.equal(parsed?.domain, "example.com");
  assert.equal(parsed?.secure, true);
  assert.equal(parsed?.httpOnly, true);
});

await test("two collapsed cookies that each carry an Expires split correctly", () => {
  // Both the value comma AND the separator comma are present here, so a fix
  // that merely kept every comma would fail this one.
  assert.deepEqual(
    splitSetCookieHeaders(
      "a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT, b=2; Expires=Fri, 02 Jan 2099 00:00:00 GMT",
    ),
    ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT", "b=2; Expires=Fri, 02 Jan 2099 00:00:00 GMT"],
  );
});

await test("a cookie whose value legitimately contains a comma stays whole", () => {
  // Not quoted, no Expires: still one cookie, because what follows the comma
  // does not open a new `name=` pair.
  assert.deepEqual(splitSetCookieHeaders("a=1, b"), ["a=1, b"]);
  assert.deepEqual(splitSetCookieHeaders("a=1,  b=2 "), ["a=1", "b=2"]);
});

await test("semicolon only returns 1", () => {
  assert.equal(splitSetCookieHeaders("a=b; c=d; e=f").length, 1);
  assert.deepEqual(splitSetCookieHeaders("a=b; c=d; e=f"), ["a=b; c=d; e=f"]);
});
await test("single cookie returns 1", () => {
  assert.equal(splitSetCookieHeaders("key=value").length, 1);
  // A length-only check is satisfied by a truncated fragment, which is exactly
  // the failure this file had.
  assert.deepEqual(splitSetCookieHeaders("key=value"), ["key=value"]);
});
await test("empty string returns 0", () => {
  assert.deepEqual(splitSetCookieHeaders(""), []);
  assert.deepEqual(splitSetCookieHeaders("   "), []);
});
await test("cookie with escaped quote", () => {
  const result = splitSetCookieHeaders('a="b\\"c"');
  assert.equal(result.length, 1);
});

await test("extractSetCookieHeaders - Headers object", () => {
  const h = new Headers({ "set-cookie": "session=abc123" });
  const out = extractSetCookieHeaders(h);
  assert.equal(out.length, 1);
  // The old check was a length, so a single mangled fragment passed.
  assert.deepEqual(out, ["session=abc123"]);
  // The Headers path must carry an Expires date through whole.
  const h2 = new Headers({ "set-cookie": "a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT" });
  assert.deepEqual(extractSetCookieHeaders(h2), ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT"]);
});
await test("extractSetCookieHeaders - Headers object getSetCookie path", () => {
  const h = new Headers({ "set-cookie": "a=1" });
  assert.equal(extractSetCookieHeaders(h).length, 1);
});
await test("extractSetCookieHeaders - plain object", () => {
  assert.deepEqual(extractSetCookieHeaders({ "set-cookie": "session=abc123" }), ["session=abc123"]);
  // A plain record has no getSetCookie(), so it goes through the splitter —
  // this is the path an Expires date was truncated on.
  assert.deepEqual(
    extractSetCookieHeaders({ "set-cookie": "a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT" }),
    ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT"],
  );
  assert.deepEqual(
    extractSetCookieHeaders({ "set-cookie": "a=1, b=2; Expires=Thu, 01 Jan 2099 00:00:00 GMT" }),
    ["a=1", "b=2; Expires=Thu, 01 Jan 2099 00:00:00 GMT"],
  );
  // Both header spellings are accepted.
  assert.deepEqual(extractSetCookieHeaders({ "Set-Cookie": "a=1" }), ["a=1"]);
});
await test("extractSetCookieHeaders - array value", () => {
  assert.deepEqual(extractSetCookieHeaders({ "set-cookie": ["a=1", "b=2"] }), ["a=1", "b=2"]);
  // Each element of the array is a whole header, and each may carry an Expires.
  assert.deepEqual(
    extractSetCookieHeaders({
      "set-cookie": ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT", "b=2"],
    }),
    ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT", "b=2"],
  );
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

await test("formatSetCookieHeader - quotes a value that would otherwise break the header", () => {
  const base = {
    name: "a",
    value: "",
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: "Unset" as const,
    sameParty: false,
    priority: null,
    partitioned: false,
  };
  // A space, a comma or a semicolon in a bare value would make the header
  // parse back as something else entirely.
  assert.equal(formatSetCookieHeader({ ...base, value: "plain" }), "a=plain");
  assert.equal(formatSetCookieHeader({ ...base, value: "has space" }), 'a="has space"');
  assert.equal(formatSetCookieHeader({ ...base, value: "a,b" }), 'a="a,b"');
  assert.equal(formatSetCookieHeader({ ...base, value: 'say "hi"' }), 'a="say \\"hi\\""');
});

await test("formatSetCookieHeader round-trips through parseSetCookieHeader", () => {
  // The strongest form: whatever the formatter emits must parse back to the
  // same cookie, which catches a quoting bug and a parser bug at once.
  const original = {
    name: "session",
    value: "abc 123",
    domain: "example.com",
    path: "/api",
    expires: Date.UTC(2030, 0, 1),
    maxAge: 3600,
    secure: true,
    httpOnly: true,
    sameSite: "Lax" as const,
    sameParty: true,
    priority: "High" as const,
    partitioned: true,
  };
  const round = parseSetCookieHeader(formatSetCookieHeader(original));
  assert.equal(round?.name, original.name);
  assert.equal(round?.value, original.value);
  assert.equal(round?.domain, original.domain);
  assert.equal(round?.path, original.path);
  assert.equal(round?.maxAge, original.maxAge);
  assert.equal(round?.secure, true);
  assert.equal(round?.httpOnly, true);
  assert.equal(round?.sameSite, "Lax");
  assert.equal(round?.sameParty, true);
  assert.equal(round?.priority, "High");
  assert.equal(round?.partitioned, true);
  // Max-Age wins over Expires on the way back in, so `expires` is the one
  // field a round trip cannot preserve — assert that explicitly rather than
  // leaving it to look like an accident.
  assert.equal(round?.expires, null, "Max-Age suppresses Expires, by design");

  // A session cookie round-trips completely.
  const session = { ...original, expires: null, maxAge: null, domain: null, path: null };
  const back = parseSetCookieHeader(formatSetCookieHeader(session));
  assert.deepEqual(back, session);
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

// (An `async function _unused()` with no callers stood here, describing the
// getSetCookie fallback. Removed; the same note is kept where it belongs.)

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
    // Pinned, not "200 or any 3xx": a redirect is a different response shape
    // and was being accepted as equivalent.
    assert.equal(res.status, 200, "the echo endpoint must answer 200");
  }
});

await test("httpbin /response-headers echoes Set-Cookie from params", async () => {
  const res = await client.get("https://httpbin.org/response-headers?Set-Cookie=fake=cookie");
  const setCookies = extractSetCookieHeaders(res.headers);
  assert.equal(setCookies.length, 1);
  assert.equal(setCookies[0], "fake=cookie");
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
  assert.equal(raw.length, 2);
  assert.deepEqual(raw, ["a=1", "b=2"]);
});

// ============================================================================
// §8  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
// ============================================================================
// §9  REGRESSION: SET-COOKIE SPLITTING, DOMAIN MATCHING, VALUE HYGIENE
// ============================================================================

suite("regression: an Expires comma is not a cookie separator");

await test("regression: a persisted cookie keeps its Expires attribute end to end", async () => {
  // `splitSetCookieHeaders` exists because `Expires` values contain commas —
  // that is the first thing its own doc comment says. Its split condition was
  // "have we seen a value or an attribute yet", which is true the instant the
  // first `=` is read, so it committed on EVERY comma. Any persistent cookie
  // was truncated at the day name: `a=1; Expires=Wed, 09 Jun 2021 10:18:14 GMT`
  // became `a=1; Expires=Wed`, silently losing the expiry, and a collapsed
  // two-cookie header was shredded into fragments like
  // `09 Jun 2021 10:18:14 GMT; Path=/; HttpOnly`. Not one of the file's
  // 146 tests used an Expires value.
  const raw = "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Path=/; Secure";
  assert.deepEqual(splitSetCookieHeaders(raw), [raw]);

  const parsed = parseSetCookieHeader(splitSetCookieHeaders(raw)[0] as string);
  assert.equal(parsed?.name, "sid");
  assert.equal(parsed?.expires, Date.parse("Wed, 09 Jun 2021 10:18:14 GMT"));
  assert.equal(parsed?.path, "/");
  assert.equal(parsed?.secure, true);
});

await test("regression: the plain-object extraction path keeps Expires whole", () => {
  // This is the path `HTTPCookieJar` uses (`src/cookie-store.ts`), so the
  // truncation reached the cookie store itself, not just the exported helper.
  const out = extractSetCookieHeaders({
    "set-cookie": "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Domain=example.com",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0], "sid=xyz; Expires=Wed, 09 Jun 2021 10:18:14 GMT; Domain=example.com");
});

await test("regression: separator commas still separate, after the fix", () => {
  // The control: a fix that simply stopped splitting on every comma would
  // merge two real cookies into one.
  assert.deepEqual(splitSetCookieHeaders("a=1, b=2"), ["a=1", "b=2"]);
  assert.deepEqual(splitSetCookieHeaders("a=b; Path=/, c=d"), ["a=b; Path=/", "c=d"]);
  assert.deepEqual(splitSetCookieHeaders("a=1;b=2,c=3"), ["a=1;b=2", "c=3"]);
  assert.deepEqual(
    splitSetCookieHeaders('a="x,y", b=z'),
    ['a="x,y"', "b=z"],
    "a quoted value containing a comma is still one cookie",
  );
  assert.deepEqual(
    splitSetCookieHeaders("a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT, b=2"),
    ["a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT", "b=2"],
    "a value comma followed by a separator comma",
  );
});

suite("regression: domain matching and registrable domains");

await test("regression: `Domain=.example.com` matches its subdomains", () => {
  // RFC 6265 §5.2.3: a leading %x2E is ignored. `domainMatch` compared the
  // strings literally, so the spelling this function's own JSDoc gives as its
  // example returned false for the host itself and for every subdomain —
  // while the public-suffix check two lines below, added for security, was
  // the only reason the function had not been obviously broken.
  for (const host of ["example.com", "www.example.com", "a.b.example.com"]) {
    assert.equal(domainMatch(host, ".example.com"), true, `${host} vs .example.com`);
  }
  // Leading dots must not become a way past the public-suffix check.
  assert.equal(domainMatch("www.example.com", ".com"), false);
  assert.equal(domainMatch("www.example.co.uk", ".co.uk"), false);
  // Nor may they widen the match.
  assert.equal(domainMatch("notexample.com", ".example.com"), false);
});

await test("regression: a trailing dot no longer yields a domain fragment", () => {
  // `getPublicSuffix` stripped the trailing FQDN dot but `getRegistrableDomain`
  // did not, so the two disagreed about the same host and the registrable
  // domain came back as a fragment: "1.2.3.4." -> "4.", "www.example.com." ->
  // "m." A caller using that as a cookie domain is validating against nonsense.
  assert.equal(getRegistrableDomain("www.example.com."), "example.com");
  assert.equal(getRegistrableDomain("a.b.example.com."), "example.com");
  assert.equal(getRegistrableDomain("WWW.Example.COM."), "example.com");
  assert.equal(getRegistrableDomain("1.2.3.4."), "1.2.3.4");
  // Agreement with the other two entry points is the point.
  for (const h of ["www.example.com", "www.example.co.uk", "sub.a.example.com"]) {
    assert.equal(
      getRegistrableDomain(`${h}.`),
      getRegistrableDomain(h),
      `${h}. must agree with ${h}`,
    );
  }
});

await test("regression: IPv6 detection accepts mapped forms and rejects hex look-alikes", () => {
  // The old test was /^[\da-f:]+$/ plus "contains a colon", which is both too
  // loose and too strict. It accepted `abc:123` and `cafe:babe` — a hostname
  // spelled entirely in hex characters — and rejected `::ffff:1.2.3.4`, a
  // real address, for which getRegistrableDomain then returned the fragment
  // "3.4".
  for (const v6 of [
    "::1",
    "::",
    "2001:db8::1",
    "1:2:3:4:5:6:7:8",
    "2001:0db8:0000:0000:0000:ff00:0042:8329",
    "::ffff:1.2.3.4",
    "::ffff:192.168.1.1",
    "64:ff9b::1.2.3.4",
  ]) {
    assert.equal(isIPAddress(v6), true, `${v6} is IPv6`);
  }
  for (const notV6 of [
    "example.com",
    "abc:123",
    "cafe:babe",
    "deadbeef",
    "1.2.3:4",
    "1.2.3.4:80",
    "localhost",
    "1.2.3",
    "256.1.1.1",
  ]) {
    assert.equal(isIPAddress(notV6), false, `${notV6} is not IPv6`);
  }
  // Bracketed literals are still accepted.
  assert.equal(isIPAddress("[::1]"), true);
  assert.equal(isIPAddress("[::ffff:1.2.3.4]"), true);
  // And an IPv4-mapped address is not mistaken for a dotted quad.
  assert.equal(getRegistrableDomain("::ffff:1.2.3.4"), "::ffff:1.2.3.4");
});

suite("regression: control characters at the edge of a value");

await test("regression: a value wrapped in CRLF is rejected, not silently trimmed", () => {
  // `value.trim()` ran before the control-character check, so a CTL at either
  // end was stripped along with the surrounding space and validation could
  // never see it. The interior case was already refused, so the rejection
  // only applied from the second character in.
  assert.equal(parseSetCookieHeader("a=\r\nX-Injected: 1"), null);
  assert.equal(parseSetCookieHeader("a=\nleading-newline"), null);
  assert.equal(parseSetCookieHeader("a=trailing-newline\r\n"), null);
  assert.equal(parseSetCookieHeader("a=\r"), null);
  assert.equal(parseSetCookieHeader("a=\n"), null);
  // The lenient behaviour the library documents is unaffected: spaces, tabs
  // and commas are data, and surrounding whitespace is still trimmed.
  assert.equal(parseSetCookieHeader("  a  =  value  ")?.value, "value");
  assert.equal(parseSetCookieHeader("a=has space")?.value, "has space");
  assert.equal(parseSetCookieHeader("a=has\ttab")?.value, "has\ttab");
  assert.equal(parseSetCookieHeader("a=has,comma")?.value, "has,comma");
});

console.log(`\n${"=".repeat(60)}`);
console.log(
  `  COOKIE PARSER TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
