import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "./config.js";
import {
  commandEnvelopeSchema,
  commandResultSchema,
  type CloudCommandEnvelope,
  type CloudCommandResult,
} from "./cloud-contract.js";
import type { CloudClient } from "./cloud-client.js";
import type { CloudConfig } from "./cloud-config.js";
import type { Store } from "./store.js";
import type { AnytypePort } from "./types.js";
import type { WorkflowRunnerExtension } from "./automation/runner.js";
import { canonicalJson, type JsonValue } from "./automation/workflow.js";

type CommandState =
  | "received"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "terminal_pending"
  | "succeeded"
  | "rejected"
  | "failed"
  | "cancelled"
  | "dead_letter";

type CommandRow = {
  command_id: string;
  connector_id: string;
  envelope_json: string;
  envelope_digest: string;
  required_scope: string;
  actor_principal_digest: string;
  actor_digest_version: number;
  actor_provenance: "cloud-authenticated";
  attempt: number;
  lease_token: string;
  lease_token_digest: string;
  lease_expires_at: number;
  expires_at: number;
  state: CommandState;
  local_attempts: number;
  effect_key: string;
  result_json: string | null;
  last_error_code: string | null;
  last_error: string | null;
  available_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export interface CloudCommandRecord {
  commandId: string;
  connectorId: string;
  requiredScope: string;
  actorPrincipalDigest: string;
  actorDigestVersion: number;
  actorProvenance: "cloud-authenticated";
  state: CommandState;
  attempt: number;
  localAttempts: number;
  leaseExpiresAt: number;
  expiresAt: number;
  effectKey: string;
  result?: CloudCommandResult;
  lastErrorCode?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CloudCommandClient {
  claimCommands(input?: { leaseSeconds?: number }): ReturnType<CloudClient["claimCommands"]>;
  extendLease(
    command: CloudCommandEnvelope,
    extendBySeconds?: number,
  ): ReturnType<CloudClient["extendLease"]>;
  submitResult(
    command: CloudCommandEnvelope,
    result: CloudCommandResult,
  ): ReturnType<CloudClient["submitResult"]>;
  controlPublication: CloudClient["controlPublication"];
}

export interface CloudCommandExecutionPort {
  execute(command: CloudCommandEnvelope, effectKey: string): Promise<CloudCommandResult>;
}

export class CloudCommandStore {
  constructor(private readonly store: Store) {}

  persistClaim(command: CloudCommandEnvelope, now = Date.now()): CloudCommandRecord {
    const parsed = commandEnvelopeSchema.parse(command);
    const envelopeJson = canonicalJson(parsed as unknown as JsonValue);
    const envelopeDigest = digest(
      "knot.cloud.command.immutable.v1",
      canonicalJson(immutableCommand(parsed) as unknown as JsonValue),
    );
    const leaseTokenDigest = digest("knot.cloud.command.lease.v1", parsed.leaseToken);
    const actorPrincipalDigest = parsed.actor.principalDigest;
    const effectKey = digest(
      "knot.cloud.command.effect.v1",
      parsed.connectorId,
      parsed.commandId,
      canonicalJson(parsed.payload as unknown as JsonValue),
    );
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          `INSERT INTO cloud_command_inbox(
             command_id,connector_id,envelope_json,envelope_digest,required_scope,
             actor_principal_digest,actor_digest_version,actor_provenance,attempt,lease_token,lease_token_digest,
             lease_expires_at,expires_at,state,effect_key,available_at,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,'cloud-authenticated',?,?,?,?,?,'received',?,?,?,?)
           ON CONFLICT(command_id) DO NOTHING`,
        )
        .run(
          parsed.commandId,
          parsed.connectorId,
          envelopeJson,
          envelopeDigest,
          parsed.requiredScope,
          actorPrincipalDigest,
          parsed.actor.digestVersion,
          parsed.attempt,
          parsed.leaseToken,
          leaseTokenDigest,
          parsed.leaseExpiresAt * 1_000,
          parsed.expiresAt * 1_000,
          effectKey,
          now,
          now,
          now,
        );
      const row = this.row(parsed.commandId);
      if (!row) throw new Error("Cloud command was not persisted");
      if (row.envelope_digest !== envelopeDigest || row.connector_id !== parsed.connectorId)
        throw new Error("Cloud command ID was replayed with different immutable content");
      if (
        row.attempt !== parsed.attempt ||
        row.lease_token_digest !== leaseTokenDigest ||
        row.lease_expires_at !== parsed.leaseExpiresAt * 1_000
      ) {
        if (terminalStates.has(row.state) && row.completed_at !== null) {
          this.store.db.exec("COMMIT");
          return mapCommand(row);
        }
        this.store.db
          .prepare(
            `UPDATE cloud_command_inbox SET envelope_json=?,attempt=?,lease_token=?,lease_token_digest=?,
             lease_expires_at=?,updated_at=? WHERE command_id=?`,
          )
          .run(
            envelopeJson,
            parsed.attempt,
            parsed.leaseToken,
            leaseTokenDigest,
            parsed.leaseExpiresAt * 1_000,
            now,
            parsed.commandId,
          );
      }
      this.store.db.exec("COMMIT");
      return this.command(parsed.commandId)!;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  command(commandId: string): CloudCommandRecord | undefined {
    const row = this.row(commandId);
    return row ? mapCommand(row) : undefined;
  }

  envelope(commandId: string): CloudCommandEnvelope {
    const row = this.row(commandId);
    if (!row) throw new Error("Unknown cloud command");
    return commandEnvelopeSchema.parse(JSON.parse(row.envelope_json));
  }

  list(limit = 100): CloudCommandRecord[] {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM cloud_command_inbox ORDER BY created_at DESC,command_id DESC LIMIT ?",
        )
        .all(Math.max(1, Math.min(limit, 500))) as unknown as CommandRow[]
    ).map(mapCommand);
  }

  recoverInterruptedEffects(now = Date.now()): number {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.store.db
        .prepare(
          `SELECT i.command_id,i.effect_key FROM cloud_command_inbox i
           JOIN cloud_effect_receipts r ON r.effect_key=i.effect_key
           WHERE i.state='running' AND r.state='running'`,
        )
        .all() as Array<{ command_id: string; effect_key: string }>;
      for (const row of rows) {
        const result = commandResultSchema.parse({
          outcome: "failed",
          retryable: false,
          errorCode: "effect-outcome-unknown",
        });
        this.store.db
          .prepare(
            `UPDATE cloud_effect_receipts SET state='outcome_unknown',
             error_code='effect-outcome-unknown',error='Process stopped while an external effect was in flight',
             completed_at=?,updated_at=? WHERE effect_key=? AND state='running'`,
          )
          .run(now, now, row.effect_key);
        this.store.db
          .prepare(
            `UPDATE cloud_command_inbox SET state='dead_letter',
             result_json=?,
             last_error_code='effect-outcome-unknown',
             last_error='External effect outcome is unknown; Knot will not repeat it automatically',
             completed_at=NULL,updated_at=? WHERE command_id=? AND state='running'`,
          )
          .run(JSON.stringify(result), now, row.command_id);
        this.enqueueProjection(row.command_id, "dead_letter", now);
      }
      this.store.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  prepare(commandId: string, approvalRequired: boolean, now = Date.now()): boolean {
    const next = approvalRequired ? "awaiting_approval" : "queued";
    const changed = this.store.db
      .prepare(
        "UPDATE cloud_command_inbox SET state=?,updated_at=? WHERE command_id=? AND state='received'",
      )
      .run(next, now, commandId).changes;
    if (changed) this.enqueueProjection(commandId, next, now);
    return changed === 1;
  }

  reject(commandId: string, reasonCode: string, now = Date.now()): boolean {
    return this.setTerminalPending(
      commandId,
      { outcome: "rejected-by-local-policy", reasonCode: safeCode(reasonCode) },
      now,
      ["received", "awaiting_approval", "queued"],
    );
  }

  cancel(commandId: string, now = Date.now()): boolean {
    return this.setTerminalPending(
      commandId,
      { outcome: "rejected-by-local-policy", reasonCode: "operator-cancelled" },
      now,
      ["received", "awaiting_approval", "queued"],
    );
  }

  approve(commandId: string, now = Date.now()): boolean {
    const changed = this.store.db
      .prepare(
        "UPDATE cloud_command_inbox SET state='queued',available_at=?,updated_at=? WHERE command_id=? AND state='awaiting_approval'",
      )
      .run(now, now, commandId).changes;
    if (changed) this.enqueueProjection(commandId, "approved", now);
    return changed === 1;
  }

  retry(commandId: string, now = Date.now()): boolean {
    const row = this.row(commandId);
    if (
      !row ||
      row.completed_at !== null ||
      !["terminal_pending", "failed", "dead_letter"].includes(row.state)
    )
      return false;
    const result = row.result_json
      ? commandResultSchema.parse(JSON.parse(row.result_json))
      : undefined;
    if (result?.outcome !== "failed") return false;
    const receipt = this.store.db
      .prepare("SELECT state FROM cloud_effect_receipts WHERE effect_key=?")
      .get(row.effect_key) as { state: string } | undefined;
    if (receipt && !["failed"].includes(receipt.state))
      throw new Error(
        "This command may have produced an external effect and cannot be retried safely",
      );
    this.store.db
      .prepare(
        `UPDATE cloud_effect_receipts SET state='prepared',fencing_token=?,error_code=NULL,error=NULL,
         started_at=NULL,completed_at=NULL,updated_at=? WHERE effect_key=? AND state='failed'`,
      )
      .run(randomUUID(), now, row.effect_key);
    const changed = this.store.db
      .prepare(
        `UPDATE cloud_command_inbox SET state='queued',available_at=?,last_error_code=NULL,
         last_error=NULL,result_json=NULL,completed_at=NULL,updated_at=?
         WHERE command_id=? AND completed_at IS NULL
         AND state IN ('terminal_pending','failed','dead_letter')`,
      )
      .run(now, now, commandId).changes;
    if (changed) this.enqueueProjection(commandId, "retrying", now);
    return changed === 1;
  }

  nextReady(now = Date.now()): CloudCommandRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM cloud_command_inbox WHERE state='queued' AND available_at<=?
         ORDER BY created_at,command_id LIMIT 1`,
      )
      .get(now) as CommandRow | undefined;
    return row ? mapCommand(row) : undefined;
  }

  startEffect(commandId: string, now = Date.now()): { effectKey: string; fencingToken: string } {
    const row = this.row(commandId);
    if (!row || row.state !== "queued") throw new Error("Cloud command is not ready");
    const operationDigest = digest(
      "knot.cloud.command.operation.v1",
      canonicalJson(this.envelope(commandId).payload as unknown as JsonValue),
    );
    const fencingToken = randomUUID();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          `INSERT INTO cloud_effect_receipts(
             effect_key,command_id,operation_digest,state,fencing_token,updated_at
           ) VALUES(?,?,?,'prepared',?,?) ON CONFLICT(effect_key) DO NOTHING`,
        )
        .run(row.effect_key, commandId, operationDigest, fencingToken, now);
      const receipt = this.store.db
        .prepare(
          "SELECT operation_digest,state,fencing_token FROM cloud_effect_receipts WHERE effect_key=?",
        )
        .get(row.effect_key) as {
        operation_digest: string;
        state: string;
        fencing_token: string;
      };
      if (receipt.operation_digest !== operationDigest)
        throw new Error("Effect key is bound to different operation content");
      if (receipt.state === "succeeded") throw new Error("Effect already completed");
      if (!["prepared", "failed"].includes(receipt.state))
        throw new Error("Effect cannot be executed again without operator reconciliation");
      const token = receipt.state === "prepared" ? receipt.fencing_token : fencingToken;
      if (receipt.state === "failed")
        this.store.db
          .prepare(
            `UPDATE cloud_effect_receipts SET state='prepared',fencing_token=?,error_code=NULL,
             error=NULL,started_at=NULL,completed_at=NULL,updated_at=? WHERE effect_key=? AND state='failed'`,
          )
          .run(token, now, row.effect_key);
      const changed = this.store.db
        .prepare(
          `UPDATE cloud_command_inbox SET state='running',local_attempts=local_attempts+1,
           updated_at=? WHERE command_id=? AND state='queued'`,
        )
        .run(now, commandId).changes;
      if (changed !== 1) throw new Error("Cloud command lost its local queue lease");
      this.store.db
        .prepare(
          `UPDATE cloud_effect_receipts SET state='running',started_at=?,updated_at=?
           WHERE effect_key=? AND state='prepared' AND fencing_token=?`,
        )
        .run(now, now, row.effect_key, token);
      this.store.db.exec("COMMIT");
      return { effectKey: row.effect_key, fencingToken: token };
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeEffect(
    commandId: string,
    fencingToken: string,
    result: CloudCommandResult,
    now = Date.now(),
  ): boolean {
    const parsed = commandResultSchema.parse(result);
    const row = this.row(commandId);
    if (!row) return false;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const receiptChanged = this.store.db
        .prepare(
          `UPDATE cloud_effect_receipts SET state='succeeded',result_json=?,completed_at=?,updated_at=?
           WHERE effect_key=? AND state='running' AND fencing_token=?`,
        )
        .run(JSON.stringify(parsed), now, now, row.effect_key, fencingToken).changes;
      if (receiptChanged !== 1) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const commandChanged = this.store.db
        .prepare(
          `UPDATE cloud_command_inbox SET state='terminal_pending',result_json=?,updated_at=?
           WHERE command_id=? AND state='running'`,
        )
        .run(JSON.stringify(parsed), now, commandId).changes;
      if (commandChanged !== 1)
        throw new Error("Cloud command fencing token lost before completion");
      this.enqueueProjection(commandId, "effect-complete", now);
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  failEffect(
    commandId: string,
    fencingToken: string,
    input: { code: string; message: string; retryable: boolean; retryAt?: number },
    maximumAttempts = 3,
    now = Date.now(),
  ): boolean {
    const row = this.row(commandId);
    if (!row) return false;
    const safeRetry = input.retryable && isRetrySafe(this.envelope(commandId));
    const retry = safeRetry && row.local_attempts < maximumAttempts;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.store.db
        .prepare(
          `UPDATE cloud_effect_receipts SET state='failed',error_code=?,error=?,completed_at=?,updated_at=?
           WHERE effect_key=? AND state='running' AND fencing_token=?`,
        )
        .run(
          safeCode(input.code),
          input.message.slice(0, 2_000),
          now,
          now,
          row.effect_key,
          fencingToken,
        ).changes;
      if (changed !== 1) {
        this.store.db.exec("COMMIT");
        return false;
      }
      if (retry)
        this.store.db
          .prepare(
            `UPDATE cloud_command_inbox SET state='queued',available_at=?,last_error_code=?,
             last_error=?,updated_at=? WHERE command_id=? AND state='running'`,
          )
          .run(
            input.retryAt ?? now + backoff(row.local_attempts),
            safeCode(input.code),
            input.message.slice(0, 2_000),
            now,
            commandId,
          );
      else {
        const result = commandResultSchema.parse({
          outcome: "failed",
          retryable: false,
          errorCode: safeCode(input.code),
        });
        this.store.db
          .prepare(
            `UPDATE cloud_command_inbox SET state='terminal_pending',result_json=?,
             last_error_code=?,last_error=?,updated_at=? WHERE command_id=? AND state='running'`,
          )
          .run(
            JSON.stringify(result),
            safeCode(input.code),
            input.message.slice(0, 2_000),
            now,
            commandId,
          );
      }
      this.enqueueProjection(commandId, retry ? "retrying" : "failed", now);
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  terminalPending(): CloudCommandRecord[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM cloud_command_inbox
           WHERE state='terminal_pending'
              OR (state='dead_letter' AND result_json IS NOT NULL AND completed_at IS NULL)
           ORDER BY updated_at,command_id LIMIT 20`,
        )
        .all() as unknown as CommandRow[]
    ).map(mapCommand);
  }

  markSubmitted(commandId: string, result: CloudCommandResult, now = Date.now()): boolean {
    let state =
      result.outcome === "succeeded"
        ? "succeeded"
        : result.outcome === "rejected-by-local-policy"
          ? result.reasonCode === "operator-cancelled"
            ? "cancelled"
            : "rejected"
          : "failed";
    const current = this.row(commandId);
    const receipt = current
      ? (this.store.db
          .prepare("SELECT state FROM cloud_effect_receipts WHERE effect_key=?")
          .get(current.effect_key) as { state: string } | undefined)
      : undefined;
    if (
      result.outcome === "failed" &&
      (current?.state === "dead_letter" ||
        receipt?.state === "failed" ||
        receipt?.state === "outcome_unknown")
    )
      state = "dead_letter";
    const changed = this.store.db
      .prepare(
        `UPDATE cloud_command_inbox SET state=?,completed_at=?,updated_at=?
         WHERE command_id=? AND state IN ('terminal_pending','dead_letter') AND result_json=?`,
      )
      .run(state, now, now, commandId, JSON.stringify(commandResultSchema.parse(result))).changes;
    if (changed) this.enqueueProjection(commandId, state, now);
    return changed === 1;
  }

  updateLease(commandId: string, leaseExpiresAtSeconds: number, now = Date.now()): void {
    this.store.db
      .prepare(
        `UPDATE cloud_command_inbox SET lease_expires_at=?,updated_at=?
         WHERE command_id=? AND state IN ('received','awaiting_approval','queued','running','terminal_pending')`,
      )
      .run(leaseExpiresAtSeconds * 1_000, now, commandId);
  }

  expire(now = Date.now()): number {
    const rows = this.store.db
      .prepare(
        `SELECT command_id FROM cloud_command_inbox WHERE expires_at<=?
         AND state IN ('received','awaiting_approval','queued')`,
      )
      .all(now) as Array<{ command_id: string }>;
    for (const row of rows) this.reject(row.command_id, "command-expired", now);
    return rows.length;
  }

  claimProjection(workerId: string, now = Date.now()): ProjectionRecord | undefined {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          `UPDATE cloud_projection_outbox SET state='retrying',lease_owner=NULL,lease_expires_at=NULL,
           available_at=?,updated_at=? WHERE state='in_flight' AND lease_expires_at<=?`,
        )
        .run(now, now, now);
      const row = this.store.db
        .prepare(
          `SELECT projection_id FROM cloud_projection_outbox
           WHERE state IN ('pending','retrying') AND available_at<=?
           ORDER BY created_at,projection_id LIMIT 1`,
        )
        .get(now) as { projection_id: string } | undefined;
      if (!row) {
        this.store.db.exec("COMMIT");
        return undefined;
      }
      this.store.db
        .prepare(
          `UPDATE cloud_projection_outbox SET state='in_flight',attempt=attempt+1,
           lease_owner=?,lease_expires_at=?,updated_at=? WHERE projection_id=?`,
        )
        .run(workerId, now + 30_000, now, row.projection_id);
      const claimed = this.projection(row.projection_id);
      this.store.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeProjection(
    projectionId: string,
    workerId: string,
    messageId: string,
    now = Date.now(),
  ): void {
    this.store.db
      .prepare(
        `UPDATE cloud_projection_outbox SET state='delivered',target_message_id=?,delivered_at=?,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE projection_id=? AND state='in_flight' AND lease_owner=?`,
      )
      .run(messageId, now, now, projectionId, workerId);
  }

  failProjection(
    projectionId: string,
    workerId: string,
    error: string,
    attempt: number,
    now = Date.now(),
  ): void {
    const terminal = attempt >= 5;
    this.store.db
      .prepare(
        `UPDATE cloud_projection_outbox SET state=?,available_at=?,last_error=?,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE projection_id=? AND state='in_flight' AND lease_owner=?`,
      )
      .run(
        terminal ? "dead_letter" : "retrying",
        terminal ? now : now + backoff(attempt),
        error.slice(0, 2_000),
        now,
        projectionId,
        workerId,
      );
  }

  private setTerminalPending(
    commandId: string,
    result: CloudCommandResult,
    now: number,
    allowed: CommandState[],
  ): boolean {
    const parsed = commandResultSchema.parse(result);
    const placeholders = allowed.map(() => "?").join(",");
    const changed = this.store.db
      .prepare(
        `UPDATE cloud_command_inbox SET state='terminal_pending',result_json=?,updated_at=?
         WHERE command_id=? AND state IN (${placeholders})`,
      )
      .run(JSON.stringify(parsed), now, commandId, ...allowed).changes;
    if (changed) this.enqueueProjection(commandId, parsed.outcome, now);
    return changed === 1;
  }

  private enqueueProjection(commandId: string, state: string, now: number): void {
    const originEffectKey = digest("knot.cloud.projection.v1", commandId, state);
    this.store.db
      .prepare(
        `INSERT INTO cloud_projection_outbox(
           projection_id,command_id,origin_effect_key,payload_json,state,available_at,created_at,updated_at
         ) VALUES(?,?,?,?,'pending',?,?,?) ON CONFLICT(origin_effect_key) DO NOTHING`,
      )
      .run(
        randomUUID(),
        commandId,
        originEffectKey,
        JSON.stringify({ commandId, state, originEffectKey }),
        now,
        now,
        now,
      );
  }

  private projection(projectionId: string): ProjectionRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM cloud_projection_outbox WHERE projection_id=?")
      .get(projectionId) as ProjectionRow | undefined;
    return row ? mapProjection(row) : undefined;
  }

  private row(commandId: string): CommandRow | undefined {
    return this.store.db
      .prepare("SELECT * FROM cloud_command_inbox WHERE command_id=?")
      .get(commandId) as CommandRow | undefined;
  }
}

