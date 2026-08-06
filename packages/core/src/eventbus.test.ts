import { describe, expect, test } from "bun:test"
import type { HamiltonEvent } from "@hamilton/shared"
import type { EmitInput } from "./eventbus.ts"
import { eventKey, pickTail, stamp } from "./eventbus.ts"

function input(overrides: Partial<EmitInput> = {}): EmitInput {
  return { type: "agent.started", runId: "run-1", payload: {}, ...overrides }
}

function makeEvent(seq: number): HamiltonEvent {
  return {
    id: `e${seq}`,
    type: "agent.started",
    ts: "2026-08-06T00:00:00.000Z",
    runId: "run-1",
    seq,
    payload: {},
  }
}

describe("stamp", () => {
  test("assigns id, ts, and seq, copying the input fields", () => {
    const event = stamp(
      input({ type: "agent.milestone", payload: { step: 2 } }),
      7,
    )
    expect(event.type).toBe("agent.milestone")
    expect(event.runId).toBe("run-1")
    expect(event.seq).toBe(7)
    expect(event.payload).toEqual({ step: 2 })
    expect(event.id.length).toBeGreaterThan(0)
    expect(new Date(event.ts).toISOString()).toBe(event.ts)
  })

  test("produces a unique id per call", () => {
    const a = stamp(input(), 1)
    const b = stamp(input(), 2)
    expect(a.id).not.toBe(b.id)
  })

  test("carries optional taskId and agentId through", () => {
    const event = stamp(input({ taskId: "t1", agentId: "a1" }), 3)
    expect(event.taskId).toBe("t1")
    expect(event.agentId).toBe("a1")
  })

  test("omits optional fields when not provided", () => {
    const event = stamp(input(), 1)
    expect("taskId" in event).toBe(false)
    expect("agentId" in event).toBe(false)
  })
})

describe("pickTail", () => {
  test("returns the last n events in ascending order", () => {
    const events = [1, 2, 3, 4, 5].map(makeEvent)
    expect(pickTail(events, 3).map((e) => e.seq)).toEqual([3, 4, 5])
  })

  test("returns the whole list when n exceeds its length", () => {
    const events = [1, 2].map(makeEvent)
    expect(pickTail(events, 10).map((e) => e.seq)).toEqual([1, 2])
  })

  test("returns an empty list for an empty list", () => {
    expect(pickTail([], 5)).toEqual([])
  })

  test("handles n of zero", () => {
    const events = [1, 2, 3].map(makeEvent)
    expect(pickTail(events, 0)).toEqual([])
  })
})

describe("eventKey", () => {
  test("formats as evt:<runId>:<zero-padded seq>", () => {
    expect(eventKey("run-1", 1)).toBe("evt:run-1:0000000001")
    expect(eventKey("run-42", 123)).toBe("evt:run-42:0000000123")
  })

  test("lexicographic order matches numeric seq order", () => {
    const keys = [eventKey("r", 10), eventKey("r", 2), eventKey("r", 100)]
    expect(keys.toSorted()).toEqual([
      eventKey("r", 2),
      eventKey("r", 10),
      eventKey("r", 100),
    ])
  })
})
