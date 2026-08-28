# Architecture decisions and design history

This document records the trade-offs considered before implementation. It complements [ARCHITECTURE.md](../ARCHITECTURE.md), which describes the resulting system in detail.

## One Anytype member per agent

One running AAG instance maps one Anytype member directly to one runtime-backed agent.

We considered using one shared Anytype identity with several agents beneath it. That would require users to mention an identity and then select an internal agent, complicating both tagging and authorization. A dedicated member makes the visible `@name` the complete routing address: tagging that member wakes that agent.

Independently taggable agents need separate Anytype identities and isolated AAG processes. This remains true when several processes share one physical host.

## One agent process per machine or service instance

The supported deployment unit is one AAG process, one identity, and one runtime agent. Run the process in the foreground or install it as an operating-system user service.

We considered making one gateway supervise many identities and agents. The simpler invariant won because it keeps lifecycle, credentials, state, logs, self-message filtering, and failures isolated. Multiple agents can be deployed as separate machines or isolated service accounts/process environments without changing the protocol.

An offline member remains visible and taggable in Anytype; AAG does not post presence or failure messages merely because its process is offline. Starting the command or service brings that identity online again, and reconnect catch-up handles eligible messages that arrived while it was down.

## The CLI remains the operator interface

Keep the CLI even though production deployments normally run as services.

The service is only the long-lived execution mode. The CLI also owns onboarding and operations:

- create a dedicated Anytype identity and revocable API key;
- join one or more spaces from invite links;
- create and validate configuration;
- diagnose routes, runtimes, adapters, and project paths;
- run in the foreground for an end-to-end test;
- install, inspect, restart, stop, and follow logs for the native service.

This keeps setup reproducible and makes a future `aag init`/installer flow possible without requiring a separate desktop application.

## TypeScript core with runtime adapters

Implement the gateway and CLI in TypeScript behind a small runtime-driver interface.

OpenClaw uses its native authenticated Gateway because it exposes the agent/session lifecycle and steering semantics directly. Codex uses Agent Client Protocol (ACP), with durable session IDs and native steering. Claude Code support was deliberately deferred; the adapter boundary leaves room for it without making the first release depend on three harnesses.

AAG is not an agent runtime. OpenClaw, Codex, or a future adapter handles reasoning, memory, compaction, approvals, tools, and model selection.

## Public Anytype API first; private Heart compatibility only where required

Use the public Anytype API for spaces, chats, messages, reactions, object lookup, and streaming. Use the official Anytype CLI for headless identity lifecycle.

We considered building directly on AnySync or Anytype Heart. That would couple the whole gateway to private synchronization internals. The only missing public capability required by the product is resolving an object's internal discussion ID, so a version-pinned Go adapter isolates that Heart call behind a tiny JSON interface.

The Heart adapter is optional and has a separate dependency-license boundary. The Any Source Available License 1.0 governs `anytype-heart`. Core AAG remains Apache-2.0; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Declarative configuration plus SQLite coordination state

Accept YAML, JSON, or TOML for operator-authored agent configuration. Use SQLite only for local coordination state.

Configuration describes identity, spaces, chats, wake rules, runtime, projects, response behavior, and peer agents. SQLite stores cursors, message fingerprints, runs, response IDs, discussion mappings, and durable ACP session IDs. It is not the source of truth for configuration and is not a distributed queue.

Session bindings, outbound retries, native-event cursors, and proactive-delivery deduplication also live in SQLite. AAG still does not claim distributed exactly-once delivery; after a crash it reconciles a retry against recent Anytype replies before sending again.

## Native schedulers stay native

AAG does not define cron syntax or maintain a second scheduler. OpenClaw cron jobs, heartbeats, subagents, and external session continuations keep using OpenClaw's scheduler and session model. The bundled channel plugin observes only explicitly bound sessions and returns their assistant output to the stored Anytype route.

Codex ACP does not currently expose Codex desktop scheduled tasks or external session observation. AAG reports that limitation instead of pretending to schedule a job. Equivalent Codex support belongs in a native Codex app-server adapter.

## Anytype mutations use scoped tools

Agents need more than prompt context when asked to create a daily object, update a task, search a space, upload a file, add an object to a collection, or return an object link. AAG exposes those operations through a policy-mediated MCP server rather than handing an API key to the model.

