export interface BranchState {
  branch: string
  parent: string
  worktreePath?: string
  ahead?: number
  behind?: number
  dirtyCount?: number
  unpushedCount?: number
  commitCount?: number
  merged?: boolean
  lastEventAt?: string
}

export type WorktreeState =
  | "merged"
  | "dirty"
  | "behind"
  | "diverged"
  | "ahead"
  | "clean"
  | "unknown"

const STATE_RANK: Record<WorktreeState, number> = {
  merged: 0,
  dirty: 1,
  diverged: 2,
  behind: 3,
  ahead: 4,
  clean: 5,
  unknown: 6,
}

export function worktreeState(b: BranchState): WorktreeState {
  if (b.merged === true) return "merged"
  if ((b.dirtyCount ?? 0) > 0) return "dirty"
  const ahead = b.ahead ?? 0
  const behind = b.behind ?? 0
  if (ahead > 0 && behind > 0) return "diverged"
  if (behind > 0) return "behind"
  if (ahead > 0) return "ahead"
  if (b.worktreePath) return "clean"
  return "unknown"
}

export interface TreeNode {
  branch: string
  state: WorktreeState
  ahead: number
  behind: number
  dirtyCount: number
  unpushedCount: number
  worktreePath?: string
  lastEventAt?: string
}

export interface TreeModel {
  parent: string
  nodes: TreeNode[]
}

function toNode(b: BranchState): TreeNode {
  const node: TreeNode = {
    branch: b.branch,
    state: worktreeState(b),
    ahead: b.ahead ?? 0,
    behind: b.behind ?? 0,
    dirtyCount: b.dirtyCount ?? 0,
    unpushedCount: b.unpushedCount ?? 0,
  }
  if (b.worktreePath !== undefined) node.worktreePath = b.worktreePath
  if (b.lastEventAt !== undefined) node.lastEventAt = b.lastEventAt
  return node
}

export function buildTree(branches: BranchState[], parent: string): TreeModel {
  const nodes = branches
    .filter((b) => b.parent === parent)
    .map(toNode)
    .toSorted((a, b) => {
      const byState = STATE_RANK[a.state] - STATE_RANK[b.state]
      if (byState !== 0) return byState
      if (a.branch < b.branch) return -1
      if (a.branch > b.branch) return 1
      return 0
    })
  return { parent, nodes }
}

const SVG_WIDTH = 560
const NODE_W = 120
const NODE_H = 26
const NODE_X = 40
const HEADER_W = 140
const HEADER_H = 26
const HEADER_Y = 8
const ROW_H = 34
const TOP = 40
const LABEL_MAX = 18

const NODE_FILL: Record<WorktreeState, string> = {
  merged: "#14532d",
  dirty: "#713f12",
  diverged: "#7c2d12",
  behind: "#7f1d1d",
  ahead: "#1e3a8a",
  clean: "#1f2937",
  unknown: "#111827",
}

function truncateLabel(name: string): string {
  if (name.length <= LABEL_MAX) return name
  return `${name.slice(0, LABEL_MAX)}…`
}

function svgEsc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function badgeText(n: TreeNode): string {
  if (n.state === "merged") return "✓"
  const parts: string[] = []
  if (n.ahead > 0) parts.push(`↑${n.ahead}`)
  if (n.behind > 0) parts.push(`↓${n.behind}`)
  if (n.dirtyCount > 0) parts.push(`≈${n.dirtyCount}`)
  if (n.unpushedCount > 0) parts.push(`➜${n.unpushedCount}`)
  return parts.join(" ")
}

export function renderTreeSvg(model: TreeModel): string {
  const headerX = (SVG_WIDTH - HEADER_W) / 2
  const headerCx = headerX + HEADER_W / 2
  const headerBottom = HEADER_Y + HEADER_H
  const nodeCx = NODE_X + NODE_W / 2
  const busY = TOP + NODE_H / 2
  const height = TOP + model.nodes.length * ROW_H + 20
  const rows: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}" font-family="ui-monospace,Menlo,monospace">`,
  ]
  if (model.nodes.length > 0) {
    rows.push('<g stroke="#444" fill="none">')
    rows.push(`<path d="M${headerCx} ${headerBottom} V${busY}" />`)
    rows.push(`<path d="M${nodeCx} ${busY} H${headerCx}" />`)
    for (const [i] of model.nodes.entries()) {
      rows.push(`<path d="M${nodeCx} ${busY} V${TOP + i * ROW_H}" />`)
    }
    rows.push("</g>")
  }
  rows.push(
    `<rect x="${headerX}" y="${HEADER_Y}" width="${HEADER_W}" height="${HEADER_H}" fill="#333" />`,
  )
  rows.push(
    `<text x="${headerCx}" y="${HEADER_Y + HEADER_H / 2 + 3}" fill="#eee" font-size="11" text-anchor="middle">${svgEsc(truncateLabel(model.parent))}</text>`,
  )
  for (const [i, n] of model.nodes.entries()) {
    const y = TOP + i * ROW_H
    rows.push(
      `<rect x="${NODE_X}" y="${y}" width="${NODE_W}" height="${NODE_H}" fill="${NODE_FILL[n.state]}" />`,
    )
    rows.push(
      `<text x="${NODE_X + 6}" y="${y + 15}" fill="#f3f4f6" font-size="10">${svgEsc(truncateLabel(n.branch))}</text>`,
    )
    const badge = badgeText(n)
    if (badge !== "") {
      rows.push(
        `<text x="${NODE_X + 6}" y="${y + 24}" fill="#d1d5db" font-size="9">${svgEsc(badge)}</text>`,
      )
    }
  }
  rows.push("</svg>")
  return rows.join("\n")
}

function htmlEsc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function formatLastEvent(iso: string | undefined): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}

export function worktreeSection(branches: BranchState[]): string {
  const rows: string[] = ['<section id="worktrees">', "<h2>worktrees</h2>"]
  if (branches.length === 0) {
    rows.push('<p class="dim">no worktrees yet</p>')
    rows.push("</section>")
    return rows.join("\n")
  }
  const parents: string[] = []
  for (const b of branches) {
    if (!parents.includes(b.parent)) parents.push(b.parent)
  }
  for (const parent of parents) {
    rows.push(renderTreeSvg(buildTree(branches, parent)))
  }
  rows.push(
    "<table><thead><tr><th>branch</th><th>parent</th><th>state</th><th>ahead</th><th>behind</th><th>dirty</th><th>unpushed</th><th>worktree</th><th>last event</th></tr></thead><tbody>",
  )
  for (const parent of parents) {
    for (const n of buildTree(branches, parent).nodes) {
      rows.push(
        `<tr class="st-${n.state}"><td>${htmlEsc(n.branch)}</td><td>${htmlEsc(parent)}</td><td>${n.state}</td><td>${n.ahead}</td><td>${n.behind}</td><td>${n.dirtyCount}</td><td>${n.unpushedCount}</td><td>${n.worktreePath ? htmlEsc(n.worktreePath) : "—"}</td><td>${htmlEsc(formatLastEvent(n.lastEventAt))}</td></tr>`,
      )
    }
  }
  rows.push("</tbody></table>", "</section>")
  return rows.join("\n")
}
