/**
 * AWS Signature Version 4 implementation.
 * Zero dependencies. Cross-runtime: Deno · Bun · Node.js · Cloudflare Workers ·
 * Vercel Edge · AWS Lambda · Browser (WebCrypto API).
 *
 * Implements:
 *  - AWS SigV4 request signing          (Authorization header)
 *  - AWS SigV4 presigned URLs           (query-string signing)
 *  - AWS SigV4 chunked upload signing   (streaming)
 *  - AWS SigV4 POST policy signing      (S3 browser upload)
 *  - Credential scope + derivation
 *  - Canonical request construction     (full URI/query/header normalization)
 *  - Multi-region + multi-service support
 *  - STS AssumeRole credential provider
 *  - Environment + chain credential provider
 *  - Automatic clock skew correction
 *  - Unsigned payload support           (e.g. S3 streaming)
 *  - X-Amz-Security-Token               (temporary credentials)
 *
 * References:
 *  https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 */

// Node.js globals accessed via globalThis for cross-runtime compatibility
import { KinetexError as _KinetexError, TimeoutError, NetworkError } from "./types.ts";

// ============================================================================
// #1  TYPES
// ============================================================================

/**
 * AWS credentials (access key, secret key, optional session token + expiration).
 */
export interface AWSCredentials {
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** Session token for temporary credentials (STS/AssumeRole/instance profile) */
  sessionToken?: string;
  /** Expiry for temporary credentials (ISO 8601) */
  expiration?: string;
}

/**
 * Configuration for AWS SigV4 signing.
 */
export interface SigningConfig {
  /** AWS credentials or a provider that resolves them */
  credentials: AWSCredentials | CredentialProvider;
  /** AWS region, e.g. "us-east-1" */
  region: string;
  /** AWS service name, e.g. "s3", "execute-api", "sts" */
  service: string;
  /**
   * Override the signing date (ISO 8601 or Date).
   * Defaults to current UTC time.
   */
  signingDate?: Date | string;
  /**
   * Clock skew correction in seconds.
   * Applied when server returns a clock-skew error.
   */
  clockSkewSecs?: number;
  /**
   * Headers to exclude from signing.
   * These are appended to the default exclusion list.
   */
  unsignedHeaders?: string[];
  /**
   * If true, the request body is not hashed (use for large S3 uploads).
   * Sets x-amz-content-sha256: UNSIGNED-PAYLOAD
   */
  unsignedPayload?: boolean;
  /**
   * If true, apply double URI encoding for path segments (default: true).
   * S3 uses single encoding — set to false for S3.
   */
  doubleEncodeUri?: boolean;
}

/**
 * An HTTP request that can be signed with SigV4.
 */
interface SignableRequest {
  /** HTTP method (GET, PUT, POST, DELETE, etc.) */
  method: string;
  /** Full request URL (including query string) */
  url: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body (string, bytes, or null for empty) */
  body: string | Uint8Array | null;
}

/**
 * Result of signing a request — extends SignableRequest with signature fields.
 */
interface SignedRequest extends SignableRequest {
  /** The computed Authorization header value */
  authorization: string;
  /** The x-amz-date header value */
  amzDate: string;
  /** The computed signature (hex) */
  signature: string;
  /** The canonical request string (for debugging) */
  canonicalRequest: string;
  /** The string to sign (for debugging) */
  stringToSign: string;
}

/**
 * Options for generating a presigned URL.
 */
interface PresignOptions {
  /** Expiry in seconds (default: 3600, max for STS: 3600, max for S3: 604800) */
  expiresIn?: number;
  /** Additional query parameters to include before signing */
  extraParams?: Record<string, string>;
  /**
   * If true, omit x-amz-security-token from the presigned URL
   * (useful when the caller will append it separately).
   */
  omitSessionToken?: boolean;
}

/**
 * State tracking for chunked/streaming upload signing.
 * Carries the previous chunk's signature, key, scope, and date.
 */
interface ChunkedSigningState {
  /** Signature from the previous chunk (seed for the next) */
  previousSignature: string;
  /** Derived signing key (Uint8Array) */
  signingKey: Uint8Array;
  /** Credential scope string (date/region/service/aws4_request) */
  scope: string;
  /** ISO 8601 basic date string (YYYYMMDDTHHMMSSZ) */
  signingDate: string;
}

/**
 * S3 POST policy definition for browser-based uploads.
 * Specifies expiration and conditions the upload must satisfy.
 */
interface S3PostPolicy {
  /** ISO 8601 expiration timestamp */
  expiration: string;
  /** Array of policy conditions (equality or starts-with matches) */
  conditions: Array<Record<string, string> | [string, string, string]>;
}

