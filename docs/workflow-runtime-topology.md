# Workflow runtime process topology

Status: process contract for Phase 2. The workflow definition observer and durable runner core are
implemented. Target-object observation, effect executors, receipts, and status projection remain
proposed.

This document fixes the process and recovery rules for the workflow runtime. Later implementation
PRs may add tables and modules, but they must keep these rules unless a new architecture decision
changes them.

## Scope

The Phase 2 runtime runs inside the existing Knot service. The current release has two long-lived
supervisors:

- the observer turns Anytype changes, chat messages, schedules, and manual requests into normalized
  events;
- the runner matches events to approved workflow versions and advances durable step attempts.

The observer and runner do not replace the current chat gateway. The gateway keeps its route,
session, steering, and response projection behavior. Workflow agent steps call the existing runtime
drivers through a separate execution path and persist their results before later steps begin.

OpenClaw still owns OpenClaw cron jobs, heartbeats, and native session continuations. A Knot schedule
creates a `schedule.tick` event for a Knot workflow. It does not create or emulate a native Codex or
OpenClaw scheduled task.

## Deployment boundary

One operating-system process owns one Knot configuration and one SQLite database.

```text
Knot service process
  process lock
  configuration and secret resolver
  SQLite store
  chat gateway supervisor
  workflow observer supervisor
    adaptive reconciliation scheduler
    chat event adapter
    optional Heart hint adapter
    schedule and manual event adapters
  workflow runner supervisor
    delivery dispatcher
    bounded worker pool
    retry and timer scanner
    effect executor
    Anytype status projector
  Codex or OpenClaw runtime driver
```

The Heart adapter, Anytype API, Codex ACP process, and OpenClaw Gateway may run as separate
processes. They do not own workflow queues or leases. Knot treats their output as external input or
external effects.

Knot acquires the existing state-file process lock before opening the workflow supervisors. A
second process must fail before it can poll, lease work, or write status. Sharing the SQLite file
between hosts is unsupported. Leases recover work after a local process crash. They are not a
distributed lock and do not make active-active deployment safe.

SQLite WAL mode remains local to the service. In-memory queues, timers, caches, and promises may
reduce latency, but no correctness decision may depend on them surviving a restart.

## State ownership

Each fact has one owner.

| State                                                                                                                                | Owner                                                          | Notes                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Workflow YAML, display name, enabled choice, approval requests, and visible run summaries                                            | Anytype                                                        | This is untrusted intent and operator visibility. Anytype status is not execution truth.                |
| Allowed authors, spaces, projects, capabilities, connections, secret names, risk tier, budgets, and feature gates                    | Local configuration                                            | Anytype content cannot add or widen a grant.                                                            |
| Connection credentials and secret values                                                                                             | Local files, environment, or an approved local secret provider | SQLite, Anytype, prompts, status objects, and logs store names or digests only.                         |
| Parsed immutable workflow versions and approval hashes                                                                               | SQLite                                                         | A behavior change creates another version. It never rewrites an old version.                            |
| Approval decisions and the authority hash used for each decision                                                                     | SQLite                                                         | T2 approval must name an authenticated local or native Anytype actor and use manual mode.               |
| Snapshots, normalized events, workflow deliveries, runs, steps, attempts, timers, effects, receipts, audit records, and dead letters | SQLite                                                         | These records drive recovery.                                                                           |
| Current Anytype objects and collection membership                                                                                    | Anytype                                                        | SQLite snapshots are observations used for diffing. Reconciliation re-reads Anytype.                    |
| Runtime memory and model state                                                                                                       | Codex or OpenClaw                                              | Knot stores the session binding and the persisted workflow step result needed for retries.              |
| External HTTP state                                                                                                                  | The named external system                                      | Knot stores request and response digests plus an idempotency receipt, not a second copy of that system. |

