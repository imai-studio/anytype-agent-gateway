import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import { normalizedEventSchema, type NormalizedEventRecord } from "./event.js";
import type {
  WorkflowAttemptRecord,
  WorkflowDeliveryRecord,
  WorkflowRunRecord,
  WorkflowRunnerCursor,
  WorkflowStepRecord,
  WorkflowVersionRecord,
  WorkflowOperatorAuditRecord,
} from "./store-types.js";
import { canonicalJson, type JsonValue, type WorkflowDefinition } from "./workflow.js";

const MAX_STORED_STEP_RESULT_BYTES = 64 * 1024;
const MAX_STORED_STEP_ERROR_CHARACTERS = 4_000;

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Workflow list limit must be an integer between 1 and 500");
}

type WorkflowDeliveryInput = Omit<
  WorkflowDeliveryRecord,
  | "state"
  | "createdAt"
  | "nextDispatchAt"
  | "dispatchAttemptCount"
  | "approvalPending"
  | "dispatchedAt"
>;

export interface WorkflowRetryPolicy {
  attempts: number;
  initialDelaySeconds: number;
  maximumDelaySeconds: number;
  multiplier: number;
}

export interface WorkflowClaim {
  run: WorkflowRunRecord;
  step: WorkflowStepRecord;
  attempt: WorkflowAttemptRecord;
}

export interface WorkflowRunnerCounts {
  deliveries: number;
  runs: number;
  readySteps: number;
  activeLeases: number;
  deadLetters: number;
}

export class WorkflowQueue {
  constructor(private readonly store: Store) {}

  cursor(): WorkflowRunnerCursor {
    const row = this.store.db
      .prepare(
        `SELECT matcher_initialized,matcher_recorded_at,matcher_event_id,last_claimed_workflow_id
         FROM workflow_runner_state WHERE singleton=1`,
      )
      .get() as RunnerStateRow;
    return {
      initialized: row.matcher_initialized === 1,
      recordedAt: row.matcher_recorded_at,
      eventId: row.matcher_event_id,
      ...(row.last_claimed_workflow_id
        ? { lastClaimedWorkflowId: row.last_claimed_workflow_id }
        : {}),
    };
  }

