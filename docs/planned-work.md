# Planned work

This file lists work that has not shipped. Released behavior belongs in `README.md` and
`ARCHITECTURE.md`. A design in this file does not make a command, service, API, or compatibility
promise.

## Phase 2 workflow runtime

The repository contains the Phase 2 contracts, additive SQLite foundation, read-only workflow
definition observer, and durable local runner core. The runner dispatches normalized events,
persists runs and dependency-ordered steps, recovers leases, retries with durable deadlines,
records cancellation, and dead-letters work that cannot continue. Effect execution is not
available. Definitions with prompt or message text stop in `source_refetch_required` because the
gateway does not install a read-only source resolver. The remaining work should follow this order.

The foundation rejects hard-delete and raw external URL steps, requires named local connections,
checks verified editor identity, intersects definition budgets with local caps, and stores source
digests instead of raw definition text. Normalized events use closed enums and bounded payloads.
The definition observer discovers configured workflow objects, checks native editor identity and
local authority, stores immutable versions, and emits deduplicated definition events. It does not
observe workflow target objects. The runner ignores those control-plane definition events and waits
for normalized target, chat, schedule, or manual events.

### 1. Infrastructure specification

The proposed process and recovery contract is in
[`workflow-runtime-topology.md`](workflow-runtime-topology.md). It fixes queue ownership, leases,
fencing, crash recovery, timers, cancellation, effect receipts, retention, backup restoration, and
single-host operation. Reviewing that design is the gate for the observer and runner work below.

The topology document is the design contract for the shipped definition observer and durable runner
core. Effect receipts, projections, target-data observation, and effect workers remain proposed.

### 2. Remaining observation and reconciliation

- Extend the normalized event path from workflow definitions to target objects, collection
  membership, authorized chat messages, schedules, and manual requests.
- Use Heart events or streams only to reduce latency.
- Add first-activation baselines, optional backfill, coalescing, and self-write suppression.
- Add global and per-space API budgets to the existing fair, bounded definition polling.

### 3. Runner completion

- Add durable timer events and per-step waiting timers.
- Add effect intent, receipt, and unknown-outcome recovery before any external executor ships.
- Extend the current concurrency, hourly-rate, step, and causal-depth checks with cost accounting.
- Add a complete policy-decision and effect audit view.
- Add CLI inspection and operator controls for runs, cancellation, retries, and dead letters.

### 4. Steps and approvals

- Implement Anytype read, query, write, upsert, and materialize steps.
- Add declarative transforms and notifications.
- Add Codex and OpenClaw agent steps through the existing runtime adapters.
- Add HTTP through named local connections and secret references.
- Require an exact approved hash for T1 and T2 workflows.
- Keep T2 manual approval mandatory.

### 5. Anytype authoring

- Bootstrap the Knot workflow, approval, run, and connection-reference types.
- Add approval, disable, retry, and cancel commands.
- Project bounded run status into Anytype without creating self-trigger loops.

### 6. Data products and operations

- Add ingestion templates and deterministic collection or dashboard materialization.
- Add experimental one-way mirrors with explicit property grants and provenance.
- Add run, event, audit, and dead-letter CLI inspection.
- Build simulation, fault injection, end-to-end tests, and a representative 72-hour soak.

Phase 2 does not include arbitrary JavaScript steps, two-way mirrors, ACL bypass, hosted
multi-tenancy, or a second scheduler for Codex and OpenClaw.

## Knot Cloud

Knot Cloud is a proposed imai-operated and self-hostable Next.js service. Its reference deployment
runs on Vercel. Knot Publish accepts authenticated document snapshots from local Knot installations
and serves removable, versioned public pages. A typed Anytype data API creates durable operations
that paired local connectors may execute only after applying local policy. The complete proposal is
in [`publish-architecture.md`](publish-architecture.md).

The suggested delivery order is:

1. Freeze the threat model, document schema, signing and protocol negotiation, idempotency,
   destructive unpublish, typed Anytype operations, relay state machine, provenance, and audit
   fixtures. Prove the Vercel reference topology without shipping a public API.
2. Launch invitation-only email accounts, connector pairing, Knot Publish, private object storage,
   isolated public-content domains, rollback, disable, destructive unpublish, quotas, and the local
   Knot outbox client.
3. Add scoped consumer keys and the asynchronous typed Anytype data API through paired connectors.
   Keep arbitrary prompts, shell, filesystem, model-tool, and network execution out of the protocol.
4. Add transactional events and channel workflows through the Phase 2 runner rather than a second
   scheduler.
5. Add an MCP publish tool and CLI connection commands in the release that implements them.
6. Add the T2 `publish.web` workflow step after the Phase 2 runner can execute external effects.
7. Add custom domains, authenticated readers, billing, media workers, and isolated hosted connectors
   only after their individual security and operational gates pass.

The Knot Cloud repository and hosted foundation exist. The local connector branch implements
private Ed25519 key setup, human-initiated pairing polling, protocol diagnostics, and signed command
claim, lease, result, and rejection calls. It does not execute cloud commands. Production pairing
and command routes are still under review, so the end-to-end workflow remains unavailable there.
Publish commands, a publication outbox, Relay execution, and the remote Anytype data API client are
still planned. Treat them as unavailable until their release notes and setup guides ship.

## Gateway work not included in the current release

- A Codex app-server adapter that can observe native scheduled and externally continued tasks.
- A Windows service installer.
- A supported active-active or multi-host deployment for one identity and state database.
- A distributed queue or exactly-once delivery guarantee.
- A public-API replacement for the private Heart discussion compatibility adapter.

These gaps should stay visible in documentation and diagnostics. Do not paper over them with a
second scheduler, shared SQLite files, display-name authorization, or broad network listeners.
