import { describe, expect, it, vi } from "vitest";
import { parseSseBlock } from "../src/anytype-client.js";
import { configSchema } from "../src/config.js";
import { renderCoordination, renderForAnytype, RunProjection } from "../src/projection.js";
import { parseSilence } from "../src/runtime/openclaw.js";
import type { ConversationRef } from "../src/types.js";
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
    ...overrides,
  });
}

describe("protocol boundaries", () => {
  it("parses multiline SSE data and rejects malformed envelopes", () => {
    expect(parseSseBlock('event: message\ndata: {"type":\ndata: "message_added"}')?.type).toBe(
      "message_added",
    );
    expect(() => parseSseBlock('data: {"payload":{}}')).toThrow("invalid event envelope");
    expect(parseSseBlock(": heartbeat")).toBeUndefined();
  });

  it("recognizes deliberate silence without mistaking normal prose", () => {
    expect(parseSilence(" [[AAG_STAY_SILENT: no useful update]] \n")).toMatchObject({
      silent: true,
      reason: "no useful update",
    });
    expect(parseSilence("I might say [[AAG_STAY_SILENT]] later").silent).toBeUndefined();
  });

  it("creates only configured peer marks and enforces fan-out", () => {
    const value = config({
      coordination: {
        peers: [
          { name: "Builder", participantId: "peer-1" },
          { name: "Reviewer", participantId: "peer-2" },
        ],
        maxFanout: 1,
      },
    });
    const rendered = renderCoordination(
      "Ask [[AAG_MENTION:Builder]] then [[AAG_MENTION:Reviewer]].",
      value,
    );
    expect(rendered.text).toBe("Ask @Builder then [[AAG_MENTION:Reviewer]].");
    expect(rendered.marks).toEqual([{ type: "mention", from: 4, to: 12, param: "peer-1" }]);
  });

  it("normalizes Markdown and creates native mentions for observed participants", () => {
    const rendered = renderForAnytype("@HELD Hi!\n- **Important** detail with `code`.", config(), [
      { name: "HELD", participantId: "person-held" },
    ]);
    expect(rendered.text).toBe("@HELD Hi!\n• Important detail with code.");
    expect(rendered.marks).toEqual(
      expect.arrayContaining([
        { type: "mention", from: 0, to: 5, param: "person-held" },
        { type: "bold", from: 12, to: 21 },
        { type: "keyboard", from: 34, to: 38 },
      ]),
    );
  });

  it("renders object references, Anytype links, and fenced code as native marks", () => {
    const rendered = renderForAnytype(
      "See [[AAG_OBJECT:object-1|Roadmap]] and [open](anytype://object/object-1).\n```ts\nconst answer = 42;\n```",
      config(),
    );
    expect(rendered.text).toBe("See Roadmap and open.\nconst answer = 42;");
    expect(rendered.text).not.toContain("```");
    expect(rendered.marks).toEqual(
      expect.arrayContaining([
        { type: "object", from: 4, to: 11, param: "object-1" },
        { type: "link", from: 16, to: 20, param: "anytype://object/object-1" },
        { type: "keyboard", from: 22, to: 40 },
      ]),
    );
  });
});

describe("projection ordering", () => {
  it("streams text into the stable reply in single mode by default", async () => {
    vi.useFakeTimers();
    try {
      const anytype = new FakeAnytype();
      const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
      projection.onEvent({ type: "text-delta", text: "A partial answer" });
      await vi.advanceTimersByTimeAsync(900);
      expect(anytype.edits.at(-1)?.text).toBe("A partial answer");
      await projection.finish({ text: "A complete answer" });
      expect(anytype.edits.at(-1)?.text).toBe("A complete answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("can keep the placeholder stable when streaming is disabled", async () => {
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { streaming: false } }),
      conversation,
      "trigger",
    );
    projection.onEvent({ type: "text-delta", text: "hidden partial" });
    expect(anytype.edits).toEqual([]);
    await projection.finish({ text: "final only" });
    expect(anytype.edits.at(-1)?.text).toBe("final only");
  });

  it("does not let a delayed progress edit overwrite the final answer", async () => {
    class SlowAnytype extends FakeAnytype {
      override async editMessage(
        spaceId: string,
        chatId: string,
        messageId: string,
        text: string,
      ): Promise<void> {
        if (text === "partial") await new Promise((resolve) => setTimeout(resolve, 30));
        await super.editMessage(spaceId, chatId, messageId, text);
      }
    }
    const anytype = new SlowAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { mode: "verbose" } }),
      conversation,
      "trigger",
    );
    projection.onEvent({ type: "text-delta", text: "partial" });
    await new Promise((resolve) => setTimeout(resolve, 950));
    await projection.finish({ text: "final" });
    expect(
      anytype.messages.find((message) => message.id === projection.messageId)?.content?.text,
    ).toBe("final");
  });

  it("projects tool milestones before the final answer", async () => {
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { mode: "milestones" } }),
      conversation,
      "trigger",
    );
    projection.onEvent({ type: "tool", name: "terminal: pwd", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(anytype.edits.at(-1)?.text).toContain("✓ terminal: pwd");
    await projection.finish({ text: "final" });
    expect(anytype.edits.at(-1)?.text).toBe("final");
  });

  it("implements keep and replace silent placeholder policies", async () => {
    const kept = new FakeAnytype();
    const keepProjection = await RunProjection.create(
      kept,
      config({ responses: { silentPlaceholder: "keep" } }),
      conversation,
      "trigger",
    );
    await keepProjection.finish({ text: "", silent: true });
    expect(kept.deleted).toEqual([]);
    expect(kept.messages.at(-1)?.content?.text).toBe("Working…");

    const replaced = new FakeAnytype();
    const replaceProjection = await RunProjection.create(
      replaced,
      config({ responses: { silentPlaceholder: "replace", silentText: "No reply needed." } }),
      conversation,
      "trigger",
    );
    await replaceProjection.finish({ text: "", silent: true });
    expect(replaced.messages.at(-1)?.content?.text).toBe("No reply needed.");
  });

  it("marks truncated final answers and never splits a surrogate pair", async () => {
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(
      anytype,
      config({ responses: { maxCharacters: 100 } }),
      conversation,
      "trigger",
    );
    await projection.finish({ text: `${"x".repeat(70)}😀${"y".repeat(80)}` });
    const text = anytype.messages.at(-1)?.content?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain("[Response truncated by AAG]");
    expect(text).not.toContain("�");
  });
});
