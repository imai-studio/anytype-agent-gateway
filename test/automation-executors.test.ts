import { describe, expect, it, vi } from "vitest";
import { TypedWorkflowStepExecutor } from "../src/automation/executors.js";
import {
  evaluateWorkflowAuthority,
  evaluateWorkflowPolicy,
  workflowAuthorityHash,
} from "../src/automation/policy.js";
import type { WorkflowStepExecutor } from "../src/automation/runner.js";
import { WorkflowQueue, type WorkflowClaim } from "../src/automation/runner-store.js";
import {
  canonicalJson,
  canonicalWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowPrincipalDigest,
  workflowSourceDigest,
  workflowVersionHash,
  type WorkflowCapability,
  type WorkflowDefinition,
} from "../src/automation/workflow.js";
import { configSchema, type AgentConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { AnytypePort, RuntimeDriver } from "../src/types.js";

const fallback: WorkflowStepExecutor = {
  async execute() {
    return { ok: false, error: "unexpected fallback", retryable: false };
  },
};

function config(overrides: Record<string, unknown> = {}): AgentConfig {
  return configSchema.parse({
    version: 1,
    agent: { name: "Knot", participantId: "agent" },
    anytype: { apiKeyFile: "/tmp/key" },
    spaces: [{ id: "space-1" }],
    runtime: { kind: "codex", defaultProject: "/workspace" },
    automation: {
      enabled: true,
      observation: true,
      execution: true,
      allowedAuthorIds: ["operator"],
      allowedSpaceIds: ["space-1"],
      allowedCapabilities: [
        "agent.invoke",
        "anytype.read",
        "anytype.query",
        "anytype.write",
        "anytype.materialize",
        "anytype.bulk",
        "notify",
      ],
      allowedConnections: ["team"],
      allowedProjects: ["/workspace"],
      allowedModels: ["gpt-test"],
      notificationConnections: { team: { spaceId: "space-1", chatId: "chat-1" } },
      maximumRiskTier: "T2",
      ...overrides,
    },
  });
}

function workflow(
  steps: Array<Record<string, unknown>>,
  capabilities: WorkflowCapability[],
  budget: Record<string, unknown> = {},
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    apiVersion: "knot.imai.studio/v1alpha1",
    kind: "KnotWorkflow",
    metadata: { name: "Typed executor test" },
    spec: {
      enabled: true,
      triggers: [{ kind: "manual" }],
      steps,
      capabilities,
      budget: { maximumRunSeconds: 300, ...budget },
    },
  });
}

