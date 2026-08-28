import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BridgeDeliverySchema,
  BridgeInboundSchema,
  type AnytypeRoute,
  type BridgeDelivery,
  type BridgeInbound,
  type StoredDelivery,
} from "./protocol.js";

type Row = Record<string, unknown>;

export class BridgeStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_inbound (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_outbound (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bridge_outbound_pending
        ON bridge_outbound(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS bridge_bindings (
        session_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        route TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_owned_runs (
        run_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  putInbound(message: BridgeInbound, now = Date.now()): boolean {
    const payload = JSON.stringify(BridgeInboundSchema.parse(message));
    const result = this.#db
      .prepare(
        `INSERT INTO bridge_inbound
         (id, payload, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           status = 'pending',
           last_error = NULL,
           updated_at = excluded.updated_at
         WHERE bridge_inbound.status = 'failed'`,
      )
      .run(message.id, payload, now, now);
    return result.changes > 0;
  }

  pendingInbound(limit = 50): BridgeInbound[] {
    const rows = this.#db
      .prepare(
        `SELECT payload FROM bridge_inbound WHERE status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => BridgeInboundSchema.parse(JSON.parse(String(row.payload))));
  }

  markInbound(id: string, status: "delivered" | "failed", error?: string, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE bridge_inbound SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, error ?? null, now, id);
  }

  inboundStatus(id: string): { status: string; lastError?: string } | undefined {
    const row = this.#db
      .prepare("SELECT status, last_error FROM bridge_inbound WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      status: String(row.status),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    };
  }

  bindSession(sessionKey: string, accountId: string, route: AnytypeRoute, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO bridge_bindings(session_key, account_id, route, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           account_id = excluded.account_id,
           route = excluded.route,
           updated_at = excluded.updated_at`,
      )
      .run(sessionKey, accountId, JSON.stringify(route), now);
  }

  bindingForSession(sessionKey: string): { accountId: string; route: AnytypeRoute } | undefined {
    const row = this.#db
      .prepare("SELECT account_id, route FROM bridge_bindings WHERE session_key = ?")
      .get(sessionKey) as Row | undefined;
    if (!row) return undefined;
    return {
      accountId: String(row.account_id),
      route: JSON.parse(String(row.route)) as AnytypeRoute,
    };
  }

  markOwnedRun(runId: string, now = Date.now()): void {
    this.#db.prepare("INSERT OR REPLACE INTO bridge_owned_runs(run_id,created_at) VALUES(?,?)").run(runId, now);
  }

  isOwnedRun(runId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM bridge_owned_runs WHERE run_id=?").get(runId));
  }

  pruneOwnedRuns(before: number): number {
    return Number(this.#db.prepare("DELETE FROM bridge_owned_runs WHERE created_at < ?").run(before).changes);
  }

  putDelivery(delivery: BridgeDelivery, now = Date.now()): boolean {
    const parsed = BridgeDeliverySchema.parse(delivery);
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO bridge_outbound
         (id, idempotency_key, payload, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(parsed.id, parsed.idempotencyKey, JSON.stringify(parsed), now, now, now);
    return result.changes > 0;
  }

  pendingDeliveries(now = Date.now(), limit = 100, afterSequence = 0): StoredDelivery[] {
    const rows = this.#db
      .prepare(
        `SELECT rowid AS store_sequence, payload, attempts, next_attempt_at, last_error FROM bridge_outbound
         WHERE status = 'pending' AND next_attempt_at <= ?
           AND rowid > ?
         ORDER BY rowid ASC LIMIT ?`,
      )
      .all(now, afterSequence, limit) as Row[];
    return rows.map((row) => ({
      ...BridgeDeliverySchema.parse(JSON.parse(String(row.payload))),
      storeSequence: Number(row.store_sequence),
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    }));
  }

  pendingDeliveriesFor(
    filter: { sessionKey: string; route: AnytypeRoute },
    now = Date.now(),
    limit = 100,
    afterSequence = 0,
  ): StoredDelivery[] {
    const rows = this.#db
      .prepare(
        `SELECT rowid AS store_sequence, payload, attempts, next_attempt_at, last_error FROM bridge_outbound
         WHERE status = 'pending' AND next_attempt_at <= ?
           AND rowid > ?
           AND (
             json_extract(payload, '$.sessionKey') = ?
             OR (
               json_extract(payload, '$.route.spaceId') = ?
               AND json_extract(payload, '$.route.chatId') = ?
               AND COALESCE(json_extract(payload, '$.route.discussionRootId'), '') = ?
             )
           )
         ORDER BY rowid ASC LIMIT ?`,
      )
      .all(
        now,
        afterSequence,
        filter.sessionKey,
        filter.route.spaceId,
        filter.route.chatId,
        filter.route.discussionRootId ?? "",
        limit,
      ) as Row[];
    return rows.map((row) => ({
      ...BridgeDeliverySchema.parse(JSON.parse(String(row.payload))),
      storeSequence: Number(row.store_sequence),
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    }));
  }

  pruneDelivered(before: number): number {
    return Number(
      this.#db.prepare("DELETE FROM bridge_outbound WHERE status = 'delivered' AND updated_at < ?").run(before)
        .changes,
    );
  }

  pruneExpiredPending(before: number): number {
    return Number(this.#db.prepare("DELETE FROM bridge_outbound WHERE status = 'pending' AND created_at < ?").run(before).changes);
  }

  acknowledgeDelivery(id: string, now = Date.now()): void {
    this.#db
      .prepare("UPDATE bridge_outbound SET status = 'delivered', updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  acknowledgeDeliveries(ids: string[], now = Date.now()): void {
    if (ids.length === 0) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#db.prepare("UPDATE bridge_outbound SET status = 'delivered', updated_at = ? WHERE id = ?");
      for (const id of ids) update.run(now, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  retryDelivery(id: string, error: string, now = Date.now()): void {
    const row = this.#db
      .prepare("SELECT attempts FROM bridge_outbound WHERE id = ?")
      .get(id) as Row | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const delay = Math.min(60_000, 500 * 2 ** Math.min(attempts - 1, 7));
    this.#db
      .prepare(
        `UPDATE bridge_outbound SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, now + delay, error.slice(0, 2_000), now, id);
  }
}
