// Hamilton Brain — worker entry (HAMILTON.md §5).
// Routes /ping, /do/run, and the event bus queue into the RunDO spine.

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
    await Promise.all(
      batch.messages.map((message) => {
        const evt = message.body
        if (!isHamiltonEvent(evt)) return Promise.resolve()
        const id = env.RUN_DO.idFromName(`run:${evt.runId}`)
        return env.RUN_DO.get(id)
          .fetch("http://do/event", {
            method: "POST",
            body: JSON.stringify(evt),
            headers: { "content-type": "application/json" },
          })
          .then(() => {})
      }),
    )
  },
} satisfies ExportedHandler<Env>
