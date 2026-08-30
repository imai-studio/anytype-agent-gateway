# Upgrade and rollback from AAG

Knot never moves or deletes an AAG configuration or database. Stop any foreground AAG process,
then inspect the migration plan:

```bash
knot migrate --dry-run
knot migrate --dry-run --json
```

`knot migrate` copies the legacy configuration, SQLite state, support files, and macOS logs to the
Knot paths. It rejects symlinks and non-regular files, preserves modes, writes through same-filesystem
temporary files/directories, fsyncs before rename, and compares file sizes and SHA-256 digests. For
SQLite it additionally runs `quick_check` and `integrity_check` and compares route cursors, handled
message versions and fingerprints, session bindings and generations, authorization overrides,
outbox dedupe/delivery state, proactive deliveries, and bridge cursors. The schema is not rebranded
or converted. Existing identical destinations make the command idempotent; any divergent destination
stops the migration. A `-wal` or `-shm` sidecar means state is not safely quiescent and must be
resolved by cleanly stopping AAG before retrying.

After a successful copy, run `knot service migrate --dry-run`, followed by `knot service migrate`.
Service migration requires exactly the legacy definition and no Knot definition. It verifies the
copy, disables and stops AAG, retains its definition as a timestamped `.pre-knot-*.bak`, installs
Knot, and proves AAG is inactive while Knot is enabled and running. A failed transition restores and
restarts the legacy service. JSON output excludes configuration contents and credentials.

Every migration writes a manifest below `~/.local/state/knot-migration-manifests`. Keep it and the service
backup until the upgrade has been observed under normal traffic.

## Rollback

Linux:

```bash
systemctl --user disable --now knot.service
mv LEGACY_BACKUP ~/.config/systemd/user/anytype-agent-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now anytype-agent-gateway.service
```

macOS:

```bash
knot service stop
mv LEGACY_BACKUP ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist
launchctl enable gui/$(id -u)/com.anytype.anytype-agent-gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist
```

Never start AAG against copied Knot state after Knot has accepted new traffic; rollback uses the
untouched legacy database. If both services are reported, inspect and disable the unexpected service
instead of deleting either definition. Lock contention names a live process; stale locks are reclaimed
only after signal-zero proves their owner is gone.

Both `knot-heart-adapter` and `aag-heart-adapter` are discovered. Install the new binary without
removing the old one. The OpenClaw channel, `aag_*` MCP tools, `aag:` persisted keys, legacy response
markers, and OpenClaw `aag` profile are not rewritten.
