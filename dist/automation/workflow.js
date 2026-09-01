import { createHash } from "node:crypto";
import { z } from "zod";
import { publicationDocumentSchema, publicationMutationSchema } from "../cloud-contract.js";
export const jsonValueSchema = z.lazy(() => z.union([
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
    "publish.web",
]);
export const WORKFLOW_POLICY_VERSION = 2;
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
    "publish.web",
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
        events: z
            .array(z.enum(["created", "updated", "archived"]))
            .min(1)
            .max(3),
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
const anytypePropertySchema = z
    .object({
    key: z.string().trim().min(1).max(256),
    text: z.string().max(100_000).optional(),
    number: z.number().finite().optional(),
    select: z.string().max(512).optional(),
    multi_select: z.array(z.string().max(512)).max(100).optional(),
    date: z.string().max(128).optional(),
    files: z.array(z.string().max(512)).max(100).optional(),
    checkbox: z.boolean().optional(),
    url: z.string().max(2_000).optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(128).optional(),
    objects: z.array(z.string().max(512)).max(100).optional(),
})
    .strict()
    .superRefine((value, context) => {
    if (["archived", "id", "layout", "object", "space_id", "type", "type_key"].includes(value.key.toLowerCase()))
        context.addIssue({
            code: "custom",
            path: ["key"],
            message: "Reserved Anytype property key is not writable",
        });
    const fields = [
        "text",
        "number",
        "select",
        "multi_select",
        "date",
        "files",
        "checkbox",
        "url",
        "email",
        "phone",
        "objects",
    ].filter((field) => value[field] !== undefined);
    if (fields.length !== 1)
        context.addIssue({
            code: "custom",
            message: "Anytype property requires exactly one typed value",
        });
});
const anytypePropertiesSchema = z.array(anytypePropertySchema).max(100);
export const anytypeReadConfigSchema = z
    .object({ spaceId: z.string().min(1).optional(), objectId: z.string().min(1).optional() })
    .strict();
export const anytypeQueryConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    text: z.string().max(1_024).default(""),
    typeKeys: z.array(z.string().trim().min(1).max(256)).max(20).default([]),
    limit: z.number().int().min(1).max(100).default(25),
})
    .strict();
export const anytypeWriteConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    operation: z.enum(["create", "update", "archive"]).default("update"),
    bulk: z.boolean().default(false),
    values: z
        .object({
        typeKey: z.string().trim().min(1).max(256).optional(),
        name: z.string().max(2_000).optional(),
        body: z.string().max(100_000).optional(),
        markdown: z.string().max(100_000).optional(),
        properties: anytypePropertiesSchema.default([]),
    })
        .strict()
        .default({ properties: [] }),
})
    .strict()
    .superRefine((value, context) => {
    if (value.bulk)
        context.addIssue({
            code: "custom",
            path: ["bulk"],
            message: "Bulk writes are not supported",
        });
    if (value.operation === "create" && !value.values.typeKey)
        context.addIssue({
            code: "custom",
            path: ["values", "typeKey"],
            message: "Create requires typeKey",
        });
    if (value.operation === "create" && value.objectId)
        context.addIssue({
            code: "custom",
            path: ["objectId"],
            message: "Create does not accept objectId",
        });
    if (value.operation === "create" && value.values.markdown !== undefined)
        context.addIssue({
            code: "custom",
            path: ["values", "markdown"],
            message: "Create accepts body, not markdown",
        });
    if (value.operation === "update" && value.values.body !== undefined)
        context.addIssue({
            code: "custom",
            path: ["values", "body"],
            message: "Update accepts markdown, not body",
        });
    if (value.operation !== "create" && value.values.typeKey)
        context.addIssue({
            code: "custom",
            path: ["values", "typeKey"],
            message: "Object type cannot be changed",
        });
    if (value.operation === "archive" &&
        Object.keys(value.values).some((key) => key !== "properties"))
        context.addIssue({
            code: "custom",
            path: ["values"],
            message: "Archive does not accept values",
        });
    if (value.operation === "archive" && value.values.properties.length)
        context.addIssue({
            code: "custom",
            path: ["values", "properties"],
            message: "Archive does not accept properties",
        });
});
export const anytypeUpsertConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    typeKey: z.string().trim().min(1).max(256),
    matchName: z.string().trim().min(1).max(2_000),
    bulk: z.boolean().default(false),
    body: z.string().max(100_000).optional(),
    properties: anytypePropertiesSchema.default([]),
})
    .strict()
    .refine((value) => !value.bulk, { path: ["bulk"], message: "Bulk upserts are not supported" });
