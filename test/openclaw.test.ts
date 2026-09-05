import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { configSchema } from "../src/config.js";
import { OpenClawDriver } from "../src/runtime/openclaw.js";
import { BridgeServer, BridgeStore } from "../packages/openclaw-anytype-channel/src/index.js";

const tokenEnvironment = "AAG_TEST_OPENCLAW_TOKEN";
const bridgeTokenEnvironment = "AAG_TEST_OPENCLAW_BRIDGE_TOKEN";
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env[tokenEnvironment];
  delete process.env[bridgeTokenEnvironment];
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("OpenClaw gateway recovery", () => {
  it("discovers models and patches the native OpenClaw session", async () => {
    process.env[tokenEnvironment] = "test-token";
    const calls: Array<{ method: string; params?: unknown }> = [];
    class ModelGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === "models.list")
          return {
            models: [
              { provider: "openai", id: "gpt-default", name: "Default" },
              { provider: "openai", id: "gpt-fast", name: "Fast" },
            ],
          } as T;
        if (method === "sessions.patch") {
          const requested = (params as { model?: string | null } | undefined)?.model;
          return (
            requested === null
              ? { entry: {} }
              : { entry: { providerOverride: "openai", modelOverride: "gpt-fast" } }
          ) as T;
        }
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, ModelGatewayClient);

    const state = await driver.configureModel({
      sessionKey: "chat-session",
      modelId: "openai/gpt-fast",
    });

    expect(state.currentModelId).toBe("openai/gpt-fast");
    expect(state.options.map((model) => model.id)).toEqual([
      "openai/gpt-default",
      "openai/gpt-fast",
    ]);
    expect(calls).toContainEqual({
      method: "sessions.patch",
      params: { key: "chat-session", model: "openai/gpt-fast" },
    });
    const reset = await driver.configureModel({ sessionKey: "never-created", modelId: null });
    expect(reset.currentModelId).toBeUndefined();
    expect(calls).toContainEqual({
      method: "sessions.patch",
      params: { key: "never-created", model: null },
    });
    await driver.close();
  });

  it("fails before launching a run when the model patch is rejected", async () => {
    process.env[tokenEnvironment] = "test-token";
    const calls: string[] = [];
    class RejectingModelGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "models.list") return { models: [{ id: "gpt-fast" }] } as T;
        if (method === "sessions.patch") throw new Error("patch rejected");
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, RejectingModelGatewayClient);
    await expect(
      driver.start(
        { sessionKey: "new-session", prompt: "hello", modelId: "gpt-fast" },
        () => undefined,
      ),
    ).rejects.toThrow("patch rejected");
    expect(calls).not.toContain("agent");
    await driver.close();
  });

  it("continues an ordinary turn when best-effort model discovery fails", async () => {
    process.env[tokenEnvironment] = "test-token";
    const calls: string[] = [];
    class DiscoveryFailureGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "models.list") throw new Error("catalog temporarily unavailable");
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent") return { runId: "ordinary-run" } as T;
        if (method === "agent.wait")
          return { result: { payloads: [{ text: "ordinary reply" }] } } as T;
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, DiscoveryFailureGatewayClient, true);

    const active = await driver.start({ sessionKey: "ordinary", prompt: "hello" }, () => undefined);

    await expect(active.result).resolves.toMatchObject({ text: "ordinary reply" });
    expect(calls).toContain("models.list");
    expect(calls).toContain("agent");
    await driver.close();
  });

  it("resumes an in-flight wait after the gateway reconnects", async () => {
    process.env[tokenEnvironment] = "test-token";
    let waitRequests = 0;

    class ReconnectingGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}

      start(): void {
        this.callback("onHelloOk")?.();
      }
      stop(): void {}

      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent") return { runId: "run-1" } as T;
        if (method === "agent.wait") {
          waitRequests += 1;
          if (waitRequests === 1) {
            this.callback("onClose")?.(1006, "");
            setTimeout(() => this.callback("onHelloOk")?.(), 0);
            throw new Error("gateway closed (1006):");
          }
          return { result: { payloads: [{ text: "Recovered reply" }] } } as T;
        }
        throw new Error(`Unexpected request: ${method}`);
      }

      private callback(name: string): ((...arguments_: unknown[]) => void) | undefined {
        const value = this.options[name];
        return typeof value === "function"
          ? (value as (...arguments_: unknown[]) => void)
          : undefined;
      }
    }

    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");

    const driver = new OpenClawDriver(runtime, ReconnectingGatewayClient);
    const active = await driver.start({ sessionKey: "discussion", prompt: "hello" }, () => {});

    await expect(active.result).resolves.toEqual({ text: "Recovered reply" });
    expect(waitRequests).toBe(2);
    await driver.close();
  });

  it("falls back to session history when agent.wait returns an empty payload list", async () => {
    process.env[tokenEnvironment] = "test-token";
    let historyRequests = 0;
    class EmptyPayloadGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") {
          historyRequests += 1;
          return {
            messages:
              historyRequests === 1
                ? []
                : [
                    {
                      id: "reply",
                      role: "assistant",
                      content: [{ text: "History reply" }],
                      timestamp: 2,
                    },
                  ],
          } as T;
        }
        if (method === "agent") return { runId: "empty-payload-run" } as T;
        if (method === "agent.wait") return { result: { payloads: [] } } as T;
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, EmptyPayloadGatewayClient);
    const active = await driver.start(
      { sessionKey: "discussion", prompt: "hello" },
      () => undefined,
    );
    await expect(active.result).resolves.toEqual({ text: "History reply" });
    expect(historyRequests).toBeGreaterThanOrEqual(2);
    await driver.close();
  });

  it("binds the plugin store under the canonical session key acknowledged by OpenClaw", async () => {
    process.env[tokenEnvironment] = "test-token";
    process.env[bridgeTokenEnvironment] = "test-bridge-token-that-is-long-enough";
    const store = new BridgeStore(":memory:");
    const bridge = new BridgeServer({
      host: "127.0.0.1",
      port: 0,
      token: process.env[bridgeTokenEnvironment],
      store,
      onInbound: async () => undefined,
    });
    await bridge.start();
    const address = bridge.address();
    if (!address) throw new Error("missing bridge address");
    const canonical = "agent:anya:anytype:channel:canonical";
    class CanonicalGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent")
          return { result: { runId: "canonical-run", sessionKey: canonical } } as T;
        if (method === "agent.wait") return { result: { payloads: [{ text: "done" }] } } as T;
        if (method === "sessions.abort") return { ok: true } as T;
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: {
        kind: "openclaw",
        gateway: { tokenEnv: tokenEnvironment },
        channelBridge: {
          enabled: true,
          url: `http://127.0.0.1:${address.port}`,
          tokenEnv: bridgeTokenEnvironment,
        },
      },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, CanonicalGatewayClient);
    try {
      const active = await driver.start(
        {
          sessionKey: "requested-alias",
          prompt: "hello",
          turn: {
            conversation: {
              routeId: "chat:space:chat",
              spaceId: "space",
              chatId: "chat",
              kind: "chat",
            },
            message: { id: "trigger", creator: "owner", content: { text: "hello" } },
            replyTargetId: "trigger",
          },
        },
        () => undefined,
      );
      await active.result;
      expect(active.sessionKey).toBe(canonical);
      expect(store.bindingForSession(canonical)).toEqual({
        accountId: "default",
        route: { spaceId: "space", chatId: "chat" },
      });
      expect(store.bindingForSession("requested-alias")).toBeUndefined();
    } finally {
      await driver.close();
      await bridge.stop();
      store.close();
    }
  });

  it("binds operator sessions to the native channel and restores external run output", async () => {
    process.env[tokenEnvironment] = "test-token";
    process.env[bridgeTokenEnvironment] = "test-bridge-token-that-is-long-enough";
    const bindings: unknown[] = [];
    let deliveries: any[] = [];
    const outboxQueries: URLSearchParams[] = [];
    const canonicalSessionKey = "agent:main:anytype:channel:thread";
    let failNextBatchAck = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if (path === "/health") response.end(JSON.stringify({ ok: true }));
      else if (path === "/v1/bindings") {
        bindings.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end(JSON.stringify({ ok: true }));
      } else if (path === "/v1/owned-runs") {
        response.end(JSON.stringify({ ok: true }));
      } else if (path === "/v1/outbox") {
        outboxQueries.push(requestUrl.searchParams);
        response.end(JSON.stringify({ deliveries }));
      } else if (path === "/v1/outbox/ack") {
        if (failNextBatchAck) {
          failNextBatchAck = false;
          response.statusCode = 503;
          response.end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ids: string[] };
        deliveries = deliveries.filter((delivery) => !body.ids.includes(delivery.id));
        response.end(JSON.stringify({ ok: true }));
      } else if (/^\/v1\/outbox\/[^/]+\/ack$/u.test(path)) {
        const id = decodeURIComponent(path.split("/")[3]!);
        deliveries = deliveries.filter((delivery) => delivery.id !== id);
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");

    class GatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as (() => void) | undefined)?.();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent") return { runId: "owned-run", sessionKey: canonicalSessionKey } as T;
        if (method === "agent.wait") return { result: { payloads: [{ text: "direct" }] } } as T;
        if (method === "health") return { ok: true } as T;
        throw new Error(`Unexpected request: ${method}`);
      }
    }
    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ id: "space" }],
      runtime: {
        kind: "openclaw",
        gateway: { tokenEnv: tokenEnvironment },
        channelBridge: {
          enabled: true,
          url: `http://127.0.0.1:${address.port}`,
          tokenEnv: bridgeTokenEnvironment,
          pollIntervalMilliseconds: 100,
        },
      },
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
    const driver = new OpenClawDriver(runtime, GatewayClient);
    const active = await driver.start(
      {
        sessionKey: "thread",
        prompt: "hello",
        turn: {
          conversation: {
            routeId: "chat:space:chat",
            spaceId: "space",
            chatId: "chat",
            kind: "chat",
          },
          message: { id: "trigger", creator: "owner", content: { text: "hello" } },
          replyTargetId: "trigger",
        },
      },
      () => undefined,
    );
    await active.result;
    expect(active.sessionKey).toBe(canonicalSessionKey);
    expect(bindings).toEqual([
      {
        accountId: "default",
        sessionKey: canonicalSessionKey,
        route: { spaceId: "space", chatId: "chat" },
      },
    ]);

    const outputs: string[] = [];
    const observer = await driver.observeSession(
      {
        sessionKey: canonicalSessionKey,
        conversation: {
          routeId: "chat:space:chat",
          spaceId: "space",
          chatId: "chat",
          kind: "chat",
        },
      },
      async (output) => void outputs.push(output.result.text),
    );
    expect(
      outboxQueries.some(
        (query) =>
          query.get("sessionKey") === canonicalSessionKey &&
          query.get("spaceId") === "space" &&
          query.get("chatId") === "chat",
      ),
    ).toBe(true);
    deliveries = [
      {
        id: "owned-1",
        idempotencyKey: "owned-k1",
        sessionKey: canonicalSessionKey,
        route: { spaceId: "space", chatId: "chat" },
        kind: "agent-event",
        agentEvent: {
          runId: "owned-run",
          seq: 1,
          stream: "assistant",
          timestamp: 1,
          data: { text: "direct" },
        },
      },
      {
        id: "owned-2",
        idempotencyKey: "owned-k2",
        sessionKey: canonicalSessionKey,
        route: { spaceId: "space", chatId: "chat" },
        kind: "agent-event",
        agentEvent: {
          runId: "owned-run",
          seq: 2,
          stream: "lifecycle",
          timestamp: 2,
          data: { phase: "completed" },
        },
      },
    ];
    failNextBatchAck = true;
    await expect.poll(() => deliveries).toEqual([]);
    expect(outputs).toEqual([]);
    deliveries = [
      {
        id: "d2",
        idempotencyKey: "k2",
        sessionKey: canonicalSessionKey,
        kind: "agent-event",
        agentEvent: {
          runId: "external",
          seq: 2,
          stream: "assistant",
          timestamp: 2,
          data: { delta: "reply" },
        },
      },
      {
        id: "d1",
        idempotencyKey: "k1",
        sessionKey: canonicalSessionKey,
        kind: "agent-event",
        agentEvent: {
          runId: "external",
          seq: 1,
          stream: "assistant",
          timestamp: 1,
          data: { delta: "scheduled " },
        },
      },
    ];
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outputs).toEqual([]);
    expect(deliveries).toHaveLength(2);
    await observer.close();
    const resumedObserver = await driver.observeSession(
      {
        sessionKey: canonicalSessionKey,
        conversation: {
          routeId: "chat:space:chat",
          spaceId: "space",
          chatId: "chat",
          kind: "chat",
        },
      },
      async (output) => void outputs.push(output.result.text),
    );
    deliveries.push({
      id: "d3",
      idempotencyKey: "k3",
      sessionKey: canonicalSessionKey,
      kind: "agent-event",
      agentEvent: {
        runId: "external",
        seq: 3,
        stream: "lifecycle",
        timestamp: 3,
        data: { phase: "error" },
      },
    });
    await expect.poll(() => outputs).toEqual(["scheduled reply"]);
    await expect.poll(() => deliveries).toEqual([]);
    deliveries = [
      {
        id: "twin-event-text",
        idempotencyKey: "twin-event-text-key",
        sessionKey: canonicalSessionKey,
        kind: "agent-event",
        agentEvent: {
          runId: "twin-run",
          seq: 1,
          stream: "assistant",
          timestamp: 3,
          data: { text: "one proactive result" },
        },
      },
      {
        id: "twin-event-end",
        idempotencyKey: "twin-event-end-key",
        sessionKey: canonicalSessionKey,
        kind: "agent-event",
        agentEvent: {
          runId: "twin-run",
          seq: 2,
          stream: "lifecycle",
          timestamp: 4,
          data: { phase: "completed" },
        },
      },
    ];
    await expect.poll(() => outputs).toEqual(["scheduled reply", "one proactive result"]);
    await expect.poll(() => deliveries).toEqual([]);
    deliveries = [
      {
        id: "twin-final",
        idempotencyKey: "twin-final-key",
        sessionKey: canonicalSessionKey,
        route: { spaceId: "space", chatId: "chat" },
        kind: "message-final",
        message: { text: "one proactive result" },
      },
    ];
    await expect.poll(() => deliveries).toEqual([]);
    expect(outputs).toEqual(["scheduled reply", "one proactive result"]);
    deliveries = [
      {
        id: "wrong-session",
        idempotencyKey: "wrong-session-key",
        sessionKey: "another-thread",
        route: { spaceId: "space", chatId: "chat" },
        kind: "message-final",
        message: { text: "must not route-fallback" },
      },
    ];
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outputs).toEqual(["scheduled reply", "one proactive result"]);
    expect(deliveries.map((delivery) => delivery.id)).toEqual(["wrong-session"]);
    deliveries = [
      {
        id: "route-final",
        idempotencyKey: "route-final-key",
        route: { spaceId: "space", chatId: "chat" },
        kind: "message-final",
        message: { text: "native channel output" },
      },
    ];
    await expect
      .poll(() => outputs)
      .toEqual(["scheduled reply", "one proactive result", "native channel output"]);
    await expect.poll(() => deliveries).toEqual([]);
    deliveries = [
      {
        id: "failed-only",
        idempotencyKey: "failed-only-key",
        sessionKey: canonicalSessionKey,
        route: { spaceId: "space", chatId: "chat" },
        kind: "agent-event",
        agentEvent: {
          runId: "failed-external",
          seq: 1,
          stream: "lifecycle",
          timestamp: 4,
          data: { phase: "error", text: "tool failed" },
        },
      },
    ];
    await expect
      .poll(() => outputs)
      .toEqual([
        "scheduled reply",
        "one proactive result",
        "native channel output",
        "OpenClaw external run error: tool failed",
      ]);
    await expect.poll(() => deliveries).toEqual([]);
    await resumedObserver.close();
    await driver.close();
  });
});

