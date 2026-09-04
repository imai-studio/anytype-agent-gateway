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
    expect(parseSilence("[[KNOT_STAY_SILENT: compatible]]")).toMatchObject({
      silent: true,
      reason: "compatible",
    });
  });

  it("accepts Knot names for every response marker while retaining AAG markers", async () => {
    const value = config({
      coordination: { peers: [{ name: "Builder", participantId: "peer-1" }] },
    });
    expect(renderCoordination("Ask [[KNOT_MENTION:Builder]].", value)).toMatchObject({
      text: "Ask @Builder.",
      marks: [{ type: "mention", from: 4, to: 12, param: "peer-1" }],
    });
    expect(
      renderForAnytype(
        "[[KNOT_OBJECT:object-1|Roadmap]] [[KNOT_OBJECT_CARD:object-2|Dashboard]]",
        value,
      ),
    ).toMatchObject({
      text: "Roadmap Dashboard",
      marks: [{ type: "object", from: 0, to: 7, param: "object-1" }],
      attachments: [{ target: "object-2", type: "file" }],
    });
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(anytype, value, conversation, "trigger");
    await projection.finish({ text: "[[KNOT_REPLY]] quoted" });
    expect(anytype.messages.find((message) => message.id === projection.messageId)).toMatchObject({
      reply_to_message_id: "trigger",
      content: { text: "quoted" },
    });
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

  it("keeps configured peer names and aliases authoritative over observed mentions", () => {
    const value = config({
      coordination: { peers: [{ name: "Builder", participantId: "peer-1", aliases: ["Build"] }] },
    });
    const rendered = renderCoordination("@Builder [[AAG_MENTION:Build]]", value, [
      { name: "Builder", participantId: "spoof" },
      { name: "BUILD", participantId: "spoof" },
      { name: "Alternate", participantId: "peer-1" },
    ]);
    expect(rendered.text).toBe("@Builder @Builder");
    expect(rendered.marks.every((mark) => mark.param === "peer-1")).toBe(true);
  });

  it.each([
    "@Builder @Person @Builder @Reviewer",
    "@Person @Reviewer",
    "[[KNOT_MENTION:Builder]] [[KNOT_MENTION:Person]] @Builder @Person @Reviewer",
  ])("counts equivalent native identities once across mention forms: %s", (text) => {
    const value = config({
      coordination: {
        peers: [
          { name: "Builder", participantId: "_member_person" },
          { name: "Reviewer", participantId: "reviewer" },
        ],
        maxFanout: 2,
      },
    });
    const rendered = renderCoordination(text, value, [{ name: "Person", participantId: "person" }]);
    expect(rendered.marks.map((mark) => mark.param)).toEqual(["_member_person", "reviewer"]);
  });

  it("drops ambiguous dynamic names regardless of order while retaining identity-equivalent hydration", () => {
    const targets = [
      { name: "Person", participantId: "person-a" },
      { name: "PERSON", participantId: "person-b" },
      { name: "Person", participantId: "person-a" },
      { name: "Known", participantId: "_member_known" },
      { name: "KNOWN", participantId: "known" },
    ];
    for (const observed of [targets, [...targets].reverse()]) {
      const rendered = renderCoordination(
        "@Person [[AAG_MENTION:Person]] @Known",
        config(),
        observed,
      );
      expect(rendered.text).toContain("[[AAG_MENTION:Person]]");
      expect(rendered.marks).toHaveLength(1);
      expect(["known", "_member_known"]).toContain(rendered.marks[0]?.param);
    }
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

  it("preserves intraword underscores while still rendering underscore emphasis", () => {
    const rendered = renderForAnytype("NEW_SESSION_PASS and _italic_", config());
    expect(rendered.text).toBe("NEW_SESSION_PASS and italic");
    expect(rendered.marks).toContainEqual({ type: "italic", from: 21, to: 27 });
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
    expect(rendered.attachments).toEqual([]);
  });

  it("renders object-card tokens as deduplicated native attachments", () => {
    const rendered = renderForAnytype(
      "[[AAG_OBJECT_CARD:object-1|Roadmap]] and [[AAG_OBJECT_CARD:object-1|Roadmap again]]",
      config(),
    );
    expect(rendered.text).toBe("Roadmap and Roadmap again");
    expect(rendered.marks).toEqual([]);
    expect(rendered.attachments).toEqual([{ target: "object-1", type: "file" }]);
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

  it("edits the stable reply into a native object-card message", async () => {
    const anytype = new FakeAnytype();
    const projection = await RunProjection.create(anytype, config(), conversation, "trigger");
    await projection.finish({
      text: "[[AAG_OBJECT_CARD:object-1|Studio Main Changelog — 29 Aug 2026]]",
    });
    const message = anytype.messages.find((item) => item.id === projection.messageId);
    expect(message?.content?.text).toBe("Studio Main Changelog — 29 Aug 2026");
    expect(message?.attachments).toEqual([{ target: "object-1", type: "file" }]);
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
    expect(text).toContain("[Response truncated by Knot]");
    expect(text).not.toContain("�");
  });
});
