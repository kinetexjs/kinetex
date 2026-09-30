import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import {
  SigV4Signer,
  staticCredentials,
  envCredentials,
  chainCredentials,
  cachingCredentials,
  formatAmzDate,
  formatDateStamp,
  sigV4UriEncode,
  deriveSigningKey,
  detectClockSkew,
  isClockSkewError,
  createS3Signer,
  createAPIGatewaySigner,
  createDynamoDBSigner,
  signRequest,
  presignRequest,
} from "../src/mod.ts";
import {
  imdsCredentials,
  createSTSSigner,
  signS3PostPolicy,
  initChunkedSigning,
  signChunk,
  signFinalChunk,
} from "../src/aws-sigv4.ts";

const T = 30_000;
const httpbin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

/**
 * True when httpbin answered with a status its own front end produces —
 * 429 while rate-limiting, 502/503/504 when degraded — rather than the one
 * the endpoint was asked for. The request never reached the endpoint, so
 * asserting on the status measures the outage rather than the client.
 *
 * Only these four statuses count. A 404 or 500 back from `/anything` is a
 * real failure and must still fail the run.
 */
function isUpstreamStatusDrift(status: number, expected: number): boolean {
  return (
    status !== expected && (status === 429 || status === 502 || status === 503 || status === 504)
  );
}

/** Run `fn`, returning null instead of throwing on an upstream-only failure. */
async function settleUpstream<T>(
  name: string,
  fn: () => Promise<T>,
  expected: number,
  statusOf: (v: T) => number,
): Promise<T | null> {
  try {
    const v = await fn();
    if (isUpstreamStatusDrift(statusOf(v), expected)) {
      console.log(
        `    ⚠️  ${name} — assertions skipped (transient: httpbin answered ${statusOf(v)}, not ${expected})`,
      );
      return null;
    }
    return v;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (typeof status === "number" && isUpstreamStatusDrift(status, expected)) {
      console.log(
        `    ⚠️  ${name} — assertions skipped (transient: httpbin answered ${status}, not ${expected})`,
      );
      return null;
    }
    throw err;
  }
}

