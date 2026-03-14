import type { Argv } from "yargs"
import path from "path"
import fs from "fs/promises"
import { EOL } from "os"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Bench } from "../../bench"
import { BenchRunner } from "../../bench/runner"
import { Global } from "../../global"

export const BenchCommand = cmd({
  command: "bench",
  describe: "run SWE-bench benchmark evaluation",
  builder: (yargs: Argv) => {
    return yargs
      .option("dataset", {
        alias: ["d"],
        type: "string",
        describe: "path to SWE-bench JSONL dataset file",
        demandOption: true,
      })
      .option("model", {
        alias: ["m"],
        type: "string",
        describe: "model to use in provider/model format",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (reasoning effort)",
      })
      .option("output", {
        alias: ["o"],
        type: "string",
        describe: "output predictions JSONL file path",
        default: "predictions.jsonl",
      })
      .option("cache-dir", {
        type: "string",
        describe: "directory to cache repo clones",
      })
      .option("concurrency", {
        type: "number",
        describe: "number of parallel instances",
        default: 5,
      })
      .option("limit", {
        type: "number",
        describe: "maximum number of instances to run",
      })
      .option("offset", {
        type: "number",
        describe: "skip first N instances",
      })
      .option("filter", {
        type: "string",
        describe: "filter instance IDs by substring",
      })
      .option("timeout", {
        type: "number",
        describe: "per-instance timeout in seconds",
        default: 300,
      })
  },
  handler: async (args) => {
    const dataset = path.resolve(args.dataset)
    const output = path.resolve(args.output)
    const cache = args.cacheDir ?? path.join(Global.Path.data, "bench-repos")
    const concurrency = args.concurrency
    const model = args.model ?? "default"

    UI.println(UI.Style.TEXT_INFO_BOLD + "~", UI.Style.TEXT_NORMAL + `Loading dataset: ${dataset}`)
    const all = await Bench.load(dataset)
    const instances = Bench.filter(all, {
      filter: args.filter,
      offset: args.offset,
      limit: args.limit,
    })

    if (instances.length === 0) {
      UI.error("No instances match the given filters")
      process.exit(1)
    }

    UI.println(
      UI.Style.TEXT_INFO_BOLD + "~",
      UI.Style.TEXT_NORMAL + `Running ${instances.length} instances (concurrency: ${concurrency})`,
    )
    UI.empty()

    const opts: BenchRunner.Options = {
      model: args.model,
      agent: args.agent,
      variant: args.variant,
      timeout: args.timeout,
      cache,
    }

    await fs.writeFile(output, "")

    const results: Bench.Result[] = []
    let done = 0
    const active = new Map<number, string>()

    function status() {
      const parts = [...active.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, msg]) => UI.Style.TEXT_DIM + `  [w${id}] ${msg}`)
      if (parts.length > 0) {
        UI.println(...parts)
      }
    }

    async function worker(id: number, queue: Bench.Instance[]) {
      while (queue.length > 0) {
        const instance = queue.shift()
        if (!instance) break

        active.set(id, instance.instance_id)
        UI.println(
          UI.Style.TEXT_DIM + `▸ [w${id}] starting ${instance.instance_id}`,
        )

        const result = await BenchRunner.run(instance, {
          ...opts,
          onPhase: (iid, phase) => {
            active.set(id, `${iid} — ${phase}`)
          },
        })
        results.push(result)
        done++
        active.delete(id)

        await fs.appendFile(output, Bench.prediction(result, model) + EOL)

        const icon = result.status === "success" ? "✓" : result.status === "timeout" ? "⏱" : "✗"
        const style =
          result.status === "success"
            ? UI.Style.TEXT_SUCCESS_BOLD
            : result.status === "timeout"
              ? UI.Style.TEXT_WARNING_BOLD
              : UI.Style.TEXT_DANGER_BOLD
        const elapsed = (result.duration / 1000).toFixed(1)
        UI.println(
          style + icon,
          UI.Style.TEXT_NORMAL +
            `[${done}/${instances.length}] ${result.instance_id} (${elapsed}s)` +
            (result.error ? UI.Style.TEXT_DIM + ` ${result.error}` : ""),
        )
        status()
      }
    }

    const queue = [...instances]
    const workers = Array.from({ length: Math.min(concurrency, instances.length) }, (_, i) => worker(i + 1, queue))
    await Promise.all(workers)

    const summary = Bench.summarize(results)
    const elapsed = (summary.duration / 1000).toFixed(1)
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "─".repeat(50))
    UI.println(UI.Style.TEXT_INFO_BOLD + "  SWE-bench Results")
    UI.println(UI.Style.TEXT_INFO_BOLD + "─".repeat(50))
    UI.println(UI.Style.TEXT_NORMAL + `  Total:    ${summary.total}`)
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `  Success:  ${summary.success}` +
        UI.Style.TEXT_DIM +
        ` (${summary.total > 0 ? ((summary.success / summary.total) * 100).toFixed(1) : 0}%)`,
    )
    UI.println(UI.Style.TEXT_DANGER_BOLD + `  Error:    ${summary.error}`)
    UI.println(UI.Style.TEXT_WARNING_BOLD + `  Timeout:  ${summary.timeout}`)
    UI.println(UI.Style.TEXT_NORMAL + `  Duration: ${elapsed}s`)
    UI.println(UI.Style.TEXT_INFO_BOLD + "─".repeat(50))
    UI.println(UI.Style.TEXT_NORMAL + `  Predictions: ${output}`)
    UI.empty()
  },
})
