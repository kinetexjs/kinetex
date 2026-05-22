/**
 * HTTP Digest Access Authentication (RFC 7616) implementation.
 *
 * Pure-JS MD5 (no Web Crypto dependency) plus SHA-256 via Web Crypto API.
 * Supports MD5, SHA-256, and SHA-512-256 hash algorithms.
 *
 * Main entry point: {@link createDigestAuthorization} — parse a 401
 * WWW-Authenticate challenge, compute the response hash, and format the
 * Authorization header in one call.
 */

import { randomBytes } from "./utils.ts";

type DigestHashAlgo = "MD5" | "SHA-256" | "SHA-512-256";

// ============================================================================
// §1  MD5 — Pure JS (no Web Crypto dependency)
// ============================================================================

/**
 * Pure-JS MD5 hash implementation (RFC 1321).
 * No Web Crypto dependency — works in all runtimes.
 *
 * @param input - String to hash
 * @returns 32-char hex-encoded MD5 digest
 */
function md5(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      const c2 = input.charCodeAt(i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length * 8) % 512 !== 448) bytes.push(0);

  for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xff);
  for (let i = 4; i < 8; i++) bytes.push(0);

  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) {
      const b0 = bytes[offset + i * 4]!;
      const b1 = bytes[offset + i * 4 + 1]!;
      const b2 = bytes[offset + i * 4 + 2]!;
      const b3 = bytes[offset + i * 4 + 3]!;
      M[i] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    }

    let A = a0,
      B = b0,
      C = c0,
      D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]!) | (F >>> (32 - S[i]!)))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  function toHexLE(n: number): string {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return s;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

// ============================================================================
// §2  DIGEST CHALLENGE TYPES
// ============================================================================

/** Parameters extracted from a `WWW-Authenticate: Digest` challenge header. */
export interface DigestChallenge {
  /** Required: authentication realm. */
  realm: string;
  /** Required: server-provided nonce (used once). */
  nonce: string;
  /** Opaque data echoed back by the client (if provided by server). */
  opaque?: string;
  /** Hash algorithm (default: "MD5"). RFC 7616 also defines "SHA-256", "SHA-512-256". */
  algorithm: string;
  /** Quality of protection: "auth", "auth-int", or a comma-separated list. */
  qop?: string;
  /** `true` if the nonce is stale and a retry is allowed without user interaction. */
  stale?: boolean;
  /** Space-separated list of URL prefixes protected by this challenge. */
  domain?: string;
  /** Character encoding expected by the server (e.g. "UTF-8"). */
  charset?: string;
  /** `true` if the server supports hashed username (RFC 7616 §3.4.4). */
  userhash?: boolean;
}

// ============================================================================
// §3  DIGEST CHALLENGE PARSING
// ============================================================================

/**
 * Parse a `WWW-Authenticate: Digest` response header into a structured
 * {@link DigestChallenge}.
 *
 * @param header - Raw `WWW-Authenticate` header value (e.g. from a 401 response).
 * @returns Parsed challenge parameters.
 * @throws If `realm` or `nonce` are missing.
 *
 * @example
 * ```ts
 * const challenge = parseDigestChallenge(
 *   'Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"',
 * );
 * console.log(challenge.realm); // "testrealm@host.com"
 * ```
 */
export function parseDigestChallenge(header: string): DigestChallenge {
  const challenge: Partial<DigestChallenge> = {
    algorithm: "MD5",
  };

  const cleaned = header.replace(/^Digest\s+/i, "").trim();

  const regex = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    const key = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3])!;

    switch (key) {
      case "realm":
        challenge.realm = value;
        break;
      case "nonce":
        challenge.nonce = value;
        break;
      case "opaque":
        challenge.opaque = value;
        break;
      case "algorithm":
        challenge.algorithm = value.toUpperCase();
        break;
      case "qop":
        challenge.qop = value;
        break;
      case "domain":
        challenge.domain = value;
        break;
      case "charset":
        challenge.charset = value;
        break;
      case "userhash":
        challenge.userhash = value === "true";
        break;
      case "stale":
        challenge.stale = value === "true";
        break;
    }
  }

  if (!challenge.realm) throw new Error("Digest challenge missing 'realm'");
  if (!challenge.nonce) throw new Error("Digest challenge missing 'nonce'");

  return challenge as DigestChallenge;
}

// ============================================================================
// §3b  SHA-256 HASHING VIA WEB CRYPTO API
// ============================================================================

/**
 * SHA-256 hash via Web Crypto API, returned as hex string.
 *
 * @param data - String to hash
 * @returns 64-char hex-encoded SHA-256 digest
 */
