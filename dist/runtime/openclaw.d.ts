import type { AgentConfig } from "../config.js";
import type { ActiveRuntime, ConversationRef, RuntimeDriver, RuntimeEvent, RuntimeResult, RuntimeSessionObserver, RuntimeSessionOutput, RuntimeTurn } from "../types.js";
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
    readonly capabilities: {
        readonly steering: true;
        readonly thinking: true;
        readonly multipleOutputParts: true;
        readonly sessionObservation: true;
        readonly nativeScheduling: true;
    };
    private client;
    private connecting;
    private connected;
    private connectionGeneration;
    private readonly connectionWaiters;
    private readonly eventCallbacks;
    private readonly ownedRunIds;
    private readonly ownedTerminalTexts;
    private readonly ownedSessionLaunches;
    private readonly bridgeObservers;
    private bridgePollTimer;
    private bridgePolling;
    private lastBridgePollErrorAt;
    constructor(config: Extract<AgentConfig["runtime"], {
        kind: "openclaw";
    }>, clientConstructor?: GatewayClientConstructor | undefined);
    doctor(): Promise<string[]>;
    close(): Promise<void>;
    start(input: {
        sessionKey: string;
        prompt: string;
        turn?: RuntimeTurn;
    }, onEvent: (event: RuntimeEvent) => void): Promise<ActiveRuntime>;
    observeSession(input: {
        sessionKey: string;
        afterCursor?: string;
        conversation?: ConversationRef;
    }, onOutput: (output: RuntimeSessionOutput) => Promise<void>): Promise<RuntimeSessionObserver>;
    private resolveSessionKey;
    private bindBridgeSession;
    private observeBridgeSession;
    private pollBridgeOutbox;
    private reportBridgePollError;
    private drainBridgeOutbox;
    private drainBridgeObserver;
    private ackBridgeDelivery;
    private markBridgeOwnedRun;
    private ackBridgeDeliveries;
    private bridgeToken;
    private markOwnedTerminalText;
    private beginOwnedSessionLaunch;
    private endOwnedSessionLaunch;
    private markOwnedRun;
    private consumeOwnedTerminalText;
    private getClient;
    private loadClientConstructor;
    private request;
    private waitForConnection;
    private resolveConnectionWaiters;
    private rejectConnectionWaiters;
    private disconnect;
    private clientModuleCandidates;
    private readToken;
    private waitForRun;
    private readTerminalCursor;
    private readTerminalText;
    private waitForTerminalText;
}
export declare function parseSilence(text: string): RuntimeResult;
export {};
