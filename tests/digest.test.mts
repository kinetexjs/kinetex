import assert from "node:assert/strict";
import {
  parseDigestChallenge,
  computeDigestResponse,
  formatDigestAuth,
  createDigestAuthorization,
  createDigestAuthorizer,
  computeUsernameStar,
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

/**
 * An independent implementation of RFC 7230 §3.2.6 quoted-string escaping,
 * used to state the expected header shape. Deliberately *not* shared with
 * `src/digest.ts` — a test that reused the implementation's own helper would
 * pass no matter what that helper did.
 */
function q(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
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
    assert.equal(resp.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(resp));
    // HA1 = md5("Mufasa:testrealm@host.com:Circle Of Life")
    //     = 939e7578ed9e3c518a452acee763bce9
    // HA2 = md5("GET:/dir/index.html")
    // response = md5(HA1:nonce:nc:cnonce:auth:HA2)
    assert.equal(resp, "670fd8c2df070c60b045671b8b24ff02");
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
    // RFC 2069 mode: response = H(HA1:nonce:HA2) — nc and cnonce are not
    // part of the digest at all, so the values passed here must not change it.
    assert.equal(resp, "1ecb81fef95a43a93c30bcab4be6f71b");
    const ignored = await computeDigestResponse(
      challenge,
      "user",
      "pass",
      "GET",
      "/",
      "totally-different",
      "deadbeef",
    );
    assert.equal(ignored, "1ecb81fef95a43a93c30bcab4be6f71b");
  });

  await test("produces different response for POST vs GET", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const getResp = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000001");
    const postResp = await computeDigestResponse(challenge, "u", "p", "POST", "/", "c", "00000001");
    assert.equal(getResp, "1f12c4d3e87088764f420b90007dfe32");
    assert.equal(postResp, "8f421e478fcf537b5157acbf7f6458f0");
  });

  await test("produces different response for different cnonces", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp1 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c1", "00000001");
    const resp2 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c2", "00000001");
    assert.equal(resp1, "fa55c75c4452c64c6dc81fe765a29b41");
    assert.equal(resp2, "7c20e51ecebb53207b89712dc3d62ecb");
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
    // SHA-256 produces 64 hex chars
    assert.equal(resp.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(resp));
    assert.equal(resp, "c3ce6608434199653e2d9184f6254ac604c868cb27b99d4f49bacdb2da488848");
    // The MD5 response for the same inputs is a different, 32-char value.
    const md5Resp = await computeDigestResponse(
      parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`),
      "user",
      "pass",
      "GET",
      "/",
      "cnonce",
      "00000001",
    );
    assert.equal(md5Resp, "6777d127c2290d76a491614ea911e232");
  });

  await test("increments nonce count yields different response", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp1 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000001");
    const resp2 = await computeDigestResponse(challenge, "u", "p", "GET", "/", "c", "00000002");
    assert.equal(resp1, "1f12c4d3e87088764f420b90007dfe32");
    assert.equal(resp2, "f26be5006f5e6cbfd2a841ed491a4be8");
  });

  await test("auto-generates cnonce and nc when omitted", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="abc123", qop="auth"`);
    const resp = await computeDigestResponse(challenge, "user", "pass", "GET", "/path");
    // The cnonce is random, so only its shape is pinnable here.
    assert.equal(resp.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(resp));
    // Two calls must not collide — a fixed default cnonce would pass every
    // other test in this file while defeating replay protection.
    const again = await computeDigestResponse(challenge, "user", "pass", "GET", "/path");
    assert.notEqual(resp, again);
    // With the cnonce and nc that formatDigestAuth generates by default fixed,
    // the digest is exact.
    assert.equal(
      await computeDigestResponse(
        challenge,
        "user",
        "pass",
        "GET",
        "/path",
        "0011223344",
        "00000001",
      ),
      "1e85d8198f3dea732d0d5020f9dff2f4",
    );
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
    assert.equal(
      header,
      'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
  });

  await test("includes qop, nc, cnonce when qop is present", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/", "cnonce", "00000001");
    assert.equal(
      header,
      'Digest username="u", realm="r", nonce="n", uri="/", response="resp", qop=auth, nc=00000001, cnonce="cnonce"',
    );
  });

  await test("omits opaque when not in challenge", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.match(
      header,
      /^Digest username="u", realm="r", nonce="n", uri="\/", response="resp", qop=auth, nc=00000001, cnonce="[0-9a-f]{10}"$/,
    );
    assert.equal(header.includes("opaque="), false);
  });

  await test("omits algorithm when MD5 (default)", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.equal(header, 'Digest username="u", realm="r", nonce="n", uri="/", response="resp"');
  });

  await test("includes algorithm when non-MD5", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", algorithm=SHA-256`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    assert.equal(
      header,
      'Digest username="u", realm="r", nonce="n", uri="/", response="resp", algorithm=SHA-256',
    );
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

  await test("emits qop=auth when auth-int is listed first", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth-int,auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/", "0123456789", "00000001");
    assert.equal(
      header,
      'Digest username="u", realm="r", nonce="n", uri="/", response="resp", qop=auth, nc=00000001, cnonce="0123456789"',
    );
    assert.ok(!header.includes("auth-int"));
  });

  await test("auto-generated cnonce is 10 lowercase hex characters", () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const header = formatDigestAuth(challenge, "u", "resp", "/");
    const m = header.match(/cnonce="([0-9a-f]+)"/);
    assert.ok(m);
    assert.equal(m[1].length, 10);
    assert.ok(/^[0-9a-f]{10}$/.test(m[1]));
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
    const cnonce = auth.match(/cnonce="([^"]+)"/)![1];
    const response = auth.match(/response="([^"]+)"/)![1];
    assert.equal(
      auth,
      'Digest username="Mufasa", realm="testrealm@host.com", ' +
        'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", ' +
        'response="' +
        response +
        '", opaque="5ccc069c403ebaf9f0171e9517f40e41", ' +
        'qop=auth, nc=00000001, cnonce="' +
        cnonce +
        '"',
    );
    assert.ok(/^[0-9a-f]{10}$/.test(cnonce));
    assert.ok(/^[0-9a-f]{32}$/.test(response));
  });

  await test("response in the emitted header matches the emitted cnonce and nc", async () => {
    // The single most important property of this module: the `response` has to
    // be the digest *of the same nc and cnonce that appear in the header*.
    // Checking only that `response="..."` is present and 32 characters long
    // passes even if the two were generated independently.
    const wwwAuth = `Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth"`;
    for (let i = 0; i < 5; i++) {
      const auth = await createDigestAuthorization(
        wwwAuth,
        "Mufasa",
        "Circle Of Life",
        "GET",
        "/dir/index.html",
      );
      const cnonce = auth.match(/cnonce="([^"]+)"/)![1];
      const nc = auth.match(/nc=([0-9a-f]{8})/)![1];
      const response = auth.match(/response="([^"]+)"/)![1];
      assert.equal(nc, "00000001");
      assert.equal(cnonce.length, 10);
      assert.ok(/^[0-9a-f]{10}$/.test(cnonce));
      assert.equal(
        response,
        await computeDigestResponse(
          parseDigestChallenge(wwwAuth),
          "Mufasa",
          "Circle Of Life",
          "GET",
          "/dir/index.html",
          cnonce,
          nc,
        ),
      );
    }
  });

  await test("full integration with SHA-256", async () => {
    const wwwAuth = `Digest realm="r", nonce="abc123", algorithm=SHA-256, qop="auth"`;
    const auth = await createDigestAuthorization(wwwAuth, "user", "pass", "GET", "/");
    const cnonce = auth.match(/cnonce="([^"]+)"/)![1];
    const response = auth.match(/response="([^"]+)"/)![1];
    assert.equal(
      auth,
      'Digest username="user", realm="r", nonce="abc123", uri="/", response="' +
        response +
        '", algorithm=SHA-256, qop=auth, nc=00000001, cnonce="' +
        cnonce +
        '"',
    );
    assert.equal(response.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(response));
    assert.equal(
      response,
      await computeDigestResponse(
        parseDigestChallenge(wwwAuth),
        "user",
        "pass",
        "GET",
        "/",
        cnonce,
        "00000001",
      ),
    );
  });

  await test("full integration without qop", async () => {
    const wwwAuth = `Digest realm="r", nonce="abc123"`;
    const auth = await createDigestAuthorization(wwwAuth, "user", "pass", "GET", "/");
    const response = auth.match(/response="([^"]+)"/)![1];
    // No qop means no nc and no cnonce may be sent (RFC 2069 mode).
    assert.equal(
      auth,
      'Digest username="user", realm="r", nonce="abc123", uri="/", response="' + response + '"',
    );
    assert.ok(!auth.includes("qop="));
    assert.ok(!auth.includes("nc="));
    assert.ok(!auth.includes("cnonce="));
    assert.equal(response, "1ecb81fef95a43a93c30bcab4be6f71b");
  });

  suite("RFC test vectors");

  await test("RFC 2617 §3.5: MD5 with qop=auth", async () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"',
    );
    assert.equal(
      await computeDigestResponse(
        challenge,
        "Mufasa",
        "Circle Of Life",
        "GET",
        "/dir/index.html",
        "0a4f113b",
        "00000001",
      ),
      "6629fae49393a05397450978507c4ef1",
    );
  });

  await test("RFC 2617 §3.5: MD5 without qop", async () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"',
    );
    assert.equal(
      await computeDigestResponse(challenge, "Mufasa", "Circle Of Life", "GET", "/dir/index.html"),
      "670fd8c2df070c60b045671b8b24ff02",
    );
  });

  await test("RFC 7616 §3.9.1: SHA-256 with qop=auth", async () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", algorithm="SHA-256", ' +
        'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", ' +
        'opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
    );
    assert.equal(
      await computeDigestResponse(
        challenge,
        "Mufasa",
        "Circle of Life",
        "GET",
        "/dir/index.html",
        "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        "00000001",
      ),
      "7436fa2bd5fb0f7940f6ee15c3588c088f090b8e23bfdf10c45edca74c34ee4f",
    );
  });

  suite("createDigestAuthorizer (the stateful path the client uses)");

  const AUTH_WWW = `Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth"`;

  await test("nc starts at 00000001 and strictly increases", async () => {
    const auth = createDigestAuthorizer();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const header = await auth(AUTH_WWW, "Mufasa", "Circle Of Life", "GET", "/dir/index.html");
      seen.push(header.match(/nc=([0-9a-f]{8})/)![1]);
    }
    assert.deepEqual(seen, ["00000001", "00000002", "00000003", "00000004"]);
  });

  await test("each response is the digest of that request's own nc and cnonce", async () => {
    const auth = createDigestAuthorizer();
    for (const expectNc of ["00000001", "00000002", "00000003"]) {
      const header = await auth(AUTH_WWW, "Mufasa", "Circle Of Life", "GET", "/dir/index.html");
      const cnonce = header.match(/cnonce="([^"]+)"/)![1];
      const nc = header.match(/nc=([0-9a-f]{8})/)![1];
      const response = header.match(/response="([^"]+)"/)![1];
      assert.equal(nc, expectNc);
      assert.equal(
        response,
        await computeDigestResponse(
          parseDigestChallenge(AUTH_WWW),
          "Mufasa",
          "Circle Of Life",
          "GET",
          "/dir/index.html",
          cnonce,
          nc,
        ),
      );
    }
  });

  await test("a different nonce resets the counter to 1", async () => {
    const auth = createDigestAuthorizer();
    await auth(AUTH_WWW, "u", "p", "GET", "/d");
    await auth(AUTH_WWW, "u", "p", "GET", "/d");
    const fresh = await auth(
      `Digest realm="testrealm@host.com", nonce="a-different-nonce", qop="auth"`,
      "u",
      "p",
      "GET",
      "/d",
    );
    assert.equal(fresh.match(/nc=([0-9a-f]{8})/)![1], "00000001");
    assert.equal(fresh.match(/nonce="([^"]+)"/)![1], "a-different-nonce");
    // ...and the original nonce resumes from where it left off.
    const resumed = await auth(AUTH_WWW, "u", "p", "GET", "/d");
    assert.equal(resumed.match(/nc=([0-9a-f]{8})/)![1], "00000003");
  });

  await test("counter is independent per authorizer instance", async () => {
    const a = createDigestAuthorizer();
    const b = createDigestAuthorizer();
    await a(AUTH_WWW, "u", "p", "GET", "/d");
    const bHeader = await b(AUTH_WWW, "u", "p", "GET", "/d");
    assert.equal(bHeader.match(/nc=([0-9a-f]{8})/)![1], "00000001");
  });

  await test("emits the full header with the challenge's opaque", async () => {
    const auth = createDigestAuthorizer();
    const header = await auth(
      `Digest realm="r", nonce="n", qop="auth", opaque="OP"`,
      "u",
      "p",
      "GET",
      "/d",
    );
    const cnonce = header.match(/cnonce="([^"]+)"/)![1];
    const response = header.match(/response="([^"]+)"/)![1];
    assert.equal(
      header,
      'Digest username="u", realm="r", nonce="n", uri="/d", response="' +
        response +
        '", opaque="OP", qop=auth, nc=00000001, cnonce="' +
        cnonce +
        '"',
    );
    // opaque must not perturb the digest — it is echoed, never hashed.
    assert.equal(
      response,
      await computeDigestResponse(
        parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`),
        "u",
        "p",
        "GET",
        "/d",
        cnonce,
        "00000001",
      ),
    );
  });

  await test("no-qop challenge produces a header with no nc or cnonce", async () => {
    const auth = createDigestAuthorizer();
    const header = await auth(`Digest realm="r", nonce="n"`, "u", "p", "GET", "/d");
    assert.equal(
      header,
      'Digest username="u", realm="r", nonce="n", uri="/d", response="3ce808f964d94d8ce8131d5025746bc6"',
    );
  });

  await test("different method and uri each change the response", async () => {
    const auth = createDigestAuthorizer();
    const g = await auth(`Digest realm="r", nonce="n", qop="auth"`, "u", "p", "GET", "/a");
    const p = await auth(`Digest realm="r", nonce="n", qop="auth"`, "u", "p", "POST", "/a");
    const b = await auth(`Digest realm="r", nonce="n", qop="auth"`, "u", "p", "GET", "/b");
    assert.equal(
      [
        g.match(/response="([^"]+)"/)![1],
        p.match(/response="([^"]+)"/)![1],
        b.match(/response="([^"]+)"/)![1],
      ].length,
      3,
    );
    assert.equal(new Set([g, p, b].map((h) => h.match(/response="([^"]+)"/)![1])).size, 3);
  });

  suite("regression: RFC 7616 §3.4.3 / §3.4.4 and RFC 7230 §3.2.6");

  await test("auth-int is refused rather than answered as if it were auth", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth-int"`);
    // assert.rejects, not assert.throws: computeDigestResponse is async, and
    // assert.throws(() => promise) inspects the *return value*, not the
    // settlement — it passes for any body that merely returns a promise.
    await assert.rejects(
      computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "00000001"),
      /auth-int/,
    );
  });

  await test("auth is used when the server offers both, and the response matches", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth-int,auth"`);
    // Exactly the RFC 7616 §3.4.1 ordering a server may legitimately send.
    const got = await computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "00000001");
    assert.equal(got, "2ec343127bc4345ed918b11a84a83211");
    const header = formatDigestAuth(challenge, "u", got, "/d", "CN", "00000001");
    assert.ok(header.includes("qop=auth"));
    assert.ok(!header.includes("auth-int"));
  });

  await test("an unrecognised algorithm is an error, not a silent MD5", async () => {
    for (const algorithm of ["SCRAM-SHA-256", "garbage", "SHA-1"]) {
      const challenge = parseDigestChallenge(
        `Digest realm="r", nonce="n", qop="auth", algorithm=${algorithm}`,
      );
      // The message echoes challenge.algorithm, which the parser normalises
      // to upper case, so match case-insensitively.
      await assert.rejects(
        computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "1"),
        new RegExp(`Unsupported digest algorithm: ${algorithm}`, "i"),
      );
    }
  });

  await test("MD5-sess folds nonce and cnonce into HA1", async () => {
    const challenge = parseDigestChallenge(
      `Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess`,
    );
    assert.equal(
      await computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "0000002a"),
      "b15a244c593fc9615521cd621e113530",
    );
    // Session binding must actually change the digest.
    const plain = await computeDigestResponse(
      parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`),
      "u",
      "p",
      "GET",
      "/d",
      "CN",
      "0000002a",
    );
    assert.equal(plain, "83b81a38a36ec42911e10672ae7cebfa");
    assert.notEqual(plain, "b15a244c593fc9615521cd621e113530");
  });

  await test("SHA-256-sess is SHA-256, not MD5", async () => {
    const challenge = parseDigestChallenge(
      `Digest realm="r", nonce="n", qop="auth", algorithm=SHA-256-sess`,
    );
    assert.equal(
      await computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "0000002a"),
      "e0e66476f2fcbdbcb9ae9d853285415ae9275234f0596a8004315c1f2d975537",
    );
    assert.equal(
      (await computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "0000002a")).length,
      64,
    );
  });

  await test("MD5-sess and SHA-256-sess are different digests", async () => {
    const m = await computeDigestResponse(
      parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess`),
      "u",
      "p",
      "GET",
      "/d",
      "CN",
      "0000002a",
    );
    const s = await computeDigestResponse(
      parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth", algorithm=SHA-256-sess`),
      "u",
      "p",
      "GET",
      "/d",
      "CN",
      "0000002a",
    );
    assert.notEqual(m, s);
  });

  await test("a -sess algorithm without qop is an error", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", algorithm=MD5-sess`);
    await assert.rejects(
      computeDigestResponse(challenge, "u", "p", "GET", "/d", "CN", "1"),
      /requires a qop parameter/,
    );
  });

  await test("a quoted quote in a username cannot inject auth-params", async () => {
    const challenge = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    const evil = 'admin", qop=auth-int, nc="ffffffff';
    const response = await computeDigestResponse(challenge, evil, "p", "GET", "/d", "CN", "1");
    const header = formatDigestAuth(challenge, evil, response, "/d", "CN", "00000001");
    // The username stays a single quoted-string: its quote is escaped, so the
    // `qop=auth-int, nc="ffffffff` text remains *inside* username="...".
    assert.equal(
      header,
      "Digest username=" +
        q(evil) +
        ', realm="r", nonce="n", uri="/d", response="' +
        response +
        '", qop=auth, nc=00000001, cnonce="CN"',
    );
    // Round-tripping finds exactly one qop, one nonce and one realm: no
    // attacker-chosen parameter was smuggled in.
    const back = parseDigestChallenge(header);
    assert.equal(back.qop, "auth");
    assert.equal(back.realm, "r");
    assert.equal(back.nonce, "n");
    // Count *parameters*, not substrings: blank out every quoted-string
    // first, so text sitting inside a value cannot be mistaken for a
    // top-level auth-param.
    const params = header.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.equal((params.match(/\bqop=/g) ?? []).length, 1);
    assert.equal((params.match(/\bnc=/g) ?? []).length, 1);
    assert.equal((params.match(/\bcnonce=/g) ?? []).length, 1);
    // And the parameter list ends where the library put it.
    assert.ok(header.endsWith(', qop=auth, nc=00000001, cnonce="CN"'));
  });

  await test("a quoted quote in a server-supplied realm cannot inject auth-params", async () => {
    // realm and opaque come from the *server*, so a hostile or compromised
    // one could otherwise write into the client's outgoing Authorization header.
    const challenge = parseDigestChallenge(
      String.raw`Digest realm="evil\", x=\"y", nonce="n", qop="auth", opaque="op\"z", algorithm=SHA-256`,
    );
    assert.equal(challenge.realm, 'evil", x="y');
    assert.equal(challenge.opaque, 'op"z');
    assert.equal(challenge.nonce, "n");
    assert.equal(challenge.qop, "auth");
    assert.equal(challenge.algorithm, "SHA-256");
    const response = "deadbeef";
    const header = formatDigestAuth(challenge, "u", response, "/d", "CN", "00000001");
    assert.equal(
      header,
      'Digest username="u", realm=' +
        q(challenge.realm) +
        ', nonce="n", uri="/d", response="deadbeef", opaque=' +
        q(challenge.opaque!) +
        ', algorithm=SHA-256, qop=auth, nc=00000001, cnonce="CN"',
    );
    // The header we send back parses to exactly the challenge we were given.
    const back = parseDigestChallenge(header);
    assert.equal(back.realm, 'evil", x="y');
    assert.equal(back.opaque, 'op"z');
    assert.equal(back.nonce, "n");
    assert.equal(back.qop, "auth");
  });

  await test("quoted-pairs round-trip through the formatter (RFC 7230 §3.2.6)", () => {
    // A literal backslash must travel as two backslashes, and a literal quote
    // as \". A lone \b inside a quoted-string is a quoted-pair for the
    // character `b` (RFC 7230 §3.2.6), so a value containing a backslash only
    // survives the round-trip if every one of them was escaped.
    const realm = 'a\\b"c';
    const challenge = parseDigestChallenge(`Digest realm=${q(realm)}, nonce="n"`);
    assert.equal(challenge.realm, realm);
    const header = formatDigestAuth(challenge, "u\\v", "r", "/d");
    assert.equal(
      header,
      "Digest username=" +
        q("u\\v") +
        ", realm=" +
        q(realm) +
        ', nonce="n", uri="/d", response="r"',
    );
    assert.equal(parseDigestChallenge(header).realm, realm);
  });

  await test("parseDigestChallenge decodes quoted-pairs (RFC 7230 §3.2.6)", () => {
    const c = parseDigestChallenge(String.raw`Digest realm="say \"hi\"", nonce="n", qop="auth"`);
    assert.equal(c.realm, 'say "hi"');
    assert.equal(c.qop, "auth");
    // \b is a quoted-pair for the character `b`, not a backslash.
    assert.equal(parseDigestChallenge(String.raw`Digest realm="a\b", nonce="n"`).realm, "ab");
    // \\ is a quoted-pair for a single backslash.
    assert.equal(parseDigestChallenge(String.raw`Digest realm="a\\b", nonce="n"`).realm, "a\\b");
  });

  await test("userhash=true sends username* and never the plaintext name", async () => {
    const www = `Digest realm="testrealm@host.com", nonce="n", qop="auth", userhash=true`;
    const auth = createDigestAuthorizer();
    const header = await auth(www, "Mufasa", "pw", "GET", "/d");
    assert.ok(/username\*="[^"]+"/.test(header));
    assert.ok(!header.includes('username="Mufasa"'));
    assert.ok(!header.includes("Mufasa"));
    assert.equal(
      await computeUsernameStar(parseDigestChallenge(www), "Mufasa"),
      "dPVP4sgEWl/9p9Av2X8XFg==",
    );
  });

  await test("userhash=true substitutes username* inside HA1", async () => {
    const www = `Digest realm="r", nonce="n", qop="auth", userhash=true`;
    const challenge = parseDigestChallenge(www);
    const hash = await computeUsernameStar(challenge, "admin");
    const cnonce = "CN";
    const response = await computeDigestResponse(
      challenge,
      "admin",
      "pw",
      "GET",
      "/d",
      cnonce,
      "00000001",
    );
    // Recompute HA1 by hand using the hashed name.
    const { createHash } = await import("node:crypto");
    const md5 = (x: string) => createHash("md5").update(x).digest("hex");
    const ha1 = md5(`${hash}:r:pw`);
    const ha2 = md5("GET:/d");
    assert.equal(response, md5(`${ha1}:n:00000001:${cnonce}:auth:${ha2}`));
    // ...and it is NOT the digest of the plaintext name.
    assert.notEqual(
      response,
      await computeDigestResponse(
        parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`),
        "admin",
        "pw",
        "GET",
        "/d",
        cnonce,
        "00000001",
      ),
    );
  });

  await test("userhash uses the challenge's own algorithm", async () => {
    assert.equal(
      await computeUsernameStar(
        parseDigestChallenge(`Digest realm="r", nonce="n", userhash=true, algorithm=SHA-256`),
        "Mufasa",
      ),
      "jsPh1kfYvSrnEVoZtRVXJ8CD3TVunm+lJrEYhGHxis8=",
    );
    assert.equal(
      await computeUsernameStar(parseDigestChallenge(`Digest realm="r", nonce="n"`), "Mufasa"),
      null,
    );
  });

  await test("formatDigestAuth refuses to send a plaintext username under userhash", async () => {
    const challenge = parseDigestChallenge(
      `Digest realm="r", nonce="n", qop="auth", userhash=true`,
    );
    assert.throws(
      () => formatDigestAuth(challenge, "admin", "resp", "/d", "CN", "00000001"),
      /userhash/,
    );
    const plain = parseDigestChallenge(`Digest realm="r", nonce="n", qop="auth"`);
    assert.throws(
      () => formatDigestAuth(plain, "admin", "resp", "/d", "CN", "00000001", "hash"),
      /does not offer userhash/,
    );
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