export const anytypeMaterializeConfigSchema = z
    .object({
    spaceId: z.string().min(1).optional(),
    collectionId: z.string().min(1),
    objectIds: z.array(z.string().trim().min(1).max(512)).max(100).default([]),
    inputStepId: z.string().min(1).optional(),
    bulk: z.boolean().default(false),
})
    .strict()
    .superRefine((value, context) => {
    if (!value.objectIds.length && !value.inputStepId)
        context.addIssue({
            code: "custom",
            message: "Materialize requires objectIds or inputStepId",
        });
    if ((value.objectIds.length > 1 || value.inputStepId) && !value.bulk)
        context.addIssue({
            code: "custom",
            path: ["bulk"],
            message: "Materializing multiple or derived objects requires bulk",
        });
});
export const transformConfigSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("identity"), inputStepId: z.string().min(1) }).strict(),
    z
        .object({
        operation: z.literal("select"),
        inputStepId: z.string().min(1),
        pointer: z
            .string()
            .regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/)
            .max(2_000),
    })
        .strict(),
    z
        .object({
        operation: z.literal("project"),
        inputStepId: z.string().min(1),
        fields: z
            .record(z.string().trim().min(1).max(256), z
            .string()
            .regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/)
            .max(2_000))
            .refine((value) => Object.keys(value).length <= 100),
    })
        .strict(),
]);
export const notifyConfigSchema = z
    .object({
    connectionRef: z.string().trim().min(1).max(160),
    message: z.string().max(100_000).optional(),
    inputStepId: z.string().min(1).optional(),
})
    .strict()
    .refine((value) => value.message !== undefined || value.inputStepId !== undefined, {
    message: "Notify requires message or inputStepId",
});
export const agentConfigSchema = z
    .object({
    project: z.string().min(1).optional(),
    prompt: z.string().min(1).max(100_000),
    model: z.string().min(1).optional(),
})
    .strict();
