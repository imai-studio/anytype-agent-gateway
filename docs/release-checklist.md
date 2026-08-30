# Knot v0.2.0 release and rename checklist

This checklist is for the behavior-neutral Phase 1 release. It does not authorize Phase 2 workflow
features or any production mutation beyond the explicitly selected test chats.

## Automated release candidate

Run from a clean commit on Node 24+ and pnpm 11.22.0:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run release:gates
git diff --exit-code -- dist packages/openclaw-anytype-channel/dist

(cd heart-adapter && go test ./... && go vet ./... && go build -o /tmp/knot-heart-adapter .)
```

Inspect the publishable archive without publishing:

```bash
npm pack --ignore-scripts --dry-run --json
```

The archive must identify `@imai/knot@0.2.0`, contain the Apache `LICENSE`, `NOTICE`,
`THIRD_PARTY_NOTICES.md`, compiled CLI, bundled OpenClaw channel, agent setup, compatibility matrix,
and upgrade guide, and exclude source tests, state, credentials, and local configuration.

## Repository rename and npm trusted publishing

1. Merge the complete Phase 1 stack and confirm CI passes on the release commit.
2. Rename `imai-studio/anytype-agent-gateway` to `imai-studio/knot` in GitHub settings.
3. Verify the old URL redirects to the same commit. Never create another repository with the old name.
4. Confirm branch protection, private vulnerability reporting, Actions permissions, environments,
   secrets, and deploy keys survived the rename.
5. In npm, confirm the maintainer can create/publish public packages in the `@imai` scope.
6. Create or select `@imai/knot` and register the trusted publisher as GitHub organization
   `imai-studio`, repository `knot`, workflow `publish.yml`, environment `npm`.
7. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`. The workflow uses GitHub OIDC and npm provenance.
8. Push signed tag `v0.2.0`, draft the GitHub release, verify the tag points to the reviewed commit,
   then publish the GitHub release. Confirm npm provenance links to that workflow and commit.
9. From an upgrade machine, run `pnpm ls --global --depth 0`, remove an installed legacy package
   with `pnpm remove --global @imai/aag`, then run `pnpm add --global @imai/knot@0.2.0` and
   `pnpm add --global github:imai-studio/knot#v0.2.0`; both `knot --version` and `aag --version`
   must print `0.2.0`.

The publish workflow refuses to run before the GitHub repository name is exactly
`imai-studio/knot`. npm scope authorization and trusted-publisher registration are external
maintainer prerequisites; repository code cannot grant them. The ancestry and redirect checks use
anonymous GitHub access because this is a public repository; if visibility changes, update those
checks deliberately rather than adding credentials to the publish job.

## Live dry-run: Codex Klee

Use existing protected config/key files. Do not paste secrets, participant IDs, invite URLs, tokens,
or project paths into a transcript.

```bash
knot --version
knot validate --config "$KLEE_KNOT_CONFIG"
knot doctor --config "$KLEE_KNOT_CONFIG"
knot migrate --dry-run --json
```

Stop Klee's current foreground/service process before any real migration. In one pre-approved test
chat, verify: authorized native-ID mention wakes Klee; an attacker using the same display name does
not; an authorized `/new` preserves the route while changing session generation; one already-handled
fixture message is not replayed; steering updates the follow-up reply; and denied permission remains
denied. Record only pass/fail and non-sensitive message IDs if needed.

## Live dry-run: OpenClaw Anya

```bash
knot validate --config "$ANYA_KNOT_CONFIG"
knot doctor --config "$ANYA_KNOT_CONFIG"
knot openclaw plugin path
knot migrate --dry-run --json
```

In one approved test route, verify one native session binding, steering, durable assistant output,
and a command-job continuation created from fresh `aag_context` output. Verify both Heart lookup
combinations in a disposable `PATH`: Knot configured/legacy installed and legacy configured/Knot
installed. Do not print the bridge token, Gateway token, API key, or continuation arguments.

For both Klee and Anya, repeat the sender-auth spoof cases: renamed authorized member succeeds;
duplicate display name, text claiming “Raj/operator/admin,” mention of an admin, reply to an admin,
and forwarded admin text all remain unauthorized because only the immutable native ID is authority.

## Live migration and exact rollback

After dry-run review and a maintenance window:

```bash
knot service migrate --json
knot service status
```

Confirm the returned manifest and legacy service backup exist without printing their contents.
Verify exactly one Knot process owns the migrated state and no historical message is delivered.

Linux rollback:

```bash
systemctl --user disable --now knot.service
rm -f ~/.config/systemd/user/knot.service
mv LEGACY_BACKUP ~/.config/systemd/user/anytype-agent-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now anytype-agent-gateway.service
```

macOS rollback:

```bash
knot service stop
rm -f ~/Library/LaunchAgents/com.imai.knot.plist
mv LEGACY_BACKUP ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist
launchctl enable gui/$(id -u)/com.anytype.anytype-agent-gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.anytype.anytype-agent-gateway.plist
```

Rollback always uses the untouched AAG config and state. Never point old AAG at a Knot copy after
Knot has accepted new traffic.
