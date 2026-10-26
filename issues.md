# Kinetex 1.5.0 — `axios` replacement audit

**Audited:** 2026-10-26
**Package:** `kinetex@1.5.0` (npm)
**Source:** `/root/kinetex`, branch `main`, commit `b4b7b73`
**Consumer:** `/root/Suhail-Md-3.0` — CommonJS Node.js bot currently using `axios@1.20.0`
**Runtime:** Linux, Node.js `v24.22.1`, npm 11.x
**Method:** published-tarball runtime probes (local HTTP/1.1, HTTP/2 and TLS servers), source inspection, and `axios` side-by-side comparisons.

This report records findings only. No Kinetex source is changed by it. Fixes are listed in the checklist at the end.

**Status legend**

- **Runtime-confirmed** — reproduced against `node_modules/kinetex` in this environment.
- **Code-inspected** — the defect is visible in the source; no stable runtime reproduction was attempted.
- **Verified good** — tested and passed, or an earlier suspicion was disproved.

---

## 1. Executive summary

Kinetex cannot replace `axios` in this bot yet. The blockers are not only packaging:

1. `require('kinetex')` crashes because `dist/cjs` contains ESM.
2. The bot calls `axios({ url, method, data, responseType, validateStatus, ... })`; Kinetex has no config-object request API and ignores `data`, `responseType`, `validateStatus`, `paramsSerializer`, `maxContentLength` and `maxBodyLength`.
3. The default HTTP/2-first transport does not fall back when a TLS origin rejects ALPN with `no application protocol`.
4. The HTTP/1.1 fallback silently drops `proxy`, `ca`, `allowPrivateNetwork` and `dispatcher`.
5. Request interceptors cannot short-circuit with a synthetic response, so the cache interceptor never serves a hit.
6. Cross-origin redirects leak interceptor-set credential headers that are not lowercase.
7. `timeout` does not cover the response body, and `destroy()` does not abort an in-flight body read.

The compiled browser and Deno artifacts are also broken independently of Node usage.

### Severity index

| ID    | Severity    | Area              | Finding                                                                                                                    | Evidence                                     |
| ----- | ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| KX-01 | **Blocker** | CJS packaging     | `require('kinetex')` throws `SyntaxError: Unexpected token 'export'`                                                       | Runtime-confirmed                            |
| KX-02 | **Blocker** | Browser/worker    | Browser bundles import `node:dns`, `node:net`, `node:http2`, `node:https`, `node:tls`                                      | Runtime-confirmed                            |
| KX-03 | **Blocker** | Deno              | `deno` export condition resolves to `./src/mod.ts`, but `src/` is absent from the published tarball                        | Runtime-confirmed                            |
| KX-04 | **Blocker** | CJS TypeScript    | CJS TS consumers get `TS1479`; no `.d.cts` under the `require` condition                                                   | Runtime-confirmed                            |
| KX-05 | **Blocker** | axios API         | Config-object `request({ url, method, data, ... })` is unsupported; `data` is ignored                                      | Runtime-confirmed                            |
| KX-06 | **Blocker** | axios API         | `responseType`, `validateStatus`, `paramsSerializer`, `maxContentLength`, `maxBodyLength` are absent/ignored               | Runtime-confirmed                            |
| KX-07 | **Blocker** | Transport         | ALPN rejection `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL` is not recognised, so no HTTP/1.1 fallback                    | Runtime-confirmed                            |
| KX-08 | **Blocker** | Transport         | `_sendHTTP1()` drops `proxy`, `ca`, `allowPrivateNetwork`, `dispatcher`                                                    | Runtime-confirmed                            |
| KX-09 | **High**    | Security          | Cross-origin redirect strips only lowercase credential header names                                                        | Runtime-confirmed                            |
| KX-10 | **High**    | Security          | URL userinfo is unsupported and leaked verbatim in `ENETWORK` errors                                                       | Runtime-confirmed                            |
| KX-11 | **High**    | Timeout           | `timeout` stops at response headers; a trickling response body hangs indefinitely                                          | Runtime-confirmed                            |
| KX-12 | **High**    | Lifecycle         | `destroy()` leaves an in-flight body read pending                                                                          | Runtime-confirmed                            |
| KX-13 | **High**    | Interceptors      | Request interceptors cannot return a synthetic response; cache hits are never served                                       | Runtime-confirmed                            |
| KX-14 | **High**    | Cache             | Cache interceptor key has no auth fingerprint or `Vary`, and ignores `Cache-Control: private`                              | Code-inspected (latent until KX-13 is fixed) |
| KX-15 | **High**    | S3                | `signS3PostPolicy()` uses `btoa`; non-Latin-1 throws, Latin-1 is encoded as Latin-1 not UTF-8                              | Runtime-confirmed                            |
| KX-16 | **High**    | S3                | Chunked signing signs an empty payload hash instead of `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`                                | Runtime-confirmed                            |
| KX-17 | **Medium**  | URL               | `baseURL` containing `?query` loses both the base path and the query                                                       | Runtime-confirmed                            |
| KX-18 | **Medium**  | Headers           | `Headers` instance sends no headers; array-of-pairs sends numeric keys                                                     | Runtime-confirmed                            |
| KX-19 | **Medium**  | Query             | Scalar `params` replace existing query values; arrays use repeat not bracket form; nested objects become `[object Object]` | Runtime-confirmed                            |
| KX-20 | **Medium**  | Response          | No-content-type and `application/octet-stream` bodies return `Uint8Array`; axios returns a string                          | Runtime-confirmed                            |
| KX-21 | **Medium**  | Redirect          | HEAD becomes GET on 301/302/303; POST→GET keeps `content-type`                                                             | Runtime-confirmed                            |
| KX-22 | **Medium**  | Cache             | `HTTPCache.set()` overwrite inflates `totalEntries`/`totalSizeBytes` and evicts live entries                               | Runtime-confirmed                            |
| KX-23 | **Medium**  | Hooks             | Around hooks dispatch twice, ignore short-circuit, and leak async rejection as unhandled                                   | Runtime-confirmed                            |
| KX-24 | **Medium**  | GraphQL           | `query()` accepts per-call headers but never puts them on the request                                                      | Runtime-confirmed                            |
| KX-25 | **Medium**  | WebSocket         | Configured WS headers are silently dropped on Node 22+ global `WebSocket`                                                  | Runtime-confirmed                            |
| KX-26 | **Medium**  | Logging           | `Redactor.redactURL()` does not strip URL userinfo                                                                         | Runtime-confirmed                            |
| KX-27 | **Low**     | Packaging         | `kinetex/package.json` is not exported                                                                                     | Runtime-confirmed                            |
| KX-28 | **Low**     | Packaging         | Tarball excludes `src/`, but ESM source maps point to `../../src`                                                          | Runtime-confirmed                            |
| KX-29 | **Low**     | Response          | `KinetexResponse.raw` is declared but never populated                                                                      | Runtime-confirmed                            |
| KX-30 | **Low**     | Circuit breaker   | `onOpen` fires once per failing half-open probe, not once per opening                                                      | Runtime-confirmed                            |
| KX-31 | **Low**     | Progress          | A download stream that errors is reported 100% done                                                                        | Runtime-confirmed                            |
| KX-32 | **Low**     | SSE               | A leading UTF-8 BOM makes the first SSE event disappear                                                                    | Runtime-confirmed                            |
| KX-33 | **Low**     | SSRF guard        | `isSafeURL` rejects any path containing `..`, including `foo..bar.txt`                                                     | Runtime-confirmed                            |
| KX-34 | **Low**     | `httpVersion`     | Only the exact string `"HTTP/1.1"` forces HTTP/1.1; `"http/1.1"`, `"1.1"`, `"HTTP/1.0"` silently use HTTP/2                | Runtime-confirmed                            |
| KX-35 | **Medium**  | Shutdown          | HTTP/2 sessions keep the Node event loop alive after the last response unless `destroy()` is called                        | Runtime-confirmed                            |
| KX-36 | **Low**     | Response metadata | `response.httpVersion` is inferred from `Alt-Svc` and can report HTTP/2 for an HTTP/1.1 response                           | Runtime-confirmed                            |

