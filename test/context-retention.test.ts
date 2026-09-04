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
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { buildContext, preparePrompt, workspaceContextFile } from "../src/context.js";
import { holdWorkspaceContext, pruneWorkspaceContext } from "../src/context-retention.js";
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
  return { config, directory, turn };
}

function attachment(bundle: ContextBundle): string {
  return bundle.attachments![0]!.localPath!;
}

describe("managed workspace context retention", () => {
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
