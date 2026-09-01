import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateWorkflowPolicy, workflowAuthorityHash } from "../src/automation/policy.js";
import {
  WorkflowRunner,
  type WorkflowSourceResolver,
  type WorkflowStepExecutor,
} from "../src/automation/runner.js";
import { WorkflowQueue } from "../src/automation/runner-store.js";
import {
  canonicalJson,
  canonicalStoredWorkflowDefinition,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowPrincipalDigest,
  workflowSourceDigest,
  workflowVersionHash,
  type JsonValue,
  type WorkflowDefinition,
} from "../src/automation/workflow.js";
import { configSchema, type AgentConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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
  it("dead-letters a delivery whose static effect graph exceeds the local effect budget", () => {
    const store = new Store(":memory:");
    const config = runnerConfig({
      allowedCapabilities: ["anytype.write", "notify"],
      allowedConnections: ["team"],
      maximumRiskTier: "T2",
    });
    const queue = new WorkflowQueue(store);
    const definition = workflow("Too many effects", {
      steps: [
        {
          id: "write",
          kind: "anytype.write",
          dependsOn: [],
          config: {
            operation: "create",
            bulk: false,
            values: { typeKey: "page", properties: [] },
          },
        },
        {
          id: "notify",
          kind: "notify",
          dependsOn: [],
          config: { connectionRef: "team", message: "done" },
        },
      ],
      capabilities: ["anytype.write", "notify"],
    });
    const version = saveVersion(store, definition, "workflow-effect-budget");
    const event = recordEvent(store, version.workflowId);
    const authorityHash = workflowAuthorityHash(config);
    store.recordWorkflowApproval({
      decisionId: "approval-workflow-effect-budget",
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "approved",
      mode: "manual",
      authorityHash,
      actorPrincipalDigest: version.editorPrincipalDigest!,
      decidedAt: 300,
    });
    const created = queue.createDelivery({
      deliveryId: "delivery-effect-budget",
      workflowId: version.workflowId,
      versionHash: version.versionHash,
      eventId: event.eventId,
      eventDedupeKey: event.dedupeKey,
      approvalHash: version.approvalHash,
      authorityHash,
      actorPrincipalDigest: version.editorPrincipalDigest!,
      actorProvenance: version.editorProvenance!,
    });

    expect(
      queue.dispatchDelivery(
        created.deliveryId,
        definition,
        {
          maximumConcurrentRuns: 4,
          maximumRunsPerHour: 60,
          maximumEffectsPerRun: 1,
        },
        authorityHash,
      ),
    ).toBeUndefined();
    expect(
      store.db
        .prepare("SELECT state FROM workflow_deliveries WHERE delivery_id=?")
        .get(created.deliveryId),
    ).toEqual({ state: "dead_letter" });
    store.close();
  });

  it("contains extension failures without stopping the workflow scheduler", async () => {
    const store = new Store(":memory:");
    const log = vi.fn();
    const afterTick = vi.fn();
    const runner = new WorkflowRunner(store, runnerConfig(), log, undefined, () => 500, undefined, [
      {
        beforeTick: async () => {
          throw new Error("cloud unavailable");
        },
        afterTick,
      },
    ]);

    await runner.tickOnce();

    expect(runner.queue.cursor()?.initialized).toBe(true);
    expect(afterTick).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("workflow_runner_extension_failed", {
      phase: "before_tick",
      error: "cloud unavailable",
    });
    store.close();
  });

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
      triggers: [{ kind: "anytype.event", spaceId: "space-1", events: ["updated"], filter: {} }],
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
      source: "workflow",
      spaceId: "space-1",
      observedAt: 300,
      recordedAt: 300,
      causalDepth: 0,
      payload: {},
    });

    expect(runner.matchEventsOnce()).toBe(0);
    expect(runner.queue.counts().deliveries).toBe(0);
    store.close();
  });

  it("does not let event payload spoof trusted control-plane classification", () => {
    const store = new Store(":memory:");
    const definition = workflow("Object workflow", {
      triggers: [{ kind: "anytype.event", spaceId: "space-1", events: ["updated"], filter: {} }],
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
      eventId: "event-spoofed-control",
      dedupeKey: "dedupe-spoofed-control",
      kind: "object.updated",
      source: "poll",
      spaceId: "space-1",
      objectId: "ordinary-object",
      editor: {
        principalDigest: workflowPrincipalDigest("operator"),
        provenance: "anytype-native",
      },
      observedAt: 300,
      recordedAt: 300,
      causalDepth: 0,
      payload: { controlPlane: "workflow-definition" },
    });

    expect(runner.matchEventsOnce()).toBe(1);
    expect(runner.queue.counts().deliveries).toBe(1);
    store.close();
  });

  it("atomically persists event deliveries with the matcher cursor", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const definition = workflow();
    const version = saveVersion(store, definition);
    const queue = new WorkflowQueue(store);
    const authorityHash = approve(store, config, version);
    queue.initializeMatcher(250);
    const event = recordEvent(store, version.workflowId);
    const input = {
      deliveryId: "delivery-atomic-good",
      workflowId: version.workflowId,
      versionHash: version.versionHash,
      eventId: event.eventId,
      eventDedupeKey: event.dedupeKey,
      approvalHash: version.approvalHash,
      authorityHash,
      actorPrincipalDigest: version.editorPrincipalDigest!,
      actorProvenance: version.editorProvenance!,
    };

    expect(() =>
      queue.createDeliveriesAndAdvanceCursor(
        event,
        [
          input,
          {
            ...input,
            deliveryId: "delivery-atomic-bad",
            eventId: "missing-event",
            eventDedupeKey: "missing-event",
          },
        ],
        500,
      ),
    ).toThrow();
    expect(queue.counts().deliveries).toBe(0);
    expect(queue.cursor()).toMatchObject({ recordedAt: 0, eventId: "" });
    store.close();
  });

  it("replays a pre-cursor delivery across an authority change without wedging", () => {
    const store = new Store(":memory:");
    const definition = workflow();
    const version = saveVersion(store, definition);
    const queue = new WorkflowQueue(store);
    queue.initializeMatcher(250);
    const event = recordEvent(store, version.workflowId);
    queue.createDelivery(
      {
        deliveryId: `delivery-${version.workflowId}-${version.versionHash}-${event.dedupeKey}`,
        workflowId: version.workflowId,
        versionHash: version.versionHash,
        eventId: event.eventId,
        eventDedupeKey: event.dedupeKey,
        approvalHash: version.approvalHash,
        authorityHash: "sha256:" + "a".repeat(64),
        actorPrincipalDigest: event.editor!.principalDigest,
        actorProvenance: event.editor!.provenance,
      },
      400,
    );
    const runner = new WorkflowRunner(
      store,
      runnerConfig(),
      () => {},
      undefined,
      () => 500,
    );

    expect(runner.matchEventsOnce(500)).toBe(1);
    expect(queue.cursor()).toMatchObject({ recordedAt: event.recordedAt, eventId: event.eventId });
    expect(queue.counts().deliveries).toBe(1);
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
          config: { operation: "update", bulk: false, values: { properties: [] } },
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
    expect(runner.queue.pendingDeliveries(10, 1_500)[0]).toMatchObject({
      approvalPending: true,
      dispatchAttemptCount: 0,
    });
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
    expect(runner.dispatchOnce(1_500)).toBe(1);
    expect(runner.queue.counts().runs).toBe(1);
    store.close();
  });

  it("defers unapproved deliveries so later approved work is not starved", () => {
    const config = runnerConfig({
      allowedCapabilities: ["anytype.write"],
      maximumRiskTier: "T1",
      runner: {
        pollIntervalMilliseconds: 50,
        leaseSeconds: 5,
        workerCount: 1,
        batchSize: 2,
      },
    });
    const store = new Store(":memory:");
    const queue = new WorkflowQueue(store);
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
    );
    const definition = workflow("Write", {
      steps: [
        {
          id: "write",
          kind: "anytype.write",
          dependsOn: [],
          config: { operation: "update", bulk: false, values: { properties: [] } },
        },
      ],
      capabilities: ["anytype.write"],
    });
    for (const [index, workflowId] of ["blocked-a", "blocked-b", "approved"].entries()) {
      const version = saveVersion(store, definition, workflowId);
      const event = recordEvent(store, workflowId);
      const authorityHash = workflowAuthorityHash(config);
      if (workflowId === "approved") approve(store, config, version);
      queue.createDelivery(
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
        100 + index,
      );
    }

    expect(runner.dispatchOnce(500)).toBe(0);
    expect(runner.dispatchOnce(501)).toBe(1);
    expect(queue.counts().runs).toBe(1);
    expect(queue.pendingDeliveries(10, 501).map((item) => item.workflowId)).toEqual([]);
    expect(
      queue
        .pendingDeliveries(10, 1_500)
        .map((item) => item.workflowId)
        .sort(),
    ).toEqual(["blocked-a", "blocked-b"]);
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

  it("bounds each expired-lease recovery scan", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const first = delivery(queue, store, config, workflow("First"), "workflow-recovery-a");
    const second = delivery(queue, store, config, workflow("Second"), "workflow-recovery-b");
    queue.claimStep("worker-a", new Set([first.authorityHash, second.authorityHash]), 1_000, 500);
    queue.claimStep("worker-b", new Set([first.authorityHash, second.authorityHash]), 1_000, 500);

    expect(queue.recoverExpiredLeases(() => workflow().spec.retry, 1_500, 1)).toBe(1);
    expect(queue.counts().activeLeases).toBe(1);
    expect(queue.recoverExpiredLeases(() => workflow().spec.retry, 1_500, 1)).toBe(1);
    expect(queue.counts().activeLeases).toBe(0);
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

  it("heartbeats a lease while an executor is still running", async () => {
    vi.useFakeTimers({ now: 500 });
    const store = new Store(":memory:");
    const definition = workflow();
    const version = saveVersion(store, definition);
    let finish: ((execution: { ok: true; result: null }) => void) | undefined;
    const executor: WorkflowStepExecutor = {
      execute: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const runner = new WorkflowRunner(store, runnerConfig(), () => {}, executor);
    await runner.tickOnce();
    recordEvent(store, version.workflowId);

    const pending = runner.tickOnce();
    await vi.advanceTimersByTimeAsync(1_700);
    const run = runner.queue.activeRuns()[0]!;
    expect(runner.queue.steps(run.runId)[0]?.leaseExpiresAt).toBeGreaterThan(5_500);
    finish!({ ok: true, result: null });
    await pending;
    await vi.waitFor(() => expect(runner.queue.run(run.runId)?.state).toBe("succeeded"));
    store.close();
  });

  it("aborts an executor at the lease hard deadline and durably retries the timeout", async () => {
    vi.useFakeTimers({ now: 500 });
    const store = new Store(":memory:");
    const config = runnerConfig();
    const definition = workflow("Timeout", {
      steps: [{ id: "noop", kind: "transform", dependsOn: [], timeoutSeconds: 1 }],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-executor-timeout");
    let aborted = false;
    const executor: WorkflowStepExecutor = {
      execute: async (_claim, _definition, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const runner = new WorkflowRunner(store, config, () => {}, executor);

    const pending = runner.tickOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(aborted).toBe(true);
    expect(queue.run(run.runId)?.state).toBe("waiting");
    expect(queue.steps(run.runId)[0]).toMatchObject({
      state: "waiting_retry",
      error: "Workflow step timed out before completion",
    });
    expect(queue.attempts(run.runId, "noop")[0]?.state).toBe("retry");
    store.close();
  });

  it("bounds source refetch by the claim deadline", async () => {
    vi.useFakeTimers({ now: 500 });
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent timeout", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          timeoutSeconds: 1,
          config: { prompt: "private" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-refetch-timeout");
    let aborted = false;
    const resolver: WorkflowSourceResolver = {
      refetch: async (_version, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const runner = new WorkflowRunner(store, config, () => {}, undefined, undefined, resolver);

    const pending = runner.tickOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(aborted).toBe(true);
    expect(queue.run(run.runId)?.state).toBe("waiting");
    expect(queue.steps(run.runId)[0]?.state).toBe("waiting_retry");
    store.close();
  });

  it("aborts active execution promptly on runner shutdown without inventing a result", async () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, workflow(), "workflow-shutdown");
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: WorkflowStepExecutor = {
      execute: async (_claim, _definition, signal) =>
        new Promise((_resolve, reject) => {
          started!();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );
    const shutdown = new AbortController();

    const pending = runner.tickOnce(shutdown.signal);
    await began;
    shutdown.abort(new Error("shutdown"));
    await pending;

    expect(queue.run(run.runId)?.state).toBe("running");
    expect(queue.steps(run.runId)[0]?.state).toBe("running");
    store.close();
  });

  it("uses configured worker slots concurrently", async () => {
    const config = runnerConfig({
      runner: {
        pollIntervalMilliseconds: 50,
        leaseSeconds: 5,
        workerCount: 2,
        batchSize: 100,
      },
    });
    const store = new Store(":memory:");
    const queue = new WorkflowQueue(store);
    const first = delivery(queue, store, config, workflow("First"), "workflow-concurrent-a");
    const second = delivery(queue, store, config, workflow("Second"), "workflow-concurrent-b");
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: WorkflowStepExecutor = {
      async execute() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 2) release!();
        await gate;
        active -= 1;
        return { ok: true, result: null };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );

    await runner.tickOnce();

    expect(maximumActive).toBe(2);
    expect(queue.run(first.runId)?.state).toBe("succeeded");
    expect(queue.run(second.runId)?.state).toBe("succeeded");
    store.close();
  });

  it("dead-letters a rejected executor settlement instead of re-executing it", async () => {
    const store = new Store(":memory:");
    const definition = workflow();
    const version = saveVersion(store, definition);
    const events: string[] = [];
    const queue = new WorkflowQueue(store);
    const executor: WorkflowStepExecutor = {
      async execute(claim) {
        queue.pauseRunForApproval(claim.run.runId, "authority changed", 550);
        return { ok: true, result: { effectCommitted: true } };
      },
    };
    const runner = new WorkflowRunner(
      store,
      runnerConfig(),
      (event) => events.push(event),
      executor,
      () => 600,
    );
    await runner.tickOnce();
    recordEvent(store, version.workflowId);
    await runner.tickOnce();

    const run = store.db.prepare("SELECT run_id FROM workflow_runs").get() as { run_id: string };
    expect(queue.run(run.run_id)).toMatchObject({
      state: "dead_letter",
      error:
        "Workflow executor returned after its lease was lost; the outcome requires operator reconciliation",
    });
    expect(events).toContain("workflow_step_settlement_rejected");
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

  it("aborts an in-flight executor cooperatively after cancellation", async () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, workflow(), "workflow-live-cancel");
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const executor: WorkflowStepExecutor = {
      execute: async (_claim, _definition, signal) =>
        new Promise((_resolve, reject) => {
          started!();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );

    await runner.tickOnce();
    await began;
    queue.cancelRun(run.runId, workflowPrincipalDigest("operator"), "operator request", 550);
    await runner.tickOnce();

    await vi.waitFor(() => expect(queue.run(run.runId)?.state).toBe("cancelled"));
    expect(aborted).toBe(true);
    store.close();
  });

  it("bounds deferred deliveries instead of retrying permanent denial forever", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const definition = workflow();
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
    runner.matchEventsOnce(500);
    const pending = runner.queue.pendingDeliveries(1, 500)[0]!;

    expect(runner.queue.deferDelivery(pending.deliveryId, 600, 2)).toBe("deferred");
    expect(runner.queue.pendingDeliveries(1, 600)[0]?.dispatchAttemptCount).toBe(1);
    expect(runner.queue.deferDelivery(pending.deliveryId, 700, 2)).toBe("dead_letter");
    expect(
      store.db
        .prepare("SELECT state FROM workflow_deliveries WHERE delivery_id=?")
        .get(pending.deliveryId),
    ).toEqual({ state: "dead_letter" });
    store.close();
  });

  it("does not spend the permanent denial budget on approval or capacity deferrals", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const definition = workflow();
    const version = saveVersion(store, definition);
    const queue = new WorkflowQueue(store);
    const event = recordEvent(store, version.workflowId);
    const pending = queue.createDelivery(
      {
        deliveryId: "delivery-transient-deferrals",
        workflowId: version.workflowId,
        versionHash: version.versionHash,
        eventId: event.eventId,
        eventDedupeKey: event.dedupeKey,
        approvalHash: version.approvalHash,
        authorityHash: workflowAuthorityHash(config),
        actorPrincipalDigest: version.editorPrincipalDigest!,
        actorProvenance: version.editorProvenance!,
      },
      500,
    );

    for (let index = 0; index < 100; index += 1) {
      expect(queue.deferDeliveryForApproval(pending.deliveryId, 600 + index)).toBe(true);
      expect(queue.deferDeliveryTransient(pending.deliveryId, 700 + index)).toBe(true);
    }

    expect(queue.pendingDeliveries(1, 1_000)[0]).toMatchObject({
      state: "pending",
      approvalPending: false,
      dispatchAttemptCount: 0,
    });
    store.close();
  });

  it("keeps a concurrency-blocked delivery pending beyond the permanent denial limit", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const definition = workflow("Serial", { concurrency: 1 });
    const version = saveVersion(store, definition, "workflow-serial");
    const queue = new WorkflowQueue(store);
    const authorityHash = approve(store, config, version);
    const firstEvent = recordEvent(store, version.workflowId);
    const first = queue.createDelivery(
      {
        deliveryId: "delivery-serial-first",
        workflowId: version.workflowId,
        versionHash: version.versionHash,
        eventId: firstEvent.eventId,
        eventDedupeKey: firstEvent.dedupeKey,
        approvalHash: version.approvalHash,
        authorityHash,
        actorPrincipalDigest: version.editorPrincipalDigest!,
        actorProvenance: version.editorProvenance!,
      },
      300,
    );
    expect(
      queue.dispatchDelivery(
        first.deliveryId,
        definition,
        { maximumConcurrentRuns: 1, maximumRunsPerHour: 60 },
        authorityHash,
        300,
      ),
    ).toBeDefined();
    const secondEvent = recordEvent(store, version.workflowId, {
      eventSuffix: "serial-second",
      recordedAt: 301,
    });
    const second = queue.createDelivery(
      {
        deliveryId: "delivery-serial-second",
        workflowId: version.workflowId,
        versionHash: version.versionHash,
        eventId: secondEvent.eventId,
        eventDedupeKey: secondEvent.dedupeKey,
        approvalHash: version.approvalHash,
        authorityHash,
        actorPrincipalDigest: version.editorPrincipalDigest!,
        actorProvenance: version.editorProvenance!,
      },
      301,
    );
    const runner = new WorkflowRunner(
      store,
      config,
      () => undefined,
      undefined,
      () => 500,
    );

    for (let index = 0; index < 30; index += 1)
      expect(runner.dispatchOnce(2_000 + index * 2_000)).toBe(0);

    expect(queue.pendingDeliveries(1, 100_000)[0]).toMatchObject({
      deliveryId: second.deliveryId,
      state: "pending",
      dispatchAttemptCount: 0,
    });
    store.close();
  });

  it("attributes automatic disabled-workflow cancellation to the runner principal", async () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, workflow(), "workflow-auto-cancel");
    store.db
      .prepare(
        "UPDATE workflow_definitions SET state='invalid',active_version_hash=NULL WHERE workflow_id=?",
      )
      .run(run.workflowId);
    const runner = new WorkflowRunner(
      store,
      config,
      () => undefined,
      undefined,
      () => 500,
    );

    await runner.tickOnce();

    expect(queue.run(run.runId)).toMatchObject({
      state: "cancelled",
      cancelActorPrincipalDigest: workflowPrincipalDigest("system:workflow-runner"),
      cancelReason: "Workflow version was superseded or archived",
    });
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
          config: { operation: "update", bulk: false, values: { properties: [] } },
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

  it("bounds and redacts persisted executor results and errors", () => {
    const store = new Store(":memory:");
    const config = runnerConfig();
    const queue = new WorkflowQueue(store);
    const success = delivery(queue, store, config, workflow(), "workflow-result");
    const successClaim = queue.claimStep(
      "worker-success",
      new Set([success.authorityHash]),
      5_000,
      500,
    )!;
    queue.startStep(success.runId, "noop", successClaim.attempt.fencingToken, 501);
    queue.completeStep(
      success.runId,
      "noop",
      successClaim.attempt.fencingToken,
      { nested: { token: "secret-token", accepted: true } },
      600,
    );
    expect(queue.steps(success.runId)[0]?.result).toEqual({
      nested: {
        token: { redacted: true, digest: expect.stringMatching(/^sha256:/) },
        accepted: true,
      },
    });

    const failure = delivery(queue, store, config, workflow(), "workflow-error");
    const failureClaim = queue.claimStep(
      "worker-failure",
      new Set([failure.authorityHash]),
      5_000,
      700,
    )!;
    queue.startStep(failure.runId, "noop", failureClaim.attempt.fencingToken, 701);
    queue.failStep(
      failure.runId,
      "noop",
      failureClaim.attempt.fencingToken,
      `authorization=top-secret ${"x".repeat(10_000)}`,
      workflow().spec.retry,
      false,
      800,
    );
    const error = queue.steps(failure.runId)[0]?.error ?? "";
    expect(error).not.toContain("top-secret");
    expect(error).toContain("authorization=[redacted]");
    expect(error.length).toBeLessThanOrEqual(4_000);
    store.close();
  });

  it("parks a run when redacted workflow text requires a verified source refetch", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          config: { prompt: "private operator prompt" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-source-required");
    let calls = 0;
    const executor: WorkflowStepExecutor = {
      async execute() {
        calls += 1;
        return { ok: true, result: null };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );

    await runner.tickOnce();

    expect(calls).toBe(0);
    expect(queue.run(run.runId)).toMatchObject({
      state: "waiting",
      error:
        "source_refetch_required: workflow text is not stored; refetch and reverify the source before execution",
    });
    expect(queue.steps(run.runId)[0]).toMatchObject({
      state: "source_refetch_required",
    });
    expect(queue.attempts(run.runId, "agent")[0]).toMatchObject({
      state: "source_refetch_required",
    });
    store.close();
  });

  it("bounds failed source refetch attempts and dead-letters the run", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          config: { prompt: "private operator prompt" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-refetch-bounded");
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
    );
    await runner.tickOnce();

    expect(queue.deferSourceRefetch(run.runId, "agent", "unavailable", 1_000, 2, 600)).toBe(
      "deferred",
    );
    expect(queue.steps(run.runId)[0]?.sourceRefetchAttemptCount).toBe(1);
    expect(queue.deferSourceRefetch(run.runId, "agent", "still unavailable", 2_000, 2, 700)).toBe(
      "dead_letter",
    );
    expect(queue.run(run.runId)).toMatchObject({
      state: "dead_letter",
      error: "still unavailable",
    });
    store.close();
  });

  it("does not let source-refetch parked runs consume workflow concurrency", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent", {
      steps: [{ id: "agent", kind: "agent", dependsOn: [], config: { prompt: "private" } }],
      capabilities: ["agent.invoke"],
      concurrency: 1,
    });
    const version = saveVersion(store, definition);
    approve(store, config, version);
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
    recordEvent(store, version.workflowId, { eventSuffix: "2", recordedAt: 301 });
    await runner.tickOnce();

    expect(runner.queue.counts().runs).toBe(2);
    expect(runner.queue.activeRuns().every((run) => run.state === "waiting")).toBe(true);
    store.close();
  });

  it("parks nested prompt and message text until the complete source is reverified", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["anytype.write"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflowDefinitionSchema.parse({
      apiVersion: "knot.imai.studio/v1alpha1",
      kind: "KnotWorkflow",
      metadata: { name: "Structured", labels: { prompt: "classification", message: "safe" } },
      spec: {
        enabled: true,
        triggers: [{ kind: "manual" }],
        steps: [
          {
            id: "write",
            kind: "anytype.write",
            config: {
              values: {
                properties: [
                  { key: "prompt", text: "ordinary object property" },
                  { key: "message", text: "also ordinary data" },
                ],
              },
            },
          },
        ],
        capabilities: ["anytype.write"],
      },
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-structured");
    const executor: WorkflowStepExecutor = {
      async execute() {
        return { ok: true, result: null };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );

    await runner.tickOnce();

    expect(queue.run(run.runId)?.state).toBe("waiting");
    expect(queue.steps(run.runId)[0]).toMatchObject({
      state: "source_refetch_required",
    });
    const stored = store.workflowVersion(run.workflowId, run.versionHash)!;
    expect(stored.storedDefinitionJson).not.toContain("classification");
    expect(stored.storedDefinitionJson).not.toContain("ordinary object property");
    expect(stored.storedDefinitionJson).not.toContain("also ordinary data");
    store.close();
  });

  it("refetches and revalidates redacted source before handing it to an executor", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          config: { prompt: "private operator prompt" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const definitionSource = canonicalWorkflowDefinition(definition);
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-refetched");
    let receivedPrompt: string | undefined;
    const executor: WorkflowStepExecutor = {
      async execute(_claim, completeDefinition) {
        const step = completeDefinition.spec.steps[0];
        receivedPrompt = step?.kind === "agent" ? step.config?.prompt : undefined;
        return { ok: true, result: { accepted: true } };
      },
    };
    const resolver: WorkflowSourceResolver = {
      async refetch() {
        return {
          definitionSource,
          sourceModifiedAt: 100,
          editorParticipantId: "operator",
          editorProvenance: "anytype-native",
        };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
      resolver,
    );

    await runner.tickOnce();

    expect(receivedPrompt).toBe("private operator prompt");
    expect(queue.run(run.runId)?.state).toBe("succeeded");
    expect(queue.steps(run.runId)[0]).toMatchObject({
      state: "succeeded",
      result: { accepted: true },
    });
    store.close();
  });

  it("keeps a parked run closed when refetched source fails exact hash checks", async () => {
    const config = runnerConfig({
      allowedCapabilities: ["agent.invoke"],
      maximumRiskTier: "T1",
    });
    const store = new Store(":memory:");
    const definition = workflow("Agent", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          config: { prompt: "approved prompt" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-refetch-mismatch");
    const changed = workflow("Agent", {
      steps: [
        {
          id: "agent",
          kind: "agent",
          dependsOn: [],
          config: { prompt: "changed prompt" },
        },
      ],
      capabilities: ["agent.invoke"],
    });
    const resolver: WorkflowSourceResolver = {
      async refetch() {
        return {
          definitionSource: canonicalWorkflowDefinition(changed),
          sourceModifiedAt: 100,
          editorParticipantId: "operator",
          editorProvenance: "anytype-native",
        };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
      resolver,
    );

    await runner.tickOnce();

    expect(queue.run(run.runId)).toMatchObject({
      state: "waiting",
      error:
        "source_reverification_failed: refetched workflow source did not match the stored version, approval, editor, and revision hashes",
    });
    expect(queue.steps(run.runId)[0]?.state).toBe("source_refetch_required");
    store.close();
  });

  it("dead-letters a run when stored policy material no longer matches its hashes", async () => {
    const config = runnerConfig();
    const store = new Store(":memory:");
    const definition = workflow();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-tampered");
    const changed = workflow("Workflow one", {
      retry: {
        attempts: 4,
        initialDelaySeconds: 1,
        maximumDelaySeconds: 2,
        multiplier: 2,
      },
    });
    store.db.exec("DROP TRIGGER workflow_versions_no_update");
    store.db
      .prepare(
        `UPDATE workflow_versions SET canonical_definition_json=?
         WHERE workflow_id=? AND version_hash=?`,
      )
      .run(canonicalStoredWorkflowDefinition(changed), run.workflowId, run.versionHash);
    let calls = 0;
    const executor: WorkflowStepExecutor = {
      async execute() {
        calls += 1;
        return { ok: true, result: null };
      },
    };
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      executor,
      () => 500,
    );

    await runner.tickOnce();

    expect(calls).toBe(0);
    expect(queue.run(run.runId)).toMatchObject({
      state: "dead_letter",
      error:
        "workflow_version_integrity_failed: stored definition, approval, or policy did not match its immutable hashes",
    });
    store.close();
  });

  it("reports stored schema rejection separately from immutable hash tamper", async () => {
    const config = runnerConfig();
    const store = new Store(":memory:");
    const definition = workflow();
    const queue = new WorkflowQueue(store);
    const run = delivery(queue, store, config, definition, "workflow-schema-rejected");
    const version = store.workflowVersion(run.workflowId, run.versionHash)!;
    const invalid = JSON.parse(version.storedDefinitionJson) as {
      spec: { steps: Array<Record<string, unknown>> };
    };
    invalid.spec.steps[0]!.unsupported = true;
    store.db.exec("DROP TRIGGER workflow_versions_no_update");
    store.db
      .prepare(
        `UPDATE workflow_versions SET canonical_definition_json=?
         WHERE workflow_id=? AND version_hash=?`,
      )
      .run(canonicalJson(invalid as unknown as JsonValue), run.workflowId, run.versionHash);
    const runner = new WorkflowRunner(
      store,
      config,
      () => {},
      undefined,
      () => 500,
    );

    await runner.tickOnce();

    expect(queue.run(run.runId)).toMatchObject({
      state: "dead_letter",
      error:
        "workflow_version_schema_rejected: stored definition does not satisfy the supported schema",
    });
    store.close();
  });
});
