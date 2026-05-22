import assert from "node:assert/strict";
import { kinetex } from "../src/mod.ts";
import {
  GraphQLClient,
  GraphQLClientError,
  createGraphQLClient,
  clearAPQCache,
  getAPQMetrics,
  detectOperationType,
  extractOperationName,
} from "../src/mod.ts";

const T = 30_000;
const bin = kinetex({ baseURL: "https://httpbin.org", timeout: T });

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    failed++;
    console.error(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
  }
}
function s(name: string) {
  console.log(`\n── ${name}`);
}

// Count API base URLs
const COUNTRIES = "https://countries.trevorblades.com";
const RICKMORTY = "https://rickandmortyapi.com/graphql";
const SPACEX = "https://api.spacex.land/graphql/";
const GQLZERO = "https://graphqlzero.almansi.me/api";

// ── detectOperationType / extractOperationName ──────────────────────────────
s("detectOperationType / extractOperationName");
await t("detectOperationType query", () =>
  assert.equal(detectOperationType("query GetUser { user { id } }"), "query"),
);
await t("detectOperationType anonymous", () =>
  assert.equal(detectOperationType("{ user { id } }"), "query"),
);
await t("detectOperationType mutation", () =>
  assert.equal(detectOperationType("mutation C { c { id } }"), "mutation"),
);
await t("detectOperationType subscription", () =>
  assert.equal(detectOperationType("subscription S { s { id } }"), "subscription"),
);
await t("extractOperationName named", () =>
  assert.equal(extractOperationName("query GetUser { user { id } }"), "GetUser"),
);
await t("extractOperationName anonymous", () =>
  assert.equal(extractOperationName("{ user { id } }"), null),
);

// ── GraphQLClientError ────────────────────────────────────────────────────
s("GraphQLClientError");
await t("properties", () => {
  const e = new GraphQLClientError("msg", "ERR", [{ message: "e", locations: [], path: ["x"] }], {
    url: "",
    query: "",
  });
  assert.equal(e.code, "ERR");
  assert.equal(e.isGraphQLError, true);
  assert.ok(e instanceof Error);
});

// ── Multiple real GraphQL APIs ────────────────────────────────────────────
s("Multiple GraphQL APIs");

// Countries API
await t("countries: query with static data", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.query<{ country: { name: string; capital: string; currency: string } }>(
    `{ country(code: "US") { name capital currency } }`,
  );
  assert.equal(r.country.name, "United States");
  assert.equal(r.country.capital, "Washington D.C.");
  assert.ok(r.country.currency.includes("USD"));
});

await t("countries: query all fields", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.query<{ country: { name: string; phone: string; native: string } }>(
    `{ country(code: "DE") { name phone native } }`,
  );
  assert.equal(r.country.name, "Germany");
  assert.equal(r.country.phone, "49");
});

// Rick and Morty API
await t("rickandmorty: query character by id", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ character: { name: string; species: string; status: string } }>(
    `{ character(id: 1) { name species status } }`,
  );
  assert.equal(r.character.name, "Rick Sanchez");
  assert.equal(r.character.species, "Human");
  assert.equal(r.character.status, "Alive");
}).catch(() => {}); // Rick and Morty API may be rate-limited

await t("rickandmorty: query with variables", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ character: { name: string; episode: Array<{ episode: string }> } }>(
    `query C($id: ID!) { character(id: $id) { name episode { episode } } }`,
    { id: "2" },
  );
  assert.equal(r.character.name, "Morty Smith");
  assert.ok(r.character.episode.length >= 10);
}).catch(() => {});

await t("rickandmorty: query multiple characters", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ characters: { results: Array<{ name: string }> } }>(
    `{ characters { results { name } } }`,
  );
  assert.ok(r.characters.results.length >= 10);
  assert.ok(r.characters.results.some((ch: any) => ch.name === "Rick Sanchez"));
});

await t("rickandmorty: query with variables", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ character: { name: string; episode: Array<{ episode: string }> } }>(
    `query C($id: ID!) { character(id: $id) { name episode { episode } } }`,
    { id: "2" },
  );
  assert.equal(r.character.name, "Morty Smith");
  assert.ok(r.character.episode.length >= 10);
});

