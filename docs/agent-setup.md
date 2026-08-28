# Agent bootstrap runbook

This runbook tells a coding agent how to connect its Codex or OpenClaw runtime to Anytype. The agent can start with only this repository link. It must ask the operator for credentials and routing decisions that the machine cannot discover safely.

## Outcome

One long-lived AAG process appears in Anytype as one dedicated, taggable member. A mention, reply, prefix, or configured every-message route wakes one Codex or OpenClaw runtime. AAG reacts to the triggering user message, posts an immediate reply, edits it while work progresses, handles same-thread follow-ups as steering, and removes the reaction when the run finishes.

## 1. Verify prerequisites

- macOS or Linux, Node.js 24 or newer, and pnpm 11 or newer.
- Anytype Desktop/API reachable from this machine, normally through a loopback address. For a remote agent machine, forward the local API with SSH or another authenticated private transport.
- The official Anytype CLI if this machine must create a dedicated headless identity or join invite links.
- A working Codex installation, or an OpenClaw Gateway and its client module.
- Absolute paths for every project the runtime should be told about.

Install and verify AAG:

```bash
pnpm add --global github:imai-studio/anytype-agent-gateway
aag --version
aag --help
```

Do not continue if `aag --version` fails. Do not work around the failure by downloading unreviewed binaries or disabling package-manager security globally.

## 2. Collect operator decisions

Ask only for values that cannot be discovered safely:

1. Runtime: `codex` or `openclaw`.
2. Dedicated Anytype member name.
3. One or more Anytype space invite links, unless the identity is already a member.
4. Space and initial chat names to watch, whether newly created chats should be discovered, and whether object discussions are enabled.
5. Stable participant IDs allowed to wake the agent.
6. Wake rule per chat: `mention`, `mention-or-reply`, `every-message`, `prefix`, or `disabled`.
7. Absolute default and allowed project paths.
8. Codex permission mode (`deny` is the safe default) or OpenClaw Gateway connection details.
9. Whether answer text should stream, plus response verbosity (`single`, `milestones`, or `verbose`).
10. Whether the agent may write Anytype objects, which exact spaces it may touch, whether archive is allowed, and which local roots may supply uploads.
11. For OpenClaw, a random channel-bridge token and whether native cron/heartbeat/background output should return to the bound Anytype conversation.

Never infer an invite link, participant ID, or project authorization from a display name. Never place an API key or Gateway token in the YAML file.

## 3. Create or reuse the Anytype member

For a new, independently taggable member, have the operator review the invite destinations and credential path, then run:

```bash
mkdir -p ~/.config/aag
aag identity create "AGENT_NAME" \
  --invite 'ANYTYPE_INVITE_URL' \
  --api-key-file ~/.config/aag/anytype-api-key
```

This delegates identity and key creation to the official Anytype CLI and writes the key with restrictive permissions. If the existing dedicated identity needs another space:

```bash
aag join 'ANYTYPE_INVITE_URL'
```

An API key copied from a human desktop session does not produce a separate taggable bot member. Use a dedicated identity when identity-level mentions and membership boundaries matter.

If the operator already provisioned an identity and key, reuse the protected key file rather than creating another identity. Confirm the identity's participant ID in each configured space.

## 4. Create configuration outside the repository

Start the interactive generator:

```bash
mkdir -p ~/.config/aag
aag init --output ~/.config/aag/agent.yaml
```

Or copy `examples/codex-agent.yaml` / `examples/openclaw-agent.yaml` and replace every placeholder. The essential Codex shape is:

```yaml
version: 1
agent:
  name: Codex
  participantId: _participant_bot_id
  aliases: [codex]
anytype:
  apiBase: http://127.0.0.1:31009
  apiKeyFile: ~/.config/aag/anytype-api-key
spaces:
  - name: SPACE_NAME
    chatDiscovery:
      enabled: true
      discoveryIntervalSeconds: 30
      wake:
        humans: mention-or-reply
        agents: direct-mention
        allowedUsers: [_participant_authorized_human_id]
    chats:
      - name: CHAT_NAME
        wake:
          humans: mention
          agents: direct-mention
          allowedUsers: [_participant_authorized_human_id]
    comments:
      mode: disabled
runtime:
  kind: codex
  command: codex-acp
  permissions: deny
  defaultProject: /absolute/path/to/default-project
  allowedProjects:
    - /absolute/path/to/another-project
responses:
  mode: milestones
  streaming: true
```

