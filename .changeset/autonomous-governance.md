---
"@hamilton/shared": minor
"@hamilton/core": minor
"@hamilton/brain": minor
"@hamilton/mcp": minor
"@hamilton/cli": minor
---

M1–M3: event spine, autonomous execution, and the review gate.

- M1 — the event spine: Miniflare brain (RunDO/TaskDO/AgentDO/ReviewDO),
  event bus (seq/KV/queue/SSE), status page, MCP emission shim.
- M2 — autonomous execution: planner + graph.yaml projection, worktree
  provisioning + watcher (delta-only drift events), dispatcher
  (worktree/session/merge actions over the CORE binding), composite
  activity, `hamilton run`/`start`/`init`, live worktree tree graph.
- M3 — autonomous governance: role-weighted review gate (deterministic
  READ, structured findings, vetoes), review.cleanup/nudge, idempotent
  merges, constants-layer validation.
