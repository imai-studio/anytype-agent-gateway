import type { Store } from "../store.js";
import { type NormalizedEventRecord } from "./event.js";
import type { WorkflowAttemptRecord, WorkflowDeliveryRecord, WorkflowRunRecord, WorkflowRunnerCursor, WorkflowStepRecord, WorkflowVersionRecord } from "./store-types.js";
import { type JsonValue, type WorkflowDefinition } from "./workflow.js";
type WorkflowDeliveryInput = Omit<WorkflowDeliveryRecord, "state" | "createdAt" | "dispatchedAt">;
export interface WorkflowRetryPolicy {
    attempts: number;
    initialDelaySeconds: number;
    maximumDelaySeconds: number;
    multiplier: number;
}
export interface WorkflowClaim {
    run: WorkflowRunRecord;
    step: WorkflowStepRecord;
    attempt: WorkflowAttemptRecord;
}
export interface WorkflowRunnerCounts {
    deliveries: number;
    runs: number;
    readySteps: number;
    activeLeases: number;
    deadLetters: number;
}
export declare class WorkflowQueue {
    private readonly store;
    constructor(store: Store);
    cursor(): WorkflowRunnerCursor;
    initializeMatcher(now?: number): boolean;
    eventsAfter(cursor: WorkflowRunnerCursor, limit: number): NormalizedEventRecord[];
    activeWorkflowVersions(): WorkflowVersionRecord[];
    createDelivery(input: WorkflowDeliveryInput, now?: number): WorkflowDeliveryRecord;
    createDeliveriesAndAdvanceCursor(event: NormalizedEventRecord, inputs: readonly WorkflowDeliveryInput[], now?: number): WorkflowDeliveryRecord[];
    private insertDelivery;
    pendingDeliveries(limit: number): WorkflowDeliveryRecord[];
    isActiveVersion(workflowId: string, versionHash: string): boolean;
    cancelDelivery(deliveryId: string): boolean;
    deadLetterDelivery(deliveryId: string): boolean;
    dispatchDelivery(deliveryId: string, definition: WorkflowDefinition, limits: {
        maximumConcurrentRuns: number;
        maximumRunsPerHour: number;
        maximumStepsPerRun?: number;
    }, authorityHash: string, now?: number): WorkflowRunRecord | undefined;
    claimStep(workerId: string, allowedAuthorityHashes: ReadonlySet<string>, leaseMilliseconds: number, now?: number): WorkflowClaim | undefined;
    startStep(runId: string, stepId: string, fencingToken: string, now?: number): boolean;
    heartbeat(runId: string, stepId: string, fencingToken: string, leaseMilliseconds: number, now?: number): boolean;
    claimIsCurrent(runId: string, stepId: string, fencingToken: string, now?: number): boolean;
    completeStep(runId: string, stepId: string, fencingToken: string, result: JsonValue, now?: number): boolean;
    failStep(runId: string, stepId: string, fencingToken: string, error: string, retry: WorkflowRetryPolicy, retryable: boolean, now?: number): boolean;
    requireSourceRefetch(runId: string, stepId: string, fencingToken: string, reason: string, now?: number): boolean;
    resumeSourceRefetchStep(runId: string, stepId: string, now?: number): boolean;
    deferSourceRefetch(runId: string, stepId: string, reason: string, availableAt: number, now?: number): boolean;
    sourceRefetchSteps(now?: number, limit?: number): WorkflowStepRecord[];
    recoverExpiredLeases(retryFor: (runId: string, stepId: string) => WorkflowRetryPolicy, now?: number): number;
    expireRunDeadlines(now?: number): number;
    cancelRun(runId: string, actorPrincipalDigest: string, reason: string, now?: number): boolean;
    pauseRunForApproval(runId: string, reason: string, now?: number): boolean;
    resumeRunWithAuthority(runId: string, authorityHash: string, now?: number): boolean;
    deadLetterRun(runId: string, error: string, now?: number): boolean;
    run(runId: string): WorkflowRunRecord | undefined;
    runForDelivery(deliveryId: string): WorkflowRunRecord | undefined;
    activeRuns(): WorkflowRunRecord[];
    steps(runId: string): WorkflowStepRecord[];
    attempts(runId: string, stepId: string): WorkflowAttemptRecord[];
    counts(): WorkflowRunnerCounts;
    private deliveryForEvent;
    private step;
    private attempt;
    private promoteRetriesInTransaction;
    private failExpiredLease;
    private unblockDependentsInTransaction;
    private deadLetterRemainingStepsInTransaction;
    private refreshRunStateInTransaction;
    private finishCancellationInTransaction;
}
export {};
