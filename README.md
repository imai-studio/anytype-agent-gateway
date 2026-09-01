# Knot

[![CI](https://github.com/imai-studio/knot/actions/workflows/ci.yml/badge.svg)](https://github.com/imai-studio/knot/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

Connect a Codex or OpenClaw agent to Anytype as its own taggable member.

Knot watches approved Anytype chats and object discussions, wakes the right agent session, supplies
the relevant context, and streams the response back into the same conversation. One running Knot
process represents one agent identity.

> **Release status:** Knot `0.2.0` is prepared on `main` but is not published to npm yet. Install
> from this checkout while the release is being prepared. The latest tagged compatibility release
> is `v0.1.3` under the former Anytype Agent Gateway name.

[Quick start](#quick-start) · [How it works](#how-it-works) ·
[Configuration](#configuration) · [Documentation](#documentation) ·
[Contributing](CONTRIBUTING.md)

## Why Knot

Anytype gives people a shared place for chats, objects, and discussions. Codex and OpenClaw provide
capable agent runtimes. Knot connects them without replacing either side:

- Each agent appears as a distinct Anytype member that people can mention.
- Each chat or discussion keeps its own persistent runtime session.
- Native Anytype participant IDs control who may wake or reconfigure an agent.
- Codex keeps its project and model selection; OpenClaw keeps its native sessions and scheduler.
- Agent replies, progress, tool milestones, steering, and attachments stay in the Anytype thread.

## Highlights

| Area          | Released behavior                                                                       |
| ------------- | --------------------------------------------------------------------------------------- |
| Conversations | Chats, direct messages, and object discussion threads                                   |
| Wake policy   | Mention, mention or reply, every message, prefix, or disabled per route                 |
| Sessions      | One persisted session per conversation, `/new`, steering, and model selection           |
| Responses     | Editable streaming replies, working reactions, milestones, and multi-part output        |
| Projects      | Codex project binding through `agent-name:project-name` Anytype Chat tags               |
| Anytype tools | Scoped object search, reads, writes, uploads, collection membership, and profile images |
| Media         | Message attachments and media embedded in referenced Anytype objects                    |
| Recovery      | REST catch-up, event streaming, SQLite state, deduplication, and outbound retries       |
| Runtimes      | Codex over ACP and OpenClaw through its Gateway plus native Anytype channel             |

Claude Code is not supported in the current release.

## How it works

```text
Anytype chat or object discussion
                |
                v
      Knot route and identity policy
                |
        +-------+-------+
        |               |
        v               v
   Codex ACP       OpenClaw Gateway
        |               |
        +-------+-------+
                |
                v
     streamed Anytype response
```

Knot uses the public Anytype API for chats and object operations. The optional Heart adapter fills
the current public API gap for object discussion discovery and replies. Runtime access stays local:
Anytype HTTP, Heart gRPC, and OpenClaw listeners should remain on loopback or an authenticated
private network.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the complete released design and
[architecture decisions](docs/architecture-decisions.md) for the trade-offs behind it.

## Quick start

### 1. Install from this checkout

Knot requires Node.js 24 or newer and pnpm 11.

```bash
git clone https://github.com/imai-studio/knot.git
cd knot
pnpm install --frozen-lockfile
pnpm add --global .
knot --version
```

The compiled `dist` directory is committed, so a direct GitHub installation does not need package
build scripts:

```bash
pnpm add --global github:imai-studio/knot
```

Use a tagged source once `v0.2.0` is published:

```bash
pnpm add --global github:imai-studio/knot#v0.2.0
```

### 2. Create or reuse an Anytype member

Give each agent its own Anytype identity. This command delegates identity creation, space joining,
and API-key creation to the official Anytype CLI:

```bash
knot identity create Klee \
  --invite 'https://invite.any.coop/...' \
  --api-key-file ~/.config/knot/anytype-api-key
```

Join another space later with:

```bash
knot join 'https://invite.any.coop/...'
```

Invite links and API keys are sensitive. Keep them out of shell history, logs, issues, and commits.

### 3. Run the guided setup

Run the initializer from the workspace the agent should use. That directory becomes the default
workspace unless you select another one.

```bash
cd /path/to/agent-workspace
knot init --output ~/.config/knot/agent.yaml
```

The initializer asks for the Anytype member, spaces, chats, authorized participant IDs, runtime,
project paths, wake policy, and permissions. It writes a private configuration file and can add the
workspace instructions required by Codex.

Start from a checked-in example when you prefer to edit configuration directly:

- [Codex configuration](examples/codex-agent.yaml)
- [OpenClaw configuration](examples/openclaw-agent.yaml)

### 4. Validate in the foreground

```bash
knot validate --config ~/.config/knot/agent.yaml
knot doctor --config ~/.config/knot/agent.yaml
knot run --config ~/.config/knot/agent.yaml
```

Mention the dedicated member in an authorized Anytype chat and confirm the complete reply flow
before installing a background service.

### 5. Install the service

```bash
knot service install --config ~/.config/knot/agent.yaml
knot service status
knot service logs
```

Knot installs a systemd user service on Linux or a launchd agent on macOS. Other platforms can run
`knot run` under their own process supervisor.

## Requirements

- Node.js 24 or newer and pnpm 11.
- A reachable Anytype API and a revocable API key owned by the agent identity.
- The official Anytype CLI for headless identity creation and space joining.
- A running OpenClaw Gateway or the packaged `codex-acp` runtime.
- Go 1.25.7 only when building the optional Heart adapter.
- Linux or macOS for the built-in service installer.

Anytype Desktop normally exposes its API at `http://127.0.0.1:31009`. A headless Anytype node
normally uses `http://127.0.0.1:31012`. Use SSH forwarding or another authenticated private
transport when Knot runs on a different machine. Do not expose these listeners publicly.

## Configuration

Knot accepts YAML, JSON, or TOML. The guided initializer is the recommended starting point.

```yaml
version: 1

agent:
  name: Klee
  participantId: _participant_replace_me

anytype:
  apiBase: http://127.0.0.1:31009
  apiKeyFile: ~/.config/knot/anytype-api-key

spaces:
  - name: Agents
    chats:
      - name: sandbox
        wake:
          humans: mention-or-reply
          agents: never
          allowedUsers:
            - _participant_replace_with_owner_id
    comments:
      mode: disabled

runtime:
  kind: codex
  defaultProject: /absolute/path/to/agent-workspace
  allowedProjects: []
  permissions: deny

responses:
  streaming: true
  mode: milestones
  workingReaction: 👀

state:
  path: ~/.local/state/knot/state.sqlite
```

This example is intentionally narrow. Every chat needs an explicit wake policy. Object discussions,
direct messages, Anytype writes, archive access, file roots, route self-management, model changes,
and project changes remain disabled until the operator enables and scopes them.

Use immutable Anytype participant or identity IDs in allowlists. Display names, message text,
mentions, replies, and agent claims never grant authority.

### Useful commands

| Command                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `knot init`            | Create a private agent configuration through guided setup      |
| `knot validate`        | Validate configuration and policy without starting the gateway |
| `knot doctor`          | Check Anytype, runtime, adapter, and project connectivity      |
| `knot run`             | Run the gateway in the foreground                              |
| `knot service install` | Install the configured agent as a user service                 |
| `knot service status`  | Show service state                                             |
| `knot service logs`    | Read private service logs                                      |
| `knot mcp`             | Start the policy-mediated Anytype tool server                  |
| `knot join`            | Join another Anytype space with the current identity           |

Inside an authorized Anytype chat, `/new` starts a fresh harness session. Codex-backed agents also
support `/projects`, `/project <name>`, `/models`, and `/model <id>` when the operator enables the
matching management permissions.

## Runtime notes

### Codex

Knot starts the packaged `codex-acp`, stores one ACP session per Anytype conversation, streams agent
and tool updates, and uses ACP steering. `runtime.defaultProject` sets the working directory.
`allowedProjects` supplies additional project choices but is not a filesystem sandbox. Enforce real
access through Codex permissions, its sandbox, or a separate operating-system account.

Set `runtime.desktopProject: auto` to associate created ACP tasks with the saved Codex Desktop
project whose root exactly matches the workspace. A Chat tag such as `klee:imai` binds future
`/new` sessions for Klee to the configured project named `imai`.

### OpenClaw

Knot uses OpenClaw Gateway for starts, cancellation, and steering. The bundled native Anytype
channel carries output from the same OpenClaw session, including cron jobs, heartbeats, subagents,
and external continuations.

Install the bundled channel with:

```bash
knot openclaw plugin install
```

OpenClaw remains responsible for scheduling. Knot does not create a second scheduler.

### Object discussions

The public Anytype API does not currently expose an object's internal discussion ID. Build the
optional, version-pinned Heart adapter when the agent needs object comments:

```bash
cd heart-adapter
go build -o knot-heart-adapter .
install -m 0755 knot-heart-adapter ~/.local/bin/knot-heart-adapter
```

The adapter links against `anytype-heart` under the Any Source Available License 1.0. Review
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before building or distributing it.

## Security

Knot is a policy boundary, not a sandbox for the connected runtime.

- Authorize senders only through immutable native Anytype IDs.
- Keep API keys, invite links, tokens, state databases, and local paths outside the repository.
- Give each independently trusted agent its own Anytype identity and operating-system account.
- Bind listeners to loopback or an authenticated private network.
- Scope Anytype write access by space, operation, and allowed file root.
- Enforce filesystem and tool access in Codex, OpenClaw, a service account, or a container.
- Treat all chat, object, reply, attachment, and forwarded content as untrusted input.

Read the [security policy](SECURITY.md) before deploying an agent with write access. Report
vulnerabilities through GitHub's private vulnerability reporting flow, not a public issue.

## Documentation

| Document                                                       | Use it for                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| [Agent setup runbook](docs/agent-setup.md)                     | Give this repository to Codex or another setup agent       |
| [Architecture](ARCHITECTURE.md)                                | Released components, state, message flow, and boundaries   |
| [Architecture decisions](docs/architecture-decisions.md)       | Alternatives considered during the original design         |
| [Compatibility matrix](docs/compatibility.md)                  | AAG aliases, paths, environments, and migration guarantees |
| [Upgrade from AAG](docs/upgrade-from-aag.md)                   | Copy, service migration, verification, and rollback        |
| [Workflow recipes](docs/workflow-recipes.md)                   | Configure and verify common agent workflows                |
| [Live regression runbook](docs/live-regression.md)             | Real Anytype tests for Codex and OpenClaw changes          |
| [Roadmap](docs/knot-roadmap.md)                                | Product direction and completed migration phases           |
| [Planned work](docs/planned-work.md)                           | Work that has not shipped                                  |
| [Workflow runtime topology](docs/workflow-runtime-topology.md) | Proposed Phase 2 process and recovery contract             |
| [Knot Publish proposal](docs/publish-architecture.md)          | Proposed self-hosted web publishing architecture           |

Proposals are marked as proposals. A document in planned work does not make its commands, service,
or protocol available in the current release.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check

cd heart-adapter
go test ./...
go vet ./...
```

The repository uses Prettier for shared formatting. The compiled `dist` directory is committed so
direct GitHub installations remain deterministic. After changing `src`, run `pnpm run build` and
commit the matching generated output.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

## Current limitations

- One Knot process owns one runtime agent and one Anytype identity.
- The singleton lock is local and is not a distributed lease.
- Object discussion support depends on private, version-pinned Heart behavior.
- Codex ACP does not expose the Codex Desktop scheduled-task system.
- OpenClaw Gateway client paths vary between OpenClaw distributions.
- Claude Code and Windows service installation are not supported.

See [planned work](docs/planned-work.md) for the ordered implementation plan.

## License

Knot is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project and dependency notices.