function bridgeTestRuntime() {
  process.env[tokenEnvironment] = "synthetic-token";
  process.env[bridgeTokenEnvironment] = "synthetic-bridge-token-that-is-long-enough";
  const runtime = configSchema.parse({
    version: 1,
    agent: { name: "Test", participantId: "bot" },
    anytype: { apiKeyFile: "/tmp/synthetic-key" },
    spaces: [{ name: "Test" }],
    runtime: {
      kind: "openclaw",
      gateway: { tokenEnv: tokenEnvironment },
      channelBridge: {
        enabled: true,
        tokenEnv: bridgeTokenEnvironment,
        pollIntervalMilliseconds: 100,
      },
    },
  }).runtime;
  if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");
  return runtime;
}

const bridgeTestConversation = {
  kind: "chat" as const,
  routeId: "chat:space:chat",
  spaceId: "space",
  chatId: "chat",
};
const bridgeTestFinal = {
  id: "final",
  idempotencyKey: "final-source",
  storeSequence: 1,
  sessionKey: "session",
  kind: "message-final",
  message: { text: "direct reply" },
};

// Use the real controller, disk Store, HTTP bridge, and process exit. Only the
// Anytype write port is synthetic; its append-only log survives child restarts.
const bridgeShutdownChild = `
import { appendFileSync } from "node:fs";
import { configSchema } from "./src/config.ts";
import { AgentController } from "./src/controller.ts";
import { Store } from "./src/store.ts";
import { OpenClawDriver } from "./src/runtime/openclaw.ts";
import { FakeAnytype } from "./test/fakes.ts";
const [mode, database, sends, url] = process.argv.slice(1);
const keepAlive = setInterval(() => undefined, 1_000);
process.env.KNOT_SHUTDOWN_TEST_TOKEN = "synthetic-bridge-token-for-shutdown-test";
const config = configSchema.parse({
  version: 1, agent: { name: "Test", participantId: "bot" },
  anytype: { apiKeyFile: "/tmp/synthetic-key" }, spaces: [{ id: "space" }],
  runtime: { kind: "openclaw", channelBridge: {
    enabled: true, url, tokenEnv: "KNOT_SHUTDOWN_TEST_TOKEN", pollIntervalMilliseconds: 100,
  } },
});
const driver = new OpenClawDriver(config.runtime);
let shuttingDown;
let signalShutdown;
const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
class Anytype extends FakeAnytype {
  async sendMessage(...args) {
    const id = await super.sendMessage(...args);
    appendFileSync(sends, id + "\\n");
    if (mode === "shutdown") {
      shuttingDown = driver.close();
      signalShutdown();
    }
    return id;
  }
}
const store = new Store(database);
if (!store.sessionBinding("thread")) store.saveSessionBinding({
  threadKey: "thread", routeId: "chat:space:chat", spaceId: "space", chatId: "chat",
  runtime: "openclaw", nativeSessionKey: "session", generation: 0, state: "active",
});
const controller = new AgentController(new Anytype(), driver, config, store, () => undefined);
try {
  await controller.restoreObserversForRoute({ kind: "chat", routeId: "chat:space:chat", spaceId: "space", chatId: "chat" });
} catch (error) {
  if (!/observer closed|acknowledgement returned HTTP 503/.test(String(error))) throw error;
}
if (mode === "shutdown") {
  await shutdownStarted;
  await shuttingDown;
}
await controller.stop();
store.close();
clearInterval(keepAlive);
// Deliberately exit here rather than allowing an un-awaited ACK to finish.
process.exit(0);
`;

