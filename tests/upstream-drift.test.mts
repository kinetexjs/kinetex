/**
 * The upstream-drift guard, tested.
 *
 * `tests/upstream.ts` decides when a failed assertion against live httpbin is
 * somebody else's outage rather than a defect in this client. That decision is
 * the one place in the test suite where a failure can be made to disappear, so
 * it is pinned here rather than trusted: the tests below are the answer to
 * "what stops this from quietly turning red into green?"
 *
 * Three properties matter, and all three are asserted:
 *
 *  1. Drift is excused — a 502 where 200 was expected must not fail the run.
 *  2. Nothing else is — every real mismatch, and every non-status mismatch,
 *     must still throw and still be counted.
 *  3. The suites cannot bypass it — a new live-network suite must route its
 *     status assertions through the guard, and a suite that gives up the guard
 *     is a hole in the wall.
 *
 * (1) and (2) are behavioural and kill any mutant in the classifier. (3) is
 * structural: it reads the suite sources, because a test that only ever proves
 * the classifier behaves still leaves the door open for someone to not call it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createDriftGuard,
  isUpstreamFlake,
  isUpstreamStatusDrift,
  UPSTREAM_DRIFT,
} from "./upstream.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  ✅  ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌  ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failures.push({ name, err });
      failed++;
    }
  })();
}

/** Read a sibling test source file as text. */
function source(file: string): string {
  return readFileSync(join(HERE, file), "utf8");
}

