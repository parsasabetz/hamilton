# Hamilton — Multi-Agent Autonomous Orchestration Framework

> Named in memory and respect of **Margaret Hamilton** — the software she shipped didn't just run, it _reported on itself_, so humans and machines could trust it in the moment. Hamilton is that philosophy applied to software agents: an orchestrator that autonomously plans, dispatches, supervises, reviews, and retries a team of coding agents — and shows you exactly what it is doing, at all times.
>
> Status: **Design document (v0.1)** — authoritative for implementation. Written so a fresh engineer, or a fresh orchestrator session, can rebuild Hamilton from this file alone.
>
> Operational docs: **FEATURES.md** (ranked feature tiers, Level 1 = the necessary feature) · **ROADMAP.md** (remaining work per milestone).

## 0. Decision ledger

| #   | Decision              | Chosen default                                                                                                                                                                                           | Override                                                        |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1  | Brain location        | Orchestrator logic lives in **Durable Objects under Miniflare** (alarms = wake-ups); the Bun process is the **executor** (git, spawning, opencode control). Same brain code later deploys to Cloudflare. | —                                                               |
| D2  | Merge authority       | Orchestrator decides reviews/retries/escalations autonomously; **squash-merges wait for explicit owner confirmation** (per AGENTS.md guardrail precedent in `manifest.md`).                              | Per-run config flag `mergeAuthority: owner-gated \| autonomous` |
| D3  | Agent interface       | Agents talk to Hamilton through a **local MCP server** (tools: `heartbeat`, `checkpoint`, `emit_event`, `ask_question`, `report_subagent`, `ready_for_review`). No plugin coupling.                      | —                                                               |
| D4  | Status page           | One dumb page: **tables + simple DAG diagram, SSE live push**. No frontend framework, no chart libs.                                                                                                     | —                                                               |
| D5  | State source of truth | Runtime state lives in DO storage + KV; `graph.yaml` and `progress/` are **rendered projections**, never hand-edited.                                                                                    | —                                                               |

## 1. What Hamilton is

**Mission.** Hamilton runs a project build autonomously: one orchestrator (a Durable Object) holds an execution plan — existing or self-created — decomposes the request into a deterministic task graph, dispatches agents in parallel per dependency order, lets each agent spawn its own planned subagents, hands finished work to reviewers (who read the plan, write tests from the objective, run them, and write review documents), then decides what happens next. Humans are needed only at the gates they own: merges and Q&A.

**Operating principles.**

