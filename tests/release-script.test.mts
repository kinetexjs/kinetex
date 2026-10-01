/**
 * scripts/release.ts, tested.
 *
 * The release script is the one program in this repo whose failure is silent
 * and total: v1.4.0 sat on `main` with no tag, and because `release.yml` and
 * `publish.yml` both trigger on `tags: v*`, nothing published and every
 * workflow reported success. Nothing failed. That is why this file exists.
 *
 * These are structural checks on the script's source, not unit tests of
 * exported functions — the script runs as a process against real git and a
 * real GitHub API, and standing up a fake of both to test it would be a
 * parallel implementation that drifts from the real one. So each test asserts
 * a property of the source that, if it stopped being true, would produce
 * exactly the silent no-release outcome above.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "scripts", "release.ts"), "utf8");

/** Source with comments and doc comments stripped, so prose cannot satisfy a check. */
function code(): string {
  return SRC.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("\n── release script — the release cannot end without a tag");

await check("a merged PR is finished, not abandoned", () => {
  // The regression. `gh pr merge` and `git tag` are separate steps, so a human
  // merge — which is the NORMAL outcome, because main requires an approving
  // review — skipped the tag and nothing published.
  const c = code();
  assert.ok(
    /prState === "MERGED"/.test(c),
    "the script must recognise a merged PR as a state it can finish",
  );
  const merged = c.slice(c.indexOf('prState === "MERGED"'));
  const tagAt = merged.search(/git tag -a/);
  assert.ok(tagAt !== -1, "the merged-PR path must reach a git tag");
  assert.ok(
    /git push origin/.test(merged.slice(tagAt, tagAt + 400)),
    "the merged-PR path must push the tag, or nothing downstream fires",
  );
});

await check("every path that ships a version also pushes a tag", () => {
  // The invariant behind the whole file: if a tag is created it is pushed, and
  // if the script believes it has finished a release, a tag was pushed. A new
  // branch that tags without pushing would pass a narrower test and still
  // publish nothing.
  const c = code();
  const tags = (c.match(/git tag -a/g) ?? []).length;
  const pushes = (c.match(/git push origin/g) ?? []).length;
  assert.ok(tags > 0, "expected the script to create a tag somewhere");
  assert.ok(
    pushes >= tags,
    `every 'git tag -a' needs a matching 'git push origin' (tags=${tags}, pushes=${pushes})`,
  );
});

await check("the merged path verifies main carries that version", () => {
  // The guard that matters most. Tagging `origin/main` without checking what is
  // on it would tag whatever commit happens to be there — so a re-run from the
  // wrong branch produces a v1.4.0 that points at unrelated work.
  const c = code();
  const start = c.indexOf('prState === "MERGED"');
  const region = c.slice(start, start + 1400);
  assert.ok(
    /package\.json/.test(region) && /mainVersion/.test(region),
    "the merged path must read the version off origin/main before tagging",
  );
  assert.ok(
    /mainVersion !== version/.test(region),
    "the merged path must compare that version against the one being tagged",
  );
});

await check("it refuses to tag rather than tag the wrong commit", () => {
  const c = code();
  const start = c.indexOf('prState === "MERGED"');
  const region = c.slice(start, start + 1400);
  assert.ok(
    /Refusing to tag/.test(region) && /process\.exit\(1\)/.test(region),
    "a version mismatch must abort the tag, not warn and continue",
  );
});

await check("an existing tag is never overwritten", () => {
  // Re-running the release after a successful one must be a no-op, not a force.
  const c = code();
  assert.ok(
    !/git tag -f/.test(c) && !/git push .*--force/.test(c),
    "the script must never force a tag over an existing one",
  );
});

await check("every path that tags first checks the tag is absent", () => {
  // The guard that mutant C removed. Counting `hasTag(` across the file is not
  // enough — removing one call left the count high enough to pass while the
  // merged-PR path became able to overwrite an existing release. So each path
  // is checked in its own region: a `hasTag` before its `git tag -a`.
  const c = code();
  const regions: Array<[string, number]> = [];
  for (const marker of ['prState === "MERGED"', "function mergeAndTag"]) {
    const at = c.indexOf(marker);
    assert.ok(at !== -1, `expected to find ${marker} in the script`);
    regions.push([marker, at]);
  }
  for (const [marker, at] of regions) {
    const region = c.slice(at, at + 2200);
    const tagAt = region.indexOf("git tag -a");
    assert.ok(tagAt !== -1, `${marker} must create a tag`);
    const before = region.slice(0, tagAt);
    assert.ok(
      /hasTag\(/.test(before),
      `${marker} tags without first checking whether the tag already exists — a re-run would overwrite a published release`,
    );
  }
});

await check("the version is never hand-edited around the script", () => {
  // The script owns the bump. If it ever told a human to edit package.json by
  // hand, a release could ship a version the script did not verify.
  assert.ok(
    /the version bump itself, which this script owns/.test(SRC) || /never\s+hand-edited/.test(SRC),
    "the script must state that it owns the version bump",
  );
});

await check("the script cannot report success without pushing the tag", () => {
  // The failure that started this: the script exited 0 while the release did
  // not exist. The banner that claims a release shipped must come after the
  // push, and the merged path must not return before it.
  const c = code();
  const mergedStart = c.indexOf('prState === "MERGED"');
  const region = c.slice(mergedStart, mergedStart + 2200);
  const pushAt = region.indexOf("git push origin");
  const bannerAt = region.indexOf("banner(");
  assert.ok(pushAt !== -1, "the merged path must push the tag");
  assert.ok(bannerAt !== -1, "the merged path must report what it did");
  assert.ok(
    pushAt < bannerAt,
    "the success banner must come after the push — otherwise the script claims a release it has not made",
  );
});

await check("the tag is created on the commit that landed, not the branch head", () => {
  // `git tag` with no argument tags HEAD, which after a squash merge is the
  // local release branch — a commit that is not on main and never will be.
  const c = code();
  const tagLines = c.split("\n").filter((l) => /git tag -a/.test(l));
  assert.ok(tagLines.length > 0, "expected at least one tag command");
  for (const line of tagLines) {
    assert.ok(
      /origin\/main/.test(line),
      `a tag must name origin/main explicitly, or it tags the local branch head: ${line.trim()}`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`  ❌ ${name}: ${String(err)}`);
  process.exit(1);
}
process.exit(0);
