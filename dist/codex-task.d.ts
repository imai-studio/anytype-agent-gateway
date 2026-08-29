import type { AgentConfig } from "./config.js";
export declare function createCodexTask(config: AgentConfig, input: {
    project: string;
    prompt: string;
}): Promise<{
    thread_id: string;
    project: string;
    status: "running";
}>;
