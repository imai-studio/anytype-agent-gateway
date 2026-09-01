import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { workflowAuthorityHash } from "./automation/policy.js";
import { WorkflowQueue } from "./automation/runner-store.js";
import type {
  WorkflowApprovalDecisionKind,
  WorkflowRunState,
  WorkflowVersionRecord,
} from "./automation/store-types.js";
import { canonicalJson, workflowPrincipalDigest, type JsonValue } from "./automation/workflow.js";
import { Store } from "./store.js";

type Output = (line: string) => void;

interface ReadOptions {
  agentConfigFile: string;
  json?: boolean;
  output?: Output;
}

interface MutationOptions extends ReadOptions {
  actorDigest?: string;
  yes: boolean;
  reasonCode?: string;
  now?: number;
}

export async function workflowList(input: ReadOptions & { limit?: number }): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store, queue, config }) => {
    const authorityHash = workflowAuthorityHash(config.automation);
    const records = store.workflowDefinitions(input.limit ?? 100).map((definition) => {
      const version = activeVersion(store, definition.workflowId);
      const override = store.workflowOperatorOverride(definition.workflowId);
      const approval = version
        ? store.latestWorkflowApproval(definition.workflowId, version.approvalHash)
        : undefined;
      return {
        workflowId: definition.workflowId,
        name: definition.name,
        state: definition.state,
        enabled: override?.enabled ?? true,
        activeVersionHash: definition.activeVersionHash,
        approvalHash: version?.approvalHash,
        approval: approval?.decision ?? "missing",
        authorityCurrent: approval?.authorityHash === authorityHash,
        executable: version
          ? queue.isActiveVersion(definition.workflowId, version.versionHash)
          : false,
        updatedAt: definition.lastSeenAt,
      };
    });
    emit(input, records, (record) =>
      [
        record.workflowId,
        record.state,
        record.enabled ? "enabled" : "disabled",
        `approval=${record.approval}`,
        record.authorityCurrent ? "authority=current" : "authority=stale-or-missing",
        record.name,
      ].join("\t"),
    );
  });
}

export async function workflowShow(input: ReadOptions & { workflowId: string }): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store, queue, config }) => {
    const definition = requireWorkflow(store, input.workflowId);
    const version = activeVersion(store, input.workflowId);
    const approval = version
      ? store.latestWorkflowApproval(input.workflowId, version.approvalHash)
      : undefined;
    const override = store.workflowOperatorOverride(input.workflowId);
    const record = {
      workflowId: definition.workflowId,
      name: definition.name,
      spaceId: definition.spaceId,
      objectId: definition.objectId,
      state: definition.state,
      validationErrors: definition.validationErrors,
      enabled: override?.enabled ?? true,
      overrideReasonCode: override?.reasonCode,
      activeVersion: version
        ? {
            versionHash: version.versionHash,
            approvalHash: version.approvalHash,
            riskTier: version.riskTier,
            requiredCapabilities: version.requiredCapabilities,
            sourceDigest: version.sourceDigest,
            sourceModifiedAt: version.sourceModifiedAt,
          }
        : undefined,
      approval: approval
        ? {
            decisionId: approval.decisionId,
            decision: approval.decision,
            authorityCurrent: approval.authorityHash === workflowAuthorityHash(config.automation),
            decidedAt: approval.decidedAt,
            expiresAt: approval.expiresAt,
          }
        : undefined,
      executable: version ? queue.isActiveVersion(input.workflowId, version.versionHash) : false,
    };
    (input.output ?? console.log)(JSON.stringify(record, null, input.json ? undefined : 2));
  });
}

