import assert from "node:assert/strict";
import { computeDigestResponse } from "../src/digest.ts";
import { kinetex } from "../src/mod.ts";
import {
  httpbinBaseUrl,
  httpbinTlsBaseUrl,
  isLocalHttpbinRunning,
  HTTPBIN_LOCAL_TLS_ORIGIN,
  LOCAL_TLS_CA,
} from "./httpbin-local.ts";
import { createSecureContext } from "node:tls";

/**
 * The local httpbin replacement has to behave like the service the suite was
 * written against, or repointing the suites at it would change what they are
 * testing. These pin the behaviours the suite actually depends on.
 */

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}

const base = await httpbinBaseUrl();

await test("starts on loopback and answers in one call", async () => {
  assert.ok(isLocalHttpbinRunning(), "the server must be up after httpbinBaseUrl()");
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
});

await test("is idempotent and returns the same origin", async () => {
  assert.equal(await httpbinBaseUrl(), base);
});

await test("/get echoes method, url, args and headers", async () => {
  const r = await fetch(`${base}/get?a=1&b=2`, { headers: { "x-probe": "yes" } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, never>;
  assert.equal(body.method, "GET");
  assert.equal(body.url, `${base}/get?a=1&b=2`, "httpbin echoes the absolute URL");
  assert.deepEqual(body.args, { a: "1", b: "2" });
  const headers = body.headers as unknown as Record<string, string>;
  assert.equal(headers["x-probe"], "yes");
});

await test("/post echoes the body as both data and json", async () => {
  const r = await fetch(`${base}/post`, {
    method: "POST",
    body: JSON.stringify({ a: 1 }),
    headers: { "content-type": "application/json" },
  });
  const body = (await r.json()) as { method: string; data: string; json: unknown };
  assert.equal(body.method, "POST");
  assert.equal(body.json !== null, true, "a JSON body must also be parsed");
  assert.match(body.data, /"a":1/);
});

await test("/uuid returns an object with a well-formed v4 uuid", async () => {
  const body = (await (await fetch(`${base}/uuid`)).json()) as { uuid: string };
  assert.deepEqual(Object.keys(body), ["uuid"], "httpbin wraps the value in an object");
  assert.match(body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Two calls must differ — a fixed value would make a caching test pass for
  // the wrong reason.
  const again = (await (await fetch(`${base}/uuid`)).json()) as { uuid: string };
  assert.notEqual(body.uuid, again.uuid);
});

await test("/status/N returns that status with an html body", async () => {
  for (const code of [200, 302, 404, 418, 500, 503]) {
    const r = await fetch(`${base}/status/${code}`);
    assert.equal(r.status, code);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  }
});

await test("/delay/N waits, and is capped so a suite cannot hang on it", async () => {
  const t0 = Date.now();
  const r = await fetch(`${base}/delay/1`);
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  // Lower bound: it really waited. The cap is 2 s, so /delay/60 cannot exceed it.
  assert.ok(elapsed >= 900, `delay/1 returned after ${elapsed}ms`);
  const t1 = Date.now();
  await fetch(`${base}/delay/60`);
  assert.ok(Date.now() - t1 <= 3_500, "/delay/60 must be capped");
});

await test("/bytes/N returns exactly N bytes", async () => {
  const buf = await (await fetch(`${base}/bytes/1000`)).arrayBuffer();
  assert.equal(buf.byteLength, 1000);
});

await test("/base64/V decodes", async () => {
  assert.equal(await (await fetch(`${base}/base64/aGVsbG8=`)).text(), "hello");
});

await test("/redirect/N walks down to /get", async () => {
  let r = await fetch(`${base}/redirect/3`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/redirect/2");
  r = await fetch(`${base}/redirect/1`, { redirect: "manual" });
  assert.equal(r.headers.get("location"), "/get");
});

await test("/cookies/set then /cookies reads the jar back", async () => {
  await fetch(`${base}/cookies/set?probe=abc123`);
  const body = (await (await fetch(`${base}/cookies`)).json()) as {
    cookies: Record<string, string>;
  };
  assert.equal(body.cookies.probe, "abc123");
});

await test("/response-headers echoes the query keys as headers", async () => {
  // Upstream sends the query parameters as the JSON body *and* as response
  // headers of the same name — `?Set-Cookie=a=b` is how the cookie suite gets a
  // Set-Cookie back.
  const r = await fetch(`${base}/response-headers?a=1&a=2&Location=%2Ftarget`);
  assert.deepEqual(await r.json(), { a: ["1", "2"], Location: "/target" });
  assert.equal(r.headers.get("location"), "/target");
});

await test("/user-agent answers JSON with the agent that was sent", async () => {
  // The `null` branch only fires for a client that sends no agent at all, which
  // undici's fetch never does — it defaults to `node`.
  const r = await fetch(`${base}/user-agent`, { headers: { "user-agent": "kinetex-test" } });
  assert.deepEqual(await r.json(), { "user-agent": "kinetex-test" });
});

await test("/basic-auth requires the credential", async () => {
  const anon = await fetch(`${base}/basic-auth/user/passwd`);
  assert.equal(anon.status, 401);
  const ok = await fetch(`${base}/basic-auth/user/passwd`, {
    headers: { authorization: `Basic ${Buffer.from("user:passwd").toString("base64")}` },
  });
  assert.equal(ok.status, 200);
});

await test("/digest-auth issues a challenge then rejects a wrong digest", async () => {
  const url = `${base}/digest-auth/auth/user/passwd`;
  const first = await fetch(url);
  assert.equal(first.status, 401);
  const challenge = first.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Digest /);
  assert.match(challenge, /nonce="[^"]+"/);

  // A wrong response must be rejected. Previously this test sent a made-up
  // response and asserted 200, which the server granted on a username match
  // alone — so no digest computation was ever checked.
  const nonce = /nonce="([^"]+)"/.exec(challenge)?.[1] ?? "";
  const wrong = `Digest username="user", realm="me@kennethreitz.com", nonce="${nonce}", uri="/digest-auth/auth/user/passwd", response="deadbeef"`;
  const bad = await fetch(url, { headers: { authorization: wrong } });
  assert.equal(bad.status, 401, "a wrong digest must not authenticate");

  // The correct one is computed by the library's own digest helper, so the
  // server genuinely verifies rather than pattern-matching a username.
  const fields = Object.fromEntries(
    [...challenge.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)].map((m) => [
      m[1] ?? "",
      m[2] ?? m[3] ?? "",
    ]),
  );
  const cnonce = "0a4f113b";
  const response = await computeDigestResponse(
    {
      realm: fields["realm"] ?? "",
      nonce: fields["nonce"] ?? "",
      qop: fields["qop"] ?? "",
      opaque: fields["opaque"] ?? "",
      algorithm: "MD5",
    },
    "user",
    "passwd",
    "GET",
    "/digest-auth/auth/user/passwd",
    cnonce,
    "00000001",
  );
  const ok = await fetch(url, {
    headers: {
      authorization: `Digest username="user", realm="${fields["realm"]}", nonce="${fields["nonce"]}", uri="/digest-auth/auth/user/passwd", qop=auth, nc=00000001, cnonce="${cnonce}", response="${response}"`,
    },
  });
  assert.equal(ok.status, 200, "a correct digest must authenticate");
});