type ProjectionRow = {
  projection_id: string;
  command_id: string;
  origin_effect_key: string;
  payload_json: string;
  state: string;
  attempt: number;
  lease_owner: string | null;
  target_message_id: string | null;
};

interface ProjectionRecord {
  projectionId: string;
  commandId: string;
  originEffectKey: string;
  payload: { commandId: string; state: string; originEffectKey: string };
  attempt: number;
}

export class CloudWorkflowExtension implements WorkflowRunnerExtension {
  private readonly inbox: CloudCommandStore;
  private readonly projectionWorkerId = `cloud-projection-${randomUUID()}`;
  private nextPollAt = 0;
  private recovered = false;

  constructor(
    store: Store,
    private readonly client: CloudCommandClient,
    private readonly executor: CloudCommandExecutionPort,
    private readonly config: AgentConfig["cloudCommands"],
    private readonly anytype: AnytypePort,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.inbox = new CloudCommandStore(store);
  }

  async beforeTick(): Promise<void> {
    const now = this.now();
    if (!this.recovered) {
      const recovered = this.inbox.recoverInterruptedEffects(now);
      if (recovered) this.log("cloud_command_effects_quarantined", { count: recovered });
      this.recovered = true;
    }
    this.inbox.expire(now);
    await this.extendLeases(now);
    await this.submitTerminalResults(now);
    if (now >= this.nextPollAt) await this.poll(now);
    const ready = this.inbox.nextReady(now);
    if (ready && ready.leaseExpiresAt > now) await this.execute(ready, now);
    else if (ready)
      this.log("cloud_command_waiting_for_lease", {
        commandId: ready.commandId,
        attempt: ready.attempt,
      });
  }

