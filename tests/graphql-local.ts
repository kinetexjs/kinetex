import { createServer, type Server } from "node:http";

/**
 * A local stand-in for the four public GraphQL endpoints tests/graphql.test.mts
 * was written against: countries.trevorblades.com, the Rick and Morty API,
 * GraphQLZero, and (formerly) SpaceX.
 *
 * Rick and Morty in particular is rate-limited and intermittently 5xxs, which
 * is why those tests were annotated "tests pass when available" and guarded with
 * `if (r)` — a test that cannot fail. The fixtures below are small, fixed, and
 * answer every query the suite sends, so the assertions can be exact again.
 *
 * Responses are complete objects rather than projections of the selection set.
 * The client reads the fields it asked for, and projecting would mean writing a
 * parser for the query document — the one part of GraphQL this fixture exists to
 * avoid.
 */

export const GRAPHQL_LOCAL_PORT = 18082;
export const GRAPHQL_LOCAL_ORIGIN = `http://127.0.0.1:${GRAPHQL_LOCAL_PORT}`;

/** One path per upstream endpoint, so no hostname appears in the suite. */
export const COUNTRIES_URL = `${GRAPHQL_LOCAL_ORIGIN}/graphql`;
export const RICKMORTY_URL = `${GRAPHQL_LOCAL_ORIGIN}/graphql/rickandmorty`;
export const GQLZERO_URL = `${GRAPHQL_LOCAL_ORIGIN}/graphql/graphqlzero`;

// ── countries.trevorblades.com ────────────────────────────────────────────

const COUNTRIES: Record<string, Record<string, unknown>> = {
  US: {
    code: "US",
    name: "United States",
    native: "United States",
    phone: "1",
    capital: "Washington D.C.",
    currency: "USD",
    emoji: "🇺🇸",
    emojiU: "US",
    continent: "NA",
    awsRegion: "us-east-1",
    languages: [{ code: "en", name: "English", native: "English" }],
    currencies: [{ code: "USD", name: "United States dollar", symbol: "$" }],
    states: [{ code: "CA", name: "California" }],
    subdivisions: [{ code: "CA", name: "California" }],
  },
  DE: {
    code: "DE",
    name: "Germany",
    native: "Deutschland",
    phone: "49",
    capital: "Berlin",
    currency: "EUR",
    emoji: "🇩🇪",
    emojiU: "DE",
    continent: "EU",
    awsRegion: "eu-central-1",
    languages: [{ code: "de", name: "German", native: "Deutsch" }],
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    states: [{ code: "BE", name: "Berlin" }],
    subdivisions: [{ code: "BE", name: "Berlin" }],
  },
  JP: {
    code: "JP",
    name: "Japan",
    native: "日本",
    phone: "81",
    capital: "Tokyo",
    currency: "JPY",
    emoji: "🇯🇵",
    emojiU: "JP",
    continent: "AS",
    awsRegion: "ap-northeast-1",
    languages: [{ code: "ja", name: "Japanese", native: "日本語" }],
    currencies: [{ code: "JPY", name: "Japanese yen", symbol: "¥" }],
    states: [{ code: "13", name: "Tokyo" }],
    subdivisions: [{ code: "13", name: "Tokyo" }],
  },
  MX: {
    code: "MX",
    name: "Mexico",
    native: "México",
    phone: "52",
    capital: "Mexico City",
    currency: "MXN",
    emoji: "🇲🇽",
    emojiU: "MX",
    continent: "NA",
    awsRegion: "na-central-1",
    languages: [{ code: "es", name: "Spanish", native: "Español" }],
    currencies: [{ code: "MXN", name: "Mexican peso", symbol: "$" }],
    states: [{ code: "CMX", name: "Ciudad de México" }],
    subdivisions: [{ code: "CMX", name: "Ciudad de México" }],
  },
  FR: {
    code: "FR",
    name: "France",
    native: "France",
    phone: "33",
    capital: "Paris",
    currency: "EUR",
    emoji: "🇫🇷",
    emojiU: "FR",
    continent: "EU",
    awsRegion: "eu-west-3",
    languages: [{ code: "fr", name: "French", native: "français" }],
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    states: [{ code: "IDF", name: "Île-de-France" }],
    subdivisions: [{ code: "IDF", name: "Île-de-France" }],
  },
};

