import { afterEach, describe, expect, test } from "bun:test"
import {
  checkpointMatrixError,
  checkpointPhases,
  type EventType,
} from "@hamilton/shared"
import {
  checkpointEventType,
  checkpointPayload,
  subagentEvents,
  validateCheckpoint,
} from "./index.ts"
import { getRunStatus, postJson } from "./client.ts"

const originalFetch = globalThis.fetch

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(impl: FetchStub): void {
  globalThis.fetch = impl as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("checkpointEventType", () => {
  const phaseToEvent: Record<string, EventType> = {
    claimed: "agent.claimed",
    started: "agent.started",
    working: "agent.milestone",
    milestone: "agent.milestone",
    error: "agent.error",
    blocked: "agent.blocked",
    "ready-for-review": "agent.ready_for_review",
  }

  test("maps all 7 phases to their events", () => {
    for (const phase of checkpointPhases) {
      expect(checkpointEventType(phase)).toBe(phaseToEvent[phase]!)
    }
  })

  test("unknown phases fall back to agent.milestone", () => {
    expect(checkpointEventType("somewhere")).toBe("agent.milestone")
  })
})

describe("checkpointPayload", () => {
  test("includes phase, status, message and files", () => {
    const payload = checkpointPayload({
      phase: "working",
      status: "working",
      message: "building the gate",
      files: ["src/gate.ts"],
    })
    expect(payload).toEqual({
      phase: "working",
      status: "working",
      message: "building the gate",
      files: ["src/gate.ts"],
    })
  })

  test("omits files when undefined", () => {
    const payload = checkpointPayload({
      phase: "claimed",
      status: "working",
      message: "claiming",
    })
    expect("files" in payload).toBe(false)
  })
})

describe("validateCheckpoint", () => {
  test("accepts every allowed phase/status pair", () => {
    const valid: Array<{ phase: string; status: string }> = [
      { phase: "claimed", status: "working" },
      { phase: "started", status: "working" },
      { phase: "working", status: "working" },
      { phase: "milestone", status: "working" },
      { phase: "error", status: "blocked" },
      { phase: "blocked", status: "blocked" },
      { phase: "ready-for-review", status: "complete" },
    ]
    for (const args of valid) {
      expect(validateCheckpoint({ ...args, message: "m" })).toEqual({
        ok: true,
      })
    }
  })

  test("rejects an invalid combo with the byte-exact matrix error", () => {
    const result = validateCheckpoint({
      phase: "blocked",
      status: "working",
      message: "m",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(checkpointMatrixError("blocked", "working"))
      expect(result.error).toContain("Invalid checkpoint combination:")
      expect(result.error).toContain(
        'phase="blocked" requires status="blocked"',
      )
      expect(result.error).toContain('received status="working"')
      expect(result.error).toContain("Allowed:")
    }
  })

  test("rejects an unknown phase", () => {
    const result = validateCheckpoint({
      phase: "somewhere",
      status: "working",
      message: "m",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("unknown checkpoint phase: somewhere")
    }
  })
})

describe("subagentEvents", () => {
  test("emits spawn first, then result, with the right payloads", () => {
    const events = subagentEvents({
      role: "planner",
      objective: "decompose the run",
      result: "12 tasks planned",
    })
    expect(events.length).toBe(2)
    expect(events[0]).toEqual({
      type: "agent.subagent_spawned",
      payload: { role: "planner", objective: "decompose the run" },
    })
    expect(events[1]).toEqual({
      type: "agent.subagent_result",
      payload: {
        role: "planner",
        objective: "decompose the run",
        result: "12 tasks planned",
      },
    })
  })
})

describe("postJson", () => {
  test("POSTs JSON and returns the parsed data on success", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    stubFetch(async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify({ runId: "run-7" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const result = await postJson("http://core.test", "/api/run", {
      prompt: "build x",
      mergeAuthority: "autonomous",
    })

    expect(result).toEqual({ ok: true, data: { runId: "run-7" } })
    expect(capturedUrl).toBe("http://core.test/api/run")
    expect(capturedInit?.method).toBe("POST")
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      prompt: "build x",
      mergeAuthority: "autonomous",
    })
  })

  test("reports a non-ok core response as an error", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }))

    const result = await postJson("http://core.test", "/api/run", {})

    expect(result).toEqual({ ok: false, error: "core responded 500" })
  })

  test("returns an error string on network failure", async () => {
    stubFetch(async () => {
      throw new Error("connection refused")
    })

    const result = await postJson("http://core.test", "/api/run", {})

    expect(result.ok).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toBe("connection refused")
  })
})

describe("getRunStatus", () => {
  const summary = {
    runId: "run-7",
    phase: "dispatching",
    seq: 42,
    progress: {
      planned: 3,
      inProgress: 1,
      reviewing: 0,
      approved: 0,
      merged: 0,
      blocked: 0,
    },
    agents: [{ agentId: "a1", state: "working" }],
    tasks: [{ id: "t1", status: "in-progress", role: "implementer" }],
    violations: [],
  }

  test("GETs the run-status endpoint and returns the summary", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    stubFetch(async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const result = await getRunStatus("http://core.test", "run-7")

    expect(result.ok).toBe(true)
    expect(result.data).toEqual(summary)
    expect(capturedUrl).toBe("http://core.test/api/run-status?run=run-7")
    expect(capturedInit?.method).toBeUndefined()
    expect(capturedInit?.body).toBeUndefined()
  })

  test("reports a non-ok core response as an error", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }))

    const result = await getRunStatus("http://core.test", "run-7")

    expect(result).toEqual({ ok: false, error: "core responded 404" })
  })
})