function prepare(
  definition: WorkflowDefinition,
  agentConfig = config(),
  eventSpaceId = "space-1",
): { store: Store; queue: WorkflowQueue; claim: WorkflowClaim } {
  const store = new Store(":memory:");
  const queue = new WorkflowQueue(store);
  const now = Date.now();
  const workflowId = `workflow-${definition.spec.steps[0]!.id}`;
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: "space-1" });
  const version = store.saveWorkflowVersion({
    workflowId,
    spaceId: "space-1",
    objectId: `definition-${workflowId}`,
    name: definition.metadata.name,
    versionHash: workflowVersionHash(definition),
    approvalHash: workflowApprovalHash(definition),
    schemaVersion: 1,
    canonicalDefinitionJson: canonicalWorkflowDefinition(definition),
    canonicalApprovalJson: canonicalJson(workflowApprovalMaterial(definition)),
    sourceDigest: workflowSourceDigest(canonicalWorkflowDefinition(definition)),
    riskTier: policy.riskTier,
    requiredCapabilities: policy.requiredCapabilities,
    sourceModifiedAt: now,
    editorPrincipalDigest: workflowPrincipalDigest("operator"),
    editorProvenance: "operator-cli",
    createdAt: now,
  });
  const authorityHash = workflowAuthorityHash(agentConfig.automation);
  store.recordWorkflowApproval({
    decisionId: `approval-${workflowId}`,
    workflowId,
    approvalHash: version.approvalHash,
    decision: "approved",
    mode: "manual",
    authorityHash,
    actorPrincipalDigest: workflowPrincipalDigest("operator"),
    decidedAt: now,
  });
  const event = store.recordNormalizedEvent({
    eventId: `event-${workflowId}`,
    dedupeKey: `dedupe-${workflowId}`,
    kind: "manual.run",
    source: "manual",
    spaceId: eventSpaceId,
    objectId: "object-source",
    editor: { principalDigest: workflowPrincipalDigest("operator"), provenance: "operator-cli" },
    observedAt: now,
    recordedAt: now,
    causalDepth: 0,
    payload: { workflowId },
  });
  const delivery = queue.createDelivery(
    {
      deliveryId: `delivery-${workflowId}`,
      workflowId,
      versionHash: version.versionHash,
      eventId: event.eventId,
      eventDedupeKey: event.dedupeKey,
      approvalHash: version.approvalHash,
      authorityHash,
      actorPrincipalDigest: workflowPrincipalDigest("operator"),
      actorProvenance: "operator-cli",
    },
    now,
  );
  queue.dispatchDelivery(
    delivery.deliveryId,
    definition,
    { maximumConcurrentRuns: 4, maximumRunsPerHour: 60 },
    authorityHash,
    now,
  );
  const claim = queue.claimStep("worker", new Set([authorityHash]), 60_000, now)!;
  expect(
    queue.startStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, now + 1),
  ).toBe(true);
  return { store, queue, claim: { ...claim, step: queue.steps(claim.run.runId)[0]! } };
}

function anytype(overrides: Partial<AnytypePort> = {}): AnytypePort {
  return {
    getObject: vi.fn(async (_spaceId, objectId) => ({ id: objectId, name: "Source" })),
    updateObject: vi.fn(async (_spaceId, objectId) => ({ id: objectId })),
    sendMessage: vi.fn(async () => "message-1"),
    ...overrides,
  } as unknown as AnytypePort;
}

function runtime(overrides: Partial<RuntimeDriver> = {}): RuntimeDriver {
  return {
    name: "test",
    projectEnforcement: "enforced",
    capabilities: {
      steering: false,
      thinking: false,
      multipleOutputParts: false,
      sessionObservation: false,
      nativeScheduling: false,
      modelSelection: true,
    },
    start: vi.fn(async () => ({
      result: Promise.resolve({ text: "done" }),
      steer: async () => {},
      cancel: async () => {},
    })),
    doctor: async () => [],
    ...overrides,
  } as RuntimeDriver;
}

