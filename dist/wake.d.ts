import type { AgentConfig, WakeConfig } from "./config.js";
import type { ChatMessage } from "./types.js";
export type WakeDecision = {
    wake: boolean;
    reason: string;
    isAgent: boolean;
    directMention: boolean;
};
export declare function isDirectMention(message: ChatMessage, config: AgentConfig, participantId?: string): boolean;
export declare function decideWake(message: ChatMessage, wake: WakeConfig, config: AgentConfig, options: {
    replyToAgent: boolean;
    selfParticipantId?: string;
}): WakeDecision;
export declare function sameIdentity(left: string, right: string): boolean;
