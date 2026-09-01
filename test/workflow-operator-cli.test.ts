import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkflowPolicy, workflowAuthorityHash } from "../src/automation/policy.js";
import { WorkflowQueue } from "../src/automation/runner-store.js";
import {
  canonicalJson,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowPrincipalDigest,
  workflowSourceDigest,
  workflowVersionHash,
} from "../src/automation/workflow.js";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import {
  workflowApprovalAction,
  workflowAuditList,
  workflowEventList,
  workflowManualRun,
  workflowRunMutation,
  workflowRunShow,
  workflowSetEnabled,
} from "../src/workflow-operator-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "knot-workflow-operator-"));
  temporaryDirectories.push(directory);
  const statePath = join(directory, "state.sqlite");
  const configPath = join(directory, "agent.json");
  const raw = {
    version: 1,
    agent: { name: "Knot", participantId: "agent" },
    anytype: { apiKeyFile: join(directory, "anytype.key") },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex" },
    automation: {
      enabled: true,
      observation: true,
      execution: true,
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: [],
      maximumRiskTier: "T0",
    },
    state: { path: statePath },
  };
  writeFileSync(configPath, JSON.stringify(raw));
  const config = configSchema.parse(raw);
  const definition = workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name: "Operator test" },
    spec: {
      triggers: [{ kind: "manual" }],
      steps: [{ id: "shape", kind: "transform" }],
      capabilities: [],
      retry: {
        attempts: 1,
        initialDelaySeconds: 1,
        maximumDelaySeconds: 1,
        multiplier: 1,
      },
    },
  });
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: "space-1" });
  const store = new Store(statePath);
  const version = store.saveWorkflowVersion({
    workflowId: "workflow-1",
    spaceId: "space-1",
    objectId: "workflow-object-1",
    name: definition.metadata.name,
    versionHash: workflowVersionHash(definition),
    approvalHash: workflowApprovalHash(definition),
    schemaVersion: 1,
    canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
    canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
    sourceDigest: workflowSourceDigest(canonicalWorkflowDefinition(definition)),
    riskTier: policy.riskTier,
    requiredCapabilities: policy.requiredCapabilities,
    sourceModifiedAt: 100,
    editorPrincipalDigest: workflowPrincipalDigest("operator"),
    editorProvenance: "anytype-native",
    createdAt: 200,
  });
  store.close();
  return { configPath, statePath, config, definition, version };
}

function lines() {
  const output: string[] = [];
  return { output, write: (line: string) => output.push(line) };
}

