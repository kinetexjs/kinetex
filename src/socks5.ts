/**
 * socks5.ts — SOCKS5 proxy tunnel for TypeScript HTTP clients
 *
 * Supports:
 *  - SOCKS5 (RFC 1928) + SOCKS5h (remote DNS)
 *  - Auth methods: NO_AUTH and USERNAME/PASSWORD (RFC 1929)
 *  - Address types: IPv4, IPv6, domain name
 *  - HTTPS (TLS-over-tunnel)
 *  - Configurable timeouts, retries, and error classification
 *  - Deno and Node.js (net module) compatible via an abstract TCP interface
 */

// ---------------------------------------------------------------------------
// 1. CONSTANTS & PROTOCOL BYTES
// ---------------------------------------------------------------------------

const SOCKS_VERSION = 0x05;

/**
 * Authentication methods supported by the SOCKS5 protocol.
 *
 * Note: GSSAPI (0x01) is declared but only NO_AUTH and USERNAME/PASSWORD
 * are implemented. If a SOCKS5 server offers GSSAPI, the client will fail
 * with "unsupported auth method".
 */
const AuthMethod = {
  NoAuth: 0x00,
  GSSAPI: 0x01,
  UserPassword: 0x02,
  NoAcceptable: 0xff,
} as const;

/** Address types */
const AddrType = {
  IPv4: 0x01,
  Domain: 0x03,
  IPv6: 0x04,
} as const;

/**
 * SOCKS5 commands.
 *
 * Note: Only CONNECT (0x01) is implemented. BIND (0x02) and UDP_ASSOCIATE (0x03)
 * are declared as protocol references but will cause a proxy error if used.
 */
const Cmd = {
  Connect: 0x01,
  Bind: 0x02,
  UdpAssociate: 0x03,
} as const;

/** Reply codes */
const Reply = {
  Succeeded: 0x00,
  GeneralFailure: 0x01,
  ConnNotAllowed: 0x02,
  NetworkUnreachable: 0x03,
  HostUnreachable: 0x04,
  ConnRefused: 0x05,
  TtlExpired: 0x06,
  CmdNotSupported: 0x07,
  AddrTypeNotSupported: 0x08,
} as const;

const REPLY_MESSAGES: Record<number, string> = {
  [Reply.Succeeded]: "Succeeded",
  [Reply.GeneralFailure]: "General SOCKS server failure",
  [Reply.ConnNotAllowed]: "Connection not allowed by ruleset",
  [Reply.NetworkUnreachable]: "Network unreachable",
  [Reply.HostUnreachable]: "Host unreachable",
  [Reply.ConnRefused]: "Connection refused",
  [Reply.TtlExpired]: "TTL expired",
  [Reply.CmdNotSupported]: "Command not supported",
  [Reply.AddrTypeNotSupported]: "Address type not supported",
};

// ---------------------------------------------------------------------------
// 2. TYPES
// ---------------------------------------------------------------------------

/**
 * Connection parameters for a SOCKS5 proxy server.
 *
 * Supports optional username/password authentication, remote DNS,
 * and configurable timeouts with retry.
 */
export interface Socks5ProxyConfig {
  /** Proxy host (hostname or IP) */
  host: string;
  /** Proxy port (default: 1080) */
  port?: number;
  /** Username for USERNAME/PASSWORD auth */
  username?: string;
  /** Password for USERNAME/PASSWORD auth */
  password?: string;
  /**
   * If true, send the domain name to the proxy for remote DNS resolution
   * (SOCKS5h behaviour). Default: true.
   */
  remoteDns?: boolean;
  /** Connection timeout to the proxy in ms (default: 10_000) */
  connectTimeoutMs?: number;
  /** Per-read timeout during handshake in ms (default: 10_000) */
  handshakeTimeoutMs?: number;
  /** Number of retry attempts on transient failures (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 300) */
  retryDelayMs?: number;
}

/**
 * Target address for SOCKS5 connection.
 *
 * TLS upgrade: After `createSocks5Tunnel` returns a tunnel, you must manually
 * upgrade the connection to TLS. Use Node's `tls.connect()` or Deno's `Deno.connectTls()`
 * with the tunnel's underlying socket. The `tlsServerName` option can be used to
 * specify a different SNI value than the target host.
 *
 * @example
 * ```ts
 * // Node.js TLS upgrade
 * import tls from "node:tls";
 * const tunnel = await createSocks5Tunnel(proxyConfig, target, connector);
 * const tlsConn = tls.connect({
 *   socket: tunnel.conn, // may need adapter layer
 *   servername: target.tlsServerName || target.host,
 * });
 * ```
 */