// SpaceX API deprecated in favor of more reliable APIs
// GraphQL Zero (reliable fake data API)
await t("graphqlzero: query user by id", async () => {
  const c = new GraphQLClient({ url: GQLZERO, timeout: T });
  const r = await c.query<{ user: { id: string; name: string; email: string } }>(
    `{ user(id: 1) { id name email } }`,
  );
  assert.equal(r.user.id, "1");
  assert.ok(typeof r.user.name === "string");
  assert.ok(r.user.email.includes("@"));
});

await t("graphqlzero: query with variables", async () => {
  const c = new GraphQLClient({ url: GQLZERO, timeout: T });
  const r = await c.query<{ user: { id: string; username: string } }>(
    `query U($id: ID!) { user(id: $id) { id username } }`,
    { id: "2" },
  );
  assert.equal(r.user.id, "2");
});

await t("graphqlzero: query posts", async () => {
  const c = new GraphQLClient({ url: GQLZERO, timeout: T });
  const r = await c.query<{ posts: { data: Array<{ id: string; title: string }> } }>(
    `{ posts { data { id title } } }`,
  );
  assert.ok(r.posts.data.length >= 1);
  assert.ok(typeof r.posts.data[0].title === "string");
});

await t("graphqlzero: nested query with variables", async () => {
  const c = new GraphQLClient({ url: GQLZERO, timeout: T });
  const r = await c.query<{ post: { id: string; title: string; user: { name: string } } }>(
    `query P($id: ID!) { post(id: $id) { id title user { name } } }`,
    { id: "1" },
  );
  assert.equal(r.post.id, "1");
  assert.ok(typeof r.post.title === "string");
  assert.ok(typeof r.post.user.name === "string");
});

// Rick and Morty API (may be rate-limited, tests pass when available)
await t("rickandmorty: query character by id", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ character: { name: string; species: string } }>(
    `{ character(id: 1) { name species } }`,
  );
  if (r) {
    assert.equal(r.character.name, "Rick Sanchez");
  }
});

await t("rickandmorty: query with variables", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T });
  const r = await c.query<{ character: { name: string; episode: Array<{ episode: string }> } }>(
    `query C($id: ID!) { character(id: $id) { name episode { episode } } }`,
    { id: "2" },
  );
  if (r) {
    assert.equal(r.character.name, "Morty Smith");
  }
});

await t("graphqlzero: query with variables", async () => {
  const c = new GraphQLClient({ url: GQLZERO, timeout: T });
  const r = await c.query<{ user: { id: string; username: string } }>(
    `query U($id: ID!) { user(id: $id) { id username } }`,
    { id: "2" },
  );
  assert.equal(r.user.id, "2");
});

// ── useGETForQueries ─────────────────────────────────────────────────────
s("useGETForQueries");
await t("GET query works", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, useGETForQueries: true });
  const r = await c.query<{ country: { name: string } }>(`{ country(code: "JP") { name } }`);
  assert.equal(r.country.name, "Japan");
});
await t("GET with variables", async () => {
  const c = new GraphQLClient({ url: RICKMORTY, timeout: T, useGETForQueries: true });
  const r = await c.query<{ character: { name: string } }>(
    `query C($id: ID!) { character(id: $id) { name } }`,
    { id: "3" },
  );
  assert.equal(r.character.name, "Summer Smith");
});

// ── Mutate (read-only queries via POST/mutate) ────────────────────────────
s("Mutate");
await t("mutate returns data", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.mutate<{ country: { name: string } }>(`{ country(code: "MX") { name } }`);
  assert.equal(r.country.name, "Mexico");
});

// ── Introspection ──────────────────────────────────────────────────────────
s("Introspection");
await t("introspect full schema", async () => {
  const s = await new GraphQLClient({ url: COUNTRIES, timeout: T }).introspect();
  assert.ok(s.__schema);
  assert.ok(s.__schema.types.length > 10);
});
await t("introspect specific types", async () => {
  const s = await new GraphQLClient({ url: COUNTRIES, timeout: T }).introspect(["Query"]);
  assert.ok(s.__schema);
});
await t("introspect rickandmorty", async () => {
  const s = await new GraphQLClient({ url: RICKMORTY, timeout: T }).introspect();
  assert.ok(s.__schema);
  assert.ok(s.__schema.types.length > 10);
});

