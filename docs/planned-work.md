# Planned work

This file lists work that has not shipped. Released behavior belongs in `README.md` and
`ARCHITECTURE.md`. A design in this file does not make a command, service, API, or compatibility
promise.

## Phase 2 workflow runtime

The repository contains the Phase 2 contracts and additive SQLite foundation. Workflow execution
is still disabled. The next work should follow this order.

The foundation rejects hard-delete and raw external URL steps, requires named local connections,
checks verified editor identity, intersects definition budgets with local caps, and stores source
digests instead of raw definition text. Normalized events use closed enums and bounded payloads.
These checks prepare the observer and runner; they do not implement either loop.

### 1. Infrastructure specification

The proposed process and recovery contract is in
[`workflow-runtime-topology.md`](workflow-runtime-topology.md). It fixes queue ownership, leases,
fencing, crash recovery, timers, cancellation, effect receipts, retention, backup restoration, and
single-host operation. Reviewing that design is the gate for the observer and runner work below.

The topology document is a design contract. No workflow observer or runner has shipped.

### 2. Observation and reconciliation

- Normalize object, chat, schedule, and manual events into one immutable record format.
- Treat polling and reconciliation as the correctness path.
- Use Heart events or streams only to reduce latency.
- Add first-activation baselines, optional backfill, coalescing, and self-write suppression.
- Partition polling fairly across configured spaces and enforce API budgets.

### 3. Durable runner

- Add run, step, attempt, lease, timer, effect, retry, cancellation, and dead-letter state machines.
- Recover expired leases after a crash without losing a run.
- Deliver events at least once and require idempotent effects.
- Enforce concurrency, rate, cost, and causal-depth limits.
- Record an audit entry for every policy decision and external effect.

### 4. Steps and approvals

- Implement Anytype read, query, write, upsert, and materialize steps.
- Add declarative transforms and notifications.
- Add Codex and OpenClaw agent steps through the existing runtime adapters.
- Add HTTP through named local connections and secret references.
- Require an exact approved hash for T1 and T2 workflows.
- Keep T2 manual approval mandatory.

### 5. Anytype authoring

- Bootstrap the Knot workflow, approval, run, and connection-reference types.
- Discover and validate workflow objects without executing unapproved definitions.
- Add approval, disable, retry, and cancel commands.
- Project bounded run status into Anytype without creating self-trigger loops.

### 6. Data products and operations

- Add ingestion templates and deterministic collection or dashboard materialization.
- Add experimental one-way mirrors with explicit property grants and provenance.
- Add run, event, audit, and dead-letter CLI inspection.
- Build simulation, fault injection, end-to-end tests, and a representative 72-hour soak.

Phase 2 does not include arbitrary JavaScript steps, two-way mirrors, ACL bypass, hosted
multi-tenancy, or a second scheduler for Codex and OpenClaw.

## Knot Publish

Knot Publish is a proposed self-hosted Next.js service. It accepts authenticated document bundles
from local Knot installations and serves versioned public pages. The complete proposal is in
[`publish-architecture.md`](publish-architecture.md).

The suggested delivery order is:

1. Freeze the document schema, signing protocol, idempotency rules, and rollback semantics.
2. Build a single-instance Next.js service with PostgreSQL and S3-compatible storage.
3. Add publisher pairing, scoped keys, revocation, and the local Knot outbox client.
4. Add an MCP publish tool and CLI connection commands.
5. Add the T2 `publish.web` workflow step after the Phase 2 runner can execute external effects.
6. Add custom domains, reader authentication, multi-instance caching, quotas, and media workers only
   when deployments need them.

No Knot Publish package, command, server, protocol, or hosted endpoint exists yet.

## Gateway work not included in the current release

- A Codex app-server adapter that can observe native scheduled and externally continued tasks.
- A Windows service installer.
- A supported active-active or multi-host deployment for one identity and state database.
- A distributed queue or exactly-once delivery guarantee.
- A public-API replacement for the private Heart discussion compatibility adapter.

These gaps should stay visible in documentation and diagnostics. Do not paper over them with a
second scheduler, shared SQLite files, display-name authorization, or broad network listeners.
