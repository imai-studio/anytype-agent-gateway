import type { AgentConfig } from "./config.js";
type RegistryReadFailure = "missing" | "invalid-json" | "invalid-schema" | "nonregular" | "unreadable";
export type ContextRegistryIssue = RegistryReadFailure | "disabled" | "lock-contended" | "lock-unavailable" | "registration-failed" | "cleanup-failed" | "write-failed";
export type ContextRegistryResult = {
    status: "ok";
} | {
    status: "skipped";
    reason: ContextRegistryIssue;
};
export type ContextRegistryDiagnostics = {
    status: "ready" | "disabled" | RegistryReadFailure;
    registeredFiles?: number;
    managedFiles?: number;
    managedBytes?: number;
    lock: "present" | "absent" | "unreadable" | "not-applicable";
};
/** Prevent a sweep while a turn is assembling or using not-yet-bound context. */
export declare function holdWorkspaceContext(config: AgentConfig): () => void;
/** Create only Knot's own directories without following nested symlinks. */
export declare function prepareWorkspaceDirectory(config: AgentConfig, directory: string): Promise<void>;
export declare function recordWorkspaceSession(config: AgentConfig, sessionKey: string, paths: string[]): Promise<ContextRegistryResult>;
/** Evict inactive context and unreferenced media; never scan arbitrary project files. */
export declare function pruneWorkspaceContext(config: AgentConfig, activeSessionKeys: string[], now?: number): Promise<{
    removedFiles: number;
    retainedBytes: number;
} & ContextRegistryResult>;
/** Inspect registry and recorded files without locks, writes, repairs or cleanup. */
export declare function inspectContextRegistry(config: AgentConfig): Promise<ContextRegistryDiagnostics>;
export declare function contextRegistryDoctorLine(diagnostics: ContextRegistryDiagnostics): string;
export {};
