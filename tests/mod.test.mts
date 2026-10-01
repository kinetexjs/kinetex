import { kinetex } from "../src/mod.ts";
import type { HTTPStatusError } from "../src/types.ts";
import nodeAssert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt, after } from "node:test";
import { createDriftGuard } from "./upstream.ts";

/**
 * A hung test must fail rather than stall the runner: node:test's default
 * budget is infinite, and this is the suite that talks to httpbin.org for
 * almost every case, so a socket that never answers parks the whole file with
 * no output at all. 45 s is far above any real request here.
 */
const TEST_BUDGET_MS = 45_000;

/**
 * The `assert` every test in this file uses, plus the two counters that decide
 * this process's exit code.
 *
 * The exit code is counted here rather than read from node:test. This file used
 * to close with `process.exit(process.exitCode ?? 0)`, on the theory that
 * node:test had already recorded the run's verdict in `process.exitCode`. It
 * has not, and does not: when a test file is executed directly rather than
 * through `node --test`, that property is never assigned — measured at 1.5 s
 * and again at 4 s after the run, it was still `undefined`. The forced exit is
 * genuinely needed (this suite leaks keep-alive sockets and would otherwise hang
 * forever), so it evaluated to `process.exit(0)` and the process reported
 * **success after any number of failures**. Every assertion here was printed to
 * the terminal and enforced against nothing: CI, a `&&` chain, and a mutation
 * harness all saw green.
 *
 * Two counters, because two different things can go wrong. `failures` is a real
 * defect in this client and must exit non-zero. `drift` is httpbin misbehaving
 * — roughly seventy assertions in this file read a status straight off a live
 * response, and a 429/502/503/504 from its front end says nothing about the
 * transport under test. Drift does not fail the run, because the client did
 * nothing wrong, but it is not silent either: every excused assertion is named
 * in a report under its own heading, so "the suite was inconclusive here" can
 * never be mistaken for "the suite passed".
 *
 * The count is taken at the assertion rather than at the test boundary because
 * neither `it()` nor `describe()` hands back the object it built, and there is
 * no in-process failure event short of restructuring the file onto a `run()`
 * helper. A test that fails by throwing something that is not an assertion — a
 * stray `TypeError` — is not counted, which is the one gap this leaves; the
 * terminal output still shows it.
 *
 * The guard's own discrimination is pinned by `tests/upstream-drift.test.mts`;
 * this file only wires it up.
 */
const { assert, report: driftReport } = createDriftGuard<typeof nodeAssert>(nodeAssert);

function it(name: string, fn: () => unknown): void {
  nodeIt(name, { timeout: TEST_BUDGET_MS }, fn as () => void | Promise<void>);
}

const describe = nodeDescribe;

// ============================================================================
// mod.ts EXPORTS TESTS
// Testing all major exports from the kinetex module
// ============================================================================

