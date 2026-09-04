import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import { WorkflowQueue, type WorkflowClaim } from "./runner-store.js";
import type { WorkflowVersionRecord } from "./store-types.js";
import { type JsonValue, type WorkflowDefinition } from "./workflow.js";
type RunnerConfig = AgentConfig["automation"];
export type WorkflowStepExecution = {
    ok: true;
    result: JsonValue;
} | {
    ok: false;
    error: string;
    retryable: boolean;
};
export interface WorkflowStepExecutor {
    execute(claim: WorkflowClaim, definition: WorkflowDefinition, signal: AbortSignal): Promise<WorkflowStepExecution>;
}
export interface WorkflowSourceSnapshot {
    definitionSource: string;
    sourceModifiedAt: number;
    editorParticipantId: string;
    editorProvenance: "anytype-native" | "authenticated-chat" | "operator-cli";
}
export interface WorkflowSourceResolver {
    refetch(version: WorkflowVersionRecord, signal: AbortSignal): Promise<WorkflowSourceSnapshot | undefined>;
}
export interface WorkflowRunnerExtension {
    beforeTick?(signal?: AbortSignal): Promise<void>;
    afterTick?(signal?: AbortSignal): Promise<void>;
    stop?(): Promise<void>;
}
export declare class NoEffectWorkflowStepExecutor implements WorkflowStepExecutor {
    execute(claim: WorkflowClaim, definition: WorkflowDefinition, _signal: AbortSignal): Promise<WorkflowStepExecution>;
}
export declare class WorkflowRunner {
    private readonly store;
    private readonly config;
    private readonly log;
    private readonly executor;
    private readonly now;
    private readonly sourceResolver?;
    private readonly extensions;
    readonly queue: WorkflowQueue;
    private readonly workerIds;
    private readonly inFlight;
    private lastReauthorizedRunId?;
    constructor(store: Store, config: RunnerConfig, log: (event: string, fields?: Record<string, unknown>) => void, executor?: WorkflowStepExecutor, now?: () => number, sourceResolver?: WorkflowSourceResolver | undefined, extensions?: WorkflowRunnerExtension[]);
    run(signal: AbortSignal): Promise<void>;
    tickOnce(signal?: AbortSignal): Promise<void>;
    private reconcileInFlight;
    matchEventsOnce(now?: number): number;
    dispatchOnce(now?: number): number;
    private deferPendingDelivery;
    private deferApprovalPendingDelivery;
    private deferTransientDelivery;
    private executeClaim;
    private startLeaseHeartbeat;
    private handleRejectedSettlement;
    private reauthorizeActiveRuns;
    private authorize;
    private ensureAutomaticApproval;
    private retryFor;
    private resumeSourceRefetchSteps;
    private deferSourceRefetch;
    private definitionForExecution;
}
export {};