describe("closed typed workflow executors", () => {
  it("rejects open transports, arbitrary code, missing capabilities, and unauthorized models", () => {
    expect(() =>
      workflowDefinitionSchema.parse({
        apiVersion: "knot.imai.studio/v1alpha1",
        kind: "KnotWorkflow",
        metadata: { name: "Open transport" },
        spec: {
          enabled: true,
          triggers: [{ kind: "manual" }],
          steps: [{ id: "notify", kind: "notify", config: { url: "https://example.com" } }],
          capabilities: ["notify"],
        },
      }),
    ).toThrow();
    expect(() =>
      workflow([{ id: "transform", kind: "transform", config: { code: "process.exit()" } }], []),
    ).toThrow();
    expect(() =>
      workflow(
        [
          {
            id: "write",
            kind: "anytype.write",
            config: {
              operation: "create",
              objectId: "ignored",
              values: { typeKey: "page", markdown: "silently ignored" },
            },
          },
        ],
        ["anytype.write"],
      ),
    ).toThrow();
    const missing = workflow(
      [{ id: "write", kind: "anytype.write", config: { operation: "update" } }],
      [],
    );
    expect(evaluateWorkflowPolicy(missing).missingCapabilities).toEqual(["anytype.write"]);
    const unauthorized = workflow(
      [
        {
          id: "agent",
          kind: "agent",
          config: { prompt: "work", project: "/workspace", model: "other-model" },
        },
      ],
      ["agent.invoke"],
    );
    expect(evaluateWorkflowPolicy(unauthorized).riskTier).toBe("T1");
    const authority = config({ allowedModels: [] });
    expect(
      evaluateWorkflowAuthority(unauthorized, authority.automation, {
        sourceSpaceId: "space-1",
        editor: { principalId: "operator", provenance: "operator-cli" },
      }).violations,
    ).toContain("Model is not locally authorized: other-model");
  });

  it("reads, queries, and applies only declarative JSON-pointer transforms", async () => {
    const definition = workflow(
      [
        { id: "read", kind: "anytype.read" },
        {
          id: "pick",
          kind: "transform",
          dependsOn: ["read"],
          config: { operation: "select", inputStepId: "read", pointer: "/object/name" },
        },
      ],
      ["anytype.read"],
    );
    const state = prepare(definition);
    const port = anytype();
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      port,
      runtime(),
      fallback,
    );
    const first = await executor.execute(state.claim, definition, new AbortController().signal);
    expect(first).toEqual({
      ok: true,
      result: {
        spaceId: "space-1",
        objectId: "object-source",
        object: { id: "object-source", name: "Source" },
      },
    });
    if (!first.ok) throw new Error(first.error);
    expect(
      state.queue.completeStep(
        state.claim.run.runId,
        state.claim.step.stepId,
        state.claim.attempt.fencingToken,
        first.result!,
      ),
    ).toBe(true);
    const next = state.queue.claimStep("worker", undefined, 60_000, Date.now())!;
    state.queue.startStep(next.run.runId, next.step.stepId, next.attempt.fencingToken);
    const transformed = await executor.execute(next, definition, new AbortController().signal);
    expect(transformed).toEqual({ ok: true, result: "Source" });
    state.store.close();
  });

  it("writes once and replays the durable receipt without repeating the effect", async () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page", name: "Created" } },
        },
      ],
      ["anytype.write"],
    );
    const state = prepare(definition);
    const createObject = vi.fn(async () => ({ id: "created-1" }));
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({ createObject }),
      runtime(),
      fallback,
    );
    const first = await executor.execute(state.claim, definition, new AbortController().signal);
    const replay = await executor.execute(state.claim, definition, new AbortController().signal);
    expect(first).toEqual({
      ok: true,
      result: { operation: "created", spaceId: "space-1", objectId: "created-1" },
    });
    expect(replay).toEqual(first);
    expect(createObject).toHaveBeenCalledOnce();
    expect(state.store.db.prepare("SELECT state FROM workflow_effect_receipts").get()).toEqual({
      state: "succeeded",
    });
    state.store.close();
  });

  it("bounds queries, exact-match upserts, and explicit collection materialization", async () => {
    const queryDefinition = workflow(
      [
        {
          id: "query",
          kind: "anytype.query",
          config: { text: "Roadmap", typeKeys: ["page"], limit: 2 },
        },
      ],
      ["anytype.query"],
    );
    const queryState = prepare(queryDefinition);
    const searchSpace = vi.fn(async () => [
      { id: "one", name: "Roadmap" },
      { id: "two", name: "Roadmap archive" },
      { id: "three", name: "must be sliced" },
    ]);
    const queryExecutor = new TypedWorkflowStepExecutor(
      queryState.store,
      config(),
      anytype({ searchSpace }),
      runtime(),
      fallback,
    );
    expect(
      await queryExecutor.execute(queryState.claim, queryDefinition, new AbortController().signal),
    ).toMatchObject({ ok: true, result: { objects: [{ id: "one" }, { id: "two" }] } });
    expect(searchSpace).toHaveBeenCalledWith(
      "space-1",
      { query: "Roadmap", types: ["page"], offset: 0, limit: 2 },
      expect.any(AbortSignal),
    );
    queryState.store.close();

    const upsertDefinition = workflow(
      [
        {
          id: "upsert",
          kind: "anytype.upsert",
          config: { typeKey: "page", matchName: "Roadmap" },
        },
      ],
      ["anytype.write"],
    );
    const upsertState = prepare(upsertDefinition);
    const upsertCreate = vi.fn(async () => ({ id: "new-roadmap" }));
    const upsertExecutor = new TypedWorkflowStepExecutor(
      upsertState.store,
      config(),
      anytype({ searchSpace: vi.fn(async () => []), createObject: upsertCreate }),
      runtime(),
      fallback,
    );
    expect(
      await upsertExecutor.execute(
        upsertState.claim,
        upsertDefinition,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, result: { operation: "created", objectId: "new-roadmap" } });
    expect(upsertCreate).toHaveBeenCalledOnce();
    upsertState.store.close();

    const paginatedState = prepare(upsertDefinition);
    const paginatedCreate = vi.fn(async () => ({ id: "must-not-create" }));
    const paginatedUpdate = vi.fn(async (_spaceId, objectId) => ({ id: objectId }));
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: `decoy-${index}`,
      name: `Roadmap ${index}`,
      type_key: "page",
    }));
    const paginatedSearch = vi
      .fn()
      .mockResolvedValueOnce(pageOne)
      .mockResolvedValueOnce([{ id: "existing-roadmap", name: "Roadmap", type_key: "page" }]);
    const paginatedExecutor = new TypedWorkflowStepExecutor(
      paginatedState.store,
      config(),
      anytype({
        searchSpace: paginatedSearch,
        createObject: paginatedCreate,
        updateObject: paginatedUpdate,
      }),
      runtime(),
      fallback,
    );
    expect(
      await paginatedExecutor.execute(
        paginatedState.claim,
        upsertDefinition,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, result: { operation: "updated", objectId: "existing-roadmap" } });
    expect(paginatedSearch).toHaveBeenCalledTimes(2);
    expect(paginatedCreate).not.toHaveBeenCalled();
    expect(paginatedUpdate).toHaveBeenCalledOnce();
    paginatedState.store.close();

    const materializeDefinition = workflow(
      [
        {
          id: "materialize",
          kind: "anytype.materialize",
          config: {
            collectionId: "collection-1",
            objectIds: ["one", "two"],
            bulk: true,
          },
        },
      ],
      ["anytype.materialize", "anytype.write", "anytype.bulk"],
    );
    const materializeState = prepare(materializeDefinition);
    const addObjectsToList = vi.fn(async () => {});
    const materializeExecutor = new TypedWorkflowStepExecutor(
      materializeState.store,
      config(),
      anytype({ addObjectsToList }),
      runtime(),
      fallback,
    );
    expect(
      await materializeExecutor.execute(
        materializeState.claim,
        materializeDefinition,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, result: { operation: "materialized", count: 2 } });
    expect(addObjectsToList).toHaveBeenCalledWith(
      "space-1",
      "collection-1",
      ["one", "two"],
      expect.any(AbortSignal),
    );
    materializeState.store.close();
  });

  it("honors cancellation immediately before an effect", async () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page" } },
        },
      ],
      ["anytype.write"],
    );
    const state = prepare(definition);
    const createObject = vi.fn(async () => ({ id: "created-1" }));
    state.queue.cancelRun(
      state.claim.run.runId,
      workflowPrincipalDigest("operator"),
      "operator",
      Date.now(),
    );
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({ createObject }),
      runtime(),
      fallback,
    );
    const result = await executor.execute(state.claim, definition, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: "Workflow claim is no longer authorized to execute",
    });
    expect(createObject).not.toHaveBeenCalled();
    expect(
      state.store.db.prepare("SELECT COUNT(*) AS count FROM workflow_effect_receipts").get(),
    ).toEqual({ count: 0 });
    state.store.close();
  });

  it("rechecks the current approval after preparing the receipt and before the effect", async () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page" } },
        },
      ],
      ["anytype.write"],
    );
    const state = prepare(definition);
    const createObject = vi.fn(async () => ({ id: "created-1" }));
    const currentApproval = state.store.currentWorkflowApproval.bind(state.store);
    vi.spyOn(state.store, "currentWorkflowApproval")
      .mockImplementationOnce(currentApproval)
      .mockReturnValueOnce(undefined);
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({ createObject }),
      runtime(),
      fallback,
    );
    expect(
      await executor.execute(state.claim, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: "Workflow exact approval is no longer current" });
    expect(createObject).not.toHaveBeenCalled();
    expect(state.store.db.prepare("SELECT state FROM workflow_effect_receipts").get()).toEqual({
      state: "failed",
    });
    state.store.close();
  });

  it("enforces the durable per-run effect budget before calling Anytype", async () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page" } },
        },
      ],
      ["anytype.write"],
      { maximumEffectsPerRun: 0 },
    );
    const state = prepare(definition);
    const createObject = vi.fn(async () => ({ id: "created-1" }));
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({ createObject }),
      runtime(),
      fallback,
    );
    expect(
      await executor.execute(state.claim, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: "Workflow effect budget is exhausted" });
    expect(createObject).not.toHaveBeenCalled();
    expect(
      state.store.db.prepare("SELECT COUNT(*) AS count FROM workflow_effect_receipts").get(),
    ).toEqual({ count: 0 });
    state.store.close();
  });

  it("rejects a dynamic event space without cross-space approval or local authorization", async () => {
    const definition = workflow([{ id: "read", kind: "anytype.read" }], ["anytype.read"]);
    const state = prepare(definition, config(), "space-2");
    const getObject = vi.fn(async () => ({ id: "object-source" }));
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({ getObject }),
      runtime(),
      fallback,
    );
    expect(
      await executor.execute(state.claim, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: expect.stringContaining("without anytype.cross-space") });
    expect(getObject).not.toHaveBeenCalled();
    state.store.close();

    const declared = workflow(
      [{ id: "read", kind: "anytype.read" }],
      ["anytype.read", "anytype.cross-space"],
    );
    const declaredState = prepare(declared, config(), "space-2");
    const declaredGetObject = vi.fn(async () => ({ id: "object-source" }));
    const declaredExecutor = new TypedWorkflowStepExecutor(
      declaredState.store,
      config(),
      anytype({ getObject: declaredGetObject }),
      runtime(),
      fallback,
    );
    expect(
      await declaredExecutor.execute(declaredState.claim, declared, new AbortController().signal),
    ).toMatchObject({ ok: false, error: "Anytype space is not locally authorized: space-2" });
    expect(declaredGetObject).not.toHaveBeenCalled();
    declaredState.store.close();
  });

  it("dead-letters a crash-interrupted external effect instead of guessing or replaying", () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page" } },
        },
      ],
      ["anytype.write"],
    );
    const state = prepare(definition);
    state.store.db
      .prepare(
        `INSERT INTO workflow_effect_receipts(
          effect_key,run_id,step_id,operation_digest,state,fencing_token,updated_at
        ) VALUES(?,?,?,?, 'running',?,?)`,
      )
      .run(
        "effect-interrupted",
        state.claim.run.runId,
        state.claim.step.stepId,
        `sha256:${"1".repeat(64)}`,
        state.claim.attempt.fencingToken,
        Date.now(),
      );
    new TypedWorkflowStepExecutor(state.store, config(), anytype(), runtime(), fallback);
    expect(state.queue.run(state.claim.run.runId)?.state).toBe("dead_letter");
    expect(state.store.db.prepare("SELECT state FROM workflow_effect_receipts").get()).toEqual({
      state: "outcome_unknown",
    });
    state.store.close();
  });

  it("persists an unknown outcome without leaking an external credential-shaped error", async () => {
    const definition = workflow(
      [
        {
          id: "write",
          kind: "anytype.write",
          config: { operation: "create", values: { typeKey: "page" } },
        },
      ],
      ["anytype.write"],
    );
    const state = prepare(definition);
    const executor = new TypedWorkflowStepExecutor(
      state.store,
      config(),
      anytype({
        createObject: vi.fn(async () => {
          throw new Error('request failed with "token":"never-store-this"');
        }),
      }),
      runtime(),
      fallback,
    );
    expect(
      await executor.execute(state.claim, definition, new AbortController().signal),
    ).toMatchObject({ ok: false, error: expect.stringContaining("outcome is unknown") });
    const receipt = state.store.db
      .prepare("SELECT state,error FROM workflow_effect_receipts")
      .get() as { state: string; error: string };
    expect(receipt.state).toBe("outcome_unknown");
    expect(receipt.error).toContain("token=[redacted]");
    expect(receipt.error).not.toContain("never-store-this");
    state.store.close();
  });

  it("uses named notification authority and workflow-origin runtime invocation", async () => {
    const notification = workflow(
      [{ id: "notify", kind: "notify", config: { connectionRef: "team", message: "ready" } }],
      ["notify"],
    );
    const notificationState = prepare(notification);
    const sendMessage = vi.fn(async () => "message-7");
    const notificationExecutor = new TypedWorkflowStepExecutor(
      notificationState.store,
      config(),
      anytype({ sendMessage }),
      runtime(),
      fallback,
    );
    expect(
      await notificationExecutor.execute(
        notificationState.claim,
        notification,
        new AbortController().signal,
      ),
    ).toEqual({
      ok: true,
      result: { operation: "notified", connectionRef: "team", messageId: "message-7" },
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "space-1",
      "chat-1",
      { text: "ready" },
      expect.any(AbortSignal),
    );
    notificationState.store.close();

    const agent = workflow(
      [
        {
          id: "agent",
          kind: "agent",
          config: { prompt: "do work", project: "/workspace", model: "gpt-test" },
        },
      ],
      ["agent.invoke"],
    );
    const agentState = prepare(agent);
    const start = vi.fn(async () => ({
      result: Promise.resolve({ text: "finished" }),
      steer: async () => {},
      cancel: async () => {},
    }));
    const agentExecutor = new TypedWorkflowStepExecutor(
      agentState.store,
      config(),
      anytype(),
      runtime({ start }),
      fallback,
    );
    const result = await agentExecutor.execute(
      agentState.claim,
      agent,
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: true,
      result: { operation: "agent-invoked", text: "finished", silent: false },
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "workflow",
        prompt: "do work",
        workspacePath: "/workspace",
        modelId: "gpt-test",
      }),
      expect.any(Function),
    );
    agentState.store.close();

    const openclawState = prepare(agent, config({ allowedModels: ["gpt-test"] }));
    const openclawConfig = configSchema.parse({
      ...config({ allowedModels: ["gpt-test"] }),
      runtime: { kind: "openclaw" },
    });
    const openclawStart = vi.fn();
    const openclawExecutor = new TypedWorkflowStepExecutor(
      openclawState.store,
      openclawConfig,
      anytype(),
      runtime({ start: openclawStart }),
      fallback,
    );
    expect(
      await openclawExecutor.execute(openclawState.claim, agent, new AbortController().signal),
    ).toMatchObject({ ok: false, error: expect.stringContaining("OpenClaw workflow mode") });
    expect(openclawStart).not.toHaveBeenCalled();
    openclawState.store.close();

    const unscopedAgent = workflow(
      [{ id: "agent", kind: "agent", config: { prompt: "do work" } }],
      ["agent.invoke"],
    );
    const noDefaultConfig = configSchema.parse({
      ...config(),
      runtime: { kind: "codex" },
    });
    const unscopedState = prepare(unscopedAgent, noDefaultConfig);
    const unscopedStart = vi.fn();
    const unscopedExecutor = new TypedWorkflowStepExecutor(
      unscopedState.store,
      noDefaultConfig,
      anytype(),
      runtime({ start: unscopedStart }),
      fallback,
    );
    expect(
      await unscopedExecutor.execute(
        unscopedState.claim,
        unscopedAgent,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("explicitly authorized project") });
    expect(unscopedStart).not.toHaveBeenCalled();
    unscopedState.store.close();
  });
});
