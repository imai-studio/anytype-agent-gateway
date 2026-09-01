import type { AgentConfig } from "./config.js";
import { type CloudCommandEnvelope, type CloudCommandResult } from "./cloud-contract.js";
import type { CloudClient } from "./cloud-client.js";
import type { CloudConfig } from "./cloud-config.js";
import type { Store } from "./store.js";
import type { AnytypePort } from "./types.js";
import type { WorkflowRunnerExtension } from "./automation/runner.js";
type CommandState = "received" | "awaiting_approval" | "queued" | "running" | "terminal_pending" | "succeeded" | "rejected" | "failed" | "cancelled" | "dead_letter";
export interface CloudCommandRecord {
    commandId: string;
    connectorId: string;
    requiredScope: string;
    actorPrincipalDigest: string;
    actorDigestVersion: number;
    actorProvenance: CloudCommandEnvelope["actor"]["provenance"];
    state: CommandState;
    attempt: number;
    localAttempts: number;
    leaseExpiresAt: number;
    expiresAt: number;
    effectKey: string;
    result?: CloudCommandResult;
    lastErrorCode?: string;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}
export interface CloudCommandClient {
    claimCommands(input?: {
        leaseSeconds?: number;
    }): ReturnType<CloudClient["claimCommands"]>;
    extendLease(command: CloudCommandEnvelope, extendBySeconds?: number): ReturnType<CloudClient["extendLease"]>;
    submitResult(command: CloudCommandEnvelope, result: CloudCommandResult): ReturnType<CloudClient["submitResult"]>;
    controlPublication: CloudClient["controlPublication"];
}
export interface CloudCommandExecutionPort {
    execute(command: CloudCommandEnvelope, effectKey: string): Promise<CloudCommandResult>;
}
export declare class CloudCommandStore {
    private readonly store;
    constructor(store: Store);
    persistClaim(command: CloudCommandEnvelope, now?: number): CloudCommandRecord;
    command(commandId: string): CloudCommandRecord | undefined;
    envelope(commandId: string): CloudCommandEnvelope;
    list(limit?: number): CloudCommandRecord[];
    recoverInterruptedEffects(now?: number): number;
    prepare(commandId: string, approvalRequired: boolean, now?: number): boolean;
    reject(commandId: string, reasonCode: string, now?: number): boolean;
    cancel(commandId: string, now?: number): boolean;
    approve(commandId: string, now?: number): boolean;
    retry(commandId: string, now?: number): boolean;
    nextReady(now?: number): CloudCommandRecord | undefined;
    startEffect(commandId: string, now?: number): {
        effectKey: string;
        fencingToken: string;
    };
    completeEffect(commandId: string, fencingToken: string, result: CloudCommandResult, now?: number): boolean;
    failEffect(commandId: string, fencingToken: string, input: {
        code: string;
        message: string;
        retryable: boolean;
        retryAt?: number;
    }, maximumAttempts?: number, now?: number): boolean;
    terminalPending(): CloudCommandRecord[];
    markSubmitted(commandId: string, result: CloudCommandResult, now?: number): boolean;
    updateLease(commandId: string, leaseExpiresAtSeconds: number, now?: number): void;
    expire(now?: number): number;
    claimProjection(workerId: string, now?: number): ProjectionRecord | undefined;
    completeProjection(projectionId: string, workerId: string, messageId: string, now?: number): void;
    failProjection(projectionId: string, workerId: string, error: string, attempt: number, now?: number): void;
    private setTerminalPending;
    private enqueueProjection;
    private projection;
    private row;
}
interface ProjectionRecord {
    projectionId: string;
    commandId: string;
    originEffectKey: string;
    payload: {
        commandId: string;
        state: string;
        originEffectKey: string;
    };
    attempt: number;
}
export declare class CloudWorkflowExtension implements WorkflowRunnerExtension {
    private readonly client;
    private readonly executor;
    private readonly config;
    private readonly anytype;
    private readonly log;
    private readonly now;
    private readonly inbox;
    private readonly projectionWorkerId;
    private nextPollAt;
    private recovered;
    private inFlight;
    constructor(store: Store, client: CloudCommandClient, executor: CloudCommandExecutionPort, config: AgentConfig["cloudCommands"], anytype: AnytypePort, log: (event: string, fields?: Record<string, unknown>) => void, now?: () => number);
    beforeTick(): Promise<void>;
    stop(): Promise<void>;
    afterTick(): Promise<void>;
    private poll;
    private extendLeases;
    private execute;
    private maintainLease;
    private submitTerminalResults;
}
export declare class AnytypeCloudCommandExecutor implements CloudCommandExecutionPort {
    private readonly anytype;
    private readonly cloud;
    private readonly cloudConfig;
    private readonly agentParticipantId;
    constructor(anytype: AnytypePort, cloud: CloudCommandClient, cloudConfig: CloudConfig, agentParticipantId: string);
    execute(command: CloudCommandEnvelope, effectKey: string): Promise<CloudCommandResult>;
}
export {};
