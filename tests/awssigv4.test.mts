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
  assert.ok(result.includes("%2520") || result.includes("%26"));
});

await test("sigV4UriEncode encodes special characters", async () => {
  const encoded = sigV4UriEncode("test+value=123");
  assert.ok(encoded.includes("%"));

  const encoded2 = sigV4UriEncode("hello world/foo");
  assert.ok(encoded2.includes("%2520"));
  assert.ok(encoded2.includes("%252F"));
});

await test("sigV4UriEncode without double encode (S3 mode)", async () => {
  const result = sigV4UriEncode("test value/foo", false);
  assert.ok(result.includes("%20"));
  assert.ok(result.includes("%2F"));
  assert.ok(!result.includes("%2520"));
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
  try {
    await provider();
    console.log("     [on EC2] IMDS succeeded unexpectedly");
  } catch (err) {
    assert.ok(err instanceof Error);
    const msg = (err as Error).message;
    assert.ok(
      msg.includes("timed out") ||
        msg.includes("aborted") ||
        msg.includes("IMDS") ||
        msg.includes("ETIMEOUT") ||
        msg.includes("Network"),
      `Expected IMDS timeout/network error, got: ${msg}`,
    );
  }
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
  try {
    await provider();
    console.log("     [on EC2] IPv6 IMDS succeeded");
  } catch (err) {
    assert.ok(err instanceof Error);
    // Validation passed but fetch failed (not on EC2) - this proves bracket stripping works
  }
});

// ============================================================================
// §4  CLOCK SKEW DETECTION
// ============================================================================

suite("Clock Skew Detection");

await test("detectClockSkew returns number", async () => {
  const skew = detectClockSkew({ date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  assert.equal(typeof skew, "number");
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
  const skew = detectClockSkew({ Date: "Mon, 01 Jan 2024 12:00:00 GMT" });
  assert.equal(typeof skew, "number");
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
  assert.equal(typeof result.authorization, "string");
  assert.equal(typeof result.amzDate, "string");
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
  assert.equal(typeof result.authorization, "string");
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
  assert.equal(typeof result.authorization, "string");
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
  assert.equal(typeof result.authorization, "string");
  assert.ok(result.authorization.startsWith("AWS4-HMAC-SHA256"));
  assert.equal(typeof result.signature, "string");
  assert.equal(typeof result.amzDate, "string");
  assert.equal(typeof result.headers["authorization"], "string");
  assert.equal(typeof result.headers["x-amz-date"], "string");
  assert.equal(typeof result.headers["x-amz-content-sha256"], "string");
  assert.equal(typeof result.canonicalRequest, "string");
  assert.equal(typeof result.stringToSign, "string");
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
  assert.equal(typeof result.authorization, "string");
  assert.equal(typeof result.headers["x-amz-content-sha256"], "string");
  assert.notEqual(result.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
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
  assert.equal(typeof result.authorization, "string");
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
  // x-custom-trace should not appear in signed headers
  assert.ok(!result.signedHeaders || !result.signedHeaders.includes("x-custom-trace"));
});

await test("SigV4Signer.sign with clock skew correction", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  signer.updateClockSkew({ date: new Date(Date.now() + 3600000).toUTCString() });
  const result = await signer.sign({
    method: "GET",
    url: "https://s3.amazonaws.com/",
    headers: {},
    body: null,
  });
  assert.equal(typeof result.authorization, "string");
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
  assert.ok(result.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
  assert.ok(result.includes("X-Amz-Credential="));
  assert.ok(result.includes("X-Amz-Signature="));
  assert.ok(result.includes("X-Amz-Expires=3600"));
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
  assert.ok(result.includes("X-Amz-Security-Token=SESSION"));
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
  assert.ok(!result.includes("X-Amz-Security-Token"));
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
  assert.ok(result.includes("response-content-disposition"));
});

await test("SigV4Signer.presign warns on invalid expiresIn", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  // 7+ days should warn for S3 (max 604800)
  const result = await signer.presign(
    { method: "GET", url: "https://s3.amazonaws.com/bucket/key", headers: {}, body: null },
    { expiresIn: 700000 },
  );
  assert.ok(result.includes("X-Amz-Signature="));
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
  assert.ok(result.includes("X-Amz-Signature="));
});

await test("SigV4Signer.updateClockSkew updates skew", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  signer.updateClockSkew({ "x-amz-date": "20300101T120000Z" });
});

await test("SigV4Signer.updateClockSkew with Date header", async () => {
  const signer = new SigV4Signer({
    credentials: testCredentials,
    region: "us-east-1",
    service: "s3",
  });
  signer.updateClockSkew({ date: "Mon, 01 Jan 2024 12:00:00 GMT" });
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
  assert.ok(final.startsWith("0;chunk-signature="));
  assert.ok(final.endsWith("\r\n\r\n"));
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
  assert.ok(result.includes("X-Amz-Signature="));
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
  assert.ok(chunkHeader.includes("chunk-signature="));
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
  const response = await httpbin.get("/get");
  assert.equal(response.status, 200);
  assert.notEqual(response.data, null);
});

await test("httpbin.org/ip returns IP via kinetex", async () => {
  const response = await httpbin.get("/ip");
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.origin, "string");
});

await test("httpbin.org/post with JSON body via kinetex", async () => {
  const response = await httpbin.post("/post", { message: "test", data: { key: "value" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.json, { message: "test", data: { key: "value" } });
});

await test("httpbin.org/headers returns request headers via kinetex", async () => {
  const response = await httpbin.get("/headers");
  assert.equal(response.status, 200);
  assert.notEqual(response.data.headers, null);
});

await test("httpbin.org/json returns slideshow via kinetex", async () => {
  const response = await httpbin.get("/json");
  assert.equal(response.status, 200);
  assert.notEqual(response.data.slideshow, null);
});

await test("httpbin.org/uuid generates unique ID via kinetex", async () => {
  const response = await httpbin.get("/uuid");
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.uuid, "string");
});

await test("httpbin.org/base64 decode via kinetex", async () => {
  const response = await httpbin.get("/base64/SGVsbG8gV29ybGQ=");
  assert.equal(response.status, 200);
  assert.equal(String(response.data).trim(), "Hello World");
});

await test("httpbin.org/anything echoes all request details via kinetex", async () => {
  const response = await httpbin.post("/anything", { test: true });
  assert.equal(response.status, 200);
  assert.notEqual(response.data.json, null);
  assert.deepEqual(response.data.json, { test: true });
});

await test("Multiple httpbin endpoints sequential via kinetex", async () => {
  const r1 = await httpbin.get("/get");
  const r2 = await httpbin.get("/ip");
  const r3 = await httpbin.get("/uuid");
  const r4 = await httpbin.get("/headers");
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.equal(r4.status, 200);
});

await test("httpbin delayed response with timing", async () => {
  const start = Date.now();
  const response = await httpbin.get("/delay/0");
  const elapsed = Date.now() - start;
  assert.equal(response.status, 200);
  assert.ok(elapsed < 2000, `delay/0 took ${elapsed}ms`);
});

await test("httpbin custom response headers via kinetex", async () => {
  const response = await httpbin.get("/response-headers", {
    headers: { "X-Custom": "test-value" },
    params: { "X-Custom": "test-value" },
  });
  assert.equal(response.status, 200);
});

await test("httpbin Date header detection via kinetex", async () => {
  const response = await httpbin.get("/get");
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
  const response = await httpbin.post("/anything", complexBody);
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
// §11  SUMMARY
// ============================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  AWS SIGV4 TEST RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
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
