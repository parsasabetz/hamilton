# Hamilton Roadmap — Remaining Work

> **Target (the necessary feature):** Level 1 of `FEATURES.md` — Hamilton runs
> multiple agents by itself and finishes an app from a single initial prompt,
> with no human intervention.
>
> Milestones referenced below are HAMILTON.md §16 (M0–M5).

## Status summary

| Area                                                                 | Completion | Notes                                                                                                                               |
| -------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain (pnpm/turbo/bun/ts7/oxc/changesets/logtape/citty/husky/CI) | **100%**   | gate green, hooks active, CI covers main+dev                                                                                        |
| Design doc (`HAMILTON.md`)                                           | **100%**   | all contracts specified                                                                                                             |
| Contracts (`@hamilton/shared`)                                       | **100%**   | event envelope + full type table (runtime array), zod task schema, MCP tool specs                                                   |
| OpenCode bridge (`core/src/bridge.ts`)                               | **100%**   | emits into the bus via `startCore` when `HAMILTON_OPCODE_URL` is set                                                                |
| MCP server (`@hamilton/mcp`)                                         | **100%**   | all 6 tools emit onto the bus via the HTTP shim; checkpoint `phase` selects the event type                                          |
| Core server                                                          | **~70%**   | event bus (seq/KV/queue/fan-out), `/api/events`, `/api/state`, SSE `/api/stream`, status page                                       |
| Brain (Miniflare DOs)                                                | **~70%**   | RunDO (dedupe, transitions, snapshots, diff-forwarding), TaskDO/AgentDO/ReviewDO, queue consumer; AgentDO liveness alarms next (M4) |
| Planner / dispatch / gate / merge / recovery                         | **0%**     | not started                                                                                                                         |
| Status page                                                          | **~60%**   | header/task table/agent table/event tail, SSE live — DAG diagram + detail panels in M2/M5                                           |
| M1 demo (`core/src/demo.ts`)                                         | **done**   | agent → MCP → bus → queue → RunDO → KV → page, incl. restart persistence                                                            |

## Remaining work by milestone

### M1 — Event spine (the bus) · **complete**

All M1 tasks shipped (queue → RunDO consumer, Miniflare wiring, RunDO/TaskDO/AgentDO/ReviewDO,
bridge → bus, `/api/state` + SSE + page, end-to-end demo with resumption).
AgentDO heartbeat-expiry/claim-deadline alarms remain pending until M4 (state machines exist).

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

`M1 + M2 + M3 + M4` — M1 is complete; **~7–9 focused sessions remain**
(M2 the largest at ~3–4, then M3 ~2, M4 ~2), to the "one prompt → finished
app, zero intervention" goal. M5 can follow or ship incrementally.

## Known risks (in build order)

1. ~~M1 integration unknowns — miniflare queue dispatch + the MCP stdio → Core shim transport.~~ **Resolved:** queue producer → consumer verified end-to-end; demo passes.
2. **OpenCode permission flow in headless mode** — the auto-responder must observe `permission.required` events correctly; verify early in M2 with a real `opencode serve`.
3. **Planner determinism** — the first graph must be trivially correct for a small app before it generalizes; the zod validation + loud failure path is the safety net.
4. **Git worktree provisioning speed** — installs per worktree are expensive; batch/symlink strategies are a later optimization, not a blocker.
5. **Miniflare needs bundling** — workerd cannot parse TS: the brain worker is esbuild-bundled (with `cloudflare:*` external) into `packages/core/dist/brain.js` at boot; bundles and persist dirs must live inside the repo (workerd sandbox).
