import type { AgentConfig } from "./config.js";
import type { AnytypePort, ChatMessage, ContextBundle, ConversationRef } from "./types.js";
export declare function buildContext(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, trigger: ChatMessage): Promise<ContextBundle>;
export declare function formatPrompt(bundle: ContextBundle, config: AgentConfig): string;
