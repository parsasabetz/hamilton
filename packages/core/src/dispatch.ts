import { getLogger } from "@logtape/logtape"
import type {
  CoreAction,
  CoreActionResult,
  HamiltonConfig,
  HamiltonEvent,
} from "@hamilton/shared"
import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import type { BusHandle } from "./eventbus.ts"
import { readReviewerInstructions } from "./constants.ts"
import {
  createWorktree,
  installIfLockfile,
  parentHead,
  squashMerge,
} from "./git.ts"
import type { GitOptions } from "./git.ts"
import type { ControlPlane } from "./opencode.ts"
import type { BrainHandle } from "./runtime.ts"

const logger = getLogger(["hamilton", "core", "dispatch"])

export interface DispatcherBrain extends BrainHandle {
  registryGet(key: string): Promise<string | null>
  registryPut(key: string, value: string): Promise<void>
  /** List registry keys by prefix. */
  registryList(prefix: string): Promise<string[]>
  /** Delete a registry key (used by review.cleanup). */
  registryDelete(key: string): Promise<void>
}

export interface DispatchContext {
  runId: string
  repoRoot: string
  worktreesDir: string
  parent: string
  config: HamiltonConfig
  bus: BusHandle
  brain: DispatcherBrain
  controlPlane: ControlPlane | undefined
  /** Resolves the task's session spec (agent role, model, generated brief). */
  getTask?: (
    taskId: string,
    worktreePath?: string,
  ) => TaskSessionSpec | undefined
}

/** What the dispatcher needs to start a task's session. */
export interface TaskSessionSpec {
  agent: string
  model: string
  brief: string
}

export interface DispatcherHandle {
  handleAction(action: CoreAction): Promise<CoreActionResult>
}

