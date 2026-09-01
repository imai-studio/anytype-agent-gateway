import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent, RuntimeModelState, RuntimeTurn } from "../types.js";
type CodexSessionStore = Pick<Store, "codexAcpSession" | "saveCodexAcpSession" | "deleteCodexAcpSession">;
type McpServerCommand = {
    command: string;
    args: string[];
    actorDirectory: string;
    env?: Record<string, string>;
};
type CodexRuntimeConfig = Extract<AgentConfig["runtime"], {
    kind: "codex";
}>;
type CodexDriverConfig = Omit<CodexRuntimeConfig, "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds" | "desktopProject"> & Partial<Pick<CodexRuntimeConfig, "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds" | "desktopProject">>;
export declare class RuntimeTurnAlreadyCompletedError extends Error {
    readonly name = "RuntimeTurnAlreadyCompletedError";
    constructor();
}
export declare class CodexAcpDriver implements RuntimeDriver {
    private readonly config;
    private readonly store?;
    private readonly mcpServer?;
    private readonly agentName?;
    readonly name = "codex-acp";
    readonly projectEnforcement: "advisory";
    readonly capabilities: {
        readonly steering: true;
        readonly thinking: true;
        readonly multipleOutputParts: true;
        readonly sessionObservation: false;
        readonly nativeScheduling: false;
        readonly modelSelection: true;
    };
    private readonly repeatedInternalLoadFailures;
    private readonly hydratedDesktopSessions;
    constructor(config: CodexDriverConfig, store?: CodexSessionStore | undefined, mcpServer?: McpServerCommand | undefined, agentName?: string | undefined);
    doctor(): Promise<string[]>;
    configureModel(input: {
        sessionKey: string;
        turn?: RuntimeTurn;
        modelId?: string | null;
        defaultModelId?: string;
    }): Promise<RuntimeModelState>;
    start(input: {
        sessionKey: string;
        prompt: string;
        turn?: RuntimeTurn;
        origin?: "conversation" | "workflow";
        workspacePath?: string;
        modelId?: string | null;
        defaultModelId?: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
    private associateDesktopProject;
    private hydrateDesktopProject;
    private retryDesktopProjectAssociation;
}
export declare function codexToolActivitySummary(title: unknown, toolCallId: unknown): string;
export {};
