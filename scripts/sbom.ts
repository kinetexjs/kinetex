/**
 * Emit a CycloneDX 1.5 SBOM for this package, from `package-lock.json`.
 *
 * The release workflow previously generated this with
 * `advanced-security/sbom-generator-action`, behind `continue-on-error: true`,
 * because that action needs GitHub Advanced Security and is therefore
 * unavailable on a public repository — so the SBOM step silently produced
 * nothing. `npm sbom` would be the obvious replacement but only exists from
 * npm 10, and this project builds on npm 9.
 *
 * Written out by hand instead, so it runs on any npm and cannot fail for a
 * reason outside this repository. The document is derived entirely from the
 * lockfile.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, { version?: string; license?: string; dev?: boolean }>;
};

interface Component {
  type: "library";
  name: string;
  version: string;
  scope: "required" | "optional";
  licenses?: Array<{ license: { id: string } }>;
  purl: string;
}

const components: Component[] = [];

for (const [path, meta] of Object.entries(lock.packages)) {
  // Skip the root project (""), which is the subject of the document rather
  // than a dependency of it.
  if (path === "" || !meta.version) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  components.push({
    type: "library",
    name,
    version: meta.version,
    // A devDependency is not installed for a consumer, so it is reported as
    // optional. This package has no runtime dependencies, which is the single
    // most useful fact in the document.
    scope: meta.dev === true ? "optional" : "required",
    ...(meta.license ? { licenses: [{ license: { id: meta.license } }] } : {}),
    purl: `pkg:npm/${name}@${meta.version}`,
  });
}

components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "library",
      name: pkg.name,
      version: pkg.version,
      licenses: [{ license: { id: pkg.license } }],
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
    properties: [
      {
        name: "kinetex:runtimeDependencies",
        value: String(Object.keys(pkg.dependencies ?? {}).length),
      },
      { name: "kinetex:lockfileVersion", value: String(lock.lockfileVersion) },
    ],
  },
  components,
};

const out = join(ROOT, "sbom.cdx.json");
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);

const required = components.filter((c) => c.scope === "required");
console.log(
  `SBOM written to ${out}: ${components.length} components, ` +
    `${required.length} of them runtime (shipped to consumers).`,
);