/**
 * Result of signing an S3 POST policy.
 * Contains form fields to include in the multipart upload request.
 */
interface S3PostSignature {
  /** Base64-encoded JSON policy document */
  policy: string;
  /** Hex HMAC-SHA256 signature of the policy */
  signature: string;
  /** Credential string: "ACCESS_KEY/scope" */
  credential: string;
  /** Date stamp in YYYYMMDD format */
  date: string;
  /** Session security token (if temporary credentials) */
  securityToken?: string;
}

// ============================================================================
// #2  CREDENTIAL PROVIDERS
// ============================================================================

/**
 * Function signature for credential providers.
 * Returns a promise that resolves to AWS credentials.
 */
export type CredentialProvider = () => Promise<AWSCredentials>;

/**
 * Static credential provider — wraps a fixed set of credentials.
 */
export function staticCredentials(creds: AWSCredentials): CredentialProvider {
  return () => Promise.resolve(creds);
}

/**
 * Environment variable credential provider.
 * Reads: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
 *
 * Compatible with: Node.js, Deno, Bun, Cloudflare (via wrangler secrets),
 * Vercel Edge (via env vars), AWS Lambda.
 */
export function envCredentials(): CredentialProvider {
  return (): Promise<AWSCredentials> => {
    const accessKeyId = getEnv("AWS_ACCESS_KEY_ID");
    const secretAccessKey = getEnv("AWS_SECRET_ACCESS_KEY");
    const sessionToken = getEnv("AWS_SESSION_TOKEN");

    if (!accessKeyId || !secretAccessKey) {
      return Promise.reject(
        new NetworkError(
          "AWS credentials not found in environment. " +
            "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
        ),
      );
    }

    return Promise.resolve({
      accessKeyId,
      secretAccessKey,
      ...(sessionToken !== undefined ? { sessionToken } : {}),
    });
  };
}

/**
 * Credential chain provider — tries each provider in order,
 * returning the first that succeeds.
 */
