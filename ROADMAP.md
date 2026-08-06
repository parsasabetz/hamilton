# Hamilton Roadmap — Remaining Work

> **Target (the necessary feature):** Level 1 of `FEATURES.md` — Hamilton runs
> multiple agents by itself and finishes an app from a single initial prompt,
> with no human intervention.
>
> Milestones referenced below are HAMILTON.md §16 (M0–M5).

## Status summary

| Area                                                                                       | Completion | Notes                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain (pnpm/turbo/bun/ts7/oxc/changesets/logtape/citty/husky/CI)                       | **100%**   | gate green, hooks active, CI covers main+dev                                                                                                                                                                                                            |
| Design doc (`HAMILTON.md`)                                                                 | **100%**   | all contracts specified                                                                                                                                                                                                                                 |
| Contracts (`@hamilton/shared`)                                                             | **100%**   | event envelope + full type table (runtime array), zod task schema, MCP tool specs, Hamilton config schema                                                                                                                                               |
| OpenCode bridge (`core/src/bridge.ts`)                                                     | **100%**   | emits into the bus via `startCore` when `HAMILTON_OPCODE_URL` is set                                                                                                                                                                                    |
| MCP server (`@hamilton/mcp`)                                                               | **100%**   | all 6 tools emit onto the bus via the HTTP shim; checkpoint `phase` selects the event type                                                                                                                                                              |
| Core server                                                                                | **~75%**   | event bus, `/api/events`, `/api/state`, SSE `/api/stream`, status page; runtime config resolution + CONFIG binding                                                                                                                                      |
| Brain (Miniflare DOs)                                                                      | **~85%**   | RunDO (dedupe, transitions, snapshots, diff-forwarding, supervision: command watch, zone violations, per-agent R2 logs, early-stop), TaskDO/AgentDO/ReviewDO, queue consumer with leases + exponential-backoff retry; AgentDO liveness alarms next (M4) |
| Planner / dispatch / git / sessions / merges                                               | **~90%**   | planner (validation + projection + briefs + LLM decomposition), dispatcher (worktrees/sessions/merges via CORE binding), session registry, permission responder — merge-log artifacts + gate wiring in M3                                               |
| Worktree graph (live drift/diff in browser)                                                | **done**   | SVG tree graph + worktree table, SSE-live, delta-only status events, git activity attribution                                                                                                                                                           |
| Composite activity (M2)                                                                    | **done**   | activity = git changes + commits + tool calls + telemetry within `activity.windowMs`; per-agent state + early-stop integration                                                                                                                          |
| Status page                                                                                | **~60%**   | header/task table/agent table/event tail, SSE live — DAG diagram + detail panels in M2/M5                                                                                                                                                               |
| M1 demo (`core/src/demo.ts`)                                                               | **done**   | agent → MCP → bus → queue → RunDO → KV → page, incl. restart persistence                                                                                                                                                                                |
| Conductor session (`hamilton start`)                                                       | **~80%**   | session bootstrap (plan mode, seeded brief, server auto-spawn) — the plan-confirm-execute handoff completes with the dispatcher (M2)                                                                                                                    |
| Supervision (command watch / zone violations / early-stop / per-agent logs / leases+retry) | **done**   | shipped ahead of schedule with the conductor requirements pass (54 brain tests)                                                                                                                                                                         |

## Remaining work by milestone

### M1 — Event spine (the bus) · **complete**

All M1 tasks shipped (queue → RunDO consumer, Miniflare wiring, RunDO/TaskDO/AgentDO/ReviewDO,
bridge → bus, `/api/state` + SSE + page, end-to-end demo with resumption).
AgentDO heartbeat-expiry/claim-deadline alarms remain pending until M4 (state machines exist).

**Exit:** a single demo task runs agent → MCP → bus → RunDO → KV/R2 → page.

**Effort:** ~1–2 focused sessions. Highest uncertainty in the whole roadmap (in-process
miniflare queue dispatch + stdio→HTTP shim are first-time integrations).

### M2 — Autonomous execution · **complete**

Renamed per the governance split (M3 = governance). Everything shipped:

- `hamilton run` (prompt → LLM-assisted decomposition, zod-validated; or `--plan` JSON) with graph.yaml projection + run report
- Dispatcher: worktree.ensure → session.start chaining (mock + real opencode modes), session registry, session.abort, merge.execute (squash + verify + task.merged) — RunDO decides (actionsFor over the CORE service binding), Core executes
- Composite activity (git changes + commits + tool calls + telemetry within `activity.windowMs`), precise statuses, early-stop integration (phase `stopping` honored by the dispatcher)
- Worktree watcher: fs.watch + sweep backstop, delta-only `worktree.status_changed` events; branch registry in RunDO; git commits count as agent activity
- Live worktree tree graph on the status page (SVG, per-parent trees, state colors, drift badges) + worktree table via `/api/worktrees`
- Permission auto-responder (deny-by-default, per-role policy, v2 permission.reply)
- **Demo (`demo-m2.ts`):** real DAG (t2 depends on t1) executed end-to-end in a throwaway repo — worktrees, mock sessions, real commits, DAG-ordered squash merges, phase `finished`, live worktree events — all assertions green, offline.

**Exit (met):** a real DAG executes end-to-end — plan → graph → worktrees → agents → DAG-ordered merges → live worktree graph, zero human input.

### M3 — Autonomous governance (reviews, policies, approvals)

| Task                                                                                      | Status      |
| ----------------------------------------------------------------------------------------- | ----------- |
| Reviewer role agent configs (`edit: deny`, restricted bash)                               | not started |
| Reviewer dispatch on `ready_for_review` (N parallel, read-only)                           | not started |
| Review documents → R2; `review.verdict` events                                            | not started |
| Three-phase gate: READ → REVIEW → DECIDE (RunDO) replaces the M2 auto-merge trigger       | not started |
| Richer merge decisions: `mergeAuthority` policies, merge-log artifacts, conflict handling | not started |

**Exit:** a task passes the gate and merges under policy end-to-end.

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

`M1 + M2 + M3 + M4` — M1 and M2 are complete; **~4–6 focused sessions remain**
(M3 ~2, M4 ~2–3), to the "one prompt → finished app, zero intervention" goal.
M5 can follow or ship incrementally.

## Known risks (in build order)

1. ~~M1 integration unknowns — miniflare queue dispatch + the MCP stdio → Core shim transport.~~ **Resolved:** queue producer → consumer verified end-to-end; demo passes.
2. **OpenCode permission flow in headless mode** — the auto-responder must observe `permission.required` events correctly; verify early in M2 with a real `opencode serve`.
3. **Planner determinism** — the first graph must be trivially correct for a small app before it generalizes; the zod validation + loud failure path is the safety net.
4. **Git worktree provisioning speed** — installs per worktree are expensive; batch/symlink strategies are a later optimization, not a blocker.
5. **Miniflare needs bundling** — workerd cannot parse TS: the brain worker is esbuild-bundled (with `cloudflare:*` external) into `packages/core/dist/brain.js` at boot; bundles and persist dirs must live inside the repo (workerd sandbox).
