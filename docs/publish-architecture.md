# Knot Cloud architecture

Status: active design. The Knot Cloud foundation lives in `imai-studio/knot-cloud` and runs at
`knot.imai.tech`. Connector pairing, publishing, the remote Anytype data API, Relay, and the local
Cloud client remain planned unless the Knot Cloud release notes say otherwise.

The product decisions are:

- imai operates a hosted service, and the same service remains supported for self-hosting;
- the imai reference deployment runs on Vercel;
- human signup and login use email only, and the initial hosted service is invitation-only;
- public content uses a different registrable domain from the dashboard and API;
- unpublishing removes all content that the service can still control rather than merely hiding it;
- consumer API keys expose typed Anytype data operations through paired Knot connectors, not
  arbitrary prompts, shell commands, or model tools.

The existing **Knot Gateway** name continues to mean the local Anytype-to-agent subsystem. The
remote product is **Knot Cloud**. **Knot Publish** is its publishing subsystem, and **Knot Relay** is
the optional, locally granted command-delivery subsystem.

A Knot process running beside Codex or OpenClaw can publish a snapshot and can execute explicitly
allowed Anytype data operations requested through Knot Cloud. Knot Cloud cannot dial into Anytype,
Codex, OpenClaw, or the publisher's filesystem. A local connector polls outward over authenticated
HTTPS, and all local authority remains local.

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
Route Handlers under `/api/v1`. Public pages use Server Components and resolve one mutable
`current_version_id`; version documents and assets are immutable.

The imai-operated reference deployment uses:

- Vercel for the Next.js dashboard, API, public renderer, previews, and production promotion;
- Neon PostgreSQL as the sole authoritative store;
- private Cloudflare R2 buckets for drafts, publication bundles, and media;
- Upstash Redis for rate limits, replay nonces, and short-lived email/pairing state only;
- Vercel Queues for optional first-party validation, webhook, indexing, and media work;
- Vercel Cron for idempotent reconciliation and cleanup only.

No correctness depends on process memory, a Vercel Function filesystem, Redis, Queues, Cron timing,
or cache invalidation. Postgres owns tenants, accounts, invitations, sites, connector public keys,
API-key hashes, publications, versions, assets, commands, leases, attempts, idempotency records,
quotas, and audit data. Every authoritative row carries a tenant ID, and database row-level security
enforces tenant isolation.

Vercel Queues is not the customer connector boundary. A customer laptop must not receive Vercel
OIDC or Queue API credentials, and the public protocol must not depend on a Vercel product. Commands
remain in Postgres for as long as the product retention policy permits. Connectors use signed,
bounded HTTPS polling with adaptive backoff.

The dashboard and authenticated API use one origin such as `app.example`. User-controlled public
content uses a different registrable domain such as `*.example-sites`. Dashboard cookies are never
valid on the content domain. Customer custom domains are a later addition.

The supported self-host deployment uses the same application with Next.js `output: "standalone"`,
PostgreSQL, S3-compatible private object storage, a replaceable job runner, and a reverse proxy for
TLS and limits. Provider ports keep Vercel, Neon, R2, Redis, and Queue types out of the wire
contract. The reference implementation provides Vercel, Neon, R2, and Upstash adapters. Self-host
adapters are added when a deployment needs them.

The cloud service lives in a separate repository because its continuous Vercel deployment cadence,
security boundary, and operations differ from the tag-installed Knot CLI:

```text
imai-studio/knot
  @imai/knot                  local Gateway, Cloud connector, and SQLite outbox

imai-studio/knot-cloud
  apps/cloud                  Next.js service deployed on Vercel or self-hosted
  packages/cloud-contract     schemas, signatures, versions, and protocol fixtures
  packages/publish-renderer   typed document renderer
```

`@imai/knot-cloud-contract` contains no storage SDK, database client, queue token, framework request
type, or provider-specific credential. Released fixtures test old clients against the current
server. The HTTP protocol, not repository layout, remains the compatibility boundary.

## Pairing and credentials

The operator connects a local installation with:

```bash
knot publish connect https://publish.example.com
```

The proposed pairing flow is:

1. Knot creates a signing key on the local machine.
2. The CLI opens a short-lived authorization URL on the publish server.
3. The user signs in, selects a site, and grants operations and slug prefixes.
4. The server registers the public key and returns a connection ID.
5. Knot stores the private key in a mode-`0600` file outside the repository.
6. The agent configuration records the connection name, server URL, site ID, and local limits.

Each request carries the connection ID, timestamp, nonce, body digest, and signature. The server
rejects expired timestamps, reused nonces, invalid signatures, and operations outside the key's
server-side grants. Operators can revoke one machine without rotating every publisher.

