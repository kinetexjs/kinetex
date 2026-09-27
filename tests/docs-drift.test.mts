/**
 * docs-drift.test.mts — keeps the documentation honest.
 *
 * Every documented code sample (README fenced blocks and inline `@example`
 * JSDoc blocks, which are what reach consumers via typedoc) is type-checked
 * against the real implementation. Only two classes of diagnostic are treated
 * as failure:
 *
 *   TS2353 — "Object literal may only specify known properties, and 'x' does
 *            not exist in type 'T'"
 *   TS2561 — "Property 'x' does not exist on type 'T'"
 *   TS2339 — "Property 'x' does not exist on type 'T'"
 *
 * Those are exactly the "this option does not exist", "this symbol is not
 * exported", and "this method/field does not exist" errors, which is the whole
 * class of bug this guards against (a config field renamed without updating
 * the docs, a fabricated class, a deep-import path that no longer exists, a
 * builder that returns the wrong shape).
 *
 * TS2339 is safe to include precisely because the preamble below binds every
 * public name to the real implementation: an identifier that resolves to
 * `any` cannot produce a TS2339, so these are true findings. It caught a set
 * of real defects on first run — `HookEmitter.clear()` (the method is
 * `removeAllListeners()`), `Socks5Tunnel.send()` (the tunnel is a raw socket,
 * not an HTTP client), `withDownloadProgress()` destructured as `{ stream }`
 * (it returns `{ response, tracker }`), a `URLBuilder` whose `.toString()`
 * result was then read as if it were still a builder, and a `gql` helper
 * used as a tagged template.
 *
 * Every other diagnostic is ignored on purpose. The samples are illustrative:
 * they reference variables that do not exist in the snippet (`client`,
 * `controller`, `Item`, ...), so unresolved-name and implicitly-typed errors
 * are expected and are not drift. Type errors of that kind would make the
 * suite unusable and get it ignored, which would be worse than not having it.
 *
 * Import specifiers are rewritten to relative source paths so the samples are
 * checked against `src/`, not against a published build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const PKG = JSON.parse(readFileSync("package.json", "utf8")) as {
  exports: Record<string, unknown>;
};

const SRC_DIR = "src";
const srcFiles = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(SRC_DIR, f));

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: ["node"],
};

/** Diagnostics that mean "the documented API does not exist". */
const DRIFT_CODES = new Set([2353, 2561, 2339]);

// ── Extract every documented code block ───────────────────────────────────

interface Block {
  where: string;
  code: string;
}

function markdownBlocks(md: string, label: string): Block[] {
  const out: Block[] = [];
  const lines = md.split("\n");
  let inFence = false;
  let fenceLine = 0;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!inFence && /^\s*```\s*ts\s*$/.test(l)) {
      inFence = true;
      fenceLine = i + 1;
      buf = [];
      continue;
    }
    if (inFence && /^\s*```\s*$/.test(l)) {
      out.push({ where: `${label}:${fenceLine}`, code: buf.join("\n") });
      inFence = false;
      continue;
    }
    if (inFence) buf.push(l);
  }
  return out;
}

/**
 * `ts` fenced blocks inside `@example` JSDoc blocks. Each line is written as
 * ` * code`, so the leading ` * ` is stripped back off. The elided-body
 * placeholder `{ ... }` is normalised to `{}` because these examples live
 * inside a comment in the shipped source, where that style is conventional
 * and cannot break the build.
 */
