/**
 * Patch-coverage tests for src/core.ts and src/utils.ts changed regions:
 * the `createConnection` structural cast in NodeHTTP2Transport (lines 1440-1476)
 * and the NodeProcess type-fallback formatting in utils.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const coreSrc = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8");
const utilsSrc = readFileSync(new URL("../src/utils.ts", import.meta.url), "utf8");

test("patch-coverage: core.ts assigns createConnection through a structural type", () => {
  assert.ok(
    coreSrc.includes("type ProxiedCreateConnection ="),
    "the createConnection seam must be declared through a structural type",
  );
  assert.ok(
    coreSrc.includes("(agent as unknown as { createConnection: ProxiedCreateConnection })"),
    "the agent cast must go through the ProxiedCreateConnection structural type",
  );
  // The fix ends with a plain assignment; the old `as unknown as typeof ...`
  // double-cast is gone.
  assert.ok(!coreSrc.includes("as unknown as typeof import"), "the legacy double-cast is gone");
});

test("patch-coverage: utils.ts NodeProcess falls back to an hrtime-shaped type", () => {
  assert.ok(
    utilsSrc.includes(": { hrtime: () => [number, number] };"),
    "the NodeProcess conditional must fall back to an hrtime-shaped object",
  );
});