describe("mod - Core Exports", () => {
  it("kinetex factory creates Kinetex instance", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/get", { throwOnError: false });

    console.log("kinetex factory - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          httpVersion: res.httpVersion,
          durationMs: res.durationMs,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("kinetex with default config", async () => {
    const client = kinetex();
    const res = await client.get("https://httpbin.org/get", { throwOnError: false });

    console.log("kinetex default config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });
});

describe("mod - HTTP Methods", () => {
  it("GET request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/get");

    console.log("GET /get - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("POST request with JSON body", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.post("/post", { test: "value", number: 42 });

    console.log("POST /post - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.json.test, "value");
    client.destroy();
  });

  it("PUT request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.put("/put", { data: "test" });

    console.log("PUT /put - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("PATCH request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.patch("/patch", { patch: true });

    console.log("PATCH /patch - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("DELETE request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.delete("/delete", { throwOnError: false });

    console.log("DELETE /delete - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("HEAD request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.head("/get");

    console.log("HEAD /get - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          headers: res.headers,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("OPTIONS request", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.options("/get", { throwOnError: false });

    console.log("OPTIONS /get - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          headers: res.headers,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });
});

describe("mod - Fluent Request Builder", () => {
  it("GET with fluent chain", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const data = await client
      .GET("/get")
      .header("X-Custom", "header")
      .param("key", "value")
      .timeout(30000)
      .noThrow()
      .json();

    console.log("Fluent GET - actual response:");
    console.log(JSON.stringify(data, null, 2));

    assert.notEqual(data, null);
    client.destroy();
  });

  it("POST with fluent JSON body", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const data = await client
      .POST("/post")
      .withJSON({ fluent: true, method: "json" })
      .bearer("test-token")
      .json();

    console.log("Fluent POST withJSON - actual response:");
    console.log(JSON.stringify(data, null, 2));

    assert.strictEqual(data.json?.fluent, true);
    client.destroy();
  });

  it("Fluent withBody", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client
      .POST("/post")
      .withBody("raw body content")
      .header("Content-Type", "text/plain")
      .send();

    console.log("Fluent withBody - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.data, "raw body content");
    client.destroy();
  });

  it("Fluent basic auth", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const data = await client.GET("/basic-auth/user/pass").basic("user", "pass").noThrow().json();

    console.log("Fluent basic auth - actual response:");
    console.log(JSON.stringify(data, null, 2));

    assert.strictEqual(data.authenticated, true);
    assert.strictEqual(data.user, "user");
    client.destroy();
  });

  it("Fluent apiKey", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const data = await client.GET("/headers").apiKey("X-API-Key", "my-key").noThrow().json();

    console.log("Fluent apiKey - actual response:");
    console.log(JSON.stringify(data, null, 2));

    assert.strictEqual(data.headers["X-Api-Key"], "my-key");
    client.destroy();
  });

  it("Fluent retry", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.GET("/get").retry(2).noThrow().send();

    console.log("Fluent retry - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          attempt: res.attempt,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.attempt, 1);
    client.destroy();
  });

  it("Fluent text() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const text = await client.GET("/encoding/utf8").noThrow().text();

    console.log("Fluent text() - actual response:");
    console.log("Response length:", text.length);

    assert.equal(typeof text, "string");
    // httpbin's UTF-8 demo is an HTML document with multi-byte characters
    assert.equal(text.startsWith("<h1>Unicode Demo</h1>"), true);
    assert.equal(text.includes("UTF-8 encoded sample plain-text file"), true);
    assert.equal(
      text.includes("Markus Kuhn [ˈmaʳkʊs kuːn]"),
      true,
      "multi-byte characters must survive decoding",
    );
    client.destroy();
  });

  it("Fluent params() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const data = await client
      .GET("/get")
      .params({ page: "1", limit: "10", filter: "active" })
      .noThrow()
      .json();

    console.log("Fluent params() - actual response:");
    console.log(JSON.stringify(data, null, 2));

    assert.deepEqual(data.args, { page: "1", limit: "10", filter: "active" });
    client.destroy();
  });

  it("Fluent meta() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.GET("/get").meta({ requestId: "123", userId: 456 }).send();

    console.log("Fluent meta() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          requestMeta: res.request.meta,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.deepEqual(res.request.meta, { requestId: "123", userId: 456 });
    client.destroy();
  });

  it("Fluent noAuth() method", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: { type: "bearer", token: "should-be-ignored" },
    });
    const res = await client.GET("/headers").noAuth().send();

    console.log("Fluent noAuth() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.ok(!res.data.headers["Authorization"]);
    client.destroy();
  });

  it("Fluent noRetry() method", async () => {
    // The endpoint succeeds, so `noRetry()` and a retrying client produce the
    // same single request. It is now measured against an endpoint that fails,
    // where the two differ.
    const failing = kinetex({
      baseURL: "https://httpbin.org",
      retry: { maxRetries: 5, retryDelayMs: 1 },
    });
    const seen = await failing.GET("/status/500").noRetry().noThrow().send();
    assert.strictEqual(seen.status, 500);
    assert.strictEqual(seen.attempt, 1, "noRetry() must not have retried");
    failing.destroy();

    const retrying = kinetex({
      baseURL: "https://httpbin.org",
      retry: { maxRetries: 2, retryDelayMs: 1 },
    });
    const retried = await retrying.GET("/status/500").noThrow().send();
    assert.strictEqual(retried.status, 500);
    assert.strictEqual(retried.attempt, 3, "the same client without noRetry() does retry");
    retrying.destroy();

    const client = kinetex({
      baseURL: "https://httpbin.org",
      retry: { maxRetries: 5 },
    });
    const res = await client.GET("/get").noRetry().send();

    console.log("Fluent noRetry() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("Fluent noCache() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.GET("/get").noCache().send();

    console.log("Fluent noCache() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("Fluent noThrow() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.GET("/status/500").noThrow().send();

    console.log("Fluent noThrow() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          statusText: res.statusText,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 500);
    client.destroy();
  });

  it("Fluent subscribe() callback method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const callbackCalled = await Promise.race([
      new Promise<boolean>((resolve) => {
        client.GET("/get").subscribe(
          () => resolve(true),
          () => resolve(false),
        );
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
    ]);
    assert.strictEqual(callbackCalled, true);
    client.destroy();
  });
});

describe("mod - Client Configuration", () => {
  it("baseURL configuration", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/get");

    console.log("baseURL config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          requestUrl: res.request.url,
        },
        null,
        2,
      ),
    );

    assert.equal(res.request.url, "https://httpbin.org/get");
    assert.equal(res.status, 200);
    client.destroy();
  });

  it("headers configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      headers: { "X-Global-Header": "global-value" },
    });
    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("headers config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.data.headers["X-Global-Header"], "global-value");
    client.destroy();
  });

  it("params configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      params: { globalParam: "globalValue" },
    });
    const res = await client.get<{ args: Record<string, string> }>("/get");

    console.log("params config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          args: res.data.args,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.deepEqual(res.data.args, { globalParam: "globalValue" });
    client.destroy();
  });

  it("timeout configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      timeout: 60000,
    });
    const res = await client.get("/get", { throwOnError: false });

    console.log("timeout config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          durationMs: res.durationMs,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // `durationMs < 60000` is true of every response that ever arrived, and of
    // a client that ignored the option completely. What the option promises is
    // the opposite direction too: a budget that *does* fire.
    assert.ok(
      res.durationMs >= 0 && res.durationMs < 60_000,
      `durationMs must be measured, got ${res.durationMs}`,
    );
    client.destroy();

    // The half of the contract that can actually fail: a budget smaller than
    // the endpoint's delay rejects with ETIMEOUT rather than hanging.
    const impatient = kinetex({ baseURL: "https://httpbin.org", timeout: 1 });
    let caught: unknown = null;
    try {
      await impatient.get("/delay/3", { throwOnError: false });
    } catch (err) {
      caught = err;
    }
    assert.notEqual(caught, null, "a 1ms budget must reject against /delay/3");
    assert.strictEqual((caught as { code?: string }).code, "ETIMEOUT");
    assert.strictEqual((caught as { timeoutMs?: number }).timeoutMs, 1);
    impatient.destroy();
  });

  it("throwOnError: false", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      throwOnError: false,
    });
    const res = await client.get("/status/404");

    console.log("throwOnError:false - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          statusText: res.statusText,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 404);
    client.destroy();
  });

  it("followRedirects configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      followRedirects: true,
    });
    const res = await client.get("/redirect/1", { throwOnError: false });

    console.log("followRedirects - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          url: res.url,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // Following was configured, so the hop was taken: this is what
    // `redirected` and `url` are for, and neither was looked at.
    assert.strictEqual(res.redirected, true);
    assert.match(res.url, /\/get$/);
    client.destroy();
  });

  it("followRedirects: false hands the 3xx back unfollowed", async () => {
    // The counterpart the file never had. `redirected` used to be `true` on
    // this path — a caller branching on it to spot a cross-origin bounce was
    // told it had been redirected somewhere it never went.
    const client = kinetex({ baseURL: "https://httpbin.org", followRedirects: false });
    const res = await client.get("/redirect/1", { throwOnError: false });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.redirected, false, "no hop was taken");
    assert.strictEqual(res.url, "https://httpbin.org/redirect/1");
    assert.ok(res.headers["location"], "the caller is handed the Location to act on");
    client.destroy();
  });

  it("maxRedirects configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      maxRedirects: 5,
    });
    const res = await client.get("/redirect/1", { throwOnError: false });

    console.log("maxRedirects - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.redirected, true, "the hop was taken");
    client.destroy();
  });

  it("httpVersion configuration", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      httpVersion: "HTTP/1.1" as const,
    });
    const res = await client.get("/get", { throwOnError: false });

    console.log("httpVersion config - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          httpVersion: res.httpVersion,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.httpVersion, "HTTP/1.1");
    client.destroy();
  });
});

describe("mod - Authentication", () => {
  it("bearer token auth", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: { type: "bearer", token: "test-token" },
    });
    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("bearer auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.headers["Authorization"], "Bearer test-token");
    client.destroy();
  });

  it("basic auth", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: { type: "basic", username: "user", password: "pass" },
    });
    const res = await client.get("/basic-auth/user/pass", { throwOnError: false });

    console.log("basic auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.data.authenticated, true);
    client.destroy();
  });

  it("apikey auth", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: { type: "apikey", header: "X-API-Key", key: "my-key" },
    });
    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("apikey auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.headers["X-Api-Key"], "my-key");
    client.destroy();
  });

  it("custom auth", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: {
        type: "custom",
        apply: async (req) => ({
          ...req,
          headers: { ...req.headers, "X-Custom-Auth": "custom-value" },
        }),
      },
    });
    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("custom auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.headers["X-Custom-Auth"], "custom-value");
    client.destroy();
  });

  it("async bearer token function", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      auth: { type: "bearer", token: async () => "async-token" },
    });
    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("async bearer auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.headers["Authorization"], "Bearer async-token");
    client.destroy();
  });
});