---

## 2. Packaging and distribution

### KX-01 — CommonJS entry points ship ESM syntax

```bash
cd /root/Suhail-Md-3.0
node -e "require('kinetex')"
```

```text
Warning: Failed to load the ES module: .../dist/cjs/mod.js.
dist/cjs/mod.js:23
export { Kinetex, FluentRequest, ... } from "./client.js";
^^^^^^
SyntaxError: Unexpected token 'export'
```

`dist/cjs/package.json` says `{"type":"commonjs"}`, but the files are ESM.

**Cause.** `tsconfig.cjs.json` uses `"module": "Node16"` while the root package is `"type": "module"`. TypeScript therefore classifies `src/*.ts` as ESM and emits ESM into `dist/cjs`. Writing `dist/cjs/package.json` afterwards does not change the emitted syntax.

**Fix.** Emit real CommonJS (`module: "CommonJS"`, or a dedicated CJS build via esbuild/rollup), then smoke-test the packed tarball with `require()` on Node 22 and 24. Add `publint` and `@arethetypeswrong/cli` to release checks.

### KX-02 — Browser and worker bundles import Node built-ins

```bash
grep -oE "node:(dns|net|http2|https|tls)" \
  node_modules/kinetex/dist/browser/kinetex.esm.js | sort -u
# node:dns
# node:http2
# node:https
# node:net
# node:tls
```

`scripts/build.ts` passes every `node:*` module as `--external`, so the browser bundle contains runtime imports of modules no browser can resolve. Importing the bundle in a browser or worker fails before the first request.

**Fix.** Split Node-only transports (`NodeHTTP2Transport`, pinned DNS lookup, SOCKS proxy) behind a runtime adapter, or build a browser entry that excludes them. Test the bundle in a headless browser/worker, not only with `node --check`.

### KX-03 — Deno export target is not published

`package.json` exports:

```json
"deno": "./src/mod.ts"
```

but `files` is `["dist", "README.md", "LICENSE"]` and the packed tarball contains **0** `src/` files. Deno therefore resolves to a path that does not exist in the published package.

**Fix.** Point `deno` at a published ESM build (or ship `src/`), and add a Deno import smoke test against the packed tarball.

### KX-04 — CJS TypeScript consumers get `TS1479`

A `.ts` file compiled as CommonJS:

```ts
import { kinetex } from "kinetex";
```

```text
error TS1479: The current file is a CommonJS module whose imports will produce
'require' calls; however, the referenced file is an ECMAScript module and cannot
be imported with 'require'.
```

The `require` condition has no `types` condition, so TypeScript resolves the ESM declarations. A CJS consumer needs a `.d.cts` tree (or a `require.types` condition) that matches the CJS implementation.

**Fix.** Emit `.d.cts` (or a CJS declaration tree) and expose it from the `require` condition. Smoke-test with a CommonJS `tsconfig` using `module: "Node16"` and `moduleResolution: "Node16"`.

### KX-05 / KX-06 — The axios config-object API is missing

The bot uses the axios call shape in `lib/scraper.js`, `lib/serialized.js`, `lib/suhail.js` and `lib/koyeb.js`:

```js
const response = await axios({
  url: "https://telegra.ph/upload",
  method: "POST",
  headers: form.getHeaders(),
  data: form,
});

const response = await axios({
  method,
  url,
  timeout: 30000,
  headers: { DNT: 1 },
  ...options,
  responseType: "arraybuffer",
});

await axios.get(url, { validateStatus: () => true });
```

Kinetex has `client.request(method, url)` — a fluent builder — not `request(config)`. Passing an axios config object produced a request with an empty body and no error; `data` was ignored.

Runtime probe:

```js
const c = kinetex({ allowPrivateNetwork: true, httpVersion: "HTTP/1.1" });
await c.request({
  url: "http://127.0.0.1:PORT/upload",
  method: "POST",
  data: "axios-style",
  headers: { "content-type": "text/plain" },
});
// server received "" — not "axios-style"
```

Also absent or ignored:

| axios option                  | Kinetex today                              | Consequence                                             |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `data`                        | not read; only `body` is read              | uploads and POST bodies disappear                       |
| `responseType: "arraybuffer"` | no equivalent                              | binary callers receive `Uint8Array` or a decoded string |
| `validateStatus: () => true`  | no equivalent                              | `throwOnError` defaults to `true`, so 403/404/429 throw |
| `paramsSerializer`            | no equivalent                              | custom query encodings cannot be expressed              |
| `maxContentLength`            | `maxResponseSize` (different name/default) | axios callers silently keep Kinetex's limit             |
| `maxBodyLength`               | `maxRequestSize` (different name/default)  | large uploads may be rejected                           |
| `transformResponse`           | `parseResponse` (different contract)       | existing transforms do not apply                        |
| `decompress`                  | always decompresses via fetch              | no opt-out                                              |
| `httpsAgent` / `httpAgent`    | `dispatcher` / `proxy`                     | Node agent configuration is lost                        |

`SendOptions` has no `responseType`, `validateStatus`, `paramsSerializer`, `transformResponse`, or `decompress` at all. This is the single largest blocker for a production swap in this codebase, independent of the CJS build.

**Fix options.** Either add an axios-compatible adapter surface (`request(config)`, `data`, `responseType`, `validateStatus`, `paramsSerializer`, size aliases), or keep an adapter layer in the bot that translates every call site. The audit recommendation is to add the adapter in Kinetex because the bot has many call sites and third-party packages also pass axios-style configs.

### KX-27 — `kinetex/package.json` is not exported

