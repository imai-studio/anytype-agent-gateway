import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import plugin, { AnytypeChannelRuntime } from "./index.js";

describe("OpenClaw plugin registration", () => {
  it("ships startup and cold-path channel metadata", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as any;
    expect(manifest.activation?.onStartup).toBe(true);
    expect(manifest.channelConfigs?.anytype?.schema?.properties).toMatchObject({
      bridgeToken: { type: "string", minLength: 24 },
      allowFrom: { type: "array", minItems: 1 },
    });
  });

  it("registers the native channel, session output subscription, and cleanup", () => {
    const registerChannel = vi.fn();
    const registerAgentEventSubscription = vi.fn();
    const registerRuntimeLifecycle = vi.fn();
    plugin.register({
      registrationMode: "full",
      config: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      registerChannel,
      agent: { events: { registerAgentEventSubscription } },
      lifecycle: { registerRuntimeLifecycle },
    } as never);

    expect(registerChannel).toHaveBeenCalledOnce();
    expect(registerChannel.mock.calls[0]?.[0]?.plugin).toMatchObject({
      id: "anytype",
      capabilities: { reply: true, threads: true },
    });
    expect(registerAgentEventSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "anytype-session-output",
        streams: ["assistant", "thinking", "tool", "lifecycle", "item"],
      }),
    );
    expect(registerRuntimeLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "anytype-bridge-cleanup" }),
    );
  });
});

describe("native session event observation", () => {
  it("mirrors only an exactly bound Anytype session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aag-anytype-runtime-"));
    const cfg = {
      channels: {
        anytype: {
          bridgeToken: "test-token-that-is-long-enough",
          allowFrom: ["owner"],
          databasePath: join(dir, "bridge.sqlite"),
        },
      },
    };
    const runtime = new AnytypeChannelRuntime({
      config: cfg,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never);
    const account = runtime.runtimeFor(cfg);
    account.store.bindSession("agent:anya:anytype:channel:bound", "default", {
      spaceId: "space",
      chatId: "chat",
    });
    account.store.markOwnedRun("scheduled-run");

    runtime.observeAgentEvent({
      runId: "scheduled-run",
      seq: 4,
      stream: "assistant",
      ts: 1_000,
      sessionKey: "agent:anya:anytype:channel:unrelated",
      data: { text: "must not leak" },
    });
    expect(account.store.pendingDeliveries(2_000)).toEqual([]);

    runtime.observeAgentEvent({
      runId: "scheduled-run",
      seq: 5,
      stream: "assistant",
      ts: 1_001,
      sessionKey: "agent:anya:anytype:channel:bound",
      data: { text: "scheduled output", rawPrompt: "must not be persisted", apiKey: "must not leak" },
    });
    expect(account.store.pendingDeliveries(Date.now() + 2_000)).toEqual([
      expect.objectContaining({
        sessionKey: "agent:anya:anytype:channel:bound",
        route: { spaceId: "space", chatId: "chat" },
        kind: "agent-event",
        owned: true,
        agentEvent: expect.objectContaining({ runId: "scheduled-run", seq: 5, data: { text: "scheduled output" } }),
      }),
    ]);
    await runtime.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });
});
