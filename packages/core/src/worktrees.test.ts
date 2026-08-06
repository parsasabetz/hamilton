import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitOptions } from "./git.ts"
import { createWorktree } from "./git.ts"
import type { WorktreeStatusEvent, WorktreeWatcherHandle } from "./worktrees.ts"
import { createWorktreeWatcher } from "./worktrees.ts"

const cleanup: string[] = []
const watchers: WorktreeWatcherHandle[] = []

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop()
  }
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

function run(args: string[], cwd: string): GitResult {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString().trim(),
    stderr: res.stderr.toString().trim(),
  }
}

function makeRepo(): { options: GitOptions; repo: string } {
  const repo = mkdtempSync(join(tmpdir(), "hamilton-worktrees-"))
  cleanup.push(repo)
  run(["init", "-b", "main"], repo)
  run(["config", "user.email", "test@example.com"], repo)
  run(["config", "user.name", "Hamilton Test"], repo)
  writeFileSync(join(repo, "a.txt"), "a\n")
  run(["add", "a.txt"], repo)
  run(["commit", "-m", "a"], repo)
  run(["checkout", "-b", "parent"], repo)
  writeFileSync(join(repo, "b.txt"), "b\n")
  run(["add", "b.txt"], repo)
  run(["commit", "-m", "b"], repo)
  return { options: { repoRoot: repo, worktreesDir: ".worktrees" }, repo }
}

function commitIn(repoDir: string, file: string, message: string): void {
  writeFileSync(join(repoDir, file), `${file}\n`)
  run(["add", file], repoDir)
  run(["commit", "-m", message], repoDir)
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

function eventAt(
  events: WorktreeStatusEvent[],
  index: number,
): WorktreeStatusEvent {
  const event = events[index]
  if (event === undefined) {
    throw new Error(`expected event at index ${index}, got ${events.length}`)
  }
  return event
}

describe("createWorktreeWatcher", () => {
  test("trackBranch emits the baseline status event with the worktree path", async () => {
    const { options } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher({ options }, (event) =>
      events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)

    const baseline = eventAt(events, 0)
    expect(baseline).toMatchObject({
      type: "worktree.status_changed",
      branch: "feat/t1",
      parent: "parent",
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      unpushedCount: 0,
      commitCount: 0,
      commitDelta: 0,
      changedPaths: [],
      merged: false,
    })
    expect(baseline.worktreePath).not.toBeNull()
    expect(baseline.worktreePath).toContain(worktreePath)
    expect(baseline.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("a new commit in the worktree emits commitDelta 1", async () => {
    const { options } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher({ options }, (event) =>
      events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)

    commitIn(worktreePath, "c.txt", "worktree commit")
    await watcher.sweepOnce()
    await waitFor(() => events.length === 2)

    const updated = eventAt(events, 1)
    expect(updated.commitDelta).toBe(1)
    expect(updated.ahead).toBe(1)
    expect(updated.commitCount).toBe(1)
    expect(updated.changedPaths).toContain("c.txt")
  })

  test("a no-change sweep emits nothing", async () => {
    const { options } = makeRepo()
    createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher({ options }, (event) =>
      events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)

    await watcher.sweepOnce()
    await watcher.sweepOnce()

    expect(events.filter((event) => event.branch === "feat/t1").length).toBe(1)
  })

  test("a dirty working tree emits dirtyCount 1 with commitDelta 0", async () => {
    const { options } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher({ options }, (event) =>
      events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)

    writeFileSync(join(worktreePath, "c.txt"), "modified\n")
    await watcher.sweepOnce()
    await waitFor(() => events.length === 2)

    const dirty = eventAt(events, 1)
    expect(dirty.dirtyCount).toBe(1)
    expect(dirty.commitDelta).toBe(0)
  })

  test("untrackBranch stops emission", async () => {
    const { options } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher({ options }, (event) =>
      events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)

    watcher.untrackBranch("feat/t1")
    writeFileSync(join(worktreePath, "c.txt"), "modified\n")
    await watcher.sweepOnce()

    expect(events.length).toBe(1)
  })

  test("trackedBranches reflects track and untrack", () => {
    const { options } = makeRepo()
    createWorktree(options, "parent", "feat/t1")
    const watcher = createWorktreeWatcher({ options }, () => {})
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    expect(watcher.trackedBranches()).toEqual([
      { branch: "feat/t1", parent: "parent" },
    ])

    watcher.trackBranch("feat/t2", "main")
    expect(watcher.trackedBranches()).toEqual([
      { branch: "feat/t1", parent: "parent" },
      { branch: "feat/t2", parent: "main" },
    ])

    watcher.untrackBranch("feat/t1")
    expect(watcher.trackedBranches()).toEqual([
      { branch: "feat/t2", parent: "main" },
    ])
  })

  test("fs.watch events debounce into a sweep", async () => {
    const { options } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/t1")
    const events: WorktreeStatusEvent[] = []
    const watcher = createWorktreeWatcher(
      { options, debounceMs: 50, sweepIntervalMs: 60_000 },
      (event) => events.push(event),
    )
    watchers.push(watcher)

    watcher.trackBranch("feat/t1", "parent")
    await waitFor(() => events.length === 1)
    await Bun.sleep(200)

    writeFileSync(join(worktreePath, "c.txt"), "new\n")
    await waitFor(() => events.length === 2, 6000)

    const dirty = eventAt(events, 1)
    expect(dirty.dirtyCount).toBe(1)
  })
})
