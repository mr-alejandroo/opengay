import z from "zod"
import { Log } from "@/util/log"

export namespace Bench {
  const log = Log.create({ service: "bench" })

  // SWE-bench dataset instance schema
  export const Instance = z.object({
    instance_id: z.string(),
    repo: z.string(),
    base_commit: z.string(),
    problem_statement: z.string(),
    hints_text: z.string().optional().default(""),
    test_patch: z.string().optional().default(""),
    patch: z.string().optional().default(""),
    FAIL_TO_PASS: z.string().optional().default("[]"),
    PASS_TO_PASS: z.string().optional().default("[]"),
    environment_setup_commit: z.string().optional(),
    created_at: z.string().optional(),
    version: z.string().optional(),
  })
  export type Instance = z.infer<typeof Instance>

  // Prediction output format (standard SWE-bench)
  export const Prediction = z.object({
    instance_id: z.string(),
    model_name_or_path: z.string(),
    model_patch: z.string(),
  })
  export type Prediction = z.infer<typeof Prediction>

  // Result for a single instance run
  export type Result = {
    instance_id: string
    status: "success" | "error" | "timeout"
    patch: string
    duration: number
    error?: string
  }

  // Aggregated summary
  export type Summary = {
    total: number
    success: number
    error: number
    timeout: number
    duration: number
  }

  // Load SWE-bench JSONL dataset
  export async function load(path: string): Promise<Instance[]> {
    const text = await Bun.file(path).text()
    const lines = text.split("\n").filter((line) => line.trim())
    const results: Instance[] = []
    for (const line of lines) {
      let json
      try {
        json = JSON.parse(line)
      } catch {
        log.warn("skipping line with invalid JSON")
        continue
      }
      const parsed = Instance.safeParse(json)
      if (!parsed.success) {
        log.warn("skipping invalid instance", { error: parsed.error.message })
        continue
      }
      results.push(parsed.data)
    }
    log.info("loaded dataset", { instances: results.length, path })
    return results
  }

  // Apply filters to dataset
  export function filter(instances: Instance[], opts: {
    filter?: string
    offset?: number
    limit?: number
  }): Instance[] {
    let result = instances
    if (opts.filter) {
      const pattern = opts.filter
      result = result.filter((i) => i.instance_id.includes(pattern))
    }
    if (opts.offset) result = result.slice(opts.offset)
    if (opts.limit) result = result.slice(0, opts.limit)
    return result
  }

  // Format a prediction line for JSONL output
  export function prediction(result: Result, model: string): string {
    return JSON.stringify({
      instance_id: result.instance_id,
      model_name_or_path: model,
      model_patch: result.patch,
    })
  }

  // Aggregate results into summary
  export function summarize(results: Result[]): Summary {
    return {
      total: results.length,
      success: results.filter((r) => r.status === "success").length,
      error: results.filter((r) => r.status === "error").length,
      timeout: results.filter((r) => r.status === "timeout").length,
      duration: results.reduce((sum, r) => sum + r.duration, 0),
    }
  }
}
