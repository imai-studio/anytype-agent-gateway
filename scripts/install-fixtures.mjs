import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const releaseManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseVersion = releaseManifest.version;
const temporary = await mkdtemp(join(tmpdir(), "knot-release-install-"));
try {
  const packDirectory = join(temporary, "pack");
  await mkdir(packDirectory);
  const { stdout } = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const packed = JSON.parse(stdout)[0];
  if (!packed?.filename) throw new Error("npm pack did not return an archive");
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "dist/cli.js",
    "dist/mcp.js",
    "dist/migration.js",
    "docs/agent-setup.md",
    "docs/compatibility.md",
    "docs/upgrade-from-aag.md",
    "packages/openclaw-anytype-channel/dist/index.js",
    "packages/openclaw-anytype-channel/openclaw.plugin.json",
    "packages/openclaw-anytype-channel/package.json",
  ])
    if (!files.has(required)) throw new Error(`tarball is missing ${required}`);
  for (const forbidden of ["src/", "test/", ".github/", ".env", "state.sqlite"])
    if ([...files].some((file) => file.startsWith(forbidden)))
      throw new Error(`tarball unexpectedly contains ${forbidden}`);

  const archive = join(packDirectory, packed.filename);
  await verifyInstall("tarball", archive);
  await verifyLegacyGlobalUpgrade(archive);

  const includeGit = !process.argv.includes("--skip-git");
  if (includeGit) {
    const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await verifyInstall("direct-git", `git+file://${root}#${commit}`);
  }
  process.stdout.write(
    `install fixtures: tarball${includeGit ? " and direct-Git" : ""} CLI aliases verified\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function verifyInstall(name, spec) {
  const project = join(temporary, name);
  await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"fixture","private":true}\n');
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", spec],
    { cwd: project, maxBuffer: 20 * 1024 * 1024 },
  );
  const installed = JSON.parse(
    await readFile(join(project, "node_modules", "@imai", "knot", "package.json"), "utf8"),
  );
  if (installed.name !== "@imai/knot" || installed.version !== releaseVersion)
    throw new Error(`${name} installed unexpected package metadata`);
  const knot = await run(join(project, "node_modules", ".bin", "knot"), ["--version"]);
  const aag = await run(join(project, "node_modules", ".bin", "aag"), ["--version"]);
  if (knot.stdout.trim() !== releaseVersion || aag.stdout !== knot.stdout)
    throw new Error(`${name} CLI aliases are not release-compatible`);
}

async function verifyLegacyGlobalUpgrade(archive) {
  const fixtureRoot = join(temporary, "global-upgrade");
  const legacy = join(fixtureRoot, "legacy");
  const pnpmHome = join(fixtureRoot, "pnpm-home");
  const pnpmBin = join(pnpmHome, "bin");
  await mkdir(legacy, { recursive: true });
  await mkdir(pnpmBin, { recursive: true });
  await writeFile(
    join(legacy, "package.json"),
    '{"name":"@imai/aag","version":"0.1.3","bin":{"aag":"cli.js"}}\n',
  );
  await writeFile(join(legacy, "cli.js"), '#!/usr/bin/env node\nconsole.log("0.1.3")\n', {
    mode: 0o755,
  });
  const env = {
    ...process.env,
    PNPM_HOME: pnpmHome,
    PATH: `${pnpmBin}:${pnpmHome}:${process.env.PATH ?? ""}`,
  };
  await run("pnpm", ["add", "--global", legacy], { env });
  await run("pnpm", ["remove", "--global", "@imai/aag"], { env });
  await run("pnpm", ["add", "--global", archive], { env });
  const aag = await run(join(pnpmBin, "aag"), ["--version"], { env });
  if (aag.stdout.trim() !== releaseVersion)
    throw new Error("legacy global-package upgrade did not replace the aag alias");
}
