import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowAuthority,
  evaluateWorkflowPolicy,
  riskTierAllows,
  workflowAuthorityHash,
} from "../src/automation/policy.js";
import {
  canonicalJson,
  workflowApprovalMaterial,
  workflowApprovalHash,
  workflowDefinitionSchema,
} from "../src/automation/workflow.js";

function workflow(overrides: Record<string, unknown> = {}) {
  return workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name: "Daily digest" },
    spec: {
      triggers: [{ kind: "schedule", schedule: "0 9 * * *", timezone: "Asia/Kolkata" }],
      steps: [{ id: "read", kind: "anytype.query", config: { spaceId: "space-1" } }],
      capabilities: ["anytype.query"],
      ...overrides,
    },
  });
}

describe("workflow foundation", () => {
  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: [2, 1] } })).toBe(
      '{"a":{"b":[2,1],"y":true},"z":1}',
    );
    expect(canonicalJson({ ä: 1, z: 2 })).toBe('{"z":2,"ä":1}');
  });

  it("produces stable approval hashes and ignores descriptive metadata", () => {
    const first = workflow();
    const renamed = workflowDefinitionSchema.parse({
      ...first,
      metadata: { ...first.metadata, name: "Renamed", description: "Presentation only" },
    });
    expect(workflowApprovalHash(renamed)).toBe(workflowApprovalHash(first));
    const disabled = workflowDefinitionSchema.parse({
      ...first,
      spec: { ...first.spec, enabled: !first.spec.enabled },
    });
    expect(workflowApprovalHash(disabled)).toBe(workflowApprovalHash(first));
    const changed = workflow({ behavior: { includeSelfWrites: true } });
    expect(workflowApprovalHash(changed)).not.toBe(workflowApprovalHash(first));
    expect(workflowApprovalHash(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reorderedCapabilities = workflow({ capabilities: ["anytype.read", "anytype.query"] });
    const otherCapabilityOrder = workflow({
      capabilities: ["anytype.query", "anytype.read", "anytype.query"],
    });
    expect(workflowApprovalHash(reorderedCapabilities)).toBe(
      workflowApprovalHash(otherCapabilityOrder),
    );
  });

  it("keeps every behavior-bearing spec field in approval material", () => {
    const definition = workflow();
    const material = workflowApprovalMaterial(definition) as {
      policyVersion: number;
      spec: Record<string, unknown>;
    };
    expect(material.policyVersion).toBeGreaterThan(0);
    expect(Object.keys(material.spec).sort()).toEqual(
      Object.keys(definition.spec)
        .filter((key) => key !== "enabled")
        .sort(),
    );
  });

  it("rejects invalid step graphs", () => {
    expect(() =>
      workflow({
        steps: [{ id: "read", kind: "anytype.read", dependsOn: ["missing"] }],
      }),
    ).toThrow("Unknown step dependency");
    expect(() =>
      workflow({
        steps: [
          { id: "one", kind: "transform", dependsOn: ["two"] },
          { id: "two", kind: "transform", dependsOn: ["one"] },
        ],
      }),
    ).toThrow("acyclic");
  });

  it("fails closed on unknown workflow-owned fields", () => {
    expect(() =>
      workflowDefinitionSchema.parse({
        ...workflow(),
        spec: { ...workflow().spec, undocumentedBehavior: true },
      }),
    ).toThrow("Unrecognized key");
    expect(() =>
      workflowDefinitionSchema.parse(
        JSON.parse(
          '{"apiVersion":"knot.imai.studio/v1alpha1","kind":"KnotWorkflow","metadata":{"name":"Unsafe"},"spec":{"triggers":[{"kind":"manual"}],"steps":[{"id":"read","kind":"anytype.read","config":{"__proto__":{"polluted":true}}}]}}',
        ),
      ),
    ).toThrow("Unsafe object key");
  });

  it("invalidates approval when ordered behavior or pinned references change", () => {
    const first = workflow({
      steps: [
        { id: "one", kind: "transform" },
        { id: "two", kind: "anytype.read" },
      ],
    });
    const reordered = workflow({ steps: [...first.spec.steps].reverse() });
    expect(workflowApprovalHash(reordered)).not.toBe(workflowApprovalHash(first));
    const pinned = workflow({
      behaviorReferences: [{ kind: "prompt", id: "digest", digest: `sha256:${"a".repeat(64)}` }],
    });
    const changed = workflow({
      behaviorReferences: [{ kind: "prompt", id: "digest", digest: `sha256:${"b".repeat(64)}` }],
    });
    expect(workflowApprovalHash(changed)).not.toBe(workflowApprovalHash(pinned));
  });

  it("sorts behavior references by deterministic UTF-8 bytes", () => {
    const definition = workflow({
      behaviorReferences: [
        { kind: "prompt", id: "ä", digest: `sha256:${"a".repeat(64)}` },
        { kind: "prompt", id: "z", digest: `sha256:${"b".repeat(64)}` },
      ],
    });
    const material = workflowApprovalMaterial(definition) as {
      spec: { behaviorReferences: Array<{ id: string }> };
    };

    expect(material.spec.behaviorReferences.map((reference) => reference.id)).toEqual(["z", "ä"]);
  });

  it("sorts dependency IDs by deterministic UTF-8 bytes", () => {
    const material = workflowApprovalMaterial(
      workflow({
        steps: [
          { id: "z", kind: "transform" },
          { id: "a", kind: "transform" },
          { id: "final", kind: "transform", dependsOn: ["z", "a"] },
        ],
      }),
    ) as { spec: { steps: Array<{ id: string; dependsOn: string[] }> } };

    expect(material.spec.steps[2]!.dependsOn).toEqual(["a", "z"]);
  });

  it("bounds workflow schema collections", () => {
    expect(() =>
      workflow({
        triggers: Array.from({ length: 101 }, () => ({ kind: "manual" })),
      }),
    ).toThrow();
    expect(() =>
      workflowDefinitionSchema.parse({
        ...workflow(),
        metadata: {
          name: "Too many labels",
          labels: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [`label-${index}`, "value"]),
          ),
        },
      }),
    ).toThrow("At most 100 labels");
  });

  it("classifies read, write, and external workflows into increasing risk tiers", () => {
    expect(evaluateWorkflowPolicy(workflow()).riskTier).toBe("T0");
    const write = workflow({
      steps: [{ id: "write", kind: "anytype.write" }],
      capabilities: ["anytype.write"],
    });
    expect(evaluateWorkflowPolicy(write)).toMatchObject({ riskTier: "T1", approvalRequired: true });
    const external = workflow({
      steps: [{ id: "send", kind: "http", config: { connectionRef: "example" } }],
      capabilities: ["http.request"],
    });
    expect(evaluateWorkflowPolicy(external).riskTier).toBe("T2");
    expect(riskTierAllows("T1", "T2")).toBe(false);
  });

  it("reports capabilities implied by steps but omitted from the declaration", () => {
    const result = evaluateWorkflowPolicy(
      workflow({ steps: [{ id: "write", kind: "anytype.upsert" }], capabilities: [] }),
    );
    expect(result.missingCapabilities).toEqual(["anytype.write"]);
  });

  it("derives cross-space, bulk, and destructive capabilities from step configuration", () => {
    const result = evaluateWorkflowPolicy(
      workflow({
        steps: [
          {
            id: "write",
            kind: "anytype.write",
            config: { spaceId: "space-2", bulk: true, operation: "archive" },
          },
        ],
        capabilities: ["anytype.write"],
      }),
      { sourceSpaceId: "space-1" },
    );
    expect(result.riskTier).toBe("T2");
    expect(result.missingCapabilities).toEqual([
      "anytype.archive",
      "anytype.bulk",
      "anytype.cross-space",
    ]);
  });

  it("binds approvals to normalized local authority", () => {
    const authority = {
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: ["anytype.read" as const, "anytype.query" as const],
      allowedConnections: [],
      allowedSecretNames: [],
      allowedProjects: [],
      maximumRiskTier: "T1" as const,
      limits: {
        maximumConcurrentRuns: 2,
        maximumRunsPerHour: 60,
        maximumStepsPerRun: 100,
        maximumEffectsPerRun: 20,
        maximumRunSeconds: 3_600,
        maximumCausalDepth: 8,
      },
    };
    expect(
      workflowAuthorityHash({
        ...authority,
        allowedCapabilities: [...authority.allowedCapabilities].reverse(),
      }),
    ).toBe(workflowAuthorityHash(authority));
    expect(
      workflowAuthorityHash({
        ...authority,
        limits: { ...authority.limits, maximumEffectsPerRun: 6 },
      }),
    ).not.toBe(workflowAuthorityHash(authority));

    expect(
      evaluateWorkflowAuthority(workflow(), authority, {
        sourceSpaceId: "space-1",
        editor: { principalId: "operator", provenance: "anytype-native" },
      }),
    ).toMatchObject({ allowed: true, violations: [] });
    const external = workflow({
      steps: [
        {
          id: "send",
          kind: "http",
          config: { connectionRef: "billing", secretRefs: ["billing-token"] },
        },
      ],
      capabilities: ["http.request"],
    });
    expect(
      evaluateWorkflowAuthority(external, authority, {
        sourceSpaceId: "space-2",
        editor: { principalId: "intruder", provenance: "anytype-native" },
      }),
    ).toMatchObject({ allowed: false, riskTier: "T2" });
    expect(
      evaluateWorkflowAuthority(external, authority, {
        sourceSpaceId: "space-2",
        editor: { principalId: "intruder", provenance: "anytype-native" },
      }).violations,
    ).toEqual(
      expect.arrayContaining([
        "Capability is not locally authorized: http.request",
        "Risk tier T2 exceeds local maximum T1",
        "Space is not locally authorized: space-2",
        "Editor is not locally authorized: intruder",
        "Connection is not locally authorized: billing",
        "Secret is not locally authorized: billing-token",
      ]),
    );
  });

  it("rejects hard delete and raw external URLs", () => {
    expect(() =>
      workflow({
        steps: [{ id: "remove", kind: "anytype.write", config: { operation: "delete" } }],
      }),
    ).toThrow();
    expect(() =>
      workflow({
        steps: [{ id: "send", kind: "http", config: { url: "https://example.com" } }],
      }),
    ).toThrow();
    expect(() =>
      workflow({
        steps: [
          {
            id: "notify",
            kind: "notify",
            config: { connectionRef: "chat", destination: "https://example.com/hook" },
          },
        ],
      }),
    ).toThrow("connection-local reference");
  });

  it("requires verified editors and enforces local budget caps", () => {
    const authority = {
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: ["anytype.query" as const],
      allowedConnections: [],
      allowedSecretNames: [],
      allowedProjects: [],
      maximumRiskTier: "T0" as const,
      limits: {
        maximumConcurrentRuns: 1,
        maximumRunsPerHour: 10,
        maximumStepsPerRun: 20,
        maximumEffectsPerRun: 5,
        maximumRunSeconds: 600,
        maximumCausalDepth: 4,
      },
    };
    const noEditor = evaluateWorkflowAuthority(workflow(), authority, {
      sourceSpaceId: "space-1",
    });
    expect(noEditor.violations).toContain("Workflow editor identity is not verified");
    const bounded = evaluateWorkflowAuthority(workflow(), authority, {
      sourceSpaceId: "space-1",
      editor: { principalId: "operator", provenance: "anytype-native" },
    });
    expect(bounded.allowed).toBe(false);
    expect(bounded.violations).toEqual(
      expect.arrayContaining([
        "Workflow maximumRunsPerHour 60 exceeds local maximum 10",
        "Workflow maximumStepsPerRun 100 exceeds local maximum 20",
      ]),
    );
    expect(bounded.effectiveLimits).toMatchObject({
      maximumRunsPerHour: 10,
      maximumStepsPerRun: 20,
    });
  });
});
