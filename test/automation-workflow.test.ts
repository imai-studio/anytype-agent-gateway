import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowPolicy,
  riskTierAllows,
  workflowAuthorityHash,
} from "../src/automation/policy.js";
import {
  canonicalJson,
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
  });

  it("produces stable approval hashes and ignores descriptive metadata", () => {
    const first = workflow();
    const renamed = workflowDefinitionSchema.parse({
      ...first,
      metadata: { ...first.metadata, name: "Renamed", description: "Presentation only" },
    });
    expect(workflowApprovalHash(renamed)).toBe(workflowApprovalHash(first));
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

  it("classifies read, write, and external workflows into increasing risk tiers", () => {
    expect(evaluateWorkflowPolicy(workflow()).riskTier).toBe("T0");
    const write = workflow({
      steps: [{ id: "write", kind: "anytype.write" }],
      capabilities: ["anytype.write"],
    });
    expect(evaluateWorkflowPolicy(write)).toMatchObject({ riskTier: "T1", approvalRequired: true });
    const external = workflow({
      steps: [{ id: "send", kind: "http", config: { url: "https://example.com" } }],
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
      maximumRiskTier: "T1" as const,
      limits: {
        maximumConcurrentRuns: 2,
        maximumStepsPerRun: 20,
        maximumEffectsPerRun: 5,
        maximumRunSeconds: 600,
        maximumCausalDepth: 4,
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
  });
});