  async afterTick(): Promise<void> {
    if (!this.config.projection.enabled) return;
    const projection = this.inbox.claimProjection(this.projectionWorkerId, this.now());
    if (!projection) return;
    try {
      const messageId = await this.anytype.sendMessage(
        this.config.projection.spaceId!,
        this.config.projection.chatId!,
        {
          text: `Knot Cloud command ${projection.commandId}: ${projection.payload.state}`,
        },
      );
      this.inbox.completeProjection(
        projection.projectionId,
        this.projectionWorkerId,
        messageId,
        this.now(),
      );
    } catch (error) {
      this.inbox.failProjection(
        projection.projectionId,
        this.projectionWorkerId,
        message(error),
        projection.attempt,
        this.now(),
      );
    }
  }

  private async poll(now: number): Promise<void> {
    try {
      const response = await this.client.claimCommands({ leaseSeconds: this.config.leaseSeconds });
      this.nextPollAt = now + response.pollAfterSeconds * 1_000;
      for (const command of response.commands) {
        const record = this.inbox.persistClaim(command, now);
        if (record.state !== "received") continue;
        const denial = localPolicyDenial(command, this.config, now);
        if (denial) this.inbox.reject(command.commandId, denial, now);
        else this.inbox.prepare(command.commandId, approvalRequired(command, this.config), now);
        this.log("cloud_command_persisted", {
          commandId: command.commandId,
          requiredScope: command.requiredScope,
          actorPrincipalDigest: record.actorPrincipalDigest,
          actorProvenance: record.actorProvenance,
        });
      }
    } catch (error) {
      this.nextPollAt = now + this.config.pollIntervalSeconds * 1_000;
      this.log("cloud_command_poll_failed", { error: message(error) });
    }
  }