describe("mod - Interceptors", () => {
  it("request interceptor", async () => {
    // The interceptor only logged its context, so a client that never ran
    // request interceptors passed: nothing below looked at `seen`.
    const seen: Array<{ method: string; url: string; attempt: number }> = [];
    const client = kinetex({
      baseURL: "https://httpbin.org",
      interceptors: {
        request: [
          (ctx) => {
            seen.push({ method: ctx.request.method, url: ctx.request.url, attempt: ctx.attempt });
            console.log("Request interceptor - actual context:");
            console.log(
              JSON.stringify(
                {
                  url: ctx.request.url,
                  method: ctx.request.method,
                  attempt: ctx.attempt,
                },
                null,
                2,
              ),
            );
            return ctx.request;
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("Request interceptor result - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.deepEqual(seen, [{ method: "GET", url: "https://httpbin.org/get", attempt: 1 }]);
    client.destroy();
  });

  it("response interceptor", async () => {
    let interceptorCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      interceptors: {
        response: [
          (ctx) => {
            if (ctx.response) {
              interceptorCalled = true;
              console.log("Response interceptor - actual context:");
              console.log(
                JSON.stringify(
                  {
                    status: ctx.response.status,
                    statusText: ctx.response.statusText,
                    attempt: ctx.attempt,
                  },
                  null,
                  2,
                ),
              );
            }
            return ctx.response;
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("Response interceptor result - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          called: interceptorCalled,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(interceptorCalled, true);
    client.destroy();
  });

  it("error interceptor", async () => {
    let errorInterceptorCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      interceptors: {
        error: [
          (ctx) => {
            if (ctx.error) {
              errorInterceptorCalled = true;
              console.log("Error interceptor - actual context:");
              console.log(
                JSON.stringify(
                  {
                    error: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
                    attempt: ctx.attempt,
                  },
                  null,
                  2,
                ),
              );
            }
            return ctx.response;
          },
        ],
      },
    });

    await assert.rejects(
      () => client.get("/status/500"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "a 500 must reject with an Error");
        return true;
      },
    );

    console.log("Error interceptor called:", errorInterceptorCalled);
    assert.strictEqual(errorInterceptorCalled, true);
    client.destroy();
  });

  it("useRequest() method", async () => {
    // The interceptor only logged, so a client that never ran a registered
    // request interceptor passed: the only assertion was the status, which the
    // server produced regardless.
    const seen: string[] = [];
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useRequest((ctx) => {
      seen.push(`${ctx.request.method} ${ctx.request.url}`);
      console.log("useRequest() - actual context:");
      console.log(
        JSON.stringify(
          {
            url: ctx.request.url,
            method: ctx.request.method,
          },
          null,
          2,
        ),
      );
      return ctx.request;
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("useRequest() result - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.deepEqual(seen, ["GET https://httpbin.org/get"]);
    client.destroy();
  });

  it("useResponse() method", async () => {
    const seen: number[] = [];
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useResponse((ctx) => {
      if (ctx.response) {
        seen.push(ctx.response.status);
        console.log("useResponse() - actual context:");
        console.log(
          JSON.stringify(
            {
              status: ctx.response.status,
            },
            null,
            2,
          ),
        );
      }
      return ctx.response;
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("useResponse() result - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.deepEqual(seen, [200], "the response interceptor must see the response");
    client.destroy();
  });

  it("useError() method", async () => {
    const seen: string[] = [];
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useError((ctx) => {
      seen.push(
        ctx.error instanceof Error
          ? ((ctx.error as { code?: string }).code ?? "nocode")
          : "not-an-error",
      );
      console.log("useError() - actual context:");
      console.log(
        JSON.stringify(
          {
            error: ctx.error instanceof Error ? ctx.error.message : null,
            attempt: ctx.attempt,
          },
          null,
          2,
        ),
      );
      return ctx.response;
    });

    const res = await client.get("/get", { throwOnError: false });

    assert.strictEqual(res.status, 200);
    client.destroy();
  });
});

describe("mod - Lifecycle Hooks", () => {
  it("onBeforeRequest hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onBeforeRequest: [
          (req, ctx) => {
            hookCalled = true;
            console.log("onBeforeRequest hook - actual response:");
            console.log(
              JSON.stringify(
                {
                  request: { url: req.url, method: req.method },
                  attempt: ctx.attempt,
                  startedAt: ctx.startedAt,
                },
                null,
                2,
              ),
            );
            return req;
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("onBeforeRequest hook called:", hookCalled);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });

  it("onAfterRequest hook", async () => {
    // `hookCalled` was set here and never read: this test asserted the status
    // and nothing else, so a client that never invoked the hook passed it. The
    // hook was also, in fact, never invoked at all — see the Regressions block.
    let hookCalled = false;
    const seenAfter: Array<{ method: string; url: string; attempt: number }> = [];

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onAfterRequest: [
          (req, ctx) => {
            hookCalled = true;
            seenAfter.push({ method: req.method, url: req.url, attempt: ctx.attempt });
            console.log("onAfterRequest hook - actual response:");
            console.log(
              JSON.stringify(
                {
                  request: { url: req.url, method: req.method },
                  attempt: ctx.attempt,
                },
                null,
                2,
              ),
            );
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("onAfterRequest hook called:", hookCalled);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true, "onAfterRequest must run");
    assert.deepEqual(seenAfter, [{ method: "GET", url: "https://httpbin.org/get", attempt: 1 }]);
    client.destroy();
  });

  it("onBeforeResponse hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onBeforeResponse: [
          (res, ctx) => {
            hookCalled = true;
            console.log("onBeforeResponse hook - actual response:");
            console.log(
              JSON.stringify(
                {
                  status: res.status,
                  statusText: res.statusText,
                  attempt: ctx.attempt,
                },
                null,
                2,
              ),
            );
            return res;
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("onBeforeResponse hook called:", hookCalled);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });

  it("onAfterResponse hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onAfterResponse: [
          (res, ctx) => {
            hookCalled = true;
            console.log("onAfterResponse hook - actual response:");
            console.log(
              JSON.stringify(
                {
                  status: res.status,
                  durationMs: res.durationMs,
                  attempt: ctx.attempt,
                },
                null,
                2,
              ),
            );
          },
        ],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("onAfterResponse hook called:", hookCalled);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });

  it("onError hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onError: [
          (err, ctx) => {
            hookCalled = true;
            console.log("onError hook - actual response:");
            console.log(
              JSON.stringify(
                {
                  error: err instanceof Error ? err.message : String(err),
                  attempt: ctx.attempt,
                },
                null,
                2,
              ),
            );
          },
        ],
      },
    });

    await assert.rejects(
      () => client.get("/status/500"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "a 500 must reject with an Error");
        return true;
      },
    );

    console.log("onError hook called:", hookCalled);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });

  it("onUploadProgress hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onUploadProgress: [
          (event) => {
            hookCalled = true;
            console.log("onUploadProgress hook - actual response:");
            console.log(JSON.stringify(event, null, 2));
          },
        ],
      },
    });

    const res = await client.post("/post", { data: "test" }, { throwOnError: false });

    console.log("onUploadProgress hook called:", hookCalled);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });

  it("onDownloadProgress hook", async () => {
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onDownloadProgress: [
          (event) => {
            hookCalled = true;
            console.log("onDownloadProgress hook - actual response:");
            console.log(JSON.stringify(event, null, 2));
          },
        ],
      },
    });

    const res = await client.get("/bytes/100", { throwOnError: false });

    console.log("onDownloadProgress hook called:", hookCalled);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hookCalled, true);
    client.destroy();
  });
});

