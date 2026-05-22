/**
 * **kinetex** — Feature-rich, universal TypeScript HTTP client.
 *
 * Works in Node.js, Deno, Bun, browsers, Cloudflare Workers, Vercel Edge,
 * and all WinterCG runtimes from a single zero-dependency codebase.
 *
 * @example
 * ```ts
 * // Node.js / Bun / Deno
 * import { kinetex } from "kinetex";
 * import { kinetex } from "jsr:@kinetexjs/kinetex";
 *
 * const api = kinetex({ baseURL: "https://api.example.com/v1" });
 *
 * // Fluent chain
 * const users = await api.GET("/users").bearer("token").json<User[]>();
 *
 * // Standard send
 * const post = await api.post<Post>("/posts", JSON.stringify(body));
 * ```
 */

// ── Core client ───────────────────────────────────────────────────────────────
export { Kinetex, FluentRequest, createMethodCircuitBreakerKey, BatchQueue } from "./client.ts";

// ── Factory ───────────────────────────────────────────────────────────────────

import type { KinetexConfig } from "./types.ts";
import { Kinetex } from "./client.ts";

/**
 * Create a new `Kinetex` HTTP client instance.
 *
 * This is the primary entry point. Suitable for all runtimes including
 * Cloudflare Workers, Vercel Edge, Deno Deploy, and browsers — no lazy
 * loading or globalThis side effects.
 *
 * @param config - Global client configuration.
 * @returns A configured Kinetex client instance.
 */
export function kinetex(config: KinetexConfig = {}): Kinetex {
  return new Kinetex(config);
}

// aws-sigv4.ts exports
export {
  chainCredentials,
  imdsCredentials,
  sigV4UriEncode,
  detectClockSkew,
  isClockSkewError,
  createS3Signer,
  createAPIGatewaySigner,
  createSTSSigner,
  createDynamoDBSigner,
  signS3PostPolicy,
  initChunkedSigning,
  signChunk,
  signFinalChunk,
} from "./aws-sigv4.ts";

// cache.ts exports
export { createSessionStorageCache } from "./cache.ts";

// cookie-parser.ts exports
export {
  parseCookieDate,
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  decodeIDNLabel,
  canonicalizeDomainFull,
  isIPAddress,
  domainMatch,
  defaultPath,
  pathMatch,
  parseSetCookieHeader,
  splitSetCookieHeaders,
  extractSetCookieHeaders,
} from "./cookie-parser.ts";

// core.ts exports
export {
  HAS_NATIVE_FETCH,
  createTransport,
  parseBody,
  sendWithTimeout,
  readRawBody,
  decompressBodyStream,
} from "./core.ts";

// digest.ts exports
export {
  parseDigestChallenge,
  computeDigestResponse,
  formatDigestAuth,
  createDigestAuthorization,
} from "./digest.ts";
export type { DigestChallenge } from "./digest.ts";

// graphql.ts exports
export {
  clearAPQCache,
  getAPQMetrics,
  authLink,
  errorLink,
  loggingLink,
  retryLink,
} from "./graphql.ts";

// headers.ts exports
export {
  HeaderName,
  formatContentType,
  parseContentDisposition,
  formatContentDisposition,
  parseWWWAuthenticate,
  formatBearer,
  formatBasic,
  parseAccept,
  parseAcceptEncoding,
  parseAcceptLanguage,
  negotiateContentType,
  parseRange,
  parseContentRange,
  formatLinkHeader,
  parseForwarded,
  normalizeForwardedHeaders,
  getClientIP,
  parseRetryAfter,
  parseHSTS,
  formatHSTS,
  parseCSP,
  formatCSP,
  parseServerTiming,
  formatServerTiming,
  parseAltSvc,
  parseContentLanguage,
  parseWarning,
  parseParams,
  fromNodeHeaders,
  toNodeHeaders,
  fromWebHeaders,
  securityHeaders,
  corsHeaders,
  RichHeaders,
  createHeaders,
  createRequestHeaders,
  createResponseHeaders,
  createImmutableHeaders,
} from "./headers.ts";

// interceptors.ts exports
export {
  createRetryInterceptor,
  createAuthInterceptor,
  createTimeoutInterceptor,
  createLoggingInterceptor,
  createCacheInterceptor,
  createDedupeInterceptor,
  createRateLimitInterceptor,
  RateLimitError,
  createHARInterceptor,
  createMetricsInterceptor,
  createInterceptorSuite,
  computeBodySize,
} from "./interceptors.ts";