/** Log and report an upstream-only status drift for `name`. */
function skipStatusDrift(name: string, status: number, expected = 200): boolean {
  if (!isUpstreamStatusDrift(status, expected)) return false;
  console.log(
    `    ⚠️  ${name} — assertions skipped (transient: httpbin answered ${status}, not ${expected})`,
  );
  return true;
}

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>) {
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

// ============================================================================
// §1  UTILITY FUNCTIONS
// ============================================================================

suite("Utility Functions");

await test("formatAmzDate formats correctly", async () => {
  const result = formatAmzDate(new Date("2024-01-01T12:00:00Z"));
  assert.equal(result, "20240101T120000Z");
});

await test("formatAmzDate handles different months/days", async () => {
  assert.equal(formatAmzDate(new Date("2024-12-31T23:59:59Z")), "20241231T235959Z");
  assert.equal(formatAmzDate(new Date("2023-02-28T01:02:03Z")), "20230228T010203Z");
});

await test("formatDateStamp formats correctly", async () => {
  const result = formatDateStamp(new Date("2024-01-01T12:00:00Z"));
  assert.equal(result, "20240101");
});

await test("formatDateStamp handles year boundary", async () => {
  assert.equal(formatDateStamp(new Date("2023-12-31T23:59:59Z")), "20231231");
  assert.equal(formatDateStamp(new Date("2024-01-01T00:00:00Z")), "20240101");
});

await test("sigV4UriEncode encodes correctly", async () => {
  const result = sigV4UriEncode("test & more");
  assert.equal(result, "test%2520%2526%2520more");
});

await test("sigV4UriEncode encodes special characters", async () => {
  assert.equal(sigV4UriEncode("test+value=123"), "test%252Bvalue%253D123");
  assert.equal(sigV4UriEncode("hello world/foo"), "hello%2520world%252Ffoo");
});

await test("sigV4UriEncode without double encode (S3 mode)", async () => {
  const result = sigV4UriEncode("test value/foo", false);
  assert.equal(result, "test%20value%2Ffoo");
});

await test("sigV4UriEncode handles unreserved chars", async () => {
  const result = sigV4UriEncode("abc-123~_.def");
  assert.equal(result, "abc-123~_.def");
});

await test("deriveSigningKey creates 32-byte key", async () => {
  const key = await deriveSigningKey(
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "20240101",
    "us-east-1",
    "s3",
  );
  assert.ok(key instanceof Uint8Array);
  assert.equal(key.length, 32);
});

await test("deriveSigningKey produces deterministic output", async () => {
  const key1 = await deriveSigningKey("secret", "20240101", "us-east-1", "iam");
  const key2 = await deriveSigningKey("secret", "20240101", "us-east-1", "iam");
  assert.deepEqual(key1, key2);
});

// ============================================================================
// §2  CREDENTIAL PROVIDERS
// ============================================================================

suite("Credential Providers");

await test("staticCredentials returns credentials", async () => {
  const provider = staticCredentials({ accessKeyId: "test-key", secretAccessKey: "test-secret" });
  const creds = await provider();
  assert.equal(creds.accessKeyId, "test-key");
  assert.equal(creds.secretAccessKey, "test-secret");
});

await test("staticCredentials with session token", async () => {
  const provider = staticCredentials({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "IQoJb3JpZ2luX2VjEMv////4",
  });
  const creds = await provider();
  assert.equal(creds.accessKeyId, "AKIAIOSFODNN7EXAMPLE");
  assert.equal(creds.sessionToken, "IQoJb3JpZ2luX2VjEMv////4");
});

await test("cachingCredentials caches results", async () => {
  let count = 0;
  const provider = () => {
    count++;
    return Promise.resolve({ accessKeyId: "cached", secretAccessKey: "secret" });
  };
  const cached = cachingCredentials(provider);
  const r1 = await cached();
  const r2 = await cached();
  assert.equal(count, 1);
  assert.equal(r1.accessKeyId, r2.accessKeyId);
});

await test("cachingCredentials re-fetches on expiry", async () => {
  let count = 0;
  const provider = () => {
    count++;
    const future = new Date(Date.now() + 100).toISOString();
    return Promise.resolve({
      accessKeyId: "expires",
      secretAccessKey: "secret",
      expiration: future,
    });
  };
  const cached = cachingCredentials(provider, 50); // 50ms before expiry
  const r1 = await cached();
  await new Promise((r) => setTimeout(r, 120)); // wait past expiry
  const r2 = await cached();
  assert.equal(count, 2, "Should refetch after expiry");
});

await test("cachingCredentials re-fetches on expiration near threshold", async () => {
  const nearExpiry = new Date(Date.now() + 100).toISOString();
  let count = 0;
  const provider = () => {
    count++;
    return Promise.resolve({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      expiration: nearExpiry,
    });
  };
  const cached = cachingCredentials(provider, 200); // refresh if within 200ms
  await cached();
  await cached();
  assert.equal(count, 2, "Should refetch when within refresh window");
});

await test("cachingCredentials propagates errors", async () => {
  let count = 0;
  const provider = async () => {
    count++;
    throw new Error("fail-" + count);
  };
  const cached = cachingCredentials(provider);
  await assert.rejects(() => cached(), /fail-1/);
  // Subsequent call should retry since previous failed (inflight was cleared)
  await assert.rejects(() => cached(), /fail-2/);
  assert.equal(count, 2);
});

await test("cachingCredentials deduplicates concurrent calls", async () => {
  let count = 0;
  const wait = new Promise<{ accessKeyId: string; secretAccessKey: string }>((resolve) => {
    setTimeout(() => {
      count++;
      resolve({ accessKeyId: "dedup", secretAccessKey: "secret" });
    }, 50);
  });
  const provider = () => wait;
  const cached = cachingCredentials(provider);
  const [a, b] = await Promise.all([cached(), cached()]);
  assert.equal(count, 1);
  assert.equal(a.accessKeyId, b.accessKeyId);
});

await test("chainCredentials tries sequential providers", async () => {
  const p1 = () => Promise.reject(new Error("first failed"));
  const p2 = () => Promise.resolve({ accessKeyId: "second", secretAccessKey: "secret" });
  const chain = chainCredentials(p1, p2);
  const creds = await chain();
  assert.equal(creds.accessKeyId, "second");
});

await test("chainCredentials throws if all fail", async () => {
  const p1 = () => Promise.reject(new Error("fail1"));
  const p2 = () => Promise.reject(new Error("fail2"));
  const chain = chainCredentials(p1, p2);
  await assert.rejects(() => chain(), /All credential providers failed/);
});

await test("chainCredentials stops at first success", async () => {
  let secondCalled = false;
  const p1 = () => Promise.resolve({ accessKeyId: "first", secretAccessKey: "secret" });
  const p2 = () => {
    secondCalled = true;
    return Promise.reject(new Error("should not reach"));
  };
  const chain = chainCredentials(p1, p2);
  const creds = await chain();
  assert.equal(creds.accessKeyId, "first");
  assert.equal(secondCalled, false);
});

await test("envCredentials reads from environment", async () => {
  const key = "KX_TEST_AWS_KEY_" + Date.now();
  const secret = "KX_TEST_AWS_SECRET_" + Date.now();
  process.env["AWS_ACCESS_KEY_ID"] = key;
  process.env["AWS_SECRET_ACCESS_KEY"] = secret;
  try {
    const provider = envCredentials();
    const creds = await provider();
    assert.equal(creds.accessKeyId, key);
    assert.equal(creds.secretAccessKey, secret);
    assert.equal(creds.sessionToken, undefined);
  } finally {
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
  }
});

await test("envCredentials reads session token", async () => {
  process.env["AWS_ACCESS_KEY_ID"] = "AKID";
  process.env["AWS_SECRET_ACCESS_KEY"] = "SECRET";
  process.env["AWS_SESSION_TOKEN"] = "TOKEN";
  try {
    const provider = envCredentials();
    const creds = await provider();
    assert.equal(creds.sessionToken, "TOKEN");
  } finally {
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_SESSION_TOKEN"];
  }
});

await test("envCredentials throws when missing", async () => {
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  const provider = envCredentials();
  await assert.rejects(() => provider(), /AWS credentials not found/);
});

// ============================================================================
// §3  IMDS CREDENTIALS (exercises fetchWithTimeout)
// ============================================================================

suite("IMDS Credentials");

await test("imdsCredentials fails fast with short timeout (not on EC2)", async () => {
  const provider = imdsCredentials({ timeout: 50 });
  const start = Date.now();
  let caught: unknown = null;
  try {
    await provider();
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - start;
  if (caught === null) {
    // Only reachable when the suite actually runs on an EC2 instance. Skipping
    // is correct here; reporting a pass on the EC2 path would not be, so this
    // is the one branch that is allowed to assert nothing.
    console.log("     [on EC2] IMDS succeeded unexpectedly — assertions skipped");
    return;
  }
  // Pinned to the two documented outcomes rather than a six-way message
  // disjunction. `msg.includes("IMDS")` alone matched every IMDS error ever
  // produced — including a bare TypeError from a typo, or the SSRF guard
  // firing — none of which prove the timeout was honoured. Which of the two
  // wins depends on whether the endpoint's response or the 50ms timeout
  // lands first, so both are accepted, but nothing else is.
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  const err = caught as Error & { code?: string };
  assert.ok(
    err.name === "NetworkError" || err.name === "TimeoutError",
    `expected a NetworkError or TimeoutError, got ${err.name}: ${err.message}`,
  );
  assert.ok(
    err.code === "ENETWORK" || err.code === "ETIMEOUT",
    `the failure must be classified as a network or timeout error, got ${String(err.code)}`,
  );
  assert.ok(elapsed < 5_000, `IMDS must fail fast against a 50ms timeout, took ${elapsed}ms`);
});

await test("imdsCredentials throws on invalid endpoint (SSRF protection)", async () => {
  assert.throws(
    () => imdsCredentials({ endpoint: "http://evil.com", timeout: 50 }),
    /Invalid IMDS endpoint/,
  );
});

await test("imdsCredentials throws on invalid IP endpoint", async () => {
  assert.throws(
    () => imdsCredentials({ endpoint: "http://1.2.3.4", timeout: 50 }),
    /Invalid IMDS endpoint/,
  );
});

await test("imdsCredentials throws on invalid URL format", async () => {
  assert.throws(
    () => imdsCredentials({ endpoint: "not-a-valid-url", timeout: 50 }),
    /Invalid IMDS endpoint/,
  );
});

await test("imdsCredentials validates IPv6 endpoint (strips brackets)", async () => {
  const provider = imdsCredentials({ endpoint: "http://[fd00:ec2::254]", timeout: 50 });
  let caught: unknown = null;
  try {
    await provider();
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    // Only reachable when the suite actually runs on an EC2 instance.
    console.log("     [on EC2] IPv6 IMDS succeeded — assertions skipped");
    return;
  }
  // A TypeError with "fetch failed" is the signature of *reaching* the network
  // layer. A URL that failed to parse would surface as a different error, so
  // asserting the class as well as the message is what proves the brackets
  // were stripped correctly — `new URL("http://[fd00:ec2::254]")` would
  // otherwise never get far enough to fail here.
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  assert.equal(
    (caught as Error).name,
    "TypeError",
    "a fetch-level TypeError, not a URL parse error — the brackets must be stripped",
  );
  assert.equal((caught as Error).message, "fetch failed");
});

// ============================================================================
// §4  CLOCK SKEW DETECTION
// ============================================================================

suite("Clock Skew Detection");

await test("detectClockSkew returns the exact offset in seconds", async () => {
  // Was `typeof skew === "number"` — true for NaN, for 0, and for any sign.
  // 2024 is in the past, so the offset must be negative and match the epoch.
  const skew = detectClockSkew({ date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  const expected = Math.round(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000 - Date.now() / 1000);
  assert.ok(Math.abs(skew - expected) <= 2, `expected ~${expected}, got ${skew}`);
  assert.ok(skew < 0, "a past server date must yield a negative skew");
});

await test("detectClockSkew returns 0 for missing header", async () => {
  const skew = detectClockSkew({});
  assert.equal(skew, 0);
});

await test("detectClockSkew returns 0 for invalid date", async () => {
  const skew = detectClockSkew({ date: "invalid-date" });
  assert.equal(skew, 0);
});

await test("detectClockSkew handles Date header (uppercase)", async () => {
  // Also only a typeof check. The capital-D spelling is the one a raw Node
  // response carries, so it has to produce the same number as the lowercase one.
  const upper = detectClockSkew({ Date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  const lower = detectClockSkew({ date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  assert.equal(upper, lower, "header name casing must not change the result");
  assert.ok(Number.isFinite(upper) && upper !== 0, "a 2024 date is neither 0 nor NaN");
});

await test("detectClockSkew returns 0 for empty headers", async () => {
  assert.equal(detectClockSkew({ "content-type": "application/json" }), 0);
});

await test("isClockSkewError detects RequestExpired", async () => {
  assert.equal(isClockSkewError(403, "RequestExpired: Request has expired"), true);
});

await test("isClockSkewError detects RequestTimeTooSkewed", async () => {
  assert.equal(
    isClockSkewError(403, "RequestTimeTooSkewed: The request timestamp is too far"),
    true,
  );
});

await test("isClockSkewError detects InvalidSignatureException", async () => {
  assert.equal(isClockSkewError(403, "InvalidSignatureException: Signature not valid"), true);
});

await test("isClockSkewError detects AuthFailure", async () => {
  assert.equal(isClockSkewError(403, "AuthFailure: Authorization failed"), true);
});

await test("isClockSkewError detects SignatureDoesNotMatch", async () => {
  assert.equal(isClockSkewError(403, "SignatureDoesNotMatch: The signature does not match"), true);
});

await test("isClockSkewError returns false for non-skew errors", async () => {
  assert.equal(isClockSkewError(404, "NoSuchKey: The specified key does not exist"), false);
});

await test("isClockSkewError returns false for wrong status code", async () => {
  assert.equal(isClockSkewError(500, "RequestExpired: some error"), false);
});

await test("isClockSkewError returns true for status 400", async () => {
  assert.equal(isClockSkewError(400, "RequestTimeTooSkewed"), true);
});

await test("isClockSkewError returns false for normal error on status 400", async () => {
  assert.equal(isClockSkewError(400, "ValidationError: invalid input"), false);
});

// ============================================================================
// §5  RESOLVE SIGNING DATE (internal function tested via signRequest)
// ============================================================================

suite("Signing Date Resolution");

await test("signRequest with signingDate as string and clockSkewSecs", async () => {
  const result = await signRequest(
    { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null },
    {
      credentials: staticCredentials({ accessKeyId: "AKID", secretAccessKey: "SECRET" }),
      region: "us-east-1",
      service: "s3",
      signingDate: "2024-06-15T12:00:00Z",
      clockSkewSecs: 3600,
    },
  );
  // The config options are the entire subject of this test, and neither was
  // checked: a build that ignored `signingDate` and `clockSkewSecs` wholesale
  // would still have produced a string.
  assert.equal(result.amzDate, "20240615T130000Z", "signingDate + 3600s of skew");
  assert.equal(
    /Credential=AKID\/(\d{8})\//.exec(result.authorization)?.[1],
    "20240615",
    "the credential scope must use the resolved date, not today",
  );
  assert.match(result.signature, /^[0-9a-f]{64}$/);
});

await test("signRequest with signingDate as Date and clockSkewSecs", async () => {
  const result = await signRequest(
    { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null },
    {
      credentials: staticCredentials({ accessKeyId: "AKID", secretAccessKey: "SECRET" }),
      region: "us-east-1",
      service: "s3",
      signingDate: new Date("2024-06-15T12:00:00Z"),
      clockSkewSecs: -300,
    },
  );
  // Was a typeof check only. A Date and the equivalent ISO string must resolve
  // to the same instant, and a negative skew must subtract from it.
  assert.equal(result.amzDate, "20240615T115500Z", "12:00:00Z minus 300s of skew");
  assert.equal(/Credential=AKID\/(\d{8})\//.exec(result.authorization)?.[1], "20240615");
  assert.match(result.signature, /^[0-9a-f]{64}$/);
});

await test("signRequest with only clockSkewSecs (no signingDate)", async () => {
  const result = await signRequest(
    { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null },
    {
      credentials: staticCredentials({ accessKeyId: "AKID", secretAccessKey: "SECRET" }),
      region: "us-east-1",
      service: "s3",
      clockSkewSecs: 60,
    },
  );
  // Only a typeof check: the skew could have been ignored entirely. With no
  // signingDate the base is "now", so pin the shape AND the size of the shift.
  assert.match(result.amzDate, /^\d{8}T\d{6}Z$/);
  const signedAt = Date.parse(
    `${result.amzDate.slice(0, 4)}-${result.amzDate.slice(4, 6)}-${result.amzDate.slice(6, 8)}` +
      `T${result.amzDate.slice(9, 11)}:${result.amzDate.slice(11, 13)}:${result.amzDate.slice(13, 15)}Z`,
  );
  const drift = signedAt - Date.now();
  assert.ok(
    drift >= 55_000 && drift <= 65_000,
    `a +60s skew on "now" must land ~60s ahead, off by ${drift}ms`,
  );
  assert.match(result.signature, /^[0-9a-f]{64}$/);
});

await test("signRequest with signingDate as Date (no clockSkew)", async () => {
  const result = await signRequest(
    { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null },
    {
      credentials: staticCredentials({ accessKeyId: "AKID", secretAccessKey: "SECRET" }),
      region: "us-east-1",
      service: "s3",
      signingDate: new Date("2024-06-15T12:00:00Z"),
    },
  );
  assert.equal(typeof result.authorization, "string");
  assert.ok(result.amzDate.startsWith("20240615"));
});

// ============================================================================
// §6  SIGV4 SIGNER CLASS
// ============================================================================

suite("SigV4Signer Class");

const testCredentials = staticCredentials({
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
});

await test("SigV4Signer.sign generates authorization header", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: {},
    body: null,
  });
  assert.ok(result.authorization.startsWith("AWS4-HMAC-SHA256"));
  // Every field was a `typeof` check, so any string at all satisfied all ten
  // assertions. Pin the actual SigV4 structure instead.
  const scope = /Credential=([^,]+)/.exec(result.authorization)?.[1];
  assert.equal(
    scope,
    `AKIAIOSFODNN7EXAMPLE/${result.amzDate.slice(0, 8)}/us-east-1/s3/aws4_request`,
  );
  assert.equal(/SignedHeaders=([^,]+)/.exec(result.authorization)?.[1], "host;x-amz-date");
  const sigInHeader = /Signature=([0-9a-f]{64})$/.exec(result.authorization)?.[1];
  assert.equal(
    sigInHeader,
    result.signature,
    "the header and the field must be the same signature",
  );

  // Empty-body SHA-256 — the canonical value for a null body.
  assert.equal(
    result.headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(result.headers["x-amz-date"], result.amzDate, "header and field must agree");
  assert.equal(result.headers["host"], "s3.amazonaws.com");
  assert.equal(result.headers["authorization"], result.authorization);

  // The canonical request is six newline-joined parts, but the canonical-header
  // block contributes one line per signed header, so the tail is what must line
  // up: <signed headers>, "", <SignedHeaders>, <payload hash>.
  const cr = result.canonicalRequest.split("\n");
  const signedHeaders = "host;x-amz-date";
  assert.equal(cr.slice(0, 3).join("|"), "GET|/|", "method, path and an empty query string");
  assert.equal(
    cr.slice(3, 3 + signedHeaders.split(";").length).join("\n"),
    `host:s3.amazonaws.com\nx-amz-date:${result.amzDate}`,
    "the canonical header block must be sorted, lowercased and newline-joined",
  );
  assert.deepEqual(cr.slice(-3), ["", signedHeaders, result.headers["x-amz-content-sha256"]]);
  assert.equal(cr.length, 6 + signedHeaders.split(";").length, "no extra canonical parts");

  // The string to sign hashes the canonical request — pin the algorithm, the
  // timestamp, the scope and the hex digest.
  const sts = result.stringToSign.split("\n");
  assert.equal(sts[0], "AWS4-HMAC-SHA256");
  assert.equal(sts[1], result.amzDate);
  // The scope in the string-to-sign omits the access key id — only the
  // Credential= header carries it.
  assert.equal(sts[2], scope.slice(scope.indexOf("/") + 1));
  assert.match(sts[3], /^[0-9a-f]{64}$/);
});

await test("SigV4Signer.sign with session token adds x-amz-security-token", async () => {
  const signer = new SigV4Signer({
    credentials: staticCredentials({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "SESSION",
    }),
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: {},
    body: null,
  });
  assert.equal(typeof result.headers["x-amz-security-token"], "string");
  assert.equal(result.headers["x-amz-security-token"], "SESSION");
});

await test("SigV4Signer.sign with unsigned payload", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
    unsignedPayload: true,
  });
  const result = await signer.sign({
    method: "PUT",
    url: "https://s3.amazonaws.com/big-object",
    headers: {},
    body: null,
  });
  assert.equal(result.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

await test("SigV4Signer.sign with body", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "execute-api",
  });
  const result = await signer.sign({
    method: "POST",
    url: "https://api.example.com/data",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "value" }),
  });
  // A body was supplied, so the payload hash must be the SHA-256 of exactly
  // that body — not the empty hash, and not UNSIGNED-PAYLOAD.
  const body = JSON.stringify({ key: "value" });
  assert.equal(
    result.headers["x-amz-content-sha256"],
    "e43abcf3375244839c012f9633f95862d232a95b00d5bc7348b3098b9fed7f32",
    `the SHA-256 of ${body}, not the empty hash`,
  );
  assert.notEqual(
    result.headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "a non-empty body must not hash as empty",
  );
});

await test("SigV4Signer.sign with query parameters", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/bucket?prefix=test&max-keys=10",
    headers: {},
    body: null,
  });
  // Was a typeof check only. Query parameters are the point of this test, so
  // assert they reach the canonical query string — sorted, as SigV4 requires.
  const q = result.canonicalRequest.split("\n")[2];
  assert.equal(q, "max-keys=10&prefix=test", "query params must be sorted and encoded");
  assert.match(result.authorization, /Signature=[0-9a-f]{64}$/, "signature must be present");
  assert.equal(/Signature=([0-9a-f]{64})$/.exec(result.authorization)?.[1], result.signature);
  assert.ok(
    !result.authorization.includes("X-Amz-Signature"),
    "sign() uses an Authorization header; only presign() puts the signature in the query",
  );
});

