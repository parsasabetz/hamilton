// Hamilton Brain — ReviewDO: per-review gate state, M1 skeleton only
// (HAMILTON.md §5). The three-phase gate itself lands in a later milestone.

import { DurableObject } from "cloudflare:workers"

import type { Env } from "./index.ts"
import { readJsonBody } from "./run-do.ts"

const KEYS = {
  status: "status",
  verdict: "verdict",
} as const

export class ReviewDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/state") {
      return this.state()
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 })
    }
    if (url.pathname === "/submit") {
      const body = await readJsonBody(request)
      if (body === undefined || body.verdict === undefined) {
        return new Response("verdict required", { status: 400 })
      }
      await this.ctx.storage.put({
        [KEYS.status]: "submitted",
        [KEYS.verdict]: body.verdict,
      })
      return Response.json({ ok: true })
    }
    return new Response("not found", { status: 404 })
  }

  private async state(): Promise<Response> {
    const { runId, taskId, idx } = await this.identities()
    const [status, verdict] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.status),
      this.ctx.storage.get<unknown>(KEYS.verdict),
    ])
    return Response.json({
      runId,
      taskId,
      idx,
      status: status ?? "assigned",
      verdict: verdict ?? null,
    })
  }

  private async identities(): Promise<{
    runId: string
    taskId: string
    idx: number | null
  }> {
    const name = this.ctx.id.name
    if (name !== undefined) {
      const parts = name.split(":") // review:${runId}:${taskId}:${idx}
      const runId = parts[1] ?? ""
      const taskId = parts[2] ?? ""
      const idx = Number(parts[3])
      return { runId, taskId, idx: Number.isNaN(idx) ? null : idx }
    }
    return { runId: "", taskId: "", idx: null }
  }
}
