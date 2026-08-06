import { getLogger } from "@logtape/logtape"
import type {
  CoreAction,
  CoreActionResult,
  HamiltonConfig,
  HamiltonEvent,
} from "@hamilton/shared"
import type { BusHandle } from "./eventbus.ts"
import {
  createWorktree,
  installIfLockfile,
  parentHead,
  squashMerge,
} from "./git.ts"
import type { ControlPlane } from "./opencode.ts"
import type { BrainHandle } from "./runtime.ts"

const logger = getLogger(["hamilton", "core", "dispatch"])

export interface DispatcherBrain extends BrainHandle {
  registryGet(key: string): Promise<string | null>
  registryPut(key: string, value: string): Promise<void>
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

  async function executeMerge(
    action: Extract<CoreAction, { action: "merge.execute" }>,
  ): Promise<CoreActionResult> {
    try {
      const message = `merge(${action.taskId}): ${action.branch} -> ${action.parent}`
      const { commit } = squashMerge(
        gitOptions,
        action.branch,
        action.parent,
        message,
      )
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
