import type { AgentConfig, WakeConfig } from "./config.js";
import type { ChatMessage } from "./types.js";
import {
  principalAllowed,
  principalFromMessage,
  sameIdentity,
  type AnytypePrincipal,
} from "./principal.js";

export { sameIdentity } from "./principal.js";

export type WakeDecision = {
  wake: boolean;
  reason: string;
  isAgent: boolean;
  directMention: boolean;
  actor?: AnytypePrincipal;
};

export type WakeOverride = {
  humans: string;
  prefix?: string;
  allowedUsers?: string[];
};

export function mergeWakeOverride(wake: WakeConfig, override?: WakeOverride): WakeConfig {
  if (!override) return wake;
  return {
    ...wake,
    humans: override.humans as WakeConfig["humans"],
    ...(override.prefix ? { prefix: override.prefix } : {}),
    ...(override.allowedUsers ? { allowedUsers: override.allowedUsers } : {}),
  };
}

export function isDirectMention(
  message: ChatMessage,
  config: AgentConfig,
  participantId = config.agent.participantId,
): boolean {
  return isStructuredMention(message, participantId) || isTextMention(message, config);
}

function isStructuredMention(message: ChatMessage, participantId: string): boolean {
  if (message.mentioned) return true;
  const marks = message.content?.marks ?? [];
  return marks.some(
    (mark) => mark.type === "mention" && mark.param && sameIdentity(mark.param, participantId),
  );
}

function isTextMention(message: ChatMessage, config: AgentConfig): boolean {
  const text = message.content?.text ?? "";
  const names = [config.agent.name, ...config.agent.aliases].map((name) => name.replace(/^@/, ""));
  return names.some((name) =>
    new RegExp(`(^|\\s)@${escapeRegex(name)}(?=\\s|$|[.,:;!?])`, "i").test(text),
  );
}

export function decideWake(
  message: ChatMessage,
  wake: WakeConfig,
  config: AgentConfig,
  options: { replyToAgent: boolean; selfParticipantId?: string },
): WakeDecision {
  const actor = principalFromMessage(message);
  if (!actor)
    return {
      wake: false,
      reason: "identity-unavailable",
      isAgent: false,
      directMention: false,
    };
  const creator = actor.participantId;
  const selfParticipantId = options.selfParticipantId ?? config.agent.participantId;
  const isSelf = Boolean(creator && sameIdentity(creator, selfParticipantId));
  if (isSelf) return { wake: false, reason: "self", isAgent: true, directMention: false, actor };
  const isAgent =
    config.coordination.agentParticipants.some((participant) =>
      sameIdentity(creator, participant),
    ) || config.coordination.peers.some((peer) => sameIdentity(creator, peer.participantId));
  const directMention = isAgent
    ? isStructuredMention(message, selfParticipantId)
    : isDirectMention(message, config, selfParticipantId);
  const allowed = principalAllowed(actor, wake.allowedUsers);
  if (!allowed) return { wake: false, reason: "unauthorized", isAgent, directMention, actor };
  if (isAgent) {
    const result =
      wake.agents === "every-message" || (wake.agents === "direct-mention" && directMention);
    return {
      wake: result,
      reason: result ? `agent:${wake.agents}` : "agent-policy",
      isAgent,
      directMention,
      actor,
    };
  }
  const text = message.content?.text ?? "";
  const result =
    wake.humans === "every-message" ||
    (wake.humans === "mention" && directMention) ||
    (wake.humans === "mention-or-reply" && (directMention || options.replyToAgent)) ||
    (wake.humans === "prefix" && Boolean(wake.prefix && text.trimStart().startsWith(wake.prefix)));
  return {
    wake: result,
    reason: result ? `human:${wake.humans}` : "human-policy",
    isAgent,
    directMention,
    actor,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
