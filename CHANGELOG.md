# Changelog

All notable changes to kinetex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kinetexjs/kinetex/compare/v0.0.3...HEAD
