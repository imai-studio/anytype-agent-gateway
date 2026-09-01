import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { connectorPublicationControlRequestSchema, publicationMutationSchema, } from "./cloud-contract.js";
const operationStateSchema = z.enum(["queued", "in-flight", "retrying", "succeeded", "failed"]);
const assetManifestRetentionMs = 7 * 24 * 60 * 60 * 1_000;
export const publicationAssetSchema = z
    .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    path: z.string().min(1),
    fileName: z.string().trim().min(1).max(500),
    contentType: z.string().trim().min(3).max(200),
    byteSize: z
        .number()
        .int()
        .positive()
        .max(100 * 1024 * 1024),
})
    .strict();
const storedRequestSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: z.literal("push"),
        mutation: publicationMutationSchema,
        assets: z.array(publicationAssetSchema).max(100).default([]),
    })
        .strict(),
    z
        .object({ kind: z.literal("control"), request: connectorPublicationControlRequestSchema })
        .strict(),
]);
export class CloudPublicationOutbox {
    db;
    constructor(path) {
        const existed = path !== ":memory:" && existsSync(path);
        if (existed) {
            const info = lstatSync(path);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error("Cloud publication outbox must be a regular file, not a symbolic link");
            if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
                throw new Error("Cloud publication outbox must not be accessible to group or other users");
        }
        if (path !== ":memory:") {
            const directory = dirname(path);
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const directoryInfo = lstatSync(directory);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
                throw new Error("Cloud publication outbox directory must be a real directory");
            if (process.platform !== "win32")
                chmodSync(directory, 0o700);
        }
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS publication_operations (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        publication_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('push','control')),
        request_json TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','in-flight','retrying','succeeded','failed')),
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        result_json TEXT,
        last_error_code TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS publication_operations_ready
        ON publication_operations(state,available_at,created_at);
      CREATE TABLE IF NOT EXISTS publication_asset_manifests (
        manifest_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_asset_checkpoints (
        operation_id TEXT NOT NULL REFERENCES publication_operations(operation_id) ON DELETE CASCADE,
        digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','requested','uploaded','committed')),
        asset_id TEXT,
        upload_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(operation_id,digest)
      );
    `);
        const now = Date.now();
        this.db
            .prepare(`UPDATE publication_operations
           SET state='retrying',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=?
         WHERE state='in-flight' AND lease_expires_at<=?`)
            .run(now, now, now);
        if (path !== ":memory:" && (!existed || process.platform !== "win32"))
            chmodSync(path, 0o600);
    }
    enqueue(input) {
        const request = storedRequestSchema.parse(input.request);
        const now = input.now ?? Date.now();
        const publicationId = request.kind === "push"
            ? request.mutation.publicationId
            : request.request.operation.publicationId;
        const operationId = randomUUID();
        this.db
            .prepare(`INSERT INTO publication_operations(
           operation_id,idempotency_key,publication_id,kind,request_json,request_sha256,
           state,attempt,available_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,'queued',0,?,?,?)
         ON CONFLICT(idempotency_key) DO NOTHING`)
            .run(operationId, input.idempotencyKey, publicationId, request.kind, JSON.stringify(request), input.requestSha256, now, now, now);
        const row = this.rowByIdempotencyKey(input.idempotencyKey);
        if (!row)
            throw new Error("Publication outbox did not persist the operation");
        if (row.request_sha256 !== input.requestSha256)
            throw new Error("The idempotency key is already bound to a different publication request");
        if (request.kind === "push" && row.state !== "in-flight" && row.state !== "succeeded")
            this.db
                .prepare(`UPDATE publication_operations
             SET request_json=?,state='queued',available_at=?,last_error_code=NULL,last_error=NULL,
                 lease_owner=NULL,lease_expires_at=NULL,updated_at=?
           WHERE operation_id=? AND state<>'in-flight' AND state<>'succeeded'`)
                .run(JSON.stringify(request), now, now, row.operation_id);
        if (request.kind === "push")
            for (const asset of request.assets)
                this.db
                    .prepare(`INSERT INTO publication_asset_checkpoints(operation_id,digest,state,updated_at)
             VALUES(?,?,'pending',?) ON CONFLICT(operation_id,digest) DO NOTHING`)
                    .run(row.operation_id, asset.digest, now);
        const refreshed = this.rowByIdempotencyKey(input.idempotencyKey);
        if (!refreshed)
            throw new Error("Publication outbox lost the persisted operation");
        return mapOperation(refreshed);
    }
    saveAssetManifest(assets, now = Date.now()) {
        const parsed = z.array(publicationAssetSchema).min(1).max(100).parse(assets);
        this.pruneAssetManifests(now - assetManifestRetentionMs);
        const manifestId = randomUUID();
        this.db
            .prepare("INSERT INTO publication_asset_manifests(manifest_id,manifest_json,created_at) VALUES(?,?,?)")
            .run(manifestId, JSON.stringify(parsed), now);
        return manifestId;
    }
    assetManifest(manifestId) {
        const row = this.db
            .prepare("SELECT manifest_json FROM publication_asset_manifests WHERE manifest_id=?")
            .get(manifestId);
        return row
            ? z.array(publicationAssetSchema).min(1).max(100).parse(JSON.parse(row.manifest_json))
            : undefined;
    }
    deleteAssetManifest(manifestId) {
        this.db.prepare("DELETE FROM publication_asset_manifests WHERE manifest_id=?").run(manifestId);
    }
    pruneAssetManifests(createdBefore) {
        return Number(this.db
            .prepare("DELETE FROM publication_asset_manifests WHERE created_at<?")
            .run(createdBefore).changes);
    }
    assetCheckpoint(operationId, digest) {
        const row = this.db
            .prepare(`SELECT state,asset_id,upload_id FROM publication_asset_checkpoints
         WHERE operation_id=? AND digest=?`)
            .get(operationId, digest);
        if (!row)
            throw new Error("Publication asset checkpoint is missing");
        return {
            state: row.state,
            ...(row.asset_id ? { assetId: row.asset_id } : {}),
            ...(row.upload_id ? { uploadId: row.upload_id } : {}),
        };
    }
    checkpointAsset(operationId, digest, state, ids, now = Date.now()) {
        const changed = this.db
            .prepare(`UPDATE publication_asset_checkpoints
         SET state=?,asset_id=?,upload_id=?,updated_at=? WHERE operation_id=? AND digest=?`)
            .run(state, ids.assetId, ids.uploadId, now, operationId, digest).changes;
        if (changed !== 1)
            throw new Error("Publication asset checkpoint is missing");
    }
    operation(operationId) {
        const row = this.db
            .prepare("SELECT * FROM publication_operations WHERE operation_id=?")
            .get(operationId);
        return row ? mapOperation(row) : undefined;
    }
    request(operationId) {
        const row = this.db
            .prepare("SELECT request_json FROM publication_operations WHERE operation_id=?")
            .get(operationId);
        return row ? storedRequestSchema.parse(JSON.parse(row.request_json)) : undefined;
    }
    claim(operationId, workerId, now = Date.now(), leaseMs = 60_000) {
        return (this.db
            .prepare(`UPDATE publication_operations
             SET state='in-flight',attempt=attempt+1,lease_owner=?,lease_expires_at=?,updated_at=?
           WHERE operation_id=? AND state IN ('queued','retrying') AND available_at<=?`)
            .run(workerId, now + leaseMs, now, operationId, now).changes === 1);
    }
    retryNow(operationId, now = Date.now()) {
        this.db
            .prepare(`UPDATE publication_operations SET available_at=?,updated_at=?
         WHERE operation_id=? AND state='retrying'`)
            .run(now, now, operationId);
    }
    succeed(operationId, workerId, result, now = Date.now()) {
        const changed = this.db
            .prepare(`UPDATE publication_operations
           SET state='succeeded',result_json=?,last_error_code=NULL,last_error=NULL,
               lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE operation_id=? AND state='in-flight' AND lease_owner=?`)
            .run(JSON.stringify(result), now, operationId, workerId).changes;
        if (changed !== 1)
            throw new Error("Publication operation lease was lost before completion");
    }
    fail(operationId, workerId, input, now = Date.now()) {
        const state = input.retryable ? "retrying" : "failed";
        const delay = input.retryAfterMs ?? 1_000;
        const changed = this.db
            .prepare(`UPDATE publication_operations
           SET state=?,available_at=?,last_error_code=?,last_error=?,
               lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE operation_id=? AND state='in-flight' AND lease_owner=?`)
            .run(state, input.retryable ? now + delay : now, input.code.slice(0, 200), input.message.slice(0, 2_000), now, operationId, workerId).changes;
        if (changed !== 1)
            throw new Error("Publication operation lease was lost before failure recording");
    }
    close() {
        this.db.close();
    }
    rowByIdempotencyKey(key) {
        return this.db
            .prepare("SELECT * FROM publication_operations WHERE idempotency_key=?")
            .get(key);
    }
}
function mapOperation(row) {
    return {
        operationId: row.operation_id,
        idempotencyKey: row.idempotency_key,
        publicationId: row.publication_id,
        kind: row.kind,
        state: operationStateSchema.parse(row.state),
        attempt: row.attempt,
        availableAt: row.available_at,
        ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
        ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export function publicationRequest(request) {
    return request.kind === "push" ? request.mutation : request.request;
}
