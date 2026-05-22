import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");

// 1. Generate markdown via typedoc-plugin-markdown
execSync("npx typedoc --tsconfig tsconfig.check.json --entryPoints src/mod.ts --out docs --plugin typedoc-plugin-markdown --outputFileStrategy Modules --flattenOutputFiles --hideGenerator --hidePageHeader", { stdio: "inherit", cwd: ROOT });

// 2. Concatenate all .md files into single README.md
let combined = "";
const files: string[] = [];

function collect(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full);
    else if (entry.endsWith(".md")) files.push(full);
  }
}
collect(DOCS);

// Sort: README.md first, then everything else in a consistent order
files.sort((a, b) => {
  if (a.endsWith("README.md")) return -1;
  if (b.endsWith("README.md")) return 1;
  return a.localeCompare(b);
});

const seen = new Set<string>();
for (const f of files) {
  if (seen.has(f)) continue;
  seen.add(f);
  const content = readFileSync(f, "utf-8");
  // Strip the file if it only contains links / navigation
  if (content.trim().length < 50) continue;
  combined += content + "\n\n---\n\n";
}

// 3. Remove all subfiles
for (const f of files) {
  if (f !== join(DOCS, "README.md")) {
    try { rmSync(f); } catch { /* ignore */ }
  }
}

// 4. Clean up empty subdirectories
function cleanDirs(dir: string): boolean {
  let hasFiles = false;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!cleanDirs(full)) rmSync(full);
      else hasFiles = true;
    } else {
      hasFiles = true;
    }
  }
  return hasFiles;
}
cleanDirs(DOCS);

// 5. Write combined README
writeFileSync(join(DOCS, "README.md"), combined.trim() + "\n");
console.log(`\n✅ Single README.md written (${combined.length} bytes)`);