  private async extendLeases(now: number): Promise<void> {
    for (const command of this.inbox.list(100)) {
      if (
        (terminalStates.has(command.state) && command.completedAt !== undefined) ||
        command.leaseExpiresAt - now > Math.max(5_000, (this.config.leaseSeconds * 1_000) / 2)
      )
        continue;
      try {
        const envelope = this.inbox.envelope(command.commandId);
        const extended = await this.client.extendLease(envelope, this.config.leaseSeconds);
        if (extended.commandId !== command.commandId || extended.attempt !== envelope.attempt)
          throw new Error("Cloud returned a lease extension for a different command fence");
        this.inbox.updateLease(command.commandId, extended.leaseExpiresAt, now);
      } catch (error) {
        this.log("cloud_command_lease_extension_failed", {
          commandId: command.commandId,
          error: message(error),
        });
      }
    }
  }

  private async execute(record: CloudCommandRecord, now: number): Promise<void> {
    const command = this.inbox.envelope(record.commandId);
    const denial = localPolicyDenial(command, this.config, now);
    if (denial) {
      this.inbox.reject(command.commandId, denial, now);
      return;
    }
    const { fencingToken } = this.inbox.startEffect(command.commandId, now);
    const heartbeat = new AbortController();
    const leaseTask = this.maintainLease(command.commandId, heartbeat.signal);
    try {
      const result = await this.executor.execute(command, record.effectKey);
      this.inbox.completeEffect(command.commandId, fencingToken, result, this.now());
    } catch (error) {
      const failure = cloudExecutionError(error);
      this.inbox.failEffect(
        command.commandId,
        fencingToken,
        {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
        this.config.maximumLocalAttempts,
        this.now(),
      );
    } finally {
      heartbeat.abort();
      await leaseTask;
    }
  }

  private async maintainLease(commandId: string, signal: AbortSignal): Promise<void> {
    const interval = Math.max(5_000, (this.config.leaseSeconds * 1_000) / 2);
    while (!signal.aborted) {
      if (!(await waitFor(interval, signal))) return;
      try {
        const envelope = this.inbox.envelope(commandId);
        const extended = await this.client.extendLease(envelope, this.config.leaseSeconds);
        if (extended.commandId !== commandId || extended.attempt !== envelope.attempt)
          throw new Error("Cloud returned a lease extension for a different command fence");
        this.inbox.updateLease(commandId, extended.leaseExpiresAt, this.now());
      } catch (error) {
        this.log("cloud_command_lease_extension_failed", {
          commandId,
          error: message(error),
        });
      }
    }
  }

  private async submitTerminalResults(now: number): Promise<void> {
    for (const record of this.inbox.terminalPending()) {
      if (!record.result) continue;
      try {
        const command = this.inbox.envelope(record.commandId);
        const receipt = await this.client.submitResult(command, record.result);
        if (receipt.commandId !== record.commandId || receipt.attempt !== command.attempt)
          throw new Error("Cloud acknowledged a different command fence");
        this.inbox.markSubmitted(record.commandId, record.result, now);
      } catch (error) {
        this.log("cloud_command_result_submission_failed", {
          commandId: record.commandId,
          error: message(error),
        });
      }
    }
  }
}

export class AnytypeCloudCommandExecutor implements CloudCommandExecutionPort {
  constructor(
    private readonly anytype: AnytypePort,
    private readonly cloud: CloudCommandClient,
    private readonly cloudConfig: CloudConfig,
    private readonly agentParticipantId: string,
  ) {}

