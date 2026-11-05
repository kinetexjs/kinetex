/**
 * Browser stand-ins for Node builtins.
 *
 * The browser bundle is built from the same source tree as the Node build, so
 * esbuild still sees the lazy `import("node:*")` calls in Node-only transports,
 * decompression fallbacks, and logging. Leaving those external made the
 * published bundle unloadable in a browser bundler: the first `node:zlib` or
 * `node:dns` specifier stopped the build even though the browser path never
 * executes it.
 *
 * Every builtin is aliased to this module for the browser build only. The
 * functions either report a clear runtime error (Node transport/decompression
 * paths) or degrade safely (DNS preflight is skipped by the caller's existing
 * try/catch; IDN falls back to the input string). None of them import a Node
 * builtin, so the resulting bundle is self-contained.
 */

function unsupported(name: string): never {
  throw new Error(`[kinetex] ${name} is not available in this runtime.`);
}

/** `node:dns` stand-in: fail the lookup callback so the preflight is skipped. */
export function lookup(
  _hostname: string,
  _options: unknown,
  callback: (err: NodeJS.ErrnoException | null) => void,
): void {
  const err = Object.assign(new Error("[kinetex] DNS lookup is not available in this runtime"), {
    code: "ENOTSUP",
  });
  callback(err);
}

/** `node:net.isIP` stand-in used only by Node-specific code. */
export function isIP(_host: string): number {
  return 0;
}

/** `node:net.connect` / `node:tls.connect` / `node:http2.connect`. */
export function connect(): never {
  return unsupported("A Node socket transport");
}

/** `node:https.request` / `node:http.request`. */
export function request(): never {
  return unsupported("The Node HTTP/1.1 transport");
}

/** `node:https.Agent` stand-in; constructing it is a Node-only operation. */
export class Agent {
  constructor(_options?: unknown) {
    unsupported("node:https.Agent");
  }
}

/** `node:https.globalAgent` stand-in. */
export const globalAgent = {};

/** `node:stream.Readable` stand-in; the pretty logger is Node-only. */
export class Readable {
  constructor(_options?: unknown) {
    unsupported("node:stream.Readable");
  }
}

/** `node:tls.TLSSocket` stand-in. */
export class TLSSocket {
  constructor() {
    unsupported("node:tls.TLSSocket");
  }
}

/** `node:net.Socket` stand-in. */
export class Socket {
  constructor() {
    unsupported("node:net.Socket");
  }
}

/** `node:url.domainToUnicode` fallback: leave the hostname untouched. */
export function domainToUnicode(hostname: string): string {
  return hostname;
}

/** `node:zlib` stand-ins. The browser uses DecompressionStream where available. */
export function createBrotliDecompress(): never {
  return unsupported("Brotli decompression");
}

export function createZstdDecompress(): never {
  return unsupported("Zstandard decompression");
}

export function createGunzip(): never {
  return unsupported("Gzip decompression");
}

export function createInflate(): never {
  return unsupported("Deflate decompression");
}

/** `node:http2.constants` stand-in for feature checks. */
export const constants = {};
