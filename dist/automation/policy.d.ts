import { z } from "zod";
import type { WorkflowDefinition, WorkflowCapability } from "./workflow.js";
export type WorkflowRiskTier = "T0" | "T1" | "T2";
export interface WorkflowPolicyEvaluation {
    riskTier: WorkflowRiskTier;
    requiredCapabilities: WorkflowCapability[];
    missingCapabilities: WorkflowCapability[];
    approvalRequired: boolean;
}
export declare const workflowAuthorityFields: {
    allowedAuthorIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSpaceIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedCapabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        "agent.invoke": "agent.invoke";
        "anytype.archive": "anytype.archive";
        "anytype.bulk": "anytype.bulk";
        "anytype.cross-space": "anytype.cross-space";
        "anytype.materialize": "anytype.materialize";
        "anytype.query": "anytype.query";
        "anytype.read": "anytype.read";
        "anytype.write": "anytype.write";
        "http.request": "http.request";
        notify: "notify";
    }>>>;
    allowedConnections: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSecretNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
    maximumRiskTier: z.ZodDefault<z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
    }>>;
    limits: z.ZodDefault<z.ZodObject<{
        maximumConcurrentRuns: z.ZodDefault<z.ZodNumber>;
        maximumStepsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumEffectsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumRunSeconds: z.ZodDefault<z.ZodNumber>;
        maximumCausalDepth: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
};
export declare const workflowAuthoritySchema: z.ZodObject<{
    allowedAuthorIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSpaceIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedCapabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        "agent.invoke": "agent.invoke";
        "anytype.archive": "anytype.archive";
        "anytype.bulk": "anytype.bulk";
        "anytype.cross-space": "anytype.cross-space";
        "anytype.materialize": "anytype.materialize";
        "anytype.query": "anytype.query";
        "anytype.read": "anytype.read";
        "anytype.write": "anytype.write";
        "http.request": "http.request";
        notify: "notify";
    }>>>;
    allowedConnections: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSecretNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
    maximumRiskTier: z.ZodDefault<z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
    }>>;
    limits: z.ZodDefault<z.ZodObject<{
        maximumConcurrentRuns: z.ZodDefault<z.ZodNumber>;
        maximumStepsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumEffectsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumRunSeconds: z.ZodDefault<z.ZodNumber>;
        maximumCausalDepth: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type WorkflowAuthority = z.infer<typeof workflowAuthoritySchema>;
export interface WorkflowPolicyContext {
    sourceSpaceId?: string;
}
export interface WorkflowAuthorityContext extends WorkflowPolicyContext {
    authorId?: string;
}
export interface WorkflowAuthorityEvaluation extends WorkflowPolicyEvaluation {
    allowed: boolean;
    violations: string[];
    authorityHash: string;
}
export declare function evaluateWorkflowPolicy(workflow: WorkflowDefinition, context?: WorkflowPolicyContext): WorkflowPolicyEvaluation;
export declare function evaluateWorkflowAuthority(workflow: WorkflowDefinition, authority: WorkflowAuthority, context?: WorkflowAuthorityContext): WorkflowAuthorityEvaluation;
export declare function riskTierAllows(maximum: WorkflowRiskTier, actual: WorkflowRiskTier): boolean;
export declare function workflowAuthorityHash(authority: WorkflowAuthority): string;
