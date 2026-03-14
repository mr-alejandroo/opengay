import path from "path"
import fs from "fs/promises"
import { git } from "@/util/git"
import { Log } from "@/util/log"
import { bootstrap } from "@/cli/bootstrap"
import { Server } from "@/server/server"
import { Provider } from "@/provider/provider"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Bench } from "."

export namespace BenchRunner {
  const log = Log.create({ service: "bench.runner" })

  export type Options = {
    model?: string
    agent?: string
    variant?: string
    timeout: number
    cache: string
    onPhase?: (instance: string, phase: string) => void
  }

  async function prepare(instance: Bench.Instance, cache: string): Promise<string> {
    const slug = instance.repo.replace("/", "__")
    const dir = path.join(cache, slug)

    const exists = await fs
      .stat(path.join(dir, ".git"))
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      log.info("cloning", { repo: instance.repo, dir })
      const url = `https://github.com/${instance.repo}.git`
      const result = await git(["clone", "--quiet", url, dir], { cwd: cache })
      if (result.exitCode !== 0) throw new Error(`clone failed: ${result.stderr.toString()}`)
    }

    const fetch = await git(["fetch", "--quiet", "origin"], { cwd: dir })
    if (fetch.exitCode !== 0) throw new Error(`fetch failed: ${fetch.stderr.toString()}`)
    const checkout = await git(["checkout", "--force", instance.base_commit], { cwd: dir })
    if (checkout.exitCode !== 0) throw new Error(`checkout failed: ${checkout.stderr.toString()}`)

    const clean = await git(["clean", "-fdx"], { cwd: dir })
    if (clean.exitCode !== 0) throw new Error(`clean failed: ${clean.stderr.toString()}`)

    log.info("prepared", { instance: instance.instance_id, commit: instance.base_commit.slice(0, 8) })
    return dir
  }

  async function diff(dir: string): Promise<string> {
    const result = await git(["diff", "HEAD"], { cwd: dir })
    return result.text()
  }

  export async function run(instance: Bench.Instance, opts: Options): Promise<Bench.Result> {
    const start = Date.now()
    const phase = opts.onPhase ?? (() => {})
    try {
      await fs.mkdir(opts.cache, { recursive: true })
      phase(instance.instance_id, "preparing repo")
      const dir = await prepare(instance, opts.cache)

      phase(instance.instance_id, "bootstrapping")
      const patch = await bootstrap(dir, async () => {
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          return Server.Default().fetch(request)
        }) as typeof globalThis.fetch
        const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })

        const session = await sdk.session.create({
          title: `bench: ${instance.instance_id}`,
          permission: [
            { permission: "question", action: "deny", pattern: "*" },
            { permission: "plan_enter", action: "deny", pattern: "*" },
            { permission: "plan_exit", action: "deny", pattern: "*" },
          ],
        })
        if (!session.data) throw new Error("session creation failed")
        const sessionID = session.data.id

        const events = await sdk.event.subscribe()
        const model = opts.model ? Provider.parseModel(opts.model) : undefined

        phase(instance.instance_id, "prompting agent")
        await sdk.session.prompt({
          sessionID,
          agent: opts.agent,
          model,
          variant: opts.variant,
          parts: [{ type: "text", text: instance.problem_statement }],
        })

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeout * 1000)

        try {
          phase(instance.instance_id, "waiting for agent")
          for await (const event of events.stream) {
            if (controller.signal.aborted) throw new Error("timeout")

            if (event.type === "permission.asked") {
              const perm = event.properties
              if (perm.sessionID !== sessionID) continue
              await sdk.permission.reply({ requestID: perm.id, reply: "reject" })
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let msg = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                msg = String(props.error.data.message)
              }
              throw new Error(msg)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              break
            }
          }
        } finally {
          clearTimeout(timer)
        }

        phase(instance.instance_id, "extracting diff")
        return await diff(dir)
      })

      return {
        instance_id: instance.instance_id,
        status: "success",
        patch: patch ?? "",
        duration: Date.now() - start,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const timeout = msg === "timeout"
      log.warn("failed", {
        instance: instance.instance_id,
        error: msg,
        timeout,
      })
      return {
        instance_id: instance.instance_id,
        status: timeout ? "timeout" : "error",
        patch: "",
        duration: Date.now() - start,
        error: msg,
      }
    }
  }
}
