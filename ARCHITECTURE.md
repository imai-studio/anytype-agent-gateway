# Local architecture

This document describes the local Anytype agent gateway and workflow runner. The released Cloud
connector and publication client have separate guides in
[`docs/cloud-connector.md`](docs/cloud-connector.md) and
[`docs/cloud-publishing.md`](docs/cloud-publishing.md). Read
[`docs/planned-work.md`](docs/planned-work.md) for remaining gaps and
[`docs/publish-architecture.md`](docs/publish-architecture.md) for the Cloud protocol plan.

The workflow observer, runner, executors, and operator CLI are disabled by default while the
representative soak is pending. Their invariants are part of the local release; enabling them is an
explicit operator decision.

[`docs/knot-roadmap.md`](docs/knot-roadmap.md) records the migration history and the order of the
remaining Phase 2 work.

For the alternatives considered and the reasoning behind these boundaries, see [docs/architecture-decisions.md](docs/architecture-decisions.md).

## Deployment invariant

The deployment unit is one Knot process bound to one Anytype member and one runtime-backed agent. A
configuration may include several spaces, chats, and discussion policies. They all use the same
Anytype identity and the same OpenClaw agent or Codex ACP adapter.

```text
one machine / service account
  └── one Knot process
      ├── one Anytype API credential and member identity
      ├── one OpenClaw agent or Codex ACP runtime
      ├── many configured chat/discussion routes
      └── one local SQLite state database
```

An Anytype member maps directly to one agent process. Deploy another isolated process and identity
for another independently taggable agent.

## Data flow

```text
Anytype SSE message event
  → route baseline/idempotency check
  → sender authorization and wake decision
  → bounded channel/reply/object context
  → runtime session prompt
  → working reaction on trigger + immediate Anytype reply
  → coalesced progress edits
  → final edit, silence action, or failure edit
```

The public Anytype API is the primary transport. Knot uses it to resolve routes, list and retrieve
messages, subscribe to server-sent events, create, edit, and delete replies, toggle reactions,
search objects, and fetch referenced-object summaries.

When the local automation gates enable observation, a separate read-only loop searches configured
workflow object type keys in explicitly allowed spaces. It fetches each full object, requires a
native modification timestamp and explicit native editor participant ID, validates the fenced YAML
definition against local authority, and stores a source digest plus immutable normalized event. A
durable per-space page cursor and reconciliation boundary survive restarts. The loop never invokes a
runtime, writes Anytype, or performs external effects.

When `automation.execution` is also enabled, a durable local runner matches normalized events to
enabled workflow versions. SQLite stores deliveries, runs, dependency-ordered steps, attempts, retry
deadlines, cancellation requests, claim leases, and fencing tokens. Every dispatch and resume
rechecks the immutable editor provenance, current local authority, and exact approval hash. The
shipped executor boundary supports bounded Anytype reads, queries, writes, exact-name upserts,
collection materialization, declarative JSON-pointer transforms, named Anytype notifications,
capability-narrowed Codex ACP invocation, and the closed `publish.web` lifecycle.
Raw HTTP and arbitrary code remain unavailable. External effects use durable, immutable receipts;
an interrupted effect with an unknown outcome is dead-lettered instead of repeated. SQLite stores
digests in place of author prompt and message text. A step that needs that text enters
`source_refetch_required`. An executor may resume it only
after a read-only resolver refetches the definition and matches its source revision, editor, version
hash, approval hash, and policy against the immutable record.

Workflow-origin Codex sessions are confined to the explicitly approved workspace, receive no
additional project directories or Anytype MCP server, and deny interactive permission requests.
OpenClaw workflow-agent invocation is disabled until the adapter can enforce an equivalent closed
authority boundary; ordinary OpenClaw conversation and scheduling behavior is unaffected.

Every route has a stable key:

```text
chat:<space-id>:<chat-id>
discussion:<space-id>:<discussion-id>
```

