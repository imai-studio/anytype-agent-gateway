import { readFileSync } from "node:fs";

type PackageManifest = { version?: unknown };

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;
if (typeof manifest.version !== "string" || !manifest.version)
  throw new Error("package.json has no valid version");

export const VERSION = manifest.version;
