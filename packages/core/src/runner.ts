// Run runner — the conductor-triggered run path, shared by the CLI and the
// MCP start_run tool. startRunOn seeds a planned run onto an already-running
// core; parsePlanJson validates + normalizes plan JSON. Callers own the
// graph.yaml projection write and any post-run teardown.

import { getLogger } from "@logtape/logtape"
import type { TaskGraph } from "@hamilton/shared"

import type { CoreHandle } from "./index.ts"
import { normalizeGraph, validateGraph } from "./planner.ts"

const logger = getLogger(["hamilton", "core", "runner"])

export interface StartRunOptions {
  runId: string
  graph: TaskGraph
  parent: string
  mergeAuthority?: "autonomous" | "owner-gated"
}

/** Seed a planned run on an already-running core (run.planned + a log line).
 *  The core stays up; the caller owns the projection and teardown. */
export async function startRunOn(
  handle: CoreHandle,
  options: StartRunOptions,
): Promise<void> {
  logger.info("Seeding run {runId} (parent {parent}, merge {mergeAuthority})", {
    runId: options.runId,
    parent: options.parent,
    mergeAuthority: options.mergeAuthority ?? "owner-gated",
  })
  await handle.emit({
    type: "run.planned",
    runId: options.runId,
    payload: { tasks: options.graph.tasks, parent: options.parent },
  })
}

/** Validate + normalize plan JSON into a TaskGraph. Throws with the first
 *  five validation issues when the plan is invalid. */
export function parsePlanJson(json: string): TaskGraph {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid plan JSON: ${detail}`, { cause: error })
  }
  const result = validateGraph(raw)
  if (!result.ok) {
    const shown = result.issues.slice(0, 5)
    const rest = result.issues.length - shown.length
    const suffix = rest > 0 ? ` (+${rest} more)` : ""
    throw new Error(`plan failed validation: ${shown.join("; ")}${suffix}`)
  }
  return normalizeGraph(result.graph)
}
