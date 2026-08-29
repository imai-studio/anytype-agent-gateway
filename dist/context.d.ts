import type { AgentConfig } from "./config.js";
import type { AnytypePort, ChatMessage, ContextBundle, ConversationRef } from "./types.js";
export declare function buildContext(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, trigger: ChatMessage, options?: {
    newSession?: boolean;
}): Promise<ContextBundle>;
export declare function formatPrompt(bundle: ContextBundle, config: AgentConfig, managementCommand?: string, workspaceContextFile?: string): string;
export declare function preparePrompt(bundle: ContextBundle, config: AgentConfig, sessionKey: string, managementCommand?: string): Promise<string>;
export declare function isNewSessionCommand(text: string): boolean;
export declare function isNewSessionOnlyCommand(text: string, agentName: string): boolean;
