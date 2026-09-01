import type { JsonValue, WorkflowCapability } from "./workflow.js";
import type { WorkflowRiskTier } from "./policy.js";
export type { NormalizedEventRecord } from "./event.js";

export type WorkflowEditorProvenance = "anytype-native" | "authenticated-chat" | "operator-cli";

export type WorkflowDefinitionState = "discovered" | "valid" | "invalid" | "archived";

export type WorkflowValidationErrorCode =
  | "anytype_request_failed"
  | "authority_rejected"
  | "capabilities_missing"
  | "capability_unauthorized"
  | "connection_unauthorized"
  | "editor_unauthorized"
  | "editor_unverified"
  | "native_revision_missing"
  | "object_not_found"
  | "object_read_failed"
  | "object_too_large"
  | "object_type_unverified"
  | "project_unauthorized"
  | "risk_tier_unauthorized"
  | "schema_invalid"
  | "secret_unauthorized"
  | "source_fence_invalid"
  | "source_invalid"
  | "source_missing"
  | "source_too_large"
  | "space_unauthorized"
  | "store_write_failed"
  | "workflow_integrity_failed"
  | "yaml_invalid";

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
  validationErrors: WorkflowValidationErrorCode[];
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

interface WorkflowVersionMetadata {
  workflowId: string;
  spaceId: string;
  objectId: string;
  name: string;
  versionHash: string;
  approvalHash: string;
  schemaVersion: number;
  sourceDigest: string;
  riskTier: WorkflowRiskTier;
  requiredCapabilities: WorkflowCapability[];
  sourceModifiedAt: number;
  editorPrincipalDigest?: string;
  editorProvenance?: WorkflowEditorProvenance;
  createdAt: number;
}

export interface WorkflowVersionInput extends WorkflowVersionMetadata {
  canonicalDefinitionJson: string;
  canonicalApprovalJson: string;
}

export interface WorkflowVersionRecord extends WorkflowVersionMetadata {
  storedDefinitionJson: string;
  storedApprovalJson: string;
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

export type WorkflowDeliveryState = "pending" | "dispatched" | "cancelled" | "dead_letter";
export type WorkflowRunState =
  "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "dead_letter";
export type WorkflowStepState =
  | "blocked"
  | "ready"
  | "leased"
  | "running"
  | "succeeded"
  | "waiting_retry"
  | "waiting_timer"
  | "waiting_approval"
  | "source_refetch_required"
  | "failed"
  | "cancelled"
  | "dead_letter";
export type WorkflowAttemptState =
  "running" | "succeeded" | "retry" | "source_refetch_required" | "failed" | "dead_letter";

export interface WorkflowDeliveryRecord {
  deliveryId: string;
  workflowId: string;
  versionHash: string;
  eventId: string;
  eventDedupeKey: string;
  approvalHash: string;
  authorityHash: string;
  actorPrincipalDigest: string;
  actorProvenance: WorkflowEditorProvenance;
  state: WorkflowDeliveryState;
  createdAt: number;
  nextDispatchAt: number;
  dispatchAttemptCount: number;
  dispatchedAt?: number;
}

export interface WorkflowRunRecord {
  runId: string;
  deliveryId: string;
  workflowId: string;
  versionHash: string;
  approvalHash: string;
  authorityHash: string;
  actorPrincipalDigest: string;
  actorProvenance: WorkflowEditorProvenance;
  state: WorkflowRunState;
  cancelRequestedAt?: number;
  cancelActorPrincipalDigest?: string;
  cancelReason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WorkflowStepRecord {
  runId: string;
  workflowId: string;
  stepId: string;
  position: number;
  kind: string;
  state: WorkflowStepState;
  dependencies: string[];
  timeoutSeconds: number;
  runDeadlineAt: number;
  attemptCount: number;
  sourceRefetchAttemptCount: number;
  availableAt: number;
  leaseOwner?: string;
  fencingToken?: string;
  leaseStartedAt?: number;
  leaseExpiresAt?: number;
  leaseHardExpiresAt?: number;
  authorityHash: string;
  result?: JsonValue;
  error?: string;
  updatedAt: number;
}

export interface WorkflowAttemptRecord {
  attemptId: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  workerId: string;
  fencingToken: string;
  state: WorkflowAttemptState;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface WorkflowRunnerCursor {
  initialized: boolean;
  recordedAt: number;
  eventId: string;
  lastClaimedWorkflowId?: string;
}
