# Upgrade and rollback from AAG

Knot 0.2.0 is prepared but not yet published. The npm command below is for use after trusted
publishing completes; use the checkout-local installation while preparing the release.

Before running a new Knot binary's `doctor` or `run` against existing state, stop all gateway and
MCP writers and take a private SQLite-consistent backup using the backup API or `.backup`. Doctor
opens the state store and can migrate it. Preserve configuration, identity/key references, service
definitions, context registries, and the independently installed OpenClaw plugin's state/artifact.
Stop the plugin writer for its snapshot. Do not copy a live database without its committed WAL data.

The first release supports upgrades from schemas 7, 17, and 18 to schema 19. The store creates a
private pre-migration snapshot before applying the applicable migration chain. Migration 18
expires pre-thread-binding ephemeral capabilities; migration 19 adds durable result-submission
retry metadata while preserving results, effect receipts and completion state. Fresh authenticated
turns replace expired capabilities. Earlier binaries reject schema 19 rather than downgrading it.

If the old package was installed globally, remove it before installing Knot so both packages do not
compete for the `aag` executable shim:

```bash
pnpm ls --global --depth 0
pnpm remove --global @imai/aag
pnpm add --global @imai/knot@0.2.0
```

Knot never moves or deletes an AAG configuration or database. Stop any foreground AAG process,
then inspect the migration plan:

```bash
knot migrate --dry-run
knot migrate --dry-run --json
```

If this machine uses an agent-specific config such as `~/.config/aag/klee/agent.yaml`, select it
explicitly. Knot preserves the relative layout as `~/.config/knot/klee/agent.yaml` and maps an
explicit `state.path` beneath `~/.local/state/aag` to the corresponding Knot state tree. A nested
config without an explicit `state.path` uses the shared `~/.local/state/aag` tree exactly as AAG did;
set an explicit per-agent path when the state lives in a nested directory:

```bash
knot migrate --config ~/.config/aag/klee/agent.yaml --dry-run --json
knot service migrate --config ~/.config/aag/klee/agent.yaml --dry-run --json
```

`knot migrate` copies the legacy configuration, SQLite state, support files, and macOS logs to the
Knot paths. It rejects symlinks and non-regular files, preserves modes, writes through same-filesystem
temporary files/directories, fsyncs before rename, and compares file sizes and SHA-256 digests. For
SQLite it also runs `quick_check` and `integrity_check` and compares route cursors, handled
message versions and fingerprints, session bindings and generations, authorization overrides,
outbox dedupe/delivery state, proactive deliveries, and bridge cursors. The schema is not rebranded
or converted. Existing identical destinations make the command idempotent; any divergent destination
stops the migration. A `-wal` or `-shm` sidecar means state is not safely quiescent and must be
resolved by cleanly stopping AAG before retrying.

After a successful copy, run `knot service migrate --dry-run`, followed by `knot service migrate`
(passing the same `--config` when one was selected).
Service migration requires exactly the legacy definition and no Knot definition. It verifies the
copy, disables and stops AAG, retains its definition as a timestamped `.pre-knot-*.bak`, installs
Knot, and proves AAG is inactive while Knot is enabled and running. A failed transition restores and
restarts the legacy service. JSON output excludes configuration contents and credentials.

Every migration writes a manifest below `~/.local/state/knot-migration-manifests`. Keep it and the service
backup until the upgrade has been observed under normal traffic.

## Rollback

The service-name rollback below describes the historical rename. An already-renamed Knot service
should retain its identity and paths during an artifact upgrade. Restore a pre-upgrade database
only with matching artifacts/configuration, stopped writers, and no stale WAL/SHM sidecars. Once
new traffic has been accepted, preserve the newer database and prefer a forward fix: restoring an
old snapshot can lose replies or approvals and repeat external effects. State reconciliation is
required before a rollback in that case; merely replacing the executable cannot downgrade schema 19.

Linux:

```bash
systemctl --user disable --now knot.service
rm -f ~/.config/systemd/user/knot.service
mv LEGACY_BACKUP ~/.config/systemd/user/anytype-agent-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now anytype-agent-gateway.service
```

macOS:

```bash
knot service stop
rm -f ~/Library/LaunchAgents/com.imai.knot.plist
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

## Troubleshooting

- **AAG or Knot lock is live:** stop the named foreground process or service. Knot reclaims a stale
  lock only after signal-zero proves the PID is gone; never delete a live lock to force startup.
- **SQLite `-wal` or `-shm` exists:** AAG did not quiesce cleanly. Stop it and allow SQLite to
  checkpoint/close. Do not copy only the main database while a WAL contains newer committed state.
- **Divergent destination:** keep both trees untouched and compare the migration manifest, sizes,
  hashes, and operator changes. Knot will not overwrite a destination that may contain newer traffic.
- **Both service definitions exist:** disable and stop both, identify the exact timestamped legacy
  backup and intended Knot config, then follow rollback or resume. Do not guess which identity owns
  the database.
- **No legacy service found:** `service migrate` requires the exact supported legacy identity. A
  custom supervisor must be stopped and migrated manually around `knot migrate`.
- **Heart adapter not found:** run `knot doctor`, inspect the service `PATH`, and retain either
  `knot-heart-adapter` or `aag-heart-adapter`. Do not expose Heart gRPC beyond loopback/private transport.
- **Unauthorized sender unexpectedly wakes:** stop Knot and treat this as a security issue. Authority
  must come only from the immutable native Anytype participant/member ID; names and message content
  are never evidence.
- **npm publish does not start:** the workflow runs only when the `v0.2.0` GitHub release is
  published. It also verifies the `imai-studio/knot` repository name. Confirm the release tag,
  `@imai` scope authorization, and npm trusted-publisher tuple in the
  [release checklist](release-checklist.md). Do not add a long-lived token as a workaround.

See the [compatibility matrix](compatibility.md) for surfaces intentionally retained through the
0.2.x/0.3.x window.
