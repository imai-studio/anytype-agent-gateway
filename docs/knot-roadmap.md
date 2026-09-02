# Knot roadmap

This page tracks delivery status. Released behavior lives in
[`../README.md`](../README.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Work that is still
missing lives in [`planned-work.md`](planned-work.md). The separate Cloud service keeps its own
[release record](https://github.com/imai-studio/knot-cloud/blob/main/docs/releases.md).

| Milestone                              | Status on local `main`                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| Phase 1 rename and AAG compatibility   | Complete                                                   |
| Agent chats, discussions, and DMs      | Released                                                   |
| Phase 2 observer and durable runner    | Default-off preview pending the representative soak        |
| Closed workflow executors and CLI      | Default-off preview pending the representative soak        |
| Cloud connector and publication client | Released with the matching Knot Cloud routes               |
| Cloud Relay and Anytype data client    | Cloud routes released; local execution remains default-off |
| Knot Data and Mirrors                  | Planned                                                    |

Repository code, a passing pull request, and a Cloud deployment are different release boundaries.
Update this table only when the relevant local documentation or Cloud release record changes.

## Product boundary

One Knot process represents one Anytype member and one Codex or OpenClaw agent. Anytype carries
messages and workflow intent. Local configuration grants senders, spaces, projects, capabilities,
connections, secrets, and budgets. SQLite owns local delivery and recovery state.

Authority comes from immutable native participant IDs. Display names, message text, mentions,
replies, forwarded content, and Cloud-provided identity claims do not grant access.

Knot has four product areas:

- **Gateway:** chats, discussions, DMs, runtime sessions, streaming replies, and scoped Anytype tools.
- **Flows:** approved definitions, normalized events, durable execution, closed effects, and local
  operator controls.
- **Data:** repeatable imports and managed Anytype collections or dashboards.
- **Mirrors:** explicitly granted one-way materializations between spaces.

Data products and mirrors compile to Flows. They do not introduce another scheduler or authority
plane.

## Completed milestones

Phase 1 renamed the product and package while preserving the `aag` CLI alias, `AAG_*` environment
variables, legacy config and state paths, Heart protocol names, OpenClaw plugin state, MCP tool
names, and the old GitHub repository redirect. `knot migrate` and `knot service migrate` copy and
verify state without destroying the source or allowing old and new services to run together.

The Phase 2 preview adds:

- a read-only, paginated workflow-definition observer with durable cursors and verified native
  editor identity;
- immutable workflow versions, exact approval hashes, normalized events, durable runs and steps,
  leases, fencing, retry deadlines, cancellation, dead letters, and effect receipts;
- bounded Anytype read, query, write, upsert, and materialize steps; closed transforms; named
  notifications; capability-narrowed Codex invocation; and `publish.web`;
- source refetch before sensitive definition text reaches an executor;
- exact approval, enable/disable, manual run, cancel, safe retry, and redacted inspection commands;
- a default-off Cloud command bridge that reuses the same runner and local authority checks.

Automation remains disabled by default. OpenClaw workflow-agent invocation, generic HTTP, arbitrary
code, shell, and filesystem steps fail closed. Conversation routing and native OpenClaw scheduling
are unchanged.

## Release gates

The preview stays default-off until the representative 72-hour soak and live Anytype regression
suite pass. The tests must cover crash recovery, stale leases, source changes, approval and authority
changes, effect ambiguity, cancellation, safe retry, and restart behavior without losing evidence.

The next implementation work is limited to the gaps in [`planned-work.md`](planned-work.md). Detailed
workflow invariants are frozen in
[`workflow-runtime-contract.md`](workflow-runtime-contract.md); process ownership and recovery are
defined in [`workflow-runtime-topology.md`](workflow-runtime-topology.md).
