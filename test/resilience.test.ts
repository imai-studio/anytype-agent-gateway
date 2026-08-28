import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { CodexAcpDriver } from "../src/runtime/codex-acp.js";
import { Store } from "../src/store.js";
import type { HeartDiscussionAdapter } from "../src/discussions.js";
import type { AnytypeEvent, ChatMessage } from "../src/types.js";
import { FakeAnytype, FakeRuntime, incoming } from "./fakes.js";

describe("failure containment", () => {
  it("treats a legacy handled row without a version as handled", () => {
    const store = new Store(":memory:");
    store.markHandled("route", "message");
    expect(store.isHandled("route", "message", 100)).toBe(true);
    store.close();
  });

  it("recognizes a same-timestamp content edit as a new message revision", () => {
    const store = new Store(":memory:");
    store.markHandled("route", "message", 100, "placeholder");
    expect(store.isHandled("route", "message", 100, "placeholder")).toBe(true);
    expect(store.isHandled("route", "message", 100, "final-with-mention")).toBe(false);
    store.markHandled("route", "message", 100, "final-with-mention");
    expect(store.isHandled("route", "message", 100, "final-with-mention")).toBe(true);
    store.close();
  });

  it("ignores an older content revision delivered after a newer one", () => {
    const store = new Store(":memory:");
    store.markHandled("route", "message", 200, "newer");
    expect(store.isHandled("route", "message", 100, "older")).toBe(true);
    store.close();
  });

  it("stops already-started route tasks when later route resolution fails", async () => {
    class FailingAnytype extends FakeAnytype {
      calls = 0;
      override async resolveSpace(): Promise<{ id: string; name: string }> {
        this.calls += 1;
        if (this.calls === 2) throw new Error("second space failed");
        return { id: "space-1", name: "First" };
      }
    }
    class ClosingRuntime extends FakeRuntime {
      closed = false;
      async close(): Promise<void> { this.closed = true; }
    }
    const anytype = new FailingAnytype();
    const runtime = new ClosingRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: ["First", "Second"].map(name => ({ name, chats: [{ name: "chat", wake: { humans: "mention", agents: "never", allowedUsers: ["human"] } }] })),
      runtime: { kind: "openclaw" }
    });
    const store = new Store(":memory:");
    const gateway = new Gateway(anytype, runtime, config, store, {} as HeartDiscussionAdapter, () => undefined);
    await expect(gateway.start()).rejects.toThrow("second space failed");
    expect(runtime.closed).toBe(true);
    store.close();
  });

  it("discovers a new chat and catches its first tagged message", async () => {
    class DiscoveringAnytype extends FakeAnytype {
      listCalls = 0;
      override async listChats(): Promise<Array<{ id: string; name: string }>> {
        this.listCalls += 1;
        return this.listCalls === 1 ? [{ id: "existing", name: "Existing" }] : [{ id: "existing", name: "Existing" }, { id: "new-chat", name: "New chat" }];
      }
      override async listMessages(_spaceId: string, chatId: string, limit: number, afterOrderId?: string): Promise<ChatMessage[]> {
        if (chatId !== "new-chat") return [];
        const values = afterOrderId ? this.messages.filter(message => message.order_id && message.order_id > afterOrderId) : this.messages;
        return values.slice(-limit);
      }
      override async *stream(_spaceId: string, _chatId: string, signal: AbortSignal): AsyncIterable<AnytypeEvent> {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    const anytype = new DiscoveringAnytype();
    anytype.messages.push(incoming({ id: "first-tag", order_id: "001" }));
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [{ name: "Test", chatDiscovery: { enabled: true, discoveryIntervalSeconds: 10, wake: { humans: "mention-or-reply", agents: "direct-mention", allowedUsers: ["human-1"] } } }],
      runtime: { kind: "openclaw" }
    });
    config.spaces[0]!.chatDiscovery.discoveryIntervalSeconds = 0.01;
    const store = new Store(":memory:");
    const gateway = new Gateway(anytype, runtime, config, store, {} as HeartDiscussionAdapter, () => undefined);
    const running = gateway.start();
    await eventually(() => expect(runtime.starts).toHaveLength(1));
    expect(runtime.starts[0]?.sessionKey).toBe("aag:chat:space:new-chat");
    gateway.stop();
    await running;
    store.close();
  });

  it("contains a Codex ACP spawn failure without an unhandled rejection", async () => {
    const driver = new CodexAcpDriver({ kind: "codex", command: "/definitely/missing/codex-acp", args: [], allowedProjects: [], environment: {}, timeoutSeconds: 2, permissions: "deny" });
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      await expect(driver.start({ sessionKey: "failure", prompt: "hello" }, () => undefined)).rejects.toBeDefined();
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", listener); }
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { assertion(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw last;
}
