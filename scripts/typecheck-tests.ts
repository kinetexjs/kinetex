/**
 * Type-check gate for the test suite.
 *
 * `tsconfig.check.json` only covers `src/`, so a type error anywhere in the
 * test tree was invisible to CI. Turning the checker on surfaced 1477
 * pre-existing errors, so this started life as a ratchet: fail only when the
 * count rose, with the number recorded in a baseline file that could only go
 * down.
 *
 * The backlog is now zero, so the ratchet has nothing left to guard. This is
 * the plain form of the same gate — any type error in a test fails CI — and the
 * baseline file and its `--write` escape hatch are gone with it.
 *
 *   npm run typecheck:tests   type-check tests/ (CI)
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runTsc(): string {
  try {
    return execFileSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        join(ROOT, "tsconfig.tests.json"),
        "--noEmit",
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // tsc exits non-zero on type errors and writes them to stdout; that is the
    // interesting case, not a crash.
    const e = err as { stdout?: string; stderr?: string };
    if (typeof e.stdout === "string" && e.stdout.length > 0) return e.stdout;
    throw err;
  }
}

const output = runTsc();
const errors = output.split("\n").filter((line) => /error TS\d+:/.test(line));

if (errors.length > 0) {
  console.error(`Type errors in tests/: ${errors.length}`);
  for (const line of errors.slice(0, 50)) console.error(`  ${line}`);
  if (errors.length > 50) console.error(`  ... and ${errors.length - 50} more`);
  process.exit(1);
}

console.log("Type-checked tests/: 0 errors");
