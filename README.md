# Anytype Agent Gateway

[![CI](https://github.com/imai-studio/anytype-agent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/imai-studio/anytype-agent-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Anytype Agent Gateway (AAG) runs one OpenClaw or Codex agent as one Anytype member. A long-lived `aag run` process watches the configured chats and object discussions, decides when that member should wake, supplies Anytype context to the runtime, and projects the run back into Anytype as an editable reply.

The detailed system design is in [ARCHITECTURE.md](ARCHITECTURE.md). The early alternatives and trade-offs that shaped it are preserved in [docs/architecture-decisions.md](docs/architecture-decisions.md).

The current deployment model is deliberately simple: **one AAG process, one Anytype identity, and one runtime-backed agent per machine**. That identity may join multiple spaces and the configuration may subscribe it to multiple chats and discussion sets. Run another machine or isolated service account for another independently taggable agent.

## Implemented behavior

- Resolves spaces and chats by exact ID or exact name and can discover newly created chats through the Anytype API `2025-11-08`.
- Baselines existing history on first start, catches up through the REST API before every stream connection, then consumes Anytype's server-sent chat events without replaying handled requests.
- Supports human wake modes `mention`, `mention-or-reply`, `every-message`, `prefix`, and `disabled`, independently for each configured chat or a space's object discussions.
- Supports peer-agent wake modes `never`, `direct-mention`, and `every-message`, with allowed-sender lists, hop limits, and an activation circuit breaker.
- Adds a configurable working reaction to the triggering user message, posts a reply immediately, edits that reply with progress, and removes the reaction when the run finishes.
- Streams safe thinking/progress into that first reply, replaces it with the following answer text in the same message, and gives each later assistant text part its own streamed message.
- Treats a qualifying follow-up during an active run as steering. The gateway freezes the previous progress reply, creates a new reply beneath the follow-up, and continues there.
- Starts a fresh persisted harness session for the current chat or comment thread when an authorized wake message contains `/new`; an active run is replaced instead of steered.
- Discovers models from the connected harness and keeps an independent model choice per chat or object discussion.
- Preserves every reply created by a steered run so a later reply to any of them is still recognized as a follow-up.
- Allows a runtime to stay silent by returning exactly `[[AAG_STAY_SILENT]]` or `[[AAG_STAY_SILENT: reason]]`. The placeholder can be deleted, retained, or replaced according to configuration.
- Builds bounded context from recent messages, reply ancestry, the object owning a discussion, and objects referenced by Anytype marks.
- Converts explicit `[[AAG_MENTION:Peer Name]]` output for configured peers into real Anytype mention marks, bounded by `coordination.maxFanout`.
- Stores route baselines, content fingerprints, response IDs, native session bindings, delivery deduplication, bridge cursors, and durable outbound work in SQLite using WAL mode.
- Uses AAG inactivity and maximum-run watchdogs independently. Both are disabled by default, so AAG does not fail a healthy run at 900 seconds; native OpenClaw, harness, or provider limits may still apply.
- Gives connected harnesses policy-mediated tools to search, read, create, update, organize, upload, and optionally archive objects in explicitly allowed Anytype spaces.

The repository includes two runtime adapters:

- **OpenClaw Gateway plus native Anytype channel.** AAG uses the authenticated Gateway for starts, cancellation, and true `sessions.steer`. The bundled OpenClaw channel plugin binds that same session to its Anytype route and durably forwards assistant output from cron jobs, heartbeats, subagents, and external continuations. It does not introduce a second session or scheduler.
- **Codex over ACP.** AAG starts `codex-acp`, saves and resumes one ACP session per Anytype conversation, streams agent and tool updates, and uses ACP steering. AAG reports steering failures instead of canceling and sending the prompt again, which could repeat tool side effects. It denies permission requests by default or can allow one request for the current run. ACP project settings tell Codex which directories to use, but they do not restrict filesystem access.

Claude Code is not part of this release.

## Requirements

- Node.js 24 or newer (AAG uses the built-in `node:sqlite` module).
- A reachable Anytype API and a revocable API key owned by the bot identity.
- The official Anytype CLI when creating/joining a headless identity.
- OpenClaw with its Gateway running, or a working `codex-acp` command.
- Go 1.25.7 only when building the optional object-discussion adapter.
- Linux with systemd user services or macOS with launchd for `aag service ...`; other platforms can run AAG in the foreground or under their own supervisor.

Anytype Desktop normally exposes its API at `http://127.0.0.1:31009`. When AAG runs on another machine, keep the API loopback-only and forward it over SSH or another authenticated private transport. Set `anytype.apiBase` to the forwarded address; AAG does not create or manage that tunnel.

## Install

Install the CLI directly from GitHub with pnpm:

```bash
pnpm add --global github:imai-studio/anytype-agent-gateway
aag --version
```

The repository includes its compiled `dist` output, so this command does not need to run package build scripts. To install a specific revision, append a branch, tag, or commit, for example `github:imai-studio/anytype-agent-gateway#v0.1.2` after that tag exists.

If you are handing this repository to Codex, OpenClaw, or another coding agent to configure, point it to [AGENTS.md](AGENTS.md) and [the agent setup runbook](docs/agent-setup.md). They define the required inputs, safe setup sequence, validation checks, and runtime-specific configuration.

To build from source instead:

```bash
git clone https://github.com/imai-studio/anytype-agent-gateway.git
cd anytype-agent-gateway
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
```

`pnpm link --global` makes the `aag` command available from the current Node installation. You can instead invoke the compiled CLI directly from `dist/cli.js`.

To enable object-discussion discovery, build and install the pinned Heart adapter:

```bash
cd heart-adapter
go build -o aag-heart-adapter .
install -m 0755 aag-heart-adapter ~/.local/bin/aag-heart-adapter
```

The Go module pins `github.com/anyproto/anytype-heart` to `v0.50.10`. Treat an Anytype/Heart upgrade as a compatibility change and test it before changing that pin.

The core gateway and adapter source in this repository are Apache-2.0. The optional adapter links against `anytype-heart`, which is distributed under the Any Source Available License 1.0 and limits permitted use. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before building or distributing the adapter binary.

For OpenClaw, install the bundled channel after installing AAG:

```bash
aag openclaw plugin install
```

`aag openclaw plugin path` prints the packaged directory when an operator wants to inspect or install it manually.

## Create the Anytype member

Creating an identity and API key grants persistent workspace access. Review the invite links and destination key path before running this command:

```bash
aag identity create OpenClaw \
  --invite 'https://invite.any.coop/...' \
  --api-key-file ~/.config/aag/anytype-api-key
```

This delegates account creation, space joining, and revocable API-key creation to the official Anytype CLI, then saves only the API key at mode `0600`. To add the existing machine identity to more spaces later:

```bash
aag join 'https://invite.any.coop/...'
```

An API key created from a human's desktop session does not create a separate bot member. Use a dedicated Anytype CLI account when the agent must have its own taggable name and membership boundary.

## Configure

Start from [examples/openclaw-agent.yaml](examples/openclaw-agent.yaml) or [examples/codex-agent.yaml](examples/codex-agent.yaml). Configuration accepts YAML, JSON, or TOML.

For a safe minimal starting point, use the interactive initializer:

```bash
aag init --output ~/.config/aag/agent.yaml
```

`aag init` is the guided setup path. It asks for the agent identity, Anytype space and sender allowlist, runtime, permissions, and workspace. The workspace defaults to the directory where the command is run. For Codex it can create or extend that workspace's `AGENTS.md`, enables compact workspace instructions, and opts newly created ACP tasks into the matching saved Codex Desktop project.

It asks for the agent participant ID, API-key file, exact space/chat IDs, authorized participant IDs, runtime, and optional default project. It writes a new mode-`0600` file and refuses to overwrite an existing one. The generated chat uses `mention-or-reply`, rejects agent-authored messages, and leaves object discussions disabled.

An abbreviated OpenClaw configuration looks like this:

```yaml
version: 1
agent:
  name: OpenClaw
  participantId: _participant_replace_me
  aliases: [claw]

anytype:
  apiBase: http://127.0.0.1:31012
  apiKeyFile: ~/.config/aag/anytype-api-key
  heartAdapter:
    command: aag-heart-adapter
    grpcAddress: 127.0.0.1:31010

directMessages:
  enabled: true
  discoveryIntervalSeconds: 30
  wake:
    humans: every-message
    agents: never
    allowedUsers: [_participant_replace_with_authorized_human_id]

spaces:
  - name: IMAI Studio Inc.
    chatDiscovery:
      enabled: true
      autoEnroll: true
      discoveryIntervalSeconds: 30
      wake:
        humans: mention-or-reply
        agents: direct-mention
        allowedUsers: [_participant_replace_with_authorized_human_id]
    chats:
      - name: sandbox
        wake:
          humans: mention-or-reply
          agents: direct-mention
          allowedUsers: [_participant_replace_with_authorized_human_id]
    comments:
      mode: disabled

runtime:
  kind: openclaw
  command: openclaw
  agentId: main
  gateway:
    url: ws://127.0.0.1:18789
    configFile: ~/.openclaw/openclaw.json
    clientModule: /absolute/path/to/openclaw/packages/gateway-client/dist/index.mjs
    protocolVersion: 4
  channelBridge:
    enabled: true
    url: http://127.0.0.1:18791
    tokenEnv: AAG_OPENCLAW_BRIDGE_TOKEN
    tokenFile: ~/.config/aag/openclaw-bridge-token
    accountId: default
    pollIntervalMilliseconds: 500
  inactivityTimeoutSeconds: 0
  maxRunSeconds: 0
  defaultProject: /absolute/path/to/default-project
  allowedProjects: []

tools:
  anytype:
    enabled: true
    allowWrite: true
    allowArchive: false
    allowedSpaceIds: [_space_replace_me]
    allowedFileRoots: [/absolute/path/to/default-project]

responses:
  mode: single
  streaming: true
  thinking: stream
  editIntervalMilliseconds: 900
  workingText: Working…
  workingReaction: 👀
  silentPlaceholder: delete

coordination:
  peers:
    - name: Codex
      participantId: _participant_replace_with_codex_bot_id
      aliases: [codex]
  maxHops: 3
  maxFanout: 4
  maxActivationsPerThread: 12
  windowSeconds: 300

state:
  path: ~/.local/state/aag/state.sqlite
```

Set `agent.participantId` to the bot member's stable Anytype participant ID. AAG uses it to match structured mentions, ignore its own messages, reconcile reactions, and recover orphan replies. `agent.aliases` accepts textual forms such as `@claw`, but structured Anytype mention marks take priority.

When `chatDiscovery.autoEnroll` is enabled, a direct mention from someone in the discovery wake allowlist persists that chat as an explicit route in the agent configuration before processing the message. Unauthorized mentions never enroll a chat. Discovery remains active so the same trusted user can introduce the agent to channels created later. Because managed updates serialize the YAML document, keep explanatory notes in source-controlled example files rather than comments inside the live agent configuration.

`directMessages` is disabled by default. When enabled, AAG discovers newly created Anytype one-to-one spaces across the agent identity, verifies the other active member against `wake.allowedUsers`, and subscribes to that DM's chats. Direct messages always use `humans: every-message`; the sender does not need to mention the agent. Wildcard access is rejected, and shared spaces are never treated as DMs. Use stable Anytype identity IDs in the allowlist so the same authorized person matches their space-scoped participant ID safely.

Anytype participant IDs can be space-scoped. When one identity joins multiple spaces, set `spaces[].participantId` for each space; it overrides `agent.participantId` for self-filtering and mention matching on that space's routes.

Wake allowlists deliberately treat a bare Anytype identity and that identity's space-scoped `_participant_…_<identity>` forms as the same member. This lets one owner entry authorize the same account across configured spaces. Access is identity-scoped and cannot be narrowed to only one space membership.

For OpenClaw, AAG loads `gateway.clientModule` dynamically. The npm name shown by the schema default is not available in every OpenClaw distribution, so a source installation should normally use the absolute path to its built `packages/gateway-client/dist/index.mjs`. The Gateway token is read from the environment variable named by `gateway.tokenEnv` (default `OPENCLAW_GATEWAY_TOKEN`) or from `gateway.configFile`; it is never included in an agent prompt.

### Native OpenClaw session output

The bundled channel plugin runs inside OpenClaw. AAG registers its exact Gateway session key and Anytype route with the plugin before starting a run, then pulls the plugin's durable local outbox. This keeps one native OpenClaw session per Anytype chat or discussion root while preserving Gateway steering.

Configure the same random token, at least 24 characters long, in a mode-`0600` file selected by `runtime.channelBridge.tokenFile` (or the environment variable selected by `tokenEnv`) and in OpenClaw's `channels.anytype.bridgeToken`. A token file is usually more reliable for a service because it does not depend on interactive shell environment propagation. Keep the plugin listener on loopback. A minimal OpenClaw block is:

```json5
{
  channels: {
    anytype: {
      enabled: true,
      listenHost: "127.0.0.1",
      listenPort: 18791,
      bridgeToken: "${AAG_OPENCLAW_BRIDGE_TOKEN}",
      databasePath: "/home/agent/.openclaw/anytype/default.sqlite",
      allowFrom: ["_participant_authorized_human_id"],
    },
  },
  mcp: {
    servers: {
      aag_anytype: {
        command: "aag",
        args: ["mcp", "--config", "/home/agent/.config/aag/agent.yaml"],
      },
    },
  },
}
```

AAG pulls and acknowledges the plugin's durable loopback outbox; the plugin does not expose a push-delivery setting. OpenClaw's native scheduler remains the scheduler. Once a session has been bound, heartbeat, subagent, and externally continued assistant output can return to the same Anytype route. AAG mirrors agent output only, not the external user prompt.

OpenClaw gives ordinary cron `agentTurn` jobs a separate `agent:…:cron:…` session. To keep one session per Anytype chat or discussion, call `aag_context` with the route metadata from the prompt and schedule the returned `continuation_argv` as an OpenClaw **command job**. That argv runs `openclaw agent` against the exact bound session and explicitly delivers through the native `anytype` channel target. Replace only `<scheduled prompt>`; keep the returned session key and target unchanged. AAG supplies this recipe and carries the resulting message, but it neither parses the schedule nor stores a cron definition. After `/new`, call `aag_context` again because the bound session key changes.

### Anytype object tools

`aag mcp` exposes `aag_context`; object search and full reads; type, property, tag, template, collection-view, and list-member discovery; create/update/list-membership/upload tools; optional archive; route-bound wake changes; and a self-only profile-image tool. Codex ACP receives it automatically. Add the same command to OpenClaw's native MCP configuration as shown above.

The discovery tools are part of the write workflow, not just metadata helpers. An agent should resolve the target type and property formats, read an existing object before editing it, preserve unrelated properties, and perform the scoped mutation. It can copy the returned `object_ref` token for a compact clickable reference or `object_card` for a full native object attachment; the returned `anytype://` URL is the fallback. That is what lets a scheduled OpenClaw job create a daily object and publish it without receiving the Anytype API key.

The Anytype tool server defaults to off. Turn on `tools.anytype.enabled` only after registering `aag mcp` with the harness. Object writes remain separately off; enable `allowWrite` for an agent that should create or edit objects, and list `allowedSpaceIds`. File upload fails closed unless `allowedFileRoots` is explicit, resolves symlinks, accepts regular files only, and caps each upload at 50 MiB. With those write and file permissions, `aag_set_profile_image` uses the authenticated Heart adapter to upload a PNG, JPEG, WebP, or GIF and update only the signed-in agent identity; callers cannot select another identity. Archive stays separately disabled unless explicitly enabled. The Anytype API key stays in the AAG configuration boundary and is never returned by a tool; because the harness runs under the same operating-system account, use its sandbox or a separate service account if the key file itself must be inaccessible to shell tools.

Incoming chat and discussion attachments are downloaded into the agent workspace under `.aag/attachments/` with private permissions and surfaced as absolute local paths. The same projection scans referenced Anytype object payloads for embedded images, video, audio, PDFs, and other files, so the harness can inspect media attached directly to a message or embedded in an object. Each download is capped at 50 MiB and a turn projects at most twelve files.

Object tools return `object_ref` for a compact inline reference, `object_card` for a native card attachment, and an `anytype://` deep-link fallback. A shared MCP process can pass `route_id` to `aag_set_wake`; a route-bound process may omit it. With one allowed space, the MCP process also uses that space as its safe default.

For Codex, the npm package includes `codex-acp`; the default `command: codex-acp` resolves that packaged executable automatically and falls back to `PATH` in source/operator-managed layouts. `runtime.defaultProject` becomes the ACP session working directory and `allowedProjects` become ACP additional directories. These are declarations to the ACP implementation, not a security sandbox. `runtime.permissions` is `deny` by default; `allow-once` selects an available one-run allow option for permission requests. For OpenClaw, project values are context declarations only; configure actual filesystem/tool permissions in OpenClaw.

Set `runtime.desktopProject: auto` when this agent runs beside Codex Desktop. AAG then associates every ACP-created task with the saved local Codex project whose root exactly matches its workspace; if no exact saved project exists, it leaves the task ungrouped. Set `tools.codex.enabled: true` to expose `aag_create_codex_task`. That tool starts a separate persistent Codex task only in `defaultProject` or `allowedProjects`, then associates it with the matching saved Codex Desktop project.

When Anytype writes are also enabled, AAG exposes `aag_create_bound_chat`. In one operation it creates a new Anytype chat, starts a Codex task in a configured project, and persists their one-to-one binding. The returned chat route keeps loading that exact Codex task and keeps its Codex Desktop project association on later turns. If the complete relationship cannot be established, AAG does not report the pair as bound and reports any externally created resources that need attention. Ordinary Anytype turns continue in their existing one-task-per-chat or discussion session.

## Validate and run

```bash
aag validate --config ~/.config/aag/agent.yaml
aag doctor --config ~/.config/aag/agent.yaml
aag run --config ~/.config/aag/agent.yaml
```

`doctor` checks the API key file, resolves every configured space/chat, checks the Heart adapter when discussions are enabled, probes the chosen runtime, and verifies declared project paths. Keep the foreground process running for an end-to-end Anytype test before installing it as a service.

Install the exact CLI and configuration as a user service:

```bash
aag service install --config ~/.config/aag/agent.yaml
aag service status
aag service logs
```

Other supported service commands are `restart` and `stop`. Linux installation writes and enables `~/.config/systemd/user/anytype-agent-gateway.service`; macOS writes and bootstraps `~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist` and keeps private logs in `~/Library/Logs/AnytypeAgentGateway`. A static Linux reference unit is available at [deploy/anytype-agent-gateway.service](deploy/anytype-agent-gateway.service), but `aag service install` is preferred because it records the actual Node, CLI, and configuration paths.

When `anytype.apiBase` is the local headless default `127.0.0.1:31012`, service installation also creates a minimal `anytype.service` if one does not already exist and makes AAG depend on it. An existing operator-owned unit is never overwritten. For forwarded or remote Anytype API endpoints, AAG leaves that transport lifecycle to the operator.

## Wake and response configuration

Each chat and the discussion policy in each space has an independent `wake` block.

Every configured chat must include its `wake` block; there is no implicit broad chat policy. Object discussions default to `comments.mode: disabled` and therefore require an explicit opt-in.

- `allowedUsers` accepts Anytype participant IDs or their stable identity suffixes. A stable suffix authorizes the same person across space-scoped participant IDs. `["*"]` explicitly allows every member, but is discouraged outside a tightly controlled test channel. Display names are never authorization identifiers.
- `humans: mention-or-reply` is useful for conversational agents because a reply to the agent's recorded response can steer it without another mention.
- `humans: every-message` implements a group-listener style agent. Use it only in a tightly scoped chat and combine it with `allowedUsers` when appropriate.
- `agents` applies only to creators listed in `coordination.peers` or the legacy `coordination.agentParticipants` list. A peer entry supplies a stable participant ID plus the name/aliases used for outbound coordination.
- `spaces[].chatDiscovery` is disabled by default. When enabled with its own required `wake` block, AAG subscribes to current and newly created chats in that space. Existing history is baselined; a bounded recent tail is checked when a chat appears after startup so its first mention is not lost.
- `directMessages` is disabled by default. When enabled with `humans: every-message` and an explicit sender allowlist, AAG discovers current and newly created `anytype.onetoone` spaces and subscribes only when the peer is authorized.
- `responses.streaming: true` edits the stable reply with text as the runtime produces it. Streaming is enabled by default and coalesced to avoid excessive API writes; set it to `false` to keep the placeholder unchanged until the final answer. `responses.mode: single` hides tool and status chatter, `milestones` exposes tool lifecycle milestones, and `verbose` also exposes runtime status output.
- `responses.thinking: stream` displays only the safe progress/thinking text emitted by the harness. It does not expose hidden model chain-of-thought. AAG renders current thinking and milestone tool titles as a compact, plain-text `Working…` activity feed, keeps only the latest four items, and updates a tool item in place when it completes. The first following assistant text replaces that feed in the same message; later assistant parts get separate messages. `editIntervalMilliseconds` controls edit coalescing.
- `runtime.inactivityTimeoutSeconds` and `runtime.maxRunSeconds` are independent. A `maxRunSeconds` value of `0` means AAG does not request or enforce a run cap and keeps using bounded `agent.wait` long polls; OpenClaw, its harness, and the model provider may still apply their own native limits. Set an AAG maximum only when the operator intentionally wants an additional hard cap.

An authorized wake message containing `/new` increments the persistent session generation for that chat or comment thread. AAG starts a fresh OpenClaw/ACP session with only the current message and directly referenced object context. For example, `@Anya /new plan the release` starts cleanly with “plan the release”; if another run is active, AAG marks its reply as replaced and does not steer it.

### Per-conversation models

AAG asks the harness for its live model catalog instead of maintaining a second provider registry. Codex uses ACP session configuration; OpenClaw uses its gateway model catalog and session override. The choice is persisted per Anytype chat or root object-discussion thread.

- `/models` lists the models allowed by `models.allowed`.
- `/model` shows the current model.
- `/model <id-or-number>` changes the model for this conversation.
- `/model default` restores the harness default.
- `/new --model <id>` starts a fresh session with that model.

Changing a model requires `management.allowModelChanges: true` and a stable sender ID in `management.modelAdmins`. Listing models is read-only. If a run is active, a plain `/model` change is saved and applies after that run; `/new --model` replaces the active run and applies the choice to the fresh session. The agent can use the constrained `aag_list_models` and `aag_set_model` tools when the Anytype tool server is enabled. Operators can inspect or change cached state with `aag config models --thread-key ...` and `aag config model --thread-key ... --model ...`.

```yaml
models:
  enabled: true
  allowed:
    - "*" # Prefer provider/model globs in shared deployments.

management:
  allowModelChanges: true
  modelAdmins:
    - _participant_owner_id
```

Silence is a runtime decision, not an Anytype tool call. The prompt tells the runtime about the exact marker; AAG then applies `silentPlaceholder` to the current reply.

To coordinate with another configured agent, the runtime must output `[[AAG_MENTION:Peer Name]]`. AAG replaces a recognized peer marker with visible `@Peer Name` text and a real Anytype mention mark. Unknown markers remain literal, repeated references to one peer consume one fan-out slot, and no more than `maxFanout` distinct peers are marked. Incoming agent messages are still subject to that route's `agents` policy, authorization list, hop limit, and activation circuit breaker.

## Object discussions

Anytype's public API currently exposes chat messages but not the mapping from an object to its internal discussion ID. AAG therefore keeps this feature in an explicit compatibility adapter:

1. The public API searches objects in the configured space.
2. `aag-heart-adapter` calls the local/private Heart gRPC API, reads the object's `discussionId`, and hydrates block-based comment text and mention metadata that the public chat API currently omits.
3. AAG caches the mapping in SQLite and subscribes to the discussion using the public message stream. Discussion replies, edits, and deletions go through Heart's block-based message commands because legacy messages created through the public chat endpoint exist but are not rendered by the object-discussion UI. Each root comment thread receives its own runtime session and active-run lane; its context is filtered to that root thread while still including the owning object. Discussions present when AAG starts are baselined. When a discussion appears while AAG is running, AAG checks a bounded recent tail so the tag that created the discussion is handled and the response is posted as a reply in that same discussion. The working reaction is applied to the triggering comment before AAG creates its reply, making it the acknowledgement that AAG accepted the tag.

Object discussions are flat threads in Anytype: every visible follow-up is attached to the root comment. AAG therefore reacts to the exact triggering follow-up but attaches its response to the thread root. It renders each response line as a native block and converts common Markdown emphasis, links, inline code, headings, and bullets into Anytype rich text. Participants observed or mentioned in the current conversation become safe outgoing mention targets; the harness can use `[[AAG_MENTION:Name]]`, and an exact `@Name` is also converted to a native mention.

### Agent-managed wake behavior

Set `management.allowWakeChanges: true` to let the connected harness change the human wake mode for its current chat or object discussion. AAG identifies itself in the harness prompt and provides a route-bound `aag config wake` command. When an authorized user explicitly says, for example, “listen to every message in this chat,” the agent can apply that setting immediately.

Participant access is a separate permission. Set `management.allowAccessChanges: true` and list stable participant IDs in `management.accessAdmins` to let only those admins ask the agent to add or remove allowed senders on the current route. The constrained `aag config access` command requires the requesting admin's native participant ID, refuses wildcard grants, and prevents an admin from removing an access admin. For example:

```yaml
management:
  allowWakeChanges: true
  allowAccessChanges: true
  allowModelChanges: true
  accessAdmins:
    - _participant_owner_id
  modelAdmins:
    - _participant_owner_id
```

Both commands write a route-specific override to the private agent configuration and mirror the complete wake policy into SQLite, so the running gateway applies the change to the next message without a restart. Neither capability grants general configuration access or changes agent-to-agent wake rules. Both are disabled by default, and the agent is told not to report success unless the constrained command succeeds.

The adapter authenticates with the `sessionToken` in the official CLI config (normally `~/.anytype/config.json`) and defaults to Heart gRPC at `127.0.0.1:31010`. Keyring-only CLI sessions are not supported by this adapter. `comments.createMissing: true` asks Heart to add a discussion to objects that do not have one and is therefore a workspace mutation; it defaults to `false`.

Use `comments.mode: filtered` with `includeObjectTypes`/`excludeObjectTypes` for large spaces. Discovery is periodic and relies on private, version-pinned behavior, so it should be monitored after Anytype upgrades.

## Security model

- Store the Anytype API key outside the repository, readable only by the service user. AAG reads it from `anytype.apiKeyFile`.
- Prefer one dedicated Anytype identity and operating-system account per independently trusted agent. Invite it only to the spaces it needs and revoke its API key when retiring it.
- Keep Anytype HTTP, Heart gRPC, and OpenClaw Gateway listeners on loopback or an authenticated private network. AAG does not add TLS or network authentication in front of them.
- Sender allowlists and wake policies control activation; they are not filesystem sandboxes.
- Codex and OpenClaw project lists tell the runtime which directories to use. Enforce filesystem and tool access in the runtime settings, sandbox, service account, or container. AAG cannot contain a runtime that escapes those controls.
- Prompts label channel/object content as untrusted, but content can still attempt prompt injection. Apply runtime tool and approval policies appropriate to the workspace.
- Anytype MCP tools enforce the configured space/write/archive/file policy. They are a policy boundary, not an operating-system sandbox against a harness running as the same user.
- SQLite contains message IDs, run metadata, and discovered object/discussion metadata. Protect the state directory as workspace metadata.

## Current limitations

- One process owns one Anytype identity/runtime agent. Multi-agent deployments use separate machines or isolated service instances.
- Progress is truncated to `responses.maxCharacters`. AAG projects supported rich-text marks and native Anytype object-card attachments; arbitrary rich blocks and general file attachments are not projected from model text.
- The singleton lock prevents two local processes from using one state file. It is not a distributed lease; do not run the same identity/configuration from multiple machines.
- Reconnect catch-up and orphan-reply reconciliation cover interrupted dispatch, while startup reconciliation clears a stale working reaction and marks an already-recorded interrupted run. SQLite is still not a durable distributed job queue.
- Discussion discovery depends on the private Heart protocol pinned in this repository and may require an adapter update when Anytype changes.
- The OpenClaw Gateway client module path is distribution-specific.
- Codex ACP supports session continuity, streaming, and steering, but it does not expose the Codex desktop scheduled-task system. AAG does not emulate one. Native recurring delivery is currently an OpenClaw capability; a future Codex app-server adapter must provide equivalent session observation before Codex scheduling can be advertised.

## Development checks

```bash
pnpm run check
pnpm run smoke:codex

cd heart-adapter
go test ./...
go build ./...
```

`pnpm run check` builds, lints, and runs the unit/workflow tests. `smoke:codex` requires a real `codex-acp` command and performs live ACP prompt and steering checks.

## Releases

Install AAG from GitHub for now. The command name is `aag`. We plan to publish the same CLI as `@imai/aag`, which will provide a shorter install command. `package.json` holds the release version. After npm trusted publishing is configured, a GitHub release tagged `vX.Y.Z` runs the publish workflow. The tag must match the package version exactly.

The workflow uses npm trusted publishing through GitHub Actions OIDC, so release publishing does not require a long-lived npm token in the repository. The initial package publish and trusted-publisher registration are maintainer operations.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for the project notice.