Anytype object metadata does not prove who edited a workflow unless the Anytype transport exposes an
immutable native editor identity. A display name or a user-editable `Created by` property never
authorizes execution. When Knot cannot verify the editor, it records the definition as untrusted
and requires approval through an authenticated CLI action or an Anytype chat turn with native
sender provenance.

## Startup order

Knot starts the workflow runtime in this order:

1. Parse and validate configuration without resolving secret values into logs.
2. Acquire every compatible legacy and current process lock.
3. Open SQLite, enable foreign keys and WAL mode, and run additive migrations.
4. Create and report the pre-migration backup when the schema changes.
5. Reconcile incomplete attempts, expired leases, due retry timers, current authority, and prior
   shutdown markers.
6. Start the runner dispatcher, bounded workers, and effect worker if `automation.execution` is
   enabled.
7. Start the bounded Anytype projection outbox worker.
8. Start polling and reconciliation if `automation.observation` is enabled.
9. Attach chat SSE and optional Heart hints after the reconciliation scheduler is ready.
10. Report the service as ready.

The current release performs the queue recovery and runner startup steps when
`automation.execution` is enabled. It skips the effect worker and Anytype projection worker because
neither has shipped.

The runner will start before new observations so recovered work does not wait behind a burst of fresh
events. Observation still uses a baseline on first activation, so enabling a workflow does not turn
existing objects into historical events unless its approved definition requests backfill.

Observation may run while execution is disabled. In that mode it stores snapshots and events but
creates no workflow deliveries. Enabling execution records the current event watermark for each
workflow. Older events stay observational history unless the approved workflow requests backfill.

If recovery fails, Knot does not start observation or execution. The chat gateway may only continue
when configuration explicitly allows a degraded gateway-only mode and the failure does not involve
the shared database. The default is to fail the service.

## Observer loops

One adaptive scheduler now owns workflow definition reconciliation for every configured space. It
does not create one interval per workflow. Later work extends the same ownership model to target
objects and collection membership.

The current scheduler keeps durable per-space page cursors, reconciliation boundaries, revision
watermarks, failure counts, and next-scan times. Each cycle:

1. selects spaces fairly from the durable next-scan state;
2. fetches a bounded page of at most 100 configured workflow definition objects;
3. validates the source and native editor identity, then stores immutable versions and definition
   state;
4. inserts one deduplicated normalized event per source revision;
5. advances the cursor only after those durable writes succeed;
6. records the next scan time with bounded backoff and jitter.

A complete definition pass finds missed updates. A search miss alone never archives a definition;
Knot requires a direct read to confirm the archive or native 404/410 response. Those confirmation
reads use bounded batches, and the reconciliation boundary advances only after all batches finish.
A restart resumes the saved page. Re-reading a page is safe, and an
interrupted write is repaired by the event dedupe key on the next pass. Heart-assisted target fetch,
property-level snapshot diffs, collection reconciliation, and self-write suppression remain planned.

Chat SSE uses the gateway's reconnect and REST catch-up behavior, then converts eligible messages
to the normalized workflow event contract. It does not skip route sender authorization. A workflow
chat trigger still needs an explicit local space, route, and sender grant.

The observer writes an origin effect key on Knot-authored changes. The next snapshot records the
new source state but suppresses a matching self-write event unless the approved workflow enables
self-writes. Compatible changes to one object may share one coalescing window. The stored event
keeps the first and last observed revisions so coalescing cannot erase the fact that a change
occurred.

## Normalized event ingestion

Every event source uses one versioned schema. Event kinds and source names come from closed enums.
The parser rejects unknown fields, unsafe object keys, oversized payloads, invalid timestamps, and
causal depth above the local limit. It records verified editor provenance and a native source
revision when the source supplies them. Display metadata is not a fallback identity.

If two workflow observations have the same Anytype modification timestamp, the observer compares
their domain-separated raw object-body digests byte by byte. The greater digest becomes active. A
separate fenced-YAML digest identifies an accepted immutable version. This tie-breaker gives every
observation order the same result without treating a timestamp as unique.

The observer computes two identities:

