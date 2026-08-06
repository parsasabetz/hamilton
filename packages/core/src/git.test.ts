import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitOptions } from "./git.ts"
import {
  commitDelta,
  createWorktree,
  drift,
  installIfLockfile,
  parentHead,
  removeWorktree,
  squashMerge,
  worktreePathFor,
} from "./git.ts"

const cleanup: string[] = []

afterEach(() => {
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
  const repo = mkdtempSync(join(tmpdir(), "hamilton-git-"))
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

function worktreePaths(repo: string): string[] {
  const porcelain = run(["worktree", "list", "--porcelain"], repo).stdout
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

describe("worktreePathFor", () => {
  test("sanitizes a feat/ branch prefix and invalid characters", () => {
    const options: GitOptions = {
      repoRoot: "/repo",
      worktreesDir: ".worktrees",
    }
    expect(worktreePathFor(options, "feat/x-y")).toBe(
      join("/repo", ".worktrees", "x-y"),
    )
    expect(worktreePathFor(options, "feat/foo bar!")).toBe(
      join("/repo", ".worktrees", "foobar"),
    )
  })
})

describe("createWorktree", () => {
  test("creates the branch and registers a worktree at the sanitized path", () => {
    const { options, repo } = makeRepo()
    const { worktreePath } = createWorktree(options, "parent", "feat/w1")

    expect(
      run(["rev-parse", "--verify", "--quiet", "refs/heads/feat/w1"], repo)
        .exitCode,
    ).toBe(0)
    const expected = realpathSync(worktreePathFor(options, "feat/w1"))
    expect(worktreePaths(repo).map((path) => realpathSync(path))).toContain(
      expected,
    )
    expect(worktreePath).toBe(worktreePathFor(options, "feat/w1"))
    expect(run(["branch", "--show-current"], worktreePath).stdout).toBe(
      "feat/w1",
    )

    const again = createWorktree(options, "parent", "feat/w1")
    expect(again.worktreePath).toBe(worktreePath)
  })

  test("throws when the parent branch does not exist", () => {
    const { options } = makeRepo()
    expect(() => createWorktree(options, "missing-parent", "feat/w2")).toThrow(
      /does not exist/,
    )
  })
})

describe("drift", () => {
  test("a fresh branch reports zeros with exists true", () => {
    const { options, repo } = makeRepo()
    run(["branch", "feat/fresh", "parent"], repo)
    expect(drift(options, "feat/fresh", "parent")).toEqual({
      branch: "feat/fresh",
      parent: "parent",
      ahead: 0,
      behind: 0,
      unpushed: 0,
      dirtyCount: 0,
      commitCount: 0,
      changedPaths: [],
      merged: false,
      exists: true,
      worktreePath: null,
    })
  })

  test("a missing branch reports zeros with exists false", () => {
    const { options } = makeRepo()
    const d = drift(options, "ghost", "parent")
    expect(d.exists).toBe(false)
    expect(d.merged).toBe(false)
    expect(d.ahead).toBe(0)
    expect(d.worktreePath).toBeNull()
  })

  test("merged is true when branch equals parent", () => {
    const { options } = makeRepo()
    expect(drift(options, "parent", "parent").merged).toBe(true)
  })

  test("measures commits and working-tree state of a worktree branch", () => {
    const { options } = makeRepo()
    createWorktree(options, "parent", "feat/w4")
    const worktreePath = worktreePathFor(options, "feat/w4")
    commitIn(worktreePath, "c.txt", "worktree commit")

    const d = drift(options, "feat/w4", "parent")
    expect(d.exists).toBe(true)
    expect(d.ahead).toBe(1)
    expect(d.behind).toBe(0)
    expect(d.unpushed).toBe(0)
    expect(d.commitCount).toBe(1)
    expect(d.changedPaths).toContain("c.txt")
    expect(d.worktreePath).not.toBeNull()

    writeFileSync(join(worktreePath, "d.txt"), "d\n")
    expect(drift(options, "feat/w4", "parent").dirtyCount).toBe(1)
  })

  test("throws a clear error outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "hamilton-git-"))
    cleanup.push(dir)
    const options: GitOptions = { repoRoot: dir, worktreesDir: ".worktrees" }
    expect(() => drift(options, "feat/x", "parent")).toThrow(
      /not a git repository/,
    )
  })
})

describe("commitDelta", () => {
  test("reports the commit difference between two drifts", () => {
    const { options } = makeRepo()
    createWorktree(options, "parent", "feat/w5")
    const worktreePath = worktreePathFor(options, "feat/w5")
    commitIn(worktreePath, "c.txt", "c")
    const prev = drift(options, "feat/w5", "parent")
    commitIn(worktreePath, "d.txt", "d")
    const next = drift(options, "feat/w5", "parent")
    expect(commitDelta(prev, next)).toBe(1)
  })
})

describe("squashMerge", () => {
  test("folds a two-commit feature into parent and marks it merged", () => {
    const { options, repo } = makeRepo()
    createWorktree(options, "parent", "feat/x-y")
    const worktreePath = worktreePathFor(options, "feat/x-y")
    commitIn(worktreePath, "c.txt", "c")
    commitIn(worktreePath, "d.txt", "d")

    const before = parentHead(options, "parent")
    const { commit } = squashMerge(
      options,
      "feat/x-y",
      "parent",
      "squash feature",
    )
    expect(commit).toBe(parentHead(options, "parent"))
    expect(commit).not.toBe(before)
    expect(run(["rev-list", "--count", "parent"], repo).stdout).toBe("3")

    const d = drift(options, "feat/x-y", "parent")
    expect(d.merged).toBe(true)
  })

  test("throws 'nothing to merge' when the branch has no commits", () => {
    const { options, repo } = makeRepo()
    run(["branch", "feat/empty", "parent"], repo)
    expect(() => squashMerge(options, "feat/empty", "parent", "noop")).toThrow(
      "nothing to merge",
    )
  })
})

describe("removeWorktree", () => {
  test("removes the worktree and deletes the branch", () => {
    const { options, repo } = makeRepo()
    createWorktree(options, "parent", "feat/w7")
    removeWorktree(options, "feat/w7")

    const porcelain = run(["worktree", "list", "--porcelain"], repo).stdout
    expect(porcelain).not.toContain(".worktrees/w7")
    expect(
      run(["show-ref", "--verify", "--quiet", "refs/heads/feat/w7"], repo)
        .exitCode,
    ).toBe(1)
    expect(drift(options, "feat/w7", "parent").exists).toBe(false)
  })
})

describe("installIfLockfile", () => {
  test("runs pnpm install for a pnpm-lock.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "hamilton-install-"))
    cleanup.push(dir)
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"hamilton-test","version":"0.0.0","private":true}\n',
    )
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    const result = installIfLockfile(dir)
    expect(result.command).toBe("pnpm install --frozen-lockfile")
    expect(result.ok).toBe(true)
  })

  test("returns a null command when no lockfile exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "hamilton-install-"))
    cleanup.push(dir)
    expect(installIfLockfile(dir)).toEqual({ command: null, ok: false })
  })
})
