import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
const SCHEMA_VERSION = 6;
export class Store {
    db;
    constructor(path) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        this.migrate();
    }
    schemaVersion() {
        return Number(this.db.prepare("PRAGMA user_version").get().user_version);
    }
    migrate() {
        const current = this.schemaVersion();
        if (current > SCHEMA_VERSION) {
            throw new Error(`State database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (current < 1)
                this.migrateToVersion1();
            if (current < 2)
                this.migrateToVersion2();
            if (current < 3)
                this.migrateToVersion3();
            if (current < 4)
                this.migrateToVersion4();
            if (current < 5)
                this.migrateToVersion5();
            if (current < 6)
                this.migrateToVersion6();
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    migrateToVersion1() {
        this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS route_wake_overrides (route_id TEXT PRIMARY KEY, humans TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
        const versionColumns = this.db
            .prepare("PRAGMA table_info(handled_message_versions)")
            .all();
        if (!versionColumns.some((column) => column.name === "fingerprint")) {
            this.db.exec("ALTER TABLE handled_message_versions ADD COLUMN fingerprint TEXT");
        }
    }
    migrateToVersion2() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        thread_key TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        discussion_root_id TEXT,
        runtime TEXT NOT NULL CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
        native_session_key TEXT NOT NULL,
        native_session_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
        event_cursor TEXT,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','detached','resetting')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime, native_session_key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_bindings_route ON session_bindings(route_id, thread_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_bindings_native_id ON session_bindings(runtime, native_session_id) WHERE native_session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS runtime_capabilities (
        runtime TEXT PRIMARY KEY CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
        capabilities_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS output_cycles (
        cycle_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL REFERENCES session_bindings(thread_key) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        anytype_message_id TEXT NOT NULL UNIQUE,
        reply_to_message_id TEXT,
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','complete','failed','deleted')),
        phase TEXT NOT NULL DEFAULT 'working' CHECK(phase IN ('working','thinking','answer','error')),
        thinking_text TEXT NOT NULL DEFAULT '',
        answer_text TEXT NOT NULL DEFAULT '',
        event_cursor TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(thread_key, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_output_cycles_open ON output_cycles(thread_key) WHERE state='open';
      CREATE INDEX IF NOT EXISTS idx_output_cycles_thread ON output_cycles(thread_key, sequence);

      CREATE TABLE IF NOT EXISTS outbound_outbox (
        item_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        route_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        discussion_root_id TEXT,
        operation TEXT NOT NULL CHECK(operation IN ('create','edit','delete','react-add','react-remove')),
        target_message_id TEXT,
        reply_to_message_id TEXT,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','delivered','failed','dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        available_at INTEGER NOT NULL,
        claimed_at INTEGER,
        claimed_by TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_ready ON outbound_outbox(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_thread ON outbound_outbox(thread_key, created_at);

      CREATE TABLE IF NOT EXISTS proactive_deliveries (
        runtime TEXT NOT NULL CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
        native_session_key TEXT NOT NULL,
        native_event_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        payload_hash TEXT,
        message_id TEXT,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY(runtime, native_session_key, native_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_thread ON proactive_deliveries(thread_key, delivered_at);

      CREATE TABLE IF NOT EXISTS bridge_cursors (
        bridge_id TEXT NOT NULL,
        stream_key TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(bridge_id, stream_key)
      );
    `);
    }
    migrateToVersion3() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_workspaces (
        thread_key TEXT PRIMARY KEY REFERENCES session_bindings(thread_key) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    }
    migrateToVersion4() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_models (
        thread_key TEXT PRIMARY KEY,
        runtime TEXT NOT NULL CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
        requested_model_id TEXT,
        use_default INTEGER NOT NULL DEFAULT 0 CHECK(use_default IN (0,1)),
        applied_model_id TEXT,
        default_model_id TEXT,
        catalog_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_messages (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    }
    migrateToVersion5() {
        const columns = this.db.prepare("PRAGMA table_info(conversation_models)").all();
        if (!columns.some((column) => column.name === "applied_generation"))
            this.db.exec("ALTER TABLE conversation_models ADD COLUMN applied_generation INTEGER");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS control_activations (
        route_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_control_activations_window
        ON control_activations(route_id,thread_key,created_at);
    `);
    }
    migrateToVersion6() {
        const workspaceTableExists = Boolean(this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_workspaces'")
            .get());
        if (!workspaceTableExists) {
            this.db.exec(`
        CREATE TABLE session_workspaces (
          thread_key TEXT PRIMARY KEY REFERENCES session_bindings(thread_key) ON DELETE CASCADE,
          workspace_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
        }
        this.db.exec(`
      CREATE TABLE session_workspace_overrides (
        thread_key TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    }
    isInitialized(routeId) {
        return Boolean(this.db.prepare("SELECT 1 FROM cursors WHERE route_id = ?").get(routeId));
    }
    initialize(routeId, newestOrderId) {
        this.db
            .prepare("INSERT OR IGNORE INTO cursors(route_id,newest_order_id,initialized_at) VALUES(?,?,?)")
            .run(routeId, newestOrderId ?? null, Date.now());
    }
    cursor(routeId) {
        return (this.db.prepare("SELECT newest_order_id FROM cursors WHERE route_id=?").get(routeId)?.newest_order_id ?? undefined);
    }
    updateCursor(routeId, newestOrderId) {
        this.db
            .prepare("UPDATE cursors SET newest_order_id=? WHERE route_id=?")
            .run(newestOrderId, routeId);
    }
    isHandled(routeId, messageId, modifiedAt, fingerprint) {
        if (!this.db
            .prepare("SELECT 1 FROM handled_messages WHERE route_id=? AND message_id=?")
            .get(routeId, messageId))
            return false;
        if (modifiedAt === undefined)
            return true;
        const version = this.db
            .prepare("SELECT modified_at,fingerprint FROM handled_message_versions WHERE route_id=? AND message_id=?")
            .get(routeId, messageId);
        if (!version)
            return true;
        if (modifiedAt < version.modified_at)
            return true;
        if (fingerprint !== undefined && version.fingerprint !== null)
            return version.fingerprint === fingerprint;
        return version.modified_at >= modifiedAt;
    }
    markHandled(routeId, messageId, modifiedAt, fingerprint) {
        this.db
            .prepare("INSERT INTO handled_messages(route_id,message_id,handled_at) VALUES(?,?,?) ON CONFLICT(route_id,message_id) DO UPDATE SET handled_at=excluded.handled_at")
            .run(routeId, messageId, Date.now());
        if (modifiedAt !== undefined)
            this.db
                .prepare("INSERT INTO handled_message_versions(route_id,message_id,modified_at,fingerprint) VALUES(?,?,?,?) ON CONFLICT(route_id,message_id) DO UPDATE SET modified_at=MAX(modified_at,excluded.modified_at), fingerprint=excluded.fingerprint")
                .run(routeId, messageId, modifiedAt, fingerprint ?? null);
    }
    unmarkHandled(routeId, messageId) {
        this.db
            .prepare("DELETE FROM handled_messages WHERE route_id=? AND message_id=?")
            .run(routeId, messageId);
    }
    createRun(run) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare("INSERT INTO runs(run_id,route_id,thread_key,trigger_message_id,response_message_id,status,hop,started_at) VALUES(?,?,?,?,?,'running',?,?)")
                .run(run.id, run.routeId, run.threadKey, run.triggerId, run.responseId, run.hop, Date.now());
            const moved = this.db
                .prepare("UPDATE run_messages SET run_id=?, created_at=? WHERE message_id=?")
                .run(run.id, Date.now(), run.responseId);
            if (moved.changes === 0)
                this.db
                    .prepare("INSERT INTO run_messages(run_id,message_id,created_at) VALUES(?,?,?)")
                    .run(run.id, run.responseId, Date.now());
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    updateRunResponse(id, responseId, triggerId) {
        if (triggerId)
            this.db
                .prepare("UPDATE runs SET response_message_id=?,trigger_message_id=? WHERE run_id=?")
                .run(responseId, triggerId, id);
        else
            this.db.prepare("UPDATE runs SET response_message_id=? WHERE run_id=?").run(responseId, id);
        this.db
            .prepare("INSERT OR IGNORE INTO run_messages(run_id,message_id,created_at) VALUES(?,?,?)")
            .run(id, responseId, Date.now());
    }
    isResponse(messageId) {
        return Boolean(this.db.prepare("SELECT 1 FROM run_messages WHERE message_id=?").get(messageId) ??
            this.db.prepare("SELECT 1 FROM runs WHERE response_message_id=?").get(messageId) ??
            this.db.prepare("SELECT 1 FROM proactive_deliveries WHERE message_id=?").get(messageId) ??
            this.db.prepare("SELECT 1 FROM control_messages WHERE message_id=?").get(messageId));
    }
    markControlMessage(messageId, now = Date.now()) {
        this.db
            .prepare("INSERT OR IGNORE INTO control_messages(message_id,created_at) VALUES(?,?)")
            .run(messageId, now);
    }
    runningRuns(routeId) {
        return this.db
            .prepare("SELECT run_id,thread_key,trigger_message_id,response_message_id,started_at FROM runs WHERE route_id=? AND status='running'")
            .all(routeId).map((row) => ({
            id: row.run_id,
            threadKey: row.thread_key,
            triggerId: row.trigger_message_id,
            responseId: row.response_message_id,
            startedAt: row.started_at,
        }));
    }
    runningRunForThread(threadKey) {
        const row = this.db
            .prepare("SELECT run_id,route_id,trigger_message_id,response_message_id FROM runs WHERE thread_key=? AND status='running' ORDER BY started_at DESC LIMIT 1")
            .get(threadKey);
        return row
            ? {
                id: row.run_id,
                routeId: row.route_id,
                triggerId: row.trigger_message_id,
                responseId: row.response_message_id,
            }
            : undefined;
    }
    finishRun(id, status) {
        this.db
            .prepare("UPDATE runs SET status=?, finished_at=? WHERE run_id=?")
            .run(status, Date.now(), id);
    }
    recentActivations(routeId, threadKey, since) {
        const row = this.db
            .prepare("SELECT COUNT(*) AS count FROM runs WHERE route_id=? AND thread_key=? AND started_at>=?")
            .get(routeId, threadKey, since);
        return Number(row.count);
    }
    recordControlActivation(routeId, threadKey, now = Date.now()) {
        this.db
            .prepare("INSERT INTO control_activations(route_id,thread_key,created_at) VALUES(?,?,?)")
            .run(routeId, threadKey, now);
    }
    recentControlActivations(routeId, threadKey, since) {
        const row = this.db
            .prepare("SELECT COUNT(*) AS count FROM control_activations WHERE route_id=? AND thread_key=? AND created_at>=?")
            .get(routeId, threadKey, since);
        return Number(row.count);
    }
    prune(before) {
        this.db.prepare("DELETE FROM handled_messages WHERE handled_at < ?").run(before);
        this.db
            .prepare("DELETE FROM handled_message_versions WHERE NOT EXISTS (SELECT 1 FROM handled_messages h WHERE h.route_id=handled_message_versions.route_id AND h.message_id=handled_message_versions.message_id)")
            .run();
        this.db
            .prepare("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?")
            .run(before);
        this.db
            .prepare("DELETE FROM output_cycles WHERE state <> 'open' AND completed_at IS NOT NULL AND completed_at < ?")
            .run(before);
        this.db
            .prepare("DELETE FROM outbound_outbox WHERE status='delivered' AND delivered_at IS NOT NULL AND delivered_at < ?")
            .run(before);
        this.db.prepare("DELETE FROM proactive_deliveries WHERE delivered_at < ?").run(before);
        this.db.prepare("DELETE FROM bridge_cursors WHERE updated_at < ?").run(before);
        this.db.prepare("DELETE FROM control_messages WHERE created_at < ?").run(before);
        this.db.prepare("DELETE FROM control_activations WHERE created_at < ?").run(before);
        this.db
            .prepare("DELETE FROM session_bindings WHERE state <> 'active' AND updated_at < ?")
            .run(before);
        this.db
            .prepare("DELETE FROM session_workspace_overrides WHERE updated_at < ? AND thread_key NOT IN (SELECT thread_key FROM session_bindings)")
            .run(before);
    }
    cacheDiscussion(value) {
        this.db
            .prepare("INSERT INTO discussions(space_id,object_id,discussion_id,object_name,object_type,discovered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,object_id) DO UPDATE SET discussion_id=excluded.discussion_id, object_name=excluded.object_name, object_type=excluded.object_type, discovered_at=excluded.discovered_at")
            .run(value.spaceId, value.objectId, value.discussionId, value.objectName ?? null, value.objectType ?? null, Date.now());
    }
    knownDiscussionObjectIds(spaceId) {
        return new Set(this.db
            .prepare("SELECT object_id FROM discussions WHERE space_id=?")
            .all(spaceId).map((row) => row.object_id));
    }
    listDiscussions(spaceId) {
        return this.db
            .prepare("SELECT object_id,discussion_id,object_name,object_type FROM discussions WHERE space_id=?")
            .all(spaceId).map((row) => ({
            objectId: row.object_id,
            discussionId: row.discussion_id,
            ...(row.object_name ? { objectName: row.object_name } : {}),
            ...(row.object_type ? { objectType: row.object_type } : {}),
        }));
    }
    codexAcpSession(sessionKey) {
        return this.db
            .prepare("SELECT session_id FROM codex_acp_sessions WHERE session_key=?")
            .get(sessionKey)?.session_id;
    }
    saveCodexAcpSession(sessionKey, sessionId) {
        this.db
            .prepare("INSERT INTO codex_acp_sessions(session_key,session_id,updated_at) VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at")
            .run(sessionKey, sessionId, Date.now());
    }
    deleteCodexAcpSession(sessionKey) {
        this.db.prepare("DELETE FROM codex_acp_sessions WHERE session_key=?").run(sessionKey);
    }
    sessionGeneration(threadKey) {
        return Number(this.db
            .prepare("SELECT generation FROM session_generations WHERE thread_key=?")
            .get(threadKey)?.generation ?? 0);
    }
    resetSession(threadKey) {
        this.db
            .prepare("INSERT INTO session_generations(thread_key,generation,updated_at) VALUES(?,1,?) ON CONFLICT(thread_key) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at")
            .run(threadKey, Date.now());
        return this.sessionGeneration(threadKey);
    }
    wakeOverride(routeId) {
        const stored = this.db.prepare("SELECT humans FROM route_wake_overrides WHERE route_id=?").get(routeId)?.humans;
        if (!stored)
            return undefined;
        try {
            const parsed = JSON.parse(stored);
            if (typeof parsed.humans !== "string")
                return undefined;
            return {
                humans: parsed.humans,
                ...(typeof parsed.prefix === "string" && parsed.prefix ? { prefix: parsed.prefix } : {}),
                ...(Array.isArray(parsed.allowedUsers) &&
                    parsed.allowedUsers.every((participant) => typeof participant === "string")
                    ? { allowedUsers: parsed.allowedUsers }
                    : {}),
            };
        }
        catch {
            return { humans: stored };
        }
    }
    setWakeOverride(routeId, humans, prefix, allowedUsers) {
        const value = JSON.stringify({
            humans,
            ...(prefix ? { prefix } : {}),
            ...(allowedUsers ? { allowedUsers } : {}),
        });
        this.db
            .prepare("INSERT INTO route_wake_overrides(route_id,humans,updated_at) VALUES(?,?,?) ON CONFLICT(route_id) DO UPDATE SET humans=excluded.humans,updated_at=excluded.updated_at")
            .run(routeId, value, Date.now());
    }
    sessionBinding(threadKey) {
        return mapSessionBinding(this.db.prepare("SELECT * FROM session_bindings WHERE thread_key=?").get(threadKey));
    }
    bindingForNativeSession(runtime, nativeSession) {
        if (nativeSession.id) {
            const byId = mapSessionBinding(this.db
                .prepare("SELECT * FROM session_bindings WHERE runtime=? AND native_session_id=?")
                .get(runtime, nativeSession.id));
            if (byId)
                return byId;
        }
        if (!nativeSession.key)
            return undefined;
        return mapSessionBinding(this.db
            .prepare("SELECT * FROM session_bindings WHERE runtime=? AND native_session_key=?")
            .get(runtime, nativeSession.key));
    }
    listSessionBindings(state) {
        const rows = state
            ? this.db
                .prepare("SELECT * FROM session_bindings WHERE state=? ORDER BY created_at,thread_key")
                .all(state)
            : this.db.prepare("SELECT * FROM session_bindings ORDER BY created_at,thread_key").all();
        return rows.map((row) => mapSessionBinding(row));
    }
    saveSessionBinding(binding, now = Date.now()) {
        this.db
            .prepare(`
      INSERT INTO session_bindings(
        thread_key,route_id,space_id,chat_id,discussion_root_id,runtime,native_session_key,
        native_session_id,generation,event_cursor,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_key) DO UPDATE SET
        route_id=excluded.route_id,
        space_id=excluded.space_id,
        chat_id=excluded.chat_id,
        discussion_root_id=excluded.discussion_root_id,
        runtime=excluded.runtime,
        native_session_key=excluded.native_session_key,
        native_session_id=excluded.native_session_id,
        generation=excluded.generation,
        event_cursor=excluded.event_cursor,
        state=excluded.state,
        updated_at=excluded.updated_at
    `)
            .run(binding.threadKey, binding.routeId, binding.spaceId, binding.chatId, binding.discussionRootId ?? null, binding.runtime, binding.nativeSessionKey, binding.nativeSessionId ?? null, binding.generation, binding.eventCursor ?? null, binding.state, now, now);
        return this.sessionBinding(binding.threadKey);
    }
    updateSessionBinding(threadKey, patch, now = Date.now()) {
        const current = this.sessionBinding(threadKey);
        if (!current)
            return undefined;
        const nativeSessionId = patch.nativeSessionId === undefined
            ? current.nativeSessionId
            : (patch.nativeSessionId ?? undefined);
        const eventCursor = patch.eventCursor === undefined ? current.eventCursor : (patch.eventCursor ?? undefined);
        return this.saveSessionBinding({
            threadKey: current.threadKey,
            routeId: current.routeId,
            spaceId: current.spaceId,
            chatId: current.chatId,
            ...(current.discussionRootId ? { discussionRootId: current.discussionRootId } : {}),
            runtime: current.runtime,
            nativeSessionKey: patch.nativeSessionKey ?? current.nativeSessionKey,
            ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
            generation: patch.generation ?? current.generation,
            ...(eventCursor === undefined ? {} : { eventCursor }),
            state: patch.state ?? current.state,
        }, now);
    }
    deleteSessionBinding(threadKey) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("DELETE FROM session_workspace_overrides WHERE thread_key=?").run(threadKey);
            const deleted = this.db.prepare("DELETE FROM session_bindings WHERE thread_key=?").run(threadKey).changes >
                0;
            this.db.exec("COMMIT");
            return deleted;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    sessionWorkspace(threadKey) {
        return this.db
            .prepare(`SELECT workspace_path FROM session_workspace_overrides WHERE thread_key=?
           UNION ALL
           SELECT workspace_path FROM session_workspaces WHERE thread_key=?
           LIMIT 1`)
            .get(threadKey, threadKey)?.workspace_path;
    }
    explicitSessionWorkspace(threadKey) {
        return this.db
            .prepare("SELECT workspace_path FROM session_workspaces WHERE thread_key=?")
            .get(threadKey)?.workspace_path;
    }
    sessionWorkspaceSource(threadKey) {
        if (this.db.prepare("SELECT 1 FROM session_workspace_overrides WHERE thread_key=?").get(threadKey))
            return "chat-tag";
        return this.explicitSessionWorkspace(threadKey) ? "explicit" : undefined;
    }
    saveSessionWorkspace(threadKey, workspacePath, now = Date.now(), source = "explicit") {
        const table = source === "chat-tag" ? "session_workspace_overrides" : "session_workspaces";
        this.db
            .prepare(`INSERT INTO ${table}(thread_key,workspace_path,updated_at) VALUES(?,?,?)
         ON CONFLICT(thread_key) DO UPDATE SET workspace_path=excluded.workspace_path,updated_at=excluded.updated_at`)
            .run(threadKey, workspacePath, now);
    }
    clearChatTagWorkspace(threadKey) {
        return (this.db.prepare("DELETE FROM session_workspace_overrides WHERE thread_key=?").run(threadKey)
            .changes > 0);
    }
    deleteSessionWorkspace(threadKey) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const overrides = this.db
                .prepare("DELETE FROM session_workspace_overrides WHERE thread_key=?")
                .run(threadKey).changes;
            const explicit = this.db
                .prepare("DELETE FROM session_workspaces WHERE thread_key=?")
                .run(threadKey).changes;
            this.db.exec("COMMIT");
            return Number(overrides) + Number(explicit) > 0;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    runtimeCapabilities(runtime) {
        const row = this.db
            .prepare("SELECT capabilities_json FROM runtime_capabilities WHERE runtime=?")
            .get(runtime);
        return row ? parseJson(row.capabilities_json) : undefined;
    }
    saveRuntimeCapabilities(runtime, capabilities, now = Date.now()) {
        this.db
            .prepare(`
      INSERT INTO runtime_capabilities(runtime,capabilities_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(runtime) DO UPDATE SET capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at
    `)
            .run(runtime, JSON.stringify(capabilities), now);
    }
    conversationModel(threadKey, runtime) {
        const row = this.db
            .prepare(runtime
            ? "SELECT * FROM conversation_models WHERE thread_key=? AND runtime=?"
            : "SELECT * FROM conversation_models WHERE thread_key=?")
            .get(...(runtime ? [threadKey, runtime] : [threadKey]));
        return row ? mapConversationModel(row) : undefined;
    }
    saveConversationModel(input, now = Date.now()) {
        this.db
            .prepare(`INSERT INTO conversation_models(
          thread_key,runtime,requested_model_id,use_default,applied_generation,applied_model_id,
          default_model_id,catalog_json,updated_by,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(thread_key) DO UPDATE SET
          runtime=excluded.runtime,
          requested_model_id=excluded.requested_model_id,
          use_default=excluded.use_default,
          applied_generation=excluded.applied_generation,
          applied_model_id=excluded.applied_model_id,
          default_model_id=excluded.default_model_id,
          catalog_json=excluded.catalog_json,
          updated_by=excluded.updated_by,
          updated_at=excluded.updated_at`)
            .run(input.threadKey, input.runtime, input.requestedModelId ?? null, input.useDefault ? 1 : 0, input.appliedGeneration ?? null, input.appliedModelId ?? null, input.defaultModelId ?? null, JSON.stringify(input.catalog), input.updatedBy ?? null, now);
        return this.conversationModel(input.threadKey);
    }
    createOutputCycle(input, now = Date.now()) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.db
                .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM output_cycles WHERE thread_key=?")
                .get(input.threadKey);
            this.db
                .prepare(`
        INSERT INTO output_cycles(
          cycle_id,thread_key,sequence,anytype_message_id,reply_to_message_id,state,phase,
          thinking_text,answer_text,event_cursor,created_at,updated_at
        ) VALUES(?,?,?,?,?,'open',?,'','',?,?,?)
      `)
                .run(input.id, input.threadKey, Number(row.sequence), input.anytypeMessageId, input.replyToMessageId ?? null, input.phase ?? "working", input.eventCursor ?? null, now, now);
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return this.outputCycle(input.id);
    }
    outputCycle(id) {
        return mapOutputCycle(this.db.prepare("SELECT * FROM output_cycles WHERE cycle_id=?").get(id));
    }
    outputCycleForMessage(messageId) {
        return mapOutputCycle(this.db.prepare("SELECT * FROM output_cycles WHERE anytype_message_id=?").get(messageId));
    }
    reopenOutputCycle(id, phase, now = Date.now()) {
        this.db
            .prepare("UPDATE output_cycles SET state='open',phase=?,completed_at=NULL,updated_at=? WHERE cycle_id=?")
            .run(phase, now, id);
        return this.outputCycle(id);
    }
    openOutputCycle(threadKey) {
        return mapOutputCycle(this.db
            .prepare("SELECT * FROM output_cycles WHERE thread_key=? AND state='open'")
            .get(threadKey));
    }
    listOutputCycles(threadKey) {
        return this.db
            .prepare("SELECT * FROM output_cycles WHERE thread_key=? ORDER BY sequence")
            .all(threadKey).map((row) => mapOutputCycle(row));
    }
    updateOutputCycle(id, patch, now = Date.now()) {
        const current = this.outputCycle(id);
        if (!current)
            return undefined;
        this.db
            .prepare(`
      UPDATE output_cycles SET
        phase=?,thinking_text=?,answer_text=?,event_cursor=?,reply_to_message_id=?,updated_at=?
      WHERE cycle_id=?
    `)
            .run(patch.phase ?? current.phase, patch.thinkingText ?? current.thinkingText, patch.answerText ?? current.answerText, patch.eventCursor === undefined ? (current.eventCursor ?? null) : patch.eventCursor, patch.replyToMessageId === undefined
            ? (current.replyToMessageId ?? null)
            : patch.replyToMessageId, now, id);
        return this.outputCycle(id);
    }
    finishOutputCycle(id, state, now = Date.now()) {
        const changed = this.db
            .prepare("UPDATE output_cycles SET state=?,completed_at=?,updated_at=? WHERE cycle_id=? AND state='open'")
            .run(state, now, now, id);
        return changed.changes > 0 ? this.outputCycle(id) : undefined;
    }
    enqueueOutbound(input, now = Date.now()) {
        this.db
            .prepare(`
      INSERT INTO outbound_outbox(
        item_id,thread_key,route_id,space_id,chat_id,discussion_root_id,operation,target_message_id,
        reply_to_message_id,payload_json,dedupe_key,status,attempts,available_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `)
            .run(input.id, input.threadKey, input.routeId, input.spaceId, input.chatId, input.discussionRootId ?? null, input.operation, input.targetMessageId ?? null, input.replyToMessageId ?? null, JSON.stringify(input.payload ?? null), input.dedupeKey, input.availableAt ?? now, now, now);
        return this.outboundByDedupeKey(input.dedupeKey);
    }
    outbound(id) {
        return mapOutbound(this.db.prepare("SELECT * FROM outbound_outbox WHERE item_id=?").get(id));
    }
    outboundByDedupeKey(dedupeKey) {
        return mapOutbound(this.db.prepare("SELECT * FROM outbound_outbox WHERE dedupe_key=?").get(dedupeKey));
    }
    setOutboundTargetMessage(id, targetMessageId, workerId, now = Date.now()) {
        const result = workerId
            ? this.db
                .prepare("UPDATE outbound_outbox SET target_message_id=?,updated_at=? WHERE item_id=? AND status='claimed' AND claimed_by=?")
                .run(targetMessageId, now, id, workerId)
            : this.db
                .prepare("UPDATE outbound_outbox SET target_message_id=?,updated_at=? WHERE item_id=?")
                .run(targetMessageId, now, id);
        return result.changes > 0;
    }
    claimOutbound(workerId, options = {}) {
        const now = options.now ?? Date.now();
        const limit = Math.max(1, Math.trunc(options.limit ?? 20));
        const leaseMs = Math.max(1, Math.trunc(options.leaseMs ?? 30_000));
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare(`
        UPDATE outbound_outbox
        SET status='failed',claimed_at=NULL,claimed_by=NULL,last_error=COALESCE(last_error,'Delivery lease expired before acknowledgement'),updated_at=?
        WHERE status='claimed' AND claimed_at<=?
      `)
                .run(now, now - leaseMs);
            const ids = this.db
                .prepare(`
        SELECT item_id FROM outbound_outbox
        WHERE status IN ('pending','failed') AND available_at<=?
        ORDER BY available_at,created_at,item_id LIMIT ?
      `)
                .all(now, limit).map((row) => row.item_id);
            const claimed = [];
            for (const id of ids) {
                this.db
                    .prepare(`
          UPDATE outbound_outbox
          SET status='claimed',attempts=attempts+1,claimed_at=?,claimed_by=?,updated_at=?
          WHERE item_id=? AND status IN ('pending','failed')
        `)
                    .run(now, workerId, now, id);
                const item = this.outbound(id);
                if (item?.status === "claimed" && item.claimedBy === workerId)
                    claimed.push(item);
            }
            this.db.exec("COMMIT");
            return claimed;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    acknowledgeOutbound(id, workerId, now = Date.now()) {
        const result = workerId
            ? this.db
                .prepare("UPDATE outbound_outbox SET status='delivered',delivered_at=?,claimed_at=NULL,claimed_by=NULL,last_error=NULL,updated_at=? WHERE item_id=? AND status='claimed' AND claimed_by=?")
                .run(now, now, id, workerId)
            : this.db
                .prepare("UPDATE outbound_outbox SET status='delivered',delivered_at=?,claimed_at=NULL,claimed_by=NULL,last_error=NULL,updated_at=? WHERE item_id=? AND status='claimed'")
                .run(now, now, id);
        return result.changes > 0;
    }
    failOutbound(id, error, options = {}) {
        const item = this.outbound(id);
        if (!item ||
            item.status !== "claimed" ||
            (options.workerId && item.claimedBy !== options.workerId))
            return false;
        const now = options.now ?? Date.now();
        const terminal = item.attempts >= (options.maxAttempts ?? Number.POSITIVE_INFINITY);
        this.db
            .prepare(`
      UPDATE outbound_outbox SET
        status=?,available_at=?,claimed_at=NULL,claimed_by=NULL,last_error=?,updated_at=?
      WHERE item_id=? AND status='claimed'
    `)
            .run(terminal ? "dead" : "failed", options.retryAt ?? now, error, now, id);
        return true;
    }
    deleteOutbound(id) {
        return this.db.prepare("DELETE FROM outbound_outbox WHERE item_id=?").run(id).changes > 0;
    }
    outboundStatusCounts() {
        const counts = {
            pending: 0,
            claimed: 0,
            delivered: 0,
            failed: 0,
            dead: 0,
        };
        const rows = this.db
            .prepare("SELECT status,COUNT(*) AS count FROM outbound_outbox GROUP BY status")
            .all();
        for (const row of rows)
            counts[row.status] = Number(row.count);
        return counts;
    }
    isProactiveDelivered(runtime, nativeSessionKey, nativeEventId) {
        return Boolean(this.db
            .prepare("SELECT 1 FROM proactive_deliveries WHERE runtime=? AND native_session_key=? AND native_event_id=?")
            .get(runtime, nativeSessionKey, nativeEventId));
    }
    markProactiveDelivered(delivery, now = Date.now()) {
        return (this.db
            .prepare(`
      INSERT OR IGNORE INTO proactive_deliveries(
        runtime,native_session_key,native_event_id,thread_key,payload_hash,message_id,delivered_at
      ) VALUES(?,?,?,?,?,?,?)
    `)
            .run(delivery.runtime, delivery.nativeSessionKey, delivery.nativeEventId, delivery.threadKey, delivery.payloadHash ?? null, delivery.messageId ?? null, now).changes > 0);
    }
    bridgeCursor(bridgeId, streamKey) {
        return this.db
            .prepare("SELECT cursor FROM bridge_cursors WHERE bridge_id=? AND stream_key=?")
            .get(bridgeId, streamKey)?.cursor;
    }
    saveBridgeCursor(bridgeId, streamKey, cursor, now = Date.now()) {
        this.db
            .prepare(`
      INSERT INTO bridge_cursors(bridge_id,stream_key,cursor,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(bridge_id,stream_key) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at
    `)
            .run(bridgeId, streamKey, cursor, now);
    }
    close() {
        this.db.close();
    }
}
function mapSessionBinding(row) {
    if (!row)
        return undefined;
    return {
        threadKey: row.thread_key,
        routeId: row.route_id,
        spaceId: row.space_id,
        chatId: row.chat_id,
        ...(row.discussion_root_id ? { discussionRootId: row.discussion_root_id } : {}),
        runtime: row.runtime,
        nativeSessionKey: row.native_session_key,
        ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
        generation: Number(row.generation),
        ...(row.event_cursor ? { eventCursor: row.event_cursor } : {}),
        state: row.state,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
function mapConversationModel(row) {
    return {
        threadKey: row.thread_key,
        runtime: row.runtime,
        ...(row.requested_model_id ? { requestedModelId: row.requested_model_id } : {}),
        ...(row.use_default ? { useDefault: true } : {}),
        ...(row.applied_generation === null
            ? {}
            : { appliedGeneration: Number(row.applied_generation) }),
        ...(row.applied_model_id ? { appliedModelId: row.applied_model_id } : {}),
        ...(row.default_model_id ? { defaultModelId: row.default_model_id } : {}),
        catalog: parseJson(row.catalog_json),
        ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
        updatedAt: Number(row.updated_at),
    };
}
function mapOutputCycle(row) {
    if (!row)
        return undefined;
    return {
        id: row.cycle_id,
        threadKey: row.thread_key,
        sequence: Number(row.sequence),
        anytypeMessageId: row.anytype_message_id,
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        state: row.state,
        phase: row.phase,
        thinkingText: row.thinking_text,
        answerText: row.answer_text,
        ...(row.event_cursor ? { eventCursor: row.event_cursor } : {}),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    };
}
function mapOutbound(row) {
    if (!row)
        return undefined;
    return {
        id: row.item_id,
        threadKey: row.thread_key,
        routeId: row.route_id,
        spaceId: row.space_id,
        chatId: row.chat_id,
        ...(row.discussion_root_id ? { discussionRootId: row.discussion_root_id } : {}),
        operation: row.operation,
        ...(row.target_message_id ? { targetMessageId: row.target_message_id } : {}),
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        payload: parseJson(row.payload_json),
        dedupeKey: row.dedupe_key,
        status: row.status,
        attempts: Number(row.attempts),
        availableAt: Number(row.available_at),
        ...(row.claimed_at === null ? {} : { claimedAt: Number(row.claimed_at) }),
        ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.delivered_at === null ? {} : { deliveredAt: Number(row.delivered_at) }),
    };
}
function parseJson(value) {
    return JSON.parse(value);
}
