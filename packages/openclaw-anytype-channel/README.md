# OpenClaw Anytype channel

`@imai/openclaw-anytype-channel` makes an Anytype chat or object discussion a native OpenClaw channel. AAG remains the Anytype transport owner; this plugin owns OpenClaw session routing and observes native agent output.

The package does not add a scheduler. Cron jobs, heartbeats, background work, and session tools continue to use OpenClaw's scheduler. Once a session is bound to an Anytype route, output produced by those native systems is delivered back to that route.

## What it guarantees

- One OpenClaw session key per Anytype chat.
- One separate threaded session key per object-discussion root.
- The binding from an exact OpenClaw session key to an exact Anytype route is persisted in SQLite.
- Normal replies and proactive session output use the same native channel delivery route.
- Assistant, thinking, tool, item, and lifecycle events are forwarded with stable `runId` and `seq` values for streaming and deduplication.
- Inbound and outbound bridge records survive process restarts.
- The bridge binds only to loopback and requires a bearer token.
- The sender allowlist is checked again inside the OpenClaw process, even if AAG already checked it.

## Install

Build or install the package, then install it as an OpenClaw plugin:

```bash
pnpm --filter @imai/openclaw-anytype-channel build
openclaw plugins install /absolute/path/to/anytype-agent-gateway/packages/openclaw-anytype-channel
```

Use a random bridge token of at least 24 characters. Keep it outside the repository.

```json5
{
  channels: {
    anytype: {
      enabled: true,
      listenHost: "127.0.0.1",
      listenPort: 18791,
      bridgeToken: "${AAG_OPENCLAW_BRIDGE_TOKEN}",
      databasePath: "/home/anya/.openclaw/anytype/default.sqlite",
      allowFrom: ["the-exact-anytype-participant-id"],
    },
  },
}
```

The bridge is pull-only: AAG reads its durable loopback outbox, then acknowledges records after they are durable in AAG.

Restart the OpenClaw gateway after enabling the plugin. The standard AAG runtime keeps using the OpenClaw Gateway for starts and steering, then registers that exact operator session through `POST /v1/bindings`. The bridge also supports native-channel ingress at `POST /v1/inbound` for hosts that use the package directly.

## Bridge contract

### AAG to OpenClaw

`POST /v1/bindings` associates an already-created Gateway/operator session with its Anytype route before the run starts:

```json
{
  "accountId": "default",
  "sessionKey": "aag:chat:space-id:chat-id",
  "route": {
    "spaceId": "space-id",
    "chatId": "chat-id",
    "discussionRootId": "optional-root-message-id"
  }
}
```

This hybrid path is what the bundled AAG runtime uses. It preserves native `sessions.steer` and makes events from later OpenClaw cron, heartbeat, subagent, and session-continuation runs observable on the same route without starting a second OpenClaw session.

After OpenClaw returns a run ID, AAG registers it through authenticated `POST /v1/owned-runs`. The plugin persists that ownership marker and attaches it to the run's deliveries, so an AAG restart between projection and acknowledgement cannot mirror the operator run as a second proactive reply.

`POST /v1/inbound`

```json
{
  "id": "globally-stable-anytype-event-id",
  "accountId": "default",
  "route": {
    "spaceId": "space-id",
    "chatId": "chat-id",
    "discussionRootId": "optional-root-message-id"
  },
  "message": {
    "id": "message-id",
    "senderId": "participant-id",
    "senderName": "Raj",
    "text": "@Anya review this",
    "replyToId": "optional-message-id",
    "wasMentioned": true,
    "createdAt": 1787940000000
  }
}
```

The response is `202` for a new event or `200` for a duplicate. A failed dispatch can be retried by posting the same ID again. Check `GET /v1/inbound/:id` when AAG needs a delivery receipt.

The route is converted to an opaque OpenClaw target. New targets persist the optional discussion root as a third encoded field and also use it as OpenClaw's native thread suffix; legacy two-field chat targets remain valid. This makes two root discussions under one object distinct even when transient thread context is unavailable. An explicit OpenClaw thread ID overrides the encoded root. `/new` is passed through as an authorized native command; it resets OpenClaw context without changing the Anytype route.

### OpenClaw to AAG

The payload kind is either `agent-event` or `message-final`. `agent-event` preserves native `runId`, `seq`, stream, timestamp, and sanitized event data. `message-final` is the channel's durable final delivery. AAG should project agent events for live thinking/text and reconcile the final delivery into the same output cycle rather than creating a duplicate message.

AAG pulls `GET /v1/outbox`. Standalone final records are acknowledged with `POST /v1/outbox/:id/ack`; a run's event records are retained until its terminal event and acknowledged atomically with `POST /v1/outbox/ack`. A process restart therefore reconstructs the run from the plugin's durable records instead of losing already-seen chunks.

Delivered records are retained for seven days. Pending records with no matching live route or no terminal lifecycle event expire after 30 days, preventing abandoned bindings from growing the outbox forever. Plaintext thinking events are ephemeral: live thinking remains available for streaming, while abandoned pending thinking expires after one hour.

## Native scheduling and external continuation

The first inbound Anytype message persists the route/session binding. After that, a heartbeat, subagent announcement, `sessions_send`, or another OpenClaw client that continues the same session can deliver agent output to the bound Anytype route. The plugin does not mirror the external user prompt; it forwards agent output only.

Plain cron `agentTurn` jobs run in an isolated cron session. To preserve the bound Anytype session, schedule a native command job that invokes `openclaw agent --session-key <bound-key> … --deliver --reply-channel anytype --reply-to <route-target>`. The standard AAG `aag_context` tool returns the complete argv for the current chat or discussion root.

For a proactive job that has never received an Anytype message, use OpenClaw's normal outbound routing to the Anytype target first. There is no safe route to infer before a chat or discussion has been bound.

## Current boundaries

- Text, replies, and discussions are implemented. Media upload and Anytype reactions remain AAG responsibilities.
- AAG must implement the delivery endpoint or poll the outbox. The standard AAG runtime polls and acknowledges it. The plugin deliberately does not receive an Anytype API key.
- OpenClaw emits sanitized thinking events, not hidden model chain-of-thought. AAG may display only the safe progress text present in those events.
- The final channel delivery and assistant event stream describe the same run. AAG must deduplicate using the idempotency key and reconcile by session/run/output cycle.
- A session becomes eligible for event mirroring only after its route binding exists. This prevents output from unrelated OpenClaw sessions leaking into Anytype.
- Pull recovery matches deliveries carrying `sessionKey` only against that exact active key. Route fallback applies only to deliveries without a session key, so output from a pre-`/new` generation cannot leak into the replacement session.
- AAG binds the route only after OpenClaw accepts a run, using the canonical `agent:<id>:...` session key returned in that acknowledgement. The requested alias is not written to the plugin binding table.
- Unacknowledged outbound records are durable across restarts. Delivered records and owned-run markers are retained for seven days; abandoned pending records are retained for 30 days, except plaintext thinking events, which expire after one hour. Cleanup never cancels or times out an OpenClaw run.
- One plugin process may host multiple configured accounts, but every account needs a distinct loopback port and SQLite path.

## Package checks

```bash
pnpm --filter @imai/openclaw-anytype-channel run check
```

The focused tests cover route identity, chat/discussion separation, persistence, idempotency, failed-ingress replay, authenticated HTTP ingress, pull recovery, acknowledgement, and outbound retry.