The installed package resolves its bundled `codex-acp` executable automatically. For OpenClaw, use `examples/openclaw-agent.yaml`, provide the absolute Gateway client-module path, and keep the Gateway token in the configured environment variable or protected OpenClaw config file.

Object writes are off unless the configuration explicitly sets `tools.anytype.allowWrite: true`. Keep `allowedSpaceIds` and `allowedFileRoots` narrow. Uploads require an explicit root, resolve symlinks, accept regular files only, and are capped at 50 MiB. Archive is a separate permission.

For OpenClaw, install the packaged native channel and configure its loopback bridge before validation:

```bash
aag openclaw plugin install
```

Generate one random token of at least 24 characters. Prefer a mode-`0600` file selected by `runtime.channelBridge.tokenFile`; the environment variable selected by `tokenEnv` is also supported. Configure the same value as OpenClaw's `channels.anytype.bridgeToken`. Add `aag mcp --config /absolute/path/to/agent.yaml` to OpenClaw's native `mcp.servers` configuration so the OpenClaw agent receives the same scoped Anytype object tools as Codex. Do not expose the bridge listener beyond loopback.

For object work, tell the agent to call `aag_context`, discover the space's types and properties, read the target object, and then mutate it. Select and multi-select values can be resolved through the property-tag tool, templates through the type-template tool, and collection membership through the view tools. Every found, created, or updated object returns an `object_ref` token that AAG turns into a clickable object reference. The accompanying `anytype://` link is a fallback.

One configuration should describe one identity and one runtime agent. Use explicit routes or an explicit `chatDiscovery` policy; space membership alone must not turn on every conversation. When discovery is enabled, keep its wake policy mention-based and its sender allowlist narrow.

## 5. Validate before connecting

```bash
aag validate --config ~/.config/aag/agent.yaml
aag doctor --config ~/.config/aag/agent.yaml
```

`validate` checks configuration structure. `doctor` checks Anytype connectivity, configured routes, runtime availability, adapter availability, and project paths. Resolve every relevant failure rather than weakening allowlists or exposing a listener publicly.

## 6. Prove the foreground workflow

Run AAG in a terminal first:

```bash
aag run --config ~/.config/aag/agent.yaml
```

In a configured Anytype chat, verify this sequence:

1. Mention the dedicated member from an allowed human account.
2. Confirm AAG reacts to the user message and creates a reply promptly.
3. Confirm progress edits the same reply and the final answer removes the reaction from the user message.
4. During a run, send a same-chat follow-up. Confirm it steers the active runtime and produces a new response beneath the follow-up.
5. Confirm an unmentioned message stays silent when the route uses `mention`.
6. If object discussions are enabled, verify the prompt receives the owning object and comment-thread context.
7. Ask the agent to create a temporary object in an allowed test space, confirm the returned `anytype://` link opens it, then update and find it through the tools.
8. For OpenClaw, call `aag_context` for the current route and create a short native command job from its `continuation_argv`. Confirm only its assistant output returns to the same Anytype chat or discussion, then remove the test schedule through OpenClaw. Do not use a plain cron `agentTurn`; OpenClaw isolates it under a different session key.
9. Let a run exceed fifteen minutes or use a controlled long-running fixture. Confirm it remains alive when both runtime watchdogs are `0`.

Do not install the background service until the foreground flow succeeds. Stop the foreground process before starting the service so both processes cannot contend for the same state file.

## 7. Install the service

```bash
aag service install --config ~/.config/aag/agent.yaml
aag service status
aag service logs
```

This installs a user-level launchd service on macOS or systemd user service on Linux. Use `aag service restart`, `stop`, and `logs` for operation. Keep one service process per machine/user environment for the supported deployment model.

## 8. Completion checklist

- `aag --version`, `validate`, and `doctor` succeed.
- Anytype shows a separate, taggable member in only the intended spaces.
- API keys and tokens live outside the repository with restrictive permissions.
- Chat/discussion routes and participant allowlists are explicit.
- Codex, OpenClaw, or the operating-system sandbox enforces the declared project limits.
- The foreground test covers mentions, silence, progress edits, final replies, and steering.
- Thinking is replaced by the following text in one message; later distinct text parts appear as new streamed messages.
- A `/new` message resets the native harness context without changing the Anytype route.
- Allowed Anytype object operations work and denied spaces, archive, and upload paths fail closed.
- OpenClaw's native channel is installed, its exact operator session is bound, and native scheduled/background output returns after an AAG restart.
- Only one foreground/service process owns the configuration and SQLite state.

For rationale behind these boundaries, read [`architecture-decisions.md`](architecture-decisions.md). For component-level design, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
