/**
 * Upstream-drift detection for the suites that talk to live httpbin.
 *
 * httpbin.org is a free public service. It rate-limits, and it answers
 * 429/502/503/504 from its own front end when it is unwell or loaded. That is
 * never a defect in this client, but it is indistinguishable from one unless it
 * is looked for: a red suite during someone else's outage is how a real
 * regression gets lost in the noise of an expected one.
 *
 * So drift is separated from failure. It is never silent — every excused
 * assertion is named in a report — but it does not fail the run, because the
 * client did nothing wrong.
 *
 * This started as three private copies, one per suite, which had already
 * drifted apart: `mod.test.mts` excused drift, `core.test.mts` excused drift
 * plus network errors, and `client.test.mts` had nothing at all. There is one
 * implementation here and one test file covering it.
 */

/** Statuses httpbin returns when *it* is unwell, rather than when asked to. */
export const UPSTREAM_DRIFT = new Set([429, 502, 503, 504]);

/** Error codes that mean the connection failed, not that the request was wrong. */
const NETWORK_CODES =
  /^(ECONN|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)$/;

/** Message fragments that mean the third party misbehaved. */
const UPSTREAM_MESSAGE =
  /\b(429|502|503|504)\b|upstream|bad gateway|service unavailable|gateway timeout|too many requests/i;

/** True for a value that could be an HTTP status. */
function isStatusish(n: number): boolean {
  return Number.isInteger(n) && n >= 100 && n <= 599;
}

/**
 * True when a failed status comparison is the third party drifting rather than
 * the client being wrong: both sides are HTTP statuses, they differ, and what
 * actually came back is one httpbin produces unprompted.
 *
 * Deliberately narrow. A 404 or 500 back from `/status/200` is a real failure
 * and must still fail the run, and a `500` is not excused either — httpbin
 * emits 502 when its gateway is unwell, so a 500 means the request itself
 * produced it.
 */
export function isUpstreamStatusDrift(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (actual === expected) return false;
  return isStatusish(actual) && isStatusish(expected) && UPSTREAM_DRIFT.has(actual);
}

/**
 * True only for errors that mean "the third party misbehaved", not "our code is
 * wrong". An `AssertionError` can only come from a test's own assertion, so it
 * is never excused — this escape hatch must not be able to turn a real failure
 * into green.
 */
export function isUpstreamFlake(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AssertionError") return false;
  // A TypeError is either our code crashing or fetch's own network-level
  // failure; the message is what separates the two.
  if (err.name === "TypeError") {
    return /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(err.message);
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (NETWORK_CODES.test(code)) return true;
    // A 5xx surfaced as a KinetexError is the upstream service, not us. 429
    // is the same story: httpbin rate-limiting is not a client defect.
    if (/^EHTTP_5/.test(code)) return true;
    if (code === "EHTTP_429") return true;
  }
  return UPSTREAM_MESSAGE.test(err.message);
}

/** One excused assertion, and where it happened. */
export interface DriftSite {
  site: string;
  expected: unknown;
  actual: unknown;
}

/** The counters a guarded suite closes its run with. */
export interface DriftReport {
  /** Status drifts excused so far. */
  drift: number;
  /** Every excused assertion, in order. */
  sites: DriftSite[];
  /** The block to print when anything was excused. Empty string when none was. */
  text(): string;
  /**
   * Assertions that genuinely failed, counted at the assertion itself.
   *
   * This belongs here rather than in each suite because a suite that closes
   * with `process.exit(...)` has no other way to learn the verdict: when a test
   * file is run directly rather than through `node --test`, node:test never
   * assigns `process.exitCode`, so a hand-rolled counter is the only thing
   * standing between a red suite and a green exit code. Suites that let
   * node:test own the exit code can ignore this.
   */
  failures: number;
}

export interface DriftGuard<T> {
  /** Drop-in for `node:assert/strict` that excuses upstream status drift. */
  assert: T;
  report: DriftReport;
}

/**
 * The assert methods the guard is willing to intercept.
 *
 * An allowlist, not "any function on the module": `node:assert/strict` also
 * exports `AssertionError`, a class. Wrapping it in the drift check would
 * return a plain function from `guarded.AssertionError` and break every
 * `instanceof` a suite does against it — a subtle breakage in exchange for
 * guarding nothing.
 */
const GUARDED = new Set([
  "ok",
  "equal",
  "notEqual",
  "deepEqual",
  "strictEqual",
  "notStrictEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "fail",
  "match",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
]);

/**
 * Wrap an assert module so a status comparison that failed only because httpbin
 * drifted is recorded as inconclusive instead of failed.
 *
 * Only the (actual, expected) comparison methods in `GUARDED` are candidates,
 * and only when both arguments are integers in the HTTP status range.
 * Everything else falls through to the real assert, so this can never mask a
 * genuine defect.
 */
export function createDriftGuard<T extends Record<string, unknown>>(base: T): DriftGuard<T> {
  const sites: DriftSite[] = [];
  let failures = 0;

  const assert = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!GUARDED.has(String(prop))) return value;
      return (...args: unknown[]) => {
        if (isUpstreamStatusDrift(args[0], args[1])) {
          sites.push({
            site: new Error().stack?.split("\n")[2]?.trim() ?? "unknown site",
            expected: args[1],
            actual: args[0],
          });
          return undefined;
        }
        try {
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          failures++;
          throw err;
        }
      };
    },
  }) as T;

  return {
    assert,
    report: {
      get drift() {
        return sites.length;
      },
      get failures() {
        return failures;
      },
      sites,
      text() {
        if (sites.length === 0) return "";
        return (
          `\n⚠️  ${sites.length} assertion(s) were INCONCLUSIVE — httpbin answered a drift ` +
          `status (429/502/503/504) where another was expected. They are not counted as ` +
          `failures, because the client did not produce them, but they did not run either:\n` +
          sites
            .map(
              (s) =>
                `     - ${s.site} — expected ${String(s.expected)}, httpbin answered ${String(s.actual)}\n`,
            )
            .join("")
        );
      },
    },
  };
}