async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(data));
  const bytes = new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// §3c  SHA-512/256 — Pure-JS (FIPS 180-4)
// ============================================================================

/**
 * SHA-512/256 hash via pure-JS implementation (FIPS 180-4).
 *
 * SHA-512/256 uses the SHA-512 compression function with different initial
 * values, producing a 256-bit digest. The Web Crypto API does not expose
 * SHA-512/256 directly, so we implement it using BigInt for 64-bit arithmetic.
 * Works in all runtimes that support BigInt (Node 18+, Deno, Bun, modern
 * browsers).
 *
 * @param data - String to hash
 * @returns 64-char hex-encoded SHA-512/256 digest (first 256 bits of the
 *          512-bit state)
 */
function sha512256Hex(data: string): string {
  /* SHA-512 round constants — first 80 primes' cube roots fractional part */
  const K = [
    0x428a2f98d728ae22n,
    0x7137449123ef65cdn,
    0xb5c0fbcfec4d3b2fn,
    0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n,
    0x59f111f1b605d019n,
    0x923f82a4af194f9bn,
    0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n,
    0x12835b0145706fben,
    0x243185be4ee4b28cn,
    0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn,
    0x80deb1fe3b1696b1n,
    0x9bdc06a725c71235n,
    0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n,
    0xefbe4786384f25e3n,
    0x0fc19dc68b8cd5b5n,
    0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n,
    0x4a7484aa6ea6e483n,
    0x5cb0a9dcbd41fbd4n,
    0x76f988da831153b5n,
    0x983e5152ee66dfabn,
    0xa831c66d2db43210n,
    0xb00327c898fb213fn,
    0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n,
    0xd5a79147930aa725n,
    0x06ca6351e003826fn,
    0x142929670a0e6e70n,
    0x27b70a8546d22ffcn,
    0x2e1b21385c26c926n,
    0x4d2c6dfc5ac42aedn,
    0x53380d139d95b3dfn,
    0x650a73548baf63den,
    0x766a0abb3c77b2a8n,
    0x81c2c92e47edaee6n,
    0x92722c851482353bn,
    0xa2bfe8a14cf10364n,
    0xa81a664bbc423001n,
    0xc24b8b70d0f89791n,
    0xc76c51a30654be30n,
    0xd192e819d6ef5218n,
    0xd69906245565a910n,
    0xf40e35855771202an,
    0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n,
    0x1e376c085141ab53n,
    0x2748774cdf8eeb99n,
    0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n,
    0x4ed8aa4ae3418acbn,
    0x5b9cca4f7763e373n,
    0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn,
    0x78a5636f43172f60n,
    0x84c87814a1f0ab72n,
    0x8cc702081a6439ecn,
    0x90befffa23631e28n,
    0xa4506cebde82bde9n,
    0xbef9a3f7b2c67915n,
    0xc67178f2e372532bn,
    0xca273eceea26619cn,
    0xd186b8c721c0c207n,
    0xeada7dd6cde0eb1en,
    0xf57d4f7fee6ed178n,
    0x06f067aa72176fban,
    0x0a637dc5a2c898a6n,
    0x113f9804bef90daen,
    0x1b710b35131c471bn,
    0x28db77f523047d84n,
    0x32caab7b40c72493n,
    0x3c9ebe0a15c9bebcn,
    0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n,
    0x597f299cfc657e2an,
    0x5fcb6fab3ad6faecn,
    0x6c44198c4a475817n,
  ];

  /* SHA-512/256 initial hash values (FIPS 180-4 §5.6.2.2) */
  const H0 = [
    0x22312194fc2bf72cn,
    0x9f555fa3c84c64c2n,
    0x2393b86b6f53b151n,
    0x963877195940eabdn,
    0x96283ee2a88effe3n,
    0xbe5e1e2553863992n,
    0x2b0199fc2c85b8aan,
    0x0eb72ddc81c52ca2n,
  ];

  /* Encode to UTF-8 bytes */
  const bytes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      const c2 = data.charCodeAt(i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }

  /* SHA-512 padding: append 0x80, pad to 896 mod 1024 bits, append 128-bit length */
  const bitLen = BigInt(bytes.length * 8);
  bytes.push(0x80);
  while ((bytes.length * 8) % 1024 !== 896) bytes.push(0);
  for (let i = 15; i >= 0; i--) bytes.push(Number((bitLen >> BigInt(i * 8)) & 0xffn));

  function rotr(x: bigint, n: bigint): bigint {
    return (x >> n) | ((x << (64n - n)) & 0xffffffffffffffffn);
  }

  let H = H0.slice() as readonly bigint[];

  /* Process each 1024-bit block */
  for (let offset = 0; offset < bytes.length; offset += 128) {
    const W: bigint[] = new Array(80);
    for (let t = 0; t < 16; t++) {
      let w = 0n;
      for (let i = 0; i < 8; i++) {
        w = (w << 8n) | BigInt(bytes[offset + t * 8 + i]!);
      }
      W[t] = w;
    }
    for (let t = 16; t < 80; t++) {
      const s0 = rotr(W[t - 15]!, 1n) ^ rotr(W[t - 15]!, 8n) ^ (W[t - 15]! >> 7n);
      const s1 = rotr(W[t - 2]!, 19n) ^ rotr(W[t - 2]!, 61n) ^ (W[t - 2]! >> 6n);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) & 0xffffffffffffffffn;
    }

    let a = H[0]!,
      b = H[1]!,
      c = H[2]!,
      d = H[3]!;
    let e = H[4]!,
      f = H[5]!,
      g = H[6]!,
      h = H[7]!;

    for (let t = 0; t < 80; t++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + W[t]!) & 0xffffffffffffffffn;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & 0xffffffffffffffffn;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffffffffffffn;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffffffffffffn;
    }

    H = [
      (H[0]! + a) & 0xffffffffffffffffn,
      (H[1]! + b) & 0xffffffffffffffffn,
      (H[2]! + c) & 0xffffffffffffffffn,
      (H[3]! + d) & 0xffffffffffffffffn,
      (H[4]! + e) & 0xffffffffffffffffn,
      (H[5]! + f) & 0xffffffffffffffffn,
      (H[6]! + g) & 0xffffffffffffffffn,
      (H[7]! + h) & 0xffffffffffffffffn,
    ];
  }

  /* Output first 256 bits (H[0..3]) as hex, big-endian */
  let hex = "";
  for (let i = 0; i < 4; i++) {
    hex += H[i]!.toString(16).padStart(16, "0");
  }
  return hex;
}

