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

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import process from "node:process";

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

const distDir = join(ROOT, "dist");
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
["esm", "cjs", "types", "browser"].forEach((d) => mkdirSync(join(distDir, d), { recursive: true }));

// Every `node:` builtin that `src/` references must appear here. The browser
// bundles run with `--platform=browser`, where esbuild refuses to bundle a
// Node builtin at all — it errors rather than stubbing — so a builtin that is
// missing from this list fails `npm run build` the moment a module imports it.
// `node:tls` arrived with the CONNECT-tunnel work in `src/proxy.ts` and
// `node:url` with the IDNA fallback in `src/cookie-parser.ts`; neither was
// added, and the release script runs `npm run build`, so the omission stopped
// a release outright. `tests/build-externals.test.mts` asserts the two sets
// agree so a third cannot be added silently.
const NODE_EXT = [
  "node:http2",
  "node:https",
  "node:http",
  "node:stream",
  "node:net",
  "node:process",
  "node:buffer",
  "node:crypto",
  "node:tls",
  "node:url",
  "node:zlib",
]
  .map((m) => `--external:${m}`)
  .join(" ");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const BANNER = `/* kinetex v${version} | MIT | https://github.com/kinetexjs/kinetex */`;

console.log("\n📦 ESM (Node.js / Bun / bundlers)...");
run(`${TSC} -p tsconfig.esm.json`);
writeFileSync(join(distDir, "esm", "package.json"), JSON.stringify({ type: "module" }));

console.log("\n📦 CJS (legacy require())...");
run(`${TSC} -p tsconfig.cjs.json`);
writeFileSync(join(distDir, "cjs", "package.json"), JSON.stringify({ type: "commonjs" }));

console.log("\n📦 Browser bundles...");
const base = `${ESBUILD} dist/esm/mod.js --bundle --platform=browser --target=es2020 ${NODE_EXT}`;

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