describe("workflow operator CLI", () => {
  it("requires an exact allowlisted actor and confirmation and audits durable controls", async () => {
    const state = setup();
    await expect(
      workflowApprovalAction({
        agentConfigFile: state.configPath,
        workflowId: "workflow-1",
        approvalHash: state.version.approvalHash,
        actorDigest: workflowPrincipalDigest("intruder"),
        action: "approve",
        yes: true,
        now: 300,
      }),
    ).rejects.toThrow("does not match automation.allowedAuthorIds");
    await expect(
      workflowApprovalAction({
        agentConfigFile: state.configPath,
        workflowId: "workflow-1",
        approvalHash: state.version.approvalHash,
        action: "approve",
        yes: false,
        now: 300,
      }),
    ).rejects.toThrow("--yes");

    await workflowApprovalAction({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      action: "approve",
      yes: true,
      now: 300,
    });
    await workflowManualRun({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      yes: true,
      now: 400,
    });
    const runStore = new Store(state.statePath);
    const runQueue = new WorkflowQueue(runStore);
    const event = runQueue.recentEvents(1)[0]!;
    const authorityHash = workflowAuthorityHash(state.config.automation);
    const delivery = runQueue.createDelivery(
      {
        deliveryId: "delivery-cancel",
        workflowId: "workflow-1",
        versionHash: state.version.versionHash,
        eventId: event.eventId,
        eventDedupeKey: event.dedupeKey,
        approvalHash: state.version.approvalHash,
        authorityHash,
        actorPrincipalDigest: workflowPrincipalDigest("operator"),
        actorProvenance: "operator-cli",
      },
      425,
    );
    const run = runQueue.dispatchDelivery(
      delivery.deliveryId,
      state.definition,
      { maximumConcurrentRuns: 4, maximumRunsPerHour: 60 },
      authorityHash,
      425,
    )!;
    runStore.close();
    await workflowRunMutation({
      agentConfigFile: state.configPath,
      runId: run.runId,
      action: "cancel",
      reasonCode: "operator-cancel",
      yes: true,
      now: 450,
    });
    await workflowSetEnabled({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      reasonCode: "maintenance",
      enabled: false,
      yes: true,
      now: 500,
    });
    await workflowApprovalAction({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      action: "revoke",
      reasonCode: "operator-revoked",
      yes: true,
      now: 550,
    });
    await workflowApprovalAction({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      action: "approve",
      yes: true,
      now: 600,
    });
    await workflowApprovalAction({
      agentConfigFile: state.configPath,
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      action: "reject",
      reasonCode: "operator-rejected",
      yes: true,
      now: 650,
    });

    const store = new Store(state.statePath);
    expect(new WorkflowQueue(store).activeWorkflowVersions()).toEqual([]);
    expect(store.workflowOperatorOverride("workflow-1")).toMatchObject({ enabled: false });
    expect(
      store
        .workflowOperatorAudits()
        .map((record) => record.action)
        .sort(),
    ).toEqual(
      [
        "run.cancel",
        "workflow.approve",
        "workflow.approve",
        "workflow.disable",
        "workflow.manual_run",
        "workflow.reject",
        "workflow.revoke",
      ].sort(),
    );
    expect(
      store.db.prepare("SELECT kind FROM normalized_events WHERE source='manual'").get(),
    ).toEqual({ kind: "manual.run" });
    store.close();

    const audit = lines();
    await workflowAuditList({
      agentConfigFile: state.configPath,
      json: true,
      output: audit.write,
    });
    expect(audit.output.join("\n")).not.toContain('operator"');
    expect(audit.output.join("\n")).toContain("workflow.disable");
  });

  it("redacts event/run contents and retries only when effect receipts prove safe", async () => {
    const state = setup();
    const store = new Store(state.statePath);
    const queue = new WorkflowQueue(store);
    const authorityHash = workflowAuthorityHash(state.config.automation);
    store.recordWorkflowApproval({
      decisionId: "approval-1",
      workflowId: "workflow-1",
      approvalHash: state.version.approvalHash,
      decision: "approved",
      mode: "manual",
      authorityHash,
      actorPrincipalDigest: workflowPrincipalDigest("operator"),
      decidedAt: 300,
    });
    const event = store.recordNormalizedEvent({
      eventId: "event-secret",
      dedupeKey: "event-secret",
      kind: "manual.run",
      source: "manual",
      spaceId: "space-1",
      observedAt: 400,
      payload: { workflowId: "workflow-1", secret: "never-print-this" },
      causalDepth: 0,
      recordedAt: 400,
    });
    const delivery = queue.createDelivery(
      {
        deliveryId: "delivery-1",
        workflowId: "workflow-1",
        versionHash: state.version.versionHash,
        eventId: event.eventId,
        eventDedupeKey: event.dedupeKey,
        approvalHash: state.version.approvalHash,
        authorityHash,
        actorPrincipalDigest: workflowPrincipalDigest("operator"),
        actorProvenance: "operator-cli",
      },
      400,
    );
    const run = queue.dispatchDelivery(
      delivery.deliveryId,
      state.definition,
      { maximumConcurrentRuns: 4, maximumRunsPerHour: 60 },
      authorityHash,
      400,
    )!;
    const claim = queue.claimStep("worker", new Set([authorityHash]), 5_000, 500)!;
    queue.startStep(run.runId, "shape", claim.attempt.fencingToken, 501);
    queue.failStep(
      run.runId,
      "shape",
      claim.attempt.fencingToken,
      "raw terminal failure",
      state.definition.spec.retry,
      true,
      600,
    );
    store.db
      .prepare(
        `INSERT INTO workflow_effect_receipts(
        effect_key,run_id,step_id,operation_digest,state,fencing_token,updated_at
      ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        "effect-1",
        run.runId,
        "shape",
        `sha256:${"a".repeat(64)}`,
        "outcome_unknown",
        "token",
        600,
      );
    store.close();

    await expect(
      workflowRunMutation({
        agentConfigFile: state.configPath,
        runId: run.runId,
        action: "retry",
        reasonCode: "operator-retry",
        yes: true,
        now: 700,
      }),
    ).rejects.toThrow("not safely retryable");

    const reconciled = new Store(state.statePath);
    reconciled.db
      .prepare("UPDATE workflow_effect_receipts SET state='failed',updated_at=? WHERE effect_key=?")
      .run(701, "effect-1");
    reconciled.close();
    await workflowRunMutation({
      agentConfigFile: state.configPath,
      runId: run.runId,
      action: "retry",
      reasonCode: "operator-retry",
      yes: true,
      now: 800,
    });

    const shown = lines();
    await workflowRunShow({
      agentConfigFile: state.configPath,
      runId: run.runId,
      output: shown.write,
    });
    expect(shown.output.join("\n")).not.toContain("raw terminal failure");
    const events = lines();
    await workflowEventList({
      agentConfigFile: state.configPath,
      json: true,
      output: events.write,
    });
    expect(events.output.join("\n")).not.toContain("never-print-this");
    expect(events.output.join("\n")).toContain("payloadDigest");

    const finalStore = new Store(state.statePath);
    const finalQueue = new WorkflowQueue(finalStore);
    expect(finalQueue.run(run.runId)).toMatchObject({ state: "pending" });
    expect(
      finalQueue.claimStep("worker-after-retry", new Set([authorityHash]), 5_000, 900),
    ).toMatchObject({ attempt: { attemptNumber: 2 } });
    expect(finalStore.workflowOperatorAudits().some((audit) => audit.action === "run.retry")).toBe(
      true,
    );
    finalStore.close();
  });
});
