// M2: conductor-owned worktree watcher — event-based git status with
// delta-only emission. Watches tracked branch worktrees, debounces fs.watch
// bursts, and sweeps periodically as a backstop for missed events.

import { watch } from "node:fs"
import type { FSWatcher } from "node:fs"
import { getLogger } from "@logtape/logtape"
import type { Drift, GitOptions } from "./git.ts"
import { commitDelta, drift, worktreePathFor } from "./git.ts"

const logger = getLogger(["hamilton", "core", "worktrees"])

export interface WorktreeStatusEvent {
  type: "worktree.status_changed"
  branch: string
  parent: string
  ahead: number
  behind: number
  dirtyCount: number
  unpushedCount: number
  commitCount: number
  commitDelta: number
  changedPaths: string[]
  merged: boolean
  worktreePath: string | null
  ts: string
}

export interface WorktreeWatcherOptions {
  options: GitOptions
  sweepIntervalMs?: number
  debounceMs?: number
  now?: () => number
}

export interface WorktreeWatcherHandle {
  start(): void
  stop(): void
  trackBranch(branch: string, parent: string): void
  untrackBranch(branch: string): void
  sweepOnce(): Promise<void>
  trackedBranches(): Array<{ branch: string; parent: string }>
}

interface TrackedBranch {
  parent: string
  last: Drift | null
  watcher: FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
}

function driftsEqual(prev: Drift, next: Drift): boolean {
  if (
    prev.ahead !== next.ahead ||
    prev.behind !== next.behind ||
    prev.unpushed !== next.unpushed ||
    prev.dirtyCount !== next.dirtyCount ||
    prev.commitCount !== next.commitCount ||
    prev.merged !== next.merged ||
    prev.exists !== next.exists ||
    prev.worktreePath !== next.worktreePath ||
    prev.changedPaths.length !== next.changedPaths.length
  ) {
    return false
  }
  return prev.changedPaths.every((path, i) => path === next.changedPaths[i])
}

function detachWatcher(state: TrackedBranch): void {
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  if (state.watcher !== null) {
    try {
      state.watcher.close()
    } catch {
      // already closed
    }
    state.watcher = null
  }
}

function toEvent(
  prev: Drift | null,
  next: Drift,
  ts: string,
): WorktreeStatusEvent {
  return {
    type: "worktree.status_changed",
    branch: next.branch,
    parent: next.parent,
    ahead: next.ahead,
    behind: next.behind,
    dirtyCount: next.dirtyCount,
    unpushedCount: next.unpushed,
    commitCount: next.commitCount,
    commitDelta: prev === null ? 0 : commitDelta(prev, next),
    changedPaths: next.changedPaths,
    merged: next.merged,
    worktreePath: next.worktreePath,
    ts,
  }
}

export function createWorktreeWatcher(
  options: WorktreeWatcherOptions,
  emit: (event: WorktreeStatusEvent) => void,
): WorktreeWatcherHandle {
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000
  const debounceMs = options.debounceMs ?? 500
  const now = options.now ?? Date.now
  const tracked = new Map<string, TrackedBranch>()
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let running = false

  function stamp(): string {
    return new Date(now()).toISOString()
  }

  function attachWatcher(branch: string, state: TrackedBranch): void {
    if (state.watcher !== null) return
    let watcher: FSWatcher
    try {
      watcher = watch(
        worktreePathFor(options.options, branch),
        { recursive: true },
        () => {
          try {
            if (tracked.get(branch) !== state) return
            if (state.debounceTimer !== null) {
              clearTimeout(state.debounceTimer)
            }
            state.debounceTimer = setTimeout(() => {
              state.debounceTimer = null
              if (tracked.get(branch) === state) {
                void sweepOnce()
              }
            }, debounceMs)
          } catch (err) {
            logger.warn("worktree watch callback failed", {
              branch,
              err: String(err),
            })
          }
        },
      )
    } catch (err) {
      logger.warn("worktree dir not watchable; falling back to sweep-only", {
        branch,
        err: String(err),
      })
      return
    }
    watcher.on("error", (err) => {
      logger.warn("worktree watcher error; falling back to sweep-only", {
        branch,
        err: String(err),
      })
      try {
        watcher.close()
      } catch {
        // already closed
      }
      if (state.watcher === watcher) state.watcher = null
    })
    state.watcher = watcher
  }

  async function sweepOnce(): Promise<void> {
    for (const [branch, state] of tracked) {
      let next: Drift
      try {
        next = drift(options.options, branch, state.parent)
      } catch (err) {
        logger.warn("drift failed; skipping branch", {
          branch,
          err: String(err),
        })
        continue
      }
      const prev = state.last
      if (prev !== null && driftsEqual(prev, next)) continue
      state.last = next
      emit(toEvent(prev, next, stamp()))
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      sweepTimer = setInterval(() => {
        void sweepOnce()
      }, sweepIntervalMs)
    },
    stop(): void {
      running = false
      if (sweepTimer !== null) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      for (const state of tracked.values()) {
        detachWatcher(state)
      }
      tracked.clear()
    },
    trackBranch(branch: string, parent: string): void {
      let state = tracked.get(branch)
      if (state !== undefined) {
        detachWatcher(state)
        state.parent = parent
      } else {
        state = { parent, last: null, watcher: null, debounceTimer: null }
        tracked.set(branch, state)
      }
      state.last = drift(options.options, branch, parent)
      emit(toEvent(null, state.last, stamp()))
      attachWatcher(branch, state)
    },
    untrackBranch(branch: string): void {
      const state = tracked.get(branch)
      if (state === undefined) return
      detachWatcher(state)
      tracked.delete(branch)
    },
    sweepOnce,
    trackedBranches(): Array<{ branch: string; parent: string }> {
      return [...tracked.entries()].map(([branch, state]) => ({
        branch,
        parent: state.parent,
      }))
    },
  }
}
