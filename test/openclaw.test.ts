import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { OpenClawDriver } from "../src/runtime/openclaw.js";

const tokenEnvironment = "AAG_TEST_OPENCLAW_TOKEN";

afterEach(() => { delete process.env[tokenEnvironment]; });

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
});
