import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizedEventSchema } from "./automation/event.js";
import { evaluateWorkflowPolicy } from "./automation/policy.js";
import { WORKFLOW_POLICY_VERSION, canonicalJson, canonicalStoredWorkflowApproval, canonicalStoredWorkflowDefinition, canonicalWorkflowDefinition, redactStoredWorkflowJson, workflowApprovalHash, workflowApprovalMaterial, workflowDefinitionSchema, workflowSourceDigest, workflowVersionHash, } from "./automation/workflow.js";
const SCHEMA_VERSION = 18;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
function managementCapabilityHash(token) {
    return createHash("sha256").update(token).digest("hex");
}
function assertStoredTimestamp(value, label) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`${label} must be a non-negative safe integer`);
}
function assertOperatorMutation(actorPrincipalDigest, reasonCode, createdAt) {
    assertStoredTimestamp(createdAt, "Workflow operator mutation time");
    if (!/^sha256:[a-f0-9]{64}$/u.test(actorPrincipalDigest))
        throw new Error("Workflow operator actor must be a principal digest");
    if (reasonCode !== undefined && !/^[a-z][a-z0-9-]{0,63}$/u.test(reasonCode))
        throw new Error("Workflow operator reason must be a stable lowercase code");
}
export class Store {
    reportMigration;
    db;
    _migrationBackupPath;
    constructor(path, reportMigration = (message) => console.warn(message)) {
        this.reportMigration = reportMigration;
        const existed = path !== ":memory:" && existsSync(path);
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            chmodSync(dirname(path), 0o700);
        }
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
        this.migrate(path, existed);
        this.secureStateFiles(path);
    }
    get migrationBackupPath() {
        return this._migrationBackupPath;
    }
    schemaVersion() {
        return Number(this.db.prepare("PRAGMA user_version").get().user_version);
    }
    migrate(path, existed) {
        const current = this.schemaVersion();
        if (current > SCHEMA_VERSION) {
            throw new Error(`State database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);
        }
        if (existed && path !== ":memory:" && current < SCHEMA_VERSION && this.hasUserTables())
            this._migrationBackupPath = this.backupBeforeMigration(path, current);
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
            if (current < 7)
                this.migrateToVersion7();
            if (current < 8)
                this.migrateToVersion8();
            if (current < 9)
                this.migrateToVersion9();
            if (current < 10)
                this.migrateToVersion10();
            if (current < 11)
                this.migrateToVersion11();
            if (current < 12)
                this.migrateToVersion12();
            if (current < 13)
                this.migrateToVersion13();
            if (current < 14)
                this.migrateToVersion14();
            if (current < 15)
                this.migrateToVersion15();
            if (current < 16)
                this.migrateToVersion16();
            if (current < 17)
                this.migrateToVersion17();
            if (current < 18)
                this.migrateToVersion18();
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            if (this._migrationBackupPath)
                throw new Error(`State migration failed; backup preserved at ${this._migrationBackupPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            throw error;
        }
        if (this._migrationBackupPath)
            this.reportMigration(`Knot upgraded the state database from schema ${current} to ${SCHEMA_VERSION}. Backup: ${this._migrationBackupPath}`);
        if (current > 0 && current < SCHEMA_VERSION) {
            this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
        }
        this.secureStateFiles(path);
    }
    secureStateFiles(path) {
        if (path === ":memory:")
            return;
        chmodSync(dirname(path), 0o700);
        for (const candidate of [path, `${path}-wal`, `${path}-shm`])
            if (existsSync(candidate))
                chmodSync(candidate, 0o600);
    }
    hasUserTables() {
        return Boolean(this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
            .get());
    }
    backupBeforeMigration(path, current) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backup = `${path}.pre-v${current}.${stamp}.${randomUUID()}.bak`;
        const temporaryDirectory = mkdtempSync(`${dirname(path)}/.knot-migration-`);
        const temporaryBackup = `${temporaryDirectory}/state.sqlite`;
        try {
            this.db.prepare("VACUUM INTO ?").run(temporaryBackup);
            chmodSync(temporaryBackup, 0o600);
            renameSync(temporaryBackup, backup);
            return backup;
        }
        finally {
            rmSync(temporaryDirectory, { recursive: true, force: true });
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
    migrateToVersion7() {
        this.db.exec(`
      CREATE TABLE workflow_definitions (
        workflow_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'discovered'
          CHECK(state IN ('discovered','valid','invalid','archived')),
        active_version_hash TEXT,
        source_modified_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        validation_errors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(validation_errors_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id,object_id),
        FOREIGN KEY(workflow_id,active_version_hash)
          REFERENCES workflow_versions(workflow_id,version_hash)
          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX idx_workflow_definitions_state
        ON workflow_definitions(state,updated_at,workflow_id);
      CREATE INDEX idx_workflow_definitions_space
        ON workflow_definitions(space_id,last_seen_at,workflow_id);

      CREATE TABLE workflow_approval_subjects (
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id) ON DELETE RESTRICT,
        approval_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK(policy_version > 0),
        canonical_approval_json TEXT NOT NULL CHECK(json_valid(canonical_approval_json)),
        risk_tier TEXT NOT NULL CHECK(risk_tier IN ('T0','T1','T2')),
        required_capabilities_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(required_capabilities_json)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(workflow_id,approval_hash)
      );

      CREATE TABLE workflow_versions (
        workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id) ON DELETE RESTRICT,
        space_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        approval_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        canonical_definition_json TEXT NOT NULL CHECK(json_valid(canonical_definition_json)),
        source_text TEXT NOT NULL,
        risk_tier TEXT NOT NULL CHECK(risk_tier IN ('T0','T1','T2')),
        required_capabilities_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(required_capabilities_json)),
        source_modified_at INTEGER NOT NULL,
        author_principal_digest TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(workflow_id,version_hash),
        FOREIGN KEY(workflow_id,approval_hash)
          REFERENCES workflow_approval_subjects(workflow_id,approval_hash) ON DELETE RESTRICT
      );
      CREATE INDEX idx_workflow_versions_approval
        ON workflow_versions(workflow_id,approval_hash,created_at);

      CREATE TABLE workflow_approval_decisions (
        decision_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL UNIQUE,
        workflow_id TEXT NOT NULL,
        approval_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','revoked')),
        mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')),
        authority_hash TEXT NOT NULL,
        actor_principal_digest TEXT NOT NULL,
        reason TEXT,
        decided_at INTEGER NOT NULL,
        expires_at INTEGER,
        supersedes_decision_id TEXT REFERENCES workflow_approval_decisions(decision_id)
          ON DELETE RESTRICT,
        UNIQUE(workflow_id,approval_hash,decision_id),
        FOREIGN KEY(workflow_id,approval_hash)
          REFERENCES workflow_approval_subjects(workflow_id,approval_hash) ON DELETE RESTRICT,
        FOREIGN KEY(workflow_id,approval_hash,supersedes_decision_id)
          REFERENCES workflow_approval_decisions(workflow_id,approval_hash,decision_id)
          ON DELETE RESTRICT
      );
      CREATE INDEX idx_workflow_decisions_current
        ON workflow_approval_decisions(workflow_id,approval_hash,decision_sequence DESC);
      CREATE INDEX idx_workflow_decisions_expiry
        ON workflow_approval_decisions(expires_at) WHERE decision='approved';

      CREATE TABLE normalized_events (
        event_id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT,
        space_id TEXT NOT NULL,
        object_id TEXT,
        observed_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
        diff_json TEXT CHECK(diff_json IS NULL OR json_valid(diff_json)),
        causation_run_id TEXT,
        causal_depth INTEGER NOT NULL DEFAULT 0 CHECK(causal_depth >= 0),
        origin_effect_key TEXT,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX idx_normalized_events_observed ON normalized_events(observed_at,event_id);
      CREATE INDEX idx_normalized_events_space
        ON normalized_events(space_id,observed_at,event_id);
      CREATE INDEX idx_normalized_events_object
        ON normalized_events(space_id,object_id,observed_at,event_id) WHERE object_id IS NOT NULL;
      CREATE INDEX idx_normalized_events_kind
        ON normalized_events(kind,observed_at,event_id);

      CREATE TRIGGER workflow_approval_subjects_no_update BEFORE UPDATE ON workflow_approval_subjects
        BEGIN SELECT RAISE(ABORT,'workflow approval subjects are append-only'); END;
      CREATE TRIGGER workflow_approval_subjects_no_delete BEFORE DELETE ON workflow_approval_subjects
        BEGIN SELECT RAISE(ABORT,'workflow approval subjects are append-only'); END;
      CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
        BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
      CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions
        BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
      CREATE TRIGGER workflow_approval_decisions_no_update BEFORE UPDATE ON workflow_approval_decisions
        BEGIN SELECT RAISE(ABORT,'workflow approval decisions are append-only'); END;
      CREATE TRIGGER workflow_approval_decisions_no_delete BEFORE DELETE ON workflow_approval_decisions
        BEGIN SELECT RAISE(ABORT,'workflow approval decisions are append-only'); END;
      CREATE TRIGGER normalized_events_no_update BEFORE UPDATE ON normalized_events
        BEGIN SELECT RAISE(ABORT,'normalized events are append-only'); END;
      CREATE TRIGGER normalized_events_no_delete BEFORE DELETE ON normalized_events
        BEGIN SELECT RAISE(ABORT,'normalized events are append-only'); END;
    `);
    }
    migrateToVersion8() {
        this.db.exec(`
      CREATE TABLE management_actor_capabilities (
        token_hash TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('wake','access','model','publish')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_management_actor_capabilities_route
        ON management_actor_capabilities(route_id,expires_at);
    `);
    }
    migrateToVersion9() {
        const versionColumns = this.db.prepare("PRAGMA table_info(workflow_versions)").all();
        if (!versionColumns.some((column) => column.name === "source_digest"))
            this.db.exec("ALTER TABLE workflow_versions ADD COLUMN source_digest TEXT");
        if (!versionColumns.some((column) => column.name === "editor_provenance"))
            this.db.exec("ALTER TABLE workflow_versions ADD COLUMN editor_provenance TEXT");
        const eventColumns = this.db.prepare("PRAGMA table_info(normalized_events)").all();
        if (!eventColumns.some((column) => column.name === "source_modified_at"))
            this.db.exec("ALTER TABLE normalized_events ADD COLUMN source_modified_at INTEGER");
        if (!eventColumns.some((column) => column.name === "source_fingerprint"))
            this.db.exec("ALTER TABLE normalized_events ADD COLUMN source_fingerprint TEXT");
        if (!eventColumns.some((column) => column.name === "editor_principal_digest"))
            this.db.exec("ALTER TABLE normalized_events ADD COLUMN editor_principal_digest TEXT");
        if (!eventColumns.some((column) => column.name === "editor_provenance"))
            this.db.exec("ALTER TABLE normalized_events ADD COLUMN editor_provenance TEXT");
        this.db.exec("DROP TRIGGER IF EXISTS workflow_versions_no_update");
        const rows = this.db
            .prepare("SELECT rowid,source_text,source_digest FROM workflow_versions")
            .all();
        const update = this.db.prepare(`UPDATE workflow_versions
       SET source_text='',source_digest=?,author_principal_digest=NULL,editor_provenance=NULL
       WHERE rowid=?`);
        for (const row of rows)
            update.run(row.source_digest ?? workflowSourceDigest(row.source_text), row.rowid);
        this.db.exec(`
      CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
        BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
    `);
    }
    migrateToVersion10() {
        const definitionColumns = this.db
            .prepare("PRAGMA table_info(workflow_definitions)")
            .all();
        if (definitionColumns.length &&
            !definitionColumns.some((column) => column.name === "observed_source_digest"))
            this.db.exec("ALTER TABLE workflow_definitions ADD COLUMN observed_source_digest TEXT NOT NULL DEFAULT ''");
        this.db.exec(`
      CREATE TABLE workflow_observer_spaces (
        space_id TEXT PRIMARY KEY,
        page_offset INTEGER NOT NULL DEFAULT 0 CHECK(page_offset >= 0),
        reconcile_started_at INTEGER NOT NULL CHECK(reconcile_started_at >= 0),
        watermark_modified_at INTEGER NOT NULL DEFAULT 0 CHECK(watermark_modified_at >= 0),
        watermark_fingerprint TEXT NOT NULL DEFAULT '',
        poll_interval_ms INTEGER NOT NULL CHECK(poll_interval_ms > 0),
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
        next_scan_at INTEGER NOT NULL CHECK(next_scan_at >= 0),
        last_scan_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX idx_workflow_observer_due
        ON workflow_observer_spaces(next_scan_at,space_id);
    `);
    }
    migrateToVersion11() {
        const versionTable = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_versions'")
            .get();
        if (!versionTable)
            return;
        const versionColumns = this.db.prepare("PRAGMA table_info(workflow_versions)").all();
        const subjectTable = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_approval_subjects'")
            .get();
        this.db.exec(`
      DROP TRIGGER IF EXISTS workflow_versions_no_update;
      DROP TRIGGER IF EXISTS workflow_approval_subjects_no_update;
    `);
        if (versionColumns.some((column) => column.name === "canonical_definition_json")) {
            const versions = this.db
                .prepare("SELECT rowid,canonical_definition_json FROM workflow_versions")
                .all();
            const updateVersion = this.db.prepare("UPDATE workflow_versions SET canonical_definition_json=? WHERE rowid=?");
            for (const row of versions)
                updateVersion.run(redactStoredWorkflowJson(row.canonical_definition_json), row.rowid);
        }
        if (subjectTable) {
            const subjects = this.db
                .prepare("SELECT rowid,canonical_approval_json FROM workflow_approval_subjects")
                .all();
            const updateSubject = this.db.prepare("UPDATE workflow_approval_subjects SET canonical_approval_json=? WHERE rowid=?");
            for (const row of subjects)
                updateSubject.run(redactStoredWorkflowJson(row.canonical_approval_json), row.rowid);
        }
        this.db.exec(`
      CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
        BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
    `);
        if (subjectTable)
            this.db.exec(`
        CREATE TRIGGER workflow_approval_subjects_no_update BEFORE UPDATE ON workflow_approval_subjects
          BEGIN SELECT RAISE(ABORT,'workflow approval subjects are append-only'); END;
      `);
    }
    migrateToVersion12() {
        this.db.exec(`
      CREATE TABLE workflow_runner_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        matcher_initialized INTEGER NOT NULL DEFAULT 0 CHECK(matcher_initialized IN (0,1)),
        matcher_recorded_at INTEGER NOT NULL DEFAULT 0 CHECK(matcher_recorded_at >= 0),
        matcher_event_id TEXT NOT NULL DEFAULT '',
        last_claimed_workflow_id TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workflow_runner_state(singleton,updated_at) VALUES(1,0);

      CREATE TABLE workflow_deliveries (
        delivery_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES normalized_events(event_id) ON DELETE RESTRICT,
        event_dedupe_key TEXT NOT NULL,
        approval_hash TEXT NOT NULL,
        authority_hash TEXT NOT NULL,
        actor_principal_digest TEXT NOT NULL,
        actor_provenance TEXT NOT NULL
          CHECK(actor_provenance IN ('anytype-native','authenticated-chat','operator-cli')),
        state TEXT NOT NULL CHECK(state IN ('pending','dispatched','cancelled','dead_letter')),
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        UNIQUE(workflow_id,version_hash,event_dedupe_key),
        FOREIGN KEY(workflow_id,version_hash)
          REFERENCES workflow_versions(workflow_id,version_hash) ON DELETE RESTRICT
      );
      CREATE INDEX idx_workflow_deliveries_state
        ON workflow_deliveries(state,created_at,delivery_id);

      CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE REFERENCES workflow_deliveries(delivery_id) ON DELETE RESTRICT,
        workflow_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        approval_hash TEXT NOT NULL,
        authority_hash TEXT NOT NULL,
        actor_principal_digest TEXT NOT NULL,
        actor_provenance TEXT NOT NULL
          CHECK(actor_provenance IN ('anytype-native','authenticated-chat','operator-cli')),
        state TEXT NOT NULL
          CHECK(state IN ('pending','running','waiting','succeeded','failed','cancelled','dead_letter')),
        cancel_requested_at INTEGER,
        cancel_actor_principal_digest TEXT,
        cancel_reason TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY(workflow_id,version_hash)
          REFERENCES workflow_versions(workflow_id,version_hash) ON DELETE RESTRICT
      );
      CREATE INDEX idx_workflow_runs_state ON workflow_runs(state,updated_at,run_id);

      CREATE TABLE workflow_steps (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        kind TEXT NOT NULL,
         state TEXT NOT NULL CHECK(state IN (
           'blocked','ready','leased','running','succeeded','waiting_retry','waiting_timer',
           'waiting_approval','source_refetch_required','failed','cancelled','dead_letter'
         )),
        dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json)),
        timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds > 0),
        run_deadline_at INTEGER NOT NULL CHECK(run_deadline_at >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        fencing_token TEXT,
        lease_started_at INTEGER,
        lease_expires_at INTEGER,
        lease_hard_expires_at INTEGER,
        authority_hash TEXT NOT NULL,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(run_id,step_id)
      );
      CREATE INDEX idx_workflow_steps_ready
        ON workflow_steps(state,available_at,updated_at,run_id,position);
      CREATE INDEX idx_workflow_steps_lease
        ON workflow_steps(lease_expires_at) WHERE state IN ('leased','running');

      CREATE TABLE workflow_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
        worker_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
         state TEXT NOT NULL CHECK(state IN (
           'running','succeeded','retry','source_refetch_required','failed','dead_letter'
         )),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        UNIQUE(run_id,step_id,attempt_number),
        FOREIGN KEY(run_id,step_id) REFERENCES workflow_steps(run_id,step_id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_workflow_attempts_step
        ON workflow_attempts(run_id,step_id,attempt_number);

      CREATE TRIGGER workflow_deliveries_no_delete BEFORE DELETE ON workflow_deliveries
        BEGIN SELECT RAISE(ABORT,'workflow deliveries are durable'); END;
      CREATE TRIGGER workflow_runs_no_delete BEFORE DELETE ON workflow_runs
        BEGIN SELECT RAISE(ABORT,'workflow runs are durable'); END;
      CREATE TRIGGER workflow_steps_no_delete BEFORE DELETE ON workflow_steps
        BEGIN SELECT RAISE(ABORT,'workflow steps are durable'); END;
      CREATE TRIGGER workflow_attempts_no_delete BEFORE DELETE ON workflow_attempts
        BEGIN SELECT RAISE(ABORT,'workflow attempts are durable'); END;
    `);
    }
    migrateToVersion13() {
        this.db.exec(`
      ALTER TABLE workflow_deliveries ADD COLUMN next_dispatch_at INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_workflow_deliveries_dispatch
        ON workflow_deliveries(state,next_dispatch_at,created_at,delivery_id);
    `);
        const eventColumns = this.db.prepare("PRAGMA table_info(normalized_events)").all();
        const definitionColumns = this.db
            .prepare("PRAGMA table_info(workflow_definitions)")
            .all();
        if (["kind", "source", "space_id", "object_id", "source_modified_at", "source_fingerprint"].every((name) => eventColumns.some((column) => column.name === name)) &&
            ["space_id", "object_id", "source_modified_at", "observed_source_digest"].every((name) => definitionColumns.some((column) => column.name === name))) {
            this.db.exec(`
        DROP TRIGGER IF EXISTS normalized_events_no_update;
        UPDATE normalized_events SET source='workflow'
          WHERE source='poll' AND kind IN ('object.created','object.updated','object.archived')
            AND EXISTS(
              SELECT 1 FROM workflow_definitions d
              WHERE d.space_id=normalized_events.space_id
                AND d.object_id=normalized_events.object_id
                AND d.source_modified_at=normalized_events.source_modified_at
                AND d.observed_source_digest=normalized_events.source_fingerprint
            );
        CREATE TRIGGER normalized_events_no_update BEFORE UPDATE ON normalized_events
          BEGIN SELECT RAISE(ABORT,'normalized events are append-only'); END;
      `);
        }
    }
    migrateToVersion14() {
        const capabilityTableExists = Boolean(this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='management_actor_capabilities'")
            .get());
        if (!capabilityTableExists) {
            this.db.exec(`
        CREATE TABLE management_actor_capabilities (
          token_hash TEXT PRIMARY KEY,
          route_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('wake','access','model','publish')),
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_management_actor_capabilities_route
          ON management_actor_capabilities(route_id,expires_at);
      `);
            return;
        }
        this.db.exec(`
      CREATE TABLE management_actor_capabilities_v14 (
        token_hash TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('wake','access','model','publish')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO management_actor_capabilities_v14(
        token_hash,route_id,participant_id,scope,expires_at,created_at
      )
      SELECT token_hash,route_id,participant_id,scope,expires_at,created_at
        FROM management_actor_capabilities;
      DROP TABLE management_actor_capabilities;
      ALTER TABLE management_actor_capabilities_v14 RENAME TO management_actor_capabilities;
      CREATE INDEX idx_management_actor_capabilities_route
        ON management_actor_capabilities(route_id,expires_at);
    `);
    }
    migrateToVersion15() {
        const legacyUnredactedWorkflowIds = new Set();
        const versionRedactions = [];
        const versionTable = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_versions'")
            .get();
        const versionColumns = versionTable
            ? this.db.prepare("PRAGMA table_info(workflow_versions)").all()
            : [];
        if (versionColumns.some((column) => column.name === "workflow_id") &&
            versionColumns.some((column) => column.name === "canonical_definition_json")) {
            const versions = this.db
                .prepare("SELECT rowid,workflow_id,canonical_definition_json FROM workflow_versions")
                .all();
            for (const version of versions) {
                const canonical = canonicalJson(JSON.parse(version.canonical_definition_json));
                const redacted = redactStoredWorkflowJson(version.canonical_definition_json);
                if (redacted !== canonical) {
                    legacyUnredactedWorkflowIds.add(version.workflow_id);
                    versionRedactions.push({ rowid: version.rowid, value: redacted });
                }
            }
        }
        const subjectTable = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_approval_subjects'")
            .get();
        const subjectColumns = subjectTable
            ? this.db.prepare("PRAGMA table_info(workflow_approval_subjects)").all()
            : [];
        const subjectRedactions = [];
        if (subjectColumns.some((column) => column.name === "workflow_id") &&
            subjectColumns.some((column) => column.name === "canonical_approval_json")) {
            const subjects = this.db
                .prepare("SELECT rowid,workflow_id,canonical_approval_json FROM workflow_approval_subjects")
                .all();
            for (const subject of subjects) {
                const canonical = canonicalJson(JSON.parse(subject.canonical_approval_json));
                const redacted = redactStoredWorkflowJson(subject.canonical_approval_json);
                if (redacted !== canonical) {
                    legacyUnredactedWorkflowIds.add(subject.workflow_id);
                    subjectRedactions.push({ rowid: subject.rowid, value: redacted });
                }
            }
        }
        if (versionRedactions.length > 0 || subjectRedactions.length > 0) {
            this.db.exec(`
        DROP TRIGGER IF EXISTS workflow_versions_no_update;
        DROP TRIGGER IF EXISTS workflow_approval_subjects_no_update;
      `);
            if (versionRedactions.length > 0) {
                const updateVersion = this.db.prepare("UPDATE workflow_versions SET canonical_definition_json=? WHERE rowid=?");
                for (const redaction of versionRedactions)
                    updateVersion.run(redaction.value, redaction.rowid);
            }
            if (subjectRedactions.length > 0) {
                const updateSubject = this.db.prepare("UPDATE workflow_approval_subjects SET canonical_approval_json=? WHERE rowid=?");
                for (const redaction of subjectRedactions)
                    updateSubject.run(redaction.value, redaction.rowid);
            }
            if (versionColumns.length > 0)
                this.db.exec(`
          CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
            BEGIN SELECT RAISE(ABORT,'workflow versions are append-only'); END;
        `);
            if (subjectColumns.length > 0)
                this.db.exec(`
          CREATE TRIGGER workflow_approval_subjects_no_update BEFORE UPDATE ON workflow_approval_subjects
            BEGIN SELECT RAISE(ABORT,'workflow approval subjects are append-only'); END;
        `);
        }
        this.db.exec(`
      ALTER TABLE workflow_deliveries
        ADD COLUMN dispatch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempt_count >= 0);
      ALTER TABLE workflow_deliveries
        ADD COLUMN approval_pending INTEGER NOT NULL DEFAULT 0 CHECK(approval_pending IN (0,1));
      ALTER TABLE workflow_steps
        ADD COLUMN source_refetch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(source_refetch_attempt_count >= 0);

      CREATE TABLE cloud_command_inbox (
        command_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
        envelope_digest TEXT NOT NULL,
        required_scope TEXT NOT NULL,
        actor_principal_digest TEXT NOT NULL,
        actor_digest_version INTEGER NOT NULL CHECK(actor_digest_version > 0),
        actor_provenance TEXT NOT NULL CHECK(actor_provenance IN (
          'authenticated-cloud-session','connector-key','consumer-api-key','first-party-service'
        )),
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        lease_token TEXT NOT NULL,
        lease_token_digest TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'received','awaiting_approval','queued','running','terminal_pending',
          'succeeded','rejected','failed','cancelled','dead_letter'
        )),
        local_attempts INTEGER NOT NULL DEFAULT 0 CHECK(local_attempts >= 0),
        effect_key TEXT NOT NULL UNIQUE,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        last_error_code TEXT,
        last_error TEXT,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX cloud_command_inbox_ready
        ON cloud_command_inbox(state,available_at,created_at,command_id);
      CREATE INDEX cloud_command_inbox_lease
        ON cloud_command_inbox(lease_expires_at) WHERE state IN ('received','awaiting_approval','queued','running','terminal_pending');

      CREATE TABLE cloud_effect_receipts (
        effect_key TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES cloud_command_inbox(command_id) ON DELETE RESTRICT,
        operation_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','running','succeeded','failed','outcome_unknown')),
        fencing_token TEXT NOT NULL,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error_code TEXT,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE cloud_projection_outbox (
        projection_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL REFERENCES cloud_command_inbox(command_id) ON DELETE RESTRICT,
        origin_effect_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        state TEXT NOT NULL CHECK(state IN ('pending','in_flight','delivered','retrying','dead_letter')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        target_message_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX cloud_projection_outbox_ready
        ON cloud_projection_outbox(state,available_at,created_at,projection_id);

      CREATE TRIGGER cloud_command_inbox_no_delete BEFORE DELETE ON cloud_command_inbox
        BEGIN SELECT RAISE(ABORT,'cloud command inbox is durable'); END;
      CREATE TRIGGER cloud_effect_receipts_no_delete BEFORE DELETE ON cloud_effect_receipts
        BEGIN SELECT RAISE(ABORT,'cloud effect receipts are durable'); END;
      CREATE TRIGGER cloud_projection_outbox_no_delete BEFORE DELETE ON cloud_projection_outbox
        BEGIN SELECT RAISE(ABORT,'cloud projection outbox is durable'); END;
    `);
        if (legacyUnredactedWorkflowIds.size > 0) {
            const invalidate = this.db.prepare(`UPDATE workflow_definitions
         SET state='invalid',active_version_hash=NULL,
             validation_errors_json='["workflow_integrity_failed"]',updated_at=MAX(updated_at,?)
         WHERE workflow_id=?`);
            const invalidatedAt = Date.now();
            for (const workflowId of legacyUnredactedWorkflowIds)
                invalidate.run(invalidatedAt, workflowId);
        }
    }
    migrateToVersion16() {
        this.db.exec(`
      CREATE TABLE workflow_effect_receipts (
        effect_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','running','succeeded','failed','outcome_unknown')),
        fencing_token TEXT NOT NULL,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id,step_id),
        FOREIGN KEY(run_id,step_id) REFERENCES workflow_steps(run_id,step_id) ON DELETE RESTRICT
      );
      CREATE INDEX workflow_effect_receipts_state
        ON workflow_effect_receipts(state,updated_at,effect_key);
      CREATE TRIGGER workflow_effect_receipts_no_delete
        BEFORE DELETE ON workflow_effect_receipts
        BEGIN SELECT RAISE(ABORT,'workflow effect receipts are durable'); END;
    `);
    }
    migrateToVersion17() {
        this.db.exec(`
      CREATE TABLE workflow_operator_overrides (
        workflow_id TEXT PRIMARY KEY REFERENCES workflow_definitions(workflow_id) ON DELETE RESTRICT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        actor_principal_digest TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workflow_operator_audit (
        audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK(action IN (
          'workflow.approve','workflow.reject','workflow.revoke','workflow.enable',
          'workflow.disable','workflow.manual_run','run.cancel','run.retry'
        )),
        actor_principal_digest TEXT NOT NULL,
        workflow_id TEXT REFERENCES workflow_definitions(workflow_id) ON DELETE RESTRICT,
        run_id TEXT REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
        reason_code TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX workflow_operator_audit_created
        ON workflow_operator_audit(created_at,audit_sequence);
      CREATE INDEX workflow_operator_audit_workflow
        ON workflow_operator_audit(workflow_id,created_at,audit_sequence);
      CREATE INDEX workflow_operator_audit_run
        ON workflow_operator_audit(run_id,created_at,audit_sequence);
      CREATE TRIGGER workflow_operator_audit_no_update BEFORE UPDATE ON workflow_operator_audit
        BEGIN SELECT RAISE(ABORT,'workflow operator audit is append-only'); END;
      CREATE TRIGGER workflow_operator_audit_no_delete BEFORE DELETE ON workflow_operator_audit
        BEGIN SELECT RAISE(ABORT,'workflow operator audit is append-only'); END;
    `);
    }
    migrateToVersion18() {
        // Pre-upgrade capabilities lack an authenticated source thread. Expire that
        // transient authority instead of guessing a discussion root or widening use.
        this.db.exec(`
      ALTER TABLE management_actor_capabilities ADD COLUMN thread_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE management_actor_capabilities ADD COLUMN uses_remaining INTEGER NOT NULL DEFAULT 1 CHECK(uses_remaining >= 0);
      DELETE FROM management_actor_capabilities;
      CREATE INDEX idx_management_actor_capabilities_thread ON management_actor_capabilities(thread_key);
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
        this.db
            .prepare("DELETE FROM management_actor_capabilities WHERE expires_at<=?")
            .run(Date.now());
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
    workflowDefinition(spaceId, objectId) {
        const row = this.db
            .prepare("SELECT * FROM workflow_definitions WHERE space_id=? AND object_id=?")
            .get(spaceId, objectId);
        return row ? mapWorkflowDefinition(row) : undefined;
    }
    workflowDefinitionById(workflowId) {
        const row = this.db
            .prepare("SELECT * FROM workflow_definitions WHERE workflow_id=?")
            .get(workflowId);
        return row ? mapWorkflowDefinition(row) : undefined;
    }
    workflowDefinitions(limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            throw new Error("Workflow list limit must be from 1 to 500");
        return this.db
            .prepare("SELECT * FROM workflow_definitions ORDER BY updated_at DESC,workflow_id LIMIT ?")
            .all(limit).map(mapWorkflowDefinition);
    }
    recordWorkflowDefinitionStatus(input) {
        assertStoredTimestamp(input.sourceModifiedAt, "Workflow source modification time");
        assertStoredTimestamp(input.seenAt, "Workflow observation time");
        const validationErrorsJson = JSON.stringify(input.validationErrors ?? []);
        this.db
            .prepare(`INSERT INTO workflow_definitions(
          workflow_id,space_id,object_id,name,state,active_version_hash,source_modified_at,
          last_seen_at,validation_errors_json,observed_source_digest,created_at,updated_at
        ) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?)
        ON CONFLICT(workflow_id) DO UPDATE SET
          last_seen_at=MAX(workflow_definitions.last_seen_at,excluded.last_seen_at),
          name=CASE WHEN excluded.source_modified_at > workflow_definitions.source_modified_at
            OR (excluded.source_modified_at=workflow_definitions.source_modified_at
                AND excluded.observed_source_digest>=workflow_definitions.observed_source_digest)
            THEN excluded.name ELSE workflow_definitions.name END,
          state=CASE WHEN excluded.source_modified_at > workflow_definitions.source_modified_at
            OR (excluded.source_modified_at=workflow_definitions.source_modified_at
                AND excluded.observed_source_digest>=workflow_definitions.observed_source_digest)
            THEN excluded.state ELSE workflow_definitions.state END,
          active_version_hash=CASE WHEN (
              excluded.source_modified_at > workflow_definitions.source_modified_at OR
              (excluded.source_modified_at=workflow_definitions.source_modified_at
               AND excluded.observed_source_digest>=workflow_definitions.observed_source_digest)
            ) AND excluded.state!='valid'
            THEN NULL ELSE workflow_definitions.active_version_hash END,
          source_modified_at=MAX(workflow_definitions.source_modified_at,excluded.source_modified_at),
          validation_errors_json=CASE WHEN excluded.source_modified_at > workflow_definitions.source_modified_at
            OR (excluded.source_modified_at=workflow_definitions.source_modified_at
                AND excluded.observed_source_digest>=workflow_definitions.observed_source_digest)
            THEN excluded.validation_errors_json ELSE workflow_definitions.validation_errors_json END,
          observed_source_digest=CASE WHEN excluded.source_modified_at > workflow_definitions.source_modified_at
            OR (excluded.source_modified_at=workflow_definitions.source_modified_at
                AND excluded.observed_source_digest>=workflow_definitions.observed_source_digest)
            THEN excluded.observed_source_digest ELSE workflow_definitions.observed_source_digest END,
          updated_at=MAX(workflow_definitions.updated_at,excluded.updated_at)`)
            .run(input.workflowId, input.spaceId, input.objectId, input.name, input.state, input.sourceModifiedAt, input.seenAt, validationErrorsJson, input.sourceDigest, input.seenAt, input.seenAt);
        return this.workflowDefinition(input.spaceId, input.objectId);
    }
    recordWorkflowDefinitionReadFailure(input) {
        assertStoredTimestamp(input.sourceModifiedAt, "Workflow source modification time");
        assertStoredTimestamp(input.seenAt, "Workflow observation time");
        this.db
            .prepare(`INSERT INTO workflow_definitions(
          workflow_id,space_id,object_id,name,state,active_version_hash,source_modified_at,
          last_seen_at,validation_errors_json,observed_source_digest,created_at,updated_at
        ) VALUES(?,?,?,?, 'invalid',NULL,?,?,?,?,?,?)
        ON CONFLICT(workflow_id) DO UPDATE SET
          name=CASE WHEN excluded.source_modified_at>workflow_definitions.source_modified_at
            THEN excluded.name ELSE workflow_definitions.name END,
          state=CASE WHEN excluded.source_modified_at>workflow_definitions.source_modified_at
            THEN 'invalid' ELSE workflow_definitions.state END,
          active_version_hash=CASE
            WHEN excluded.source_modified_at>workflow_definitions.source_modified_at THEN NULL
            ELSE workflow_definitions.active_version_hash END,
          source_modified_at=MAX(workflow_definitions.source_modified_at,excluded.source_modified_at),
          last_seen_at=MAX(workflow_definitions.last_seen_at,excluded.last_seen_at),
          validation_errors_json=CASE
            WHEN excluded.source_modified_at>workflow_definitions.source_modified_at
            THEN excluded.validation_errors_json ELSE workflow_definitions.validation_errors_json END,
          observed_source_digest=CASE
            WHEN excluded.source_modified_at>workflow_definitions.source_modified_at
            THEN excluded.observed_source_digest ELSE workflow_definitions.observed_source_digest END,
          updated_at=MAX(workflow_definitions.updated_at,excluded.updated_at)`)
            .run(input.workflowId, input.spaceId, input.objectId, input.name, input.sourceModifiedAt, input.seenAt, JSON.stringify([input.errorCode]), input.sourceDigest, input.seenAt, input.seenAt);
        return this.workflowDefinition(input.spaceId, input.objectId);
    }
    workflowDefinitionsMissingSince(spaceId, reconcileStartedAt, limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
            throw new Error("Workflow reconciliation limit must be between 1 and 1000");
        const rows = this.db
            .prepare(`SELECT * FROM workflow_definitions
         WHERE space_id=? AND state!='archived' AND last_seen_at<?
         ORDER BY last_seen_at,workflow_id LIMIT ?`)
            .all(spaceId, reconcileStartedAt, limit);
        return rows.map(mapWorkflowDefinition);
    }
    workflowObserverState(spaceId) {
        const row = this.db
            .prepare("SELECT * FROM workflow_observer_spaces WHERE space_id=?")
            .get(spaceId);
        return row ? mapWorkflowObserverState(row) : undefined;
    }
    saveWorkflowObserverState(input) {
        this.db
            .prepare(`INSERT INTO workflow_observer_spaces(
          space_id,page_offset,reconcile_started_at,watermark_modified_at,watermark_fingerprint,
          poll_interval_ms,consecutive_failures,next_scan_at,last_scan_at,last_success_at,last_error
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(space_id) DO UPDATE SET
          page_offset=excluded.page_offset,reconcile_started_at=excluded.reconcile_started_at,
          watermark_modified_at=excluded.watermark_modified_at,
          watermark_fingerprint=excluded.watermark_fingerprint,
          poll_interval_ms=excluded.poll_interval_ms,
          consecutive_failures=excluded.consecutive_failures,next_scan_at=excluded.next_scan_at,
          last_scan_at=excluded.last_scan_at,last_success_at=excluded.last_success_at,
          last_error=excluded.last_error`)
            .run(input.spaceId, input.pageOffset, input.reconcileStartedAt, input.watermarkModifiedAt, input.watermarkFingerprint, input.pollIntervalMilliseconds, input.consecutiveFailures, input.nextScanAt, input.lastScanAt ?? null, input.lastSuccessAt ?? null, input.lastError ?? null);
        return this.workflowObserverState(input.spaceId);
    }
    saveWorkflowVersion(input, observationDigest = input.sourceDigest) {
        assertStoredTimestamp(input.sourceModifiedAt, "Workflow source modification time");
        assertStoredTimestamp(input.createdAt, "Workflow creation time");
        if (input.sourceModifiedAt > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS)
            throw new Error("Workflow source modification time is too far in the future");
        const definition = workflowDefinitionSchema.parse(JSON.parse(input.canonicalDefinitionJson));
        const canonicalDefinitionJson = canonicalWorkflowDefinition(definition);
        const canonicalApprovalJson = canonicalJson(workflowApprovalMaterial(definition));
        const storedDefinitionJson = canonicalStoredWorkflowDefinition(definition);
        const storedApprovalJson = canonicalStoredWorkflowApproval(definition);
        const policy = evaluateWorkflowPolicy(definition, { sourceSpaceId: input.spaceId });
        const requiredCapabilitiesJson = JSON.stringify(policy.requiredCapabilities);
        if (input.canonicalDefinitionJson !== canonicalDefinitionJson ||
            input.versionHash !== workflowVersionHash(definition) ||
            input.canonicalApprovalJson !== canonicalApprovalJson ||
            input.approvalHash !== workflowApprovalHash(definition) ||
            input.name !== definition.metadata.name ||
            input.riskTier !== policy.riskTier ||
            JSON.stringify([...new Set(input.requiredCapabilities)].sort()) !==
                requiredCapabilitiesJson ||
            policy.missingCapabilities.length > 0)
            throw new Error("Workflow version record does not match its canonical definition and policy");
        if (!/^sha256:[a-f0-9]{64}$/.test(input.sourceDigest))
            throw new Error("Workflow source digest must be a domain-separated SHA-256 digest");
        if (!/^sha256:[a-f0-9]{64}$/.test(observationDigest))
            throw new Error("Workflow observation digest must be a domain-separated SHA-256 digest");
        if ((input.editorPrincipalDigest === undefined) !== (input.editorProvenance === undefined))
            throw new Error("Workflow editor digest and provenance must be recorded together");
        if (input.editorPrincipalDigest !== undefined &&
            !/^sha256:[a-f0-9]{64}$/.test(input.editorPrincipalDigest))
            throw new Error("Workflow editor principal digest must be a SHA-256 digest");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const existingSource = this.db
                .prepare("SELECT workflow_id FROM workflow_definitions WHERE space_id=? AND object_id=?")
                .get(input.spaceId, input.objectId);
            if (existingSource && existingSource.workflow_id !== input.workflowId)
                throw new Error("Anytype workflow object is already bound to another workflow ID");
            this.db
                .prepare(`INSERT INTO workflow_definitions(
            workflow_id,space_id,object_id,name,state,active_version_hash,source_modified_at,
            last_seen_at,validation_errors_json,created_at,updated_at
          ) VALUES(?,?,?,?,'valid',NULL,?,?,'[]',?,?)
          ON CONFLICT(workflow_id) DO NOTHING`)
                .run(input.workflowId, input.spaceId, input.objectId, input.name, input.sourceModifiedAt, input.createdAt, input.createdAt, input.createdAt);
            this.db
                .prepare(`INSERT OR IGNORE INTO workflow_approval_subjects(
            workflow_id,approval_hash,policy_version,canonical_approval_json,risk_tier,
            required_capabilities_json,created_at
          ) VALUES(?,?,?,?,?,?,?)`)
                .run(input.workflowId, input.approvalHash, WORKFLOW_POLICY_VERSION, storedApprovalJson, input.riskTier, requiredCapabilitiesJson, input.createdAt);
            const subject = this.db
                .prepare(`SELECT policy_version,canonical_approval_json,risk_tier,required_capabilities_json
           FROM workflow_approval_subjects WHERE workflow_id=? AND approval_hash=?`)
                .get(input.workflowId, input.approvalHash);
            if (!subject ||
                subject.policy_version !== WORKFLOW_POLICY_VERSION ||
                subject.canonical_approval_json !== storedApprovalJson ||
                subject.risk_tier !== input.riskTier ||
                subject.required_capabilities_json !== requiredCapabilitiesJson)
                throw new Error("Workflow approval hash collision or divergent approval material");
            this.db
                .prepare(`INSERT OR IGNORE INTO workflow_versions(
            workflow_id,space_id,object_id,name,version_hash,approval_hash,schema_version,
            canonical_definition_json,source_text,source_digest,risk_tier,required_capabilities_json,
            source_modified_at,author_principal_digest,editor_provenance,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(input.workflowId, input.spaceId, input.objectId, input.name, input.versionHash, input.approvalHash, input.schemaVersion, storedDefinitionJson, "", input.sourceDigest, input.riskTier, requiredCapabilitiesJson, input.sourceModifiedAt, input.editorPrincipalDigest ?? null, input.editorProvenance ?? null, input.createdAt);
            const stored = this.workflowVersion(input.workflowId, input.versionHash);
            if (!stored ||
                stored.spaceId !== input.spaceId ||
                stored.objectId !== input.objectId ||
                stored.name !== input.name ||
                stored.approvalHash !== input.approvalHash ||
                stored.schemaVersion !== input.schemaVersion ||
                stored.storedDefinitionJson !== storedDefinitionJson ||
                stored.storedApprovalJson !== storedApprovalJson ||
                stored.riskTier !== input.riskTier ||
                JSON.stringify(stored.requiredCapabilities) !== requiredCapabilitiesJson)
                throw new Error("Workflow version hash collision or divergent immutable version");
            this.activateWorkflowVersionObservation(input, observationDigest);
            this.db.exec("COMMIT");
            return stored;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    activateWorkflowVersionObservation(input, observationDigest = input.sourceDigest) {
        const version = this.db
            .prepare("SELECT 1 FROM workflow_versions WHERE workflow_id=? AND version_hash=?")
            .get(input.workflowId, input.versionHash);
        if (!version)
            throw new Error("Cannot activate an unknown workflow version");
        this.db
            .prepare(`UPDATE workflow_definitions SET active_version_hash=?,name=?,source_modified_at=?,
           observed_source_digest=?,updated_at=?
         WHERE workflow_id=? AND (
           ? > source_modified_at OR
           (? = source_modified_at AND ? >= observed_source_digest)
         )`)
            .run(input.versionHash, input.name, input.sourceModifiedAt, observationDigest, input.createdAt, input.workflowId, input.sourceModifiedAt, input.sourceModifiedAt, observationDigest);
    }
    workflowVersion(workflowId, versionHash) {
        const row = this.db
            .prepare(`SELECT v.*,s.canonical_approval_json
         FROM workflow_versions v
         JOIN workflow_approval_subjects s
           ON s.workflow_id=v.workflow_id AND s.approval_hash=v.approval_hash
         WHERE v.workflow_id=? AND v.version_hash=?`)
            .get(workflowId, versionHash);
        return row ? mapWorkflowVersion(row) : undefined;
    }
    recordWorkflowApproval(input, audit) {
        for (const [label, value] of [
            ["decision ID", input.decisionId],
            ["authority hash", input.authorityHash],
            ["actor principal digest", input.actorPrincipalDigest],
        ])
            if (!value.trim())
                throw new Error(`Workflow approval ${label} must not be empty`);
        assertStoredTimestamp(input.decidedAt, "Workflow approval decision time");
        if (input.expiresAt !== undefined) {
            assertStoredTimestamp(input.expiresAt, "Workflow approval expiry time");
            if (input.expiresAt <= input.decidedAt)
                throw new Error("Workflow approval expiry must be after its decision time");
        }
        if (audit) {
            const expectedAction = input.decision === "approved"
                ? "workflow.approve"
                : input.decision === "rejected"
                    ? "workflow.reject"
                    : "workflow.revoke";
            if (audit.action !== expectedAction ||
                audit.workflowId !== input.workflowId ||
                audit.runId !== undefined ||
                audit.actorPrincipalDigest !== input.actorPrincipalDigest)
                throw new Error("Workflow approval audit does not match the approval mutation");
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const subject = this.db
                .prepare("SELECT risk_tier FROM workflow_approval_subjects WHERE workflow_id=? AND approval_hash=?")
                .get(input.workflowId, input.approvalHash);
            if (!subject)
                throw new Error("Unknown workflow approval subject");
            if (subject.risk_tier === "T2" && input.decision === "approved" && input.mode !== "manual")
                throw new Error("T2 workflows require explicit manual approval");
            const result = this.db
                .prepare(`INSERT INTO workflow_approval_decisions(
            decision_id,workflow_id,approval_hash,decision,mode,authority_hash,
            actor_principal_digest,reason,decided_at,expires_at,supersedes_decision_id
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
                .run(input.decisionId, input.workflowId, input.approvalHash, input.decision, input.mode, input.authorityHash, input.actorPrincipalDigest, input.reason ?? null, input.decidedAt, input.expiresAt ?? null, input.supersedesDecisionId ?? null);
            const decision = this.workflowApprovalBySequence(Number(result.lastInsertRowid));
            if (!decision)
                throw new Error("Workflow approval decision was not persisted");
            if (audit)
                this.appendWorkflowOperatorAudit({
                    ...audit,
                    createdAt: audit.createdAt ?? input.decidedAt,
                });
            this.db.exec("COMMIT");
            return decision;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    currentWorkflowApproval(workflowId, approvalHash, authorityHash, now = Date.now()) {
        const decision = this.latestWorkflowApproval(workflowId, approvalHash);
        if (!decision ||
            decision.decision !== "approved" ||
            decision.authorityHash !== authorityHash ||
            (decision.expiresAt !== undefined && decision.expiresAt <= now))
            return undefined;
        return decision;
    }
    latestWorkflowApproval(workflowId, approvalHash) {
        const row = this.db
            .prepare(`SELECT * FROM workflow_approval_decisions
         WHERE workflow_id=? AND approval_hash=?
         ORDER BY decision_sequence DESC LIMIT 1`)
            .get(workflowId, approvalHash);
        return row ? mapWorkflowApprovalDecision(row) : undefined;
    }
    workflowOperatorOverride(workflowId) {
        const row = this.db
            .prepare("SELECT * FROM workflow_operator_overrides WHERE workflow_id=?")
            .get(workflowId);
        return row ? mapWorkflowOperatorOverride(row) : undefined;
    }
    setWorkflowOperatorOverride(input) {
        const now = input.now ?? Date.now();
        if (!this.workflowDefinitionById(input.workflowId))
            throw new Error("Unknown workflow");
        assertOperatorMutation(input.actorPrincipalDigest, input.reasonCode, now);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare(`INSERT INTO workflow_operator_overrides(
            workflow_id,enabled,actor_principal_digest,reason_code,updated_at
          ) VALUES(?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET
            enabled=excluded.enabled,actor_principal_digest=excluded.actor_principal_digest,
            reason_code=excluded.reason_code,updated_at=excluded.updated_at`)
                .run(input.workflowId, input.enabled ? 1 : 0, input.actorPrincipalDigest, input.reasonCode, now);
            this.appendWorkflowOperatorAudit({
                auditId: input.auditId,
                action: input.enabled ? "workflow.enable" : "workflow.disable",
                actorPrincipalDigest: input.actorPrincipalDigest,
                workflowId: input.workflowId,
                reasonCode: input.reasonCode,
                details: { enabled: input.enabled },
                createdAt: now,
            });
            this.db.exec("COMMIT");
            return this.workflowOperatorOverride(input.workflowId);
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    appendWorkflowOperatorAudit(input) {
        assertOperatorMutation(input.actorPrincipalDigest, input.reasonCode, input.createdAt);
        if (!input.auditId.trim())
            throw new Error("Workflow operator audit ID must not be empty");
        const detailsJson = canonicalJson(input.details);
        if (Buffer.byteLength(detailsJson, "utf8") > 8 * 1024)
            throw new Error("Workflow operator audit details exceed 8 KiB");
        const result = this.db
            .prepare(`INSERT INTO workflow_operator_audit(
          audit_id,action,actor_principal_digest,workflow_id,run_id,reason_code,details_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`)
            .run(input.auditId, input.action, input.actorPrincipalDigest, input.workflowId ?? null, input.runId ?? null, input.reasonCode ?? null, detailsJson, input.createdAt);
        const row = this.db
            .prepare("SELECT * FROM workflow_operator_audit WHERE audit_sequence=?")
            .get(Number(result.lastInsertRowid));
        if (!row)
            throw new Error("Workflow operator audit was not persisted");
        return mapWorkflowOperatorAudit(row);
    }
    workflowOperatorAudits(limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            throw new Error("Workflow audit limit must be from 1 to 500");
        return this.db
            .prepare("SELECT * FROM workflow_operator_audit ORDER BY created_at DESC,audit_sequence DESC LIMIT ?")
            .all(limit).map(mapWorkflowOperatorAudit);
    }
    recordNormalizedEvent(input) {
        const event = normalizedEventSchema.parse(input);
        assertStoredTimestamp(event.observedAt, "Normalized event observation time");
        assertStoredTimestamp(event.recordedAt, "Normalized event recording time");
        const payloadJson = canonicalJson(event.payload);
        const diffJson = event.diff ? canonicalStructured(event.diff) : undefined;
        this.db
            .prepare(`INSERT OR IGNORE INTO normalized_events(
          event_id,dedupe_key,kind,source,source_event_id,space_id,object_id,observed_at,
          payload_json,diff_json,causation_run_id,causal_depth,origin_effect_key,recorded_at,
          source_modified_at,source_fingerprint,editor_principal_digest,editor_provenance
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(event.eventId, event.dedupeKey, event.kind, event.source, event.sourceEventId ?? null, event.spaceId, event.objectId ?? null, event.observedAt, payloadJson, diffJson ?? null, event.causationRunId ?? null, event.causalDepth, event.originEffectKey ?? null, event.recordedAt, event.sourceRevision?.modifiedAt ?? null, event.sourceRevision?.fingerprint ?? null, event.editor?.principalDigest ?? null, event.editor?.provenance ?? null);
        const row = this.db
            .prepare("SELECT * FROM normalized_events WHERE dedupe_key=?")
            .get(event.dedupeKey);
        if (!row)
            throw new Error("Normalized event ID collision or divergent dedupe key");
        const stored = mapNormalizedEvent(row);
        if (!sameNormalizedEvent(stored, event))
            throw new Error("Normalized event dedupe key collision or divergent immutable event");
        return stored;
    }
    hasNormalizedEvent(dedupeKey) {
        return Boolean(this.db.prepare("SELECT 1 FROM normalized_events WHERE dedupe_key=?").get(dedupeKey));
    }
    hasNormalizedObjectEvent(spaceId, objectId) {
        return Boolean(this.db
            .prepare(`SELECT 1 FROM normalized_events
           WHERE space_id=? AND object_id=? AND kind IN ('object.created','object.updated') LIMIT 1`)
            .get(spaceId, objectId));
    }
    hasNormalizedDefinitionRevision(spaceId, objectId, modifiedAt, fingerprint) {
        return Boolean(this.db
            .prepare(`SELECT 1 FROM normalized_events
           WHERE space_id=? AND object_id=? AND source_modified_at=? AND source_fingerprint=?
             AND kind IN ('object.created','object.updated') LIMIT 1`)
            .get(spaceId, objectId, modifiedAt, fingerprint));
    }
    workflowApprovalBySequence(sequence) {
        const row = this.db
            .prepare("SELECT * FROM workflow_approval_decisions WHERE decision_sequence=?")
            .get(sequence);
        return row ? mapWorkflowApprovalDecision(row) : undefined;
    }
    revokeManagementCapabilities(routeId, threadKey) {
        this.db
            .prepare("DELETE FROM management_actor_capabilities WHERE (route_id=? AND (? IS NULL OR thread_key=?)) OR expires_at<=?")
            .run(routeId, threadKey ?? null, threadKey ?? null, Date.now());
    }
    issueManagementCapability(routeId, participantId, scope, ttlMs = 5 * 60 * 1_000, threadKey = routeId) {
        const now = Date.now();
        const token = randomUUID();
        this.db
            .prepare(`INSERT INTO management_actor_capabilities
          (token_hash,route_id,participant_id,scope,expires_at,created_at,thread_key,uses_remaining)
         VALUES(?,?,?,?,?,?,?,?)`)
            .run(managementCapabilityHash(token), routeId, participantId, scope, now + ttlMs, now, threadKey, scope === "publish" ? 16 : 1);
        return token;
    }
    consumeManagementCapability(token, routeId, scope, threadKey) {
        if (!/^[0-9a-f-]{36}$/i.test(token))
            return undefined;
        const tokenHash = managementCapabilityHash(token);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.db
                .prepare(`SELECT participant_id,route_id,scope,expires_at,thread_key,uses_remaining
             FROM management_actor_capabilities WHERE token_hash=?`)
                .get(tokenHash);
            const valid = row &&
                row.route_id === routeId &&
                row.scope === scope &&
                row.expires_at > Date.now() &&
                row.uses_remaining > 0 &&
                (threadKey === undefined || row.thread_key === threadKey);
            if (valid)
                this.db
                    .prepare("UPDATE management_actor_capabilities SET uses_remaining=uses_remaining-1 WHERE token_hash=?")
                    .run(tokenHash);
            this.db.exec("COMMIT");
            return valid ? row.participant_id : undefined;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
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
function mapWorkflowVersion(row) {
    return {
        workflowId: row.workflow_id,
        spaceId: row.space_id,
        objectId: row.object_id,
        name: row.name,
        versionHash: row.version_hash,
        approvalHash: row.approval_hash,
        schemaVersion: Number(row.schema_version),
        storedDefinitionJson: row.canonical_definition_json,
        storedApprovalJson: row.canonical_approval_json,
        sourceDigest: row.source_digest,
        riskTier: row.risk_tier,
        requiredCapabilities: parseJson(row.required_capabilities_json),
        sourceModifiedAt: Number(row.source_modified_at),
        ...(row.author_principal_digest === null
            ? {}
            : { editorPrincipalDigest: row.author_principal_digest }),
        ...(row.editor_provenance === null ? {} : { editorProvenance: row.editor_provenance }),
        createdAt: Number(row.created_at),
    };
}
function mapWorkflowDefinition(row) {
    return {
        workflowId: row.workflow_id,
        spaceId: row.space_id,
        objectId: row.object_id,
        name: row.name,
        state: row.state,
        ...(row.active_version_hash ? { activeVersionHash: row.active_version_hash } : {}),
        sourceModifiedAt: Number(row.source_modified_at),
        sourceDigest: row.observed_source_digest,
        lastSeenAt: Number(row.last_seen_at),
        validationErrors: parseJson(row.validation_errors_json),
    };
}
function mapWorkflowObserverState(row) {
    return {
        spaceId: row.space_id,
        pageOffset: Number(row.page_offset),
        reconcileStartedAt: Number(row.reconcile_started_at),
        watermarkModifiedAt: Number(row.watermark_modified_at),
        watermarkFingerprint: row.watermark_fingerprint,
        pollIntervalMilliseconds: Number(row.poll_interval_ms),
        consecutiveFailures: Number(row.consecutive_failures),
        nextScanAt: Number(row.next_scan_at),
        ...(row.last_scan_at === null ? {} : { lastScanAt: Number(row.last_scan_at) }),
        ...(row.last_success_at === null ? {} : { lastSuccessAt: Number(row.last_success_at) }),
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
    };
}
function mapWorkflowApprovalDecision(row) {
    return {
        sequence: Number(row.decision_sequence),
        decisionId: row.decision_id,
        workflowId: row.workflow_id,
        approvalHash: row.approval_hash,
        decision: row.decision,
        mode: row.mode,
        authorityHash: row.authority_hash,
        actorPrincipalDigest: row.actor_principal_digest,
        ...(row.reason === null ? {} : { reason: row.reason }),
        decidedAt: Number(row.decided_at),
        ...(row.expires_at === null ? {} : { expiresAt: Number(row.expires_at) }),
        ...(row.supersedes_decision_id === null
            ? {}
            : { supersedesDecisionId: row.supersedes_decision_id }),
    };
}
function mapWorkflowOperatorOverride(row) {
    return {
        workflowId: row.workflow_id,
        enabled: row.enabled === 1,
        actorPrincipalDigest: row.actor_principal_digest,
        reasonCode: row.reason_code,
        updatedAt: Number(row.updated_at),
    };
}
function mapWorkflowOperatorAudit(row) {
    return {
        sequence: Number(row.audit_sequence),
        auditId: row.audit_id,
        action: row.action,
        actorPrincipalDigest: row.actor_principal_digest,
        ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
        details: parseJson(row.details_json),
        createdAt: Number(row.created_at),
    };
}
function mapNormalizedEvent(row) {
    return {
        eventId: row.event_id,
        dedupeKey: row.dedupe_key,
        kind: row.kind,
        source: row.source,
        ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
        ...(row.source_modified_at === null || row.source_fingerprint === null
            ? {}
            : {
                sourceRevision: {
                    modifiedAt: Number(row.source_modified_at),
                    fingerprint: row.source_fingerprint,
                },
            }),
        spaceId: row.space_id,
        ...(row.object_id === null ? {} : { objectId: row.object_id }),
        ...(row.editor_principal_digest === null || row.editor_provenance === null
            ? {}
            : {
                editor: {
                    principalDigest: row.editor_principal_digest,
                    provenance: row.editor_provenance,
                },
            }),
        observedAt: Number(row.observed_at),
        payload: parseJson(row.payload_json),
        ...(row.diff_json === null
            ? {}
            : { diff: parseJson(row.diff_json) }),
        ...(row.causation_run_id === null ? {} : { causationRunId: row.causation_run_id }),
        causalDepth: Number(row.causal_depth),
        ...(row.origin_effect_key === null ? {} : { originEffectKey: row.origin_effect_key }),
        recordedAt: Number(row.recorded_at),
    };
}
function sameNormalizedEvent(left, right) {
    return (left.eventId === right.eventId &&
        left.dedupeKey === right.dedupeKey &&
        left.kind === right.kind &&
        left.source === right.source &&
        left.sourceEventId === right.sourceEventId &&
        canonicalStructured(left.sourceRevision ?? null) ===
            canonicalStructured(right.sourceRevision ?? null) &&
        left.spaceId === right.spaceId &&
        left.objectId === right.objectId &&
        canonicalStructured(left.editor ?? null) === canonicalStructured(right.editor ?? null) &&
        left.observedAt === right.observedAt &&
        canonicalJson(left.payload) === canonicalJson(right.payload) &&
        canonicalStructured(left.diff ?? null) === canonicalStructured(right.diff ?? null) &&
        left.causationRunId === right.causationRunId &&
        left.causalDepth === right.causalDepth &&
        left.originEffectKey === right.originEffectKey);
}
function parseJson(value) {
    return JSON.parse(value);
}
function canonicalStructured(value) {
    return canonicalJson(JSON.parse(JSON.stringify(value)));
}
