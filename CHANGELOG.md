# Changelog

All notable changes to kinetex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-26

A full-codebase review pass — source correctness, then a documentation audit that checked every README section and inline JSDoc example against the implementation. Every source finding below is covered by a dedicated regression test in `tests/regressions.test.mts` (131 tests); the documentation findings are enforced by `tests/docs-drift.test.mts`, which type-checks all 146 documented samples against `src/`.

### Documentation

A second audit pass found documentation defects that the first round missed, because the docs-drift test only treated two diagnostic codes as drift. It now also fails on TS2339 ("property does not exist"), which is what caught most of these. All eleven are fixed:

- **Fluent builder documented as an unbroken chain.** The "Fluent Request Builder" sample chained `.send().json().text().bytes().blob().data().subscribe()` onto one expression. Every terminal method returns a promise, so only the first can be called; the sample now shows one terminal call per request.
- **`HookEmitter.clear()` does not exist** (it is `removeAllListeners()`), and the sample used `beforeRequest` with a `(req, ctx)` pair — the real event names are colon-separated (`before:request`) and `emit()` is async and takes a single event object. The full event-name list is now documented.
- **`Socks5Tunnel.send()` does not exist.** `createSocks5Tunnel` is a low-level primitive returning `{ conn, boundAddr, boundPort }` — a raw TCP socket, not an HTTP client. The sample invented a request API, omitted two of the function's three required arguments, and implied kinetex could route over it unaided. Rewritten to show the real shape and to state that reaching kinetex's pipeline means supplying your own fetch over the tunnel.
- **`withDownloadProgress()` destructured as `{ stream }`.** It returns `{ response, tracker }`; only the upload wrappers return a `stream`. `streamWithProgress()` was also shown as returning `{ stream }` when it is an async generator yielding `{ chunk, progress }`, and its options are `Omit<ProgressOptions, "onProgress">` (progress arrives per chunk), so the sample's `onProgress` callback could not compile.
- **`gql` used as a tagged template in five places.** It is a one-shot _function_ — `gql(url, query, variables?, headers?)` — and there is no template-tag form. Related: `client.query()` resolves to the response's `data` field directly, not to a `{ data, errors }` envelope; a non-empty `errors` array throws `GraphQLClientError`. The samples now say so, and `client.graphql()` is documented as returning a `GraphQLClient` rather than shadowing the imported `gql`.
- **AWS SigV4 chunked signing documented with a fabricated signature.** `initChunkedSigning(request, config)` returns `{ signedRequest, state }`; `signChunk(chunk, state)` returns `{ chunkHeader, newState }` and `signFinalChunk(state)` returns a string. The sample invented `sessionToken`/`dateTime`/`chunkIndex`/`previousSignature` parameters, and omitted that `newState` must be threaded into the next call.
- **`URLBuilder` sample called `.toString()` and then read `.href`/`.protocol`/`.searchParams` off the result**, which is a `string`. The builder is now kept in a variable and rendered separately.
- **`detectHTTPVersion()` presented as public API.** It is an internal, non-exported helper in `core.ts`; the compatibility note now says so and points at `KinetexResponse.httpVersion` instead.
- **`ECIRCUITOPEN` missing from the error-code table.** `CircuitOpenError` is exported and thrown by every circuit-breaker rejection, but the table omitted it.
- **`client.get("/users/1").json<User>()`** in the `Kinetex` class JSDoc: `get()` returns a `Promise`, so `.json()` cannot be chained onto it. The uppercase `GET()` builder is required. The same example passed a single object to `send()`, which takes `(url, method, options)`.
- **`WSMessage.json` read as `msg.json?.type`.** It is typed `unknown`, so the sample now narrows it before use.

`CONTRIBUTING.md` had its own drift: it pointed at `npm run test:coverage` (the script is `coverage`), and its code-style rules forbade `any` and lint suppressions outright — both exist in `src/` today, so the rules now state the actual convention instead of one the codebase does not follow.

### Security

