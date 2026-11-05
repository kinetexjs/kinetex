import assert from "node:assert/strict";
import process from "node:process";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

/**
 * Guards against a whole class of test that cannot fail.
 *
 * `assert.throws(fn)` with no matcher is satisfied by *any* throw, including a
 * `TypeError` from a typo in the code under test — which is the exact defect
 * these tests exist to catch. And `assert.throws(fn, "some string")` is worse
 * than it looks: a string second argument to `node:assert` is the
 * `AssertionError` *message*, not a matcher, so it constrains nothing while
 * reading as if it did. Three real instances of the second form shipped here
 * (`utils.test.mts`, `Node.test.mts`, `Bun.test.mts`), and 105 of the first.
 *
 * This follows the pattern the suite already uses elsewhere — `test-manifest`
 * walks the tree to prove every suite is reachable, `upstream-drift` reads its
 * siblings to prove they cannot bypass the drift classifier. Here we read every
 * suite to prove none of them asserts without a matcher.
 *
 * Parsing is done with the TypeScript compiler API rather than a hand-rolled
 * scanner, which is what a regex-based version kept getting wrong: `/response=
 * "([^"]+)"/` is a real line in `digest.test.mts`, and any scanner that reads a
 * quote as always opening a string loses its place there and afterwards
 * reports commented-out code as live. `typescript` is already a devDependency
 * and `docs-drift.test.mts` already builds a program from it.
 */

const TESTS_DIR = import.meta.dirname;

let passed = 0;
let failed = 0;
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

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* testFiles(full);
    } else if (entry.name.endsWith(".test.mts")) {
      yield full;
    }
  }
}

interface Offence {
  file: string;
  line: number;
  kind: string;
  detail: string;
}

/**
 * Matched call forms.
 *
 * `assert.throws` / `assert.rejects` — node:assert, and the shape every
 * hand-rolled harness in the Node suite uses.
 *
 * `assertThrows` / `assertRejects` — bare functions from `jsr:@std/assert`, the
 * Deno runtime suite. They carry the same defect: a string second argument is
 * the failure *message* in `@std/assert` too, verified by running both forms.
 * Leaving them out meant the Deno suite could regress independently of the one
 * this guard already covered.
 */
const METHOD_KINDS = new Set(["throws", "rejects"]);
const FUNCTION_KINDS = new Set(["assertThrows", "assertRejects"]);

/** Parses `src`, returning every assert.throws/rejects that lacks a matcher. */
function parseOffences(rel: string, src: string): Offence[] {
  const sf = ts.createSourceFile(
    join(TESTS_DIR, "x.mts"),
    src,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const offences: Offence[] = [];

  const visit = (node: ts.Node): void => {
    // Bound to a `CallExpression | null` rather than paired with a separate
    // `kind` string: narrowing `node` does not survive into a later block, so
    // `node.arguments` would not type-check there.
    let call: ts.CallExpression | null = null;
    let kind = "";
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const target = node.expression.expression;
        if (METHOD_KINDS.has(name) && ts.isIdentifier(target) && target.text === "assert") {
          call = node;
          kind = name;
        }
      } else if (ts.isIdentifier(node.expression) && FUNCTION_KINDS.has(node.expression.text)) {
        call = node;
        kind = node.expression.text;
      }
    }

    if (call !== null) {
      const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
      const matcher = call.arguments[1];
      if (matcher === undefined) {
        offences.push({
          file: rel,
          line,
          kind,
          detail: "no matcher — satisfied by any throw/rejection at all",
        });
      } else if (
        ts.isStringLiteral(matcher) ||
        ts.isNoSubstitutionTemplateLiteral(matcher) ||
        ts.isTemplateExpression(matcher)
      ) {
        offences.push({
          file: rel,
          line,
          kind,
          detail:
            "matcher is a string — that is the failure *message*, not a matcher, so it constrains nothing",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offences;
}

function scan(file: string): Offence[] {
  return parseOffences(file.slice(TESTS_DIR.length + 1), readFileSync(file, "utf8"));
}

/** Runs the parser over an in-memory source, for the probes below. */
function scanVirtual(src: string): Offence[] {
  return parseOffences("probe", src);
}

const offenders: Offence[] = [];
let scanned = 0;
let parsed = 0;
for (const file of testFiles(TESTS_DIR)) {
  scanned++;
  offenders.push(...scan(file));
  parsed++;
}

suite("assertion hygiene");

await test("the parser distinguishes a matcher from a message", () => {
  // The three shapes this guard has to tell apart, checked directly so a
  // future change to `scan` cannot quietly stop discriminating.
  const probe = `
    assert.rejects(fn);                                  // no matcher
    assert.rejects(fn, /boom/);                          // matcher
    assert.rejects(fn, (e) => e instanceof Error);        // matcher
    assert.rejects(fn, "must reject");                   // a message
    assert.rejects(fn, \`must \${x} reject\`);             // also a message
  `;
  const found = scanVirtual(probe);
  assert.deepEqual(
    found.map((o) => (o.detail.startsWith("no matcher") ? "none" : "string")),
    ["none", "string", "string"],
  );
});

await test("commented-out and stringified assertions are not counted", () => {
  const probe = `
    // assert.rejects(fn, "looks strict but is a comment");
    const s = 'assert.rejects(fn, "inside a string")';
    /* assert.throws(fn); */
    assert.throws(fn, /real/);
  `;
  assert.deepEqual(scanVirtual(probe), []);
});

await test("every suite is parsed by the assertion-hygiene guard", () => {
  // A guard that silently stops walking the tree is worse than none: it would
  // report a clean suite while checking nothing.
  assert.ok(scanned >= 50, `expected the whole tests/ tree, only saw ${scanned} files`);
  assert.equal(parsed, scanned);
});

await test("no assert.throws/assert.rejects asserts without a matcher", () => {
  // `kind` is already the full call shape for the Deno forms, so only the
  // node:assert ones get an `assert.` prefix.
  const label = (k: string): string =>
    k.startsWith("assert") && k !== "assert" ? k : `assert.${k}`;
  const problems = offenders.map((o) => `${o.file}:${o.line}  ${label(o.kind)}  ${o.detail}`);
  assert.deepEqual(problems, [], problems.join("\n"));
});

console.log(`\n${"=".repeat(60)}`);
console.log(`  ASSERTION HYGIENE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  ✗ ${f.name}`);
}
console.log(`${"=".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
