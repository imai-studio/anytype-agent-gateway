import type { AgentConfig } from "../config.js";
import type { ActiveRuntime, RuntimeDriver, RuntimeEvent, RuntimeResult } from "../types.js";
type GatewayClientLike = {
    start(): void;
    stop(): void;
    request<T = Record<string, unknown>>(method: string, params?: unknown, options?: {
        expectFinal?: boolean;
        timeoutMs?: number | null;
        onAccepted?: (payload: unknown) => void;
    }): Promise<T>;
};
type GatewayClientConstructor = new (options: Record<string, unknown>) => GatewayClientLike;
export declare class OpenClawDriver implements RuntimeDriver {
    private readonly config;
    private readonly clientConstructor?;
    readonly name = "openclaw";
    readonly projectEnforcement: "advisory";
    private client;
    private connecting;
    private connected;
    private connectionGeneration;
    private readonly connectionWaiters;
    private readonly eventCallbacks;
    constructor(config: Extract<AgentConfig["runtime"], {
        kind: "openclaw";
    }>, clientConstructor?: GatewayClientConstructor | undefined);
    doctor(): Promise<string[]>;
    close(): Promise<void>;
    start(input: {
        sessionKey: string;
        prompt: string;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
    private getClient;
    private loadClientConstructor;
    private request;
    private waitForConnection;
    private resolveConnectionWaiters;
    private rejectConnectionWaiters;
    private disconnect;
    private clientModuleCandidates;
    private readToken;
    private readTerminalText;
    private waitForTerminalText;
}
export declare function parseSilence(text: string): RuntimeResult;
export {};
