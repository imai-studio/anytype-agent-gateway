import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCompatibleProcessLocks,
  acquireProcessLock,
  compatibleProcessLockPaths,
} from "../src/process-lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("process lock", () => {
  it("allows only one concurrent O_EXCL owner", async () => {
    const path = await lockPath();
    const attempts = await Promise.allSettled([
      acquireProcessLock(path, { pid: process.pid }),
      acquireProcessLock(path, { pid: process.pid }),
    ]);
    const acquired = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    await (acquired[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it("reclaims a stale owner and releases only its own token", async () => {
    const path = await lockPath();
    await writeFile(path, "987654 stale\n", { mode: 0o600 });
    const release = await acquireProcessLock(path, {
      pid: 1234,
      probe: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    expect(await readFile(path, "utf8")).toMatch(/^1234 /u);
    await writeFile(path, "4321 replacement\n");
    await release();
    expect(await readFile(path, "utf8")).toBe("4321 replacement\n");
  });

  it("treats EPERM from signal zero as a live owner", async () => {
    const path = await lockPath();
    await writeFile(path, "987654 protected\n", { mode: 0o600 });
    await expect(
      acquireProcessLock(path, {
        probe: () => {
          throw Object.assign(new Error("not permitted"), { code: "EPERM" });
        },
      }),
    ).rejects.toThrow("Another Knot process is already running (pid 987654)");
    expect(await readFile(path, "utf8")).toBe("987654 protected\n");
  });

  it("reclaims a stale owner when migration allows the retry", async () => {
    const path = await lockPath();
    await writeFile(path, "987654 stale\n", { mode: 0o600 });
    const release = await acquireProcessLock(path, {
      attempts: 2,
      probe: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    await release();
  });

  it("makes legacy and current state paths contend on one identity lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "knot-cross-generation-lock-"));
    directories.push(home);
    const legacy = join(home, ".local", "state", "aag", "state.sqlite");
    const current = join(home, ".local", "state", "knot", "state.sqlite");
    expect(compatibleProcessLockPaths(legacy)[0]).toBe(compatibleProcessLockPaths(current)[0]);
    const release = await acquireCompatibleProcessLocks(legacy, { pid: process.pid });
    await expect(
      acquireCompatibleProcessLocks(current, { pid: process.pid, attempts: 1 }),
    ).rejects.toThrow("Another Knot process is already running");
    await release();
  });
});

async function lockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aag-process-lock-"));
  directories.push(directory);
  return join(directory, "agent.lock");
}