export function createDispatcher(ctx: DispatchContext): DispatcherHandle {
  const gitOptions = { repoRoot: ctx.repoRoot, worktreesDir: ctx.worktreesDir }

  async function ensureWorktree(
    action: Extract<CoreAction, { action: "worktree.ensure" }>,
  ): Promise<CoreActionResult> {
    try {
      const { worktreePath } = createWorktree(
        gitOptions,
        action.parent,
        action.branch,
      )
      if (ctx.config.provision.install === "auto") {
        const install = installIfLockfile(worktreePath)
        if (!install.ok) {
          logger.warn(
            "Dependency install skipped or failed in {worktreePath} ({command})",
            { worktreePath, command: install.command ?? "none" },
          )
        }
      }
      await ctx.bus.emit({
        type: "worktree.created",
        runId: action.runId,
        taskId: action.taskId,
        payload: { branch: action.branch, parent: action.parent, worktreePath },
      })
      // Chain session.start: the RunDO issues worktree.ensure; once the
      // worktree exists the dispatcher boots the agent session itself
      // (the brain stays the decision-maker, the Core the executor).
      const spec = ctx.getTask?.(action.taskId, worktreePath)
      if (spec !== undefined) {
        const started = await startSession({
          action: "session.start",
          runId: action.runId,
          taskId: action.taskId,
          agent: spec.agent,
          model: spec.model,
          brief: spec.brief,
        })
        if (!started.ok) {
          logger.error(
            "session.start chained after worktree.ensure failed: {error}",
            {
              error: started.error,
            },
          )
        }
      }
      return { ok: true, worktreePath }
    } catch (err) {
      logger.error("worktree.ensure failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
  }

  async function startSession(
    action: Extract<CoreAction, { action: "session.start" }>,
  ): Promise<CoreActionResult> {
    try {
      const sessionId =
        ctx.controlPlane === undefined
          ? `mock-${action.taskId}`
          : await openSession(ctx.controlPlane, action)
      await ctx.brain.registryPut(
        `session:${action.runId}:${action.taskId}`,
        sessionId,
      )
      await ctx.bus.emit({
        type: "task.dispatched",
        runId: action.runId,
        taskId: action.taskId,
        payload: { sessionId, branch: `feat/${action.taskId}` },
      })
      return { ok: true, sessionId }
    } catch (err) {
      logger.error("session.start failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
  }

  async function abortSession(
    action: Extract<CoreAction, { action: "session.abort" }>,
  ): Promise<CoreActionResult> {
    try {
      const sessionId = await ctx.brain.registryGet(
        `session:${action.runId}:${action.taskId}`,
      )
      if (sessionId === null) {
        return { ok: false, error: "no session registered" }
      }
      if (ctx.controlPlane === undefined) {
        logger.info("session.abort (mock): {sessionId}", { sessionId })
      } else {
        try {
          await ctx.controlPlane.client.v2.session.interrupt({
            sessionID: sessionId,
          })
        } catch (err) {
          logger.warn("session.interrupt failed for {sessionId}: {error}", {
            sessionId,
            error: errorMessage(err),
          })
        }
      }
      return { ok: true }
    } catch (err) {
      logger.error("session.abort failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
  }

  async function nudgeSession(
    action: Extract<CoreAction, { action: "session.nudge" }>,
  ): Promise<CoreActionResult> {
    try {
      const sessionId = await ctx.brain.registryGet(
        `session:${action.runId}:${action.taskId}`,
      )
      if (sessionId === null) {
        logger.info("session.nudge: no session registered for {taskId}", {
          taskId: action.taskId,
        })
        return { ok: true }
      }
      if (ctx.controlPlane === undefined) {
        logger.info("session.nudge (mock): {message} -> {sessionId}", {
          message: action.message,
          sessionId,
        })
        return { ok: true }
      }
      const result = await ctx.controlPlane.client.v2.session.prompt({
        sessionID: sessionId,
        prompt: { text: action.message },
        delivery: "queue",
      })
      if (result.error !== undefined) {
        logger.warn("session.nudge prompt rejected for {sessionId}: {error}", {
          sessionId,
          error: errorMessage(result.error),
        })
      }
      return { ok: true }
    } catch (err) {
      logger.error("session.nudge failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: true }
    }
  }

  async function startReview(
    action: Extract<CoreAction, { action: "review.start" }>,
  ): Promise<CoreActionResult> {
    try {
      const worktreePath = reviewWorktreePathFor(gitOptions, action.taskId)
      ensureReviewWorktree(gitOptions, action.branch, worktreePath)
      const facts = computeReadFacts(gitOptions, action.branch, action.parent)
      const readSummary = renderReadSummary(facts, action.zone)
      let instructions = ""
      try {
        instructions = readReviewerInstructions(
          join(resolve(ctx.repoRoot), ".hamilton"),
        )
      } catch (err) {
        logger.warn(
          "review.start: reviewer instructions unavailable for {taskId}: {error}",
          { taskId: action.taskId, error: errorMessage(err) },
        )
      }
      const sessionIds: string[] = []
      const reviewers: Array<{ idx: number; role: string; sessionId: string }> =
        []
      for (const [idx, role] of action.roles.entries()) {
        // Sequential on purpose: a failing role aborts the batch fail-fast.
        // oxlint-disable-next-line no-await-in-loop
        const sessionId = await openReviewerSession(
          ctx.controlPlane,
          action,
          role,
          idx,
          worktreePath,
          instructions,
          readSummary,
        )
        sessionIds.push(sessionId)
        reviewers.push({ idx, role, sessionId })
        // oxlint-disable-next-line no-await-in-loop
        await ctx.brain.registryPut(
          `review:${action.runId}:${action.taskId}:${idx}`,
          sessionId,
        )
      }
      await ctx.bus.emit({
        type: "review.assigned",
        runId: action.runId,
        taskId: action.taskId,
        payload: { taskId: action.taskId, reviewers, worktreePath },
      })
      return {
        ok: true,
        reviewerSessionIds: sessionIds,
        reviewWorktreePath: worktreePath,
      }
    } catch (err) {
      logger.error("review.start failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
  }

  async function cleanupReview(
    action: Extract<CoreAction, { action: "review.cleanup" }>,
  ): Promise<CoreActionResult> {
    const worktreePath = reviewWorktreePathFor(gitOptions, action.taskId)
    try {
      const res = Bun.spawnSync(
        [
          "git",
          "-C",
          ctx.repoRoot,
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      if (res.exitCode !== 0) {
        logger.warn(
          "review.cleanup: worktree removal failed for {taskId}: {stderr}",
          { taskId: action.taskId, stderr: res.stderr.toString().trim() },
        )
      }
    } catch (err) {
      logger.warn(
        "review.cleanup: worktree removal threw for {taskId}: {error}",
        { taskId: action.taskId, error: errorMessage(err) },
      )
    }
    if (
      ctx.brain.registryList !== undefined &&
      ctx.brain.registryDelete !== undefined
    ) {
      try {
        const prefix = `review:${action.runId}:${action.taskId}:`
        const keys = await ctx.brain.registryList(prefix)
        for (const key of keys) {
          // oxlint-disable-next-line no-await-in-loop
          await ctx.brain.registryDelete(key)
        }
        // The brain's issued-markers for this task's gate round: a fresh
        // gate after rejection must be able to re-issue review.start.
        await ctx.brain.registryDelete(
          `issued:${action.runId}:${action.taskId}:review.start`,
        )
        await ctx.brain.registryDelete(
          `issued:${action.runId}:${action.taskId}:session.nudge`,
        )
        logger.info(
          "review.cleanup: removed {count} registry keys for {taskId}",
          { count: keys.length, taskId: action.taskId },
        )
      } catch (err) {
        logger.warn(
          "review.cleanup: registry cleanup failed for {taskId}: {error}",
          { taskId: action.taskId, error: errorMessage(err) },
        )
      }
    }
    return { ok: true }
  }

  async function executeMerge(
    action: Extract<CoreAction, { action: "merge.execute" }>,
  ): Promise<CoreActionResult> {
    try {
      const message = `merge(${action.taskId}): ${action.branch} -> ${action.parent}`
      let commit: string
      try {
        ;({ commit } = squashMerge(
          gitOptions,
          action.branch,
          action.parent,
          message,
        ))
      } catch (err) {
        // Idempotent re-merge: "nothing to merge" after a prior successful
        // squash (or an empty diff) means the parent already carries the
        // branch's changes — treat it as merged and emit task.merged, so a
        // re-issued merge.execute can never loop.
        if (errorMessage(err) !== "nothing to merge") throw err
        const head = parentHead(gitOptions, action.parent)
        await ctx.bus.emit({
          type: "task.merged",
          runId: action.runId,
          taskId: action.taskId,
          payload: { commit: head, alreadyMerged: true },
        })
        return { ok: true, mergeCommit: head }
      }
      const head = parentHead(gitOptions, action.parent)
      if (head !== commit) {
        throw new Error(
          `parent head verification failed: expected ${commit}, got ${head}`,
        )
      }
      await ctx.bus.emit({
        type: "task.merged",
        runId: action.runId,
        taskId: action.taskId,
        payload: { commit },
      })
      return { ok: true, mergeCommit: commit }
    } catch (err) {
      logger.error("merge.execute failed for {taskId}: {error}", {
        taskId: action.taskId,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
  }

  return {
    async handleAction(action) {
      switch (action.action) {
        case "worktree.ensure":
          return ensureWorktree(action)
        case "session.start":
          return startSession(action)
        case "session.abort":
          return abortSession(action)
        case "session.nudge":
          return nudgeSession(action)
        case "review.start":
          return startReview(action)
        case "review.cleanup":
          return cleanupReview(action)
        case "merge.execute":
          return executeMerge(action)
        default:
          return { ok: false, error: "unknown action" }
      }
    },
  }
}

function modelRefFrom(model: string): { id: string; providerID: string } {
  const sepIndex = Math.max(model.indexOf("/"), model.indexOf(":"))
  if (sepIndex <= 0 || sepIndex === model.length - 1) {
    return { id: model, providerID: "custom" }
  }
  return {
    id: model.slice(sepIndex + 1),
    providerID: model.slice(0, sepIndex),
  }
}

async function openSession(
  plane: ControlPlane,
  action: Extract<CoreAction, { action: "session.start" }>,
): Promise<string> {
  const model = action.model === "" ? undefined : modelRefFrom(action.model)
  const created = await plane.client.v2.session.create({
    agent: action.agent,
    ...(model === undefined ? {} : { model }),
  })
  if (created.error !== undefined) {
    throw new Error(
      `opencode session.create failed: ${errorMessage(created.error)}`,
    )
  }
  const sessionId = created.data.data.id
  const prompted = await plane.client.v2.session.prompt({
    sessionID: sessionId,
    prompt: { text: action.brief },
    delivery: "queue",
  })
  if (prompted.error !== undefined) {
    throw new Error(
      `opencode session.prompt failed: ${errorMessage(prompted.error)}`,
    )
  }
  return sessionId
}

/** The detached review worktree for a task: a sibling of the task worktrees. */
export function reviewWorktreePathFor(
  options: GitOptions,
  taskId: string,
): string {
  return join(
    resolve(options.repoRoot),
    options.worktreesDir,
    `review-${taskId}`,
  )
}

/** True when `git worktree list --porcelain` registers a worktree at path. */
function worktreeExistsAt(options: GitOptions, path: string): boolean {
  const res = Bun.spawnSync(
    ["git", "-C", options.repoRoot, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (res.exitCode !== 0) return false
  const target = canonicalPath(path)
  return res.stdout
    .toString()
    .split("\n")
    .some(
      (line) =>
        line.startsWith("worktree ") &&
        canonicalPath(line.slice("worktree ".length)) === target,
    )
}

/** Canonicalize a path (git prints /private/var for /var; resolve the link). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Provision the detached review worktree at path for branch (which must
 * exist — the task's branch). Reuses an existing worktree at that path so
 * the gate can re-run after rejections. Throws with git's stderr on failure.
 */
function ensureReviewWorktree(
  options: GitOptions,
  branch: string,
  path: string,
): void {
  if (worktreeExistsAt(options, path)) return
  const res = Bun.spawnSync(
    [
      "git",
      "-C",
      options.repoRoot,
      "worktree",
      "add",
      "--detach",
      path,
      branch,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (res.exitCode !== 0) {
    throw new Error(
      `git: failed to add review worktree for '${branch}' at '${path}': ${res.stderr.toString().trim()}`,
    )
  }
}

/** The deterministic READ facts the reviewer brief is built from. */
export interface ReadFacts {
  diffStat: string
  changedFiles: string[]
  commits: string[]
  zoneViolations: string[]
}

function gitLines(options: GitOptions, args: string[]): string[] {
  const res = Bun.spawnSync(["git", "-C", options.repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (res.exitCode !== 0) return []
  return res.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Deterministic READ: diff stat, changed files, and commit list for
 * parent...branch. Never throws — a missing branch/parent yields empty facts.
 */
export function computeReadFacts(
  gitOptions: GitOptions,
  branch: string,
  parent: string,
): ReadFacts {
  const statRes = Bun.spawnSync(
    [
      "git",
      "-C",
      gitOptions.repoRoot,
      "diff",
      "--stat",
      `${parent}...${branch}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  return {
    diffStat: statRes.exitCode === 0 ? statRes.stdout.toString().trim() : "",
    changedFiles: gitLines(gitOptions, [
      "diff",
      "--name-only",
      `${parent}...${branch}`,
    ]),
    commits: gitLines(gitOptions, ["log", "--oneline", `${parent}..${branch}`]),
    zoneViolations: [],
  }
}

/**
 * Files whose path does not start with any zone prefix (leading "./" is
 * stripped on both sides). An empty zone never flags anything.
 */
export function checkZoneCompliance(
  changedFiles: string[],
  zone: string[],
): string[] {
  if (zone.length === 0) return []
  const prefixes = zone.map((entry) => entry.replace(/^\.\//, ""))
  return changedFiles.filter((file) => {
    const path = file.replace(/^\.\//, "")
    return !prefixes.some((prefix) => path.startsWith(prefix))
  })
}

/** The deterministic READ summary fed into every reviewer brief. */
export function renderReadSummary(facts: ReadFacts, zone: string[]): string {
  const violations = checkZoneCompliance(facts.changedFiles, zone)
  const zoneList = zone.length > 0 ? zone.join(", ") : "(none)"
  const changed =
    facts.changedFiles.length > 0
      ? facts.changedFiles.map((file) => `- ${file}`).join("\n")
      : "- (none)"
  const commits =
    facts.commits.length > 0
      ? facts.commits.map((commit) => `- ${commit}`).join("\n")
      : "- (none)"
  const violationList =
    violations.length > 0
      ? violations.map((violation) => `- ${violation}`).join("\n")
      : "- none"
  return [
    "## READ (deterministic facts)",
    "",
    "### Diff stat",
    "",
    facts.diffStat === ""
      ? "(empty — branch or parent missing)"
      : facts.diffStat,
    "",
    "### Changed files",
    "",
    changed,
    "",
    "### Commits",
    "",
    commits,
    "",
    "### Zone compliance",
    "",
    `zone: ${zoneList}`,
    "",
    violationList,
  ].join("\n")
}

/** Deterministic reviewer brief: role line, instructions, context, READ, submit. */
export function buildReviewBrief(args: {
  taskId: string
  branch: string
  parent: string
  role: string
  worktreePath: string
  zone: string[]
  contract?: { inputs: string[]; outputs: string[] }
  instructions: string
  readSummary: string
}): string {
  const zoneList = args.zone.length > 0 ? args.zone.join(", ") : "(none)"
  const contractLines =
    args.contract === undefined
      ? []
      : [
          "## Task contract",
          "",
          `- inputs: ${args.contract.inputs.join("; ") || "(none)"}`,
          `- outputs: ${args.contract.outputs.join("; ") || "(none)"}`,
          "",
        ]
  return [
    `You are the ${args.role} reviewer for task ${args.taskId}`,
    "",
    args.instructions.trim(),
    "",
    "## Task context",
    "",
    `- branch: ${args.branch}`,
    `- parent: ${args.parent}`,
    `- worktree: ${args.worktreePath}`,
    `- zone: ${zoneList}`,
    "",
    ...contractLines,
    args.readSummary.trim(),
    "",
    "## Submitting your review",
    "",
    "Run the check process in the review worktree (typecheck, format:check, tests, hooks — per the project's toolchain). Write tests from the task objective if they are missing, then run them. Then call the `submit_review` MCP tool with your structured findings (`id`, `location`, `issue`, `suggested_fix`), the checks you ran, tests you wrote, and your verdict (`pass` | `fail`).",
  ].join("\n")
}

async function openReviewerSession(
  plane: ControlPlane | undefined,
  action: Extract<CoreAction, { action: "review.start" }>,
  role: string,
  idx: number,
  worktreePath: string,
  instructions: string,
  readSummary: string,
): Promise<string> {
  const brief = buildReviewBrief({
    taskId: action.taskId,
    branch: action.branch,
    parent: action.parent,
    role,
    worktreePath,
    zone: action.zone,
    ...(action.contract !== undefined ? { contract: action.contract } : {}),
    instructions,
    readSummary,
  })
  if (plane === undefined) {
    return `mock-review-${action.taskId}-${idx}`
  }
  const model =
    action.model !== undefined && action.model !== "" ? action.model : undefined
  const modelRef = model === undefined ? undefined : modelRefFrom(model)
  const created = await plane.client.v2.session.create({
    agent: "build",
    ...(modelRef === undefined ? {} : { model: modelRef }),
  })
  if (created.error !== undefined) {
    throw new Error(
      `opencode session.create failed: ${errorMessage(created.error)}`,
    )
  }
  const sessionId = created.data.data.id
  const prompted = await plane.client.v2.session.prompt({
    sessionID: sessionId,
    prompt: { text: brief },
    delivery: "queue",
  })
  if (prompted.error !== undefined) {
    throw new Error(
      `opencode session.prompt failed: ${errorMessage(prompted.error)}`,
    )
  }
  return sessionId
}

const IMPLEMENTER_TOOLS = new Set([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "write",
  "apply_patch",
  "todowrite",
])
const REVIEWER_TOOLS = new Set(["read", "glob", "grep", "list", "bash"])
const PLANNER_TOOLS = new Set(["read", "glob", "grep", "list"])

const DANGEROUS_GIT =
  /git (push|rebase|reset|checkout|switch|merge|clean|fetch)/
const REVIEWER_BASH =
  /^(git (diff|log|show|status)|(pnpm|npm|bun) (test|typecheck|format:check|lint)|grep|rg)/

export function decidePermission(
  role: string,
  tool: string,
  input: Record<string, unknown>,
): { allow: boolean; reason: string } {
  const command = typeof input["command"] === "string" ? input["command"] : ""
  if (role === "implementer") {
    if (!IMPLEMENTER_TOOLS.has(tool)) {
      return { allow: false, reason: `implementer may not use ${tool}` }
    }
    if (tool === "bash" && DANGEROUS_GIT.test(command)) {
      return { allow: false, reason: "dangerous git" }
    }
    return { allow: true, reason: "implementer permission" }
  }
  if (role === "reviewer") {
    if (!REVIEWER_TOOLS.has(tool)) {
      return { allow: false, reason: `reviewer may not use ${tool}` }
    }
    if (tool === "bash" && !REVIEWER_BASH.test(command)) {
      return { allow: false, reason: "read-only bash required" }
    }
    return { allow: true, reason: "reviewer permission" }
  }
  if (role === "planner") {
    if (tool === "bash") {
      return { allow: false, reason: "planner may not run bash" }
    }
    if (tool === "edit") {
      return { allow: false, reason: "planner may not edit" }
    }
    if (!PLANNER_TOOLS.has(tool)) {
      return { allow: false, reason: `planner may not use ${tool}` }
    }
    return { allow: true, reason: "planner permission" }
  }
  return { allow: false, reason: `unknown role: ${role}` }
}

export interface ExtractedPermissionRequest {
  sessionID: string
  requestID: string
  tool: string
  input: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function extractPermissionRequest(
  telemetryPayload: unknown,
): ExtractedPermissionRequest | null {
  if (!isRecord(telemetryPayload)) return null
  if (telemetryPayload["opencodeType"] !== "permission.v2.asked") return null
  if (!isRecord(telemetryPayload["properties"])) return null
  const fields = isRecord(telemetryPayload["properties"]["permission"])
    ? telemetryPayload["properties"]["permission"]
    : telemetryPayload["properties"]
  const sessionID = fields["sessionID"]
  const requestID = fields["id"]
  const tool = fields["action"]
  if (
    typeof sessionID !== "string" ||
    typeof requestID !== "string" ||
    typeof tool !== "string"
  ) {
    return null
  }
  const resources: string[] = []
  if (Array.isArray(fields["resources"])) {
    for (const resource of fields["resources"]) {
      if (typeof resource === "string") resources.push(resource)
    }
  }
  const input: Record<string, unknown> = {}
  if (resources.length > 0) {
    input["command"] = resources.join(" ")
  }
  input["resources"] = resources
  return { sessionID, requestID, tool, input }
}

export interface PermissionResponderContext {
  controlPlane: ControlPlane | undefined
  roleForSession?: (sessionId: string) => string | undefined
}

export function createPermissionResponder(ctx: PermissionResponderContext): {
  handleTelemetry(event: HamiltonEvent): Promise<void>
} {
  return {
    async handleTelemetry(event) {
      if (event.type !== "telemetry.opencode") return
      const request = extractPermissionRequest(event.payload)
      if (request === null) return
      const role = ctx.roleForSession?.(request.sessionID) ?? "implementer"
      const decision = decidePermission(role, request.tool, request.input)
      const plane = ctx.controlPlane
      if (plane === undefined) {
        logger.info(
          "Permission {verdict} for {role} tool {tool} on session {sessionID} (mock)",
          {
            verdict: decision.allow ? "allow" : "deny",
            role,
            tool: request.tool,
            sessionID: request.sessionID,
          },
        )
        return
      }
      try {
        const result = await plane.client.v2.session.permission.reply({
          sessionID: request.sessionID,
          requestID: request.requestID,
          reply: decision.allow ? "once" : "reject",
          ...(decision.allow ? {} : { message: decision.reason }),
        })
        if (result.error !== undefined) {
          logger.warn(
            "Permission reply rejected by server for {requestID}: {error}",
            {
              requestID: request.requestID,
              error: errorMessage(result.error),
            },
          )
        }
      } catch (err) {
        logger.error("Permission reply failed for {requestID}: {error}", {
          requestID: request.requestID,
          error: errorMessage(err),
        })
      }
    },
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
