// Hamilton status page — a single self-contained HTML document served at `/`
// (HAMILTON.md §6). No frameworks, no external deps: the page fetches
// /api/state once on load, opens an EventSource on /api/stream, appends
// events to an in-memory tail (capped), and re-renders by rebuilding the
// innerHTML of the three containers. Deliberately dumb.
//
// The pure helpers below are unit-tested; the page's own inline JS mirrors
// them with string concatenation (no nested template literals in the page).

import type { HamiltonEvent } from "@hamilton/shared"

const PAYLOAD_BRIEF_LENGTH = 120
const DOING_MESSAGE_LENGTH = 60

/** One agent row from the /api/state snapshot's agents array. */
export interface AgentState {
  agentId: string
  taskId?: string
  state: string
  status?: string
  lastPhase?: string
  lastReportAt?: string
  lastMessage?: string
  lastFiles?: string[]
  claimedAt?: string
  startedAt?: string
  errorCount?: number
  subagentCount?: number
  lastSubagentRole?: string
  lastReadyAt?: string
  heartbeatAt?: string
  lastActivityAt?: string
  busy?: boolean
  stalledAt?: string
  diedAt?: string
}

/** "12s ago" / "3m ago" / "—" — age of a single ISO timestamp at a wall clock. */
export function formatHeartbeatAge(
  heartbeatAt: string | undefined,
  nowMs: number,
): string {
  if (!heartbeatAt) return "—"
  const atMs = Date.parse(heartbeatAt)
  if (Number.isNaN(atMs)) return "—"
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

/** Same as formatHeartbeatAge — activity age of one timestamp. */
export function formatActivityAge(
  at: string | undefined,
  nowMs: number,
): string {
  return formatHeartbeatAge(at, nowMs)
}

/** Newest of activity/heartbeat/report timestamps, or undefined. */
function newestActivityAt(agent: AgentState): string | undefined {
  let newest: string | undefined
  for (const ts of [
    agent.lastActivityAt,
    agent.heartbeatAt,
    agent.lastReportAt,
  ]) {
    if (!ts) continue
    const atMs = Date.parse(ts)
    if (Number.isNaN(atMs)) continue
    if (!newest || atMs > Date.parse(newest)) newest = ts
  }
  return newest
}

/** "12s ago" / "3m ago" / "—" — age of the newest activity signal. */
export function activityAge(agent: AgentState, nowMs: number): string {
  return formatActivityAge(newestActivityAt(agent), nowMs)
}

/** "working · phase — message…" — what the agent is doing right now. */
export function doingText(agent: AgentState): string {
  if (agent.lastPhase && agent.lastMessage) {
    const message =
      agent.lastMessage.length > DOING_MESSAGE_LENGTH
        ? `${agent.lastMessage.slice(0, DOING_MESSAGE_LENGTH)}…`
        : agent.lastMessage
    return `${agent.status ?? "working"} · ${agent.lastPhase} — ${message}`
  }
  if (agent.lastPhase) return agent.lastPhase
  return "—"
}

/** Present protocol badges: claim/start/ready, plus err:N and sub:N counts. */
export function protocolBadges(agent: AgentState): string[] {
  const badges: string[] = []
  if (agent.claimedAt) badges.push("claim")
  if (agent.startedAt) badges.push("start")
  if (agent.lastReadyAt) badges.push("ready")
  if (agent.errorCount && agent.errorCount > 0)
    badges.push(`err:${agent.errorCount}`)
  if (agent.subagentCount && agent.subagentCount > 0) {
    badges.push(`sub:${agent.subagentCount}`)
  }
  return badges
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const PROTOCOL_STEPS: ReadonlyArray<{
  label: string
  present: (agent: AgentState) => boolean
}> = [
  { label: "claim", present: (agent) => !!agent.claimedAt },
  { label: "start", present: (agent) => !!agent.startedAt },
  { label: "ready", present: (agent) => !!agent.lastReadyAt },
]

/** The doing cell innerHTML: escaped doing text + protocol/count badges. */
export function doingRow(agent: AgentState): string {
  let html = escapeHtml(doingText(agent))
  for (const step of PROTOCOL_STEPS) {
    html += `<span class="badge ${step.present(agent) ? "st-ok" : "st-bad"}">${step.label}</span>`
  }
  if (agent.errorCount && agent.errorCount > 0) {
    html += `<span class="badge st-bad">err:${agent.errorCount}</span>`
  }
  if (agent.subagentCount && agent.subagentCount > 0) {
    html += `<span class="badge st-ok">sub:${agent.subagentCount}</span>`
  }
  return html
}

/** One tail row: `seq type task? agent? — payload-brief`. */
export function eventRowText(event: HamiltonEvent): string {
  const brief = JSON.stringify(event.payload ?? null).slice(
    0,
    PAYLOAD_BRIEF_LENGTH,
  )
  const parts = [String(event.seq), event.type]
  if (event.taskId) parts.push(event.taskId)
  if (event.agentId) parts.push(event.agentId)
  return `${parts.join(" ")} — ${brief}`
}

/** Last n events, order preserved. */
export function capTail(events: HamiltonEvent[], n: number): HamiltonEvent[] {
  if (n <= 0) return []
  return events.slice(-n)
}

/** Complete self-contained status page (inline style + script). */
export function statusPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>hamilton — status</title>
<style>
  body { background:#111; color:#ddd; font-family:ui-monospace,Menlo,monospace; font-size:14px; margin:2rem; }
  h1 { font-size:16px; color:#eee; margin:0 0 0.25rem; }
  h2 { font-size:12px; color:#888; margin:1.5rem 0 0.25rem; text-transform:uppercase; letter-spacing:0.1em; }
  table { border-collapse:collapse; width:100%; margin-top:0.25rem; }
  th, td { text-align:left; padding:4px 12px 4px 0; border-bottom:1px solid #222; white-space:nowrap; }
  th { color:#888; font-weight:normal; }
  .dim { color:#6b7280; }
  .ok { color:#4ade80; }
  .work { color:#facc15; }
  .review { color:#60a5fa; }
  .bad { color:#f87171; }
  .badge { font-size:11px; color:#6b7280; border:1px solid #333; border-radius:3px; padding:1px 5px; margin-left:6px; }
  .badge.st-ok { color:#4ade80; border-color:#2c4537; }
  .badge.st-bad { color:#f87171; border-color:#4a2f2f; }
  .conn { font-weight:bold; }
  .conn.live { color:#4ade80; }
  .conn.reconnecting { color:#facc15; }
  #tail div { padding:2px 0; color:#bbb; }
  #header { padding-bottom:0.5rem; border-bottom:1px solid #222; }
  #worktrees svg { display:block; margin:0.5rem 0; }
  #worktrees table td { white-space:nowrap; }
</style>
</head>
<body>
<h1>hamilton <span class="dim">/ status</span></h1>
<div id="header"></div>
<h2>tasks</h2>
<div id="tasks"></div>
<h2>agents</h2>
<div id="agents"></div>
<h2>worktrees</h2>
<div id="worktrees"><p class="dim">loading…</p></div>
<h2>events</h2>
<div id="tail"></div>
<script>
var state = null
var tail = []
var conn = 'live'
var TAIL_CAP = 50
var lastWorktreesFetch = 0

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function brief(payload) {
  return JSON.stringify(payload == null ? null : payload).slice(0, 120)
}

function eventRowText(e) {
  var parts = [String(e.seq), e.type]
  if (e.taskId) parts.push(e.taskId)
  if (e.agentId) parts.push(e.agentId)
  return parts.join(' ') + ' — ' + brief(e.payload)
}

function age(heartbeatAt) {
  if (!heartbeatAt) return '—'
  var at = Date.parse(heartbeatAt)
  if (isNaN(at)) return '—'
  var seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 60) return seconds + 's ago'
  return Math.floor(seconds / 60) + 'm ago'
}

// Client mirrors of the server helpers above — deliberate duplication,
// string concatenation only (no nested template literals in the page).

function doingText(a) {
  if (a.lastPhase && a.lastMessage) {
    var msg = String(a.lastMessage)
    if (msg.length > 60) msg = msg.slice(0, 60) + '…'
    return String(a.status || 'working') + ' · ' + a.lastPhase + ' — ' + msg
  }
  if (a.lastPhase) return a.lastPhase
  return '—'
}

function activityAge(a) {
  var best = ''
  var keys = ['lastActivityAt', 'heartbeatAt', 'lastReportAt']
  for (var i = 0; i < keys.length; i++) {
    var t = a[keys[i]]
    if (!t) continue
    var at = Date.parse(t)
    if (isNaN(at)) continue
    if (!best || at > Date.parse(best)) best = t
  }
  return age(best)
}

function doingCell(a) {
  var html = esc(doingText(a))
  var steps = [['claim', !!a.claimedAt], ['start', !!a.startedAt], ['ready', !!a.lastReadyAt]]
  for (var i = 0; i < steps.length; i++) {
    html += '<span class="badge ' + (steps[i][1] ? 'st-ok' : 'st-bad') + '">' + steps[i][0] + '</span>'
  }
  if (a.errorCount > 0) html += '<span class="badge st-bad">err:' + a.errorCount + '</span>'
  if (a.subagentCount > 0) html += '<span class="badge st-ok">sub:' + a.subagentCount + '</span>'
  return html
}

function timeShort(iso) {
  if (!iso) return '—'
  return String(iso).slice(11, 19)
}

function statusClass(status) {
  var s = String(status || '')
  if (s === 'merged' || s === 'approved') return 'ok'
  if (s === 'in-progress' || s === 'working' || s === 'reviewing') return 'work'
  if (s === 'ready-for-review') return 'review'
  if (s === 'blocked' || s === 'escalated' || s === 'died') return 'bad'
  return 'dim'
}

function agentClass(a) {
  if (a.diedAt) return 'bad'
  if (a.stalledAt) return 'bad'
  var s = String(a.state || '')
  if (s === 'idle' || s === 'planned') return 'dim'
  if (s === 'ready_for_review' || s === 'ready-for-review') return 'review'
  return s === '' ? 'dim' : 'work'
}

function renderHeader() {
  var el = document.getElementById('header')
  var snap = state && state.snapshot
  if (!snap) {
    el.innerHTML = '<span class="dim">waiting for run state</span> · <span class="conn ' + conn + '">' + conn + '</span>'
    return
  }
  el.innerHTML =
    'run <b>' + esc(snap.runId) + '</b>' +
    ' · phase <b>' + esc(snap.phase) + '</b>' +
    ' · seq <b>' + esc(snap.seq) + '</b>' +
    ' · updated <b>' + esc(timeShort(snap.updatedAt)) + '</b>' +
    ' · <span class="conn ' + conn + '">' + conn + '</span>'
}

function renderTasks() {
  var el = document.getElementById('tasks')
  var snap = state && state.snapshot
  var tasks = (snap && snap.tasks) || []
  if (!tasks.length) {
    el.innerHTML = '<span class="dim">no tasks</span>'
    return
  }
  var html = '<table><thead><tr><th>id</th><th>status</th><th>role</th><th>branch</th><th>last event</th><th>last at</th></tr></thead><tbody>'
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]
    html += '<tr class="' + statusClass(t.status) + '">'
    html += '<td>' + esc(t.id) + '</td>'
    html += '<td>' + esc(t.status || '—') + '</td>'
    html += '<td>' + esc(t.role || '—') + '</td>'
    html += '<td>' + esc(t.branch || '—') + '</td>'
    html += '<td>' + esc(t.lastEventType || '—') + '</td>'
    html += '<td>' + esc(timeShort(t.lastEventAt)) + '</td>'
    html += '</tr>'
  }
  el.innerHTML = html + '</tbody></table>'
}

function renderAgents() {
  var el = document.getElementById('agents')
  var snap = state && state.snapshot
  var agents = (snap && snap.agents) || []
  if (!agents.length) {
    el.innerHTML = '<span class="dim">no agents</span>'
    return
  }
  var html = '<table><thead><tr><th>agentId</th><th>task</th><th>state</th><th>doing</th><th>activity</th><th>busy</th><th>stalled</th><th>died</th></tr></thead><tbody>'
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i]
    html += '<tr class="' + agentClass(a) + '">'
    html += '<td>' + esc(a.agentId) + '</td>'
    html += '<td>' + esc(a.taskId || '—') + '</td>'
    html += '<td>' + esc(a.state || '—') + '</td>'
    html += '<td>' + doingCell(a) + '</td>'
    html += '<td>' + esc(activityAge(a)) + '</td>'
    html += '<td>' + (a.busy ? 'yes' : 'no') + '</td>'
    html += '<td>' + (a.stalledAt ? 'yes' : 'no') + '</td>'
    html += '<td>' + (a.diedAt ? 'yes' : 'no') + '</td>'
    html += '</tr>'
  }
  el.innerHTML = html + '</tbody></table>'
}

function renderTail() {
  var el = document.getElementById('tail')
  if (!tail.length) {
    el.innerHTML = '<span class="dim">no events yet</span>'
    return
  }
  var html = ''
  for (var i = 0; i < tail.length; i++) {
    html += '<div>' + esc(eventRowText(tail[i])) + '</div>'
  }
  el.innerHTML = html
}

function renderWorktrees() {
  var now = Date.now()
  if (now - lastWorktreesFetch < 2000) return
  lastWorktreesFetch = now
  fetch('/api/worktrees')
    .then(function (r) { return r.json() })
    .then(function (d) {
      var el = document.getElementById('worktrees')
      if (el && d && typeof d.html === 'string') el.innerHTML = d.html
    })
    .catch(function () {})
}

function render() {
  renderHeader()
  renderTasks()
  renderAgents()
  renderTail()
  renderWorktrees()
}

fetch('/api/state')
  .then(function (r) { return r.json() })
  .then(function (d) { state = d; render() })
  .catch(function () { render() })

var es = new EventSource('/api/stream')
es.onopen = function () { conn = 'live'; renderHeader() }
es.onerror = function () { conn = 'reconnecting'; renderHeader() }
es.onmessage = function (ev) {
  var data
  try { data = JSON.parse(ev.data) } catch (err) { return }
  if (!data || data.type === 'ping') return
  tail.push(data)
  if (tail.length > TAIL_CAP) tail.shift()
  render()
}
</script>
</body>
</html>`
}
