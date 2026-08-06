// Hamilton Brain — worker entry (HAMILTON.md §5).
// Routes /ping, /do/run, and the event bus queue into the RunDO spine.

import type { HamiltonConfig } from "@hamilton/shared"

import type { AgentDO } from "./agent-do.ts"
import { isHamiltonEvent } from "./run-do.ts"
import type { RunDO } from "./run-do.ts"
import type { ReviewDO } from "./review-do.ts"
import type { TaskDO } from "./task-do.ts"

export { AgentDO } from "./agent-do.ts"
export { ReviewDO } from "./review-do.ts"
export { RunDO } from "./run-do.ts"
export { TaskDO } from "./task-do.ts"

export interface Env {
  RUN_DO: DurableObjectNamespace<RunDO>
  TASK_DO: DurableObjectNamespace<TaskDO>
  AGENT_DO: DurableObjectNamespace<AgentDO>
  REVIEW_DO: DurableObjectNamespace<ReviewDO>
  EVENTS: KVNamespace
  REGISTRY: KVNamespace
  ARTIFACTS: R2Bucket
  BUS: Queue<unknown>
  CONFIG: string
}

// The Core validates the config with zod once; the brain trusts it and only
// parses the JSON binding (keeps zod out of the worker bundle).
export function parseConfig(raw: string): HamiltonConfig {
  return JSON.parse(raw) as HamiltonConfig
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/ping") {
      return new Response("ok")
    }
    if (url.pathname.startsWith("/do/run")) {
      const id = env.RUN_DO.idFromName("run:default")
      return env.RUN_DO.get(id).fetch(request)
    }
    return new Response("not found", { status: 404 })
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const config = parseConfig(env.CONFIG)
    await Promise.all(
      batch.messages.map(async (message) => {
        const evt = message.body
        if (!isHamiltonEvent(evt)) return
        // Lease: skip if another delivery for this event is in flight.
        const leaseKey = `lease:${evt.id}`
        const lease = await env.REGISTRY.get(leaseKey, "text")
        if (lease !== null) return
        const leaseTtl = Math.max(60, Math.round(config.leaseTtlMs / 1000))
        await env.REGISTRY.put(leaseKey, "1", { expirationTtl: leaseTtl })
        const id = env.RUN_DO.idFromName(`run:${evt.runId}`)
        try {
          await env.RUN_DO.get(id).fetch("http://do/event", {
            method: "POST",
            body: JSON.stringify(evt),
            headers: { "content-type": "application/json" },
          })
          await env.REGISTRY.delete(leaseKey)
        } catch {
          // Release the lease, then retry with exponential backoff capped at
          // maxDelayMs; give up (dead-letter record) once attempts are
          // exhausted. Never throw: workerd would retry the whole batch.
          await env.REGISTRY.delete(leaseKey)
          const attempts = message.attempts ?? 1
          if (attempts < config.eventRetry.maxAttempts) {
            const delayMs = Math.min(
              config.eventRetry.baseDelayMs * 2 ** (attempts - 1),
              config.eventRetry.maxDelayMs,
            )
            message.retry({ delaySeconds: delayMs / 1000 })
          } else {
            await env.REGISTRY.put(
              `dead:${evt.id}`,
              JSON.stringify({
                id: evt.id,
                type: evt.type,
                runId: evt.runId,
                attempts,
              }),
            )
          }
        }
      }),
    )
  },
} satisfies ExportedHandler<Env>