export interface Socks5Target {
  /** Destination hostname or IP */
  host: string;
  /** Destination port */
  port: number;
  /**
   * If true, signals intent to upgrade to TLS.
   * Note: The tunnel creation itself does not perform TLS - you must upgrade
   * the returned connection manually after tunnel establishment.
   */
  tls?: boolean;
  /** TLS server name for SNI (defaults to target host if not specified) */
  tlsServerName?: string;
}

/**
 * Minimal interface a TCP connection must expose.
 *
 * Implementations should ensure close() is idempotent - calling multiple times
 * should not throw errors.
 */
export interface TcpConn {
  /** Read up to buf.length bytes into buf. Returns bytes read or null on EOF. */
  read(buf: Uint8Array): Promise<number | null>;
  /** Write data, returns number of bytes buffered (may not equal data.length in some implementations). */
  write(data: Uint8Array): Promise<number>;
  /**
   * Close the connection.
   * @throws May throw on error, but idempotent - safe to call multiple times.
   */
  close(): void;
}

/** Factory: open a raw TCP connection to host:port */
export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<TcpConn>;

/** Result of a successful tunnel establishment */
export interface Socks5Tunnel {
  /** The underlying TCP connection (now a transparent tunnel) */
  conn: TcpConn;
  /** Bound address reported by the proxy (useful for BIND/UDP) */
  boundAddr: string;
  /** Bound port reported by the proxy */
  boundPort: number;
}

// ---------------------------------------------------------------------------
// 3. ERRORS
// ---------------------------------------------------------------------------

/**
 * SOCKS5-specific error.
 *
 * The `retriable` flag indicates whether the operation may succeed on retry:
 * - `true` for NetworkUnreachable (0x04) and TtlExpired (0x06)
 * - `false` for all other errors (auth failure, bad request, etc.)
 */
export class Socks5Error extends Error {
  /**
   * @param message Human-readable error description.
   * @param code Machine-readable error code (e.g. "SOCKS5_TIMEOUT").
   * @param retriable Whether the operation may succeed on retry.
   */
  constructor(
    message: string,
    public readonly code: string,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "Socks5Error";
  }
}

function proxyReplyError(reply: number): Socks5Error {
  const msg = REPLY_MESSAGES[reply] ?? `Unknown reply code 0x${reply.toString(16)}`;
  const retriable = reply === Reply.NetworkUnreachable || reply === Reply.TtlExpired;
  return new Socks5Error(`SOCKS5 proxy error: ${msg}`, `SOCKS5_REPLY_${reply}`, retriable);
}

// ---------------------------------------------------------------------------
// 4. BUFFER UTILITIES
// ---------------------------------------------------------------------------

/**
 * Internal buffered reader for SOCKS5 handshake.
 *
 * Accumulates incoming data into an internal buffer and provides exact-length
 * reads needed for the protocol. Uses a growing Uint8Array strategy (creates
 * new array on each read) - acceptable for handshake phase which has small,
 * bounded data requirements.
 *
 * Not exported - internal use only for the handshake phase.
 */
class BufReader {
  private buf = new Uint8Array(0);

  constructor(
    private readonly conn: TcpConn,
    private readonly timeoutMs: number,
  ) {}

  async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      const chunk = new Uint8Array(4096);
      const deadline = withTimeout(
        this.conn.read(chunk),
        this.timeoutMs,
        "SOCKS5 handshake read timed out",
      );
      const nRead = await deadline;
      if (nRead === null || nRead === 0) {
        throw new Socks5Error("Connection closed during SOCKS5 handshake", "SOCKS5_EOF");
      }
      const next = new Uint8Array(this.buf.length + nRead);
      next.set(this.buf);
      next.set(chunk.subarray(0, nRead), this.buf.length);
      this.buf = next;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  // A non-positive budget means "no timeout", matching `denoTcpConnector`,
  // which documents and tests exactly that. Passing 0 to `setTimeout` fired on
  // the next tick, so `connectTimeoutMs: 0` — the conventional way to say
  // "wait as long as it takes" — failed the connection instantly.
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Socks5Error(message, "SOCKS5_TIMEOUT", true)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 5. ADDRESS ENCODING
// ---------------------------------------------------------------------------

function encodeAddress(this: void, host: string, remoteDns: boolean): Uint8Array {
  // IPv4 - must validate octet range 0-255
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    // Validate each octet is 0-255
    if (octets.every((o) => o >= 0 && o <= 255)) {
      return new Uint8Array([AddrType.IPv4, ...octets]);
    }
  }

