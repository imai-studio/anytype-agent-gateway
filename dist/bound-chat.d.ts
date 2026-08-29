import { createCodexTask } from "./codex-task.js";
import type { AgentConfig } from "./config.js";
import { enrollChatRoute } from "./management.js";
type ChatCreator = {
    createChat(spaceId: string, input: {
        name: string;
    }): Promise<{
        id: string;
        name: string;
    }>;
};
type TaskCreator = typeof createCodexTask;
type RouteEnroller = typeof enrollChatRoute;
export declare function createBoundCodexChat(anytype: ChatCreator, config: AgentConfig, configPath: string, input: {
    spaceId: string;
    name: string;
    project: string;
    prompt: string;
}, dependencies?: {
    createTask?: TaskCreator;
    enrollRoute?: RouteEnroller;
}): Promise<{
    chat_id: string;
    chat_name: string;
    route_id: string;
    thread_id: string;
    project: string;
    status: "bound";
}>;
export {};