- **SSRF (critical):** redirect targets are now re-validated. `isSafeURL` only screened the _initial_ URL, so a public host returning `302 → http://169.254.169.254/…` reached the link-local/IMDS address with the whole private-range block list bypassed. Every hop now runs the same SSRF check, and `httpsOnly` is re-checked per hop so a redirect is no longer a trivial https→http downgrade.
- **Cross-origin credentials without a cookie jar:** `CROSS_ORIGIN_STRIP_HEADERS` was only applied by the manual redirect follower, which runs _only_ when a cookie jar is active. With the default path (`redirect: "follow"`) the Fetch spec drops only `authorization`/`cookie`/`proxy-authorization`, so a custom API-key header was forwarded verbatim to any redirect target. Requests carrying a known credential header — or a declared `apikey` auth (whose name is application-chosen and therefore unknown to the library) — are now followed hop-by-hop and stripped on origin change.
- **Cross-origin cookie leak:** the strip loop ran _after_ the jar-scoped `Cookie` header was rebuilt, deleting it again, so every cross-origin hop was sent without the cookies the jar had just scoped for the target. The order is corrected; same-origin hops are unaffected.
- **HAR (high):** HAR entries redacted credential _headers_ but stored the full `request.url`, every `queryString` value, the `Location` header and the entire response body verbatim — in a format whose stated rationale is that HAR logs are routinely exported and shared. URLs now have sensitive query parameters (and the fragment) masked, `Location` is redacted, body text is recorded only for JSON/XML/text content types and truncated to 8 KiB, and HTML bodies are never recorded.
- **Dedupe interceptor (critical):** `createDedupeInterceptor` keyed on `METHOD:url` with no auth fingerprint and handed the leader's response object to every waiter, so two callers with different `Authorization`/`Cookie` for the same URL received each other's data. The key now includes the same fingerprint the client's built-in dedup uses.
- **Cache/dedup credential coverage (high):** the auth fingerprint only hashed `authorization`, `cookie`, `x-api-key` and `x-auth-token`, while the redirect strip list treated ten more headers as credentials. A single shared `CREDENTIAL_HEADERS` list now backs the cache key, the dedup key and the cross-origin strip list, so a custom auth header can no longer silently collapse two users into one cache entry. Fingerprinting is also case-insensitive on header names.
- **SOCKS5:** the IMDS role name returned by the metadata service is now `encodeURIComponent`-escaped before being interpolated into the credentials URL path.

### Fixed

