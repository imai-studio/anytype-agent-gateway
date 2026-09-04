import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("audits tracked text without reading unrelated scratch files or binary contents", () => {
  const root = resolve(import.meta.dirname, "..");
  const fixture = mkdtempSync(join(tmpdir(), "knot-release-audit-"));
  try {
    // Begin with a coherent committed release inventory, independent of local edits.
    const archive = execFileSync("git", ["archive", "HEAD"], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", fixture], { input: archive });
    copyFileSync(
      join(root, "scripts/release-audit.mjs"),
      join(fixture, "scripts/release-audit.mjs"),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    execFileSync("git", ["add", "--all"], { cwd: fixture });
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    writeFileSync(join(fixture, "scratch.txt"), "AAG scratch data outside the release inventory");
    writeFileSync(join(fixture, "asset.bin"), Buffer.from([0, 65, 65, 71, 255]));
    writeFileSync(join(fixture, "name\nwith-newline.txt"), "tracked text");
    execFileSync("git", ["add", "--", "asset.bin", "name\nwith-newline.txt"], { cwd: fixture });
    expect(
      execFileSync(process.execPath, ["scripts/release-audit.mjs"], {
        cwd: fixture,
        encoding: "utf8",
      }),
    ).toContain("compatibility surfaces verified");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