An opaque scoped token is a simpler fallback for the first prototype. The protocol should not make
bearer tokens permanent if local key signing is practical.

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
holding the Anytype identity may be offline. A request creates an operation and normally returns
`202 Accepted` with an operation ID. A bounded wait option may return the result when the connector
is already online; it does not change durability or execution semantics.

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

## Local authority

An agent refers to a connection by name. It cannot supply a server URL or credential at run time.

```yaml
connections:
  publish:
    personal-site:
      baseUrl: https://publish.example.com
      siteId: personal
      keyFile: /private/path/publish.key
      operations: [create, update, unpublish]
      allowedSlugs:
        - projects/*
        - notes/*
```

Before sending a request, Knot checks:

- the immutable Anytype sender identity;
- the route's sender and wake policy;
- the named connection, site, operation, and slug prefix;
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
HTML. The first schema can support headings, paragraphs, rich text, lists, quotes, code, tables,
images, files, and a small allowlist of embeds. Renderers must escape text and sanitize every
allowed HTML fragment.

Source details such as Anytype object IDs and local paths belong in private provenance records.
They do not appear in public pages unless the publication explicitly includes them.

## Write protocol

The proposed API starts small:

```text
POST   /api/v1/publications
PUT    /api/v1/publications/{publicationId}
POST   /api/v1/publications/{publicationId}/disable
POST   /api/v1/publications/{publicationId}/unpublish
POST   /api/v1/publications/{publicationId}/rollback
GET    /api/v1/publications/{publicationId}
POST   /api/v1/assets/uploads
GET    /api/v1/operations/{operationId}
POST   /api/v1/anytype/operations
POST   /api/v1/connectors/{connectorId}/commands/claim
POST   /api/v1/connectors/{connectorId}/commands/extend
POST   /api/v1/connectors/{connectorId}/commands/result
```

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

An interactive agent uses a constrained MCP tool. The tool accepts a configured connection name,
slug, title, typed document, assets, and visibility. It returns the publication ID, committed
version, content hash, and public URL. Knot can then post that URL in Anytype.

The CLI should provide operator commands without bypassing local policy:

```text
knot publish connect <url>
knot publish connections
knot publish status <connection>
knot publish push <file> --connection <name> --slug <slug>
knot publish revoke <connection>
```

Phase 2 workflows use the same client through a `publish.web` step. Publishing is an external
effect and belongs in risk tier T2. The workflow definition names a connection but cannot define
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

## Delivery phases

### P0: contracts, threat model, and Vercel proof

Freeze the service name, domains, document schema, signature canonicalization, protocol negotiation,
idempotency, publication states, destructive unpublish semantics, command envelope, typed Anytype
operations, provenance classes, and audit rules. Publish golden fixtures. Prove Neon transactions and
row-level security, direct R2 upload and verification, separate-domain routing, bounded connector
polling, cache revocation, and database restoration in a Vercel spike.

P0 exits only after mock old/new clients round-trip against the server fixtures and the threat model
has explicit tests for replay, tenant escape, cloud-asserted participant IDs, stale lease results,
malicious documents, interrupted unpublish, and credential confusion.

### P1: invitation-only accounts, pairing, and Publish

Implement email invitations and magic links, tenants, sites, connector pairing, local SQLite outbox,
typed document publishing, public pages on the isolated content domain, disable, rollback,
destructive unpublish, quotas, audit, a tenant kill switch, and operator takedown. Add the proposed
`knot publish` commands only in the release that contains their implementation.

P1 exits after two-tenant isolation tests, signature replay and revocation tests, failure injection at
every commit and unpublish boundary, malicious-render tests, backup restoration, and proof that a
failed publication never replaces the prior live version.

### P2a: typed Anytype data API

Implement scoped consumer keys, asynchronous Anytype operation resources, connector claim/extend/
result, local operation mappings, usage reporting, and revocation. Reads and writes both travel
through the paired connector; Knot Cloud does not hold the Anytype credential.

P2a exits after offline recovery, local policy denial, operation expiry, stale result fencing,
redelivery deduplication, and adversarial native-sender re-verification tests pass. The API remains
incapable of arbitrary agent, shell, filesystem, or network execution.

### P2b: events and channel workflows

Add transactional webhooks, channel-origin pointers, local re-fetch and identity verification, and
explicitly granted chat-send operations. Integrate remote operations with the Phase 2 workflow
runner rather than adding another scheduler.

### P3: platform extensions

Add customer custom domains, authenticated readers, media derivatives, billing, broader quotas, and
optional hosted connectors. A hosted connector is an isolated off-Vercel container using the same
public connector protocol, one dedicated Anytype member per tenant and agent, and externally managed
KMS credentials. It has no privileged internal protocol. Hosted Anytype/Heart operation requires a
licensing and terms review before implementation or public commitment.

Do not start the public API implementation until P0 authentication, document, idempotency, rollback,
unpublish, command, and Anytype operation contracts exist as executable tests and protocol fixtures.
