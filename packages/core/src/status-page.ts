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

/** "12s ago" / "3m ago" / "—" — heartbeat age at a given wall clock. */
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
  var html = '<table><thead><tr><th>agentId</th><th>task</th><th>state</th><th>heartbeat</th><th>busy</th><th>stalled</th><th>died</th></tr></thead><tbody>'
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i]
    html += '<tr class="' + agentClass(a) + '">'
    html += '<td>' + esc(a.agentId) + '</td>'
    html += '<td>' + esc(a.taskId || '—') + '</td>'
    html += '<td>' + esc(a.state || '—') + '</td>'
    html += '<td>' + esc(age(a.heartbeatAt)) + '</td>'
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