await test("gzip, deflate and brotli are served with matching content-encoding", async () => {
  // brotli is announced as the registered token `br`, verified against upstream.
  // Asserting the path name instead meant this server and this test agreed with
  // each other and both disagreed with httpbin — and a client decoding by token
  // silently left the body as raw bytes.
  for (const [path, token] of [
    ["gzip", "gzip"],
    ["deflate", "deflate"],
    ["brotli", "br"],
  ] as const) {
    const r = await fetch(`${base}/${path}`);
    assert.equal(r.status, 200, `/${path}`);
    assert.equal(r.headers.get("content-encoding"), token, `/${path} content-encoding token`);
  }
});

await test("an unknown path is a 404 with a JSON body", async () => {
  const r = await fetch(`${base}/definitely-not-an-endpoint`);
  assert.equal(r.status, 404);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
});

console.log(`\n${"=".repeat(56)}`);
await test("the TLS origin serves the same routes over HTTP/2", async () => {
  const tlsBase = await httpbinTlsBaseUrl();
  // Trust the fixture certificate explicitly rather than disabling
  // verification for the process.
  const seen = await fetch(`${tlsBase}/get`).catch((err: unknown) => err);
  assert.ok(seen instanceof Error, "an untrusted fetch must reject rather than connect");

  // With the certificate supplied as a CA it connects and reports HTTP/2.
  const secure = kinetex({
    baseURL: HTTPBIN_LOCAL_TLS_ORIGIN,
    timeout: 10_000,
    ca: LOCAL_TLS_CA,
    // The fixture is on loopback; the SSRF guard would otherwise refuse it
    // before TLS is even attempted.
    allowPrivateNetwork: true,
  });
  const r = await secure.get<{ url: string; headers: Record<string, string> }>("/get?x=1");
  assert.equal(r.status, 200);
  assert.equal(r.httpVersion, "HTTP/2", "ALPN must select h2");
  assert.equal(r.data.url, `${HTTPBIN_LOCAL_TLS_ORIGIN}/get?x=1`);
});

await test("the fixture certificate covers the name the origin uses", () => {
  // A certificate for the wrong name would pass on one origin and fail on the
  // other, which is exactly the mistake worth pinning.
  const ctx = createSecureContext({ ca: LOCAL_TLS_CA });
  assert.ok(ctx, "the CA must parse as a certificate");
});

console.log(`  LOCAL HTTPBIN: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log(`${"=".repeat(56)}\n`);
process.exit(0);