// ── Rick and Morty ────────────────────────────────────────────────────────

const EPISODES = Array.from({ length: 12 }, (_, i) => ({
  id: `EPISODE_${i + 1}`,
  episode: `S1E${i + 1}`,
  name: `Episode ${i + 1}`,
  airDate: "2013-12-01",
}));

interface Character {
  id: string;
  name: string;
  species: string;
  status: string;
  type: string;
  gender: string;
  origin: { name: string; url: string };
  location: { name: string; url: string };
  episode: typeof EPISODES;
}

const CHARACTERS: Record<string, Character> = {
  "1": {
    id: "1",
    name: "Rick Sanchez",
    species: "Human",
    status: "Alive",
    type: "",
    gender: "Male",
    origin: { name: "Earth (C-137)", url: "" },
    location: { name: "Earth (C-137)", url: "" },
    episode: EPISODES,
  },
  "2": {
    id: "2",
    name: "Morty Smith",
    species: "Human",
    status: "Alive",
    type: "",
    gender: "Male",
    origin: { name: "Earth (C-137)", url: "" },
    location: { name: "Earth (C-137)", url: "" },
    episode: EPISODES,
  },
  "3": {
    id: "3",
    name: "Summer Smith",
    species: "Human",
    status: "Alive",
    type: "",
    gender: "Female",
    origin: { name: "Earth (C-137)", url: "" },
    location: { name: "Earth (C-137)", url: "" },
    episode: EPISODES,
  },
  "4": {
    id: "4",
    name: "Beth Smith",
    species: "Human",
    status: "Alive",
    type: "",
    gender: "Female",
    origin: { name: "Earth (C-137)", url: "" },
    location: { name: "Earth (C-137)", url: "" },
    episode: EPISODES,
  },
  "5": {
    id: "5",
    name: "Jerry Smith",
    species: "Human",
    status: "Alive",
    type: "",
    gender: "Male",
    origin: { name: "Earth (C-137)", url: "" },
    location: { name: "Earth (C-137)", url: "" },
    episode: EPISODES,
  },
  "6": {
    id: "6",
    name: "Abadango Cluster Princess",
    species: "Alien",
    status: "Alive",
    type: "",
    gender: "Female",
    origin: { name: "Abadango Cluster", url: "" },
    location: { name: "Abadango Cluster", url: "" },
    episode: [],
  },
};

/** `characters { results { ... } }` must return at least ten. */
const CHARACTER_LIST = [
  ...Object.values(CHARACTERS),
  ...Array.from({ length: 6 }, (_, i) => ({
    ...CHARACTERS["1"]!,
    id: String(i + 7),
    name: `Extra Character ${i + 7}`,
  })),
];

// ── GraphQLZero ───────────────────────────────────────────────────────────

interface ZeroUser {
  id: string;
  name: string;
  username: string;
  email: string;
}

const ZERO_USERS: Record<string, ZeroUser> = {
  "1": { id: "1", name: "Leanne Graham", username: "Bret", email: "Sincere@april.biz" },
  "2": { id: "2", name: "Ervin Howell", username: "Antonette", email: "Shanna@melissa.tv" },
};

const ZERO_POSTS = [
  { id: "1", title: "sunt aut facere repellat", user: ZERO_USERS["1"] },
  { id: "2", title: "qui est esse", user: ZERO_USERS["1"] },
  { id: "3", title: "ea molestias quasi exercitationem", user: ZERO_USERS["2"] },
];

// ── Introspection ─────────────────────────────────────────────────────────

const SCALARS = ["String", "Int", "Float", "Boolean", "ID"].map((name) => ({
  kind: "SCALAR",
  name,
  description: null,
  fields: null,
  inputFields: null,
  interfaces: null,
  enumValues: null,
  possibleTypes: null,
}));