  // IPv6 — strip brackets if present
  const ipv6Raw = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv6(ipv6Raw)) {
    const bytes = expandIPv6(ipv6Raw);
    return new Uint8Array([AddrType.IPv6, ...bytes]);
  }

  // Domain — always DOMAINNAME regardless of remoteDns flag (flag controls
  // whether *we* resolve first vs letting the proxy resolve)
  if (!remoteDns) {
    // Caller should have resolved to IP before calling; emit a warning but
    // fall through to domain encoding as a safety net.
    console.warn("[socks5] remoteDns=false but got a hostname; sending as DOMAINNAME");
  }
  const enc = new TextEncoder().encode(host);
  if (enc.length > 255) {
    throw new Socks5Error("Hostname too long for SOCKS5 (max 255 bytes)", "SOCKS5_ADDR_TOO_LONG");
  }
  return new Uint8Array([AddrType.Domain, enc.length, ...enc]);
}

/**
 * A single hextet: one to four hex digits.
 *
 * `parseInt(g, 16)` is not a validation. It accepts trailing garbage
 * (`parseInt("12zz", 16)` is 18) and returns `NaN` for anything that is not
 * hex at all — and `NaN` then sailed through the `g < 0 || g > 0xffff` range
 * check, because every comparison with `NaN` is false. `NaN >> 8 & 0xff` is
 * 0, so such a group contributed a zero pair.
 */
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * True when `s` is a syntactically valid IPv6 literal.
 *
 * Structural, NOT "contains a colon". The old test accepted any string with a
 * colon in it, so a hostname like `g:h:i:j:k:l:m:n` was taken for an IPv6
 * literal: eight groups, every one of them `NaN`, all eight of which passed
 * the range check, and the result encoded as sixteen zero bytes. The proxy
 * was then asked to connect to the unspecified address `::` and the tunnel
 * was established — to the wrong place, with no error anywhere. A name that
 * is not a valid IPv6 literal is now left to the domain-name encoding, where
 * the proxy resolves it and reports host-unreachable if it is not real.
 */
function isIPv6(s: string): boolean {
  if (!s.includes(":")) return false;
  // At most one compressed run ("::"). Two would be ambiguous.
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groupsOf = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const left = groupsOf(halves[0]);
  if (halves.length === 2) {
    const right = groupsOf(halves[1]);
    // "::" must stand for at least one omitted group.
    if (left.length + right.length > 7) return false;
    return [...left, ...right].every((g) => HEX_GROUP.test(g));
  }
  // Uncompressed: all eight groups must be present and well formed.
  return left.length === 8 && left.every((g) => HEX_GROUP.test(g));
}

/**
 * Expand a compressed IPv6 address to 8 groups (16 bytes).
 *
 * Edge cases handled:
 * - `::` (loopback) - expands to 0:0:0:0:0:0:0:0
 * - `::1` (loopback) - left=empty, right=[1] -> fills with 7 zeros
 * - `2001:db8::` - trailing :: means right side is empty
 * - `::ffff:192.168.1.1` (IPv4-mapped) - valid but not commonly used
 * - Multiple `::` in address - split("::") returns >2 parts, triggers length check and throws
 * - Trailing single `:` like `2001:db8:` - parsed as 2 groups, fails length check
 *
 * @throws Socks5Error if address is invalid (wrong group count, out-of-range groups)
 */
function expandIPv6(addr: string): number[] {
  // Expand :: and return 16 bytes
  const halves = addr.split("::");
  const expand = (part: string | undefined) =>
    part ? part.split(":").map((g) => (HEX_GROUP.test(g) ? parseInt(g, 16) : Number.NaN)) : [];

  let groups: number[];
  if (halves.length === 2) {
    const left = expand(halves[0]);
    const right = expand(halves[1]);
    const fill = new Array(8 - left.length - right.length).fill(0);
    groups = [...left, ...fill, ...right];
  } else {
    groups = expand(addr);
  }

  if (groups.length !== 8) {
    throw new Socks5Error(`Invalid IPv6 address: ${addr}`, "SOCKS5_INVALID_ADDR");
  }

  // Validate each group is a finite 16-bit value. `Number.isFinite` is the
  // load-bearing half: a bare `g < 0 || g > 0xffff` is false for every NaN,
  // so an unparseable group passed and then encoded as a zero pair.
  for (const g of groups) {
    if (!Number.isFinite(g) || g < 0 || g > 0xffff) {
      throw new Socks5Error(
        `Invalid IPv6 group: ${g} out of range (0-65535)`,
        "SOCKS5_INVALID_ADDR",
      );
    }
  }

  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >> 8) & 0xff, g & 0xff);
  }
  return bytes;
}