await test("SigV4Signer.sign with custom unsigned headers", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
    unsignedHeaders: ["x-custom-trace"],
  });
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: { "x-custom-trace": "abc123" },
    body: null,
  });
  assert.equal(typeof result.authorization, "string");
  // `sign()` does not expose a `signedHeaders` field at all, so the previous
  // guard `!result.signedHeaders || !result.signedHeaders.includes(...)` was
  // satisfied by the undefined itself on every run and could never fail. The
  // only place the signed set is observable — and the only place a server sees
  // it — is inside the Authorization header, so assert on that instead.
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(result.authorization)?.[1];
  assert.equal(
    typeof signedHeaders,
    "string",
    `Authorization must carry a SignedHeaders list, got: ${result.authorization}`,
  );
  const list = signedHeaders!.split(";");
  assert.ok(list.includes("host"), `host must be signed, got: ${signedHeaders}`);
  assert.ok(list.includes("x-amz-date"), `x-amz-date must be signed, got: ${signedHeaders}`);
  assert.equal(
    list.includes("x-custom-trace"),
    false,
    `x-custom-trace is declared unsigned and must be absent, got: ${signedHeaders}`,
  );
});

await test("SigV4Signer.sign with clock skew correction", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  // The whole point is the correction, and the old assertion was a typeof on
  // the authorization string — it passed with the skew applied, ignored, or
  // applied backwards.
  const req = { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null };
  const before = await signer.sign(req);
  signer.updateClockSkew({ date: new Date(Date.now() + 3600000).toUTCString() });
  const result = await signer.sign(req);
  const toMs = (d: string) =>
    Date.parse(
      `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`,
    );
  const delta = Math.round((toMs(result.amzDate) - toMs(before.amzDate)) / 1000);
  assert.ok(
    Math.abs(delta - 3600) <= 2,
    `a +1h server clock must shift the signed date by ~3600s, got ${delta}s`,
  );
  assert.notEqual(result.signature, before.signature, "the signature must change with the date");
});

