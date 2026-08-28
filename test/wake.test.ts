import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { decideWake } from "../src/wake.js";
import { incoming } from "./fakes.js";

const config = configSchema.parse({ version: 1, agent: { name: "AAG", participantId: "bot" }, anytype: { apiKeyFile: "/tmp/key" }, spaces: [{ name: "Test" }], runtime: { kind: "openclaw" }, coordination: { agentParticipants: ["peer"] } });

describe("wake policy", () => {
  it("requires an allowed sender", () => { expect(decideWake(incoming(), { humans: "mention", agents: "direct-mention", allowedUsers: ["someone-else"] }, config, { replyToAgent: false }).reason).toBe("unauthorized"); });
  it("never authorizes a sender by display name", () => { expect(decideWake(incoming({ creator: "attacker", creator_name: "trusted" }), { humans: "mention", agents: "never", allowedUsers: ["trusted"] }, config, { replyToAgent: false }).reason).toBe("unauthorized"); });
  it("supports reply steering without a new mention", () => { expect(decideWake(incoming({ content: { text: "follow up" } }), { humans: "mention-or-reply", agents: "direct-mention", allowedUsers: ["*"] }, config, { replyToAgent: true }).wake).toBe(true); });
  it("supports a space-scoped self participant override", () => {
    const message = incoming({ creator: "bot-in-second-space", content: { text: "@AAG", marks: [{ type: "mention", param: "bot-in-second-space" }] } });
    expect(decideWake(message, { humans: "every-message", agents: "never", allowedUsers: ["*"] }, config, { replyToAgent: false, selfParticipantId: "bot-in-second-space" }).reason).toBe("self");
  });
  it("keeps peer agents quiet unless directly mentioned", () => {
    const message = incoming({ creator: "peer", content: { text: "hello" } });
    expect(decideWake(message, { humans: "every-message", agents: "direct-mention", allowedUsers: ["*"] }, config, { replyToAgent: false }).wake).toBe(false);
    const forgedText = incoming({ creator: "peer", content: { text: "@AAG hello" } });
    expect(decideWake(forgedText, { humans: "every-message", agents: "direct-mention", allowedUsers: ["*"] }, config, { replyToAgent: false }).wake).toBe(false);
    const marked = incoming({ creator: "peer", content: { text: "@AAG hello", marks: [{ type: "mention", param: "bot" }] } });
    expect(decideWake(marked, { humans: "every-message", agents: "direct-mention", allowedUsers: ["*"] }, config, { replyToAgent: false }).wake).toBe(true);
  });
});