- **Crash / wrong error (critical):** the download-progress stream wrapper closed over the same `let` that was reassigned to the wrapper, so `cancel()` cancelled _itself_. `readRawBody`'s `reader.cancel()` (size limit exceeded, abort mid-download, read error) re-entered it, which threw `TypeError: Invalid state: ReadableStream is locked` from inside the cancel algorithm and left the inner promise unhandled — a process-level crash on Node. `maxResponseSize` + `onDownloadProgress` now yields the intended `SizeLimitError`.
- **Backpressure:** `withUploadProgress` and `withDownloadProgress` drained their entire source inside an `async start()`, enqueueing every chunk before the transport or consumer read a single byte — a large transfer was fully buffered in memory and the stream high-water mark bought nothing. Both are now pull-based (`start`/`pull`/`cancel`).
- **Type narrower than runtime (bodies):** the client has always JSON-encoded a plain-object/array body and set `content-type: application/json` when the caller supplied no content-type, but `SendOptions.body` and the `post`/`put`/`patch`/`withBody` parameters were typed `BodyInit`, so the documented, tested and working call `client.post("/posts", { title: "x" })` did not type-check. A new exported `RequestBody` type admits those values; `KinetexRequest.body` stays `BodyInit | null` because the encoding has already happened by then.
- **Silently empty body for `URLSearchParams`/`Blob` (high):** the raw Node HTTP/1.1 and HTTP/2 transports write only streams, byte arrays and strings; any other `BodyInit` fell through to `stream.end()`/`req.end()` with no payload, so `client.post(url, new URLSearchParams({ a: "1" }))` reached the server as an empty request on the default HTTP/2 path. Both writers now serialize the body types `fetch` would have encoded, and a `URLSearchParams` body without an explicit content-type gets `application/x-www-form-urlencoded` so servers can parse it.
- **`Cache-Control` quoted values truncated:** `parseCacheControl` split the header on every comma, including commas inside a quoted string, so `private="field1, field2"` parsed as a single field `field1` (RFC 7234 §5.2). Directives are now split on commas outside quotes.
- **Lost response in `onError` hooks:** the error-hook bridge in `attachHookRegistry` hardcoded `response: null` on both the `HookError` and the `HookContext`, even when the failure carried a response (`HTTPStatusError` holds the `KinetexResponse`). Every bridged `onError` hook therefore saw no response — `createLoggingHooks()` in particular recorded `status: null` for 4xx/5xx, silently losing the status code in structured logs. The response is now carried through, and is still `null` for genuinely response-less failures (network, timeout, abort).
- **Memory (listener/timer leaks):** `pagination`'s `sleep()` and `xhrFetch` attached `{ once: true }` abort listeners that only self-removed when they _fired_, accumulating one dead listener (and its closures) per completed operation on a shared signal. Both now detach on settle. `denoTcpConnector` created a `Promise.race` timeout per read and never cleared it — one leaked timer per chunk on a streaming tunnel; the timers are now cleared in a `finally`.
- **Hang:** `nodeTcpConnector` did not latch socket EOF, so any read issued after the peer closed parked forever with nothing to reject it. EOF is now latched and reported as `null`.
- **Method casing:** `send(url, "patch")` passed validation but put the literal string `"patch"` on the wire, because the normalized method was computed and then discarded. fetch() only normalizes `delete/get/head/options/post/put`, so lowercase PATCH/CONNECT reached servers verbatim and drew `405`. The normalized method is now sent.
- **Digest auth:** `nc` was hard-coded to `00000001` for every request, so any server enforcing RFC 7616 replay protection rejected the second authenticated request with 401. The new `createDigestAuthorizer()` keeps a per-nonce counter (reset when the server issues a new nonce) and is what the client's 401-retry interceptor uses; the stateless `createDigestAuthorization` is unchanged for one-shot callers.
- **Retry with a non-replayable body:** retrying a `ReadableStream`/`Blob` body re-wrapped an already-consumed, locked stream and transmitted nothing. Retrying such a request now fails with a clear `EVALIDATION` error instead of silently sending an empty body.
- **Interceptor re-send loop:** a response interceptor that returned a modified request recursed through `_executeOnce` without any bound. Re-sends are now capped (`__interceptorResendDepth`, limit 5) and throw a descriptive error instead of looping forever.
- **OTel span leak:** the span was created before the dispatch `try`, so a throw between `startSpan()` and dispatch (e.g. auth fingerprinting when Web Crypto is unavailable) abandoned it — never exported, never reporting the error. The pre-dispatch section is now guarded and always ends the span.
- **SWR stuck key:** if `getCache()` rejected in the background revalidation's `finally`, the in-flight marker survived and that key could never revalidate again — every future hit served it stale forever. The cleanup can no longer be skipped.
- **Dedup stale timer:** a new dedup window for a key did not clear the previous entry's timeout, so the stale timer later deleted the _new_, still-in-flight entry out from under its waiters.
- **WebSocket double reconnect:** the send-error path both called `ws.close()` and scheduled a reconnect, and the `onclose` handler scheduled another, overwriting the handle without clearing it — a duplicate connection and double-counted attempts on every send failure. The pending timer is now cleared first, and the reconnect timer is no longer `unref()`'d (an awaited `open()`/`for await` consumer depends on it).
- **Cache housekeeping:** tag-index references were left behind for entries missing from storage, growing on every eviction; `304` is no longer in the default `cacheStatuses` (the client revalidates rather than storing one); control-character stripping in cache keys no longer recompiles a `RegExp` per call.
- **Cookies:** a `Domain=Example.COM` attribute was stored verbatim while every lookup compared against a lower-cased host, so the cookie was stored and never matched again — the attribute is now normalized. `domainMatch` tested the _request host_ for being a public suffix, which could never fire and reported `Domain=com` as matching every `.com` host; it now tests the cookie domain. The probabilistic 1%-per-access cookie sweep is gone (the periodic cleanup timer already covers it).
- **`getClientIP`:** now accepts `{ trustedHops }` and selects the entry written by the last trusted proxy instead of the client-supplied left-most value, and normalizes `for="…"` quoting, `[ipv6]:port` and `:port` suffixes. The trust caveat is documented on the API.
- **`destroy()`:** no longer calls `cache.clear()` — releasing a client must not purge data, and a user-supplied adapter (localStorage / Cloudflare KV / Redis) would have lost every persisted entry. Explicitly call `client.getCache().then(c => c.clear())` to empty it.
- **`BatchQueue`:** `maxBatch` must be a positive integer and `flushMs` a non-negative finite number (both now throw `RangeError`); `maxBatch: 0` previously spliced nothing and made `flush()` spin forever. `flush()` is additionally bounded.
- **`transformResponse`:** receives the real response object (status/headers/url) instead of the `{}` placeholder it was handed before.
- **`maxRequestSize`:** a circular or `BigInt`-containing body threw a raw `TypeError` from inside the size guard; it is now wrapped in a `KinetexError` naming the real cause.
- **Circuit breaker:** `execute()` no longer throws synchronously when the guarded function throws (it always returns a promise, so `.catch()` works); the half-open probe slot is released based on whether _this call_ acquired it, rather than on the state at settle time; `snapshot` no longer allocates an array per call.
- **WebSocket `worker` entry docs:** the module header claimed HTTP/2 was unavailable while the `kinetex()` example advertised it — the entry point always uses `FetchTransport` and defaults to HTTP/1.1, and now says so.

