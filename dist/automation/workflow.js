import { createHash } from "node:crypto";
import { z } from "zod";
const jsonValueSchema = z.lazy(() => z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
]));
export const workflowCapabilitySchema = z.enum([
    "agent.invoke",
    "anytype.archive",
    "anytype.bulk",
    "anytype.cross-space",
    "anytype.materialize",
    "anytype.query",
    "anytype.read",
    "anytype.write",
    "http.request",
    "notify",
]);
export const WORKFLOW_POLICY_VERSION = 1;
export const workflowStepKindSchema = z.enum([
    "agent",
    "anytype.read",
    "anytype.query",
    "anytype.write",
    "anytype.upsert",
    "anytype.materialize",
    "transform",
    "http",
    "approval",
    "notify",
]);
const retrySchema = z
    .object({
    attempts: z.number().int().min(1).max(20).default(3),
    initialDelaySeconds: z.number().int().min(0).max(86_400).default(5),
    maximumDelaySeconds: z.number().int().min(0).max(604_800).default(300),
    multiplier: z.number().min(1).max(10).default(2),
})
    .strict()
    .refine((value) => value.maximumDelaySeconds >= value.initialDelaySeconds, "maximumDelaySeconds must be greater than or equal to initialDelaySeconds");
const workflowTriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }).strict(),
    z
        .object({
        kind: z.literal("schedule"),
        schedule: z.string().trim().min(1),
        timezone: z.string().trim().min(1).default("UTC"),
    })
        .strict(),
    z
        .object({
        kind: z.literal("anytype.event"),
        events: z.array(z.enum(["created", "updated", "archived"])).min(1),
        spaceId: z.string().min(1).optional(),
        objectTypeId: z.string().min(1).optional(),
        filter: z.record(z.string(), jsonValueSchema).default({}),
    })
        .strict(),
    z
        .object({
        kind: z.literal("anytype.chat"),
        spaceId: z.string().min(1).optional(),
        chatId: z.string().min(1).optional(),
    })
        .strict(),
]);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const anytypeReadConfigSchema = z
    .object({ spaceId: z.string().min(1).optional(), objectId: z.string().min(1).optional() })
    .strict();
const anytypeQueryConfigSchema = z
    .object({ spaceId: z.string().min(1).optional(), query: jsonObjectSchema.optional() })
    .strict();
const anytypeWriteConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    operation: z.enum(["create", "update", "archive", "delete"]).default("update"),
    bulk: z.boolean().default(false),
    values: jsonObjectSchema.default({}),
})
    .strict();
const anytypeUpsertConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    objectTypeId: z.string().min(1).optional(),
    uniqueKey: z.string().min(1).optional(),
    bulk: z.boolean().default(false),
    values: jsonObjectSchema.default({}),
})
    .strict();
const anytypeMaterializeConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    collectionId: z.string().min(1).optional(),
    bulk: z.boolean().default(false),
})
    .strict();
