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
        "publish.web": "publish.web";
    }>>>;
    allowedConnections: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSecretNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedModels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    publishConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        cloudConfigFile: z.ZodString;
        allowedSiteIds: z.ZodArray<z.ZodUUID>;
        allowedSlugPrefixes: z.ZodArray<z.ZodString>;
        allowUpdate: z.ZodDefault<z.ZodBoolean>;
        allowRollback: z.ZodDefault<z.ZodBoolean>;
        allowDisable: z.ZodDefault<z.ZodBoolean>;
        allowUnpublish: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>>;
    notificationConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        spaceId: z.ZodString;
        chatId: z.ZodString;
    }, z.core.$strict>>>;
    maximumRiskTier: z.ZodDefault<z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
    }>>;
    limits: z.ZodDefault<z.ZodObject<{
        maximumConcurrentRuns: z.ZodDefault<z.ZodNumber>;
        maximumRunsPerHour: z.ZodDefault<z.ZodNumber>;
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
        "publish.web": "publish.web";
    }>>>;
    allowedConnections: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedSecretNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedProjects: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedModels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    publishConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        cloudConfigFile: z.ZodString;
        allowedSiteIds: z.ZodArray<z.ZodUUID>;
        allowedSlugPrefixes: z.ZodArray<z.ZodString>;
        allowUpdate: z.ZodDefault<z.ZodBoolean>;
        allowRollback: z.ZodDefault<z.ZodBoolean>;
        allowDisable: z.ZodDefault<z.ZodBoolean>;
        allowUnpublish: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>>;
    notificationConnections: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        spaceId: z.ZodString;
        chatId: z.ZodString;
    }, z.core.$strict>>>;
    maximumRiskTier: z.ZodDefault<z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
    }>>;
    limits: z.ZodDefault<z.ZodObject<{
        maximumConcurrentRuns: z.ZodDefault<z.ZodNumber>;
        maximumRunsPerHour: z.ZodDefault<z.ZodNumber>;
        maximumStepsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumEffectsPerRun: z.ZodDefault<z.ZodNumber>;
        maximumRunSeconds: z.ZodDefault<z.ZodNumber>;
        maximumCausalDepth: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type WorkflowAuthority = z.infer<typeof workflowAuthoritySchema>;
type WorkflowAuthorityInput = Omit<WorkflowAuthority, "allowedModels" | "notificationConnections" | "publishConnections"> & {
    allowedModels?: WorkflowAuthority["allowedModels"];
    notificationConnections?: WorkflowAuthority["notificationConnections"];
    publishConnections?: WorkflowAuthority["publishConnections"];
};
export interface WorkflowPolicyContext {
    sourceSpaceId?: string;
}
export interface WorkflowAuthorityContext extends WorkflowPolicyContext {
    editor?: {
        principalId: string;
        provenance: "anytype-native" | "authenticated-chat" | "operator-cli";
    };
}
export interface WorkflowEffectiveLimits {
    maximumConcurrentRuns: number;
    maximumRunsPerHour: number;
    maximumStepsPerRun: number;
    maximumEffectsPerRun: number;
    maximumRunSeconds: number;
    maximumCausalDepth: number;
}
export interface WorkflowAuthorityEvaluation extends WorkflowPolicyEvaluation {
    allowed: boolean;
    violations: string[];
    authorityHash: string;
    effectiveLimits: WorkflowEffectiveLimits;
}
export declare function evaluateWorkflowPolicy(workflow: WorkflowDefinition, context?: WorkflowPolicyContext): WorkflowPolicyEvaluation;
export declare function evaluateWorkflowAuthority(workflow: WorkflowDefinition, authority: WorkflowAuthorityInput, context?: WorkflowAuthorityContext): WorkflowAuthorityEvaluation;
export declare function riskTierAllows(maximum: WorkflowRiskTier, actual: WorkflowRiskTier): boolean;
export declare function workflowAuthorityHash(authority: WorkflowAuthorityInput): string;
export {};