await test("SigV4Signer.presign creates presigned URL", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { expiresIn: 3600 },
  );
  const params = new URL(result).searchParams;
  assert.equal(params.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(params.get("X-Amz-Expires"), "3600");
  assert.equal(params.get("X-Amz-SignedHeaders"), "host");
  assert.match(
    params.get("X-Amz-Credential") as string,
    /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request$/,
  );
  assert.match(params.get("X-Amz-Date") as string, /^\d{8}T\d{6}Z$/);
  assert.match(params.get("X-Amz-Signature") as string, /^[0-9a-f]{64}$/);
});

await test("SigV4Signer.presign with session token", async () => {
  const signer = new SigV4Signer({
    credentials: staticCredentials({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "SESSION",
    }),
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    {},
  );
  assert.equal(new URL(result).searchParams.get("X-Amz-Security-Token"), "SESSION");
});

await test("SigV4Signer.presign omits session token when requested", async () => {
  const signer = new SigV4Signer({
    credentials: staticCredentials({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "SESSION",
    }),
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { omitSessionToken: true },
  );
  assert.equal(new URL(result).searchParams.has("X-Amz-Security-Token"), false);
});

await test("SigV4Signer.presign with extra params", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { extraParams: { "response-content-disposition": "attachment" } },
  );
  assert.equal(new URL(result).searchParams.get("response-content-disposition"), "attachment");
});

await test("SigV4Signer.presign warns on invalid expiresIn", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  // 7+ days is past S3's 604800 ceiling. AWS rejects such a link outright with
  // AuthorizationQueryParametersError, so the value must be clamped, not emitted
  // verbatim — the old expectation of "700000" encoded a permanently dead URL.
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { expiresIn: 700000 },
  );
  const params = new URL(result).searchParams;
  assert.equal(params.get("X-Amz-Expires"), "604800", "clamped to the S3 maximum of 7 days");
  assert.match(params.get("X-Amz-Signature") as string, /^[0-9a-f]{64}$/);
});

await test("SigV4Signer.presign warns for non-s3 service with >1h", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "execute-api",
  });
  const result = await signer.presign(
    { method: "GET", url: "https://api.example.com/path", headers: {}, body: null },
    { expiresIn: 7200 },
  );
  const params = new URL(result).searchParams;
  assert.equal(params.get("X-Amz-Expires"), "3600", "non-s3 services cap at 1 hour");
  assert.match(
    params.get("X-Amz-Credential") as string,
    /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request$/,
  );
  assert.match(params.get("X-Amz-Signature") as string, /^[0-9a-f]{64}$/);
});

await test("SigV4Signer.updateClockSkew updates skew", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const skewOf = (s: SigV4Signer) => (s as unknown as { clockSkewSecs: number }).clockSkewSecs;
  assert.equal(skewOf(signer), 0, "a fresh signer has no skew");
  // Was called with no assertion at all: the header was ignored and the test
  // still passed, which is how the x-amz-date gap went unnoticed.
  signer.updateClockSkew({ "x-amz-date": "20300101T120000Z" });
  const skew = skewOf(signer);
  const expected = Math.round(Date.UTC(2030, 0, 1, 12, 0, 0) / 1000 - Date.now() / 1000);
  assert.ok(Math.abs(skew - expected) <= 2, `expected ~${expected}s, got ${skew}s`);
  assert.ok(skew > 0, "2030 is in the future, so the skew must be positive");

  // The correction must actually change what gets signed.
  const req = {
    method: "GET",
    url: "https://s3.test/b",
    headers: {} as Record<string, string>,
    body: null,
  } as never;
  const before = await signer.sign(req);
  signer.updateClockSkew({ "x-amz-date": "20100101T120000Z" });
  const after = await signer.sign(req);
  assert.notEqual(after.amzDate, before.amzDate, "a corrected skew must change the signed date");
  assert.ok(after.amzDate.startsWith("20100101"), `expected a 2010 date, got ${after.amzDate}`);
});

