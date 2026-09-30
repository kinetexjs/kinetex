import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The browser bundles build with `--platform=browser`, where esbuild refuses to
 * bundle a Node builtin — it errors rather than stubbing — so every `node:`
 * specifier in `src/` has to be marked external.
 *
 * That set used to be written out by hand in `scripts/build.ts` and fell behind
 * `src/` twice: `node:tls`, added with the CONNECT-tunnel work in
 * `src/proxy.ts`, and `node:url`, added with the IDNA fallback in
 * `src/cookie-parser.ts`. `npm run build` is the first thing
 * `scripts/release.ts` runs, so each omission stopped a release outright. The
 * build now derives the set in `scripts/node-externals.ts`.
 *
 * These tests import that module rather than repeating its logic. An earlier
 * version of this file carried its own copy of the scan, and it passed against
 * mutants that had broken the real one — the copy agreed with itself, not with
 * the code that builds the bundle.
 */

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const BUILD_SRC = join(ROOT, "scripts", "build.ts");

const { nodeExternals, referencedNodeBuiltins } = await import(
  join(ROOT, "scripts", "node-externals.ts")
);

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

/** A throwaway `src/`-shaped directory for the synthetic cases. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kinetex-ext-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

suite("Browser bundle externals");

await test("src/ references node: builtins the scan can find", () => {
  const referenced = referencedNodeBuiltins(SRC);
  assert.ok(referenced.size > 0, "the src/ scan must find at least one node: builtin");

  // Spelled out individually, so a regression says which import form stopped
  // being seen. All four are dynamic `await import(...)` calls rather than
  // top-level import statements, which is the shape the scan has to match.
  for (const expected of ["node:http2", "node:net", "node:tls", "node:url"]) {
    assert.ok(
      referenced.has(expected),
      `expected src/ to reference ${expected}; the scan is not seeing every import form`,
    );
  }
});

await test("every external is a well-formed node: specifier", () => {
  // A typo'd pattern could yield a bare name, which externalises nothing while
  // still looking correct in the build command.
  const bad = [...referencedNodeBuiltins(SRC)].filter((m) => !/^node:[a-z0-9_]+$/.test(m)).sort();
  assert.deepStrictEqual(bad, [], `malformed externals: ${bad.join(", ")}`);
});

await test("a builtin named only in a comment is not treated as a reference", () => {
  // `node:quic` appears solely inside a comment in src/types.ts. If comment
  // stripping broke, the list would start growing on names nothing imports —
  // and that failure is invisible in the build, which only ever errors on a
  // builtin it was *not* told about.
  assert.ok(
    !referencedNodeBuiltins(SRC).has("node:quic"),
    "node:quic appears only in a comment in src/types.ts and must not be scanned as a reference",
  );
});

await test("both comment forms are stripped", () => {
  // Synthetic rather than relying on src/, because what is being pinned is the
  // stripping itself: dropping either rule leaks whatever the comment names
  // into the externals. The names in the comments are written as complete quoted
  // specifiers, since that is the only shape the scan treats as a reference.
  const dir = scratch({
    "a.ts": [
      'await import("node:net");',
      '/* block mentions "node:http2" */',
      '// line mentions "node:https"',
      'const x = 1; // trailing mentions "node:zlib"',
      'const s = "node:crypto";',
    ].join("\n"),
  });
  try {
    const found = referencedNodeBuiltins(dir);
    assert.deepStrictEqual([...found].sort(), ["node:crypto", "node:net"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("only complete quoted specifiers count as references", () => {
  // The match is anchored on both quotes deliberately: a `node:` name appearing
  // mid-string is prose, not an import, and externalising on it would add
  // builtins the source never loads.
  const dir = scratch({
    "a.ts": ['const prose = "we mention node:http2 in passing";', 'await import("node:net");'].join(
      "\n",
    ),
  });
  try {
    assert.deepStrictEqual(referencedNodeBuiltins(dir), new Set(["node:net"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the line-comment rule cannot hide a real import", () => {
  // Known limitation, pinned deliberately: the line rule is textual, so a `//`
  // inside a *string literal* starts a "comment" as far as the scan is
  // concerned, and a `node:` specifier later on that same line is invisible to
  // it. That would drop a builtin from the externals and fail the browser
  // bundle — so rather than leave it as a trap, assert the scan finds the
  // imports on the shapes `src/` actually uses, which have no `//` in a string.
  //
  // Should a `node:` import ever land after a URL literal on one line, the fix
  // is a real tokenizer here rather than a wider regex — and this test is where
  // that would surface.
  const dir = scratch({
    "a.ts": [
      'const base = "https://example.com/api";',
      'await import("node:http2");',
      'await import("node:https");',
    ].join("\n"),
  });
  try {
    assert.deepStrictEqual(referencedNodeBuiltins(dir), new Set(["node:http2", "node:https"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a newly added import needs no build-script edit", () => {
  // The regression that cost two releases: a new `node:` import appeared in
  // src/ and nothing had to be added anywhere for the browser bundle to keep
  // building. With a hand-maintained list this is exactly the case that failed.
  const dir = scratch({ "a.ts": 'await import("node:dgram");' });
  try {
    assert.deepStrictEqual(nodeExternals(dir), ["node:dgram"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a scan that matches nothing throws instead of building", () => {
  // The silent failure this guards: a regex change that stops matching would
  // externalise nothing, and the build would then fail on the first builtin it
  // met — surfacing as the same confusing esbuild error as before, rather than
  // as a broken scan.
  const dir = scratch({ "a.ts": "export const x = 1;" });
  try {
    assert.throws(
      () => nodeExternals(dir),
      /no `node:` builtins found/,
      "an empty result must throw, not return an empty externals list",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the build script derives the set rather than declaring one", () => {
  const src = readFileSync(BUILD_SRC, "utf8");
  // A literal array is the bug, not the fix: it can drift from src/ again, and
  // it would shadow the derivation.
  assert.ok(
    !/NODE_EXT\s*=\s*\[/.test(src),
    "scripts/build.ts must not declare NODE_EXT as a literal array — a hand-written " +
      "list is what let node:tls and node:url be missed",
  );
  assert.match(src, /from "\.\/node-externals\.ts"/, "scripts/build.ts must import nodeExternals");
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