On its first start, a route records the currently visible messages as handled before opening the event stream. This prevents installation from replaying historical messages. Optional per-space chat discovery lists chat objects on a bounded interval and adds routes under the discovery wake policy. The initial discovery pass also baselines history; a chat found on a later pass checks only a bounded recent tail so a mention sent while discovery was pending is not lost. Before every stream connection, including reconnects, Knot lists recent messages and processes any unhandled gap; the stream then reconnects with exponential backoff. A message is recorded as handled after its dispatch path completes, while an in-memory claim suppresses concurrent duplicate delivery. The handled revision includes a content/mark fingerprint as well as Anytype's timestamp, so a final mention-bearing edit remains visible even when the placeholder and final edit share second-resolution timestamps.

If dispatch stops after Knot creates the immediate reply but before it commits the run record, a retry looks for a bot reply under the same trigger. It resumes that reply instead of posting a duplicate. This recovery handles one known failure window; it is not a durable distributed queue.

## Controller and wake policy

`AgentController` owns the active run per route. `wake.ts` classifies each incoming message as self, configured peer agent, or human, then applies that route's policy:

- humans: `mention`, `mention-or-reply`, `every-message`, `prefix`, or `disabled`;
- configured agents: `never`, `direct-mention`, or `every-message`;
- both: `allowedUsers`, which Knot checks only against the stable creator or participant ID. The `"*"` wildcard allows every ID and should be rare. Display names never authorize a sender.

Chat routes have no implicit wake block: each configured chat must declare one. Chat discovery and discussion discovery both default to disabled and require their own wake policy when enabled.

Set `agent.participantId` to the agent's stable Anytype participant ID. Knot uses structured Anytype mention marks for direct mentions and accepts textual `@<name-or-alias>` as a fallback. It ignores self messages by participant ID.

Because Anytype participant IDs may be space-scoped, `spaces[].participantId` can override the agent-level fallback for every route resolved from that space.

Configured `coordination.peers` bind each peer's stable participant ID to a name and aliases. The prompt exposes only those peer names and requires the explicit output marker `[[AAG_MENTION:Peer Name]]`. On the final edit, Knot converts recognized markers to visible `@Peer Name` text with real Anytype mention marks; it marks at most `maxFanout` distinct peers. Unknown or over-limit markers remain literal.

The coordination guard counts recent route activations in SQLite and stops waking after `maxActivationsPerThread` within `windowSeconds`. Messages from configured peer participants also follow their reply ancestry to calculate an agent hop count. Runs beyond `maxHops` are ignored. Outbound marks and inbound agent wake policies therefore use the same configured identity boundary.

## Context assembly

Context is bounded by three configuration values:

- `historyMessages`: recent messages from the active chat/discussion;
- `replyDepth`: the trigger's reply ancestry;
- `referencedObjects`: objects referenced by marks on the trigger.

For an object discussion, the owning object is added to referenced-object context. History is filtered to the trigger's root comment thread, and each root thread gets a distinct session/active-run key; separate comment threads under one object can therefore run independently. The runtime prompt includes route/sender metadata, the current message, reply ancestry, recent thread context, object names/Markdown, and declared project roots. Untrusted data is serialized as JSON inside a randomized boundary and explicitly described as conversation data rather than instructions.

A runtime is not given the Anytype API key or OpenClaw Gateway token in the prompt. Knot supplies a policy-mediated MCP surface for allowed Anytype search/get/create/update/list/upload/archive operations. Codex ACP receives it during session creation; OpenClaw receives the same server through its native MCP configuration. Space, write, archive, and real-path upload policy are evaluated inside Knot. Strong protection from runtime shell access still requires an OS/runtime sandbox because the processes normally share one service account.

Management mutations require native sender provenance. Codex ACP binds that provenance through a private per-turn actor file. Because OpenClaw uses a long-lived MCP process, Knot instead mints opaque single-use capabilities bound to the authenticated participant, exact route, and one management scope. A new human turn revokes unused capabilities for that route; a successful tool authorization consumes its capability. The model can relay the capability but cannot choose or forge the participant identity it represents.

