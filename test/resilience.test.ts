import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { CodexAcpDriver } from "../src/runtime/codex-acp.js";
import { Store } from "../src/store.js";
import type { HeartDiscussionAdapter } from "../src/discussions.js";
import type {
  ActiveRuntime,
  AnytypeEvent,
  ChatMessage,
  RuntimeDriver,
  RuntimeSessionObserver,
  RuntimeSessionOutput,
} from "../src/types.js";
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
      async close(): Promise<void> {
        this.closed = true;
      }
    }
    const anytype = new FailingAnytype();
    const runtime = new ClosingRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: ["First", "Second"].map((name) => ({
        name,
        chats: [
          { name: "chat", wake: { humans: "mention", agents: "never", allowedUsers: ["human"] } },
        ],
      })),
      runtime: { kind: "openclaw" },
    });
    const store = new Store(":memory:");
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      () => undefined,
    );
    await expect(gateway.start()).rejects.toThrow("second space failed");
    expect(runtime.closed).toBe(true);
    store.close();
  });

  it("discovers a new chat, enrolls it for an authorized tag, and catches that message", async () => {
    class DiscoveringAnytype extends FakeAnytype {
      listCalls = 0;
      override async listChats(): Promise<Array<{ id: string; name: string }>> {
        this.listCalls += 1;
        return this.listCalls === 1
          ? [{ id: "existing", name: "Existing" }]
          : [
              { id: "existing", name: "Existing" },
              { id: "new-chat", name: "New chat" },
            ];
      }
      override async listMessages(
        _spaceId: string,
        chatId: string,
        limit: number,
        afterOrderId?: string,
      ): Promise<ChatMessage[]> {
        if (chatId !== "new-chat") return [];
        const values = afterOrderId
          ? this.messages.filter((message) => message.order_id && message.order_id > afterOrderId)
          : this.messages;
        return values.slice(-limit);
      }
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    const anytype = new DiscoveringAnytype();
    anytype.messages.push(
      incoming({ id: "agent-tag", order_id: "000", creator: "peer" }),
      incoming({ id: "unauthorized-tag", order_id: "001", creator: "outsider" }),
      incoming({ id: "first-tag", order_id: "002" }),
    );
    const runtime = new FakeRuntime();
    const enrollments: Array<{
      spaceId: string;
      spaceName: string;
      chatId: string;
      chatName: string;
      allowedUsers: string[];
    }> = [];
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          name: "Test",
          chatDiscovery: {
            enabled: true,
            autoEnroll: true,
            discoveryIntervalSeconds: 10,
            wake: {
              humans: "mention-or-reply",
              agents: "never",
              allowedUsers: ["peer"],
            },
          },
        },
      ],
      runtime: { kind: "openclaw" },
      coordination: { agentParticipants: ["peer"] },
    });
    config.spaces[0]!.chatDiscovery.discoveryIntervalSeconds = 0.01;
    const store = new Store(":memory:");
    store.setWakeOverride("chat:space:new-chat", "mention-or-reply", undefined, [
      "human-1",
      "peer",
    ]);
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      () => undefined,
      undefined,
      async (spaceId, spaceName, chatId, chatName, discoveredWake) => {
        enrollments.push({
          spaceId,
          spaceName,
          chatId,
          chatName,
          allowedUsers: discoveredWake.allowedUsers,
        });
        return "enrolled";
      },
    );
    const running = gateway.start();
    await eventually(() => expect(enrollments).toHaveLength(1));
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.sessionKey).toBe("aag:chat:space:new-chat");
    expect(enrollments).toEqual([
      {
        spaceId: "space",
        spaceName: "Space",
        chatId: "new-chat",
        chatName: "New chat",
        allowedUsers: ["human-1", "peer"],
      },
    ]);
    gateway.stop();
    await running;
    store.close();
  });

  it("does not auto-enroll a chat for a sender revoked by a live access override", async () => {
    class DiscoveringAnytype extends FakeAnytype {
      listCalls = 0;
      override async listChats(): Promise<Array<{ id: string; name: string }>> {
        this.listCalls += 1;
        return this.listCalls === 1
          ? [{ id: "existing", name: "Existing" }]
          : [
              { id: "existing", name: "Existing" },
              { id: "new-chat", name: "New chat" },
            ];
      }
      override async listMessages(
        _spaceId: string,
        chatId: string,
        limit: number,
        afterOrderId?: string,
      ): Promise<ChatMessage[]> {
        if (chatId !== "new-chat") return [];
        const values = afterOrderId
          ? this.messages.filter((message) => message.order_id && message.order_id > afterOrderId)
          : this.messages;
        return values.slice(-limit);
      }
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    const anytype = new DiscoveringAnytype();
    anytype.messages.push(incoming({ id: "revoked-tag", order_id: "001" }));
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          name: "Test",
          chatDiscovery: {
            enabled: true,
            autoEnroll: true,
            discoveryIntervalSeconds: 10,
            wake: {
              humans: "mention",
              agents: "never",
              allowedUsers: ["human-1"],
            },
          },
        },
      ],
      runtime: { kind: "openclaw" },
    });
    config.spaces[0]!.chatDiscovery.discoveryIntervalSeconds = 0.01;
    const store = new Store(":memory:");
    store.setWakeOverride("chat:space:new-chat", "mention", undefined, ["someone-else"]);
    let enrollments = 0;
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
      undefined,
      async () => {
        enrollments += 1;
        return "enrolled";
      },
    );

    const running = gateway.start();
    await eventually(() =>
      expect(logs).toContainEqual({
        event: "message_ignored",
        fields: expect.objectContaining({ messageId: "revoked-tag", reason: "unauthorized" }),
      }),
    );
    expect(enrollments).toBe(0);
    expect(runtime.starts).toHaveLength(0);
    gateway.stop();
    await running;
    store.close();
  });

  it("discovers a newly created discussion and catches the tag that created it", async () => {
    class DiscussingAnytype extends FakeAnytype {
      sentTo: Array<{ chatId: string; replyTo?: string }> = [];
      override async searchObjects(): Promise<Array<{ id: string; name?: string; type?: string }>> {
        return [{ id: "todo", name: "Payments testing", type: "issue" }];
      }
      override async listMessages(
        _spaceId: string,
        chatId: string,
        limit: number,
        afterOrderId?: string,
      ): Promise<ChatMessage[]> {
        if (chatId !== "discussion") return [];
        const values = afterOrderId
          ? this.messages.filter((message) => message.order_id && message.order_id > afterOrderId)
          : this.messages;
        return values.slice(-limit);
      }
      override async sendMessage(
        spaceId: string,
        chatId: string,
        input: { text: string; replyTo?: string },
      ): Promise<string> {
        this.sentTo.push({ chatId, ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
        return super.sendMessage(spaceId, chatId, input);
      }
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    class AppearingDiscussionAdapter {
      calls = 0;
      sentTo: Array<{ chatId: string; replyTo?: string }> = [];
      async resolve(): Promise<Array<{ objectId: string; discussionId?: string }>> {
        this.calls += 1;
        return this.calls === 1
          ? [{ objectId: "todo" }]
          : [{ objectId: "todo", discussionId: "discussion" }];
      }
      async hydrateMessages(_chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
        return messages.map((message) => ({
          ...message,
          content: {
            text: "Anya can u see this note?",
            marks: [{ type: "mention", param: "heart-identity" }],
          },
          mentioned: true,
        }));
      }
      async sendMessage(
        chatId: string,
        input: { text: string; replyTo?: string },
      ): Promise<string> {
        this.sentTo.push({ chatId, ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
        return "heart-reply";
      }
      async editMessage(): Promise<void> {}
      async deleteMessage(): Promise<void> {}
    }
    const anytype = new DiscussingAnytype();
    anytype.messages.push(
      incoming({ id: "first-discussion-tag", order_id: "001", content: { text: "" } }),
    );
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          name: "Test",
          comments: {
            mode: "all",
            discoveryIntervalSeconds: 10,
            createMissing: false,
            wake: { humans: "mention-or-reply", agents: "direct-mention", allowedUsers: ["*"] },
          },
        },
      ],
      runtime: { kind: "openclaw" },
    });
    config.spaces[0]!.comments.discoveryIntervalSeconds = 0.01;
    const store = new Store(":memory:");
    const adapter = new AppearingDiscussionAdapter();
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      adapter as unknown as HeartDiscussionAdapter,
      () => undefined,
    );
    const running = gateway.start();
    await eventually(() => expect(runtime.starts).toHaveLength(1));
    expect(runtime.starts[0]?.sessionKey).toBe(
      "aag:discussion:space:discussion:root:first-discussion-tag",
    );
    expect(runtime.starts[0]?.prompt).toContain("Anya can u see this note?");
    expect(adapter.sentTo).toContainEqual({
      chatId: "discussion",
      replyTo: "first-discussion-tag",
    });
    gateway.stop();
    await running;
    store.close();
  });

  it("skips one failed discussion object while keeping successful routes online", async () => {
    class MixedDiscussionAnytype extends FakeAnytype {
      override async searchObjects(): Promise<Array<{ id: string; name?: string; type?: string }>> {
        return [
          { id: "broken", name: "Broken" },
          { id: "healthy", name: "Healthy" },
        ];
      }
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    class MixedDiscussionAdapter {
      async resolve(
        _spaceId: string,
        objects: Array<{ id: string }>,
      ): Promise<Array<{ objectId: string; discussionId?: string; error?: string }>> {
        return objects.map((object) =>
          object.id === "broken"
            ? { objectId: object.id, error: "object has no discussion relation" }
            : { objectId: object.id, discussionId: "healthy-discussion" },
        );
      }
      async hydrateMessages(_chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
        return messages;
      }
    }
    const anytype = new MixedDiscussionAnytype();
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          id: "space",
          comments: {
            mode: "all",
            discoveryIntervalSeconds: 10,
            wake: { humans: "mention", agents: "never", allowedUsers: ["human-1"] },
          },
        },
      ],
      runtime: { kind: "openclaw" },
    });
    config.spaces[0]!.comments.discoveryIntervalSeconds = 0.01;
    const store = new Store(":memory:");
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      new MixedDiscussionAdapter() as unknown as HeartDiscussionAdapter,
      (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
    );
    const running = gateway.start();
    await eventually(() =>
      expect(store.listDiscussions("space")).toContainEqual({
        objectId: "healthy",
        discussionId: "healthy-discussion",
        objectName: "Healthy",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "discussion_resolution_failed",
        fields: expect.objectContaining({ objectId: "broken" }),
      }),
    );
    gateway.stop();
    await running;
    store.close();
  });

  it("restores a native observer before reconciling an interrupted observable run", async () => {
    class WaitingAnytype extends FakeAnytype {
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield { type: "unreachable" };
      }
    }
    class ObservableRuntime implements RuntimeDriver {
      readonly name = "openclaw";
      readonly projectEnforcement = "enforced" as const;
      readonly capabilities = {
        steering: true,
        thinking: true,
        multipleOutputParts: true,
        sessionObservation: true,
        nativeScheduling: true,
        modelSelection: false,
      } as const;
      output: ((value: RuntimeSessionOutput) => Promise<void>) | undefined;
      async doctor(): Promise<string[]> {
        return [];
      }
      async start(): Promise<ActiveRuntime> {
        throw new Error("A new run should not start during recovery");
      }
      async observeSession(
        _input: { sessionKey: string },
        onOutput: (output: RuntimeSessionOutput) => Promise<void>,
      ): Promise<RuntimeSessionObserver> {
        this.output = onOutput;
        return { close: async () => undefined };
      }
    }
    const anytype = new WaitingAnytype();
    const trigger = incoming({ id: "trigger" });
    const response: ChatMessage = {
      id: "response",
      creator: "bot",
      reply_to_message_id: "trigger",
      content: { text: "Working…" },
    };
    anytype.messages.push(trigger, response);
    const runtime = new ObservableRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          id: "space",
          chats: [
            { id: "chat", wake: { humans: "mention", agents: "never", allowedUsers: ["human-1"] } },
          ],
        },
      ],
      runtime: { kind: "openclaw" },
    });
    const store = new Store(":memory:");
    store.createRun({
      id: "interrupted",
      routeId: "chat:space:chat",
      threadKey: "chat:space:chat",
      triggerId: "trigger",
      responseId: "response",
      hop: 0,
    });
    store.saveSessionBinding({
      threadKey: "chat:space:chat",
      routeId: "chat:space:chat",
      spaceId: "space",
      chatId: "chat",
      runtime: "openclaw",
      nativeSessionKey: "aag:chat:space:chat",
      generation: 0,
      state: "active",
    });
    const logs: string[] = [];
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      (event) => logs.push(event),
    );
    const running = gateway.start();
    await eventually(() => expect(runtime.output).toBeDefined());
    expect(logs).toContain("run_reconcile_deferred");
    expect(store.runningRuns("chat:space:chat")).toHaveLength(1);

    await runtime.output!({
      id: "terminal-event",
      cursor: "cursor-1",
      events: [{ type: "text-delta", text: "Recovered final" }],
      result: { text: "Recovered final" },
    });
    await eventually(() =>
      expect(anytype.messages.find((message) => message.id === "response")?.content?.text).toBe(
        "Recovered final",
      ),
    );
    expect(store.runningRuns("chat:space:chat")).toEqual([]);
    expect(anytype.reactions).toContainEqual({ id: "trigger", emoji: "👀", present: false });
    gateway.stop();
    await running;
    store.close();
  });

  it("does not steer historical message-added events replayed after catchup", async () => {
    const old = incoming({ id: "old", order_id: "001" });
    const latest = incoming({
      id: "latest",
      order_id: "002",
      content: { text: "@AAG newest", marks: [{ type: "mention", param: "bot" }] },
    });
    class ReplayingAnytype extends FakeAnytype {
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        yield { type: "message_added", payload: { message: old } };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    }
    const anytype = new ReplayingAnytype();
    anytype.messages.push(old, latest);
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          name: "Test",
          chats: [
            {
              name: "Chat",
              wake: {
                humans: "mention-or-reply",
                agents: "direct-mention",
                allowedUsers: ["human-1"],
              },
            },
          ],
        },
      ],
      runtime: { kind: "openclaw" },
    });
    const store = new Store(":memory:");
    store.initialize("chat:space:chat", "001");
    store.markHandled("chat:space:chat", "old", old.created_at);
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      () => undefined,
    );
    const running = gateway.start();
    await eventually(() => expect(runtime.starts).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.steers).toEqual([]);
    gateway.stop();
    await running;
    store.close();
  });

  it("does not compare opaque Anytype order IDs lexically before processing a stream event", async () => {
    const message = incoming({ id: "fractional", order_id: "!!00" });
    class FractionalOrderAnytype extends FakeAnytype {
      streamed = false;
      override async *stream(
        _spaceId: string,
        _chatId: string,
        signal: AbortSignal,
      ): AsyncIterable<AnytypeEvent> {
        if (!this.streamed) {
          this.streamed = true;
          yield { type: "message_added", payload: { message } };
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    }
    const anytype = new FractionalOrderAnytype();
    const runtime = new FakeRuntime();
    const config = configSchema.parse({
      version: 1,
      agent: { name: "AAG", participantId: "bot" },
      anytype: { apiKeyFile: "/tmp/key" },
      spaces: [
        {
          name: "Test",
          chats: [
            {
              name: "Chat",
              wake: { humans: "mention", agents: "never", allowedUsers: ["human-1"] },
            },
          ],
        },
      ],
      runtime: { kind: "openclaw" },
    });
    const store = new Store(":memory:");
    store.initialize("chat:space:chat", "zzzz");
    const gateway = new Gateway(
      anytype,
      runtime,
      config,
      store,
      {} as HeartDiscussionAdapter,
      () => undefined,
    );
    const running = gateway.start();
    await eventually(() => expect(runtime.starts).toHaveLength(1));
    gateway.stop();
    await running;
    store.close();
  });

  it("contains a Codex ACP spawn failure without an unhandled rejection", async () => {
    const driver = new CodexAcpDriver({
      kind: "codex",
      command: "/definitely/missing/codex-acp",
      args: [],
      allowedProjects: [],
      environment: {},
      timeoutSeconds: 2,
      permissions: "deny",
    });
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", listener);
    try {
      await expect(
        driver.start({ sessionKey: "failure", prompt: "hello" }, () => undefined),
      ).rejects.toBeDefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw last;
}
