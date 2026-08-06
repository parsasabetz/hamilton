# AGENTS.md

## What this repo is

Hamilton — a multi-agent autonomous orchestration framework. The authoritative design document is `HAMILTON.md`; read it before changing architecture or contracts.

## Toolchain

- Package manager: **pnpm 10** (`pnpm-workspace.yaml`, workspaces under `packages/`)
- Task runner: **Turborepo** (`turbo.json`) — `pnpm typecheck` / `pnpm test` / `pnpm dev` run via turbo with caching; `pnpm lint` / `pnpm format` run oxc directly at the root (registered as turbo root tasks, so `turbo run lint` works too)
- Runtime: **Bun 1.3+** — all code must run as-is under Bun (ESM, no build step)
- Linter: **oxlint** — `pnpm lint` / `pnpm lint:fix`
- Formatter: **oxfmt** — `pnpm format` / `pnpm format:check`
- Typecheck: **TypeScript 7** (native compiler) — `pnpm typecheck`
- Versioning: **Changesets** — `pnpm changeset` (add a changeset) / `pnpm version:packages` (apply). Never edit `package.json` versions by hand.
- Logging: **LogTape** (`@logtape/logtape`) — loggers categorized `["hamilton", ...]`, configured once in `@hamilton/core`. No `console.log` in library code.
- CLI: **citty** (`@hamilton/cli`) — `hamilton dev` boots the core server.
- Tests (when added): `bun:test`

## Conventions

- `erasableSyntaxOnly` is on: no enums, no namespaces, no parameter properties — code stays runnable by Bun without transformation.
- Strict flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` — satisfy the compiler; no `any` escapes.
- Type-only imports use `import type`.
- All code must pass: `pnpm lint && pnpm format:check && pnpm typecheck`.

## Workspaces

- `@hamilton/shared` — event envelope, event types, zod task schema, MCP tool specs (no runtime deps beyond zod)
- `@hamilton/core` — Bun executor: HTTP API, SSE hub, status page, opencode control plane (`@opencode-ai/sdk/v2`), Miniflare wiring
- `@hamilton/brain` — Miniflare/Workers code: RunDO/TaskDO/AgentDO/ReviewDO + worker entry
- `@hamilton/mcp` — the Hamilton MCP server agents talk to (stdlib stdio server on `@modelcontextprotocol/sdk`)
- `@hamilton/cli` — citty CLI entry: `hamilton dev`

## Environment notes

- Miniflare: latest stable line is 4.x (`4.20260730.0`); the npm `latest` tag points to a 5.x alpha — do not take it unless deliberately evaluated.