## Run projection and steering

Before the runtime starts, `RunProjection` sends `responses.workingText` as a reply and applies `responses.workingReaction` to the triggering user message. This gives the user an immediate durable acknowledgement without making the agent react to itself.

Runtime events are projected according to `responses.mode`:

- `single`: stream only answer text into the stable reply;
- `milestones`: stream answer text and include tool lifecycle/status milestones;
- `verbose`: stream answer text and include tool and runtime status output.

`responses.streaming` controls incremental edits independently of verbosity and defaults to `true`. Safe thinking/progress temporarily replaces the working text. The first following assistant text replaces that thinking in the same message. A new assistant part starts a new Anytype message, so runtime message boundaries survive projection. A short configurable timer combines nearby deltas. Per-cycle promise chains keep edits ordered, so a progress flush cannot overwrite a move or final edit. Knot truncates each visible cycle to `responses.maxCharacters` and removes the working reaction from the trigger when the run ends.

If a qualifying message arrives while the same chat or root discussion thread has an active run, Knot treats it as steering. Knot flushes the old response, removes the reaction from the previous trigger, reacts to the follow-up, and sends later progress and final output to a new reply beneath it. `run_messages` keeps every response ID, so a reply to an earlier frozen response still counts as a follow-up. Knot does not queue a second run for that thread.

An authorized wake message containing the standalone command token `/new` is the exception to steering. Knot cancels and visibly replaces an active run, increments a SQLite-backed generation for that chat or root comment thread, and starts the runtime with a new session key. Generation zero retains the legacy key, so upgrades preserve existing continuity. A reset prompt excludes earlier channel history and reply ancestry while retaining the current message, route metadata, the owning discussion object, and objects referenced by the current message.

The inactivity watchdog and absolute maximum race the result independently; both are disabled by default. Runtime events reset only the inactivity watchdog. Shutdown aborts route streams, cancels all active handles, clears their working reactions, marks visible replies interrupted, waits for completion paths to settle, and only then closes SQLite and releases the process lock. Startup reconciliation preserves streamed text, appends an interruption notice, restores observers for persisted native-session bindings, and closes stale runs as failed.

The exact runtime result `[[AAG_STAY_SILENT]]` (optionally with a reason after a colon) maps to a silent result. Knot deletes, retains, or replaces the current placeholder according to `responses.silentPlaceholder`.

## Runtime ports

The runtime boundary is the internal `RuntimeDriver` interface:

```text
doctor() → diagnostic lines
start(session key, prompt, event callback)
  → result promise
  → steer(message)
  → cancel()
```

### OpenClaw

`OpenClawDriver` loads the configured Gateway client module and opens an authenticated WebSocket connection as an operator with read/write scopes. The token comes from the configured environment variable or OpenClaw JSON config. It sends `agent`, observes agent/tool events keyed by run ID, waits with `agent.wait`, and falls back to `chat.history` when a terminal reply is absent. Steering uses `sessions.steer`; cancellation uses `sessions.abort`.

The bundled `@imai/openclaw-anytype-channel` plugin runs inside OpenClaw. Before the Gateway starts a run, Knot binds that exact session key to the exact Anytype chat or discussion-root route through an authenticated loopback endpoint. The plugin observes assistant/thinking/tool/lifecycle events for bound sessions only and writes them to its SQLite outbox. Knot pulls and acknowledges that outbox, suppresses events belonging to the direct run it already projected, and turns external/scheduled run output into durable Anytype replies. This hybrid keeps Gateway steering and native OpenClaw scheduling while avoiding a second session per route.

