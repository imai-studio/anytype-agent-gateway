import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import {
  evaluateWorkflowAuthority,
  evaluateWorkflowPolicy,
  type WorkflowAuthorityEvaluation,
} from "./policy.js";
import { WorkflowQueue, type WorkflowClaim, type WorkflowRetryPolicy } from "./runner-store.js";
import type { NormalizedEventRecord, WorkflowVersionRecord } from "./store-types.js";
import {
  type JsonValue,
  type WorkflowDefinition,
  canonicalJson,
  canonicalStoredWorkflowApproval,
  canonicalStoredWorkflowDefinition,
  workflowApprovalHash,
  workflowApprovalMaterial,
  workflowDefinitionSchema,
  workflowPrincipalDigest,
  workflowSourceDigest,
  workflowVersionHash,
} from "./workflow.js";

type RunnerConfig = AgentConfig["automation"];

export type WorkflowStepExecution =
  { ok: true; result: JsonValue } | { ok: false; error: string; retryable: boolean };

export interface WorkflowStepExecutor {
  execute(claim: WorkflowClaim, definition: WorkflowDefinition): Promise<WorkflowStepExecution>;
}

export interface WorkflowSourceSnapshot {
  definitionSource: string;
  sourceModifiedAt: number;
  editorParticipantId: string;
  editorProvenance: "anytype-native" | "authenticated-chat" | "operator-cli";
}

export interface WorkflowSourceResolver {
  refetch(version: WorkflowVersionRecord): Promise<WorkflowSourceSnapshot | undefined>;
}

const SOURCE_REFETCH_REQUIRED =
  "source_refetch_required: workflow text is not stored; refetch and reverify the source before execution";

export class NoEffectWorkflowStepExecutor implements WorkflowStepExecutor {
  async execute(
    claim: WorkflowClaim,
    definition: WorkflowDefinition,
  ): Promise<WorkflowStepExecution> {
    const step = definition.spec.steps.find((candidate) => candidate.id === claim.step.stepId);
    if (!step) return { ok: false, error: "Workflow step no longer exists", retryable: false };
    if (step.kind === "transform" && !step.config?.transformRef && !step.config?.inputStepId)
      return { ok: true, result: { kind: "no-op", stepId: step.id } };
    return {
      ok: false,
      error: `No effect executor is installed for workflow step kind: ${step.kind}`,
      retryable: false,
    };
  }
}

export class WorkflowRunner {
  readonly queue: WorkflowQueue;
  private readonly workerIds: string[];

