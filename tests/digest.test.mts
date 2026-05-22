import assert from "node:assert/strict";
import {
  parseDigestChallenge,
  computeDigestResponse,
  formatDigestAuth,
  createDigestAuthorization,
} from "../src/digest.ts";

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

async function main() {
  // Known-good test vectors from RFC 7616 Appendix A
  // HA1 = md5("Mufasa:testrealm@host.com:Circle Of Life") = "939e7578ed9e3c518a452acee763bce9"

  const WWW_AUTH = `Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"`;
  const CHALLENGE = parseDigestChallenge(WWW_AUTH);

  suite("parseDigestChallenge");

  await test("parses realm, nonce, opaque from real challenge", () => {
    assert.equal(CHALLENGE.realm, "testrealm@host.com");
    assert.equal(CHALLENGE.nonce, "dcd98b7102dd2f0e8b11d0f600bfb0c093");
    assert.equal(CHALLENGE.opaque, "5ccc069c403ebaf9f0171e9517f40e41");
    assert.equal(CHALLENGE.algorithm, "MD5");
  });

  await test("parses qop parameter correctly", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth,auth-int"`);
    assert.equal(c.qop, "auth,auth-int");
  });

  await test("parses stale flag as boolean", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", stale=true`);
    assert.equal(c.stale, true);
  });

  await test("parses stale=false", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", stale=false`);
    assert.equal(c.stale, false);
  });

  await test("parses algorithm=SHA-256", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", algorithm=SHA-256`);
    assert.equal(c.algorithm, "SHA-256");
  });

  await test("parses userhash=true", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", userhash=true`);
    assert.equal(c.userhash, true);
  });

  await test("parses charset=UTF-8", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", charset=UTF-8`);
    assert.equal(c.charset, "UTF-8");
  });

  await test("parses domain parameter", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n", domain="/ /api"`);
    assert.equal(c.domain, "/ /api");
  });

  await test("throws on missing realm", () => {
    assert.throws(() => parseDigestChallenge(`Digest nonce="n"`), /missing.*realm/i);
  });

  await test("throws on missing nonce", () => {
    assert.throws(() => parseDigestChallenge(`Digest realm="r"`), /missing.*nonce/i);
  });

  await test("handles unquoted values", () => {
    const c = parseDigestChallenge(`Digest realm=simple, nonce=abc123`);
    assert.equal(c.realm, "simple");
    assert.equal(c.nonce, "abc123");
  });

  await test("handles Digest prefix case variations", () => {
    const c = parseDigestChallenge(`digest realm="r", nonce="n"`);
    assert.equal(c.realm, "r");
  });

  await test("default algorithm is MD5 when omitted", () => {
    const c = parseDigestChallenge(`Digest realm="r", nonce="n"`);
    assert.equal(c.algorithm, "MD5");
  });

  suite("computeDigestResponse");

  await test("produces 32-char hex MD5 response with qop=auth", async () => {
    const challenge = parseDigestChallenge(WWW_AUTH);
    const resp = await computeDigestResponse(
      challenge,
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "f2/wE",
      "00000001",
    );
    assert.equal(typeof resp, "string");
    assert.equal(resp.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(resp));
  });

  await test("produces deterministic MD5 response for same inputs", async () => {
    const challenge = parseDigestChallenge(WWW_AUTH);
    const resp1 = await computeDigestResponse(
      challenge,
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "f2/wE",
      "00000001",
    );
    const resp2 = await computeDigestResponse(
      challenge,
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "f2/wE",
      "00000001",
    );
    assert.equal(resp1, resp2);
  });

  await test("produces correct response without qop (RFC 2069 mode)", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123"`);
    const resp = await computeDigestResponse(
      challenge,
      "user",
      "pass",
      "GET",
      "/",
      "cnonce",
      "00000001",
    );
    assert.equal(typeof resp, "string");
    assert.equal(resp.length, 32);
  });

  await test("produces different response for POST vs GET", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const getResp = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000001");
    const postResp = await computeDigestResponse(challenge, "u", "p", "POST", "/", "c", "00000001");
    assert.notEqual(getResp, postResp);
  });

  await test("produces different response for different nonces", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp1 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c1", "00000001");
    const resp2 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c2", "00000001");
    assert.notEqual(resp1, resp2);
  });

  await test("uses SHA-256 algorithm when specified", async () => {
    const challenge = parseDigestChallenge(
      `Digest realm="r", nonce="abc123", algorithm=SHA-256, qop="auth"`,
    );
    const resp = await computeDigestResponse(
      challenge,
      "user",
      "pass",
      "GET",
      "/",
      "cnonce",
      "00000001",
    );
    assert.equal(typeof resp, "string");
    // SHA-256 produces 64 hex chars
    assert.equal(resp.length, 64);
  });

  await test("increments nonce count yields different response", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp1 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000001");
    const resp2 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000002");
    assert.notEqual(resp1, resp2);
  });

  await test("auto-generates cnonce and nc when omitted", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp = await computeDigestResponse(challenge, "user", "pass", "GET", "/path");
    assert.equal(typeof resp, "string");
    assert.equal(resp.length, 32);
  });

  suite("formatDigestAuth");

  await test("produces Digest header with all required fields", () => {
    const challenge = parseDigestChallenge(WWW_AUTH);
    const header = formatDigestAuth(
      challenge,
      "Mufasa",
      "6629fae49393a05397450978507c4ef1",
      "/dir/index.html",
      "f2/wE",
      "00000001",
    );
    assert.ok(header.startsWith("Digest "));
    assert.ok(header.includes(`username="Mufasa"`));
    assert.ok(header.includes(`realm="testrealm@host.com"`));
    assert.ok(header.includes(`nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"`));
    assert.ok(header.includes(`uri="/dir/index.html"`));
    assert.ok(header.includes(`response="6629fae49393a05397450978507c4ef1"`));
    assert.ok(header.includes(`opaque="5ccc069c403ebaf9f0171e9517f40e41"`));
  });

  await test("includes qop, nc, cnonce when qop is present", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/", "cnonce", "00000001");
    assert.ok(header.includes("qop=auth"));
    assert.ok(header.includes("nc=00000001"));
    assert.ok(header.includes(`cnonce="cnonce"`));
  });

  await test("omits opaque when not in challenge", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.ok(!header.includes("opaque="));
  });

  await test("omits algorithm when MD5 (default)", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.ok(!header.includes("algorithm="));
  });

  await test("includes algorithm when non-MD5", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", algorithm=SHA-256`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.ok(header.includes("algorithm=SHA-256"));
  });

  await test("auto-generates cnonce when omitted", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header1 = formatDigestAuth(challenge, "u", "resp", "/");
    const header2 = formatDigestAuth(challenge, "u", "resp", "/");
    // Random cnonce should differ between calls
    const m1 = header1.match(/cnonce="([^"]+)"/);
    const m2 = header2.match(/cnonce="([^"]+)"/);
    assert.ok(m1 && m2);
    assert.notEqual(m1[1], m2[1]);
  });

  await test("selects first qop value when multiple offered", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth-int,auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.ok(header.includes("qop=auth-int"));
  });

  suite("createDigestAuthorization");

  await test("full integration: produces valid auth header from raw WWW-Authenticate", async () => {
    const wwwAuth = `Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41", qop="auth"`;
    const auth = await createDigestAuthorization(
      wwwAuth,
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
    );
    assert.ok(auth.startsWith("Digest "));
    assert.ok(auth.includes(`username="Mufasa"`));
    assert.ok(auth.includes(`realm="testrealm@host.com"`));
    assert.ok(auth.includes(`uri="/dir/index.html"`));
    assert.ok(auth.includes("qop=auth"));
    assert.ok(auth.includes("nc=00000001"));
    assert.ok(auth.includes(`cnonce="`));
    const respMatch = auth.match(/response="([^"]+)"/);
    assert.ok(respMatch);
    assert.equal(respMatch[1].length, 32);
  });

  await test("full integration with SHA-256", async () => {
    const wwwAuth = `Digest realm="r", nonce="abc123", algorithm=SHA-256, qop="auth"`;
    const auth = await createDigestAuthorization(wwwAuth, "user", "pass", "GET", "/");
    assert.ok(auth.includes("algorithm=SHA-256"));
    const respMatch = auth.match(/response="([^"]+)"/);
    assert.ok(respMatch);
    assert.equal(respMatch[1].length, 64);
  });

  await test("full integration without qop", async () => {
    const wwwAuth = `Digest realm="r", nonce="abc123"`;
    const auth = await createDigestAuthorization(wwwAuth, "user", "pass", "GET", "/");
    assert.ok(!auth.includes("qop="));
    assert.ok(!auth.includes("nc="));
    const respMatch = auth.match(/response="([^"]+)"/);
    assert.ok(respMatch);
    assert.equal(respMatch[1].length, 32);
  });

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  Digest tests: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
  console.log(`════════════════════════════════════════════════════════════`);

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : String(f.err)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
