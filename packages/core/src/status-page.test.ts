import { describe, expect, test } from "bun:test"
import type { HamiltonEvent } from "@hamilton/shared"
import {
  activityAge,
  capTail,
  doingRow,
  doingText,
  eventRowText,
  formatHeartbeatAge,
  protocolBadges,
} from "./status-page.ts"
import type { AgentState } from "./status-page.ts"

const nowMs = 1_700_000_000_000

const agent = (overrides: Partial<AgentState> = {}): AgentState => ({
  agentId: "a1",
  state: "working",
  ...overrides,
})

const iso = (offsetMs: number): string =>
  new Date(nowMs - offsetMs).toISOString()

const event = (overrides: Partial<HamiltonEvent> = {}): HamiltonEvent => ({
  id: "e",
  type: "task.status_changed",
  ts: new Date(nowMs).toISOString(),
  runId: "r1",
  seq: 1,
  payload: null,
  ...overrides,
})

describe("formatHeartbeatAge", () => {
  test("formats seconds ago", () => {
    const at = new Date(nowMs - 12_000).toISOString()
    expect(formatHeartbeatAge(at, nowMs)).toBe("12s ago")
  })

  test("formats minutes ago", () => {
    const at = new Date(nowMs - 3 * 60_000).toISOString()
    expect(formatHeartbeatAge(at, nowMs)).toBe("3m ago")
  })

  test("no heartbeat renders dash", () => {
    expect(formatHeartbeatAge(undefined, nowMs)).toBe("—")
  })

  test("unparseable timestamp renders dash", () => {
    expect(formatHeartbeatAge("not-a-date", nowMs)).toBe("—")
  })
})

describe("eventRowText", () => {
  test("includes seq and type", () => {
    const e = event({
      seq: 42,
      type: "agent.heartbeat",
      payload: { note: "alive" },
    })
    const text = eventRowText(e)
    expect(text).toContain("42")
    expect(text).toContain("agent.heartbeat")
    expect(text).toContain('{"note":"alive"}')
  })

  test("includes task and agent when present", () => {
    const e = event({
      seq: 7,
      taskId: "t-1",
      agentId: "a-1",
      payload: { status: "in-progress" },
    })
    expect(eventRowText(e)).toBe(
      '7 task.status_changed t-1 a-1 — {"status":"in-progress"}',
    )
  })

  test("omits absent task and agent", () => {
    const e = event({ seq: 1, type: "run.planned", payload: null })
    expect(eventRowText(e)).toBe("1 run.planned — null")
  })

  test("truncates payload brief to 120 chars", () => {
    const e = event({
      seq: 9,
      type: "telemetry.opencode",
      payload: { data: "x".repeat(500) },
    })
    const text = eventRowText(e)
    const brief = JSON.stringify(e.payload).slice(0, 120)
    expect(text).toContain(brief)
    expect(text).not.toContain("x".repeat(500))
  })
})

describe("capTail", () => {
  const events: HamiltonEvent[] = [0, 1, 2, 3, 4].map((seq) => event({ seq }))

  test("keeps last n in order", () => {
    expect(capTail(events, 3).map((e) => e.seq)).toEqual([2, 3, 4])
  })

  test("returns all when fewer than n", () => {
    expect(capTail(events, 10)).toEqual(events)
  })

  test("zero or negative n returns empty", () => {
    expect(capTail(events, 0)).toEqual([])
    expect(capTail(events, -1)).toEqual([])
  })

  test("empty input returns empty", () => {
    expect(capTail([], 5)).toEqual([])
  })
})

describe("doingText", () => {
  test("status, phase and message combined", () => {
    const a = agent({
      status: "working",
      lastPhase: "implementing",
      lastMessage: "wiring up the bridge",
    })
    expect(doingText(a)).toBe("working · implementing — wiring up the bridge")
  })

  test("status defaults to working", () => {
    const a = agent({ lastPhase: "implementing", lastMessage: "hi" })
    expect(doingText(a)).toBe("working · implementing — hi")
  })

  test("phase only", () => {
    const a = agent({ lastPhase: "reviewing" })
    expect(doingText(a)).toBe("reviewing")
  })

  test("nothing renders dash", () => {
    expect(doingText(agent())).toBe("—")
  })

  test("message truncated at 60 chars with ellipsis", () => {
    const a = agent({ lastPhase: "implementing", lastMessage: "x".repeat(70) })
    expect(doingText(a)).toBe(`working · implementing — ${"x".repeat(60)}…`)
  })
})

describe("activityAge", () => {
  test("uses newest of activity, heartbeat and report", () => {
    const a = agent({
      lastActivityAt: iso(120_000),
      heartbeatAt: iso(60_000),
      lastReportAt: iso(12_000),
    })
    expect(activityAge(a, nowMs)).toBe("12s ago")
  })

  test("heartbeat wins when it is newest", () => {
    const a = agent({
      lastActivityAt: iso(120_000),
      heartbeatAt: iso(30_000),
      lastReportAt: iso(60_000),
    })
    expect(activityAge(a, nowMs)).toBe("30s ago")
  })

  test("no timestamps renders dash", () => {
    expect(activityAge(agent(), nowMs)).toBe("—")
  })
})

describe("protocolBadges", () => {
  test("all protocol steps present", () => {
    const a = agent({
      claimedAt: iso(0),
      startedAt: iso(0),
      lastReadyAt: iso(0),
    })
    expect(protocolBadges(a)).toEqual(["claim", "start", "ready"])
  })

  test("counts appended after protocol steps", () => {
    const a = agent({
      claimedAt: iso(0),
      startedAt: iso(0),
      lastReadyAt: iso(0),
      errorCount: 2,
      subagentCount: 3,
    })
    expect(protocolBadges(a)).toEqual([
      "claim",
      "start",
      "ready",
      "err:2",
      "sub:3",
    ])
  })

  test("empty when nothing", () => {
    expect(protocolBadges(agent())).toEqual([])
  })
})

describe("doingRow", () => {
  test("contains doing text and badge classes", () => {
    const a = agent({
      lastPhase: "implementing",
      lastMessage: "wiring the bridge",
      claimedAt: iso(0),
    })
    const html = doingRow(a)
    expect(html).toContain("working · implementing — wiring the bridge")
    expect(html).toContain('<span class="badge st-ok">claim</span>')
    expect(html).toContain('<span class="badge st-bad">start</span>')
    expect(html).toContain('<span class="badge st-bad">ready</span>')
  })

  test("escapes angle brackets in message text", () => {
    const a = agent({ lastPhase: "implementing", lastMessage: "a < b > c" })
    const html = doingRow(a)
    expect(html).toContain("a &lt; b &gt; c")
    expect(html).not.toContain("a < b")
  })
})
