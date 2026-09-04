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
import { holdWorkspaceContext, pruneWorkspaceContext } from "../src/context-retention.js";
import * as processLock from "../src/process-lock.js";
import type { ContextBundle, ConversationRef } from "../src/types.js";
import { FakeAnytype, incoming } from "./fakes.js";

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
  async function turn(id: string, sessionKey: string): Promise<ContextBundle> {
    const bundle = await buildContext(
      anytype,
      config,
      conversation,
      incoming({
        id,
        attachments: [{ type: "file", target: `file-${id}` }],
      }),
    );
    await preparePrompt(bundle, config, sessionKey);
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

      expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
      const next = await turn("next", "next");
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

      expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
      const next = await turn("next", "next");
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
      expect((await pruneWorkspaceContext(config, [], after31Days())).removedFiles).toBe(0);
      const next = await turn("next", "next");
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
