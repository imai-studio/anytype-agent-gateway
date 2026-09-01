import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkflowPolicy, workflowAuthorityHash } from "../src/automation/policy.js";
import { WorkflowRunner } from "../src/automation/runner.js";
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
  type WorkflowDefinition,
} from "../src/automation/workflow.js";
import { configSchema, type AgentConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runnerConfig(overrides: Record<string, unknown> = {}): AgentConfig["automation"] {
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
      allowedCapabilities: [],
      maximumRiskTier: "T0",
      runner: {
        pollIntervalMilliseconds: 50,
        leaseSeconds: 5,
        workerCount: 1,
        batchSize: 100,
      },
      ...overrides,
    },
  }).automation;
}

function workflow(
  name = "Workflow one",
  overrides: Partial<WorkflowDefinition["spec"]> = {},
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name },
    spec: {
      enabled: true,
      triggers: [{ kind: "manual" }],
      steps: [{ id: "noop", kind: "transform" }],
      capabilities: [],
      retry: {
        attempts: 2,
        initialDelaySeconds: 1,
        maximumDelaySeconds: 2,
        multiplier: 2,
      },
      ...overrides,
    },
  });
}

function saveVersion(
  store: Store,
  definition: WorkflowDefinition,
  workflowId = "workflow-1",
  objectId = `object-${workflowId}`,
) {
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: "space-1" });
  return store.saveWorkflowVersion({
    workflowId,
    spaceId: "space-1",
    objectId,
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
}

function recordEvent(store: Store, workflowId: string, overrides: Record<string, unknown> = {}) {
  return store.recordNormalizedEvent({
    eventId: `event-${workflowId}-${String(overrides.eventSuffix ?? "1")}`,
    dedupeKey: `dedupe-${workflowId}-${String(overrides.eventSuffix ?? "1")}`,
    kind: "manual.run",
    source: "manual",
    spaceId: "space-1",
    editor: {
      principalDigest: workflowPrincipalDigest("operator"),
      provenance: "operator-cli",
    },
    observedAt: Number(overrides.recordedAt ?? 300),
    recordedAt: Number(overrides.recordedAt ?? 300),
    causalDepth: 0,
    payload: { workflowId, ...(overrides.payload as Record<string, string> | undefined) },
  });
}

function approve(
  store: Store,
  config: AgentConfig["automation"],
  version: ReturnType<typeof saveVersion>,
) {
  const authorityHash = workflowAuthorityHash(config);
  store.recordWorkflowApproval({
    decisionId: `approval-${version.workflowId}`,
    workflowId: version.workflowId,
    approvalHash: version.approvalHash,
    decision: "approved",
    mode: "automatic",
    authorityHash,
    actorPrincipalDigest: version.editorPrincipalDigest!,
    decidedAt: 300,
  });
  return authorityHash;
}

function delivery(
  queue: WorkflowQueue,
  store: Store,
  config: AgentConfig["automation"],
  definition: WorkflowDefinition,
  workflowId: string,
  now = 300,
) {
  const version = saveVersion(store, definition, workflowId);
  const event = recordEvent(store, workflowId);
  const authorityHash = approve(store, config, version);
  const created = queue.createDelivery(
    {
      deliveryId: `delivery-${workflowId}`,
      workflowId,
      versionHash: version.versionHash,
      eventId: event.eventId,
      eventDedupeKey: event.dedupeKey,
      approvalHash: version.approvalHash,
      authorityHash,
      actorPrincipalDigest: version.editorPrincipalDigest!,
      actorProvenance: version.editorProvenance!,
    },
    now,
  );
  return queue.dispatchDelivery(
    created.deliveryId,
    definition,
    { maximumConcurrentRuns: 4, maximumRunsPerHour: 60 },
    authorityHash,
    now,
  )!;
}

describe("durable workflow runner", () => {
  it("baselines existing events the first time execution is enabled", async () => {
    const store = new Store(":memory:");
    const version = saveVersion(store, workflow());
    recordEvent(store, version.workflowId);
    const runner = new WorkflowRunner(
      store,
      runnerConfig(),
      () => {},
      undefined,
      () => 500,
    );

    await runner.tickOnce();

    expect(runner.queue.cursor()).toMatchObject({
      initialized: true,
      recordedAt: 300,
      eventId: "event-workflow-1-1",
    });
    expect(runner.queue.counts().deliveries).toBe(0);
    store.close();
  });

  it("matches once, preserves actor provenance, and completes safe no-op steps", async () => {
    const store = new Store(":memory:");
    const definition = workflow();
    const version = saveVersion(store, definition);
    const runner = new WorkflowRunner(
      store,
      runnerConfig(),
      () => {},
      undefined,
      () => 500,
    );

    await runner.tickOnce();
    recordEvent(store, version.workflowId);
    await runner.tickOnce();

    expect(runner.queue.counts()).toEqual({
      deliveries: 1,
      runs: 1,
      readySteps: 0,
      activeLeases: 0,
      deadLetters: 0,
    });
    const run =
      runner.queue.activeRuns()[0] ??
      (store.db.prepare("SELECT run_id FROM workflow_runs").get() as { run_id: string });
    const stored = "runId" in run ? run : runner.queue.run(run.run_id)!;
    expect(stored).toMatchObject({
      state: "succeeded",
      actorPrincipalDigest: workflowPrincipalDigest("operator"),
      actorProvenance: "operator-cli",
    });
    expect(runner.queue.steps(stored.runId)[0]).toMatchObject({
      state: "succeeded",
      result: { kind: "no-op", stepId: "noop" },
    });
    store.close();
  });

  it("ignores workflow-definition control-plane events", () => {
    const store = new Store(":memory:");
    const definition = workflow("Object workflow", {
      triggers: [{ kind: "anytype.event", events: ["updated"], filter: {} }],
    });
    saveVersion(store, definition);
    const runner = new WorkflowRunner(
      store,
      runnerConfig(),
      () => {},
      undefined,
      () => 500,
    );
    runner.queue.initializeMatcher(250);
    store.recordNormalizedEvent({
      eventId: "event-control",
      dedupeKey: "dedupe-control",
      kind: "object.updated",
      source: "poll",
      spaceId: "space-1",
      observedAt: 300,
      recordedAt: 300,
      causalDepth: 0,
      payload: { controlPlane: "workflow-definition" },
    });

    expect(runner.matchEventsOnce()).toBe(0);
    expect(runner.queue.counts().deliveries).toBe(0);
    store.close();
  });

  it("holds T1 deliveries until an exact authority-bound approval exists", () => {
    const config = runnerConfig({
      allowedCapabilities: ["anytype.write"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Write", {
      steps: [
        {
          id: "write",
          kind: "anytype.write",
          dependsOn: [],
          config: { operation: "update", bulk: false, values: {} },
        },
      ],
      capabilities: ["anytype.write"],
    });
    const version = saveVersion(store, definition);
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
    );
    runner.queue.initializeMatcher(250);
    recordEvent(store, version.workflowId);

    expect(runner.matchEventsOnce(500)).toBe(1);
    expect(runner.dispatchOnce(500)).toBe(0);
    expect(runner.queue.pendingDeliveries(10)).toHaveLength(1);
    store.recordWorkflowApproval({
      decisionId: "manual-write-approval",
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "approved",
      mode: "manual",
      authorityHash: workflowAuthorityHash(config),
      actorPrincipalDigest: workflowPrincipalDigest("operator"),
      decidedAt: 501,
    });
    expect(runner.dispatchOnce(502)).toBe(1);
    expect(runner.queue.counts().runs).toBe(1);
    store.close();
  });

  it("claims fairly across two workflows", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const runA = delivery(queue, store, config, workflow("A"), "workflow-a");
    const runB = delivery(queue, store, config, workflow("B"), "workflow-b");
    const hashes = new Set([runA.authorityHash, runB.authorityHash]);

    const first = queue.claimStep("worker-a", hashes, 5_000, 500)!;
    const second = queue.claimStep("worker-b", hashes, 5_000, 500)!;

    expect(first.run.workflowId).not.toBe(second.run.workflowId);
    store.close();
  });

  it("recovers an expired lease after restart and rejects the stale fence", () => {
    const directory = mkdtempSync(join(tmpdir(), "knot-runner-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const config = runnerConfig();
    let store = new Store(path);
    let queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, workflow(), "workflow-restart", 300);
    const hashes = new Set([run.authorityHash]);
    const stale = queue.claimStep("worker-stale", hashes, 5_000, 500)!;
    expect(queue.startStep(run.runId, "noop", stale.attempt.fencingToken, 501)).toBe(true);
    store.close();

    store = new Store(path);
    queue = new WorkflowQueue(store);
    expect(queue.recoverExpiredLeases(() => workflow().spec.retry, 5_501)).toBe(1);
    const current = queue.claimStep("worker-current", hashes, 5_000, 6_501)!;
    expect(current.attempt.fencingToken).not.toBe(stale.attempt.fencingToken);
    expect(
      queue.completeStep(run.runId, "noop", stale.attempt.fencingToken, { stale: true }, 6_502),
    ).toBe(false);
    expect(
      queue.completeStep(run.runId, "noop", current.attempt.fencingToken, { current: true }, 6_502),
    ).toBe(true);
    expect(queue.run(run.runId)?.state).toBe("succeeded");
    expect(queue.attempts(run.runId, "noop").map((attempt) => attempt.state)).toEqual([
      "retry",
      "succeeded",
    ]);
    store.close();
  });

  it("bounds heartbeat extensions by the step timeout", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const definition = workflow("Timeout", {
      steps: [{ id: "noop", kind: "transform", dependsOn: [], timeoutSeconds: 2 }],
      budget: {
        maximumRunsPerHour: 60,
        maximumStepsPerRun: 100,
        maximumEffectsPerRun: 20,
        maximumRunSeconds: 10,
      },
    });
    const run = delivery(queue, store, config, definition, "workflow-timeout", 300);
    const claim = queue.claimStep("worker", new Set([run.authorityHash]), 5_000, 500)!;

    expect(claim.step.leaseExpiresAt).toBe(2_500);
    expect(claim.step.leaseHardExpiresAt).toBe(2_500);
    expect(queue.heartbeat(run.runId, "noop", claim.attempt.fencingToken, 5_000, 1_000)).toBe(true);
    expect(queue.steps(run.runId)[0]?.leaseExpiresAt).toBe(2_500);
    expect(queue.recoverExpiredLeases(() => definition.spec.retry, 2_500)).toBe(1);
    store.close();
  });

  it("uses durable retry deadlines and dead-letters exhausted attempts", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const definition = workflow();
    const run = delivery(queue, store, config, definition, "workflow-retry");
    const hashes = new Set([run.authorityHash]);
    const first = queue.claimStep("worker-1", hashes, 5_000, 500)!;
    expect(queue.startStep(run.runId, "noop", first.attempt.fencingToken, 501)).toBe(true);
    expect(
      queue.failStep(
        run.runId,
        "noop",
        first.attempt.fencingToken,
        "temporary",
        definition.spec.retry,
        true,
        600,
      ),
    ).toBe(true);
    expect(queue.claimStep("too-early", hashes, 5_000, 1_599)).toBeUndefined();
    const second = queue.claimStep("worker-2", hashes, 5_000, 1_600)!;
    expect(queue.startStep(run.runId, "noop", second.attempt.fencingToken, 1_601)).toBe(true);
    queue.failStep(
      run.runId,
      "noop",
      second.attempt.fencingToken,
      "still failing",
      definition.spec.retry,
      true,
      1_700,
    );

    expect(queue.run(run.runId)).toMatchObject({ state: "dead_letter", error: "still failing" });
    expect(queue.attempts(run.runId, "noop").map((attempt) => attempt.state)).toEqual([
      "retry",
      "dead_letter",
    ]);
    store.close();
  });

  it("records cooperative cancellation and waits for an active claim to stop", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, workflow(), "workflow-cancel");
    const claim = queue.claimStep("worker", new Set([run.authorityHash]), 5_000, 500)!;
    queue.startStep(run.runId, "noop", claim.attempt.fencingToken, 501);

    expect(
      queue.cancelRun(run.runId, workflowPrincipalDigest("operator"), "operator request", 600),
    ).toBe(true);
    expect(queue.run(run.runId)).toMatchObject({
      state: "running",
      cancelReason: "operator request",
    });
    expect(
      queue.completeStep(run.runId, "noop", claim.attempt.fencingToken, { ignored: true }, 700),
    ).toBe(true);
    expect(queue.run(run.runId)?.state).toBe("cancelled");
    store.close();
  });

  it("pauses queued work when current local authority narrows", async () => {
    const original = runnerConfig({
      allowedCapabilities: ["anytype.write"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Authority", {
      steps: [
        {
          id: "write",
          kind: "anytype.write",
          dependsOn: [],
          config: { operation: "update", bulk: false, values: {} },
        },
      ],
      capabilities: ["anytype.write"],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, original, definition, "workflow-authority");
    const narrowed = runnerConfig();
    const runner = new WorkflowRunner(
      store,
      narrowed,
      () => {},
      undefined,
      () => 500,
    );

    await runner.tickOnce();

    expect(queue.run(run.runId)).toMatchObject({
      state: "waiting",
      error: "Current local authority does not permit this run",
    });
    expect(queue.steps(run.runId)[0]?.state).toBe("waiting_approval");
    store.close();
  });

  it("keeps unsupported effect steps behind the disabled executor boundary", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["anytype.read"],
    });
    const store = new Store(":memory:");
    const definition = workflow("Read", {
      steps: [{ id: "read", kind: "anytype.read", dependsOn: [], config: {} }],
      capabilities: ["anytype.read"],
    });
    const version = saveVersion(store, definition);
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
    );

    await runner.tickOnce();
    recordEvent(store, version.workflowId);
    await runner.tickOnce();

    expect(runner.queue.counts().deadLetters).toBe(1);
    const row = store.db.prepare("SELECT error FROM workflow_runs").get() as { error: string };
    expect(row.error).toContain("No effect executor is installed");
    store.close();
  });
});
