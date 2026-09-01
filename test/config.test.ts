import { constants } from "node:fs";
import { access, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
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
    expect(config.context.promptMode).toBe("full");
    expect(config.runtime.timeoutSeconds).toBe(0);
    expect(config.runtime.maxRunSeconds).toBe(0);
    expect(config.tools.anytype.enabled).toBe(false);
    expect(config.tools.anytype.allowWrite).toBe(false);
    expect(config.tools.codex.enabled).toBe(false);
    expect(config.spaces[0]?.chatDiscovery.enabled).toBe(false);
    expect(config.spaces[0]?.chatDiscovery.autoEnroll).toBe(false);
    expect(config.directMessages.enabled).toBe(false);
    expect(config.directMessages.createMissing).toBe(false);
    expect(config.automation.enabled).toBe(false);
    expect(config.automation.execution).toBe(false);
    expect(config.automation.maximumRiskTier).toBe("T0");
    expect(config.automation.definitionTypeKeys).toEqual(["knot-workflow"]);
    expect(config.automation.polling).toEqual({
      minimumIntervalSeconds: 10,
      maximumIntervalSeconds: 300,
      pageSize: 100,
    });
  });

  it("requires explicit workflow authors and spaces before enabling automation", () => {
    const base = {
      version: 1,
      agent: { name: "Knot", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: { kind: "codex" },
    };
    expect(() => configSchema.parse({ ...base, automation: { enabled: true } })).toThrow(
      "allowedAuthorIds",
    );
    expect(
      configSchema.parse({
        ...base,
        automation: {
          enabled: true,
          allowedAuthorIds: ["operator"],
          allowedSpaceIds: ["space"],
        },
      }).automation.enabled,
    ).toBe(true);
    expect(() =>
      configSchema.parse({
        ...base,
        automation: {
          enabled: true,
          observation: false,
          execution: true,
          allowedAuthorIds: ["operator"],
          allowedSpaceIds: ["space"],
        },
      }),
    ).toThrow("observation");
    expect(() =>
      configSchema.parse({
        ...base,
        automation: {
          enabled: true,
          observation: true,
          execution: true,
          allowedAuthorIds: ["operator"],
          allowedSpaceIds: ["space"],
        },
      }),
    ).toThrow("not available in this release");
    expect(() =>
      configSchema.parse({ ...base, automation: { allowedCapabilties: ["anytype.read"] } }),
    ).toThrow("Unrecognized key");
    expect(() => configSchema.parse({ ...base, automation: { heartHints: true } })).toThrow(
      "Heart hints",
    );
    expect(() =>
      configSchema.parse({
        ...base,
        automation: {
          enabled: true,
          allowedAuthorIds: ["operator"],
          allowedSpaceIds: ["space"],
          polling: { pageSize: 101 },
        },
      }),
    ).toThrow();
    expect(() =>
      configSchema.parse({
        ...base,
        automation: {
          enabled: true,
          allowedAuthorIds: ["operator"],
          allowedSpaceIds: ["😀".repeat(400)],
        },
      }),
    ).toThrow("Too big");
    expect(() =>
      configSchema.parse({
        ...base,
        automation: {
          polling: { minimumIntervalSeconds: 30, maximumIntervalSeconds: 10 },
        },
      }),
    ).toThrow("must not be below the minimum");
  });

  it("accepts workspace-owned stable prompt instructions", () => {
    const config = configSchema.parse({
      version: 1,
      agent: { name: "Klee", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "codex" },
      context: { promptMode: "workspace" },
    });
    expect(config.context.promptMode).toBe("workspace");
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

  it("requires a narrow mention policy for chat auto-enrollment", () => {
    const base = {
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      runtime: { kind: "openclaw" },
    };
    expect(() =>
      configSchema.parse({
        ...base,
        spaces: [
          {
            id: "space",
            chatDiscovery: {
              enabled: true,
              autoEnroll: true,
              wake: { humans: "every-message", agents: "never", allowedUsers: ["admin"] },
            },
          },
        ],
      }),
    ).toThrow("mention-based");
    expect(() =>
      configSchema.parse({
        ...base,
        spaces: [
          {
            id: "space",
            chatDiscovery: {
              enabled: true,
              autoEnroll: true,
              wake: { humans: "mention", agents: "never", allowedUsers: ["*"] },
            },
          },
        ],
      }),
    ).toThrow("explicit sender allowlist");
    expect(() =>
      configSchema.parse({
        ...base,
        directMessages: {
          enabled: true,
          wake: { humans: "every-message", agents: "never", allowedUsers: [""] },
        },
      }),
    ).toThrow();
    expect(() =>
      configSchema.parse({
        ...base,
        spaces: [
          {
            id: "space",
            chatDiscovery: {
              enabled: true,
              autoEnroll: true,
              wake: { humans: "mention", agents: "never", allowedUsers: ["admin"] },
            },
            wakeOverrides: [
              {
                kind: "chat",
                id: "chat",
                wake: { humans: "mention", agents: "never", allowedUsers: ["*"] },
              },
            ],
          },
        ],
      }),
    ).toThrow("wildcard route overrides");
  });

  it("requires an explicit sender allowlist and every-message wake for direct messages", () => {
    const base = {
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: { kind: "openclaw" },
    };
    expect(() =>
      configSchema.parse({
        ...base,
        directMessages: {
          enabled: true,
          wake: { humans: "mention", agents: "never", allowedUsers: ["admin"] },
        },
      }),
    ).toThrow("every-message");
    expect(() =>
      configSchema.parse({
        ...base,
        directMessages: {
          enabled: true,
          wake: { humans: "every-message", agents: "never", allowedUsers: ["*"] },
        },
      }),
    ).toThrow("explicit sender allowlist");
    const accepted = configSchema.parse({
      ...base,
      directMessages: {
        enabled: true,
        wake: { humans: "every-message", agents: "never", allowedUsers: ["admin"] },
      },
    }).directMessages;
    expect(accepted.enabled).toBe(true);
    expect(accepted.createMissing).toBe(false);
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

  it("requires project admins when Chat project changes are enabled", () => {
    expect(() =>
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiKeyFile: "/tmp/key" },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
        management: { allowProjectChanges: true },
      }),
    ).toThrow("projectAdmins");
    expect(() =>
      configSchema.parse({
        version: 1,
        agent: { name: "AAG", participantId: "bot" },
        anytype: { apiKeyFile: "/tmp/key" },
        spaces: [{ id: "space" }],
        runtime: { kind: "codex" },
        management: { allowProjectChanges: true, projectAdmins: [""] },
      }),
    ).toThrow();
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

  it("keeps gateway state outside agent-accessible projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const project = join(dir, "workspace");
    const path = join(dir, "unsafe.yaml");
    await writeFile(
      path,
      `${yaml.replace("runtime: { kind: openclaw }", `runtime: { kind: openclaw, defaultProject: ${project} }`)}state: { path: ${join(project, ".aag", "state.sqlite")} }\n`,
    );

    await expect(loadConfig(path)).rejects.toThrow(
      "state.path must be outside agent-accessible project directories",
    );
  });

  it("resolves project symlinks before checking gateway state isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-config-"));
    const stateRoot = join(dir, "state-root");
    const projectLink = join(dir, "linked-project");
    const path = join(dir, "unsafe-symlink.yaml");
    await mkdir(stateRoot);
    await symlink(stateRoot, projectLink);
    await writeFile(
      path,
      `${yaml.replace("runtime: { kind: openclaw }", `runtime: { kind: openclaw, defaultProject: ${projectLink} }`)}state: { path: ${join(stateRoot, "state.sqlite")} }\n`,
    );

    await expect(loadConfig(path)).rejects.toThrow(
      "state.path must be outside agent-accessible project directories",
    );
  });
});