describe("mod - Retry Configuration", () => {
  it("default retry config", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      retry: {
        maxRetries: 3,
        statuses: [500, 502, 503, 504],
      },
    });

    const res = await client.get("/get", { throwOnError: false });

    console.log("default retry - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          attempt: res.attempt,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.attempt, 1);
    client.destroy();
  });

  it("onRetry hook with retry config", async () => {
    let retryCount = 0;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      retry: {
        maxRetries: 2,
        statuses: [500],
        onRetry: (ctx, delayMs) => {
          retryCount++;
          console.log("onRetry hook - actual response:");
          console.log(
            JSON.stringify(
              {
                attempt: ctx.attempt,
                maxRetries: ctx.maxRetries,
                request: { url: ctx.request.url, method: ctx.request.method },
                delayMs,
              },
              null,
              2,
            ),
          );
        },
      },
    });

    const res = await client.get("/status/500", { throwOnError: false });

    console.log("onRetry hook called count:", retryCount);
    console.log("Response status:", res.status);
    assert.strictEqual(res.status, 500);
    assert.ok(retryCount > 0);
    client.destroy();
  });
});

describe("mod - Cookie Jar", () => {
  it("cookieJar with true", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      cookieJar: true,
    });

    await client.get("/cookies/set/test/cookie-value", { throwOnError: false });
    const res = await client.get<{ cookies: Record<string, string> }>("/cookies");

    console.log("cookieJar - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.cookies.test, "cookie-value");
    client.destroy();
  });
});

describe("mod - HAR Recording", () => {
  it("HAR recording enabled", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      har: true,
    });

    await client.get("/get", { throwOnError: false });
    await client.post("/post", { data: "test" }, { throwOnError: false });

    const har = client.getHAR();

    console.log("HAR log - actual response:");
    console.log(
      JSON.stringify(
        {
          version: har.version,
          creator: har.creator,
          entriesCount: har.entries.length,
          entries: har.entries.map((e) => ({
            startedDateTime: e.startedDateTime,
            time: e.time,
            request: {
              method: e.request.method,
              url: e.request.url,
            },
            response: {
              status: e.response.status,
              statusText: e.response.statusText,
            },
          })),
        },
        null,
        2,
      ),
    );

    assert.equal(har.version, "1.2");
    assert.equal(Array.isArray(har.entries), true);
    assert.equal(har.entries.length, 2);
    assert.deepEqual(
      har.entries.map((e) => e.request.method),
      ["GET", "POST"],
    );

    client.destroy();
  });

  it("clearHAR() method", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      har: true,
    });

    await client.get("/get", { throwOnError: false });
    assert.equal(client.getHAR().entries.length, 1);

    client.clearHAR();
    assert.equal(client.getHAR().entries.length, 0);

    console.log("clearHAR() works correctly");
    client.destroy();
  });
});

describe("mod - Client Extend", () => {
  it("extend() creates child client", async () => {
    const parent = kinetex({
      baseURL: "https://httpbin.org",
      headers: { "X-Parent": "parent-value" },
    });

    const child = parent.extend({
      headers: { "X-Child": "child-value" },
    });

    const parentRes = await parent.get<{ headers: Record<string, string> }>("/headers", {
      throwOnError: false,
    });
    const childRes = await child.get<{ headers: Record<string, string> }>("/headers", {
      throwOnError: false,
    });

    console.log("parent extend() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: parentRes.status,
          data: parentRes.data,
        },
        null,
        2,
      ),
    );

    console.log("child extend() - actual response:");
    console.log(
      JSON.stringify(
        {
          status: childRes.status,
          data: childRes.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(childRes.status, 200);
    assert.strictEqual(parentRes.status, 200);
    // What `extend` is *for*: the child keeps the parent's header and gains its
    // own. Neither was checked — the parent carried no header at all before.
    assert.strictEqual(childRes.data.headers["X-Parent"], "parent-value");
    assert.strictEqual(childRes.data.headers["X-Child"], "child-value");
    assert.strictEqual(
      parentRes.data.headers["X-Child"],
      undefined,
      "the parent must not inherit from the child",
    );
    parent.destroy();
    child.destroy();
  });
});

describe("mod - Deduplication", () => {
  it("enableDedup() and disableDedup()", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
    });

    client.enableDedup();

    // Concurrent, not sequential: dedup shares an *in-flight* entry, so two
    // awaited one after the other are two misses and the test would have
    // asserted the opposite of what it claims.
    const [res1, res2] = await Promise.all([
      client.get("/get", { throwOnError: false }),
      client.get("/get", { throwOnError: false }),
    ]);

    console.log("dedup enabled - actual response:");
    console.log(
      JSON.stringify(
        {
          res1Status: res1.status,
          res2Status: res2.status,
          metrics: client.dedupMetrics,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res2.status, 200);
    // `dedupMetrics` was printed and never checked, so a `enableDedup()` that
    // did nothing — and returned two different objects — passed.
    assert.equal(res1, res2, "a deduplicated response is the same object");
    const metrics = client.dedupMetrics;
    assert.notEqual(metrics, null, "dedup is on, so metrics must exist");
    assert.strictEqual(metrics!.totalRequests, 2);
    assert.strictEqual(metrics!.misses, 1);
    assert.strictEqual(metrics!.hits, 1);
    assert.strictEqual(metrics!.inFlightCount, 0);
    client.disableDedup();
    assert.strictEqual(client.dedupMetrics, null, "disabling clears the metrics");
    const fresh = await client.get("/get", { throwOnError: false });
    assert.strictEqual(fresh.status, 200);
    client.destroy();
  });
});

