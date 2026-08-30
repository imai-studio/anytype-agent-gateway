import type { AgentConfig } from "./config.js";
import type { AnytypePort, ConversationRef } from "./types.js";
export type ChatProjectBinding = {
    kind: "none";
} | {
    kind: "bound";
    tag: string;
    projectName: string;
    workspacePath: string;
} | {
    kind: "invalid";
    message: string;
};
export declare function resolveChatProjectBinding(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef): Promise<ChatProjectBinding>;
export declare function setChatProjectBindingTag(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, projectName?: string): Promise<string | undefined>;