- `event_id` identifies the immutable observed fact;
- `dedupe_key` identifies equivalent delivery input across polling, chat, Heart, and recovery.

The event transaction commits before delivery matching. A durable matcher scans events after its
stored cursor and creates delivery rows for matching approved workflow versions. It advances the
cursor only after the delivery transaction commits. A unique key on workflow version and event
dedupe key prevents a second logical delivery. Delivery remains at least once because a worker may
crash after an external effect and before committing its receipt.

Heart and chat hints never write workflow deliveries directly. They pass through the same fetch,
normalization, approval, and authority checks as polling.

## Queue ownership and dispatch

SQLite is the queue. The dispatcher queries durable delivery, step, and timer rows. An in-memory
channel may wake workers after a commit, but workers also scan SQLite on a bounded interval.

The runner uses separate records for:

- event delivery to a workflow version;
- the logical run;
- each step and its dependency state;
- each execution attempt;
- each retry, schedule, timeout, or approval timer;
- each external effect and receipt;
- each policy decision and audit entry.

The matcher creates at most one delivery. The dispatcher creates the logical run in a separate
transaction with the delivery's unique key. A duplicate event returns the existing delivery and
run. A manual retry creates a new attempt under the same logical step unless the operator explicitly
asks for a new run.

The dispatcher does not infer authority from an old approval. Before it starts or resumes a run, it
re-evaluates the immutable workflow version against current local configuration. A changed authority
hash pauses the run until the required approval exists under that hash.

A T0 workflow still receives an explicit automatic approval decision in the ledger. No risk tier
bypasses the approval record used by execution.

## Run and step states

Run states are:

```text
pending -> running -> waiting -> succeeded
                    -> failed
                    -> cancelled
                    -> dead_letter
```

`waiting` means no worker owns the run because it waits for a retry timer, schedule time, approval,
source refetch, or an upstream step. `dead_letter` means automatic progress stopped and an operator
must inspect the run.

Step states are:

```text
blocked -> ready -> leased -> running -> succeeded
                                  -> waiting_retry -> ready
                                  -> waiting_timer -> ready
                                  -> waiting_approval -> ready
                                  -> source_refetch_required -> ready
                                  -> failed
                                  -> cancelled
                                  -> dead_letter
```

The runner moves a step to `ready` only after every dependency has succeeded. A failed, cancelled,
or dead-letter dependency prevents downstream execution. Fan-out and joins use the same rule.

Attempts are immutable records. A retry appends another attempt. It never clears the error or
receipt from an earlier attempt.

`source_refetch_required` records why Knot refused to execute a redacted definition. A read-only
resolver can move the step back to `ready` only after it matches the stored source revision, native
editor, version hash, approval hash, and local policy. The runner keeps refetched text in memory and
never writes it to SQLite or logs.

## Leases and fencing

A worker claims one ready step in a SQLite `BEGIN IMMEDIATE` transaction. The claim writes:

- a random worker instance ID;
- a random fencing token;
- the lease start and expiry times;
- the attempt number;
- the workflow version and authority hashes.

Completion, heartbeat, retry, and effect-receipt writes must present the current fencing token. An
update whose token no longer matches affects zero rows and the worker discards its result. This
prevents a late worker from overwriting recovery work after its lease expires.

Workers extend leases before half the lease interval has elapsed. Extension is bounded by the
step timeout and maximum run time. A blocked event loop or unreachable dependency eventually loses
its lease.

The recovery scan handles an expired lease by inspecting durable effect receipts:

- no effect was prepared, so it appends a retry attempt;
- a retry-safe effect has a committed receipt, so it records the step result without repeating the
  effect;
- a prepared effect can be reconciled by stable external key, so it reconciles and records the
  outcome;
- an effect has an unknown outcome and no safe reconciliation method, so it moves the step to
  `dead_letter`.

The worker ID helps diagnostics. Only the fencing token grants the right to commit.

## Timers and schedules

SQLite owns timer deadlines. JavaScript timers only wake the scanner near the next deadline.

