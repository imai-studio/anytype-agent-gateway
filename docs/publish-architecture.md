# Knot Publish architecture

Status: proposed. Knot Publish is not implemented or included in the current Knot release.

Knot Publish is a separate, self-hosted web service. A Knot process running beside Codex or
OpenClaw can send it a document and receive a public URL. The publish service does not connect back
to Anytype, Codex, OpenClaw, or the publisher's filesystem.

## What belongs where

The local Knot process authenticates the Anytype sender, applies the agent's local policy, reads
allowed files, prepares the document, and retries interrupted requests. It never gives a model the
publish credential.

Knot Publish authenticates each Knot installation, validates the requested site and operation,
stores immutable publication versions, serves the current version, and records an audit trail. It
does not decide which Anytype user may ask an agent to publish. The local Knot configuration owns
that decision.

```text
Anytype user
  -> Codex or OpenClaw
  -> local Knot policy
  -> local publish outbox
  -> signed HTTPS request
  -> Knot Publish API
  -> PostgreSQL + S3-compatible storage
  -> public Next.js page
```

## Proposed components

Knot Publish runs as a Next.js application on the Node.js runtime. External Knot clients use App
Router Route Handlers under `/api/v1`. The public site uses Server Components to read publication
metadata and render the stored document format.

A first deployment needs:

- one Next.js process built with `output: "standalone"`;
- PostgreSQL for sites, publisher keys, publications, versions, idempotency records, and audit data;
- S3-compatible storage for images, files, and immutable document bundles;
- a reverse proxy for TLS, body limits, timeouts, and rate limits;
- backups for PostgreSQL and object storage.

The first version should use one application process. Horizontal scaling adds shared cache and tag
invalidation, a stable Next.js deployment ID, coordinated Server Action encryption, and a shared
rate limiter. Publication correctness must depend on PostgreSQL and object storage, not a Next.js
filesystem cache.

The service should live in its own repository and package. A small versioned contract package can
be shared with the Knot client:

```text
@imai/knot                    local gateway and publish client
@imai/knot-publish            self-hosted Next.js service
@imai/knot-publish-contract   request and document schemas
```

This split lets the gateway and web service ship separately. The HTTP protocol, not a shared source
tree, is their compatibility boundary.

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

Rollback moves the pointer to an older version. Unpublish changes visibility and keeps the version
history. Destructive deletion should be a separate operation with a stricter grant.

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
POST   /api/v1/publications/{publicationId}/unpublish
POST   /api/v1/publications/{publicationId}/rollback
GET    /api/v1/publications/{publicationId}
POST   /api/v1/assets/uploads
GET    /api/v1/operations/{operationId}
```

Large assets use short-lived upload URLs. Knot hashes each file before upload. The server verifies
the digest before attaching it to a version.

Every mutation includes an idempotency key derived from the connection, site, logical publication,
operation, and content hash. The server stores the key and result in the same transaction that
commits publication metadata. A retry returns the recorded result.

Knot stores pending operations in its local SQLite outbox. It removes an item only after the server
returns a committed result. If the network fails after the server commits, the retry uses the same
idempotency key and does not create another version.

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

## Open decisions

The implementation plan still needs decisions on:

- the identity provider for the publish control panel;
- custom domains and certificate management;
- public, unlisted, and authenticated-reader visibility;
- quotas and abuse controls for a multi-user deployment;
- whether v1 uses local key signing or scoped bearer tokens;
- the exact document schema and compatibility policy;
- CDN choice and cache-purge integration;
- whether media transforms run in the web process or a separate worker.

Do not start the public API implementation until the authentication method, document schema,
idempotency transaction, and version rollback behavior are written as tests and protocol fixtures.
