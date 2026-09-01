# Workflow runtime foundation

This document freezes the Phase 2 foundation contract. Knot has a read-only observer for workflow
definition objects and a durable local runner core. It does not observe workflow target data or
execute agent, Anytype, HTTP, notification, or other effect steps.

The companion [process topology](workflow-runtime-topology.md) defines ownership, leases, crash
recovery, timers, cancellation, effects, shutdown, retention, and restore behavior for the code that
will implement this contract.

## Trust planes

Knot separates workflow state into three planes:

- **Intent plane:** an Anytype `Knot Workflow` object carries the operator-visible definition,
  schedule, approval status, and summaries.
- **Authority plane:** the local agent configuration limits verified editors, spaces, capabilities,
  connections, secret names, risk tier, projects, and budgets. Anytype content cannot expand these
  grants.
- **Execution plane:** local SQLite stores immutable versions, approval decisions, normalized events,
  runs, effects, timers, and audit records. It is the recovery source for the local runner, not a
  replacement for the visible Anytype intent.

Every decision uses the intersection of definition intent and current local authority. A workflow
that names an ungranted capability, connection, secret, project, or space must fail closed. A
definition also fails when its concurrency, hourly rate, step, effect, time, or causal-depth budget
exceeds the matching local cap. The effective value is the lower of the two limits.

## Feature gates

`automation.enabled` is false by default. Set `automation.observation` to start the read-only
definition observer. The configuration must also name allowed spaces, allowed native editor IDs,
allowed capabilities, and one or more workflow object type keys. Set `automation.execution` to
start the durable matcher, dispatcher, and bounded workers. Execution requires observation.
Authoring and data-product gates remain unavailable.

The runner stores deliveries, runs, steps, and attempts before it claims work. Claims have a worker
ID, lease deadline, and random fencing token. A stale worker cannot complete a reclaimed step.
Retry deadlines, cancellation requests, dead letters, the event cursor, and the fair-claim hint are
durable. Dispatch and resume re-evaluate current local authority and the exact approval decision.
The only shipped successful executor is an empty transform with no transform or input reference.
Every other step fails closed at the executor boundary without an external effect.
If a definition contains a prompt or message, the runner moves its first claimed step to
`source_refetch_required` instead of reading text from SQLite. The optional resolver contract is
read-only. It must return the exact definition source, native revision, and verified editor. Knot
then checks the source, version, approval, editor, policy, and current authority hashes before it
can resume the step. The current gateway does not install a resolver or effect executor.

The observer polls every allowed space through the public Anytype API. It stores one durable page
cursor, reconciliation boundary, revision watermark, failure count, and next-scan time per space.
`minimumIntervalSeconds`, `maximumIntervalSeconds`, and `pageSize` bound that work. The page size is
limited to the Anytype API maximum of 100. Missing-object confirmation also runs in page-sized
batches, and the observer preserves the reconciliation boundary until every batch is complete. A
quiet space backs off to the maximum. A change, incomplete page, or recovery returns to the minimum. Run
`knot doctor` to verify that the configured type keys are searchable before starting the service.

## Definition and approval integrity

Definitions use `knot.imai.studio/v1alpha1` and `KnotWorkflow`. The parser rejects unknown fields in
the workflow-owned envelope. Every step kind has a strict configuration schema; executors may not
interpret undeclared nested options. Connection, secret, project, target-space, bulk, and archive
references therefore remain visible to approval and authority policy. Step kinds are limited to the
initial Phase 2 catalog. Step IDs are unique and their dependency graph must be valid and acyclic.
Anytype write steps can create, update, or archive. They cannot hard-delete. HTTP and notification
steps must name a local connection. HTTP steps may add a relative path, but a definition cannot set
the scheme, host, port, or an absolute URL.

Knot hashes the parsed, default-materialized approval projection, never raw YAML. The projection
includes an explicit policy-derivation version, so changing risk semantics invalidates old approval
subjects. Canonical JSON
sorts object keys and preserves semantic array order. Set-like capability, dependency, and pinned
reference collections are normalized explicitly. The domain-separated `knot.workflow.approval.v1`
SHA-256 hash includes:

- every trigger and its configuration;
- ordered steps, prompts, destinations, connection names, relative paths, transforms, templates, retry
  settings, and timeouts;
- requested capabilities, budgets, concurrency, backfill, self-write, and causal-depth behavior;
- content digests for referenced prompts, templates, transforms, and policies.

Display name, description, labels, and enabled state do not affect the approval hash. Changing any
behavior-bearing value or referenced content does. Secret reference names may be hashed; secret
values must never enter the definition, hash material, database, or logs. Knot stores a
domain-separated digest of the source text, not the source text itself. In stored definition and
approval records, it replaces author-supplied `prompt` and `message` strings with separately
domain-separated digests. A future executor must refetch and verify the source or use an encrypted
content store before it can run those steps.

