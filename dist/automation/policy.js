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
]);
const t1Capabilities = new Set([
    "agent.invoke",
    "anytype.materialize",
    "anytype.write",
    "notify",
]);
export function evaluateWorkflowPolicy(workflow) {
    const requested = new Set(workflow.spec.capabilities);
    const required = new Set();
    for (const step of workflow.spec.steps)
        for (const capability of stepCapabilities[step.kind])
            required.add(capability);
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
export function riskTierAllows(maximum, actual) {
    return tierOrder[actual] <= tierOrder[maximum];
}
