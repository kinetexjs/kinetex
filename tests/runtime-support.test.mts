/**
 * runtime-support.test.mts — keeps the Node.js support claim honest.
 *
 * A published library's supported-runtime list is a promise, and this repo made
 * one it did not keep: the README advertised Node 18/20/22 while CI ran a
 * single cell (Node 22). Neither direction was checked, so the claim drifted
 * silently in both directions at once — untested on the versions it named, and
 * testing only the version that happened to be current locally.
 *
 * The fix is not a single edit, it is this test. The three places that state
 * the claim have to agree:
 *
 *   1. `engines.node` in package.json — what npm enforces at install time.
 *   2. the README runtime table — what a user reads before choosing a runtime.
 *   3. the CI matrix — what actually gets tested.
 *
 * It also refuses EOL runtimes outright. Node 18 lost upstream security patches
 * in April 2025 and Node 20 in April 2026; a runtime that cannot be patched is
 * not something a library can honestly stand behind, so naming one here fails
 * the suite rather than shipping an unfalsifiable support promise. The floor is
 * asserted explicitly instead of read from a table, so bumping it is a
 * deliberate act with a date attached rather than a silent edit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), "utf8");

/**
 * Lowest supported Node.js major. Bump deliberately: verify against
 * https://endoflife.date/nodejs that the version is still receiving upstream
 * security patches before raising this, and update the README table and the CI
 * matrix in the same commit.
 */
const SUPPORTED_FLOOR = 22;

/** Runtime lines known to have stopped receiving upstream security patches. */
const EOL_NODE_MAJORS = new Set([14, 16, 18, 20]);

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ✅  ${name}`),
      (e: unknown) => {
        console.error(`  ❌  ${name}: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      },
    );
}

await test("the ./worker entry point exports what it claims and is importable", async () => {
  // `worker.ts` is a published entry point (`"./worker"` in package.json exports)
  // and no test imported it at all, so it shipped with zero coverage. A broken
  // re-export there would only surface for a user, in an edge runtime, at
  // runtime — the worst place to find out.
  const worker = await import("../src/worker.ts");
  assert.equal(typeof worker.kinetex, "function", "kinetex() factory");
  assert.equal(typeof worker.default, "function", "default export");
  assert.equal(typeof worker.Kinetex, "function", "Kinetex class");
  assert.equal(typeof worker.FluentRequest, "function", "FluentRequest");
  assert.equal(typeof worker.BatchQueue, "function", "BatchQueue");

  // The entry point's whole purpose is a transport that is safe everywhere, so
  // it must default to HTTP/1.1 rather than reaching for node:http2.
  const client = worker.kinetex({ baseURL: "https://example.invalid" });
  assert.equal((client as unknown as { cfg: { httpVersion: string } }).cfg.httpVersion, "HTTP/1.1");
  await client.destroy();

  // ...and an explicit request for HTTP/2 must not silently claim otherwise.
  const h2 = worker.kinetex({ baseURL: "https://example.invalid", httpVersion: "HTTP/2" });
  assert.equal((h2 as unknown as { cfg: { httpVersion: string } }).cfg.httpVersion, "HTTP/2");
  await h2.destroy();
});

await test("package.json declares a Node engines floor", () => {
  const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
  const range = pkg.engines?.node;
  assert.ok(
    range,
    "package.json has no engines.node — npm will install on any runtime, including EOL ones",
  );
  const floor = Number(range.replace(/^[^\d]*/, ""));
  assert.ok(Number.isInteger(floor), `engines.node "${range}" does not start with a major version`);
  assert.equal(
    floor,
    SUPPORTED_FLOOR,
    `engines.node floor is ${floor} but this suite asserts ${SUPPORTED_FLOOR}`,
  );
});

await test("no supported Node.js line is end-of-life", () => {
  const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
  const floor = Number((pkg.engines?.node ?? "").replace(/^[^\d]*/, ""));
  assert.ok(floor > 0, "could not determine the supported floor");
  const dead = [...EOL_NODE_MAJORS].filter((m) => m >= floor);
  assert.deepEqual(
    dead,
    [],
    `engines claims Node ${floor}+, which includes EOL line(s) ${dead.join(", ")}. ` +
      `A runtime that receives no upstream security patches cannot be supported honestly.`,
  );
});