```bash
node -e "require('kinetex/package.json')"
# Error [ERR_PACKAGE_PATH_NOT_EXPORTED]
```

Add `"./package.json": "./package.json"` to `exports`.

### KX-28 — Source maps point at unpublished sources

The tarball contains 143 files: 54 `dist/types/*`, 0 `src/*`, and 0 CJS source maps. `dist/esm/*.js.map` references `"../../src/*.ts"`, which is not in the package, so debuggers cannot resolve original sources.

**Fix.** Include `src/` in the tarball, or emit maps with `sourcesContent` and no external source paths. Decide whether CJS should also ship maps.

---

## 3. Transport and security

### KX-07 — ALPN fallback predicate misses the real TLS error

`NodeHTTP2Transport.send()`:

```ts
try {
  return await this._sendHTTP2(req, url);
} catch (err) {
  if (isHTTP2FallbackError(err)) return this._sendHTTP1(req);
  throw err;
}
```

```ts
function isHTTP2FallbackError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("alpn") ||
    msg.includes("h2") ||
    msg.includes("http2") ||
    (err as NodeJS.ErrnoException).code === "ERR_HTTP2_ERROR"
  );
}
```

An HTTP/1.1-only TLS origin rejects the HTTP/2 ALPN offer with Node error code `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL`. The message contains neither `alpn` nor `h2`, and the code is not `ERR_HTTP2_ERROR`, so the request fails instead of falling back.

Reproduction with a local TLS server offering only `http/1.1`:

```js
import https from "node:https";
import fs from "node:fs";
import { kinetex } from "kinetex";

const key = fs.readFileSync("/tmp/opencode/kinetex-tls/key.pem");
const cert = fs.readFileSync("/tmp/opencode/kinetex-tls/cert.pem");
const s = https.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (req, res) =>
  res.end("tls-ok"),
);
await new Promise((r) => s.listen(0, "127.0.0.1", r));

const c = kinetex({ ca: cert, allowPrivateNetwork: true, retry: false });
await c.get(`https://localhost:${s.address().port}/`);
// ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL
```

The same origin succeeds when HTTP/1.1 is forced, but only if certificate verification is disabled (see KX-08):

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node ...
# 200 HTTP/1.1
```

**Fix.** Match `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL`, `ERR_SSL_*`, `ERR_HTTP2_*`, and the TLS alert text `no application protocol`; add a local TLS fixture to CI. Fall back only for replayable requests, and cache the per-origin downgrade to avoid paying a failed TLS handshake on every request.

### KX-08 — HTTP/1.1 fallback drops transport configuration

```ts
private _sendHTTP1(req: KinetexRequest): Promise<RawResponse> {
  if (typeof globalThis.fetch === "function") {
    if (!this._http1Fallback) {
      const opts: FetchTransportOptions = {
        fetchFn: globalThis.fetch,
        strict: this._strict,
        requestTimeoutMs: this._requestTimeoutMs,
      };
      // proxy, ca, allowPrivateNetwork, dispatcher are never copied
      this._http1Fallback = new FetchTransport(opts);
    }
    return this._http1Fallback.send(req);
  }
  ...
}
```

Confirmed consequences:

- Default client, `http://localhost` (hostname, not IP literal), `allowPrivateNetwork: true` → `EBLOCKEDHOST: resolved only to blocked addresses`. Forced `httpVersion: "HTTP/1.1"` → 200.
- Forced HTTP/1.1 to a self-signed TLS fixture with a valid `ca` → `ENETWORK: fetch failed`; the `ca` never reaches `FetchTransport`.
- Proxy configuration is dropped on every HTTP/1.1 request/fallback, so traffic silently goes direct.

**Fix.** Forward `proxy`, `ca`, `allowPrivateNetwork`, `dispatcher`, `connectTimeoutMs` and `onDroppedHeader` into the fallback transport. Add tests for a private hostname, a custom CA, and a proxy on both the forced and ALPN-fallback paths.

### KX-09 — Cross-origin redirect strips only lowercase credential names

`CROSS_ORIGIN_STRIP_HEADERS` contains lowercase names, and the redirect loop does:

```ts
for (const h of CROSS_ORIGIN_STRIP_HEADERS) delete nextHeaders[h];
```

Headers set by an interceptor in canonical case (`Authorization`, `Cookie`, `X-Api-Key`, `Proxy-Authorization`) survive and are sent to the new origin. Runtime-confirmed for `Cookie`, `X-Api-Key`, and `Proxy-Authorization`; the same path applies to `Authorization`.

```js
c.useRequest((ctx) => {
  ctx.request.headers["X-Api-Key"] = "SECRET";
});
await c.get("http://origin-a/redirect-to-origin-b");
// origin B received SECRET
```

**Fix.** Delete headers case-insensitively, and normalise header names before the strip. Add a cross-origin test matrix for lowercase, canonical, and mixed case.

### KX-10 — URL userinfo is unsupported and leaked in errors

```js
await c.get("http://user:supersecret@127.0.0.1:PORT/");
// ENETWORK: Request cannot be constructed from a URL that includes credentials:
//   http://user:supersecret@127.0.0.1:PORT/
```

Kinetex does not translate userinfo into Basic auth. Worse, the transport error embeds the full credential URL. `buildURL` already has a `redactUserInfo()` helper, but transport errors do not pass through it.

**Fix.** Either support `https://user:pass@host` as Basic auth (axios behaviour), or reject it with a redacted message. Sanitise every error path, including `cause` chains and HAR/log output.

### KX-11 — `timeout` does not cover the response body

`sendWithTimeout()` clears its timer when `transport.send()` resolves — which happens when headers arrive, before the body is read. The body is then read at `client.ts:3434` with only the caller's signal:

```ts
const rawBody = await readRawBody(bodyStream, maxSize, raw.url, req.signal);
```

A server that sends one byte and then stalls keeps the request pending past `timeout: 500` (confirmed > 2500 ms). Axios applies its timeout to the whole request.

**Fix.** Carry the total-request deadline into body reading (a deadline, not a per-read timer), and race `reader.read()` against it. Add a trickle-server regression test.

### KX-12 — `destroy()` does not abort an in-flight body read

`destroy()` destroys transport sessions and drains the concurrency queue, but it does not abort the request/body reader held by `readRawBody`. A request blocked on a stalled body remains pending after `await client.destroy()`.

**Fix.** Track active body readers/controllers per client, abort them in `destroy()`, and test `destroy()` against a server that sends headers then stalls.

### KX-13 — Request interceptors cannot short-circuit with a response

The documented contract says a request interceptor may return `InterceptorResponse` to skip the fetch (`interceptors.ts` §"A request interceptor may"). The dispatcher only accepts a replacement request:

```ts
const result = await fn(ctx);
if (result && "url" in result && !("status" in result)) {
  req = result as KinetexRequest;
} else if (ctx.request !== req) {
  req = ctx.request;
}
```

