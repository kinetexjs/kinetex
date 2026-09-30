/**
 * §14  HTTP(S) CONNECT PROXY TUNNELING
 *
 * Establishes a TCP tunnel to a target host through an HTTP/HTTPS proxy using
 * the `CONNECT` method (RFC 9110 §9.3.6), then optionally wraps that socket in
 * TLS to the target.
 *
 * The tunnel is how an HTTP proxy must be used for HTTPS: the client sends
 * only the CONNECT request line to the proxy, and from there the proxy is a
 * blind byte relay. The target's certificate is therefore validated end to
 * end against the target's own name — the proxy never terminates TLS, so it
 * cannot impersonate the target without the CA store rejecting it.
 *
 * This module is Node-only by construction: it imports `node:net` and
 * `node:tls`. Other runtimes route through their own `fetch` and must use a
 * proxy-capable dispatcher instead.
 *
 * @module
 */

import { KinetexError } from "./types.ts";
import type { ProxyConfig } from "./types.ts";

/** Options for {@link connectThroughProxy}. */
export interface ProxyConnectOptions {
  /** CA certificate(s) trusted in addition to the system store. */
  ca?: string | string[];
  /** TLS server name for the target (defaults to the target hostname). */
  servername?: string;
  /** Socket/connect/tunnel timeout in ms. Default: 30 000. */
  connectTimeoutMs?: number;
  /** Abort the connection attempt. */
  signal?: AbortSignal | null;
  /** Origin of the request, attached to any thrown KinetexError. */
  request?: import("./types.ts").KinetexRequest;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Maximum CONNECT response head we will buffer before giving up. */
const MAX_HEAD_BYTES = 64 * 1024;

/**
 * True when the proxy URL names a SOCKS proxy, which needs a different
 * mechanism entirely (`createSocks5Tunnel` in `kinetex/socks5`).
 */
function isSocksProxy(url: string): boolean {
  return /^socks5h?:/i.test(url);
}

/**
 * Build the `Proxy-Authorization` header value for Basic proxy auth.
 *
 * Uses the same encoding as the client's HTTP Basic auth. Returns `undefined`
 * when no username was supplied — an empty username is still a deliberate
 * (if unusual) credential, so it is encoded rather than skipped.
 */
function proxyAuthHeader(proxy: ProxyConfig): string | undefined {
  if (proxy.username === undefined) return undefined;
  const raw = `${proxy.username}:${proxy.password ?? ""}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof globalThis.btoa === "function"
      ? globalThis.btoa(binary)
      : // Node without btoa (or a non-Latin1 username) — encode explicitly.
        Buffer.from(bytes).toString("base64");
  return `Basic ${b64}`;
}

/**
 * Parse a `CONNECT` response head.
 *
 * @returns The numeric status code, or `null` when the head is incomplete.
 */
function parseConnectStatus(head: string): { status: number; reason: string } | null {
  const statusLine = head.split("\r\n", 1)[0] ?? "";
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) return null;
  return { status: Number(match[1]), reason: match[2] ?? "" };
}

/**
 * Open a socket to a target host through an HTTP(S) proxy via `CONNECT`.
 *
 * Returns a socket connected to the **target** — already TLS-wrapped when the
 * target is `https:`. The caller owns it and decides whether to pool it.
 *
 * @param proxy - Proxy URL and optional Basic credentials.
 * @param target - Fully-resolved target URL.
 * @param options - CA, timeout, and abort configuration.
 * @returns A socket tunneled to the target.
 * @throws {KinetexError} `EVALIDATION` for a SOCKS proxy or a malformed proxy
 *   URL, `EPROXYAUTH` when the proxy demands credentials, `EPROXY` for any
 *   other non-2xx CONNECT response, `ETIMEOUT` if the proxy never answers,
 *   `EABORT` if `signal` fires, and `ENETWORK` for socket/TLS failures.
 */
export async function connectThroughProxy(
  proxy: ProxyConfig,
  target: URL,
  options: ProxyConnectOptions = {},
): Promise<import("node:net").Socket | import("node:tls").TLSSocket> {
  // Built conditionally: `exactOptionalPropertyTypes` forbids passing an
  // explicit `undefined` for an optional property.
  const errMeta: { request?: import("./types.ts").KinetexRequest } =
    options.request !== undefined ? { request: options.request } : {};

  if (isSocksProxy(proxy.url)) {
    throw new KinetexError(
      `proxy url "${proxy.url}" is a SOCKS proxy, which needs a different mechanism. ` +
        "Use createSocks5Tunnel() from kinetex/socks5 and supply your own fetch over the tunnel.",
      "EVALIDATION",
      errMeta,
    );
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy.url);
  } catch (err) {
    throw new KinetexError(`proxy url "${proxy.url}" is not a valid URL`, "EVALIDATION", {
      ...errMeta,
      cause: err,
    });
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new KinetexError(
      `proxy url scheme "${proxyUrl.protocol}" is not supported; use http:, https:, socks5: or socks5h:`,
      "EVALIDATION",
      errMeta,
    );
  }

  const net = await import("node:net");
  const tls = await import("node:tls");

  const proxyPort = proxyUrl.port
    ? Number(proxyUrl.port)
    : proxyUrl.protocol === "https:"
      ? 443
      : 80;
  const targetPort = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  const authority = `${target.hostname}:${targetPort}`;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // ── 1. TCP (or TLS-to-proxy) connection to the proxy itself ───────────────
  const baseSocket =
    proxyUrl.protocol === "https:"
      ? await openTlsSocket(
          tls,
          {
            host: proxyUrl.hostname,
            port: proxyPort,
            servername: proxyUrl.hostname,
            ...(options.ca !== undefined ? { ca: options.ca } : {}),
          },
          timeoutMs,
          options.signal,
          errMeta,
          `proxy ${proxyUrl.host}`,
        )
      : await openTcpSocket(
          net,
          { host: proxyUrl.hostname, port: proxyPort },
          timeoutMs,
          options.signal,
          errMeta,
          `proxy ${proxyUrl.host}`,
        );

  // ── 2. CONNECT handshake ─────────────────────────────────────────────────
  const auth = proxyAuthHeader(proxy);
  const connectLines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    // RFC 9110 §9.3.6: proxies that support persistent tunnels are expected to
    // treat a tunnel as still-open even without this, but sending it is what
    // every real client does and some proxies misbehave without it.
    "Proxy-Connection: Keep-Alive",
    ...(auth !== undefined ? [`Proxy-Authorization: ${auth}`] : []),
    "",
    "",
  ];
  baseSocket.write(connectLines.join("\r\n"));

  let head = "";
  // TCP does not preserve write boundaries. A proxy that splits the 200 head
  // across two writes and puts the target's first bytes in the second
  // delivers the head terminator and the start of the tunnelled stream in a
  // single read, so the tail is kept and put back rather than discarded --
  // dropping it silently truncates the message the caller is about to read.
  //
  // The head is therefore read in PAUSED mode -- `on("readable")` plus
  // `read()` -- and never with `on("data")`. `on("data")` switches the stream
  // to flowing mode, and removing the last `data` listener does NOT switch it
  // back, so a flowing socket with nothing attached silently DISCARDS the
  // bytes after the head terminator. `unshift()` alone does not recover them
  // either: a later `on("data")` sets `state.flowing = true` before calling
  // `resume()`, and `resume()` only restarts the flow when flowing was
  // previously false, so the socket stalls with the tail still buffered and
  // the caller waits forever. Reading paused leaves the flow state unset, so
  // whichever consumer comes next -- `on("data")`, `pipe()`, or
  // `tls.connect({ socket })` -- starts the flow and sees the tail.
  const headResult = await new Promise<{ ok: true } | { ok: false; err: KinetexError }>(
    (resolve) => {
      // Pull every buffered chunk into `head`; a null read means the buffer is
      // drained and `readable` will fire again when more arrives.
      const drain = (): void => {
        for (;;) {
          const chunk = baseSocket.read() as Buffer | null;
          if (chunk === null) return;
          head += chunk.toString("latin1");
        }
      };

      const onReadable = (): void => {
        drain();
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
          if (head.length > MAX_HEAD_BYTES) {
            cleanup();
            resolve({
              ok: false,
              err: new KinetexError("Proxy sent an oversized CONNECT response", "EPROXY", errMeta),
            });
          }
          return;
        }

        cleanup();
        const parsed = parseConnectStatus(head.slice(0, end));
        if (!parsed) {
          resolve({
            ok: false,
            err: new KinetexError(
              `Proxy returned a malformed CONNECT response: ${JSON.stringify(head.slice(0, end).split("\r\n", 1)[0] ?? "")}`,
              "EPROXY",
              errMeta,
            ),
          });
          return;
        }

        // RFC 9110 section 9.3.6: any 2xx switches the proxy to tunnel mode.
        // Only 200 was accepted, so a proxy answering 201 or 204 was reported
        // as a refusal.
        if (parsed.status >= 200 && parsed.status < 300) {
          // Put the tunnel bytes back in front of the buffered stream before
          // handing the socket on. latin1 round-trips the bytes exactly, which
          // is how `head` was built.
          const tail = head.slice(end + 4);
          if (tail.length > 0) baseSocket.unshift(Buffer.from(tail, "latin1"));
          resolve({ ok: true });
          return;
        }
        if (parsed.status === 407) {
          // Deliberately does not echo credentials back to the caller.
          resolve({
            ok: false,
            err: new KinetexError(
              "Proxy requires authentication (407). Set `username`/`password` on the proxy config, " +
                "or embed them in the proxy URL.",
              "EPROXY",
              errMeta,
            ),
          });
          return;
        }
        resolve({
          ok: false,
          err: new KinetexError(
            `Proxy refused CONNECT to ${authority}: ${parsed.status} ${parsed.reason}`.trim(),
            "EPROXY",
            errMeta,
          ),
        });
      };

      const onError = (e: Error): void => {
        cleanup();
        resolve({
          ok: false,
          err: new KinetexError(`Proxy connection failed: ${e.message}`, "ENETWORK", {
            ...errMeta,
            cause: e,
          }),
        });
      };

      // A proxy that closes the connection mid-handshake delivers a clean FIN,
      // not a reset — so no `error` event fires and the socket simply ends.
      // Without this the request would sit here until the connect timeout
      // expired: 30s by default, for a proxy that is already gone.
      const onClosedEarly = (): void => {
        cleanup();
        resolve({
          ok: false,
          err: new KinetexError(
            `Proxy closed the connection before answering CONNECT for ${authority}`,
            "EPROXY",
            errMeta,
          ),
        });
      };

      const onTimeout = (): void => {
        cleanup();
        baseSocket.destroy();
        resolve({
          ok: false,
          err: new KinetexError(
            `Proxy did not respond to CONNECT for ${authority} within ${timeoutMs}ms`,
            "ETIMEOUT",
            errMeta,
          ),
        });
      };

      const onAbort = (): void => {
        cleanup();
        baseSocket.destroy();
        resolve({
          ok: false,
          err: new KinetexError("Proxy connection aborted", "EABORT", errMeta),
        });
      };

      const timer = setTimeout(onTimeout, timeoutMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }

      function cleanup(): void {
        clearTimeout(timer);
        baseSocket.off("readable", onReadable);
        baseSocket.off("error", onError);
        baseSocket.off("end", onClosedEarly);
        baseSocket.off("close", onClosedEarly);
        baseSocket.off("timeout", onTimeout);
        options.signal?.removeEventListener("abort", onAbort);
      }

      baseSocket.on("readable", onReadable);
      baseSocket.once("error", onError);
      baseSocket.once("end", onClosedEarly);
      baseSocket.once("close", onClosedEarly);
      baseSocket.setTimeout(timeoutMs, onTimeout);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // Data may already be buffered (the request write above and the reply
      // can cross), and `readable` does not fire for bytes that arrived before
      // the listener was attached.
      drain();
    },
  );

  if (!headResult.ok) {
    baseSocket.destroy();
    throw headResult.err;
  }

  // ── 3. TLS to the target through the tunnel ───────────────────────────────
  if (target.protocol !== "https:") {
    // Clear the handshake listeners' timeout; the socket now belongs to the
    // caller and its own timeout policy.
    baseSocket.setTimeout(0);
    return baseSocket;
  }

  return await new Promise<import("node:tls").TLSSocket>((resolve, reject) => {
    // The CONNECT handshake is over and its timeout/abort listeners are torn
    // down, but the TLS handshake to the target has not happened yet. A peer
    // that accepts the tunnel and then says nothing -- a black-holed target,
    // or a proxy that relays to nothing -- would otherwise wait forever, so
    // the same timeout and abort cover this step too.
    const onTunnelTimeout = (): void => {
      done();
      baseSocket.destroy();
      reject(
        new KinetexError(
          `TLS handshake through proxy to ${target.hostname} did not complete within ${timeoutMs}ms`,
          "ETIMEOUT",
          errMeta,
        ),
      );
    };
    const onTunnelAbort = (): void => {
      done();
      baseSocket.destroy();
      reject(new KinetexError("Proxy connection aborted", "EABORT", errMeta));
    };

    const tunnelTimer = setTimeout(onTunnelTimeout, timeoutMs);
    if (typeof (tunnelTimer as unknown as { unref?: () => void }).unref === "function") {
      (tunnelTimer as unknown as { unref: () => void }).unref();
    }
    options.signal?.addEventListener("abort", onTunnelAbort, { once: true });

    function done(): void {
      clearTimeout(tunnelTimer);
      options.signal?.removeEventListener("abort", onTunnelAbort);
    }

    const secure = tls.connect(
      {
        socket: baseSocket,
        servername: options.servername ?? target.hostname,
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
      },
      // `rejectUnauthorized` is left at its default (true), so a peer that
      // fails verification emits `error` rather than reaching this callback.
      // Verification therefore cannot be bypassed here, and the callback
      // only ever runs for a verified handshake.
      () => {
        done();
        baseSocket.setTimeout(0);
        resolve(secure);
      },
    );
    secure.once("error", (e: Error) => {
      done();
      baseSocket.destroy();
      reject(
        new KinetexError(
          `TLS handshake through proxy failed for ${target.hostname}: ${e.message}`,
          "ENETWORK",
          { ...errMeta, cause: e },
        ),
      );
    });
  });
}

/** Open a plain TCP socket, rejecting on error/timeout/abort. */
async function openTcpSocket(
  net: typeof import("node:net"),
  opts: { host: string; port: number },
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
  errMeta: object,
  what: string,
): Promise<import("node:net").Socket> {
  return await new Promise<import("node:net").Socket>((resolve, reject) => {
    const socket = net.connect({ host: opts.host, port: opts.port });
    const onError = (e: Error): void => {
      cleanup();
      reject(
        new KinetexError(`Cannot reach ${what}: ${e.message}`, "ENETWORK", {
          ...errMeta,
          cause: e,
        }),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new KinetexError(`Connecting to ${what} timed out`, "ETIMEOUT", errMeta));
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(new KinetexError("Proxy connection aborted", "EABORT", errMeta));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Open a TLS socket to an HTTPS proxy itself. */
async function openTlsSocket(
  tls: typeof import("node:tls"),
  opts: { host: string; port: number; servername: string; ca?: string | string[] },
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
  errMeta: object,
  what: string,
): Promise<import("node:tls").TLSSocket> {
  return await new Promise<import("node:tls").TLSSocket>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: opts.host,
        port: opts.port,
        servername: opts.servername,
        ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
      },
      () => {
        cleanup();
        resolve(socket);
      },
    );
    const onError = (e: Error): void => {
      cleanup();
      reject(
        new KinetexError(`Cannot reach ${what}: ${e.message}`, "ENETWORK", {
          ...errMeta,
          cause: e,
        }),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new KinetexError(`Connecting to ${what} timed out`, "ETIMEOUT", errMeta));
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(new KinetexError("Proxy connection aborted", "EABORT", errMeta));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }
    socket.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
