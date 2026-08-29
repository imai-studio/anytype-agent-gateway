import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAcpDriver, RuntimeTurnAlreadyCompletedError } from "../src/runtime/codex-acp.js";
import { Store } from "../src/store.js";
import type { RuntimeEvent, RuntimeTurn } from "../src/types.js";

const fixture = resolve("test/fixtures/fake-acp.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex ACP continuity", () => {
  it("persists a session, loads it after reopening SQLite, and ignores replayed history", async () => {
    const directory = await temporaryDirectory();
    const database = join(directory, "state.sqlite");
    const firstLog = join(directory, "first.jsonl");
    const firstStore = new Store(database);
    const first = driver(firstStore, {
      FAKE_ACP_LOG: firstLog,
      FAKE_ACP_NEW_SESSION_ID: "durable-session",
    });
    expect(
      await (
        await first.start({ sessionKey: "aag:thread", prompt: "first" }, () => undefined)
      ).result,
    ).toMatchObject({ text: "fresh reply" });
    expect(firstStore.codexAcpSession("aag:thread")).toBe("durable-session");
    firstStore.close();

    const secondLog = join(directory, "second.jsonl");
    const secondStore = new Store(database);
    const events: RuntimeEvent[] = [];
    const second = driver(secondStore, { FAKE_ACP_LOG: secondLog });
    const result = await (
      await second.start({ sessionKey: "aag:thread", prompt: "second" }, (event) =>
        events.push(event),
      )
    ).result;
    expect(result).toMatchObject({ text: "fresh reply" });
    expect(events).toEqual([{ type: "text-delta", text: "fresh reply" }]);
    const calls = await log(secondLog);
    expect(calls.find((call) => call.method === "session/load")?.params).toMatchObject({
      sessionId: "durable-session",
    });
    expect(calls.some((call) => call.method === "session/new")).toBe(false);
    secondStore.close();
  });

  it("replaces a saved session only when the agent reports it unavailable", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "missing-session");
    const runtime = driver(store, {
      FAKE_ACP_LOG: logPath,
      FAKE_ACP_LOAD_ERROR: "missing",
      FAKE_ACP_NEW_SESSION_ID: "replacement-session",
    });
    await (
      await runtime.start({ sessionKey: "aag:thread", prompt: "continue" }, () => undefined)
    ).result;
    expect(store.codexAcpSession("aag:thread")).toBe("replacement-session");
    expect(
      (await log(logPath))
        .filter((call) => call.method === "session/load" || call.method === "session/new")
        .map((call) => call.method),
    ).toEqual(["session/load", "session/new"]);
    store.close();
  });

  it("preserves a saved session when loading repeatedly fails with a transient ACP internal error", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "broken-session");
    const runtime = driver(store, { FAKE_ACP_LOG: logPath, FAKE_ACP_LOAD_ERROR: "internal" });

    await expect(
      runtime.start({ sessionKey: "aag:thread", prompt: "continue" }, () => undefined),
    ).rejects.toThrow("Internal error");

    expect(store.codexAcpSession("aag:thread")).toBe("broken-session");
    expect(
      (await log(logPath))
        .filter((call) => call.method === "session/load" || call.method === "session/new")
        .map((call) => call.method),
    ).toEqual(["session/load", "session/load"]);
    store.close();
  });

  it("keeps continuity when an ACP internal load error succeeds on retry", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "durable-session");
    const runtime = driver(store, { FAKE_ACP_LOG: logPath, FAKE_ACP_LOAD_ERROR: "internal-once" });

    const result = await (
      await runtime.start({ sessionKey: "aag:thread", prompt: "continue" }, () => undefined)
    ).result;

    expect(result).toMatchObject({ text: "fresh reply" });
    expect(store.codexAcpSession("aag:thread")).toBe("durable-session");
    const calls = await log(logPath);
    expect(calls.filter((call) => call.method === "session/load")).toHaveLength(2);
    expect(calls.some((call) => call.method === "session/new")).toBe(false);
    store.close();
  });

  it("does not replace a saved session after an unrelated load failure", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "saved-session");
    const runtime = driver(store, { FAKE_ACP_LOG: logPath, FAKE_ACP_LOAD_ERROR: "auth" });
    await expect(
      runtime.start({ sessionKey: "aag:thread", prompt: "continue" }, () => undefined),
    ).rejects.toThrow("Authentication required");
    expect(store.codexAcpSession("aag:thread")).toBe("saved-session");
    expect((await log(logPath)).some((call) => call.method === "session/new")).toBe(false);
    store.close();
  });

  it("does not delete a saved session for a transient load-service outage", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "saved-session");
    const runtime = driver(store, { FAKE_ACP_LOG: logPath, FAKE_ACP_LOAD_ERROR: "unavailable" });

    await expect(
      runtime.start({ sessionKey: "aag:thread", prompt: "continue" }, () => undefined),
    ).rejects.toThrow("temporarily unavailable");

    expect(store.codexAcpSession("aag:thread")).toBe("saved-session");
    expect((await log(logPath)).some((call) => call.method === "session/new")).toBe(false);
    store.close();
  });

  it("does not replay a failed prompt or discard its persisted session", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const store = new Store(join(directory, "state.sqlite"));
    store.saveCodexAcpSession("aag:thread", "poisoned-session");
    const runtime = driver(store, {
      FAKE_ACP_LOG: logPath,
      FAKE_ACP_PROMPT_ERROR_SESSION: "poisoned-session",
    });

    const active = await runtime.start(
      { sessionKey: "aag:thread", prompt: "recover" },
      () => undefined,
    );

    await expect(active.result).rejects.toThrow("Internal error");
    expect(store.codexAcpSession("aag:thread")).toBe("poisoned-session");
    const calls = await log(logPath);
    expect(
      calls.filter((call) => call.method === "session/prompt").map((call) => call.params.sessionId),
    ).toEqual(["poisoned-session"]);
    store.close();
  });

  it("preserves the persisted session when an active run is cancelled", async () => {
    const directory = await temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"));
    const runtime = driver(store, {
      FAKE_ACP_NEW_SESSION_ID: "cancelled-session",
      FAKE_ACP_PROMPT_DELAY_MS: "1000",
    });
    const active = await runtime.start(
      { sessionKey: "aag:thread", prompt: "cancel me" },
      () => undefined,
    );

    await active.cancel();

    expect(store.codexAcpSession("aag:thread")).toBe("cancelled-session");
    await active.result.catch(() => undefined);
    store.close();
  });
});

