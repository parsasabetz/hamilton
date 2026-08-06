import { describe, expect, test } from "bun:test"
import type { HamiltonEvent } from "@hamilton/shared"
import { capTail, eventRowText, formatHeartbeatAge } from "./status-page.ts"

const nowMs = 1_700_000_000_000

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
