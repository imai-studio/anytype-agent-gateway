import type { AgentConfig } from "./config.js";
/** Prevent a sweep while a turn is assembling or using not-yet-bound context. */
export declare function holdWorkspaceContext(config: AgentConfig): () => void;
/** Create only Knot's own directories without following nested symlinks. */
export declare function prepareWorkspaceDirectory(config: AgentConfig, directory: string): Promise<void>;
export declare function recordWorkspaceSession(config: AgentConfig, sessionKey: string, paths: string[]): Promise<void>;
/** Evict inactive context and unreferenced media; never scan arbitrary project files. */
export declare function pruneWorkspaceContext(config: AgentConfig, activeSessionKeys: string[], now?: number): Promise<{
    removedFiles: number;
    retainedBytes: number;
}>;
