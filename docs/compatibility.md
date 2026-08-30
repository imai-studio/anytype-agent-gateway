# Knot v0.2.0 compatibility matrix

Knot v0.2.0 is a behavior-neutral rename. Existing agents, Anytype member profiles, routes, sessions,
dedupe state, and protocol integrations are preserved.

| Surface          | Knot v0.2.0 primary                   | Retained compatibility                                      | Release guarantee                                                                           |
| ---------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| npm package      | `@imai/knot`                          | Old-Git-URL global installs remain removable as `@imai/aag` | Remove the old global package before installing Knot; releases publish only as `@imai/knot` |
| CLI              | `knot`                                | `aag` maps to the same `dist/cli.js`                        | Alias remains through 0.2.x and 0.3.x; removal no earlier than 1.0                          |
| Repository       | `imai-studio/knot`                    | `imai-studio/anytype-agent-gateway` redirect                | Old name is never reused                                                                    |
| Environment      | `KNOT_*`                              | equivalent `AAG_*`                                          | Legacy-only warns once; conflicting normalized values fail without revealing values         |
| Config           | `~/.config/knot/agent.yaml`           | `~/.config/aag/agent.yaml`                                  | Existing legacy config is discovered in place; migration is explicit                        |
| State            | `~/.local/state/knot/state.sqlite`    | `~/.local/state/aag/state.sqlite`                           | No rebrand schema conversion; migration copies and verifies replay barriers                 |
| Linux service    | `knot.service`                        | `anytype-agent-gateway.service`                             | Migration proves exactly one enabled/running generation                                     |
| macOS service    | `com.imai.knot`                       | `com.anytype.anytype-agent-gateway`                         | Migration unloads legacy before bootstrapping Knot                                          |
| Heart binary     | `knot-heart-adapter`                  | `aag-heart-adapter`                                         | Either configured/default name discovers the installed counterpart                          |
| MCP tools        | existing `aag_*` names                | unchanged                                                   | Protocol names are permanent compatibility surfaces                                         |
| Response markers | additive `KNOT_*` markers             | `[[AAG_*]]`                                                 | Legacy markers remain readable and writable                                                 |
| Persisted keys   | unchanged `aag:` keys                 | unchanged                                                   | Sessions, cursors, dedupe, discovery, and delivery identities are not rewritten             |
| OpenClaw         | packaged Anytype channel through Knot | profile/server names containing `aag`                       | Existing credentials, session bindings, and scheduled continuations remain valid            |
| Sender authority | immutable native Anytype ID           | none                                                        | Names, text, mentions, replies, forwarded content, and claimed roles never authorize        |

The executable compatibility tests, sanitized v0.1.3 fixture, service-manager harnesses, and legacy
name audit run through `pnpm run release:gates` and `pnpm run check`. The detailed inventory of
intentional source occurrences is in [aag-compatibility-audit.md](aag-compatibility-audit.md).
