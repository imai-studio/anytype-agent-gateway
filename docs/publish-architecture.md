# Knot Cloud architecture

This document describes the Cloud protocol and trust boundaries. The imai service at
`knot.imai.tech` releases connector pairing, signed command and publication routes, scoped consumer
keys, typed Anytype operations, and the reader at `pages.imai.studio`. Check the Knot Cloud
[release record](https://github.com/imai-studio/knot-cloud/blob/main/docs/releases.md) for the exact
deployed contract.

The local package implements the signed connector, bounded publication client, default-off Cloud
command bridge, typed Anytype command executor, and `publish.web` workflow step. The service routes
are released, but command execution and workflows stay disabled until the operator enables the
local preview gates and grants the corresponding scopes and sites.

| Component                             | Status                            |
| ------------------------------------- | --------------------------------- |
| Local Anytype agent gateway           | Released                          |
| Local workflow observer and runner    | Default-off preview; soak pending |
| Cloud pairing and signed local client | Released                          |
| Bounded publication client and outbox | Released                          |
| Relay and Anytype executor            | Implemented; default-off preview  |
| `publish.web` workflow step           | Implemented; default-off preview  |
| Cloud custom-domain verification      | Released                          |
| Cloud hosted connectors               | Unavailable                       |

The product decisions are:

- imai operates a hosted service, and the same service remains supported for self-hosting;
- the imai reference deployment runs on Vercel;
- human signup and login use email only, and the initial hosted service is invitation-only;
- public content uses a different registrable domain from the dashboard and API;
- unpublishing removes all content that the service can still control rather than merely hiding it;
- consumer API keys expose typed Anytype data operations through paired Knot connectors, not
  arbitrary prompts, shell commands, or model tools.

Knot Gateway is the local Anytype-to-agent subsystem. Knot Cloud is the remote product. Knot Publish
is the publishing subsystem. Knot Relay is the optional command delivery subsystem, and local
configuration must grant every command it can carry.

In this design, a Knot process running beside Codex or OpenClaw publishes snapshots and executes
explicitly allowed Anytype data operations requested through Knot Cloud. Knot Cloud cannot dial
into Anytype, Codex, OpenClaw, or the publisher's filesystem. A local connector polls outward over
authenticated HTTPS, and all local authority remains local.

## What belongs where

The local Knot process authenticates the Anytype sender, applies the agent's local policy, reads
allowed files, prepares the document, and retries interrupted requests. It never gives a model the
publish credential.

Knot Publish authenticates each Knot installation, validates the requested site and operation,
stores immutable publication versions, serves the current version, and records an audit trail. It
does not decide which Anytype user may ask an agent to publish. The local Knot configuration owns
that decision.

```text
Anytype user -> local Knot policy -> Codex or OpenClaw
                         |
                         +-> local publish outbox -> signed HTTPS -> Knot Cloud

Dashboard or API client -> typed Anytype operation -> Knot Cloud command ledger
                                                      |
                                                      +-> outbound connector poll
                                                          -> local Knot policy
                                                          -> Anytype API

Knot Cloud -> PostgreSQL + private object storage -> public Next.js page and media routes
```

The cloud may record connector-attested Anytype provenance for a request received from local Knot,
but it cannot independently verify that provenance. Cloud-provided participant IDs, display names,
message text, mentions, replies, and forwarded content never grant authority. For a remote operation
that references an Anytype message, the cloud sends only an object pointer; local Knot re-fetches the
object and verifies the immutable native participant ID. Failure to verify fails closed.

## Deployment topology

Knot Cloud runs as a Next.js App Router application on the Node.js runtime. External clients use
Route Handlers under `/api/v1`. Reader handlers resolve one mutable `current_version_id`; version
documents and assets are immutable.

The imai-operated reference deployment uses:

- Vercel for the Next.js dashboard, API, public renderer, previews, and production promotion;
- Neon PostgreSQL as the sole authoritative store;
- private Cloudflare R2 buckets for drafts, publication bundles, and media;
- Upstash Redis for connector and pairing abuse limits only;
- Vercel Cron for publication maintenance every ten minutes and webhook maintenance every minute.

Transactional event delivery uses a separate authenticated maintenance route. Cloud webhook
delivery is released; connecting those event pointers to the default-off local workflow runner is
still planned. Self-hosted operators must schedule both maintenance routes. No deployed path
requires Vercel Queues.

No correctness depends on process memory, a Vercel Function filesystem, Redis, Cron timing, or cache
invalidation. Postgres owns tenants, accounts, invitations, sites, connector public keys,
API-key hashes, publications, versions, assets, commands, leases, attempts, idempotency records,
quotas, and audit data. Every authoritative row carries a tenant ID, and database row-level security
enforces tenant isolation.

Customer laptops do not receive Vercel credentials, and the public protocol does not depend on a
Vercel product. Commands remain in Postgres for as long as the product retention policy permits.
Connectors use signed, bounded HTTPS polling with adaptive backoff.

The dashboard and authenticated API use one registrable domain. User-controlled public content uses
a different registrable domain. In the imai deployment, the control plane is `knot.imai.tech` and
managed sites share the fixed `pages.imai.studio` reader host; a verified custom hostname maps to
one site. Dashboard cookies are never valid on a reader domain. Custom-domain TXT verification is
released. DNS records, TLS, and service routing remain operator-managed.

The supported self-host deployment uses the same application with Next.js `output: "standalone"`,
PostgreSQL, private object storage, a replaceable job runner, and a reverse proxy for TLS and limits.
Provider ports keep Vercel, Neon, R2, and Redis types out of the wire contract. The reference
implementation provides Vercel, Neon, R2, and Upstash adapters. Its object-store adapter is specific
to R2 even though it uses the S3 protocol. A general S3-compatible adapter is not released.

The cloud service lives in a separate repository because its continuous Vercel deployment cadence,
security boundary, and operations differ from the tag-installed Knot CLI:

```text
imai-studio/knot
  @imai/knot                  local Gateway, Cloud connector, and SQLite outbox

imai-studio/knot-cloud
  apps/cloud                  Next.js service deployed on Vercel or self-hosted
  packages/cloud-contract     schemas, signatures, versions, and protocol fixtures
  packages/publication-renderer   typed document renderer
```

`@imai/knot-cloud-contract` contains no storage SDK, database client, queue token, framework request
type, or provider-specific credential. Released fixtures test old clients against the current
server. The HTTP protocol, not repository layout, remains the compatibility boundary.

## Pairing and credentials

The local CLI prepares and pairs an installation with the released imai service or another Cloud
server that advertises the matching protocol:

```bash
knot cloud login --url https://publish.example.com --scope publications.read publications.write
knot cloud pair --credentials-file /private/path/pairing.json
```

The local pairing flow is:

1. Knot creates a signing key on the local machine.
2. The CLI prints the public key and dashboard URL; it does not authenticate the human account.
3. A workspace owner or admin creates the pairing request in the dashboard and grants the site,
   scopes, and slug prefixes.
4. The server creates a one-time pairing result that `knot cloud pair` polls and consumes exactly
   once.
5. Knot stores the private key in a mode-`0600` file outside the repository.
6. The agent configuration records the connection name, server URL, site ID, and local limits.

Each request carries the connection ID, timestamp, nonce, body digest, and signature. The server
rejects expired timestamps, reused nonces, invalid signatures, and operations outside the key's
server-side grants. Operators can revoke one machine without rotating every publisher.

Every request includes a protocol version. `GET /api/v1/meta` reports the minimum and maximum
supported versions and server time. Signature timestamp failures return server time so a connector
can make one corrected retry, and `knot doctor` reports material clock skew.

### Human authentication

The hosted control panel launches invitation-only. An invitation is redeemed by an email-only
magic-link flow; there is no social login requirement. Human sessions are accepted only by the
dashboard and administrative API and are never valid connector credentials. The self-hosted service
uses the same email interface with a configurable mail provider.

### Consumer API keys

Consumer API keys are separate high-entropy bearer credentials. The server stores a keyed hash plus
a displayable prefix, never the recoverable key. A key is bound to a tenant, optional sites and
connectors, typed scopes, expiry, quotas, and revocation state.

The data API manages Anytype through a paired connector. It is asynchronous because the machine
holding the Anytype identity may be offline. A new request returns `202 Accepted` with an operation
ID; an idempotent replay returns `200`. The caller reads the durable operation resource for status
and results.

The first operation vocabulary is typed and versioned:

- object read, query, create, update, and archive;
- collection read and membership changes;
- file upload, download, and attachment;
- chat and discussion read;
- chat send only under a separate, explicit grant;
- publication create, update, disable, rollback, and unpublish.

Corresponding scopes use names such as `anytype.objects.read`, `anytype.objects.write`,
`anytype.collections.write`, `anytype.files.write`, and `anytype.chats.send`. There is no generic
`execute`, `run prompt`, `shell`, model-tool, arbitrary HTTP, or arbitrary filesystem operation.
Adding a new operation requires a contract version, server scope, local policy mapping, audit shape,
and adversarial fixture.

An API key authorizes only Knot Cloud to create a typed intent. Local Knot maps the credential and
operation to local configuration, re-checks space, object, sender, route, and operation grants, and
may reject it. A local policy rejection is a successful terminal command outcome and is never
retried into eventual permission.

For `chat.send`, Cloud carries only a same-channel origin pointer. Local Knot refetches that exact
message from Anytype immediately before the effect and authorizes the native participant against
`cloudCommands.allowedOriginParticipantIds`. Cloud never asserts the Anytype participant and a
display name or mention is not authority.

## Local authority

An agent uses the Cloud connector selected by trusted local configuration. It cannot supply a
server URL or credential at run time.

```yaml
tools:
  publish:
    enabled: true
    cloudConfigFile: ~/.config/knot/cloud.json
    allowedUsers: [_participant_authorized_operator]
    allowedSiteIds: [00000000-0000-4000-8000-000000000001]
    allowedSlugPrefixes: [projects/, notes/]
    allowUpdate: true
    allowUnpublish: false
```

Before sending a request, Knot checks:

- the immutable Anytype sender identity;
- the route's sender and wake policy;
- the configured connector, site, operation, and slug prefix;
- local file roots, file types, item count, and byte limits;
- the document schema and total request size.

The publish server repeats its own site, operation, quota, and slug checks. Neither side treats the
other side's policy as proof of authorization.

## Publication model

A publication has a stable site and slug. Each successful change creates an immutable version and
moves the publication's current-version pointer.

```text
Site
  Publication
    slug
    visibility
    current_version_id
    PublicationVersion
      document
      content_hash
      asset references
      publisher key ID
      created_at
```

Rollback moves the pointer to an older version. Reversible removal is named **disable** and keeps
version history. **Unpublish is destructive**: it tombstones the publication and versions, clears
the public pointer, invalidates service-controlled caches, and deletes unreferenced bundles and
assets. Only minimal hashes, timestamps, credential identifiers, and audit outcomes remain.

All publication bundles and media use private object storage and are served through
publication-scoped Next.js routes that check the live publication state before reading the blob.
After the unpublish transaction commits, these routes return `404` immediately even if asynchronous
blob deletion is still running. Responses use conservative cache headers so the service can revoke
access. This is slower and more expensive than permanent public object URLs, but it is required by
the removal contract.

No web service can recall a copy that a reader already downloaded, screenshotted, or stored in an
uncontrolled cache. The guarantee is that Knot Cloud removes its origin data and stops serving new
copies; the product must state this limitation plainly.

The public document is typed JSON, not executable JavaScript, React components, or unsanitized
HTML. The current schema supports headings, paragraphs, rich text, lists, quotes, code, tables,
images, and files. The renderer escapes text and accepts no raw HTML.

Source details such as Anytype object IDs and local paths belong in private provenance records.
They do not appear in public pages unless the publication explicitly includes them.

## Write protocol

The released local clients use these Cloud routes:

```text
GET    /api/v1/meta
POST   /api/v1/pairing/poll
POST   /api/v1/connectors/{connectorId}/assets/request
POST   /api/v1/connectors/{connectorId}/assets/commit
POST   /api/v1/connectors/{connectorId}/publications
POST   /api/v1/connectors/{connectorId}/publications/{publicationId}/status
POST   /api/v1/connectors/{connectorId}/publications/{publicationId}/control
POST   /api/v1/connectors/{connectorId}/commands/claim
POST   /api/v1/connectors/{connectorId}/commands/extend
POST   /api/v1/connectors/{connectorId}/commands/result
```

External consumer API clients use `POST /api/v1/operations` and
`GET /api/v1/operations/{operationId}`. The Knot CLI does not submit those operations. The local
connector can claim and process them only when its default-off command bridge is enabled.

Large assets use short-lived upload URLs. Knot hashes each file before upload. The server verifies
the digest before attaching it to a version.

Every mutation includes an idempotency key derived from the connection, site, logical publication,
operation, and content hash. The server stores the key and result in the same transaction that
commits publication metadata. A retry returns the recorded result.

Knot stores pending operations in its local SQLite outbox. It removes an item only after the server
returns a committed result. If the network fails after the server commits, the retry uses the same
idempotency key and does not create another version.

## Command relay

Relay is disabled by default. Enabling it requires both a server-side connector grant and a local
allowlist of typed commands. A cloud command carries intent but no local capability.

Postgres owns the state machine:

```text
pending -> leased -> succeeded
                  -> rejected-by-local-policy
                  -> failed -> pending when retryable
                  -> pending after lease expiry
pending -> expired | cancelled | dead-lettered
```

Claiming lazily recovers expired leases in the same transaction and uses row locking so the cloud
is the sole cross-machine lease arbiter. Every lease has a random fencing token. Extend and result
requests must present the current token; a late result from an expired lease is recorded as an
attempt but cannot change the command. Local SQLite deduplicates command IDs and re-acknowledges a
terminal command without repeating its effect.

Cloud delivery retries and local execution retries are separate domains. A command enters Knot's
existing normalized-event, policy, approval, and durable-runner path; Relay does not introduce a
second scheduler. Local Knot remains authoritative for the Anytype identity, native sender
verification, spaces, routes, projects, files, runtime permissions, approvals, and the final
execute-or-reject decision.

## Agent and workflow entry points

The released constrained MCP tool accepts a configured connection name, slug, title, typed
document, assets, and visibility. It returns the publication ID, committed version, content hash,
and public URL. Knot can then post that URL in Anytype.

The released local CLI provides connector setup and diagnostics without bypassing local policy:

```text
knot cloud login
knot cloud pair
knot cloud status
knot cloud doctor
knot cloud revoke
knot cloud operation status <operation-id>
knot cloud operation retry <operation-id>
knot cloud commands list|show|approve|reject|cancel|retry
```

The commands generate a private local Ed25519 key, consume a human-created one-time pairing, inspect
local and protocol state, recover publication operations, and manage the durable local preview
queue. Remote connector revocation remains a dashboard action because it requires an authenticated
owner or admin. `knot cloud revoke --forget-local` removes only local credentials. The default-off
command bridge can claim and execute an allowed command through the existing workflow runner after
the operator configures its local policy and approval gates.

The local publication client provides:

```text
knot publish push <document> --site <uuid> --publication <uuid> --slug <slug>
knot publish status <publication-id>
knot publish rollback <publication-id> --version <version-id>
knot publish disable <publication-id>
knot publish unpublish <publication-id> --confirm <publication-id>
```

The default-off Phase 2 workflow uses the same client through a `publish.web` step. Publishing is
an external effect in risk tier T2. The workflow definition names a connection but cannot define
its URL, key, site grant, or slug grant. The approval hash covers the connection name, destination,
visibility, document transform, and retry policy.

## Failure behavior

- Invalid local policy fails before any network request.
- Invalid server grants return a permanent authorization failure.
- Timeouts and server errors remain in the local outbox and retry with bounded backoff.
- Asset upload failure prevents the publication version from becoming current.
- A page render failure leaves the previous current version available.
- Revoking a key stops new writes but does not remove existing public pages.
- A database or object-store outage makes health checks fail and blocks writes.

The public URL should never be returned as successful until the version transaction commits.

## Operations and tests

The service needs readiness and liveness endpoints, structured audit logs, request IDs, metrics,
database migrations, and tested backup restoration. Logs must omit document bodies, signatures,
credentials, private paths, and source identity values.

Release tests should cover pairing, key revocation, signature replay, slug and operation scopes,
request-size limits, malicious document input, asset digest mismatches, idempotent retries, rollback,
unpublish, cache invalidation, database restoration, and upgrades between adjacent protocol versions.

## Delivery status

### Released service and local clients

The imai service releases invitation-only accounts, connector pairing, signed claim, lease, result,
publication and asset routes, scoped consumer keys, typed asynchronous Anytype operations, public
and authenticated readers, custom-domain verification, safety limits, audit records, and
transactional event intake. The Cloud
[release record](https://github.com/imai-studio/knot-cloud/blob/main/docs/releases.md) is the source
of truth.

The local CLI releases connector setup, pairing, status, diagnostics, local credential removal,
publication controls, asset manifests, and durable publication outbox recovery. Remote connector
revocation stays in the Cloud dashboard. The CLI does not submit consumer data-API operations.

### Default-off local preview

The Cloud command executor and workflow bridge remain disabled until an operator configures the
local identity, space, operation, and approval gates. The workflow observer, runner, closed
executors, and `publish.web` step also remain behind the default-off automation gates while the soak
continues.

### Unavailable capabilities

Hosted connectors, billing and paid entitlements, and media transformation execution are not
released. The Cloud database may store limits or job metadata for them, but that does not enable a
provider or worker.
