/**
 * live-network.test.mts — makes third-party uptime a visible, deliberate thing.
 *
 * A test suite whose result depends on somebody else's server is not a safety
 * net: it goes red for reasons that have nothing to do with the code under test
 * and, worse, it goes *green* for them too. During the work that produced this
 * file, a single session recorded two failures that were pure third-party
 * noise — httpbin.org returning a 502, and echo.websocket.org closing with
 * 1006 — while the same files passed on the next run. A suite that produces
 * that signal gets ignored, and an ignored suite is worse than no suite.
 *
 * kinetex already ships `tests/httpbin-local.ts`, a dependency-free local
 * server covering the endpoints these suites use. This file does not force the
 * migration on its own — a handful of tests genuinely want a real, public
 * origin, and a few exercise behaviour a local stub cannot reproduce (real
 * ALPN, real DNS, a third-party's redirect behaviour). It instead:
 *
 *   1. Records which files still reach the public internet, so the remaining
 *      work is countable rather than a feeling.
 *   2. Fails when a *new* file starts depending on a live host, which stops
 *      the number from growing while the existing ones are converted.
 *   3. Proves the local server can satisfy the endpoints the migrated suites
 *      rely on, so "just point it at localhost" stays a real option.
 *
 * Once every file below is converted this becomes an allowlist of zero and the
 * suite can assert `expectations.length === 0` outright.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), "utf8");

/**
 * Files still pointed at a live third-party host, and why each is allowed to
 * stay for now.
 *
 * Adding an entry is a decision, not a convenience: the `reason` is what a
 * reviewer reads when asking why this suite can fail for someone else's reasons.
 * Prefer converting the file and deleting the entry over extending it.
 */
const KNOWN_LIVE: Record<string, string> = {};

/** Hosts that mean "somebody else's uptime". */
const LIVE_HOST = /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;

/**
 * A real third-party host appearing in a `baseURL` position.
 *
 * Narrower than "the string appears anywhere": a URL passed to something with an
 * injected `fetch`, or used as inert string data for redaction and template
 * assertions, is never dialled and must not count. Constructing a client against
 * a public origin is the thing that actually makes a file live-dependent.
 */
const PUBLIC = String.raw`https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}`;
const LIVE_BASE = new RegExp(
  String.raw`kinetex\(\s*\{[^}]*baseURL:\s*["'\`]` +
    PUBLIC +
    String.raw`|\.(get|post|put|patch|delete|head)\(\s*["'\`]` +
    PUBLIC +
    String.raw`|new GraphQLClient\(\s*\{[^}]*url:\s*["'\`]` +
    PUBLIC +
    // A transport driven directly: `new FetchTransport().send({ url })` dials
    // the public origin exactly as a client would. This pattern was missing, and
    // `core-unit.test.mts` held a dozen such calls — including two that dialled
    // cloudflare.com and google.com — while the guard reported the suite clean.
    String.raw`|(send|raw)\(\s*\{[^}]*url:\s*["'\`]` +
    PUBLIC,
  "is",
);

/** Fake origins used as fixtures; reaching them is fine because nothing does. */
const FIXTURE_HOST =
  /https?:\/\/(?:[a-z0-9-]+\.)*(example\.(?:com|test|invalid|org|net)|[a-z0-9]+\.test|localhost|127\.0\.0\.1)/i;

/**
 * Hosts that cannot resolve to a real server, whatever the TLD looks like.
 *
 * `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24` are TEST-NET-1/2/3,
 * reserved for documentation and never routed. A test that dials one is
 * asserting on a *failure* — a DNS or block decision — and is not a live
 * dependency, even though the address is globally routable in shape.
 */
const NON_ROUTABLE = /https?:\/\/(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/i;

/**
 * RFC 2606 / RFC 6761 reserved TLDs, which can never resolve.
 *
 * `.example` is the canonical one and is not covered by the fixture regex,
 * which lists `example.com` and friends — a test written against
 * `https://rebind.example/` is naming a placeholder, not a server.
 */
const RESERVED_TLD = /https?:\/\/(?:[a-z0-9-]+\.)*(?:example|invalid|local|test)(?![a-z0-9-])/i;

/**
 * Every brace-balanced `{ ... }` block following each occurrence of `open`.
 *
 * A regex window cannot do this: the configs run from one line to forty, and a
 * fixed-width match either truncates a large one or runs into the next.
 */
function balancedObjects(body: string, open: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(open.source, open.flags.includes("g") ? open.flags : `${open.flags}g`);
  let match: RegExpExecArray | null;
  let resume = 0;
  while ((match = re.exec(body)) !== null) {
    const i = match.index;
    resume = re.lastIndex;
    const start = body.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    for (let j = start; j < body.length; j++) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") {
        depth--;
        if (depth === 0) {
          out.push(body.slice(start, j + 1));
          resume = j + 1;
          break;
        }
      }
    }
    re.lastIndex = Math.max(resume, i + 1);
    if (depth !== 0) break;
  }
  return out;
}

