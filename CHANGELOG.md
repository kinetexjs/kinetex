# Changelog

All notable changes to kinetex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.2]

- Added .d.cts type declarations and fix browser bundle node: imports
- Generate .d.cts files in dist/cjs/types/ for proper CJS TypeScript support (KX-01-04)
- Post-process browser bundles to replace node:* imports with browser-shim code
- Update package.json exports to reference .d.cts files for CJS type imports
- Browser bundles now work correctly in browsers without node: protocol errors

### Fixed

- TypeScript CJS consumers got wrong type inference
- Browser bundles failed with 'Cannot find module node:http' errors

Verified working on Node.js 22, Deno 2.0, Bun 1.4.4
