import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import type { AnytypePort, RuntimeDriver } from "../types.js";
import { type WorkflowClaim } from "./runner-store.js";
import type { WorkflowStepExecution, WorkflowStepExecutor } from "./runner.js";
import { type WorkflowDefinition } from "./workflow.js";
/** Executes only the closed, typed local workflow catalog. */
export declare class TypedWorkflowStepExecutor implements WorkflowStepExecutor {
    private readonly store;
    private readonly config;
    private readonly anytype;
    private readonly runtime;
    private readonly fallback;
    private readonly queue;
    private readonly receipts;
    private readonly upsertTails;
    constructor(store: Store, config: AgentConfig, anytype: AnytypePort, runtime: RuntimeDriver, fallback: WorkflowStepExecutor);
    execute(claim: WorkflowClaim, definition: WorkflowDefinition, signal: AbortSignal): Promise<WorkflowStepExecution>;
    private validateWrite;
    private validateMaterialize;
    private validateNotify;
    private validateAgent;
    private read;
    private query;
    private write;
    private upsert;
    private materialize;
    private transform;
    private notify;
    private invokeAgent;
    private effect;
    private preflight;
    private sourceEvent;
    private inputResult;
    private assertSpaceAuthorized;
    private assertEventSpaceApproval;
    private withUpsertLock;
}