  async execute(command: CloudCommandEnvelope, effectKey: string): Promise<CloudCommandResult> {
    if (command.payload.domain === "publication") {
      const result = await this.cloud.controlPublication({
        protocolVersion: "1.0",
        connectorId: command.connectorId,
        idempotencyKey: effectKey,
        operation: command.payload.operation,
      });
      return commandResultSchema.parse({ outcome: "succeeded", result });
    }
    const operation = command.payload.operation;
    const senderDigest = digest("knot.anytype.participant.v1", this.agentParticipantId);
    const provenance = (spaceId: string, objectId?: string, messageId?: string) => ({
      kind: "connector-attested-anytype" as const,
      connectorId: command.connectorId,
      senderDigest,
      spaceId,
      ...(objectId ? { objectId } : {}),
      ...(messageId ? { messageId } : {}),
    });
    switch (operation.type) {
      case "object.read": {
        const object = await this.anytype.getObject(operation.spaceId, operation.objectId);
        return success({
          type: operation.type,
          object: snapshot(
            object,
            operation.spaceId,
            operation.objectId,
            provenance(operation.spaceId, operation.objectId),
          ),
        });
      }
      case "object.query": {
        if (!this.anytype.searchSpace) throw unsupported(operation.type);
        const objects = await this.anytype.searchSpace(operation.spaceId, {
          text: operation.text,
          query: operation.text,
          ...(operation.typeKey ? { types: [operation.typeKey] } : {}),
          limit: operation.limit,
        } as { query?: string; types?: string[]; limit?: number });
        return success({
          type: operation.type,
          objects: objects.slice(0, operation.limit).map((object) => {
            const id = stringField(object, "id");
            return snapshot(object, operation.spaceId, id, provenance(operation.spaceId, id));
          }),
        });
      }
      case "object.create": {
        if (!this.anytype.createObject) throw unsupported(operation.type);
        const object = await this.anytype.createObject(operation.spaceId, {
          type_key: operation.typeKey,
          name: operation.name,
          properties: properties(operation.properties),
        });
        const id = stringField(object, "id");
        return success({
          type: operation.type,
          object: snapshot(object, operation.spaceId, id, provenance(operation.spaceId, id)),
        });
      }
      case "object.update": {
        const object = await this.anytype.updateObject(operation.spaceId, operation.objectId, {
          properties: properties(operation.properties),
        });
        return success({
          type: operation.type,
          object: snapshot(
            object,
            operation.spaceId,
            operation.objectId,
            provenance(operation.spaceId, operation.objectId),
          ),
        });
      }
      case "object.archive": {
        if (!this.anytype.archiveObject) throw unsupported(operation.type);
        await this.anytype.archiveObject(operation.spaceId, operation.objectId);
        return success({ ...operation, archived: true });
      }
      case "collection.read": {
        if (!this.anytype.listViews || !this.anytype.listViewObjects)
          throw unsupported(operation.type);
        const [view] = await this.anytype.listViews(operation.spaceId, operation.collectionId);
        if (!view) return success({ ...operation, objectIds: [] });
        const viewId = stringField(view, "id");
        const objects = await this.anytype.listViewObjects(
          operation.spaceId,
          operation.collectionId,
          viewId,
          { offset: 0, limit: operation.limit },
        );
        return success({
          ...operation,
          objectIds: objects.map((object) => stringField(object, "id")),
        });
      }
      case "collection.members.add": {
        if (!this.anytype.addObjectsToList) throw unsupported(operation.type);
        await this.anytype.addObjectsToList(
          operation.spaceId,
          operation.collectionId,
          operation.objectIds,
        );
        return success(operation);
      }
      case "collection.members.remove": {
        if (!this.anytype.removeObjectFromList) throw unsupported(operation.type);
        for (const objectId of operation.objectIds)
          await this.anytype.removeObjectFromList(
            operation.spaceId,
            operation.collectionId,
            objectId,
          );
        return success(operation);
      }
      case "file.upload": {
        if (!this.anytype.uploadFile) throw unsupported(operation.type);
        const path = await resolveAsset(
          operation.assetDigest,
          operation.name,
          this.cloudConfig.publication.allowedAssetRoots,
        );
        const file = await this.anytype.uploadFile(operation.spaceId, path);
        return success({
          type: operation.type,
          spaceId: operation.spaceId,
          fileId: stringField(file, "id", "file_id"),
          assetDigest: operation.assetDigest,
        });
      }
      case "file.download": {
        if (!this.anytype.downloadFile) throw unsupported(operation.type);
        const downloaded = await this.anytype.downloadFile(
          operation.spaceId,
          operation.fileId,
          this.cloudConfig.publication.maximumAssetBytes,
        );
        return success({
          type: operation.type,
          spaceId: operation.spaceId,
          fileId: operation.fileId,
          assetDigest: createHash("sha256").update(downloaded.bytes).digest("hex"),
          name: basename(operation.fileId),
          contentType: downloaded.contentType ?? "application/octet-stream",
          byteSize: downloaded.bytes.byteLength,
        });
      }
      case "file.attach":
        throw unsupported(operation.type);
      case "chat.read": {
        const messages = await this.anytype.listMessages(
          operation.spaceId,
          operation.chatId,
          operation.limit,
        );
        return success({
          type: operation.type,
          spaceId: operation.spaceId,
          chatId: operation.chatId,
          messages: messages.map((message) => {
            const participantDigest = digest(
              "knot.anytype.participant.v1",
              String(message.creator ?? "unknown"),
            );
            return {
              messageId: message.id,
              text: message.content?.text ?? "",
              sentAt: toUnixSeconds(message.created_at),
              senderDigest: participantDigest,
              provenance: {
                kind: "connector-attested-anytype" as const,
                connectorId: command.connectorId,
                senderDigest: participantDigest,
                spaceId: operation.spaceId,
                messageId: message.id,
              },
            };
          }),
        });
      }
      case "chat.send": {
        const messageId = await this.anytype.sendMessage(operation.spaceId, operation.chatId, {
          text: operation.message,
        });
        return success({
          type: operation.type,
          spaceId: operation.spaceId,
          chatId: operation.chatId,
          messageId,
          sentAt: Math.floor(Date.now() / 1_000),
        });
      }
    }
  }
}

function localPolicyDenial(
  command: CloudCommandEnvelope,
  config: AgentConfig["cloudCommands"],
  now: number,
): string | undefined {
  if (command.expiresAt * 1_000 <= now) return "command-expired";
  if (command.notBefore * 1_000 > now) return "command-not-active";
  if (!config.allowedCreatorKinds.includes(command.createdBy)) return "creator-kind-denied";
  if (!config.allowedActorDigests.includes(command.actor.principalDigest))
    return "actor-principal-denied";
  if (!config.allowedScopes.includes(command.requiredScope)) return "scope-denied";
  if (command.payload.domain === "anytype") {
    const spaceId = command.payload.operation.spaceId;
    if (!config.allowedSpaceIds.includes(spaceId)) return "space-denied";
  }
  return undefined;
}

function approvalRequired(
  command: CloudCommandEnvelope,
  config: AgentConfig["cloudCommands"],
): boolean {
  if (config.approval === "all") return true;
  if (config.approval === "none") return false;
  return !["object.read", "object.query", "collection.read", "file.download", "chat.read"].includes(
    command.payload.operation.type,
  );
}

function isRetrySafe(command: CloudCommandEnvelope): boolean {
  return (
    command.payload.domain === "publication" ||
    ["object.read", "object.query", "collection.read", "file.download", "chat.read"].includes(
      command.payload.operation.type,
    )
  );
}

function success(result: unknown): CloudCommandResult {
  return commandResultSchema.parse({ outcome: "succeeded", result });
}

class CloudEffectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function unsupported(type: string): CloudEffectError {
  return new CloudEffectError(
    `The local Anytype adapter does not support ${type}`,
    "unsupported-operation",
    false,
  );
}

function cloudExecutionError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof CloudEffectError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "external-effect-failed", message: message(error), retryable: true };
}