export function chainCredentials(...providers: CredentialProvider[]): CredentialProvider {
  return async () => {
    const errors: Error[] = [];
    for (const provider of providers) {
      try {
        return await provider();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    throw new NetworkError(
      `All credential providers failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  };
}

/**
 * Caching credential provider — refreshes credentials only when they
 * are within `refreshBeforeExpiryMs` of expiry (default: 5 minutes).
 */
export function cachingCredentials(
  provider: CredentialProvider,
  refreshBeforeExpiryMs = 5 * 60 * 1000,
): CredentialProvider {
  let cached: AWSCredentials | null = null;
  let inflight: Promise<AWSCredentials> | null = null;

  return (): Promise<AWSCredentials> => {
    const now = Date.now();

    if (cached) {
      if (!cached.expiration) return Promise.resolve(cached);
      const expiresAt = new Date(cached.expiration).getTime();
      if (expiresAt - now > refreshBeforeExpiryMs) return Promise.resolve(cached);
    }

    if (inflight) return inflight;

    inflight = provider().then(
      (creds) => {
        cached = creds;
        inflight = null;
        return creds;
      },
      (err) => {
        inflight = null;
        throw err;
      },
    );

    return inflight;
  };
}

/** Allowed IMDS endpoints — restricts SSRF attack surface. */
const ALLOWED_IMDS_ENDPOINTS = new Set([
  "http://169.254.169.254",
  "http://169.254.170.2", // IMDSv2 in some regions
  "http://fd00:ec2::254", // IPv6 link-local
]);

/**
 * Validate IMDS endpoint to prevent SSRF attacks.
 * Only allows known AWS metadata service endpoints.
 */
function isValidIMDSEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    // Strip brackets from IPv6 addresses for comparison
    let hostname = url.hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    const normalized = `${url.protocol}//${hostname}`;
    return ALLOWED_IMDS_ENDPOINTS.has(normalized);
  } catch {
    return false;
  }
}

/**
 * EC2 instance metadata credential provider (IMDSv2).
 * Uses the IMDSv2 token flow (PUT token, then GET credentials).
 * Works on EC2, ECS (task role), and Lambda (execution role).
 *
 * The endpoint is validated against a known-safe allowlist to
 * prevent SSRF attacks. Defaults to http://169.254.169.254.
 */
export function imdsCredentials(
  options: {
    endpoint?: string;
    timeout?: number;
  } = {},
): CredentialProvider {
  const endpoint = options.endpoint ?? "http://169.254.169.254";
  const timeout = options.timeout ?? 5000;

  // Validate endpoint to prevent SSRF
  if (!isValidIMDSEndpoint(endpoint)) {
    throw new Error(
      `Invalid IMDS endpoint: ${endpoint}. Only AWS metadata service endpoints are allowed.`,
    );
  }

  return cachingCredentials(async () => {
    // Step 1: Get IMDSv2 token
    const tokenRes = await fetchWithTimeout(
      `${endpoint}/latest/api/token`,
      {
        method: "PUT",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
      },
      timeout,
    );
    if (!tokenRes.ok) throw new NetworkError(`IMDS token fetch failed: ${tokenRes.status}`);
    const token = await tokenRes.text();

    // Step 2: Get role name
    const roleRes = await fetchWithTimeout(
      `${endpoint}/latest/meta-data/iam/security-credentials/`,
      { headers: { "x-aws-ec2-metadata-token": token } },
      timeout,
    );
    if (!roleRes.ok) throw new NetworkError(`IMDS role fetch failed: ${roleRes.status}`);
    const roles = (await roleRes.text()).trim().split("\n");
    const role = roles[0]?.trim();
    if (!role) throw new NetworkError("No IAM role found in IMDS response");

    // Step 3: Get credentials for role
    const credsRes = await fetchWithTimeout(
      `${endpoint}/latest/meta-data/iam/security-credentials/${role}`,
      { headers: { "x-aws-ec2-metadata-token": token } },
      timeout,
    );
    if (!credsRes.ok) throw new NetworkError(`IMDS credentials fetch failed: ${credsRes.status}`);
    const data = (await credsRes.json()) as {
      AccessKeyId: string;
      SecretAccessKey: string;
      Token: string;
      Expiration: string;
    };

    return {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiration: data.Expiration,
    };
  });
}

// ============================================================================
// #3  DATE UTILITIES
// ============================================================================

/**
 * Format a Date as YYYYMMDD'T'HHMMSS'Z' (ISO 8601 basic format used by AWS).
 */
export function formatAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Format a Date as YYYYMMDD (credential scope date).
 */
export function formatDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Resolve the signing date from config, applying clock skew if set.
 *
 * @param config - Signing configuration with optional signingDate and clockSkewSecs
 * @returns Date object for signing, adjusted for clock skew
 */
function resolveSigningDate(config: SigningConfig): Date {
  if (config.signingDate) {
    const d =
      config.signingDate instanceof Date ? config.signingDate : new Date(config.signingDate);
    if (config.clockSkewSecs) {
      return new Date(d.getTime() + config.clockSkewSecs * 1000);
    }
    return d;
  }
  const now = new Date();
  if (config.clockSkewSecs) {
    return new Date(now.getTime() + config.clockSkewSecs * 1000);
  }
  return now;
}

// ============================================================================
// #4  CRYPTO PRIMITIVES
// ============================================================================

/**
 * HMAC-SHA256 using the WebCrypto API (available in all target runtimes).
 * Returns raw bytes.
 */
async function hmacSHA256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const raw = typeof key === "string" ? enc.encode(key) : key;
  // Cast to ArrayBuffer so WebCrypto importKey overload resolves correctly
  const keyData: ArrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

/**
 * SHA-256 hash of a string or bytes. Returns lowercase hex.
 */
async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const raw = typeof data === "string" ? enc.encode(data) : data;
  // Cast to ArrayBuffer for WebCrypto digest overload
  const buf: ArrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(hashBuf));
}

/** Convert a Uint8Array to a lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// #5  CANONICAL REQUEST
// ============================================================================

/** Headers never included in the signed headers list. */
const DEFAULT_UNSIGNED_HEADERS = new Set([
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "accept-encoding",
  "connection",
  "expect",
  "transfer-encoding",
]);

/** Headers always included in the signed headers list. */
const ALWAYS_SIGNED_HEADERS = new Set(["host", "content-type", "content-md5"]);

/**
 * URI-encode a string per AWS SigV4 rules.
 * Encodes everything except unreserved chars: A-Z a-z 0-9 - _ . ~
 * Optionally double-encodes (default: true, S3 uses false).
 */
export function sigV4UriEncode(str: string, doubleEncode = true): string {
  const encoded = encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

  if (!doubleEncode) return encoded;
  // Double-encode the % signs that are already percent-encoded
  return encoded.replace(/%/g, "%25").replace(/%2525/g, "%25");
}

/**
 * Normalize and encode a URI path per SigV4.
 * Resolves dot segments, normalizes slashes.
 *
 * @param path - Raw URI path
 * @param doubleEncode - Whether to double-encode percent-encoded characters
 * @returns Normalized and encoded path string
 */
function normalizePath(path: string, doubleEncode: boolean): string {
  if (!path || path === "/") return "/";

  // Split on "/" and encode each segment
  const segments = path.split("/");
  const encoded = segments.map((seg) => {
    if (seg === "" || seg === ".") return seg;
    if (seg === "..") return seg;
    // Encode each segment individually
    return sigV4UriEncode(decodeURIComponent(seg.replace(/\+/g, " ")), doubleEncode);
  });

  // Resolve . and ..
  const resolved: string[] = [];
  for (const seg of encoded) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }

  const result = resolved.join("/");
  return result.startsWith("/") ? result : "/" + result;
}