A synthetic response has `status` and no `url`, so it is discarded. Runtime probe: an interceptor returning a 200/`"synthetic"` body still hit the network; the caller got the network body.

**Fix.** Detect an interceptor response (`status` + `headers` + `body`), populate `ctx.response`, and return it through the normal response pipeline. This also unblocks the cache interceptor and dedupe waiters.

### KX-14 — Cache interceptor cannot serve hits; key is not auth- or Vary-aware

`createCacheInterceptor()` stores responses but its request interceptor returns `{...entry.response, request}`, which KX-13 discards. Runtime probe: two GETs → two network hits, `cached: false`.

While fixing KX-13, address the latent security defects in the same interceptor:

- Key is `"${req.method}:${req.url}"` — no `Authorization`/Cookie/API-key fingerprint.
- No `Vary` handling.
- `parseTtl()` handles `no-store` and `no-cache` but not `Cache-Control: private`.

Today the cache never serves, so no cross-user leak is observable. Once short-circuit works, two users hitting the same URL with different credentials can share a private response.

**Fix.** Reuse `getAuthFingerprint()` and the `HTTPCache` Vary logic, honour `private`, and add cross-auth tests before enabling short-circuit.

### KX-22 — `HTTPCache.set()` overwrite corrupts capacity gauges

```ts
await this._ensureCapacity(entry.size);
const stored = await this.storage.set(key, entry);
if (stored === false) return false;
this.lru.touch(key);
this.stats.totalEntries++;
this.stats.totalSizeBytes += entry.size;
```

Overwriting an existing key increments the gauges without subtracting the old entry. Runtime probe with `maxEntries: 2`:

```text
totalEntries=2, storageKeys=1
A present after B insert: false
stats={"evictions":4,"totalEntries":2,...}
```

Repeated overwrites made the cache believe it was full and evicted a live entry.

**Fix.** Read the previous entry before `_ensureCapacity`; subtract its size and do not increment `totalEntries` for an existing key. Recompute gauges on hydrate; add an overwrite test that asserts `totalEntries === storage.keys().length`.

### KX-29 — `response.raw` is declared but never set

`KinetexResponse.raw?: unknown` is documented as "the underlying runtime response, when one exists", but `_buildResponse()` never assigns it. Runtime probe: `typeof response.raw === "undefined"` for a normal network response.

**Fix.** Populate `raw` from `RawResponse.raw` (or remove the field and document `rawBody`). If populated, ensure it is not serialised into logs/HAR accidentally.

### KX-30 — Circuit breaker re-fires `onOpen`

With `failureThreshold: 1`, two concurrent half-open probes failing caused `onOpen` to fire **3** times for **2** openings (initial + half-open failure). Each probe that fails in `HALF_OPEN` calls the state transition independently.

**Fix.** Guard the `HALF_OPEN → OPEN` transition so only the first failing probe fires `onOpen`; subsequent failures update counters without re-emitting.

### KX-31 — Download progress reports errored streams as complete

`withDownloadProgress()` marks `done: true` and `percent: 100` when the stream errors. Runtime probe with a stream that enqueues `abc`, then calls `controller.error()`:

```text
done=true percent=100 loaded=0
```

**Fix.** On stream error/abort, set an `errored`/`aborted` state, do not complete, and surface the error through the tracker.

### KX-33 — `isSafeURL` rejects benign double dots

```ts
if (parsed.hostname.includes("..") || parsed.pathname.includes("..")) return false;
```

`new URL()` already normalises dot segments (`a/../b` → `/b`), so this check only rejects legitimate names such as `/foo..bar.txt`, `/..hidden`, or `https://foo..bar/`. It also does not prevent the traversal it appears to target.

**Fix.** Drop the pathname substring check, or resolve the path and reject only remaining `..` segments. Do not reject `..` inside a filename.

### KX-34 — `httpVersion` values are case-sensitive and silently ignored

`HTTPVersion` is typed as `"HTTP/1.0" | "HTTP/1.1" | "HTTP/2"`, but JS callers can pass anything. The transport checks only:

```ts
if (url.protocol !== "https:" || req.httpVersion === "HTTP/1.1") {
  return this._sendHTTP1(req);
}
```

Runtime probe against an HTTP/2-capable TLS origin:

| Value passed | Negotiated                                      |
| ------------ | ----------------------------------------------- |
| `"HTTP/1.1"` | failed on `ca` loss (KX-08), otherwise HTTP/1.1 |
| `"http/1.1"` | HTTP/2                                          |
| `"1.1"`      | HTTP/2                                          |
| `"HTTP/1.0"` | HTTP/2                                          |
| `"HTTP/2"`   | HTTP/2                                          |

**Fix.** Normalise accepted spellings, and throw `EVALIDATION` for unknown values rather than silently using HTTP/2. Decide whether `HTTP/1.0` should be supported or rejected.

### KX-35 — HTTP/2 sessions keep the Node event loop alive

A single successful HTTP/2 request leaves Node running until `client.destroy()` is called:

```text
$ timeout 20 node probe-event-loop.mjs
got 200 HTTP/2
STILL ALIVE after 5s (no destroy)   # forced process.exit(7)
```

Control runs:

| Path                                               | Process exit after response          |
| -------------------------------------------------- | ------------------------------------ |
| Kinetex HTTP/2, no `destroy()`                     | still alive at 5 s, then forced exit |
| Kinetex HTTP/2, `await client.destroy()`           | ~3 ms                                |
| Kinetex HTTP/1.1 to a local server, no `destroy()` | ~2 ms                                |
| axios HTTP/1.1                                     | ~1 ms                                |

`NodeHTTP2Transport` keeps its `ClientHttp2Session` objects in a pool. The ping timer is `unref()`'d, but the sessions themselves are not, so they hold the event loop open. The README documents `destroy()` under **Resource Cleanup**, but not that omitting it prevents a one-shot script from exiting.

This is exactly what happened to `verify-http.js`: all 59 result records were written, but the process stayed alive past the 600 s command timeout. The result file was complete; only the process shutdown was blocked.

**Fix.** Unref idle sessions when they have no active streams (`session.unref()`), add an idle-session reaper, or close sessions from a `beforeExit` hook. Document the requirement next to `kinetex()`, and add a test that a script performing one HTTP/2 request exits without calling `destroy()`.

### KX-36 — `response.httpVersion` is inferred from `Alt-Svc`

A plain HTTP/1.1 server that advertises `h2`/`h3` in `Alt-Svc` is reported as HTTP/2:

```js
// server: http.createServer, res.writeHead(200, {
//   "alt-svc": 'h3=":443"; ma=86400, h2=":443"; ma=86400'
// })
const r = await kinetex({ httpVersion: "HTTP/1.1" }).get(url);
// server saw HTTP/1.1; r.httpVersion === "HTTP/2"
```

