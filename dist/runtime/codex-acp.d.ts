import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent } from "../types.js";
type CodexSessionStore = Pick<Store, "codexAcpSession" | "saveCodexAcpSession" | "deleteCodexAcpSession">;
type McpServerCommand = {
    command: string;
    args: string[];
    env?: Record<string, string>;
};
type CodexRuntimeConfig = Extract<AgentConfig["runtime"], {
    kind: "codex";
}>;
type CodexDriverConfig = Omit<CodexRuntimeConfig, "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds"> & Partial<Pick<CodexRuntimeConfig, "maxRunSeconds" | "setupTimeoutSeconds" | "livenessProbeSeconds" | "terminationGraceSeconds">>;
export declare class CodexAcpDriver implements RuntimeDriver {
    private readonly config;
    private readonly store?;
    private readonly mcpServer?;
    readonly name = "codex-acp";
    readonly projectEnforcement: "advisory";
    readonly capabilities: {
        readonly steering: true;
        readonly thinking: true;
        readonly multipleOutputParts: true;
        readonly sessionObservation: false;
        readonly nativeScheduling: false;
    };
    constructor(config: CodexDriverConfig, store?: CodexSessionStore | undefined, mcpServer?: McpServerCommand | undefined);
    doctor(): Promise<string[]>;
    start(input: {
        sessionKey: string;
        prompt: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
}
export {};
