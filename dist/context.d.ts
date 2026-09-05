import type { AgentConfig } from "./config.js";
import type { AnytypePort, ChatMessage, ContextBundle, ConversationRef } from "./types.js";
import { type ContextRegistryIssue } from "./context-retention.js";
export declare function buildContext(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, trigger: ChatMessage, options?: {
    newSession?: boolean;
}): Promise<ContextBundle>;
export declare function formatPrompt(bundle: ContextBundle, config: AgentConfig, managementCommand?: string, workspaceContextFile?: string, options?: {
    bootstrapWorkspace?: boolean;
}): string;
export declare function preparePrompt(bundle: ContextBundle, config: AgentConfig, sessionKey: string, managementCommand?: string, options?: {
    bootstrapWorkspace?: boolean;
    onContextRegistryIssue?: (reason: ContextRegistryIssue) => void;
}): Promise<string>;
export declare function workspaceContextFile(defaultProject: string, sessionKey: string): string;
export declare function isNewSessionCommand(text: string): boolean;
export declare function isNewSessionOnlyCommand(text: string, agentName: string): boolean;
