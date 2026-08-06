<div align="center">
  <img src="assets/hamilton.png" alt="Hamilton logo" width="180" />
  <h1>Hamilton</h1>
  <p>Multi-agent autonomous orchestration for software projects.</p>
</div>

Hamilton coordinates coding agents around a shared, event-driven execution model. It is designed to plan work as a task graph, dispatch agents in parallel, supervise their progress, run independent reviews, recover from failures, and make the current state visible in real time.

> **Early development:** The event spine is working today. Planner, autonomous dispatch, review, merge, and recovery features are still being implemented. See [current status](#current-status) and the [roadmap](ROADMAP.md).

## The Name

Hamilton is named in honor of **Margaret Hamilton**, the pioneering software engineer and computer scientist whose software leadership helped guide NASA's Apollo missions to the Moon. Her work emphasized software that could report on its own state so people and machines could trust it in critical moments. Hamilton carries that same idea into autonomous software development: every action should be observable, auditable, and recoverable.

## Why Hamilton?

Coding agents can make progress independently, but a larger project still needs coordination: dependency ordering, isolated worktrees, liveness signals, review gates, failure recovery, and an honest view of what is happening.

Hamilton treats those concerns as one orchestration system:

- **Event-driven:** events are the communication contract between agents, the executor, and the stateful brain.
- **Observable:** the status page is a live projection of the event bus, with task, agent, and event views.
- **Durable:** Miniflare Durable Objects, KV, R2, and Queues provide persisted local state and ordered event handling.
- **Autonomous but gated:** mechanical decisions are automated; owner-controlled decisions such as merges can remain explicit.
- **OpenCode-native:** OpenCode provides the agent runtime; Hamilton provides the control plane around it.

## Current Status

The repository currently includes:

- A Bun-based Core HTTP server and SSE event hub.
- A Miniflare brain with `RunDO`, `TaskDO`, `AgentDO`, and `ReviewDO`.
- Durable KV event sequencing, queue delivery, runtime state snapshots, and R2 artifact storage.
- A local MCP server with six agent-facing tools: `heartbeat`, `checkpoint`, `emit_event`, `ask_question`, `report_subagent`, and `ready_for_review`.
- An OpenCode SSE bridge for forwarding session telemetry into Hamilton events.
- A zero-build status page at `/`.
- An end-to-end M1 demo that verifies MCP emission, event processing, state projection, and restart resumption.

The following Level 1 capabilities are not complete yet:

- Prompt-to-task-graph planning.
- DAG dispatch, worktree provisioning, and OpenCode session orchestration.
- Reviewer dispatch and the READ -> REVIEW -> DECIDE gate.
- Autonomous merge execution.
- Agent death recovery, retries, escalation, and budget controls.

## Architecture

Hamilton is split into three planes:

```text
OpenCode server                 Core (Bun)                 Brain (Miniflare)
-----------------              ------------------          -------------------
Agent sessions  <--- SDK --->  HTTP API + SSE hub  <---->  Durable Objects
OpenCode SSE    ------------->  Git/executor              KV + R2 + Queue
                                MCP event shim             Persisted local state
```

The event flow is:

```text
Agent MCP tool
    -> Core POST /api/events
    -> ordered event bus
    -> RunDO / TaskDO / AgentDO / ReviewDO
    -> KV state + R2 artifacts + SSE dashboard
```

The full design, event vocabulary, state machines, guardrails, and phased plan are documented in [HAMILTON.md](HAMILTON.md).

## Quick Start

### Requirements

- [Bun](https://bun.sh/) `1.3` or newer.
- [pnpm](https://pnpm.io/) `10`.
- OpenCode is optional for the event-spine demo and required for the future agent control plane.

### Install

```bash
pnpm install
```

### Start the Core

```bash
pnpm dev
```

This starts the Hamilton CLI in development mode and serves the status page at [http://localhost:8787](http://localhost:8787).

Useful endpoints:

```text
GET  /api/health       Health and version information
GET  /api/state        Current run snapshot and recent event tail
GET  /api/events       Recent events, optionally filtered with ?run=<id>&n=<count>
POST /api/events       Emit an event onto the bus
GET  /api/stream       Server-Sent Events stream
```

### Run the Event-Spine Demo

The demo starts the Core, drives the real MCP server over stdio, verifies the resulting state, restarts the Core, and verifies persisted resumption:

```bash
bun packages/core/src/demo.ts
```

The demo uses `.mf-demo` temporarily and removes it when it finishes.

### Connect the OpenCode Bridge

Start an OpenCode server, then point Hamilton at it when starting the Core:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
HAMILTON_OPCODE_URL=http://127.0.0.1:4096 pnpm dev
```

Hamilton forwards the OpenCode server's SSE telemetry as `telemetry.opencode` events and derives liveness-related events for tracked sessions.

## MCP Agent Interface

The `@hamilton/mcp` package exposes a stdio MCP server for agents. It sends events to the Core through `POST /api/events`.

```bash
HAMILTON_CORE_URL=http://localhost:8787 \
HAMILTON_RUN_ID=local-run \
HAMILTON_TASK_ID=task-1 \
HAMILTON_AGENT_ID=agent-1 \
pnpm --filter @hamilton/mcp start
```

The environment variables are optional and default to `http://localhost:8787` and `local-run`. The task and agent identifiers attach context to emitted events.

## Repository Layout

| Package           | Responsibility                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `packages/shared` | Event envelope, event types, task schema, runtime config, and MCP tool specifications.     |
| `packages/core`   | Bun executor, HTTP API, SSE hub, Miniflare runtime, OpenCode bridge, and status page.      |
| `packages/brain`  | Worker entry point and Durable Object state machines for runs, tasks, agents, and reviews. |
| `packages/mcp`    | Local stdio MCP server used by Hamilton agents.                                            |
| `packages/cli`    | `hamilton` command-line entry point.                                                       |
| `assets`          | Project assets, including the Hamilton logo used above.                                    |

## Development

Run the repository checks before opening a change:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

The repository uses pnpm workspaces and Turborepo. Source runs directly under Bun with ESM; there is no application build step for the Core status page. Changesets are used for package versioning, and package versions should not be edited by hand.

## Project Documents

- [HAMILTON.md](HAMILTON.md): authoritative architecture and contracts.
- [FEATURES.md](FEATURES.md): ranked feature tiers and acceptance criteria.
- [ROADMAP.md](ROADMAP.md): implementation status and remaining milestones.
- [AGENTS.md](AGENTS.md): repository conventions for contributors and coding agents.

## Contributing

Hamilton is being built in small, contract-first milestones. Before making a change:

1. Read [HAMILTON.md](HAMILTON.md) and the relevant package source.
2. Keep changes within the package or architectural zone they affect.
3. Add or update Bun tests for behavior changes.
4. Run the full check set above.
5. Use a changeset for changes that will eventually affect published package versions.

The project is not yet publishing its workspace packages. Licensing and release details will be added before the first public package release.
