import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
export class Store {
    db;
    constructor(path) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cursors (route_id TEXT PRIMARY KEY, newest_order_id TEXT, initialized_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handled_messages (route_id TEXT NOT NULL, message_id TEXT NOT NULL, handled_at INTEGER NOT NULL, PRIMARY KEY (route_id, message_id));
      CREATE TABLE IF NOT EXISTS handled_message_versions (route_id TEXT NOT NULL, message_id TEXT NOT NULL, modified_at INTEGER NOT NULL, fingerprint TEXT, PRIMARY KEY (route_id, message_id));
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, thread_key TEXT NOT NULL, trigger_message_id TEXT NOT NULL, response_message_id TEXT NOT NULL, status TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(route_id, thread_key, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_response ON runs(response_message_id);
      CREATE TABLE IF NOT EXISTS run_messages (run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, message_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, message_id));
      CREATE INDEX IF NOT EXISTS idx_run_messages_message ON run_messages(message_id);
      CREATE TABLE IF NOT EXISTS discussions (space_id TEXT NOT NULL, object_id TEXT NOT NULL, discussion_id TEXT NOT NULL, object_name TEXT, object_type TEXT, discovered_at INTEGER NOT NULL, PRIMARY KEY (space_id, object_id));
      CREATE TABLE IF NOT EXISTS codex_acp_sessions (session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_generations (thread_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
        const versionColumns = this.db.prepare("PRAGMA table_info(handled_message_versions)").all();
        if (!versionColumns.some(column => column.name === "fingerprint")) {
            this.db.exec("ALTER TABLE handled_message_versions ADD COLUMN fingerprint TEXT");
        }
    }
    isInitialized(routeId) { return Boolean(this.db.prepare("SELECT 1 FROM cursors WHERE route_id = ?").get(routeId)); }
    initialize(routeId, newestOrderId) { this.db.prepare("INSERT OR IGNORE INTO cursors(route_id,newest_order_id,initialized_at) VALUES(?,?,?)").run(routeId, newestOrderId ?? null, Date.now()); }
    cursor(routeId) { return this.db.prepare("SELECT newest_order_id FROM cursors WHERE route_id=?").get(routeId)?.newest_order_id ?? undefined; }
    updateCursor(routeId, newestOrderId) { this.db.prepare("UPDATE cursors SET newest_order_id=? WHERE route_id=?").run(newestOrderId, routeId); }
    isHandled(routeId, messageId, modifiedAt, fingerprint) {
        if (!this.db.prepare("SELECT 1 FROM handled_messages WHERE route_id=? AND message_id=?").get(routeId, messageId))
            return false;
        if (modifiedAt === undefined)
            return true;
        const version = this.db.prepare("SELECT modified_at,fingerprint FROM handled_message_versions WHERE route_id=? AND message_id=?").get(routeId, messageId);
        if (!version)
            return true;
        if (modifiedAt < version.modified_at)
            return true;
        if (fingerprint !== undefined && version.fingerprint !== null)
            return version.fingerprint === fingerprint;
        return version.modified_at >= modifiedAt;
    }
    markHandled(routeId, messageId, modifiedAt, fingerprint) {
        this.db.prepare("INSERT INTO handled_messages(route_id,message_id,handled_at) VALUES(?,?,?) ON CONFLICT(route_id,message_id) DO UPDATE SET handled_at=excluded.handled_at").run(routeId, messageId, Date.now());
        if (modifiedAt !== undefined)
            this.db.prepare("INSERT INTO handled_message_versions(route_id,message_id,modified_at,fingerprint) VALUES(?,?,?,?) ON CONFLICT(route_id,message_id) DO UPDATE SET modified_at=MAX(modified_at,excluded.modified_at), fingerprint=excluded.fingerprint").run(routeId, messageId, modifiedAt, fingerprint ?? null);
    }
    unmarkHandled(routeId, messageId) { this.db.prepare("DELETE FROM handled_messages WHERE route_id=? AND message_id=?").run(routeId, messageId); }
    createRun(run) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("INSERT INTO runs(run_id,route_id,thread_key,trigger_message_id,response_message_id,status,hop,started_at) VALUES(?,?,?,?,?,'running',?,?)").run(run.id, run.routeId, run.threadKey, run.triggerId, run.responseId, run.hop, Date.now());
            const moved = this.db.prepare("UPDATE run_messages SET run_id=?, created_at=? WHERE message_id=?").run(run.id, Date.now(), run.responseId);
            if (moved.changes === 0)
                this.db.prepare("INSERT INTO run_messages(run_id,message_id,created_at) VALUES(?,?,?)").run(run.id, run.responseId, Date.now());
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    updateRunResponse(id, responseId, triggerId) {
        if (triggerId)
            this.db.prepare("UPDATE runs SET response_message_id=?,trigger_message_id=? WHERE run_id=?").run(responseId, triggerId, id);
        else
            this.db.prepare("UPDATE runs SET response_message_id=? WHERE run_id=?").run(responseId, id);
        this.db.prepare("INSERT OR IGNORE INTO run_messages(run_id,message_id,created_at) VALUES(?,?,?)").run(id, responseId, Date.now());
    }
    isResponse(messageId) { return Boolean(this.db.prepare("SELECT 1 FROM run_messages WHERE message_id=?").get(messageId) ?? this.db.prepare("SELECT 1 FROM runs WHERE response_message_id=?").get(messageId)); }
    runningRuns(routeId) {
        return this.db.prepare("SELECT run_id,trigger_message_id,response_message_id FROM runs WHERE route_id=? AND status='running'").all(routeId).map(row => ({ id: row.run_id, triggerId: row.trigger_message_id, responseId: row.response_message_id }));
    }
    finishRun(id, status) { this.db.prepare("UPDATE runs SET status=?, finished_at=? WHERE run_id=?").run(status, Date.now(), id); }
    recentActivations(routeId, threadKey, since) { const row = this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE route_id=? AND thread_key=? AND started_at>=?").get(routeId, threadKey, since); return Number(row.count); }
    prune(before) {
        this.db.prepare("DELETE FROM handled_messages WHERE handled_at < ?").run(before);
        this.db.prepare("DELETE FROM handled_message_versions WHERE NOT EXISTS (SELECT 1 FROM handled_messages h WHERE h.route_id=handled_message_versions.route_id AND h.message_id=handled_message_versions.message_id)").run();
        this.db.prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(before);
    }
    cacheDiscussion(value) { this.db.prepare("INSERT INTO discussions(space_id,object_id,discussion_id,object_name,object_type,discovered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,object_id) DO UPDATE SET discussion_id=excluded.discussion_id, object_name=excluded.object_name, object_type=excluded.object_type, discovered_at=excluded.discovered_at").run(value.spaceId, value.objectId, value.discussionId, value.objectName ?? null, value.objectType ?? null, Date.now()); }
    knownDiscussionObjectIds(spaceId) { return new Set(this.db.prepare("SELECT object_id FROM discussions WHERE space_id=?").all(spaceId).map(row => row.object_id)); }
    listDiscussions(spaceId) { return this.db.prepare("SELECT object_id,discussion_id,object_name,object_type FROM discussions WHERE space_id=?").all(spaceId).map(row => ({ objectId: row.object_id, discussionId: row.discussion_id, ...(row.object_name ? { objectName: row.object_name } : {}), ...(row.object_type ? { objectType: row.object_type } : {}) })); }
    codexAcpSession(sessionKey) { return this.db.prepare("SELECT session_id FROM codex_acp_sessions WHERE session_key=?").get(sessionKey)?.session_id; }
    saveCodexAcpSession(sessionKey, sessionId) { this.db.prepare("INSERT INTO codex_acp_sessions(session_key,session_id,updated_at) VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at").run(sessionKey, sessionId, Date.now()); }
    deleteCodexAcpSession(sessionKey) { this.db.prepare("DELETE FROM codex_acp_sessions WHERE session_key=?").run(sessionKey); }
    sessionGeneration(threadKey) { return Number(this.db.prepare("SELECT generation FROM session_generations WHERE thread_key=?").get(threadKey)?.generation ?? 0); }
    resetSession(threadKey) {
        this.db.prepare("INSERT INTO session_generations(thread_key,generation,updated_at) VALUES(?,1,?) ON CONFLICT(thread_key) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at").run(threadKey, Date.now());
        return this.sessionGeneration(threadKey);
    }
    close() { this.db.close(); }
}
