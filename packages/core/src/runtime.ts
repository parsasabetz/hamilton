// Miniflare brain wrapper (HAMILTON.md §5) — bundles the brain worker entry
// with esbuild and exposes its bindings (KV, R2, queue producer) as a handle.
//
// The bundle output MUST live inside the repo: workerd's sandbox rejects
// script paths outside the process cwd, so we write to dist/brain.js
// (gitignored) under packages/core.

import { getLogger } from "@logtape/logtape"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import type { HamiltonEvent } from "@hamilton/shared"

const logger = getLogger(["hamilton", "core", "runtime"])

export interface BrainOptions {
  persistDir: string
}

export interface BrainHandle {
  emit(event: HamiltonEvent): Promise<void>
  readRunState(runId: string): Promise<unknown | null>
  readEventTail(runId: string, n: number): Promise<HamiltonEvent[]>
  putArtifact(
    runId: string,
    taskId: string | undefined,
    type: string,
    seq: number,
    body: string,
  ): Promise<string>
  appendEvent(event: HamiltonEvent): Promise<void>
  nextSeq(runId: string): Promise<number>
  dispose(): Promise<void>
  mf: Miniflare
}

const BRAIN_ENTRY = fileURLToPath(
  new URL("../../brain/src/index.ts", import.meta.url),
)
const BRAIN_OUTFILE = fileURLToPath(
  new URL("../dist/brain.js", import.meta.url),
)

const EVENT_KEY_SEQ_PAD = 10

/** Bundle the brain worker entry into a single ESM file for Miniflare. */
export async function bundleBrain(outfile: string): Promise<void> {
  await build({
    entryPoints: [BRAIN_ENTRY],
    bundle: true,
    outfile,
    platform: "neutral",
    format: "esm",
    external: ["cloudflare:*"],
  })
}

export async function createBrain(options: BrainOptions): Promise<BrainHandle> {
  await bundleBrain(BRAIN_OUTFILE)
  logger.info("Brain bundle written to {path}", { path: BRAIN_OUTFILE })

  const mf = new Miniflare({
    modules: true,
    scriptPath: BRAIN_OUTFILE,
    durableObjects: {
      RUN_DO: "RunDO",
      TASK_DO: "TaskDO",
      AGENT_DO: "AgentDO",
      REVIEW_DO: "ReviewDO",
    },
    kvNamespaces: { EVENTS: "ham-events", REGISTRY: "ham-registry" },
    r2Buckets: { ARTIFACTS: "ham-artifacts" },
    queueProducers: { BUS: "ham-bus" },
    queueConsumers: { "ham-bus": {} },
    kvPersist: options.persistDir,
    r2Persist: options.persistDir,
    durableObjectsPersist: options.persistDir,
  })
  await mf.ready

  const bus = await mf.getQueueProducer<HamiltonEvent>("BUS")
  const registry = await mf.getKVNamespace("REGISTRY")
  const events = await mf.getKVNamespace("EVENTS")
  const artifacts = await mf.getR2Bucket("ARTIFACTS")

  return {
    async emit(event: HamiltonEvent): Promise<void> {
      await bus.send(event)
    },
    async readRunState(runId: string): Promise<unknown | null> {
      const raw = await registry.get(`state:${runId}:run`, "text")
      if (raw === null) return null
      return JSON.parse(raw) as unknown
    },
    async readEventTail(runId: string, n: number): Promise<HamiltonEvent[]> {
      // Keys are zero-padded (`evt:<runId>:<0000000000N>`), so list returns
      // them in seq order; take the last n and return them ascending.
      const prefix = `evt:${runId}:`
      const keys: string[] = []
      let done = false
      let cursor: string | undefined
      while (!done) {
        // oxlint-disable-next-line no-await-in-loop
        const page = await events.list({
          prefix,
          ...(cursor ? { cursor } : {}),
        })
        for (const key of page.keys) keys.push(key.name)
        if (page.list_complete) {
          done = true
        } else {
          cursor = page.cursor
        }
      }
      const tail = keys.slice(-n)
      const result: HamiltonEvent[] = []
      for (const key of tail) {
        // oxlint-disable-next-line no-await-in-loop
        const raw = await events.get(key, "text")
        if (raw === null) continue
        result.push(JSON.parse(raw) as HamiltonEvent)
      }
      return result
    },
    async putArtifact(
      runId: string,
      taskId: string | undefined,
      type: string,
      seq: number,
      body: string,
    ): Promise<string> {
      const key = `artifacts/${runId}/${taskId ?? "run"}/${seq}-${type}.json`
      await artifacts.put(key, body)
      return key
    },
    async appendEvent(event: HamiltonEvent): Promise<void> {
      await events.put(
        `evt:${event.runId}:${String(event.seq).padStart(EVENT_KEY_SEQ_PAD, "0")}`,
        JSON.stringify(event),
      )
    },
    async nextSeq(runId: string): Promise<number> {
      const counterKey = `seq:${runId}:counter`
      const raw = await registry.get(counterKey, "text")
      const next = raw === null ? 1 : Number.parseInt(raw, 10) + 1
      await registry.put(counterKey, String(next))
      return next
    },
    async dispose(): Promise<void> {
      await mf.dispose()
    },
    mf,
  }
}
