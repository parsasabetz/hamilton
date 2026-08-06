# Hamilton Roadmap — Remaining Work

> **Target (the necessary feature):** Level 1 of `FEATURES.md` — Hamilton runs
> multiple agents by itself and finishes an app from a single initial prompt,
> with no human intervention.
>
> Milestones referenced below are HAMILTON.md §16 (M0–M5).

## Status summary

| Area                                                                 | Completion | Notes                                                                                            |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| Toolchain (pnpm/turbo/bun/ts7/oxc/changesets/logtape/citty/husky/CI) | **100%**   | gate green, hooks active, CI covers main+dev                                                     |
| Design doc (`HAMILTON.md`)                                           | **100%**   | all contracts specified                                                                          |
| Contracts (`@hamilton/shared`)                                       | **100%**   | event envelope + full type table, zod task schema, MCP tool specs                                |
| OpenCode bridge (`core/src/bridge.ts`)                               | **~90%**   | subscribe/classify/track/stall/idle/stream events, tested — only the bus wiring is missing       |
| MCP server (`@hamilton/mcp`)                                         | **~70%**   | stdio server + all 6 tools registered and smoke-tested; handlers acknowledge instead of emitting |
| Core server                                                          | **~30%**   | health, SSE ping, status-page stub — no `/api/state`, no bus fan-out, no control-plane calls     |
| Brain (Miniflare DOs)                                                | **~15%**   | RunDO skeleton with alarm pattern; miniflare-under-Bun proven (KV/R2/DO/alarm smoke passed)      |
| Planner / dispatch / gate / merge / recovery                         | **0%**     | not started                                                                                      |
| Status page                                                          | **~10%**   | stub page only                                                                                   |

## Remaining work by milestone

### M1 — Event spine (the bus) · _next_

| Task                                                                                                | Status      |
| --------------------------------------------------------------------------------------------------- | ----------- |
| MCP tool handlers → Core shim (HTTP) → queue → RunDO consumer                                       | not started |
| Miniflare wiring in Core: KV (event log, registries), R2 (artifacts), queue (bus), DO storage       | not started |
| RunDO event handling: dedupe by id, state transitions, seq assignment                               | not started |
| TaskDO / AgentDO / ReviewDO state machines + alarms (claim deadline, heartbeat expiry)              | not started |
| Bridge emits onto the bus instead of a callback                                                     | not started |
| `/api/state` projection + SSE fan-out of bus events (page skeleton: header, task table, event tail) | not started |
| One demo task end-to-end: claim → milestones → ready, visible live on the page                      | not started |

**Exit:** a single demo task runs agent → MCP → bus → RunDO → KV/R2 → page.

**Effort:** ~1–2 focused sessions. Highest uncertainty in the whole roadmap (in-process
miniflare queue dispatch + stdio→HTTP shim are first-time integrations).

### M2 — Planner, dispatch, sessions (largest)

| Task                                                                                                    | Status      |
| ------------------------------------------------------------------------------------------------------- | ----------- |
| `hamilton run "<prompt>"` CLI command (citty) + run config                                              | not started |
| Deterministic planner: prompt + constants → zod-validated graph JSON → `graph.yaml` projection          | not started |
| Brief generation (inherits `briefs/S2` format)                                                          | not started |
| DAG traversal: gating on `merged`, parallel dispatch, merge-order enforcement                           | not started |
| Git provisioning: worktree + branch + deps per task                                                     | not started |
| Session lifecycle: create (role+model) → `noReply` brief → `prompt_async` → KV session registry → abort | not started |
| Permission auto-responder (deny-by-default, per-role allowlists)                                        | not started |
| Agent/session tables + DAG ordering on the page                                                         | not started |

**Exit:** two dependent tasks run in parallel and finish in DAG order.

**Effort:** ~3–4 sessions — the planner and the git/session machinery are the bulk.

### M3 — Gate & merge

| Task                                                                                                            | Status      |
| --------------------------------------------------------------------------------------------------------------- | ----------- |
| Reviewer role agent configs (`edit: deny`, restricted bash)                                                     | not started |
| Reviewer dispatch on `ready_for_review` (N parallel, read-only)                                                 | not started |
| Review documents → R2; `review.verdict` events                                                                  | not started |
| Three-phase gate: READ → REVIEW → DECIDE (RunDO)                                                                | not started |
| Merge executor: squash-merge + verify + status flip + merge-log artifact + DAG re-eval; `mergeAuthority` config | not started |

**Exit:** a task passes the gate and merges autonomously end-to-end.

**Effort:** ~2 sessions.

### M4 — Failure semantics & guardrails

| Task                                                                                                                              | Status      |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Recovery controller: stall/idle/claim-deadline → verify → abort → respawn-with-continue → retry-once → escalate → gate dependents | not started |
| Budget guard: 50% stop-and-report, per-task caps, usage events                                                                    | not started |
| `STALE`/`DIED`/heartbeat-age on the page; pause/resume controls                                                                   | not started |
| Tool-timeout guard (`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`) in run config                                                | not started |

**Exit:** kill an agent mid-task; Hamilton recovers and continues without the human.

**Effort:** ~2 sessions.

### M5 — Observability & hardening

| Task                                                                             | Status      |
| -------------------------------------------------------------------------------- | ----------- |
| Dashboard polish: DAG diagram, detail panels, artifact shelf, live session tails | not started |
| Structured logs + metrics → R2; `/log` API                                       | not started |
| Crash-recovery drill: kill everything, resume from disk, zero task loss          | not started |
| Cloudflare deploy decision                                                       | not started |

**Effort:** ~1–2 sessions.

## Where Level 1 is reached

`M1 + M2 + M3 + M4` — i.e. everything except the M5 polish layer.
**Rough total: ~8–11 focused sessions** to the "one prompt → finished app, zero
intervention" goal, dominated by M2. M5 can follow or ship incrementally.

## Known risks (in build order)

1. **M1 integration unknowns** — miniflare queue-producer/consumer option details under Bun, and the MCP stdio → Core shim transport. Both are isolated in M1's demo task.
2. **OpenCode permission flow in headless mode** — the auto-responder must observe `permission.required` events correctly; verify early in M2 with a real `opencode serve`.
3. **Planner determinism** — the first graph must be trivially correct for a small app before it generalizes; the zod validation + loud failure path is the safety net.
4. **Git worktree provisioning speed** — installs per worktree are expensive; batch/symlink strategies are a later optimization, not a blocker.
