import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import { WorkflowQueue, type WorkflowClaim } from "./runner-store.js";
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
    execute(claim: WorkflowClaim, definition: WorkflowDefinition): Promise<WorkflowStepExecution>;
}
export declare class NoEffectWorkflowStepExecutor implements WorkflowStepExecutor {
    execute(claim: WorkflowClaim, definition: WorkflowDefinition): Promise<WorkflowStepExecution>;
}
export declare class WorkflowRunner {
    private readonly store;
    private readonly config;
    private readonly log;
    private readonly executor;
    private readonly now;
    readonly queue: WorkflowQueue;
    private readonly workerIds;
    constructor(store: Store, config: RunnerConfig, log: (event: string, fields?: Record<string, unknown>) => void, executor?: WorkflowStepExecutor, now?: () => number);
    run(signal: AbortSignal): Promise<void>;
    tickOnce(): Promise<void>;
    matchEventsOnce(now?: number): number;
    dispatchOnce(now?: number): number;
    private executeClaim;
    private reauthorizeActiveRuns;
    private authorize;
    private ensureAutomaticApproval;
    private retryFor;
}
export {};
