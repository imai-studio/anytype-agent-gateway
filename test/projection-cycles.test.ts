import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { RunProjection } from "../src/projection.js";
import type { ConversationRef, TextMark } from "../src/types.js";
import { FakeAnytype } from "./fakes.js";

const conversation: ConversationRef = {
  routeId: "chat:space:chat",
  spaceId: "space",
  chatId: "chat",
  kind: "chat",
};

function config(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    version: 1,
    agent: { name: "AAG", participantId: "bot" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ name: "Test" }],
    runtime: { kind: "openclaw" },
    responses: { thinking: "stream" },
    ...overrides,
  });
}

async function flushProjection(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
}

describe("output-cycle projection", () => {
  it("replaces transient thinking with the following answer in the same message", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");

      projection.onEvent({ type: "thinking-delta", text: "Inspecting", partId: "thought-1" });
      projection.onEvent({ type: "thinking-delta", text: " files", partId: "thought-1" });
      await flushProjection();
      expect(anytype.messages).toHaveLength(1);
      expect(anytype.messages[0]?.content?.text).toBe("Working…\n\n• Inspecting files");

      projection.onEvent({ type: "text-delta", text: "Found", partId: "answer-1" });
      projection.onEvent({ type: "text-delta", text: " it.", partId: "answer-1" });
      await flushProjection();
      expect(anytype.messages).toHaveLength(1);
      expect(anytype.messages[0]?.content?.text).toBe("Found it.");

      await projection.finish({ text: "Found it." });
      expect(anytype.messages[0]?.content?.text).toBe("Found it.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders thinking and tool activity as a compact native activity feed", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(
        anytype,
        config({ responses: { thinking: "stream", mode: "milestones" } }),
        conversation,
        "trigger",
      );

      projection.onEvent({
        type: "thinking-delta",
        text: "**Investigating Codex session logs**\n\n### Planning the next check",
        partId: "thought-1",
      });
      projection.onEvent({ type: "tool", name: "Inspecting user prompts", status: "running" });
      projection.onEvent({ type: "tool", name: "Inspecting user prompts", status: "completed" });
      await flushProjection();

      expect(anytype.messages[0]?.content?.text).toBe(
        "Working…\n\n• Investigating Codex session logs\n• Planning the next check\n✓ Inspecting user prompts",
      );
      expect(anytype.messages[0]?.content?.marks).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses replace within a part and creates a new message for a distinct assistant part", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const tracked: string[] = [];
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.trackMessages((messageId) => tracked.push(messageId));

      projection.onEvent({ type: "text-delta", text: "draft", partId: "part-1" });
      projection.onEvent({
        type: "text-delta",
        text: "First answer",
        partId: "part-1",
        replace: true,
      });
      await flushProjection();
      projection.onEvent({ type: "text-delta", text: "Second", partId: "part-2" });
      await vi.advanceTimersByTimeAsync(0);
      projection.onEvent({ type: "text-delta", text: " answer", partId: "part-2" });
      await flushProjection();

      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "First answer",
        "Second answer",
      ]);
      expect(tracked).toEqual(["reply-1", "reply-2"]);

      await projection.finish({ text: "First answer\n\nSecond answer" });
      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "First answer",
        "Second answer",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats phase as the logical part identity when partId is absent", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.onEvent({ type: "text-delta", text: "Commentary", phase: "commentary" });
      await flushProjection();
      projection.onEvent({ type: "text-delta", text: "Final", phase: "final" });
      await vi.advanceTimersByTimeAsync(0);
      await projection.finish({ text: "Commentary\n\nFinal" });
      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "Commentary",
        "Final",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the placeholder untouched until finish when streaming is disabled", async () => {
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { thinking: "stream", streaming: false } }),
      conversation,
      "trigger",
    );
    projection.onEvent({ type: "text-delta", text: "First", partId: "part-1" });
    projection.onEvent({ type: "text-delta", text: "Second", partId: "part-2" });
    expect(anytype.messages.map((message) => message.content?.text)).toEqual(["Working…"]);

    await projection.finish({ text: "First\n\nSecond" });
    expect(anytype.messages.map((message) => message.content?.text)).toEqual(["First", "Second"]);
  });

  it("freezes completed output and starts a standalone Working message when steered", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger-1");
      projection.onEvent({ type: "text-delta", text: "Before steer", partId: "part-1" });
      await flushProjection();

      const nextMessageId = await projection.move("trigger-2");
      expect(anytype.messages.find((message) => message.id === "reply-1")?.content?.text).toBe(
        "Before steer",
      );
      expect(anytype.messages.find((message) => message.id === nextMessageId)).toMatchObject({
        content: { text: "Working…" },
      });
      expect(
        anytype.messages.find((message) => message.id === nextMessageId)?.reply_to_message_id,
      ).toBeUndefined();
      expect(anytype.reactions.slice(-2)).toEqual([
        { id: "trigger-1", emoji: "👀", present: false },
        { id: "trigger-2", emoji: "👀", present: true },
      ]);

      projection.onEvent({ type: "text-delta", text: "After steer", partId: "part-2" });
      await projection.finish({ text: "After steer" });
      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "Before steer",
        "After steer",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the agent explicitly choose a native reply without exposing the directive", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");

      projection.onEvent({
        type: "text-delta",
        text: "[[AAG_REPLY]] This is easier to follow as a reply.",
        partId: "answer",
      });
      await flushProjection();

      expect(anytype.deleted).toEqual(["reply-1"]);
      expect(anytype.messages.at(-1)).toMatchObject({
        reply_to_message_id: "trigger",
        content: { text: "This is easier to follow as a reply." },
      });
      await projection.finish({ text: "[[AAG_REPLY]] This is easier to follow as a reply." });
      expect(anytype.messages.at(-1)?.content?.text).not.toContain("AAG_REPLY");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an unfinished transient slot on steering rather than copying it", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger-1");
      projection.onEvent({ type: "thinking-delta", text: "Old thought", partId: "thought-1" });
      await flushProjection();

      const nextMessageId = await projection.move("trigger-2");
      expect(anytype.deleted).toEqual(["reply-1"]);
      expect(anytype.messages.find((message) => message.id === nextMessageId)?.content?.text).toBe(
        "Working…",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves completed output on failure and writes a separate tracked notice", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const tracked: string[] = [];
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.trackMessages((messageId) => tracked.push(messageId));
      projection.onEvent({ type: "text-delta", text: "Useful partial", partId: "part-1" });
      await flushProjection();

      await projection.fail(new Error("connection lost"));
      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "Useful partial",
        "Agent run failed: connection lost",
      ]);
      expect(tracked).toEqual(["reply-1", "reply-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the latest streamed text before writing a failure notice", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.onEvent({ type: "text-delta", text: "Unflushed partial", partId: "part-1" });

      await projection.fail(new Error("connection lost"));
      expect(anytype.messages.map((message) => message.content?.text)).toEqual([
        "Unflushed partial",
        "Agent run failed: connection lost",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a dangling thinking message when completion only repeats prior text", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.onEvent({ type: "text-delta", text: "Answer", partId: "answer-1" });
      await flushProjection();
      projection.onEvent({ type: "thinking-delta", text: "Checking", partId: "thought-2" });
      await vi.advanceTimersByTimeAsync(0);

      await projection.finish({ text: "Answer" });
      expect(anytype.deleted).toContain("reply-2");
      expect(anytype.messages[0]?.content?.text).toBe("Answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the open transient message for failure and keeps tool progress transient", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(
        anytype,
        config({ responses: { thinking: "stream", mode: "milestones" } }),
        conversation,
        "trigger",
      );
      projection.onEvent({ type: "tool", name: "terminal", status: "completed" });
      await flushProjection();
      expect(anytype.messages[0]?.content?.text).toBe("Working…\n\n✓ terminal");
      await projection.fail(new Error("boom"));
      expect(anytype.messages).toHaveLength(1);
      expect(anytype.messages[0]?.content?.text).toBe("Agent run failed: boom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps native formatting and mention marks when a streamed cycle is finalized", async () => {
    class MarkAwareAnytype extends FakeAnytype {
      marks = new Map<string, TextMark[]>();
      override async editMessage(
        spaceId: string,
        chatId: string,
        messageId: string,
        text: string,
        marks?: TextMark[],
      ): Promise<void> {
        await super.editMessage(spaceId, chatId, messageId, text);
        this.marks.set(messageId, marks ?? []);
      }
    }
    vi.useFakeTimers();
    try {
      const anytype = new MarkAwareAnytype();
      const projection = await RunProjection.create(
        anytype,
        config(),
        conversation,
        "trigger",
        "trigger",
        [{ name: "Raj", participantId: "person-raj" }],
      );
      projection.onEvent({ type: "text-delta", text: "@Raj **done**", partId: "answer" });
      await projection.finish({ text: "@Raj **done**" });
      expect(anytype.messages[0]?.content?.text).toBe("@Raj done");
      expect(anytype.marks.get("reply-1")).toEqual(
        expect.arrayContaining([
          { type: "mention", from: 0, to: 4, param: "person-raj" },
          { type: "bold", from: 5, to: 9 },
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps formatting marks at the truncation boundary and removes later marks", async () => {
    class MarkAwareAnytype extends FakeAnytype {
      marks: TextMark[] = [];
      override async editMessage(
        spaceId: string,
        chatId: string,
        messageId: string,
        text: string,
        marks?: TextMark[],
      ): Promise<void> {
        await super.editMessage(spaceId, chatId, messageId, text);
        this.marks = marks ?? [];
      }
    }
    const anytype = new MarkAwareAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { thinking: "stream", maxCharacters: 100 } }),
      conversation,
      "trigger",
    );
    const answer = `**${"x".repeat(120)}** [[AAG_OBJECT:late-object|Late object]]`;
    await projection.finish({ text: answer });

    const text = anytype.messages[0]?.content?.text ?? "";
    const noticeStart = text.indexOf("\n\n[Response truncated by AAG]");
    expect(noticeStart).toBeGreaterThan(0);
    expect(anytype.marks).toEqual([{ type: "bold", from: 0, to: noticeStart }]);
  });

  it("uses the conversation's per-space participant identity for reactions", async () => {
    const anytype = new FakeAnytype();
    const scopedConversation: ConversationRef = {
      ...conversation,
      selfParticipantId: "self-in-space",
    };
    const projection = await RunProjection.create(anytype, config(), scopedConversation, "trigger");
    await projection.finish({ text: "Done" });
    expect(anytype.reactionParticipants).toEqual(["self-in-space", "self-in-space"]);
  });
});
