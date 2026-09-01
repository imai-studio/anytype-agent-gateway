# Publish through Knot Cloud

Knot can send a typed document to a paired Knot Cloud connector without giving an agent a server
URL, connector key, or local file path. The commands in this guide require a Cloud deployment with
the matching signed publication and asset routes.

## Grant the connector

Request only the sites, slugs, and lifecycle scopes this machine needs. Asset roots are local policy;
they are not sent to Knot Cloud.

```bash
knot cloud login \
  --scope publications.read publications.write publications.unpublish \
  --slug-grant 'notes/*' \
  --asset-root /absolute/path/to/publishable-assets
knot cloud pair --credentials-file /private/path/pairing.json
```

The dashboard approval must grant a site, the requested scopes, and the required slug patterns.
Knot checks the saved grant again before every request.

## Create a typed document

Publication input is JSON, not HTML. This minimal document uses the versioned renderer contract:

```json
{
  "schemaVersion": "1.0",
  "title": "Release notes",
  "blocks": [
    {
      "type": "paragraph",
      "content": [{ "text": "The release is ready.", "marks": [] }]
    }
  ]
}
```

Choose stable UUIDs for the site and publication. Retain the publication UUID because status,
updates, rollback, disable, and unpublish all use it.

```bash
knot publish push release.json \
  --site 00000000-0000-4000-8000-000000000001 \
  --publication 00000000-0000-4000-8000-000000000002 \
  --slug notes/release \
  --operation create
```

The command writes the request to a private SQLite outbox before using the network. A timeout or
retryable server failure leaves the operation in `retrying` state with the same idempotency key.
Inspect or explicitly retry it with:

```bash
knot cloud operation status <operation-id>
knot cloud operation retry <operation-id>
```

## Publish assets

An asset manifest is a local JSON array. Each entry names a file under one of the roots configured
by `cloud login`. A digest is optional; when supplied, Knot verifies it.

```json
[
  {
    "path": "/absolute/path/to/publishable-assets/diagram.png",
    "contentType": "image/png"
  }
]
```

Prepare the manifest first when an agent will publish it:

```bash
knot publish assets prepare assets.json
```

The result contains an opaque local manifest ID and the computed digests. Put a digest in the
document's `image` or `file` block, then pass the manifest ID to `publish push`:

```bash
knot publish push release.json \
  --site 00000000-0000-4000-8000-000000000001 \
  --publication 00000000-0000-4000-8000-000000000002 \
  --slug notes/release \
  --operation create \
  --asset-manifest-id 00000000-0000-4000-8000-000000000003
```

An operator can use the convenience form `--asset-manifest assets.json` instead.

Knot accepts at most the configured file count and byte budget, resolves every path beneath an
allowed root, rejects symbolic links, hashes the file, requests a short-lived upload, uploads it,
and commits the digest before publishing the document. Each asset has durable requested, uploaded,
and committed checkpoints. A retry never changes the publication idempotency key.

## Inspect and control a publication

```bash
knot publish status <publication-id>
knot publish rollback <publication-id> --version <version-id>
knot publish disable <publication-id>
knot publish unpublish <publication-id> --confirm <publication-id>
```

Disable is reversible. Unpublish is destructive and requires the publication ID twice. The Cloud
service removes the public pointer immediately and deletes service-controlled content according to
its unpublish contract.

## Enable the agent tool

The MCP surface is disabled by default. Enable it with native Anytype participant IDs and narrower
local grants than the connector when possible:

```yaml
tools:
  publish:
    enabled: true
    cloudConfigFile: ~/.config/knot/cloud.json
    allowedUsers:
      - _participant_replace_with_authorized_human_id
    allowedSiteIds:
      - 00000000-0000-4000-8000-000000000001
    allowedSlugPrefixes:
      - notes/
    allowUpdate: true
    allowRollback: false
    allowDisable: false
    allowUnpublish: false
```

`aag_publish` accepts a closed action vocabulary, UUIDs, a typed document, and an optional manifest
ID created by the CLI. It does not accept a server URL, API key, raw HTML, upload URL, or filesystem
path. Knot binds the call to the verified native Anytype sender and uses the same outbox and policy
checks as the CLI.

## Use a named connection from a workflow

Workflow publishing is separate from the interactive MCP grant. Configure a named, operator-owned
connection in the automation authority and grant both the connection and the T2 capability:

```yaml
automation:
  enabled: true
  observation: true
  execution: true
  maximumRiskTier: T2
  allowedCapabilities: [publish.web]
  allowedConnections: [website]
  publishConnections:
    website:
      cloudConfigFile: ~/.config/knot/cloud.json
      allowedSiteIds:
        - 00000000-0000-4000-8000-000000000001
      allowedSlugPrefixes: [notes/]
      allowUpdate: true
      allowRollback: false
      allowDisable: false
      allowUnpublish: false
```

The workflow step names `website`; it never receives the Cloud URL or key:

```yaml
- id: publish-release
  kind: publish.web
  config:
    action: create
    connectionRef: website
    siteId: 00000000-0000-4000-8000-000000000001
    publicationId: 00000000-0000-4000-8000-000000000002
    slug: notes/release
    document:
      schemaVersion: "1.0"
      title: Release notes
      blocks:
        - type: paragraph
          content:
            - text: The release is ready.
              marks: []
```

Declare `publish.web` in the workflow's `spec.capabilities`. It is T2, so an exact explicit manual
approval is mandatory. Changing document text, destination, lifecycle operation, connection, or
local named-connection policy invalidates the applicable approval. Publication text is not retained
in the workflow database; execution refetches and re-verifies the Anytype definition before the
existing Cloud publication outbox commits the effect.
