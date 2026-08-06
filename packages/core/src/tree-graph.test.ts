import { describe, expect, test } from "bun:test"
import {
  buildTree,
  renderTreeSvg,
  worktreeSection,
  worktreeState,
} from "./tree-graph.ts"
import type { BranchState, TreeNode, TreeModel } from "./tree-graph.ts"

const branch = (overrides: Partial<BranchState> = {}): BranchState => ({
  branch: "feat/x",
  parent: "main",
  worktreePath: "/worktrees/feat-x",
  ...overrides,
})

const makeNode = (overrides: Partial<TreeNode>): TreeNode => ({
  branch: "feat/x",
  state: "clean",
  ahead: 0,
  behind: 0,
  dirtyCount: 0,
  unpushedCount: 0,
  ...overrides,
})

describe("worktreeState", () => {
  test("merged wins over everything", () => {
    expect(
      worktreeState(branch({ merged: true, ahead: 5, dirtyCount: 3 })),
    ).toBe("merged")
  })

  test("dirty beats drift", () => {
    expect(worktreeState(branch({ ahead: 2, behind: 1, dirtyCount: 1 }))).toBe(
      "dirty",
    )
  })

  test("diverged when both ahead and behind", () => {
    expect(worktreeState(branch({ ahead: 3, behind: 2 }))).toBe("diverged")
  })

  test("behind", () => {
    expect(worktreeState(branch({ behind: 4 }))).toBe("behind")
  })

  test("ahead", () => {
    expect(worktreeState(branch({ ahead: 4 }))).toBe("ahead")
  })

  test("clean when worktree exists with no drift", () => {
    expect(worktreeState(branch({}))).toBe("clean")
  })

  test("unknown for a registry row with no worktree", () => {
    expect(worktreeState(branch({ worktreePath: undefined }))).toBe("unknown")
  })

  test("zero counts with no worktree is unknown", () => {
    expect(
      worktreeState(
        branch({ ahead: 0, behind: 0, dirtyCount: 0, worktreePath: undefined }),
      ),
    ).toBe("unknown")
  })
})

describe("buildTree", () => {
  const branches: BranchState[] = [
    branch({ branch: "feat/dirty-a", dirtyCount: 2 }),
    branch({ branch: "feat/clean-b" }),
    branch({ branch: "feat/merged", merged: true }),
    branch({ branch: "feat/clean-a" }),
    branch({ branch: "feat/behind", behind: 1 }),
    branch({ branch: "feat/ahead", ahead: 2 }),
    branch({ branch: "feat/diverged", ahead: 2, behind: 1 }),
    branch({ branch: "feat/unknown", worktreePath: undefined }),
    branch({ branch: "other/child", parent: "topic" }),
  ]

  test("keeps only children of the requested parent", () => {
    const model = buildTree(branches, "main")
    expect(model.parent).toBe("main")
    expect(model.nodes.map((n) => n.branch)).toEqual([
      "feat/merged",
      "feat/dirty-a",
      "feat/diverged",
      "feat/behind",
      "feat/ahead",
      "feat/clean-a",
      "feat/clean-b",
      "feat/unknown",
    ])
    expect(buildTree(branches, "topic").nodes.map((n) => n.branch)).toEqual([
      "other/child",
    ])
  })

  test("sorts ties within a state by branch name", () => {
    const names = buildTree(branches, "main")
      .nodes.filter((n) => n.state === "clean")
      .map((n) => n.branch)
    expect(names).toEqual(["feat/clean-a", "feat/clean-b"])
  })

  test("fills zero counts", () => {
    const node = buildTree(branches, "main").nodes.find(
      (n) => n.branch === "feat/clean-a",
    )
    expect(node?.ahead).toBe(0)
    expect(node?.behind).toBe(0)
    expect(node?.dirtyCount).toBe(0)
    expect(node?.unpushedCount).toBe(0)
  })

  test("keeps optional fields", () => {
    const node = buildTree(
      [
        branch({
          branch: "feat/dirty-a",
          dirtyCount: 2,
          worktreePath: undefined,
        }),
      ],
      "main",
    ).nodes[0]
    expect(node?.dirtyCount).toBe(2)
    expect(node?.worktreePath).toBeUndefined()
    const wt = buildTree(
      [
        branch({
          branch: "feat/x",
          worktreePath: "/wt/x",
          lastEventAt: "2026-08-06T12:00:00.000Z",
        }),
      ],
      "main",
    ).nodes[0]
    expect(wt?.worktreePath).toBe("/wt/x")
    expect(wt?.lastEventAt).toBe("2026-08-06T12:00:00.000Z")
  })
})

