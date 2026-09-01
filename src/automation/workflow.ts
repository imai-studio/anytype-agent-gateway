import { createHash } from "node:crypto";
import { z } from "zod";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export type WorkflowCapability = z.infer<typeof workflowCapabilitySchema>;

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
]);

const retrySchema = z
  .object({
    attempts: z.number().int().min(1).max(20).default(3),
    initialDelaySeconds: z.number().int().min(0).max(86_400).default(5),
    maximumDelaySeconds: z.number().int().min(0).max(604_800).default(300),
    multiplier: z.number().min(1).max(10).default(2),
  })
  .strict()
  .refine(
    (value) => value.maximumDelaySeconds >= value.initialDelaySeconds,
    "maximumDelaySeconds must be greater than or equal to initialDelaySeconds",
  );

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
    operation: z.enum(["create", "update", "archive"]).default("update"),
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
  connectionRef: z.string().min(1),
  secretRefs: z.array(z.string().min(1)).max(100).default([]),
};

function workflowStep<K extends z.infer<typeof workflowStepKindSchema>, T extends z.ZodTypeAny>(
  kind: K,
  config: T,
) {
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

const workflowStepSchema = z.discriminatedUnion("kind", [
  workflowStep(
    "agent",
    z
      .object({
        project: z.string().min(1).optional(),
        prompt: z.string().max(100_000).optional(),
        model: z.string().min(1).optional(),
      })
      .strict(),
  ),
  workflowStep("anytype.read", anytypeReadConfigSchema),
  workflowStep("anytype.query", anytypeQueryConfigSchema),
  workflowStep("anytype.write", anytypeWriteConfigSchema),
  workflowStep("anytype.upsert", anytypeUpsertConfigSchema),
  workflowStep("anytype.materialize", anytypeMaterializeConfigSchema),
  workflowStep(
    "transform",
    z
      .object({
        transformRef: z.string().min(1).optional(),
        inputStepId: z.string().min(1).optional(),
      })
      .strict(),
  ),
  workflowStep(
    "http",
    z
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
      .strict(),
  ),
  workflowStep("approval", z.object({ message: z.string().max(4_000).optional() }).strict()),
  workflowStep(
    "notify",
    z
      .object({
        ...externalReferenceConfig,
        destination: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), {
            message: "destination must be a connection-local reference, not a URL",
          })
          .optional(),
        message: z.string().max(100_000).optional(),
      })
      .strict(),
  ),
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
          .array(
            z
              .object({
                kind: z.enum(["prompt", "template", "transform", "policy"]),
                id: z.string().min(1),
                digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              })
              .strict(),
          )
          .max(1_000)
          .default([]),
        concurrency: z.number().int().min(1).max(100).default(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((workflow, context) => {
    const stepIds = new Set<string>();
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
    const dependencies = new Map(
      workflow.spec.steps.map((step) => [step.id, step.dependsOn] as const),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (stepId: string): boolean => {
      if (visiting.has(stepId)) return true;
      if (visited.has(stepId)) return false;
      visiting.add(stepId);
      const cyclic = (dependencies.get(stepId) ?? []).some(
        (dependency) => dependencies.has(dependency) && visit(dependency),
      );
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

export function unsafeObjectKey(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsafe = unsafeObjectKey(item, seen);
      if (unsafe) return unsafe;
    }
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) return key;
    const unsafe = unsafeObjectKey((value as Record<string, unknown>)[key], seen);
    if (unsafe) return unsafe;
  }
  return undefined;
}

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareBytewise)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function workflowApprovalMaterial(workflow: WorkflowDefinition): JsonValue {
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
      behaviorReferences: [...workflow.spec.behaviorReferences].sort((left, right) =>
        compareBytewise(
          `${left.kind}\0${left.id}\0${left.digest}`,
          `${right.kind}\0${right.id}\0${right.digest}`,
        ),
      ),
      budget: workflow.spec.budget,
      capabilities: [...new Set(workflow.spec.capabilities)].sort(compareBytewise),
      concurrency: workflow.spec.concurrency,
      retry: workflow.spec.retry,
      steps: normalizedSteps,
      triggers: workflow.spec.triggers,
    },
  } as JsonValue;
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function workflowApprovalHash(workflow: WorkflowDefinition): string {
  const digest = createHash("sha256")
    .update("knot.workflow.approval.v1\0")
    .update(canonicalJson(workflowApprovalMaterial(workflow)))
    .digest("hex");
  return `sha256:${digest}`;
}

export function canonicalWorkflowDefinition(workflow: WorkflowDefinition): string {
  return canonicalJson(JSON.parse(JSON.stringify(workflow)) as JsonValue);
}

export function canonicalStoredWorkflowDefinition(workflow: WorkflowDefinition): string {
  return canonicalJson(redactSensitiveWorkflowStrings(workflow) as JsonValue);
}

export function canonicalStoredWorkflowApproval(workflow: WorkflowDefinition): string {
  return canonicalJson(
    redactSensitiveWorkflowStrings(workflowApprovalMaterial(workflow)) as JsonValue,
  );
}

export function redactStoredWorkflowJson(value: string): string {
  return canonicalJson(redactSensitiveWorkflowStrings(JSON.parse(value)) as JsonValue);
}

function redactSensitiveWorkflowStrings(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value))
    return value.map((item, index) =>
      redactSensitiveWorkflowStrings(item, [...path, String(index)]),
    );
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = [...path, key];
    if ((key === "prompt" || key === "message") && typeof nested === "string") {
      result[key] = {
        redacted: true,
        digest: sensitiveWorkflowFieldDigest(nestedPath, nested),
      };
    } else result[key] = redactSensitiveWorkflowStrings(nested, nestedPath);
  }
  return result;
}

function sensitiveWorkflowFieldDigest(path: string[], value: string): string {
  const digest = createHash("sha256")
    .update("knot.workflow.sensitive-field.v1\0")
    .update(path.join("\0"))
    .update("\0")
    .update(value)
    .digest("hex");
  return `sha256:${digest}`;
}

export function workflowVersionHash(workflow: WorkflowDefinition): string {
  const digest = createHash("sha256")
    .update("knot.workflow.version.v1\0")
    .update(canonicalWorkflowDefinition(workflow))
    .digest("hex");
  return `sha256:${digest}`;
}

export function workflowSourceDigest(source: string): string {
  const digest = createHash("sha256")
    .update("knot.workflow.source.v1\0")
    .update(source)
    .digest("hex");
  return `sha256:${digest}`;
}

export function workflowPrincipalDigest(participantId: string): string {
  const digest = createHash("sha256")
    .update("knot.workflow.principal.v1\0")
    .update(participantId)
    .digest("hex");
  return `sha256:${digest}`;
}