## Capability and risk policy

The capability catalog is explicit. A step implies minimum capabilities, and declaring fewer than
the step requires is invalid. Declaring additional capabilities can only increase risk.

- **T0:** single-space read/query and pure transforms.
- **T1:** bounded agent invocation and Anytype writes, upserts, or materialization.
- **T2:** HTTP, notifications, other external effects, cross-space work, bulk operations, or archive.

T1 and T2 require an exact approved hash. T2 always requires an explicit manual approval. Local
maximum tier and capability grants remain authoritative even when an old approval exists.
Before approval or execution, Knot evaluates the complete intersection of definition intent with
the current verified editor, space, capability, project, connection, secret-name, tier, and budget
grants. An approval decision cannot expand that intersection.

Editor authority comes from an immutable native Anytype identity, an authenticated chat identity,
or an authenticated operator command. A display name is not an editor identity. If Knot cannot
verify the editor or the verified principal is absent from `allowedAuthorIds`, the definition is not
authorized.

## Observation correctness boundary

Polling plus reconciliation is the correctness mechanism. The shipped observer applies this rule
to workflow definition objects. Heart and streaming hints are not connected to this loop. The
observer pages fairly across configured spaces and performs a complete pass before it considers a
missing definition archived. It then requires a direct object read to confirm an archive or native
404/410 response.

Each definition must contain one fenced YAML block. Knot reads the native modification timestamp
and the `last_modified_by` system object property from the full object response. Top-level aliases,
display names, and creator fallbacks do not authorize the definition. Missing or unauthorized editor
identity leaves the definition invalid. Knot stores a digest of the complete raw object body as the
observation revision, plus a separate digest of the fenced YAML on an accepted immutable version.
It also stores closed bounded error codes and an immutable normalized definition event. It stores the redacted parsed version only after schema
and local authority checks pass. It never stores the raw source body, author prompt text, upstream
response body, or validation input in workflow tables or event payloads.

The remaining object, collection, schedule, and manual observation work will use the same event
contract. First activation does not backfill unless requested.
Normalized event kinds and sources use closed enums. Payloads and property diffs have bounded,
strict schemas. Native editor provenance and the source revision fingerprint remain attached to the
immutable event. Event IDs and dedupe keys provide immutable input facts; runner delivery is
at-least-once. Self-writes are suppressed by default, compatible object changes may coalesce, and
causal depth bounds terminate loops.

Anytype can report two workflow edits with the same modification timestamp. Knot compares the
domain-separated raw object-body digests byte by byte for those ties and selects the greater digest.
This produces the same active state and version regardless of observation order, including when one
revision is invalid.

## State migration and retention

Before an on-disk schema migration, Knot creates a consistent SQLite backup next to the configured
state database. The filename records the source schema version, the backup file is mode `0600`, and
the service reports its exact path after a successful migration or in a migration failure. To
restore one, stop Knot, move the failed database and its `-wal` and `-shm` companions aside, copy the
chosen backup to the configured state path, keep it mode `0600`, and restart with the Knot version
that understands that backup's schema. Never restore while a Knot process has the database open.

Workflow versions, approval subjects, approval decisions, and normalized events are intentionally
append-only in the Phase 2 foundation. Knot applies no automatic retention to this audit history.
A later retention policy must be explicit, preserve referenced approval and run evidence, and be
reviewed as a trust-boundary change.

The schema 9 migration replaces legacy `workflow_versions.source_text` values with empty strings and
stores their digests. The pre-migration backup still contains the old text by design. Protect that
backup like the live database and remove it only after the operator has verified the migration and
accepted the loss of that rollback point.

Schema 11 is also the first release boundary that writes observer approval material. Approval rows
whose behavior-reference ordering came from an unpublished development build are therefore not a
supported migration input; those development databases must be recreated or their workflows
re-authored. Rewriting their approval hashes in place would break the append-only approval ledger.
Schema 10 added definition source digests and durable per-space observer state. A restart resumes the
saved page and reconciliation boundary. Repeated pages and repeated revisions reuse the same event
dedupe key. An interrupted observation repairs a missing event on the next pass before it advances
past that source revision.

Schema 11 redacts author prompt and message strings from stored definition and approval records.
The backup created before a schema 11 migration can still contain those plaintext strings. Keep it
mode `0600`, restrict access to the operator, and remove it after the migration and rollback window
have been verified.

Schema 12 adds the runner cursor, deliveries, runs, steps, and attempts. It records retry deadlines,
cancellation, leases, and fences in SQLite. A restart recovers an expired claim from this state. The
runner does not infer success from a missing worker process. It also records
`source_refetch_required` for a claimed step and attempt when the immutable version contains
redacted source text.
