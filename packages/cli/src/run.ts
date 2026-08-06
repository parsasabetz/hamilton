// `hamilton run` — autonomous execution (M2): decompose a prompt (or load a
// JSON plan), write the graph.yaml projection, boot the core, seed the run,
// and watch it to a terminal state. The CLI reporter polls the projection
// endpoint — the orchestration itself is event-driven.

import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  createControlPlane,
  decomposeWithOpencode,
  loadConfigFile,
  planFromFile,
  planFromPrompt,
  renderBrief,
  renderGraphYaml,
  startCore,
} from "@hamilton/core"
import type { Decomposer, TaskGraph } from "@hamilton/core"

const DEFAULT_PORT = 8787
const POLL_INTERVAL_MS = 2000
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_PARENT_BRANCH = "main"
const PROJECTION_DIR = ".hamilton"

// Active-but-unfinished statuses: the task was dispatched and no longer
// counts as "planned", but it is not merged yet.
const IN_PROGRESS_STATUSES = new Set([
  "in-progress",
  "ready-for-review",
  "reviewing",
  "approved",
])

export interface RunOptions {
  /** When set, the prompt is decomposed against the control plane. */
  prompt?: string
  /** JSON plan path (mutually exclusive with prompt). */
  planFile?: string
  /** Project root (default process.cwd()). */
  repoRoot?: string
  /** Core HTTP port (default 8787). */
  port?: number
  /** Run id stamped on events (default `run-<timestamp>`). */
  runId?: string
  /** Overrides hamilton.config.ts mergeAuthority for this run. */
  mergeAuthority?: "autonomous" | "owner-gated"
  /** baseUrl of a running `opencode serve`, used for decomposition
   *  (env HAMILTON_OPCODE_URL default). */
  opencodeUrl?: string
}

export interface RunResult {
  runId: string
  report: string
  exitCode: number
  graph: TaskGraph
}

export interface RunTaskState {
  id: string
  status: string
  role: string
  branch?: string
}

/** The slice of the run snapshot the CLI reporter renders. */
export interface RunSnapshotView {
  runId: string
  phase: string
  seq: number
  tasks: RunTaskState[]
}

/** Deterministic human report: per task `id [status] (role) branch`, plus the
 *  run phase and a summary line. Tasks render in id order. */
export function buildReport(snapshot: RunSnapshotView): string {
  const lines = [
    `run ${snapshot.runId} — phase ${snapshot.phase} (seq ${snapshot.seq})`,
  ]
  const tasks = [...snapshot.tasks].toSorted((a, b) => a.id.localeCompare(b.id))
  for (const task of tasks) {
    let line = `  ${task.id} [${task.status}]`
    if (task.role !== "") line += ` (${task.role})`
    if (task.branch !== undefined) line += ` ${task.branch}`
    lines.push(line)
  }
  const merged = tasks.filter((task) => task.status === "merged").length
  const inProgress = tasks.filter((task) =>
    IN_PROGRESS_STATUSES.has(task.status),
  ).length
  const pending = tasks.length - merged - inProgress
  lines.push(
    `${merged} merged, ${inProgress} in-progress, ${pending} blocked/planned`,
  )
  return `${lines.join("\n")}\n`
}

/** 0 when the run finished or every task merged; 1 otherwise (stopping,
 *  failures, or work still pending). */
export function finalExitCode(snapshot: RunSnapshotView): number {
  const allMerged =
    snapshot.tasks.length > 0 &&
    snapshot.tasks.every((task) => task.status === "merged")
  if (snapshot.phase === "finished" || allMerged) return 0
  return 1
}