describe("OpenClaw bridge process shutdown", () => {
  it.each(["final", "event"])(
    "drains a delivered %s ACK before process exit",
    async (kind) => {
      const fixture = await bridgeProcessFixture(kind);
      try {
        await fixture.run("shutdown");
        expect(fixture.pending()).toEqual([]);
        expect(await fixture.sendCount()).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    15_000,
  );

  it.each(["final", "event"])(
    "uses the persisted %s receipt after ACK failure and process restart",
    async (kind) => {
      const fixture = await bridgeProcessFixture(kind);
      try {
        fixture.rejectAck(true);
        const result = await fixture.run("shutdown");
        expect(result.stderr).toContain("openclaw_bridge_shutdown_incomplete");
        expect(result.stderr).toContain("poll_failed");
        expect(fixture.pending()).toHaveLength(1);
        expect(await fixture.sendCount()).toBe(1);
        fixture.rejectAck(false);
        await fixture.run("restart");
        expect(fixture.pending()).toEqual([]);
        expect(await fixture.sendCount()).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );
});

async function bridgeProcessFixture(kind: string) {
  const directory = await mkdtemp(join(tmpdir(), "knot-bridge-shutdown-"));
  const database = join(directory, "state.sqlite");
  const sends = join(directory, "sends.log");
  let rejectAck = false;
  let firstPollEmpty = false;
  let pending: Array<{ id: string } & Record<string, unknown>> =
    kind === "final"
      ? [bridgeTestFinal]
      : [
          {
            id: "terminal",
            idempotencyKey: "terminal-source",
            storeSequence: 1,
            sessionKey: "session",
            kind: "agent-event",
            agentEvent: {
              runId: "external",
              seq: 1,
              stream: "lifecycle",
              timestamp: 1,
              data: { phase: "error", text: "synthetic failure" },
            },
          },
        ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      // Slow enough that returning from close immediately kills the ACK socket.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (response.destroyed) return;
      if (rejectAck) {
        response.writeHead(503);
        response.end("{}");
        return;
      }
      const ids: string[] =
        url.pathname === "/v1/outbox/ack"
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ids: string[] }).ids
          : [url.pathname.split("/")[3]!];
      pending = pending.filter((delivery) => !ids.includes(delivery.id));
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ deliveries: firstPollEmpty ? [] : pending }));
    firstPollEmpty = false;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  return {
    run: async (mode: string) => {
      firstPollEmpty = mode === "shutdown";
      return await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          bridgeShutdownChild,
          mode,
          database,
          sends,
          `http://127.0.0.1:${address.port}`,
        ],
        { cwd: resolve(import.meta.dirname, ".."), timeout: 12_000 },
      );
    },
    pending: () => pending,
    rejectAck: (value: boolean) => {
      rejectAck = value;
    },
    sendCount: async () => (await readFile(sends, "utf8")).trim().split("\n").length,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("OpenClaw shutdown and acknowledgement fences", () => {
  it("closes an idle observer without waiting for another observer's output or ACK", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let pending = false;
    let finishOutput!: () => void;
    let finishAck!: (response: Response) => void;
    const outputFinished = new Promise<void>((resolve) => {
      finishOutput = resolve;
    });
    const busyOutput = vi.fn(async () => outputFinished);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, options?: RequestInit) => {
        if (options?.method === "POST") {
          options.signal?.throwIfAborted();
          return new Promise<Response>((resolve) => {
            finishAck = resolve;
          });
        }
        return Response.json({
          deliveries:
            pending && url.searchParams.get("sessionKey") === "busy"
              ? [{ ...bridgeTestFinal, sessionKey: "busy" }]
              : [],
        });
      }),
    );
    const driver = new OpenClawDriver(bridgeTestRuntime());
    const idle = await driver.observeSession(
      { sessionKey: "idle", conversation: bridgeTestConversation },
      async () => undefined,
    );
    const busy = await driver.observeSession(
      { sessionKey: "busy", conversation: bridgeTestConversation },
      busyOutput,
    );
    pending = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(busyOutput).toHaveBeenCalledTimes(1);

    let idleClosed = false;
    const idleClosing = idle.close().then(() => {
      idleClosed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(idleClosed).toBe(true);
    await idleClosing;
    expect(warnings).not.toHaveBeenCalled();

    let busyClosed = false;
    const busyClosing = busy.close().then(() => {
      busyClosed = true;
    });
    finishOutput();
    await vi.advanceTimersByTimeAsync(0);
    expect(finishAck).toBeTypeOf("function");
    expect(busyClosed).toBe(false);
    finishAck(Response.json({ ok: true }));
    await busyClosing;
    expect(busyClosed).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
    await driver.close();
  });

  it.each(["observer", "driver"])(
    "bounds %s close when onOutput never completes",
    async (target) => {
      vi.useFakeTimers();
      const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let deliveries: unknown[] = [];
      let finishOutput!: () => void;
      const outputs = vi.fn(
        async () =>
          new Promise<void>((resolve) => {
            finishOutput = resolve;
          }),
      );
      const acknowledged = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: URL, options?: RequestInit) => {
          if (options?.method === "POST") {
            options.signal?.throwIfAborted();
            acknowledged();
            return Response.json({ ok: true });
          }
          return Response.json({ deliveries });
        }),
      );
      const driver = new OpenClawDriver(bridgeTestRuntime());
      const observer = await driver.observeSession(
        { sessionKey: "session", conversation: bridgeTestConversation },
        outputs,
      );
      deliveries = [bridgeTestFinal];
      await vi.advanceTimersByTimeAsync(100);
      expect(outputs).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = (target === "observer" ? observer.close() : driver.close()).then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
      expect(
        warnings.mock.calls.some(([line]) =>
          String(line).includes("openclaw_bridge_shutdown_incomplete"),
        ),
      ).toBe(true);
      expect(acknowledged).not.toHaveBeenCalled();
      expect(deliveries).toHaveLength(1);
      // A callback that settles after the deadline cannot initiate a late ACK.
      finishOutput();
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledged).not.toHaveBeenCalled();
      await driver.close();
    },
  );

  it.each([
    ["observer", "final"],
    ["observer", "event"],
    ["driver", "final"],
    ["driver", "event"],
  ])("acknowledges a delivered %s-close %s after onOutput finishes", async (target, kind) => {
    vi.useFakeTimers();
    let deliveries: Array<{ id: string }> = [];
    let finishOutput!: () => void;
    const outputFinished = new Promise<void>((resolve) => {
      finishOutput = resolve;
    });
    const outputs = vi.fn(async () => outputFinished);
    const acknowledged: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, options?: RequestInit) => {
        if (options?.method === "POST") {
          // A real fetch rejects an already-aborted observer signal.
          options.signal?.throwIfAborted();
          const ids: string[] =
            url.pathname === "/v1/outbox/ack"
              ? (JSON.parse(String(options.body)) as { ids: string[] }).ids
              : [url.pathname.split("/")[3]!];
          acknowledged.push(...ids);
          deliveries = deliveries.filter((delivery) => !ids.includes(delivery.id));
          return Response.json({ ok: true });
        }
        return Response.json({ deliveries });
      }),
    );
    const runtime = bridgeTestRuntime();
    const driver = new OpenClawDriver(runtime);
    const observer = await driver.observeSession(
      { sessionKey: "session", conversation: bridgeTestConversation },
      outputs,
    );
    const eventDeliveries = [
      {
        id: "text-event",
        idempotencyKey: "text-source",
        storeSequence: 1,
        sessionKey: "session",
        kind: "agent-event",
        agentEvent: {
          runId: "external-run",
          seq: 1,
          stream: "assistant",
          timestamp: 1,
          data: { text: "external reply" },
        },
      },
      {
        id: "terminal-event",
        idempotencyKey: "terminal-source",
        storeSequence: 2,
        sessionKey: "session",
        kind: "agent-event",
        agentEvent: {
          runId: "external-run",
          seq: 2,
          stream: "lifecycle",
          timestamp: 2,
          data: { phase: "completed" },
        },
      },
    ];
    deliveries = kind === "final" ? [bridgeTestFinal] : eventDeliveries;
    const expectedIds = deliveries.map((delivery) => delivery.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(outputs).toHaveBeenCalledTimes(1);
    const closing = target === "observer" ? observer.close() : driver.close();
    expect(acknowledged).toEqual([]);
    finishOutput();
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(acknowledged).toEqual(expectedIds);
    expect(deliveries).toEqual([]);

    const replacement = target === "observer" ? driver : new OpenClawDriver(runtime);
    const replayed = vi.fn(async () => undefined);
    await replacement.observeSession(
      { sessionKey: "session", conversation: bridgeTestConversation },
      replayed,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(replayed).not.toHaveBeenCalled();
    await replacement.close();
  });

  it.each(["observer", "driver"])(
    "does not emit or acknowledge an in-flight bridge response after %s close",
    async (target) => {
      vi.useFakeTimers();
      let held = false;
      let release!: (response: Response) => void;
      const outputs = vi.fn(async () => undefined);
      const acks = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, options?: RequestInit) => {
          if (options?.method === "POST") {
            acks();
            return Response.json({ ok: true });
          }
          if (!held) return Response.json({ deliveries: [] });
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }),
      );
      const driver = new OpenClawDriver(bridgeTestRuntime());
      const observer = await driver.observeSession(
        { sessionKey: "session", conversation: bridgeTestConversation },
        outputs,
      );
      held = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(release).toBeTypeOf("function");
      const closing = target === "observer" ? observer.close() : driver.close();
      // Deliberately emulate a transport that completes despite cancellation.
      release(Response.json({ deliveries: [bridgeTestFinal] }));
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      expect(outputs).not.toHaveBeenCalled();
      expect(acks).not.toHaveBeenCalled();
      await driver.close();
    },
  );

  it("rejects an initial connection on close and ignores its late hello", async () => {
    let options!: Record<string, unknown>;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stop = vi.fn();
    const request = vi.fn(async () => ({ models: [] }));
    class PendingGateway {
      constructor(value: Record<string, unknown>) {
        options = value;
      }
      start(): void {
        markStarted();
      }
      stop(): void {
        stop();
      }
      async request<T>(): Promise<T> {
        return (await request()) as T;
      }
    }
    const driver = new OpenClawDriver(bridgeTestRuntime(), PendingGateway);
    const rejected = expect(driver.configureModel({ sessionKey: "session" })).rejects.toThrow(
      "driver closed",
    );
    await started;
    await driver.close();
    (options.onHelloOk as () => void)();
    await rejected;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    await expect(driver.configureModel({ sessionKey: "session" })).rejects.toThrow("driver closed");
  });

  it("keeps an owned final suppressed when its acknowledgement must retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let deliveries: unknown[] = [];
    let ackAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, options?: RequestInit) => {
        if (url.pathname === "/v1/outbox/final/ack") {
          ackAttempts++;
          if (ackAttempts === 1) return new Response("{}", { status: 503 });
          deliveries = [];
          return Response.json({ ok: true });
        }
        if (options?.method === "POST") return Response.json({ ok: true });
        return Response.json({ deliveries });
      }),
    );
    class Gateway {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void {
        (this.options.onHelloOk as () => void)();
      }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent") return { runId: "owned-run", sessionKey: "session" } as T;
        if (method === "agent.wait") return { result: { text: "direct reply" } } as T;
        throw new Error(`Unexpected request ${method}`);
      }
    }
    const driver = new OpenClawDriver(bridgeTestRuntime(), Gateway);
    const active = await driver.start(
      {
        sessionKey: "session",
        prompt: "hello",
        turn: {
          conversation: bridgeTestConversation,
          message: { id: "trigger", creator: "owner", content: { text: "hello" } },
          replyTargetId: "trigger",
        },
      },
      () => undefined,
    );
    await expect(active.result).resolves.toMatchObject({ text: "direct reply" });
    const outputs = vi.fn(async () => undefined);
    await driver.observeSession(
      { sessionKey: "session", conversation: bridgeTestConversation },
      outputs,
    );
    deliveries = [bridgeTestFinal];
    await vi.advanceTimersByTimeAsync(100);
    expect(ackAttempts).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(outputs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(ackAttempts).toBe(2);
    expect(deliveries).toEqual([]);
    expect(outputs).not.toHaveBeenCalled();
    await driver.close();
  });
});
