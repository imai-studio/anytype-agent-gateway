import { createHash } from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import type { AnytypePort, RuntimeDriver } from "../types.js";
import { WorkflowQueue, type WorkflowClaim } from "./runner-store.js";
import type { WorkflowStepExecution, WorkflowStepExecutor } from "./runner.js";
import {
  anytypeMaterializeConfigSchema,
  anytypeQueryConfigSchema,
  anytypeReadConfigSchema,
  anytypeUpsertConfigSchema,
  anytypeWriteConfigSchema,
  agentConfigSchema,
  canonicalJson,
  jsonValueSchema,
  notifyConfigSchema,
  transformConfigSchema,
  workflowApprovalHash,
  type JsonValue,
  type WorkflowDefinition,
} from "./workflow.js";
import { workflowAuthorityHash } from "./policy.js";

type EffectStart =
  | { kind: "execute"; effectKey: string }
  | { kind: "replay"; result: JsonValue }
  | { kind: "blocked"; error: string };

/** Executes only the closed, typed local workflow catalog. */
export class TypedWorkflowStepExecutor implements WorkflowStepExecutor {
  private readonly queue: WorkflowQueue;
  private readonly receipts: WorkflowEffectReceipts;
  private readonly upsertTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly config: AgentConfig,
    private readonly anytype: AnytypePort,
    private readonly runtime: RuntimeDriver,
    private readonly fallback: WorkflowStepExecutor,
  ) {
    this.queue = new WorkflowQueue(store);
    this.receipts = new WorkflowEffectReceipts(store, this.queue);
    this.receipts.recoverInterruptedEffects();
  }

  async execute(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
    signal: AbortSignal,
  ): Promise<WorkflowStepExecution> {
    const step = definition.spec.steps.find((candidate) => candidate.id === claim.step.stepId);
    if (!step) return failure("Workflow step no longer exists");
    if (signal.aborted) throw signal.reason;
    try {
      this.assertEventSpaceApproval(claim, definition);
      switch (step.kind) {
        case "anytype.read":
          return await this.read(claim, step.config, signal);
        case "anytype.query":
          return await this.query(claim, step.config, signal);
        case "anytype.write":
          this.validateWrite(claim, step.config);
          return await this.effect(claim, definition, step, signal, () =>
            this.write(claim, step.config, signal),
          );
        case "anytype.upsert":
          return await this.upsert(claim, definition, step, signal);
        case "anytype.materialize":
          this.validateMaterialize(claim, step.config);
          return await this.effect(claim, definition, step, signal, () =>
            this.materialize(claim, step.config, signal),
          );
        case "transform":
          return this.transform(claim, step.config);
        case "notify":
          this.validateNotify(claim, step.config);
          return await this.effect(claim, definition, step, signal, () =>
            this.notify(claim, step.config, signal),
          );
        case "agent":
          this.validateAgent(step.config);
          return await this.effect(claim, definition, step, signal, () =>
            this.invokeAgent(claim, step.config, signal),
          );
        default:
          return await this.fallback.execute(claim, definition, signal);
      }
    } catch (error) {
      if (error instanceof ClosedExecutorError) return failure(error.message);
      throw error;
    }
  }

  private validateWrite(claim: WorkflowClaim, raw: unknown): void {
    const parsed = anytypeWriteConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ClosedExecutorError("anytype.write configuration is invalid");
    const input = parsed.data;
    const objectId = input.objectId ?? this.sourceEvent(claim).objectId;
    if (input.operation === "create" && !this.anytype.createObject)
      throw new ClosedExecutorError("Anytype create is unavailable");
    if (input.operation === "archive" && !this.anytype.archiveObject)
      throw new ClosedExecutorError("Anytype archive is unavailable");
    if (input.operation !== "create" && !objectId)
      throw new ClosedExecutorError(
        `anytype.${input.operation} requires objectId or an object event`,
      );
  }

  private validateMaterialize(claim: WorkflowClaim, raw: unknown): void {
    const parsed = anytypeMaterializeConfigSchema.safeParse(raw);
    if (!parsed.success)
      throw new ClosedExecutorError("anytype.materialize configuration is invalid");
    if (!this.anytype.addObjectsToList)
      throw new ClosedExecutorError("Anytype collection materialization is unavailable");
    const objectIds = new Set(parsed.data.objectIds);
    if (parsed.data.inputStepId)
      for (const objectId of objectIdsFrom(this.inputResult(claim, parsed.data.inputStepId)))
        objectIds.add(objectId);
    if (!objectIds.size) throw new ClosedExecutorError("Materialize resolved no object IDs");
    if (objectIds.size > 100) throw new ClosedExecutorError("Materialize exceeds 100 objects");
  }

  private validateNotify(claim: WorkflowClaim, raw: unknown): void {
    const parsed = notifyConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ClosedExecutorError("notify configuration is invalid");
    const target = this.config.automation.notificationConnections[parsed.data.connectionRef];
    if (!target || !this.config.automation.allowedConnections.includes(parsed.data.connectionRef))
      throw new ClosedExecutorError("notify connection is not locally authorized");
    if (!this.config.automation.allowedSpaceIds.includes(target.spaceId))
      throw new ClosedExecutorError("notify target space is not locally authorized");
    if (parsed.data.inputStepId) this.inputResult(claim, parsed.data.inputStepId);
  }

  private validateAgent(raw: unknown): void {
    const parsed = agentConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ClosedExecutorError("agent configuration is invalid");
    if (this.config.runtime.kind === "openclaw")
      throw new ClosedExecutorError(
        "agent workflow invocation requires a capability-scoped runtime; OpenClaw workflow mode is unavailable",
      );
    const project = parsed.data.project ?? this.config.runtime.defaultProject;
    if (!project)
      throw new ClosedExecutorError(
        "agent workflow invocation requires an explicitly authorized project",
      );
    if (this.config.runtime.kind !== "codex")
      throw new ClosedExecutorError("agent project selection requires the Codex runtime");
    if (!this.config.automation.allowedProjects.includes(project))
      throw new ClosedExecutorError("agent project is not locally authorized");
    if (parsed.data.model && !this.config.automation.allowedModels.includes(parsed.data.model))
      throw new ClosedExecutorError("agent model is not locally authorized");
    if (parsed.data.model && !this.runtime.capabilities.modelSelection)
      throw new ClosedExecutorError("agent model selection is unavailable for this runtime");
  }

  private async read(
    claim: WorkflowClaim,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<WorkflowStepExecution> {
    const parsed = anytypeReadConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) return failure("anytype.read configuration is invalid");
    const event = this.sourceEvent(claim);
    const spaceId = parsed.data.spaceId ?? event.spaceId;
    this.assertSpaceAuthorized(spaceId);
    const objectId = parsed.data.objectId ?? event.objectId;
    if (!objectId) return failure("anytype.read requires objectId or an object event");
    const object = await this.anytype.getObject(spaceId, objectId, signal);
    return success(toBoundedJson({ spaceId, objectId, object }));
  }

  private async query(
    claim: WorkflowClaim,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<WorkflowStepExecution> {
    const parsed = anytypeQueryConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) return failure("anytype.query configuration is invalid");
    if (!this.anytype.searchSpace) return failure("Anytype query is not supported locally");
    const event = this.sourceEvent(claim);
    const input = parsed.data;
    const spaceId = input.spaceId ?? event.spaceId;
    this.assertSpaceAuthorized(spaceId);
    const objects = await this.anytype.searchSpace(
      spaceId,
      {
        query: input.text,
        ...(input.typeKeys.length ? { types: input.typeKeys } : {}),
        offset: 0,
        limit: input.limit,
      },
      signal,
    );
    return success(toBoundedJson({ spaceId, objects: objects.slice(0, input.limit) }));
  }

  private async write(claim: WorkflowClaim, raw: unknown, signal: AbortSignal): Promise<JsonValue> {
    const parsed = anytypeWriteConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ClosedExecutorError("anytype.write configuration is invalid");
    const event = this.sourceEvent(claim);
    const input = parsed.data;
    const spaceId = input.spaceId ?? event.spaceId;
    this.assertSpaceAuthorized(spaceId);
    const objectId = input.objectId ?? event.objectId;
    const properties = input.values.properties;
    if (input.operation === "create") {
      if (!this.anytype.createObject)
        throw new ClosedExecutorError("Anytype create is unavailable");
      const object = await this.anytype.createObject(
        spaceId,
        {
          type_key: input.values.typeKey!,
          ...(input.values.name !== undefined ? { name: input.values.name } : {}),
          ...(input.values.body !== undefined ? { body: input.values.body } : {}),
          ...(properties.length ? { properties } : {}),
        },
        signal,
      );
      return toJson({ operation: "created", spaceId, objectId: objectIdOf(object) });
    }
    if (!objectId)
      throw new ClosedExecutorError(
        `anytype.${input.operation} requires objectId or an object event`,
      );
    if (input.operation === "archive") {
      if (!this.anytype.archiveObject)
        throw new ClosedExecutorError("Anytype archive is unavailable");
      await this.anytype.archiveObject(spaceId, objectId, signal);
      return { operation: "archived", spaceId, objectId };
    }
    const object = await this.anytype.updateObject(
      spaceId,
      objectId,
      {
        ...(input.values.name !== undefined ? { name: input.values.name } : {}),
        ...(input.values.markdown !== undefined ? { markdown: input.values.markdown } : {}),
        ...(properties.length ? { properties } : {}),
      },
      signal,
    );
    return toJson({ operation: "updated", spaceId, objectId: objectIdOf(object, objectId) });
  }

  private async upsert(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
    step: WorkflowDefinition["spec"]["steps"][number],
    signal: AbortSignal,
  ): Promise<WorkflowStepExecution> {
    const parsed = anytypeUpsertConfigSchema.safeParse(step.config);
    if (!parsed.success) return failure("anytype.upsert configuration is invalid");
    if (!this.anytype.searchSpace || !this.anytype.createObject)
      return failure("Anytype upsert is not supported locally");
    const event = this.sourceEvent(claim);
    const input = parsed.data;
    const spaceId = input.spaceId ?? event.spaceId;
    this.assertSpaceAuthorized(spaceId);
    const lockKey = `${spaceId}\0${input.typeKey}\0${input.matchName}`;
    return this.withUpsertLock(lockKey, async () => {
      const matches: Array<Record<string, unknown>> = [];
      let exhaustive = false;
      for (let page = 0; page < 10; page += 1) {
        const candidates = await this.anytype.searchSpace!(
          spaceId,
          { query: input.matchName, types: [input.typeKey], offset: page * 100, limit: 100 },
          signal,
        );
        const named = candidates.filter((candidate) => candidate.name === input.matchName);
        if (named.some((candidate) => typeKeyOf(candidate) !== input.typeKey))
          return failure("anytype.upsert could not verify the exact match type");
        matches.push(...named);
        if (matches.length > 1) return failure("anytype.upsert found more than one exact match");
        if (candidates.length < 100) {
          exhaustive = true;
          break;
        }
      }
      if (!exhaustive)
        return failure("anytype.upsert search was not exhaustive; refusing to create a duplicate");
      const selectedId = matches[0] ? objectIdOf(matches[0]) : undefined;
      return this.effect(
        claim,
        definition,
        step,
        signal,
        async () => {
          if (selectedId) {
            const object = await this.anytype.updateObject(
              spaceId,
              selectedId,
              {
                name: input.matchName,
                ...(input.body !== undefined ? { markdown: input.body } : {}),
                ...(input.properties.length ? { properties: input.properties } : {}),
              },
              signal,
            );
            return toJson({
              operation: "updated",
              spaceId,
              objectId: objectIdOf(object, selectedId),
            });
          }
          const object = await this.anytype.createObject!(
            spaceId,
            {
              type_key: input.typeKey,
              name: input.matchName,
              ...(input.body !== undefined ? { body: input.body } : {}),
              ...(input.properties.length ? { properties: input.properties } : {}),
            },
            signal,
          );
          return toJson({ operation: "created", spaceId, objectId: objectIdOf(object) });
        },
        { selectedId: selectedId ?? null },
      );
    });
  }

  private async materialize(
    claim: WorkflowClaim,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const parsed = anytypeMaterializeConfigSchema.safeParse(raw);
    if (!parsed.success)
      throw new ClosedExecutorError("anytype.materialize configuration is invalid");
    if (!this.anytype.addObjectsToList)
      throw new ClosedExecutorError("Anytype collection materialization is unavailable");
    const event = this.sourceEvent(claim);
    const input = parsed.data;
    const spaceId = input.spaceId ?? event.spaceId;
    this.assertSpaceAuthorized(spaceId);
    const objectIds = new Set(input.objectIds);
    if (input.inputStepId)
      for (const objectId of objectIdsFrom(this.inputResult(claim, input.inputStepId)))
        objectIds.add(objectId);
    if (!objectIds.size) throw new ClosedExecutorError("Materialize resolved no object IDs");
    if (objectIds.size > 100) throw new ClosedExecutorError("Materialize exceeds 100 objects");
    await this.anytype.addObjectsToList(spaceId, input.collectionId, [...objectIds], signal);
    return {
      operation: "materialized",
      spaceId,
      collectionId: input.collectionId,
      count: objectIds.size,
    };
  }

  private transform(claim: WorkflowClaim, raw: unknown): WorkflowStepExecution {
    if (raw === undefined) return success({ kind: "no-op", stepId: claim.step.stepId });
    const parsed = transformConfigSchema.safeParse(raw);
    if (!parsed.success) return failure("transform configuration is invalid");
    const input = this.inputResult(claim, parsed.data.inputStepId);
    if (parsed.data.operation === "identity") return success(input);
    if (parsed.data.operation === "select") return success(pointer(input, parsed.data.pointer));
    const projected: Record<string, JsonValue> = {};
    for (const [key, path] of Object.entries(parsed.data.fields))
      projected[key] = pointer(input, path);
    return success(projected);
  }

  private async notify(
    claim: WorkflowClaim,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const parsed = notifyConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ClosedExecutorError("notify configuration is invalid");
    const input = parsed.data;
    const target = this.config.automation.notificationConnections[input.connectionRef];
    if (!target || !this.config.automation.allowedConnections.includes(input.connectionRef))
      throw new ClosedExecutorError("notify connection is not locally authorized");
    if (!this.config.automation.allowedSpaceIds.includes(target.spaceId))
      throw new ClosedExecutorError("notify target space is not locally authorized");
    const derived = input.inputStepId
      ? canonicalJson(this.inputResult(claim, input.inputStepId))
      : undefined;
    const text = [input.message, derived]
      .filter((value): value is string => value !== undefined)
      .join("\n");
    const messageId = await this.anytype.sendMessage(
      target.spaceId,
      target.chatId,
      { text },
      signal,
    );
    return { operation: "notified", connectionRef: input.connectionRef, messageId };
  }

  private async invokeAgent(
    claim: WorkflowClaim,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const step = agentConfigSchema.parse(raw);
    const project = step.project ?? this.config.runtime.defaultProject;
    const active = await this.runtime.start(
      {
        sessionKey: `workflow:${claim.run.workflowId}:${claim.run.runId}:${claim.step.stepId}`,
        prompt: step.prompt,
        origin: "workflow",
        ...(project ? { workspacePath: project } : {}),
        ...(step.model ? { modelId: step.model } : {}),
      },
      () => {},
    );
    const cancel = () => void active.cancel().catch(() => undefined);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await abortable(active.result, signal);
      const text = boundedText(result.text, 60_000);
      return { operation: "agent-invoked", text, silent: result.silent ?? false };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async effect(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
    step: WorkflowDefinition["spec"]["steps"][number],
    signal: AbortSignal,
    execute: () => Promise<JsonValue>,
    discriminator: JsonValue = null,
  ): Promise<WorkflowStepExecution> {
    const preflight = this.preflight(claim, definition, signal);
    if (preflight) return preflight;
    const start = this.receipts.begin(
      claim,
      {
        kind: step.kind,
        config: (step.config ?? {}) as JsonValue,
        approvalHash: claim.run.approvalHash,
        authorityHash: claim.run.authorityHash,
        discriminator,
      },
      definition.spec.budget.maximumEffectsPerRun,
    );
    if (start.kind === "replay") return success(start.result);
    if (start.kind === "blocked") return failure(start.error);
    const finalPreflight = this.preflight(claim, definition, signal);
    if (finalPreflight) {
      this.receipts.failBeforeEffect(
        start.effectKey,
        claim.attempt.fencingToken,
        "Effect authority changed",
      );
      return finalPreflight;
    }
    try {
      const result = await execute();
      if (!this.receipts.complete(start.effectKey, claim.attempt.fencingToken, result))
        return failure("Workflow effect receipt fencing was lost");
      return success(result);
    } catch (error) {
      this.receipts.outcomeUnknown(
        start.effectKey,
        claim.attempt.fencingToken,
        safeEffectError(error),
      );
      if (signal.aborted) throw signal.reason;
      return failure(
        error instanceof ClosedExecutorError
          ? error.message
          : "External effect outcome is unknown; Knot will not repeat it automatically",
      );
    }
  }

  private preflight(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
    signal: AbortSignal,
  ): WorkflowStepExecution | undefined {
    if (signal.aborted) throw signal.reason;
    if (claim.run.approvalHash !== workflowApprovalHash(definition))
      return failure("Workflow exact approval hash changed");
    if (claim.run.authorityHash !== workflowAuthorityHash(this.config.automation))
      return failure("Workflow local authority changed");
    if (
      !this.store.currentWorkflowApproval(
        claim.run.workflowId,
        claim.run.approvalHash,
        claim.run.authorityHash,
      )
    )
      return failure("Workflow exact approval is no longer current");
    if (!this.queue.claimMayExecute(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken))
      return failure("Workflow claim is no longer authorized to execute");
    return undefined;
  }

  private sourceEvent(claim: WorkflowClaim): { spaceId: string; objectId?: string } {
    const row = this.store.db
      .prepare(
        `SELECT e.space_id,e.object_id FROM workflow_deliveries d
         JOIN normalized_events e ON e.event_id=d.event_id WHERE d.delivery_id=?`,
      )
      .get(claim.run.deliveryId) as { space_id: string; object_id: string | null } | undefined;
    if (!row) throw new ClosedExecutorError("Workflow source event is unavailable");
    return { spaceId: row.space_id, ...(row.object_id ? { objectId: row.object_id } : {}) };
  }

  private inputResult(claim: WorkflowClaim, stepId: string): JsonValue {
    const step = this.queue.steps(claim.run.runId).find((candidate) => candidate.stepId === stepId);
    if (!step || step.state !== "succeeded" || step.result === undefined)
      throw new ClosedExecutorError(`Workflow input step is unavailable: ${stepId}`);
    return step.result;
  }

  private assertSpaceAuthorized(spaceId: string): void {
    if (!this.config.automation.allowedSpaceIds.includes(spaceId))
      throw new ClosedExecutorError(`Anytype space is not locally authorized: ${spaceId}`);
  }

  private assertEventSpaceApproval(claim: WorkflowClaim, definition: WorkflowDefinition): void {
    const eventSpaceId = this.sourceEvent(claim).spaceId;
    const version = this.store.db
      .prepare("SELECT space_id FROM workflow_versions WHERE workflow_id=? AND version_hash=?")
      .get(claim.run.workflowId, claim.run.versionHash) as { space_id: string } | undefined;
    if (
      version &&
      version.space_id !== eventSpaceId &&
      !definition.spec.capabilities.includes("anytype.cross-space")
    )
      throw new ClosedExecutorError(
        `Workflow event crossed from ${version.space_id} to ${eventSpaceId} without anytype.cross-space approval`,
      );
  }

  private async withUpsertLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.upsertTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.upsertTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.upsertTails.get(key) === tail) this.upsertTails.delete(key);
    }
  }
}

