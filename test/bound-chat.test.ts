import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createBoundCodexChat } from "../src/bound-chat.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

describe("bound Anytype and Codex chats", () => {
  it("creates and persists a one-to-one chat and Codex task binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-bound-chat-"));
    const configPath = join(dir, "agent.yaml");
    const statePath = join(dir, "state.sqlite");
    const project = join(dir, "imai");
    await writeFile(
      configPath,
      YAML.stringify({
        version: 1,
        agent: { name: "Klee", participantId: "bot" },
        anytype: { apiKeyFile: "/tmp/key" },
        spaces: [
          {
            id: "space",
            name: "Agents",
            chatDiscovery: {
              enabled: true,
              autoEnroll: true,
              wake: { humans: "mention", agents: "never", allowedUsers: ["raj"] },
            },
          },
        ],
        runtime: {
          kind: "codex",
          defaultProject: dir,
          allowedProjects: [project],
        },
        tools: { anytype: { enabled: true, allowWrite: true }, codex: { enabled: true } },
        state: { path: statePath },
      }),
    );
    const config = await loadConfig(configPath);
    const createTask = vi.fn(async () => ({
      thread_id: "codex-thread",
      project,
      status: "running" as const,
    }));
    const enrollRoute = vi.fn(async () => "enrolled" as const);

    const result = await createBoundCodexChat(
      { createChat: vi.fn(async () => ({ id: "new-chat", name: "IMAI work" })) },
      config,
      configPath,
      { spaceId: "space", name: "IMAI work", project, prompt: "Start here" },
      { createTask, enrollRoute },
    );

    expect(result).toEqual({
      chat_id: "new-chat",
      chat_name: "IMAI work",
      route_id: "chat:space:new-chat",
      thread_id: "codex-thread",
      project,
      status: "bound",
    });
    expect(createTask).toHaveBeenCalledWith(config, {
      project,
      prompt: expect.stringMatching(/persistent harness session[\s\S]*Start here$/),
    });
    expect(enrollRoute).toHaveBeenCalledWith(
      expect.objectContaining({ configPath, spaceId: "space", chatId: "new-chat" }),
    );

    const store = new Store(statePath);
    expect(store.sessionBinding("chat:space:new-chat")).toMatchObject({
      routeId: "chat:space:new-chat",
      runtime: "codex-acp",
      nativeSessionId: "codex-thread",
      state: "active",
    });
    expect(store.codexAcpSession("aag:chat:space:new-chat")).toBe("codex-thread");
    expect(store.sessionWorkspace("chat:space:new-chat")).toBe(project);
    store.close();
  });
});
