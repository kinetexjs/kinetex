/**
 * Discover the `node:` builtins referenced by `src/`, for the browser bundles.
 *
 * The browser bundles build with `--platform=browser`, where esbuild refuses to
 * bundle a Node builtin: it errors instead of stubbing. So every `node:`
 * specifier under `src/` has to be marked external, and when that set was
 * written out by hand in `scripts/build.ts` it fell behind `src/` twice —
 * `node:tls` with the CONNECT-tunnel work in `src/proxy.ts`, and `node:url` with
 * the IDNA fallback in `src/cookie-parser.ts`. `npm run build` is the first
 * thing `scripts/release.ts` runs, so each omission stopped a release outright.
 *
 * Deriving the set removes the class of bug rather than the two instances: there
 * is no longer a list that an import can outrun. This lives in its own module
 * rather than inline in the build script so `tests/build-externals.test.mts` can
 * exercise the code that actually runs — a copy of the scan in the test would
 * pass while the real one rotted.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts` file under `dir`, recursively. */
export function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Strip comments, then collect every `node:` specifier.
 *
 * Comments go first because a `node:` name mentioned in a comment is not a
 * reference — `node:quic` appears only that way in `src/types.ts`, and scanning
 * it would mean the list grows on stale references the moment the comment
 * stripping breaks.
 *
 * Two rules, not three: a line that is entirely a `//` comment is already
 * removed by the trailing-comment rule, which cuts from the first `//` to the
 * end of the line whatever precedes it. A separate whole-line rule was tried and
 * dropped — it changed nothing, and a rule that cannot change the result is one
 * more thing to keep correct.
 *
 * All three quote styles are matched, because the imports this has to catch are
 * dynamic: `await import("node:tls")` and `await import("node:url")` are both
 * reached at runtime rather than from a top-level import statement.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The `node:` specifiers referenced by every `.ts` file under `dir`. */
export function referencedNodeBuiltins(dir: string): Set<string> {
  const found = new Set<string>();
  for (const file of tsFiles(dir)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/["'`](node:[a-z0-9_]+)["'`]/g)) found.add(m[1]!);
  }
  return found;
}

/**
 * The externals to pass to esbuild, sorted so the build command is stable.
 *
 * An empty result means the scan matched nothing, which would leave the browser
 * bundles externalising nothing and failing on the first builtin they met. That
 * is a broken scan rather than a source tree with no Node code, so it throws
 * here where the message can say so.
 */
export function nodeExternals(srcDir: string): string[] {
  const found = referencedNodeBuiltins(srcDir);
  if (found.size === 0) {
    throw new Error(
      "nodeExternals: no `node:` builtins found in src/ — the scan is broken, not the source tree",
    );
  }
  return [...found].sort();
}
