import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Knot CLI rename", () => {
  it("publishes knot as primary and aag as an alias to the same implementation", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    expect(manifest.name).toBe("@imai/knot");
    expect(manifest.bin).toEqual({ knot: "dist/cli.js", aag: "dist/cli.js" });

    const binDirectory = await mkdtemp(join(tmpdir(), "knot-cli-parity-"));
    const cli = resolve("dist/cli.js");
    await Promise.all([
      symlink(cli, join(binDirectory, "knot")),
      symlink(cli, join(binDirectory, "aag")),
    ]);
    const [knot, aag] = await Promise.all([
      execFileAsync(join(binDirectory, "knot"), ["--version"], { cwd: dirname(cli) }),
      execFileAsync(join(binDirectory, "aag"), ["--version"], { cwd: dirname(cli) }),
    ]);
    expect(aag.stdout).toBe(knot.stdout);
    expect(aag.stderr).toBe("");

    const configured = await execFileAsync(join(binDirectory, "knot"), ["validate"], {
      cwd: dirname(cli),
      env: {
        ...process.env,
        KNOT_CONFIG: resolve("test/fixtures/v0.1.3/agent.yaml"),
      },
    });
    expect(configured.stdout).toContain("valid: Fixture Agent");
    expect(configured.stderr).toBe("");
  });
});