export async function workflowApprovalAction(
  input: MutationOptions & {
    workflowId: string;
    approvalHash: string;
    action: "approve" | "reject" | "revoke";
    expiresAt?: number;
  },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store, config }) => {
    requireConfirmed(input.yes);
    const actorPrincipalDigest = authorizedActor(config, input.actorDigest);
    const version =
      input.action === "revoke" ? undefined : requireActiveVersion(store, input.workflowId);
    if (version && version.approvalHash !== input.approvalHash)
      throw new Error("Approval hash does not match the active workflow version");
    if (input.action === "revoke") requireWorkflow(store, input.workflowId);
    const now = input.now ?? Date.now();
    const latest = store.latestWorkflowApproval(input.workflowId, input.approvalHash);
    if (input.action === "revoke" && latest?.decision !== "approved")
      throw new Error("Only the current approved decision can be revoked");
    const decision: WorkflowApprovalDecisionKind =
      input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "revoked";
    const reasonCode =
      input.action === "approve" ? input.reasonCode : requireReasonCode(input.reasonCode);
    if (input.expiresAt !== undefined && input.action !== "approve")
      throw new Error("Only approvals may have an expiry time");
    const authorityHash = workflowAuthorityHash(config.automation);
    const decisionId = randomUUID();
    store.recordWorkflowApproval(
      {
        decisionId,
        workflowId: input.workflowId,
        approvalHash: input.approvalHash,
        decision,
        mode: "manual",
        authorityHash,
        actorPrincipalDigest,
        ...(reasonCode ? { reason: reasonCode } : {}),
        decidedAt: now,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(latest ? { supersedesDecisionId: latest.decisionId } : {}),
      },
      {
        auditId: randomUUID(),
        action: `workflow.${input.action}`,
        actorPrincipalDigest,
        workflowId: input.workflowId,
        ...(reasonCode ? { reasonCode } : {}),
        details: { approvalHash: input.approvalHash, authorityHash, decisionId },
      },
    );
    (input.output ?? console.log)(`${decision}: ${input.workflowId} ${input.approvalHash}`);
  });
}

export async function workflowSetEnabled(
  input: MutationOptions & { workflowId: string; enabled: boolean },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store, config }) => {
    requireConfirmed(input.yes);
    const actorPrincipalDigest = authorizedActor(config, input.actorDigest);
    const reasonCode = requireReasonCode(input.reasonCode);
    const result = store.setWorkflowOperatorOverride({
      workflowId: input.workflowId,
      enabled: input.enabled,
      actorPrincipalDigest,
      reasonCode,
      auditId: randomUUID(),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    (input.output ?? console.log)(
      `${result.enabled ? "enabled" : "disabled"}: ${result.workflowId}`,
    );
  });
}

export async function workflowManualRun(
  input: MutationOptions & { workflowId: string; approvalHash: string },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store, config }) => {
    requireConfirmed(input.yes);
    const actorPrincipalDigest = authorizedActor(config, input.actorDigest);
    const version = requireActiveVersion(store, input.workflowId);
    requireManualTrigger(version);
    if (version.approvalHash !== input.approvalHash)
      throw new Error("Approval hash does not match the active workflow version");
    if (store.workflowOperatorOverride(input.workflowId)?.enabled === false)
      throw new Error("Workflow is disabled by an operator override");
    const now = input.now ?? Date.now();
    const authorityHash = workflowAuthorityHash(config.automation);
    if (!store.currentWorkflowApproval(input.workflowId, input.approvalHash, authorityHash, now))
      throw new Error("Workflow lacks a current approval under the configured authority");
    const eventId = randomUUID();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.recordNormalizedEvent({
        eventId,
        dedupeKey: `operator-manual:${eventId}`,
        kind: "manual.run",
        source: "manual",
        spaceId: version.spaceId,
        editor: { principalDigest: actorPrincipalDigest, provenance: "operator-cli" },
        observedAt: now,
        payload: { workflowId: input.workflowId },
        causalDepth: 0,
        recordedAt: now,
      });
      store.appendWorkflowOperatorAudit({
        auditId: randomUUID(),
        action: "workflow.manual_run",
        actorPrincipalDigest,
        workflowId: input.workflowId,
        details: { approvalHash: input.approvalHash, authorityHash, eventId },
        createdAt: now,
      });
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    (input.output ?? console.log)(`queued: ${input.workflowId} event=${eventId}`);
  });
}

export async function workflowRunList(
  input: ReadOptions & { limit?: number; state?: WorkflowRunState },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ queue }) => {
    const records = queue.runs(input.limit ?? 100, input.state).map(safeRun);
    emit(input, records, (record) =>
      [record.runId, record.workflowId, record.state, record.errorDigest ?? ""].join("\t"),
    );
  });
}

