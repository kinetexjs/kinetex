/**
 * Fixture factories for test files.
 *
 * `tests/` is type-checked (`tsconfig.tests.json`), which surfaced a large
 * class of error that had never been visible before: test code constructing
 * `InterceptorRequest`, `InterceptorContext` and `HookRequest` literals by hand.
 * Each of those types carries a dozen fields, so every literal had to spell out
 * all of them, and whenever a field was added to the real interface every
 * hand-written literal became a compile error — which is where the 94 "missing
 * property" and 28 "incompatible literal" errors came from.
 *
 * That is the wrong shape for a fixture. A test almost never cares about
 * `startedAt`, `store` or `attempt`; it cares about `request.url`. Spelling out
 * the rest is noise that also rots. These factories take a partial and fill the
 * remainder with inert defaults, so a fixture states what it means and adding a
 * field to a real interface does not break every test that touches it.
 *
 * The defaults are deliberately inert, not clever: `store` is empty, `attempt`
 * is 1, `body` is null. A test that needs a field to be meaningful sets it
 * explicitly — a fixture must never assert something by accident.
 */

import type {
  InterceptorContext,
  InterceptorRequest,
  InterceptorResponse,
} from "../src/interceptors.ts";
import type { KinetexResponse } from "../src/types.ts";
import type { HookRequest, HookResponse } from "../src/lifecycle.ts";

export function makeInterceptorRequest(over: Partial<InterceptorRequest> = {}): InterceptorRequest {
  return {
    url: "https://example.test/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    ...over,
  };
}

export function makeInterceptorResponse(
  over: Partial<InterceptorResponse> = {},
): InterceptorResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    body: null,
    raw: null,
    request: makeInterceptorRequest(),
    ...over,
  } as InterceptorResponse;
}

/**
 * The interceptor manager speaks `InterceptorResponse` (`body` + `raw`), while
 * the client and its config surface speak `KinetexResponse` (`data` +
 * `rawBody`). Both are public, so a test that drives the manager needs an
 * explicit conversion rather than a cast that silently accepts the wrong shape.
 */
export function fromKinetexResponse(response: KinetexResponse<unknown>): InterceptorResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.rawBody,
    raw: null,
    request: makeInterceptorRequest({
      url: response.url,
      method: response.request?.method ?? "GET",
      headers: response.request?.headers ?? {},
    }),
  };
}

export function makeInterceptorContext(over: Partial<InterceptorContext> = {}): InterceptorContext {
  return {
    request: makeInterceptorRequest(),
    response: null,
    error: null,
    startedAt: 0,
    attempt: 1,
    aborted: false,
    store: new Map<symbol, unknown>(),
    ...over,
  };
}

export function makeHookRequest(over: Partial<HookRequest> = {}): HookRequest {
  return {
    url: "https://example.test/",
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    ...over,
  };
}

export function makeHookResponse(over: Partial<HookResponse> = {}): HookResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    body: null,
    request: makeHookRequest(),
    ...over,
  };
}

/**
 * Read a response body as a concrete type.
 *
 * `client.get()` defaults its generic to `unknown`, so every `r.data.foo` in a
 * test is a type error until the response is parameterised. The alternative —
 * typing each call site with `get<{ uuid: string }>("/uuid")` — pushes a
 * response-shape declaration into the assertion it supports, which is the wrong
 * way round: when the assertion and the declared type disagree, the compiler
 * checks nothing. Narrowing once, at the point of use, keeps the assertion and
 * the shape in the same expression, so a typo in either is still caught.
 */
export function data<T>(response: { data: unknown }): T {
  return response.data as T;
}

/**
 * Adapt a real `KinetexResponse` into the `InterceptorResponse` the interceptor
 * pipeline speaks.
 *
 * These are genuinely two different shapes, not two names for one thing.
 * `InterceptorResponse` is the pipeline's own view — `body` plus a `raw`
 * escape hatch and a back-reference to the request — while a real response
 * carries `data`, `rawBody`, `url` and timings instead. `InterceptorManager`
 * never actually returns one in the client (the client runs its own loop), so
 * a test that feeds a genuine response through `execute()` has to translate.
 *
 * Widening the public `InterceptorResponse` to accept both would let it stop
 * describing what the pipeline returns, so the conversion lives here where it
 * is only used.
 */
export function asInterceptorResponse(
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    url: string;
  },
  request: InterceptorRequest,
): InterceptorResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: null,
    raw: null,
    request,
  };
}
