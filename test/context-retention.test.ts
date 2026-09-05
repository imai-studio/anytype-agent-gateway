import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { buildContext, preparePrompt, workspaceContextFile } from "../src/context.js";
import {
  contextRegistryDoctorLine,
  holdWorkspaceContext,
  inspectContextRegistry,
  pruneWorkspaceContext,
  recordWorkspaceSession,
  type ContextRegistryIssue,
} from "../src/context-retention.js";
import { Gateway } from "../src/gateway.js";
import { Store } from "../src/store.js";
import type { HeartDiscussionAdapter } from "../src/discussions.js";
import * as processLock from "../src/process-lock.js";
import type { ContextBundle, ConversationRef } from "../src/types.js";
import { FakeAnytype, FakeRuntime, incoming } from "./fakes.js";

const conversation: ConversationRef = {
  routeId: "chat:space:chat",
  kind: "chat",
  spaceId: "space",
  chatId: "chat",
};
const after31Days = () => Date.now() + 31 * 86_400_000;
async function fixture(maxBytes = 1024 * 1024 * 1024, promptMode = "workspace") {
  const directory = await mkdtemp(join(tmpdir(), "knot-retention-"));
  const config = configSchema.parse({
    version: 1,
    agent: { name: "Fixture", participantId: "bot" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ id: "space" }],
    runtime: { kind: "codex", defaultProject: join(directory, "workspace") },
    state: { path: join(directory, "state", "state.sqlite") },
    context: { promptMode, retention: { maxBytes } },
  });
  const anytype = new (class extends FakeAnytype {
    async downloadFile() {
      return { bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" };
    }
  })();
  async function turn(
    id: string,
    sessionKey: string,
    onContextRegistryIssue?: (reason: ContextRegistryIssue) => void,
  ): Promise<ContextBundle> {
    const bundle = await buildContext(
      anytype,
      config,
      conversation,
      incoming({
        id,
        attachments: [{ type: "file", target: `file-${id}` }],
      }),
    );
    await preparePrompt(
      bundle,
      config,
      sessionKey,
      undefined,
      onContextRegistryIssue ? { onContextRegistryIssue } : {},
    );
    return bundle;
  }
  return { config, directory, turn, anytype };
}

function attachment(bundle: ContextBundle): string {
  return bundle.attachments![0]!.localPath!;
}

async function registryFile(statePath: string): Promise<string> {
  const names = await readdir(dirname(statePath));
  return join(
    dirname(statePath),
    names.find((name) => /^context-[a-f0-9]+\.json$/u.test(name))!,
  );
}

type TestRegistry = {
  version: number;
  files: Record<string, Record<string, unknown>>;
  sessions: Record<string, Record<string, unknown>>;
};