/**
 * Source with comments and doc comments removed.
 *
 * The suites document the bugs they have already fixed, so the very string a
 * guard test searches for — `process.exit(process.exitCode ?? 0)` — appears in
 * a comment describing its removal. Searching raw text would make a suite
 * unfixable: correcting the code would still leave the note quoting it.
 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

// ============================================================================
// 1. isUpstreamStatusDrift — the statuses that count, and the ones that do not
// ============================================================================

suite("upstream drift — status classification");

await check("excuses each status httpbin produces unprompted", () => {
  for (const status of UPSTREAM_DRIFT) {
    assert.equal(
      isUpstreamStatusDrift(status, 200),
      true,
      `${status} should be recognised as drift`,
    );
  }
});

await check("the excused set is exactly 429/502/503/504", () => {
  // Pinned literally, not derived: this set is the difference between a green
  // run and a masked failure, so widening it must be a deliberate edit here.
  assert.deepEqual(
    [...UPSTREAM_DRIFT].sort((a, b) => a - b),
    [429, 502, 503, 504],
  );
});

await check("does not excuse a 500 — httpbin emits 502 when unwell", () => {
  // The subtle one. A 500 back from `/status/200` is a real answer from the
  // endpoint, not a gateway hiccup, and excusing it would hide a genuine bug.
  assert.equal(isUpstreamStatusDrift(500, 200), false);
});

await check("does not excuse a 404 or a 422", () => {
  assert.equal(isUpstreamStatusDrift(404, 200), false);
  assert.equal(isUpstreamStatusDrift(422, 503), false);
});

await check("does not excuse a match", () => {
  // Equal statuses are not drift — there is nothing to excuse.
  assert.equal(isUpstreamStatusDrift(200, 200), false);
  assert.equal(isUpstreamStatusDrift(502, 502), false);
});

await check("does not excuse non-status numbers", () => {
  // A count, a duration, a byte length: a 502 that happens to be the value
  // under test is a coincidence, not an outage.
  assert.equal(isUpstreamStatusDrift(502, 3), false);
  assert.equal(isUpstreamStatusDrift(99, 200), false);
  assert.equal(isUpstreamStatusDrift(600, 200), false);
});

await check("does not excuse non-numeric comparisons", () => {
  assert.equal(isUpstreamStatusDrift("502", 200), false);
  assert.equal(isUpstreamStatusDrift(502, "200"), false);
  assert.equal(isUpstreamStatusDrift(null, 200), false);
  assert.equal(isUpstreamStatusDrift(undefined, undefined), false);
  assert.equal(isUpstreamStatusDrift({ status: 502 }, 200), false);
});

// ============================================================================
// 2. createDriftGuard — the accounting the exit code depends on
// ============================================================================

suite("upstream drift — guard accounting");

await check("a drifted status does not throw and is not a failure", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  assert.doesNotThrow(() => guarded.equal(502, 200));
  assert.equal(report.failures, 0);
  assert.equal(report.drift, 1);
});

await check("a genuine mismatch still throws and is counted", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  assert.throws(() => guarded.equal(500, 200), /AssertionError/);
  assert.equal(report.failures, 1, "a real failure must be counted");
  assert.equal(report.drift, 0, "and must not be filed as drift");
});

await check("a drifted status does not mask a later real failure", () => {
  // The escape hatch must not leak: excusing one assertion cannot disarm the
  // guard for the rest of the run.
  const { assert: guarded, report } = createDriftGuard(assert);
  guarded.equal(503, 200);
  assert.throws(() => guarded.equal(200, 404), /AssertionError/);
  assert.equal(report.failures, 1);
  assert.equal(report.drift, 1);
});

await check("non-status assertions pass straight through", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  assert.doesNotThrow(() => guarded.equal("abc", "abc"));
  assert.doesNotThrow(() => guarded.ok(true));
  assert.equal(report.failures, 0);
  assert.equal(report.drift, 0);
  assert.throws(() => guarded.equal("a", "b"));
  assert.equal(report.failures, 1);
});

await check("a pass through the guard is still a pass", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  guarded.equal(200, 200);
  assert.equal(report.failures, 0);
  assert.equal(report.drift, 0);
});

await check("non-function properties survive the proxy", () => {
  // `assert.AssertionError` and friends are read off the module; a proxy that
  // wrapped those would break `instanceof` in unrelated code.
  const { assert: guarded } = createDriftGuard(assert);
  assert.equal(guarded.AssertionError, assert.AssertionError);
});

await check("every excused assertion is named in the report", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  guarded.equal(502, 200);
  guarded.equal(429, 201);
  const text = report.text();
  assert.ok(text.includes("2 assertion(s) were INCONCLUSIVE"), "the count is stated");
  assert.ok(text.includes("expected 200"), "the first expectation is named");
  assert.ok(text.includes("httpbin answered 502"), "the first actual is named");
  assert.ok(text.includes("httpbin answered 429"), "the second actual is named");
});

await check("a clean run prints no drift report at all", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  guarded.equal(200, 200);
  assert.equal(report.text(), "", "silence is the correct output when nothing drifted");
});

await check("an excused assertion is attributed to a real call site", () => {
  const { assert: guarded, report } = createDriftGuard(assert);
  const mark = () => guarded.equal(503, 200);
  mark();
  assert.equal(report.sites.length, 1);
  assert.ok(report.sites[0].site.length > 0, "the site must not be 'unknown site'");
  assert.equal(report.sites[0].expected, 200);
  assert.equal(report.sites[0].actual, 503);
});

// ============================================================================
// 3. isUpstreamFlake — thrown-error form of the same decision
// ============================================================================

suite("upstream drift — error classification");

await check("excuses a KinetexError carrying an upstream 5xx", () => {
  const err = Object.assign(new Error("HTTP 502 Bad Gateway — https://httpbin.org/post"), {
    code: "EHTTP_502",
  });
  assert.equal(isUpstreamFlake(err), true);
});

await check("excuses a rate-limit rejection", () => {
  const err = Object.assign(new Error("HTTP 429 Too Many Requests"), { code: "EHTTP_429" });
  assert.equal(isUpstreamFlake(err), true);
});

await check("excuses network-level failures", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]) {
    assert.equal(
      isUpstreamFlake(Object.assign(new Error("socket"), { code })),
      true,
      `${code} should be excused`,
    );
  }
  assert.equal(isUpstreamFlake(new TypeError("fetch failed")), true);
});

await check("never excuses an AssertionError", () => {
  // The load-bearing case. A failed assertion can only have come from a test's
  // own `assert`, so excusing one would let this harness mask a real defect.
  const err = new assert.AssertionError({ message: "HTTP 502 — expected 200" });
  assert.equal(err.name, "AssertionError");
  assert.equal(isUpstreamFlake(err), false, "an assertion failure must never be filed as a flake");
});

await check("never excuses a 404 or a 400", () => {
  // The suites assert these statuses for real; excusing them would delete the
  // only tests that cover error propagation.
  assert.equal(
    isUpstreamFlake(new Error("HTTP 404 Not Found — https://httpbin.org/status/404")),
    false,
  );
  assert.equal(isUpstreamFlake(new Error("Unexpected DELETE status 404")), false);
  assert.equal(isUpstreamFlake(new Error("HTTP 400 Bad Request")), false);
});

await check("never excuses a bare 500", () => {
  assert.equal(isUpstreamFlake(new Error("HTTP 500 Internal Server Error")), false);
});

await check("never excuses a TypeError from our own code", () => {
  assert.equal(isUpstreamFlake(new TypeError("res.data.map is not a function")), false);
});

await check("never excuses a non-Error, or an unrecognised error", () => {
  assert.equal(isUpstreamFlake("502 Bad Gateway"), false);
  assert.equal(isUpstreamFlake(undefined), false);
  assert.equal(isUpstreamFlake(new Error("something else entirely")), false);
});

await check("does not excuse a size-limit error", () => {
  // `ESIZELIMIT` is kinetex enforcing maxResponseSize. That is our behaviour
  // working, and a test asserting it must be allowed to fail.
  const err = Object.assign(new Error("Response exceeds maxResponseSize"), {
    code: "ESIZELIMIT",
  });
  assert.equal(isUpstreamFlake(err), false);
});

// ============================================================================
// 4. No suite can drop the guard
// ============================================================================

suite("upstream drift — suites cannot bypass the guard");

/** Live-network suites, and how each is expected to reach the guard. */
const LIVE_SUITES: Array<{ file: string; needs: RegExp[] }> = [
  {
    // This is the suite the drift guard was written for: it has bare
    // `assert.strictEqual(res.status, N)` calls against live httpbin, so every
    // one of them must go through the proxy rather than node:test's assert.
    file: "mod.test.mts",
    needs: [
      /createDriftGuard/,
      /from "\.\/upstream\.ts"/,
      /driftReport\.failures/,
      /driftReport\.drift/,
    ],
  },
  { file: "core.test.mts", needs: [/isUpstreamStatusDrift/, /isUpstreamFlake/] },
  { file: "client.test.mts", needs: [/isUpstreamStatusDrift/, /isUpstreamFlake/] },
];