describe("Codex ACP output and steering", () => {
  it("terminates an ACP child that never completes setup", async () => {
    const runtime = new CodexAcpDriver({
      kind: "codex",
      command: process.execPath,
      args: [fixture],
      allowedProjects: [],
      environment: { FAKE_ACP_HANG_INITIALIZE: "true" },
      timeoutSeconds: 0.05,
      permissions: "deny",
    });

    await expect(
      runtime.start({ sessionKey: "hung-setup", prompt: "answer" }, () => undefined),
    ).rejects.toThrow("Codex ACP setup timed out");
  });

  it("suppresses the split internal skill warning from deltas and the final result", async () => {
    const warning =
      "Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.";
    const events: RuntimeEvent[] = [];
    const runtime = driver(undefined, {
      FAKE_ACP_UPDATES: JSON.stringify([
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          content: { type: "text", text: warning.slice(0, 35) },
          _meta: { codex: { phase: "final_answer" } },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          content: { type: "text", text: `${warning.slice(35)}\n\n` },
          _meta: { codex: { phase: "final_answer" } },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          content: { type: "text", text: "visible answer" },
          _meta: { codex: { phase: "final_answer" } },
        },
      ]),
    });
    const result = await (
      await runtime.start({ sessionKey: "warning", prompt: "answer" }, (event) =>
        events.push(event),
      )
    ).result;
    expect(result).toMatchObject({ text: "visible answer" });
    expect(events).toEqual([
      { type: "text-delta", text: "visible answer", partId: "final", phase: "final_answer" },
    ]);
  });

  it("suppresses the exceeded skill-budget warning", async () => {
    const warning =
      "Warning: Exceeded skills context budget. All skill descriptions were removed and 105 additional skills were not included in the model-visible skills list.";
    const events: RuntimeEvent[] = [];
    const runtime = driver(undefined, {
      FAKE_ACP_UPDATES: JSON.stringify([
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          content: { type: "text", text: warning.slice(0, 44) },
          _meta: { codex: { phase: "final_answer" } },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          content: { type: "text", text: `${warning.slice(44)}\n\nvisible answer` },
          _meta: { codex: { phase: "final_answer" } },
        },
      ]),
    });
    const result = await (
      await runtime.start({ sessionKey: "exceeded-warning", prompt: "answer" }, (event) =>
        events.push(event),
      )
    ).result;

    expect(result).toMatchObject({ text: "visible answer" });
    expect(events).toEqual([
      { type: "text-delta", text: "visible answer", partId: "final", phase: "final_answer" },
    ]);
  });

  it("uses the terminal final-answer message instead of concatenating progress replies", async () => {
    const updates = [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "progress",
        content: { type: "text", text: "I am working." },
        _meta: { codex: { phase: "commentary" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "final",
        content: { type: "text", text: "CLEAN_FINAL" },
        _meta: { codex: { phase: "final_answer" } },
      },
    ];
    const events: RuntimeEvent[] = [];
    const runtime = driver(undefined, { FAKE_ACP_UPDATES: JSON.stringify(updates) });
    const result = await (
      await runtime.start({ sessionKey: "terminal", prompt: "answer" }, (event) =>
        events.push(event),
      )
    ).result;
    expect(result).toMatchObject({ text: "CLEAN_FINAL" });
    expect(events).toEqual([
      { type: "text-delta", text: "I am working.", partId: "progress", phase: "commentary" },
      { type: "text-delta", text: "CLEAN_FINAL", partId: "final", phase: "final_answer" },
    ]);
  });

  it("propagates native steering failure without cancelling and queueing another prompt", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const runtime = driver(undefined, { FAKE_ACP_LOG: logPath, FAKE_ACP_PROMPT_DELAY_MS: "100" });
    const active = await runtime.start({ sessionKey: "steer", prompt: "start" }, () => undefined);
    await expect(active.steer("follow up")).rejects.toThrow("Steering rejected by fake agent");
    await active.result;
    const calls = await log(logPath);
    expect(calls.filter((call) => call.method === "session/prompt")).toHaveLength(1);
    expect(calls.some((call) => call.method === "session/cancel")).toBe(false);
  });

  it("signals a late steer as an already-completed turn", async () => {
    const runtime = driver();
    const active = await runtime.start(
      { sessionKey: "completed", prompt: "answer" },
      () => undefined,
    );
    await active.result;
    await expect(active.steer("too late")).rejects.toBeInstanceOf(RuntimeTurnAlreadyCompletedError);
  });

  it("scopes the Anytype MCP server to the explicit route and space without passing an API key", async () => {
    const directory = await temporaryDirectory();
    const logPath = join(directory, "calls.jsonl");
    const runtime = new CodexAcpDriver(
      {
        kind: "codex",
        command: process.execPath,
        args: [fixture],
        allowedProjects: [],
        environment: { FAKE_ACP_LOG: logPath },
        timeoutSeconds: 2,
        permissions: "deny",
      },
      undefined,
      {
        command: "aag",
        args: ["mcp", "serve"],
        env: { SAFE_SETTING: "yes", ANYTYPE_API_KEY: "must-not-leak", AAG_ROUTE_ID: "spoofed" },
      },
    );
    const turn: RuntimeTurn = {
      conversation: {
        routeId: "chat:space-1:chat-1",
        spaceId: "space-1",
        chatId: "chat-1",
        kind: "chat",
      },
      message: { id: "trigger", creator: "human", content: { text: "hello" } },
      replyTargetId: "trigger",
    };

    await (
      await runtime.start(
        { sessionKey: "native-session-key", prompt: "answer", turn },
        () => undefined,
      )
    ).result;

    const calls = await log(logPath);
    const session = calls.find((call) => call.method === "session/new")?.params as
      { mcpServers?: Array<{ env?: Array<{ name: string; value: string }> }> } | undefined;
    const environment = Object.fromEntries(
      (session?.mcpServers?.[0]?.env ?? []).map((item) => [item.name, item.value]),
    );
    expect(environment).toMatchObject({
      SAFE_SETTING: "yes",
      AAG_ROUTE_ID: "chat:space-1:chat-1",
      AAG_SPACE_ID: "space-1",
    });
    expect(environment.AAG_ROUTE_ID).not.toBe("native-session-key");
    expect(Object.keys(environment).some((name) => /api[_-]?key/i.test(name))).toBe(false);
    expect(Object.values(environment)).not.toContain("must-not-leak");
  });
});

function driver(store?: Store, environment: Record<string, string> = {}): CodexAcpDriver {
  return new CodexAcpDriver(
    {
      kind: "codex",
      command: process.execPath,
      args: [fixture],
      allowedProjects: [],
      environment,
      timeoutSeconds: 2,
      permissions: "deny",
    },
    store,
  );
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "aag-codex-acp-"));
  temporaryDirectories.push(path);
  return path;
}

async function log(
  path: string,
): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