class WorkflowEffectReceipts {
  constructor(
    private readonly store: Store,
    private readonly queue: WorkflowQueue,
  ) {}

  recoverInterruptedEffects(now = Date.now()): number {
    const rows = this.store.db
      .prepare(
        "SELECT effect_key,run_id,state FROM workflow_effect_receipts WHERE state IN ('running','outcome_unknown')",
      )
      .all() as Array<{ effect_key: string; run_id: string; state: string }>;
    for (const row of rows) {
      if (row.state === "running")
        this.store.db
          .prepare(
            `UPDATE workflow_effect_receipts SET state='outcome_unknown',
             error='Process stopped while an external effect was in flight',completed_at=?,updated_at=?
             WHERE effect_key=? AND state='running'`,
          )
          .run(now, now, row.effect_key);
      this.queue.deadLetterRun(
        row.run_id,
        "External effect outcome is unknown; Knot will not repeat it automatically",
        now,
      );
    }
    return rows.length;
  }

  begin(
    claim: WorkflowClaim,
    operation: JsonValue,
    maximumEffectsPerRun: number,
    now = Date.now(),
  ): EffectStart {
    const effectKey = `workflow:${claim.run.runId}:${claim.step.stepId}`;
    const operationDigest = digest("knot.workflow.effect.v1", canonicalJson(operation));
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.store.db
        .prepare("SELECT 1 FROM workflow_effect_receipts WHERE effect_key=?")
        .get(effectKey);
      const count = this.store.db
        .prepare("SELECT COUNT(*) AS count FROM workflow_effect_receipts WHERE run_id=?")
        .get(claim.run.runId) as { count: number };
      if (!existing && Number(count.count) >= maximumEffectsPerRun) {
        this.store.db.exec("COMMIT");
        return { kind: "blocked", error: "Workflow effect budget is exhausted" };
      }
      this.store.db
        .prepare(
          `INSERT INTO workflow_effect_receipts(
             effect_key,run_id,step_id,operation_digest,state,fencing_token,updated_at
           ) VALUES(?,?,?,?,'prepared',?,?) ON CONFLICT(effect_key) DO NOTHING`,
        )
        .run(
          effectKey,
          claim.run.runId,
          claim.step.stepId,
          operationDigest,
          claim.attempt.fencingToken,
          now,
        );
      const row = this.store.db
        .prepare(
          "SELECT operation_digest,state,result_json FROM workflow_effect_receipts WHERE effect_key=?",
        )
        .get(effectKey) as {
        operation_digest: string;
        state: string;
        result_json: string | null;
      };
      if (row.operation_digest !== operationDigest)
        throw new Error("Workflow effect key is bound to different approved content");
      if (row.state === "succeeded") {
        this.store.db.exec("COMMIT");
        return { kind: "replay", result: jsonValueSchema.parse(JSON.parse(row.result_json!)) };
      }
      if (["running", "outcome_unknown"].includes(row.state)) {
        this.store.db.exec("COMMIT");
        return {
          kind: "blocked",
          error: "External effect outcome is unknown; Knot will not repeat it automatically",
        };
      }
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_effect_receipts SET state='running',fencing_token=?,started_at=?,
           completed_at=NULL,error=NULL,updated_at=?
           WHERE effect_key=? AND (
             state='prepared' OR
             (state='failed' AND completed_at IS NOT NULL AND fencing_token!=?)
           )`,
        )
        .run(claim.attempt.fencingToken, now, now, effectKey, claim.attempt.fencingToken).changes;
      if (changed !== 1) throw new Error("Workflow effect receipt could not be started");
      this.store.db.exec("COMMIT");
      return { kind: "execute", effectKey };
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(effectKey: string, fencingToken: string, result: JsonValue, now = Date.now()): boolean {
    return (
      this.store.db
        .prepare(
          `UPDATE workflow_effect_receipts SET state='succeeded',result_json=?,completed_at=?,updated_at=?
           WHERE effect_key=? AND state='running' AND fencing_token=?`,
        )
        .run(canonicalJson(result), now, now, effectKey, fencingToken).changes === 1
    );
  }

  failBeforeEffect(effectKey: string, fencingToken: string, error: string, now = Date.now()): void {
    this.store.db
      .prepare(
        `UPDATE workflow_effect_receipts SET state='failed',error=?,completed_at=?,updated_at=?
         WHERE effect_key=? AND state='running' AND fencing_token=?`,
      )
      .run(safeEffectError(error), now, now, effectKey, fencingToken);
  }

  outcomeUnknown(effectKey: string, fencingToken: string, error: string, now = Date.now()): void {
    this.store.db
      .prepare(
        `UPDATE workflow_effect_receipts SET state='outcome_unknown',error=?,completed_at=?,updated_at=?
         WHERE effect_key=? AND state='running' AND fencing_token=?`,
      )
      .run(safeEffectError(error), now, now, effectKey, fencingToken);
  }
}

class ClosedExecutorError extends Error {}

function success(result: JsonValue): WorkflowStepExecution {
  return { ok: true, result };
}

function failure(error: string): WorkflowStepExecution {
  return { ok: false, error, retryable: false };
}

function toJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function toBoundedJson(value: unknown, maximumBytes = 1024 * 1024): JsonValue {
  const parsed = toJson(value);
  if (Buffer.byteLength(canonicalJson(parsed), "utf8") > maximumBytes)
    throw new ClosedExecutorError("Workflow data result exceeds the 1 MiB execution limit");
  return parsed;
}

function objectIdOf(value: Record<string, unknown>, fallback?: string): string {
  const id = typeof value.id === "string" ? value.id : fallback;
  if (!id) throw new ClosedExecutorError("Anytype returned no object ID");
  return id;
}

function typeKeyOf(value: Record<string, unknown>): string | undefined {
  if (typeof value.type_key === "string") return value.type_key;
  if (typeof value.type === "string") return value.type;
  if (value.type && typeof value.type === "object" && "key" in value.type)
    return String((value.type as { key: unknown }).key);
  return undefined;
}

function objectIdsFrom(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(objectIdsFrom);
  if (!value || typeof value !== "object") return typeof value === "string" ? [value] : [];
  if (typeof value.objectId === "string") return [value.objectId];
  if (typeof value.id === "string") return [value.id];
  if (Array.isArray(value.objectIds))
    return value.objectIds.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(value.objects)) return value.objects.flatMap(objectIdsFrom);
  return [];
}

function pointer(value: JsonValue, path: string): JsonValue {
  if (!path) return value;
  let current: JsonValue = value;
  for (const encoded of path.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= current.length)
        throw new ClosedExecutorError(`Transform pointer does not exist: ${path}`);
      current = current[Number(segment)]!;
    } else if (current && typeof current === "object" && Object.hasOwn(current, segment))
      current = current[segment]!;
    else throw new ClosedExecutorError(`Transform pointer does not exist: ${path}`);
  }
  return current;
}

function digest(domain: string, value: string): string {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 15)}...[truncated]`;
}

function safeEffectError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(
      /["']?\b(api[_ -]?key|authorization|credential|message|password|prompt|secret|token)\b["']?\s*[:=]\s*["']?[^\s,"';}]+["']?/giu,
      "$1=[redacted]",
    )
    .slice(0, 2_000);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
