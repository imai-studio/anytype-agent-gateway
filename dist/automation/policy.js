import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./workflow.js";
import { workflowCapabilitySchema } from "./workflow.js";
const tierOrder = { T0: 0, T1: 1, T2: 2 };
const stepCapabilities = {
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
const t2Capabilities = new Set([
    "anytype.archive",
    "anytype.bulk",
    "anytype.cross-space",
    "http.request",
    "notify",
]);
const t1Capabilities = new Set([
    "agent.invoke",
    "anytype.materialize",
    "anytype.write",
]);
export const workflowAuthorityFields = {
    allowedAuthorIds: z.array(z.string().min(1)).default([]),
    allowedSpaceIds: z.array(z.string().min(1)).default([]),
    allowedCapabilities: z.array(workflowCapabilitySchema).default([]),
    allowedConnections: z.array(z.string().min(1)).default([]),
    allowedSecretNames: z.array(z.string().min(1)).default([]),
    allowedProjects: z.array(z.string().min(1)).default([]),
    maximumRiskTier: z.enum(["T0", "T1", "T2"]).default("T0"),
    limits: z
        .object({
        maximumConcurrentRuns: z.number().int().min(1).max(100).default(4),
        maximumRunsPerHour: z.number().int().min(1).max(10_000).default(60),
        maximumStepsPerRun: z.number().int().min(1).max(1_000).default(100),
        maximumEffectsPerRun: z.number().int().min(0).max(1_000).default(20),
        maximumRunSeconds: z.number().int().min(1).max(604_800).default(3_600),
        maximumCausalDepth: z.number().int().min(0).max(100).default(8),
    })
        .strict()
        .default({
        maximumConcurrentRuns: 4,
        maximumRunsPerHour: 60,
        maximumStepsPerRun: 100,
        maximumEffectsPerRun: 20,
        maximumRunSeconds: 3_600,
        maximumCausalDepth: 8,
    }),
};
export const workflowAuthoritySchema = z.object(workflowAuthorityFields).strict();
export function evaluateWorkflowPolicy(workflow, context = {}) {
    const requested = new Set(workflow.spec.capabilities);
    const required = new Set();
    for (const step of workflow.spec.steps)
        for (const capability of stepCapabilities[step.kind])
            required.add(capability);
    deriveConfiguredRiskCapabilities(workflow, context, required);
    for (const capability of requested)
        required.add(capability);
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
function deriveConfiguredRiskCapabilities(workflow, context, required) {
    const configuredSpaces = new Set();
    for (const trigger of workflow.spec.triggers)
        if ("spaceId" in trigger && trigger.spaceId)
            configuredSpaces.add(trigger.spaceId);
    for (const step of workflow.spec.steps) {
        if (!step.kind.startsWith("anytype."))
            continue;
        const config = step.config ?? {};
        if ("spaceId" in config && config.spaceId)
            configuredSpaces.add(config.spaceId);
        if ("bulk" in config && config.bulk)
            required.add("anytype.bulk");
        if ("operation" in config && config.operation === "archive")
            required.add("anytype.archive");
    }
    if (configuredSpaces.size > 1 ||
        (context.sourceSpaceId &&
            [...configuredSpaces].some((spaceId) => spaceId !== context.sourceSpaceId)))
        required.add("anytype.cross-space");
}
export function evaluateWorkflowAuthority(workflow, authority, context = {}) {
    const policy = evaluateWorkflowPolicy(workflow, context);
    const violations = [];
    const allowedCapabilities = new Set(authority.allowedCapabilities);
    for (const capability of policy.requiredCapabilities)
        if (!allowedCapabilities.has(capability))
            violations.push(`Capability is not locally authorized: ${capability}`);
    if (!riskTierAllows(authority.maximumRiskTier, policy.riskTier))
        violations.push(`Risk tier ${policy.riskTier} exceeds local maximum ${authority.maximumRiskTier}`);
    const spaces = new Set();
    if (context.sourceSpaceId)
        spaces.add(context.sourceSpaceId);
    for (const trigger of workflow.spec.triggers)
        if ("spaceId" in trigger && trigger.spaceId)
            spaces.add(trigger.spaceId);
    for (const step of workflow.spec.steps)
        if (step.kind.startsWith("anytype.")) {
            const config = step.config ?? {};
            if ("spaceId" in config && config.spaceId)
                spaces.add(config.spaceId);
        }
    for (const spaceId of spaces)
        if (!authority.allowedSpaceIds.includes(spaceId))
            violations.push(`Space is not locally authorized: ${spaceId}`);
    if (!context.editor)
        violations.push("Workflow editor identity is not verified");
    else if (!authority.allowedAuthorIds.includes(context.editor.principalId))
        violations.push(`Editor is not locally authorized: ${context.editor.principalId}`);
    for (const step of workflow.spec.steps) {
        const config = step.config ?? {};
        if (step.kind === "agent" && "project" in config && config.project)
            if (!authority.allowedProjects.includes(config.project))
                violations.push(`Project is not locally authorized: ${config.project}`);
        if (step.kind !== "http" && step.kind !== "notify")
            continue;
        if ("connectionRef" in config &&
            config.connectionRef &&
            !authority.allowedConnections.includes(config.connectionRef))
            violations.push(`Connection is not locally authorized: ${config.connectionRef}`);
        for (const secretRef of ("secretRefs" in config && config.secretRefs) || [])
            if (!authority.allowedSecretNames.includes(secretRef))
                violations.push(`Secret is not locally authorized: ${secretRef}`);
    }
    const definitionLimits = {
        maximumConcurrentRuns: workflow.spec.concurrency,
        maximumRunsPerHour: workflow.spec.budget.maximumRunsPerHour,
        maximumStepsPerRun: workflow.spec.budget.maximumStepsPerRun,
        maximumEffectsPerRun: workflow.spec.budget.maximumEffectsPerRun,
        maximumRunSeconds: workflow.spec.budget.maximumRunSeconds,
        maximumCausalDepth: workflow.spec.behavior.maximumCausalDepth,
    };
    for (const key of Object.keys(definitionLimits))
        if (definitionLimits[key] > authority.limits[key])
            violations.push(`Workflow ${key} ${definitionLimits[key]} exceeds local maximum ${authority.limits[key]}`);
    const effectiveLimits = Object.fromEntries(Object.keys(definitionLimits).map((key) => [
        key,
        Math.min(definitionLimits[key], authority.limits[key]),
    ]));
    return {
        ...policy,
        allowed: violations.length === 0,
        violations,
        authorityHash: workflowAuthorityHash(authority),
        effectiveLimits,
    };
}
export function riskTierAllows(maximum, actual) {
    return tierOrder[actual] <= tierOrder[maximum];
}
export function workflowAuthorityHash(authority) {
    const material = {
        allowedAuthorIds: [...new Set(authority.allowedAuthorIds)].sort(),
        allowedCapabilities: [...new Set(authority.allowedCapabilities)].sort(),
        allowedConnections: [...new Set(authority.allowedConnections)].sort(),
        allowedProjects: [...new Set(authority.allowedProjects)].sort(),
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