/** The four built-in directives, with the locations and args the spec fixes. */
const DIRECTIVES = [
  {
    name: "include",
    description:
      "Directs the executor to include this field or fragment only when the `if` argument is true.",
    locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"],
    args: [
      {
        name: "if",
        description: "Included when true.",
        type: {
          kind: "NON_NULL",
          name: null,
          ofType: { kind: "SCALAR", name: "Boolean", ofType: null },
        },
        defaultValue: null,
      },
    ],
  },
  {
    name: "skip",
    description:
      "Directs the executor to skip this field or fragment when the `if` argument is true.",
    locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"],
    args: [
      {
        name: "if",
        description: "Skipped when true.",
        type: {
          kind: "NON_NULL",
          name: null,
          ofType: { kind: "SCALAR", name: "Boolean", ofType: null },
        },
        defaultValue: null,
      },
    ],
  },
  {
    name: "deprecated",
    description: "Marks an element of a GraphQL schema as no longer supported.",
    locations: ["FIELD_DEFINITION", "ENUM_VALUE"],
    args: [
      {
        name: "reason",
        description: "Why the element was deprecated.",
        type: { kind: "SCALAR", name: "String", ofType: null },
        defaultValue: '"No longer supported"',
      },
    ],
  },
  {
    name: "specifiedBy",
    description: "Exposes a URL that specifies the behaviour of this scalar.",
    locations: ["SCALAR"],
    args: [
      {
        name: "url",
        description: "The URL that specifies the behaviour.",
        type: {
          kind: "NON_NULL",
          name: null,
          ofType: { kind: "SCALAR", name: "String", ofType: null },
        },
        defaultValue: null,
      },
    ],
  },
];

function obj(name: string, fields: Array<[string, string]>): Record<string, unknown> {
  return {
    kind: "OBJECT",
    name,
    description: null,
    interfaces: [],
    possibleTypes: null,
    enumValues: null,
    inputFields: null,
    // `isDeprecated` and `deprecationReason` are present on every field: the
    // suite asserts both exist, and omitting them made the check pass for a
    // server that simply never deprecates anything.
    fields: fields.map(([field, type]) => ({
      name: field,
      description: null,
      type: { kind: "SCALAR", name: type, ofType: null },
      isDeprecated: false,
      deprecationReason: null,
      args: [],
    })),
  };
}

/** The Countries schema, matching the 15 fields the suite pins by name. */
const COUNTRIES_INTROSPECTION = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: null,
    subscriptionType: null,
    types: [
      obj("Query", [
        ["countries", "String"],
        ["country", "Country"],
        ["continent", "String"],
      ]),
      obj("Country", [
        ["code", "String"],
        ["name", "String"],
        ["native", "String"],
        ["phone", "String"],
        ["phones", "String"],
        ["continent", "String"],
        ["capital", "String"],
        ["currency", "String"],
        ["currencies", "String"],
        ["languages", "String"],
        ["emoji", "String"],
        ["emojiU", "String"],
        ["awsRegion", "String"],
        ["states", "String"],
        ["subdivisions", "String"],
      ]),
      ...SCALARS,
      {
        kind: "ENUM",
        name: "Currency",
        description: null,
        fields: null,
        inputFields: null,
        interfaces: null,
        enumValues: [],
        possibleTypes: null,
      },
    ],
    directives: DIRECTIVES,
  },
};

/** Rick and Morty: the suite only asserts `types.length > 10`. */
const RICKMORTY_INTROSPECTION = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: null,
    subscriptionType: null,
    types: [
      obj("Query", [
        ["character", "Character"],
        ["characters", "Characters"],
        ["episode", "Episode"],
        ["episodes", "Episodes"],
        ["location", "Location"],
        ["locations", "Locations"],
      ]),
      obj("Character", [
        ["id", "ID"],
        ["name", "String"],
        ["status", "String"],
        ["species", "String"],
        ["type", "String"],
        ["gender", "String"],
        ["origin", "Location"],
        ["location", "Location"],
        ["episode", "Episode"],
      ]),
      obj("Characters", [
        ["info", "Info"],
        ["results", "Character"],
      ]),
      obj("Episodes", [
        ["info", "Info"],
        ["results", "Episode"],
      ]),
      obj("Locations", [
        ["info", "Info"],
        ["results", "Location"],
      ]),
      obj("Episode", [
        ["id", "ID"],
        ["name", "String"],
        ["episode", "String"],
        ["airDate", "String"],
        ["characters", "Character"],
      ]),
      obj("Location", [
        ["id", "ID"],
        ["name", "String"],
        ["dimension", "String"],
      ]),
      obj("Info", [
        ["count", "Int"],
        ["pages", "Int"],
        ["next", "String"],
        ["prev", "String"],
      ]),
      obj("PageInfo", [
        ["count", "Int"],
        ["current", "String"],
        ["pages", "Int"],
      ]),
      obj("Filter", [["name", "String"]]),
      obj("CharacterConnection", [
        ["pageInfo", "PageInfo"],
        ["edges", "String"],
      ]),
      ...SCALARS,
    ],
    directives: DIRECTIVES,
  },
};

