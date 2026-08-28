# Anytype Agent Gateway

[![CI](https://github.com/imai-studio/anytype-agent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/imai-studio/anytype-agent-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Anytype Agent Gateway (AAG) runs one OpenClaw or Codex agent as one Anytype member. A long-lived `aag run` process watches the configured chats and object discussions, decides when that member should wake, supplies Anytype context to the runtime, and projects the run back into Anytype as an editable reply.

The detailed system design is in [ARCHITECTURE.md](ARCHITECTURE.md). The early alternatives and trade-offs that shaped it are preserved in [docs/architecture-decisions.md](docs/architecture-decisions.md).

The current deployment model is deliberately simple: **one AAG process, one Anytype identity, and one runtime-backed agent per machine**. That identity may join multiple spaces and the configuration may subscribe it to multiple chats and discussion sets. Run another machine or isolated service account for another independently taggable agent.

## Implemented behavior

- Resolves spaces and chats by exact ID or exact name through the Anytype API `2025-11-08`.
- Baselines existing history on first start, catches up through the REST API before every stream connection, then consumes Anytype's server-sent chat events without replaying handled requests.
- Supports human wake modes `mention`, `mention-or-reply`, `every-message`, `prefix`, and `disabled`, independently for each configured chat or a space's object discussions.
- Supports peer-agent wake modes `never`, `direct-mention`, and `every-message`, with allowed-sender lists, hop limits, and an activation circuit breaker.
- Posts a reply immediately, adds a configurable working reaction, edits that reply with progress, and removes the reaction when the run finishes.
- Treats a qualifying follow-up during an active run as steering. The gateway freezes the previous progress reply, creates a new reply beneath the follow-up, and continues there.
- Preserves every reply created by a steered run so a later reply to any of them is still recognized as a follow-up.
- Allows a runtime to stay silent by returning exactly `[[AAG_STAY_SILENT]]` or `[[AAG_STAY_SILENT: reason]]`. The placeholder can be deleted, retained, or replaced according to configuration.
- Builds bounded context from recent messages, reply ancestry, the object owning a discussion, and objects referenced by Anytype marks.
- Converts explicit `[[AAG_MENTION:Peer Name]]` output for configured peers into real Anytype mention marks, bounded by `coordination.maxFanout`.
- Stores route baselines, content fingerprints for edited-message idempotency, runs, durable Codex session IDs, and discovered discussions in SQLite using WAL mode.
- Serializes projection edits, applies run/API timeouts, reconciles interrupted placeholders/reactions on restart, cancels active runs cleanly on shutdown, and holds a state-file singleton lock.

The repository includes two runtime adapters:

- **OpenClaw native Gateway.** AAG connects to OpenClaw's authenticated WebSocket Gateway, starts the configured agent and session, receives tool and text events, uses `sessions.steer` for follow-ups, and reads the final chat reply when needed. OpenClaw's agent, workspace, and tool settings must enforce project access.
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

The repository includes its compiled `dist` output, so this command does not need to run package build scripts. To install a specific revision, append a branch, tag, or commit, for example `github:imai-studio/anytype-agent-gateway#v0.1.0` after that tag exists.

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

spaces:
  - name: IMAI Studio Inc.
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
  defaultProject: /absolute/path/to/default-project
  allowedProjects: []

responses:
  mode: single
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

Anytype participant IDs can be space-scoped. When one identity joins multiple spaces, set `spaces[].participantId` for each space; it overrides `agent.participantId` for self-filtering and mention matching on that space's routes.

For OpenClaw, AAG loads `gateway.clientModule` dynamically. The npm name shown by the schema default is not available in every OpenClaw distribution, so a source installation should normally use the absolute path to its built `packages/gateway-client/dist/index.mjs`. The Gateway token is read from the environment variable named by `gateway.tokenEnv` (default `OPENCLAW_GATEWAY_TOKEN`) or from `gateway.configFile`; it is never included in an agent prompt.

For Codex, the npm package includes `codex-acp`; the default `command: codex-acp` resolves that packaged executable automatically and falls back to `PATH` in source/operator-managed layouts. `runtime.defaultProject` becomes the ACP session working directory and `allowedProjects` become ACP additional directories. These are declarations to the ACP implementation, not a security sandbox. `runtime.permissions` is `deny` by default; `allow-once` selects an available one-run allow option for permission requests. For OpenClaw, project values are context declarations only; configure actual filesystem/tool permissions in OpenClaw.

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

- `allowedUsers` accepts stable Anytype creator/participant IDs only. `["*"]` explicitly allows every member, but is discouraged outside a tightly controlled test channel. Display names are never authorization identifiers.
- `humans: mention-or-reply` is useful for conversational agents because a reply to the agent's recorded response can steer it without another mention.
- `humans: every-message` implements a group-listener style agent. Use it only in a tightly scoped chat and combine it with `allowedUsers` when appropriate.
- `agents` applies only to creators listed in `coordination.peers` or the legacy `coordination.agentParticipants` list. A peer entry supplies a stable participant ID plus the name/aliases used for outbound coordination.
- `responses.mode: single` keeps the placeholder stable until the final answer. `milestones` exposes tool lifecycle milestones; `verbose` also streams text deltas and status output, with edits coalesced to avoid excessive API writes.

Silence is a runtime decision, not an Anytype tool call. The prompt tells the runtime about the exact marker; AAG then applies `silentPlaceholder` to the current reply.

To coordinate with another configured agent, the runtime must output `[[AAG_MENTION:Peer Name]]`. AAG replaces a recognized peer marker with visible `@Peer Name` text and a real Anytype mention mark. Unknown markers remain literal, repeated references to one peer consume one fan-out slot, and no more than `maxFanout` distinct peers are marked. Incoming agent messages are still subject to that route's `agents` policy, authorization list, hop limit, and activation circuit breaker.

## Object discussions

Anytype's public API currently exposes chat messages but not the mapping from an object to its internal discussion ID. AAG therefore keeps this feature in an explicit compatibility adapter:

1. The public API searches objects in the configured space.
2. `aag-heart-adapter` calls the local/private Heart gRPC API and reads the object's `discussionId`.
3. AAG caches the mapping in SQLite and subscribes to the discussion using the normal chat message API. Each root comment thread receives its own runtime session and active-run lane; its context is filtered to that root thread while still including the owning object.

The adapter authenticates with the `sessionToken` in the official CLI config (normally `~/.anytype/config.json`) and defaults to Heart gRPC at `127.0.0.1:31010`. Keyring-only CLI sessions are not supported by this adapter. `comments.createMissing: true` asks Heart to add a discussion to objects that do not have one and is therefore a workspace mutation; it defaults to `false`.

Use `comments.mode: filtered` with `includeObjectTypes`/`excludeObjectTypes` for large spaces. Discovery is periodic and relies on private, version-pinned behavior, so it should be monitored after Anytype upgrades.

## Security model

- Store the Anytype API key outside the repository, readable only by the service user. AAG reads it from `anytype.apiKeyFile`.
- Prefer one dedicated Anytype identity and operating-system account per independently trusted agent. Invite it only to the spaces it needs and revoke its API key when retiring it.
- Keep Anytype HTTP, Heart gRPC, and OpenClaw Gateway listeners on loopback or an authenticated private network. AAG does not add TLS or network authentication in front of them.
- Sender allowlists and wake policies control activation; they are not filesystem sandboxes.
- Codex and OpenClaw project lists tell the runtime which directories to use. Enforce filesystem and tool access in the runtime settings, sandbox, service account, or container. AAG cannot contain a runtime that escapes those controls.
- Prompts label channel/object content as untrusted, but content can still attempt prompt injection. Apply runtime tool and approval policies appropriate to the workspace.
- SQLite contains message IDs, run metadata, and discovered object/discussion metadata. Protect the state directory as workspace metadata.

## Current limitations

- One process owns one Anytype identity/runtime agent. Multi-agent deployments use separate machines or isolated service instances.
- Progress is text-only and truncated to `responses.maxCharacters`; AAG does not project rich blocks or attachments.
- The singleton lock prevents two local processes from using one state file. It is not a distributed lease; do not run the same identity/configuration from multiple machines.
- Reconnect catch-up and orphan-reply reconciliation cover interrupted dispatch, while startup reconciliation clears a stale working reaction and marks an already-recorded interrupted run. SQLite is still not a durable distributed job queue.
- Discussion discovery depends on the private Heart protocol pinned in this repository and may require an adapter update when Anytype changes.
- The OpenClaw Gateway client module path is distribution-specific.

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