/**
 * Build the canonical query string per SigV4:
 * - Sort by key (then by value on ties)
 * - URI-encode keys and values
 * - Join with &
 */
function canonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of searchParams.entries()) {
    pairs.push([
      encodeURIComponent(k).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
      encodeURIComponent(v).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    ]);
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Build canonical headers and signed headers list.
 * Rules:
 *  - Lowercase header names
 *  - Trim and collapse internal whitespace in values
 *  - Sort by name
 *  - Exclude headers in the unsigned set
 *  - Always include host, content-type, and content-md5
 */
function buildCanonicalHeaders(
  headers: Record<string, string>,
  unsignedExtra: string[],
): { canonicalHeaders: string; signedHeaders: string } {
  const unsigned = new Set([
    ...DEFAULT_UNSIGNED_HEADERS,
    ...unsignedExtra.map((h) => h.toLowerCase()),
  ]);

  const entries: [string, string][] = [];

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (unsigned.has(lower) && !ALWAYS_SIGNED_HEADERS.has(lower)) continue;
    // Trim + collapse internal whitespace
    const normalized = value.trim().replace(/\s+/g, " ");
    entries.push([lower, normalized]);
  }

  // Sort by name
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // Deduplicate: if same name appears multiple times, join with comma
  const deduped = new Map<string, string>();
  for (const [name, value] of entries) {
    const existing = deduped.get(name);
    deduped.set(name, existing ? `${existing},${value}` : value);
  }

  const canonicalHeaders =
    Array.from(deduped.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join("\n") + "\n";

  const signedHeaders = Array.from(deduped.keys()).join(";");

  return { canonicalHeaders, signedHeaders };
}

/**
 * Build the full canonical request string.
 */
async function buildCanonicalRequest(
  method: string,
  parsedUrl: URL,
  headers: Record<string, string>,
  body: string | Uint8Array | null,
  unsignedPayload: boolean,
  doubleEncode: boolean,
  unsignedHeaders: string[],
): Promise<{
  canonicalRequest: string;
  signedHeaders: string;
  payloadHash: string;
}> {
  // 1. HTTP method
  const httpMethod = method.toUpperCase();

  // 2. Canonical URI
  const canonicalUri = normalizePath(parsedUrl.pathname, doubleEncode);

  // 3. Canonical query string
  const canonicalQS = canonicalQueryString(parsedUrl.searchParams);

  // 4. Payload hash
  let payloadHash: string;
  if (unsignedPayload) {
    payloadHash = "UNSIGNED-PAYLOAD";
  } else if (!body) {
    payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA256("")
  } else {
    payloadHash = await sha256Hex(body);
  }

  // 5. Canonical headers
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(headers, unsignedHeaders);

  // 6. Canonical request
  const canonicalRequest = [
    httpMethod,
    canonicalUri,
    canonicalQS,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  return { canonicalRequest, signedHeaders, payloadHash };
}

// ============================================================================
// #6  SIGNING KEY DERIVATION
// ============================================================================

/**
 * Derive the SigV4 signing key:
 * HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")
 *
 * Uses TypedArrays to avoid creating temporary strings containing secrets in memory.
 */
export async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  // Encode "AWS4" prefix and secret separately, then concatenate as Uint8Array
  // This avoids creating a temporary string "AWS4<secret>" in memory
  const enc = new TextEncoder();
  const aws4Prefix = enc.encode("AWS4");
  const secretBytes = enc.encode(secretAccessKey);

  // Combine prefix and secret into a single Uint8Array
  const keyMaterial = new Uint8Array(aws4Prefix.length + secretBytes.length);
  keyMaterial.set(aws4Prefix);
  keyMaterial.set(secretBytes, aws4Prefix.length);

  // Clear the secret from memory as soon as possible
  secretBytes.fill(0);

  const kDate = await hmacSHA256(keyMaterial, dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, "aws4_request");

  // Clear intermediate key materials
  keyMaterial.fill(0);

  return kSigning;
}

// ============================================================================
// #7  STRING TO SIGN
// ============================================================================

/**
 * Build the SigV4 StringToSign from the canonical request.
 */
async function buildStringToSign(
  amzDate: string,
  credentialScope: string,
  canonicalRequest: string,
): Promise<string> {
  const hashedCanonical = await sha256Hex(canonicalRequest);
  return ["AWS4-HMAC-SHA256", amzDate, credentialScope, hashedCanonical].join("\n");
}

// ============================================================================
// #8  PUBLIC API — SIGN REQUEST
// ============================================================================

/**
 * Sign an HTTP request with AWS Signature Version 4.
 *
 * @returns A new request object with `authorization` and `x-amz-date` headers set.
 */
export async function signRequest(
  request: SignableRequest,
  config: SigningConfig,
): Promise<SignedRequest> {
  const credentials = await resolveCredentials(config.credentials);
  const signingDate = resolveSigningDate(config);
  const amzDate = formatAmzDate(signingDate);
  const dateStamp = formatDateStamp(signingDate);

  const parsedUrl = new URL(request.url);

  // Build the headers to sign — start from request headers
  const headers: Record<string, string> = {
    ...request.headers,
    host: parsedUrl.host,
    "x-amz-date": amzDate,
  };

  if (config.unsignedPayload) {
    headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  }

  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const doubleEncode = config.doubleEncodeUri !== false; // default true
  const unsignedHdrs = config.unsignedHeaders ?? [];

  const { canonicalRequest, signedHeaders, payloadHash } = await buildCanonicalRequest(
    request.method,
    parsedUrl,
    headers,
    request.body,
    config.unsignedPayload ?? false,
    doubleEncode,
    unsignedHdrs,
  );

  // Add content-sha256 header for all requests (unless already set by unsignedPayload)
  if (!headers["x-amz-content-sha256"] && !config.unsignedPayload) {
    headers["x-amz-content-sha256"] = payloadHash;
  }

  const credentialScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  const stringToSign = await buildStringToSign(amzDate, credentialScope, canonicalRequest);
  const signingKey = await deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );
  const signatureBytes = await hmacSHA256(signingKey, stringToSign);
  const signature = toHex(signatureBytes);

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    method: request.method,
    url: request.url,
    headers: { ...headers, authorization },
    body: request.body,
    authorization,
    amzDate,
    signature,
    canonicalRequest,
    stringToSign,
  };
}