### Added

- `getClientIP(headers, { trustedHops })` — proxy-aware client-IP extraction.
- `createDigestAuthorizer()` — stateful Digest auth with a per-nonce request counter.
- `CREDENTIAL_HEADERS` (exported from `cache.ts`) — the single list of credential-bearing header names, re-exported for callers building their own cache/dedup keys.
- `maxRedirects` and `followRedirects` are now actually honoured. Both were documented on `KinetexConfig` and `SendOptions` and silently ignored; the manual redirect follower now enforces the per-request/client limit (`0` disables following and returns the 3xx as-is), and the documented default was corrected to the enforced one (20).
- `tests/regressions.test.mts` — 131 tests, one per finding, plus edge cases: the SSRF address matrix on redirect hops, cross-origin cookie matrices, `apikey`/custom-header handling with and without a cookie jar, unhandled-rejection and `SizeLimitError` assertions for the progress cancellation bug, per-identity dedup isolation and waiter abort, stream backpressure assertions, digest counter rollover and nonce rotation, SOCKS5 EOF-vs-hang timing, and redirect-limit behaviour.
- `NodeHTTP2Transport`'s `ca` option is now documented in the README (added in 1.2.0).

### Changed

- `scripts/release.ts` rewritten for the protected-`main` workflow: it now bumps versions, verifies, opens a `chore: release vX.Y.Z` pull request, and (with `--merge`) can wait for checks, squash-merge, tag the merge commit and push the tag that triggers npm/JSR/GitHub Release publishing. See CONTRIBUTING.md → Release Process.
- Manually followed redirect chains now report `redirected: true`, matching what fetch() reports under `redirect: "follow"`.
- `accept-encoding` is only stripped by `FetchTransport` when it exactly matches the value kinetex injects; a caller who deliberately set `gzip, deflate, br` (or any superset such as `+ zstd`) now keeps it.
- HAR timing uses `performance.getEntriesByName()` and requires a recent entry, instead of scanning every resource-timing entry per recorded request and potentially attributing another request's timings.
- The auth fingerprint is computed only when dedup is enabled, instead of hashing credential headers on every request.
- Interceptors are ordered by priority at registration (stable) rather than re-sorting three array copies on every request.
- Cookie-domain matching in the jar lower-cases both sides, so cookies inserted directly via `putCookie()` with mixed-case domains match.