await test("SigV4Signer.updateClockSkew with Date header", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const skewOf = (s: SigV4Signer) => (s as unknown as { clockSkewSecs: number }).clockSkewSecs;
  assert.equal(skewOf(signer), 0);
  signer.updateClockSkew({ date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  // Pinned, not merely "did not throw": 2024 is in the past, so negative.
  assert.ok(skewOf(signer) < 0, `expected a negative skew, got ${skewOf(signer)}`);
  const expected = Math.round(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000 - Date.now() / 1000);
  assert.ok(Math.abs(skewOf(signer) - expected) <= 2, `expected ~${expected}s`);
});

await test("SigV4Signer.handleClockSkewError detects and handles", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const handled = signer.handleClockSkewError(403, "RequestExpired: error", {
    "x-amz-date": "20240101T120000Z",
  });
  assert.equal(handled, true);
  const notHandled = signer.handleClockSkewError(404, "NotFound: error", {});
  assert.equal(notHandled, false);
});

await test("SigV4Signer.signPostPolicy signs policy", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const policy = {
    expiration: new Date(Date.now() + 3600000).toISOString(),
    conditions: [{ bucket: "test-bucket" }, ["starts-with", "$key", "uploads/"]],
  };
  const result = await signer.signPostPolicy(policy);
  assert.equal(typeof result.policy, "string");
  assert.equal(typeof result.signature, "string");
  assert.equal(typeof result.credential, "string");
  assert.equal(typeof result.date, "string");
  assert.ok(!result.securityToken);
});

await test("SigV4Signer.signPostPolicy with session token", async () => {
  const signer = new SigV4Signer({
    credentials: staticCredentials({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    }),
    region: "us-east-1",
    service: "s3",
  });
  const policy = {
    expiration: new Date(Date.now() + 3600000).toISOString(),
    conditions: [{ bucket: "test-bucket" }],
  };
  const result = await signer.signPostPolicy(policy);
  assert.equal(typeof result.policy, "string");
  assert.equal(typeof result.signature, "string");
  assert.equal(result.securityToken, "TOKEN");
});

await test("SigV4Signer.initChunked initializes chunked signing", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const result = await signer.initChunked({
    method: "PUT",
    url: "https://s3.amazonaws.com/bucket/key",
    headers: { "content-length": "1000" },
    body: null,
  });
  assert.notEqual(result.signedRequest, null);
  assert.equal(typeof result.signedRequest.authorization, "string");
  assert.notEqual(result.state, null);
  assert.ok(result.state.signingKey instanceof Uint8Array);
  assert.equal(typeof result.state.previousSignature, "string");
  assert.equal(typeof result.state.signingDate, "string");
  assert.equal(typeof result.state.scope, "string");
  // Should have chunked-specific headers
  assert.equal(
    result.signedRequest.headers["x-amz-content-sha256"],
    "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
  );
  assert.equal(result.signedRequest.headers["content-encoding"], "aws-chunked");
});

await test("signChunk signs a chunk correctly", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const { state } = await signer.initChunked({
    method: "PUT",
    url: "https://s3.amazonaws.com/bucket/key",
    headers: {},
    body: null,
  });

  const { chunkHeader, newState } = await signChunk("hello", state);
  assert.ok(chunkHeader.includes("chunk-signature="));
  assert.ok(chunkHeader.startsWith("5;"));

  // Second chunk chains from new state
  const { chunkHeader: chunk2 } = await signChunk("world", newState);
  assert.ok(chunk2.startsWith("5;"));
  assert.ok(chunk2.includes("chunk-signature="));
  // Verify signature chaining (different signatures per chunk)
  const sig1 = chunkHeader.match(/chunk-signature=([a-f0-9]+)/);
  const sig2 = chunk2.match(/chunk-signature=([a-f0-9]+)/);
  assert.ok(sig1 !== null && sig2 !== null);
  assert.notEqual(sig1[1], sig2[1], "Each chunk must have a unique signature");
});

await test("signFinalChunk terminates chunked upload", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const { state } = await signer.initChunked({
    method: "PUT",
    url: "https://s3.amazonaws.com/bucket/key",
    headers: {},
    body: null,
  });
  const final = await signFinalChunk(state);
  assert.match(final, /^0;chunk-signature=[0-9a-f]{64}\r\n\r\n$/);
});

// ============================================================================
// §7  TOP-LEVEL EXPORTED FUNCTIONS
// ============================================================================

suite("Top-Level Exported Functions");

await test("signRequest exports and works", async () => {
  const result = await signRequest(
    { method: "GET", url: "https://s3.amazonaws.com/", headers: {}, body: null },
    { credentials: testCredentials, region: "us-east-1", service: "s3" },
  );
  assert.equal(typeof result.authorization, "string");
});

await test("presignRequest exports and works", async () => {
  const result = await presignRequest(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { credentials: testCredentials, region: "us-east-1", service: "s3" },
  );
  const params = new URL(result).searchParams;
  assert.equal(params.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.match(params.get("X-Amz-Signature") as string, /^[0-9a-f]{64}$/);
});

await test("signS3PostPolicy exports and works", async () => {
  const result = await signS3PostPolicy(
    { expiration: new Date(Date.now() + 3600000).toISOString(), conditions: [{ bucket: "b" }] },
    { credentials: testCredentials, region: "us-east-1", service: "s3" },
  );
  assert.equal(typeof result.policy, "string");
  assert.equal(typeof result.signature, "string");
});

await test("initChunkedSigning exports and works", async () => {
  const result = await initChunkedSigning(
    { method: "PUT", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { credentials: testCredentials, region: "us-east-1", service: "s3" },
  );
  assert.notEqual(result.signedRequest, null);
  assert.notEqual(result.state, null);
});

await test("SigV4Signer initChunked with string body input", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  const { state } = await signer.initChunked({
    method: "PUT",
    url: "https://s3.amazonaws.com/bucket/key",
    headers: {},
    body: null,
  });
  const { chunkHeader } = await signChunk("string data", state);
  assert.match(chunkHeader, /^b;chunk-signature=[0-9a-f]{64}\r\n$/);
});

// ============================================================================
// §8  SIGNER FACTORIES
// ============================================================================

suite("Signer Factories");

await test("createS3Signer creates SigV4Signer", async () => {
  const signer = createS3Signer({
    credentials: testCredentials,
    region: "us-east-1",
  });
  assert.ok(signer instanceof SigV4Signer);
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: {},
    body: null,
  });
  assert.equal(typeof result.authorization, "string");
});

