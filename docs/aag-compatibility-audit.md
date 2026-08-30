# Retained AAG compatibility audit

Knot keeps the following AAG surfaces intentionally. This inventory is the review guide for every
remaining `AAG`, `aag`, `anytype-agent-gateway`, and `@imai/aag` match after the Phase 1 rename.

| Retained surface                                                    | Locations                                                                                                                                          | Reason                                                                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AAG_*` environment variables                                       | `src/compatibility.ts`, runtime environment projection, process scrubbing, tests, and the v0.1.3 fixture                                           | Deprecated input aliases remain accepted through the centralized P1 resolvers; actor and route variables also remain available to existing integrations. |
| `aag_*` MCP tool/server names                                       | `src/mcp.ts`, runtime registration, onboarding prompts, docs, and tests                                                                            | Tool names are a permanent protocol compatibility surface and are not renamed.                                                                           |
| `[[AAG_*]]` response markers                                        | protocol parsing/projection, prompts, docs, and tests                                                                                              | Legacy markers remain readable and writable; Knot markers are additive.                                                                                  |
| `aag:` session, route, cursor, dedupe, and discovery keys           | gateway/controller/store/runtime/plugin code and tests                                                                                             | Persisted keys must not change, so existing sessions continue and historical messages are not replayed.                                                  |
| `.aag/context`, `.aag/attachments`, and `.aag` lock/backup suffixes | context projection and Codex Desktop integration                                                                                                   | Existing workspace context and recovery files remain discoverable without conversion.                                                                    |
| AAG config/state/service/log/Heart names                            | `src/compatibility.ts`, `src/service.ts`, `src/migration.ts`, `src/onboarding.ts`, legacy fixture, compatibility tests, and migration/release docs | Knot discovers legacy installations in place and P3 copies/verifies them without deleting or rewriting the source.                                       |
| `anytype-agent-gateway` external handshake identifiers              | Codex ACP and Codex Desktop adapters and tests                                                                                                     | These protocol-facing client identifiers stay stable until the external consumers explicitly guarantee rename safety.                                    |
| OpenClaw profile `aag`                                              | `deploy/openclaw-knot-gateway.service` and operator-owned OpenClaw configuration                                                                   | The profile selects existing OpenClaw state and credentials; renaming it would create a different profile and break upgrades.                            |
| AAG product/package/repository names                                | compatibility metadata, roadmap, fixture, release history, and this audit                                                                          | These identify the legacy generation and the permanent old-repository redirect contract.                                                                 |
| AAG-named test agents and fixtures                                  | `test/**`                                                                                                                                          | They prove old identities, messages, markers, and persisted values remain unchanged.                                                                     |

The exact-count inventory also covers the supporting locations that implement or explain these
categories: `.gitignore`, `.npmignore`, `.github/workflows/publish.yml`, `AGENTS.md`, `README.md`,
`ARCHITECTURE.md`, `docs/architecture-decisions.md`, `docs/agent-setup.md`,
`docs/compatibility.md`, `docs/knot-roadmap.md`, `docs/release-checklist.md`,
`docs/upgrade-from-aag.md`, the OpenClaw package README/source/tests, `package.json`,
`scripts/install-fixtures.mjs`, `scripts/smoke-codex.ts`,
`scripts/verify-repository-redirect.mjs`, and the runtime source files listed in
`scripts/aag-occurrences.json`. Temporary-file prefixes such as `aag-smoke`, compatibility probe
variables such as `AAG_CODEX_ACP_OK`, and process/context compatibility paths are retained only to
exercise or discover the legacy generation; newly created product identities use Knot names.

Generated `dist` repeats the same source-level compatibility strings and is marked generated in
`.gitattributes`. `THIRD_PARTY_NOTICES.md`, `LICENSE`, and the v0.1.3 fixture are intentionally
unchanged. `scripts/aag-occurrences.json` is the definitive per-file, per-occurrence inventory, and
`scripts/release-audit.mjs` requires an exact match. A new, removed, or moved grep finding is a
release-blocking change until its compatibility reason and count are reviewed together.