// ============================================================================
// §4  DIGEST RESPONSE COMPUTATION
// ============================================================================

/**
 * Compute the Digest Access Authentication `response` value per RFC 7616 §3.4.
 *
 * The response is computed as:
 * ```
 * HA1  = H(username:realm:password)
 * HA2  = H(method:uri)
 * response = H(HA1:nonce[:nc:cnonce:qop]:HA2)    // when qop is present
 * response = H(HA1:nonce:HA2)                     // when qop is absent
 * ```
 * where `H` is the hash algorithm selected by the challenge (MD5, SHA-256,
 * or SHA-512-256). Defaults to MD5 per RFC 7616 §3.4.1.
 *
 * @param challenge - Parsed challenge from the server's `WWW-Authenticate` header.
 * @param username  - Digest auth username.
 * @param password  - Digest auth password.
 * @param method    - HTTP method (e.g. `"GET"`, `"POST"`).
 * @param uri       - Request URI path + query (e.g. `"/dir/index.html"`).
 * @param cnonce    - Client nonce (random). Auto-generated if omitted.
 * @param nc        - Nonce count as 8-char zero-padded hex (e.g. `"00000001"`).
 *                   Defaults to `"00000001"` if omitted.
 * @returns The hex-encoded response hash.
 *
 * @example
 * ```ts
 * const challenge = parseDigestChallenge(wwwAuthHeader);
 * const response = await computeDigestResponse(challenge, "Mufasa",
 *   "Circle Of Life", "GET", "/dir/index.html");
 * ```
 */
export async function computeDigestResponse(
  challenge: DigestChallenge,
  username: string,
  password: string,
  method: string,
  uri: string,
  cnonce?: string,
  nc?: string,
): Promise<string> {
  const qop = challenge.qop || "";
  const nonce = challenge.nonce;
  const realm = challenge.realm;

  const _cnonce = cnonce || randomBytes(5);
  const _nc = nc || "00000001";

  const algo = resolveHashAlgo(challenge.algorithm);

  async function hash(s: string): Promise<string> {
    if (algo === "MD5") return md5(s);
    if (algo === "SHA-512-256") return sha512256Hex(s);
    return await sha256Hex(s);
  }

  const ha1 = await hash(`${username}:${realm}:${password}`);
  const ha2 = await hash(`${method}:${uri}`);

  let response: string;
  const qopList = qop.split(/\s*,\s*/).filter(Boolean);

  if (qopList.includes("auth") || qopList.includes("auth-int")) {
    response = await hash(`${ha1}:${nonce}:${_nc}:${_cnonce}:${qopList[0]}:${ha2}`);
  } else {
    response = await hash(`${ha1}:${nonce}:${ha2}`);
  }

  return response;
}

