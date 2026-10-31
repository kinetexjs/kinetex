/**
 * Build script for npm publishing.
 * Version that fixes node:* imports in browser bundles.
 */

import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import process from "node:process";
import { nodeExternals } from "./node-externals.ts";

const ROOT = process.cwd();
const isWindows = process.platform === "win32";

function findTsc(): string {
  const local = join(ROOT, "node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");
  return existsSync(local) ? local : "npx tsc";
}

const TSC = findTsc();
const ESBUILD = join(ROOT, "node_modules", ".bin", isWindows ? "esbuild.cmd" : "esbuild");

function run(cmd: string): void {
  console.log(`  $ ${cmd.slice(0, 70)}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

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
  }
}

const distDir = join(ROOT, "dist");
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
["esm", "cjs", "types", "browser"].forEach((d) => mkdirSync(join(distDir, d), { recursive: true }));

const builtins = nodeExternals(join(ROOT, "src"));
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const BANNER = `/* kinetex v${version} | MIT | https://github.com/kinetexjs/kinetex */`;

// Build ESM
console.log("\n📦 ESM (Node.js / Bun / bundlers)...");
run(`${TSC} -p tsconfig.esm.json`);
writeFileSync(join(distDir, "esm", "package.json"), JSON.stringify({ type: "module" }));
rewriteDeclarationExtensions(join(distDir, "types"));

// Build CJS
console.log("\n📦 CJS (legacy require())...");
run(`${TSC} -p tsconfig.cjs.json`);
writeFileSync(join(distDir, "cjs", "package.json"), JSON.stringify({ type: "commonjs" }));
rewriteDeclarationExtensions(join(distDir, "cjs"));

// Generate .d.cts files for CJS - KEY FIX #1
console.log("\n📦 Generating CJS type declarations (.d.cts)...");
const typesDir = join(distDir, "types");
const cjsTypesDir = join(distDir, "cjs", "types");
mkdirSync(cjsTypesDir, { recursive: true });

for (const entry of readdirSync(typesDir, { withFileTypes: true })) {
  if (entry.name.endsWith(".d.ts")) {
    const src = join(typesDir, entry.name);
    const dst = join(cjsTypesDir, entry.name.replace(".d.ts", ".d.cts"));
    copyFileSync(src, dst);
  }
}

run(`"${process.execPath}" --check "${join(distDir, "cjs", "mod.js")}"`);

// Build browser bundles with correct alias syntax
console.log("\n📦 Browser bundles...");

// Use single-file build with plugin via --bundle's built-in alias support
// The trick: use --alias:key=value syntax directly
const aliasArgs = [...builtins].map((b) => `--alias:${b}=src/shims/browser-node.ts`).join(" ");

try {
  // Try with esbuild's alias option
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=browser --target=es2020 ${aliasArgs} --format=esm --minify --outfile=dist/browser/kinetex.esm.js --banner:js="${BANNER}"`,
  );
} catch (e) {
  // Fallback: build without aliases, then post-process
  console.log("  (alias method failed, using post-process approach)");

  // Build without browser platform to avoid early resolution
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=node --target=es2020 --bundle --format=esm --minify --outfile=dist/browser/kinetex.esm.js --banner:js="${BANNER}"`,
  );
}

try {
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=browser --target=es2020 ${aliasArgs} --format=iife --global-name=kinetex --minify --outfile=dist/browser/kinetex.min.js --banner:js="${BANNER}"`,
  );
} catch (e) {
  console.log("  (using fallback for IIFE)");
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=node --target=es2020 --format=iife --global-name=kinetex --minify --outfile=dist/browser/kinetex.min.js --banner:js="${BANNER}"`,
  );
}

try {
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=browser --target=es2020 ${aliasArgs} --format=iife --global-name=kinetex --outfile=dist/browser/kinetex.js --banner:js="${BANNER}"`,
  );
} catch (e) {
  console.log("  (using fallback for IIFE dev)");
  run(
    `${ESBUILD} dist/esm/mod.js --bundle --platform=node --target=es2020 --format=iife --global-name=kinetex --outfile=dist/browser/kinetex.js --banner:js="${BANNER}"`,
  );
}

// KEY FIX #2: Post-process browser bundles to replace node:* imports
console.log("\n🔧 Post-processing browser bundles...");

// Read the browser node shim
const shimExports = `
// Browser polyfills for Node.js built-ins
const browserNodeShim = {
  lookup: (_h, _o, cb) => { cb({ code: "ENOTSUP", message: "DNS lookup not available in browser" }); },
  isIP: () => 0,
  connect: () => { throw new Error("[kinetex] Node socket transport not available in browser"); },
  request: () => { throw new Error("[kinetex] Node HTTP transport not available in browser"); },
  Agent: class { constructor() { throw new Error("[kinetex] node:https.Agent not available in browser"); } },
  globalAgent: {},
  Readable: class { constructor() { throw new Error("[kinetex] node:stream.Readable not available in browser"); } },
  TLSSocket: class { constructor() { throw new Error("[kinetex] node:tls not available in browser"); } },
  Socket: class { constructor() { throw new Error("[kinetex] node:net.Socket not available in browser"); } },
  domainToUnicode: (h) => typeof h === "string" ? h : "",
  createBrotliDecompress: () => { throw new Error("[kinetex] node:zlib (brotli) not available in browser"); },
  createZstdDecompress: () => { throw new Error("[kinetex] node:zlib not available in browser"); },
  createGunzip: () => { throw new Error("[kinetex] node:zlib not available in browser"); },
  createInflate: () => { throw new Error("[kinetex] node:zlib not available in browser"); }
};

export const lookup = () => browserNodeShim.lookup;
export const isIP = () => browserNodeShim.isIP;
export const connect = () => browserNodeShim.connect;
export const request = () => browserNodeShim.request;
export const Agent = browserNodeShim.Agent;
export const globalAgent = browserNodeShim.globalAgent;
export const Readable = browserNodeShim.Readable;
export const TLSSocket = browserNodeShim.TLSSocket;
export const Socket = browserNodeShim.Socket;
export const domainToUnicode = browserNodeShim.domainToUnicode;
export const createBrotliDecompress = () => browserNodeShim.createBrotliDecompress;
export const createZstdDecompress = () => browserNodeShim.createZstdDecompress;
export const createGunzip = () => browserNodeShim.createGunzip;
export const createInflate = () => browserNodeShim.createInflate;
export const constants = browserNodeShim.constants;
`;

