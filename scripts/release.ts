#!/usr/bin/env node
/**
 * scripts/release.ts
 *
 * Prepares a release via PROTECTED-MAIN-SAFE pull request flow.
 *
 * `main` is protected (PRs only, 1 approving review required, no bypass), so a
 * direct `git push origin main` is always rejected. This script therefore:
 *
 *  1. Validates the working tree is clean and level with origin/main
 *  2. Bumps the version in package.json and deno.json
 *  3. Runs build + typecheck + lint (Deno steps are skipped with a note when
 *     the deno CLI is not installed — CI runs them on the release PR)
 *  4. Commits the version bump on a release branch `release/vX.Y.Z`
 *  5. Pushes the branch and opens a PR titled `chore: release vX.Y.Z`
 *  6. Optionally (--merge): waits for required checks, squash-merges the PR,
 *     tags the commit that landed on main and pushes the tag — which triggers
 *     the publish pipelines (npm, JSR, GitHub Release)
 *
 * Re-runnability: if the current branch is already an open release PR branch,
 * `--merge` skips straight to step 6 (useful after checks went green).
 *
 * Usage:
 *   npm run release              # patch bump (1.2.0 → 1.2.1)
 *   npm run release minor        # minor bump (1.2.0 → 1.3.0)
 *   npm run release major        # major bump (1.2.0 → 2.0.0)
 *   npm run release 1.3.0        # explicit version (prereleases rejected)
 *
 * Flags:
 *   --no-pr      Stop after committing locally (no push, no PR)
 *   --merge      Wait for required checks, squash-merge, tag and push the tag.
 *                Requires the GitHub CLI (gh) and repo-review rights.
 *                Default: open the PR and stop (a human approves/merges).
 *   --draft      Open the release PR as a draft
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const run = (cmd: string) => {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const runSilent = (cmd: string): string => {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(`${cmd.split(" ")[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
};

const runSilentAllowFail = (cmd: string): string => {
  try {
    return runSilent(cmd);
  } catch {
    return "";
  }
};

const hasCommand = (cmd: string): boolean => {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function bumpVersion(current: string, type: string): string {
  const [maj, min, pat] = current.split(".").map(Number);
  if (type === "major") return `${maj + 1}.0.0`;
  if (type === "minor") return `${maj}.${min + 1}.0`;
  if (type === "patch") return `${maj}.${min}.${pat + 1}`;
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(type)) return type;
  throw new Error(`Unknown bump type: ${type}`);
}

const isPrerelease = (version: string): boolean => version.includes("-");

const hasTag = (tag: string): boolean => {
  try {
    execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

interface Cli {
  bump: string;
  noPr: boolean;
  merge: boolean;
  draft: boolean;
}

function parseArgs(argv: string[]): Cli {
  const bumpParts: string[] = [];
  const cli: Cli = { bump: "patch", noPr: false, merge: false, draft: false };
  for (const a of argv) {
    if (a === "--no-pr") cli.noPr = true;
    else if (a === "--merge") cli.merge = true;
    else if (a === "--draft") cli.draft = true;
    else bumpParts.push(a);
  }
  if (bumpParts.length > 0) cli.bump = bumpParts[0]!;
  return cli;
}

function releasePrBody(oldVersion: string, newVersion: string): string {
  return [
    `## Release v${newVersion}`,
    "",
    `Version bump \`${oldVersion}\` → \`${newVersion}\` in \`package.json\` + \`deno.json\`.`,
    "",
    existsSync("CHANGELOG.md")
      ? `Changelog: see CHANGELOG.md → the [\`${newVersion}\`] section (add it before merging if not present).`
      : "",
    "",
    "### After merge (tag the squash commit to trigger publishing)",
    "",
    "```bash",
    "git fetch origin main --tags",
    `git tag -a v${newVersion} -m "Release v${newVersion}" origin/main`,
    `git push origin v${newVersion}`,
    "```",
    "",
    "Tag push triggers: release.yml (GitHub Release), publish.yml (npm + JSR), docs.yml (TypeDoc).",
    "",
    `Or re-run \`npm run release -- --merge\` on this branch to merge + tag automatically.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function banner(version: string, lines: string[]): void {
  console.log("\n" + "═".repeat(50));
  console.log(`✅ v${version}: ${lines[0]}`);
  for (const l of lines.slice(1)) console.log(`   ${l}`);
  console.log("═".repeat(50) + "\n");
}

/** Phase 7 of the flow: watch checks → squash-merge → tag origin/main → push tag. */
function mergeAndTag(newVersion: string, branch: string): void {
  console.log("\n[merge] Waiting for required checks...");
  // --watch blocks until every check finishes (--fail-fast bails on the first
  // failure). gh exits non-zero when a check fails — captured, then the
  // explicit status query below decides success/failure.
  try {
    run(`gh pr checks ${branch} --watch --fail-fast`);
  } catch {
    // fall through to the decisive status query
  }
  let checksStatus = "";
  try {
    checksStatus = runSilent(`gh pr checks ${branch}`);
  } catch {
    checksStatus = "fail"; // non-zero exit → at least one check failed
  }
  if (checksStatus.includes("fail")) {
    console.error(`❌ Required checks failed — not merging. Inspect with: gh pr checks ${branch}`);
    process.exit(1);
  }
  console.log("  ✓ All required checks passed");

  console.log("\n[merge] Squash-merging the release PR...");
  run(`gh pr merge ${branch} --squash --delete-branch`);

  console.log("\n[tag] Tagging the commit that landed on main...");
  runSilent("git fetch origin main --tags");
  const mergeSha = runSilent("git rev-parse --short origin/main");
  if (hasTag(`v${newVersion}`)) {
    console.error(`❌ Tag v${newVersion} already exists — refusing to overwrite.`);
    process.exit(1);
  }
  run(`git tag -a "v${newVersion}" -m "Release v${newVersion}" origin/main`);
  run(`git push origin "v${newVersion}"`);

  banner(newVersion, [
    `Tag v${newVersion} pushed (on ${mergeSha}).`,
    "CI is now publishing:",
    "  • release.yml → GitHub Release (tar.gz + zip)",
    "  • publish.yml → npm + JSR",
    "  • docs.yml    → TypeDoc to GitHub Pages",
  ]);
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  console.log("\n🚀 Kinetex Release Script (PR-based)");
  console.log("═".repeat(50));

  // ── Preflight ────────────────────────────────────────────────────────────
  console.log("\n[1/6] Checking working tree and tooling...");
  const status = runSilent("git status --porcelain");
  if (status) {
    console.error("❌ Working tree is not clean. Commit or stash changes first:\n" + status);
    process.exit(1);
  }
  const startBranch = runSilent("git branch --show-current");
  console.log(`  ✓ Clean. Branch: ${startBranch}`);

  const hasGh = hasCommand("gh");
  const hasDeno = hasCommand("deno");
  if (!hasGh && !cli.noPr) {
    console.error(
      "❌ The GitHub CLI (gh) is required to open the release PR.\n" +
        "   Install it (https://cli.github.com) or run with --no-pr to stop after the local commit.",
    );
    process.exit(1);
  }
  // gh auth only matters when a PR will actually be opened or merged.
  if (hasGh && !cli.noPr) runSilent("gh auth status"); // throws with gh's own message if unauthenticated
  if (!hasDeno) {
    console.log(
      "  ℹ deno CLI not found — skipping local deno check/lint (CI runs both on the release PR).",
    );
  }

  // Re-run support: already on an open release PR branch + --merge → merge now.
  const onReleaseBranch = /^release\/v(\d+\.\d+\.\d+)$/.exec(startBranch);
  if (onReleaseBranch) {
    const version = onReleaseBranch[1]!;
    if (!cli.merge) {
      console.log(
        `\nℹ Branch ${startBranch} already has (or is meant for) the release PR.\n` +
          `  Re-run with --merge to wait for checks, merge and tag v${version}.`,
      );
      return;
    }
    const prState = runSilentAllowFail(`gh pr view ${startBranch} --json state --jq .state`);
    if (prState !== "OPEN") {
      console.error(
        `❌ No open PR found for ${startBranch} (state: ${prState || "none"}).` +
          `${prState === "MERGED" ? " If it was merged, delete this branch and re-run --merge from main — the tag step is safe to redo." : ""}`,
      );
      process.exit(1);
    }
    if (hasTag(`v${version}`)) {
      console.error(`❌ Tag v${version} already exists — nothing to do.`);
      process.exit(1);
    }
    mergeAndTag(version, startBranch);
    return;
  }

  runSilent("git fetch origin main --tags");
  const head = runSilent("git rev-parse --short HEAD");
  const originMain = runSilent("git rev-parse --short origin/main");
  if (head !== originMain) {
    console.error(
      `❌ This branch (${head}) is not level with origin/main (${originMain}).\n` +
        "   Rebase or merge main first — releases must be cut from latest main.",
    );
    process.exit(1);
  }
  console.log("  ✓ Level with origin/main");

  // ── Version bump ─────────────────────────────────────────────────────────
  console.log("\n[2/6] Bumping version...");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, cli.bump);
  if (isPrerelease(newVersion)) {
    console.error(
      `❌ Refusing to publish prerelease version ${newVersion} through this script.\n` +
        "   Prereleases need a different npm dist-tag strategy — bump manually if you really need one.",
    );
    process.exit(1);
  }
  if (hasTag(`v${newVersion}`)) {
    console.error(`❌ Tag v${newVersion} already exists.`);
    process.exit(1);
  }
  pkg.version = newVersion;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  const hasDenoJson = existsSync("deno.json");
  if (hasDenoJson) {
    const deno = JSON.parse(readFileSync("deno.json", "utf8")) as { version: string };
    deno.version = newVersion;
    writeFileSync("deno.json", JSON.stringify(deno, null, 2) + "\n");
  }
  console.log(
    `  ✓ package.json: ${oldVersion} → ${newVersion}${hasDenoJson ? " (+ deno.json)" : ""}`,
  );

  // ── Verify ───────────────────────────────────────────────────────────────
  try {
    console.log("\n[3/6] Running build, typecheck, and lint...");
    run("npm run build");
    if (hasDeno) {
      run("deno check src/");
      run("deno lint");
    }
    run("npm run typecheck");
    console.log("  ✓ All checks passed");
  } catch (err) {
    console.error(
      "\n❌ Checks failed. Version files were already bumped — restore them with:\n" +
        "   git checkout -- package.json deno.json",
    );
    throw err;
  }
  run("npx prettier --write package.json deno.json --log-level=warn");

  // ── Commit on a release branch ───────────────────────────────────────────
  console.log("\n[4/6] Committing version bump on a release branch...");
  const branch = `release/v${newVersion}`;
  runSilent(`git checkout -B ${branch}`);
  run(hasDenoJson ? "git add package.json deno.json" : "git add package.json");
  run(`git commit -m "chore: release v${newVersion}"`);
  console.log(`  ✓ Committed on ${branch}: chore: release v${newVersion}`);

  if (cli.noPr) {
    banner(newVersion, [
      "Committed locally (--no-pr). To continue manually:",
      `  git push -u origin ${branch}`,
      `  gh pr create --base main --head ${branch} --title "chore: release v${newVersion}" --fill`,
      "Or re-run this script without --no-pr from main to do it automatically.",
    ]);
    return;
  }

  // ── Push + open the release PR ───────────────────────────────────────────
  console.log("\n[5/6] Pushing branch and opening the release PR...");
  run(`git push -u origin ${branch}`);
  const draftFlag = cli.draft ? "--draft " : "";
  run(
    `gh pr create --base main --head ${branch} ${draftFlag}` +
      `--title "chore: release v${newVersion}" ` +
      `--body ${JSON.stringify(releasePrBody(oldVersion, newVersion))}`,
  );
  const prUrl = runSilent(`gh pr view ${branch} --json url --jq .url`);
  console.log(`  ✓ ${prUrl}`);

  if (!cli.merge) {
    banner(newVersion, [
      `PR opened: ${prUrl}`,
      "Next (a human approves + merges), then tag the squash commit:",
      "  git fetch origin main --tags",
      `  git tag -a v${newVersion} -m "Release v${newVersion}" origin/main`,
      `  git push origin v${newVersion}   ← triggers npm/JSR/GitHub Release`,
      `Or, while on branch ${branch}: npm run release -- --merge`,
    ]);
    return;
  }

  // ── Watch checks → merge → tag → push tag ────────────────────────────────
  mergeAndTag(newVersion, branch);
}

main().catch((err) => {
  console.error("\n💥", err instanceof Error ? err.message : err);
  process.exit(1);
});