export async function workflowRunShow(input: ReadOptions & { runId: string }): Promise<void> {
  await withOperator(input.agentConfigFile, ({ queue }) => {
    const run = queue.run(input.runId);
    if (!run) throw new Error("Unknown workflow run");
    const record = {
      ...safeRun(run),
      steps: queue.steps(input.runId).map((step) => ({
        stepId: step.stepId,
        kind: step.kind,
        state: step.state,
        attemptCount: step.attemptCount,
        sourceRefetchAttemptCount: step.sourceRefetchAttemptCount,
        hasResult: step.result !== undefined,
        resultDigest:
          step.result === undefined ? undefined : sensitiveDigest("step-result", step.result),
        errorDigest:
          step.error === undefined ? undefined : sensitiveDigest("step-error", step.error),
        updatedAt: step.updatedAt,
      })),
      attempts: queue.steps(input.runId).flatMap((step) =>
        queue.attempts(input.runId, step.stepId).map((attempt) => ({
          attemptId: attempt.attemptId,
          stepId: attempt.stepId,
          attemptNumber: attempt.attemptNumber,
          state: attempt.state,
          errorDigest:
            attempt.error === undefined
              ? undefined
              : sensitiveDigest("attempt-error", attempt.error),
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
        })),
      ),
    };
    (input.output ?? console.log)(JSON.stringify(record, null, input.json ? undefined : 2));
  });
}

export async function workflowRunMutation(
  input: MutationOptions & { runId: string; action: "cancel" | "retry" },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ queue, config }) => {
    requireConfirmed(input.yes);
    const actorPrincipalDigest = authorizedActor(config, input.actorDigest);
    const reasonCode = requireReasonCode(input.reasonCode);
    const run = queue.run(input.runId);
    if (!run) throw new Error("Unknown workflow run");
    const now = input.now ?? Date.now();
    const changed =
      input.action === "cancel"
        ? queue.cancelRun(input.runId, actorPrincipalDigest, reasonCode, now, {
            auditId: randomUUID(),
            action: "run.cancel",
            actorPrincipalDigest,
            workflowId: run.workflowId,
            runId: input.runId,
            reasonCode,
            details: { priorState: run.state },
          })
        : queue.retryRun(
            input.runId,
            workflowAuthorityHash(config.automation),
            actorPrincipalDigest,
            reasonCode,
            randomUUID(),
            now,
          );
    if (!changed)
      throw new Error(
        input.action === "retry"
          ? "Run is not safely retryable; it must be terminal, current, approved, idle, and have no uncertain effect receipt"
          : "Run is not cancellable from its current state",
      );
    (input.output ?? console.log)(`${input.action}: ${input.runId}`);
  });
}

export async function workflowEventList(input: ReadOptions & { limit?: number }): Promise<void> {
  await withOperator(input.agentConfigFile, ({ queue }) => {
    const records = queue.recentEvents(input.limit ?? 100).map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      source: event.source,
      spaceId: event.spaceId,
      objectId: event.objectId,
      payloadKind: Array.isArray(event.payload)
        ? "array"
        : event.payload === null
          ? "null"
          : typeof event.payload,
      payloadDigest: sensitiveDigest("event-payload", event.payload),
      hasDiff: event.diff !== undefined,
      diffDigest:
        event.diff === undefined
          ? undefined
          : sensitiveDigest("event-diff", event.diff as unknown as JsonValue),
      recordedAt: event.recordedAt,
    }));
    emit(input, records, (record) =>
      [record.eventId, record.kind, record.source, record.payloadDigest].join("\t"),
    );
  });
}

export async function workflowAuditList(input: ReadOptions & { limit?: number }): Promise<void> {
  await withOperator(input.agentConfigFile, ({ store }) => {
    const records = store.workflowOperatorAudits(input.limit ?? 100).map((audit) => ({
      sequence: audit.sequence,
      auditId: audit.auditId,
      action: audit.action,
      actorPrincipalDigest: audit.actorPrincipalDigest,
      workflowId: audit.workflowId,
      runId: audit.runId,
      reasonCode: audit.reasonCode,
      detailsDigest: sensitiveDigest("operator-audit-details", audit.details),
      createdAt: audit.createdAt,
    }));
    emit(input, records, (record) =>
      [String(record.sequence), record.action, record.workflowId ?? "", record.runId ?? ""].join(
        "\t",
      ),
    );
  });
}

export async function workflowDeadLetterList(
  input: ReadOptions & { limit?: number },
): Promise<void> {
  await withOperator(input.agentConfigFile, ({ queue }) => {
    const limit = input.limit ?? 100;
    const records = [
      ...queue.runs(limit, "dead_letter").map((run) => ({ type: "run" as const, ...safeRun(run) })),
      ...queue.deadLetterDeliveries(limit).map((delivery) => ({
        type: "delivery" as const,
        deliveryId: delivery.deliveryId,
        workflowId: delivery.workflowId,
        state: delivery.state,
        dispatchAttemptCount: delivery.dispatchAttemptCount,
        createdAt: delivery.createdAt,
      })),
    ]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
    emit(input, records, (record) =>
      record.type === "run"
        ? [record.type, record.runId, record.workflowId, record.errorDigest ?? ""].join("\t")
        : [
            record.type,
            record.deliveryId,
            record.workflowId,
            String(record.dispatchAttemptCount),
          ].join("\t"),
    );
  });
}