describe("mod - Circuit Breaker", () => {
  it("enableCircuitBreaker() and disableCircuitBreaker()", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
    });

    client.enableCircuitBreaker();

    const res = await client.get("/get", { throwOnError: false });

    console.log("circuit breaker enabled - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          snapshots: client.circuitSnapshots,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.disableCircuitBreaker();
    client.destroy();
  });

  it("tripCircuit() and resetCircuit()", async () => {
    // The old assertion was `typeof client.circuitSnapshots === "object"`,
    // which is true of `{}` — the value returned when no registry exists at
    // all. Nothing checked that a tripped circuit stops traffic, which is the
    // entire purpose of the call.
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.enableCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    assert.deepEqual(client.circuitSnapshots, {}, "no origin is tracked until one is used");

    client.tripCircuit("https://httpbin.org");
    const tripped = client.circuitSnapshots["https://httpbin.org"];
    assert.notEqual(tripped, undefined, "tripCircuit must register the origin");
    assert.strictEqual(tripped!.state, "OPEN");

    // A tripped circuit refuses before dialling, so this cannot reach
    // httpbin.org at all — which is what makes it a real assertion.
    let caught: unknown = null;
    try {
      await client.get("/get", { throwOnError: false });
    } catch (err) {
      caught = err;
    }
    assert.notEqual(caught, null, "a tripped circuit must refuse the request");
    assert.strictEqual((caught as { code?: string }).code, "ECIRCUITOPEN");
    assert.strictEqual(
      client.circuitSnapshots["https://httpbin.org"]!.totalRequests,
      0,
      "a refused request must never be dispatched",
    );

    client.resetCircuit("https://httpbin.org");
    assert.strictEqual(client.circuitSnapshots["https://httpbin.org"]!.state, "CLOSED");

    // And the circuit really is open again afterwards.
    const res = await client.get("/get", { throwOnError: false });
    assert.strictEqual(res.status, 200);
    client.destroy();
  });
});

describe("mod - send() method", () => {
  it("low-level send() with all options", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.send("/get", "GET", {
      headers: { "X-Send-Header": "test" },
      params: { sendParam: "value" },
      timeout: 30000,
      throwOnError: false,
      meta: { custom: "data" },
    });

    console.log("send() method - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          request: {
            url: res.request.url,
            method: res.request.method,
            meta: res.request.meta,
          },
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // The test is named "with all options" and checked the status. Each option
    // is now read back off the request the server actually received.
    assert.strictEqual(res.request.url, "https://httpbin.org/get?sendParam=value");
    assert.strictEqual(res.request.headers["x-send-header"], "test");
    assert.deepEqual(res.request.meta, { custom: "data" });
    assert.strictEqual(res.request.method, "GET");
    client.destroy();
  });

  it("send() with body and auth", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.send("/post", "POST", {
      body: JSON.stringify({ key: "value" }),
      headers: { "Content-Type": "application/json" },
      auth: { type: "bearer", token: "token" },
      throwOnError: false,
    });

    console.log("send() with body/auth - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.json.key, "value");
    client.destroy();
  });

  it("send() with parseResponse", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.send("/get", "GET", {
      parseResponse: (raw) => {
        const text = new TextDecoder().decode(raw);
        return { parsed: true, raw };
      },
      throwOnError: false,
    });

    console.log("send() parseResponse - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // `parseResponse` replaced the parser and its return value became `data`;
    // the test only checked the status, so a client that ignored the hook
    // entirely passed it.
    assert.strictEqual(res.data.parsed, true);
    assert.notEqual(res.data.raw, undefined, "the hook's own return value is `data`");
    client.destroy();
  });
});

