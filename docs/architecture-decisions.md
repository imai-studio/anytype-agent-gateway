# Architecture decisions and design history

This document records the trade-offs considered before implementation. It complements [ARCHITECTURE.md](../ARCHITECTURE.md), which describes the resulting system in detail.

## One Anytype member per agent

**Decision:** one running AAG instance maps one Anytype member directly to one runtime-backed agent.

We considered using one shared Anytype identity with several agents beneath it. That would require users to mention an identity and then select an internal agent, complicating both tagging and authorization. A dedicated member makes the visible `@name` the complete routing address: tagging that member wakes that agent.

**Consequence:** independently taggable agents need separate Anytype identities and isolated AAG processes. This is intentional even if several processes eventually share one physical host.

## One agent process per machine or service instance

**Decision:** the supported deployment unit is one AAG process, one identity, and one runtime agent. The process can be started in the foreground or installed as one operating-system user service.

We considered making one gateway supervise many identities and agents. The simpler invariant won because it keeps lifecycle, credentials, state, logs, self-message filtering, and failures isolated. Multiple agents can be deployed as separate machines or isolated service accounts/process environments without changing the protocol.

An offline member remains visible and taggable in Anytype; AAG does not post presence or failure messages merely because its process is offline. Starting the command or service brings that identity online again, and reconnect catch-up handles eligible messages that arrived while it was down.

## The CLI remains the operational surface

**Decision:** keep a CLI even though production deployments normally run as services.

The service is only the long-lived execution mode. The CLI also owns onboarding and operations:

- create a dedicated Anytype identity and revocable API key;
- join one or more spaces from invite links;
- create and validate configuration;
- diagnose routes, runtimes, adapters, and project paths;
- run in the foreground for an end-to-end test;
- install, inspect, restart, stop, and follow logs for the native service.

This keeps setup reproducible and makes a future `aag init`/installer flow possible without requiring a separate desktop application.

## TypeScript core with runtime adapters

**Decision:** implement the gateway and CLI in TypeScript behind a small runtime-driver interface.

OpenClaw uses its native authenticated Gateway because it exposes the agent/session lifecycle and steering semantics directly. Codex uses Agent Client Protocol (ACP), with durable session IDs and native steering. Claude Code support was deliberately deferred; the adapter boundary leaves room for it without making the first release depend on three harnesses.

AAG is not itself an agent harness. Reasoning, memory, compaction, approvals, tools, and model selection remain responsibilities of OpenClaw, Codex, or a future adapter.

## Public Anytype API first; private Heart compatibility only where required

**Decision:** use the public Anytype API for spaces, chats, messages, reactions, object lookup, and streaming. Use the official Anytype CLI for headless identity lifecycle.

We considered building directly on AnySync or Anytype Heart. That would couple the whole gateway to private synchronization internals. The only missing public capability required by the product is resolving an object's internal discussion ID, so a version-pinned Go adapter isolates that Heart call behind a tiny JSON interface.

The Heart adapter is optional and has a separate dependency-license boundary: `anytype-heart` is governed by the Any Source Available License 1.0. Core AAG remains Apache-2.0; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Declarative configuration plus SQLite coordination state

**Decision:** accept YAML, JSON, or TOML for operator-authored agent configuration and use SQLite only for local coordination state.

Configuration describes identity, spaces, chats, wake rules, runtime, projects, response behavior, and peer agents. SQLite stores cursors, message fingerprints, runs, response IDs, discussion mappings, and durable ACP session IDs. It is not the source of truth for configuration and is not a distributed queue.

Project lists are declarations to the runtime. AAG passes them as OpenClaw context or ACP working/additional directories, but enforcement belongs to the harness, sandbox, service account, or container.

## Multi-space membership, explicit route subscriptions

**Decision:** one identity may join multiple spaces from one or several invite links, while configuration explicitly selects the chats and discussion policies it watches.

Joining a space does not implicitly subscribe the agent to every conversation. Each chat has its own wake policy, and participant IDs can be overridden per space because Anytype identities may be represented by space-scoped participant IDs.

## Wake behavior is configured per route

**Decision:** support mention, mention-or-reply, every-message, prefix, and disabled human wake modes, plus independent peer-agent wake rules.

This covers both explicitly summoned assistants and group-listener agents similar to OpenClaw's messaging-channel behavior. Every-message mode is intentionally explicit and can be restricted by stable participant-ID allowlists. Agents can also choose silence with a protocol marker; silence is a runtime result, not an unrestricted Anytype tool call.

Peer agents may talk in the same chat. Outbound coordination uses an explicit peer marker that AAG converts into a real Anytype mention, while inbound peer wakeups remain subject to allowlists, hop limits, fan-out limits, and an activation circuit breaker.

## Conversation and comment-thread session boundaries

**Decision:** use one runtime session and active-run lane per chat, and one per root comment thread for object discussions.

A comment-thread prompt includes its owning object, reply ancestry, and other messages from the same root thread. A chat prompt includes bounded recent history and referenced objects. When a first message lacks enough context, the gateway can fetch older bounded history rather than expecting the runtime to infer the channel from a single isolated message.

The runtime owns context compaction beyond these transport-level bounds.

## Immediate editable replies and native steering

**Decision:** acknowledge a trigger immediately with one reply and a working reaction, then edit that reply as the run progresses.

The default response mode keeps one message stable and replaces its text with the latest/final answer. Milestone and verbose modes can expose more progress. The working reaction is removed on completion, silence, interruption, or failure.

If a follow-up arrives during the same active conversation, it is steering—not a queued second run. AAG freezes the previous progress message, creates a new reply beneath the follow-up so the user can see that it was incorporated, and routes subsequent updates there. Runtime adapters must surface steering failures; AAG does not silently cancel and re-prompt because that could duplicate tool side effects.

## Explicit non-decisions

- No multiplexed multi-agent daemon in the first release.
- No presence bot or offline-status chatter.
- No AnySync reimplementation.
- No distributed exactly-once queue.
- No filesystem enforcement based only on configured project lists.
- No Claude Code adapter in the first release.
- No implicit access to every space, chat, object, or sender an identity can see.

These constraints keep the visible Anytype identity, the running process, and the runtime security boundary aligned. They can be revisited through new decision records without weakening the current deployment invariant silently.
