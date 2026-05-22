/**
 * **kinetex/worker** — Cloudflare Workers / workerd / WinterCG / Vercel Edge entry point.
 *
 * This entry point:
 *  - Exports ONLY types and classes that are safe in all WHATWG/WinterCG environments.
 *  - Has NO `export * from "./mod.ts"` — avoids duplicate named exports.
 *  - The Kinetex class itself is CF-safe because node:http2 / node:https are
 *    lazily imported inside async methods, never at module parse time.
 *  - FetchTransport (globalThis.fetch) is used automatically when IS_NODE is false.
 *
 * ⚠️ Features unavailable from this entry point (use main `mod.ts` instead):
 *  - HTTP/2 (node:http2) — available in Node.js but not edge runtimes
 *  - HTTPS agent options (node:tls) — Node.js only
 *  - Custom Node.js-only transports (e.g., Undici, Node.js http/https agents)
 *  - Some advanced interceptors that depend on Node.js APIs
 *
 * If you import from the main entry and use Node.js-only features, your code
 * will crash in edge environments. This worker entry prevents such issues by
 * only exposing what's safe across all runtimes.
 */

// ── Types only (no runtime cost) ──────────────────────────────────────────────
export type {
  KinetexConfig,
  KinetexRequest,
  KinetexResponse,
  SendOptions,
  HTTPMethod,
  AuthConfig,
  RetryConfig,
  HARLog,
  HAREntry,
  HeadersInit,
  QueryParams,
  BodyInit,
  RequestInterceptor,
  ResponseInterceptor,
  ErrorInterceptor,
  LifecycleHooks,
} from "./types.ts";

// ── Runtime exports ───────────────────────────────────────────────────────────
export {
  KinetexError,
  HTTPStatusError,
  TimeoutError,
  NetworkError,
  RedirectError,
} from "./types.ts";

export { Kinetex, FluentRequest, BatchQueue, createMethodCircuitBreakerKey } from "./client.ts";

// ── Factory helper ─────────────────────────────────────────────────────────────
import { Kinetex as _Kinetex } from "./client.ts";
import type { KinetexConfig } from "./types.ts";

/**
 * Create a Kinetex client pre-configured for edge/worker runtimes.
 *
 * This factory provides a convenient way to create a Kinetex instance
 * optimized for edge environments (Cloudflare Workers, Vercel Edge, etc.).
 *
 * @param config - Optional configuration options
 * @returns Configured Kinetex client instance
 *
 * @example
 * ```ts
 * // Basic usage
 * const client = kinetex({ baseURL: "https://api.example.com" });
 *
 * // With authentication
 * const authClient = kinetex({
 *   baseURL: "https://api.example.com",
 *   auth: { type: "bearer", token: "my-token" },
 * });
 *
 * // HTTP/2 is supported for outgoing requests (when target server supports it)
 * const http2Client = kinetex({ httpVersion: "HTTP/2" });
 * ```
 *
 * Note: Default transport is `globalThis.fetch` which is available in all
 * edge runtimes. This entry point does not include Node.js-specific transports.
 */
export function kinetex(config: KinetexConfig = {}): _Kinetex {
  return new _Kinetex({ httpVersion: config.httpVersion ?? "HTTP/1.1", ...config });
}

export default kinetex;