const GQLZERO_INTROSPECTION = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    subscriptionType: null,
    types: [
      obj("Query", [
        ["user", "User"],
        ["users", "Users"],
        ["post", "Post"],
        ["posts", "Posts"],
      ]),
      obj("Mutation", [
        ["addPost", "Post"],
        ["updatePost", "Post"],
        ["deletePost", "Post"],
      ]),
      obj("User", [
        ["id", "ID"],
        ["name", "String"],
        ["username", "String"],
        ["email", "String"],
      ]),
      obj("Users", [
        ["info", "Info"],
        ["data", "User"],
      ]),
      obj("Post", [
        ["id", "ID"],
        ["title", "String"],
        ["body", "String"],
        ["user", "User"],
      ]),
      obj("Posts", [
        ["info", "Info"],
        ["data", "Post"],
      ]),
      obj("Info", [
        ["count", "Int"],
        ["pages", "Int"],
        ["next", "String"],
        ["prev", "String"],
      ]),
      obj("Comment", [
        ["id", "ID"],
        ["body", "String"],
      ]),
      obj("Comments", [
        ["info", "Info"],
        ["data", "Comment"],
      ]),
      ...SCALARS,
    ],
    directives: DIRECTIVES,
  },
};

// ── Resolution ────────────────────────────────────────────────────────────

function variables(body: Record<string, unknown>): Record<string, unknown> {
  return (body["variables"] as Record<string, unknown>) ?? {};
}

/**
 * Reads the argument of `name(...)`, whether it arrives as a bound variable or
 * an inline literal.
 *
 * The suite sends both forms, and literals are not always quoted —
 * `character(id: 1)` and `country(code: "US")` both occur. Matching only
 * `name($var)` left every unquoted lookup falling back, and the first fallback
 * that happened to be wrong resolved character 2 to null.
 */
function arg(query: string, name: string, vars: Record<string, unknown>, fallback: string): string {
  const bound = query.match(new RegExp(`${name}\\s*\\([^)]*\\$([A-Za-z_][A-Za-z0-9_]*)`));
  if (bound?.[1] !== undefined && vars[bound[1]] !== undefined) return String(vars[bound[1]]);

  // A `$var` reference is not an inline literal: without this guard the
  // pattern captured the literal text "$id", which then missed the table and
  // resolved character 3 to null.
  const literal = query.match(
    new RegExp(`${name}\\s*\\([^)]*?(?:code|id)\\s*:\\s*"?([^"\\s,)]+)"?`),
  );
  if (literal?.[1] !== undefined && !literal[1].startsWith("$")) return literal[1];
  return fallback;
}

