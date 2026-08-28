import type { AgentConfig } from "./config.js";
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
}
