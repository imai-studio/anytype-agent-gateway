import type { AgentConfig, WakeConfig } from "./config.js";
import type { ChatMessage } from "./types.js";
import { type AnytypePrincipal } from "./principal.js";
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
export declare function mergeWakeOverride(wake: WakeConfig, override?: WakeOverride): WakeConfig;
export declare function isDirectMention(message: ChatMessage, config: AgentConfig, participantId?: string): boolean;
export declare function decideWake(message: ChatMessage, wake: WakeConfig, config: AgentConfig, options: {
    replyToAgent: boolean;
    selfParticipantId?: string;
}): WakeDecision;