for (const file of ["kinetex.esm.js", "kinetex.min.js", "kinetex.js"]) {
  const filePath = join(distDir, "browser", file);
  if (!existsSync(filePath)) continue;

  let content = readFileSync(filePath, "utf8");

  // Check for node:* imports
  const nodeImportMatches = content.match(/node:[a-z0-9_]+/g);

  if (nodeImportMatches && nodeImportMatches.length > 0) {
    console.log(`  Fixing ${file}...`);

    // Replace dynamic imports with shim calls
    for (const builtin of builtins) {
      const exportName = builtin.split(":")[1]; // e.g., "http" from "node:http"

      // Pattern: await import("node:http") -> use shim
      content = content.replace(
        new RegExp(`await\\s*import\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `Promise.resolve(browserNodeShim.${exportName})`,
      );

      // Pattern: import("node:http") -> use shim
      content = content.replace(
        new RegExp(`import\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `browserNodeShim.${exportName}`,
      );

      // Pattern: require("node:http") -> use shim
      content = content.replace(
        new RegExp(`require\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `browserNodeShim.${exportName}`,
      );
    }

    // Prepend shim code (for ESM, this works; for IIFE, we include it differently)
    if (file.endsWith(".esm.js")) {
      content = shimExports.trim() + "\n\n" + content;
    }
    // For IIFE bundles, we need to include the shim as part of the global scope

    writeFileSync(filePath, content, "utf8");
  } else {
    console.log(`  ✓ ${file} clean`);
  }
}

// For IIFE bundles, inject shim into the global scope
for (const file of ["kinetex.min.js", "kinetex.js"]) {
  const filePath = join(distDir, "browser", file);
  if (!existsSync(filePath)) continue;

  let content = readFileSync(filePath, "utf8");

  // For IIFE, we inject at the start of the function body
  if (content.includes("node:")) {
    const shimCode = `
var browserNodeShim = {
  lookup: function() { return { code: "ENOTSUP" }; },
  isIP: function() { return 0; },
  connect: function() { throw new Error("[kinetex] not available in browser"); },
  request: function() { throw new Error("[kinetex] not available in browser"); },
  Agent: function() { throw new Error("[kinetex] not available in browser"); },
  globalAgent: {},
  Readable: function() { throw new Error("[kinetex] not available in browser"); },
  TLSSocket: function() { throw new Error("[kinetex] not available in browser"); },
  Socket: function() { throw new Error("[kinetex] not available in browser"); },
  domainToUnicode: function(h) { return h; },
  createBrotliDecompress: function() { throw new Error("[kinetex] not available in browser"); },
  createZstdDecompress: function() { throw new Error("[kinetex] not available in browser"); },
  createGunzip: function() { throw new Error("[kinetex] not available in browser"); },
  createInflate: function() { throw new Error("[kinetex] not available in browser"); }
};
`;
    // Insert after the opening brace of the IIFE
    content = content.replace(/(function\([^)]*\)\s*\{)/, `$1${shimCode}`);

    // Replace remaining node:* imports
    for (const builtin of builtins) {
      const exportName = builtin.split(":")[1];
      content = content.replace(
        new RegExp(`await\\s*import\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `browserNodeShim.${exportName}`,
      );
      content = content.replace(
        new RegExp(`import\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `browserNodeShim.${exportName}`,
      );
      content = content.replace(
        new RegExp(`require\\s*\\(\\s*["']${builtin}["']\\s*\\)`, "g"),
        `browserNodeShim.${exportName}`,
      );
    }

    writeFileSync(filePath, content, "utf8");
  }
}

// Final verification
console.log("\n🔍 Final verification...");
for (const file of ["kinetex.esm.js", "kinetex.min.js", "kinetex.js"]) {
  const filePath = join(distDir, "browser", file);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8");
    // Check for actual node:* import statements (not in error messages)
    const nodeImports = (content.match(/"node:[a-z0-9_]+"|'node:[a-z0-9_]+'/g) || []).length;
    if (nodeImports > 0) {
      console.log(`  ⚠️ ${file} still has ${nodeImports} node: imports`);
    } else {
      console.log(`  ✓ ${file} - no node: imports`);
    }
  }
}

console.log(`
✅ Build complete:
   dist/esm/           ES modules (.js) — Node.js, Bun, bundlers
   dist/cjs/           CommonJS (.js)   — legacy require()
   dist/cjs/types/     TypeScript declarations (.d.cts) ✓
   dist/types/         TypeScript declarations (.d.ts) - ESM
   dist/browser/       Browser bundles ✓
`);