function resolve(
  schema: "countries" | "rickandmorty" | "graphqlzero",
  query: string,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  if (schema === "countries") {
    if (/\bcountries\b/.test(query)) return { countries: Object.values(COUNTRIES) };
    if (/\bcountry\b/.test(query)) {
      const code = arg(query, "country", vars, "US");
      return { country: COUNTRIES[code] ?? COUNTRIES["US"]! };
    }
    return { query: "ok" };
  }

  if (schema === "rickandmorty") {
    if (/\bcharacters\b/.test(query)) {
      return {
        characters: {
          info: { count: CHARACTER_LIST.length, pages: 1, next: null, prev: null },
          results: CHARACTER_LIST,
        },
      };
    }
    if (/\bcharacter\b/.test(query)) {
      const id = arg(query, "character", vars, "1");
      return { character: CHARACTERS[id] ?? null };
    }
    return { query: "ok" };
  }

  // Matched as `<name>(` or `<name> {`, not as a bare word anywhere: `user`
  // also occurs as a *nested field* inside `post { ... user { name } }`, so
  // testing for the word on its own resolved a `post` query through the `user`
  // resolver and returned `{ user: ... }`.
  if (/\bposts\b\s*[({]/.test(query))
    return {
      posts: {
        info: { count: ZERO_POSTS.length, pages: 1, next: null, prev: null },
        data: ZERO_POSTS,
      },
    };
  if (/\bpost\s*\(/.test(query)) {
    const id = arg(query, "post", vars, "1");
    return { post: ZERO_POSTS.find((p) => p.id === id) ?? ZERO_POSTS[0]! };
  }
  if (/\busers\b\s*[({]/.test(query))
    return {
      users: {
        info: { count: 2, pages: 1, next: null, prev: null },
        data: Object.values(ZERO_USERS),
      },
    };
  if (/\buser\s*\(/.test(query)) {
    return { user: ZERO_USERS[arg(query, "user", vars, "1")] ?? ZERO_USERS["1"]! };
  }
  return { query: "ok" };
}

function isIntrospection(query: string): boolean {
  return /__schema|__type\b/.test(query);
}

/** The first field selected on the operation's root type. */
function rootField(query: string): string | undefined {
  return query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

/** Root fields each schema exposes, so an unknown one can be rejected. */
const ROOT_FIELDS: Record<string, Set<string>> = {
  countries: new Set(["country", "countries", "continent"]),
  rickandmorty: new Set([
    "character",
    "characters",
    "episode",
    "episodes",
    "location",
    "locations",
  ]),
  graphqlzero: new Set(["user", "users", "post", "posts", "comment", "comments"]),
};

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function handle(pathname: string, bodyText: string, queryFromUrl: URLSearchParams): string {
  const body = safeParse(bodyText);
  const query = String(body["query"] ?? queryFromUrl.get("query") ?? "");
  // A GET carries its variables in `?variables=`, not in a body, and that
  // parameter *is* the variables map (not a wrapper containing one). Reading
  // only the body left every `useGETForQueries` variable unbound, so the lookup
  // silently fell back and returned character 1 for a query asking for 3.
  const bodyVars = variables(body);
  const urlVars = safeParse(queryFromUrl.get("variables") ?? "");
  const vars = Object.keys(bodyVars).length > 0 ? bodyVars : urlVars;

  const schema =
    pathname === "/graphql/rickandmorty"
      ? "rickandmorty"
      : pathname === "/graphql/graphqlzero"
        ? "graphqlzero"
        : "countries";

  if (isIntrospection(query)) {
    // Introspection is a normal query: the payload goes under `data`, which is
    // what every client unwraps. Returning `__schema` at the top level reads as
    // "Response contained no data" and fails the whole introspection surface.
    const schema_ =
      schema === "rickandmorty"
        ? RICKMORTY_INTROSPECTION
        : schema === "graphqlzero"
          ? GQLZERO_INTROSPECTION
          : COUNTRIES_INTROSPECTION;
    return JSON.stringify({ data: schema_ });
  }

  // An unknown root field is a validation error, not an empty result. The suite
  // sends `{ nonexistent }` to exercise GraphQLClientError and the non-throwing
  // `raw()` path, and both need a real `errors` payload with no `data` key.
  const root = rootField(query);
  if (root !== undefined && !ROOT_FIELDS[schema].has(root)) {
    return JSON.stringify({
      errors: [{ message: `Cannot query field "${root}" on type "Query".` }],
    });
  }
  return JSON.stringify({ data: resolve(schema, query, vars) });
}

let server: Server | undefined;
let starting: Promise<Server> | undefined;

/** Starts the fixture if it is not already up. Idempotent and race-free. */
export function graphqlServer(): Promise<Server> {
  if (starting !== undefined) return starting;
  starting = new Promise<Server>((resolve, reject) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", GRAPHQL_LOCAL_ORIGIN);
        const text = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(handle(url.pathname, text, url.searchParams));
      });
    });
    // Never hold the process open on the server's account.
    s.unref();
    s.once("error", reject);
    s.listen(GRAPHQL_LOCAL_PORT, "127.0.0.1", () => {
      server = s;
      resolve(s);
    });
  });
  return starting;
}

// Started on import, so a suite only has to import the URLs and use them.
void graphqlServer();

export function stopLocalGraphql(): void {
  server?.close();
  server = undefined;
  starting = undefined;
}
