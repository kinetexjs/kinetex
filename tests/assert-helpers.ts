import assert from "node:assert/strict";

/**
 * Shared assertion helpers for the kinetex test suite.
 *
 * Three files each carried their own copy of the structural `assertEqual`
 * below (`pagination.test.mts`, `progress.test.mts`, `response.test.mts`) and
 * a trivial `assertOk`. The `logging.test.mts` copy was weaker than the other
 * three: it compared with `!==`, so on an object it compared identity and
 * happily called two structurally identical values different.
 *
 * One definition means a fix to the comparison lands in every file at once, and
 * no file can quietly regress to identity comparison.
 */

/**
 * Structural equality, order-insensitive in keys.
 *
 * Deliberately not `JSON.stringify`: that compares key *order*, cannot tell an
 * absent key from one holding `undefined`, and folds `NaN`, `Infinity` and `-0`
 * into `null`/`0` — so a NaN rate or an eta of `-0` compared equal to anything.
 */
export function assertStructuralEqual<T>(a: T, b: T, note?: string): void {
  const suffix = note ? ` (${note})` : "";
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keysA = Object.keys(oa).sort();
    const keysB = Object.keys(ob).sort();
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      throw new Error(
        `Expected keys ${JSON.stringify(keysB)} got ${JSON.stringify(keysA)}${suffix}`,
      );
    }
    for (const k of keysB) {
      const av = oa[k];
      const bv = ob[k];
      if (!Object.is(av, bv) && JSON.stringify(av) !== JSON.stringify(bv)) {
        throw new Error(
          `Expected ${JSON.stringify(bv)} got ${JSON.stringify(av)} for key "${k}"${suffix}`,
        );
      }
    }
    return;
  }
  // `Object.is` at the leaves, so NaN, -0 and +0 are told apart.
  if (!Object.is(a, b)) {
    throw new Error(`Expected ${String(b)} got ${String(a)}${suffix}`);
  }
}

/** Truthiness assertion that reports the value it was given. */
export function assertTruthy(v: unknown, note?: string): void {
  if (!v) {
    throw new Error(`Expected truthy, got ${String(v)}${note ? ` (${note})` : ""}`);
  }
}

/**
 * Matcher for an abort.
 *
 * `sleep`, `BatchQueue` and `ConcurrencyLimiter` do not agree on one error type
 * for an abort — `sleep` rejects with a `DOMException("Aborted", "AbortError")`
 * while the limiter rejects with a `KinetexError` carrying `code: "EABORT"` —
 * so this accepts either, but requires one of them. That is still strictly
 * stronger than a bare `assert.rejects(fn)`, which is satisfied by any
 * rejection at all, including a `TypeError` thrown by a typo in the code under
 * test.
 */
export function isAbortRejection(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const code = (e as { code?: string })?.code;
  const message = (e as { message?: string })?.message ?? "";
  assert.ok(
    name === "AbortError" || code === "EABORT" || /\babort/i.test(message),
    `expected an abort rejection, got ${name ?? "(none)"}: ${message}`,
  );
  return true;
}

/**
 * Matcher factory for an error carrying a specific machine-readable code.
 *
 * Pinning the code is what distinguishes "the call failed" from "the call
 * failed for the reason under test".
 */
export function isErrorWithCode(code: string, message?: string) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof Error, `expected an Error with code ${code}, got ${String(e)}`);
    assert.equal((e as { code?: string }).code, code);
    if (message !== undefined) assert.equal(e.message, message);
    return true;
  };
}

/**
 * Predicate form of {@link isErrorWithCode}: reports whether the rejection
 * carries the code instead of asserting it.
 *
 * The asserting form throws on a mismatch, so it cannot be composed — trying
 * `isErrorWithCode("ENETWORK")(e) || isErrorWithCode("ENOTFOUND")(e)` fails on
 * the first call whenever the code is the second one. Anything that has to
 * accept a *set* of codes needs this.
 */
export function hasErrorCode(e: unknown, ...codes: string[]): boolean {
  if (!(e instanceof Error)) return false;
  const actual = (e as { code?: unknown }).code;
  return typeof actual === "string" && codes.includes(actual);
}

/**
 * Matcher for an error rejected with the given HTTP status.
 */
export function isStatusError(status: number) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof Error, `expected an Error with status ${status}, got ${String(e)}`);
    assert.equal((e as { status?: number }).status, status);
    return true;
  };
}

/** Matcher for a thrown value that must come back exactly as supplied. */
export function isExactly<T>(expected: T) {
  return (e: unknown): boolean => {
    // `Object.is`, not `==`, so `undefined` and `null` are told apart.
    assert.ok(Object.is(e, expected), `expected ${String(expected)}, got ${String(e)}`);
    return true;
  };
}
