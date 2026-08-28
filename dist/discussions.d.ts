import type { AgentConfig } from "./config.js";
import type { ChatMessage } from "./types.js";
export type DiscussionResolution = {
    objectId: string;
    discussionId?: string;
    error?: string;
};
export declare class HeartDiscussionAdapter {
    private readonly config;
    constructor(config: AgentConfig);
    resolve(spaceId: string, objects: Array<{
        id: string;
    }>, createMissing: boolean): Promise<DiscussionResolution[]>;
    hydrateMessages(chatId: string, messages: ChatMessage[]): Promise<ChatMessage[]>;
}
