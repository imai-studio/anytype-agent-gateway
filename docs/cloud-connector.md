# Connect a local Knot runtime to Knot Cloud

Status: the local connector identity, pairing poller, protocol checks, signed command client, typed
publication client, and durable publication outbox are implemented in this repository. They require
a Knot Cloud deployment that includes the matching routes; check its release notes before assuming a
particular deployment supports them.

## What the connection permits

Knot Cloud stores the connector public key and the grants approved by a workspace owner or admin.
The private key stays on the machine running Knot. The connector makes outbound HTTPS requests; it
does not open a public listener.

A cloud grant does not override local policy. Every claimed command must still pass the local
participant, space, operation, project, file, runtime, and approval checks before an adapter may
execute it. The signed client exposes claim, lease extension, result, and local-policy rejection
operations. It does not execute a command by itself.

## Prepare the connector

Run:

```bash
knot cloud login \
  --url https://knot.example.com \
  --name "Raj's MacBook" \
  --scope anytype.objects.read anytype.chats.read
```

`cloud login` verifies the server protocol, creates an Ed25519 identity, and prints the public key
and dashboard URL. It does not sign the CLI into a human account. Email authentication and connector
approval remain in the browser.

By default, Knot writes:

```text
~/.config/knot/cloud.json
~/.config/knot/cloud-connector-ed25519.pem
```

The directory uses mode `0700` and both files use mode `0600` on Unix systems. Set
`KNOT_CLOUD_CONFIG` or pass `--config` to choose a different config file. Do not put the config or
private key in a repository, shared folder, or shell transcript.

## Pair the connector

1. Sign in to the dashboard URL printed by `cloud login`.
2. Open **Connectors** and start a pairing request.
3. Paste the connector name and public key printed by the CLI.
4. Select the requested scopes and optional publication slug grants. Review them before submitting.
5. Copy the one-time pairing JSON into a private file. Do not paste it into a command argument.
6. Poll for the decision:

```bash
chmod 600 /private/path/pairing.json
knot cloud pair --credentials-file /private/path/pairing.json
rm /private/path/pairing.json
```

Use `--credentials-file -` to read the JSON from standard input. Use `--once` when a service or
script should poll once and exit. An interrupted pending request can resume with `knot cloud pair`
because Knot keeps the one-time token in its private config directory until the request completes.

The server returns an approved pairing result only once. If the CLI reports that the result was
already consumed, revoke any connector created by that attempt in the dashboard and create a new
request. This avoids trusting incomplete local state.

## Inspect and remove the connection

```bash
knot cloud status
knot cloud doctor
knot cloud revoke
```

`status` reports local pairing state and checks whether the server is reachable. It never prints the
private key or pairing token. `doctor` checks key consistency, file permissions, server protocol,
and the locally recorded grant.

Remote revocation requires an authenticated workspace owner or admin, so `cloud revoke` prints the
exact dashboard location. Revoke the connector there first. Then remove this machine's local key and
configuration:

```bash
knot cloud revoke --forget-local
```

The `--forget-local` flag does not revoke the remote connector. If the dashboard connector remains
active, deleting the local key only makes that connector unusable and leaves stale remote state.

## Signed command transport

The local client signs the method, authority, path, query, timestamp, nonce, and SHA-256 body digest
with Ed25519. Each retry receives a new nonce and signature. Retryable network and server failures
use bounded exponential backoff. Clock-skew responses update an in-memory offset from authenticated
problem details; the local clock is never changed.

The currently implemented transport methods are:

```text
POST /api/v1/connectors/{connectorId}/commands/claim
POST /api/v1/connectors/{connectorId}/commands/extend
POST /api/v1/connectors/{connectorId}/commands/result
```

The claim call is the connector's outbound poll. The cloud contract does not currently define a
separate signed heartbeat route. Connector status in the local CLI therefore means local state plus
protocol reachability, not proof that the cloud has recorded a recent heartbeat.

The publication commands use only the signed connector routes frozen in the Cloud contract. See
[`cloud-publishing.md`](cloud-publishing.md) for typed document input, asset manifests, durable
operation status, lifecycle controls, and the constrained `aag_publish` tool.

## Troubleshooting

- **Protocol mismatch:** update either Knot or the selected Cloud deployment. The client refuses to
  negotiate an unknown version.
- **Pairing denied or expired:** create a new request in the dashboard. A final poll consumes the
  one-time result.
- **Clock skew:** synchronize the machine clock. The client may compensate for the server response
  during the current process, but repeated skew usually means the host clock needs repair.
- **Lease lost:** do not execute or resubmit the effect. A later worker may receive a new attempt.
- **Scope rejected locally:** update local policy only after reviewing the caller and requested
  operation. A cloud grant is not local authorization.
