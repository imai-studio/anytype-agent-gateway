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
});
