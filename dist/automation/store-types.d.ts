import type { WorkflowCapability } from "./workflow.js";
import type { WorkflowRiskTier } from "./policy.js";
export type { NormalizedEventRecord } from "./event.js";
export type WorkflowEditorProvenance = "anytype-native" | "authenticated-chat" | "operator-cli";
export type WorkflowDefinitionState = "discovered" | "valid" | "invalid" | "archived";
export interface WorkflowDefinitionObservation {
    workflowId: string;
    spaceId: string;
    objectId: string;
    name: string;
    state: WorkflowDefinitionState;
    activeVersionHash?: string;
    sourceModifiedAt: number;
    sourceDigest: string;
    lastSeenAt: number;
    validationErrors: string[];
}
export interface WorkflowObserverState {
    spaceId: string;
    pageOffset: number;
    reconcileStartedAt: number;
    watermarkModifiedAt: number;
    watermarkFingerprint: string;
    pollIntervalMilliseconds: number;
    consecutiveFailures: number;
    nextScanAt: number;
    lastScanAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
}
export interface WorkflowVersionRecord {
    workflowId: string;
    spaceId: string;
    objectId: string;
    name: string;
    versionHash: string;
    approvalHash: string;
    schemaVersion: number;
    canonicalDefinitionJson: string;
    canonicalApprovalJson: string;
    sourceDigest: string;
    riskTier: WorkflowRiskTier;
    requiredCapabilities: WorkflowCapability[];
    sourceModifiedAt: number;
    editorPrincipalDigest?: string;
    editorProvenance?: WorkflowEditorProvenance;
    createdAt: number;
}
export type WorkflowApprovalDecisionKind = "approved" | "rejected" | "revoked";
export type WorkflowApprovalMode = "manual" | "automatic";
export interface WorkflowApprovalDecision {
    sequence: number;
    decisionId: string;
    workflowId: string;
    approvalHash: string;
    decision: WorkflowApprovalDecisionKind;
    mode: WorkflowApprovalMode;
    authorityHash: string;
    actorPrincipalDigest: string;
    reason?: string;
    decidedAt: number;
    expiresAt?: number;
    supersedesDecisionId?: string;
}
