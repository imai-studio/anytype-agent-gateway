# September 2026 audit remediation

Baseline: `26d9be1` (497 tests). This change implements the reproduced defects and records the
remaining product decisions. Independent PR review and live release verification belong to the
release operator; local regression tests do not establish live Anytype/OpenClaw interoperability.

## Findings disposition

| ID  | Disposition                                                   | Evidence and resulting behavior                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Fixed                                                         | Accepted successor turns revoke only their source thread's capabilities. Unauthorized/non-waking messages and other discussion roots preserve authority. Completion, failure, cancellation, and five-minute expiry revoke it. Controller and store regressions cover these boundaries.                                                                                                                                                              |
| C2  | Fixed                                                         | The actual unbound MCP `actor_capability` path supports status followed by multiple pushes, with a 16-call/five-minute publish budget. Access, wake, and model mutations remain single-use; model listing never consumed authority. Wrong scope/route cannot authorize or spend a valid token. Site/slug/lifecycle/sender policies still apply to every publish. Capability verification errors distinguish invalid authority from a denied sender. |
| C3  | Fixed                                                         | Heart accumulates UTF-16 units across blocks, with emoji/accent/bullet/CJK/mention regression.                                                                                                                                                                                                                                                                                                                                                      |
| C4  | Fixed                                                         | Hop ancestry uses the same native identity matcher as wake, including member/global/scoped forms. Cyclic ancestry hits the hop bound; activation circuit remains unchanged.                                                                                                                                                                                                                                                                         |
| C5  | Fixed for built-in ports                                      | Local reauthorization precedes extension I/O. Cloud batches and projections have one-second cooperative budgets, failure deferral, and shutdown cancellation. Native HTTP/retry/queue cancellation is tested. Late responses cannot commit leases/claims after abort. An interrupted effect keeps an outcome-unknown receipt. Injected ports must honor AbortSignal.                                                                                |
| C6  | Fixed with protected working-set exception                    | Filenames already reused deterministically; the reported per-turn growth estimate was overstated. Unique sessions/messages still accumulated. A registry now tracks only newly written managed files; inactive retention defaults to 30 days/1 GiB. Active/resetting session references and in-flight context survive. Unknown, older untracked, changed, and symlinked files are left alone. See `context-retention.md`.                           |
| C7  | Product/OS isolation decision                                 | Same-user shell access can forge actor files, read state/config, and read a same-user HMAC secret. HMAC alone is rejected as a complete fix. `SECURITY.md` documents the trusted operator boundary and a separate broker/isolation design; privileged tools require enforceable runtime isolation or must be disabled. A new broker is not claimed as shipped.                                                                                      |
| C8  | Fixed                                                         | Generated systemd values escape literal percent specifiers, including executable/config/PATH values.                                                                                                                                                                                                                                                                                                                                                |
| C9  | Fixed                                                         | YAML document mutation preserves unrelated comments, quotes, and anchors; aliased consumers are detached when a shared node changes. Private atomic writes remain 0600.                                                                                                                                                                                                                                                                             |
| C10 | Retained explicit trust                                       | Wildcard administrators are explicit broad operator grants, not an identity bypass. Compatibility is regression-tested and the consequence documented. Publishing continues to reject wildcard users. Tightening existing installations would require a migration decision.                                                                                                                                                                         |
| C11 | Fixed                                                         | Cloud bodies are consumed incrementally, canceling once the one-MiB limit is exceeded, including absent Content-Length.                                                                                                                                                                                                                                                                                                                             |
| C12 | Fixed conservatively                                          | Identity extraction strips only recognized native member/participant prefixes and validates empty components/whitespace for DM creation. Arbitrary global IDs retain underscores. Heart `core/domain/id.go` constructs participant IDs from encoded space plus global identity; we do not invent a display-name or cryptographic-ID regex.                                                                                                          |
| C13 | Supported transport; TLS decision open                        | Loopback-only rejection would break supported SSH/private-network configurations. Existing addresses remain accepted and tested. `SECURITY.md` explicitly states plaintext gRPC/session metadata require loopback, SSH, or authenticated encrypted private transport; a private IP alone is insufficient. Native TLS is planned.                                                                                                                    |
| C14 | Safe subset fixed; archival deferred                          | Expired capabilities are pruned; Codex does not normally issue these tokens. Workflow/Cloud tables deliberately have no-delete triggers and restricted foreign keys because they are replay/approval/effect barriers. Age-based deletion is rejected pending a reviewed archive/tombstone protocol.                                                                                                                                                 |
| C15 | Fixed collision handling                                      | Configured names/aliases win. Conflicting dynamic names are removed; equivalent native IDs remain usable. Context collection preserves conflicting evidence for the collision filter. Uncorroborated native mention text still does not establish display-name ownership or authority.                                                                                                                                                              |
| C16 | Intentional retries; diagnostics added                        | At-least-once reply delivery retains failed/dead records. Doctor reports pending/claimed/failed/dead counts before remote checks. An arbitrary retry cap or deletion would silently lose replies. Permanent failure classification/manual recovery remains planned; see additional bridge retention fix below.                                                                                                                                      |
| H1  | Literal-loopback hardening fixed                              | Remote Cloud may not select a literal loopback upload destination; local Cloud development remains supported. This is not a DNS-rebinding/general SSRF boundary.                                                                                                                                                                                                                                                                                    |
| H2  | Matcher inconsistency fixed; no native collision demonstrated | Outbox/orphan checks now share `sameIdentity`; unrelated underscore-suffix strings no longer match. Native prefix/global compatibility remains. A collision between real cryptographic identities was not demonstrated.                                                                                                                                                                                                                             |
| H3  | Product consent policy open                                   | Released contract re-reads the native origin and checks current sender policy; it does not require recent, command-specific consent. No unilateral age limit was introduced. Bridge remains default-off and this limit is explicit in the guide.                                                                                                                                                                                                    |
| H4  | Product approval decision open                                | A turn token proves sender authority, not intended mutation contents. Operation-digest approval or separate trusted confirmation must be designed before claiming prompt-injection resistance for privileged changes. See C7 and `SECURITY.md`.                                                                                                                                                                                                     |
| H5  | Fixed inventory scope                                         | Release compatibility inventory now uses tracked, NUL-delimited text paths. Scratch files, binary NUL content, and newline filenames have isolated regressions. UTF-8 decoding itself did not throw as hypothesized. Tarball validation remains independent.                                                                                                                                                                                        |

