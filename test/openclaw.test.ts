import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { configSchema } from "../src/config.js";
import { OpenClawDriver } from "../src/runtime/openclaw.js";

const tokenEnvironment = "AAG_TEST_OPENCLAW_TOKEN";
const bridgeTokenEnvironment = "AAG_TEST_OPENCLAW_BRIDGE_TOKEN";
const servers: Server[] = [];

afterEach(async () => {
  delete process.env[tokenEnvironment];
  delete process.env[bridgeTokenEnvironment];
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("OpenClaw gateway recovery", () => {
  it("resumes an in-flight wait after the gateway reconnects", async () => {
    process.env[tokenEnvironment] = "test-token";
    let waitRequests = 0;

    class ReconnectingGatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}

      start(): void { this.callback("onHelloOk")?.(); }
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
        return typeof value === "function" ? value as (...arguments_: unknown[]) => void : undefined;
      }
    }

    const runtime = configSchema.parse({
      version: 1,
      agent: { name: "Anya", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test" }],
      runtime: { kind: "openclaw", gateway: { tokenEnv: tokenEnvironment } }
    }).runtime;
    if (runtime.kind !== "openclaw") throw new Error("Expected OpenClaw runtime");

    const driver = new OpenClawDriver(runtime, ReconnectingGatewayClient);
    const active = await driver.start({ sessionKey: "discussion", prompt: "hello" }, () => {});

    await expect(active.result).resolves.toEqual({ text: "Recovered reply" });
    expect(waitRequests).toBe(2);
    await driver.close();
  });

  it("binds operator sessions to the native channel and restores external run output", async () => {
    process.env[tokenEnvironment] = "test-token";
    process.env[bridgeTokenEnvironment] = "test-bridge-token-that-is-long-enough";
    const bindings: unknown[] = [];
    let deliveries: any[] = [];
    let failNextBatchAck = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/health") response.end(JSON.stringify({ ok: true }));
      else if (path === "/v1/bindings") {
        bindings.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end(JSON.stringify({ ok: true }));
      } else if (path === "/v1/owned-runs") {
        response.end(JSON.stringify({ ok: true }));
      } else if (path === "/v1/outbox") response.end(JSON.stringify({ deliveries }));
      else if (path === "/v1/outbox/ack") {
        if (failNextBatchAck) { failNextBatchAck = false; response.statusCode = 503; response.end(); return; }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ids: string[] };
        deliveries = deliveries.filter(delivery => !body.ids.includes(delivery.id));
        response.end(JSON.stringify({ ok: true }));
      }
      else if (/^\/v1\/outbox\/[^/]+\/ack$/u.test(path)) {
        const id = decodeURIComponent(path.split("/")[3]!);
        deliveries = deliveries.filter(delivery => delivery.id !== id);
        response.end(JSON.stringify({ ok: true }));
      } else { response.statusCode = 404; response.end(); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");

    class GatewayClient {
      constructor(private readonly options: Record<string, unknown>) {}
      start(): void { (this.options.onHelloOk as (() => void) | undefined)?.(); }
      stop(): void {}
      async request<T>(method: string): Promise<T> {
        if (method === "chat.history") return { messages: [] } as T;
        if (method === "agent") return { runId: "owned-run" } as T;
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
    const active = await driver.start({
      sessionKey: "thread",
      prompt: "hello",
      turn: {
        conversation: { routeId: "chat:space:chat", spaceId: "space", chatId: "chat", kind: "chat" },
        message: { id: "trigger", creator: "owner", content: { text: "hello" } },
        replyTargetId: "trigger",
      },
    }, () => undefined);
    await active.result;
    expect(bindings).toEqual([{ accountId: "default", sessionKey: "thread", route: { spaceId: "space", chatId: "chat" } }]);

    const outputs: string[] = [];
    const observer = await driver.observeSession({ sessionKey: "thread", conversation: { routeId: "chat:space:chat", spaceId: "space", chatId: "chat", kind: "chat" } }, async output => void outputs.push(output.result.text));
    deliveries = [
      { id: "owned-1", idempotencyKey: "owned-k1", sessionKey: "thread", route: { spaceId: "space", chatId: "chat" }, kind: "agent-event", agentEvent: { runId: "owned-run", seq: 1, stream: "assistant", timestamp: 1, data: { text: "direct" } } },
      { id: "owned-2", idempotencyKey: "owned-k2", sessionKey: "thread", route: { spaceId: "space", chatId: "chat" }, kind: "agent-event", agentEvent: { runId: "owned-run", seq: 2, stream: "lifecycle", timestamp: 2, data: { phase: "completed" } } },
    ];
    failNextBatchAck = true;
    await expect.poll(() => deliveries).toEqual([]);
    expect(outputs).toEqual([]);
    deliveries = [
      { id: "d2", idempotencyKey: "k2", sessionKey: "thread", kind: "agent-event", agentEvent: { runId: "external", seq: 2, stream: "assistant", timestamp: 2, data: { delta: "reply" } } },
      { id: "d1", idempotencyKey: "k1", sessionKey: "thread", kind: "agent-event", agentEvent: { runId: "external", seq: 1, stream: "assistant", timestamp: 1, data: { delta: "scheduled " } } },
    ];
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(outputs).toEqual([]);
    expect(deliveries).toHaveLength(2);
    await observer.close();
    const resumedObserver = await driver.observeSession({ sessionKey: "thread", conversation: { routeId: "chat:space:chat", spaceId: "space", chatId: "chat", kind: "chat" } }, async output => void outputs.push(output.result.text));
    deliveries.push({ id: "d3", idempotencyKey: "k3", sessionKey: "thread", kind: "agent-event", agentEvent: { runId: "external", seq: 3, stream: "lifecycle", timestamp: 3, data: { phase: "error" } } });
    await expect.poll(() => outputs).toEqual(["scheduled reply"]);
    await expect.poll(() => deliveries).toEqual([]);
    deliveries = [
      { id: "route-final", idempotencyKey: "route-final-key", route: { spaceId: "space", chatId: "chat" }, kind: "message-final", message: { text: "native channel output" } },
    ];
    await expect.poll(() => outputs).toEqual(["scheduled reply", "native channel output"]);
    await expect.poll(() => deliveries).toEqual([]);
    deliveries = [
      { id: "failed-only", idempotencyKey: "failed-only-key", sessionKey: "thread", route: { spaceId: "space", chatId: "chat" }, kind: "agent-event", agentEvent: { runId: "failed-external", seq: 1, stream: "lifecycle", timestamp: 4, data: { phase: "error", text: "tool failed" } } },
    ];
    await expect.poll(() => outputs).toEqual(["scheduled reply", "native channel output", "OpenClaw external run error: tool failed"]);
    await expect.poll(() => deliveries).toEqual([]);
    await resumedObserver.close();
    await driver.close();
  });
});
