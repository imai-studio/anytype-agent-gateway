import { createHash } from "node:crypto";
import { z } from "zod";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
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

const workflowStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    kind: workflowStepKindSchema,
    dependsOn: z.array(z.string()).default([]),
    config: z.record(z.string(), jsonValueSchema).default({}),
    retry: retrySchema.optional(),
    timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();

export const workflowDefinitionSchema = z
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
          .array(
            z
              .object({
                kind: z.enum(["prompt", "template", "transform", "policy"]),
                id: z.string().min(1),
                digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              })
              .strict(),
          )
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

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function workflowApprovalMaterial(workflow: WorkflowDefinition): JsonValue {
  const normalizedSteps = workflow.spec.steps.map((step) => ({
    ...step,
    dependsOn: [...new Set(step.dependsOn)].sort(),
  }));
  return {
    apiVersion: workflow.apiVersion,
    kind: workflow.kind,
    spec: {
      behavior: workflow.spec.behavior,
      behaviorReferences: [...workflow.spec.behaviorReferences].sort((left, right) =>
        `${left.kind}\0${left.id}\0${left.digest}`.localeCompare(
          `${right.kind}\0${right.id}\0${right.digest}`,
        ),
      ),
      budget: workflow.spec.budget,
      capabilities: [...new Set(workflow.spec.capabilities)].sort(),
      concurrency: workflow.spec.concurrency,
      retry: workflow.spec.retry,
      steps: normalizedSteps,
      triggers: workflow.spec.triggers,
    },
  } as JsonValue;
}

export function workflowApprovalHash(workflow: WorkflowDefinition): string {
  const digest = createHash("sha256")
    .update("knot.workflow.approval.v1\0")
    .update(canonicalJson(workflowApprovalMaterial(workflow)))
    .digest("hex");
  return `sha256:${digest}`;
}
