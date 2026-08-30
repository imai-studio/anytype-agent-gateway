# Sanitized v0.1.3 upgrade fixture

This fixture models an installed AAG v0.1.3 agent without containing live credentials, participant
IDs, invite links, or project paths.

- `state.sql` is a portable SQLite fixture with a baselined route, handled message/version,
  persisted Codex session binding, generation, wake authorization override, and delivered outbox
  dedupe record.
- `agent.yaml` retains v0.1.3 config keys, paths, route authorization, and service-facing settings.
- `environment.env` records legacy variable _names_ with synthetic non-secret values.
- `anytype-agent-gateway.service` captures the legacy service identity and command shape.
- `protocol-messages.json` captures legacy AAG response markers.

Tests materialize the SQL in a private temporary directory, open it with the current Store, and
prove the route cursor, handled-message fingerprint, session binding, authorization override, and
dedupe record remain intact. The synthetic historical message remains handled and therefore cannot
be replayed.
