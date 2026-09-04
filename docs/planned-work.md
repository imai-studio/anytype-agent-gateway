# Planned work

This file lists gaps. Released behavior belongs in [`../README.md`](../README.md) and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). A design or implementation branch does not make a local
command, Cloud route, or compatibility promise available.

## Workflow runtime

The observer, durable runner, closed executors, source resolver, effect receipts, and operator CLI
are implemented behind default-off automation gates. The remaining work is:

- run the representative 72-hour soak and live Anytype regression suite before changing any default;
- ingest target-object changes, collection membership, authorized chat events, and schedules
  through one normalized path;
- add activation baselines, explicit backfill, coalescing, self-write suppression, and global or
  per-space API budgets to those new sources;
- add durable workflow schedule and sleep timers plus cost accounting;
- add a complete policy/effect audit view beyond the redacted local operator log;
- add generic HTTP only through named local connections with fixed destinations, methods, limits,
  redirect policy, and secret references;
- enable OpenClaw workflow-agent steps only after its adapter can enforce a workflow-only tool and
  filesystem boundary;
- provision native Anytype workflow, approval, run, and connection-reference types, then project
  bounded status without self-trigger loops;
- add ingestion templates, deterministic collection or dashboard materialization, and experimental
  one-way mirrors with explicit property grants and provenance.

Arbitrary JavaScript, shell, filesystem steps, two-way mirrors, ACL bypass, shared SQLite,
active-active execution, and a second Codex/OpenClaw scheduler are not planned for this phase.

## Knot Cloud production

The imai service releases connector pairing, signed command transport, publication and asset routes,
the isolated reader, consumer API keys, typed asynchronous Anytype operations, transactional event
intake, custom-domain verification, authenticated readers, safety limits, and audit records. Its
exact contract is the
[Knot Cloud release record](https://github.com/imai-studio/knot-cloud/blob/main/docs/releases.md).

The local CLI can pair a connector, inspect it, publish content, recover publication outbox work, and
inspect publication operations. Remote connector revocation remains an owner or admin action in the
Cloud dashboard. `knot cloud revoke --forget-local` removes only the local key and configuration.

Knot does not provide a CLI command that submits consumer data-API operations. An API client submits
the closed operation union to Knot Cloud, and a paired local connector may process the resulting
command only when the default-off command bridge is explicitly enabled.

Remaining work across the Cloud service and its local integration includes:

- complete the local command executor and workflow bridge soak before changing their default-off
  status;
- connect transactional event delivery to the default-off local workflow runner without creating a
  second scheduler;
- add media transformation execution, billing and paid entitlements, and hosted connectors only
  after separate security and operational reviews;
- add a general S3-compatible object-store adapter in place of the current R2-specific adapter.

Cloud may deliver typed intent. It cannot approve a local workflow, grant a project or space, assert
an Anytype sender, choose a credential, or bypass the local executor catalog.

## Gateway gaps

- A Codex app-server adapter for native scheduled and externally continued tasks.
- A Windows service installer.
- A supported multi-host deployment for one identity and state database.
- A distributed queue or cross-machine exactly-once guarantee.
- A public-API replacement for the private Heart discussion adapter.
- An isolated authority broker and explicit operation approval for shell-capable runtime management;
  same-user actor files or HMACs do not provide this boundary (see `../SECURITY.md`).
- Native remote TLS configuration for Heart; today remote transport security belongs to an
  operator-managed SSH tunnel or authenticated encrypted private network.
- A replay-safe archival/tombstone protocol for durable workflow, approval, and Cloud command
  records, and a supported operator recovery interface for permanently undeliverable chat replies.
- OpenClaw bridge diagnostics for pending final/event counts, oldest pending age, delivered
  tombstone count, and database size, through an authenticated aggregate-only endpoint usable
  across separate hosts. `knot doctor` currently reports only the Knot reply outbox, not the
  plugin's separate SQLite store. Bridge pending finals/events and idempotency tombstones can
  grow indefinitely; payload compaction does not bound row count. A replay-safe archive/recovery
  policy must precede any deletion of those records.
- A product policy for Cloud `chat.send` origin recency and content binding; today it rechecks the
  native origin sender against current local policy but does not require recent command-specific
  consent.

Keep these gaps visible in guides and diagnostics. Do not hide them behind display-name
authorization, broad network listeners, a second scheduler, or ordinary Anytype objects pretending
to be native workflow types.
