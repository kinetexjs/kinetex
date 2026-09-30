/**
 * cookie.test.mts
 *
 * Strict tests for cookie parsing and handling.
 */

import assert from "node:assert/strict";
import {
  parseCookieDate,
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  canonicalizeDomainFull,
  domainMatch,
  defaultPath,
  pathMatch,
  parseSetCookieHeader,
  splitSetCookieHeaders,
} from "../src/cookie-parser.ts";

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

// ============================================================================
// §1  COOKIE DATE PARSING
// ============================================================================

suite("Cookie Date Parsing");

await test("parseCookieDate parses real RFC 6265 date", async () => {
  // Was `assert.notEqual(date, null)` + `assert.ok(date > 0)`, which any
  // non-zero timestamp satisfies — a parser returning the epoch, or the wrong
  // day entirely, passed. Pin the exact instant.
  assert.equal(parseCookieDate("Wed, 21 Oct 2015 07:28:00 GMT"), Date.UTC(2015, 9, 21, 7, 28, 0));
  assert.equal(parseCookieDate("Wed, 21 Oct 2015 07:28:00 GMT"), 1445412480000);
  // The day name must not shift the date: 21 Oct 2015 was a Wednesday, so a
  // parser that used it as authoritative would agree here and disagree
  // elsewhere.
  assert.equal(parseCookieDate("Thu, 21 Oct 2015 07:28:00 GMT"), Date.UTC(2015, 9, 21, 7, 28, 0));
});

