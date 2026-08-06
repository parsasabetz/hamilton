import { describe, expect, test } from "bun:test"
import { classifyRawEvent } from "./bridge.ts"

describe("classifyRawEvent", () => {
  test("session.idle → idle with session id", () => {
    expect(
      classifyRawEvent({
        type: "session.idle",
        properties: { sessionID: "s1" },
      }),
    ).toEqual({ kind: "idle", sessionId: "s1" })
  })

  test("session.status → status with session id", () => {
    expect(
      classifyRawEvent({
        type: "session.status",
        properties: { sessionID: "s2", status: { type: "busy" } },
      }),
    ).toEqual({ kind: "status", sessionId: "s2" })
  })

  test("session.error → error, even without a session id", () => {
    expect(
      classifyRawEvent({
        type: "session.error",
        properties: { error: "boom" },
      }),
    ).toEqual({ kind: "error" })
  })

  test("work events with a session id → activity", () => {
    expect(
      classifyRawEvent({
        type: "message.part.updated",
        properties: { sessionID: "s3" },
      }),
    ).toEqual({ kind: "activity", sessionId: "s3" })
    expect(
      classifyRawEvent({
        type: "session.next.tool.called",
        properties: { sessionID: "s3" },
      }),
    ).toEqual({ kind: "activity", sessionId: "s3" })
  })

  test("system events without a session id → other", () => {
    expect(
      classifyRawEvent({ type: "server.connected", properties: {} }),
    ).toEqual({ kind: "other" })
  })
})
