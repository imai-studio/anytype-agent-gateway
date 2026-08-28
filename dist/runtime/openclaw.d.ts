import type { AgentConfig } from "../config.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent, RuntimeResult } from "../types.js";
export declare class OpenClawDriver implements RuntimeDriver {
    private readonly config;
    readonly name = "openclaw";
    readonly projectEnforcement: "advisory";
    private client;
    private connecting;
    private readonly eventCallbacks;
    constructor(config: Extract<AgentConfig["runtime"], {
        kind: "openclaw";
    }>);
    doctor(): Promise<string[]>;
    close(): Promise<void>;
    start(input: {
        sessionKey: string;
        prompt: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
    private getClient;
    private clientModuleCandidates;
    private readToken;
    private readTerminalText;
}
export declare function parseSilence(text: string): RuntimeResult;
