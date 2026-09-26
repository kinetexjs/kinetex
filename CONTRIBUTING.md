# Contributing to kinetex

Thank you for contributing! This guide covers everything you need.

## Development Setup

```bash
git clone https://github.com/kinetexjs/kinetex.git
cd kinetex
npm install          # install dev dependencies
```

## Making Changes

All source code lives in `src/`. The codebase is a single-layer flat structure — no subdirectories.

```
src/
├── mod.ts        Main entry point and exports
├── client.ts     Kinetex class, FluentRequest, request pipeline
├── core.ts       Transport layer (HTTP/1.1, HTTP/2, fetch)
├── types.ts      All TypeScript types and error classes
├── cache.ts      HTTP cache (LRU, SWR, adapters)
├── interceptors.ts  Interceptor pipeline
├── lifecycle.ts  Hook registry and built-in hooks
├── ...
```

## Before Submitting

Every PR must pass all three checks:

```bash
# 1. Deno typecheck  — must be 0 errors
deno task check

# 2. TypeScript typecheck — must be 0 errors
npm run typecheck

# 3. Deno lint — must be 0 errors
deno lint
```

Optionally, run real-world API tests (requires internet):

```bash
npm run node:battle
```

And check coverage:

```bash
npm run test:coverage
```

## Code Style

- TypeScript strict mode — no `any`, no non-null assertions without justification
- No `eslint-disable` or `deno-lint-ignore` suppressions — fix the underlying issue
- Internal imports use `.ts` extensions (required for Deno/JSR)
- `node:` prefix for all Node.js built-ins (e.g. `import { Buffer } from "node:buffer"`)

## Adding a New Feature

1. Add implementation in the appropriate `src/*.ts` file
2. Export from `src/mod.ts`
3. Add unit tests in `tests/`
4. Add to the relevant section in `README.md`
5. Run all checks

## Release Process

`main` is protected — releases go through a pull request. The release script automates the whole flow:

```bash
npm run release              # patch bump (1.2.0 → 1.2.1)
npm run release minor        # minor bump (1.2.0 → 1.3.0)
npm run release major        # major bump (1.2.0 → 2.0.0)
npm run release 1.3.0        # explicit version
```

The script will:

1. Verify the working tree is clean and level with latest `main`
2. Bump the version in `package.json` and `deno.json`
3. Run build + typecheck + lint (Deno steps run locally when `deno` is installed; CI runs them regardless)
4. Commit on a `release/vX.Y.Z` branch and open a PR titled `chore: release vX.Y.Z`

Then a maintainer approves and merges the PR. Publishing is triggered by tagging the squash commit that landed on `main`:

```bash
git fetch origin main --tags
git tag -a v1.3.0 -m "Release v1.3.0" origin/main
git push origin v1.3.0
```

The tag push triggers the automated pipelines: `release.yml` (GitHub Release), `publish.yml` (npm + JSR), and `docs.yml` (TypeDoc).

Useful flags:

- `--merge` — after opening the PR (or re-run on an existing `release/vX.Y.Z` branch), wait for required checks, squash-merge, tag and push the tag automatically
- `--no-pr` — stop after the local commit
- `--draft` — open the release PR as a draft

CI will automatically publish to npm and JSR when it sees a commit starting with `release:`.