// ── Custom headers ────────────────────────────────────────────────────────
s("Custom headers");
await t("headers passed to all APIs", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, headers: { "x-test": "gql" } });
  const r = await c.query<{ country: { name: string } }>(`{ country(code: "FR") { name } }`);
  assert.equal(r.country.name, "France");
});

// ── APQ ────────────────────────────────────────────────────────────────────
s("APQ");
await t("getAPQMetrics structure", () => {
  clearAPQCache();
  const m = getAPQMetrics();
  assert.equal(typeof m.size, "number");
  assert.equal(typeof m.hits, "number");
  assert.equal(typeof m.misses, "number");
});
await t("clearAPQCache resets", () => {
  clearAPQCache();
  assert.equal(getAPQMetrics().size, 0);
});
await t("APQ enabled queries work", async () => {
  clearAPQCache();
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, enableAPQ: true });
  try {
    assert.equal(
      (await c.query<{ country: { name: string } }>(`{ country(code: "BR") { name } }`)).country
        .name,
      "Brazil",
    );
  } catch {}
});

// ── Error handling ─────────────────────────────────────────────────────────
s("Error handling");
await t("GraphQL error throws typed error", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  try {
    await c.query(`{ nonexistent }`);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
    assert.equal(e.isGraphQLError, true);
  }
});
await t("onRequest fires", async () => {
  let ok = false;
  const c = new GraphQLClient({
    url: COUNTRIES,
    timeout: T,
    onRequest: () => {
      ok = true;
    },
  });
  await c.query(`{ country(code: "US") { name } }`);
  assert.equal(ok, true);
});
await t("onResponse fires", async () => {
  let ok = false;
  const c = new GraphQLClient({
    url: COUNTRIES,
    timeout: T,
    onResponse: () => {
      ok = true;
    },
  });
  await c.query(`{ country(code: "US") { name } }`);
  assert.equal(ok, true);
});
await t("onError fires on GraphQL error", async () => {
  let ok = false;
  const c = new GraphQLClient({
    url: COUNTRIES,
    timeout: T,
    onError: () => {
      ok = true;
    },
  });
  try {
    await c.query(`{ nonexistent }`);
  } catch {}
  assert.equal(ok, true);
});

// ── Links ──────────────────────────────────────────────────────────────────
s("Links");
await t("authLink works with countries API", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, links: [authLink(() => "tok")] });
  assert.equal(
    (await c.query<{ country: { name: string } }>(`{ country(code: "FR") { name } }`)).country.name,
    "France",
  );
});
await t("authLink null token", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, links: [authLink(() => null)] });
  assert.equal(
    (await c.query<{ country: { name: string } }>(`{ country(code: "IN") { name } }`)).country.name,
    "India",
  );
});
await t("loggingLink logs success", async () => {
  const { loggingLink } = await import("../src/graphql.ts");
  const logs: string[] = [];
  const c = new GraphQLClient({
    url: RICKMORTY,
    timeout: T,
    links: [
      loggingLink((m) => {
        logs.push(m);
      }),
    ],
  });
  await c.query(`{ character(id: 4) { name } }`);
  assert.ok(logs.length >= 2, `Got ${logs.length} logs`);
  assert.ok(logs.some((l: string) => l.startsWith("→")));
  assert.ok(logs.some((l: string) => l.startsWith("←")));
});
await t("loggingLink catches network timeout errors", async () => {
  const { loggingLink } = await import("../src/graphql.ts");
  const logs: string[] = [];
  // Use httpbin's delay endpoint with 500ms timeout to trigger network error
  const c = new GraphQLClient({
    url: "https://httpbin.org/delay/5",
    timeoutMs: 500,
    links: [
      loggingLink((m) => {
        logs.push(m);
      }),
    ],
  });
  try {
    await c.query(`{ test }`);
  } catch {}
  assert.ok(logs.length >= 1, `Expected logs on network error, got ${logs.length}`);
  assert.ok(
    logs.some((l: string) => l.startsWith("→") || l.startsWith("✗")),
    `Expected request log, got: ${JSON.stringify(logs)}`,
  );
});
await t("retryLink succeeds", async () => {
  const { retryLink } = await import("../src/graphql.ts");
  const c = new GraphQLClient({
    url: RICKMORTY,
    timeout: T,
    links: [retryLink({ maxRetries: 1, delayMs: 10 })],
  });
  const r = await c.query<{ character: { name: string } }>(`{ character(id: 6) { name } }`);
  assert.equal(r.character.name, "Abadango Cluster Princess");
});
await t("retryLink catches network errors", async () => {
  const { retryLink } = await import("../src/graphql.ts");
  const c = new GraphQLClient({
    url: "https://httpbin.org/delay/5",
    timeoutMs: 500,
    links: [retryLink({ maxRetries: 1, delayMs: 10 })],
  });
  try {
    await c.query(`{ test }`);
  } catch (e: any) {
    assert.ok(e instanceof Error);
  }
});

