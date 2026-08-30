import { AnytypeClient } from "./anytype-client.js";
import { type AgentConfig } from "./config.js";
type Tool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};
export declare function runMcpServer(configPath: string, context?: {
    routeId?: string;
    spaceId?: string;
}): Promise<void>;
export declare function toolDefinitions(config: AgentConfig): Tool[];
export declare function callTool(anytype: AnytypeClient, config: AgentConfig, configPath: string, routeId: string | undefined, defaultSpaceId: string | undefined, name: string, input: Record<string, any>, boundActorId?: string, boundDiscussionRootId?: string): Promise<unknown>;
export {};
