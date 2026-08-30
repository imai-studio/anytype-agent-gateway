import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, type JsonValue } from "./workflow.js";
import { workflowCapabilitySchema } from "./workflow.js";
import type { WorkflowDefinition, WorkflowCapability } from "./workflow.js";

export type WorkflowRiskTier = "T0" | "T1" | "T2";

const tierOrder: Record<WorkflowRiskTier, number> = { T0: 0, T1: 1, T2: 2 };

const stepCapabilities: Record<
  WorkflowDefinition["spec"]["steps"][number]["kind"],
  WorkflowCapability[]
> = {
  agent: ["agent.invoke"],
  "anytype.read": ["anytype.read"],
  "anytype.query": ["anytype.query"],
  "anytype.write": ["anytype.write"],
  "anytype.upsert": ["anytype.write"],
  "anytype.materialize": ["anytype.materialize", "anytype.write"],
  transform: [],
  http: ["http.request"],
  approval: [],
  notify: ["notify"],
};

const t2Capabilities = new Set<WorkflowCapability>([
  "anytype.archive",
  "anytype.bulk",
  "anytype.cross-space",
  "http.request",
]);
const t1Capabilities = new Set<WorkflowCapability>([
  "agent.invoke",
  "anytype.materialize",
  "anytype.write",
  "notify",
]);

export interface WorkflowPolicyEvaluation {
  riskTier: WorkflowRiskTier;
  requiredCapabilities: WorkflowCapability[];
  missingCapabilities: WorkflowCapability[];
  approvalRequired: boolean;
}

export const workflowAuthorityFields = {
  allowedAuthorIds: z.array(z.string().min(1)).default([]),
  allowedSpaceIds: z.array(z.string().min(1)).default([]),
  allowedCapabilities: z.array(workflowCapabilitySchema).default([]),
  allowedConnections: z.array(z.string().min(1)).default([]),
  allowedSecretNames: z.array(z.string().min(1)).default([]),
  maximumRiskTier: z.enum(["T0", "T1", "T2"]).default("T0"),
  limits: z
    .object({
      maximumConcurrentRuns: z.number().int().min(1).max(100).default(4),
      maximumStepsPerRun: z.number().int().min(1).max(1_000).default(100),
      maximumEffectsPerRun: z.number().int().min(0).max(1_000).default(20),
      maximumRunSeconds: z.number().int().min(1).max(604_800).default(3_600),
      maximumCausalDepth: z.number().int().min(0).max(100).default(8),
    })
    .strict()
    .default({
      maximumConcurrentRuns: 4,
      maximumStepsPerRun: 100,
      maximumEffectsPerRun: 20,
      maximumRunSeconds: 3_600,
      maximumCausalDepth: 8,
    }),
} satisfies z.ZodRawShape;

export const workflowAuthoritySchema = z.object(workflowAuthorityFields).strict();
export type WorkflowAuthority = z.infer<typeof workflowAuthoritySchema>;

export interface WorkflowPolicyContext {
  sourceSpaceId?: string;
}

export function evaluateWorkflowPolicy(
  workflow: WorkflowDefinition,
  context: WorkflowPolicyContext = {},
): WorkflowPolicyEvaluation {
  const requested = new Set(workflow.spec.capabilities);
  const required = new Set<WorkflowCapability>();
  for (const step of workflow.spec.steps)
    for (const capability of stepCapabilities[step.kind]) required.add(capability);
  deriveConfiguredRiskCapabilities(workflow, context, required);
  for (const capability of requested) required.add(capability);
  const requiredCapabilities = [...required].sort();
  const riskTier = requiredCapabilities.some((capability) => t2Capabilities.has(capability))
    ? "T2"
    : requiredCapabilities.some((capability) => t1Capabilities.has(capability))
      ? "T1"
      : "T0";
  return {
    riskTier,
    requiredCapabilities,
    missingCapabilities: requiredCapabilities.filter((capability) => !requested.has(capability)),
    approvalRequired: riskTier !== "T0",
  };
}

function deriveConfiguredRiskCapabilities(
  workflow: WorkflowDefinition,
  context: WorkflowPolicyContext,
  required: Set<WorkflowCapability>,
): void {
  const configuredSpaces = new Set<string>();
  for (const trigger of workflow.spec.triggers)
    if ("spaceId" in trigger && trigger.spaceId) configuredSpaces.add(trigger.spaceId);
  for (const step of workflow.spec.steps) {
    if (!step.kind.startsWith("anytype.")) continue;
    collectStringValues(step.config, "spaceId", configuredSpaces);
    if (step.config.bulk === true) required.add("anytype.bulk");
    if (step.config.archive === true || step.config.destructive === true)
      required.add("anytype.archive");
    const operation = step.config.operation;
    if (
      typeof operation === "string" &&
      ["archive", "delete", "destroy", "purge"].includes(operation.toLowerCase())
    )
      required.add("anytype.archive");
  }
  if (
    configuredSpaces.size > 1 ||
    (context.sourceSpaceId &&
      [...configuredSpaces].some((spaceId) => spaceId !== context.sourceSpaceId))
  )
    required.add("anytype.cross-space");
}

function collectStringValues(value: JsonValue, key: string, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, key, output);
    return;
  }
  for (const [candidate, nested] of Object.entries(value)) {
    if (candidate === key && typeof nested === "string") output.add(nested);
    else collectStringValues(nested, key, output);
  }
}

export function riskTierAllows(maximum: WorkflowRiskTier, actual: WorkflowRiskTier): boolean {
  return tierOrder[actual] <= tierOrder[maximum];
}

export function workflowAuthorityHash(authority: WorkflowAuthority): string {
  const material: JsonValue = {
    allowedAuthorIds: [...new Set(authority.allowedAuthorIds)].sort(),
    allowedCapabilities: [...new Set(authority.allowedCapabilities)].sort(),
    allowedConnections: [...new Set(authority.allowedConnections)].sort(),
    allowedSecretNames: [...new Set(authority.allowedSecretNames)].sort(),
    allowedSpaceIds: [...new Set(authority.allowedSpaceIds)].sort(),
    limits: authority.limits,
    maximumRiskTier: authority.maximumRiskTier,
  };
  const digest = createHash("sha256")
    .update("knot.workflow.authority.v1\0")
    .update(canonicalJson(material))
    .digest("hex");
  return `sha256:${digest}`;
}
