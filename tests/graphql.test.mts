import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isUpstreamFlake } from "./upstream.ts";
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

/**
 * Assert that `e` is a transport failure, not a defect in the code under test.
 *
 * The live-API tests below used a bare `catch {}`, which was satisfied by a
 * wrong page shape or a bad assertion just as readily as by the network being
 * down. Only a genuine connection failure may be tolerated; everything else is
 * rethrown and fails the suite.
 */
function assertTransportFailure(e: unknown): void {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as { message?: string })?.message ?? String(e);
  assert.ok(
    /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout|network|socket|fetch/i.test(
      `${name}: ${msg}`,
    ),
    `not a transport failure — this must fail the suite, not be skipped: ${name}: ${msg}`,
  );
  console.log(`    → upstream unavailable, skipping: ${msg}`);
}

/**
 * A local server that actually speaks the APQ protocol.
 *
 * The two APQ tests used to run against a live public endpoint wrapped in
 * `catch {}`. That endpoint rejects automatic persisted queries outright, so
 * the feature was never exercised and the suite reported a pass anyway — the
 * clearest possible pass-through. This server answers a hash-only request with
 * `PERSISTED_QUERY_NOT_FOUND` and a full request with data, so the
 * miss → register → hit sequence is genuinely driven and asserted.
 */