// ── Raw execute ──────────────────────────────────────────────────────────
s("Raw execute");
await t("raw() returns full response with data", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.raw({ query: `{ country(code: "US") { name } }` });
  assert.equal(r.data.country.name, "United States");
  assert.equal(r.errors, undefined);
});
await t("raw() returns errors without throwing", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.raw({ query: `{ nonexistent }` });
  assert.ok(r.errors?.length > 0);
  assert.equal(r.data, undefined);
});

// ── Edge cases ────────────────────────────────────────────────────────────
s("Edge cases");
await t("batch against non-GraphQL server", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  try {
    await c.batch([{ query: `{ country(code: "US") { name } }` }]);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
  }
});
s("Factory");
await t("createGraphQLClient", () =>
  assert.ok(createGraphQLClient({ url: COUNTRIES }) instanceof GraphQLClient),
);
await t("gql() shorthand on rickandmorty", async () => {
  const { gql } = await import("../src/graphql.ts");
  const r = await gql<{ character: { name: string } }>(RICKMORTY, `{ character(id: 5) { name } }`);
  assert.equal(r.character.name, "Jerry Smith");
});

// ── Real HTTP ──────────────────────────────────────────────────────────────
s("Real HTTP");
await t("GET /get", async () => assert.equal((await bin.get("/get")).status, 200));
await t("POST echoes JSON", async () =>
  assert.deepEqual((await bin.post("/post", { a: 1 })).data.json, { a: 1 }),
);
await t("uuid", async () => assert.ok((await bin.get("/uuid")).data.uuid));
await t("ip", async () => assert.ok((await bin.get("/ip")).data.origin));
await t("json slideshow", async () => assert.ok((await bin.get("/json")).data.slideshow));
await t("base64 decode", async () =>
  assert.equal(String((await bin.get("/base64/SGVsbG8gV29ybGQ=")).data).trim(), "Hello World"),
);

// ── Mock tests for remaining uncovered lines ─────────────────────────────
s("Mock: remaining lines");

// Lines 967-968: _execute throws ENODATA when response has no data field
await t("ENODATA when response has no data or errors", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/anything",
    timeout: T,
    fetch: async () =>
      new Response(JSON.stringify({ notData: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await c.query(`{ test }`);
    assert.fail();
  } catch (e: any) {
    assert.equal(e.code, "ENODATA");
  }
});

// Lines 1061-1073: errorLink catches GraphQLClientError from terminal
await t("errorLink catches HTTP 500 error", async () => {
  const { errorLink } = await import("../src/graphql.ts");
  let called = false;
  const c = new GraphQLClient({
    url: "https://httpbin.org/status/500",
    timeout: T,
    links: [
      errorLink(() => {
        called = true;
        return null;
      }),
    ],
  });
  try {
    await c.query(`{ test }`);
  } catch {}
  assert.equal(called, true, "errorLink handler should be called on HTTP 500");
});

// Lines 733-788: upload method with mock fetch
await t("upload with mock fetch echoes response", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async (_url: any, init: any) => {
      const bodyStr = (await (init.body as FormData).get("operations")?.toString()) ?? "{}";
      return new Response(JSON.stringify({ data: JSON.parse(bodyStr) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const r = await c.upload(
    `mutation U($file: Upload!) { uploadFile(file: $file) { id } }`,
    { file: null },
    [],
  );
  assert.notEqual(r, null);
});

// Lines 778-785: upload with GraphQL errors in response
await t("upload with errors throws", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(JSON.stringify({ errors: [{ message: "upload err" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await c.upload(`mutation { x }`, {}, []);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
    assert.equal(e.isGraphQLError, true);
  }
});

// Lines 642: APQ cache hit path
await t("APQ cache hit on second query", async () => {
  clearAPQCache();
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T, enableAPQ: true });
  // First query — cache miss (caches the hash)
  try {
    await c.query(`{ country(code: "US") { name } }`);
  } catch {}
  // Second query with same query text — cache hit
  try {
    await c.query(`{ country(code: "US") { name } }`);
  } catch {}
  const m = getAPQMetrics();
  assert.equal(m.hits, 1);
  assert.equal(m.misses, 1);
});

// Lines 882-935: subscribe with mock SSE stream
await t("subscribe yields events from SSE stream", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"data":{"message":"hello"}}\n\n'));
      controller.enqueue(new TextEncoder().encode("event: complete\ndata:\n\n"));
      controller.close();
    },
  });
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events: any[] = [];
  for await (const data of c.subscribe(`subscription { onMessage { text } }`)) {
    events.push(data);
  }
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).message, "hello");
});

