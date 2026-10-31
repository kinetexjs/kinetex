/**
 * Build script for npm publishing.
 * Works under both Node.js (npx tsx scripts/build.ts)
 * and Deno (deno run --allow-read --allow-write --allow-run scripts/build.ts)
 *
 * Outputs:
 *   dist/esm/     — ES modules (Node / Bun / bundlers)
 *   dist/cjs/     — CommonJS (legacy require())
 *   dist/types/   — TypeScript declarations (.d.ts)
 *   dist/browser/ — Browser bundles for unpkg / jsDelivr / <script>
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import process from "node:process";
import { nodeExternals } from "./node-externals.ts";

const ROOT = process.cwd();
const isWindows = process.platform === "win32";

function findTsc(): string {
  const local = join(ROOT, "node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");
  if (existsSync(local)) return local;
  return "npx tsc";
}

// Detect esbuild
function findEsbuild(): string {
  const local = join(ROOT, "node_modules", ".bin", isWindows ? "esbuild.cmd" : "esbuild");
  if (existsSync(local)) return local;
  return "npx esbuild";
}

const TSC = findTsc();
const ESBUILD = findEsbuild();

function run(cmd: string): void {
  console.log(`  $ ${cmd.slice(0, 90)}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

/**
 * Rewrite `.ts` specifiers in emitted declarations to `.js`.
 *
 * TypeScript's `rewriteRelativeImportExtensions` rewrites the JavaScript
 * output but leaves `.ts` in `.d.ts` files. A consumer without
 * `allowImportingTsExtensions` then fails to resolve the published types, and
 * a CJS consumer gets TS1479 on top. A `.js` specifier resolves to the
 * neighbouring `.d.ts` for the type checker and to the emitted `.js` file at
 * runtime, so it is correct for both module systems.
 *
 * The build fails if any `.ts` specifier survives, rather than publishing a
 * declaration tree that only type-checks with a non-default compiler option.
 */
function rewriteDeclarationExtensions(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationExtensions(path);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;

    const before = readFileSync(path, "utf8");
    const after = before
      .replace(/(\bfrom\s*["'][^"']+)\.ts(["'])/g, "$1.js$2")
      .replace(/(\bimport\s*\(\s*["'][^"']+)\.ts(["']\s*\))/g, "$1.js$2")
      .replace(/(\brequire\s*\(\s*["'][^"']+)\.ts(["']\s*\))/g, "$1.js$2");

    if (after !== before) writeFileSync(path, after);
    if (/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'][^"']+\.ts["']/.test(after)) {
      throw new Error(`Declaration still references a .ts specifier: ${path}`);
    }
  }
}

const distDir = join(ROOT, "dist");
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
["esm", "cjs", "types", "browser"].forEach((d) => mkdirSync(join(distDir, d), { recursive: true }));

// Discovered from `src/` rather than listed by hand: see ./node-externals.ts for
// why a hand-written list kept failing the release build.
//
// The browser bundle aliases each builtin to a browser shim rather than marking
// it external. An external `node:*` specifier is legal in esbuild's browser
// output but makes the *published* bundle unusable: the next bundler that sees
// it (Vite, webpack, a second esbuild pass) fails to resolve the builtin. The
// shim preserves the dynamic-import shape, so Node-only code paths still throw
// a clear error if a browser ever reaches them, while the browser path never
// touches them.
const BROWSER_SHIM = join(ROOT, "src", "shims", "browser-node.ts");
const NODE_ALIAS = nodeExternals(join(ROOT, "src"))
  .map((m) => `--alias:${m}=${BROWSER_SHIM}`)
  .join(" ");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const BANNER = `/* kinetex v${version} | MIT | https://github.com/kinetexjs/kinetex */`;

console.log("\n📦 ESM (Node.js / Bun / bundlers)...");
run(`${TSC} -p tsconfig.esm.json`);
writeFileSync(join(distDir, "esm", "package.json"), JSON.stringify({ type: "module" }));
rewriteDeclarationExtensions(join(distDir, "types"));

console.log("\n📦 CJS (legacy require())...");
run(`${TSC} -p tsconfig.cjs.json`);
writeFileSync(join(distDir, "cjs", "package.json"), JSON.stringify({ type: "commonjs" }));
rewriteDeclarationExtensions(join(distDir, "cjs"));
run(`"${process.execPath}" --check "${join(distDir, "cjs", "mod.js")}"`);

console.log("\n📦 Browser bundles...");
const base = `${ESBUILD} dist/esm/mod.js --bundle --platform=browser --target=es2020 ${NODE_ALIAS}`;

run(`${base} --format=esm --minify --outfile=dist/browser/kinetex.esm.js --banner:js="${BANNER}"`);

run(
  `${base} --format=iife --global-name=kinetex --minify --outfile=dist/browser/kinetex.min.js --banner:js="${BANNER}"`,
);

run(
  `${base} --format=iife --global-name=kinetex --outfile=dist/browser/kinetex.js --banner:js="${BANNER}"`,
);

console.log(`
✅ Build complete:
   dist/esm/                    ES modules (.js) — Node.js, Bun, bundlers
   dist/cjs/                    CommonJS (.js)   — legacy require()
   dist/types/                  TypeScript declarations (.d.ts)
   dist/browser/kinetex.esm.js  ESM bundle — Vite / webpack / Parcel
   dist/browser/kinetex.min.js  IIFE minified — <script> / unpkg / jsDelivr
   dist/browser/kinetex.js      IIFE dev build  — readable source

CDN usage:
   https://unpkg.com/kinetex/dist/browser/kinetex.min.js
   https://cdn.jsdelivr.net/npm/kinetex/dist/browser/kinetex.min.js
`);
