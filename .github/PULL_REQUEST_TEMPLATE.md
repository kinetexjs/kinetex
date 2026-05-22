## Summary

<!-- One-paragraph explanation of the purpose of this PR. What problem does it solve? -->

## Type of Change

<!-- Mark the relevant option(s) with an "x". Delete options that don't apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing API behavior)
- [ ] Performance improvement
- [ ] Refactoring (no functional changes)
- [ ] Documentation update
- [ ] Test improvement
- [ ] Build / CI / Tooling

## Related Issues

<!-- Link to related issues using "Closes #123", "Fixes #456", or "Relates to #789". -->

Closes #

## Checklist

### Code Quality
- [ ] `npm run typecheck` passes with 0 errors
- [ ] `deno task check` passes with 0 errors
- [ ] `deno lint` passes with 0 errors
- [ ] `npm run test:all` passes (or at minimum `npm test` passes)
- [ ] New code follows the existing code style (no `any`, no non-null assertions without justification)
- [ ] No `console.log`, `debugger`, or commented-out code left behind
- [ ] No new external dependencies added

### Tests
- [ ] Existing tests still pass
- [ ] New tests added for all new/changed functionality
- [ ] Tests use real HTTP calls (no mocks)
- [ ] Cross-runtime compatibility tested if applicable (Node, Deno, Bun)

### Documentation
- [ ] README updated if public API changed (exports, config, new features)
- [ ] JSDoc / TSDoc added for new public APIs
- [ ] Changes reflected in relevant type definitions

### Breaking Changes (if applicable)
- [ ] Breaking change documented in PR description
- [ ] Migration path / instructions provided
- [ ] Deprecation warnings added for old API with timeline for removal
- [ ] Version bump noted (major/minor/patch)

### Security
- [ ] No credentials, tokens, or secrets exposed
- [ ] No new prototype pollution vectors introduced
- [ ] No SSRF or open redirect vectors introduced

## Testing Performed

<!-- Describe how you tested your changes and which runtimes you verified against. -->

- [ ] Node.js (version: ___)
- [ ] Deno (version: ___)
- [ ] Bun (version: ___)
- [ ] Browser (which: ___)

## Migration Guide (for breaking changes)

<!-- If this is a breaking change, provide clear before/after examples. -->

**Before:**
```typescript
// old usage
```

**After:**
```typescript
// new usage
```

## Additional Context

<!-- Any other information that would help reviewers understand your change. -->