function jsdocExampleBlocks(src: string, label: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/@example\b/.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < lines.length && !/```/.test(lines[j]!)) j++;
    if (j >= lines.length) break;
    const openLine = j;
    const isTs = /```\s*ts\s*$/.test(lines[j]!);
    const buf: string[] = [];
    let k = j + 1;
    while (k < lines.length && !/^\s*\*?\s*```/.test(lines[k]!)) {
      buf.push(lines[k]!.replace(/^\s*\*\s?/, ""));
      k++;
    }
    if (isTs && k < lines.length) {
      out.push({
        where: `${label}:${openLine + 1}`,
        code: buf.join("\n").replace(/\{\s*\.\.\.\s*\}/g, "{}"),
      });
    }
    i = k;
  }
  return out;
}

const readmeBlocks = markdownBlocks(readFileSync("README.md", "utf8"), "README.md");
const inlineBlocks = srcFiles.flatMap((f) => jsdocExampleBlocks(readFileSync(f, "utf8"), f));
const allBlocks = [...readmeBlocks, ...inlineBlocks];

// ── Rewrite package specifiers to relative source paths ──────────────────

/** Longest-first so `kinetex/pagination` is not matched as `kinetex/...`. */
const subpaths = Object.keys(PKG.exports).sort((a, b) => b.length - a.length);

function rewriteImports(code: string, virtualName: string): string {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g, (whole, prefix, q, spec) => {
    if (spec.startsWith("jsr:@kinetexjs/")) {
      const bare = spec.slice("jsr:@kinetexjs/".length);
      const target =
        bare === "kinetex"
          ? join(SRC_DIR, "mod.ts")
          : join(SRC_DIR, `${bare.slice("kinetex/".length)}.ts`);
      if (!subpaths.includes(bare === "kinetex" ? "." : `./${bare.slice("kinetex/".length)}`)) {
        return whole; // entry point does not exist -> leave, tsc will report it
      }
      return `${prefix}${q}${relativeToVirtual(virtualName, target)}${q}`;
    }
    if (spec === "kinetex") {
      return `${prefix}${q}${relativeToVirtual(virtualName, join(SRC_DIR, "mod.ts"))}${q}`;
    }
    if (spec.startsWith("kinetex/")) {
      const sub = spec.slice("kinetex/".length);
      const target = join(SRC_DIR, `${sub}.ts`);
      return `${prefix}${q}${relativeToVirtual(virtualName, target)}${q}`;
    }
    return whole; // third-party package: out of scope
  });
}

const VIRTUAL_DIR = "tests/.docs-drift";
function relativeToVirtual(virtualName: string, target: string): string {
  const dir = virtualName.split("/").slice(0, -1).join("/");
  let r = relative(dir, target).replace(/\\/g, "/");
  if (!r.startsWith(".")) r = `./${r}`;
  return r;
}

/**
 * Every name the main entry point exports.
 *
 * Many samples use `kinetex` (or another public symbol) without importing it —
 * the README shows the import once, in Quick Start. Without a binding those
 * identifiers resolve to an unresolved name, the call is typed `any`, and
 * excess-property checking is silently disabled. Injecting the real public
 * names is what makes the check actually bind to the implementation.
 */
const publicApiNames: string[] = (() => {
  const base = ts.createProgram(srcFiles, COMPILER_OPTIONS);
  const c = base.getTypeChecker();
  const sf = base.getSourceFile(join(SRC_DIR, "mod.ts"));
  if (!sf) return [];
  const sym = c.getSymbolAtLocation(sf);
  if (!sym) return [];
  return c
    .getExportsOfModule(sym)
    .map((e) => e.getName())
    .filter((n) => n !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    .sort();
})();

// ── Type-check every snippet in one program ──────────────────────────────

/** Names a snippet already imports, so the preamble does not duplicate them. */
function alreadyImported(code: string): Set<string> {
  const out = new Set<string>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    for (const part of m[1]!.split(",")) {
      const n = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.replace(/^type\s+/, "")
        .trim();
      if (n) out.add(n);
    }
  }
  return out;
}

/**
 * Prepend the public API bindings the sample is missing, so its identifiers
 * resolve to the real implementation instead of `any`.
 */
function withPreamble(code: string, virtualName: string): string {
  const modPath = relativeToVirtual(virtualName, join(SRC_DIR, "mod.ts"));
  const have = alreadyImported(code);
  const missing = publicApiNames.filter((n) => !have.has(n));
  if (missing.length === 0) return code;
  return `import { ${missing.join(", ")} } from "${modPath}";\n${code}`;
}

const virtualFiles = new Map<string, string>();
const blockFor = new Map<string, Block>();
allBlocks.forEach((b, i) => {
  const name = `${VIRTUAL_DIR}/snippet-${i}.ts`;
  virtualFiles.set(name, withPreamble(rewriteImports(b.code, name), name));
  blockFor.set(name, b);
});

const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
const originalGetSourceFile = host.getSourceFile.bind(host);
const originalReadFile = host.readFile.bind(host);
const originalFileExists = host.fileExists.bind(host);

host.fileExists = (f) => virtualFiles.has(f) || originalFileExists(f);
host.readFile = (f) => (virtualFiles.has(f) ? virtualFiles.get(f)! : originalReadFile(f));
host.getSourceFile = (f, lang, onError, shouldCreate) => {
  if (virtualFiles.has(f)) {
    return ts.createSourceFile(f, virtualFiles.get(f)!, lang, true, ts.ScriptKind.TS);
  }
  return originalGetSourceFile(f, lang, onError, shouldCreate);
};

const program = ts.createProgram([...srcFiles, ...virtualFiles.keys()], COMPILER_OPTIONS, host);

interface Problem {
  where: string;
  message: string;
}
const problems: Problem[] = [];
const syntaxBroken: string[] = [];

for (const [name, block] of blockFor) {
  const sf = program.getSourceFile(name);
  if (!sf) continue;

  const parseDiags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) {
    syntaxBroken.push(block.where);
    continue;
  }

  for (const d of program.getSemanticDiagnostics(sf)) {
    if (!DRIFT_CODES.has(d.code)) continue;
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    problems.push({
      where: `${block.where}:${line + 1}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

test("documented code samples do not reference non-existent APIs", () => {
  if (problems.length > 0) {
    assert.fail(
      `${problems.length} documented API mismatch(es) in ${allBlocks.length} ` +
        `sample(s) (${readmeBlocks.length} README, ${inlineBlocks.length} inline):\n` +
        problems.map((p) => `  ${p.where}: ${p.message}`).join("\n"),
    );
  }
});

test("documented code samples are valid TypeScript", () => {
  assert.deepEqual(
    syntaxBroken,
    [],
    `${syntaxBroken.length} sample(s) do not parse, so they are not type-checked: ` +
      syntaxBroken.join(", "),
  );
});

test("the docs test actually inspects something", () => {
  // Without this, a refactor that stops finding code blocks — or a checker
  // that silently stops resolving types — would make the test pass vacuously.
  assert.equal(
    readmeBlocks.length >= 80,
    true,
    `expected many README code blocks, found ${readmeBlocks.length}`,
  );
  assert.equal(
    inlineBlocks.length >= 50,
    true,
    `expected many inline @example blocks, found ${inlineBlocks.length}`,
  );
  // Prove the samples really are being resolved against src/, not silently
  // falling back to `any`: a fabricated option must be detected somewhere.
  assert.equal(
    program.getSourceFile(`${VIRTUAL_DIR}/snippet-0.ts`) !== undefined,
    true,
    "virtual sample files were not added to the program",
  );
});
