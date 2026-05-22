import { kinetex } from "../src/mod.ts";
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

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

    assert.ok(text.length > 0);
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
    let callbackCalled = false;

    client.GET("/get").subscribe(
      (res) => {
        callbackCalled = true;
        console.log("Fluent subscribe() success - actual response:");
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
      (err) => {
        console.log("Fluent subscribe() error:", err.message);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 5000));
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

    assert.ok(res.request.url.includes("httpbin.org"));
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
    assert.ok(res.durationMs < 60000);
    client.destroy();
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
    const client = kinetex({
      baseURL: "https://httpbin.org",
      interceptors: {
        request: [
          (ctx) => {
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

    try {
      await client.get("/status/500");
    } catch {
      // Expected
    }

    console.log("Error interceptor called:", errorInterceptorCalled);
    assert.strictEqual(errorInterceptorCalled, true);
    client.destroy();
  });

  it("useRequest() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useRequest((ctx) => {
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
    client.destroy();
  });

  it("useResponse() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useResponse((ctx) => {
      if (ctx.response) {
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
    client.destroy();
  });

  it("useError() method", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    client.useError((ctx) => {
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
    let hookCalled = false;

    const client = kinetex({
      baseURL: "https://httpbin.org",
      hooks: {
        onAfterRequest: [
          (req, ctx) => {
            hookCalled = true;
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

    try {
      await client.get("/status/500");
    } catch {
      // Expected
    }

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

    assert.ok(har.version === "1.2");
    assert.ok(Array.isArray(har.entries));
    assert.ok(har.entries.length >= 2);

    client.destroy();
  });

  it("clearHAR() method", async () => {
    const client = kinetex({
      baseURL: "https://httpbin.org",
      har: true,
    });

    await client.get("/get", { throwOnError: false });
    assert.ok(client.getHAR().entries.length === 1);

    client.clearHAR();
    assert.ok(client.getHAR().entries.length === 0);

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

    const res1 = await client.get("/get", { throwOnError: false });
    const res2 = await client.get("/get", { throwOnError: false });

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
    client.disableDedup();
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
    const client = kinetex({
      baseURL: "https://httpbin.org",
    });

    client.enableCircuitBreaker();
    client.tripCircuit("https://httpbin.org");
    client.resetCircuit("https://httpbin.org");

    console.log("tripCircuit() and resetCircuit() executed");
    assert.strictEqual(typeof client.circuitSnapshots, "object");
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
    assert.ok(progressEvents.length > 0);
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
    assert.ok(progressEvents.length > 0);
    client.destroy();
  });
});

describe("mod - Error Handling", () => {
  it("HTTPStatusError for 404", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    try {
      await client.get("/status/404");
      assert.fail("Should have thrown");
    } catch (err) {
      console.log("HTTPStatusError 404 - actual error:");
      console.log(
        JSON.stringify(
          {
            name: err.name,
            message: err.message,
            code: err.code,
            status: (err as any).status,
            isHTTPError: (err as any).isHTTPError,
          },
          null,
          2,
        ),
      );
    }

    client.destroy();
  });

  it("HTTPStatusError for 500", async () => {
    const client = kinetex({ baseURL: "https://httpbin.org" });

    try {
      await client.get("/status/500");
      assert.fail("Should have thrown");
    } catch (err) {
      console.log("HTTPStatusError 500 - actual error:");
      console.log(
        JSON.stringify(
          {
            name: err.name,
            code: err.code,
            status: (err as any).status,
            isServerError: (err as any).isServerError,
          },
          null,
          2,
        ),
      );
    }

    client.destroy();
  });

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

    assert.ok(successCalled === true);
    assert.ok(successResponse !== null);
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
    } catch {
      // Error already handled by onError
    }

    assert.ok(errorCalled === true);
    assert.ok(errorResponse !== null);
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

    try {
      await client.get("/delay/5", {
        signal: controller.signal,
        timeout: 10000,
        throwOnError: false,
      });
    } catch (err) {
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
      assert.ok(err instanceof Error);
    }

    client.destroy();
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
// to close. This ensures the process exits after all tests complete.
after(async () => {
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 500);
});