const externalReferenceConfig = {
    connectionRef: z.string().min(1).optional(),
    secretRefs: z.array(z.string().min(1)).default([]),
};
function workflowStep(kind, config) {
    return z
        .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        kind: z.literal(kind),
        dependsOn: z.array(z.string()).default([]),
        config: config.optional(),
        retry: retrySchema.optional(),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    })
        .strict();
}
const workflowStepSchema = z.discriminatedUnion("kind", [
    workflowStep("agent", z
        .object({
        project: z.string().min(1).optional(),
        prompt: z.string().max(100_000).optional(),
        model: z.string().min(1).optional(),
    })
        .strict()),
    workflowStep("anytype.read", anytypeReadConfigSchema),
    workflowStep("anytype.query", anytypeQueryConfigSchema),
    workflowStep("anytype.write", anytypeWriteConfigSchema),
    workflowStep("anytype.upsert", anytypeUpsertConfigSchema),
    workflowStep("anytype.materialize", anytypeMaterializeConfigSchema),
    workflowStep("transform", z
        .object({
        transformRef: z.string().min(1).optional(),
        inputStepId: z.string().min(1).optional(),
    })
        .strict()),
    workflowStep("http", z
        .object({
        ...externalReferenceConfig,
        url: z.string().url().optional(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    })
        .strict()),
    workflowStep("approval", z.object({ message: z.string().max(4_000).optional() }).strict()),
    workflowStep("notify", z
        .object({
        ...externalReferenceConfig,
        destination: z.string().min(1).optional(),
        message: z.string().max(100_000).optional(),
    })
        .strict()),
]);
const workflowDefinitionObjectSchema = z
    .object({
    apiVersion: z.literal("knot.imai.studio/v1alpha1"),
    kind: z.literal("KnotWorkflow"),
    metadata: z
        .object({
        name: z.string().trim().min(1).max(160),
        description: z.string().max(2_000).optional(),
        labels: z.record(z.string(), z.string()).default({}),
    })
        .strict(),
    spec: z
        .object({
        enabled: z.boolean().default(false),
        triggers: z.array(workflowTriggerSchema).min(1),
        steps: z.array(workflowStepSchema).min(1),
        capabilities: z.array(workflowCapabilitySchema).default([]),
        retry: retrySchema.default({
            attempts: 3,
            initialDelaySeconds: 5,
            maximumDelaySeconds: 300,
            multiplier: 2,
        }),
        budget: z
            .object({
            maximumRunsPerHour: z.number().int().min(1).max(10_000).default(60),
            maximumStepsPerRun: z.number().int().min(1).max(1_000).default(100),
            maximumEffectsPerRun: z.number().int().min(0).max(1_000).default(20),
            maximumRunSeconds: z.number().int().min(1).max(604_800).default(3_600),
        })
            .strict()
            .default({
            maximumRunsPerHour: 60,
            maximumStepsPerRun: 100,
            maximumEffectsPerRun: 20,
            maximumRunSeconds: 3_600,
        }),
        behavior: z
            .object({
            backfill: z.boolean().default(false),
            includeSelfWrites: z.boolean().default(false),
            maximumCausalDepth: z.number().int().min(0).max(100).default(8),
        })
            .strict()
            .default({ backfill: false, includeSelfWrites: false, maximumCausalDepth: 8 }),
        behaviorReferences: z
            .array(z
            .object({
            kind: z.enum(["prompt", "template", "transform", "policy"]),
            id: z.string().min(1),
            digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
            .strict())
            .default([]),
        concurrency: z.number().int().min(1).max(100).default(1),
    })
        .strict(),
})
    .strict()
    .superRefine((workflow, context) => {
    const stepIds = new Set();
    for (const [index, step] of workflow.spec.steps.entries()) {
        if (stepIds.has(step.id))
            context.addIssue({
                code: "custom",
                path: ["spec", "steps", index, "id"],
                message: `Duplicate step id: ${step.id}`,
            });
        stepIds.add(step.id);
    }
    for (const [index, step] of workflow.spec.steps.entries())
        for (const dependency of step.dependsOn) {
            if (dependency === step.id)
                context.addIssue({
                    code: "custom",
                    path: ["spec", "steps", index, "dependsOn"],
                    message: `Step ${step.id} cannot depend on itself`,
                });
            else if (!stepIds.has(dependency))
                context.addIssue({
                    code: "custom",
                    path: ["spec", "steps", index, "dependsOn"],
                    message: `Unknown step dependency: ${dependency}`,
                });
        }
    const dependencies = new Map(workflow.spec.steps.map((step) => [step.id, step.dependsOn]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (stepId) => {
        if (visiting.has(stepId))
            return true;
        if (visited.has(stepId))
            return false;
        visiting.add(stepId);
        const cyclic = (dependencies.get(stepId) ?? []).some((dependency) => dependencies.has(dependency) && visit(dependency));
        visiting.delete(stepId);
        visited.add(stepId);
        return cyclic;
    };
    if (workflow.spec.steps.some((step) => visit(step.id)))
        context.addIssue({
            code: "custom",
            path: ["spec", "steps"],
            message: "Workflow step dependencies must be acyclic",
        });
});
export const workflowDefinitionSchema = z.preprocess((value, context) => {
    const unsafe = unsafeObjectKey(value);
    if (unsafe)
        context.addIssue({
            code: "custom",
            message: `Unsafe object key is not allowed in workflow definitions: ${unsafe}`,
        });
    return value;
}, workflowDefinitionObjectSchema);
function unsafeObjectKey(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value))
        return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const unsafe = unsafeObjectKey(item, seen);
            if (unsafe)
                return unsafe;
        }
        return undefined;
    }
    for (const key of Object.keys(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
            return key;
        const unsafe = unsafeObjectKey(value[key], seen);
        if (unsafe)
            return unsafe;
    }
    return undefined;
}
export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
}
export function workflowApprovalMaterial(workflow) {
    const normalizedSteps = workflow.spec.steps.map((step) => ({
        ...step,
        config: step.config ?? {},
        dependsOn: [...new Set(step.dependsOn)].sort(),
    }));
    return {
        apiVersion: workflow.apiVersion,
        kind: workflow.kind,
        policyVersion: WORKFLOW_POLICY_VERSION,
        spec: {
            behavior: workflow.spec.behavior,
            behaviorReferences: [...workflow.spec.behaviorReferences].sort((left, right) => `${left.kind}\0${left.id}\0${left.digest}`.localeCompare(`${right.kind}\0${right.id}\0${right.digest}`)),
            budget: workflow.spec.budget,
            capabilities: [...new Set(workflow.spec.capabilities)].sort(),
            concurrency: workflow.spec.concurrency,
            retry: workflow.spec.retry,
            steps: normalizedSteps,
            triggers: workflow.spec.triggers,
        },
    };
}
export function workflowApprovalHash(workflow) {
    const digest = createHash("sha256")
        .update("knot.workflow.approval.v1\0")
        .update(canonicalJson(workflowApprovalMaterial(workflow)))
        .digest("hex");
    return `sha256:${digest}`;
}
export function canonicalWorkflowDefinition(workflow) {
    return canonicalJson(JSON.parse(JSON.stringify(workflow)));
}
export function workflowVersionHash(workflow) {
    const digest = createHash("sha256")
        .update("knot.workflow.version.v1\0")
        .update(canonicalWorkflowDefinition(workflow))
        .digest("hex");
    return `sha256:${digest}`;
}
