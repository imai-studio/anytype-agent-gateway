import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { Store } from "../store.js";
import { evaluateWorkflowAuthority, type WorkflowAuthorityEvaluation } from "./policy.js";
import { WorkflowQueue, type WorkflowClaim, type WorkflowRetryPolicy } from "./runner-store.js";
import type { NormalizedEventRecord, WorkflowVersionRecord } from "./store-types.js";
import {
  type JsonValue,
  type WorkflowDefinition,
  workflowDefinitionSchema,
  workflowPrincipalDigest,
} from "./workflow.js";

type RunnerConfig = AgentConfig["automation"];

export type WorkflowStepExecution =
  { ok: true; result: JsonValue } | { ok: false; error: string; retryable: boolean };

export interface WorkflowStepExecutor {
  execute(claim: WorkflowClaim, definition: WorkflowDefinition): Promise<WorkflowStepExecution>;
}

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
    if (matched || dispatched || recovered || revoked || expired || claimed)
      this.log("workflow_runner_tick_complete", {
        matched,
        dispatched,
        recovered,
        revoked,
        expired,
        claimed,
      });
  }

  matchEventsOnce(now = this.now()): number {
    let matched = 0;
    let cursor = this.queue.cursor();
    const events = this.queue.eventsAfter(cursor, this.config.runner.batchSize);
    for (const event of events) {
      if (!isControlPlaneEvent(event)) {
        for (const version of this.queue.activeWorkflowVersions()) {
          const definition = parseDefinition(version);
          if (!definition.spec.enabled || !matchesAnyTrigger(version.workflowId, definition, event))
            continue;
          const authorization = this.authorize(version, definition);
          if (!authorization?.evaluation.allowed) continue;
          if (event.causalDepth > authorization.evaluation.effectiveLimits.maximumCausalDepth)
            continue;
          if (!definition.spec.behavior.includeSelfWrites && event.source === "self") continue;
          this.ensureAutomaticApproval(version, authorization.evaluation, now);
          this.queue.createDelivery(
            {
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
            },
            now,
          );
          matched += 1;
        }
      }
      this.queue.advanceCursor(event, now);
      cursor = { ...cursor, recordedAt: event.recordedAt, eventId: event.eventId };
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
      const definition = parseDefinition(version);
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
    const version = this.store.workflowVersion(claim.run.workflowId, claim.run.versionHash);
    if (!version) {
      this.queue.deadLetterRun(claim.run.runId, "Workflow version is unavailable", now);
      return;
    }
    const definition = parseDefinition(version);
    const execution = await this.executor.execute(claim, definition);
    const finishedAt = this.now();
    if (execution.ok)
      this.queue.completeStep(
        claim.run.runId,
        claim.step.stepId,
        claim.attempt.fencingToken,
        execution.result,
        finishedAt,
      );
    else
      this.queue.failStep(
        claim.run.runId,
        claim.step.stepId,
        claim.attempt.fencingToken,
        execution.error,
        retryForDefinition(definition, claim.step.stepId),
        execution.retryable,
        finishedAt,
      );
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
      const definition = parseDefinition(version);
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
    return retryForDefinition(parseDefinition(version), stepId);
  }
}

function parseDefinition(version: WorkflowVersionRecord): WorkflowDefinition {
  return workflowDefinitionSchema.parse(JSON.parse(version.canonicalDefinitionJson));
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
