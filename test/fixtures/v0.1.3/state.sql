PRAGMA foreign_keys = ON;

CREATE TABLE cursors (
  route_id TEXT PRIMARY KEY,
  newest_order_id TEXT,
  initialized_at INTEGER NOT NULL
);
CREATE TABLE handled_messages (
  route_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  handled_at INTEGER NOT NULL,
  PRIMARY KEY (route_id, message_id)
);
CREATE TABLE handled_message_versions (
  route_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  modified_at INTEGER NOT NULL,
  fingerprint TEXT,
  PRIMARY KEY (route_id, message_id)
);
CREATE TABLE session_generations (
  thread_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE route_wake_overrides (
  route_id TEXT PRIMARY KEY,
  humans TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE discussions (
  space_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  object_name TEXT,
  object_type TEXT,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, object_id)
);
CREATE TABLE codex_acp_sessions (
  session_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  response_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  hop INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE run_messages (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, message_id)
);
CREATE TABLE session_bindings (
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
CREATE TABLE outbound_outbox (
  item_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  route_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  discussion_root_id TEXT,
  operation TEXT NOT NULL,
  target_message_id TEXT,
  reply_to_message_id TEXT,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE TABLE runtime_capabilities (
  runtime TEXT PRIMARY KEY CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
  capabilities_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE output_cycles (
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
CREATE TABLE proactive_deliveries (
  runtime TEXT NOT NULL CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
  native_session_key TEXT NOT NULL,
  native_event_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  payload_hash TEXT,
  message_id TEXT,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY(runtime, native_session_key, native_event_id)
);
CREATE TABLE bridge_cursors (
  bridge_id TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(bridge_id, stream_key)
);
CREATE TABLE session_workspaces (
  thread_key TEXT PRIMARY KEY REFERENCES session_bindings(thread_key) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE session_workspace_overrides (
  thread_key TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE conversation_models (
  thread_key TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK(runtime IN ('openclaw','codex-acp','codex-app')),
  requested_model_id TEXT,
  use_default INTEGER NOT NULL DEFAULT 0 CHECK(use_default IN (0,1)),
  applied_model_id TEXT,
  default_model_id TEXT,
  catalog_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  applied_generation INTEGER
);
CREATE TABLE control_messages (
  message_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE control_activations (
  route_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_runs_thread ON runs(route_id, thread_key, started_at);
CREATE INDEX idx_runs_response ON runs(response_message_id);
CREATE INDEX idx_run_messages_message ON run_messages(message_id);
CREATE INDEX idx_session_bindings_route ON session_bindings(route_id, thread_key);
CREATE UNIQUE INDEX idx_session_bindings_native_id
  ON session_bindings(runtime, native_session_id) WHERE native_session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_output_cycles_open ON output_cycles(thread_key) WHERE state='open';
CREATE INDEX idx_output_cycles_thread ON output_cycles(thread_key, sequence);
CREATE INDEX idx_outbound_ready ON outbound_outbox(status, available_at, created_at);
CREATE INDEX idx_outbound_thread ON outbound_outbox(thread_key, created_at);
CREATE INDEX idx_proactive_deliveries_thread
  ON proactive_deliveries(thread_key, delivered_at);
CREATE INDEX idx_control_activations_window
  ON control_activations(route_id, thread_key, created_at);

INSERT INTO cursors VALUES (
  'chat:_space_fixture_01:_chat_fixture_01', '0000000000000042', 1700000000000
);
INSERT INTO handled_messages VALUES (
  'chat:_space_fixture_01:_chat_fixture_01', '_message_historical_01', 1700000001000
);
INSERT INTO handled_message_versions VALUES (
  'chat:_space_fixture_01:_chat_fixture_01', '_message_historical_01', 1700000001000,
  'b7eaeb6ae3db8b48fcdce672875818f1df8d861cc3ceecb7a4f726d44818a587'
);
INSERT INTO session_generations VALUES (
  'chat:_space_fixture_01:_chat_fixture_01', 2, 1700000002000
);
INSERT INTO route_wake_overrides VALUES (
  'chat:_space_fixture_01:_chat_fixture_01',
  '{"humans":"mention-or-reply","allowedUsers":["_participant_fixture_admin_01"]}',
  1700000003000
);
INSERT INTO session_bindings VALUES (
  'chat:_space_fixture_01:_chat_fixture_01',
  'chat:_space_fixture_01:_chat_fixture_01',
  '_space_fixture_01', '_chat_fixture_01', NULL, 'codex-acp',
  'aag:chat:_space_fixture_01:_chat_fixture_01:g2', '_session_fixture_01', 2,
  'event-fixture-7', 'active', 1700000002000, 1700000004000
);
INSERT INTO outbound_outbox VALUES (
  '_outbox_fixture_01', 'chat:_space_fixture_01:_chat_fixture_01',
  'chat:_space_fixture_01:_chat_fixture_01', '_space_fixture_01', '_chat_fixture_01', NULL,
  'edit', '_response_fixture_01', NULL, '{"text":"fixture response already delivered"}',
  'aag:fixture:response:dedupe-01', 'delivered', 1, 1700000004000, NULL, NULL, NULL,
  1700000004000, 1700000005000, 1700000005000
);

PRAGMA user_version = 6;
