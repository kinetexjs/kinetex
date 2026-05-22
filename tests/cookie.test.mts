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
  const date = parseCookieDate("Wed, 21 Oct 2015 07:28:00 GMT");
  assert.notEqual(date, null);
  assert.ok(date > 0);
  console.log(`     date parsed: ${date}`);
});

await test("parseCookieDate returns null for invalid date", async () => {
  const date = parseCookieDate("Invalid Date");
  assert.equal(date, null);
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
  const result = domainMatch("example.com", ".other.com");
  assert.equal(result, false);
});

// ============================================================================
// §4  PATH MATCHING
// ============================================================================

suite("Path Matching");

await test("defaultPath returns path for URL", async () => {
  const path = defaultPath("/example/path");
  assert.equal(path, "/example");
  console.log(`     path: ${path}`);
});

await test("pathMatch returns true for exact path match", async () => {
  const result = pathMatch("/example/path", "/example");
  assert.equal(result, true);
});

await test("pathMatch returns true for subpath", async () => {
  const result = pathMatch("/example/path/sub", "/example");
  assert.equal(result, true);
});

// ============================================================================
// §5  SET-COOKIE PARSING
// ============================================================================

suite("Set-Cookie Parsing");

await test("parseSetCookieHeader parses simple cookie", async () => {
  const cookie = parseSetCookieHeader("name=value");
  assert.notEqual(cookie, null);
  assert.equal(cookie.name, "name");
  assert.equal(cookie.value, "value");
  console.log(`     cookie: ${JSON.stringify(cookie)}`);
});

await test("parseSetCookieHeader parses cookie with attributes", async () => {
  const cookie = parseSetCookieHeader("name=value; Path=/; Domain=example.com; Secure; HttpOnly");
  assert.notEqual(cookie, null);
  assert.equal(cookie.name, "name");
  assert.equal(cookie.value, "value");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.domain, "example.com");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  console.log(`     cookie with attributes parsed`);
});

await test("parseSetCookieHeader parses cookie with expires", async () => {
  const cookie = parseSetCookieHeader("name=value; Expires=Wed, 21 Oct 2015 07:28:00 GMT");
  assert.notEqual(cookie, null);
  assert.ok(cookie.expires);
  console.log(`     cookie with expires parsed`);
});

await test("parseSetCookieHeader parses cookie with max-age", async () => {
  const cookie = parseSetCookieHeader("name=value; Max-Age=3600");
  assert.notEqual(cookie, null);
  assert.equal(cookie.maxAge, 3600);
});

await test("parseSetCookieHeader parses cookie with SameSite", async () => {
  const cookie = parseSetCookieHeader("name=value; SameSite=Strict");
  assert.notEqual(cookie, null);
  assert.equal(cookie.sameSite, "Strict");
});

// ============================================================================
// §6  SET-COOKIE HEADER SPLITTING
// ============================================================================

suite("Set-Cookie Header Splitting");

await test("splitSetCookieHeaders splits multiple cookies", async () => {
  const headers = splitSetCookieHeaders("name1=value1; Path=/, name2=value2; Path=/");
  assert.notEqual(headers, null);
  assert.equal(headers.length, 2);
  console.log(`     headers split: ${headers.length} cookies`);
});

// ============================================================================
// §7  CANONICALIZATION
// ============================================================================

suite("Canonicalization");

await test("canonicalizeDomainFull canonicalizes domain", async () => {
  const canonical = canonicalizeDomainFull("Example.COM");
  assert.equal(canonical, "example.com");
  console.log(`     canonical domain: ${canonical}`);
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
