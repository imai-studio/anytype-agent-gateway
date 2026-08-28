import type { AgentConfig } from "./config.js";
import type { AnytypePort, ConversationRef, RuntimeEvent, RuntimeResult, TextMark } from "./types.js";
export type ProjectionCycleSnapshot = {
    id: string;
    messageId: string;
    replyToMessageId: string;
    phase: "working" | "thinking" | "answer" | "error";
    state: "open" | "complete" | "failed" | "deleted";
    text: string;
};
export declare class RunProjection {
    private readonly anytype;
    private readonly config;
    private readonly conversation;
    private responseId;
    private reactionTargetId;
    private replyTargetId;
    private readonly cycles;
    private activeCycle;
    private timer;
    private closed;
    private writes;
    private onMessage;
    private onCycle;
    private readonly createdMessageIds;
    private readonly mentionTargets;
    private constructor();
    static create(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, triggerId: string, replyTargetId?: string, mentionTargets?: Array<{
        name: string;
        participantId: string;
    }>): Promise<RunProjection>;
    static resume(anytype: AnytypePort, config: AgentConfig, conversation: ConversationRef, responseId: string, triggerId: string, replyTargetId?: string, text?: string, mentionTargets?: Array<{
        name: string;
        participantId: string;
    }>): Promise<RunProjection>;
    get messageId(): string;
    trackMessages(callback: (messageId: string) => void): void;
    trackCycles(callback: (cycle: ProjectionCycleSnapshot) => void): void;
    addMentionTargets(targets: Array<{
        name: string;
        participantId: string;
    }>): void;
    move(triggerId: string, replyTargetId?: string): Promise<string>;
    onEvent(event: RuntimeEvent): void;
    finish(result: RuntimeResult): Promise<"done" | "silent">;
    fail(error: unknown): Promise<void>;
    interrupt(message?: string): Promise<void>;
    private updateText;
    private updateThinking;
    private updateTransient;
    private startCycle;
    private schedule;
    private cancelScheduledEdit;
    private currentDisplay;
    private flushCycle;
    private editCycleNow;
    private createCycleMessageNow;
    private writeTerminalNotice;
    private enqueue;
    private emitCycle;
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
