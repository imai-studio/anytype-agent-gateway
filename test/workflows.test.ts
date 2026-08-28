import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { AgentController } from "../src/controller.js";
import { Store } from "../src/store.js";
import type { ConversationRef } from "../src/types.js";
import { FakeAnytype, FakeRuntime, incoming } from "./fakes.js";

const conversation: ConversationRef = { routeId: "chat:space:chat", spaceId: "space", chatId: "chat", kind: "chat" };
const wake = { humans: "mention-or-reply" as const, agents: "direct-mention" as const, allowedUsers: ["*"] };

function setup(silentPlaceholder: "delete" | "keep" | "replace" = "delete") {
  const anytype = new FakeAnytype();
  const runtime = new FakeRuntime();
  const store = new Store(":memory:");
  const config = configSchema.parse({ version: 1, agent: { name: "AAG", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ name: "Test" }], runtime: { kind: "openclaw" }, responses: { silentPlaceholder } });
  const controller = new AgentController(anytype, runtime, config, store, () => undefined);
  return { anytype, runtime, store, controller };
}

describe("example workflows", () => {
  it("creates one reply, marks it working, and edits it with the result", async () => {
    const { anytype, runtime, controller } = setup();
    const message = incoming(); anytype.messages.push(message);
    await controller.process(conversation, wake, message);
    expect(anytype.messages.at(-1)?.content?.text).toBe("Working…");
    expect(anytype.reactions.at(-1)).toEqual({ id: message.id, emoji: "👀", present: true });
    runtime.finish({ text: "Finished cleanly" });
    await eventually(() => expect(anytype.edits.at(-1)?.text).toBe("Finished cleanly"));
    expect(anytype.reactions.at(-1)).toEqual({ id: message.id, emoji: "👀", present: false });
  });

  it("steers an active run and moves progress to a reply after the follow-up", async () => {
    const { anytype, runtime, controller } = setup();
    const first = incoming(); anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    const oldReply = anytype.messages.at(-1)!.id;
    const followup = incoming({ id: "message-2", content: { text: "also cover tests" }, reply_to_message_id: oldReply }); anytype.messages.push(followup);
    await controller.process(conversation, wake, followup);
    expect(runtime.steers[0]).toContain("also cover tests");
    expect(anytype.messages.at(-1)?.reply_to_message_id).toBe("message-2");
    expect(anytype.reactions).toEqual(expect.arrayContaining([
      { id: first.id, emoji: "👀", present: false },
      { id: followup.id, emoji: "👀", present: true }
    ]));
    runtime.finish({ text: "Done with tests" });
    await eventually(() => expect(anytype.edits.at(-1)?.text).toBe("Done with tests"));
  });

  it("replaces an active harness session when a tagged /new command arrives", async () => {
    const { anytype, runtime, store, controller } = setup();
    const first = incoming(); anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    const oldReply = anytype.messages.at(-1)!.id;
    const reset = incoming({ id: "message-new", content: { text: "@AAG /new plan the release", marks: [{ type: "mention", param: "bot" }] } });
    anytype.messages.push(reset);
    await controller.process(conversation, wake, reset);

    expect(runtime.steers).toEqual([]);
    expect(runtime.starts.map(start => start.sessionKey)).toEqual(["aag:chat:space:chat", "aag:chat:space:chat:g1"]);
    expect(runtime.starts.at(-1)?.prompt).toContain("new harness session");
    expect(runtime.starts.at(-1)?.prompt).toContain("plan the release");
    expect(runtime.starts.at(-1)?.prompt).not.toContain("@AAG do the work");
    expect(anytype.edits).toContainEqual({ id: oldReply, text: "Agent session replaced by /new." });
    expect(store.sessionGeneration("chat:space:chat")).toBe(1);
    runtime.finish({ text: "Fresh session ready" });
    await eventually(() => expect(anytype.edits.at(-1)?.text).toBe("Fresh session ready"));
  });

  it("deletes the placeholder when the harness deliberately stays silent", async () => {
    const { anytype, runtime, controller } = setup("delete");
    const message = incoming(); anytype.messages.push(message);
    await controller.process(conversation, wake, message);
    const reply = anytype.messages.at(-1)!.id;
    runtime.finish({ text: "", silent: true, reason: "nothing useful" });
    await eventually(() => expect(anytype.deleted).toContain(reply));
  });

  it("can wake when a previously ignored message is edited to add a mention", async () => {
    const { anytype, runtime, controller } = setup();
    const original = incoming({ content: { text: "not for the agent" }, created_at: 1 });
    anytype.messages.push(original);
    await controller.process(conversation, wake, original);
    expect(runtime.starts).toHaveLength(0);
    const edited = incoming({ content: { text: "@AAG now handle this", marks: [{ type: "mention", param: "bot" }] }, created_at: 1, modified_at: 2 });
    anytype.messages[0] = edited;
    await controller.process(conversation, wake, edited);
    expect(runtime.starts).toHaveLength(1);
  });

  it("clears working state when the controller stops an active run", async () => {
    const { anytype, controller } = setup();
    const message = incoming(); anytype.messages.push(message);
    await controller.process(conversation, wake, message);
    const responseId = anytype.messages.at(-1)!.id;
    await controller.stop();
    expect(anytype.reactions).toContainEqual({ id: message.id, emoji: "👀", present: false });
    expect(anytype.edits.at(-1)).toEqual({ id: responseId, text: "Agent run interrupted before completion." });
  });

  it("starts a new run when a follow-up arrives while the previous final edit is in flight", async () => {
    let releaseFinal!: () => void;
    let finalEditStarted!: () => void;
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    const finalStarted = new Promise<void>(resolve => { finalEditStarted = resolve; });
    class SlowFinalAnytype extends FakeAnytype {
      override async editMessage(spaceId: string, chatId: string, messageId: string, text: string): Promise<void> {
        if (text === "first final") { finalEditStarted(); await finalGate; }
        await super.editMessage(spaceId, chatId, messageId, text);
      }
    }
    const anytype = new SlowFinalAnytype();
    const runtime = new FakeRuntime();
    const store = new Store(":memory:");
    const config = configSchema.parse({ version: 1, agent: { name: "AAG", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ name: "Test" }], runtime: { kind: "openclaw" } });
    const controller = new AgentController(anytype, runtime, config, store, () => undefined);
    const first = incoming(); anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    runtime.finish({ text: "first final" });
    await finalStarted;
    const followup = incoming({ id: "message-after-result", content: { text: "@AAG start another", marks: [{ type: "mention", param: "bot" }] } });
    anytype.messages.push(followup);
    await controller.process(conversation, wake, followup);
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.steers).toEqual([]);
    releaseFinal();
    await controller.stop();
    store.close();
  });

  it("rechecks completion after moving a follow-up reply before steering", async () => {
    let releaseMove!: () => void;
    let moveStarted!: () => void;
    const moveGate = new Promise<void>(resolve => { releaseMove = resolve; });
    const started = new Promise<void>(resolve => { moveStarted = resolve; });
    class SlowMoveAnytype extends FakeAnytype {
      private workingEdits = 0;
      override async editMessage(spaceId: string, chatId: string, messageId: string, text: string): Promise<void> {
        if (text === "Working…" && this.workingEdits++ === 0) { moveStarted(); await moveGate; }
        await super.editMessage(spaceId, chatId, messageId, text);
      }
    }
    const anytype = new SlowMoveAnytype();
    const runtime = new FakeRuntime();
    const store = new Store(":memory:");
    const config = configSchema.parse({ version: 1, agent: { name: "AAG", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ name: "Test" }], runtime: { kind: "openclaw" } });
    const controller = new AgentController(anytype, runtime, config, store, () => undefined);
    const first = incoming(); anytype.messages.push(first);
    await controller.process(conversation, wake, first);
    const responseId = anytype.messages.at(-1)!.id;
    const followup = incoming({ id: "message-during-move", content: { text: "continue" }, reply_to_message_id: responseId });
    anytype.messages.push(followup);
    const processing = controller.process(conversation, wake, followup);
    await started;
    runtime.finish({ text: "first final" });
    await new Promise(resolve => setImmediate(resolve));
    releaseMove();
    await processing;
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.steers).toEqual([]);
    expect(anytype.edits.some(edit => edit.text.startsWith("Agent run failed:"))).toBe(false);
    await controller.stop();
    store.close();
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { assertion(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw last;
}
