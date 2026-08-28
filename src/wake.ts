import type { AgentConfig, WakeConfig } from "./config.js";
import type { ChatMessage } from "./types.js";

export type WakeDecision = { wake: boolean; reason: string; isAgent: boolean; directMention: boolean };

export function isDirectMention(message: ChatMessage, config: AgentConfig, participantId = config.agent.participantId): boolean {
  return isStructuredMention(message, participantId) || isTextMention(message, config);
}

function isStructuredMention(message: ChatMessage, participantId: string): boolean {
  const marks = message.content?.marks ?? [];
  return marks.some(mark => mark.type === "mention" && mark.param === participantId);
}

function isTextMention(message: ChatMessage, config: AgentConfig): boolean {
  const text = message.content?.text ?? "";
  const names = [config.agent.name, ...config.agent.aliases].map(name => name.replace(/^@/, ""));
  return names.some(name => new RegExp(`(^|\\s)@${escapeRegex(name)}(?=\\s|$|[.,:;!?])`, "i").test(text));
}

export function decideWake(message: ChatMessage, wake: WakeConfig, config: AgentConfig, options: { replyToAgent: boolean; selfParticipantId?: string }): WakeDecision {
  const creator = message.creator ?? "";
  const selfParticipantId = options.selfParticipantId ?? config.agent.participantId;
  const isSelf = creator === selfParticipantId;
  if (isSelf) return { wake: false, reason: "self", isAgent: true, directMention: false };
  const isAgent = config.coordination.agentParticipants.includes(creator) || config.coordination.peers.some(peer => peer.participantId === creator);
  const directMention = isAgent ? isStructuredMention(message, selfParticipantId) : isDirectMention(message, config, selfParticipantId);
  const allowed = wake.allowedUsers.includes("*") || wake.allowedUsers.includes(creator);
  if (!allowed) return { wake: false, reason: "unauthorized", isAgent, directMention };
  if (isAgent) {
    const result = wake.agents === "every-message" || (wake.agents === "direct-mention" && directMention);
    return { wake: result, reason: result ? `agent:${wake.agents}` : "agent-policy", isAgent, directMention };
  }
  const text = message.content?.text ?? "";
  const result = wake.humans === "every-message" || (wake.humans === "mention" && directMention) || (wake.humans === "mention-or-reply" && (directMention || options.replyToAgent)) || (wake.humans === "prefix" && Boolean(wake.prefix && text.trimStart().startsWith(wake.prefix)));
  return { wake: result, reason: result ? `human:${wake.humans}` : "human-policy", isAgent, directMention };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