await test("createS3Signer with unsignedPayload", async () => {
  const signer = createS3Signer({
    credentials: testCredentials,
    region: "us-east-1",
    unsignedPayload: true,
  });
  const result = await signer.sign({
    method: "PUT",
    url: "https://s3.amazonaws.com/large",
    headers: {},
    body: null,
  });
  assert.equal(result.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

await test("createAPIGatewaySigner creates SigV4Signer", async () => {
  const signer = createAPIGatewaySigner({
    credentials: testCredentials,
    region: "us-east-1",
  });
  assert.ok(signer instanceof SigV4Signer);
  const result = await signer.sign({
    method: "GET",
    url: "https://api.example.com/users",
    headers: {},
    body: null,
  });
  assert.equal(typeof result.authorization, "string");
});

await test("createDynamoDBSigner creates SigV4Signer", async () => {
  const signer = createDynamoDBSigner({
    credentials: testCredentials,
    region: "us-east-1",
  });
  assert.ok(signer instanceof SigV4Signer);
  const result = await signer.sign({
    method: "POST",
    url: "https://dynamodb.us-east-1.amazonaws.com/",
    headers: { "x-amz-target": "DynamoDB_20120810.GetItem" },
    body: "{}",
  });
  assert.equal(typeof result.authorization, "string");
});

await test("createSTSSigner creates SigV4Signer", async () => {
  const signer = createSTSSigner({
    credentials: testCredentials,
    region: "us-east-1",
  });
  assert.ok(signer instanceof SigV4Signer);
  const result = await signer.sign({
    method: "GET",
    url: "https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
    headers: {},
    body: null,
  });
  assert.equal(typeof result.authorization, "string");
  assert.equal(typeof result.headers["host"], "string");
});

// ============================================================================
// §9  INTEGRATION TESTS — Real HTTP Calls via Kinetex
// ============================================================================

suite("Integration Tests (Real HTTP)");

await test("httpbin.org/get returns JSON via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/get returns JSON via kinetex",
    () => httpbin.get("/get"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.notEqual(response.data, null);
});

await test("httpbin.org/ip returns IP via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/ip returns IP via kinetex",
    () => httpbin.get("/ip"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.origin, "string");
});

await test("httpbin.org/post with JSON body via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/post with JSON body via kinetex",
    () => httpbin.post("/post", { message: "test", data: { key: "value" } }),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.json, { message: "test", data: { key: "value" } });
});

await test("httpbin.org/headers returns request headers via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/headers returns request headers via kinetex",
    () => httpbin.get("/headers"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.notEqual(response.data.headers, null);
});

await test("httpbin.org/json returns slideshow via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/json returns slideshow via kinetex",
    () => httpbin.get("/json"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.notEqual(response.data.slideshow, null);
});

await test("httpbin.org/uuid generates unique ID via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/uuid generates unique ID via kinetex",
    () => httpbin.get("/uuid"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.uuid, "string");
});

await test("httpbin.org/base64 decode via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/base64 decode via kinetex",
    () => httpbin.get("/base64/SGVsbG8gV29ybGQ="),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.equal(String(response.data).trim(), "Hello World");
});

await test("httpbin.org/anything echoes all request details via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin.org/anything echoes all request details via kinetex",
    () => httpbin.post("/anything", { test: true }),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.notEqual(response.data.json, null);
  assert.deepEqual(response.data.json, { test: true });
});

await test("Multiple httpbin endpoints sequential via kinetex", async () => {
  const r1 = await httpbin.get("/get");
  if (skipStatusDrift("Multiple httpbin endpoints sequential via kinetex", r1.status)) return;
  const r2 = await httpbin.get("/ip");
  if (skipStatusDrift("Multiple httpbin endpoints sequential via kinetex", r2.status)) return;
  const r3 = await httpbin.get("/uuid");
  if (skipStatusDrift("Multiple httpbin endpoints sequential via kinetex", r3.status)) return;
  const r4 = await httpbin.get("/headers");
  if (skipStatusDrift("Multiple httpbin endpoints sequential via kinetex", r4.status)) return;
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.equal(r4.status, 200);
});

await test("httpbin delayed response with timing", async () => {
  const start = Date.now();
  const response = await settleUpstream(
    "httpbin delayed response with timing",
    () => httpbin.get("/delay/0"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  const elapsed = Date.now() - start;
  assert.equal(response.status, 200);
  assert.ok(elapsed < 2000, `delay/0 took ${elapsed}ms`);
});

await test("httpbin custom response headers via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin custom response headers via kinetex",
    () =>
      httpbin.get("/response-headers", {
        headers: { "X-Custom": "test-value" },
        params: { "X-Custom": "test-value" },
      }),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
});

await test("httpbin Date header detection via kinetex", async () => {
  const response = await settleUpstream(
    "httpbin Date header detection via kinetex",
    () => httpbin.get("/get"),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.equal(typeof response.headers["date"], "string");
  assert.equal(typeof detectClockSkew(response.headers), "number");
});

await test("Real HTTP request with signed headers structure via kinetex", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  // Sign the request headers
  const signed = await signer.sign({
    method: "GET",
    url: "https://httpbin.org/headers",
    headers: { accept: "application/json" },
    body: null,
  });
  // Verify signature format
  assert.ok(signed.authorization.startsWith("AWS4-HMAC-SHA256"));
  assert.ok(signed.authorization.includes("Credential="));
  assert.ok(signed.authorization.includes("SignedHeaders="));
  assert.ok(signed.authorization.includes("Signature="));
  assert.equal(typeof signed.headers["x-amz-date"], "string");
  assert.equal(typeof signed.headers["x-amz-content-sha256"], "string");
});

await test("POST to httpbin with complex body via kinetex", async () => {
  const complexBody = {
    user: { id: 123, name: "testuser", roles: ["admin", "user"] },
    timestamp: Date.now(),
    nested: { level1: { level2: { level3: "deep" } } },
  };
  const response = await settleUpstream(
    "POST to httpbin with complex body via kinetex",
    () => httpbin.post("/anything", complexBody),
    200,
    (r) => r.status,
  );
  if (!response) return;
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.json, complexBody);
});

// ============================================================================
// §10  EDGE CASES
// ============================================================================

suite("Edge Cases");

await test("sigV4UriEncode handles empty string", async () => {
  assert.equal(sigV4UriEncode(""), "");
  assert.equal(sigV4UriEncode("", true), "");
  assert.equal(sigV4UriEncode("", false), "");
});

await test("sigV4UriEncode double-encode does not over-encode existing %25", async () => {
  const result = sigV4UriEncode("%25hello");
  assert.equal(result, "%2525hello");
});

await test("detectClockSkew with empty object", async () => {
  assert.equal(detectClockSkew({}), 0);
});

await test("detectClockSkew with null-like edge cases", async () => {
  assert.equal(detectClockSkew({ date: "" }), 0);
  assert.equal(detectClockSkew({ Date: "" }), 0);
  assert.equal(detectClockSkew({ Date: "bad-date-value" }), 0);
});

await test("isClockSkewError false for status 200 with skew text", async () => {
  assert.equal(isClockSkewError(200, "RequestExpired"), false);
});

await test("isClockSkewError false for status 403 without matching text", async () => {
  assert.equal(isClockSkewError(403, "AccessDenied: You shall not pass"), false);
});

await test("chainCredentials with single provider", async () => {
  const provider = chainCredentials(() =>
    Promise.resolve({ accessKeyId: "single", secretAccessKey: "secret" }),
  );
  const creds = await provider();
  assert.equal(creds.accessKeyId, "single");
});

await test("staticCredentials with full expiration", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const provider = staticCredentials({
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    sessionToken: "TOKEN",
    expiration: future,
  });
  const creds = await provider();
  assert.equal(creds.expiration, future);
});

await test("cachingCredentials returns cached without expiration", async () => {
  const provider = cachingCredentials(() =>
    Promise.resolve({ accessKeyId: "noexp", secretAccessKey: "secret" }),
  );
  const r1 = await provider();
  const r2 = await provider();
  assert.equal(r1.accessKeyId, r2.accessKeyId);
});

// ============================================================================
// §11  REGRESSION: CANONICAL HEADER AND PRESIGN VALIDITY FIXES
// ============================================================================

suite("regression: canonical headers");

const regressionSigner = (service = "s3") =>
  new SigV4Signer({
    credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    region: "us-east-1",
    service,
  });

const hostLineOf = (canonicalRequest: string) =>
  canonicalRequest.split("\n").find((l) => l.startsWith("host:")) ?? "";
const signedHeadersOf = (authorization: string) =>
  /SignedHeaders=([^,]+)/.exec(authorization)?.[1] ?? "";

