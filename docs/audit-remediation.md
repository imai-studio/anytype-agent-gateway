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
  close if local delivery has not begun. Successful output already in progress completes its ACK
  with an independent bounded request, even if the observer closes during that delivery. Pending
  initial hello cannot resurrect a closed driver, and failed ACK preserves suppression of an already
  locally delivered owned final. Regressions exercise these transitions for final and terminal events.
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

PR #25 review follow-up adds these regression-backed corrections:

- Quarantined terminal commands awaiting their result receipt no longer renew a terminal lease. Persistent
  command/fence rejections are isolated from transport failures, and bounded result/lease batches
  rotate so rejected records cannot monopolize the first page. Network phases also rotate after
  interrupted batches, preserving opportunities for result submission and polling under slow errors.
- A projection send that returns a valid message ID is completed even when cancellation arrives
  with the response, preventing a later tick from sending the confirmed message again. Interrupted
  sends without a known result retain the existing retry behavior.
- Retention validates the entire registry before maintenance. Malformed JSON, invalid maps or
  entries, nonregular registry paths, and lock contention skip maintenance without interrupting a
  prompt or replacing corrupt evidence. Successful attachments, turn context, and session references
  are registered in one transaction so a failed reference update cannot expose active media to cleanup.
- The numeric upload guard also rejects unspecified addresses, normalized alternate IPv4 forms,
  and IPv4-mapped loopback addresses. It remains a literal-address guard, not DNS-rebinding protection.
- Coordination deduplicates equivalent native participant identities across marker/plain mentions
  and fanout accounting. The Desktop helper fixture closes its SQLite connection, and the plugin
  guide now describes durable pending replies and seven-day delivered-payload compaction.
- The proposed blanket discussion-root binding for MCP capabilities was not applied: wake/access
  are route-wide settings, publication is restricted by site policy, and OpenClaw uses an unbound MCP
  process. Tests exercise real unbound discussion publication and wake/access calls, reject tokens
  used on another route, and verify model mutations require their source root and reject replay.
  A source root governs token lifetime; it is not an independently authenticated caller root.
- A real MCP stdio subprocess test uses an unbound OpenClaw configuration and caller metadata;
  it rejects a direct actor variable without a capability, mismatched roots, and token replay.
  Process timeout coverage includes a real SIGTERM-ignoring grandchild in the owned process group.
- The context guide explicitly documents fail-closed writes through symlinked managed directories
  and operator remedies. OpenClaw bridge aggregate diagnostics and replay-safe archival are precise
  tracked gaps: current doctor counts cover only the Knot outbox, and bridge row growth is unbounded.

Run Node 24+/pnpm 11 frozen install, `pnpm run check`, `pnpm run release:gates`, full workspace
`pnpm audit`, and Heart test/vet/build plus pinned `govulncheck@v1.7.0` on Go 1.26.8. Matching compiled
artifacts belong in the same reviewed commit. The PR handoff records exact results and commits.

The pre-release follow-up to the second independent review adds durable per-result backoff and
quarantine, without marking an unacknowledged result submitted or repeating its effect. Global
auth/transport failures defer a batch; only permanent command/fence rejections spend the rejection
budget. Doctor exposes aggregate submission and context-registry diagnostics. Registry failures
remain fail-closed for deletion and nonfatal for prompts, but now report fixed nonsecret reason codes.
Stale registry locks can be reclaimed and acquired in the same bounded, zero-wait update.

The subsequent review follow-up keeps valid command leases renewable during result-submission
backoff. A permanent renewal rejection invalidates only the matching local lease-expiry cache,
preventing repeated renewal calls until Cloud supplies a fresh claim; it does not change the
stored result, signed envelope, effect receipt, or submission budget. Malformed JSON and invalid
receipt schemas spend the permanent result-submission budget, while transport and cancellation
failures defer. Command-specific auth classification leaves publication retry policy unchanged.
Doctor labels all unacknowledged results `total_pending`, with backoff and quarantine as subsets.

OpenClaw shutdown drains delivery/ACK work for at most ten seconds, including a potentially hung
output callback. Real subprocess tests verify successful ACK before exit and ACK-failure recovery
through the controller's persisted delivery receipts. That is not a permanent exactly-once guarantee:
local deduplication receipts expire after thirty days while plugin pending delivery can persist.
Repeated mention occurrences keep native marks with one canonical equivalent identity; fanout counts
distinct targets. A real unbound MCP subprocess performs status and two pushes through the native
HTTP client against a local synthetic Cloud server; live native interoperability remains a release gate.
The same subprocess denies a locally forbidden site even when Cloud grants that site, then
continues permitted pushes without changing either configuration. Closing an individual observer
drains only its own delivery work; driver shutdown retains the global ten-second bound.

The [gRPC update PR #24](https://github.com/imai-studio/knot/pull/24) and remediation PR #25 are now
merged. The combined tree resolves gRPC 1.83.1 with Go 1.26.8 and the patched indirect dependencies.
Release verification must test/vet/build and scan this exact combined tree, then deploy its matching
native Heart artifacts. Installing only the JavaScript package does not upgrade an older adapter.
The review suggestion to downgrade Go/tooling was rejected against executed evidence:
`GOTOOLCHAIN=go1.26.8 go version` reports Go 1.26.8, and `go list -m -json
golang.org/x/vuln@v1.7.0` resolves the upstream `refs/tags/v1.7.0` at
`617f44b718537dccdea1915395650e0529e3b72e` (2026-08-13), matching the successful vulnerability scan.

After independent review, merge the reviewed sequence and build one identified release artifact.
Record its Git SHA, package digest, Go toolchain, and Heart digest. On both Mac Klee and imai Anya,
inspect the actual launchd/systemd executable and service environment without publishing sensitive
values. Back up operator config/identity/state with SQLite-consistent backup, stop the existing
service, install the same reviewed artifact, verify actual executable/build SHA, and preserve the
existing identity, routes, paths, and permissions. Run validate/doctor, foreground workflow proof,
then service start and live smoke checks. Verify real unbound OpenClaw MCP status followed by
publishes on harmless synthetic objects, Unicode discussion mentions, hop guard, timeout/shutdown,
and existing chat/session continuity. Do not publish private chat/history.

Schema 19 adds dedicated durable result-submission metadata, keeping effect attempts/fences,
results, receipts and completion state separate from submission retry policy. Earlier migrations,
including schema 18's expiry of pre-thread-binding ephemeral capabilities, remain unchanged.
Upgrades from 7, 17, and 18 create private pre-migration backups. Older binaries cannot reopen
schema-19 state. Doctor itself can migrate state, so stop writers and take a consistent operator
backup before running the new doctor. Prefer a forward fix; do not blindly restore a
pre-upgrade database after new messages/effects have been accepted. Any rollback needs an explicit
state reconciliation plan to avoid losing replies or replaying effects. Keep Cloud repository
changes outside this release unless separately justified and reviewed.
