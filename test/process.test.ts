import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessTimeoutError, runProcess } from "../src/process.js";

describe("runProcess", () => {
  it("returns output for a successful command", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "console.log('ok')"], { timeoutMs: 2_000 }),
    ).resolves.toEqual({ stdout: "ok\n", stderr: "" });
  });

  it("rejects spawn failures", async () => {
    await expect(
      runProcess("/nonexistent/knot-test-command", [], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a timeout even when the child handles SIGTERM by exiting successfully", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 10)"],
        { timeoutMs: 300 },
      ),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });

  it("escalates when the child ignores SIGTERM", async () => {
    const started = Date.now();
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 10)"],
        { timeoutMs: 300 },
      ),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(process.platform === "win32")(
    "kills a SIGTERM-ignoring grandchild in the owned process group",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "knot-process-tree-"));
      const pidFile = join(directory, "grandchild.pid");
      const grandchild = `
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 10);
    `;
      const parent = `
      process.on('SIGTERM', () => {});
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: 'inherit' });
      setInterval(() => {}, 10);
    `;
      let descendantPid: number | undefined;
      const terminated = (pid: number): boolean => {
        try {
          const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
            encoding: "utf8",
          }).trim();
          // Some CI init processes reap orphan zombies asynchronously. A zombie
          // has terminated and cannot retain pipes or execute further effects.
          return !state || state.startsWith("Z");
        } catch {
          return true;
        }
      };
      try {
        await expect(
          runProcess(process.execPath, ["-e", parent, pidFile], { timeoutMs: 1_000 }),
        ).rejects.toBeInstanceOf(ProcessTimeoutError);
        descendantPid = Number(await readFile(pidFile, "utf8"));
        expect(descendantPid).toBeGreaterThan(1);
        await expect.poll(() => terminated(descendantPid!), { timeout: 2_000 }).toBe(true);
      } finally {
        // Bound cleanup to the exact synthetic descendant if an assertion fails.
        if (descendantPid && !terminated(descendantPid)) process.kill(descendantPid, "SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
