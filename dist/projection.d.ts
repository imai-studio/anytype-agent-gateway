import type { AgentConfig } from "./config.js";
import type { AnytypePort, ConversationRef, RuntimeEvent, RuntimeResult, TextMark } from "./types.js";
export declare class RunProjection {
    private readonly anytype;
    private readonly config;
    private readonly conversation;
    private responseId;
    private reactionTargetId;
    private text;
    private timer;
    private closed;
    private writes;
    private readonly mentionTargets;
    private constructor();
    static create(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, triggerId: string, replyTargetId?: string, mentionTargets?: Array<{
        name: string;
        participantId: string;
    }>): Promise<RunProjection>;
    static resume(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, responseId: string, triggerId: string, text?: string, mentionTargets?: Array<{
        name: string;
        participantId: string;
    }>): Promise<RunProjection>;
    get messageId(): string;
    addMentionTargets(targets: Array<{
        name: string;
        participantId: string;
    }>): void;
    move(triggerId: string, replyTargetId?: string): Promise<string>;
    onEvent(event: RuntimeEvent): void;
    finish(result: RuntimeResult): Promise<"done" | "silent">;
    fail(error: unknown): Promise<void>;
    interrupt(message?: string): Promise<void>;
    private schedule;
    private currentDisplay;
    private flush;
    private enqueue;
}
export declare function renderCoordination(text: string, config: AgentConfig, dynamicTargets?: Array<{
    name: string;
    participantId: string;
}>): {
    text: string;
    marks: TextMark[];
};
export declare function renderForAnytype(text: string, config: AgentConfig, dynamicTargets?: Array<{
    name: string;
    participantId: string;
}>): {
    text: string;
    marks: TextMark[];
};