  constructor(
    private readonly store: Store,
    private readonly config: RunnerConfig,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
    private readonly executor: WorkflowStepExecutor = new NoEffectWorkflowStepExecutor(),
    private readonly now: () => number = Date.now,
    private readonly sourceResolver?: WorkflowSourceResolver,
  ) {
    this.queue = new WorkflowQueue(store);
    this.workerIds = Array.from(
      { length: config.runner.workerCount },
      (_, index) => `workflow-worker-${index + 1}-${randomUUID()}`,
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tickOnce();
      } catch (error) {
        this.log("workflow_runner_tick_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await wait(this.config.runner.pollIntervalMilliseconds, signal);
    }
  }

  async tickOnce(): Promise<void> {
    const now = this.now();
    const initialized = this.queue.initializeMatcher(now);
    const sourceResumed = await this.resumeSourceRefetchSteps(now);
    const revoked = this.reauthorizeActiveRuns(now);
    const expired = this.queue.expireRunDeadlines(now);
    const recovered = this.queue.recoverExpiredLeases(
      (runId, stepId) => this.retryFor(runId, stepId),
      now,
    );
    const matched = initialized ? 0 : this.matchEventsOnce(now);
    const dispatched = this.dispatchOnce(now);
    let claimed = 0;
    const allowedHashes = new Set(this.queue.activeRuns().map((run) => run.authorityHash));
    for (const workerId of this.workerIds) {
      const claim = this.queue.claimStep(
        workerId,
        allowedHashes,
        this.config.runner.leaseSeconds * 1_000,
        now,
      );
      if (!claim) continue;
      claimed += 1;
      await this.executeClaim(claim);
    }
    if (matched || dispatched || recovered || revoked || expired || claimed || sourceResumed)
      this.log("workflow_runner_tick_complete", {
        matched,
        dispatched,
        recovered,
        revoked,
        expired,
        claimed,
        sourceResumed,
      });
  }

  matchEventsOnce(now = this.now()): number {
    let matched = 0;
    const cursor = this.queue.cursor();
    const events = this.queue.eventsAfter(cursor, this.config.runner.batchSize);
    for (const event of events) {
      const deliveries: Array<
        Parameters<WorkflowQueue["createDeliveriesAndAdvanceCursor"]>[1][number]
      > = [];
      if (!isControlPlaneEvent(event)) {
        for (const version of this.queue.activeWorkflowVersions()) {
          let definition: WorkflowDefinition;
          try {
            definition = parseStoredVersion(version).definition;
          } catch {
            this.log("workflow_version_integrity_failed", {
              workflowIdDigest: stableId("workflow-log", version.workflowId),
            });
            continue;
          }
          if (!definition.spec.enabled || !matchesAnyTrigger(version.workflowId, definition, event))
            continue;
          const authorization = this.authorize(version, definition);
          if (!authorization?.evaluation.allowed) continue;
          if (event.causalDepth > authorization.evaluation.effectiveLimits.maximumCausalDepth)
            continue;
          if (!definition.spec.behavior.includeSelfWrites && event.source === "self") continue;
          this.ensureAutomaticApproval(version, authorization.evaluation, now);
          deliveries.push({
            deliveryId: stableId(
              "delivery",
              version.workflowId,
              version.versionHash,
              event.dedupeKey,
            ),
            workflowId: version.workflowId,
            versionHash: version.versionHash,
            eventId: event.eventId,
            eventDedupeKey: event.dedupeKey,
            approvalHash: version.approvalHash,
            authorityHash: authorization.evaluation.authorityHash,
            actorPrincipalDigest: event.editor?.principalDigest ?? version.editorPrincipalDigest!,
            actorProvenance: event.editor?.provenance ?? version.editorProvenance!,
          });
          matched += 1;
        }
      }
      this.queue.createDeliveriesAndAdvanceCursor(event, deliveries, now);
    }
    return matched;
  }

  dispatchOnce(now = this.now()): number {
    let dispatched = 0;
    for (const delivery of this.queue.pendingDeliveries(this.config.runner.batchSize)) {
      if (!this.queue.isActiveVersion(delivery.workflowId, delivery.versionHash)) {
        this.queue.cancelDelivery(delivery.deliveryId);
        continue;
      }
      const version = this.store.workflowVersion(delivery.workflowId, delivery.versionHash);
      if (!version) continue;
      let definition: WorkflowDefinition;
      try {
        definition = parseStoredVersion(version).definition;
      } catch {
        this.queue.deadLetterDelivery(delivery.deliveryId);
        this.log("workflow_version_integrity_failed", {
          workflowIdDigest: stableId("workflow-log", delivery.workflowId),
        });
        continue;
      }
      const authorization = this.authorize(version, definition);
      if (!authorization?.evaluation.allowed) continue;
      this.ensureAutomaticApproval(version, authorization.evaluation, now);
      const authorityHash = authorization.evaluation.authorityHash;
      const approval = this.store.currentWorkflowApproval(
        delivery.workflowId,
        delivery.approvalHash,
        authorityHash,
        now,
      );
      if (!approval) continue;
      if (
        this.queue.dispatchDelivery(
          delivery.deliveryId,
          definition,
          authorization.evaluation.effectiveLimits,
          authorityHash,
          now,
        )
      )
        dispatched += 1;
    }
    return dispatched;
  }

  private async executeClaim(claim: WorkflowClaim): Promise<void> {
    const now = this.now();
    if (!this.queue.startStep(claim.run.runId, claim.step.stepId, claim.attempt.fencingToken, now))
      return;
    const heartbeat = this.startLeaseHeartbeat(claim);
    try {
      const version = this.store.workflowVersion(claim.run.workflowId, claim.run.versionHash);
      if (!version) {
        this.queue.deadLetterRun(claim.run.runId, "Workflow version is unavailable", now);
        return;
      }
      let stored: StoredWorkflowDefinition;
      if (
        heartbeat.leaseLost() ||
        !this.queue.claimIsCurrent(
          claim.run.runId,
          claim.step.stepId,
          claim.attempt.fencingToken,
          this.now(),
        )
      )
        return;
      try {
        stored = parseStoredVersion(version);
      } catch {
        this.queue.deadLetterRun(
          claim.run.runId,
          "workflow_version_integrity_failed: stored definition, approval, or policy did not match its immutable hashes",
          this.now(),
        );
        return;
      }
      const resolution = await this.definitionForExecution(version, stored);
      if (!resolution.ok) {
        this.queue.requireSourceRefetch(
          claim.run.runId,
          claim.step.stepId,
          claim.attempt.fencingToken,
          resolution.reason,
          this.now(),
        );
        return;
      }
      const definition = resolution.definition;
      const authorization = this.authorize(version, definition);
      const approval = authorization?.evaluation.allowed
        ? this.store.currentWorkflowApproval(
            version.workflowId,
            version.approvalHash,
            authorization.evaluation.authorityHash,
            this.now(),
          )
        : undefined;
      if (
        !authorization?.evaluation.allowed ||
        authorization.evaluation.authorityHash !== claim.run.authorityHash ||
        !approval
      ) {
        if (
          !this.queue.claimIsCurrent(
            claim.run.runId,
            claim.step.stepId,
            claim.attempt.fencingToken,
            this.now(),
          )
        )
          return;
        this.queue.pauseRunForApproval(
          claim.run.runId,
          "Source revalidation changed the workflow authority or exact approval",
          this.now(),
        );
        return;
      }
      if (
        heartbeat.leaseLost() ||
        !this.queue.claimIsCurrent(
          claim.run.runId,
          claim.step.stepId,
          claim.attempt.fencingToken,
          this.now(),
        )
      )
        return;
      let execution: WorkflowStepExecution;
      try {
        execution = await this.executor.execute(claim, definition);
      } catch (error) {
        execution = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }
      const finishedAt = this.now();
      const settled = execution.ok
        ? this.queue.completeStep(
            claim.run.runId,
            claim.step.stepId,
            claim.attempt.fencingToken,
            execution.result,
            finishedAt,
          )
        : this.queue.failStep(
            claim.run.runId,
            claim.step.stepId,
            claim.attempt.fencingToken,
            execution.error,
            retryForDefinition(definition, claim.step.stepId),
            execution.retryable,
            finishedAt,
          );
      if (!settled) this.handleRejectedSettlement(claim, finishedAt);
    } finally {
      heartbeat.stop();
    }
  }

  private startLeaseHeartbeat(claim: WorkflowClaim): {
    leaseLost: () => boolean;
    stop: () => void;
  } {
    const leaseMilliseconds = this.config.runner.leaseSeconds * 1_000;
    const intervalMilliseconds = Math.max(50, Math.floor(leaseMilliseconds / 3));
    let lost = false;
    const timer = setInterval(() => {
      try {
        if (
          !this.queue.heartbeat(
            claim.run.runId,
            claim.step.stepId,
            claim.attempt.fencingToken,
            leaseMilliseconds,
            this.now(),
          )
        )
          lost = true;
      } catch (error) {
        lost = true;
        this.log("workflow_step_heartbeat_failed", {
          workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
          stepId: claim.step.stepId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, intervalMilliseconds);
    timer.unref();
    return { leaseLost: () => lost, stop: () => clearInterval(timer) };
  }

  private handleRejectedSettlement(claim: WorkflowClaim, now: number): void {
    const reason =
      "Workflow executor returned after its lease was lost; the outcome requires operator reconciliation";
    const deadLettered = this.queue.deadLetterRun(claim.run.runId, reason, now);
    this.log("workflow_step_settlement_rejected", {
      workflowIdDigest: stableId("workflow-log", claim.run.workflowId),
      stepId: claim.step.stepId,
      deadLettered,
    });
  }

  private reauthorizeActiveRuns(now: number): number {
    let revoked = 0;
    for (const run of this.queue.activeRuns()) {
      const version = this.store.workflowVersion(run.workflowId, run.versionHash);
      if (!version) {
        if (this.queue.deadLetterRun(run.runId, "Workflow version is unavailable", now))
          revoked += 1;
        continue;
      }
      let definition: WorkflowDefinition;
      try {
        definition = parseStoredVersion(version).definition;
      } catch {
        if (
          this.queue.deadLetterRun(
            run.runId,
            "workflow_version_integrity_failed: stored definition, approval, or policy did not match its immutable hashes",
            now,
          )
        )
          revoked += 1;
        continue;
      }
      const authorization = this.authorize(version, definition);
      if (!authorization?.evaluation.allowed) {
        if (
          this.queue.pauseRunForApproval(
            run.runId,
            "Current local authority does not permit this run",
            now,
          )
        )
          revoked += 1;
        continue;
      }
      this.ensureAutomaticApproval(version, authorization.evaluation, now);
      const currentHash = authorization.evaluation.authorityHash;
      const approval = this.store.currentWorkflowApproval(
        run.workflowId,
        run.approvalHash,
        currentHash,
        now,
      );
      if (!approval) {
        if (
          this.queue.pauseRunForApproval(
            run.runId,
            "Current authority requires a new exact approval",
            now,
          )
        )
          revoked += 1;
      } else this.queue.resumeRunWithAuthority(run.runId, currentHash, now);
    }
    return revoked;
  }

  private authorize(
    version: WorkflowVersionRecord,
    definition: WorkflowDefinition,
  ): { participantId: string; evaluation: WorkflowAuthorityEvaluation } | undefined {
    if (!version.editorPrincipalDigest || !version.editorProvenance) return undefined;
    const participantId = this.config.allowedAuthorIds.find(
      (candidate) => workflowPrincipalDigest(candidate) === version.editorPrincipalDigest,
    );
    if (!participantId) return undefined;
    return {
      participantId,
      evaluation: evaluateWorkflowAuthority(definition, this.config, {
        sourceSpaceId: version.spaceId,
        editor: { principalId: participantId, provenance: version.editorProvenance },
      }),
    };
  }

  private ensureAutomaticApproval(
    version: WorkflowVersionRecord,
    authority: WorkflowAuthorityEvaluation,
    now: number,
  ): void {
    if (authority.riskTier !== "T0") return;
    const latest = this.store.latestWorkflowApproval(version.workflowId, version.approvalHash);
    if (latest && latest.decision !== "approved") return;
    if (
      this.store.currentWorkflowApproval(
        version.workflowId,
        version.approvalHash,
        authority.authorityHash,
        now,
      )
    )
      return;
    this.store.recordWorkflowApproval({
      decisionId: randomUUID(),
      workflowId: version.workflowId,
      approvalHash: version.approvalHash,
      decision: "approved",
      mode: "automatic",
      authorityHash: authority.authorityHash,
      actorPrincipalDigest: version.editorPrincipalDigest!,
      reason: "T0 workflow approved by the configured local policy",
      decidedAt: now,
    });
  }

  private retryFor(runId: string, stepId: string): WorkflowRetryPolicy {
    const run = this.queue.run(runId);
    if (!run) throw new Error("Unknown workflow run");
    const version = this.store.workflowVersion(run.workflowId, run.versionHash);
    if (!version) throw new Error("Workflow version is unavailable");
    return retryForDefinition(parseStoredVersion(version).definition, stepId);
  }

  private async resumeSourceRefetchSteps(now: number): Promise<number> {
    if (!this.sourceResolver) return 0;
    let resumed = 0;
    const retryAt = now + Math.max(5_000, this.config.runner.pollIntervalMilliseconds * 10);
    for (const step of this.queue.sourceRefetchSteps(now, this.config.runner.batchSize)) {
      const run = this.queue.run(step.runId);
      if (!run) continue;
      const version = this.store.workflowVersion(run.workflowId, run.versionHash);
      if (!version) continue;
      let stored: StoredWorkflowDefinition;
      try {
        stored = parseStoredVersion(version);
      } catch {
        this.queue.deadLetterRun(
          run.runId,
          "workflow_version_integrity_failed: stored definition, approval, or policy did not match its immutable hashes",
          now,
        );
        continue;
      }
      const resolution = await this.definitionForExecution(version, stored);
      if (!resolution.ok) {
        this.queue.deferSourceRefetch(step.runId, step.stepId, resolution.reason, retryAt, now);
        continue;
      }
      const authorization = this.authorize(version, resolution.definition);
      if (!authorization?.evaluation.allowed) {
        this.queue.deferSourceRefetch(
          step.runId,
          step.stepId,
          "source_reverification_failed: current local authority rejected the refetched definition",
          retryAt,
          now,
        );
        continue;
      }
      const approval = this.store.currentWorkflowApproval(
        version.workflowId,
        version.approvalHash,
        authorization.evaluation.authorityHash,
        now,
      );
      if (!approval) {
        this.queue.deferSourceRefetch(
          step.runId,
          step.stepId,
          "source_reverification_failed: no exact approval exists for the refetched definition",
          retryAt,
          now,
        );
        continue;
      }
      if (this.queue.resumeSourceRefetchStep(step.runId, step.stepId, now)) resumed += 1;
    }
    return resumed;
  }

  private async definitionForExecution(
    version: WorkflowVersionRecord,
    stored: StoredWorkflowDefinition,
  ): Promise<{ ok: true; definition: WorkflowDefinition } | { ok: false; reason: string }> {
    if (!stored.sensitiveText.size) return { ok: true, definition: stored.definition };
    if (!this.sourceResolver) return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
    let snapshot: WorkflowSourceSnapshot | undefined;
    try {
      snapshot = await this.sourceResolver.refetch(version);
    } catch {
      return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
    }
    if (!snapshot) return { ok: false, reason: SOURCE_REFETCH_REQUIRED };
    try {
      return { ok: true, definition: verifyRefetchedDefinition(version, snapshot) };
    } catch {
      return {
        ok: false,
        reason:
          "source_reverification_failed: refetched workflow source did not match the stored version, approval, editor, and revision hashes",
      };
    }
  }
}

type StoredWorkflowDefinition = {
  definition: WorkflowDefinition;
  sensitiveText: ReadonlyMap<string, string>;
};

function parseStoredVersion(version: WorkflowVersionRecord): StoredWorkflowDefinition {
  const raw = JSON.parse(version.canonicalDefinitionJson) as JsonValue;
  if (canonicalJson(raw) !== version.canonicalDefinitionJson)
    throw new Error("Stored workflow definition is not canonical JSON");
  const sensitiveText = new Map<string, string>();
  const materialized = materializeStoredDefinition(raw, [], sensitiveText);
  const definition = workflowDefinitionSchema.parse(materialized);
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: version.spaceId });
  if (
    policy.riskTier !== version.riskTier ||
    canonicalJson(policy.requiredCapabilities) !== canonicalJson(version.requiredCapabilities)
  )
    throw new Error("Stored workflow policy no longer matches the immutable version record");
  if (
    !/^sha256:[a-f0-9]{64}$/.test(version.versionHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(version.approvalHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(version.sourceDigest)
  )
    throw new Error("Stored workflow digest is invalid");
  if (!sensitiveText.size) {
    if (
      workflowVersionHash(definition) !== version.versionHash ||
      workflowApprovalHash(definition) !== version.approvalHash ||
      canonicalJson(workflowApprovalMaterial(definition)) !== version.canonicalApprovalJson
    )
      throw new Error("Stored workflow hashes no longer match the immutable definition");
  } else {
    const approval = JSON.parse(canonicalJson(workflowApprovalMaterial(definition))) as JsonValue;
    for (const [path, digest] of sensitiveText)
      setJsonPath(approval, path.split("/"), { redacted: true, digest });
    if (canonicalJson(approval) !== version.canonicalApprovalJson)
      throw new Error("Stored workflow approval projection does not match the redacted definition");
  }
  return { definition, sensitiveText };
}

function materializeStoredDefinition(
  value: JsonValue,
  path: string[],
  sensitiveText: Map<string, string>,
): JsonValue {
  if (Array.isArray(value))
    return value.map((item, index) =>
      materializeStoredDefinition(item, [...path, String(index)], sensitiveText),
    );
  if (!value || typeof value !== "object") return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (key === "prompt" || key === "message") {
      if (isRedactedText(nested)) {
        const pointer = nestedPath.join("/");
        sensitiveText.set(pointer, nested.digest);
        result[key] = `[${key} unavailable until source refetch]`;
      } else result[key] = materializeStoredDefinition(nested, nestedPath, sensitiveText);
    } else result[key] = materializeStoredDefinition(nested, nestedPath, sensitiveText);
  }
  return result;
}

function isRedactedText(value: JsonValue): value is { redacted: true; digest: string } {
  return (
    !Array.isArray(value) &&
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    value.redacted === true &&
    typeof value.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.digest)
  );
}

function setJsonPath(target: JsonValue, path: string[], value: JsonValue): void {
  let current = target;
  for (const part of path.slice(0, -1)) {
    if (!current || typeof current !== "object")
      throw new Error("Redacted workflow path is absent from approval material");
    current = Array.isArray(current) ? current[Number(part)]! : current[part]!;
  }
  const final = path.at(-1);
  if (!final || !current || typeof current !== "object")
    throw new Error("Redacted workflow path is invalid");
  if (Array.isArray(current)) current[Number(final)] = value;
  else current[final] = value;
}

function verifyRefetchedDefinition(
  version: WorkflowVersionRecord,
  snapshot: WorkflowSourceSnapshot,
): WorkflowDefinition {
  if (
    snapshot.sourceModifiedAt !== version.sourceModifiedAt ||
    snapshot.editorProvenance !== version.editorProvenance ||
    workflowPrincipalDigest(snapshot.editorParticipantId) !== version.editorPrincipalDigest ||
    workflowSourceDigest(snapshot.definitionSource) !== version.sourceDigest
  )
    throw new Error("Refetched workflow source identity or revision changed");
  const definition = workflowDefinitionSchema.parse(
    YAML.parse(snapshot.definitionSource, { maxAliasCount: 0 }),
  );
  const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: version.spaceId });
  if (
    workflowVersionHash(definition) !== version.versionHash ||
    workflowApprovalHash(definition) !== version.approvalHash ||
    canonicalStoredWorkflowDefinition(definition) !== version.canonicalDefinitionJson ||
    canonicalStoredWorkflowApproval(definition) !== version.canonicalApprovalJson ||
    policy.riskTier !== version.riskTier ||
    canonicalJson(policy.requiredCapabilities) !== canonicalJson(version.requiredCapabilities)
  )
    throw new Error("Refetched workflow source does not match the immutable version");
  return definition;
}

function retryForDefinition(definition: WorkflowDefinition, stepId: string): WorkflowRetryPolicy {
  return definition.spec.steps.find((step) => step.id === stepId)?.retry ?? definition.spec.retry;
}

function matchesAnyTrigger(
  workflowId: string,
  definition: WorkflowDefinition,
  event: NormalizedEventRecord,
): boolean {
  return definition.spec.triggers.some((trigger) => {
    if (trigger.kind === "manual")
      return (
        event.kind === "manual.run" &&
        event.editor !== undefined &&
        ["operator-cli", "authenticated-chat"].includes(event.editor.provenance) &&
        payloadString(event, "workflowId") === workflowId
      );
    if (trigger.kind === "schedule")
      return event.kind === "schedule.tick" && payloadString(event, "workflowId") === workflowId;
    if (trigger.kind === "anytype.chat")
      return (
        event.kind === "chat.message" &&
        event.editor !== undefined &&
        (!trigger.spaceId || trigger.spaceId === event.spaceId) &&
        (!trigger.chatId || trigger.chatId === payloadString(event, "chatId"))
      );
    const eventName = event.kind.startsWith("object.") ? event.kind.slice("object.".length) : "";
    return (
      trigger.kind === "anytype.event" &&
      event.editor !== undefined &&
      event.editor.provenance === "anytype-native" &&
      trigger.events.includes(eventName as "created" | "updated" | "archived") &&
      (!trigger.spaceId || trigger.spaceId === event.spaceId) &&
      (!trigger.objectTypeId || trigger.objectTypeId === payloadString(event, "objectTypeId")) &&
      Object.entries(trigger.filter).every(
        ([key, value]) => JSON.stringify(payloadValue(event, key)) === JSON.stringify(value),
      )
    );
  });
}

function isControlPlaneEvent(event: NormalizedEventRecord): boolean {
  return payloadString(event, "controlPlane") === "workflow-definition";
}

function payloadValue(event: NormalizedEventRecord, key: string): JsonValue | undefined {
  if (!event.payload || Array.isArray(event.payload) || typeof event.payload !== "object")
    return undefined;
  return event.payload[key];
}

function payloadString(event: NormalizedEventRecord, key: string): string | undefined {
  const value = payloadValue(event, key);
  return typeof value === "string" ? value : undefined;
}

function stableId(domain: string, ...parts: string[]): string {
  return `sha256:${createHash("sha256")
    .update(`knot.workflow.${domain}.v1\0`)
    .update(parts.join("\0"))
    .digest("hex")}`;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