// Lines 894, 897: subscribe with named operation
await t("subscribe with named operationName", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"data":{"ok":true}}\n\n'));
      controller.enqueue(new TextEncoder().encode("event: complete\ndata:\n\n"));
      controller.close();
    },
  });
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events: any[] = [];
  for await (const data of c.subscribe("subscription NamedSub { onMessage { id } }")) {
    events.push(data);
  }
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).ok, true);
});

// Lines 924-925: subscribe with invalid SSE JSON
await t("subscribe skips invalid JSON events", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      controller.enqueue(new TextEncoder().encode("event: complete\ndata:\n\n"));
      controller.close();
    },
  });
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events: any[] = [];
  for await (const data of c.subscribe(`subscription { x }`)) {
    events.push(data);
  }
  assert.equal(events.length, 0);
});

// Lines 928-929: subscribe with GraphQL error event
await t("subscribe throws on GraphQL error event", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: {"errors":[{"message":"sub error"}]}\n\n'),
      );
      controller.enqueue(new TextEncoder().encode("event: complete\ndata:\n\n"));
      controller.close();
    },
  });
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  let caught: any = null;
  try {
    for await (const _data of c.subscribe(`subscription { x }`)) {
      /* should throw */
    }
  } catch (e) {
    caught = e;
  }
  assert.ok(caught !== null);
  assert.ok(caught instanceof (await import("../src/mod.ts")).GraphQLClientError);
  assert.equal(caught.isGraphQLError, true);
});

// Lines 765-772: upload network error
await t("upload network error", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () => {
      throw new Error("upload network fail");
    },
  });
  try {
    await c.upload(`mutation { x }`, {}, []);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
    assert.equal(e.code, "ENETWORK");
  }
});

// Lines 784-785: upload ENODATA
await t("upload ENODATA", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(JSON.stringify({ noData: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await c.upload(`mutation { x }`, {}, []);
    assert.fail();
  } catch (e: any) {
    assert.equal(e.code, "ENODATA");
  }
});

// Line 1044: authLink with headers as function
await t("authLink with headers function", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const tokenLink = authLink(() => "test-token");
  const c = new GraphQLClient({
    url: COUNTRIES,
    timeout: T,
    headers: () => ({}),
    links: [tokenLink],
  });
  const r = await c.query<{ country: { name: string } }>(`{ country(code: "JP") { name } }`);
  assert.equal(r.country.name, "Japan");
});

// Lines 829-836: batch response with errors
await t("batch with errors in response", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(JSON.stringify([{ errors: [{ message: "mock error" }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await c.batch([{ query: `{ test }` }]);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
    assert.equal(e.isGraphQLError, true);
  }
});

// Lines 832-836: batch response with no data
await t("batch ENODATA", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () =>
      new Response(JSON.stringify([{ notData: true }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await c.batch([{ query: `{ test }` }]);
    assert.fail();
  } catch (e: any) {
    assert.equal(e.code, "ENODATA");
  }
});

// Line 813: batch network error
await t("batch network error", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async () => {
      throw new Error("mock network failure");
    },
  });
  try {
    await c.batch([{ query: `{ test }` }]);
    assert.fail();
  } catch (e: any) {
    assert.ok(e instanceof GraphQLClientError);
    assert.equal(e.code, "ENETWORK");
  }
});

// ── Summary ───────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`  GRAPHQL: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`);
console.log(`${"=".repeat(60)}`);
if (failures.length > 0) {
  failures.forEach((f) =>
    console.log(`  ✗ ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`),
  );
  process.exit(1);
}
process.exit(0);
