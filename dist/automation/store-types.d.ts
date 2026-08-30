import type { WorkflowCapability } from "./workflow.js";
import type { WorkflowRiskTier } from "./policy.js";
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
    sourceText: string;
    riskTier: WorkflowRiskTier;
    requiredCapabilities: WorkflowCapability[];
    sourceModifiedAt: number;
    authorPrincipalDigest?: string;
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
export interface NormalizedEventRecord {
    eventId: string;
    dedupeKey: string;
    kind: string;
    source: string;
    sourceEventId?: string;
    spaceId: string;
    objectId?: string;
    observedAt: number;
    payloadJson: string;
    diffJson?: string;
    causationRunId?: string;
    causalDepth: number;
    originEffectKey?: string;
    recordedAt: number;
}
