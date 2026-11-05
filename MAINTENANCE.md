# Maintenance Guide

## Release Cadence

- **Patch releases** (0.0.x): As needed for bug fixes. Usually within 48 hours of a confirmed bug.
- **Minor releases** (0.x.0): Every 2-4 weeks for new features and non-breaking improvements.
- **Major releases** (x.0.0): When breaking changes are introduced. Always includes migration guide.
- **Pre-releases** (`-alpha`, `-beta`, `-rc`): Published for community testing before major releases.

## LTS Policy

kinetex is currently in **active development** (v0.x). LTS policy will be defined at v1.0.0.

## Supported Runtimes

The project maintains compatibility with:

- Node.js: current (22), active LTS (20), and maintenance LTS (18)
- Deno: latest stable
- Bun: latest stable
- Browsers: last 2 major versions of Chrome, Firefox, Safari, Edge
- Edge runtimes: Cloudflare Workers, Vercel Edge (latest)

See the runtime compatibility table in `README.md` for detailed feature support.

## Deprecation Policy

1. Mark APIs as deprecated with JSDoc `@deprecated` tag
2. Include the planned removal version in the deprecation notice
3. Keep deprecated APIs for at least one minor version cycle (two if possible)
4. Provide migration path in CHANGELOG and migration guide

## Security Patches

- Critical vulnerabilities: patch within 7 days
- High severity: patch within 14 days
- Medium/Low: addressed in next regular release

## Backport Policy

- Security fixes are backported to the last two minor versions
- Critical bug fixes may be backported on request
- Feature releases are not backported

## Branch Strategy

- `main`: Latest stable release
- `develop`: Active development branch
- `v{version}.x`: Maintenance branches for older releases (e.g., `v0.2.x`)

## Review Requirements

- All PRs require at least one approved review from a code owner
- Changes to transport layer (`core.ts`), security modules (`cookiejar.ts`, `aws-sigv4.ts`, `digest.ts`), and public API surface require two approvals
- Breaking changes require maintainer team consensus

## Infrastructure

- **CI**: GitHub Actions (`.github/workflows/`)
- **npm publishing**: Automatic via CI on tagged commits
- **JSR publishing**: Automatic via CI on tagged commits
- **Documentation**: TypeDoc generated and deployed on release
- **Coverage**: Codecov integrated; target 90%+ coverage
