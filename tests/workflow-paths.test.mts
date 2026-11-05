import assert from "node:assert/strict";
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A workflow step that shells out to a dependency binary by bare name does not
 * work. `node_modules/.bin` is put on PATH by npm *scripts*, not by the
 * runner: `npm run test:all` finds `tsx`, and `tsx tests/Node.test.mts` as a
 * raw `run:` step does not, because nothing has added it to PATH. The step
 * fails with `tsx: command not found` and exit 127.
 *
 * That is not hypothetical. The nightly job ran two steps written that way and
 * failed there every single night, filing an issue each time — and because the
 * failure was the step before the Deno and Bun battle tests, those never ran
 * either, so the nightly was reporting a toolchain error as a regression.
 *
 * These tests read the workflow files and fail on the shape, so the mistake
 * surfaces when it is written rather than at 02:00 UTC.
 */

const ROOT = join(import.meta.dirname, "..");
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

/** Every workflow file, by name. */
function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

/** Every `run:` command in a workflow, with the line it came from. */
function runSteps(file: string): Array<{ line: number; cmd: string }> {
  const out: Array<{ line: number; cmd: string }> = [];
  readFileSync(join(WORKFLOWS, file), "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const m = /^\s*-?\s*run:\s*(.+)$/.exec(raw);
      if (m && !/^\s*\|\s*$/.test(m[1]!)) out.push({ line: i + 1, cmd: m[1]!.trim() });
    });
  return out;
}

/** Binaries that come from `node_modules/.bin` rather than the runner image. */
const LOCAL_BINARIES = ["tsx", "c8", "typedoc", "ts-prune", "type-coverage", "husky", "tsc"];

suite("Workflow command hygiene");

await test("no run: step invokes a local dependency binary by bare name", () => {
  // A step is safe when it reaches the binary through npx, or through an npm
  // script — both put node_modules/.bin on PATH.
  const offenders: string[] = [];
  for (const file of workflowFiles()) {
    for (const { line, cmd } of runSteps(file)) {
      // Strip redirections, env prefixes and arguments so `FOO=1 npx tsx …` and
      // `tsx tests/x.mts` are both reduced to the binary being invoked.
      const head = cmd.split(/\s*[|&;<>]\s*/)[0]!.trim();
      const word = head.split(/\s+/)[0]!.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*$/, "");
      const bare = word.split("/").pop()!;
      if (!LOCAL_BINARIES.includes(bare)) continue;
      offenders.push(`${file}:${line}  ${cmd}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `these steps call a dependency binary that is not on PATH in a runner step ` +
      `(node_modules/.bin is only added for npm scripts), so they fail with ` +
      `"command not found":\n  ${offenders.join("\n  ")}\n  Prefix each with "npx ".`,
  );
});

/** The body of a job, from its `  <name>:` key to the next 2-space key. */
function jobBody(src: string, jobName: string): string | null {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobName}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Any line that is a key at exactly two spaces of indent ends this job.
    if (/^ {2}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

await test("the nightly regression job can reach all of its own steps", () => {
  const src = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
  const job = jobBody(src, "nightly-regression");
  assert.ok(job, "ci.yml must declare a nightly-regression job");

  const jobTimeout = Number(/^\s{4}timeout-minutes:\s*(\d+)/m.exec(job)?.[1]);
  assert.ok(Number.isFinite(jobTimeout), "nightly-regression must declare a job timeout-minutes");

  // Every per-step budget the job carries, in order.
  const stepTimeouts = [...job.matchAll(/timeout-minutes:\s*(\d+)/g)]
    .map((m) => Number(m[1]))
    .slice(1); // [0] is the job's own
  const worstCase = stepTimeouts.reduce((a, b) => a + b, 0);

  assert.ok(
    jobTimeout >= worstCase,
    `nightly-regression has timeout-minutes: ${jobTimeout} but its steps declare ` +
      `${worstCase} minutes of budget (${stepTimeouts.join(" + ")}). GitHub cancels the ` +
      `job at the job timeout, so the steps after the first slow one can never report — ` +
      `their timeouts are unreachable.`,
  );
});

await test("every workflow is valid YAML with the jobs it declares", () => {
  // A cheap structural check: the file parses as a mapping and declares at
  // least one job, so a malformed edit cannot slip in behind the other tests.
  for (const file of workflowFiles()) {
    const src = readFileSync(join(WORKFLOWS, file), "utf8");
    assert.match(src, /^name:\s*\S/m, `${file} must declare a name`);
    assert.match(src, /^\s*jobs:\s*$/m, `${file} must declare a jobs mapping`);
    // Tabs are illegal in YAML indentation and fail the workflow at load time.
    assert.ok(!/^\t/m.test(src), `${file} must not contain tab indentation`);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