function decodeAddress(type: number, data: Uint8Array): string {
  if (type === AddrType.IPv4) {
    return Array.from(data).join(".");
  }
  if (type === AddrType.IPv6) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(((data[i]! << 8) | data[i + 1]!).toString(16));
    }
    return groups.join(":");
  }
  // Domain
  return new TextDecoder().decode(data);
}

// ---------------------------------------------------------------------------
// 6. HANDSHAKE IMPLEMENTATION
// ---------------------------------------------------------------------------

async function performHandshake(
  conn: TcpConn,
  target: Socks5Target,
  config: Required<Socks5ProxyConfig>,
): Promise<{ boundAddr: string; boundPort: number }> {
  const reader = new BufReader(conn, config.handshakeTimeoutMs);
  const hasAuth = !!(config.username && config.password);

  // ── Step 1: Method negotiation ──────────────────────────────────────────
  const methods = hasAuth ? [AuthMethod.NoAuth, AuthMethod.UserPassword] : [AuthMethod.NoAuth];

  const greeting = new Uint8Array([SOCKS_VERSION, methods.length, ...methods]);
  await conn.write(greeting);

  const methodResp = await reader.readExact(2);
  if (methodResp[0] !== SOCKS_VERSION) {
    throw new Socks5Error(
      `Unexpected SOCKS version in method response: ${methodResp[0]}`,
      "SOCKS5_BAD_VERSION",
    );
  }
  const chosenMethod = methodResp[1]!;

  // ── Step 2: Authentication ───────────────────────────────────────────────
  if (chosenMethod === AuthMethod.NoAcceptable) {
    throw new Socks5Error(
      "SOCKS5 proxy rejected all authentication methods",
      "SOCKS5_NO_ACCEPTABLE_METHOD",
    );
  }

  if (chosenMethod === AuthMethod.UserPassword) {
    if (!hasAuth) {
      throw new Socks5Error(
        "SOCKS5 proxy requires username/password but none provided",
        "SOCKS5_AUTH_REQUIRED",
      );
    }
    await performUserPassAuth(conn, reader, config.username, config.password);
  } else if (chosenMethod !== AuthMethod.NoAuth) {
    throw new Socks5Error(
      `SOCKS5 proxy chose unsupported auth method: 0x${chosenMethod.toString(16)}`,
      "SOCKS5_UNSUPPORTED_METHOD",
    );
  }

  // ── Step 3: CONNECT request ──────────────────────────────────────────────
  const addrBytes = encodeAddress(target.host, config.remoteDns);
  const port = target.port;
  const portBytes = [(port >> 8) & 0xff, port & 0xff];

  const request = new Uint8Array([
    SOCKS_VERSION,
    Cmd.Connect,
    0x00, // reserved
    ...addrBytes,
    ...portBytes,
  ]);
  await conn.write(request);

  // ── Step 4: Parse CONNECT reply ──────────────────────────────────────────
  const replyHeader = await reader.readExact(4);
  if (replyHeader[0] !== SOCKS_VERSION) {
    throw new Socks5Error(
      `Unexpected SOCKS version in reply: ${replyHeader[0]}`,
      "SOCKS5_BAD_VERSION",
    );
  }
  if (replyHeader[1] !== Reply.Succeeded) {
    throw proxyReplyError(replyHeader[1]!);
  }

  const addrType = replyHeader[3]!;
  let boundAddr: string;
  let addrData: Uint8Array;

  if (addrType === AddrType.IPv4) {
    addrData = await reader.readExact(4);
    boundAddr = decodeAddress(AddrType.IPv4, addrData);
  } else if (addrType === AddrType.IPv6) {
    addrData = await reader.readExact(16);
    boundAddr = decodeAddress(AddrType.IPv6, addrData);
  } else if (addrType === AddrType.Domain) {
    const lenBuf = await reader.readExact(1);
    addrData = await reader.readExact(lenBuf[0]!);
    boundAddr = decodeAddress(AddrType.Domain, addrData);
  } else {
    throw new Socks5Error(
      `Unsupported bound address type in reply: 0x${addrType.toString(16)}`,
      "SOCKS5_UNSUPPORTED_ADDR_TYPE",
    );
  }

  const portBuf = await reader.readExact(2);
  const boundPort = (portBuf[0]! << 8) | portBuf[1]!;

  return { boundAddr, boundPort };
}