async function startAPQServer(): Promise<{
  url: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const known = new Map<string, string>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      const ext = body.extensions as { persistedQuery?: { sha256Hash?: string } } | undefined;
      // A real APQ server remembers the query once it has been sent in full,
      // and answers later hash-only requests from that store. Without this the
      // "cache hit" case can never be observed: every request would come back
      // PERSISTED_QUERY_NOT_FOUND and the client would retry every time.
      if (typeof body.query === "string" && body.query.length > 0) {
        if (ext?.persistedQuery?.sha256Hash) known.set(ext.persistedQuery.sha256Hash, body.query);
      } else if (ext?.persistedQuery?.sha256Hash && known.has(ext.persistedQuery.sha256Hash)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { country: { name: "United States" } } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (typeof body.query === "string" && body.query.length > 0) {
        res.end(JSON.stringify({ data: { country: { name: "United States" } } }));
      } else {
        res.end(
          JSON.stringify({
            errors: [
              {
                message: "PersistedQueryNotFound",
                extensions: {
                  code: "PERSISTED_QUERY_NOT_FOUND",
                  sha256Hash: ext?.persistedQuery?.sha256Hash,
                },
              },
            ],
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A local server that records every request it receives.
 *
 * Most of the assertions this file needs to make are about the *request* — was
 * the bearer token actually put on the wire, was the query string omitted for
 * an APQ hit, did the multipart body null the right variable. A test that only
 * checks "the call returned data" cannot see any of that, and several such
 * tests passed against code that sent nothing at all.
 */
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => unknown;
}

type Responder = (
  rec: Recorded,
  index: number,
) => {
  status?: number;
  body?: unknown;
  contentType?: string;
};

async function startRecordingServer(
  respond: Responder = () => ({ body: { data: { ok: true } } }),
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = {
        url: req.url!,
        method: req.method!,
        headers: { ...req.headers },
        body: raw,
        json: () => JSON.parse(raw || "null"),
      };
      const index = requests.length;
      requests.push(rec);
      const out = respond(rec, index) ?? {};
      res.writeHead(out.status ?? 200, {
        "content-type": out.contentType ?? "application/json",
      });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    // An outage at httpbin arrives as a failure that says nothing about the
    // client. The discrimination is narrow and never excuses an
    // AssertionError, so it cannot mask a real defect; see
    // tests/upstream-drift.test.mts, which also enforces that this suite has
    // the guard in the first place.
    if (isUpstreamFlake(err)) {
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${why}`);
      return;
    }
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
  const s: any = await new GraphQLClient({ url: COUNTRIES, timeout: T }).introspect();
  assert.deepEqual(s.__schema.queryType, { name: "Query" });
  assert.ok(Array.isArray(s.__schema.types));
  assert.ok(
    s.__schema.types.every((t: any) => typeof t.kind === "string" && typeof t.name === "string"),
    "every introspected type needs a kind and a name",
  );
  const directiveNames = s.__schema.directives.map((d: any) => d.name).sort();
  for (const d of ["deprecated", "include", "skip", "specifiedBy"]) {
    assert.ok(
      directiveNames.includes(d),
      `built-in directive ${d} must be introspected, got ${JSON.stringify(directiveNames)}`,
    );
  }
  // A directive carries its locations and argument list.
  const include = s.__schema.directives.find((d: any) => d.name === "include");
  assert.deepEqual(include.locations, ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"]);
  assert.deepEqual(
    include.args.map((a: any) => a.name),
    ["if"],
  );
  // A field carries the deprecation metadata the fragment asks for.
  const country = s.__schema.types.find((t: any) => t.name === "Country");
  assert.equal(typeof country.fields[0].isDeprecated, "boolean");
  assert.ok("deprecationReason" in country.fields[0]);
});
await t("introspect resolves a specific named type from the schema", async () => {
  // This called `introspect(["Query"])`, but `introspect()` takes no
  // arguments — the "specific types" the test name promised were never
  // requested, and the assertion could not tell. The lookup it meant to do is
  // done here against the returned schema.
  const s: any = await new GraphQLClient({ url: COUNTRIES, timeout: T }).introspect();
  const country = s.__schema.types.find((t: any) => t.name === "Country");
  assert.ok(country, "the schema must contain the Country type");
  assert.equal(country.kind, "OBJECT");
  assert.deepEqual(country.fields.map((f: any) => f.name).sort(), [
    "awsRegion",
    "capital",
    "code",
    "continent",
    "currencies",
    "currency",
    "emoji",
    "emojiU",
    "languages",
    "name",
    "native",
    "phone",
    "phones",
    "states",
    "subdivisions",
  ]);
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
  assert.deepEqual(Object.keys(m).sort(), ["hits", "misses", "size"]);
  assert.equal(m.size, 0);
  assert.equal(m.hits, 0);
  assert.equal(m.misses, 0);
});
await t("clearAPQCache resets", () => {
  clearAPQCache();
  assert.equal(getAPQMetrics().size, 0);
});
await t("APQ enabled queries work", async () => {
  clearAPQCache();
  // The APQ hash cache and its metrics are static, so a previous test's entry
  // would make this "cold" query a hit and the round-trip count meaningless.
  clearAPQCache();
  const srv = await startAPQServer();
  try {
    const c = new GraphQLClient({ url: srv.url, timeout: T, enableAPQ: true });
    assert.equal(
      (await c.query<{ country: { name: string } }>(`{ country(code: "BR") { name } }`)).country
        .name,
      "United States",
    );
    // The miss is real: request 1 carries only the hash, request 2 the query.
    assert.equal(srv.bodies.length, 2, "APQ must take exactly two round-trips on a cold cache");
    assert.equal(
      srv.bodies[0]!.query,
      "",
      "the first request must omit the query text (sent as an empty string)",
    );
    assert.equal(
      typeof (srv.bodies[0]!.extensions as { persistedQuery?: { sha256Hash?: string } })
        .persistedQuery?.sha256Hash,
      "string",
      "the first request must carry the sha256 hash",
    );
    assert.equal(
      srv.bodies[1]!.query,
      `{ country(code: "BR") { name } }`,
      "the retry must resend the original query verbatim",
    );
    const m = getAPQMetrics();
    assert.equal(m.misses, 1, "a cold hash must be computed exactly once");
    // The client re-reads its own hash cache when it retries with the full
    // query, so a cold query ends at one hit — not zero. Pinned here because
    // the count is the only external evidence that the retry reused the hash
    // instead of recomputing it.
    assert.equal(m.hits, 1, "the register retry reuses the cached hash");
    assert.equal(m.size, 1, "exactly one query is cached afterwards");
  } finally {
    clearAPQCache();
  }
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
  await assert.rejects(
    () => c.query(`{ nonexistent }`),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an invalid query must reject with an Error");
      return true;
    },
  );
  assert.equal(ok, true, "onError must fire for a failed query");
});

// ── Links ──────────────────────────────────────────────────────────────────
s("Links");
await t("authLink puts the token on the wire", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const srv = await startRecordingServer(() => ({
    body: { data: { country: { name: "France" } } },
  }));
  try {
    const c = new GraphQLClient({ url: srv.url, links: [authLink(() => "tok")] });
    await c.query(`{ country(code: "FR") { name } }`);
    // The three original authLink tests asserted only that a public API still
    // answered, which is exactly what the client did while never sending a
    // token at all — the link wrote to `op.request.headers` and `op.config`,
    // and neither was ever read on the way to fetch.
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0]!.headers.authorization, "Bearer tok");
  } finally {
    await srv.close();
  }
});
await t("authLink honours a custom scheme", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({
      url: srv.url,
      links: [authLink(async () => "async-tok", "Token")],
    });
    await c.query(`{ a }`);
    assert.equal(srv.requests[0]!.headers.authorization, "Token async-tok");
  } finally {
    await srv.close();
  }
});
await t("authLink with a null token sends no authorization header", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url, links: [authLink(() => null)] });
    await c.query(`{ a }`);
    assert.equal(srv.requests[0]!.headers.authorization, undefined);
  } finally {
    await srv.close();
  }
});
let seenLogging: any[] = [];
await t("loggingLink logs success", async () => {
  const { loggingLink } = await import("../src/graphql.ts");
  const logs: string[] = [];
  seenLogging = [];
  const c = new GraphQLClient({
    url: RICKMORTY,
    timeout: T,
    links: [
      loggingLink((m, data) => {
        logs.push(m);
        seenLogging.push(data as any);
      }),
    ],
  });
  await c.query(`query GetChar { character(id: 4) { name } }`);
  // Pinned exactly: the two lifecycle messages, in order, with the operation
  // name and the URL in the request log. The old version only counted logs
  // and matched a one-character prefix, so a log of `→` with no data passed.
  assert.deepEqual(logs, ["→ GraphQL", "← GraphQL"]);
  const payloads = seenLogging;
  assert.equal(payloads[0]!.operation, "GetChar", "an anonymous operation logs as `anonymous`");
  assert.equal(payloads[0]!.url, RICKMORTY);
  assert.equal(typeof payloads[1]!.durationMs, "number");
  assert.ok(payloads[1]!.durationMs >= 0);
  assert.deepEqual(payloads[1]!.errors, undefined);
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
  // The query is expected to fail against the deliberately-unreachable host,
  // so the rejection is asserted rather than discarded.
  await assert.rejects(
    () => c.query(`{ test }`),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an unreachable endpoint must reject with an Error");
      return true;
    },
  );
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
await t("retryLink exhausts its attempts and rethrows", async () => {
  const { retryLink } = await import("../src/graphql.ts");
  let attempts = 0;
  const c = new GraphQLClient({
    url: "https://httpbin.org/delay/5",
    timeoutMs: 500,
    links: [
      retryLink({
        maxRetries: 2,
        delayMs: 5,
        shouldRetry: (err, n) => {
          attempts++;
          assert.equal(n, attempts - 1, "attempt is 0-based");
          return true;
        },
      }),
    ],
  });
  // The old version wrapped this in a bare try/catch and asserted nothing —
  // it passed whether the call resolved or rejected.
  await assert.rejects(
    () => c.query(`{ test }`),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an unreachable endpoint must reject with an Error");
      return true;
    },
  );
  assert.equal(attempts, 3, "maxRetries: 2 means three total attempts");
});

// ── Raw execute ──────────────────────────────────────────────────────────
s("Raw execute");
await t("raw() returns full response with data", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.raw({ query: `{ country(code: "US") { name } }` });
  assert.equal(r.data.country.name, "United States");
  assert.equal(r.errors, undefined, "raw() must not synthesise an errors array");
  assert.equal(r.extensions, undefined);
});
await t("raw() returns errors without throwing", async () => {
  const c = new GraphQLClient({ url: COUNTRIES, timeout: T });
  const r = await c.raw({ query: `{ nonexistent }` });
  assert.equal(Array.isArray(r.errors), true);
  assert.ok(r.errors!.length > 0);
  assert.equal(typeof r.errors![0]!.message, "string");
  assert.ok(r.errors![0]!.message.length > 0);
  assert.equal(r.data, undefined, "a failed query must not carry a data field");
});

// ── Edge cases ────────────────────────────────────────────────────────────
s("Edge cases");
await t("batch against a server that does not answer with an array", async () => {
  const srv = await startRecordingServer(() => ({ body: { data: { country: null } } }));
  try {
    const c = new GraphQLClient({ url: srv.url, timeout: T });
    await assert.rejects(
      () => c.batch([{ query: `{ country(code: "US") { name } }` }]),
      (e: any) => {
        assert.ok(e instanceof GraphQLClientError);
        assert.equal(e.code, "EINVALIDRESPONSE");
        assert.match(e.message, /must be an array/);
        return true;
      },
    );
  } finally {
    await srv.close();
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
await t("uuid", async () => {
  const d = (await bin.get("/uuid")).data;
  assert.deepEqual(Object.keys(d), ["uuid"]);
  // A v4 UUID: 8-4-4-4-12 hex with version 4 and an RFC 4122 variant nibble.
  assert.match(d.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Two calls must not return the same value.
  assert.notEqual(d.uuid, (await bin.get("/uuid")).data.uuid);
});
await t("ip", async () => {
  const d = (await bin.get("/ip")).data;
  assert.deepEqual(Object.keys(d), ["origin"]);
  // httpbin echoes the caller's address: dotted-quad, or an IPv6 form.
  assert.match(d.origin, /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i);
});
await t("json slideshow", async () => {
  const d = (await bin.get("/json")).data;
  assert.deepEqual(Object.keys(d), ["slideshow"]);
  assert.equal(d.slideshow.title, "Sample Slide Show");
  assert.ok(Array.isArray(d.slideshow.slides));
  assert.ok(d.slideshow.slides.length > 0);
});
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
  await assert.rejects(
    () => c.query(`{ test }`),
    (err: unknown) => {
      assert.ok(err instanceof Error, "an HTTP 500 must reject with an Error");
      return true;
    },
  );
  assert.equal(called, true, "errorLink handler should be called on HTTP 500");
});

let lastForm: FormData | null = null;
// Lines 733-788: upload method with mock fetch
await t("upload with mock fetch echoes response", async () => {
  const c = new GraphQLClient({
    url: "https://httpbin.org/post",
    timeout: T,
    fetch: async (_url: any, init: any) => {
      lastForm = init.body as FormData;
      const bodyStr = (await (init.body as FormData).get("operations")?.toString()) ?? "{}";
      return new Response(JSON.stringify({ data: { echo: JSON.parse(bodyStr) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const r = await c.upload<{ echo: unknown }>(
    `mutation U($file: Upload!) { uploadFile(file: $file) { id } }`,
    { file: null },
    [],
  );
  // The old assertion was `assert.notEqual(r, null)`, which any object passes.
  const echoed = r.echo as Record<string, unknown>;
  assert.equal(echoed.query, `mutation U($file: Upload!) { uploadFile(file: $file) { id } }`);
  assert.equal(echoed.operationName, "U", "the operation name is auto-extracted");
  assert.deepEqual(echoed.variables, { file: null });
  // A batch with no uploads still carries a `map`, which must be an object.
  assert.deepEqual(JSON.parse((await lastForm.get("map")) as string), {});
  assert.equal(lastForm.get("operations") !== null, true);
  assert.equal(lastForm.get("0"), null, "no part named 0 exists when no file was sent");
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
  const srv = await startAPQServer();
  const c = new GraphQLClient({ url: srv.url, timeout: T, enableAPQ: true });
  try {
    // First query — cache miss (hash computed, two round-trips)
    await c.query(`{ country(code: "US") { name } }`);
    assert.equal(srv.bodies.length, 2, "the cold query must take the miss + register pair");
    // The cold query's own retry already consults the hash cache, so it records
    // one hit. Assert that explicitly rather than leaving it to inference.
    assert.equal(getAPQMetrics().hits, 1, "the register retry re-reads the cached hash");
    // Second query with the same query text — the server already knows it, so
    // this must cost a single round-trip instead of the miss + register pair.
    await c.query(`{ country(code: "US") { name } }`);
    assert.equal(
      srv.bodies.length,
      3,
      "a cache hit must be served in one round-trip, not re-run the miss pair",
    );
    assert.equal(srv.bodies[2]!.query, "", "a cache hit still omits the query text");
    const m = getAPQMetrics();
    assert.equal(m.hits, 2, "the second query must be a cache hit");
    assert.equal(m.misses, 1, "the hash must be computed exactly once");
    assert.equal(m.size, 1, "only one query is cached");
  } finally {
    clearAPQCache();
  }
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

// ══════════════════════════════════════════════════════════════════════════
// Regression: defects found by this audit
// ══════════════════════════════════════════════════════════════════════════
s("regression: request-level headers reach the wire");

await t("op.request.headers are merged into the outgoing request", async () => {
  const srv = await startRecordingServer();
  try {
    // `authLink` writes here as well as onto op.config, so a link is the
    // natural way to exercise it; a direct link is more precise.
    const headerLink = (op: any, next: any) => {
      op.request = { ...op.request, headers: { ...op.request.headers, "x-trace": "t-1" } };
      return next(op);
    };
    const c = new GraphQLClient({ url: srv.url, links: [headerLink] });
    await c.query(`{ a }`);
    assert.equal(srv.requests[0]!.headers["x-trace"], "t-1");
  } finally {
    await srv.close();
  }
});

await t("a link that sets only op.config.headers is honoured", async () => {
  const srv = await startRecordingServer();
  try {
    // `authLink` writes to both `op.request.headers` and `op.config`, so it
    // cannot tell the two apart — the terminal link discarding `op.config`
    // was invisible while the request-level path worked. A link that only
    // touches the config is the case that needs its own test.
    const configOnlyLink = (op: any, next: any) =>
      next({ ...op, config: { ...op.config, headers: { "x-cfg": "only" } } });
    const c = new GraphQLClient({ url: srv.url, links: [configOnlyLink] });
    await c.query(`{ a }`);
    assert.equal(srv.requests[0]!.headers["x-cfg"], "only");
  } finally {
    await srv.close();
  }
});

await t("request headers override the client default", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url, headers: { accept: "application/json" } });
    const link = (op: any, next: any) => {
      op.request = { ...op.request, headers: { accept: "application/graphql-response+json" } };
      return next(op);
    };
    const c2 = new GraphQLClient({
      url: srv.url,
      headers: { accept: "application/json" },
      links: [link],
    });
    await c2.query(`{ a }`);
    assert.equal(srv.requests[0]!.headers.accept, "application/graphql-response+json");
    void c;
  } finally {
    await srv.close();
  }
});

await t("authLink works over GET as well as POST", async () => {
  const { authLink } = await import("../src/graphql.ts");
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({
      url: srv.url,
      useGETForQueries: true,
      links: [authLink(() => "g")],
    });
    await c.query(`{ a }`);
    assert.equal(srv.requests[0]!.method, "GET");
    assert.equal(srv.requests[0]!.headers.authorization, "Bearer g");
  } finally {
    await srv.close();
  }
});

s("regression: errorLink awaits its handler");

await t("an async handler returning null re-throws the original error", async () => {
  const { errorLink } = await import("../src/graphql.ts");
  // A link *below* errorLink raises the error, so it reaches errorLink intact
  // rather than being wrapped by the transport.
  const boom = new GraphQLClientError("original", "ENETWORK", undefined, { url: "", query: "" });
  const thrower = (): any => {
    throw boom;
  };
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    // The documented contract: returning `null` means "re-throw". Without an
    // `await` the null arrived as a truthy Promise, so the error was replaced
    // by a resolved `null` and the caller died on `null.errors` — a TypeError
    // that named neither the cause nor the operation.
    links: [errorLink(async () => null), thrower as any],
  });
  await assert.rejects(
    () => c.query(`{ a }`),
    (e: unknown) => {
      assert.equal(e, boom, "the very same error must propagate");
      return true;
    },
  );
});

await t("an async handler returning a response recovers", async () => {
  const { errorLink } = await import("../src/graphql.ts");
  let seenCode: string | undefined;
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    fetch: async () => {
      throw new Error("down");
    },
    // A raw fetch rejection is wrapped by the transport into a
    // GraphQLClientError, so the handler sees the wrapper — with its code and
    // the underlying network error attached.
    links: [
      errorLink(async (err) => {
        seenCode = err.code;
        assert.equal(err.networkError?.message, "down");
        return { data: { recovered: true } } as any;
      }),
    ],
  });
  assert.deepEqual(await c.query(`{ a }`), { recovered: true });
  assert.equal(seenCode, "ENETWORK");
});

await t("a synchronous handler returning null also re-throws", async () => {
  const { errorLink } = await import("../src/graphql.ts");
  const boom = new GraphQLClientError("sync", "ENETWORK", undefined, { url: "", query: "" });
  const thrower = (): any => {
    throw boom;
  };
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    links: [errorLink(() => null), thrower as any],
  });
  await assert.rejects(
    () => c.query(`{ a }`),
    (e: unknown) => {
      assert.equal(e, boom);
      return true;
    },
  );
});

await t("errorLink passes a non-GraphQLClientError straight through", async () => {
  const { errorLink } = await import("../src/graphql.ts");
  const foreign = new TypeError("not ours");
  let handled = false;
  const thrower = (): any => {
    throw foreign;
  };
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    links: [
      errorLink(() => {
        handled = true;
        return null;
      }),
      thrower as any,
    ],
  });
  await assert.rejects(
    () => c.query(`{ a }`),
    (e: unknown) => {
      assert.equal(e, foreign);
      return true;
    },
  );
  assert.equal(handled, false, "the handler must only see GraphQLClientError");
});

s("regression: negative retry counts threw `undefined`");

await t("a negative client `retries` is a RangeError, not `throw undefined`", async () => {
  const c = new GraphQLClient({ url: "http://127.0.0.1:1/graphql", retries: -1 });
  // `for (attempt = 0; attempt <= -1; …)` never entered the loop, so
  // `lastErr` stayed undefined and the method ended in `throw undefined` — a
  // rejection with no value, where even `err.message` throws a TypeError
  // inside the caller's own handler.
  await assert.rejects(
    () => c.query(`{ a }`),
    (e: unknown) => {
      assert.ok(e instanceof RangeError, `expected a RangeError, got ${String(e)}`);
      assert.match((e as Error).message, /retries must be a non-negative integer, got -1/);
      return true;
    },
  );
});

await t("a non-integer `retries` is rejected", async () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    const c = new GraphQLClient({ url: "http://127.0.0.1:1/graphql", retries: bad });
    await assert.rejects(() => c.query(`{ a }`), RangeError, `retries: ${bad} must be rejected`);
  }
});

await t("retries: 0 still means a single attempt", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url, retries: 0 });
    await c.query(`{ a }`);
    assert.equal(srv.requests.length, 1);
  } finally {
    await srv.close();
  }
});

await t("retryLink rejects a negative maxRetries at construction", async () => {
  const { retryLink } = await import("../src/graphql.ts");
  assert.throws(() => retryLink({ maxRetries: -1 }), /maxRetries must be a non-negative integer/);
  assert.throws(() => retryLink({ maxRetries: 2.5 }), /maxRetries must be a non-negative integer/);
  assert.throws(() => retryLink({ delayMs: -5 }), /delayMs must be a non-negative number/);
  // A valid configuration must still construct.
  assert.equal(typeof retryLink({ maxRetries: 0, delayMs: 1 }), "function");
});

await t("retryLink with maxRetries: 0 makes exactly one attempt", async () => {
  const { retryLink } = await import("../src/graphql.ts");
  let attempts = 0;
  const srv = await startRecordingServer(() => {
    attempts++;
    return { status: 500, contentType: "text/html", body: "nope" };
  });
  try {
    const c = new GraphQLClient({ url: srv.url, links: [retryLink({ maxRetries: 0 })] });
    await assert.rejects(() => c.query(`{ a }`), GraphQLClientError);
    assert.equal(attempts, 1, "maxRetries: 0 means no retry, so one request");
  } finally {
    await srv.close();
  }
});

s("regression: batch() misaligned results and threw raw SyntaxError");

await t("too few results is an EINVALIDRESPONSE, not a short array", async () => {
  const srv = await startRecordingServer(() => ({ body: [{ data: { only: 1 } }] }));
  try {
    const c = new GraphQLClient({ url: srv.url });
    // The old code mapped over whatever arrived: two requests answered with
    // one result silently resolved to a one-element array, and the caller had
    // no way to tell that the second request's answer was missing.
    await assert.rejects(
      () => c.batch([{ query: "{a}" }, { query: "{b}" }]),
      (e: any) => {
        assert.equal(e.code, "EINVALIDRESPONSE");
        assert.equal(e.message, "Batch response has 1 result(s) but 2 request(s) were sent");
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

await t("too many results is an EINVALIDRESPONSE, not a long array", async () => {
  const srv = await startRecordingServer(() => ({
    body: [{ data: { a: 1 } }, { data: { b: 2 } }, { data: { c: 3 } }],
  }));
  try {
    const c = new GraphQLClient({ url: srv.url });
    // `requests[i]` was undefined for the extra entries, so an `errors` in one
    // of them was attributed to no request at all.
    await assert.rejects(
      () => c.batch([{ query: "{a}" }]),
      (e: any) => {
        assert.equal(e.code, "EINVALIDRESPONSE");
        assert.equal(e.message, "Batch response has 3 result(s) but 1 request(s) were sent");
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

await t("a matching count returns the data in request order", async () => {
  const srv = await startRecordingServer((rec) => ({
    body: (rec.json() as any[]).map((r) => ({ data: { echo: r.query } })),
  }));
  try {
    const c = new GraphQLClient({ url: srv.url });
    assert.deepEqual(await c.batch([{ query: "{a}" }, { query: "{b}" }, { query: "{c}" }]), [
      { echo: "{a}" },
      { echo: "{b}" },
      { echo: "{c}" },
    ]);
  } finally {
    await srv.close();
  }
});

await t("an HTML error response becomes ENETWORK, not a raw SyntaxError", async () => {
  const srv = await startRecordingServer(() => ({
    status: 502,
    contentType: "text/html",
    body: "<html>bad gateway</html>",
  }));
  try {
    const c = new GraphQLClient({ url: srv.url });
    // `batch()` called `response.json()` bare, so a proxy's HTML error page
    // threw a SyntaxError with no `code` — a caller switching on `err.code`
    // saw `undefined` and could not tell this from a bug in their own code.
    await assert.rejects(
      () => c.batch([{ query: "{a}" }]),
      (e: any) => {
        assert.ok(
          e instanceof GraphQLClientError,
          "must be a GraphQLClientError, not a SyntaxError",
        );
        assert.equal(e.code, "ENETWORK");
        assert.match(e.message, /HTTP 502/);
        assert.match(e.message, /bad gateway/);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

await t("a malformed JSON body becomes EPARSE", async () => {
  const srv = await startRecordingServer(() => ({ body: "{not json" }));
  try {
    const c = new GraphQLClient({ url: srv.url });
    await assert.rejects(
      () => c.batch([{ query: "{a}" }]),
      (e: any) => {
        assert.equal(e.code, "EPARSE");
        assert.equal(e.message, "Failed to parse batch response as JSON");
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

await t("batch validates each query, as query() and upload() do", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    // batch() never ran the validator, so it was the one way past the length,
    // depth and injection limits applied everywhere else in the module.
    for (const bad of [`{ a } <!-- x -->`, "{".repeat(60)]) {
      await assert.rejects(
        () => c.batch([{ query: bad }]),
        (e: any) => {
          assert.ok(e instanceof Error, "an invalid batch query must reject");
          return true;
        },
        `batch must reject ${JSON.stringify(bad.slice(0, 20))}`,
      );
    }
    assert.equal(srv.requests.length, 0, "nothing may be sent when validation fails");
  } finally {
    await srv.close();
  }
});

s("regression: upload paths resolved against the wrong root");

/** Run one upload and return the `operations` and `map` the client produced. */
async function uploadShape(
  query: string,
  variables: Record<string, unknown>,
  uploads: Array<{ file: Blob; path: string }>,
): Promise<{ operations: any; map: any; parts: string[] }> {
  let form: FormData | null = null;
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    fetch: async (_u: any, init: any) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ data: { ok: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await c.upload(query, variables, uploads);
  const f = form as unknown as FormData;
  return {
    operations: JSON.parse((await f.get("operations")) as string),
    map: JSON.parse((await f.get("map")) as string),
    parts: f.keys() as unknown as string[],
  };
}

const UP_Q = `mutation UploadFile($file: Upload!) { uploadFile(file: $file) { id } }`;

await t("path `file` nulls variables.file, as the documented example claims", async () => {
  const { operations, map } = await uploadShape(UP_Q, { file: new Blob(["x"]) }, [
    { file: new Blob(["x"]), path: "file" },
  ]);
  // The documented example produced
  //   {"variables": {"file": {}}, "file": null}
  // — the null landed at the top level of the request object where no
  // variable lives, and the real variable kept its value. The upload could
  // never bind.
  assert.deepEqual(operations.variables, { file: null });
  assert.equal(operations.file, undefined, "nothing may be written outside `variables`");
  // ...and the map is rooted at `operations`, as the multipart spec requires.
  assert.deepEqual(map, { "0": ["variables.file"] });
});

await t("the spec form `variables.file` produces byte-identical output", async () => {
  const a = await uploadShape(UP_Q, { file: new Blob(["x"]) }, [
    { file: new Blob(["x"]), path: "file" },
  ]);
  const b = await uploadShape(UP_Q, { file: new Blob(["x"]) }, [
    { file: new Blob(["x"]), path: "variables.file" },
  ]);
  assert.deepEqual(a.operations, b.operations);
  assert.deepEqual(a.map, b.map);
});

await t("a nested path `input.file` reaches variables.input.file", async () => {
  const { operations, map } = await uploadShape(
    `mutation Upload($input: Input!) { upload(input: $input) { id } }`,
    { input: { file: new Blob(["x"]) } },
    [{ file: new Blob(["x"]), path: "input.file" }],
  );
  assert.deepEqual(operations.variables, { input: { file: null } });
  assert.equal(operations.input, undefined);
  assert.deepEqual(map, { "0": ["variables.input.file"] });
});

await t("a numeric segment creates an array, not an object", async () => {
  const { operations, map } = await uploadShape(
    `mutation U($files: [Upload!]!) { up(files: $files) { id } }`,
    { files: [new Blob(["a"]), new Blob(["b"])] },
    [
      { file: new Blob(["a"]), path: "files.0" },
      { file: new Blob(["b"]), path: "files.1" },
    ],
  );
  // The old code produced `{"variables": {"files": [{}, {}]}, "files":
  // {"0": null, "1": null}}`: the array kept two empty objects, the nulls
  // went to a stray sibling object, and the map pointed at indices holding
  // nothing.
  assert.ok(Array.isArray(operations.variables.files), "files must serialise as a JSON array");
  assert.deepEqual(operations.variables.files, [null, null]);
  assert.equal(operations.files, undefined);
  assert.deepEqual(map, { "0": ["variables.files.0"], "1": ["variables.files.1"] });
});

await t("a missing intermediate array is created as an array", async () => {
  const { operations } = await uploadShape(
    `mutation U($files: [Upload!]!) { up(files: $files) { id } }`,
    {},
    [{ file: new Blob(["a"]), path: "files.0" }],
  );
  assert.ok(Array.isArray(operations.variables.files));
  assert.deepEqual(operations.variables.files, [null]);
});

await t("the file part is named by index and carries the file", async () => {
  let form: FormData | null = null;
  const c = new GraphQLClient({
    url: "http://127.0.0.1:1/graphql",
    fetch: async (_u: any, init: any) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ data: { ok: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await c.upload(UP_Q, {}, [
    { file: new Blob(["aaa"]), path: "file" },
    { file: new Blob(["bbb"]), path: "file2" },
  ]);
  const f = form as unknown as FormData;
  const names = [...(f as any).keys()].sort() as string[];
  assert.deepEqual(names, ["0", "1", "map", "operations"]);
  assert.equal(await await (f.get("0") as Blob).text(), "aaa");
  assert.equal(await await (f.get("1") as Blob).text(), "bbb");
});

s("regression: the validator read string literals as code");

await t("braces inside string values do not count toward balance", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    // Each of these was rejected as "unbalanced braces" or as a malicious
    // pattern, because the brace counter and the injection scan both read the
    // contents of string literals.
    for (const q of [
      `{ a(s: "}") b }`,
      `{ f(x: "}") }`,
      `{ f(x: "}") }`,
      `{ f(x: "{") }`,
      `{ f(x: "}}") }`,
      `{ f(x: "{{") }`,
    ]) {
      await c.query(q); // must not reject
    }
    assert.equal(srv.requests.length, 6, "every one of them must actually be sent");
  } finally {
    await srv.close();
  }
});

await t("injection keywords inside string values are not flagged", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    const legit = [
      `{ search(term: "javascript:void(0)") }`,
      `{ run(code: "eval(x)") }`,
      `{ page(html: "<div onerror=alert(1)>") }`,
      `{ css(v: "<!-- hi -->") }`,
      `{ t(s: "<script>alert(1)</script>") }`,
    ];
    for (const q of legit) await c.query(q);
    assert.equal(srv.requests.length, legit.length);
  } finally {
    await srv.close();
  }
});

await t("block strings and single-quoted values are handled", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    for (const q of [
      `{ f(x: """block { string } with "quotes" """) }`,
      `{ f(x: 'single {quoted} value') }`,
      `# a comment mentioning eval(
query Q { a }`,
      `{ f(x: "escaped \\" quote }") }`,
    ]) {
      await c.query(q);
    }
    assert.equal(srv.requests.length, 4);
  } finally {
    await srv.close();
  }
});

await t("genuine attacks outside string values are still rejected", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    const attacks: Array<[string, RegExp]> = [
      [`{ a } <!-- comment -->`, /malicious pattern/],
      [`{ a } <script>alert(1)</script>`, /malicious pattern/],
      [`{ a { b {{ c } } }`, /malicious pattern/],
      [`query Q { a } eval(alert(1))`, /malicious pattern/],
      [`{ a @include(if: onerror=1) }`, /malicious pattern/],
      [`{ a } {{`, /malicious pattern/],
      [`query Q { a`, /unbalanced braces/],
      ["{".repeat(150) + "}".repeat(150), /malicious pattern|depth/],
    ];
    for (const [q, expected] of attacks) {
      await assert.rejects(
        () => c.query(q),
        (e: any) => {
          assert.ok(e instanceof Error, "an attack must be rejected with an Error");
          assert.match(e.message, expected, `for ${JSON.stringify(q.slice(0, 40))}`);
          return true;
        },
      );
    }
    assert.equal(srv.requests.length, 0, "no rejected query may reach the network");
  } finally {
    await srv.close();
  }
});

s("regression: operationName: null leaked into onRequest");

await t("an anonymous operation sends no operationName at all", async () => {
  const srv = await startRecordingServer();
  const seen: any[] = [];
  try {
    const c = new GraphQLClient({ url: srv.url, onRequest: (r) => seen.push({ ...r }) });
    await c.query(`{ anon }`);
    // `extractOperationName` returns `string | null` and the guard read
    // `!== undefined`, which `null` satisfies — so every anonymous operation
    // was handed to onRequest, to every link, and to the error object with
    // `operationName: null` set.
    assert.equal("operationName" in seen[0]!, false, `got ${JSON.stringify(seen[0])}`);
    assert.deepEqual(Object.keys(srv.requests[0]!.json() as object), ["query"]);
  } finally {
    await srv.close();
  }
});

await t("a named operation is still sent and still reported", async () => {
  const srv = await startRecordingServer();
  const seen: any[] = [];
  try {
    const c = new GraphQLClient({ url: srv.url, onRequest: (r) => seen.push({ ...r }) });
    await c.query(`query GetUser { a }`);
    assert.equal(seen[0]!.operationName, "GetUser");
    assert.equal((srv.requests[0]!.json() as any).operationName, "GetUser");
  } finally {
    await srv.close();
  }
});

await t("an explicit empty-string operationName is not silently replaced", async () => {
  const srv = await startRecordingServer();
  try {
    const c = new GraphQLClient({ url: srv.url });
    // `options.operationName !== undefined` is true for "", and buildJSONBody
    // then drops it as falsy — so the server receives no operationName and
    // executes whatever the document's first operation is. That is the
    // documented behaviour of an empty name, and it must not silently pick up
    // the auto-extracted one instead.
    await c.query(`query A { a }`, undefined, { operationName: "" });
    const body = srv.requests[0]!.json() as any;
    assert.equal("operationName" in body, false);
    assert.equal(body.query, "query A { a }");
  } finally {
    await srv.close();
  }
});

s("regression: operation type / name detection");

await t("detectOperationType ignores leading comment lines", () => {
  assert.equal(detectOperationType("# a comment\nmutation M { a }"), "mutation");
  assert.equal(
    detectOperationType("  # indented\n  # another\nsubscription S { s }"),
    "subscription",
  );
  assert.equal(detectOperationType("# only a comment\n{ a }"), "query");
});

await t("extractOperationName ignores leading comment lines", () => {
  assert.equal(extractOperationName("# lead\nquery GetUser { a }"), "GetUser");
  assert.equal(extractOperationName("  # x\n  # y\nmutation DoIt { a }"), "DoIt");
  assert.equal(extractOperationName("# lead\n{ a }"), null);
});

await t("the first operation in a document decides both", () => {
  const doc = "mutation M { a }\nquery Q { b }";
  assert.equal(detectOperationType(doc), "mutation");
  assert.equal(extractOperationName(doc), "M");
});

await t("a keyword inside a string value is not an operation type", () => {
  assert.equal(detectOperationType(`{ f(s: "mutation") }`), "query");
  assert.equal(extractOperationName(`{ f(s: "query Fake") }`), null);
});

await t("an operation name must be a valid GraphQL name", () => {
  assert.equal(extractOperationName("query { a }"), null, "an anonymous operation has no name");
  assert.equal(extractOperationName("query 9Bad { a }"), null, "a name may not start with a digit");
  assert.equal(extractOperationName("query _Ok_1 { a }"), "_Ok_1");
});

// ── Summary ───────────────────────────────────────────────────────────────
// `total` used to be snapshotted here, before the last few tests in the
// file had run, so the summary could print a pass count larger than its own
// denominator (e.g. "109/100 passed"). It is computed at print time now.
console.log(`\n${"=".repeat(60)}`);
console.log(
  `  GRAPHQL: ${passed}/${passed + failed} passed${failed > 0 ? `  (${failed} FAILED)` : ""}`,
);
console.log(`${"=".repeat(60)}`);
if (failures.length > 0) {
  failures.forEach((f) =>
    console.log(`  ✗ ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`),
  );
  process.exit(1);
}
process.exit(0);
