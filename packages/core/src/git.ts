import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

export interface Drift {
  branch: string
  parent: string
  ahead: number
  behind: number
  unpushed: number
  dirtyCount: number
  commitCount: number
  changedPaths: string[]
  merged: boolean
  exists: boolean
  worktreePath: string | null
}

export interface GitOptions {
  repoRoot: string
  worktreesDir: string
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface WorktreeEntry {
  path: string
  branch: string | null
}

const NOT_A_GIT_REPO = /not a git repository/i

function gitRun(cwd: string, args: string[]): GitResult {
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

function assertRepo(options: GitOptions, res: GitResult): void {
  if (res.exitCode !== 0 && NOT_A_GIT_REPO.test(res.stderr)) {
    throw new Error(`git: not a git repository: ${options.repoRoot}`)
  }
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0)
}

function countOf(res: GitResult): number {
  if (res.exitCode !== 0) return 0
  const value = Number(res.stdout)
  return Number.isFinite(value) ? value : 0
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/^feat\//, "").replace(/[^a-zA-Z0-9._-]/g, "")
}

function worktreeList(options: GitOptions): WorktreeEntry[] {
  const res = gitRun(options.repoRoot, ["worktree", "list", "--porcelain"])
  if (res.exitCode !== 0) return []
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of res.stdout.split("\n")) {
    if (line === "") {
      if (current !== null) {
        entries.push(current)
        current = null
      }
    } else if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null }
    } else if (line.startsWith("branch ") && current !== null) {
      current.branch = line.slice("branch ".length)
    }
  }
  if (current !== null) entries.push(current)
  return entries
}

function worktreePathForBranch(
  options: GitOptions,
  branch: string,
): string | null {
  const target = `refs/heads/${branch}`
  for (const entry of worktreeList(options)) {
    if (entry.branch === target) return entry.path
  }
  return null
}

export function worktreePathFor(options: GitOptions, branch: string): string {
  return join(
    resolve(options.repoRoot),
    options.worktreesDir,
    sanitizeBranch(branch),
  )
}