await test("regression: an explicit Host header wins over the URL host in sign()", async () => {
  // Setting Host explicitly is how you sign for a virtual-hosted-style bucket,
  // a custom endpoint or a proxy. The URL host used to be injected
  // unconditionally, so a differently-cased caller header survived alongside it
  // and buildCanonicalHeaders' dedupe joined them into
  // `host:override.example,s3.amazonaws.com` -- a host that can never validate,
  // and one the library reported no error about.
  for (const key of ["host", "Host", "HOST", "hOsT"]) {
    const result = await regressionSigner().sign({
      method: "GET",
      url: "https://s3.amazonaws.com/",
      headers: { [key]: "override.example" },
      body: null,
    });
    assert.equal(
      hostLineOf(result.canonicalRequest),
      "host:override.example",
      `casing ${key} must not merge the two hosts`,
    );
    // The emitted header keeps whatever casing the caller used, so read it back
    // case-insensitively; what matters is that the override won.
    const emitted = Object.entries(result.headers).find(([k]) => k.toLowerCase() === "host")?.[1];
    assert.equal(
      emitted,
      "override.example",
      `casing ${key}: the emitted header must be the override`,
    );
  }
});

await test("regression: SignedHeaders has no leading or doubled separator", async () => {
  // The bug showed up twice in SignedHeaders: a leading `;` (when the empty
  // name survived) and a duplicate entry (when both host casings did).
  for (const headers of [
    { Host: "override.example" },
    { "": "v", Host: "override.example" },
    { "": "v" },
  ]) {
    const result = await regressionSigner().sign({
      method: "GET",
      url: "https://s3.amazonaws.com/",
      headers,
      body: null,
    });
    const signed = signedHeadersOf(result.authorization);
    assert.ok(!signed.startsWith(";"), `SignedHeaders must not start with ";" — got ${signed}`);
    assert.ok(!signed.includes(";;"), `SignedHeaders must not contain ";;" — got ${signed}`);
    assert.ok(!signed.endsWith(";"), `SignedHeaders must not end with ";" — got ${signed}`);
    assert.equal(
      new Set(signed.split(";")).size,
      signed.split(";").length,
      `SignedHeaders must not repeat a name — got ${signed}`,
    );
    // Every name in SignedHeaders must correspond to a real canonical line.
    for (const name of signed.split(";")) {
      assert.ok(
        result.canonicalRequest.split("\n").includes(`${name}:`) ||
          result.canonicalRequest.split("\n").some((l) => l.startsWith(`${name}:`)),
        `SignedHeaders names ${name} but no canonical line carries it`,
      );
    }
  }
});

await test("regression: an empty header name never reaches the canonical request", async () => {
  // An empty name is not a valid HTTP field-name (RFC 9110 section 5.1). It
  // used to reach the canonical request verbatim as a `:value` line with a
  // matching leading `;` in SignedHeaders; AWS answers that with an opaque
  // SignatureDoesNotMatch rather than naming the empty header.
  const result = await regressionSigner().sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: { "": "should-be-dropped", "x-custom": "kept" },
    body: null,
  });
  const lines = result.canonicalRequest.split("\n");
  assert.ok(
    !lines.some((l) => l.startsWith(":")),
    `a ":value" line must not survive: ${JSON.stringify(lines)}`,
  );
  assert.equal(signedHeadersOf(result.authorization), "host;x-amz-date;x-custom");
  assert.ok(
    lines.includes("x-custom:kept"),
    "a real header alongside the empty one must still be signed",
  );
  assert.ok(
    !result.authorization.includes("should-be-dropped"),
    "the dropped header's value must not leak into the credential",
  );
});

await test("regression: presign() honours an explicit Host header", async () => {
  // presign() had the same merge. The signature is the only place the host is
  // observable, so pin it by equivalence: overriding Host must produce exactly
  // the signature of presigning the overridden URL.
  const overridden = await regressionSigner().presign(
    { method: "GET", url: "https://override.example/b/k", headers: {}, body: null },
    { expiresIn: 3600 },
  );
  for (const key of ["host", "Host", "HOST"]) {
    const withHeader = await regressionSigner().presign(
      {
        method: "GET",
        url: "https://s3.amazonaws.com/b/k",
        headers: { [key]: "override.example" },
        body: null,
      },
      { expiresIn: 3600 },
    );
    assert.equal(
      new URL(withHeader).searchParams.get("X-Amz-Signature"),
      new URL(overridden).searchParams.get("X-Amz-Signature"),
      `casing ${key} must sign the override, not the URL host`,
    );
  }
  // And it must genuinely differ from signing the URL host, or the assertion
  // above would pass even if Host were ignored entirely.
  const urlHost = await regressionSigner().presign(
    { method: "GET", url: "https://s3.amazonaws.com/b/k", headers: {}, body: null },
    { expiresIn: 3600 },
  );
  assert.notEqual(
    new URL(urlHost).searchParams.get("X-Amz-Signature"),
    new URL(overridden).searchParams.get("X-Amz-Signature"),
  );
});

await test("regression: presign() drops an empty header name", async () => {
  const url = await regressionSigner().presign(
    { method: "GET", url: "https://s3.amazonaws.com/b/k", headers: { "": "v" }, body: null },
    {},
  );
  const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders");
  assert.equal(signed, "host", "only host is signed for a presigned URL");
  assert.ok(!signed?.startsWith(";"));
});

await test("regression: presign() clamps expiresIn into a usable range", async () => {
  // AWS rejects an out-of-range X-Amz-Expires outright -- an S3 link asking for
  // 700000s fails with AuthorizationQueryParametersError, a 0 or negative value
  // expires before it can be fetched, and a fractional one is not a valid
  // integer. These all used to be emitted verbatim with only a console warning.
  const expectations: [number, number, number][] = [
    // [requested, expected for s3, expected for non-s3]
    [0, 1, 1],
    [-1, 1, 1],
    [3.7, 3, 3],
    [1, 1, 1],
    [3600, 3600, 3600],
    [604800, 604800, 3600],
    [604801, 604800, 3600],
    [1e9, 604800, 3600],
    [Number.NaN, 604800, 3600],
  ];
  for (const [requested, forS3, forOther] of expectations) {
    for (const [service, expected] of [
      ["s3", forS3],
      ["execute-api", forOther],
    ] as const) {
      const url = await regressionSigner(service).presign(
        { method: "GET", url: "https://bucket.example.com/key", headers: {}, body: null },
        { expiresIn: requested },
      );
      const actual = new URL(url).searchParams.get("X-Amz-Expires");
      assert.equal(actual, String(expected), `${service} expiresIn ${requested}`);
      assert.match(
        actual as string,
        /^\d+$/,
        `X-Amz-Expires must be a plain integer, got ${actual}`,
      );
      assert.ok(
        Number(actual) >= 1 && Number(actual) <= (service === "s3" ? 604800 : 3600),
        `${service} expiresIn ${requested} produced an out-of-range ${actual}`,
      );
      // A clamped value must still produce a real signature.
      assert.match(new URL(url).searchParams.get("X-Amz-Signature") as string, /^[0-9a-f]{64}$/);
    }
  }
});

