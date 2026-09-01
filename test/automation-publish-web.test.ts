import { describe, expect, it, vi } from "vitest";
import { PublishWebWorkflowStepExecutor } from "../src/automation/publish-web.js";
import { AnytypeWorkflowSourceResolver } from "../src/automation/observer.js";
import { workflowAuthorityHash, evaluateWorkflowPolicy } from "../src/automation/policy.js";
import type { WorkflowStepExecutor } from "../src/automation/runner.js";
import type { WorkflowClaim } from "../src/automation/runner-store.js";
import {
  canonicalStoredWorkflowApproval,
  canonicalStoredWorkflowDefinition,
  canonicalJson,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowSourceDigest,
  workflowVersionHash,
  type WorkflowDefinition,
} from "../src/automation/workflow.js";
import { configSchema } from "../src/config.js";
import type { PublicationOperation } from "../src/cloud-publication-outbox.js";
import type { AnytypePort } from "../src/types.js";
import { Store } from "../src/store.js";

const siteId = "00000000-0000-4000-8000-000000000022";
const publicationId = "00000000-0000-4000-8000-000000000033";

function config() {
  return configSchema.parse({
    version: 1,
    agent: { name: "Knot", participantId: "agent" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex" },
    automation: {
      enabled: true,
      observation: true,
      execution: true,
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: ["publish.web"],
      allowedConnections: ["website"],
      maximumRiskTier: "T2",
      publishConnections: {
        website: {
          cloudConfigFile: "/operator/cloud.json",
          allowedSiteIds: [siteId],
          allowedSlugPrefixes: ["notes/"],
          allowUpdate: true,
        },
      },
    },
  }).automation;
}

function workflow(text = "Private body"): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name: "Publish" },
    spec: {
      enabled: true,
      triggers: [{ kind: "manual" }],
      capabilities: ["publish.web"],
      steps: [
        {
          id: "publish",
          kind: "publish.web",
          config: {
            action: "create",
            connectionRef: "website",
            siteId,
            publicationId,
            slug: "notes/private",
            document: {
              schemaVersion: "1.0",
              title: "Private title",
              description: "Private description",
              blocks: [
                {
                  type: "paragraph",
                  content: [{ text, href: "https://private.example/path", marks: ["bold"] }],
                },
              ],
            },
          },
        },
      ],
    },
  });
}

function claim(definition: WorkflowDefinition, authorityHash: string): WorkflowClaim {
  return {
    run: {
      runId: "run-1",
      deliveryId: "delivery-1",
      workflowId: "workflow-1",
      versionHash: "sha256:" + "1".repeat(64),
      approvalHash: workflowApprovalHash(definition),
      authorityHash,
      actorPrincipalDigest: "sha256:" + "2".repeat(64),
      actorProvenance: "operator-cli",
      state: "running",
      createdAt: 1,
      updatedAt: 1,
    },
    step: {
      runId: "run-1",
      workflowId: "workflow-1",
      stepId: "publish",
      position: 0,
      kind: "publish.web",
      state: "running",
      dependencies: [],
      timeoutSeconds: 30,
      runDeadlineAt: 30_000,
      attemptCount: 1,
      availableAt: 1,
      authorityHash,
      updatedAt: 1,
    },
    attempt: {
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "publish",
      attemptNumber: 1,
      workerId: "worker",
      fencingToken: "fence",
      state: "running",
      startedAt: 1,
    },
  };
}

const fallback: WorkflowStepExecutor = {
  async execute() {
    return { ok: false, error: "unexpected fallback", retryable: false };
  },
};

