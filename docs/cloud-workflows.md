# Run cloud commands through a local Knot workflow runtime

Status: default-off local preview. The imai service exposes the signed command routes and includes
an authenticated `actor.principalDigest` and `actor.digestVersion` in each command envelope. Do not
enable the bridge against a service that does not advertise that contract.

Knot Cloud never connects to the laptop. A paired connector signs an outbound claim request, writes
the returned command to the agent's private SQLite state, checks local policy, and then runs the
effect from the existing workflow-runner tick. Cloud polling does not start another scheduler or
open a listener.

## Configure the local boundary

Pair the connector first. Add the cloud command gate to the agent configuration only after the
Cloud deployment advertises the matching contract:

```yaml
automation:
  enabled: true
  observation: true
  execution: true
  # Keep the existing workflow authority fields here.

cloudCommands:
  enabled: true
  cloudConfigFile: ~/.config/knot/cloud.json
  allowedCreatorKinds:
    - human-session
  allowedActorDigests:
    - replace_with_an_authenticated_cloud_principal_sha256_digest
  allowedSpaceIds:
    - replace_with_an_allowed_space_id
  # Required before granting anytype.chats.send. These are immutable native
  # Anytype participant IDs, never display names or Cloud-provided claims.
  allowedOriginParticipantIds:
    - replace_with_an_authorized_native_participant_id
  allowedScopes:
    - anytype.objects.read
    - anytype.chats.send
  approval: writes
```

The Cloud grant and this list are both required. Neither can expand the other. `approval: writes`
lets bounded reads proceed and holds mutations for an operator. Use `all` to hold every command or
`none` only in an isolated installation with an equally narrow actor, space, and scope list.

The actor digest is issued by the authenticated Cloud boundary. Knot does not derive authority from
an email address, display name, request body, or claimed Anytype participant ID. For data returned
from Anytype, the local connector creates provenance from the native participant information it
observed and sends only a domain-separated digest.

## Inspect and decide commands

These commands read the agent's state database. They never print the command lease token or
connector private key.

```bash
knot cloud commands list --agent-config /private/path/agent.yaml
knot cloud commands show <command-id> --agent-config /private/path/agent.yaml
knot cloud commands approve <command-id> --agent-config /private/path/agent.yaml
knot cloud commands reject <command-id> --reason policy-name --agent-config /private/path/agent.yaml
knot cloud commands cancel <command-id> --agent-config /private/path/agent.yaml
knot cloud commands retry <command-id> --agent-config /private/path/agent.yaml
knot cloud commands result-retry <command-id> --agent-config /private/path/agent.yaml
```

Retry is refused when an external effect may already have happened. After a process stops with a
mutation in flight, Knot records `effect-outcome-unknown`, dead-letters the command, and does not
repeat it. Reconcile the external system first.

## Recovery and result delivery

Knot persists the full claimed envelope before applying policy or starting an effect. Mutable Cloud
lease fields may advance to a newer fenced attempt, while changes to the command actor, payload,
scope, connector, or lifetime are rejected as an immutable replay mismatch.

Each command has one stable effect key and one durable receipt. A result reaches
`terminal_pending` only when the receipt's fencing token matches. Knot then submits that exact
stored result with the Cloud attempt and lease token. A duplicate Cloud acknowledgement is safe.
Retryable reads and idempotent publication controls use bounded backoff; unsafe mutations do not
repeat automatically.

Permanent command-result rejections (HTTP 400/404/409/410/422 or a mismatched receipt fence) back
off per stored result, starting at 30 seconds and doubling between failures. After five permanent
rejections, result submission is quarantined and an operator status projection is queued. The
stored result, effect receipt, Cloud attempt/fence, and unacknowledged completion state remain
intact. A matching late acknowledgement can still complete that exact result safely. Quarantined
and not-yet-due records do not occupy the next submission batch; healthy commands continue.

`knot doctor` reports pending, backing-off and quarantined result-submission counts. The command
inspection output includes submission attempts and safe error codes. After resolving the Cloud
rejection, a local operator can use `result-retry` to reschedule reporting of the stored result.
This is separate from effect retry: it does not rerun an effect, renew authority, or change the
Cloud attempt/fence. It uses the existing protected local CLI operator boundary and is not exposed
as a model-facing management tool. Auth failures (401/403), exhausted clock correction, rate limits,
and transport failures defer the network batch and do not spend the permanent rejection budget.

`notBefore` and `expiresAt` are evaluated with the same server-adjusted clock used to sign Cloud
requests. A command received before `notBefore` remains durably queued at that timestamp; it is not
reported as a policy rejection. Clock-skew responses update that shared offset before the next
dispatch decision.

## Transactional channel actions

`chat.send` has an additional local authority fence. Its typed Cloud command contains a
`channelOrigin` lookup pointer with a space, chat, and message ID. It contains no trusted participant
identity. The origin must be in the same destination channel.

Immediately before sending, Knot calls Anytype for that exact message, derives the immutable native
participant from the response, and compares it to `allowedOriginParticipantIds`. A missing message,
mismatched ID, missing native participant, or participant not in the local list produces a terminal
local-policy rejection. A Cloud-supplied display name, mention, participant ID, or actor digest
cannot substitute for this check.

The action still enters through the existing signed Cloud command claim protocol and the durable P6
runner. It does not start a second poller or scheduler. The command's immutable digest, manual
approval when configured, effect receipt, lease fence, result outbox, and crash quarantine remain
the same as other Cloud workflow effects.

Optional Anytype audit projection uses its own durable outbox:

```yaml
cloudCommands:
  # ...policy above...
  projection:
    enabled: true
    spaceId: replace_with_an_audit_space_id
    chatId: replace_with_an_audit_chat_id
```

Projection writes come from the dedicated agent member, so the existing self-message suppression
prevents them from waking the same agent. Projection delivery failures do not change command
success and dead-letter after bounded retries.

## Failure meanings

- `actor-principal-denied`: the authenticated Cloud principal digest is not locally allowed.
- `scope-denied` or `space-denied`: the Cloud grant may include the request, but local policy does
  not.
- `command-expired`: execution did not begin within the signed command lifetime.
- `effect-outcome-unknown`: the process stopped during an external mutation; automatic replay is
  unsafe.
- `unsupported-operation`: the installed Anytype adapter cannot perform that typed operation.

Use `knot cloud commands list` for local state and the Cloud operation endpoint for the remote
state. Do not infer success from a lost lease or a missing worker process.

## Local responsiveness and cancellation

Cloud command lease/result/poll work shares a one-second budget per runner tick. The first network
or global authorization failure defers remaining network work until the configured poll interval.
Per-command permanent result rejections use their own durable backoff/quarantine. Status projection has a
separate one-second budget. Local run reauthorization and cancellation run before extension I/O.
The built-in Cloud and Anytype clients propagate cancellation through queued and active HTTP
requests and retry delays; extension shutdown aborts and awaits its tracked work. Custom injected
ports must honor the supplied AbortSignal.

If shutdown interrupts an effect that may have reached Anytype, its durable receipt becomes
`outcome_unknown`. Knot does not guess success or automatically repeat an uncertain write. A late
network response cannot persist a new lease or command after cancellation.

`chat.send` reads the native origin again and checks its sender against current local policy. It
does not impose an origin age limit or bind the requested text to a command-specific native consent
message. Keep this default-off bridge disabled where that stronger consent policy is required;
the age/content policy remains planned work.