await test("regression: the expiresIn warning names the value actually used", async () => {
  // The old warning only repeated the rejected input, so a caller reading it
  // had no way to learn what expiry their link really got.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await regressionSigner("s3").presign(
      { method: "GET", url: "https://bucket.example.com/key", headers: {}, body: null },
      { expiresIn: 700000 },
    );
    await regressionSigner("execute-api").presign(
      { method: "GET", url: "https://api.example.com/key", headers: {}, body: null },
      { expiresIn: 7200 },
    );
    await regressionSigner("s3").presign(
      { method: "GET", url: "https://bucket.example.com/key", headers: {}, body: null },
      { expiresIn: 600 },
    );
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 2, `only the two out-of-range values warn, got ${warnings.length}`);
  // Match the "clamped to <n>" phrase specifically: the message also states the
  // valid range ("1-604800"), so a bare /604800/ would still pass if the value
  // actually applied were never reported.
  assert.match(warnings[0], /got 700000/);
  assert.match(warnings[0], /clamped to 604800/, "the warning must name the clamped value");
  assert.match(warnings[1], /got 7200/);
  assert.match(warnings[1], /clamped to 3600/, "the warning must name the clamped value");
  // The non-s3 warning must not leak the S3 ceiling.
  assert.ok(
    !warnings[1].includes("604800"),
    `the non-s3 warning mentions the s3 limit: ${warnings[1]}`,
  );
});

// ============================================================================
// §11  SUMMARY
// ============================================================================

// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
suite("regression: clock-skew detection and correction");

const FUTURE = "20350101T120000Z";
const FUTURE_EPOCH_S = Math.round(Date.UTC(2035, 0, 1, 12, 0, 0) / 1000);

await test("regression: detectClockSkew reads x-amz-date", async () => {
  // Only the Date header used to be read, so the header AWS actually sends
  // on a clock-skew error was invisible.
  const skew = detectClockSkew({ "x-amz-date": FUTURE });
  assert.ok(Math.abs(skew - (FUTURE_EPOCH_S - Math.round(Date.now() / 1000))) <= 2, `got ${skew}`);
});

await test("regression: detectClockSkew prefers x-amz-date over Date", async () => {
  // Date is written by whatever proxy fronts the endpoint and can be wildly
  // wrong; x-amz-date is the timestamp AWS signed against.
  const skew = detectClockSkew({ date: "Mon, 01 Jan 2000 00:00:00 GMT", "x-amz-date": FUTURE });
  assert.ok(skew > 0, `x-amz-date must win, got ${skew}`);
});

await test("regression: detectClockSkew still reads Date when x-amz-date is absent", async () => {
  const skew = detectClockSkew({ date: new Date(Date.now() + 60_000).toUTCString() });
  assert.ok(skew > 50 && skew <= 61, `expected ~60s, got ${skew}`);
  assert.equal(detectClockSkew({}), 0, "no timestamp at all means no skew");
});

await test("regression: detectClockSkew rejects a malformed x-amz-date", async () => {
  for (const bad of [
    "not-a-date",
    "2035-01-01T12:00:00Z", // ISO 8601, not AWS's basic form
    "20350101",
    "20350101T120000", // missing the trailing Z
    "20350101T1200Z", // malformed time
  ]) {
    assert.equal(detectClockSkew({ "x-amz-date": bad }), 0, `${bad} must not parse`);
  }
});

await test("regression: detectClockSkew rejects out-of-range x-amz-date parts", async () => {
  // Date.UTC rolls month 13 over into the next year; that would silently
  // produce a plausible but wrong instant.
  for (const bad of ["20351301T120000Z", "20350132T120000Z", "20350101T250000Z"]) {
    assert.equal(detectClockSkew({ "x-amz-date": bad }), 0, `${bad} must not parse`);
  }
});

await test("regression: the client re-signs with a corrected date after RequestTimeTooSkewed", async () => {
  const dates: string[] = [];
  const client = kinetex({
    baseURL: "https://s3.us-east-1.amazonaws.com",
    awsSigning: {
      credentials: testCredentials,
      region: "us-east-1",
      service: "s3",
    },
    retry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 10, jitter: 0 },
    fetch: (async (_u: unknown, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      dates.push(String(h["x-amz-date"] ?? ""));
      return new Response("<Error><Code>RequestTimeTooSkewed</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml", "x-amz-date": FUTURE },
      });
    }) as unknown as typeof fetch,
  });
  try {
    await client.get("/bucket/key");
    assert.fail("expected the second attempt to fail too");
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, "EHTTPSTATUS");
  } finally {
    client.destroy();
  }
  // Before the fix: one attempt, signed with the host's wrong clock.
  assert.equal(dates.length, 2, `expected exactly 2 attempts, got ${JSON.stringify(dates)}`);
  // The corrected date must land on the server's clock (12:00:00 UTC minus
  // the few ms the attempt took), not merely differ from the first one.
  const corrected = dates[1]!;
  assert.match(
    corrected,
    /^20350101T1[12]\d{2}\d{2}Z$/,
    `retry must sign near the server clock, got ${corrected}`,
  );
  const drift = Math.abs(
    Date.UTC(2035, 0, 1, 12, 0, 0) -
      Date.parse(
        `${corrected.slice(0, 4)}-${corrected.slice(4, 6)}-${corrected.slice(6, 8)}T${corrected.slice(9, 11)}:${corrected.slice(11, 13)}:${corrected.slice(13, 15)}Z`,
      ),
  );
  assert.ok(
    drift <= 120_000,
    `corrected date must be within 2 min of the server clock, off by ${drift}ms`,
  );
  assert.notEqual(dates[0], dates[1]);
});

await test("regression: the clock-skew correction is spent at most once", async () => {
  // A server that keeps reporting a different time must not spin forever.
  let calls = 0;
  const client = kinetex({
    baseURL: "https://s3.us-east-1.amazonaws.com",
    awsSigning: {
      credentials: testCredentials,
      region: "us-east-1",
      service: "s3",
    },
    retry: { maxRetries: 5, baseDelayMs: 5, maxDelayMs: 10, jitter: 0 },
    fetch: (async () => {
      calls++;
      return new Response("<Error><Code>RequestTimeTooSkewed</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml", "x-amz-date": FUTURE },
      });
    }) as unknown as typeof fetch,
  });
  try {
    await client.get("/bucket/key");
    assert.fail("expected a rejection");
  } catch {
    /* expected */
  } finally {
    client.destroy();
  }
  assert.equal(calls, 2, "one correction, then give up — not maxRetries+1");
});

await test("regression: a 403 that is not a clock-skew error is not retried", async () => {
  let calls = 0;
  const client = kinetex({
    baseURL: "https://s3.us-east-1.amazonaws.com",
    awsSigning: {
      credentials: testCredentials,
      region: "us-east-1",
      service: "s3",
    },
    retry: { maxRetries: 3, baseDelayMs: 5, maxDelayMs: 10, jitter: 0 },
    fetch: (async () => {
      calls++;
      return new Response("<Error><Code>AccessDenied</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml", "x-amz-date": FUTURE },
      });
    }) as unknown as typeof fetch,
  });
  try {
    await client.get("/bucket/key");
    assert.fail("expected a rejection");
  } catch {
    /* expected */
  } finally {
    client.destroy();
  }
  assert.equal(calls, 1, "AccessDenied is not a skew error, so no correction and no retry");
});

await test("regression: clock skew is not consulted when awsSigning is absent", async () => {
  let calls = 0;
  const client = kinetex({
    baseURL: "https://api.example.test",
    retry: { maxRetries: 3, baseDelayMs: 5, maxDelayMs: 10, jitter: 0 },
    fetch: (async () => {
      calls++;
      return new Response("<Error><Code>RequestTimeTooSkewed</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml", "x-amz-date": FUTURE },
      });
    }) as unknown as typeof fetch,
  });
  try {
    await client.get("/x");
    assert.fail("expected a rejection");
  } catch {
    /* expected */
  } finally {
    client.destroy();
  }
  assert.equal(calls, 1, "no signer, so no skew correction and no forced retry");
});

console.log(`\n${"=".repeat(60)}`);
console.log(
  `  AWS SIGV4 TEST RESULTS: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
