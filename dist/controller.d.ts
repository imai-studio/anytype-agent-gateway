import type { AgentConfig, WakeConfig } from "./config.js";
import { Store } from "./store.js";
import type { AnytypePort, ChatMessage, ConversationRef, RuntimeDriver } from "./types.js";
export declare class AgentController {
    private readonly anytype;
    private readonly runtime;
    private readonly config;
    private readonly store;
    private readonly log;
    private readonly active;
    private readonly processing;
    constructor(anytype: AnytypePort, runtime: RuntimeDriver, config: AgentConfig, store: Store, log: (event: string, fields?: Record<string, unknown>) => void);
    process(conversation: ConversationRef, wake: WakeConfig, message: ChatMessage): Promise<void>;
    private processClaimed;
    stop(): Promise<void>;
    private start;
    private replaceActiveSession;
    private steerPrompt;
    private threadKey;
    private agentHop;
}
export declare function messageFingerprint(message: ChatMessage): string;
