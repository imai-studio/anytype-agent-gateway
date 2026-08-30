import type { WorkflowDefinition, WorkflowCapability } from "./workflow.js";
export type WorkflowRiskTier = "T0" | "T1" | "T2";
export interface WorkflowPolicyEvaluation {
    riskTier: WorkflowRiskTier;
    requiredCapabilities: WorkflowCapability[];
    missingCapabilities: WorkflowCapability[];
    approvalRequired: boolean;
}
export declare function evaluateWorkflowPolicy(workflow: WorkflowDefinition): WorkflowPolicyEvaluation;
export declare function riskTierAllows(maximum: WorkflowRiskTier, actual: WorkflowRiskTier): boolean;
