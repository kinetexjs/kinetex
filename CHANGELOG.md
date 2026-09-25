# Changelog

All notable changes to kinetex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-25

### Fixed

- **Security (SSRF):** URL safety checks now expand IPv4/IPv6 hosts to numeric form before range comparison, closing bypasses via IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]`), hex/octal/decimal IPv4 literals (`0x7f000001`, `2130706433`, `0177.0.0.1`), and IPv6 aliases (`[::0:1]`). Covers loopback, RFC 1918, CGNAT, link-local (IMDS), IETF protocol, TEST-NET, benchmarking, multicast, and reserved ranges.
- **Security (redirects):** Credential-bearing headers (`Authorization`, `Cookie`, `Proxy-Authorization`, API-key headers) are now stripped when a redirect crosses origins, and auth re-application is suppressed on cross-origin hops — secrets are no longer forwarded to a different origin.
- **Security (HAR):** HAR entries redact credential-bearing request/response headers (`Authorization`, `Cookie`, API keys, tokens) before recording.
- **Security (URL):** the manual query-param fallback in `buildURL` now runs the SSRF safety check like every other path, and error messages redact `user:pass@` userinfo from URLs.
- **Security (auth):** `apikey` auth validates the custom header name (rejects CRLF/space injection) before applying it.
- **Security (prototype pollution):** untrusted JSON is sanitized (via the new `sanitizeParsedJSON`) at every remaining raw `JSON.parse` site — GraphQL single/batch/SSE responses, SSE `jsonSSE()` and `SSERouter.onJSON()`, WebSocket `message.json`, `deserializePaginationState`, and logging body redaction — so hostile `"__proto__": {...}` payload keys can never reach user code or downstream merges.
- **Security (GraphQL uploads):** upload variable paths are validated against prototype-pollution segments (`__proto__`, `constructor`, `prototype`); a crafted path like `__proto__.polluted` now throws `ValidationError` instead of writing through the prototype.
- **Security (logging redactor):** `redactObjectPath` never traverses or writes through pollution keys and uses own-property checks, so `bodyFields` selectors cannot be abused for prototype traversal.
- **Custom fetch honored everywhere:** a `fetch` option passed in config was silently ignored on Node.js when HTTP/2 was preferred (the default) — `NodeHTTP2Transport` has no fetch input. When a custom fetch is supplied it now always routes through `FetchTransport`, so the documented "custom fetch implementation" behavior (proxy agents, test doubles, request signing wrappers) works on every runtime.
- **Timeout:** `sendWithTimeout` races the transport against a deadline promise, so a transport that never resolves or ignores the abort signal can no longer hang the caller past `timeoutMs`.

### Changed

- `test:all` npm script now discovers all `tests/*.test.mts` files automatically (previously referenced three non-existent files and omitted several real test files).
- README: documented the `sanitizeParsedJSON` utility and kinetex's built-in prototype-pollution protection; corrected the `proxy` config / `.proxy()` fluent docs — the option fails fast with actionable guidance (undici `ProxyAgent` via `fetch`, or `createSocks5Tunnel()` for SOCKS5) instead of silently routing direct.
- README: documented previously-undocumented APIs — `WSClient` connection state/health (`state`, `connected`, `bufferedCount`, `metrics`, `waitForOpen`), rooms (`join`/`leave`/`rooms`), backpressure (`backpressure`, `drain`, `drainAndClose`, `drainBuffer`) and teardown (`close`/`destroy`); `SSEClient` lifecycle (`collect`, `close`, `destroy`, `streamHealth`). Corrected the Runtime Compatibility table: Brotli decompression is Node-only (`node:zlib`; other runtimes pass brotli bodies through), `WSClient` requires native `WebSocket` (Node 22+), URL pattern matching is kinetex's built-in implementation (all runtimes), and HTTP/2-via-fetch detection is best-effort (`Alt-Svc`/runtime hints). Fixed fluent-builder docs (`.withBody()`/`.params()` — `.body()`/`.query()` never existed) and `RetryContext` shape (`response`/`error` are non-optional, no `delayMs`).

## [1.0.0] - 2026-09-18

### Added

- HTTP/2 transport with `NodeHTTP2Transport` (Node.js 22+)
- SOCKS5 proxy support via `socks5.ts`
- AWS SigV4 signing for S3, API Gateway, STS, DynamoDB
- Digest authentication via `digest.ts`
- Circuit breaker pattern via `circuit-breaker.ts`
- Request deduplication via `dedup.ts`
- Cookie jar with RFC 6265 compliant parser and store
- HTTP cache with `MemoryStorage`, `WebStorage`, `KV`, `TwoTier` adapters
- SSE client with parser and router
- WebSocket client with reconnection
- GraphQL client with APQ and links
- Pagination strategies: offset, page, cursor, keyset, link-header, token, relay
- Upload/download progress tracking via `progress.ts`
- HAR logging via `interceptors.ts`
- OpenTelemetry tracing via `interceptors.ts`
- URL builder with `URLBuilder.from()`, template expansion, redaction
- Headers parsing: `Cache-Control`, `CSP`, `CORS`, `HSTS`, `Link`, `Server-Timing`
- Response parsing: JSON, text, bytes, NDJSON, JSON stream, multipart
- Fluent request builder with typed responses
- Batch queue for bulk operations
- Lifecycle hooks system: `onRequest`, `onResponse`, `onError`, `onRetry`
- Built-in interceptors: retry (with backoff), auth, cache, dedupe, rate-limit, HAR, metrics, logging
- Cross-runtime support: Node.js 18+, Deno, Bun, Browser, Cloudflare Workers, Vercel Edge
- Worker entry point for edge runtimes (`kinetex/worker`)
- Zero external dependencies

[Unreleased]: https://github.com/kinetexjs/kinetex/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kinetexjs/kinetex/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kinetexjs/kinetex/compare/v0.0.3...v1.0.0
