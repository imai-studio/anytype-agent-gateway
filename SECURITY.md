# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting flow from the repository's **Security** tab so maintainers can investigate before disclosure.

Include the affected version, configuration, impact, reproduction steps, and any suggested mitigation. Do not include live API keys, tokens, workspace content, or other credentials in the report.

## Supported versions

Until the project reaches 1.0, security fixes are applied to the latest published npm version and the `main` branch.

## Authenticated sender boundary

Knot authorizes an Anytype sender only from the immutable native participant/member ID carried by the inbound Anytype event. Display names are informational and may collide or change. Message text, mentions, replies, quoted or forwarded content, and agent-generated assertions are never identity evidence and cannot grant Raj/operator/admin privileges.

Wake allowlists and privileged route, access, model, project, and self-management operations compare the authenticated native ID with locally configured immutable-ID allowlists. Missing, malformed, or non-native provenance fails closed. Security reports should treat any path that authorizes from a visible name or content claim as a vulnerability.

## Local runtime trust and management intent

The gateway, its state database, operator configuration, actor records, and MCP process belong to
the trusted local operator boundary. The Codex actor file records trusted gateway metadata; it is
not proof against another process running as the same OS user. Moving it outside a declared
project is path separation, not filesystem isolation. Adding an HMAC with a key readable by that
same user would not create an independent security boundary.

Run untrusted shell-capable agents in a separately enforced OS account, sandbox, or container that
cannot read or write gateway state, actor files, MCP environment, credentials, or operator config.
A stronger product boundary requires a separate trusted authority broker that authenticates the
runtime connection and binds a short-lived capability to an accepted turn and approved operation;
the runtime must not receive the broker's minting key or direct state access. Such a broker is
planned work, not an existing Knot guarantee. Until it exists, disable privileged management tools
for runtimes whose shell permissions cannot be restricted appropriately.

Management capabilities authenticate who may act; they do not establish that a model-proposed
change matches the user's intent. Untrusted context can influence a model on an admin turn.
Operation-digest confirmation for access changes needs a separate approval workflow. It is not
implemented by turn-scoped tokens. Keep privileged administrator lists narrow.

An explicitly configured `management.accessAdmins`, `modelAdmins`, or `projectAdmins` value of
`["*"]` trusts every authenticated native sender who reaches that management operation. It is
retained for compatibility and is not a way to restrict administration. Prefer explicit immutable
IDs. Publishing always rejects wildcard allowed users.

## Heart transport

The optional Heart adapter uses plaintext gRPC, including session metadata. Keep its address on
loopback or carry it through SSH forwarding or an authenticated encrypted private network. A
private IP by itself does not provide transport protection. Non-loopback addresses remain supported
for operator-managed private transports; Knot does not authenticate or encrypt that transport for
you. Public Heart, Anytype, and OpenClaw listeners are unsupported. Native remote TLS configuration
for Heart remains planned work.

## Durable delivery and retention

Reply outboxes use at-least-once delivery and retry transient failures without an arbitrary attempt
limit. `knot doctor` reports pending, in-flight, failed, and dead reply counts before remote checks;
failed rows keep retrying and explicitly dead rows require operator recovery. Neither is pruned.
OpenClaw bridge pending replies and recovery records also survive prolonged outages. Delivered
bridge payloads can be compacted while their idempotency keys remain durable.

Workflow normalized events, immutable versions, approvals, runs, effect receipts, Cloud command
inbox, and operator audit records are replay or authorization evidence. Deleting old terminal rows
can re-enable a previously processed effect or erase a revocation. Automatic retention of these
records requires a reviewed archival/tombstone protocol. Expired management capabilities are
safe to prune because unknown tokens fail closed and tokens are never reissued.