## [1.2.0] - 2026-09-26

### Fixed

- **Security (SSRF):** `isSafeURL`'s IPv4 literal parser now implements full WHATWG shortcut-host semantics — the last dotted component absorbs the remainder of the address (`127.1` → `127.0.0.1`, `169.254.43253` → link-local/IMDS), and a single trailing dot (FQDN form, which URL parsers keep verbatim and fetch resolvers treat as the same host) is stripped before parsing. Together these close a bypass where trailing-dot shortcut hosts were previously treated as domain names and allowed through the private-range check. The dead conditional in the last-octet bounds check was removed.
- **Memory (listener leaks):** abort-signal listeners registered with `once: true` are now also removed when the operation settles — GraphQL execute/upload/batch, upload & download progress streams, XHR progress, the WebSocket external-signal close hook, and the timeout interceptor's merged-signal listener. Long-lived caller-provided signals no longer accumulate one closure per request (Node emits `MaxListenersExceededWarning` past 11).
- **HTTP/2 header validation:** the forbidden-control-character check in `NodeHTTP2Transport` is no longer gated behind strict mode — in non-strict mode (the default) an invalid header is now dropped with the `onDroppedHeader` callback / warning, matching `FetchTransport`, instead of the whole validation loop being skipped and the raw header crashing `session.request()` with `ERR_INVALID_HEADER_VALUE`. Strict mode still throws `EVALIDATION`.
- `NodeHTTP2Transport` (and `createTransport` session options) now accept a `ca` option so origins with self-signed or private-PKI certificates can be trusted without disabling TLS verification.

### Added

- Hardening test coverage: SSRF address-expansion matrix (IPv4-mapped/IPv4-compatible/NAT64/6to4 IPv6 forms, shortcut + trailing-dot IPv4 hosts), `randomBytes` CSPRNG contract, bearer/apikey header-injection guards (H3), `buildURL` manual-fallback safety check (M4), `maxRequestSize` body accounting for DataView/URLSearchParams/FormData/ReadableStream (H4), HAR recording + credential redaction, `CookieJar` `__Host-`/`__Secure-` retrieval-time defense (H5), and the GraphQL upload leaf-path pollution guard (H6).
- Additional hardening test coverage: client pre-flight guards (proxy fail-fast (M7), `httpsOnly` enforcement, unparseable-URL path exercising the manual-fallback safety check + `redactUserInfo` regex redaction, `maxRequestSize` accounting for ArrayBuffer/Blob/FormData bodies) and the timeout interceptor's merged external-signal lifecycle (abort propagation + listener cleanup on success/error).
- New local HTTP/2 test harness (`tests/h2-header-drop.test.mts`, Node-only): spins up a throwaway self-signed `http2.createSecureServer` (cert generated at test time into gitignored `tmp/`, skipped cleanly when openssl is unavailable) and covers the forbidden-header drop/callback/warn/strict paths plus per-request validation over the real HTTP/2 wire.
- Offline tests for the GraphQL external-signal lifecycle (query/upload/batch): assert the abort listener is added and removed on the caller's signal, that an external abort propagates and rejects, and that the no-CSPRNG `randomBytes` fallback throws — the httpbin-dependent graphql suite is skipped in CI, so these paths were previously unmeasured there.

### Changed

- Coverage scripts (`coverage`, `coverage:summary`) now write reports to `coverage/` instead of the repo root, so `lcov.info` lands where the CI codecov upload step looks for it (`./coverage/lcov.info`) — previously the upload silently found nothing.

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

[1.3.0]: https://github.com/kinetexjs/kinetex/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/kinetexjs/kinetex/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kinetexjs/kinetex/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kinetexjs/kinetex/compare/v0.0.3...v1.0.0