await test("parseCookieDate returns null for invalid date", async () => {
  // Not just the one string: every shape that must not assemble into a date.
  for (const bad of [
    "Invalid Date",
    "",
    "   ",
    "not a date at all",
    "01-01-2025", // no time
    "Jan 2025 00:00:00", // no day
    "01 Jan 00:00:00", // no year
  ]) {
    assert.equal(parseCookieDate(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

// ============================================================================
// §2  PUBLIC SUFFIX LIST
// ============================================================================

suite("Public Suffix List");

await test("getPublicSuffix returns real suffix for example.com", async () => {
  const suffix = getPublicSuffix("www.example.com");
  assert.equal(suffix, "com");
  console.log(`     suffix: ${suffix}`);
});

await test("getPublicSuffix handles real co.uk domain", async () => {
  const suffix = getPublicSuffix("www.example.co.uk");
  assert.equal(suffix, "co.uk");
  console.log(`     suffix: ${suffix}`);
});

await test("getRegistrableDomain returns real domain", async () => {
  const domain = getRegistrableDomain("www.example.com");
  assert.equal(domain, "example.com");
  console.log(`     domain: ${domain}`);
});

await test("isPublicSuffix returns true for public suffix", async () => {
  const result = isPublicSuffix("com");
  assert.equal(result, true);
});

await test("isPublicSuffix returns false for non-public suffix", async () => {
  const result = isPublicSuffix("example.com");
  assert.equal(result, false);
  // A bare TLD is a public suffix; a registrable domain is not. Asserting one
  // without the other leaves the test passing for a function that always
  // returns the same thing.
  assert.equal(isPublicSuffix("com"), true);
  assert.equal(isPublicSuffix("co.uk"), true);
  assert.equal(isPublicSuffix("example.co.uk"), false);
  assert.equal(getRegistrableDomain("example.co.uk"), "example.co.uk");
});

// ============================================================================
// §3  DOMAIN MATCHING
// ============================================================================

suite("Domain Matching");

await test("domainMatch returns true for exact match", async () => {
  const result = domainMatch("example.com", "example.com");
  assert.equal(result, true);
});

await test("domainMatch returns true for subdomain", async () => {
  const result = domainMatch("sub.example.com", "example.com");
  assert.equal(result, true);
});

await test("domainMatch returns false for non-matching domains", async () => {
  assert.equal(domainMatch("example.com", ".other.com"), false);
  // A leading dot is stripped from the cookie domain, and a host written with
  // one still matches because ".example.com" is subdomain-shaped. A URL never
  // produces that form, so this is tolerance rather than a contract.
  assert.equal(domainMatch(".example.com", "example.com"), true);
  assert.equal(domainMatch("a.b.example.com", "example.com"), true);
  // Sibling and parent look-alikes must not match.
  assert.equal(domainMatch("notexample.com", "example.com"), false);
  assert.equal(domainMatch("example.com.evil.net", "example.com"), false);
  assert.equal(domainMatch("example.com", "www.example.com"), false, "a parent is not a subdomain");
  // A public suffix is never a valid cookie domain.
  assert.equal(domainMatch("www.example.com", "com"), false);
  assert.equal(domainMatch("www.example.co.uk", "co.uk"), false);
  // ...and a leading dot must not be a way past that check.
  assert.equal(domainMatch("www.example.com", ".com"), false);
  assert.equal(
    domainMatch("www.example.com", ".example.com"),
    true,
    "RFC 6265 §5.2.3: a leading dot in Domain is ignored",
  );
});

// ============================================================================
// §4  PATH MATCHING
// ============================================================================

suite("Path Matching");

await test("defaultPath returns path for URL", async () => {
  assert.equal(defaultPath("/example/path"), "/example");
  // RFC 6265 §5.1.4: everything up to but not including the right-most "/".
  assert.equal(defaultPath("/example"), "/");
  assert.equal(defaultPath("/"), "/");
  assert.equal(defaultPath("/example/"), "/example");
  assert.equal(defaultPath("/a/b/c"), "/a/b");
  assert.equal(defaultPath(""), "/", "a path that is not slash-prefixed defaults to /");
  assert.equal(defaultPath("relative"), "/");
});

await test("pathMatch returns true for exact path match", async () => {
  const result = pathMatch("/example/path", "/example");
  assert.equal(result, true);
});

await test("pathMatch returns true for subpath", async () => {
  const result = pathMatch("/example/path/sub", "/example");
  assert.equal(result, true);
  // The boundary that makes path scoping meaningful: a shared prefix is not a
  // path match.
  assert.equal(pathMatch("/examples", "/example"), false);
  assert.equal(
    pathMatch("/example", "/example/path"),
    false,
    "a parent path does not match a child",
  );
  assert.equal(pathMatch("/example/other", "/example/path"), false);
  assert.equal(pathMatch("/example/path", "/example"), true);
});

// ============================================================================
// §5  SET-COOKIE PARSING
// ============================================================================

suite("Set-Cookie Parsing");

await test("parseSetCookieHeader parses simple cookie", async () => {
  // Was two field checks plus a console.log, so the other ten fields were
  // never examined. Pin the whole ParsedCookie.
  assert.deepEqual(parseSetCookieHeader("name=value"), {
    name: "name",
    value: "value",
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
});

await test("parseSetCookieHeader parses cookie with attributes", async () => {
  assert.deepEqual(
    parseSetCookieHeader("name=value; Path=/; Domain=example.com; Secure; HttpOnly"),
    {
      name: "name",
      value: "value",
      domain: "example.com",
      path: "/",
      expires: null,
      maxAge: null,
      secure: true,
      httpOnly: true,
      sameSite: "Unset",
      sameParty: false,
      priority: null,
      partitioned: false,
    },
  );
  // The Chrome/CHIPS attributes are on the same object, so assert the whole
  // thing again with them set.
  assert.deepEqual(
    parseSetCookieHeader("n=v; SameParty; Partitioned; Priority=High; SameSite=Strict"),
    {
      name: "n",
      value: "v",
      domain: null,
      path: null,
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: "Strict",
      sameParty: true,
      priority: "High",
      partitioned: true,
    },
  );
});

await test("parseSetCookieHeader parses cookie with expires", async () => {
  const cookie = parseSetCookieHeader("name=value; Expires=Wed, 21 Oct 2015 07:28:00 GMT");
  assert.notEqual(cookie, null);
  // Was `assert.ok(cookie.expires)` — any truthy value passed, including a
  // Date for the wrong day. Pin the exact instant.
  // parseSetCookieHeader yields epoch milliseconds (CookieJar's own Cookie.expires
  // is a Date) — pin the exact instant, not just a truthy value.
  assert.equal(cookie!.expires, 1445412480000);
  assert.equal(cookie!.maxAge, null);
  assert.equal(cookie!.value, "value");
});

await test("parseSetCookieHeader parses cookie with max-age", async () => {
  assert.deepEqual(parseSetCookieHeader("name=value; Max-Age=3600"), {
    name: "name",
    value: "value",
    domain: null,
    path: null,
    expires: null,
    maxAge: 3600,
    secure: false,
    httpOnly: false,
    sameSite: "Unset",
    sameParty: false,
    priority: null,
    partitioned: false,
  });
  // Max-Age wins over Expires: when both are present the date is not parsed.
  const both = parseSetCookieHeader(
    "name=value; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
  );
  assert.equal(both?.maxAge, 60);
  assert.equal(both?.expires, null);
  // Only a bare integer counts.
  assert.equal(parseSetCookieHeader("n=v; Max-Age=abc")?.maxAge, null);
  assert.equal(parseSetCookieHeader("n=v; Max-Age=60.5")?.maxAge, null);
});

await test("parseSetCookieHeader parses cookie with SameSite", async () => {
  assert.equal(parseSetCookieHeader("name=value; SameSite=Strict")?.sameSite, "Strict");
  // Case-insensitive, and the four legal values plus the fallback.
  for (const [input, expected] of [
    ["Lax", "Lax"],
    ["lax", "Lax"],
    ["None", "None"],
    ["none", "None"],
    ["Strict", "Strict"],
    ["strict", "Strict"],
    ["Nonsense", "Unset"],
  ] as const) {
    assert.equal(
      parseSetCookieHeader(`name=value; SameSite=${input}`)?.sameSite,
      expected,
      `SameSite=${input}`,
    );
  }
  // The first occurrence wins.
  assert.equal(
    parseSetCookieHeader("name=value; SameSite=Strict; SameSite=Lax")?.sameSite,
    "Strict",
  );
});

// ============================================================================
// §6  SET-COOKIE HEADER SPLITTING
// ============================================================================

suite("Set-Cookie Header Splitting");

await test("splitSetCookieHeaders splits multiple cookies", async () => {
  // Was `assert.notEqual(headers, null)` — always true for an array — plus a
  // length. Two mangled fragments still have length 2, so assert the values.
  assert.deepEqual(splitSetCookieHeaders("name1=value1; Path=/, name2=value2; Path=/"), [
    "name1=value1; Path=/",
    "name2=value2; Path=/",
  ]);
  // A single cookie is one element, and the Expires comma is not a separator.
  assert.deepEqual(splitSetCookieHeaders("a=1"), ["a=1"]);
  assert.deepEqual(splitSetCookieHeaders("a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT"), [
    "a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
  ]);
  assert.deepEqual(splitSetCookieHeaders(""), []);
});

// ============================================================================
// §7  CANONICALIZATION
// ============================================================================

suite("Canonicalization");

await test("canonicalizeDomainFull canonicalizes domain", async () => {
  assert.equal(canonicalizeDomainFull("Example.COM"), "example.com");
  // The three normalisations it performs, each of which the jar relies on to
  // find a cookie again.
  assert.equal(canonicalizeDomainFull("  Example.COM  ".trim()), "example.com");
  assert.equal(canonicalizeDomainFull(".example.com"), "example.com", "leading dot stripped");
  assert.equal(canonicalizeDomainFull("example.com."), "example.com", "trailing dot stripped");
  assert.equal(canonicalizeDomainFull(".Example.Com."), "example.com", "both stripped");
  assert.equal(canonicalizeDomainFull("xn--n3h.example.com"), "☃.example.com", "punycode decoded");
});

// ============================================================================
// FINAL RESULTS
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`📊 COOKIE TEST RESULTS`);
console.log(`${"=".repeat(60)}`);
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failures.length > 0) {
  console.log(`\n💥 FAILURES:`);
  for (const f of failures) {
    const errMsg = f.err instanceof Error ? f.err.message : String(f.err);
    console.log(`  - ${f.name}: ${errMsg}`);
  }
  process.exit(1);
} else {
  console.log(`\n✅ ALL COOKIE TESTS PASSED`);
  process.exit(0);
}