describe("mod - Progress Callbacks", () => {
  it("onUploadProgress option", async () => {
    let progressEvents: any[] = [];

    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.post(
      "/post",
      { data: "test-upload" },
      {
        onUploadProgress: (event) => {
          progressEvents.push(event);
        },
        throwOnError: false,
      },
    );

    console.log("onUploadProgress - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          progressEventsCount: progressEvents.length,
          lastEvent: progressEvents[progressEvents.length - 1],
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.ok(progressEvents.length > 0, "upload progress must be reported");
    // The terminal event is the one a caller waits on: without it a consumer
    // keyed on `done` never learns the transfer finished.
    const last = progressEvents[progressEvents.length - 1]!;
    assert.strictEqual(last.done, true, "the last upload event must report done");
    assert.strictEqual(last.percent, 100);
    assert.strictEqual(last.loaded, last.total);
    assert.strictEqual(
      last.total,
      new TextEncoder().encode(JSON.stringify({ data: "test-upload" })).byteLength,
    );
    client.destroy();
  });

  it("onDownloadProgress option", async () => {
    let progressEvents: any[] = [];

    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.get("/bytes/500", {
      onDownloadProgress: (event) => {
        progressEvents.push(event);
      },
      throwOnError: false,
    });

    console.log("onDownloadProgress - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          progressEventsCount: progressEvents.length,
          lastEvent: progressEvents[progressEvents.length - 1],
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.ok(progressEvents.length > 0, "download progress must be reported");
    const last = progressEvents[progressEvents.length - 1]!;
    assert.strictEqual(last.done, true, "the last download event must report done");
    assert.strictEqual(last.loaded, 500, "every byte of /bytes/500 must be counted");
    client.destroy();
  });
});

describe("mod - Error Handling", () => {
  // `assert.fail` inside a `try` whose `catch` swallows the AssertionError:
  // both of these caught their own failure and asserted nothing, so a client
  // that returned 404 and 500 as ordinary responses passed them. The errors
  // are now pinned to the class, the code, the status and the derived flags.
  for (const [status, flag] of [
    [404, "isClientError"],
    [500, "isServerError"],
  ] as const) {
    it(`HTTPStatusError for ${status}`, async () => {
      const client = kinetex({ baseURL: "https://httpbin.org" });

      let caught: unknown = null;
      try {
        await client.get(`/status/${status}`);
      } catch (err) {
        caught = err;
      }
      assert.notEqual(caught, null, `${status} must reject with the default throwOnError`);

      const err = caught as HTTPStatusError;
      assert.equal(err.name, "HTTPStatusError");
      assert.equal(err.code, "EHTTPSTATUS");
      assert.equal(err.status, status);
      assert.equal(err[flag], true, `${status} must set ${flag}`);
      // The three flags are independent, and each is pinned: a 404 is a client
      // error and not a server error, a 500 is the reverse, and both are HTTP
      // errors rather than transport failures. Asserting only the one that is
      // true is what let the other two go unchecked.
      assert.equal(err.isHTTPError, true, `${status} is an HTTP error`);
      assert.equal(
        err[flag === "isClientError" ? "isServerError" : "isClientError"],
        false,
        `${status} must not set the sibling flag`,
      );
      assert.match(err.message, new RegExp(String(status)));
      assert.equal(err.request.method, "GET");
      assert.equal(err.request.url, `https://httpbin.org/status/${status}`);

      client.destroy();
    });
  }

  it("onSuccess callback", async () => {
    let successCalled = false;
    let successResponse: any = null;

    const client = kinetex({ baseURL: "https://httpbin.org" });

    await client.get("/get", {
      onSuccess: (res) => {
        successCalled = true;
        successResponse = res;
        console.log("onSuccess callback - actual response:");
        console.log(
          JSON.stringify(
            {
              status: res.status,
              data: res.data,
            },
            null,
            2,
          ),
        );
      },
    });

    assert.equal(successCalled, true);
    assert.ok(successResponse !== null);
    assert.equal(successResponse.status, 200);
    assert.equal(successResponse.request.method, "GET");
    client.destroy();
  });

  it("onError callback", async () => {
    let errorCalled = false;
    let errorResponse: any = null;

    const client = kinetex({ baseURL: "https://httpbin.org" });

    try {
      await client.get("/status/500", {
        onError: (err) => {
          errorCalled = true;
          errorResponse = err;
          console.log("onError callback - actual error:");
          console.log(
            JSON.stringify(
              {
                name: err.name,
                message: err.message,
                code: err.code,
              },
              null,
              2,
            ),
          );
        },
      });
    } catch (e) {
      // The rejection is expected (onError has already run), but it is still
      // a rejection: assert its shape rather than discarding it.
      assert.ok(e instanceof Error, "the failed request must reject with an Error");
    }

    assert.equal(errorCalled, true);
    assert.ok(errorResponse !== null);
    assert.equal(errorResponse.name, "HTTPStatusError");
    assert.equal(errorResponse.code, "EHTTPSTATUS");
    assert.equal(errorResponse.status, 500);
    client.destroy();
  });
});

describe("mod - Real API Tests", () => {
  it("httpbin.org/get", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get<{
      url: string;
      args: Record<string, string>;
      headers: Record<string, string>;
    }>("/get");

    console.log("Real API /get - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          data: res.data,
          durationMs: res.durationMs,
          httpVersion: res.httpVersion,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("httpbin.org/post", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.post<{
      data: string;
      json: Record<string, any>;
    }>("/post", { test: "value" });

    console.log("Real API /post - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("httpbin.org/headers", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      headers: { "X-Custom-Test": "header-value" },
    });

    const res = await client.get<{ headers: Record<string, string> }>("/headers");

    console.log("Real API /headers - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("httpbin.org/uuid", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get<{ uuid: string }>("/uuid");

    console.log("Real API /uuid - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data.uuid === "string");
    client.destroy();
  });

  it("httpbin.org/bytes/100", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/bytes/100", { throwOnError: false });

    console.log("Real API /bytes/100 - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          rawBodyLength: res.rawBody?.byteLength ?? 0,
          contentType: res.headers["content-type"],
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.rawBody?.byteLength, 100);
    client.destroy();
  });

  it("httpbin.org/status/201", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/status/201", { throwOnError: false });

    console.log("Real API /status/201 - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          statusText: res.statusText,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 201);
    client.destroy();
  });

  it("httpbin.org/redirect/1", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/redirect/1", { throwOnError: false });

    console.log("Real API /redirect/1 - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          redirected: res.redirected,
          url: res.url,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // The response echoes `redirected` and `url` and the test looked at
    // neither: a client that reported `false` for a hop it did take, or that
    // reported the pre-hop URL, passed it.
    assert.strictEqual(res.redirected, true, "the hop was taken");
    assert.match(res.url, /\/get$/);
    client.destroy();
  });

  it("httpbin.org/delay/1", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/delay/1", { timeout: 10000, throwOnError: false });

    console.log("Real API /delay/1 - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          durationMs: res.durationMs,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("httpbin.org/image", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/image", { throwOnError: false });

    console.log("Real API /image - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          rawBodyLength: res.rawBody?.byteLength ?? 0,
          contentType: res.headers["content-type"],
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    // `/image` returns a real PNG. Only the status was checked, so a client
    // that discarded the body — or that followed a redirect onto a JSON error
    // page — passed it.
    assert.match(res.headers["content-type"] ?? "", /^image\//);
    assert.ok(
      (res.rawBody?.byteLength ?? 0) > 1000,
      `the image body must be present, got ${res.rawBody?.byteLength ?? 0} bytes`,
    );
    client.destroy();
  });

  it("httpbin.org/json", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/json", { throwOnError: false });

    console.log("Real API /json - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.slideshow.author, "Yours Truly");
    client.destroy();
  });

  it("httpbin.org/anything", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      headers: { "Content-Type": "application/json" },
    });

    const res = await client.post<{
      json: Record<string, any>;
      headers: Record<string, string>;
    }>("/anything", { echo: "test" });

    console.log("Real API /anything - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          data: res.data,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });

  it("httpbin.org/encoding/utf8", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });
    const res = await client.get("/encoding/utf8", { throwOnError: false });

    console.log("Real API /encoding/utf8 - actual response:");
    console.log(
      JSON.stringify(
        {
          status: res.status,
          rawBodyLength: res.rawBody?.byteLength ?? 0,
        },
        null,
        2,
      ),
    );

    assert.strictEqual(res.status, 200);
    client.destroy();
  });
});

describe("mod - AbortController", () => {
  it("request cancellation", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    let caught: unknown = null;
    try {
      await client.get("/delay/5", {
        signal: controller.signal,
        timeout: 10000,
        throwOnError: false,
      });
    } catch (err) {
      caught = err;
      console.log("AbortController - actual error:");
      console.log(
        JSON.stringify(
          {
            name: err.name,
            message: err.message,
          },
          null,
          2,
        ),
      );
    }
    assert.ok(caught !== null, "aborting after 100ms must reject the in-flight request");
    assert.equal((caught as Error).name, "KinetexError");
    assert.equal((caught as { code?: string }).code, "EABORT");
    assert.equal((caught as { isAbort?: boolean }).isAbort, true);

    client.destroy();
  });
});

// ── Regressions (mod round) ──────────────────────────────────────────────────
//
// Four defects in the public surface this file is the entry point for, none of
// which the assertions above could see: three of the four had a test whose
// assertions did not look at the thing named, and the fourth had no test at
// all. They run against an injected `fetch` rather than httpbin so the exact
// request count, the exact error code and the exact hook ordering are all
// observable.

// ── Documented client options that no test file exercised ───────────────────
//
// `circuitBreakerKeyFn` and `onSWRError` are both in the README's client
// configuration block, and neither appeared in a single test file. Each is a
// branch on an optional config field, so a client that ignored it was
// indistinguishable from one that honoured it.