describe("managed workspace context retention", () => {
  it("prints corrupt registry validity in doctor without rewriting evidence", async () => {
    const { config, directory, turn } = await fixture();
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    await writeFile(registryPath, "{corrupt fixture evidence");
    const configFile = join(directory, "agent.json");
    await writeFile(
      configFile,
      JSON.stringify({
        ...config,
        anytype: { ...config.anytype, apiKeyFile: join(directory, "missing-key") },
      }),
    );
    const output = await new Promise<string>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "doctor", "--config", configFile],
        { timeout: 10_000 },
        (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
      ),
    );
    const line = output.split("\n").find((value) => value.includes("context retention registry"));
    expect(line).toContain("warning:");
    expect(line).toContain("status=invalid-json");
    expect(line).toContain("managed_bytes=unavailable");
    expect(line).not.toContain(directory);
    expect(await readFile(registryPath, "utf8")).toBe("{corrupt fixture evidence");
    await expect(stat(`${registryPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs a safe gateway diagnostic while corrupt-registry prompts still succeed", async () => {
    const { config, anytype, turn } = await fixture();
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const evidence = "{private registry evidence";
    await writeFile(registryPath, evidence);
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const log = (event: string, fields?: Record<string, unknown>) =>
      logs.push({ event, ...(fields ? { fields } : {}) });
    const store = new Store(":memory:");
    const gateway = new Gateway(
      anytype,
      new FakeRuntime(),
      config,
      store,
      {} as HeartDiscussionAdapter,
      log,
    );
    try {
      await expect(gateway.start()).rejects.toThrow(
        "Configuration produced no chat or discussion routes",
      );
      await turn("next", "next", (reason) =>
        log("context_registry_unavailable", { operation: "registration", reason }),
      );
      const diagnostics = logs.filter((entry) => entry.event === "context_registry_unavailable");
      expect(diagnostics).toEqual([
        {
          event: "context_registry_unavailable",
          fields: { operation: "cleanup", reason: "invalid-json" },
        },
        {
          event: "context_registry_unavailable",
          fields: { operation: "registration", reason: "invalid-json" },
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(config.runtime.defaultProject);
      expect(JSON.stringify(diagnostics)).not.toContain(evidence);
      expect(await readFile(registryPath, "utf8")).toBe(evidence);
    } finally {
      store.close();
    }
  });

  it("reports verified counts without modifying files, registry evidence or an existing lock", async () => {
    const { config, turn } = await fixture();
    const bundle = await turn("file", "session");
    const registryPath = await registryFile(config.state.path);
    const contents = await readFile(registryPath, "utf8");
    const expectedBytes =
      (await stat(attachment(bundle))).size +
      (await stat(workspaceContextFile(config.runtime.defaultProject!, "session"))).size;
    const release = await processLock.acquireProcessLock(`${registryPath}.lock`);
    try {
      const lockContents = await readFile(`${registryPath}.lock`, "utf8");
      const diagnostics = await inspectContextRegistry(config);
      expect(diagnostics).toEqual({
        status: "ready",
        registeredFiles: 2,
        managedFiles: 2,
        managedBytes: expectedBytes,
        lock: "present",
      });
      expect(contextRegistryDoctorLine(diagnostics)).toContain(`managed_bytes=${expectedBytes}`);
      expect(contextRegistryDoctorLine(diagnostics)).not.toContain(config.runtime.defaultProject);
      expect(await readFile(registryPath, "utf8")).toBe(contents);
      expect(await readFile(`${registryPath}.lock`, "utf8")).toBe(lockContents);
      await writeFile(attachment(bundle), "modified by operator");
      expect(await inspectContextRegistry(config)).toMatchObject({
        registeredFiles: 2,
        managedFiles: 1,
      });
      expect(await readFile(registryPath, "utf8")).toBe(contents);
    } finally {
      await release();
    }
  });

  it("diagnoses an uninitialized registry without creating its state directory", async () => {
    const { config } = await fixture();
    expect(await inspectContextRegistry(config)).toEqual({ status: "missing", lock: "absent" });
    await expect(stat(dirname(config.state.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports registration failure without exposing an unsafe path or overwriting registry evidence", async () => {
    const { config, directory, turn } = await fixture();
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const contents = await readFile(registryPath, "utf8");
    const operatorFile = join(directory, "private-operator-file");
    await writeFile(operatorFile, "operator data");
    const result = await recordWorkspaceSession(config, "private-session", [operatorFile]);
    expect(result).toEqual({ status: "skipped", reason: "registration-failed" });
    expect(await readFile(registryPath, "utf8")).toBe(contents);
    expect(await readFile(operatorFile, "utf8")).toBe("operator data");
  });

  it("reclaims a stale lock and registers the first post-crash turn without waiting", async () => {
    const { config, turn } = await fixture();
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    // This PID exceeds the platform PID range and is used only as a dead-owner fixture.
    await writeFile(`${registryPath}.lock`, "2147483647 fixture\n");
    const issues: string[] = [];
    const started = Date.now();
    await turn("next", "next", (reason) => issues.push(reason));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(issues).toEqual([]);
    expect(await inspectContextRegistry(config)).toMatchObject({
      status: "ready",
      registeredFiles: 4,
      managedFiles: 4,
      lock: "absent",
    });
  });

  it.each([
    "",
    "{broken JSON",
    "null",
    "[]",
    '{"version":1,"files":[],"sessions":{}}',
    '{"version":1,"files":{},"sessions":[]}',
    '{"version":1,"files":null,"sessions":{}}',
    '{"version":1,"files":{},"sessions":"invalid"}',
    '{"version":2,"files":{},"sessions":{}}',
  ])(
    "preserves invalid registry evidence %j and still delivers workspace context",
    async (corrupt) => {
      const { config, turn } = await fixture(1);
      const previous = await turn("previous", "previous");
      const contextPath = workspaceContextFile(config.runtime.defaultProject!, "previous");
      const previousContext = await readFile(contextPath, "utf8");
      const registryPath = await registryFile(config.state.path);
      await writeFile(registryPath, corrupt);

      const reason =
        corrupt === "" || corrupt === "{broken JSON" ? "invalid-json" : "invalid-schema";
      expect(await pruneWorkspaceContext(config, [], after31Days())).toMatchObject({
        removedFiles: 0,
        status: "skipped",
        reason,
      });
      const issues: string[] = [];
      const next = await turn("next", "next", (issue) => issues.push(issue));
      expect(issues).toEqual([reason]);
      expect(await inspectContextRegistry(config)).toEqual({ status: reason, lock: "absent" });
      expect(next.attachments?.[0]?.error).toBeUndefined();
      await expect(stat(attachment(next))).resolves.toMatchObject({ size: 3 });
      await expect(
        stat(workspaceContextFile(config.runtime.defaultProject!, "next")),
      ).resolves.toBeDefined();
      expect(await readFile(registryPath, "utf8")).toBe(corrupt);
      expect(await readFile(contextPath, "utf8")).toBe(previousContext);
      await expect(stat(attachment(previous))).resolves.toMatchObject({ size: 3 });
    },
  );

  it.each([
    [
      "file entry",
      (registry: TestRegistry) => {
        Object.defineProperty(registry.files, Object.keys(registry.files)[0]!, { value: [] });
      },
    ],
    [
      "file size",
      (registry: TestRegistry) => {
        registry.files[Object.keys(registry.files)[0]!]!.size = "3";
      },
    ],
    [
      "file timestamp",
      (registry: TestRegistry) => {
        registry.files[Object.keys(registry.files)[0]!]!.mtimeMs = null;
      },
    ],
    [
      "file inode",
      (registry: TestRegistry) => {
        delete registry.files[Object.keys(registry.files)[0]!]!.ino;
      },
    ],
    [
      "file path",
      (registry: TestRegistry) => {
        registry.files["../../operator-file"] = Object.values(registry.files)[0]!;
      },
    ],
    [
      "session entry",
      (registry: TestRegistry) => {
        Object.defineProperty(registry.sessions, Object.keys(registry.sessions)[0]!, { value: [] });
      },
    ],
    [
      "session timestamp",
      (registry: TestRegistry) => {
        registry.sessions[Object.keys(registry.sessions)[0]!]!.usedAt = -1;
      },
    ],
    [
      "session paths",
      (registry: TestRegistry) => {
        registry.sessions[Object.keys(registry.sessions)[0]!]!.paths = "invalid";
      },
    ],
    [
      "session path entry",
      (registry: TestRegistry) => {
        registry.sessions[Object.keys(registry.sessions)[0]!]!.paths = [null];
      },
    ],
    [
      "session path traversal",
      (registry: TestRegistry) => {
        registry.sessions[Object.keys(registry.sessions)[0]!]!.paths = ["../operator-file"];
      },
    ],
    [
      "session key",
      (registry: TestRegistry) => {
        registry.sessions.invalid = Object.values(registry.sessions)[0]!;
      },
    ],
  ])("rejects an invalid %s before deleting any valid file", async (_name, corruptRegistry) => {
    const { config, turn } = await fixture(1);
    const previous = await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as TestRegistry;
    corruptRegistry(registry);
    const corrupt = JSON.stringify(registry);
    await writeFile(registryPath, corrupt);

    expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
    const next = await turn("next", "next");
    await expect(stat(attachment(previous))).resolves.toMatchObject({ size: 3 });
    await expect(stat(attachment(next))).resolves.toMatchObject({ size: 3 });
    await expect(
      stat(workspaceContextFile(config.runtime.defaultProject!, "previous")),
    ).resolves.toBeDefined();
    expect(await readFile(registryPath, "utf8")).toBe(corrupt);
  });

  it.each(["directory", "symlink"])(
    "skips an unavailable registry replaced by a %s",
    async (kind) => {
      const { config, turn } = await fixture(1);
      const previous = await turn("previous", "previous");
      const registryPath = await registryFile(config.state.path);
      const evidencePath = `${registryPath}.evidence`;
      const contents = await readFile(registryPath, "utf8");
      await rename(registryPath, evidencePath);
      if (kind === "directory") await mkdir(registryPath);
      else await symlink(evidencePath, registryPath);

      expect(await pruneWorkspaceContext(config, [], after31Days())).toMatchObject({
        removedFiles: 0,
        status: "skipped",
        reason: "nonregular",
      });
      const issues: string[] = [];
      const next = await turn("next", "next", (reason) => issues.push(reason));
      expect(issues).toEqual(["nonregular"]);
      await expect(stat(attachment(next))).resolves.toMatchObject({ size: 3 });
      await expect(stat(attachment(previous))).resolves.toMatchObject({ size: 3 });
      expect(await readFile(evidencePath, "utf8")).toBe(contents);
      if (kind === "directory") expect(await readdir(registryPath)).toEqual([]);
      else expect(await readFile(registryPath, "utf8")).toBe(contents);
    },
  );

  it("keeps prompts working when the registry state directory is unavailable", async () => {
    const { config, turn } = await fixture(1);
    const previous = await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const stateDirectory = dirname(registryPath);
    const evidenceDirectory = `${stateDirectory}.evidence`;
    const contents = await readFile(registryPath, "utf8");
    await rename(stateDirectory, evidenceDirectory);
    await writeFile(stateDirectory, "operator-owned file");

    expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
    const next = await turn("next", "next");
    await expect(stat(attachment(next))).resolves.toMatchObject({ size: 3 });
    await expect(stat(attachment(previous))).resolves.toMatchObject({ size: 3 });
    expect(await readFile(stateDirectory, "utf8")).toBe("operator-owned file");
    const evidenceRegistry = await registryFile(join(evidenceDirectory, "state.sqlite"));
    expect(await readFile(evidenceRegistry, "utf8")).toBe(contents);
  });

  it("resumes registration after operator repair without claiming files from skipped turns", async () => {
    const { config, turn } = await fixture(1);
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const validContents = await readFile(registryPath, "utf8");
    await writeFile(registryPath, "corrupt");
    const unmanaged = await turn("unmanaged", "unmanaged");
    await writeFile(registryPath, validContents);
    const active = await turn("active", "active");

    expect((await pruneWorkspaceContext(config, ["active"], after31Days())).removedFiles).toBe(2);
    await expect(stat(attachment(active))).resolves.toMatchObject({ size: 3 });
    await expect(stat(attachment(unmanaged))).resolves.toMatchObject({ size: 3 });
    await expect(
      stat(workspaceContextFile(config.runtime.defaultProject!, "unmanaged")),
    ).resolves.toBeDefined();
  });

  it("skips a contended registry without waiting or failing the next prompt", async () => {
    const { config, turn } = await fixture(1);
    const previous = await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const contents = await readFile(registryPath, "utf8");
    const release = await processLock.acquireProcessLock(`${registryPath}.lock`);
    try {
      const started = Date.now();
      expect(await pruneWorkspaceContext(config, [], after31Days())).toMatchObject({
        removedFiles: 0,
        status: "skipped",
        reason: "lock-contended",
      });
      const issues: string[] = [];
      const next = await turn("next", "next", (reason) => issues.push(reason));
      expect(issues).toEqual(["lock-contended"]);
      expect(Date.now() - started).toBeLessThan(1_000);
      await expect(stat(attachment(next))).resolves.toMatchObject({ size: 3 });
      await expect(stat(attachment(previous))).resolves.toMatchObject({ size: 3 });
      expect(await readFile(registryPath, "utf8")).toBe(contents);
    } finally {
      await release();
    }
  });

  it("does not expose staged attachments to cleanup if session registration is skipped", async () => {
    const { config, turn, anytype } = await fixture(1);
    await turn("previous", "previous");
    const registryPath = await registryFile(config.state.path);
    const bundle = await buildContext(
      anytype,
      config,
      conversation,
      incoming({
        id: "next",
        attachments: [{ target: "next-file", type: "file" }],
      }),
    );
    const release = await processLock.acquireProcessLock(`${registryPath}.lock`);
    try {
      await preparePrompt(bundle, config, "active");
    } finally {
      await release();
    }
    expect((await pruneWorkspaceContext(config, ["active"], after31Days())).removedFiles).toBe(2);
    await expect(stat(attachment(bundle))).resolves.toMatchObject({ size: 3 });
    await expect(
      stat(workspaceContextFile(config.runtime.defaultProject!, "active")),
    ).resolves.toBeDefined();
  });

  it("batches successful attachments and their prompt references in one atomic update", async () => {
    const { config } = await fixture();
    const anytype = new (class extends FakeAnytype {
      async downloadFile(_spaceId: string, fileId: string) {
        if (fileId === "missing") throw new Error("File unavailable");
        return { bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" };
      }
    })();
    const lock = vi.spyOn(processLock, "acquireProcessLock");
    try {
      const bundle = await buildContext(
        anytype,
        config,
        conversation,
        incoming({
          attachments: ["one", "two", "missing", "three"].map((target) => ({
            target,
            type: "file",
          })),
        }),
      );
      expect(lock).not.toHaveBeenCalled();
      await preparePrompt(bundle, config, "session");
      expect(lock).toHaveBeenCalledTimes(1);
      const registry = JSON.parse(
        await readFile(await registryFile(config.state.path), "utf8"),
      ) as TestRegistry;
      expect(Object.keys(registry.files)).toHaveLength(4);
      expect(Object.values(registry.sessions)[0]?.paths).toHaveLength(4);
      expect((await pruneWorkspaceContext(config, ["session"], after31Days())).removedFiles).toBe(
        0,
      );
    } finally {
      lock.mockRestore();
    }
  });

  it("reuses deterministic filenames for repeated attachments and sessions", async () => {
    const { config, turn } = await fixture();
    const first = await turn("same", "session");
    const second = await turn("same", "session");
    expect(attachment(first)).toBe(attachment(second));
    expect(await readdir(dirname(attachment(second)))).toHaveLength(1);
    expect(
      await readdir(dirname(workspaceContextFile(config.runtime.defaultProject!, "session"))),
    ).toHaveLength(1);
    expect(await pruneWorkspaceContext(config, ["session"], after31Days())).toMatchObject({
      removedFiles: 0,
    });
  });

  it("removes old inactive context and media while preserving every active session reference", async () => {
    const { config, turn } = await fixture();
    const earlier = await turn("earlier", "active");
    const latest = await turn("latest", "active");
    const retired = await turn("retired", "inactive");
    const result = await pruneWorkspaceContext(config, ["active"], after31Days());
    expect(result.removedFiles).toBe(2);
    await expect(stat(attachment(earlier))).resolves.toMatchObject({ size: 3 });
    await expect(stat(attachment(latest))).resolves.toMatchObject({ size: 3 });
    await expect(stat(attachment(retired))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(dirname(attachment(retired)))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(workspaceContextFile(config.runtime.defaultProject!, "inactive")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts inactive context under byte pressure without breaking retained context references", async () => {
    const { config, turn } = await fixture(1);
    const inactive = await turn("inactive", "inactive");
    const active = await turn("active", "active");
    const result = await pruneWorkspaceContext(config, ["active"]);
    expect(result.removedFiles).toBe(2);
    expect(result.retainedBytes).toBeGreaterThan(1);
    await expect(stat(attachment(inactive))).rejects.toMatchObject({ code: "ENOENT" });
    const content = JSON.parse(
      await readFile(workspaceContextFile(config.runtime.defaultProject!, "active"), "utf8"),
    );
    for (const item of content.attachments)
      await expect(stat(item.localPath)).resolves.toBeDefined();
    await expect(stat(attachment(active))).resolves.toBeDefined();
  });

  it("protects full-prompt session media and in-flight work", async () => {
    const { config, turn } = await fixture(1, "full");
    const release = holdWorkspaceContext(config);
    const bundle = await turn("pending", "pending");
    expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
    release();
    release();
    expect((await pruneWorkspaceContext(config, ["pending"], after31Days())).removedFiles).toBe(0);
    expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(1);
    await expect(stat(attachment(bundle))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes unknown, modified or symlinked operator files", async () => {
    const { config, directory, turn } = await fixture();
    const modified = await turn("modified", "modified");
    const linked = await turn("linked", "linked");
    const nested = await turn("nested", "nested");
    const unknown = join(dirname(attachment(modified)), `${"a".repeat(24)}.png`);
    await writeFile(unknown, "operator file");
    await writeFile(attachment(modified), "operator replacement");
    const external = join(directory, "operator.txt");
    await writeFile(external, "do not delete");
    await unlink(attachment(linked));
    await symlink(external, attachment(linked));
    const moved = `${dirname(attachment(nested))}-operator`;
    await rename(dirname(attachment(nested)), moved);
    await symlink(moved, dirname(attachment(nested)));
    await pruneWorkspaceContext(config, [], after31Days());
    expect(await readFile(unknown, "utf8")).toBe("operator file");
    expect(await readFile(attachment(modified), "utf8")).toBe("operator replacement");
    expect(await readFile(attachment(linked), "utf8")).toBe("do not delete");
    await expect(stat(attachment(nested))).resolves.toMatchObject({ size: 3 });
  });

  it("refuses to write context through a symlinked managed directory", async () => {
    const { config, directory, turn } = await fixture();
    const external = join(directory, "external");
    await mkdir(external);
    await mkdir(config.runtime.defaultProject!);
    await symlink(external, join(config.runtime.defaultProject!, ".aag"));
    await expect(turn("unsafe", "unsafe")).rejects.toThrow("Unsafe Knot context directory");
    expect(await readdir(external)).toEqual([]);
  });
});