await check("every live-network suite reaches the shared guard", () => {
  for (const { file, needs } of LIVE_SUITES) {
    const text = source(file);
    for (const pattern of needs) {
      assert.ok(
        pattern.test(text),
        `${file} no longer references ${pattern} — it has lost its upstream-drift guard`,
      );
    }
  }
});

await check("no live suite carries a private copy of the classifier", () => {
  // The reason this module exists: three private copies had already drifted
  // apart, and one suite had no guard at all. A fourth copy is the bug
  // returning, so its signature is checked for directly.
  const signature = /status\s*!==\s*expected\s*&&\s*\(status\s*===\s*429/;
  for (const { file } of LIVE_SUITES) {
    assert.ok(
      !signature.test(source(file)),
      `${file} re-defines the drift set inline; import it from tests/upstream.ts instead`,
    );
  }
});

await check("mod.test.mts routes its status assertions through the guard", () => {
  // The specific concern: mod.test.mts imports `nodeAssert` and wraps it. If
  // any status assertion were made against a bare `nodeAssert`, it would opt
  // out of the accounting. `nodeAssert` must appear only in the import and in
  // the `createDriftGuard` call.
  const text = source("mod.test.mts");
  const uses = text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /nodeAssert/.test(line));
  for (const { line, n } of uses) {
    assert.ok(
      /import nodeAssert from|createDriftGuard<typeof nodeAssert>/.test(line),
      `tests/mod.test.mts:${n} uses nodeAssert directly, bypassing the drift guard: ${line.trim()}`,
    );
  }
  assert.ok(uses.length > 0, "the import and the guard call should still be there");
});

await check("mod.test.mts still asserts on live statuses through `assert`", () => {
  // Guards the other direction: the accounting is worthless if the assertions
  // were quietly removed instead. This file reads a status straight off a live
  // response dozens of times, and that coverage is the point.
  const text = source("mod.test.mts");
  const count = (text.match(/assert\.(?:strictEqual|equal)\([^,]*\.status\s*,/g) ?? []).length;
  assert.ok(count >= 50, `expected dozens of live status assertions, found ${count}`);
});

await check("mod.test.mts exits non-zero on failure", () => {
  // The bug this file was rewritten for: `process.exit(process.exitCode ?? 0)`
  // reported success after any number of failures. The verdict must come from
  // the guard's own counter, never from node:test.
  const text = code("mod.test.mts");
  assert.ok(
    /process\.exit\(driftReport\.failures > 0 \? 1 : 0\)/.test(text),
    "mod.test.mts must derive its exit code from the guard's failure count",
  );
  assert.ok(
    !/process\.exit\(process\.exitCode/.test(text),
    "mod.test.mts must not read a verdict from process.exitCode",
  );
});

await check("the drift report is printed even when nothing failed", () => {
  // Otherwise a run where httpbin answered 502 for everything prints a clean
  // summary and reads as a pass.
  const text = code("mod.test.mts");
  assert.ok(
    /if \(driftReport\.drift > 0\) console\.error\(driftReport\.text\(\)\)/.test(text),
    "mod.test.mts must print the inconclusive report whenever anything drifted",
  );
});

await check("the guard does not wrap the module's own classes", () => {
  // `node:assert/strict` exports `AssertionError`. Returning a plain function
  // for it would break `instanceof` in any suite that used the wrapped module.
  const { assert: guarded } = createDriftGuard(assert);
  assert.equal(guarded.AssertionError, assert.AssertionError);
  assert.equal(typeof guarded.AssertionError, "function");
  assert.ok(new Error("x") instanceof assert.AssertionError === false);
});

await check("the guard wraps only the assert methods it lists", () => {
  // Anything off the allowlist must be the original, or the guard becomes a
  // source of behaviour nobody reviewed. `equal` is on the list and so is
  // deliberately wrapped; `custom` is not, and must come back untouched.
  const custom = () => "original";
  const base = { equal: assert.equal, custom };
  const { assert: guarded } = createDriftGuard(base);
  assert.equal(guarded.custom(), "original");
  assert.equal(guarded.custom, custom, "an unlisted function must be the original reference");
  assert.notEqual(guarded.equal, base.equal, "a listed method is wrapped");
});

// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`  ❌ ${name}: ${String(err)}`);
  process.exit(1);
}
process.exit(0);