Retry, timeout, approval-expiry, and sleep timers use absolute UTC instants. On startup, the scanner
processes every due control timer in bounded batches. Reprocessing a timer is safe because its
transition uses a unique timer ID and a compare-and-swap state update.

An approved schedule trigger stores its cron expression, IANA timezone, active workflow version,
and next nominal instant. First activation starts at the next future instant. It does not create old
ticks. After downtime, Knot emits one `schedule.tick` event for the latest missed nominal instant,
then advances to the next future instant. Older missed ticks do not backfill under schema version 1.
The event dedupe key contains the workflow version and nominal instant.

Daylight-saving behavior follows the named timezone. A local time that occurs twice produces two
distinct UTC instants. A local time that does not occur produces no tick. The schedule parser must
reject an unknown timezone or unsupported cron expression before hashing and approval.

## Cancellation

Cancellation is durable and cooperative.

An operator request records `cancel_requested_at`, the authenticated actor digest, and a reason. The
dispatcher stops leasing new steps for that run. Workers check cancellation before each step and
before preparing each effect.

For an active agent step, Knot calls the runtime driver's cancel method and waits for the bounded
shutdown result. For an HTTP or Anytype request already sent, cancellation cannot undo the external
effect. The worker records any result or unknown outcome before it releases the lease. Cancellation
then prevents later steps.

A service shutdown is not user cancellation. Shutdown stops new leases and lets active workers
checkpoint. Any unfinished attempt keeps its lease and recovery handles it after expiry. The run
does not gain a false `cancelled` state merely because the process stopped.

## Effects and receipts

Every external write uses a stable effect key derived from:

```text
workflow approval hash
run ID
step ID
canonical normalized input digest
```

Knot writes an effect record before the call. The record contains the operation kind, named
connection or Anytype target, request digest, authority hash, policy decision ID, attempt ID, and
idempotency strategy. It does not contain secret values.

The effect worker re-evaluates current local authority before sending the request. A queued effect
whose grant was removed records a policy denial and does not call the external system.

After the call, Knot appends a receipt with the external ID or stable key, status, bounded response
metadata, and response digest. Step output is stored separately and is subject to size and secret
redaction limits.

Anytype create, upsert, and materialize effects use stable external keys and reconcile before a
retry. Update and archive effects record the target revision when the API exposes one. A repeated
effect must converge on the same Anytype state.

HTTP effects use named local connections. The connection fixes scheme, host, port, path rules,
methods, redirect policy, DNS and private-address policy, timeouts, body limits, and secret refs. A
workflow cannot supply a new host at runtime. Knot does not automatically retry a non-idempotent
HTTP request unless the connection declares downstream idempotency support and the request carries
the stable effect key.

An effect with an unknown outcome remains visible. Knot never changes `unknown` to `failed` merely
to make it retryable.

## Crash recovery

The transaction boundary determines recovery behavior:

| Crash point                                                      | Recovery                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Before an observed event commits                                 | Reconciliation observes it again.                                                   |
| After the event commits but before a delivery exists             | The startup delivery reconciliation creates the missing delivery.                   |
| After a delivery commits but before a run exists                 | The dispatcher creates the run with the delivery's unique key.                      |
| While a step owns a lease but before effect preparation          | Lease expiry creates a retry attempt.                                               |
| After effect preparation but before the external call            | Recovery uses the prepared record and the executor's retry rules.                   |
| After the external call but before its receipt commits           | Recovery reconciles by stable key or dead-letters an unknown non-idempotent result. |
| After a receipt commits but before the step succeeds             | Recovery reads the receipt and completes the step without repeating the effect.     |
| After the step succeeds but before downstream steps become ready | Dependency reconciliation marks the downstream steps ready.                         |
| During Anytype status projection                                 | The projection outbox retries the same bounded projection with its effect key.      |

Startup recovery is idempotent. Running it twice produces the same queue state.

## Shutdown order