// lifecycle.ts exports
export {
  RedirectTracker,
  TooManyRedirectsError,
  tap,
  injectHeaders,
  withBaseURL,
  throwOnHTTPError,
  validateResponse,
  HTTPError,
  ResponseValidationError,
  composeBeforeRequest,
  composeBeforeResponse,
  composeAround,
  createLoggingHooks,
  createTimingHook,
  createBodyNormalizationHook,
  createAbortHook,
  createHookContext,
} from "./lifecycle.ts";

// logging.ts exports
export {
  LogLevel,
  BatchingTransport,
  RemoteTransport,
  MultiTransport,
  toOTelSpan,
} from "./logging.ts";

// pagination.ts exports
export {
  createTokenPaginator,
  createKeysetPaginator,
  serializePaginationState,
  deserializePaginationState,
  toPaginationIterator,
} from "./pagination.ts";

// progress.ts exports
export {
  withBlobUploadProgress,
  MultiPartProgressAggregator,
  xhrFetch,
  formatProgress,
  throttleProgress,
} from "./progress.ts";

// response.ts exports
export {
  HTTPResponseError,
  ResponseSizeLimitError,
  ContentTypeError,
  ResponseDecodeError,
  // normalizeHeaders deprecated - use utils.ts directly
  normalizeResponse,
  isBinary,
  decompressStream,
  applyDecompression,
  extractServerTiming,
  createLimitedReader,
} from "./response.ts";

// socks5.ts exports
export { denoTcpConnector, nodeTcpConnector, socks5Connector } from "./socks5.ts";

// sse.ts exports
export { SSEServerResponse, SSEError, SSEMaxReconnectsError, createSSEResponse } from "./sse.ts";

// types.ts exports
export {
  AbortError,
  NetworkError,
  ValidationError,
  AuthError,
  ProxyError,
  RedirectError,
  validateErrorCode,
  toRequestId,
} from "./types.ts";

// ws.ts value exports
export { WSConnectTimeoutError, WSRateLimitError } from "./ws.ts";
export { WSClient, WSError, WSMaxReconnectsError, connectWS } from "./ws.ts";

export default kinetex;

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  Brand,
  KinetexConfig,
  SendOptions,
  RetryConfig,
  RetryContext,
  AuthConfig,
  ProxyConfig,
  CacheRequestConfig,
  HTTPMethod,
  HTTPVersion,
  HeadersInit,
  QueryParams,
  QueryValue,
  BodyInit,
  Runtime,
  KinetexRequest,
  KinetexResponse,
  InterceptorContext,
  HookContext,
  LifecycleHooks,
  RequestInterceptor,
  ResponseInterceptor,
  ErrorInterceptor,
  ProgressEvent,
  ProgressCallback,
  HAREntry,
  HARLog,
  PipelineStep,
  PipelineStageName,
  RequestId,
} from "./types.ts";

// ── Errors ────────────────────────────────────────────────────────────────────
export { KinetexError, HTTPStatusError, TimeoutError, SizeLimitError } from "./types.ts";

// ── Runtime ───────────────────────────────────────────────────────────────────
export {
  detectRuntime,
  RUNTIME,
  IS_NODE,
  NodeHTTP2Transport,
  FetchTransport,
  setRuntime,
  getEffectiveRuntime,
} from "./core.ts";
export type { FetchTransportOptions } from "./core.ts";

// ── Sub-modules (tree-shakeable) ──────────────────────────────────────────────

export {
  HTTPCache,
  MemoryStorageAdapter,
  WebStorageAdapter,
  CloudflareKVAdapter,
  TwoTierStorageAdapter,
  createMemoryCache,
  createLocalStorageCache,
  createKVCache,
  createTwoTierCache,
  getAuthFingerprint,
} from "./cache.ts";
export type { CacheEntry, CacheStats, CacheConfig, CacheStorageAdapter } from "./cache.ts";

export { CookieJar, createCookieJar, loadCookieJar } from "./cookiejar.ts";
export type { Cookie, CookieJSON } from "./cookiejar.ts";

export {
  SSEClient,
  SSEParser,
  SSETransformStream,
  SSERouter,
  createSSEStream,
  createJSONSSEStream,
  parseSSEText,
  jsonSSE,
} from "./sse.ts";
export type { SSEEvent, SSEClientConfig, JSONSSEEvent } from "./sse.ts";

export {
  GraphQLClient,
  GraphQLClientError,
  createGraphQLClient,
  gql,
  detectOperationType,
  extractOperationName,
} from "./graphql.ts";
export type {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLError,
  GraphQLClientConfig,
  GraphQLLink,
  GraphQLLinkNext,
} from "./graphql.ts";

export {
  paginate,
  collectAll,
  collectPages,
  createOffsetPaginator,
  createPagePaginator,
  createCursorPaginator,
  createRelayPaginator,
  createLinkHeaderPaginator,
  mergePaginators,
  paginateItems,
  takeItems,
  parseLinkHeaderNext,
} from "./pagination.ts";
export type { Page, PaginationState } from "./pagination.ts";