```text
{"serverSaw":"HTTP/1.1","clientReported":"HTTP/2"}
```

`detectHTTPVersion()` returns `"HTTP/2"` when `Alt-Svc` contains `h2` or `h3`, even though `Alt-Svc` advertises a capability, not the protocol used for this response. The README describes the field as a best-effort heuristic; it is still presented as `httpVersion` on every response and will mislead routing, logging, and benchmarks.

**Fix.** Report the actual transport protocol where the transport knows it; on the fetch-only path return `"HTTP/1.1"` (the only protocol Node's `fetch` negotiates today) or expose an explicit `httpVersionHint`/`serverSupportsH2` field. Do not infer the protocol from `Alt-Svc`. Add a test where a plain HTTP/1.1 server advertises h2.

---

## 4. HTTP / axios semantics

### KX-17 — `baseURL` with a query loses path and query

```js
const c = kinetex({ baseURL: "http://host/v1?key=abc" });
await c.get("users"); // GET /users
```

Expected sane result: `/v1/users?key=abc`. Actual: `/users` — both `/v1` and `?key=abc` are lost. Cause: `new URL(p, bClean + "/")` where `bClean` still contains the query; the relative resolution replaces the path and search.

For reference, axios itself produces the also-wrong `/v1?key=abc/users` in this case, so this needs a defined target behaviour, not blind parity. The minimum requirement is not to drop the base path.

**Fix.** Parse the base, join pathnames explicitly, then merge base query params with request params. Add tests for baseURL with path, trailing slash, query, fragment, and absolute URLs.

### KX-18 — `Headers` and array-of-pairs inputs are corrupted

`SendOptions.headers` is Kinetex's `Record<string, string | string[]>`, but callers can still pass standard `HeadersInit` values at runtime:

```js
const h = new Headers({ "x-from-headers": "yes" });
await c.get(url, { headers: h });
// server received {}
```

```js
await c.get(url, {
  headers: [
    ["x-pair", "one"],
    ["x-array", "two"],
  ],
});
// server received "0": "x-pair, one", "1": "x-array, two"
```

**Fix.** Accept `Headers`, `[string, string][]`, and plain objects in `normalizeHeaders`, or reject unknown shapes with `EVALIDATION`. Never stringify a `Headers` instance to `{}` or an array to numeric keys.

### KX-19 — Query parameter semantics differ from axios

Runtime results:

| Input                                 | Kinetex                    | axios                    |
| ------------------------------------- | -------------------------- | ------------------------ |
| URL `?x=old`, params `{x:"new"}`      | `/q?x=new`                 | `/q?x=old&x=new`         |
| params `{a:["1","2"]}`                | `/q?a=1&a=2`               | `/q?a%5B%5D=1&a%5B%5D=2` |
| params `{a:{b:"c"}}`                  | `/q?a=%5Bobject+Object%5D` | `/q?a%5Bb%5D=c`          |
| params `{a:"1", b:undefined, c:null}` | `/q?a=1`                   | `/q?a=1`                 |

`QueryValue` excludes objects, so the nested-object case is out of contract for TypeScript callers; runtime should reject it instead of emitting `[object Object]`. The array and existing-query differences are real axios-compatibility gaps.

**Fix.** Add an `arrayFormat` option (default `"bracket"` for axios compatibility, repeat available), append scalars when the URL already carries the key (or make this configurable), and reject non-scalar objects.

### KX-20 — Binary responses are `Uint8Array` instead of string

`parseBody()` returns a `Uint8Array` when the content type is missing or `application/octet-stream`:

```text
GET /none  (no content-type)          → Uint8Array
GET /octet (application/octet-stream) → Uint8Array
GET /html  (text/html)                → string
GET /json  (application/json)         → object
```

Axios returns a string for these bodies by default. The bot's `getBuffer()` expects `responseType: "arraybuffer"` and returns `response.data` directly, so a swap changes the return type at many call sites.

**Fix.** Either default unknown/octet-stream to text when `responseType` is absent (axios parity), or implement `responseType` so callers can ask for `text`, `arraybuffer`, `blob`, `stream`, and `json` explicitly. Preserve `rawBody` for binary access either way.

### KX-21 — Redirect method and entity-header handling

Runtime-confirmed:

- `HEAD /head` receiving `302` is followed as **GET**.
- `POST /` receiving `303` becomes GET with an empty body (correct), but retains `content-type: text/plain` on the GET. Axios drops it.
- `303`/`307` method changes otherwise work; `307` preserves method and body.

Per RFC 9110, a 303 response to HEAD should remain HEAD, and a redirect that changes to GET should drop entity headers (`content-type`, `content-length`, `content-encoding`, etc.).

**Fix.** Preserve HEAD across 301/302/303; when switching to GET, delete entity headers. Add a redirect matrix covering GET/HEAD/POST × 301/302/303/307/308.

### KX-32 — SSE parser drops a leading BOM

```js
parseSSEText("\uFEFFdata: bom\n\n"); // []
```

The first field name becomes `"\uFEFFdata"`, so the event is discarded. Both `SSEParser.feed()` and `parseSSEText()` are affected. The SSE client's reconnection and `Last-Event-ID` handling otherwise passed.

**Fix.** Strip a single leading U+FEFF on the first chunk/line before field parsing.

### KX-26 — Logging redaction leaves URL userinfo

```js
new Redactor().redactURL("https://user:hunter2@example.com/x");
// "https://user:hunter2@example.com/x"
```

Query parameters, default auth headers, and nested/array body fields redact correctly. The userinfo leak remains and can be written to console, JSON, remote, or HAR transports.

**Fix.** Clear `username`/`password` in `redactURL()` (absolute URLs) and strip `//user:pass@` in the relative fallback. Add a regression test covering all log transports.

### KX-25 — WebSocket headers are silently dropped on Node 22+

`WSClient` only applies headers when the runtime's WebSocket exposes `setHeader`:

```ts
const wsExt = ws as { setHeader?: (key: string, value: string) => void };
if (typeof wsExt.setHeader === "function") {
  for (const [k, v] of Object.entries(this._headers)) wsExt.setHeader(k, v);
}
```

Node 22+'s global `WebSocket` has no `setHeader`, so `headers` (often used for `Authorization`) are silently omitted. Runtime check:

```js
typeof WebSocket.prototype.setHeader; // "undefined"
```

**Fix.** Use a WebSocket implementation that supports headers (e.g. `undici`'s `WebSocket` with a dispatcher, or `ws`), pass headers via the handshake, or throw/warn when headers are configured in a runtime that cannot send them.

### KX-23 — Around hooks double-dispatch and leak async rejection

`HookRegistry.wrapWithAround()`:

```ts
let failed = false;
const result = this._safeRunSync(hook, () => {
  failed = true;
  return hook.fn(ctx, next);
});
if (failed) return next();
return result!;
```

`failed` is set before the hook runs, so **every** around hook causes a second dispatch. A hook that returns a synthetic response without calling `next()` is also overridden by the second dispatch. Runtime-confirmed:

```text
around hook dispatch count: calls=2, hook returned 201/hooked, caller got 200/inner
around hook short-circuit:  dispatch=1, hook returned 202/short, caller got 200/inner2
```

Async hooks are passed to `_safeRunSync`, so a rejected promise with `safe:false` is not propagated; it becomes an unhandled rejection (confirmed: process-level `unhandledRejection` with `hook boom`).

**Fix.** Mark `failed` only in the catch path, await async hooks, return the hook's response when it short-circuits, and propagate `safe:false` rejections.

### KX-24 — GraphQL per-call headers are dropped

`query()` declares `options.headers`, but builds the request without them:

```ts
const req: GraphQLRequest<V> = {
  query,
  ...(variables !== undefined ? { variables } : {}),
  ...(options.operationName !== undefined ? { operationName: options.operationName } : {}),
  ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
};
```

`executeHTTP()` already honours `req.headers`. Runtime probe with a fake fetch saw only `content-type` and `accept`; `x-per-call: yes` never arrived. `mutate()` also omits `headers` from its options type.

**Fix.** Copy `options.headers` into the request, add `headers` to `mutate()`'s options, and test query/mutate/upload/batch.

### KX-15 — S3 POST policy uses `btoa`

```ts
const policyStr = JSON.stringify(policy);
const policyBase64 = btoa(policyStr);
```

`btoa` only accepts Latin-1. Non-Latin-1 (e.g. `café/😀`) throws `InvalidCharacterError`; Latin-1 characters are encoded as Latin-1 bytes, not UTF-8, so the signature/policy differ from AWS's expected UTF-8 base64.

Runtime:

```text
btoa error: InvalidCharacterError Invalid character
decoded got: ... "caf�/ ...   // mojibake for café
```

**Fix.** Encode with `TextEncoder` → base64 (`Buffer.from(str, "utf8").toString("base64")` on Node, a cross-runtime helper elsewhere). Add both non-ASCII and Latin-1 vectors.

### KX-16 — Chunked signing uses the empty-body hash

`initChunkedSigning()` sets `x-amz-content-sha256: STREAMING-AWS4-HMAC-SHA256-PAYLOAD` but signs a request whose body was replaced with `null`:

```ts
const seedRequest: SignableRequest = { ...request, body: null };
```

The resulting canonical request ends with:

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

AWS expects the literal `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` as the canonical payload hash for the seed request. The seed signature is therefore wrong, and every chunk signature derived from it is wrong.

**Fix.** Let `signRequest()` accept an explicit payload-hash override, or pass a sentinel body; use `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` in the canonical request. Add the AWS chunked-upload example as a test vector.

---

## 5. Verified good / corrected earlier findings

These were tested again and **do not** reproduce as bugs. Keep them as regression coverage, not open issues.

| Area                                                                 | Result                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP/1.1-only TLS fallback after manually forcing HTTP/1.1           | Works; only the automatic predicate (KX-07) and config forwarding (KX-08) are broken                                                                   |
| `allowPrivateNetwork` on the forced HTTP/1.1 / `FetchTransport` path | Works, including `localhost`                                                                                                                           |
| `allowPrivateNetwork` with IP literals on the default path           | Works (IP literals bypass DNS screening)                                                                                                               |
| `HTTPCache` and `Cache-Control: private`                             | `set()` returns `false`; not stored. The separate cache interceptor still ignores `private` (KX-14)                                                    |
| Cache interceptor cross-auth leak today                              | Not observable because hits are never served (KX-13); latent security bug after the fix                                                                |
| Digest auth RFC 2617 vector (`Mufasa` / `Circle Of Life`)            | `6629fae49393a05397450978507c4ef1` — correct                                                                                                           |
| SigV4 AWS IAM `ListUsers` GET vector                                 | Signature `5d672d79...` — correct                                                                                                                      |
| `sigV4UriEncode("/a b/c~d", false)` encoding slashes                 | By design: the function encodes one path segment; `normalizePath()` splits on `/` and preserves slashes                                                |
| CookieJar `SameSite` / `Secure` / `fromJSON`                         | `Lax` blocked cross-site, `Strict` blocked in lax context, `SameSite=None` without `Secure` rejected, lowercase persisted values normalised            |
| `DedupMap` auth separation and trace headers                         | Different `Authorization` values not coalesced; `X-Trace-Id` ignored                                                                                   |
| SSE client reconnect                                                 | Two events received across reconnect; second request carried `Last-Event-ID: 1`; `retry:` honoured                                                     |
| Pagination                                                           | Page (`?page=1&per_page=2`), offset (`0,3` + 6 items), and cursor (`null,c2` + `a,b`) all correct                                                      |
| Retry / `Retry-After`                                                | `Retry-After: 0` retried immediately (35 ms), past HTTP-date retried immediately (18 ms), `onRetry` saw status 429 and delay 0                         |
| Redirects                                                            | 303 POST→GET with body dropped; 307 preserves POST body; `maxRedirects: 0` returns 302; `followRedirects: false` returns 302                           |
| Error handling                                                       | 404 throws `EHTTPSTATUS` with `.response`; `throwOnError: false` returns the response; invalid JSON falls back to text; empty JSON/text returns `null` |
| Logging query/header/body redaction                                  | Query credentials, default auth headers, nested and array body fields redact correctly                                                                 |
| Download progress on abort                                           | Aborted read rejects with `AbortError` instead of hanging                                                                                              |
| `ProgressTracker` percent/rate/ETA                                   | Correct for a normal update                                                                                                                            |
| `SSEParser` CRLF and multiline data                                  | Correct                                                                                                                                                |
| `httpVersion` exact `"HTTP/1.1"`                                     | Forced HTTP/1.1 correctly when no custom CA was needed                                                                                                 |

**Corrections to earlier audit notes**

- “Cache interceptor leaks responses across credentials” — currently latent, not exploitable until KX-13 is fixed. Recorded as a prerequisite for that fix.
- “`allowPrivateNetwork` is dropped on all HTTP/1.1 paths” — false for IP literals and for the forced HTTP/1.1 `FetchTransport` path; true specifically for hostname resolution through the default HTTP/2 transport's `_sendHTTP1()` (KX-08).
- “`HTTPCache` ignores `Cache-Control: private`” — false; `set()` correctly refuses. The bug is in the separate interceptor (KX-14).
- “Digest / SigV4 / CookieJar / Dedup are broken” — no; the standard vectors pass.
- “`sigV4UriEncode` drops slashes” — no; it encodes a single segment and is composed by `normalizePath()`.

---

## 6. `axios` compatibility matrix for this bot

Actual axios usage found in application code (not `node_modules`):

| Call site           | Usage                                                                                       | Kinetex status                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `lib/scraper.js`    | `axios({ url, method, headers, data: form })`                                               | Blocked: config object + `data` (KX-05)                               |
| `lib/scraper.js`    | `timeout`, `maxContentLength: Infinity`, `maxBodyLength: Infinity`                          | Options ignored/renamed (KX-06)                                       |
| `lib/serialized.js` | `axios({ ..., responseType: "arraybuffer" })`                                               | Unsupported (KX-06); binary returns `Uint8Array` (KX-20)              |
| `lib/suhail.js`     | `axios.get(url, { responseType: "arraybuffer", timeout, maxContentLength, maxBodyLength })` | Unsupported (KX-06)                                                   |
| `lib/websearch.js`  | `{ timeout, validateStatus: () => true }`                                                   | `validateStatus` ignored; non-2xx throws (KX-06)                      |
| `lib/koyeb.js`      | `axios.get/patch/post(url, config)` with bearer headers                                     | GET/POST/PATCH exist; error shape differs                             |
| `lib/smd.js`        | `axios.get/head`                                                                            | Exists                                                                |
| `lib/scraper.js`    | `axios("https://downloadgram.org/", { ... })`                                               | Blocked: callable axios instance (KX-05)                              |
| FormData uploads    | `form-data` stream in `data`                                                                | Blocked (KX-05); Kinetex supports `FormData`/`body`, not axios `data` |
| Error handling      | `err.response.data`, `err.response.status`                                                  | Present on `EHTTPSTATUS`; cancel/axios error classes differ           |

### Minimum adapter needed for a first swap

1. `kinetex.request(config)` accepting `{ url, method, headers, data, params, timeout, responseType, validateStatus, maxContentLength, maxBodyLength, signal }`.
2. `responseType: "arraybuffer"` returning the same binary type the bot expects (`Buffer` would require an alias, `Uint8Array` is acceptable if call sites are updated).
3. `validateStatus` predicate; default `status >= 200 && status < 300`.
4. `data` accepted as body, including `form-data` streams and `FormData`.
5. Size aliases mapped to `maxRequestSize`/`maxResponseSize`, with `Infinity` meaning unlimited.
6. `axios.isAxiosError`-style predicate or documented replacement, if any bot code starts using it.
7. `baseURL` path/query joining, header normalisation, and query serialisation fixed (KX-17/18/19).

Until items 1–5 exist, a production replacement requires editing every call site and every third-party dependency that passes axios-style configs.

---

## 7. Test harness results

The bot's harnesses live in `/tmp/opencode` and are not committed to the bot. Every harness that performs HTTP now preloads a test-only adapter that keeps the axios call signature but sends through Kinetex. Production code still imports axios; nothing below is a production swap.

| Harness                    | Result                 | Notes                                                             |
| -------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `test-telegram-token.js`   | 4/4                    | Token config, URL building, and redaction; no live Telegram call  |
| `test-ai-handlers.js`      | 10/10                  | Commands and auto-reply path with mocked workers                  |
| `test-gtech-ai.js`         | 6/6 live               | llama, mistral, DALL·E, Stable, Flux; real image buffers returned |
| `test-ai-live-handlers.js` | 6/6 live               | `.chat`, `.gpt`, `.fgpt`, `.dalle`, `.imagine`, `.imagine2`       |
| `test-search-commands.js`  | 17/17                  | Search, lyrics, cricket, Google Images, and input guards          |
| `test-fixes.js`            | 5/5                    | Live QR, TinyURL, and MediaFire; remove.bg mocked                 |
| `verify-libs.js`           | 19 checks, 16 returned | See details below                                                 |
| `verify-http.js`           | 14/59 records          | Network-inconclusive; process hang is KX-35                       |

### `verify-libs.js` details

Nineteen library calls completed without the harness itself crashing; 16 records returned a result, 3 rejected:

- `TelegraPh(sample.jpg)` — 30 s timeout.
- `mediafire(scraper sample)` — upstream `404`.
- `wikimedia('cat')` — `ECONNRESET` (the same endpoint also failed for axios in the same-moment comparison).

The four upload helpers returned HTTP 400 (`No input file(s)` / `Empty upload source`). That is the test adapter's form-data gap, not evidence about the upstream: the adapter passes the axios `data` value through as a Kinetex body, and does not encode `form-data` streams with their headers (KX-05). The outer `ok:true` only means the call returned; many inner payload checks are `ok:false` (for example Pinterest returned zero images, and `async-g-i-s` returned zero results).

Working live calls in the same run included Aptoide search/download, `google-tts-api`, `websearch`, ringtone search, style text, and the Jina Telegram/Telegraph proxy checks.

### `verify-http.js` details

The Kinetex run produced all 59 records, but only 14 passed and the process did not exit (KX-35). The run is **not** a Kinetex compatibility baseline: it happened during a network slowdown where axios was also taking 8–18 s for endpoints that normally answer in under 2 s.

A same-moment targeted comparison (`/tmp/opencode/triage-http.json`) tells a different story:

| Endpoint                                                  | axios         | Kinetex                                     |
| --------------------------------------------------------- | ------------- | ------------------------------------------- |
| GitHub user, npms.io, OMDb, JokeAPI, official joke, FavQs | 200           | 200                                         |
| Urban Dictionary                                          | 200           | 200                                         |
| DuckDuckGo HTML                                           | 200           | timeout once; 200 twice on immediate retest |
| Google Translate                                          | 429           | 200                                         |
| Wikimedia Commons                                         | network error | network error                               |

Eight of ten endpoints agreed. The DuckDuckGo timeout did not reproduce (two HTTP/2 attempts returned the 30,770-byte page in ~9 s), and the Wikimedia failure affected both clients. Dead upstreams in the 59-endpoint run included `waifu.pics` (DNS), Tenor (403, API discontinued), `bot.lyo.su` (502), and both plugin-list URLs (404).

The evidence for the findings above comes from the targeted probes, not from the aggregate `14/59` count.

---

## 8. Benchmark appendix — axios vs Kinetex

Clean run: 10 endpoints × 3 rounds, same headers, raw-body downloads, identical parsing, one warm-up round per client. Run from `/root/Suhail-Md-3.0`; raw results in `/tmp/opencode/benchmark-http-clients.json`.

Kinetex required a retry wrapper over HTTP/1.1 because of KX-07. Both clients eventually reached 30/30.

### Overall

| Client  | Requests |      Success |       Mean |     Median |     p95 | HTTP versions            |
| ------- | -------: | -----------: | ---------: | ---------: | ------: | ------------------------ |
| axios   |       30 | 30/30 (100%) |    1297 ms |    1120 ms | 2226 ms | HTTP/1.1                 |
| kinetex |       30 | 30/30 (100%) | **954 ms** | **684 ms** | 3007 ms | HTTP/2 (9), HTTP/1.1 (1) |

Kinetex was ~26% faster on mean and ~39% faster on median in this run, but had a worse p95 because of the OpenWeather fallback and Bing Images.

### Per endpoint (median)

| Endpoint             |       axios |     Kinetex | Kinetex transport          |
| -------------------- | ----------: | ----------: | -------------------------- |
| GitHub user          |      443 ms |  **115 ms** | HTTP/2                     |
| OMDb movie           |      862 ms |  **370 ms** | HTTP/2                     |
| OpenWeather          | **1110 ms** |     1964 ms | HTTP/1.1 (manual fallback) |
| npms.io search       |     1133 ms |  **624 ms** | HTTP/2                     |
| lyrics.ovh suggest   |     1215 ms |  **749 ms** | HTTP/2                     |
| lyrics.ovh lyrics    |      216 ms |  **214 ms** | HTTP/2                     |
| Bing web search      |      845 ms |  **472 ms** | HTTP/2                     |
| Bing images          | **1388 ms** |     1693 ms | HTTP/2                     |
| Cricbuzz live scores |     1374 ms |  **691 ms** | HTTP/2                     |
| Coffee image         |     2226 ms | **1443 ms** | HTTP/2                     |

Caveats: single machine and network; DNS variance; image endpoints return random payloads of different sizes (total downloaded bytes were 8.7 MB for axios vs 6.2 MB for Kinetex); not a rigorous benchmark. The performance result does not offset the blockers above.

---

## 9. Fix checklist (prioritised)

### P0 — make it installable/usable

- [ ] Emit real CommonJS into `dist/cjs`; add packed-tarball `require('kinetex')` smoke tests on Node 22/24.
- [ ] Add `.d.cts` (or a `require.types` condition) and a CJS TypeScript consumer test.
- [ ] Build a browser entry without `node:*` imports; test in a browser/worker.
- [ ] Publish the Deno target (ESM build or `src/`); test with `deno check`.
- [ ] Export `./package.json`.
- [ ] Include source maps' sources or add `sourcesContent`.

### P0 — axios compatibility required by this bot

- [ ] Add `client.request(config)` with `url`, `method`, `headers`, `data`, `params`, `timeout`, `signal`.
- [ ] Map `data` to the body, including `FormData` and `form-data` streams.
- [ ] Implement `responseType` (`json`, `text`, `arraybuffer`, `blob`, `stream`).
- [ ] Implement `validateStatus`; keep axios's 2xx default.
- [ ] Implement `paramsSerializer`, `maxContentLength`, `maxBodyLength` aliases; accept `Infinity`.
- [ ] Fix `baseURL` path/query joining.
- [ ] Accept `Headers`/`[string, string][]` and normalise header names.
- [ ] Align query serialisation (`bracket` arrays, append existing keys, reject objects).
- [ ] Return strings for no-content-type/octet-stream by default, or honor `responseType`.

### P0 — transport/security

- [ ] Recognise `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL` (and related TLS/ALPN codes); add a local TLS fixture.
- [ ] Cache per-origin HTTP/1.1 downgrades; fall back only for replayable requests.
- [ ] Forward `proxy`, `ca`, `allowPrivateNetwork`, `dispatcher`, connect timeout, and header callbacks into `_sendHTTP1()`.
- [ ] Enforce the total request deadline through body reading.
- [ ] Abort active body readers in `destroy()`.
- [ ] Strip credential headers case-insensitively across origins (and on scheme/host/port changes as appropriate).
- [ ] Redact URL userinfo in every error/log path; support or reject userinfo explicitly.
- [ ] Normalise `httpVersion`; reject unknown values.

### P1 — correctness/security

- [ ] Implement request-interceptor short-circuiting; return synthetic responses through the response pipeline.
- [ ] Fix cache interceptor auth fingerprint, `Vary`, `private`, and cache-hit serving (in that order).
- [ ] Fix `HTTPCache` overwrite accounting and capacity eviction.
- [ ] Fix around-hook dispatch/short-circuit/async rejection.
- [ ] Fix GraphQL per-call headers (query + mutate).
- [ ] Fix S3 POST UTF-8 base64 and chunked seed payload hash.
- [ ] Fix WebSocket header support or fail loudly when headers cannot be sent.
- [ ] Fix redirect HEAD preservation and entity-header stripping.
- [ ] Fix `response.raw` population.
- [ ] Fix circuit-breaker `onOpen` re-fire.
- [ ] Fix download-progress error state.
- [ ] Fix SSE BOM handling.
- [ ] Fix `isSafeURL` double-dot path rejection.
- [ ] Fix `Redactor.redactURL()` userinfo.
- [ ] Unref idle HTTP/2 sessions or add an idle-session reaper so a one-shot process exits without `destroy()`.
- [ ] Stop inferring `response.httpVersion` from `Alt-Svc`; report the transport protocol or an explicit hint.

### P2 — release hardening

- [ ] Add `publint` and `@arethetypeswrong/cli` to CI.
- [ ] Add cross-runtime import tests (Node CJS/ESM, browser, worker, Deno, Bun).
- [ ] Add regression tests for every runtime-confirmed item above, including a one-shot process-exit test and an `Alt-Svc` protocol-reporting test.
- [x] Re-run the Suhail-Md harnesses through the test-only adapter; results are in §7.
- [ ] Re-run the same harnesses against the fixed production surface (no adapter) before recommending a swap.
- [ ] Update README: CJS/ESM/browser/Deno support, fallback behaviour, timeout scope, redirect credential policy, the `response.httpVersion` heuristic, and the `destroy()` shutdown requirement.
- [ ] Bump the release and publish a packed-tarball smoke test result with the PR.

---

## 10. Reproduction assets

The probes used for this audit live outside the package:

- `/tmp/opencode/probe-semantics.log`
- `/tmp/opencode/probe-advanced.log`
- `/tmp/opencode/probe-modules.log`
- `/tmp/opencode/probe-axios-compat.log`
- `/tmp/opencode/probe-alt-svc.log` (KX-36)
- `/tmp/opencode/probe-event-loop.log` (KX-35)
- `/tmp/opencode/benchmark-http-clients.json`
- `/tmp/opencode/triage-http.json` (same-moment axios/Kinetex comparison)
- `/tmp/opencode/verify-http.kinetex.log` and `/tmp/opencode/api-http-results.json`
- `/tmp/opencode/verify-libs.kinetex.log` and `/tmp/opencode/api-lib-results.json`
- `/tmp/opencode/test-{ai-handlers,ai-live-handlers,gtech-ai,telegram-token,search-commands,fixes}.kinetex.log`
- `/tmp/opencode/kinetex-helper.js` and `/tmp/opencode/kinetex-axios-adapter.js` (test-only ESM loader and axios-shaped adapter)
- `/tmp/opencode/kinetex-tls/{cert.pem,key.pem}` (self-signed `localhost` fixture)

They are temporary and not part of the Kinetex repository. The exact commands/inputs are embedded in the findings above so each defect can be re-probed after a fix.