One process-wide poller serves all persisted session bindings. It routes each record by exact native session or exact Anytype route, reconstructs chunks by OpenClaw sequence number, and acknowledges a run's event records atomically only after its terminal lifecycle event is durable in Knot. A durable owned-run marker prevents a direct Gateway run from being mirrored after either process restarts. Historical chats and discussion roots therefore do not each create their own HTTP polling loop; unmatched pending records expire after 30 days.

The initial conversation session key is `aag:<route-or-thread-key>`. After `/new`, it becomes `aag:<route-or-thread-key>:g<generation>`. `runtime.sessionKey` adds a prefix instead of replacing the key. OpenClaw owns its agent lifecycle, memory, approvals, tools, and filesystem policy. Knot passes project fields to this adapter as context only.

The Gateway client is not assumed to be independently published by all OpenClaw distributions. A source deployment should point `gateway.clientModule` at the built `GatewayClient` module shipped with that OpenClaw installation.

### Codex ACP

`CodexAcpDriver` starts the configured `codex-acp` process over newline-delimited JSON streams. It initializes ACP and resumes the session ID stored for the Knot conversation key when the agent advertises `loadSession`. Missing or invalid saved sessions are replaced with a new session. Both loaded and new sessions use `defaultProject` as `cwd` and `allowedProjects` as `additionalDirectories`. History replayed by `session/load` is not projected as part of the new answer.

Steering uses the ACP implementation's `_session/steering` extension. A rejected steering request fails the active run explicitly; Knot does not turn it into cancel-and-reprompt behavior. `runtime.permissions` defaults to `deny`, which cancels every permission request. `allow-once` selects an available one-run allow option and still cancels when none exists.

`cwd` and `additionalDirectories` are capability hints to the ACP implementation. Knot reports Codex project enforcement as advisory; operators must configure the Codex sandbox and service-account boundaries separately.

## State model

The SQLite database uses WAL mode and contains:

- `cursors`: whether each route has completed its first-start baseline;
- `handled_messages`: route/message idempotency keys;
- `runs`: trigger, current response, status, hop count, and timing metadata;
- `run_messages`: every response emitted by a run, including frozen responses before a steer;
- `discussions`: object-to-discussion mappings discovered through Heart.
- `codex_acp_sessions`: the durable ACP session ID for each Knot conversation key.
- `session_bindings`: exact Anytype thread to native runtime session identity, generation, and observer cursor.
- `outbound_outbox` and `proactive_deliveries`: retryable Anytype writes and native-output deduplication.
- `runtime_capabilities` and `bridge_cursors`: adapter capability snapshots and durable stream progress.
- `workflow_definitions`, `workflow_approval_subjects`, and `workflow_versions`: discovered workflow
  identity plus immutable full and behavior-bearing versions.
- `workflow_approval_decisions`: an append-only, authority-bound approval ledger.
- `normalized_events`: immutable, deduplicated Phase 2 observation facts.
- `workflow_observer_spaces`: durable definition-search pages, reconciliation boundaries, revision
  watermarks, adaptive intervals, and failure state.
- `workflow_deliveries`, `workflow_runs`, `workflow_steps`, and `workflow_attempts`: durable local
  dispatch, dependency, retry, cancellation, lease, fence, and dead-letter state.
- `workflow_runner_state`: the normalized-event matcher cursor and fair-claim hint.
- `workflow_effect_receipts`: immutable effect preparation and terminal evidence used to prevent
  unsafe replay.
- `workflow_operator_overrides` and `workflow_operator_audit`: durable enable/disable fences and
  append-only, redacted local operator actions.

The workflow tables remain inert while automation gates are disabled. Definition observation uses
them when `automation.observation` is enabled. The runner uses its queue tables only when
`automation.execution` is also enabled. Before an on-disk schema
upgrade, Knot creates a consistent mode-`0600` SQLite snapshot beside the database using `VACUUM
INTO`; it never copies only the main file of a live WAL database.

It is local coordination state, not a durable distributed work queue. The CLI also acquires `<state.path>.lock`, removes a stale lock only after verifying its PID is dead, and refuses to start when another local Knot process owns it. This is a host-local singleton, not cross-machine locking.