export function createWorktree(
  options: GitOptions,
  parent: string,
  branch: string,
): { worktreePath: string } {
  const parentRes = gitRun(options.repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${parent}`,
  ])
  assertRepo(options, parentRes)
  if (parentRes.exitCode !== 0) {
    throw new Error(`git: parent branch '${parent}' does not exist`)
  }

  const branchRes = gitRun(options.repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ])
  if (branchRes.exitCode !== 0) {
    const createRes = gitRun(options.repoRoot, ["branch", branch, parent])
    if (createRes.exitCode !== 0) {
      throw new Error(
        `git: failed to create branch '${branch}' from '${parent}': ${createRes.stderr}`,
      )
    }
  }

  const worktreePath = worktreePathFor(options, branch)
  if (worktreePathForBranch(options, branch) === null) {
    const addRes = gitRun(options.repoRoot, [
      "worktree",
      "add",
      worktreePath,
      branch,
    ])
    if (addRes.exitCode !== 0) {
      throw new Error(
        `git: failed to add worktree for '${branch}' at '${worktreePath}': ${addRes.stderr}`,
      )
    }
  }

  const checkoutRes = gitRun(worktreePath, ["checkout", branch])
  if (checkoutRes.exitCode !== 0) {
    throw new Error(
      `git: failed to checkout '${branch}' in worktree at '${worktreePath}': ${checkoutRes.stderr}`,
    )
  }

  return { worktreePath }
}

export function installIfLockfile(worktreePath: string): {
  command: string | null
  ok: boolean
} {
  let command: string | null = null
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
    command = "pnpm install --frozen-lockfile"
  } else if (existsSync(join(worktreePath, "package-lock.json"))) {
    command = "npm ci"
  } else if (existsSync(join(worktreePath, "bun.lockb"))) {
    command = "bun install"
  } else if (existsSync(join(worktreePath, "yarn.lock"))) {
    command = "yarn install --frozen-lockfile"
  }
  if (command === null) return { command: null, ok: false }
  try {
    const res = Bun.spawnSync(command.split(" "), {
      cwd: worktreePath,
      stdout: "ignore",
      stderr: "ignore",
    })
    return { command, ok: res.exitCode === 0 }
  } catch {
    return { command, ok: false }
  }
}

function isMerged(
  options: GitOptions,
  branch: string,
  parent: string,
  ahead: number,
  tipsEqual: boolean,
): boolean {
  if (branch === parent) return true
  const ancestorRes = gitRun(options.repoRoot, [
    "merge-base",
    "--is-ancestor",
    branch,
    parent,
  ])
  if (ancestorRes.exitCode === 0) return !tipsEqual
  if (ancestorRes.exitCode !== 1) {
    const mergedRes = gitRun(options.repoRoot, ["branch", "--merged", parent])
    if (
      mergedRes.exitCode === 0 &&
      nonEmptyLines(mergedRes.stdout).some(
        (line) => line.trim().replace(/^\*\s*/, "") === branch,
      )
    ) {
      return !tipsEqual
    }
  }
  const treeRes = gitRun(options.repoRoot, ["diff", "--quiet", branch, parent])
  return treeRes.exitCode === 0 && ahead > 0
}

export function drift(
  options: GitOptions,
  branch: string,
  parent: string,
): Drift {
  const existsRes = gitRun(options.repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ])
  assertRepo(options, existsRes)
  const exists = existsRes.exitCode === 0

  if (!exists) {
    return {
      branch,
      parent,
      ahead: 0,
      behind: 0,
      unpushed: 0,
      dirtyCount: 0,
      commitCount: 0,
      changedPaths: [],
      merged: false,
      exists: false,
      worktreePath: null,
    }
  }

  const worktreePath = worktreePathForBranch(options, branch)
  const ahead = countOf(
    gitRun(options.repoRoot, ["rev-list", "--count", `${parent}..${branch}`]),
  )
  const behind = countOf(
    gitRun(options.repoRoot, ["rev-list", "--count", `${branch}..${parent}`]),
  )
  const unpushed = countOf(
    gitRun(options.repoRoot, [
      "rev-list",
      "--count",
      `origin/${parent}..${branch}`,
    ]),
  )
  const commitCount = countOf(
    gitRun(options.repoRoot, ["rev-list", "--count", branch, "--not", parent]),
  )

  const statusCwd = worktreePath ?? options.repoRoot
  const statusRes = gitRun(statusCwd, ["status", "--porcelain"])
  const statusLines =
    statusRes.exitCode === 0 ? nonEmptyLines(statusRes.stdout) : []
  const dirtyCount = statusLines.length
  const workingTreePaths = statusLines.map((line) => line.slice(3))

  const diffRes = gitRun(options.repoRoot, [
    "diff",
    "--name-only",
    `${parent}...${branch}`,
  ])
  const diffPaths = diffRes.exitCode === 0 ? nonEmptyLines(diffRes.stdout) : []
  const changedPaths = [...new Set([...diffPaths, ...workingTreePaths])]

  const headsRes = gitRun(options.repoRoot, ["rev-parse", branch, parent])
  const tipsEqual =
    headsRes.exitCode === 0 &&
    new Set(nonEmptyLines(headsRes.stdout)).size === 1

  return {
    branch,
    parent,
    ahead,
    behind,
    unpushed,
    dirtyCount,
    commitCount,
    changedPaths,
    merged: isMerged(options, branch, parent, ahead, tipsEqual),
    exists,
    worktreePath,
  }
}

export function commitDelta(prev: Drift, next: Drift): number {
  return next.commitCount - prev.commitCount
}

export function squashMerge(
  options: GitOptions,
  branch: string,
  parent: string,
  message: string,
): { commit: string } {
  const aheadRes = gitRun(options.repoRoot, [
    "rev-list",
    "--count",
    `${parent}..${branch}`,
  ])
  assertRepo(options, aheadRes)
  if (aheadRes.exitCode !== 0 || countOf(aheadRes) === 0) {
    throw new Error("nothing to merge")
  }
  // Squash commits are not ancestors: after a squash, `parent..branch` still
  // counts the branch's commits, so a re-issued merge would stage nothing and
  // fail at commit. Detect "changes already in the parent" via the two-dot
  // diff — empty means the merge is effectively done.
  const alreadyRes = gitRun(options.repoRoot, [
    "diff",
    "--quiet",
    parent,
    branch,
  ])
  if (alreadyRes.exitCode === 0) {
    throw new Error("nothing to merge")
  }

  const mergeDir = worktreePathForBranch(options, parent) ?? options.repoRoot
  const mergeRes = gitRun(mergeDir, ["merge", "--squash", branch])
  if (mergeRes.exitCode !== 0) {
    throw new Error(
      `git: squash merge of '${branch}' into '${parent}' failed: ${mergeRes.stderr}`,
    )
  }

  const commitRes = gitRun(mergeDir, ["commit", "-m", message])
  if (commitRes.exitCode !== 0) {
    throw new Error(`git: commit of squash merge failed: ${commitRes.stderr}`)
  }

  const remoteRes = gitRun(mergeDir, ["remote", "get-url", "origin"])
  if (remoteRes.exitCode === 0) {
    const pushRes = gitRun(mergeDir, ["push", "origin", parent])
    if (pushRes.exitCode !== 0) {
      throw new Error(
        `git: push of '${parent}' to origin failed: ${pushRes.stderr}`,
      )
    }
  }

  const headRes = gitRun(mergeDir, ["rev-parse", "HEAD"])
  if (headRes.exitCode !== 0) {
    throw new Error(`git: rev-parse HEAD failed: ${headRes.stderr}`)
  }
  return { commit: headRes.stdout }
}

export function parentHead(options: GitOptions, parent: string): string {
  const res = gitRun(options.repoRoot, ["rev-parse", parent])
  assertRepo(options, res)
  if (res.exitCode !== 0) {
    throw new Error(`git: parent branch '${parent}' not found: ${res.stderr}`)
  }
  return res.stdout
}

export function removeWorktree(options: GitOptions, branch: string): void {
  const registered = worktreePathForBranch(options, branch)
  gitRun(options.repoRoot, [
    "worktree",
    "remove",
    "--force",
    registered ?? worktreePathFor(options, branch),
  ])
  gitRun(options.repoRoot, ["branch", "-D", branch])
}