async function withOperator<T>(
  configFile: string,
  operation: (context: {
    store: Store;
    queue: WorkflowQueue;
    config: AgentConfig;
  }) => T | Promise<T>,
): Promise<T> {
  const config = await loadConfig(configFile);
  if (!config.automation.enabled || !config.automation.execution)
    throw new Error("Workflow execution is not enabled in this configuration");
  const store = new Store(config.state.path);
  try {
    return await operation({ store, queue: new WorkflowQueue(store), config });
  } finally {
    store.close();
  }
}

function authorizedActor(config: AgentConfig, actorDigest?: string): string {
  if (actorDigest === undefined) {
    if (config.automation.allowedAuthorIds.length !== 1)
      throw new Error("--actor-digest is required when multiple workflow authors are allowlisted");
    return workflowPrincipalDigest(config.automation.allowedAuthorIds[0]!);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(actorDigest))
    throw new Error("Operator actor digest must be a domain-separated SHA-256 digest");
  const allowedDigests = config.automation.allowedAuthorIds.map(workflowPrincipalDigest);
  if (!allowedDigests.includes(actorDigest))
    throw new Error("Operator actor digest does not match automation.allowedAuthorIds");
  return actorDigest;
}

function requireConfirmed(confirmed: boolean): void {
  if (!confirmed) throw new Error("Mutation requires explicit --yes confirmation");
}

function requireReasonCode(value?: string): string {
  if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw new Error("Mutation requires --reason with a lowercase stable reason code");
  return value;
}

function requireWorkflow(store: Store, workflowId: string) {
  const workflow = store.workflowDefinitionById(workflowId);
  if (!workflow) throw new Error("Unknown workflow");
  return workflow;
}

function activeVersion(store: Store, workflowId: string) {
  const workflow = store.workflowDefinitionById(workflowId);
  return workflow?.activeVersionHash
    ? store.workflowVersion(workflowId, workflow.activeVersionHash)
    : undefined;
}

function requireActiveVersion(store: Store, workflowId: string) {
  const workflow = requireWorkflow(store, workflowId);
  if (workflow.state !== "valid" || !workflow.activeVersionHash)
    throw new Error("Workflow has no valid active version");
  const version = store.workflowVersion(workflowId, workflow.activeVersionHash);
  if (!version) throw new Error("Active workflow version is missing");
  return version;
}

function requireManualTrigger(version: WorkflowVersionRecord): void {
  let stored: unknown;
  try {
    stored = JSON.parse(version.storedDefinitionJson);
  } catch (cause) {
    throw new Error("Active workflow version is not valid JSON", { cause });
  }
  const spec =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as { spec?: { enabled?: unknown; triggers?: unknown } }).spec
      : undefined;
  if (spec?.enabled !== true) throw new Error("Workflow is not enabled by its definition");
  if (
    !Array.isArray(spec.triggers) ||
    !spec.triggers.some(
      (trigger) =>
        trigger !== null &&
        typeof trigger === "object" &&
        !Array.isArray(trigger) &&
        (trigger as { kind?: unknown }).kind === "manual",
    )
  )
    throw new Error("Workflow has no manual trigger");
}

function safeRun(run: ReturnType<WorkflowQueue["run"]> extends infer T ? NonNullable<T> : never) {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    versionHash: run.versionHash,
    approvalHash: run.approvalHash,
    state: run.state,
    cancelRequestedAt: run.cancelRequestedAt,
    cancelReasonDigest:
      run.cancelReason === undefined
        ? undefined
        : sensitiveDigest("cancel-reason", run.cancelReason),
    errorDigest: run.error === undefined ? undefined : sensitiveDigest("run-error", run.error),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function sensitiveDigest(domain: string, value: JsonValue | string): string {
  const material = typeof value === "string" ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(`knot:${domain}:v1\0${material}`).digest("hex")}`;
}

function emit<T>(
  input: { json?: boolean; output?: Output },
  records: T[],
  line: (record: T) => string,
): void {
  const output = input.output ?? console.log;
  if (input.json) output(JSON.stringify(records));
  else if (!records.length) output("No records.");
  else for (const record of records) output(line(record));
}