  initializeMatcher(now = Date.now()): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.cursor();
      if (state.initialized) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const tail = this.store.db
        .prepare(
          `SELECT recorded_at,event_id FROM normalized_events
           ORDER BY recorded_at DESC,event_id DESC LIMIT 1`,
        )
        .get() as { recorded_at: number; event_id: string } | undefined;
      this.store.db
        .prepare(
          `UPDATE workflow_runner_state SET matcher_initialized=1,matcher_recorded_at=?,
           matcher_event_id=?,updated_at=? WHERE singleton=1`,
        )
        .run(tail?.recorded_at ?? 0, tail?.event_id ?? "", now);
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(cursor: WorkflowRunnerCursor, limit: number): NormalizedEventRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM normalized_events
         WHERE recorded_at>? OR (recorded_at=? AND event_id>?)
         ORDER BY recorded_at,event_id LIMIT ?`,
      )
      .all(cursor.recordedAt, cursor.recordedAt, cursor.eventId, limit) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  recentEvents(limit = 100): NormalizedEventRecord[] {
    assertListLimit(limit);
    const rows = this.store.db
      .prepare("SELECT * FROM normalized_events ORDER BY recorded_at DESC,event_id DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  runs(limit = 100, state?: WorkflowRunRecord["state"]): WorkflowRunRecord[] {
    assertListLimit(limit);
    const rows = state
      ? (this.store.db
          .prepare(
            "SELECT * FROM workflow_runs WHERE state=? ORDER BY created_at DESC,run_id DESC LIMIT ?",
          )
          .all(state, limit) as unknown as RunRow[])
      : (this.store.db
          .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC,run_id DESC LIMIT ?")
          .all(limit) as unknown as RunRow[]);
    return rows.map(mapRun);
  }

  deadLetterDeliveries(limit = 100): WorkflowDeliveryRecord[] {
    assertListLimit(limit);
    const rows = this.store.db
      .prepare(
        "SELECT * FROM workflow_deliveries WHERE state='dead_letter' ORDER BY created_at DESC,delivery_id DESC LIMIT ?",
      )
      .all(limit) as unknown as DeliveryRow[];
    return rows.map(mapDelivery);
  }

  activeWorkflowVersions(): WorkflowVersionRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT d.workflow_id,d.active_version_hash
         FROM workflow_definitions d
         LEFT JOIN workflow_operator_overrides o ON o.workflow_id=d.workflow_id
         WHERE d.state='valid' AND d.active_version_hash IS NOT NULL
           AND COALESCE(o.enabled,1)=1
         ORDER BY d.workflow_id`,
      )
      .all() as Array<{ workflow_id: string; active_version_hash: string }>;
    return rows.flatMap((row) => {
      const version = this.store.workflowVersion(row.workflow_id, row.active_version_hash);
      return version ? [version] : [];
    });
  }

  createDelivery(input: WorkflowDeliveryInput, now = Date.now()): WorkflowDeliveryRecord {
    return this.insertDelivery(input, now);
  }

  createDeliveriesAndAdvanceCursor(
    event: NormalizedEventRecord,
    inputs: readonly WorkflowDeliveryInput[],
    now = Date.now(),
  ): WorkflowDeliveryRecord[] {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const deliveries = inputs.map((input) => this.insertDelivery(input, now));
      this.store.db
        .prepare(
          `UPDATE workflow_runner_state
           SET matcher_recorded_at=?,matcher_event_id=?,updated_at=? WHERE singleton=1`,
        )
        .run(event.recordedAt, event.eventId, now);
      this.store.db.exec("COMMIT");
      return deliveries;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertDelivery(input: WorkflowDeliveryInput, now: number): WorkflowDeliveryRecord {
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_deliveries(
          delivery_id,workflow_id,version_hash,event_id,event_dedupe_key,approval_hash,
          authority_hash,actor_principal_digest,actor_provenance,state,created_at,next_dispatch_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        input.deliveryId,
        input.workflowId,
        input.versionHash,
        input.eventId,
        input.eventDedupeKey,
        input.approvalHash,
        input.authorityHash,
        input.actorPrincipalDigest,
        input.actorProvenance,
        now,
        now,
      );
    const delivery = this.deliveryForEvent(
      input.workflowId,
      input.versionHash,
      input.eventDedupeKey,
    );
    if (!delivery) throw new Error("Workflow delivery was not persisted");
    if (
      delivery.eventId !== input.eventId ||
      delivery.approvalHash !== input.approvalHash ||
      delivery.actorPrincipalDigest !== input.actorPrincipalDigest ||
      delivery.actorProvenance !== input.actorProvenance
    )
      throw new Error("Workflow delivery key collision or divergent immutable delivery");
    return delivery;
  }

  pendingDeliveries(limit: number, now = Date.now()): WorkflowDeliveryRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM workflow_deliveries WHERE state='pending' AND next_dispatch_at<=?
           ORDER BY next_dispatch_at,created_at,delivery_id LIMIT ?`,
        )
        .all(now, limit) as unknown as DeliveryRow[]
    ).map(mapDelivery);
  }

  deferDelivery(
    deliveryId: string,
    availableAt: number,
    maximumAttempts: number,
  ): "deferred" | "dead_letter" | undefined {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
      throw new Error("maximumAttempts must be a positive safe integer");
    const changed = this.store.db
      .prepare(
        `UPDATE workflow_deliveries
         SET dispatch_attempt_count=dispatch_attempt_count+1,
             approval_pending=0,
             next_dispatch_at=?,
             state=CASE
               WHEN dispatch_attempt_count+1>=? THEN 'dead_letter'
               ELSE 'pending'
             END
         WHERE delivery_id=? AND state='pending'`,
      )
      .run(availableAt, maximumAttempts, deliveryId);
    if (Number(changed.changes) !== 1) return undefined;
    return (
      this.store.db
        .prepare("SELECT state FROM workflow_deliveries WHERE delivery_id=?")
        .get(deliveryId) as { state: "pending" | "dead_letter" }
    ).state === "dead_letter"
      ? "dead_letter"
      : "deferred";
  }

  deferDeliveryForApproval(deliveryId: string, availableAt: number): boolean {
    return this.deferDeliveryWithoutBudget(deliveryId, availableAt, true);
  }

  deferDeliveryTransient(deliveryId: string, availableAt: number): boolean {
    return this.deferDeliveryWithoutBudget(deliveryId, availableAt, false);
  }

  private deferDeliveryWithoutBudget(
    deliveryId: string,
    availableAt: number,
    approvalPending: boolean,
  ): boolean {
    if (!Number.isSafeInteger(availableAt) || availableAt < 0)
      throw new Error("availableAt must be a non-negative safe integer");
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE workflow_deliveries
             SET next_dispatch_at=?,approval_pending=?
             WHERE delivery_id=? AND state='pending'`,
          )
          .run(availableAt, approvalPending ? 1 : 0, deliveryId).changes,
      ) === 1
    );
  }

  isActiveVersion(workflowId: string, versionHash: string): boolean {
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM workflow_definitions d
           LEFT JOIN workflow_operator_overrides o ON o.workflow_id=d.workflow_id
           WHERE d.workflow_id=? AND d.state='valid' AND d.active_version_hash=?
             AND COALESCE(o.enabled,1)=1`,
        )
        .get(workflowId, versionHash),
    );
  }

  cancelDelivery(deliveryId: string): boolean {
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE workflow_deliveries SET state='cancelled'
             WHERE delivery_id=? AND state='pending'`,
          )
          .run(deliveryId).changes,
      ) === 1
    );
  }

  deadLetterDelivery(deliveryId: string): boolean {
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE workflow_deliveries SET state='dead_letter'
             WHERE delivery_id=? AND state='pending'`,
          )
          .run(deliveryId).changes,
      ) === 1
    );
  }

  dispatchDelivery(
    deliveryId: string,
    definition: WorkflowDefinition,
    limits: {
      maximumConcurrentRuns: number;
      maximumRunsPerHour: number;
      maximumStepsPerRun?: number;
      maximumEffectsPerRun?: number;
    },
    authorityHash: string,
    now = Date.now(),
  ): WorkflowRunRecord | undefined {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const deliveryRow = this.store.db
        .prepare("SELECT * FROM workflow_deliveries WHERE delivery_id=?")
        .get(deliveryId) as DeliveryRow | undefined;
      if (!deliveryRow) throw new Error("Unknown workflow delivery");
      const delivery = mapDelivery(deliveryRow);
      const existing = this.runForDelivery(deliveryId);
      if (existing) {
        this.store.db.exec("COMMIT");
        return existing;
      }
      if (delivery.state !== "pending") {
        this.store.db.exec("COMMIT");
        return undefined;
      }
      if (
        limits.maximumStepsPerRun !== undefined &&
        definition.spec.steps.length > limits.maximumStepsPerRun
      ) {
        this.store.db
          .prepare("UPDATE workflow_deliveries SET state='dead_letter' WHERE delivery_id=?")
          .run(deliveryId);
        this.store.db.exec("COMMIT");
        return undefined;
      }
      if (
        limits.maximumEffectsPerRun !== undefined &&
        definition.spec.steps.filter((step) => isExternalEffectStep(step.kind)).length >
          limits.maximumEffectsPerRun
      ) {
        this.store.db
          .prepare("UPDATE workflow_deliveries SET state='dead_letter' WHERE delivery_id=?")
          .run(deliveryId);
        this.store.db.exec("COMMIT");
        return undefined;
      }
      const active = this.store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM workflow_runs
           WHERE workflow_id=? AND state IN ('pending','running','waiting')
             AND NOT (
               state='waiting'
               AND EXISTS(
                 SELECT 1 FROM workflow_steps s
                 WHERE s.run_id=workflow_runs.run_id AND s.state='source_refetch_required'
               )
               AND NOT EXISTS(
                 SELECT 1 FROM workflow_steps s
                 WHERE s.run_id=workflow_runs.run_id AND s.state IN ('ready','leased','running')
               )
             )`,
        )
        .get(delivery.workflowId) as { count: number };
      const recent = this.store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM workflow_runs
           WHERE workflow_id=? AND created_at>=?`,
        )
        .get(delivery.workflowId, Math.max(0, now - 3_600_000)) as { count: number };
      if (
        Number(active.count) >= limits.maximumConcurrentRuns ||
        Number(recent.count) >= limits.maximumRunsPerHour
      ) {
        this.store.db.exec("COMMIT");
        return undefined;
      }
      const runId = randomUUID();
      this.store.db
        .prepare(
          `INSERT INTO workflow_runs(
            run_id,delivery_id,workflow_id,version_hash,approval_hash,authority_hash,
            actor_principal_digest,actor_provenance,state,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`,
        )
        .run(
          runId,
          delivery.deliveryId,
          delivery.workflowId,
          delivery.versionHash,
          delivery.approvalHash,
          authorityHash,
          delivery.actorPrincipalDigest,
          delivery.actorProvenance,
          now,
          now,
        );
      const insert = this.store.db.prepare(
        `INSERT INTO workflow_steps(
          run_id,workflow_id,step_id,position,kind,state,dependencies_json,timeout_seconds,
          run_deadline_at,available_at,authority_hash,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const [position, step] of definition.spec.steps.entries())
        insert.run(
          runId,
          delivery.workflowId,
          step.id,
          position,
          step.kind,
          step.dependsOn.length ? "blocked" : "ready",
          canonicalJson(step.dependsOn),
          step.timeoutSeconds ?? definition.spec.budget.maximumRunSeconds,
          now + definition.spec.budget.maximumRunSeconds * 1_000,
          now,
          authorityHash,
          now,
        );
      this.store.db
        .prepare(
          "UPDATE workflow_deliveries SET state='dispatched',dispatched_at=? WHERE delivery_id=?",
        )
        .run(now, deliveryId);
      this.store.db.exec("COMMIT");
      return this.run(runId);
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimStep(
    workerId: string,
    allowedAuthorityHashes: ReadonlySet<string> | undefined,
    leaseMilliseconds: number,
    now = Date.now(),
  ): WorkflowClaim | undefined {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.promoteRetriesInTransaction(now);
      const last = this.cursor().lastClaimedWorkflowId;
      const rows = this.store.db
        .prepare(
          `SELECT s.* FROM workflow_steps s
           JOIN workflow_runs r ON r.run_id=s.run_id
           WHERE s.state='ready' AND s.available_at<=? AND s.run_deadline_at>?
             AND r.cancel_requested_at IS NULL
             AND r.state IN ('pending','running','waiting')
           ORDER BY CASE WHEN s.workflow_id=? THEN 1 ELSE 0 END,
             s.available_at,s.updated_at,s.run_id,s.position LIMIT 100`,
        )
        .all(now, now, last ?? "") as unknown as StepRow[];
      const selected = allowedAuthorityHashes
        ? rows.find((row) => allowedAuthorityHashes.has(row.authority_hash))
        : rows[0];
      if (!selected) {
        this.store.db.exec("COMMIT");
        return undefined;
      }
      const fencingToken = randomUUID();
      const attemptId = randomUUID();
      const attemptNumber = selected.attempt_count + 1;
      const leaseHardExpiresAt = Math.min(
        selected.run_deadline_at,
        now + selected.timeout_seconds * 1_000,
      );
      const leaseExpiresAt = Math.min(now + leaseMilliseconds, leaseHardExpiresAt);
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='leased',attempt_count=?,lease_owner=?,fencing_token=?,
           lease_started_at=?,lease_expires_at=?,lease_hard_expires_at=?,updated_at=?
           WHERE run_id=? AND step_id=? AND state='ready'`,
        )
        .run(
          attemptNumber,
          workerId,
          fencingToken,
          now,
          leaseExpiresAt,
          leaseHardExpiresAt,
          now,
          selected.run_id,
          selected.step_id,
        );
      if (Number(changed.changes) !== 1) throw new Error("Workflow step claim was lost");
      this.store.db
        .prepare(
          `INSERT INTO workflow_attempts(
            attempt_id,run_id,step_id,attempt_number,worker_id,fencing_token,state,started_at
          ) VALUES(?,?,?,?,?,?,'running',?)`,
        )
        .run(
          attemptId,
          selected.run_id,
          selected.step_id,
          attemptNumber,
          workerId,
          fencingToken,
          now,
        );
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='running',updated_at=?
           WHERE run_id=? AND state IN ('pending','waiting')`,
        )
        .run(now, selected.run_id);
      this.store.db
        .prepare(
          `UPDATE workflow_runner_state SET last_claimed_workflow_id=?,updated_at=? WHERE singleton=1`,
        )
        .run(selected.workflow_id, now);
      this.store.db.exec("COMMIT");
      const run = this.run(selected.run_id);
      const step = this.step(selected.run_id, selected.step_id);
      const attempt = this.attempt(attemptId);
      if (!run || !step || !attempt) throw new Error("Workflow claim was not persisted");
      return { run, step, attempt };
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  startStep(runId: string, stepId: string, fencingToken: string, now = Date.now()): boolean {
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='running',updated_at=?
             WHERE run_id=? AND step_id=? AND state='leased' AND fencing_token=?
               AND lease_expires_at>?`,
          )
          .run(now, runId, stepId, fencingToken, now).changes,
      ) === 1
    );
  }

  heartbeat(
    runId: string,
    stepId: string,
    fencingToken: string,
    leaseMilliseconds: number,
    now = Date.now(),
  ): boolean {
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET lease_expires_at=MIN(?,lease_hard_expires_at),updated_at=?
             WHERE run_id=? AND step_id=? AND state IN ('leased','running')
               AND fencing_token=? AND lease_expires_at>?`,
          )
          .run(now + leaseMilliseconds, now, runId, stepId, fencingToken, now).changes,
      ) === 1
    );
  }

  claimIsCurrent(runId: string, stepId: string, fencingToken: string, now = Date.now()): boolean {
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM workflow_steps
           WHERE run_id=? AND step_id=? AND state IN ('leased','running')
             AND fencing_token=? AND lease_expires_at>?`,
        )
        .get(runId, stepId, fencingToken, now),
    );
  }

  claimMayExecute(runId: string, stepId: string, fencingToken: string, now = Date.now()): boolean {
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM workflow_steps s
           JOIN workflow_runs r ON r.run_id=s.run_id
           JOIN workflow_definitions d ON d.workflow_id=r.workflow_id
           WHERE s.run_id=? AND s.step_id=? AND s.state IN ('leased','running')
             AND s.fencing_token=? AND s.lease_expires_at>?
             AND r.state IN ('pending','running','waiting')
             AND r.cancel_requested_at IS NULL
             AND d.state='valid' AND d.active_version_hash=r.version_hash
             AND NOT EXISTS(
               SELECT 1 FROM workflow_operator_overrides o
               WHERE o.workflow_id=r.workflow_id AND o.enabled=0
             )`,
        )
        .get(runId, stepId, fencingToken, now),
    );
  }

  completeStep(
    runId: string,
    stepId: string,
    fencingToken: string,
    result: JsonValue,
    now = Date.now(),
  ): boolean {
    const storedResult = boundedStepResult(result);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
        .get(runId, stepId) as StepRow | undefined;
      if (
        !step ||
        !["leased", "running"].includes(step.state) ||
        step.fencing_token !== fencingToken ||
        (step.lease_expires_at ?? 0) <= now
      ) {
        this.store.db.exec("COMMIT");
        return false;
      }
      this.store.db
        .prepare(
          `UPDATE workflow_attempts SET state='succeeded',completed_at=?
           WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
        )
        .run(now, runId, stepId, fencingToken);
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='succeeded',result_json=?,error=NULL,lease_owner=NULL,
           fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
           WHERE run_id=? AND step_id=?`,
        )
        .run(canonicalJson(storedResult), now, runId, stepId);
      const run = this.store.db
        .prepare("SELECT cancel_requested_at FROM workflow_runs WHERE run_id=?")
        .get(runId) as { cancel_requested_at: number | null };
      if (run.cancel_requested_at !== null) this.finishCancellationInTransaction(runId, now);
      else {
        this.unblockDependentsInTransaction(runId, now);
        this.refreshRunStateInTransaction(runId, now);
      }
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  failStep(
    runId: string,
    stepId: string,
    fencingToken: string,
    error: string,
    retry: WorkflowRetryPolicy,
    retryable: boolean,
    now = Date.now(),
  ): boolean {
    error = boundedStepError(error);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
        .get(runId, stepId) as StepRow | undefined;
      if (
        !step ||
        !["leased", "running"].includes(step.state) ||
        step.fencing_token !== fencingToken ||
        (step.lease_expires_at ?? 0) <= now
      ) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const run = this.store.db
        .prepare("SELECT cancel_requested_at FROM workflow_runs WHERE run_id=?")
        .get(runId) as { cancel_requested_at: number | null };
      if (run.cancel_requested_at !== null) {
        this.store.db
          .prepare(
            `UPDATE workflow_attempts SET state='failed',completed_at=?,error=?
             WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
          )
          .run(now, "Cancelled while running", runId, stepId, fencingToken);
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='cancelled',error='Cancelled while running',
             lease_owner=NULL,fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(now, runId, stepId);
        this.finishCancellationInTransaction(runId, now);
      } else if (retryable && step.attempt_count < retry.attempts) {
        const delaySeconds = Math.min(
          retry.maximumDelaySeconds,
          retry.initialDelaySeconds * Math.pow(retry.multiplier, step.attempt_count - 1),
        );
        const availableAt = now + Math.round(delaySeconds * 1_000);
        this.store.db
          .prepare(
            `UPDATE workflow_attempts SET state='retry',completed_at=?,error=?
             WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
          )
          .run(now, error, runId, stepId, fencingToken);
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='waiting_retry',available_at=?,error=?,lease_owner=NULL,
             fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(availableAt, error, now, runId, stepId);
        this.store.db
          .prepare("UPDATE workflow_runs SET state='waiting',updated_at=? WHERE run_id=?")
          .run(now, runId);
      } else {
        this.store.db
          .prepare(
            `UPDATE workflow_attempts SET state='dead_letter',completed_at=?,error=?
             WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
          )
          .run(now, error, runId, stepId, fencingToken);
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='dead_letter',error=?,lease_owner=NULL,
             fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(error, now, runId, stepId);
        this.store.db
          .prepare(
            `UPDATE workflow_runs SET state='dead_letter',error=?,updated_at=?,completed_at=?
             WHERE run_id=?`,
          )
          .run(error, now, now, runId);
        this.deadLetterRemainingStepsInTransaction(runId, error, now);
      }
      this.store.db.exec("COMMIT");
      return true;
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  requireSourceRefetch(
    runId: string,
    stepId: string,
    fencingToken: string,
    reason: string,
    now = Date.now(),
  ): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
        .get(runId, stepId) as StepRow | undefined;
      if (
        !step ||
        step.state !== "running" ||
        step.fencing_token !== fencingToken ||
        (step.lease_expires_at ?? 0) <= now
      ) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_attempts SET state='source_refetch_required',completed_at=?,error=?
           WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
        )
        .run(now, reason, runId, stepId, fencingToken);
      if (Number(changed.changes) !== 1) {
        this.store.db.exec("COMMIT");
        return false;
      }
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='source_refetch_required',error=?,lease_owner=NULL,
           fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,
           lease_hard_expires_at=NULL,available_at=?,updated_at=?
           WHERE run_id=? AND step_id=? AND state='running'`,
        )
        .run(reason, now, now, runId, stepId);
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='waiting',error=?,updated_at=?
           WHERE run_id=? AND state IN ('pending','running','waiting')`,
        )
        .run(reason, now, runId);
      this.store.db.exec("COMMIT");
      return true;
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  resumeSourceRefetchStep(runId: string, stepId: string, now = Date.now()): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
        .get(runId, stepId) as StepRow | undefined;
      if (!step || step.state !== "source_refetch_required") {
        this.store.db.exec("COMMIT");
        return false;
      }
      const dependencies = parseJson<string[]>(step.dependencies_json);
      const states = new Map(
        (
          this.store.db
            .prepare("SELECT step_id,state FROM workflow_steps WHERE run_id=?")
            .all(runId) as Array<{ step_id: string; state: string }>
        ).map((row) => [row.step_id, row.state]),
      );
      const nextState = dependencies.every((dependency) => states.get(dependency) === "succeeded")
        ? "ready"
        : "blocked";
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state=?,available_at=?,error=NULL,updated_at=?
           WHERE run_id=? AND step_id=? AND state='source_refetch_required'`,
        )
        .run(nextState, now, now, runId, stepId);
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='running',error=NULL,updated_at=?
           WHERE run_id=? AND state='waiting'`,
        )
        .run(now, runId);
      this.store.db.exec("COMMIT");
      return true;
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  deferSourceRefetch(
    runId: string,
    stepId: string,
    reason: string,
    availableAt: number,
    maximumAttempts: number,
    now = Date.now(),
  ): "deferred" | "dead_letter" | undefined {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
      throw new Error("maximumAttempts must be a positive safe integer");
    reason = boundedStepError(reason);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare(
          `SELECT source_refetch_attempt_count FROM workflow_steps
           WHERE run_id=? AND step_id=? AND state='source_refetch_required'`,
        )
        .get(runId, stepId) as { source_refetch_attempt_count: number } | undefined;
      if (!step) {
        this.store.db.exec("COMMIT");
        return undefined;
      }
      const attempt = step.source_refetch_attempt_count + 1;
      if (attempt >= maximumAttempts) {
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='dead_letter',source_refetch_attempt_count=?,
             error=?,available_at=?,updated_at=?
             WHERE run_id=? AND step_id=? AND state='source_refetch_required'`,
          )
          .run(attempt, reason, availableAt, now, runId, stepId);
        this.store.db
          .prepare(
            `UPDATE workflow_runs SET state='dead_letter',error=?,updated_at=?,completed_at=?
             WHERE run_id=? AND state IN ('pending','running','waiting')`,
          )
          .run(reason, now, now, runId);
        this.deadLetterRemainingStepsInTransaction(runId, reason, now);
        this.store.db.exec("COMMIT");
        return "dead_letter";
      }
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET source_refetch_attempt_count=?,error=?,available_at=?,updated_at=?
           WHERE run_id=? AND step_id=? AND state='source_refetch_required'`,
        )
        .run(attempt, reason, availableAt, now, runId, stepId);
      this.store.db.exec("COMMIT");
      return "deferred";
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  sourceRefetchSteps(now = Date.now(), limit = 100): WorkflowStepRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM workflow_steps
           WHERE state='source_refetch_required' AND available_at<=?
           ORDER BY available_at,updated_at,run_id,position LIMIT ?`,
        )
        .all(now, limit) as unknown as StepRow[]
    ).map(mapStep);
  }

  recoverExpiredLeases(
    retryFor: (runId: string, stepId: string) => WorkflowRetryPolicy,
    now = Date.now(),
    limit = 100,
  ): number {
    const expired = this.store.db
      .prepare(
        `SELECT * FROM workflow_steps WHERE state IN ('leased','running') AND lease_expires_at<=?
         ORDER BY lease_expires_at,run_id,position LIMIT ?`,
      )
      .all(now, limit) as unknown as StepRow[];
    let recovered = 0;
    for (const row of expired) {
      let policy: WorkflowRetryPolicy;
      try {
        policy = retryFor(row.run_id, row.step_id);
      } catch {
        if (
          this.deadLetterRun(
            row.run_id,
            "Workflow retry policy is unavailable during lease recovery",
            now,
          )
        )
          recovered += 1;
        continue;
      }
      if (
        this.failExpiredLease(
          row.run_id,
          row.step_id,
          row.fencing_token!,
          "Worker lease expired before completion",
          policy,
          now,
        )
      )
        recovered += 1;
    }
    return recovered;
  }

  recoverTimedOutClaim(
    runId: string,
    stepId: string,
    fencingToken: string,
    retry: WorkflowRetryPolicy,
    now = Date.now(),
  ): boolean {
    const step = this.store.db
      .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
      .get(runId, stepId) as StepRow | undefined;
    if (
      !step ||
      !["leased", "running"].includes(step.state) ||
      step.fencing_token !== fencingToken ||
      (step.lease_hard_expires_at ?? Number.MAX_SAFE_INTEGER) > now ||
      step.run_deadline_at <= now
    )
      return false;
    return this.failExpiredLease(
      runId,
      stepId,
      fencingToken,
      "Workflow step timed out before completion",
      retry,
      now,
    );
  }

  expireRunDeadlines(now = Date.now(), limit = 100): number {
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT r.run_id FROM workflow_runs r
         JOIN workflow_steps s ON s.run_id=r.run_id
         WHERE r.state IN ('pending','running','waiting') AND s.run_deadline_at<=?
         ORDER BY s.run_deadline_at,r.run_id LIMIT ?`,
      )
      .all(now, limit) as Array<{ run_id: string }>;
    let expired = 0;
    for (const row of rows)
      if (this.deadLetterRun(row.run_id, "Workflow maximum run time expired", now)) expired += 1;
    return expired;
  }

  cancelRun(
    runId: string,
    actorPrincipalDigest: string,
    reason: string,
    now = Date.now(),
    audit?: Omit<WorkflowOperatorAuditRecord, "sequence" | "createdAt">,
  ): boolean {
    if (
      audit &&
      (audit.action !== "run.cancel" ||
        audit.runId !== runId ||
        audit.actorPrincipalDigest !== actorPrincipalDigest)
    )
      throw new Error("Workflow cancellation audit does not match the cancellation mutation");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (audit) {
        const run = this.run(runId);
        if (!run || audit.workflowId !== run.workflowId)
          throw new Error("Workflow cancellation audit does not match the run workflow");
      }
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_runs SET cancel_requested_at=COALESCE(cancel_requested_at,?),
           cancel_actor_principal_digest=COALESCE(cancel_actor_principal_digest,?),
           cancel_reason=COALESCE(cancel_reason,?),updated_at=?
           WHERE run_id=? AND state IN ('pending','running','waiting')`,
        )
        .run(now, actorPrincipalDigest, reason, now, runId);
      if (Number(changed.changes) === 0) {
        this.store.db.exec("COMMIT");
        return false;
      }
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='cancelled',error='Run cancelled',updated_at=?
           WHERE run_id=? AND state IN (
             'blocked','ready','waiting_retry','waiting_timer','waiting_approval',
             'source_refetch_required'
           )`,
        )
        .run(now, runId);
      this.finishCancellationInTransaction(runId, now);
      if (audit) this.store.appendWorkflowOperatorAudit({ ...audit, createdAt: now });
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  retryRun(
    runId: string,
    authorityHash: string,
    actorPrincipalDigest: string,
    reasonCode: string,
    auditId: string,
    now = Date.now(),
  ): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.run(runId);
      if (
        !run ||
        !["failed", "dead_letter"].includes(run.state) ||
        run.cancelRequestedAt !== undefined ||
        !this.isActiveVersion(run.workflowId, run.versionHash) ||
        !this.store.currentWorkflowApproval(run.workflowId, run.approvalHash, authorityHash, now)
      ) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const unsafeReceipt = this.store.db
        .prepare(
          `SELECT 1 FROM workflow_effect_receipts
           WHERE run_id=? AND state IN ('running','outcome_unknown') LIMIT 1`,
        )
        .get(runId);
      const activeStep = this.store.db
        .prepare(
          "SELECT 1 FROM workflow_steps WHERE run_id=? AND state IN ('leased','running') LIMIT 1",
        )
        .get(runId);
      if (unsafeReceipt || activeStep) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const steps = this.store.db
        .prepare("SELECT step_id,state,dependencies_json FROM workflow_steps WHERE run_id=?")
        .all(runId) as Array<{
        step_id: string;
        state: WorkflowStepRecord["state"];
        dependencies_json: string;
      }>;
      const runDeadlineAt = now + this.maximumRunMilliseconds(run.workflowId, run.versionHash);
      const states = new Map(steps.map((step) => [step.step_id, step.state]));
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET run_deadline_at=?,authority_hash=?,updated_at=?
           WHERE run_id=?`,
        )
        .run(runDeadlineAt, authorityHash, now, runId);
      const update = this.store.db.prepare(
        `UPDATE workflow_steps SET state=?,available_at=?,lease_owner=NULL,
         fencing_token=NULL,lease_started_at=NULL,
         lease_expires_at=NULL,lease_hard_expires_at=NULL,result_json=NULL,error=NULL,
         authority_hash=?,updated_at=?
         WHERE run_id=? AND step_id=? AND state!='succeeded'`,
      );
      for (const step of steps) {
        if (step.state === "succeeded") continue;
        const dependencies = parseJson<string[]>(step.dependencies_json);
        const state = dependencies.every((dependency) => states.get(dependency) === "succeeded")
          ? "ready"
          : "blocked";
        update.run(state, now, authorityHash, now, runId, step.step_id);
      }
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='pending',authority_hash=?,error=NULL,
           completed_at=NULL,updated_at=? WHERE run_id=?`,
        )
        .run(authorityHash, now, runId);
      this.store.appendWorkflowOperatorAudit({
        auditId,
        action: "run.retry",
        actorPrincipalDigest,
        workflowId: run.workflowId,
        runId,
        reasonCode,
        details: { approvalHash: run.approvalHash, authorityHash },
        createdAt: now,
      });
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private maximumRunMilliseconds(workflowId: string, versionHash: string): number {
    const version = this.store.workflowVersion(workflowId, versionHash);
    if (!version) throw new Error("Workflow retry version is missing");
    let stored: unknown;
    try {
      stored = JSON.parse(version.storedDefinitionJson);
    } catch (cause) {
      throw new Error("Workflow retry version is not valid JSON", { cause });
    }
    const maximumRunSeconds =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as { spec?: { budget?: { maximumRunSeconds?: unknown } } }).spec?.budget
            ?.maximumRunSeconds
        : undefined;
    if (
      !Number.isSafeInteger(maximumRunSeconds) ||
      (maximumRunSeconds as number) < 1 ||
      (maximumRunSeconds as number) > 604_800
    )
      throw new Error("Workflow retry version has an invalid maximum run budget");
    return (maximumRunSeconds as number) * 1_000;
  }

  pauseRunForApproval(runId: string, reason: string, now = Date.now()): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='waiting',error=?,updated_at=?
           WHERE run_id=? AND state IN ('pending','running','waiting')
             AND (state!='waiting' OR error IS NULL OR error!=?)`,
        )
        .run(reason, now, runId, reason);
      this.store.db
        .prepare(
          `UPDATE workflow_attempts SET state='retry',completed_at=?,error=?
           WHERE run_id=? AND state='running'`,
        )
        .run(now, reason, runId);
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='waiting_approval',error=?,lease_owner=NULL,
           fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
           WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled','dead_letter')
             AND (state!='waiting_approval' OR error IS NULL OR error!=?)`,
        )
        .run(reason, now, runId, reason);
      this.store.db.exec("COMMIT");
      return Number(changed.changes) === 1;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  resumeRunWithAuthority(runId: string, authorityHash: string, now = Date.now()): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_runs SET authority_hash=?,state='running',error=NULL,updated_at=?
           WHERE run_id=? AND state='waiting' AND EXISTS(
             SELECT 1 FROM workflow_steps WHERE run_id=? AND state='waiting_approval'
           )`,
        )
        .run(authorityHash, now, runId, runId);
      if (Number(changed.changes) === 0) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const states = new Map(
        (
          this.store.db
            .prepare("SELECT step_id,state FROM workflow_steps WHERE run_id=?")
            .all(runId) as Array<{ step_id: string; state: string }>
        ).map((row) => [row.step_id, row.state]),
      );
      const waiting = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND state='waiting_approval'")
        .all(runId) as unknown as StepRow[];
      for (const step of waiting) {
        const dependencies = parseJson<string[]>(step.dependencies_json);
        const state = dependencies.every((dependency) => states.get(dependency) === "succeeded")
          ? "ready"
          : "blocked";
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET authority_hash=?,state=?,available_at=?,error=NULL,updated_at=?
             WHERE run_id=? AND step_id=? AND state='waiting_approval'`,
          )
          .run(authorityHash, state, now, now, runId, step.step_id);
      }
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  deadLetterRun(runId: string, error: string, now = Date.now()): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='dead_letter',error=?,updated_at=?,completed_at=?
           WHERE run_id=? AND state IN ('pending','running','waiting')`,
        )
        .run(error, now, now, runId);
      this.store.db
        .prepare(
          `UPDATE workflow_steps SET state='dead_letter',error=?,lease_owner=NULL,
           fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
           WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled','dead_letter')`,
        )
        .run(error, now, runId);
      this.store.db
        .prepare(
          `UPDATE workflow_attempts SET state='dead_letter',error=?,completed_at=?
           WHERE run_id=? AND state='running'`,
        )
        .run(error, now, runId);
      this.store.db.exec("COMMIT");
      return Number(changed.changes) === 1;
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  run(runId: string): WorkflowRunRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as
      RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  runForDelivery(deliveryId: string): WorkflowRunRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM workflow_runs WHERE delivery_id=?")
      .get(deliveryId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  activeRuns(): WorkflowRunRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM workflow_runs WHERE state IN ('pending','running','waiting')
           ORDER BY created_at,run_id`,
        )
        .all() as unknown as RunRow[]
    ).map(mapRun);
  }

  activeRunsAfter(afterRunId: string | undefined, limit: number): WorkflowRunRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM workflow_runs WHERE state IN ('pending','running','waiting')
           ORDER BY CASE WHEN run_id>? THEN 0 ELSE 1 END,run_id LIMIT ?`,
        )
        .all(afterRunId ?? "", limit) as unknown as RunRow[]
    ).map(mapRun);
  }

  steps(runId: string): WorkflowStepRecord[] {
    return (
      this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? ORDER BY position")
        .all(runId) as unknown as StepRow[]
    ).map(mapStep);
  }

  attempts(runId: string, stepId: string): WorkflowAttemptRecord[] {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM workflow_attempts WHERE run_id=? AND step_id=? ORDER BY attempt_number",
        )
        .all(runId, stepId) as unknown as AttemptRow[]
    ).map(mapAttempt);
  }

  counts(): WorkflowRunnerCounts {
    const count = (sql: string): number =>
      Number((this.store.db.prepare(sql).get() as { count: number }).count);
    return {
      deliveries: count("SELECT COUNT(*) AS count FROM workflow_deliveries"),
      runs: count("SELECT COUNT(*) AS count FROM workflow_runs"),
      readySteps: count("SELECT COUNT(*) AS count FROM workflow_steps WHERE state='ready'"),
      activeLeases: count(
        "SELECT COUNT(*) AS count FROM workflow_steps WHERE state IN ('leased','running')",
      ),
      deadLetters: count("SELECT COUNT(*) AS count FROM workflow_runs WHERE state='dead_letter'"),
    };
  }

  private deliveryForEvent(
    workflowId: string,
    versionHash: string,
    eventDedupeKey: string,
  ): WorkflowDeliveryRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM workflow_deliveries
         WHERE workflow_id=? AND version_hash=? AND event_dedupe_key=?`,
      )
      .get(workflowId, versionHash, eventDedupeKey) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : undefined;
  }

  private step(runId: string, stepId: string): WorkflowStepRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
      .get(runId, stepId) as StepRow | undefined;
    return row ? mapStep(row) : undefined;
  }

  private attempt(attemptId: string): WorkflowAttemptRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM workflow_attempts WHERE attempt_id=?")
      .get(attemptId) as AttemptRow | undefined;
    return row ? mapAttempt(row) : undefined;
  }

  private promoteRetriesInTransaction(now: number): void {
    this.store.db
      .prepare(
        `UPDATE workflow_steps SET state='ready',updated_at=?
         WHERE state='waiting_retry' AND available_at<=?`,
      )
      .run(now, now);
  }

  private failExpiredLease(
    runId: string,
    stepId: string,
    fencingToken: string,
    error: string,
    retry: WorkflowRetryPolicy,
    now: number,
  ): boolean {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const step = this.store.db
        .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
        .get(runId, stepId) as StepRow | undefined;
      if (
        !step ||
        !["leased", "running"].includes(step.state) ||
        step.fencing_token !== fencingToken ||
        (step.lease_expires_at ?? Number.MAX_SAFE_INTEGER) > now
      ) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const run = this.store.db
        .prepare("SELECT cancel_requested_at FROM workflow_runs WHERE run_id=?")
        .get(runId) as { cancel_requested_at: number | null };
      const retryable = run.cancel_requested_at === null && step.attempt_count < retry.attempts;
      this.store.db
        .prepare(
          `UPDATE workflow_attempts SET state=?,completed_at=?,error=?
           WHERE run_id=? AND step_id=? AND fencing_token=? AND state='running'`,
        )
        .run(retryable ? "retry" : "dead_letter", now, error, runId, stepId, fencingToken);
      if (run.cancel_requested_at !== null) {
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='cancelled',error=?,lease_owner=NULL,
             fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(error, now, runId, stepId);
        this.finishCancellationInTransaction(runId, now);
      } else if (retryable) {
        const delay = Math.min(
          retry.maximumDelaySeconds,
          retry.initialDelaySeconds * Math.pow(retry.multiplier, step.attempt_count - 1),
        );
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='waiting_retry',available_at=?,error=?,lease_owner=NULL,
             fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(now + Math.round(delay * 1_000), error, now, runId, stepId);
        this.store.db
          .prepare("UPDATE workflow_runs SET state='waiting',updated_at=? WHERE run_id=?")
          .run(now, runId);
      } else {
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='dead_letter',error=?,lease_owner=NULL,
             fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,lease_hard_expires_at=NULL,updated_at=?
             WHERE run_id=? AND step_id=?`,
          )
          .run(error, now, runId, stepId);
        this.store.db
          .prepare(
            `UPDATE workflow_runs SET state='dead_letter',error=?,updated_at=?,completed_at=?
             WHERE run_id=?`,
          )
          .run(error, now, now, runId);
        this.deadLetterRemainingStepsInTransaction(runId, error, now);
      }
      this.store.db.exec("COMMIT");
      return true;
    } catch (cause) {
      this.store.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private unblockDependentsInTransaction(runId: string, now: number): void {
    const blocked = this.store.db
      .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND state='blocked'")
      .all(runId) as unknown as StepRow[];
    const states = new Map(
      (
        this.store.db
          .prepare("SELECT step_id,state FROM workflow_steps WHERE run_id=?")
          .all(runId) as Array<{ step_id: string; state: string }>
      ).map((row) => [row.step_id, row.state]),
    );
    for (const row of blocked) {
      const dependencies = parseJson<string[]>(row.dependencies_json);
      if (dependencies.every((dependency) => states.get(dependency) === "succeeded"))
        this.store.db
          .prepare(
            `UPDATE workflow_steps SET state='ready',available_at=?,updated_at=?
             WHERE run_id=? AND step_id=? AND state='blocked'`,
          )
          .run(now, now, runId, row.step_id);
    }
  }

  private deadLetterRemainingStepsInTransaction(runId: string, error: string, now: number): void {
    this.store.db
      .prepare(
        `UPDATE workflow_steps SET state='dead_letter',error=?,lease_owner=NULL,
         fencing_token=NULL,lease_started_at=NULL,lease_expires_at=NULL,
         lease_hard_expires_at=NULL,updated_at=?
         WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled','dead_letter')`,
      )
      .run(error, now, runId);
  }

  private refreshRunStateInTransaction(runId: string, now: number): void {
    const states = (
      this.store.db.prepare("SELECT state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{
        state: string;
      }>
    ).map((row) => row.state);
    if (states.every((state) => state === "succeeded"))
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='succeeded',updated_at=?,completed_at=? WHERE run_id=?`,
        )
        .run(now, now, runId);
    else {
      const waiting = states.some((state) =>
        ["waiting_retry", "waiting_timer", "waiting_approval", "source_refetch_required"].includes(
          state,
        ),
      );
      this.store.db
        .prepare("UPDATE workflow_runs SET state=?,updated_at=? WHERE run_id=?")
        .run(waiting ? "waiting" : "running", now, runId);
    }
  }

  private finishCancellationInTransaction(runId: string, now: number): void {
    const active = this.store.db
      .prepare(
        `SELECT 1 FROM workflow_steps WHERE run_id=? AND state IN ('leased','running') LIMIT 1`,
      )
      .get(runId);
    if (!active)
      this.store.db
        .prepare(
          `UPDATE workflow_runs SET state='cancelled',updated_at=?,completed_at=? WHERE run_id=?`,
        )
        .run(now, now, runId);
  }
}

function isExternalEffectStep(kind: WorkflowDefinition["spec"]["steps"][number]["kind"]): boolean {
  return [
    "agent",
    "anytype.write",
    "anytype.upsert",
    "anytype.materialize",
    "http",
    "notify",
    "publish.web",
  ].includes(kind);
}

type RunnerStateRow = {
  matcher_initialized: number;
  matcher_recorded_at: number;
  matcher_event_id: string;
  last_claimed_workflow_id: string | null;
};

type EventRow = {
  event_id: string;
  dedupe_key: string;
  kind: string;
  source: string;
  source_event_id: string | null;
  space_id: string;
  object_id: string | null;
  observed_at: number;
  payload_json: string;
  diff_json: string | null;
  causation_run_id: string | null;
  causal_depth: number;
  origin_effect_key: string | null;
  recorded_at: number;
  source_modified_at: number | null;
  source_fingerprint: string | null;
  editor_principal_digest: string | null;
  editor_provenance: string | null;
};

type DeliveryRow = {
  delivery_id: string;
  workflow_id: string;
  version_hash: string;
  event_id: string;
  event_dedupe_key: string;
  approval_hash: string;
  authority_hash: string;
  actor_principal_digest: string;
  actor_provenance: "anytype-native" | "authenticated-chat" | "operator-cli";
  state: WorkflowDeliveryRecord["state"];
  created_at: number;
  next_dispatch_at: number;
  dispatch_attempt_count: number;
  approval_pending: number;
  dispatched_at: number | null;
};

type RunRow = {
  run_id: string;
  delivery_id: string;
  workflow_id: string;
  version_hash: string;
  approval_hash: string;
  authority_hash: string;
  actor_principal_digest: string;
  actor_provenance: "anytype-native" | "authenticated-chat" | "operator-cli";
  state: WorkflowRunRecord["state"];
  cancel_requested_at: number | null;
  cancel_actor_principal_digest: string | null;
  cancel_reason: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type StepRow = {
  run_id: string;
  workflow_id: string;
  step_id: string;
  position: number;
  kind: string;
  state: WorkflowStepRecord["state"];
  dependencies_json: string;
  timeout_seconds: number;
  run_deadline_at: number;
  attempt_count: number;
  source_refetch_attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  fencing_token: string | null;
  lease_started_at: number | null;
  lease_expires_at: number | null;
  lease_hard_expires_at: number | null;
  authority_hash: string;
  result_json: string | null;
  error: string | null;
  updated_at: number;
};

type AttemptRow = {
  attempt_id: string;
  run_id: string;
  step_id: string;
  attempt_number: number;
  worker_id: string;
  fencing_token: string;
  state: WorkflowAttemptRecord["state"];
  started_at: number;
  completed_at: number | null;
  error: string | null;
};

function mapEvent(row: EventRow): NormalizedEventRecord {
  return normalizedEventSchema.parse({
    eventId: row.event_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    source: row.source,
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    ...(row.source_modified_at !== null && row.source_fingerprint
      ? {
          sourceRevision: {
            modifiedAt: row.source_modified_at,
            fingerprint: row.source_fingerprint,
          },
        }
      : {}),
    spaceId: row.space_id,
    ...(row.object_id ? { objectId: row.object_id } : {}),
    ...(row.editor_principal_digest && row.editor_provenance
      ? {
          editor: {
            principalDigest: row.editor_principal_digest,
            provenance: row.editor_provenance,
          },
        }
      : {}),
    observedAt: row.observed_at,
    payload: parseJson(row.payload_json),
    ...(row.diff_json ? { diff: parseJson(row.diff_json) } : {}),
    ...(row.causation_run_id ? { causationRunId: row.causation_run_id } : {}),
    causalDepth: row.causal_depth,
    ...(row.origin_effect_key ? { originEffectKey: row.origin_effect_key } : {}),
    recordedAt: row.recorded_at,
  });
}

function mapDelivery(row: DeliveryRow): WorkflowDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    workflowId: row.workflow_id,
    versionHash: row.version_hash,
    eventId: row.event_id,
    eventDedupeKey: row.event_dedupe_key,
    approvalHash: row.approval_hash,
    authorityHash: row.authority_hash,
    actorPrincipalDigest: row.actor_principal_digest,
    actorProvenance: row.actor_provenance,
    state: row.state,
    createdAt: row.created_at,
    nextDispatchAt: row.next_dispatch_at,
    dispatchAttemptCount: row.dispatch_attempt_count,
    approvalPending: row.approval_pending === 1,
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
  };
}

function mapRun(row: RunRow): WorkflowRunRecord {
  return {
    runId: row.run_id,
    deliveryId: row.delivery_id,
    workflowId: row.workflow_id,
    versionHash: row.version_hash,
    approvalHash: row.approval_hash,
    authorityHash: row.authority_hash,
    actorPrincipalDigest: row.actor_principal_digest,
    actorProvenance: row.actor_provenance,
    state: row.state,
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }),
    ...(row.cancel_actor_principal_digest
      ? { cancelActorPrincipalDigest: row.cancel_actor_principal_digest }
      : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function mapStep(row: StepRow): WorkflowStepRecord {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    position: row.position,
    kind: row.kind,
    state: row.state,
    dependencies: parseJson(row.dependencies_json),
    timeoutSeconds: row.timeout_seconds,
    runDeadlineAt: row.run_deadline_at,
    attemptCount: row.attempt_count,
    sourceRefetchAttemptCount: row.source_refetch_attempt_count,
    availableAt: row.available_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.fencing_token ? { fencingToken: row.fencing_token } : {}),
    ...(row.lease_started_at === null ? {} : { leaseStartedAt: row.lease_started_at }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.lease_hard_expires_at === null
      ? {}
      : { leaseHardExpiresAt: row.lease_hard_expires_at }),
    authorityHash: row.authority_hash,
    ...(row.result_json ? { result: parseJson(row.result_json) } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptRow): WorkflowAttemptRecord {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    fencingToken: row.fencing_token,
    state: row.state,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error ? { error: row.error } : {}),
  };
}

function boundedStepResult(result: JsonValue): JsonValue {
  const redacted = redactStepResult(result);
  const serialized = canonicalJson(redacted);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_STORED_STEP_RESULT_BYTES) return redacted;
  return {
    redacted: true,
    truncated: true,
    originalBytes: bytes,
    digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}

function redactStepResult(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactStepResult);
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value))
    redacted[key] = isSensitiveResultKey(key)
      ? {
          redacted: true,
          digest: `sha256:${createHash("sha256").update(canonicalJson(nested)).digest("hex")}`,
        }
      : redactStepResult(nested);
  return redacted;
}

function isSensitiveResultKey(key: string): boolean {
  return /^(?:api[-_]?key|authorization|cookie|message|password|prompt|secret|token)$/i.test(key);
}

function boundedStepError(error: string): string {
  const redacted = error
    .replace(/\b(Bearer|Basic)\s+[\w.~+/-]+=*/gi, "$1 [redacted]")
    .replace(
      /\b(api[-_]?key|authorization|cookie|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    );
  if (redacted.length <= MAX_STORED_STEP_ERROR_CHARACTERS) return redacted;
  return `${redacted.slice(0, MAX_STORED_STEP_ERROR_CHARACTERS - 15)}...[truncated]`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
