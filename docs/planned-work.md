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

The imai-operated deployment currently releases only its invitation-only console, health endpoint,
protocol metadata endpoint, restricted Neon access, and private R2 provider check. Its exact contract
is the [Knot Cloud release record](https://github.com/imai-studio/knot-cloud/blob/main/docs/releases.md).

The local repository contains signed connector, publication, asset, Relay, and `publish.web` clients.
They remain unusable with the imai deployment until the matching Cloud routes, migrations, provider
configuration, and canaries appear in that release record. Remaining Cloud release work includes:

- connector pairing and signed claim, lease, result, and revocation routes;
- publication upload, an isolated public-content domain, reader routes, rollback, disable, and
  destructive unpublish;
- consumer API-key management and typed asynchronous Anytype operations;
- transactional event and webhook delivery through the existing local runner;
- production tenant quotas, RLS probes, replay protection, cache-revocation checks, audit evidence,
  and provider smoke tests;
- separately reviewed custom domains, authenticated readers, billing, media derivatives, and hosted
  connectors.

Cloud may deliver typed intent. It cannot approve a local workflow, grant a project or space, assert
an Anytype sender, choose a credential, or bypass the local executor catalog.

## Gateway gaps

- A Codex app-server adapter for native scheduled and externally continued tasks.
- A Windows service installer.
- A supported multi-host deployment for one identity and state database.
- A distributed queue or cross-machine exactly-once guarantee.
- A public-API replacement for the private Heart discussion adapter.

Keep these gaps visible in guides and diagnostics. Do not hide them behind display-name
authorization, broad network listeners, a second scheduler, or ordinary Anytype objects pretending
to be native workflow types.
