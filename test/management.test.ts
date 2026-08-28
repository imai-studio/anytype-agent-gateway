import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { formatPrompt } from "../src/context.js";
import { setRouteWake } from "../src/management.js";
import { Store } from "../src/store.js";
import type { ContextBundle } from "../src/types.js";

describe("constrained gateway management", () => {
  it("persists a route-specific wake policy and applies a live override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-management-"));
    const configPath = join(dir, "agent.yaml");
    const statePath = join(dir, "state.sqlite");
    await writeFile(configPath, YAML.stringify({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space", chatDiscovery: { enabled: true, wake: { humans: "mention", agents: "never", allowedUsers: ["human"] } } }],
      runtime: { kind: "openclaw" },
      management: { allowWakeChanges: true },
      state: { path: statePath }
    }));

    await setRouteWake({ configPath, routeId: "chat:space:new-chat", humans: "every-message" });

    const config = await loadConfig(configPath);
    expect(config.spaces[0]?.wakeOverrides[0]).toMatchObject({ kind: "chat", id: "new-chat", wake: { humans: "every-message", agents: "never", allowedUsers: ["human"] } });
    const store = new Store(statePath);
    expect(store.wakeOverride("chat:space:new-chat")).toBe("every-message");
    store.close();
    expect((await readFile(configPath, "utf8")).includes("wakeOverrides")).toBe(true);
  });

  it("refuses changes unless self-management is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-management-"));
    const configPath = join(dir, "agent.yaml");
    await writeFile(configPath, YAML.stringify({ version: 1, agent: { name: "Anya", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ id: "space" }], runtime: { kind: "openclaw" } }));
    await expect(setRouteWake({ configPath, routeId: "chat:space:chat", humans: "every-message" })).rejects.toThrow("allowWakeChanges is disabled");
  });

  it("tells the harness it is gateway-connected and exposes only the constrained command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aag-management-"));
    const configPath = join(dir, "agent.yaml");
    await writeFile(configPath, YAML.stringify({ version: 1, agent: { name: "Anya", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ id: "space" }], runtime: { kind: "openclaw" }, management: { allowWakeChanges: true } }));
    const config = await loadConfig(configPath);
    const bundle: ContextBundle = { conversation: { routeId: "chat:space:chat", spaceId: "space", chatId: "chat", kind: "chat" }, trigger: { id: "m1", content: { text: "listen here" } }, history: [], replyAncestry: [], referencedObjects: [] };
    const prompt = formatPrompt(bundle, config, "aag config wake --route-id chat:space:chat --humans <mode>");
    expect(prompt).toContain("Anytype Agent Gateway (AAG)");
    expect(prompt).toContain("aag config wake");
    expect(prompt).toContain("explicit wake-behavior request");
  });
});