describe("Regressions (client option coverage)", () => {
  /** The `counting` helper in the mod-round block is scoped to it, so this
   * suite brings its own: a fetch that records every URL it was handed. */
  function counting(respond: (url: string, n: number) => Response): {
    fetchFn: typeof fetch;
    urls: string[];
  } {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      urls.push(url);
      return respond(url, urls.length);
    }) as unknown as typeof fetch;
    return { fetchFn, urls };
  }

  it("circuitBreakerKeyFn decides which requests share a circuit", async () => {
    // The default key is the request's origin. A custom key function is the
    // documented way to scope a breaker differently — per path, per tenant —
    // and it is only ever consulted for the WebSocket path, so it has to be
    // driven as something that changes the outcome rather than a value that is
    // merely stored.
    const seen: string[] = [];
    const { fetchFn } = counting(() => new Response("ok", { status: 200 }));
    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fetchFn,
      circuitBreakerKeyFn: (req) => {
        seen.push(req.url);
        return new URL(req.url).pathname;
      },
    });
    // The registry is only created on demand, so without this every call below
    // is a no-op against a null registry and `circuitSnapshots` is always `{}`.
    client.enableCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });

    await client.get("/alpha");
    await client.get("/beta");
    assert.deepEqual(
      seen,
      ["https://api.example.com/alpha", "https://api.example.com/beta"],
      "the key function is consulted once per request, with the full URL",
    );

    // Tripping one key must leave the other alone. Under the per-origin default
    // both of these share a breaker, so this assertion can only pass if the
    // custom key really is in use.
    client.tripCircuit("/alpha");
    const keyed = client.circuitSnapshots;
    assert.ok(
      "/alpha" in keyed,
      `expected a breaker keyed "/alpha", got ${JSON.stringify(Object.keys(keyed))}`,
    );
    assert.equal(keyed["/alpha"]!.state, "OPEN");
    // `/beta` is tracked too — it was requested above — but it is untouched:
    // under the per-origin default, tripping "/alpha" would have opened this
    // one as well.
    assert.ok(
      keyed["/beta"] !== undefined && keyed["/beta"]!.state !== "OPEN",
      `a different key must not be tripped with it, got ${JSON.stringify(keyed["/beta"]?.state)}`,
    );

    const refused = await client.get("/alpha").then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    assert.equal(refused?.code, "ECIRCUITOPEN", "the tripped key refuses traffic");
    assert.equal((await client.get("/beta")).status, 200, "an untripped key is still served");
    client.destroy();
  });

  it("a client with no circuitBreakerKeyFn keys breakers by origin", async () => {
    // The counterpart to the test above: with no key function the default is
    // the origin, so tripping it must refuse a request to a different path on
    // that same origin. This is what gives the previous test its meaning.
    const { fetchFn } = counting(() => new Response("ok", { status: 200 }));
    const client = kinetex({ baseURL: "https://api.example.com", fetch: fetchFn });
    client.enableCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });

    await client.get("/alpha");
    client.tripCircuit("https://api.example.com");
    const keyed = client.circuitSnapshots;
    assert.ok(
      "https://api.example.com" in keyed,
      `the default key is the origin, got ${JSON.stringify(Object.keys(keyed))}`,
    );
    const refused = await client.get("/a-different-path").then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    assert.equal(refused?.code, "ECIRCUITOPEN", "the whole origin shares one breaker");
    client.destroy();
  });

  it("onSWRError reports a failed background revalidation", async () => {
    // `onSWRError` fires on a path nothing reaches unless a stale entry is
    // served and its revalidation then throws: the request has already been
    // answered, so a silent failure looks exactly like a cache that quietly
    // stops refreshing.
    const errors: Array<{ message: string; url: string }> = [];
    let calls = 0;
    let failRevalidation = false;
    const { fetchFn } = counting(() => {
      calls++;
      if (failRevalidation) throw new Error(`revalidation ${calls} failed`);
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          // The canonical CDN recipe: serve the stale copy while one request
          // revalidates behind it.
          "cache-control": "max-age=0, stale-while-revalidate=30",
        },
      });
    });
    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fetchFn,
      // The response cache is off until it is configured; without this the
      // entry is never stored and nothing is ever stale.
      cache: { defaultTtlMs: 60_000 },
      onSWRError: (err, req) => {
        errors.push({ message: String((err as Error)?.message), url: req.url });
      },
    });

    assert.equal(
      (await client.get("/swr", { retry: false })).status,
      200,
      "the priming request is served",
    );
    assert.equal(calls, 1, "one call so far");
    assert.equal(errors.length, 0, "a successful request reports nothing");

    failRevalidation = true;
    const stale = await client.get("/swr", { retry: false });
    assert.equal(stale.status, 200, "the stale copy is still served");
    assert.equal(stale.cached, true, "the second call comes from the cache");

    // The revalidation is fire-and-forget, so it may already have failed by the
    // time the stale response is handed back — there is no ordering to assert
    // here. What matters is that it does fail, that the hook reports it, and
    // that the caller above still received a 200.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(errors.length, 1, `onSWRError must fire once, fired ${errors.length}`);
    assert.match(
      errors[0]!.message,
      /revalidation \d+ failed/,
      "the real failure, not a placeholder",
    );
    assert.match(errors[0]!.url, /\/swr$/, "and the request that failed");

    // A failed revalidation must not take the cache down with it.
    const after = await client.get("/swr", { retry: false });
    assert.equal(after.status, 200, "the stale entry is still servable");
    client.destroy();
  });

  it("a throwing onSWRError does not fail the request that triggered it", async () => {
    // The call is wrapped in its own try/catch, so a hook that throws is
    // isolated. Without that, a logging bug would surface as a request failure
    // on a response that had already been served.
    const { fetchFn } = counting(
      () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "max-age=0, stale-while-revalidate=30",
          },
        }),
    );
    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fetchFn,
      cache: { defaultTtlMs: 60_000 },
      onSWRError: () => {
        throw new Error("the logging hook is broken");
      },
    });

    assert.equal((await client.get("/x", { retry: false })).status, 200, "priming request");
    assert.equal(
      (await client.get("/x", { retry: false })).status,
      200,
      "the stale hit is still served",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      (await client.get("/x", { retry: false })).status,
      200,
      "and the cache keeps working",
    );
    client.destroy();
  });
});

