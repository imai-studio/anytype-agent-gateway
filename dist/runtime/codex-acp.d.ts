import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent } from "../types.js";
type CodexSessionStore = Pick<Store, "codexAcpSession" | "saveCodexAcpSession" | "deleteCodexAcpSession">;
export declare class CodexAcpDriver implements RuntimeDriver {
    private readonly config;
    private readonly store?;
    readonly name = "codex-acp";
    readonly projectEnforcement: "advisory";
    constructor(config: Extract<AgentConfig["runtime"], {
        kind: "codex";
    }>, store?: CodexSessionStore | undefined);
    doctor(): Promise<string[]>;
    start(input: {
        sessionKey: string;
        prompt: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
}
export {};
