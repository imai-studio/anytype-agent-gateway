import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const channel = JSON.parse(
  readFileSync(resolve(root, "packages/openclaw-anytype-channel/package.json"), "utf8"),
);

assert(manifest.name === "@imai/knot", "package name must be @imai/knot");
assert(manifest.version === "0.2.0", "Knot release version must be 0.2.0");
assert(channel.version === manifest.version, "bundled OpenClaw channel must match Knot version");
assert(manifest.license === "Apache-2.0", "package license must be Apache-2.0");
assert(manifest.packageManager === "pnpm@11.22.0", "package manager must stay pinned");
assert(manifest.engines?.node === ">=24.0.0", "Node engine must require version 24+");
assert(
  manifest.repository?.url === "git+https://github.com/imai-studio/knot.git",
  "repository URL must be rename-ready",
);
assert(manifest.homepage === "https://github.com/imai-studio/knot#readme", "homepage is stale");
assert(manifest.bugs?.url === "https://github.com/imai-studio/knot/issues", "bugs URL is stale");
assert(
  JSON.stringify(manifest.bin) === JSON.stringify({ knot: "dist/cli.js", aag: "dist/cli.js" }),
  "knot/aag bins must point to one implementation",
);
assert(manifest.publishConfig?.access === "public", "scoped package must publish publicly");
assert(manifest.publishConfig?.provenance === true, "npm provenance must remain enabled");
for (const required of [
  "dist",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "docs",
  "packages/openclaw-anytype-channel/dist",
])
  assert(manifest.files.includes(required), `package files missing ${required}`);

const publish = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8");
for (const fragment of [
  "release:",
  "types: [published]",
  "id-token: write",
  "Require renamed repository",
  "sha256sum --check SHA256SUMS",
  'npm publish "$artifact" --access public --provenance',
])
  assert(publish.includes(fragment), `publish workflow missing ${fragment}`);
assert(!/NODE_AUTH_TOKEN|NPM_TOKEN|npm_[A-Za-z0-9]{20,}/u.test(publish), "publish uses a token");
for (const workflow of readdirSync(resolve(root, ".github/workflows")).filter((name) =>
  /\.ya?ml$/u.test(name),
)) {
  const contents = readFileSync(resolve(root, ".github/workflows", workflow), "utf8");
  assert(Boolean(parseYaml(contents)), `${workflow} is not valid YAML`);
  for (const match of contents.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)) {
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    assert(/@[0-9a-f]{40}$/u.test(reference), `${workflow} contains unpinned action ${reference}`);
  }
}

const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");
for (const fragment of [
  "immutable native participant/member ID",
  "Display names",
  "mentions",
  "replies",
  "forwarded content",
  "fails closed",
])
  assert(security.includes(fragment), `security policy is missing sender rule: ${fragment}`);
const principalTests = readFileSync(resolve(root, "test/principal.test.ts"), "utf8");
for (const fragment of ["spoofed operator display name", "forwarded", "mentioned", "replyToAgent"])
  assert(principalTests.includes(fragment), `principal release gate is missing ${fragment}`);
for (const [path, fragments] of Object.entries({
  "test/compatibility.test.ts": [
    "accepts old-only",
    "rejects conflicting dual values",
    "discovers either Heart binary",
  ],
  "test/legacy-upgrade-fixture.test.ts": [
    "preserves sessions, authorization, dedupe, and replay barriers",
    "schemaVersion()",
    "isHandled(",
  ],
  "test/process-lock.test.ts": ["legacy and current state paths contend"],
  "test/service.test.ts": [
    "fails closed when both definitions are present",
    "leaves exactly one enabled and running generation",
    "rolls back the legacy service",
  ],
  "test/migration.test.ts": ["preserves replay-sensitive v0.1.3 state"],
})) {
  const contents = readFileSync(resolve(root, path), "utf8");
  for (const fragment of fragments)
    assert(contents.includes(fragment), `${path} is missing release gate: ${fragment}`);
}

const expectedAagOccurrences = JSON.parse(
  readFileSync(resolve(root, "scripts/aag-occurrences.json"), "utf8"),
);
const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const actualAagOccurrences = {};
for (const path of tracked) {
  if (
    path.startsWith("dist/") ||
    path.startsWith("packages/openclaw-anytype-channel/dist/") ||
    path === "pnpm-lock.yaml" ||
    path === "scripts/aag-occurrences.json" ||
    path === "scripts/release-audit.mjs"
  )
    continue;
  const bytes = readFileSync(resolve(root, path));
  if (bytes.includes(0)) continue;
  const contents = bytes.toString("utf8");
  const count = [...contents.matchAll(/AAG|anytype-agent-gateway|@imai\/aag/giu)].length;
  if (count > 0) actualAagOccurrences[path] = count;
}
assert(
  JSON.stringify(actualAagOccurrences, Object.keys(actualAagOccurrences).sort()) ===
    JSON.stringify(expectedAagOccurrences, Object.keys(expectedAagOccurrences).sort()),
  `legacy name occurrence inventory changed:\nexpected ${JSON.stringify(expectedAagOccurrences)}\nactual ${JSON.stringify(actualAagOccurrences)}`,
);

process.stdout.write(
  "release audit: metadata, publishing, version, and AAG compatibility surfaces verified\n",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