SIGINT and SIGTERM start one bounded shutdown sequence:

1. Mark the service unready and reject new manual workflow commands.
2. Stop schedule scans, object scans, chat workflow ingestion, and Heart hints.
3. Finish or roll back the observer transaction in progress.
4. Stop leasing new workflow steps.
5. Signal active workers to checkpoint and stop before the shutdown deadline.
6. Flush committed effect receipts, audit entries, and projection outbox acknowledgements.
7. Stop the workflow effect and projection workers.
8. Run the existing chat-controller shutdown and close runtime drivers.
9. Close SQLite.
10. Release the process lock.

Knot does not wait forever for an external call. At the deadline it leaves the attempt leased and
records the last known effect state when possible. Startup recovery resolves it after the lease
expires.

## Retention

The v0.3 runtime performs no automatic deletion of workflow versions, approval subjects, approval
decisions, normalized events, runs, attempts, effects, receipts, audit records, or dead letters.
Deleting that evidence before the first long soak would make failure analysis guesswork.

Knot may compact replaceable Anytype run-status projections and transient debug logs. It must not
compact SQLite execution truth in v0.3.

`knot doctor` must report database size, oldest event, oldest unresolved run, dead-letter count,
and estimated growth. A later retention command needs its own reviewed design. It must refuse to
delete a record referenced by a live run, approval, effect receipt, mirror provenance record, or
backup manifest.

## Backup and restore

Before every on-disk schema migration, Knot uses SQLite `VACUUM INTO` to create a consistent backup
next to the database. The backup name contains the source schema version and timestamp. Knot sets
mode `0600` before it reports the path.

An operator restore follows this order:

1. Stop Knot and verify that no compatible legacy or current process owns the state lock.
2. Move the current database plus its `-wal` and `-shm` files aside.
3. Copy the selected backup to the configured state path and set mode `0600`.
4. Start the Knot version that supports the backup schema.
5. Let startup recovery reconcile events, leases, effects, timers, and projections.
6. Keep the displaced files until the restored service passes `knot doctor` and live checks.

A backup contains workflow definitions, local execution history, and actor digests. A backup made
before the schema 11 redaction migration can also contain plaintext workflow prompt and message
fields. Operators must protect backups like the live state database and delete superseded plaintext
backups after verifying the migration and rollback window. Backups must never contain API keys or
connection secret values.

## Failure policy

The runner fails closed when it cannot prove authority, approval, lease ownership, effect safety,
or target identity.

- An invalid or unapproved definition remains visible but creates no run.
- A local policy denial writes an audit decision and creates no external effect.
- A lost lease discards the late worker result.
- A secret lookup failure fails the step without logging the secret source value.
- An unknown non-idempotent effect moves to dead letter.
- A projection failure does not change the underlying run result.
- A Heart failure changes latency, not correctness.
- An Anytype outage pauses observation and effects until reconciliation succeeds.

Display names, mentions, replies, object text, and cloud-provided participant IDs never grant
authority.

## Implementation gates

The next implementation layers may proceed after review accepts this document and the contract
hardening PR removes the known unsafe placeholders in the foundation schema.

The definition observer tests prove restart recovery, duplicate revision deduplication,
same-timestamp digest ordering, explicit and reconciled archives, disabled definitions, unverified
editors, and bounded backoff. Before target-data observation or execution ships, tests must also
prove:

- one process owns the database and a second process cannot poll or lease;
- every crash point in the recovery table preserves the logical run and effect evidence;
- a late fencing token cannot commit;
- duplicate events create one logical run;
- poll-only and Heart-assisted observation produce equivalent events;
- first activation does not backfill, while the approved backfill option does;
- cancellation stops later effects without rewriting a completed external result;
- a non-idempotent unknown result cannot retry automatically;
- restoration from a pre-migration backup resumes without losing approval or effect evidence;
- shutdown releases the process lock only after SQLite closes.

These gates add to the existing gateway, migration, Heart adapter, and live Anytype release checks.
