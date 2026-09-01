# Contributing

## Development setup

Use Node.js 24 or newer. Go 1.25.7 is required only for the optional Heart discussion adapter.

```bash
git clone https://github.com/imai-studio/knot.git
cd knot
pnpm install --frozen-lockfile
pnpm run check

cd heart-adapter
go test ./...
go vet ./...
```

Keep credentials and machine-local configuration outside the repository. Use the example configurations as templates and never commit Anytype API keys, OpenClaw gateway tokens, session tokens, state databases, or local invite links.

Run `pnpm format` before committing. The repository pins Prettier and keeps its shared style in `.prettierrc.json`; `pnpm run check` rejects source, documentation, and configuration files that do not match it. Generated `dist/` files and Go sources are excluded because the build and `gofmt` own their formatting.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Run `pnpm run check`, `go test ./...`, and `go vet ./...` before opening a pull request.
- Document configuration or operational changes in the README and examples.
- Explain compatibility implications when updating Anytype, Anytype Heart, OpenClaw, Codex ACP, or the ACP SDK.

By submitting a contribution, you agree that it is licensed under the Apache License, Version 2.0.