describe("Regressions (mod round)", () => {
  /** A transport that records every URL it is asked for. */
  function counting(respond: (url: string, n: number) => Response): {
    fetchFn: typeof fetch;
    urls: string[];
  } {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      urls.push(url);
      return respond(url, urls.length);
    }) as unknown as typeof fetch;
    return { fetchFn, urls };
  }

  it("regression: an unfollowed 3xx reports redirected: false", async () => {
    // `followRedirects: false` reported `redirected: true` — the one value the
    // field must never take, since no hop was taken and `res.url` is still the
    // URL the caller asked for. It is the case a caller most needs to tell
    // apart: they now have to read `Location` and decide for themselves.
    for (const cfg of [{ followRedirects: false }, { maxRedirects: 0 }] as const) {
      const { fetchFn, urls } = counting(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://api.example.com/landed" },
          }),
      );
      const client = kinetex({ baseURL: "https://api.example.com", ...cfg, fetch: fetchFn });
      const res = await client.get("/start", { throwOnError: false });
      assert.equal(res.status, 302, JSON.stringify(cfg));
      assert.equal(res.redirected, false, JSON.stringify(cfg));
      assert.equal(res.url, "https://api.example.com/start");
      assert.equal(res.headers["location"], "https://api.example.com/landed");
      assert.equal(urls.length, 1, "the hop must not have been taken");
      client.destroy();
    }
  });

  it("regression: a followed chain still reports redirected: true", async () => {
    // The counterpart, so the fix cannot be satisfied by pinning `false`.
    const { fetchFn, urls } = counting((_u, n) =>
      n === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://api.example.com/landed" },
          })
        : Response.json({ landed: true }),
    );
    const client = kinetex({ baseURL: "https://api.example.com", fetch: fetchFn });
    const res = await client.get("/start", { throwOnError: false });
    assert.equal(res.status, 200);
    assert.equal(res.redirected, true);
    assert.equal(res.url, "https://api.example.com/landed");
    assert.equal(urls.length, 2);
    client.destroy();
  });

  it("regression: an exhausted redirect chain is EREDIRECT and is not retried", async () => {
    // `RedirectError` is exported, documented in the README's error table, and
    // given a non-retryable case in `shouldRetry` — and nothing constructed it.
    // The error arrived as `ENETWORK`, so the whole chain was replayed once per
    // attempt: 16 requests went out under `maxRedirects: 3`.
    const { fetchFn, urls } = counting(
      (_u, n) =>
        new Response(null, {
          status: 302,
          headers: { location: `https://api.example.com/h${n}` },
        }),
    );
    const client = kinetex({ baseURL: "https://api.example.com", fetch: fetchFn });

    let caught: unknown = null;
    try {
      await client.get("/start", { maxRedirects: 3 });
    } catch (err) {
      caught = err;
    }
    assert.notEqual(caught, null, "an endless chain must eventually be refused");
    assert.equal((caught as { code?: string }).code, "EREDIRECT");
    assert.equal((caught as Error).name, "RedirectError");
    assert.match((caught as Error).message, /Too many redirects \(exceeded 3\)/);
    // 1 initial request + 3 followed hops, once. The old behaviour was four
    // times that.
    assert.equal(urls.length, 4, "the chain must be attempted exactly once");
    client.destroy();
  });

  it("regression: a redirect loop is EREDIRECT and stops at the loop", async () => {
    const { fetchFn, urls } = counting(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/loop" },
        }),
    );
    const client = kinetex({ baseURL: "https://api.example.com", fetch: fetchFn });
    let caught: unknown = null;
    try {
      await client.get("/loop");
    } catch (err) {
      caught = err;
    }
    assert.equal((caught as { code?: string }).code, "EREDIRECT");
    assert.match((caught as Error).message, /Redirect loop/);
    assert.equal(urls.length, 2, "one hop, then the same target is refused");
    client.destroy();
  });

  it("regression: onAfterRequest actually fires, once per attempt", async () => {
    // Declared on `LifecycleHooks` as "After the request is sent (before
    // response is processed)" and shown twice in the README with example code,
    // and never invoked on any path.
    const seen: Array<{ method: string; url: string; attempt: number }> = [];
    const { fetchFn } = counting(() => Response.json({ ok: true }));
    const client = kinetex({
      baseURL: "https://api.example.com",
      fetch: fetchFn,
      hooks: {
        onAfterRequest: [
          (req, ctx) => {
            seen.push({ method: req.method, url: req.url, attempt: ctx.attempt });
          },
        ],
      },
    });

    await client.get("/ok");
    assert.deepEqual(seen, [{ method: "GET", url: "https://api.example.com/ok", attempt: 1 }]);

    // It sits between the transport and the response, so it must also fire for
    // a 500 — and not for a request that never left.
    seen.length = 0;
    const failing = kinetex({
      baseURL: "https://api.example.com",
      fetch: (async () =>
        new Response("{}", {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      hooks: {
        onAfterRequest: [
          (req, ctx) => void seen.push({ method: req.method, url: req.url, attempt: ctx.attempt }),
        ],
      },
    });
    await failing.get("/bad", { throwOnError: false });
    assert.equal(seen.length, 4, "once per attempt, including the ones that failed");
    failing.destroy();

    seen.length = 0;
    const broken = kinetex({
      baseURL: "https://api.example.com",
      fetch: (async () => {
        throw new Error("socket died");
      }) as unknown as typeof fetch,
      hooks: { onAfterRequest: [() => void seen.push({ method: "?", url: "?", attempt: 0 })] },
    });
    await broken.get("/gone", { throwOnError: false }).catch(() => {});
    assert.equal(seen.length, 0, "a request that was never sent must not report as sent");
    broken.destroy();

    client.destroy();
  });

  it("regression: a HAR entry records the request body", async () => {
    // `postData` is declared on `HAREntry` as "Posted data, if applicable" and
    // was never written, so every recorded POST reached a HAR viewer empty —
    // while the response body, query string, headers and URL were all there.
    const echo = (async (input: unknown) => {
      const init = (input as { init?: RequestInit })?.init;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    void echo;

    const json = kinetex({
      baseURL: "https://api.example.com",
      har: true,
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    await json.post("/x", { user: "ada", password: "hunter2" });
    const entry = json.getHAR().entries[0]!;
    assert.equal(entry.request.method, "POST");
    assert.equal(entry.request.postData?.mimeType, "application/json");
    assert.deepEqual(JSON.parse(entry.request.postData!.text), {
      user: "ada",
      password: "hunter2",
    });
    assert.equal(entry.request.bodySize, entry.request.postData!.text.length);
    json.destroy();

    // A body whose content type is not safe to record is omitted rather than
    // written — the same policy the response body already uses.
    const html = kinetex({
      baseURL: "https://api.example.com",
      har: true,
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    await html.post("/x", "<script>alert(1)</script>", {
      headers: { "content-type": "text/html" },
    });
    assert.equal(html.getHAR().entries[0]!.request.postData, undefined);
    html.destroy();

    // And a GET with no body records none.
    const get = kinetex({
      baseURL: "https://api.example.com",
      har: true,
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    await get.get("/x");
    assert.equal(get.getHAR().entries[0]!.request.postData, undefined);
    assert.equal(get.getHAR().entries[0]!.request.bodySize, 0);
    get.destroy();
  });
});

describe("mod - destroy() method", () => {
  it("destroy() cleans up resources", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    const res = await client.get("/get", { throwOnError: false });

    console.log("before destroy - status:", res.status);

    assert.strictEqual(res.status, 200);
    client.destroy();

    console.log("destroy() called successfully");
  });
});

// Force clean exit — node:test waits indefinitely for HTTP keep-alive sockets
// to close. This ensures the process exits after all tests complete, with the
// run's actual verdict rather than whatever `process.exitCode` happens to hold
// (which is nothing; see the note above the drift guard).
after(async () => {
  setTimeout(() => {
    if (driftReport.failures > 0) {
      console.error(`\n${driftReport.failures} test(s) failed.`);
    }
    // Printed whether or not anything failed, and under its own heading: a run
    // whose httpbin assertions never actually ran must not read as a clean one.
    if (driftReport.drift > 0) console.error(driftReport.text());
    process.exit(driftReport.failures > 0 ? 1 : 0);
  }, 500);
});