function operation(state: PublicationOperation["state"]): PublicationOperation {
  return {
    operationId: "00000000-0000-4000-8000-000000000099",
    idempotencyKey: "knot-test-idempotency-key",
    publicationId,
    kind: "push",
    state,
    attempt: 1,
    availableAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("publish.web workflow effect", () => {
  it("is T2, requires its declared capability, and rejects an open transport shape", () => {
    const definition = workflow();
    expect(evaluateWorkflowPolicy(definition)).toMatchObject({
      riskTier: "T2",
      approvalRequired: true,
      missingCapabilities: [],
    });
    const raw = JSON.parse(JSON.stringify(definition));
    raw.spec.steps[0].config.baseUrl = "https://attacker.example";
    expect(() => workflowDefinitionSchema.parse(raw)).toThrow();
    delete raw.spec.steps[0].config.baseUrl;
    raw.spec.steps[0].config.document.blocks[0] = {
      type: "html",
      html: "<script>steal()</script>",
    };
    expect(() => workflowDefinitionSchema.parse(raw)).toThrow();
    const destructive = JSON.parse(JSON.stringify(definition));
    destructive.spec.steps[0].config = {
      action: "unpublish",
      connectionRef: "website",
      publicationId,
      confirmation: "00000000-0000-4000-8000-000000000044",
    };
    expect(() => workflowDefinitionSchema.parse(destructive)).toThrow(
      "confirmation must equal publicationId",
    );
  });

  it("refuses automatic approval and accepts only an explicit manual T2 decision", () => {
    const definition = workflow();
    const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: "space-1" });
    const store = new Store(":memory:");
    const version = store.saveWorkflowVersion({
      workflowId: "workflow-publish",
      spaceId: "space-1",
      objectId: "object-publish",
      name: definition.metadata.name,
      versionHash: workflowVersionHash(definition),
      approvalHash: workflowApprovalHash(definition),
      schemaVersion: 1,
      canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
      canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
      sourceDigest: workflowSourceDigest(canonicalWorkflowDefinition(definition)),
      riskTier: policy.riskTier,
      requiredCapabilities: policy.requiredCapabilities,
      sourceModifiedAt: 10,
      editorPrincipalDigest: "sha256:" + "a".repeat(64),
      editorProvenance: "anytype-native",
      createdAt: 10,
    });
    const decision = {
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "approved" as const,
      authorityHash: workflowAuthorityHash(config()),
      actorPrincipalDigest: version.editorPrincipalDigest!,
      decidedAt: 11,
    };
    expect(() =>
      store.recordWorkflowApproval({
        ...decision,
        decisionId: "automatic-publish",
        mode: "automatic",
      }),
    ).toThrow("explicit manual approval");
    expect(
      store.recordWorkflowApproval({
        ...decision,
        decisionId: "manual-publish",
        mode: "manual",
      }),
    ).toMatchObject({ decision: "approved", mode: "manual" });
    store.close();
  });

  it("recursively redacts publication text while preserving exact approval sensitivity", () => {
    const definition = workflow();
    const storedDefinition = canonicalStoredWorkflowDefinition(definition);
    const storedApproval = canonicalStoredWorkflowApproval(definition);
    for (const secret of [
      "Private title",
      "Private description",
      "Private body",
      "https://private.example/path",
    ]) {
      expect(storedDefinition).not.toContain(secret);
      expect(storedApproval).not.toContain(secret);
    }
    expect(storedDefinition).toContain('"redacted":true');
    expect(workflowApprovalHash(workflow("Changed body"))).not.toBe(
      workflowApprovalHash(definition),
    );
  });

  it("maps only the approved lifecycle request into the named operator connection", async () => {
    const authority = config();
    const definition = workflow();
    const effect = vi.fn(async (_input: unknown, _context?: unknown) => operation("succeeded"));
    const executor = new PublishWebWorkflowStepExecutor(authority, fallback, effect);
    const result = await executor.execute(
      claim(definition, workflowAuthorityHash(authority)),
      definition,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ ok: true, result: { publicationId, state: "succeeded" } });
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "push",
        operation: "create",
        configFile: "/operator/cloud.json",
        policy: expect.objectContaining({ allowedSiteIds: [siteId], allowUpdate: true }),
      }),
      { workerId: "workflow:attempt-1" },
    );
    expect(effect.mock.calls[0]?.[0]).not.toHaveProperty("baseUrl");
    expect(effect.mock.calls[0]?.[0]).not.toHaveProperty("headers");
  });

  it("rechecks exact approval and current local authority before any effect", async () => {
    const authority = config();
    const definition = workflow();
    const effect = vi.fn(async (_input: unknown, _context?: unknown) => operation("succeeded"));
    const executor = new PublishWebWorkflowStepExecutor(authority, fallback, effect);
    const staleApproval = claim(definition, workflowAuthorityHash(authority));
    staleApproval.run.approvalHash = "sha256:" + "9".repeat(64);
    expect(
      await executor.execute(staleApproval, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: expect.stringContaining("approval hash") });

    const staleAuthority = claim(definition, "sha256:" + "8".repeat(64));
    expect(
      await executor.execute(staleAuthority, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: expect.stringContaining("authority changed") });
    expect(effect).not.toHaveBeenCalled();
  });

  it("uses a durable receipt as the replay boundary and retries pending outbox work", async () => {
    const authority = config();
    const definition = workflow();
    const receipt = operation("retrying");
    receipt.lastErrorCode = "dependency-unavailable";
    const effect = vi.fn(async (_input: unknown, _context?: unknown) => receipt);
    const executor = new PublishWebWorkflowStepExecutor(authority, fallback, effect);
    const result = await executor.execute(
      claim(definition, workflowAuthorityHash(authority)),
      definition,
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      error: "dependency-unavailable",
      retryable: true,
    });
  });

  it("refetches the exact native Anytype source revision before redacted text executes", async () => {
    const definition = workflow();
    const source = `\`\`\`yaml\n${JSON.stringify(definition)}\n\`\`\``;
    const searchWorkflowObjects = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "other",
          name: "Other",
          typeKey: "knot-workflow",
          source,
          modifiedAt: 10,
          editorParticipantId: "operator",
          archived: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "object-1",
          name: "Publish",
          typeKey: "knot-workflow",
          source,
          modifiedAt: 10,
          editorParticipantId: "operator",
          archived: false,
        },
      ]);
    const resolver = new AnytypeWorkflowSourceResolver(
      { searchWorkflowObjects } as unknown as AnytypePort,
      ["knot-workflow"],
      1,
    );
    await expect(
      resolver.refetch(
        {
          workflowId: "workflow-1",
          name: "Publish",
          versionHash: "sha256:" + "1".repeat(64),
          approvalHash: workflowApprovalHash(definition),
          riskTier: "T2",
          requiredCapabilities: ["publish.web"],
          storedDefinitionJson: canonicalStoredWorkflowDefinition(definition),
          storedApprovalJson: canonicalStoredWorkflowApproval(definition),
          sourceDigest: "sha256:" + "2".repeat(64),
          sourceModifiedAt: 10,
          spaceId: "space-1",
          objectId: "object-1",
          schemaVersion: 1,
          createdAt: 10,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      definitionSource: JSON.stringify(definition),
      sourceModifiedAt: 10,
      editorParticipantId: "operator",
      editorProvenance: "anytype-native",
    });
    expect(searchWorkflowObjects).toHaveBeenCalledTimes(2);
  });
});
