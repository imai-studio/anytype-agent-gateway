import { constants } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema, loadConfig } from "../src/config.js";

const yaml = `version: 1
agent: { name: AAG, participantId: bot }
anytype: { apiKeyFile: /tmp/key }
spaces:
  - name: Test
    chats:
      - name: sandbox
        wake: { humans: mention, agents: never, allowedUsers: [human-1] }
runtime: { kind: openclaw }
`;

describe("loadConfig", () => {
  it("applies safe defaults to YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const path = join(dir, "agent.yaml");
    await writeFile(path, yaml);
    const config = await loadConfig(path);
    expect(config.spaces[0]?.comments.mode).toBe("disabled");
    expect(config.spaces[0]?.chats[0]?.wake.humans).toBe("mention");
    expect(config.spaces[0]?.chats[0]?.wake.agents).toBe("never");
    expect(config.responses.silentPlaceholder).toBe("delete");
    expect(config.responses.streaming).toBe(true);
    expect(config.runtime.timeoutSeconds).toBe(0);
    expect(config.runtime.maxRunSeconds).toBe(0);
    expect(config.tools.anytype.enabled).toBe(false);
    expect(config.tools.anytype.allowWrite).toBe(false);
    expect(config.spaces[0]?.chatDiscovery.enabled).toBe(false);
  });

  it("rejects prefix wake without a prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const path = join(dir, "bad.yaml");
    await writeFile(
      path,
      yaml
        .replace("runtime: { kind: openclaw }", "runtime: { kind: openclaw }\n")
        .replace(
          "wake: { humans: mention, agents: never, allowedUsers: [human-1] }",
          "wake: { humans: prefix, agents: never, allowedUsers: [human-1] }",
        ),
    );
    await expect(loadConfig(path)).rejects.toThrow("wake.prefix");
  });

  it("requires an explicit wake policy when comments are enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const path = join(dir, "comments.yaml");
    await writeFile(
      path,
      yaml.replace(
        "chats:\n      - name: sandbox\n        wake: { humans: mention, agents: never, allowedUsers: [human-1] }",
        "comments: { mode: all }",
      ),
    );
    await expect(loadConfig(path)).rejects.toThrow("comments.wake");
  });

  it("requires an explicit wake policy when chat discovery is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const path = join(dir, "chat-discovery.yaml");
    await writeFile(
      path,
      yaml
        .replace("runtime: { kind: openclaw }", "runtime: { kind: openclaw }\n")
        .replace("    chats:", "    chatDiscovery: { enabled: true }\n    chats:"),
    );
    await expect(loadConfig(path)).rejects.toThrow("chatDiscovery.wake");
  });

  it("requires access admins when runtime access changes are enabled", () => {
    expect(() =>
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiKeyFile: "/tmp/key" },
        spaces: [{ id: "space" }],
        runtime: { kind: "openclaw" },
        management: { allowAccessChanges: true },
      }),
    ).toThrow("accessAdmins");
  });

  it("resolves the packaged Codex ACP executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const path = join(dir, "codex.yaml");
    await writeFile(path, yaml.replace("runtime: { kind: openclaw }", "runtime: { kind: codex }"));

    const config = await loadConfig(path);

    expect(config.runtime.kind).toBe("codex");
    if (config.runtime.kind !== "codex") throw new Error("expected Codex runtime");
    expect(config.runtime.command).toMatch(/node_modules\/[.]bin\/codex-acp$/);
    await expect(access(config.runtime.command, constants.X_OK)).resolves.toBeUndefined();
  });
});
