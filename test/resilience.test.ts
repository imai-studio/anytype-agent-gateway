import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { CodexAcpDriver } from "../src/runtime/codex-acp.js";
import { Store } from "../src/store.js";
import type { HeartDiscussionAdapter } from "../src/discussions.js";
import { FakeAnytype, FakeRuntime } from "./fakes.js";

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