/**
 * True when the file actually dials a third-party origin.
 *
 * A public `baseURL` alone is not enough: a client constructed against
 * `https://s3.amazonaws.com` or `https://sse.example.com` with an injected
 * `fetch` never opens a connection — the host is a fixture for signing or for
 * asserting on the URL. Only a config that would be dialled counts.
 */
function isLive(body: string): boolean {
  // Strip the same non-routable names here as in `directText` below. The SSRF
  // tests dial deliberately hostile hosts such as `1.2.3.4.5.evil.example`,
  // and an RFC 2606 reserved name can never resolve to anything — so a
  // `.example` URL is not a live call, and treating it as one makes the gate
  // report the very suite that proves the screen works as a leak.
  const withoutFixtures = code(body)
    .replace(new RegExp(FIXTURE_HOST.source, "gi"), "")
    .replace(new RegExp(NON_ROUTABLE.source, "gi"), "")
    .replace(new RegExp(RESERVED_TLD.source, "gi"), "");
  // A raw transport dialled from inside a test body is checked first, against
  // text that still has the bodies. This cannot be folded into the checks
  // below: they all run on `code()`, which has already removed the body.
  const directText = codeWithBodies(body)
    .replace(new RegExp(FIXTURE_HOST.source, "gi"), "")
    .replace(new RegExp(NON_ROUTABLE.source, "gi"), "")
    .replace(new RegExp(RESERVED_TLD.source, "gi"), "");
  if (DIRECT_DIAL.test(directText)) return true;
  // `baseURL` must NOT gate this block. A file can dial with `client.send(url)`
  // or `gql(url)` and configure no client at all — which is what
  // `negative.test.mts` and both runtime suites did while this gate reported
  // them clean, because the whole check sat behind "the file mentions a
  // `baseURL:`". Deciding on `baseURL` is the config loop's job, further down.
  if (!LIVE_HOST.test(withoutFixtures)) return false;

  // What makes a public host live is the shape that issues a request.
  const dials =
    /\.(?:get|post|put|patch|delete|head|send|fetch)\(\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      withoutFixtures,
    ) ||
    // The URL inside a request object rather than as the first argument:
    // `transport.send({ url: "https://httpbin.org/get" })`. This is how the
    // raw transports are driven directly, and it was the shape
    // `core-unit.test.mts` used for a dozen live calls while this gate
    // reported the suite clean.
    /\.(?:send|raw|request)\(\s*\{[^}]*\burl:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      withoutFixtures,
    ) ||
    // A paginator takes its URL in a config object, not from a client, so it
    // has no `baseURL` anywhere for the check above to hang off.
    /createPagePaginator(?:<[^>]*>)?\(\s*\{[^}]*\burl:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      withoutFixtures,
    ) ||
    // `gql(url, query)` is a standalone helper — it constructs its own client,
    // so again there is no `baseURL` in the file to find.
    /\bgql(?:<[^>]*>)?\(\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(withoutFixtures) ||
    /new SSEClient\(\s*\{[^}]*\burl:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      withoutFixtures,
    ) ||
    /new GraphQLClient\(/.test(withoutFixtures);
  if (dials) return true;
  // A `url:` field inside an object that is not a client or a request is a
  // fixture — awssigv4 hashes one as a signing target and never sends it, and
  // `RemoteTransport` is handed a stubbed `fetch`. Both are handled by shape
  // below rather than by requiring a `baseURL` to be present somewhere.
  if (!/baseURL:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(withoutFixtures)) {
    return false;
  }

  // If every client naming a public origin also injects `fetch`, nothing is
  // dialled. Counting the two is crude but errs toward flagging, never toward
  // silently clearing a genuinely live suite.
  // A config that injects `fetch` is never dialled — awssigv4 signs against
  // s3.amazonaws.com with a stubbed fetch, which is why an earlier version of
  // this check kept it on the list forever.
  for (const c of balancedObjects(withoutFixtures, /(?:new\s+)?[Kk]inetex\s*\(/)) {
    if (/baseURL:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(c) && !/\bfetch\s*:/.test(c)) {
      return true;
    }
  }
  if (
    /new GraphQLClient\(\s*\{[^}]*url:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(
      withoutFixtures,
    )
  ) {
    return true;
  }
  // A public host that only ever appears as a URL the client must *refuse* is
  // not a dependency — that assertion needs the name to be dialable-looking.
  return /["'`]https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}[^"'`]*["'`][^;]{0,120}?(EBLOCKEDHOST|EVALIDATION|blocked|refus|reject)/i.test(
    withoutFixtures,
  );
}

/**
 * The file with comments and string literals of other hosts removed.
 *
 * A live host inside a comment is documentation, not a dependency — and a
 * suite that merely explains *why* another suite needs the internet would
 * otherwise be counted as needing it too, which overstates the remaining work.
 */
/**
 * Comments stripped, but test *bodies* left in place.
 *
 * `code()` deliberately removes `await test("...", async () => {...})` blocks so
 * inert string fixtures inside a test body are not mistaken for dependencies.
 * That is right for fixture URLs and wrong for a real dial: `core-unit.test.mts`
 * constructed its transport and called `.send({ url: "https://..." })` inside the
 * body of each test, so every one of those calls was invisible and the guard
 * reported the suite clean while it reached the public internet on every run.
 * Scanning for the dialling *verb* is precise enough to need no body-stripping:
 * a fixture passes its URL to a signer or a template, never to `send`.
 */
function codeWithBodies(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A direct transport dial at a public origin. */
const DIRECT_DIAL = /\.(?:send|raw)\(\s*\{[^}]*\burl:\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/;

function code(body: string): string {
  return (
    body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      // A URL inside a human-readable message ("httpbin answered 502") or a test
      // title is prose. Left in, it counted as a dependency and kept
      // fully-migrated files on the list.
      .replace(
        /await (?:test|check|run|skip)\(["`][\s\S]*?\)(?:, async \(\) => \{[\s\S]*?\n\}\))?[;,]?/g,
        "",
      )
      .replace(/suite\(["`][\s\S]*?\)[;,]?/g, "")
      // A suite's first string argument is a label (settleUpstream, run,
      // helper(name, ...)), not a target.
      .replace(/\b(?:settleUpstream|waitFor|logTiming)\(\s*["`][^"`]*["`],?/g, "settleUpstream(")
      .replace(/(⚠️|✅|❌)[^`\n]*`/g, "`")
  );
}

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ✅  ${name}`),
      (e: unknown) => {
        console.error(`  ❌  ${name}: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      },
    );
}

// Recursive on purpose. A top-level-only scan missed `tests/runtime/**`
// entirely, so the Deno and Bun suites kept 200-odd references to
// httpbin.org while the guard reported zero live suites.
function suiteFilesUnder(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...suiteFilesUnder(url));
    else if (entry.name.endsWith(".test.mts")) out.push(url.pathname.replace(root.pathname, ""));
  }
  return out.sort();
}