async function performUserPassAuth(
  conn: TcpConn,
  reader: BufReader,
  username: string,
  password: string,
): Promise<void> {
  const enc = new TextEncoder();
  const u = enc.encode(username);
  const p = enc.encode(password);

  if (u.length > 255 || p.length > 255) {
    throw new Socks5Error("Username or password too long (max 255 bytes)", "SOCKS5_AUTH_TOO_LONG");
  }

  const authReq = new Uint8Array([
    0x01, // sub-negotiation version
    u.length,
    ...u,
    p.length,
    ...p,
  ]);
  await conn.write(authReq);

  const authResp = await reader.readExact(2);
  if (authResp[0] !== 0x01 && authResp[0] !== 0x05) {
    throw new Socks5Error(
      `Unexpected auth sub-negotiation version: ${authResp[0]}`,
      "SOCKS5_BAD_AUTH_VERSION",
    );
  }
  if (authResp[1] !== 0x00) {
    throw new Socks5Error(
      "SOCKS5 authentication failed (invalid credentials)",
      "SOCKS5_AUTH_FAILED",
    );
  }
}

// ---------------------------------------------------------------------------
// 7. RETRY WRAPPER
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retriable = err instanceof Socks5Error && err.retriable;
      if (!retriable || attempt === maxRetries) break;
      await sleep(delayMs * Math.pow(2, attempt)); // exponential backoff
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 8. CONFIG NORMALISATION
// ---------------------------------------------------------------------------

/** TCP-level errors worth another attempt. */
const TRANSIENT_DIAL_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

function resolveConfig(cfg: Socks5ProxyConfig): Required<Socks5ProxyConfig> {
  return {
    host: cfg.host,
    port: cfg.port ?? 1080,
    username: cfg.username ?? "",
    password: cfg.password ?? "",
    remoteDns: cfg.remoteDns ?? true,
    connectTimeoutMs: cfg.connectTimeoutMs ?? 10_000,
    handshakeTimeoutMs: cfg.handshakeTimeoutMs ?? 10_000,
    maxRetries: cfg.maxRetries ?? 2,
    retryDelayMs: cfg.retryDelayMs ?? 300,
  };
}

// ---------------------------------------------------------------------------
// 9. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Establish a SOCKS5 tunnel to `target` via the configured proxy.
 *
 * Automatically retries on transient failures (network unreachable, TTL expired)
 * using exponential backoff based on proxy config.
 *
 * @param proxyConfig - Proxy connection parameters
 * @param target - Destination host/port (and optional TLS settings)
 * @param connector - Factory that opens a raw TCP connection
 * @returns A `Socks5Tunnel` whose `.conn` is ready for application data
 * @throws {Socks5Error} On handshake failure, auth failure, timeout, or proxy error
 *
 * @example
 * ```ts
 * const tunnel = await createSocks5Tunnel(
 *   { host: "proxy.example.com", port: 1080, username: "u", password: "p" },
 *   { host: "api.example.com", port: 443, tls: true },
 *   denoTcpConnector,
 * );
 * // tunnel.conn is now a transparent TCP (or TLS) stream to api.example.com:443
 * ```
 */