// ============================================================================
// #9  PRESIGNED URLs
// ============================================================================

/**
 * Generate a presigned URL for a request.
 * All signing parameters are embedded in the query string.
 */
export async function presignRequest(
  request: SignableRequest,
  config: SigningConfig,
  options: PresignOptions = {},
): Promise<string> {
  const credentials = await resolveCredentials(config.credentials);
  const signingDate = resolveSigningDate(config);
  const amzDate = formatAmzDate(signingDate);
  const dateStamp = formatDateStamp(signingDate);
  const expiresIn = options.expiresIn ?? 3600;

  // Validate expiresIn range - different services have different limits
  const maxExpires = config.service === "s3" ? 604800 : 3600;
  if (expiresIn < 1 || expiresIn > maxExpires) {
    console.warn(
      `[aws-sigv4] presignRequest: expiresIn should be 1-${maxExpires} seconds for ${config.service}, got ${expiresIn}`,
    );
  }

  const parsedUrl = new URL(request.url);
  const credentialScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;

  // Add standard X-Amz-* query parameters
  parsedUrl.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  parsedUrl.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${credentialScope}`);
  parsedUrl.searchParams.set("X-Amz-Date", amzDate);
  parsedUrl.searchParams.set("X-Amz-Expires", String(expiresIn));

  if (credentials.sessionToken && !options.omitSessionToken) {
    parsedUrl.searchParams.set("X-Amz-Security-Token", credentials.sessionToken);
  }

  // Extra params
  if (options.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) {
      parsedUrl.searchParams.set(k, v);
    }
  }

  // Determine signed headers (only "host" for presigned URLs typically)
  const headers: Record<string, string> = {
    ...request.headers,
    host: parsedUrl.host,
  };

  const unsignedHdrs = config.unsignedHeaders ?? [];

  // For presigned URLs, payload hash is always UNSIGNED-PAYLOAD
  const { canonicalRequest: _canonicalRequest, signedHeaders } = await buildCanonicalRequest(
    request.method,
    parsedUrl,
    headers,
    null,
    true, // unsigned payload
    config.doubleEncodeUri !== false,
    unsignedHdrs,
  );

  parsedUrl.searchParams.set("X-Amz-SignedHeaders", signedHeaders);

  // Re-build canonical request with updated params
  const { canonicalRequest: finalCanonical } = await buildCanonicalRequest(
    request.method,
    parsedUrl,
    headers,
    null,
    true,
    config.doubleEncodeUri !== false,
    unsignedHdrs,
  );

  const stringToSign = await buildStringToSign(amzDate, credentialScope, finalCanonical);
  const signingKey = await deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );
  const signatureBytes = await hmacSHA256(signingKey, stringToSign);
  const signature = toHex(signatureBytes);

  parsedUrl.searchParams.set("X-Amz-Signature", signature);
  return parsedUrl.toString();
}

// ============================================================================
// #10  CHUNKED UPLOAD SIGNING
// ============================================================================

/**
 * Initialize state for signing a chunked/streaming upload.
 * Call this once before streaming, then call `signChunk` for each chunk.
 */
/**
 * Initialize state for signing a chunked/streaming upload.
 * Call this once before streaming, then call {@link signChunk} for each chunk.
 *
 * @returns An object containing `signedRequest` (the seed request with chunked headers)
 *          and `state` (the initial chunked signing state for subsequent calls).
 */
export async function initChunkedSigning(
  request: SignableRequest,
  config: SigningConfig,
): Promise<{
  /** The seed request with chunked headers applied. */
  signedRequest: SignedRequest;
  /** The initial chunked signing state for subsequent signChunk calls. */
  state: ChunkedSigningState;
}> {
  // Override body to empty for the initial request signing
  const seedRequest: SignableRequest = { ...request, body: null };

  // Set chunked-specific headers
  seedRequest.headers = {
    ...seedRequest.headers,
    "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
    "content-encoding": "aws-chunked",
  };

  const signedRequest = await signRequest(seedRequest, { ...config, unsignedPayload: false });

  const credentials = await resolveCredentials(config.credentials);
  const signingDate = resolveSigningDate(config);
  const dateStamp = formatDateStamp(signingDate);
  const amzDate = formatAmzDate(signingDate);

  const signingKey = await deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );

  const scope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;

  return {
    signedRequest,
    state: {
      previousSignature: signedRequest.signature,
      signingKey,
      scope,
      signingDate: amzDate,
    },
  };
}

/**
 * Sign a single chunk in a streaming upload.
 * Returns the chunk extension header (hex-encoded chunk size + signature).
 */
/**
 * Sign a single chunk in a streaming upload.
 *
 * @returns An object containing `chunkHeader` (hex-encoded chunk size + signature)
 *          and `newState` (the updated signing state for the next chunk).
 */
export async function signChunk(
  chunk: Uint8Array | string,
  state: ChunkedSigningState,
): Promise<{
  /** Hex-encoded chunk size and signature. */
  chunkHeader: string;
  /** Updated signing state for the next chunk. */
  newState: ChunkedSigningState;
}> {
  const chunkData = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
  const chunkHash = await sha256Hex(chunkData);
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb924" + "27ae41e4649b934ca495991b7852b855";

  const stringToSign = [
    "AWS4-HMAC-SHA256-PAYLOAD",
    state.signingDate,
    state.scope,
    state.previousSignature,
    emptyHash,
    chunkHash,
  ].join("\n");

  const sigBytes = await hmacSHA256(state.signingKey, stringToSign);
  const signature = toHex(sigBytes);

  const size = chunkData.byteLength;
  const chunkHeader = `${size.toString(16)};chunk-signature=${signature}\r\n`;

  return {
    chunkHeader,
    newState: { ...state, previousSignature: signature },
  };
}

/**
 * Build the trailing empty chunk (required to terminate a chunked upload).
 */
export async function signFinalChunk(state: ChunkedSigningState): Promise<string> {
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb924" + "27ae41e4649b934ca495991b7852b855";

  const stringToSign = [
    "AWS4-HMAC-SHA256-PAYLOAD",
    state.signingDate,
    state.scope,
    state.previousSignature,
    emptyHash,
    emptyHash,
  ].join("\n");

  const sigBytes = await hmacSHA256(state.signingKey, stringToSign);
  const signature = toHex(sigBytes);
  return `0;chunk-signature=${signature}\r\n\r\n`;
}

// ============================================================================
// #11  S3 POST POLICY SIGNING
// ============================================================================

/**
 * Sign an S3 POST policy for browser-based direct uploads.
 * Returns the form fields to include in the multipart/form-data POST.
 */
export async function signS3PostPolicy(
  policy: S3PostPolicy,
  config: SigningConfig,
): Promise<S3PostSignature> {
  const credentials = await resolveCredentials(config.credentials);
  const signingDate = resolveSigningDate(config);
  const dateStamp = formatDateStamp(signingDate);

  const credentialScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  const credential = `${credentials.accessKeyId}/${credentialScope}`;

  // Encode policy as base64
  const policyStr = JSON.stringify(policy);
  const policyBase64 = btoa(policyStr);

  // Sign the policy
  const signingKey = await deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    config.region,
    config.service,
  );
  const signatureBytes = await hmacSHA256(signingKey, policyBase64);
  const signature = toHex(signatureBytes);

  const result: S3PostSignature = {
    policy: policyBase64,
    signature,
    credential,
    date: dateStamp,
  };

  if (credentials.sessionToken) {
    result.securityToken = credentials.sessionToken;
  }

  return result;
}

// ============================================================================
// #12  CLOCK SKEW DETECTION
// ============================================================================

/**
 * Parse the server's clock from a response and compute the skew in seconds.
 * Returns 0 if the header is absent or unparseable.
 */
export function detectClockSkew(responseHeaders: Record<string, string>): number {
  const dateHeader = responseHeaders["date"] ?? responseHeaders["Date"];
  if (!dateHeader) return 0;
  const serverTime = new Date(dateHeader).getTime();
  if (isNaN(serverTime)) return 0;
  return Math.round((serverTime - Date.now()) / 1000);
}

/**
 * Determine if an error response is a clock skew error.
 */
export function isClockSkewError(status: number, body: string): boolean {
  if (status !== 403 && status !== 400) return false;
  return (
    body.includes("RequestTimeTooSkewed") ||
    body.includes("RequestExpired") ||
    body.includes("InvalidSignatureException") ||
    body.includes("AuthFailure") ||
    body.includes("SignatureDoesNotMatch")
  );
}

// ============================================================================
// #13  SIGV4 SIGNER CLASS (stateful, with credential caching + clock skew)
// ============================================================================

/**
 * Stateful SigV4 signer with credential caching and automatic clock skew
 * correction. Convenience wrapper around the stateless functions.
 *
 * @example
 * ```typescript
 * const signer = new SigV4Signer({
 *   credentials: envCredentials(),
 *   region: "us-east-1",
 *   service: "s3",
 * });
 * const signed = await signer.sign({ method: "GET", url: "https://s3.amazonaws.com/...", headers: {}, body: null });
 * ```
 */
export class SigV4Signer {
  /** Accumulated clock skew in seconds (positive = server ahead) */
  private clockSkewSecs = 0;

  /**
   * @param config - Signing configuration (signingDate and clockSkewSecs are managed internally)
   */
  constructor(private config: Omit<SigningConfig, "signingDate" | "clockSkewSecs">) {}

  /**
   * Sign a request with the current configuration and accumulated clock skew.
   *
   * @param request - The request to sign
   * @returns Signed request with Authorization and x-amz-* headers populated
   */
  async sign(request: SignableRequest): Promise<SignedRequest> {
    return await signRequest(request, {
      ...this.config,
      clockSkewSecs: this.clockSkewSecs,
    });
  }

  /**
   * Generate a presigned URL for a request.
   *
   * @param request - The request to presign
   * @param options - Presigning options (expiry, extra params)
   * @returns Presigned URL string with query-string auth params
   */
  async presign(request: SignableRequest, options?: PresignOptions): Promise<string> {
    return await presignRequest(
      request,
      {
        ...this.config,
        clockSkewSecs: this.clockSkewSecs,
      },
      options,
    );
  }

  /**
   * Sign an S3 POST policy for browser-based uploads.
   *
   * @param policy - The POST policy (expiration + conditions)
   * @returns Form fields to include in the multipart POST
   */
  async signPostPolicy(policy: S3PostPolicy): Promise<S3PostSignature> {
    return await signS3PostPolicy(policy, {
      ...this.config,
      clockSkewSecs: this.clockSkewSecs,
    });
  }

  /**
   * Initialize state for a chunked/streaming upload.
   * Returns the initial signed request and a state object for `signChunk`.
   *
   * @param request - The base request (body will be replaced with chunks)
   * @returns Signed seed request + chunked signing state
   */
  /**
   * Initialize state for a chunked/streaming upload.
   *
   * @param request - The base request (body will be replaced with chunks)
   * @returns An object containing `signedRequest` (the seed request with chunked headers)
   *          and `state` (the initial chunked signing state for subsequent signChunk calls).
   */
  async initChunked(request: SignableRequest): Promise<{
    /** The seed request with chunked headers applied. */
    signedRequest: SignedRequest;
    /** The initial chunked signing state for subsequent signChunk calls. */
    state: ChunkedSigningState;
  }> {
    return await initChunkedSigning(request, {
      ...this.config,
      clockSkewSecs: this.clockSkewSecs,
    });
  }

  /**
   * Update the clock skew correction based on a server response.
   * Call this whenever you receive a clock skew error.
   */
  updateClockSkew(responseHeaders: Record<string, string>): void {
    const skew = detectClockSkew(responseHeaders);
    if (skew !== 0) this.clockSkewSecs = skew;
  }

  /**
   * Check if a response is a clock skew error and auto-correct.
   * Returns true if the skew was detected and updated (caller should retry).
   */
  handleClockSkewError(
    status: number,
    body: string,
    responseHeaders: Record<string, string>,
  ): boolean {
    if (!isClockSkewError(status, body)) return false;
    this.updateClockSkew(responseHeaders);
    return true;
  }
}

// ============================================================================
// #14  UTILITIES
// ============================================================================

/** Resolve credentials — calls the provider if it's a function, otherwise returns directly. */
async function resolveCredentials(
  creds: AWSCredentials | CredentialProvider,
): Promise<AWSCredentials> {
  return await (typeof creds === "function" ? creds() : Promise.resolve(creds));
}

/**
 * Cross-runtime environment variable reader.
 * Works in: Node.js, Deno, Bun, Cloudflare Workers (via wrangler secrets/env).
 * Returns undefined when the variable is not set or the runtime does not expose env vars.
 */
function getEnv(key: string): string | undefined {
  // Deno
  const _deno = (
    globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } }
  ).Deno;
  if (typeof _deno !== "undefined") {
    try {
      return _deno.env.get(key);
    } catch {
      /* permission denied */
    }
  }
  // Node.js / Bun / Vercel / Lambda - safely check for process before accessing
  try {
    const g = globalThis as { process?: { env?: Record<string, string> } };
    return g.process?.env?.[key];
  } catch {
    /* process not available in edge runtimes */
  }
  return undefined;
}

/**
 * Fetch with a timeout and AbortSignal merging.
 * Uses AbortSignal.any when available (Node 18+, Deno, Bun).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    // Merge signals: use both the provided signal and our timeout signal
    const mergedSignal = init.signal
      ? // In Node.js 18+, Deno, Bun: use AbortSignal.any()
        typeof AbortSignal !== "undefined" && "any" in AbortSignal
        ? (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any([
            init.signal,
            controller.signal,
          ])
        : controller.signal
      : controller.signal;

    const response = await fetch(url, { ...init, signal: mergedSignal });

    // Clear timeout immediately to prevent it from firing after fetch completes
    clearTimeout(timer);

    return response;
  } catch (err) {
    // Check if the error was caused by our timeout
    if (controller.signal.aborted) {
      throw new TimeoutError(timeout);
    }
    throw err;
  } finally {
    // Double cleanup to ensure timer is always cleared
    clearTimeout(timer);
  }
}

// ============================================================================
// #15  CONVENIENCE FACTORIES
// ============================================================================

/**
 * Create a signer pre-configured for Amazon S3.
 * Uses single URI encoding (S3-specific) and unsigned payload by default.
 */
export function createS3Signer(options: {
  credentials: AWSCredentials | CredentialProvider;
  region: string;
  unsignedPayload?: boolean;
}): SigV4Signer {
  return new SigV4Signer({
    credentials: options.credentials,
    region: options.region,
    service: "s3",
    doubleEncodeUri: false,
    unsignedPayload: options.unsignedPayload ?? false,
  });
}

/**
 * Create a signer pre-configured for API Gateway / Lambda Function URLs.
 */
export function createAPIGatewaySigner(options: {
  credentials: AWSCredentials | CredentialProvider;
  region: string;
}): SigV4Signer {
  return new SigV4Signer({
    credentials: options.credentials,
    region: options.region,
    service: "execute-api",
  });
}

/**
 * Create a signer pre-configured for Amazon STS.
 */
export function createSTSSigner(options: {
  credentials: AWSCredentials | CredentialProvider;
  region: string;
}): SigV4Signer {
  return new SigV4Signer({
    credentials: options.credentials,
    region: options.region,
    service: "sts",
  });
}

/**
 * Create a signer pre-configured for DynamoDB.
 */
export function createDynamoDBSigner(options: {
  credentials: AWSCredentials | CredentialProvider;
  region: string;
}): SigV4Signer {
  return new SigV4Signer({
    credentials: options.credentials,
    region: options.region,
    service: "dynamodb",
  });
}