1. **Minimal** — a small, fixed set of primitives (events, tasks, sessions, reviews, artifacts). If a feature isn't expressed in these, it doesn't ship.
2. **Event-driven** — everything is an event; state, logs, the dashboard, and the yaml mirrors are _projections_ of the event history. No polling (this is the explicit replacement of `poll.sh`'s `sleep 150` loop in `.agent-state`).
3. **Tight loops** — the orchestrator reacts to events in milliseconds and schedules its own wake-ups with DO alarms; agents heartbeat so liveness is observable, never assumed.
4. **Autonomous but gated** — decisions that are mechanical are automated; decisions that are judgment (merges) or facts (unanswered questions) route to the owner.
5. **Observable by design** — every action produces an artifact; the status page is a projection of the event bus, so it cannot lie.

**Goals.**

- Multi-agent parallel execution from a DAG, with dependency gating.
- Agents that plan their own subagents; subagent activity reported and auditable.
- A reviewer loop: reviewers run tests, write tests from task objectives, and file review documents the orchestrator decides on.
- Full failure handling: agent never starts, dies, quits, pauses, session breaks — orchestration continues without human intervention.
- Three immutable memory layers: constants, runtime state, append-only artifacts.
- One `bun` server serving the live status page.

**Non-goals.**

- Not a new agent runtime — OpenCode is the agent runtime; Hamilton orchestrates it.
- Not a CI system — no build pipeline, artifact publishing, or environment matrix.
- Not a multi-tenant platform — one repo/run at a time in v1.
- No human in the happy path, except owner-gated merges and Q&A.

## 2. Terminology

| Hamilton term  | Meaning                                                  | `.agent-state` ancestor              |
| -------------- | -------------------------------------------------------- | ------------------------------------ |
| **Run**        | One orchestration session over one repo request          | "layer" run in `ORCHESTRATOR.md`     |
| **Task**       | One unit of work in the DAG, one branch, one contract    | `graph.yaml` task                    |
| **Agent**      | An OpenCode session executing a task (or sub-task)       | worker session S2/S3…                |
| **Role**       | Agent configuration: implementer, reviewer, planner      | —                                    |
| **Reviewer**   | Read-only agent that tests + files a review document     | review subagent (ORCHESTRATOR.md §4) |
| **Event**      | The single unit of communication on the bus              | checkpoint append (progress files)   |
| **Artifact**   | Append-only object (log, report, metrics) in R2          | `progress/*.md`, merge log           |
| **Projection** | A rendered view of state (graph.yaml, dashboard, status) | `manifest.md` status board           |
| **Worktree**   | git worktree + branch provisioned per task               | ORCHESTRATOR.md §2                   |
| **Heartbeat**  | Liveness signal from a running agent                     | poll.sh worktree diff                |
| **Gate**       | Three-phase READ → REVIEW → DECIDE on `ready_for_review` | ORCHESTRATOR.md §4                   |
| **Budget**     | Spend tracking + stop-and-report threshold               | manifest.md budget guard             |

## 3. System architecture

Three planes, one contract — the event bus.

```
┌─────────────────────────────── Hands (opencode serve :4096) ───────────────┐
│  one long-lived headless OpenCode server. Sessions are cheap; one server    │
│  avoids MCP cold-boot per task. Auth: OPENCODE_SERVER_PASSWORD (basic auth, │
│  username `opencode`).                                                       │
└──────────────▲──────────────────────────▲────────────────────────────────────┘
               │ SSE /event                │ SDK REST (create, prompt_async,
               │                            │  abort, permissions, diff, todo)
┌──────────────┴──────────────────────────┴───────────────────────────────────┐
│ Core (Bun process — the executor)                                            │
│  • HTTP API + SSE hub + status page server (Bun.serve), started via the      │
│    `hamilton` CLI (`@hamilton/cli`, citty)                                   │
│  • git: worktree provisioning, merge execution, verify                       │
│  • opencode control plane (SDK client)                                       │
│  • Hamilton MCP server host (stdio, served to agents)                        │
│  • budget accounting (opencode stats + usage events)                         │
└──────▲───────────────────────▲────────────────────────────▲──────────────────┘
       │ put/get/list           │ RPC to DO stubs             │ produce
┌──────┴───────────────────────┴────────────────────────────┴──────────────────┐
│ Brain (Miniflare, in-process, workerd semantics)                              │
│  • Durable Objects: RunDO, TaskDO, AgentDO, ReviewDO (alarms = wake-ups)      │
│  • KV: registries + event log   • R2: artifacts   • Queue: event bus          │
│  • Persisted: kvPersist / r2Persist / durableObjectsPersist dirs — state      │
│    survives process restarts (miniflare get-started: persist options)         │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Why Miniflare rather than a plain database:** workerd semantics locally, alarms (`setAlarm`/`getAlarm`/`deleteAlarm`) give the orchestrator scheduled wake-ups for free, and the same DO code can later deploy to Cloudflare unchanged — the Bun Core becomes a remote executor (refs: [miniflare](https://developers.cloudflare.com/workers/testing/miniflare/), [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
- **Why one long-lived `opencode serve`:** sessions are cheap, MCP servers don't cold-boot per task, `session.create` + `prompt_async` is a fire-and-forget control surface, and the `/event` SSE stream is the single observation point for all agent activity (refs: [server docs](https://opencode.ai/docs/server/)).
- **Why Bun:** single binary runtime for the server, SSE, and shelling out to git/opencode; `Bun.serve` and `EventSource` are built-in (ref: [Bun docs](https://bun.sh/docs)).

### 3.1 How a run starts — the Conductor session

`hamilton start` boots the loop as a conversation: it ensures an `opencode serve`
is reachable (spawning one if not), creates an OpenCode session in **plan mode**
titled `Conductor | {project name}` (title derived from the seeded prompt), and
seeds the conductor brief (read `HAMILTON.md`/`FEATURES.md`/`ROADMAP.md`, plan —
never edit code, confirm before executing). The user talks to the conductor to
shape or approve a plan; **on confirmation, the conductor hands the plan to the
autonomous loop** (`hamilton run`, the dispatch milestone), supervises outcomes
(reviews, merges), and **reports back when the work is done or has critically
failed** — no further human assistance until then. `hamilton dev` remains the
bare-core server; `hamilton start` is the operator's front door.

## 4. The event-driven model

### 4.1 Rules

1. Events are the only language between planes. No file polling, no shared mutable files.
2. The event log is append-only and ordered per run (`seq` assigned by the Core bus, zero-padded KV keys preserve order; RunDO dedupes by event id and rejects stale seqs).
3. State, dashboard, and yaml mirrors are projections; they are recomputed, never hand-written.
4. At-least-once delivery: consumers must be idempotent by event `id`.

### 4.2 Envelope

```ts
interface HamiltonEvent {
  id: string // `evt_<ulid>` — dedupe key
  type: EventType
  ts: string // ISO 8601
  runId: string
  taskId?: string
  agentId?: string // opencode session id
  seq: number // per-run monotonic, assigned by the Core bus
  payload: unknown
}
```

### 4.3 Event types

| Domain    | Type                                                     | Emitted by      | Meaning                                                                                       |
| --------- | -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| agent     | `agent.claimed`                                          | agent (MCP)     | Read the brief; plan recorded                                                                 |
| agent     | `agent.started`                                          | agent (MCP)     | First concrete action taken                                                                   |
| agent     | `agent.milestone`                                        | agent (MCP)     | File/tests/commit done; message = checkpoint                                                  |
| agent     | `agent.heartbeat`                                        | agent (MCP)     | Liveness; resets AgentDO expiry alarm                                                         |
| agent     | `agent.error`                                            | agent (MCP)     | Error + impact + recovery                                                                     |
| agent     | `agent.blocked`                                          | agent (MCP)     | Hard blocker; implies question file                                                           |
| agent     | `agent.ready_for_review`                                 | agent (MCP)     | Done; PR URL, branch, test/check status                                                       |
| agent     | `agent.subagent_spawned` / `agent.subagent_result`       | agent (MCP)     | Subagent responsibilities + outcome                                                           |
| agent     | `agent.stalled`                                          | Core bridge     | Busy session, no stream activity ≥ stallTimeout — model hung / tool stuck                     |
| agent     | `agent.idle`                                             | Core bridge     | Session turned busy → idle; RunDO pairs with task state to catch silent quits                 |
| agent     | `agent.command`                                          | RunDO (derived) | Watched shell command detected in tool telemetry (e.g. `git …`); payload { command, matched } |
| agent     | `agent.zone_violation`                                   | RunDO (derived) | File edited outside the task's zone; payload { path, taskId }                                 |
| agent     | `agent.died`                                             | AgentDO alarm   | Heartbeat expired / session vanished                                                          |
| review    | `review.assigned` / `review.started`                     | RunDO           | Reviewer session dispatched                                                                   |
| review    | `review.submitted`                                       | reviewer (MCP)  | Review document filed (R2 ref in payload)                                                     |
| review    | `review.verdict`                                         | RunDO           | PASS / FAIL aggregated                                                                        |
| task      | `task.dispatched`                                        | RunDO           | Session created, brief injected                                                               |
| task      | `task.status_changed`                                    | TaskDO          | Lifecycle transition                                                                          |
| task      | `task.merged`                                            | RunDO           | Owner confirmed + merge executed                                                              |
| task      | `task.escalated` / `task.blocked`                        | RunDO           | Failure handling                                                                              |
| run       | `run.planned`                                            | RunDO           | Graph rendered; dispatch begins                                                               |
| run       | `run.pause` / `run.resume` / `run.finish`                | RunDO/owner     | Run control                                                                                   |
| system    | `budget.exceeded`                                        | Core            | 50% stop-and-report line crossed                                                              |
| system    | `owner.action`                                           | Core            | Merge confirmed / question answered / override                                                |
| system    | `system.error`                                           | any             | Internal failure; always lands in R2                                                          |
| telemetry | `telemetry.opencode`                                     | Core bridge     | Raw OpenCode SSE event passthrough (audit/dashboard/RunDO policy input)                       |
| telemetry | `telemetry.stream_lost` / `telemetry.stream_reconnected` | Core bridge     | SSE observation gap — liveness data untrustworthy while down                                  |

**Why Hamilton events are not OpenCode events.** OpenCode's own `/event` stream (session.updated, message.part.updated, todo.updated, session.error, vcs.branch.updated, …) is low-level session telemetry: what happened _inside_ the tool. It has no concept of tasks, contracts, review verdicts, merges, budgets, heartbeats, or death — and it never emits "died"; a dead session is just a silent stream. Hamilton events are domain semantics (intent declared via MCP, state-machine transitions, derived liveness), so the two layers compose instead of overlap: the Core's bridge subscribes to OpenCode's stream and forwards raw telemetry as `telemetry.*` events (terminal tails, todo/session detail, permission requests, error candidates) that enrich the projections — while Hamilton events drive the decisions.

### 4.4 Flow

```
agent (MCP tool) ──► Core shim ──► Queue (durable buffer + retries) ──► RunDO.alarm()/fetch()
                                                                    │
                                RunDO handler: dedupe by id ─► update TaskDO/AgentDO/ReviewDO
                                                                    │
                                          append artifact (R2) ◄────┴── project (KV/yaml/dashboard SSE)
```

**Delivery semantics (leases + retry).** The queue consumer gives every event a
**lease** (`lease:<eventId>` in KV, TTL from config): a delivery in flight is
skipped by concurrent deliveries, and the lease is released on success or
before a retry. Failures retry with **exponential backoff**
(`baseDelayMs · 2^(attempts−1)`, capped at `maxDelayMs`, max `maxAttempts`);
exhausted events land in `dead:<eventId>` for forensics. RunDO's dedupe-by-id
plus stale-seq rejection makes reprocessing idempotent.

Refs: [Queues JS APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [miniflare queue dispatch](https://developers.cloudflare.com/workers/testing/miniflare/get-started/).

## 5. Durable Objects

Per-entity DOs; one writer per entity (ref: [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). Alarms do not repeat — every handler re-arms the next one.

### 5.1 RunDO — the orchestrator brain

- **Owns:** the run: task graph, event `seq` counter, run phase, decisions.
- **Consumes:** every queue event; handlers are small pure state transitions.
- **Alarms:** status cadence (periodic `run.summary`), delayed gates.
- **Exposes RPC:** `state()`, `graph()`, `decide(event)`, `pause()`, `resume()`.

### 5.2 TaskDO — task lifecycle

```
planned ──► in-progress ──► ready-for-review ──► reviewing ──► approved ──► merged
              │  ▲                │                  │             │
              ▼  │                ▼                  ▼             ▼
          blocked ◄────── (retry exhausted / owner veto)       escalated
```

- `depends_on` gating: dispatch only when all deps are `merged`; optional tasks (`status: optional`) never gate.
- `on_failure: retry-once | skip | escalate` (inherited from `graph.yaml`).

### 5.3 AgentDO — session + liveness

- **Owns:** session state machine, last heartbeat, session id, model, steps, tokens.
- **Alarms:** `claim-deadline` (agent never started) and `heartbeat-expiry` (agent died) — both fire `agent.died`-class handling via RunDO.

```
claimed ──► started ──► working ──► idle ──► finished
   │          │           │  ▲
   ▼          ▼           ▼  │           error ──► died
```

### 5.4 ReviewDO — reviewer coordination

- **Owns:** reviewer assignments (N parallel reviewers per task), verdict aggregation, gate results (PASS/FAIL + findings refs).

### 5.5 IDs and storage

- `idFromName()`: `run:<runId>`, `task:<runId>:<taskId>`, `agent:<runId>:<sessionId>`, `review:<runId>:<taskId>:<reviewerIdx>`.
- Storage layout per DO: `state`, `lastEventId`, `history[seq]` (small ring), alarm bookkeeping.
- Cleanup: `storage.deleteAll()` (clears alarms on compatible dates — [changelog](https://developers.cloudflare.com/changelog/post/2026-02-24-deleteall-deletes-alarms/)) when the entity completes.

## 6. Storage: three memory layers

| Layer                        | Content                                                                                                                                                                                                 | Where                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **1. Constants (immutable)** | `.hamilton/CONDUCTOR.md` + `.hamilton/AGENTS.md` (critical instructions), `AGENTS.md`, execution plans, coding standards, the **check process**, runtime config, Hamilton config (`hamilton.config.ts`) | Files on disk (agents read them directly) + KV mirror for the Core |

**Project bootstrap:** `hamilton init` creates the constants layer in any project —
`.hamilton/CONDUCTOR.md` and `.hamilton/AGENTS.md` (critical instructions for the
conductor and its agents) plus `hamilton.config.ts` (default runtime config; all
fields optional). Never overwrites existing files. The Core resolves config as
defaults < `hamilton.config.ts` < explicit overrides, and fails loudly on a
malformed file — the constants layer is trusted input.
| **2. Runtime state (mutable)** | task graph, agent registry, session registry, review status, budgets, heartbeats, run status | DO storage + KV registries |
| **3. Artifacts (append-only)** | logs, progress reports, review reports, terminal output, metrics | R2, keyed `runId/taskId/<seq>-<type>.json` |

**The check process (constant):** the flow run at the very end of an agent finishing — `typecheck → format:check → tests → pre-commit hooks` (adapted from the pre-commit bar in `briefs/S2-motion-schema.md` §27). Executed by reviewers via restricted bash; results attached to the review document.

**Projections (D5):** `graph.yaml` and `progress/*.md` are rendered from runtime state at every state change — human/legacy-readable, never hand-edited. The status page (§15) is the same projection in HTML.

Refs: [R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/), [KV](https://developers.cloudflare.com/kv/get-started/), [miniflare storage](https://developers.cloudflare.com/workers/testing/miniflare/get-started/).

## 7. Agent interface — Hamilton MCP server

A local MCP server (stdio, spawned by OpenCode per the existing `.opencode/opencode.json` `mcp` block pattern) that shims every tool call into an event on the bus. No plugin, no SDK coupling (D3). Refs: [MCP servers](https://opencode.ai/docs/mcp-servers/), [permissions wildcards](https://opencode.ai/docs/permissions/).

| Tool               | Signature                                                         | Semantics                                                                                                          |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `heartbeat`        | `note?: string`                                                   | Emit `agent.heartbeat`; resets expiry alarm                                                                        |
| `checkpoint`       | `phase: string, message: string, files?: string[]`                | Emit `agent.milestone`; append progress artifact to R2                                                             |
| `emit_event`       | `type: string, payload: object`                                   | Any agent-side event (reserved for custom types)                                                                   |
| `ask_question`     | `question: string, options?: string[]`                            | Emit `agent.blocked`-adjacent question; lands on owner's board; agent may continue working unless `blocking: true` |
| `report_subagent`  | `role: string, objective: string, result: string`                 | Emit `agent.subagent_spawned`/`_result` (mandatory per-brief protocol, ORCHESTRATOR.md §3b.5)                      |
| `ready_for_review` | `summary: string, prUrl?: string, branch: string, checks: object` | Emit `agent.ready_for_review`; triggers the gate                                                                   |

Per-role permission matrices (e.g. reviewer: `hamilton_*: allow`, `edit: deny`) are applied via agent config (ref: [agents docs](https://opencode.ai/docs/agents/)).

## 8. Orchestrator control plane — OpenCode SDK + SSE

The Core drives OpenCode through `@opencode-ai/sdk` (ref: [SDK](https://opencode.ai/docs/sdk/)) against the running server (ref: [server](https://opencode.ai/docs/server/)).

1. **Create:** `client.session.create({ title, body })` → session id registered in KV session registry.
2. **Brief injection:** `client.session.prompt({ noReply: true, parts: [brief...] })` — context without triggering a response.
3. **Run:** `client.session.prompt({ parts: [task prompt], agent, model })` — awaited asynchronously; completion detected via SSE, not blocking.
4. **Watch:** the Core's SSE bridge (`packages/core/src/bridge.ts`) subscribes to `/event` and re-emits every raw event as `telemetry.opencode`. For each **tracked** session (only sessions the orchestrator owns are watched — `track()` on dispatch, `untrack()` on completion), the bridge derives liveness: `agent.stalled` when a busy session shows no stream activity past the stall timeout, `agent.idle` on busy → idle transitions, and `telemetry.stream_lost/reconnected` when the observation channel itself fails. Raw events (message/todo/permission/session) drive the permission auto-responder and dashboard detail. Heartbeats (MCP) are a secondary signal — the stream is authoritative.
5. **Abort:** `client.session.abort()` on failure handling or owner pause.
6. **Inspect:** `session.diff`, `session.todo`, `session.messages` for gate and dashboard detail.
7. **Permissions:** auto-responder answers `POST /session/:id/permissions/:permissionID` — `allow` within role policy (e.g. `git push <own branch>` for implementers), `deny` otherwise; `ask` never left unanswered.
8. **Auth:** `OPENCODE_SERVER_PASSWORD`; server bound to `127.0.0.1` (ref: [CLI](https://opencode.ai/docs/cli/)).

## 9. Task graph & planner

### 9.1 Task schema (zod, authoritative)

```ts
const Task = z.object({
  id: z.string(),
  role: z.enum(["implementer", "planner", "reviewer", "docs"]),
  zone: z.array(z.string()), // preferred file scope (soft guidance, brief S2 §17-21)
  depends_on: z.array(z.string()), // gate: merged
  status: z.enum([
    "planned",
    "in-progress",
    "ready-for-review",
    "reviewing",
    "approved",
    "merged",
    "blocked",
    "optional",
  ]),
  on_failure: z.enum(["retry-once", "skip", "escalate"]),
  contract: z.object({
    inputs: z.array(z.string()), // doc §refs, files, line ranges
    outputs: z.array(z.string()),
  }),
  model: z.string(), // provider/model
  allowed_subagents: z.array(z.string()).default([]),
  budget_cap: z.number().optional(), // USD
  branch: z.string().optional(),
  pr_title: z.string().optional(),
})
```

Direct evolution of `graph.yaml` (ref: `.agent-state/graph.yaml`) — fields map 1:1; `role`, `model`, `allowed_subagents`, `budget_cap` are new.

### 9.2 Planner (deterministic)

1. Inputs: user request + execution plans + standards (constants) + repo state.
2. Produce candidate graph JSON; **validate** against the schema; fail loudly on invalid graphs (never fix silently).
3. Render `graph.yaml` projection (D5).
4. Revision is a graph operation (split task, add task, gate dependents, reorder) — same schema, same validation.

### 9.3 Brief generation

One brief per task, inheriting the S2 brief format (ref: `briefs/S2-motion-schema.md`): read-first order, worktree/branch, zone, contract, model + allowed subagents, reporting protocol, safety rules restated.

## 10. Roles & agents

OpenCode agent files (`.opencode/agents/*.md`, ref: [agents docs](https://opencode.ai/docs/agents/)):

| Agent         | mode    | Model                                 | Permission highlights                                                                                                                                                                                                                                                   |
| ------------- | ------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementer` | primary | per-plan (e.g. flash, high reasoning) | `edit: allow`, `bash: allow` (zone-scoped globs), `task: allow` (only `allowed_subagents`), `git push <own branch>: allow`, `git fetch/push --force*, git rebase, git reset --hard: deny`                                                                               |
| `reviewer`    | primary | per-plan (judgment)                   | `edit: deny`, `bash: { "*": ask, "git diff*": allow, "git log*": allow, "git show*": allow, "npm test*": allow, "pnpm typecheck*": allow, "pnpm format:check*": allow, "grep*": allow, "rg*": allow }` — enough to read, run tests, run the check process; nothing else |
| `planner`     | primary | per-plan                              | `edit: deny`, read + bash read-only; writes plan artifacts only                                                                                                                                                                                                         |

- **Subagent policy:** each task declares `allowed_subagents`; `permission.task` globs enforce it (`"*": deny` + allowlist), and every spawn must be reported via `report_subagent` (ORCHESTRATOR.md §3b.5).
- **Check process:** run by reviewers at gate time; results recorded in the review document.

## 11. The orchestration loop

Numbered end-to-end (each step cites its `.agent-state` ancestor):

1. **Plan** — RunDO renders the graph; `run.planned`. (graph.yaml)
2. **Dispatch unblocked tasks** — all deps `merged`, status `planned` → `in-progress`. (ORCHESTRATOR.md §3.4)
3. **Provision worktree** — Core: `git worktree add`, branch off parent, install deps. (ORCHESTRATOR.md §2)
4. **Create session** — role agent + model; register in KV session registry.
5. **Inject brief + prompt** — `noReply` brief, then run prompt. (briefs/S2)
6. **Arm claim-deadline alarm** — no `agent.claimed` by deadline → respawn (see §12).
7. **Supervise** — heartbeats re-arm expiry; milestones append R2 artifacts; `agent.blocked`/questions route to owner board. (§3b protocol)
8. **On `ready_for_review`** — dispatch N reviewers (default 2) as read-only sessions with diff + contract + check process. (ORCHESTRATOR.md §3.3)
9. **Three-phase gate** — (a) **READ**: fresh factual subagent — what changed, zone compliance, commit list; (b) **REVIEW**: fresh judgment subagent (Max reasoning) — contract vs code, tests run (writes tests from the objective and runs them), check process green, safety compliance, PR targets parent; (c) **DECIDE**: RunDO weighs READ + REVIEW → `approved` or `rejected` with findings routed back to the task (reject → retry-once, never silent). (ORCHESTRATOR.md §4)
10. **Merge (owner-gated, D2)** — on `approved`: prepare squash-merge command, request owner confirmation (or execute directly if `mergeAuthority: autonomous`); execute; verify `git log origin/<parent> -1`; flip `merged`; append merge log artifact; re-evaluate DAG for newly unblocked tasks and pre-draft their briefs. (ORCHESTRATOR.md §5)
11. **Status cadence** — RunDO alarm emits `run.summary` periodically; the dashboard is always current via the same events. (§3a, §3.6)

## 12. Failure semantics

| Scenario                   | Detection                                                                                                                             | Recovery                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Many agents fail**       | RunDO bookkeeping: `failures` per agent; `shouldStop` — failed ≥ `maxFailedAgents` or failed/known ≥ `failedRatio` → phase `stopping` | Dispatch halts (no new planned→in-progress); healthy in-flight agents finish; run reports partial failure                                                                                                      |
| **Zone violation**         | RunDO: `edit`/`write` tool telemetry with `filePath` outside the task's zone → `agent.zone_violation` + violation log                 | `zoneViolation: record` logs it (default); `warn` surfaces on the dashboard; `block` gates the task (M2)                                                                                                       |
| **Watched command**        | RunDO: bash tool telemetry matched against `watchCommands` (default `["git"]`) → `agent.command` + command log                        | Recorded per agent — exact audit trail of every `git …` invocation                                                                                                                                             |
| **Agent never starts**     | `claim-deadline` alarm (AgentDO)                                                                                                      | Respawn: fresh session, same brief, "inspect and continue"                                                                                                                                                     |
| **Agent dies / quits**     | `heartbeat-expiry` alarm (AgentDO) + bridge stream loss / `agent.stalled`                                                             | Abort session if alive → respawn with continue instruction (never restart from scratch — ORCHESTRATOR.md §7.4)                                                                                                 |
| **Agent stalls mid-turn**  | bridge: busy session, no stream activity ≥ stall timeout → `agent.stalled` (model hung / tool call stuck)                             | Verify via `/session/status` + messages → `abort` → respawn with continue instruction; guard tool timeouts via `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`                                                 |
| **Agent goes quiet**       | bridge: `agent.idle` (busy → idle) while task still in-progress with no `ready_for_review`                                            | RunDO pairs idle signal with task state → nudge prompt; repeated → treat as quit (§13.1 path)                                                                                                                  |
| **Agent pauses / freezes** | `agent.stalled` + no progress events                                                                                                  | Owner sees `STALE` on dashboard; auto-resume via injected nudge prompt; escalate if repeated                                                                                                                   |
| **Session breaks**         | bridge `telemetry.stream_lost` + reconnect with backoff; session registry lookup                                                      | Reconnect; resume via registry (session id keyed by taskId); respawn session if unrecoverable                                                                                                                  |
| **Task fails**             | gate FAIL or `agent.error`                                                                                                            | `retry-once` → fresh-context agent, same branch, continue; second failure → `escalate` → mark `blocked`, gate dependents, write escalation report; unrelated parallel tasks continue (graph.yaml `on_failure`) |
| **Orchestrator crashes**   | Core restarts; Brain persisted                                                                                                        | **Resumption protocol:** read KV/DO state, replay event log, restore alarms, continue the loop (ORCHESTRATOR.md §7)                                                                                            |

### 12.1 Supervision & per-agent audit logs

Every agent gets an exact, append-only audit trail in R2 under
`artifacts/<runId>/agent-<agentId>/<kind>/<seq>-<eventId>.json`:

- **milestones** — every `agent.milestone` (phase, message, files, ts, seq)
- **commands** — every watched shell command (`watchCommands` config, default `git …`), detected from bash tool-call telemetry
- **violations** — every out-of-zone file edit (path, task zone)
- **reports** — `ready_for_review` declarations and `subagent_result` reports

Agent state is precise in the run snapshot: `claimed / started / working /
idle / error / stalled / died / ready-for-review`, plus `failures`,
`lastCommand`, `zoneViolations`, `milestoneCount` — the "exact bookkeeping" the
orchestrator's early-stop policy (§12) and the status page (§15) read from.

## 13. Budget & cost control

- Weekly cap and **stop-and-report at 50%** (`budget.exceeded`) — semantics inherited from `manifest.md` budget guard.
- Per-task `budget_cap`; usage events + `opencode stats` feed the Core's accounting.
- On stop-and-report: pause new dispatches, finish in-flight work, surface the report on the dashboard.

## 14. Guardrails & safety (non-negotiable)

Each traces to ORCHESTRATOR.md §6; all restated in every generated brief.

1. **Zone discipline** — agents work in their own worktree only; out-of-zone changes minimal + justified in state file and PR body; never `git add -A`.
2. **Branch isolation** — only the task's own branch is created/pushed; no force-push, no rebase, no history touches; PR targets the declared parent only.
3. **Version bumps** — PATCH only via changeset commands; never manual `package.json` edits.
4. **Many small commits** — one logical unit per commit; each reported via checkpoint.
5. **Permissions deny-by-default** — role configs gate every tool; permission auto-responder never leaves an `ask` hanging.
6. **Local-first** — Core API and MCP server bind `127.0.0.1`; `OPENCODE_SERVER_PASSWORD` set.
7. **Owner gates** — merges (D2) and unanswered questions route to the owner; violations halt the task and report.
8. **PRs on finish** — final state includes PR URL with comprehensive body (ORCHESTRATOR.md §5.1).

## 15. Status page (D4)

One HTML page served by the Bun Core. Zero frontend deps, no build step: a single `index.html` + `<script>` using `EventSource`. Dark, monospace, terminal-faithful; color only on status spans.

**Header strip** — run id, phase, uptime, budget spent/total + 50% line, last-event ts, heartbeat count.

**Task section** — a minimal DAG diagram (boxes + lines rendered from `depends_on`, status-colored; plain CSS/SVG, no library) above a task table in DAG order:

```
id | role | status | session | last checkpoint | branch | deps →
```

Statuses span the full lifecycle; dead-agent tasks flash `STALE`.

**Agent table** — `session | role | task | state | heartbeat age | model | steps | tokens`. Click-to-expand detail panel: milestones, `session.todo`, open questions, artifact links, message-stream tail.

**Event stream tail** — the live appended event log (`type | ts | task | payload-brief`) — the bus rendered, so it can't lie.

**Artifact shelf** — latest R2 artifacts per task (`progress`, `review`, `terminal`, `metrics`) as links.

**Data flow** — `GET /api/state`: KV registries + RPC to DO stubs → one JSON snapshot (the same snapshot the graph.yaml projection is rendered from — page, yaml, and DOs can never disagree). `GET /api/stream`: SSE fan-out of bus events + opencode `/event` + heartbeat ticks.

## 16. Phased plan

| Phase  | Goal                      | Deliverables                                                                                                                                                 | Exit criteria                                                    |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **M0** | Prove the stack           | Miniflare-under-Bun smoke: KV/R2/DO-alarm/queue persist across restarts; opencode-serve SDK loop: create / prompt_async / abort / SSE / structured output    | Both spikes green; findings recorded in `HAMILTON.md`            |
| **M1** | Event spine               | Core API + SSE hub; event schema + KV log; queue → RunDO wiring; MCP server; page skeleton (header/task table/event tail)                                    | One demo task: claim → milestones → ready → visible on page live |
| **M2** | Planner + graph           | Task schema; deterministic planner; dispatch + gating; worktree provisioning; brief generation; registries; claim-deadline alarms; DAG diagram + agent table | Two dependent tasks run in parallel and merge in DAG order       |
| **M3** | The gate                  | Reviewer role + read-only config; review docs → R2; three-phase gate; owner-gated merge flow; merge log artifacts                                            | A task passes gate and merges end-to-end via owner confirmation  |
| **M4** | Failure + guardrails      | Heartbeat death detection + respawn; never-started handling; pause/resume; budget guard; permission policies; STALE/budget on page                           | Kill an agent mid-task; Hamilton recovers autonomously           |
| **M5** | Observability + hardening | Artifact shelf; structured logging; live session tails; crash-recovery drill (kill everything, resume from disk); Cloudflare deploy decision                 | Full run survives a Core crash with zero task loss               |

## 17. Risks & open questions

- **Bun × Miniflare compatibility** — miniflare is a Node ESM package spawning workerd; verify early in M0 (fallback: drive Miniflare via a small Node shim).
- **Miniflare queue-dispatch specifics** — queue producer/consumer option names vary by version; pin in M1.
- **OpenCode event-type drift** — SSE event names/payloads are versioned; enumerate from `localhost:4096/doc` and re-verify on upgrade.
- **opencode version pinning** — pin in the repo's `.opencode/package.json` (currently `@opencode-ai/plugin@1.18.7`) so control-plane calls stay stable.
- **Remote-deploy feasibility** — DO brain deploys to Cloudflare only after M5 decides the executor story (local Bun as remote executor).

## 18. References

**OpenCode**

- SDK: https://opencode.ai/docs/sdk/
- Server (REST + SSE, OpenAPI at `/doc`): https://opencode.ai/docs/server/
- CLI (`serve`, `run --attach`, `stats`, env vars): https://opencode.ai/docs/cli/
- Agents (config, permissions, task permissions): https://opencode.ai/docs/agents/
- MCP servers: https://opencode.ai/docs/mcp-servers/
- Permissions (allow/ask/deny, bash globs): https://opencode.ai/docs/permissions/

**Cloudflare / Miniflare**

- Miniflare overview: https://developers.cloudflare.com/workers/testing/miniflare/
- Miniflare get-started (API, persist, dispatch): https://developers.cloudflare.com/workers/testing/miniflare/get-started/
- DO storage in Miniflare: https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/
- DO alarms API: https://developers.cloudflare.com/durable-objects/api/alarms/
- Rules of Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Queues JS APIs: https://developers.cloudflare.com/queues/configuration/javascript-apis/
- KV: https://developers.cloudflare.com/kv/get-started/
- R2 Workers API: https://developers.cloudflare.com/r2/get-started/workers-api/

**Bun** — https://bun.sh/docs

**Internal (inherited system)** — `.agent-state/ORCHESTRATOR.md` (loop §3, state protocol §3b, gate §4, merge §5, guardrails §6, resumption §7), `.agent-state/manifest.md` (status board, Q&A, budget, merge log), `.agent-state/graph.yaml` (task DAG), `.agent-state/briefs/S2-motion-schema.md` (brief format, reporting protocol, safety), `.agent-state/progress/motion-schema.md` (checkpoint format), `.agent-state/poll.sh` (the polling loop Hamilton replaces), `.opencode/opencode.json` (MCP config pattern), `.opencode/package.json` (version pin).