/** Projection path the run renders its graph to. */
export function graphFilePath(repoRoot: string): string {
  return join(repoRoot, PROJECTION_DIR, "graph.yaml")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeSnapshot(value: Record<string, unknown>): RunSnapshotView {
  const tasks: RunTaskState[] = []
  const rawTasks = value["tasks"]
  if (Array.isArray(rawTasks)) {
    for (const raw of rawTasks) {
      if (!isRecord(raw) || typeof raw["id"] !== "string") continue
      const task: RunTaskState = {
        id: raw["id"],
        status: typeof raw["status"] === "string" ? raw["status"] : "planned",
        role: typeof raw["role"] === "string" ? raw["role"] : "",
      }
      if (typeof raw["branch"] === "string") task.branch = raw["branch"]
      tasks.push(task)
    }
  }
  return {
    runId: typeof value["runId"] === "string" ? value["runId"] : "",
    phase: typeof value["phase"] === "string" ? value["phase"] : "planned",
    seq: typeof value["seq"] === "number" ? value["seq"] : 0,
    tasks,
  }
}

/** Terminal for the watcher: run stopped/finished/failed, or every task
 *  settled (merged or blocked). */
function isTerminal(snapshot: RunSnapshotView): boolean {
  if (
    snapshot.phase === "finished" ||
    snapshot.phase === "stopping" ||
    snapshot.phase === "failed"
  ) {
    return true
  }
  return (
    snapshot.tasks.length > 0 &&
    snapshot.tasks.every(
      (task) => task.status === "merged" || task.status === "blocked",
    )
  )
}

async function fetchSnapshot(
  url: string,
  runId: string,
): Promise<RunSnapshotView | null> {
  try {
    const response = await fetch(
      `${url}/api/state?run=${encodeURIComponent(runId)}`,
    )
    if (!response.ok) return null
    const body = (await response.json()) as { snapshot?: unknown }
    return isRecord(body.snapshot) ? normalizeSnapshot(body.snapshot) : null
  } catch {
    return null
  }
}

function runTimeoutMs(): number {
  const raw = process.env.HAMILTON_RUN_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_RUN_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TIMEOUT_MS
}

async function waitForTerminalState(
  url: string,
  runId: string,
): Promise<RunSnapshotView> {
  const timeoutMs = runTimeoutMs()
  const deadline = Date.now() + timeoutMs
  // oxlint-disable no-await-in-loop -- deliberate poll loop
  for (;;) {
    const snapshot = await fetchSnapshot(url, runId)
    if (snapshot !== null && isTerminal(snapshot)) return snapshot
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} did not reach a terminal state within ${timeoutMs}ms`,
      )
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  // oxlint-enable no-await-in-loop
}

async function buildGraph(
  options: RunOptions,
  repoRoot: string,
): Promise<TaskGraph> {
  if (options.planFile !== undefined) return planFromFile(options.planFile)
  if (options.prompt !== undefined) {
    try {
      const baseUrl = options.opencodeUrl ?? process.env.HAMILTON_OPCODE_URL
      const controlPlane = createControlPlane(
        baseUrl !== undefined ? { baseUrl } : {},
      )
      const decomposer: Decomposer = decomposeWithOpencode(
        controlPlane,
        basename(repoRoot),
      )
      return planFromPrompt(options.prompt, decomposer)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `decomposition failed (${detail}). ` +
          "Start the opencode control plane with `hamilton start` for plan " +
          "mode, or pass --plan with a JSON plan file.",
        { cause: error },
      )
    }
  }
  throw new Error("run requires a prompt or --plan")
}

export async function runHamilton(options: RunOptions): Promise<RunResult> {
  const repoRoot = options.repoRoot ?? process.cwd()
  const runId = options.runId ?? `run-${Date.now()}`
  const port = options.port ?? DEFAULT_PORT

  const loaded = await loadConfigFile(repoRoot)
  const config =
    options.mergeAuthority !== undefined
      ? { ...loaded.config, mergeAuthority: options.mergeAuthority }
      : loaded.config

  const graph = await buildGraph(options, repoRoot)

  const projection = graphFilePath(repoRoot)
  await mkdir(join(repoRoot, PROJECTION_DIR), { recursive: true })
  await writeFile(projection, renderGraphYaml(graph), "utf8")
  console.log(`graph projection: ${projection}`)

  const handle = await startCore({
    port,
    runId,
    config,
    repoRoot,
    getTask: (taskId, worktreePath) => {
      const task = graph.tasks.find((candidate) => candidate.id === taskId)
      if (task === undefined) return undefined
      return {
        agent: task.role,
        model: task.model,
        brief: renderBrief(task, {
          repoRoot,
          parent: process.env.HAMILTON_PARENT_BRANCH ?? DEFAULT_PARENT_BRANCH,
          worktreePath: worktreePath ?? "TBD",
        }),
      }
    },
  })
  try {
    const parent = process.env.HAMILTON_PARENT_BRANCH ?? DEFAULT_PARENT_BRANCH
    await handle.emit({
      type: "run.planned",
      runId,
      payload: { tasks: graph.tasks, parent },
    })
    console.log(
      `run ${runId} seeded (parent ${parent}); watching ` +
        `${handle.url}/api/state?run=${runId}`,
    )
    const snapshot = await waitForTerminalState(handle.url, runId)
    const report = buildReport(snapshot)
    return { runId, report, exitCode: finalExitCode(snapshot), graph }
  } finally {
    await handle.stop()
  }
}