## Additional reproduced defects

- **P2 subprocess timeout:** timeout always rejects, even when SIGTERM causes exit 0. A dedicated
  process group receives bounded TERM/KILL escalation; tests cover normal/spawn failure, graceful
  exit, ignored TERM, and descendants. No broad process-name killing is used.
- **Development dependencies/toolchain:** full workspace audit now includes patched `qs` 6.16.0.
  Supported Go 1.26.8 replaces the vulnerable/unsupported pins; patched x/net/x/sys/x/text remove
  remaining imported/module advisories. Production dependency audit was already clean at baseline.
  Scanner reachability is not proof of deployment exploitability.
- **OpenClaw bridge retention:** pending final replies and recovery events must survive outages.
  Removed 30-day pending deletion; delivered payloads compact after seven days but keep durable
  idempotency tombstones. Ephemeral thinking expiry remains intentional.
- **OpenClaw shutdown/ACK races:** a removed observer cannot process or ACK a response returned after
  close, pending initial hello cannot resurrect a closed driver, and failed ACK preserves suppression
  of an already locally delivered final. Four additional regressions exercise those transitions.
- **Codex Desktop helper:** malformed/empty helper JSON now reaches fallback instead of throwing out
  of a child close callback. Helper/UI subprocesses use the bounded process helper.
- **Workflow startup cancellation:** if authority is aborted while native runtime startup is pending,
  a subsequently returned runtime handle is canceled immediately; it cannot miss the already-fired
  abort event. The effect receipt still handles uncertain outcomes conservatively.

## Targeted coverage follow-up

The follow-up read all native OpenClaw plugin source, `runtime/openclaw.ts`, onboarding,
discussions, Codex Desktop, release/install scripts, and CI/publish workflows. It found the additional
bridge/desktop lifecycle defects above. Automation review targeted policy-derived capabilities,
local authority/approval hashes, observer identity/source provenance, runner reauthorization,
transactional queue/fencing, effect receipts, and operator CLI mutation gates. Store migrations
3–18 were inspected for ownership, backup, foreign-key, and durable-record constraints. CLI review
targeted setup/identity reuse, route-bound MCP actor wiring, doctor, workflow operator mutations,
and publication commands. Documentation changes reconcile implemented fixes, default-off behavior,
and the explicitly open decisions above.

This is a targeted completion of the named gaps, not a formal proof or exhaustive live-system
security certification. No live operator identity, config, service, Cloud deployment, or user object
was changed. No CodeRabbit CLI was used.

## Verification and release handoff

Run Node 24+/pnpm 11 frozen install, `pnpm run check`, `pnpm run release:gates`, full workspace
`pnpm audit`, and Heart test/vet/build plus pinned `govulncheck@v1.7.0` on Go 1.26.8. Matching compiled
artifacts belong in the same reviewed commit. The PR handoff records exact results and commits.

The existing [gRPC update PR #24](https://github.com/imai-studio/knot/pull/24), at
`0f689b32b4c12ad4a40babe58bd881d26364f134`, is a release prerequisite. This remediation deliberately
avoids duplicating its gRPC update. Its exact dependency files combined with these Heart changes
were tested in an isolated module with test/vet/build and a clean complete vulnerability scan.
Do not deploy the standalone remediation Heart binary while it still resolves gRPC 1.82.1.

After independent review, merge the reviewed sequence and build one identified release artifact.
Record its Git SHA, package digest, Go toolchain, and Heart digest. On both Mac Klee and imai Anya,
inspect the actual launchd/systemd executable and service environment without publishing sensitive
values. Back up operator config/identity/state with SQLite-consistent backup, stop the existing
service, install the same reviewed artifact, verify actual executable/build SHA, and preserve the
existing identity, routes, paths, and permissions. Run validate/doctor, foreground workflow proof,
then service start and live smoke checks. Verify real unbound OpenClaw MCP status followed by
publishes on harmless synthetic objects, Unicode discussion mentions, hop guard, timeout/shutdown,
and existing chat/session continuity. Do not publish private chat/history.

Schema 18 creates a pre-migration backup and expires only pre-upgrade ephemeral capabilities. Older
schema-17 binaries cannot reopen schema-18 state. Prefer a forward fix; do not blindly restore a
pre-upgrade database after new messages/effects have been accepted. Any rollback needs an explicit
state reconciliation plan to avoid losing replies or replaying effects. Keep Cloud repository
changes outside this release unless separately justified and reviewed.
