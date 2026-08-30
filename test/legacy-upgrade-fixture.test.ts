import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { configSchema, loadConfig } from "../src/config.js";
import { AgentController, messageFingerprint } from "../src/controller.js";
import { Store } from "../src/store.js";
import { FakeAnytype, FakeRuntime } from "./fakes.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v0.1.3");
const routeId = "chat:_space_fixture_01:_chat_fixture_01";

describe("sanitized v0.1.3 upgrade fixture", () => {
  it("contains only synthetic identities and no credential material", async () => {
    const files = ["agent.yaml", "environment.env", "anytype-agent-gateway.service"];
    const contents = (
      await Promise.all(files.map((file) => readFile(join(fixture, file), "utf8")))
    ).join("\n");
    expect(contents).toContain("_participant_fixture_");
    expect(contents).not.toMatch(/sk-[A-Za-z0-9]|Bearer\s|https:\/\/.*invite/i);
    expect(contents).not.toContain("/Users/");
  });

  it("opens in place and preserves sessions, authorization, dedupe, and replay barriers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aag-v013-upgrade-"));
    const databasePath = join(directory, "state.sqlite");
    const fixtureDatabase = new DatabaseSync(databasePath);
    fixtureDatabase.exec(await readFile(join(fixture, "state.sql"), "utf8"));
    fixtureDatabase.close();

    const store = new Store(databasePath);
    expect(store.schemaVersion()).toBe(6);
    expect(store.cursor(routeId)).toBe("0000000000000042");
    expect(store.sessionGeneration(routeId)).toBe(2);
    expect(store.sessionBinding(routeId)).toMatchObject({
      nativeSessionKey: "aag:chat:_space_fixture_01:_chat_fixture_01:g2",
      nativeSessionId: "_session_fixture_01",
      eventCursor: "event-fixture-7",
      state: "active",
    });
    expect(store.wakeOverride(routeId)).toEqual({
      humans: "mention-or-reply",
      allowedUsers: ["_participant_fixture_admin_01"],
    });
    const historical = {
      id: "_message_historical_01",
      creator: "_participant_fixture_admin_01",
      modified_at: 1700000001000,
      content: { text: "legacy message already handled" },
    };
    expect(
      store.isHandled(
        routeId,
        historical.id,
        historical.modified_at,
        messageFingerprint(historical),
      ),
    ).toBe(true);
    expect(
      store.db
        .prepare("SELECT status,dedupe_key FROM outbound_outbox WHERE item_id=?")
        .get("_outbox_fixture_01"),
    ).toEqual({ status: "delivered", dedupe_key: "aag:fixture:response:dedupe-01" });
    const runtime = new FakeRuntime();
    const controller = new AgentController(
      new FakeAnytype(),
      runtime,
      configSchema.parse({
        version: 1,
        agent: { name: "Fixture Agent", participantId: "_participant_fixture_agent_01" },
        anytype: { apiKeyFile: "/fixture/key" },
        spaces: [{ id: "_space_fixture_01" }],
        runtime: { kind: "codex" },
        state: { path: databasePath },
      }),
      store,
      () => undefined,
    );
    await controller.process(
      {
        routeId,
        spaceId: "_space_fixture_01",
        chatId: "_chat_fixture_01",
        kind: "chat",
      },
      {
        humans: "mention-or-reply",
        agents: "never",
        allowedUsers: ["_participant_fixture_admin_01"],
      },
      historical,
    );
    expect(runtime.starts).toHaveLength(0);
    await controller.stop();
    store.close();
  });

  it("loads the released config shape without conversion", async () => {
    const config = await loadConfig(join(fixture, "agent.yaml"));
    expect(config.agent.participantId).toBe("_participant_fixture_agent_01");
    expect(config.spaces[0]?.chats[0]?.wake.allowedUsers).toEqual([
      "_participant_fixture_admin_01",
    ]);
    expect(config.state.path).toBe("/fixture/state/state.sqlite");
  });
});