export {
  ProgressTracker,
  withUploadProgress,
  withDownloadProgress,
  streamWithProgress,
  formatBytes,
  formatRate,
  formatETA,
  collectStream,
} from "./progress.ts";

export {
  HTTPLogger,
  ConsoleTransport,
  JSONTransport,
  Redactor,
  createLogger,
  createProductionLogger,
  createDevelopmentLogger,
} from "./logging.ts";
export type { LogEntry, LogTransport, LoggerConfig } from "./logging.ts";

export {
  readJSON,
  readText,
  readBytes,
  readStream,
  assertOk,
  parseContentType,
  isJSON,
  isText,
  decodeBody,
  readBlob,
  readNDJSON,
  readJSONStream,
  assertOkJSON,
  diffResponses,
  parseMultipartResponse,
  readFormData,
  readBodyWithLimit,
} from "./response.ts";
export type { ResponseParseOptions, SizeLimitConfig } from "./response.ts";

export {
  HttpHeaders,
  parseCacheControl,
  parseAuthorization,
  parseLinkHeader,
  formatCacheControl,
} from "./headers.ts";

export {
  URLBuilder,
  percentEncode,
  percentDecode,
  stringifyQuery,
  parseQuery,
  joinPath,
  expandTemplate,
  compilePattern,
  normalizeURL,
  getOrigin,
  isSameOrigin,
  isSameSite,
  isAbsolute,
  isRelative,
  isHTTPS,
  isHTTP,
  isDataURL,
  isBlobURL,
  isLocalhost,
  safeParseURL,
  withTrailingSlash,
  withoutTrailingSlash,
  stripHash,
  stripQuery,
  urlExtension,
  urlFilename,
  redactURL,
  encodePathComponent,
  encodeQueryValue,
  mergeQuery,
  pickQuery,
  omitQuery,
  normalizePath,
  pathSegments,
  fillPathParams,
  resolveURL,
  relativeURL,
  parseDataURL,
  buildDataURL,
  diffURLs,
} from "./url.ts";

export {
  SigV4Signer,
  signRequest,
  presignRequest,
  deriveSigningKey,
  staticCredentials,
  envCredentials,
  cachingCredentials,
  formatAmzDate,
  formatDateStamp,
} from "./aws-sigv4.ts";
export type { AWSCredentials, SigningConfig, CredentialProvider } from "./aws-sigv4.ts";

export { createSocks5Tunnel, parseSocks5Url, Socks5Error } from "./socks5.ts";
export type { Socks5ProxyConfig, Socks5Tunnel, Socks5Target, TcpConnector } from "./socks5.ts";

export { InterceptorManager } from "./interceptors.ts";

export { HookRegistry, HookEmitter } from "./lifecycle.ts";
export type {
  HookRequest,
  HookResponse,
  HookError,
  HookOptions,
  BeforeRequestHook,
  AfterRequestHook,
  BeforeResponseHook,
  AfterResponseHook,
  OnErrorHook,
  OnRetryHook,
  OnRedirectHook,
  OnUploadProgressHook,
  OnDownloadProgressHook,
  AroundHook,
} from "./lifecycle.ts";

export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
} from "./circuit-breaker.ts";
export type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerState,
  FailureFilter,
} from "./circuit-breaker.ts";

export { DedupMap, createDedupMap } from "./dedup.ts";
export type { DedupOptions } from "./dedup.ts";

export type {
  WSState,
  WSMessage,
  WSClientConfig,
  WSCloseEvent,
  WSBackpressureInfo,
  WSSubscribedRoom,
} from "./ws.ts";

export type { OTelTracer, OTelSpan } from "./client.ts";

// ── Utilities ────────────────────────────────────────────────────────────────
export {
  safeJSONParse,
  tryParseJSON,
  parseUntrustedJSON,
  isUint8Array,
  isArrayBuffer,
  isReadableStream,
  isHeaders,
  isAbortSignal,
  isPlainObject,
  isFormData,
  isBlob,
  isURLSearchParams,
  isValidHeaderName,
  isValidHeaderValue,
  isSafeURL,
  sanitizeURL,
  createStructuredError,
  formatError,
  perfNow,
  sleep,
  concatUint8Arrays,
  toUint8Array,
  uint8ArrayToBase64,
  deepClone,
  normalizeHeaders,
  mergeSignals,
  isAbortError,
  getRuntime,
  isNodeEnvironment,
  isBrowserEnvironment,
  hasNativeFetch,
} from "./utils.ts";
export type { SafeJSONParseOptions, SafeJSONParseResult, ErrorContext } from "./utils.ts";
