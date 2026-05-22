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
npm run test:real
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

Releases are automated via CI. To trigger a release:

```bash
# Bump version in package.json and deno.json, then:
git commit -m "release: v1.2.0"
git push origin main
```

CI will automatically publish to npm and JSR when it sees a commit starting with `release:`.