The read side includes complete object payloads plus type, property, select-tag, and template discovery. This matters because property keys and value shapes are space-specific: an agent must inspect that schema before an arbitrary object mutation instead of guessing it. Write, archive, space, and local-file permissions remain separate configuration boundaries. Results include an `object_ref` token that the projector converts into a native object mark, plus a deep-link fallback.

Read access is limited to configured or explicitly allowed spaces. Writes default off, archive has its own switch, and file uploads are constrained to real paths below declared roots. The tool boundary cannot protect a key file from an unrestricted shell running as the same operating-system user, so strong credential isolation still requires a runtime sandbox or separate service account.

Project lists tell the runtime which directories to use. AAG passes them as OpenClaw context or ACP working and additional directories. The runtime settings, sandbox, service account, or container must enforce access.

## Multi-space membership, explicit route subscriptions

One identity may join multiple spaces from one or several invite links. Configuration selects the chats and discussion policies it watches.

Joining a space does not subscribe the agent to every conversation. Each chat has its own wake policy. A space can override the participant ID because Anytype may assign an identity a space-specific participant ID.

Authorization compares the stable identity suffix across Anytype's space-scoped participant IDs. A bare identity therefore authorizes the same account in each configured space; an operator can use the full participant ID when a rule should apply to only one space membership.

## Wake rules live on each route

Support mention, mention-or-reply, every-message, prefix, and disabled human wake modes. Configure peer-agent wake rules separately.

These modes support assistants that wait for a mention and group listeners that resemble OpenClaw messaging channels. Every-message mode requires explicit configuration, and stable participant-ID allowlists can restrict it. Agents can choose silence with a protocol marker. Silence is a runtime result, not an unrestricted Anytype tool call.

Peer agents may talk in the same chat. Outbound coordination uses an explicit peer marker that AAG converts into a real Anytype mention, while inbound peer wakeups remain subject to allowlists, hop limits, fan-out limits, and an activation circuit breaker.

Static chat routes remain the default. A space can explicitly enable chat discovery with a separate wake policy and sender allowlist. AAG then subscribes to every current and newly created chat in that space, while mention-based waking keeps mere membership from invoking the runtime. Existing history is baselined; only a bounded recent tail is eligible when a chat first appears after startup.

## Conversation and comment-thread session boundaries

Use one runtime session and active-run lane per chat. Object discussions use one session and lane per root comment thread.

A comment-thread prompt includes its owning object, reply ancestry, and other messages from the same root thread. A chat prompt includes bounded recent history and referenced objects. When a first message lacks enough context, the gateway can fetch older bounded history rather than expecting the runtime to infer the channel from a single isolated message.

The runtime owns context compaction beyond these transport-level bounds.

An authorized `/new` wake message creates an explicit session boundary without requiring a second Anytype chat. AAG persists a generation per chat or root comment thread and changes the runtime session key after each reset. A reset excludes earlier message history from the transport prompt. If a run is active, reset replaces it visibly rather than steering it, because steering would preserve the very harness session the user asked to discard.

## Immediate editable replies and native steering

Acknowledge a trigger immediately with a working reaction on the user's message and one reply. Edit that reply as the run progresses.

The default response mode keeps one message stable and streams the latest answer text into it. Streaming can be disabled independently; milestone and verbose modes add tool or status detail. The working reaction is removed on completion, silence, interruption, or failure.

Thinking and answer text form explicit output cycles. Safe thinking/progress may occupy the working message temporarily; the next assistant text replaces it in that same message. A later distinct assistant text part starts a new message and streams there. This follows harness output boundaries instead of flattening every part into one growing blob.

If a follow-up arrives during the same active conversation, it steers the current run instead of starting a queued run. AAG freezes the previous progress message and creates a new reply beneath the follow-up. Later updates go to the new reply. Runtime adapters must report steering failures. AAG does not silently cancel and send the prompt again because that could repeat tool side effects.

## Explicit non-decisions

- No multiplexed multi-agent daemon in the first release.
- No presence bot or offline-status chatter.
- No AnySync reimplementation.
- No distributed exactly-once queue.
- No filesystem enforcement based only on configured project lists.
- No Claude Code adapter in the first release.
- No implicit access to every space, chat, object, or sender an identity can see.

These constraints keep the visible Anytype identity, the running process, and the runtime security boundary aligned. They can be revisited through new decision records without weakening the current deployment invariant silently.