await test("README runtime table does not advertise an EOL Node.js line", () => {
  const readme = read("README.md");
  const claimed = new Set<number>();
  // "Node 18+", "Node 22+", "Node.js 18+" — any Node major named as a floor.
  for (const m of readme.matchAll(/Node(?:\.js)?\s+(\d+)\+/g)) claimed.add(Number(m[1]));
  assert.ok(
    claimed.size > 0,
    "README no longer names any supported Node.js floor — is the table intact?",
  );
  const dead = [...claimed].filter((m) => EOL_NODE_MAJORS.has(m));
  assert.deepEqual(
    dead,
    [],
    `README advertises Node ${dead.join(", ")}, which is EOL and unpatched. Drop the claim or raise the floor.`,
  );
});

await test("README floor matches package.json engines", () => {
  const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
  const declared = Number((pkg.engines?.node ?? "").replace(/^[^\d]*/, ""));
  const readme = read("README.md");
  const readmeFloor = Number(readme.match(/Node(?:\.js)?\s+(\d+)\+/)?.[1] ?? NaN);
  assert.equal(
    readmeFloor,
    declared,
    `README says Node ${readmeFloor}+ but package.json engines says ${declared}. ` +
      `These are the same promise written twice; they must agree.`,
  );
});

await test("CI matrix covers every supported Node.js major", () => {
  const ci = read(".github/workflows/ci.yml");
  const matrix = ci.match(/node:\s*\[([^\]]*)\]/);
  assert.ok(matrix, "ci.yml has no `node: [...]` matrix for the unit-node job");
  const tested = [...matrix[1].matchAll(/"?(\d+)"?/g)].map((m) => Number(m[1]));
  assert.ok(tested.length > 0, "CI node matrix is empty — the suite would never run");

  const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
  const floor = Number((pkg.engines?.node ?? "").replace(/^[^\d]*/, ""));

  // Every supported *LTS* major from the floor up to the highest tested must be
  // tested. Odd majors are excluded on purpose: Node only promotes even
  // majors to LTS, and an odd "Current" line is unsupported within ~6 months,
  // so testing one would be theatre. `engines: ">=22"` cannot express that
  // distinction without a maintenance-hostile disjunction
  // (`>=22 <23 || >=24 <25 || >=26`), and npm's `>=` range is the convention
  // every library uses — so the runtime guidance lives here instead, where it is
  // enforced, rather than in a range string nobody reads.
  const highest = Math.max(...tested);
  const missing: number[] = [];
  for (let v = floor; v <= highest; v++) {
    if (v % 2 === 0 && !tested.includes(v)) missing.push(v);
  }
  assert.deepEqual(
    missing,
    [],
    `CI tests Node ${tested.join(", ")} but supports ${floor}+ — LTS Node ${missing.join(", ")} is ` +
      `claimed as supported and never exercised.`,
  );

  for (const v of tested) {
    assert.ok(!EOL_NODE_MAJORS.has(v), `CI tests Node ${v}, which is EOL and unpatched`);
  }
});

await test("coverage reporting stays on a single Node.js line", () => {
  const ci = read(".github/workflows/ci.yml");
  // Coverage and Codecov must run once, not once per matrix cell: three uploads
  // of the same lcov to one project makes the trend line unreadable.
  const gated = [...ci.matchAll(/if: matrix\.node == '(\d+)'/g)].map((m) => m[1]);
  assert.ok(
    gated.length > 0,
    "coverage upload is no longer pinned to one Node version — it will run per matrix cell",
  );
  assert.deepEqual(
    new Set(gated),
    new Set([SUPPORTED_FLOOR.toString()]),
    `coverage upload is pinned to Node ${[...new Set(gated)].join(", ")}, not the floor ${SUPPORTED_FLOOR}`,
  );
});
