import { afterEach, describe, expect, test } from "bun:test"
import { createShim } from "./client.ts"

const originalFetch = globalThis.fetch

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(impl: FetchStub): void {
  globalThis.fetch = impl as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("createShim", () => {
  test("rejects an unknown event type without calling fetch", async () => {
    let called = false
    stubFetch(async () => {
      called = true
      return new Response("{}", { status: 200 })
    })
    const shim = createShim({ coreUrl: "http://core.test", runId: "test-run" })

    const result = await shim.emit("not.a.real.type", { note: "hi" })

    expect(result).toEqual({ ok: false, error: "unknown event type" })
    expect(called).toBe(false)
  })

  test("emits a known event and parses { id, seq }", async () => {
    let capturedUrl = ""
    let capturedBody: Record<string, unknown> | undefined
    stubFetch(async (url, init) => {
      capturedUrl = url
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: "evt-42", seq: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const shim = createShim({ coreUrl: "http://core.test", runId: "test-run" })

    const result = await shim.emit("agent.heartbeat", { note: "still alive" })

    expect(result).toEqual({ ok: true, eventId: "evt-42", seq: 7 })
    expect(capturedUrl).toBe("http://core.test/api/events")
    expect(capturedBody).toEqual({
      type: "agent.heartbeat",
      runId: "test-run",
      payload: { note: "still alive" },
    })
  })

  test("returns an error string on network failure", async () => {
    stubFetch(async () => {
      throw new Error("connection refused")
    })
    const shim = createShim({ coreUrl: "http://core.test", runId: "test-run" })

    const result = await shim.emit("agent.milestone", { phase: "started" })

    expect(result.ok).toBe(false)
    expect(result.eventId).toBeUndefined()
    expect(result.error).toBe("connection refused")
  })
})
