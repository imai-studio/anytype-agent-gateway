import type { AgentConfig } from "./config.js";
import type { AnytypePort, ConversationRef, RuntimeEvent, RuntimeResult, TextMark } from "./types.js";
export declare class RunProjection {
    private readonly anytype;
    private readonly config;
    private readonly conversation;
    private responseId;
    private text;
    private timer;
    private closed;
    private writes;
    private constructor();
    static create(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, triggerId: string): Promise<RunProjection>;
    static resume(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, responseId: string, text?: string): Promise<RunProjection>;
    get messageId(): string;
    move(triggerId: string): Promise<string>;
    onEvent(event: RuntimeEvent): void;
    finish(result: RuntimeResult): Promise<"done" | "silent">;
    fail(error: unknown): Promise<void>;
    interrupt(): Promise<void>;
    private schedule;
    private currentDisplay;
    private flush;
    private enqueue;
}
export declare function renderCoordination(text: string, config: AgentConfig): {
    text: string;
    marks: TextMark[];
};
