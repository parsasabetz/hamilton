# Hamilton Features — Ranked Tiers

> **Level 1 is the necessary feature set.** The definition of done: Hamilton takes
> a single initial prompt, plans it into a task graph, runs **multiple agents by
> itself** — dispatching in parallel, supervising, reviewing, and merging — and
> finishes a working app with **no human intervention** beyond that prompt.
>
> Level 2 makes the system trustworthy at cost; Level 3 makes it a platform.

## Level 1 — Necessary (the goal)

| #   | Feature                                           | Acceptance criterion                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Single-prompt run** — `hamilton run "<prompt>"` | One command boots the whole loop; the app is finished and committed without further human input                                                                                                                                                                             |
| 2   | **Deterministic planner**                         | Prompt + repo constants → zod-validated task graph (deps, zones, contracts, roles, models) → `graph.yaml` projection; invalid graphs fail loudly, never fixed silently                                                                                                      |
| 3   | **DAG dispatch & gating**                         | Tasks start only when all `depends_on` are `merged`; parallel tasks run concurrently; merge order is DAG order                                                                                                                                                              |
| 4   | **Git provisioning**                              | Per-task worktree + branch off the declared parent, deps installed; agents physically confined to their own worktree (no `git checkout`, no other branches)                                                                                                                 |
| 5   | **Session control**                               | Create session (role agent + model) → inject brief via `noReply` → `prompt_async` → session registry in KV → `abort` on demand                                                                                                                                              |
| 6   | **MCP emission**                                  | All 6 tools (`heartbeat`, `checkpoint`, `emit_event`, `ask_question`, `report_subagent`, `ready_for_review`) actually emit events onto the bus, not just acknowledge                                                                                                        |
| 7   | **Durable event spine**                           | Queue → RunDO handlers (dedupe by event id); KV registries (graph, agents, sessions); R2 artifacts (progress, terminal, reviews, metrics); TaskDO / AgentDO / ReviewDO state machines with alarms                                                                           |
| 8   | **Liveness & recovery**                           | Bridge-derived `agent.stalled`/`agent.idle` + `claim-deadline` + `heartbeat-expiry` alarms → verify via `/session/status` → abort → respawn **with continue instruction** (never restart from scratch); `retry-once` → escalate → gate dependents; unrelated tasks continue |
| 9   | **Reviewer loop**                                 | Read-only reviewer role (agent config: `edit: deny`, bash restricted to test/diff globs); N reviewers dispatched in parallel; review document written to R2; verdict events emitted                                                                                         |
| 10  | **Three-phase gate**                              | READ (factual) → REVIEW (judgment, runs the check process) → DECIDE (RunDO); PASS → merge path; FAIL → findings routed back → retry                                                                                                                                         |
| 11  | **Merge execution**                               | Squash-merge + verify (`git log origin/<parent> -1`) + status flip + merge-log artifact + DAG re-evaluation. `mergeAuthority: autonomous \| owner-gated` per run — **autonomous is required by the Level 1 goal**; owner-gated remains available (D2)                       |
| 12  | **Permission safety**                             | Role agent configs (implementer/reviewer), deny-by-default, permission auto-responder that never leaves an `ask` hanging                                                                                                                                                    |
| 13  | **Status page (basic)**                           | Live task table + agent table + event tail, SSE-pushed — the "exactly what is happening" view                                                                                                                                                                               |
| 14  | **Basic resumption**                              | Core restart → run continues from persisted state with no task loss                                                                                                                                                                                                         |
| 15  | **Logging & artifacts**                           | LogTape everywhere; every milestone/checkpoint/review lands an R2 artifact                                                                                                                                                                                                  |
| 16  | **Conductor session**                             | `hamilton start` opens a plan-mode OpenCode session `Conductor                                                                                                                                                                                                              | {project}`; user shapes/approves a plan; on confirmation the autonomous loop runs and reports back only when done or critically failed |
| 17  | **Supervision: watched commands**                 | Configurable command watch (default `git …`) detected from bash tool-call telemetry → `agent.command` + per-agent command log                                                                                                                                               |
| 18  | **Supervision: zone violations**                  | Edits outside the task's zone detected from tool telemetry → `agent.zone_violation` + violation log; policy `record` / `warn` / `block` (config)                                                                                                                            |
| 19  | **Early-stop policy**                             | Precise per-agent bookkeeping (`claimed/started/working/idle/error/stalled/died/ready-for-review` + `failures`); when enough agents fail, dispatch halts and healthy in-flight agents finish — run reports partial failure                                                  |
| 20  | **Delivery resilience**                           | Event leases (double-delivery guard) + exponential-backoff retries (capped) + dead-letter records — the orchestrator never loses an event                                                                                                                                   |

## Level 2 — Important (robustness & cost)

| Feature                                                                                                                      | Why it matters                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Budget guard** — 50% stop-and-report, per-task `budget_cap`, `opencode stats` accounting                                   | The autonomous run must be able to stop itself before burning money |
| **Subagent planning** — `allowed_subagents` enforcement + `report_subagent` protocol                                         | The "agents drop subagents" vision from the design brief            |
| **Dashboard depth** — DAG diagram, expandable detail panels, artifact shelf, `STALE`/`DIED` indicators                       | Trust: the page shows exactly why a decision was made               |
| **Check process** — reviewers run typecheck → format:check → tests → hooks; write tests from the task objective and run them | Catches what review reads miss                                      |
| **Q&A owner board** — `ask_question` lands on a board; auto-resolution policy for non-blocking questions                     | Keeps the loop unblocked when the human is away                     |
| **Full resumption** — event replay from R2 + alarm restoration on Core crash                                                 | Long runs must survive a killed machine                             |
| **Metrics & structured logs to R2** — usage per session/model, `/log` API                                                    | Cost and behavior forensics                                         |

## Level 3 — Future (platform)

- **Cloudflare deployment** — the brain (RunDO/TaskDO/AgentDO/ReviewDO) deploys to Cloudflare unchanged; the Bun Core becomes a remote executor
- **Multi-repo / multi-run** — several projects and runs per Core instance
- **Planner agent** — LLM-assisted decomposition with schema validation (today: deterministic rules only)
- **Workflows beyond alarms** — durable multi-step scheduling when single alarms stop scaling
- **Session replay viewer** — watch any agent session's full message stream from the browser
- **OpenCode plugin hybrid** — lifecycle hooks (auto-heartbeat on tool events) evaluated on top of the MCP surface
- **Distributed Core** — multiple executor processes sharing one brain

---

_Ranking principle: Level 1 items are what the goal sentence requires. If a feature is not needed to go from one prompt to a finished, merged app, it is not Level 1._