export async function createSocks5Tunnel(
  proxyConfig: Socks5ProxyConfig,
  target: Socks5Target,
  connector: TcpConnector,
): Promise<Socks5Tunnel> {
  const config = resolveConfig(proxyConfig);

  return await withRetry(
    async () => {
      // Open raw TCP to proxy.
      //
      // A rejection from the connector used to escape UNCHANGED, so a proxy
      // that was not listening surfaced as a bare
      // `Error: connect ECONNREFUSED 127.0.0.1:1` rather than a
      // Socks5Error. Two things broke at once. The documented contract says
      // this function throws Socks5Error, and a caller switching on `code`
      // now had to know about two vocabularies — `ECONNREFUSED` from node:net
      // and `SOCKS5_*` from here. And `withRetry` only retries an error that
      // is a Socks5Error with `retriable` set, so the one failure most worth
      // retrying — the proxy not being up yet — was the one failure never
      // retried, and the exponential backoff this module is built around went
      // unused for it.
      const conn = await withTimeout(
        connector(config.host, config.port, config.connectTimeoutMs),
        config.connectTimeoutMs,
        `TCP connection to SOCKS5 proxy ${config.host}:${config.port} timed out`,
      ).catch((err: unknown) => {
        // An abort is the caller's own doing and is already an AbortError,
        // and anything already in this module's vocabulary passes through.
        if (err instanceof Socks5Error || err instanceof DOMException) throw err;
        const code = (err as { code?: unknown })?.code;
        const systemCode = typeof code === "string" ? code : "UNKNOWN";
        throw new Socks5Error(
          `Cannot reach SOCKS5 proxy ${config.host}:${config.port}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "SOCKS5_CONNECT_FAILED",
          // Transient at the TCP layer: the proxy may come back, or the path
          // to it may. ENOTFOUND is deliberately excluded — a proxy hostname
          // that does not resolve is a configuration mistake, and retrying it
          // only delays saying so.
          TRANSIENT_DIAL_CODES.has(systemCode),
        );
      });

      try {
        const { boundAddr, boundPort } = await performHandshake(conn, target, config);
        return { conn, boundAddr, boundPort };
      } catch (err) {
        conn.close();
        throw err;
      }
    },
    config.maxRetries,
    config.retryDelayMs,
  );
}

/**
 * Parse a SOCKS5 proxy URL into a `Socks5ProxyConfig`.
 *
 * Accepts: `socks5://[user:pass@]host[:port]`
 *          `socks5h://...`  (implies remoteDns: true)
 *
 * Note: Username and password are URL-decoded (percent-decoded per RFC 3986),
 * not base64-decoded. For example, `%40` in the URL becomes `@` in the password.
 * This follows standard URL encoding conventions for SOCKS5 URLs.
 *
 * Security: URL may contain credentials which are parsed into the config.
 * These credentials are stored in memory but cannot be fully zeroized in JavaScript.
 * Error messages are sanitized to not expose the full URL with credentials.
 *
 * @param url SOCKS5 URL (socks5:// or socks5h:// with optional user:pass).
 * @returns A Socks5ProxyConfig parsed from the URL.
 * @throws {Socks5Error} If the URL is malformed, scheme is not socks5/socks5h, or host is empty.
 */
export function parseSocks5Url(url: string): Socks5ProxyConfig {
  let parsed: URL;
  try {
    // Sanitize URL for error messages - remove potential credentials
    sanitizeSocks5UrlForLogging(url); // For side effect of validation
    parsed = new URL(url);
  } catch {
    // Don't include the original URL in error (may contain credentials)
    throw new Socks5Error("Invalid SOCKS5 proxy URL: malformed URL", "SOCKS5_BAD_URL");
  }

  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") {
    throw new Socks5Error(
      `Expected socks5:// or socks5h:// scheme, got: ${parsed.protocol}`,
      "SOCKS5_BAD_SCHEME",
    );
  }

  const remoteDns = parsed.protocol === "socks5h:";
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 1080;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Socks5Error(
      "Invalid SOCKS5 proxy URL: port must be between 1 and 65535",
      "SOCKS5_BAD_URL",
    );
  }

  // Validate host is present and non-empty
  if (!host) {
    throw new Socks5Error(
      "Invalid SOCKS5 proxy URL: no hostname specified (e.g., socks5://host:port)",
      "SOCKS5_BAD_URL",
    );
  }

  // Extract credentials if present, decode them
  // Note: These will be stored in memory in the returned object
  const config: Socks5ProxyConfig = {
    host,
    port,
    remoteDns,
  };

  // Percent-decoding can itself fail: `decodeURIComponent("%ZZ")` throws a
  // `URIError`, which escaped this function as a raw URIError rather than the
  // documented Socks5Error, so a caller mapping error codes never saw one.
  // Nothing here includes the URL, so a clean SOCKS5_BAD_URL leaks nothing.
  const decode = (raw: string, field: "username" | "password"): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new Socks5Error(
        `Invalid SOCKS5 proxy URL: malformed percent-encoding in the ${field}`,
        "SOCKS5_BAD_URL",
      );
    }
  };
  if (parsed.username) {
    config.username = decode(parsed.username, "username");
  }
  if (parsed.password) {
    config.password = decode(parsed.password, "password");
  }

  return config;
}

/**
 * Sanitize a SOCKS5 URL for logging - removes any embedded credentials
 */
function sanitizeSocks5UrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    // Rebuild URL without username/password
    const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    return clean;
  } catch {
    return "[redacted]";
  }
}

// ---------------------------------------------------------------------------
// 10. PLATFORM ADAPTERS
// ---------------------------------------------------------------------------

/**
 * Deno TCP connector.
 * Usage: pass `denoTcpConnector` as the `connector` argument to `createSocks5Tunnel`.
 *
 * Both connect and read operations are wrapped with Promise.race for timeout
 * enforcement, since Deno's native connect() doesn't support timeouts natively.
 *
 * @param host Proxy hostname.
 * @param port Proxy port.
 * @param timeoutMs Connect and read timeout in ms.
 * @returns A TcpConn to the SOCKS5 proxy.
 */
export const denoTcpConnector: TcpConnector = async (host, port, timeoutMs): Promise<TcpConn> => {
  // Deno-specific API - this connector is only intended to be used in Deno runtime
  // Type assertion for Deno global which has the connect method
  // Must use type assertion as Deno namespace is not in standard TypeScript types
  const denoGlobal = globalThis as unknown as {
    Deno: {
      connect: (options: { hostname: string; port: number; transport: string }) => Promise<{
        read: (buf: Uint8Array) => Promise<number | null>;
        write: (data: Uint8Array) => Promise<number>;
        close: () => void;
      }>;
    };
  };

  // NOTE: every timeout below is created and cleared explicitly. The previous
  // Promise.race timers were never cleared, so each read left a pending timer
  // (holding a closure, and keeping the Deno event loop alive) for the full
  // timeout window — one per chunk on a streaming tunnel.
  const withTimeout = async <T>(work: Promise<T>, message: string): Promise<T> => {
    if (!timeoutMs || timeoutMs <= 0) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Socks5Error(message, "SOCKS5_TIMEOUT", true)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const conn: Awaited<ReturnType<typeof denoGlobal.Deno.connect>> = await withTimeout(
    denoGlobal.Deno.connect({ hostname: host, port, transport: "tcp" }),
    "TCP connect to proxy timed out",
  );

  // Not `async`: it returns withTimeout()'s promise directly, so there is no
  // await to make the function async.
  const wrappedRead = (buf: Uint8Array): Promise<number | null> => {
    const read = conn.read(buf).catch(() => null);
    return withTimeout(read, "TCP read timed out");
  };

  return {
    read: wrappedRead,
    write: (data) => conn.write(data),
    close: () => {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    },
  };
};

/**
 * Node.js TCP connector (requires `net` module).
 * Usage: pass `nodeTcpConnector` as the `connector` argument to `createSocks5Tunnel`.
 *
 * @param host Proxy hostname.
 * @param port Proxy port.
 * @param timeoutMs Connect timeout in ms.
 * @returns A TcpConn to the SOCKS5 proxy.
 */
export const nodeTcpConnector: TcpConnector = (host, port, timeoutMs): Promise<TcpConn> => {
  return new Promise((resolve, reject) => {
    import("node:net")
      .then(({ createConnection }) => {
        const socket = createConnection({ host, port });
        // Same rule as the Deno connector: 0 (or any non-positive budget)
        // disables the timeout rather than firing on the next tick. Every
        // `clearTimeout(timer)` below is guarded on `timer` being defined.
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            socket.destroy();
            reject(new Socks5Error("TCP connect to proxy timed out", "SOCKS5_TIMEOUT", true));
          }, timeoutMs);
        }
        const clear = (): void => {
          if (timer !== undefined) clearTimeout(timer);
        };

        let buffer = new Uint8Array(0);
        let pendingRead: ((value: number | null) => void) | null = null;
        let pendingReject: ((err: unknown) => void) | null = null;
        let pendingBuf: Uint8Array | null = null;
        let lastError: Error | null = null;

        function flushBuffer(): void {
          if (!pendingRead || !pendingBuf || buffer.length === 0) return;
          const n = Math.min(buffer.length, pendingBuf.length);
          pendingBuf.set(buffer.subarray(0, n));
          buffer = buffer.slice(n);
          const resolve = pendingRead;
          pendingRead = null;
          pendingReject = null;
          pendingBuf = null;
          resolve(n);
        }

        function rejectPending(err: unknown): void {
          if (pendingReject) {
            const rej = pendingReject;
            pendingRead = null;
            pendingReject = null;
            pendingBuf = null;
            rej(err);
          }
        }

        socket.on("data", (chunk: Uint8Array) => {
          const next = new Uint8Array(buffer.length + chunk.length);
          next.set(buffer);
          next.set(chunk, buffer.length);
          buffer = next;
          flushBuffer();
        });

        // Latch EOF. Without this, a read issued AFTER `end` parked forever:
        // the socket will never emit data again, nothing rejects, and the caller
        // hangs with no error. Callers now get an immediate null (clean EOF).
        let ended = false;
        socket.on("end", () => {
          ended = true;
          if (pendingRead) {
            pendingRead(null);
            pendingRead = null;
            pendingReject = null;
            pendingBuf = null;
          }
        });
        socket.on("close", () => {
          ended = true;
        });

        socket.once("error", (err) => {
          clear();
          lastError = err;
          rejectPending(err);
          reject(err);
        });

        socket.once("connect", () => {
          clear();
          socket.on("error", (err) => {
            lastError = err;
            rejectPending(err);
          });
          resolve({
            read: (buf) =>
              new Promise<number | null>((res, rej) => {
                if (lastError) {
                  rej(lastError);
                  return;
                }
                if (ended && buffer.length === 0) {
                  res(null);
                  return;
                }
                if (buffer.length > 0) {
                  const n = Math.min(buffer.length, buf.length);
                  buf.set(buffer.subarray(0, n));
                  buffer = buffer.slice(n);
                  res(n);
                  return;
                }
                pendingRead = res;
                pendingReject = rej;
                pendingBuf = buf;
              }),
            write: (data) =>
              new Promise((res, rej) => {
                socket.write(data, (err) => (err ? rej(err) : res(data.length)));
              }),
            close: () => socket.destroy(),
          });
        });
      })
      .catch(reject);
  });
};