const suiteFiles = suiteFilesUnder(new URL("tests/", root));

await test("every live-network suite is on the record with a reason", () => {
  // Must agree with the staleness check below, so both go through `isLive` —
  // which knows a config with an injected `fetch` is never dialled. This test
  // used a bare host+baseURL scan and flagged the very files that check
  // correctly clears, so a converted suite could never leave the list.
  const unreported: string[] = [];
  for (const file of suiteFiles) {
    if (file in KNOWN_LIVE) continue;
    if (isLive(read(file))) unreported.push(file);
  }
  assert.deepEqual(
    unreported,
    [],
    `these suites reach a live host without being listed in KNOWN_LIVE:\n  ${unreported.join("\n  ")}\n` +
      `Either point them at tests/httpbin-local.ts, or record the file in KNOWN_LIVE with a reason.`,
  );
});

await test("every KNOWN_LIVE entry still needs a live host", () => {
  // An allowlist only shrinks if something enforces that it does. Without this,
  // a converted file would keep its entry forever and the count would become a
  // number nobody trusts.
  const stale: string[] = [];
  for (const file of Object.keys(KNOWN_LIVE)) {
    if (!suiteFiles.includes(file)) {
      stale.push(`${file} (no longer exists)`);
      continue;
    }
    if (!isLive(read(file))) {
      stale.push(`${file} (no live host outside comments — delete its entry)`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `KNOWN_LIVE has entries that no longer belong:\n  ${stale.join("\n  ")}`,
  );
});

await test("every KNOWN_LIVE reason says why a real host is required", () => {
  for (const [file, reason] of Object.entries(KNOWN_LIVE)) {
    assert.ok(reason.length > 20, `${file} has a too-thin reason: "${reason}"`);
  }
});

await test("the local server covers the endpoints migrated suites depend on", async () => {
  const { httpbinBaseUrl, stopLocalHttpbin } = await import("./httpbin-local.ts");
  const base = await httpbinBaseUrl();
  try {
    for (const path of ["/get", "/uuid", "/post", "/headers", "/anything", "/json", "/ip"]) {
      const res = await fetch(`${base}${path}`, {
        method: path === "/post" ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: path === "/post" ? JSON.stringify({ a: 1 }) : undefined,
      });
      assert.equal(res.status, 200, `local httpbin must answer ${path}`);
    }
  } finally {
    stopLocalHttpbin();
  }
});