/**
 * Resolve the hash algorithm from the challenge's algorithm field.
 * Per RFC 7616 §3.4.1: default is MD5. Supports MD5, SHA-256, SHA-512-256.
 *
 * @param algorithm - Algorithm string from the challenge (e.g. "MD5", "SHA-256")
 * @returns The resolved algorithm identifier
 */
function resolveHashAlgo(algorithm: string): DigestHashAlgo {
  const upper = algorithm.toUpperCase().replace(/-/g, "");
  if (upper === "SHA256") return "SHA-256";
  if (upper === "SHA512256") return "SHA-512-256";
  return "MD5";
}

// ============================================================================
// §5  DIGEST AUTHORIZATION HEADER FORMATTING
// ============================================================================

/**
 * Format a full `Authorization: Digest ...` header value from the challenge
 * and the computed response hash.
 *
 * Only the first `qop` value (if multiple are offered) is used in the
 * header — per RFC 7616 §3.4, the client chooses one.
 *
 * @param challenge - Parsed challenge from the 401 response.
 * @param username  - Digest auth username.
 * @param response  - Hex-encoded digest response (from {@link computeDigestResponse}).
 * @param uri       - Request URI path + query.
 * @param cnonce    - Client nonce. Auto-generated if omitted (warning: must
 *                   match the value used in `computeDigestResponse`).
 * @param nc        - Nonce count. Defaults to `"00000001"` if omitted (warning:
 *                   must match the value used in `computeDigestResponse`).
 * @returns The full `Authorization` header value, e.g.
 *   `Digest username="Mufasa", realm="testrealm@host.com", ...`
 *
 * @example
 * ```ts
 * const auth = formatDigestAuth(challenge, "Mufasa",
 *   "6629fae49393a05397450978507c4ef1",
 *   "/dir/index.html", "f2/wE", "00000001");
 * ```
 */
export function formatDigestAuth(
  challenge: DigestChallenge,
  username: string,
  response: string,
  uri: string,
  cnonce?: string,
  nc?: string,
): string {
  const parts: string[] = [];
  const _cnonce = cnonce || randomBytes(5);
  const _nc = nc || "00000001";

  parts.push(`username="${username}"`);
  parts.push(`realm="${challenge.realm}"`);
  parts.push(`nonce="${challenge.nonce}"`);
  parts.push(`uri="${uri}"`);
  parts.push(`response="${response}"`);

  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm && challenge.algorithm !== "MD5")
    parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.qop) {
    parts.push(`qop=${challenge.qop.split(/\s*,\s*/)[0]}`);
    parts.push(`nc=${_nc}`);
    parts.push(`cnonce="${_cnonce}"`);
  }

  return `Digest ${parts.join(", ")}`;
}

// ============================================================================
// §6  FULL DIGEST AUTH: CONVENIENCE WRAPPER
// ============================================================================

/**
 * Convenience wrapper: given a raw `WWW-Authenticate` header from a 401
 * response, parse the challenge, compute the response hash, and produce
 * the full `Authorization: Digest ...` header value for the retry request.
 *
 * This is the primary entry-point used by the Kinetex client's internal
 * digest interceptor. It is also safe to use standalone in any HTTP client.
 *
 * @param wwwAuth  - Raw `WWW-Authenticate` header value (e.g. from
 *                  `response.headers.get("www-authenticate")`).
 * @param username - Digest auth username.
 * @param password - Digest auth password.
 * @param method   - HTTP method in uppercase (`"GET"`, `"POST"`, etc.).
 * @param uri      - Request URI path + query (e.g. `"/dir/index.html"`).
 * @returns The complete `Authorization` header value, ready to attach
 *          to the retry request.
 *
 * @example
 * ```ts
 * const auth = createDigestAuthorization(
 *   'Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"',
 *   "Mufasa",
 *   "Circle Of Life",
 *   "GET",
 *   "/dir/index.html"
 * );
 * // "Digest username="Mufasa", realm="testrealm@host.com", ..."
 * ```
 */
export async function createDigestAuthorization(
  wwwAuth: string,
  username: string,
  password: string,
  method: string,
  uri: string,
): Promise<string> {
  const challenge = parseDigestChallenge(wwwAuth);
  const cnonce = randomBytes(5);
  const nc = "00000001";
  const response = await computeDigestResponse(
    challenge,
    username,
    password,
    method,
    uri,
    cnonce,
    nc,
  );
  return formatDigestAuth(challenge, username, response, uri, cnonce, nc);
}
