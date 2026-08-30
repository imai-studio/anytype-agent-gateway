import type { AgentConfig } from "./config.js";
export declare function createCodexTask(config: AgentConfig, input: {
    project: string;
    prompt: string;
}): Promise<{
    thread_id: string;
    project: string;
    status: "running";
}>;
export declare function resolveConfiguredProject(config: AgentConfig, requested: string): Promise<string>;
export declare function configuredCodexProjects(config: AgentConfig): Promise<Array<{
    name: string;
    path: string;
}>>;