describe("renderTreeSvg", () => {
  const model: TreeModel = {
    parent: "main",
    nodes: [
      makeNode({ branch: "feat/merged", state: "merged" }),
      makeNode({ branch: "feat/ahead-3", state: "ahead", ahead: 3 }),
      makeNode({ branch: "feat/a<b>", state: "clean" }),
    ],
  }

  test("contains svg root, header and dimensions", () => {
    const svg = renderTreeSvg(model)
    expect(svg).toContain("<svg")
    expect(svg).toContain('width="560"')
    expect(svg).toContain('height="162"')
    expect(svg).toContain("main")
  })

  test("draws classic tree connectors", () => {
    const svg = renderTreeSvg(model)
    expect(svg).toContain('<g stroke="#444" fill="none">')
    expect(svg).toContain('d="M280 34 V53"')
    expect(svg).toContain('d="M100 53 H280"')
    expect(svg).toContain('d="M100 53 V108"')
  })

  test("labels each child branch", () => {
    const svg = renderTreeSvg(model)
    expect(svg).toContain("feat/merged")
    expect(svg).toContain("feat/ahead-3")
  })

  test("shows merged checkmark", () => {
    expect(renderTreeSvg(model)).toContain("✓")
  })

  test("shows ahead badge", () => {
    expect(renderTreeSvg(model)).toContain("↑3")
  })

  test("omits zero badges", () => {
    const svg = renderTreeSvg(model)
    expect(svg).not.toContain("↑0")
    expect(svg).not.toContain("↓0")
  })

  test("escapes branch names in svg text", () => {
    const svg = renderTreeSvg(model)
    expect(svg).toContain("a&lt;b&gt;")
    expect(svg).not.toContain("a<b>")
  })

  test("truncates long branch names", () => {
    const long: TreeNode = makeNode({
      branch: "feature/this-is-a-very-long-branch-name",
    })
    const svg = renderTreeSvg({ parent: "main", nodes: [long] })
    expect(svg).toContain("feature/this-is-a-…")
    expect(svg).not.toContain("feature/this-is-a-very-long-branch-name")
  })

  test("empty tree renders header only", () => {
    const svg = renderTreeSvg({ parent: "main", nodes: [] })
    expect(svg).toContain('height="60"')
    expect(svg).not.toContain("M280")
  })
})

describe("worktreeSection", () => {
  test("renders section, trees and table", () => {
    const html = worktreeSection([
      branch({ branch: "feat/dirty", dirtyCount: 2 }),
      branch({
        branch: "feat/clean",
        lastEventAt: "2026-08-06T12:34:56.789Z",
      }),
    ])
    expect(html).toContain('<section id="worktrees">')
    expect(html).toContain("</section>")
    expect(html).toContain("<h2>worktrees</h2>")
    expect(html).toContain("<svg")
    expect(html).toContain("<th>branch</th>")
    expect(html).toContain("<th>last event</th>")
    expect(html).toContain('<tr class="st-dirty">')
    expect(html).toContain("feat/dirty")
    expect(html).toContain("2026-08-06 12:34:56")
  })

  test("escapes html in values", () => {
    const html = worktreeSection([
      branch({ branch: "weird\"&'<>", worktreePath: "/wt/a&b" }),
    ])
    expect(html).toContain("weird&quot;&amp;&#39;&lt;&gt;")
    expect(html).toContain("/wt/a&amp;b")
  })

  test("empty branches render a dim paragraph", () => {
    const html = worktreeSection([])
    expect(html).toContain('<p class="dim">no worktrees yet</p>')
    expect(html).not.toContain("<table>")
  })
})
