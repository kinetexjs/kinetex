import assert from "node:assert/strict";
import process from "node:process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every test file in this repository has to be run by something.
 *
 * `test:all` discovers files with `find tests -maxdepth 1`, which is a
 * directory *depth* limit rather than a list anyone curates: a suite dropped
 * into `tests/runtime/` is silently outside it, and the day it appears the
 * build goes on reporting a test count that no longer includes it. Nothing
 * fails, because nothing claims to be checking.
 *
 * The four files under `tests/runtime/` are genuinely run — by dedicated Deno
 * and Bun jobs — but they are run by name, in workflow files, which is exactly
 * the kind of arrangement that rots: delete a step, rename a file, and the
 * coverage is gone with no error anywhere.
 *
 * So this asserts coverage rather than trusting it: every `*.test.mts` in the
 * tree must be reachable from an npm script or a workflow step. An orphan
 * fails here, naming the file, instead of being discovered months later.
 */

const ROOT = join(import.meta.dirname, "..");
const TESTS = join(ROOT, "tests");
const WORKFLOWS = join(ROOT, ".github", "workflows");

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

/** Every `.test.mts` under `tests/`, repo-relative, sorted. */
function allTestFiles(dir = TESTS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...allTestFiles(p));
    else if (p.endsWith(".test.mts"))
      out.push(
        p
          .slice(ROOT.length + 1)
          .split("\\")
          .join("/"),
      );
  }
  return out.sort();
}

/** Every npm script name and body. */
function npmScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

/** Every command any npm script runs. */
function npmScriptCommands(): string {
  return Object.values(npmScripts()).join("\n");
}

/** Every `run:` command across the workflow files. */
function workflowCommands(): string {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
    .join("\n");
}

/** The file list `test:all` actually discovers, evaluated the way the shell does. */
function discoveredByTestAll(): string[] {
  // Mirrors: find tests -maxdepth 1 -name '*.test.mts' ! -name 'perf.test.mts'
  return readdirSync(TESTS)
    .filter((f) => f.endsWith(".test.mts") && f !== "perf.test.mts")
    .map((f) => `tests/${f}`)
    .sort();
}

suite("Test manifest");

/**
 * Is `file` actually executed?
 *
 * Three routes, and the third is the one that matters: a file can be named in a
 * step, or reached through an npm script a step invokes (`npm run perf` runs
 * perf.test.mts without ever naming it). Merely *existing* as an npm script is
 * not coverage — that is precisely how perf.test.mts sat in the repo with a
 * runner nobody called, and its assertions executed nowhere.
 */
function coveragePredicate(): (file: string) => boolean {
  const workflows = workflowCommands();
  const scripts = npmScripts();
  const scriptNames = Object.keys(scripts).filter((n) =>
    new RegExp(`npm run ${n}(?![\\w-])`).test(workflows),
  );
  const topLevel = new Set(discoveredByTestAll());
  return (file: string) => {
    if (topLevel.has(file)) return true; // the directory sweep reaches it
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (workflows.includes(base)) return true;
    // Named by a script a workflow invokes — but appearing inside a `! -name`
    // exclusion is the opposite of coverage. The coverage script contains
    // `! -name 'perf.test.mts'`, and reading that as "perf is run" is exactly
    // the false negative that let this guard miss a deleted CI job.
    return scriptNames.some(
      (n) => scripts[n]!.includes(base) && !scripts[n]!.includes(`! -name '${base}'`),
    );
  };
}

await test("every test file in the repo is executed by something", () => {
  const isCovered = coveragePredicate();
  const orphans = allTestFiles().filter((file) => !isCovered(file));

  assert.deepStrictEqual(
    orphans,
    [],
    `these test files are never run by any npm script or CI step:\n` +
      orphans.map((f) => `  ${f}`).join("\n") +
      `\n\nEither move them to tests/ (where test:all's find collects them) or add ` +
      `them to a script that a CI job actually runs. A test nothing runs is ` +
      `indistinguishable from a test that passes.`,
  );
});

await test("test:all's find reaches the whole tests/ tree or the gap is covered by CI", () => {
  // The depth limit is the trap: it is silent by construction. Anything it
  // excludes has to be run by name somewhere, and the only place that counts is
  // a CI step — an npm script nobody wires into a job runs just as rarely as
  // no script at all. So this checks the workflows, and prints the size of the
  // gap so it stays visible.
  const discovered = new Set(discoveredByTestAll());
  const all = allTestFiles();
  const excluded = all.filter((f) => !discovered.has(f));

  assert.ok(
    excluded.length > 0,
    "expected the depth-limited find to exclude the runtime suites; if it no " +
      "longer does, this test's premise changed and it should be rewritten",
  );

  const isCovered = coveragePredicate();
  const uncovered = excluded.filter((f) => !isCovered(f));
  assert.deepStrictEqual(
    uncovered,
    [],
    `these files sit outside test:all's find and no CI step names them, so they never ` +
      `run:\n` +
      uncovered.map((f) => `  ${f}`).join("\n"),
  );

  console.log(
    `     (${discovered.size} discovered by find, ${excluded.length} run by CI step: ` +
      `${excluded.map((f) => f.replace("tests/", "")).join(", ")})`,
  );
});

await test("perf.test.mts is excluded from test:all but is run by a script", () => {
  // perf is excluded on purpose — it measures timing and would make the suite
  // flaky. It must still have a runner.
  const scripts = npmScriptCommands();
  assert.ok(
    !discoveredByTestAll().includes("tests/perf.test.mts"),
    "perf.test.mts must stay out of test:all",
  );
  assert.match(scripts, /perf\.test\.mts/, "an npm script must run perf.test.mts");
});

await test("no suite can reach exit 0 without having failed first", () => {
  // Several suites need a forced exit (they leak keep-alive sockets and would
  // otherwise hang), so calling process.exit at all is not the problem. The
  // problem is a suite whose only reachable exit status is 0 — one that prints
  // every assertion, then reports success no matter what it found. That is not
  // hypothetical: `process.exit(process.exitCode ?? 0)` did exactly this, and
  // `process.exitCode` is never assigned when the file is run directly rather
  // than through `node --test`, so it evaluated to exit(0).
  //
  // A suite passes this check when it has a way to report failure at all: an
  // explicit non-zero exit, or an exit status computed from a counter.
  const suites = allTestFiles().filter((f) => !f.includes("/runtime/"));
  const offenders: string[] = [];
  for (const file of suites) {
    const src = readFileSync(join(ROOT, file), "utf8");
    if (!/process\.exit\(/.test(src)) continue; // ends normally; node:test judges it
    const canReportFailure =
      /process\.exit\(\s*1\s*\)/.test(src) ||
      /process\.exit\(\s*[^)]*[><=!][^)]*\?/.test(src) ||
      /process\.exitCode\s*=\s*1/.test(src);
    if (!canReportFailure) offenders.push(file);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `these suites call process.exit but have no reachable non-zero exit, so a failing ` +
      `assertion still reports success:\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
