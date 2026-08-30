# Workflow runtime foundation

This document freezes the Phase 2 foundation contract. It does not enable workflow observation or
execution. Those paths remain unavailable unless their local feature gates are enabled in order.

## Trust planes

Knot separates workflow state into three planes:

- **Intent plane:** an Anytype `Knot Workflow` object carries the operator-visible definition,
  schedule, approval status, and summaries.
- **Authority plane:** the local agent configuration limits authors, spaces, capabilities,
  connections, secret names, risk tier, projects, and budgets. Anytype content cannot expand these
  grants.
- **Execution plane:** local SQLite stores immutable versions, approval decisions, normalized events,
  runs, effects, timers, and audit records. It is the recovery source for the local runner, not a
  replacement for the visible Anytype intent.

Every decision uses the intersection of definition intent and current local authority. A workflow
that names an ungranted capability, connection, secret, project, or space must fail closed.

## Feature gates

`automation.enabled` is false by default. Observation, execution, authoring, and data products have
separate gates. Execution requires observation; authoring and data products require execution. The
first foundation release provides contracts and durable storage only, so enabling a flag cannot
silently route work through the existing chat gateway.

## Definition and approval integrity

Definitions use `knot.imai.studio/v1alpha1` and `KnotWorkflow`. The parser rejects unknown fields in
the workflow-owned envelope. Every step kind has a strict configuration schema; executors may not
interpret undeclared nested options. Connection, secret, project, target-space, bulk, and destructive
references therefore remain visible to approval and authority policy. Step kinds are limited to the
initial Phase 2 catalog. Step IDs are unique and their dependency graph must be valid and acyclic.

Knot hashes the parsed, default-materialized approval projection, never raw YAML. The projection
includes an explicit policy-derivation version, so changing risk semantics invalidates old approval
subjects. Canonical JSON
sorts object keys and preserves semantic array order. Set-like capability, dependency, and pinned
reference collections are normalized explicitly. The domain-separated `knot.workflow.approval.v1`
SHA-256 hash includes:

- every trigger and its configuration;
- ordered steps, prompts, destinations, URLs or connection names, transforms, templates, retry
  settings, and timeouts;
- requested capabilities, budgets, concurrency, backfill, self-write, and causal-depth behavior;
- content digests for referenced prompts, templates, transforms, and policies.

Display name, description, labels, and enabled state do not affect the approval hash. Changing any
behavior-bearing value or referenced content does. Secret reference names may be hashed; secret
values must never enter the definition, hash material, database, or logs.

## Capability and risk policy

The capability catalog is explicit. A step implies minimum capabilities, and declaring fewer than
the step requires is invalid. Declaring additional capabilities can only increase risk.

- **T0:** single-space read/query and pure transforms.
- **T1:** bounded agent invocation, Anytype writes/upserts/materialization, and notifications.
- **T2:** HTTP or other external effects, cross-space work, bulk operations, archive, or destructive
  effects.

T1 and T2 require an exact approved hash. T2 always requires an explicit manual approval. Local
maximum tier and capability grants remain authoritative even when an old approval exists.
Before approval or execution, Knot evaluates the complete intersection of definition intent with
the current local author, space, capability, project, connection, secret-name, tier, and budget
grants. An approval decision cannot expand that intersection.

## Observation correctness boundary

Polling plus reconciliation is the correctness mechanism. Heart or streaming events may lower
latency but never replace reconciliation. First activation does not backfill unless requested.
Normalized event IDs and dedupe keys provide immutable input facts; later runner delivery is
at-least-once. Self-writes are suppressed by default, compatible object changes may coalesce, and
causal depth bounds terminate loops.
