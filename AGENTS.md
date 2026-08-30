# Agent setup contract

This repository builds and operates Knot. When a user gives an automation agent this repository and asks it to connect itself to Anytype, use the runbook in [`docs/agent-setup.md`](docs/agent-setup.md).

## Invariants

- One Knot process represents one runtime agent through one dedicated Anytype member.
- Treat invite links, API keys, participant IDs, gateway tokens, and local project paths as sensitive operator input. Never invent them, print their values, or commit them.
- Joining a space does not authorize every chat. Configure explicit routes or explicitly enable per-space chat discovery with a narrow wake rule and sender allowlist.
- `allowedProjects` and `defaultProject` communicate intent to the runtime; they are not a filesystem sandbox. Enforce access in Codex/OpenClaw, the service account, or a container.
- Do not expose Anytype, Heart, or OpenClaw listeners publicly. Use loopback, SSH forwarding, or an authenticated private network.
- The optional Heart adapter has a separate Any Source Available dependency boundary documented in `THIRD_PARTY_NOTICES.md`.

## Supported bootstrap

```bash
pnpm add --global .
knot --version
```

This checkout-local command is the supported bootstrap while preparing the release. After npm trusted publishing completes, use `pnpm add --global @imai/knot@0.2.0`; after the repository rename and tag exist, the exact-source form is `pnpm add --global github:imai-studio/knot#v0.2.0`. The former `imai-studio/anytype-agent-gateway` URL is compatibility-only and must remain available through GitHub's repository redirect.

Then ask the operator for the values the machine cannot discover safely: runtime (`codex` or `openclaw`), dedicated Anytype member name, invite link(s), selected chats and discussions, authorized participant IDs, project paths, and wake and permission policy. Follow `docs/agent-setup.md` to create or reuse the identity. Write configuration outside the repository, run `knot validate` and `knot doctor`, prove the foreground workflow, and only then install the service.

## Repository checks

Use pnpm 11 and Node.js 24 or newer:

```bash
pnpm install --frozen-lockfile
pnpm run check

cd heart-adapter
go test ./...
go vet ./...
```

The compiled `dist` directory is intentionally committed because it makes direct GitHub installation deterministic and build-script-free. After changing `src`, run `pnpm run build` and commit the matching `dist` changes.
