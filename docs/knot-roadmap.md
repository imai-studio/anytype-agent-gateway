# Knot architecture and migration roadmap

This document is the maintained product and delivery map for evolving Anytype Agent Gateway
(AAG) into Knot. Detailed released behavior remains in [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
and security trade-offs remain in [`architecture-decisions.md`](architecture-decisions.md).
[`planned-work.md`](planned-work.md) tracks work that has not shipped. The proposed self-hosted web
publishing service is documented separately in
[`publish-architecture.md`](publish-architecture.md).

## Product model

Knot is one Anytype-native automation runtime with four user-facing areas:

- **Knot Gateway** connects Anytype chats, comments, members, Codex, and OpenClaw. AAG is preserved
  as this first subsystem.
- **Knot Flows** provides triggers, durable execution, agent steps, approvals, schedules, retries,
  and recovery.
- **Knot Data** imports data and materializes managed Anytype objects, collections, and dashboards.
- **Knot Mirrors** creates explicitly granted, one-way materialized copies between spaces.

Dashboards, pipelines, and mirrors compile into workflows; they are not separate execution engines.

```text
Anytype intent: workflows · agents · approvals · status · data
                              |
                              v
observer -> normalized events -> policy -> durable workflow runner
                                      /       |          \
                                agents   Anytype writes   connections
```

The central rule is: **Anytype declares intent; local Knot configuration grants authority.**
Anytype content cannot grant filesystem access, secrets, spaces, tools, projects, network
destinations, or destructive capabilities.

### Authenticated actor boundary

Every inbound message is normalized with a principal whose authority comes only from the immutable
native Anytype participant/member ID. Display names are informational and may change or collide.
Message text, mentions, replies, forwarded content, and agent-generated context are never identity
evidence. Wake allowlists and all privileged actions—including route access, model changes, project
selection, and self-configuration—compare the authenticated immutable ID with locally configured
participant-ID allowlists. Missing or malformed native identity fails closed. Audit events record
native provenance and a non-reversible identifier digest, never credentials or display-name claims.
Existing configured participant IDs remain valid.

## Phase 1: behavior-neutral Knot v0.2.0

Phase 1 changes product and installation surfaces while preserving routes, sessions, databases,
services, protocol markers, MCP names, and configured agent identities such as Klee or Anya.

### Compatibility policy

- `knot` becomes primary in the rename PR; `aag` remains an alias through `0.2.x` and `0.3.x`, with
  removal no earlier than `1.0.0`.
- `KNOT_*` and `AAG_*` equivalents both work. A legacy-only setting produces at most one actionable
  process warning. Equivalent dual values are accepted; conflicting normalized values fail without
  logging either value.
- Existing config and state remain usable in their current AAG paths. Future migration copies and
  verifies state; it never destructively moves it.
- The installer must detect old and new service identities and must never enable both for one agent.
- Both Heart binary names are discoverable. Legacy protocol markers remain readable permanently.
- Persisted keys, existing `aag_*` MCP tools, Anytype objects, and member profiles are not rewritten.
- GitHub's old-repository redirect is kept permanently by never reusing the old repository name.

### PR sequence

1. **Compatibility foundation (complete):** centralized product metadata, environment/path/Heart/
   service/log resolvers, dual protocol parsing, authenticated principals, this roadmap, and a
   sanitized v0.1.3 upgrade fixture. Its release-state defaults and public names remained AAG.
2. **Product/package rename (complete):** package metadata, `knot` CLI plus `aag` alias, help/onboarding/docs,
   source-visible names, URLs, default paths, and generated output.
3. **Installation/service migration (complete):** `knot migrate`, `knot service migrate`, old-service
   exclusion, process-lock checks, copy/verify/backup/rollback behavior, dual Heart lookup, and
   OpenClaw plugin compatibility.
4. **Release engineering/docs (this PR):** publishing and provenance, compatibility matrix, upgrade and
   rollback guides, troubleshooting, installation validation, and repository rename.

Later Phase 1 PRs stack on PR 1 because their public renames depend on these contracts.

### v0.2.0 release gates

- TypeScript formatting, build, typecheck, lint, and tests pass; Heart Go tests and vet pass; the
  committed `dist` exactly matches `src`.
- Fresh npm and direct-GitHub installs work through new surfaces; the old GitHub URL redirects.
- Both CLI names and old/new environment-only configurations work; conflicts fail explicitly.
- A v0.1.3 database opens in place without destructive conversion; route cursors, handled-message
  versions, session bindings, generations, outbox dedupe, and authorization overrides survive.
- Existing sessions continue and no historical message becomes eligible for replay.
- Old/new services cannot run simultaneously; systemd and launchd migrations and rollback work.
- Old/new Heart combinations work; legacy protocol markers and MCP names remain compatible.
- Immutable-ID spoofing regressions pass, including duplicate/renamed display names, missing or
  malformed identity, and forwarded/replied operator claims.
- Live Codex and OpenClaw chat tests pass. Every remaining `AAG` occurrence is audited as deliberate
  compatibility or a staged rename.

Rollback stops Knot, re-enables the prior AAG service, and points it at untouched legacy state. Any
explicit copied-state migration keeps a timestamped backup and documented restore path.

## Phase 2: automation runtime v0.3.0

Phase 2 is developed as small, feature-gated PRs. Anytype is the **intent plane** (definitions,
schedules, approvals, summaries, dashboards); local configuration is the **authority plane**
(authors, spaces, projects, filesystem, harness, network, secrets, budgets); SQLite is the durable
**execution plane** (immutable versions, approved hashes, events, runs, attempts, effects, retries,
timers, snapshots, audit, mirror indexes, and circuit breakers).

One `Knot Workflow` object contains a fenced YAML definition. Canonicalization produces a
deterministic approval hash over triggers, prompts, destinations, URLs/connections, requested
capabilities, transforms/templates, retry/budget policy, and behavior-bearing references. Behavior
changes invalidate approval. T0 is read-only/single-space, T1 is bounded approved writes, and T2
covers external, cross-space, bulk, archive, or destructive effects and always requires approval.

Polling plus reconciliation is the correctness mechanism; Heart events are latency hints. All
sources emit one normalized event contract. First activation does not backfill unless requested,
object changes coalesce, self-writes are suppressed by default, and reconciliation repairs missed
updates and archives.

The runner provides persistent queues, immutable workflow versions, run/step state machines,
leases, crash recovery, cancellation, approval waits, timers, retries/backoff, concurrency limits,
budgets, causal-depth loop protection, audit, and idempotent effects. Delivery is at-least-once;
deterministic upserts provide exactly-once logical outcomes where possible.

Initial steps are `agent`, `anytype.read`, `anytype.query`, `anytype.write`, `anytype.upsert`,
`anytype.materialize`, declarative `transform`, `http`, `approval`, and `notify`. Arbitrary JavaScript,
two-way mirrors, ACL bypass, hosted multi-tenancy, multi-agent identity orchestration, and Heart as a
correctness dependency are explicit v0.3.0 non-goals.

### Phase 2 PR graph

1. Foundation: ADRs/flags; schema/canonicalization/hashing; additive SQLite backup migrations;
   capability policy and risk tiers.
2. Observation: normalized events; snapshots; adaptive fair polling/diffs; chat SSE; optional Heart
   hints; self-write suppression/coalescing.
3. Runner: in-memory state machine; durable leases/recovery; retry/timer/dead letter; idempotent
   effects/outbox; budgets/rate limits/circuit breakers.
4. Steps: Anytype reads/query/upsert; transforms; HTTP/secret resolution; Codex/OpenClaw; approvals
   and notifications.
5. Authoring: Knot type bootstrap; workflow discovery/validation; approval CLI/chat commands; status
   and throttled Run projections.
6. Data products: ingestion templates; dashboard/collection materializer; experimental one-way
   mirrors with local source/destination/property grants and visible provenance.
7. Operations/release: run/event/audit CLI, extended doctor, examples, simulation, fault injection,
   E2E and soak tests, then final flag enablement.

The contract/schema, event, runner, and policy foundations freeze before dependent tracks ship.
The release also requires unapproved definitions never execute, duplicate events produce one logical
run, poll-only and Heart-assisted results match, crash injection loses no run, materializers converge,
no-op ingestion writes nothing, mirror fuzzing never copies unapproved properties, loops terminate,
and a 72-hour representative soak passes.