## Object-discussion compatibility layer

Anytype's public API currently does not expose the mapping from an object to its internal discussion chat. `knot-heart-adapter` isolates the private dependency behind a small JSON-over-stdio interface; `aag-heart-adapter` remains a discovery alias for existing installations:

```text
Knot public object search
  → adapter stdin { objectIds }
  → Anytype Heart ObjectShow
  → root details.discussionId
  → adapter stdout { discussions }
  → SQLite cache + normal Anytype chat route
```

The Go adapter pins `anytype-heart` `v0.50.10`. It authenticates to the local Heart gRPC service with the official CLI config's `sessionToken`. When `comments.createMissing` is true, it may call `ObjectAddDiscussion`. The default only discovers existing discussions.

The discovery loop searches public objects, filters object types when configured, resolves unknown objects in bounded batches, caches successful mappings, and dynamically starts routes for the resulting discussion IDs. Objects with no discussion are revisited on later scans. A discussion route is further partitioned by root comment thread for context and runtime sessions. Because this is a private protocol, Anytype upgrades require explicit compatibility testing.

## Network and identity boundaries

A typical remote deployment has three separate local interfaces:

- Anytype HTTP API, normally Desktop `127.0.0.1:31009` or an arbitrary loopback SSH-forward endpoint;
- Anytype Heart gRPC, commonly the headless CLI service on a loopback address;
- OpenClaw Gateway WebSocket, normally loopback on the runtime machine.

Knot does not expose, encrypt, or tunnel these interfaces. The operator must keep them private or provide authenticated transport.

The Anytype credential determines the member visible in chats and discussions. A desktop-created key acts as that desktop user; a first-class bot requires a dedicated CLI-created Anytype account, membership through explicit invite links, and its own revocable API key. One identity per service also makes self-message suppression and peer-agent classification deterministic.

## Service lifecycle

The CLI is the operator interface:

```text
identity create / join
  → init (interactive safe config)
  → validate
  → doctor
  → run (foreground end-to-end test)
  → service install/status/logs/restart/stop
```

`knot workflow` is the separate default-off workflow operator surface. It lists redacted workflow,
run, event, audit, and dead-letter state. Exact approval, reject, revoke, enable/disable, manual run,
cancel, and safe retry actions require local state access, an allowlisted actor digest, and explicit
confirmation.

`init` writes a new mode-`0600` configuration and refuses to overwrite a file. It requires stable participant IDs, creates an explicit safe chat wake block, and defaults comments off and Codex permissions to deny.

`service install` creates either a Linux user systemd unit or a macOS launchd agent using the exact Node executable, compiled CLI location, and absolute config path of the invoking installation. The macOS agent uses private log files and orders itself after the existing Anytype headless launch agent when the local API is configured. SIGINT/SIGTERM trigger the graceful cancellation path. The runtime's project/tool access remains a separate security concern.

For a local headless API at `127.0.0.1:31012`, the installer creates `anytype.service` only when no such unit exists and orders Knot after it. Forwarded/remote API endpoints are not managed.

## Explicit non-goals and current gaps

- Knot is not an agent runtime. OpenClaw or Codex handles reasoning, tools, memory, compaction, and approvals.
- It is not an AnySync replacement and does not implement Anytype synchronization.
- It does not manage SSH tunnels, OpenClaw services, Anytype Desktop, or remote Anytype endpoints; its only Anytype lifecycle integration is the optional local headless systemd unit described above.
- Chat ingestion is at-least-once and deduplicated in the local database. The workflow runner and
  outbound outbox have durable retry state, but Knot does not provide cross-machine exactly-once
  delivery.
- It does not attach files or emit rich Anytype blocks; progress and final projections are bounded plain text with optional mention marks.
- It has no Windows service installer yet.
- The Heart adapter is deliberately version-pinned and private-API dependent.