function snapshot(
  raw: Record<string, unknown>,
  spaceId: string,
  objectId: string,
  provenance: {
    kind: "connector-attested-anytype";
    connectorId: string;
    senderDigest: string;
    spaceId: string;
    objectId?: string;
  },
) {
  const rawType = raw.type;
  const typeKey =
    typeof raw.type_key === "string"
      ? raw.type_key
      : typeof rawType === "object" && rawType && "key" in rawType
        ? String((rawType as { key: unknown }).key)
        : "unknown";
  return {
    spaceId,
    objectId,
    typeKey,
    name: typeof raw.name === "string" ? raw.name : objectId,
    properties: safeProperties(raw.properties),
    provenance,
  };
}

function safeProperties(
  value: unknown,
): Record<string, boolean | number | string | string[] | null> {
  if (Array.isArray(value)) {
    const normalized: Record<string, unknown> = Object.create(null);
    for (const entry of value.slice(0, 1_000)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key : undefined;
      if (!key) continue;
      normalized[key] =
        record.value ??
        record.text ??
        record.number ??
        record.checkbox ??
        record.multi_select ??
        record.objects ??
        null;
    }
    return safeProperties(normalized);
  }
  if (!value || typeof value !== "object") return {};
  const result: Record<string, boolean | number | string | string[] | null> = Object.create(null);
  for (const [key, candidate] of Object.entries(value).slice(0, 1_000)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "string"
    )
      result[key] = candidate;
    else if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string"))
      result[key] = candidate.slice(0, 1_000);
  }
  return result;
}

