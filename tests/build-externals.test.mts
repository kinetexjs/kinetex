import assert from "node:assert/strict";
import process from "node:process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The browser bundles are built with `--platform=browser`, where esbuild
 * refuses to bundle a Node builtin — it errors instead of stubbing. So every
 * `node:` specifier referenced anywhere in `src/` has to be listed in
 * `NODE_EXT` in `scripts/build.ts`, or `npm run build` fails.
 *
 * Two were missed and both stopped a release: `node:tls`, added with the
 * CONNECT-tunnel work in `src/proxy.ts`, and `node:url`, added with the IDNA
 * fallback in `src/cookie-parser.ts`. The build is the first thing
 * `scripts/release.ts` runs, so the omission surfaced as "Checks failed.
 * Version files were already bumped" rather than as a build error anyone was
 * looking for. This asserts the two sets agree so a third cannot be added
 * silently.
 */

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

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

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// ── the NODE_EXT list, read out of the build script ──────────────────────

function declaredExternals(): Set<string> {
  const src = readFileSync(join(ROOT, "scripts", "build.ts"), "utf8");
  const block = /const NODE_EXT = \[([\s\S]*?)\]/.exec(src);
  assert.ok(block, "scripts/build.ts must declare a NODE_EXT array");
  return new Set((block[1]!.match(/"[^"]+"/g) ?? []).map((s) => s.slice(1, -1)));
}

suite("Browser bundle externals");

await test("NODE_EXT covers every node: builtin referenced in src/", () => {
  const declared = declaredExternals();

  // `node:quic` appears only inside a comment in src/types.ts, so comments are
  // stripped before scanning; anything left is a real reference.
  const referenced = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const raw = readFileSync(file, "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");
    for (const m of code.matchAll(/["'`](node:[a-z0-9_]+)["'`]/g)) referenced.add(m[1]!);
  }

  assert.ok(referenced.size > 0, "src/ must reference at least one node: builtin");
  const missing = [...referenced].filter((m) => !declared.has(m)).sort();
  assert.deepStrictEqual(
    missing,
    [],
    `these builtins are referenced by src/ but not externalised for the browser bundle: ` +
      `${missing.join(", ")}. Add each to NODE_EXT in scripts/build.ts — esbuild fails ` +
      `the browser bundle on any Node builtin it is not told to leave alone.`,
  );
});

await test("the two builtins that broke a release are externalised", () => {
  const declared = declaredExternals();
  // Named individually so the failure says which one is missing, rather than
  // only reporting a set difference.
  assert.ok(declared.has("node:tls"), "node:tls (src/proxy.ts) must be externalised");
  assert.ok(declared.has("node:url"), "node:url (src/cookie-parser.ts) must be externalised");
});

await test("every NODE_EXT entry is a node: builtin", () => {
  // A typo like `ndoe:tls` externalises nothing while looking correct, and
  // the failure it causes is an esbuild message about a builtin that was never
  // listed.
  const bad = [...declaredExternals()].filter((m) => !/^node:[a-z0-9_]+$/.test(m)).sort();
  assert.deepStrictEqual(bad, [], `malformed externals: ${bad.join(", ")}`);
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