const externalReferenceConfig = {
    connectionRef: z.string().min(1),
    secretRefs: z.array(z.string().min(1)).max(100).default([]),
};
function workflowStep(kind, config) {
    return z
        .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        kind: z.literal(kind),
        dependsOn: z.array(z.string()).max(1_000).default([]),
        config: config.optional(),
        retry: retrySchema.optional(),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    })
        .strict();
}
function requiredWorkflowStep(kind, config) {
    return z
        .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        kind: z.literal(kind),
        dependsOn: z.array(z.string()).max(1_000).default([]),
        config,
        retry: retrySchema.optional(),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    })
        .strict();
}
const publicationIdSchema = z.uuid();
export const publishWebConfigSchema = z.discriminatedUnion("action", [
    z
        .object({
        action: z.enum(["create", "update"]),
        connectionRef: z.string().trim().min(1).max(160),
        siteId: publicationIdSchema,
        publicationId: publicationIdSchema,
        slug: publicationMutationSchema.shape.slug,
        document: publicationDocumentSchema,
        assetManifestId: publicationIdSchema.optional(),
    })
        .strict(),
    z
        .object({
        action: z.literal("rollback"),
        connectionRef: z.string().trim().min(1).max(160),
        publicationId: publicationIdSchema,
        versionId: publicationIdSchema,
    })
        .strict(),
    z
        .object({
        action: z.literal("disable"),
        connectionRef: z.string().trim().min(1).max(160),
        publicationId: publicationIdSchema,
    })
        .strict(),
    z
        .object({
        action: z.literal("unpublish"),
        connectionRef: z.string().trim().min(1).max(160),
        publicationId: publicationIdSchema,
        confirmation: publicationIdSchema,
    })
        .strict()
        .refine((value) => value.confirmation === value.publicationId, {
        path: ["confirmation"],
        message: "Destructive unpublish confirmation must equal publicationId",
    }),
]);
const workflowStepSchema = z.discriminatedUnion("kind", [
    requiredWorkflowStep("agent", agentConfigSchema),
    workflowStep("anytype.read", anytypeReadConfigSchema),
    workflowStep("anytype.query", anytypeQueryConfigSchema),
    workflowStep("anytype.write", anytypeWriteConfigSchema),
    workflowStep("anytype.upsert", anytypeUpsertConfigSchema),
    workflowStep("anytype.materialize", anytypeMaterializeConfigSchema),
    workflowStep("transform", transformConfigSchema),
    workflowStep("http", z
        .object({
        ...externalReferenceConfig,
        path: z
            .string()
            .trim()
            .regex(/^\/(?!\/)/)
            .max(2_000)
            .optional(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    })
        .strict()),
    workflowStep("approval", z.object({ message: z.string().max(4_000).optional() }).strict()),
    requiredWorkflowStep("notify", notifyConfigSchema),
    requiredWorkflowStep("publish.web", publishWebConfigSchema),
]);
const workflowDefinitionObjectSchema = z
    .object({
    apiVersion: z.literal("knot.imai.studio/v1alpha1"),
    kind: z.literal("KnotWorkflow"),
    metadata: z
        .object({
        name: z.string().trim().min(1).max(160),
        description: z.string().max(2_000).optional(),
        labels: z
            .record(z.string(), z.string())
            .refine((labels) => Object.keys(labels).length <= 100, "At most 100 labels are allowed")
            .default({}),
    })
        .strict(),
    spec: z
        .object({
        enabled: z.boolean().default(false),
        triggers: z.array(workflowTriggerSchema).min(1).max(100),
        steps: z.array(workflowStepSchema).min(1).max(1_000),
        capabilities: z.array(workflowCapabilitySchema).max(100).default([]),
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
            .max(1_000)
            .default([]),
        concurrency: z.number().int().min(1).max(100).default(1),
    })
        .strict(),
})
    .strict()
    .superRefine((workflow, context) => {
    if (workflow.spec.steps.length > workflow.spec.budget.maximumStepsPerRun)
        context.addIssue({
            code: "custom",
            path: ["spec", "steps"],
            message: `Workflow has ${workflow.spec.steps.length} steps but maximumStepsPerRun is ${workflow.spec.budget.maximumStepsPerRun}`,
        });
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
    for (const [index, step] of workflow.spec.steps.entries()) {
        const config = step.config;
        if (!config || !("inputStepId" in config) || !config.inputStepId)
            continue;
        if (!step.dependsOn.includes(config.inputStepId))
            context.addIssue({
                code: "custom",
                path: ["spec", "steps", index, "config", "inputStepId"],
                message: `Referenced input step must be an explicit dependency: ${config.inputStepId}`,
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
export function unsafeObjectKey(value, seen = new WeakSet()) {
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
        .sort(compareBytewise)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
}
export function workflowApprovalMaterial(workflow) {
    const normalizedSteps = workflow.spec.steps.map((step) => ({
        ...step,
        config: step.config ?? {},
        dependsOn: [...new Set(step.dependsOn)].sort(compareBytewise),
    }));
    return {
        apiVersion: workflow.apiVersion,
        kind: workflow.kind,
        policyVersion: WORKFLOW_POLICY_VERSION,
        spec: {
            behavior: workflow.spec.behavior,
            behaviorReferences: [...workflow.spec.behaviorReferences].sort((left, right) => compareBytewise(`${left.kind}\0${left.id}\0${left.digest}`, `${right.kind}\0${right.id}\0${right.digest}`)),
            budget: workflow.spec.budget,
            capabilities: [...new Set(workflow.spec.capabilities)].sort(compareBytewise),
            concurrency: workflow.spec.concurrency,
            retry: workflow.spec.retry,
            steps: normalizedSteps,
            triggers: workflow.spec.triggers,
        },
    };
}
function compareBytewise(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
export function canonicalStoredWorkflowDefinition(workflow) {
    return canonicalJson(redactSensitiveWorkflowStrings(workflow));
}
export function canonicalStoredWorkflowApproval(workflow) {
    return canonicalJson(redactSensitiveWorkflowStrings(workflowApprovalMaterial(workflow)));
}
export function redactStoredWorkflowJson(value) {
    return canonicalJson(redactSensitiveWorkflowStrings(JSON.parse(value)));
}
function redactSensitiveWorkflowStrings(value, path = []) {
    if (Array.isArray(value))
        return value.map((item, index) => redactSensitiveWorkflowStrings(item, [...path, String(index)]));
    if (!value || typeof value !== "object")
        return value;
    const record = value;
    const result = {};
    for (const [key, nested] of Object.entries(record)) {
        const nestedPath = [...path, key];
        if (typeof nested === "string" && isSensitiveWorkflowTextPath(nestedPath)) {
            result[key] = {
                redacted: true,
                digest: sensitiveWorkflowFieldDigest(nestedPath, nested),
            };
        }
        else
            result[key] = redactSensitiveWorkflowStrings(nested, nestedPath);
    }
    return result;
}
export function isSensitiveWorkflowTextPath(path) {
    const key = path.at(-1);
    if (key === "prompt" || key === "message")
        return true;
    if (path.length === 6 &&
        path[0] === "spec" &&
        path[1] === "steps" &&
        /^\d+$/.test(path[2]) &&
        path[3] === "config" &&
        path[4] === "values" &&
        ["body", "markdown"].includes(key ?? ""))
        return true;
    if (path.length === 5 &&
        path[0] === "spec" &&
        path[1] === "steps" &&
        /^\d+$/.test(path[2]) &&
        path[3] === "config" &&
        key === "body")
        return true;
    if (path.length >= 7 &&
        path[0] === "spec" &&
        path[1] === "steps" &&
        /^\d+$/.test(path[2]) &&
        path[3] === "config" &&
        ((path[4] === "values" && path[5] === "properties" && /^\d+$/.test(path[6])) ||
            (path[4] === "properties" && /^\d+$/.test(path[5]))) &&
        ["text", "url", "email", "phone"].includes(key ?? ""))
        return true;
    if (path.length >= 6 &&
        path[0] === "spec" &&
        path[1] === "steps" &&
        /^\d+$/.test(path[2]) &&
        path[3] === "config" &&
        path[4] === "document") {
        const leaf = path.at(-1);
        return ["title", "description", "text", "href", "code", "alt"].includes(leaf ?? "");
    }
    return false;
}
function sensitiveWorkflowFieldDigest(path, value) {
    const digest = createHash("sha256")
        .update("knot.workflow.sensitive-field.v1\0")
        .update(path.join("\0"))
        .update("\0")
        .update(value)
        .digest("hex");
    return `sha256:${digest}`;
}
export function workflowVersionHash(workflow) {
    const digest = createHash("sha256")
        .update("knot.workflow.version.v1\0")
        .update(canonicalWorkflowDefinition(workflow))
        .digest("hex");
    return `sha256:${digest}`;
}
export function workflowSourceDigest(source) {
    const digest = createHash("sha256")
        .update("knot.workflow.source.v1\0")
        .update(source)
        .digest("hex");
    return `sha256:${digest}`;
}
export function workflowPrincipalDigest(participantId) {
    const digest = createHash("sha256")
        .update("knot.workflow.principal.v1\0")
        .update(participantId)
        .digest("hex");
    return `sha256:${digest}`;
}
