/**
 * Capability gates for suites that need something the host may not have.
 *
 * Some suites cannot run without a tool (`openssl`) or a runtime feature
 * (`zlib.zstdCompressSync`). The tempting shape is to skip them when it is
 * missing — but a skip is invisible in the exit status, so a runner that lost
 * the capability reports the same green as a runner that passed, and the
 * coverage disappears without anyone noticing.
 *
 * So the behaviour differs by environment, deliberately:
 *
 *   - In CI (`CI` or `GITHUB_ACTIONS` set), a missing capability throws. The
 *     job goes red and says which capability vanished. A green build that ran
 *     fewer tests than it claims is the failure mode worth paying for.
 *   - Everywhere else it warns loudly and returns false, so the suite can skip
 *     itself. A developer on a machine without openssl should not be blocked,
 *     but should still be told their run covered less than it appears to.
 *
 * The two call sites differ in shape — one is a `node:test` `skip` option, the
 * others wrap a block of tests — so this returns the decision and lets the
 * caller act on it.
 */

/** True when running under a CI provider, where a silent skip is a defect. */
export function isCI(): boolean {
  return Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS);
}

/**
 * Decide what to do about a missing capability.
 *
 * @param name     What is required, e.g. "openssl".
 * @param available Whether it is actually usable here.
 * @param hint     What it is needed for, included in the message.
 * @returns `true` when the suite may run; `false` when it should skip.
 * @throws In CI, when `available` is false.
 */
export function requireCapability(name: string, available: boolean, hint: string): boolean {
  if (available) return true;
  const detail = `${name} is required here (${hint}).`;
  if (isCI()) {
    throw new Error(
      `${detail} In CI this is fatal: a skipped suite still reports success, so losing ` +
        `this capability would quietly remove its coverage from every green build. ` +
        `Install ${name} on the runner, or move the suite to a runner that has it.`,
    );
  }
  console.log(`  ⏭  ${detail} Suite not run — this run covers less than it appears to.`);
  return false;
}