// ---------------------------------------------------------------------------
// 11. INTEGRATION HELPER — HTTP client hook
// ---------------------------------------------------------------------------

/**
 * Higher-order connector: wraps any `TcpConnector` with SOCKS5 tunnelling.
 *
 * Drop this into an HTTP client that accepts a custom TCP connector factory.
 * The returned connector creates a SOCKS5 tunnel to the proxy, then forwards
 * all TCP traffic through that tunnel.
 *
 * @param proxyConfig SOCKS5 proxy connection parameters.
 * @param baseConnector The underlying TCP connector to wrap.
 * @returns A TcpConnector that tunnels all connections through the SOCKS5 proxy.
 * @throws {Socks5Error} Delegates to `createSocks5Tunnel` — see its errors.
 *
 * @example
 * ```ts
 * // With Deno
 * const client = new HttpClient({
 *   connector: socks5Connector(
 *     { host: "127.0.0.1", port: 1080 },
 *     denoTcpConnector,
 *   ),
 * });
 *
 * // With Node.js
 * const client = new HttpClient({
 *   connector: socks5Connector(
 *     { host: "proxy.example", port: 1080, username: "user", password: "pass" },
 *     nodeTcpConnector,
 *   ),
 * });
 * ```
 *
 * For clients without connector support, use `createSocks5Tunnel` directly.
 */
export function socks5Connector(
  proxyConfig: Socks5ProxyConfig,
  baseConnector: TcpConnector,
): TcpConnector {
  return async (host: string, port: number, timeoutMs: number): Promise<TcpConn> => {
    // The per-call `timeoutMs` is the more specific value, so it must be
    // spread LAST. It was spread first, so a `connectTimeoutMs` in the proxy
    // config silently overrode it — a caller asking for 5s was dialled with
    // the config's 99s, and nothing said so. It also now bounds the
    // handshake, which is the same "how long may this connection take" budget
    // the caller expressed and was otherwise ignored entirely.
    const perCall = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
    const connectTimeoutMs = perCall ?? proxyConfig.connectTimeoutMs;
    const tunnel = await createSocks5Tunnel(
      {
        ...proxyConfig,
        ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
        ...(perCall !== undefined ? { handshakeTimeoutMs: perCall } : {}),
      },
      { host, port },
      baseConnector,
    );
    return tunnel.conn;
  };
}