function properties(value: Record<string, boolean | number | string | string[] | null>) {
  return Object.entries(value).map(([key, propertyValue]) => ({ key, value: propertyValue }));
}

async function resolveAsset(digestValue: string, name: string, roots: string[]): Promise<string> {
  for (const root of roots) {
    for (const candidate of [join(root, digestValue), join(root, name)]) {
      try {
        const canonicalRoot = await realpath(root);
        const canonical = await realpath(candidate);
        const path = relative(canonicalRoot, canonical);
        if (path.startsWith("..") || isAbsolute(path) || !(await stat(canonical)).isFile())
          continue;
        const bytes = await readFile(canonical);
        if (createHash("sha256").update(bytes).digest("hex") === digestValue) return canonical;
      } catch {
        // Try the next explicit candidate. Knot never scans arbitrary directories.
      }
    }
  }
  throw new CloudEffectError(
    "No allowed local asset matches the requested digest",
    "asset-unavailable",
    false,
  );
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key];
  throw new CloudEffectError(
    "Anytype returned an object without an expected ID",
    "invalid-anytype-response",
    false,
  );
}

function mapCommand(row: CommandRow): CloudCommandRecord {
  return {
    commandId: row.command_id,
    connectorId: row.connector_id,
    requiredScope: row.required_scope,
    actorPrincipalDigest: row.actor_principal_digest,
    actorDigestVersion: row.actor_digest_version,
    actorProvenance: row.actor_provenance,
    state: row.state,
    attempt: row.attempt,
    localAttempts: row.local_attempts,
    leaseExpiresAt: row.lease_expires_at,
    expiresAt: row.expires_at,
    effectKey: row.effect_key,
    ...(row.result_json ? { result: commandResultSchema.parse(JSON.parse(row.result_json)) } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function mapProjection(row: ProjectionRow): ProjectionRecord {
  return {
    projectionId: row.projection_id,
    commandId: row.command_id,
    originEffectKey: row.origin_effect_key,
    payload: z
      .object({ commandId: z.string(), state: z.string(), originEffectKey: z.string() })
      .parse(JSON.parse(row.payload_json)),
    attempt: row.attempt,
  };
}

function digest(domain: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(domain);
  for (const part of parts) hash.update("\0").update(part);
  return hash.digest("hex");
}

function safeCode(value: string): string {
  const code = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return (code || "local-policy-denied").slice(0, 200);
}

function backoff(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function toUnixSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Math.floor(Date.now() / 1_000);
  return Math.floor(value > 100_000_000_000 ? value / 1_000 : value);
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve(true);
    }
    function aborted() {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const terminalStates = new Set<CommandState>([
  "succeeded",
  "rejected",
  "failed",
  "cancelled",
  "dead_letter",
]);

function immutableCommand(command: CloudCommandEnvelope) {
  return {
    protocolVersion: command.protocolVersion,
    commandId: command.commandId,
    connectorId: command.connectorId,
    requiredScope: command.requiredScope,
    createdBy: command.createdBy,
    actor: command.actor,
    createdAt: command.createdAt,
    notBefore: command.notBefore,
    expiresAt: command.expiresAt,
    payload: command.payload,
  };
}
