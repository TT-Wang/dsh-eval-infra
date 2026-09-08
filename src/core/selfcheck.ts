/**
 * Scenario self-check: the verifier must reject an untouched workspace (the
 * "null arm") and must accept the oracle's answer. A scenario that fails
 * either check measures nothing and is refused by `run`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { scenarioOracle, scenarioSetup, scenarioVerify, workspaceBytes } from './scenario.js'
import { solveInEnvironment, verifyInEnvironment, type TaskEnvironment } from './environment.js'
import type { Scenario } from './types.js'

export interface SelfcheckResult {
  name: string
  ok: boolean
  /** The verifier accepted an untouched workspace — the scenario is broken. */
  blankPasses: boolean | null
  /** The verifier accepted the oracle; null when the scenario has no oracle. */
  oraclePasses: boolean | null
  bytes: number
  turns: number
  detail: string
  error?: string
  /** Strict mode: files the oracle produced whose removal or blanking the verifier does NOT notice. */
  nonDiscriminating?: string[]
  /** Strict mode: number of oracle-produced files checked. */
  mutated?: number
}

/** Snapshot of file → sha of a workspace (excluding .truth/.git/.spill). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.truth' || e.name === '.git' || e.name === '.spill' || e.name === '__pycache__') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.set(relative(dir, p), `${statSync(p).size}:${readFileSync(p).toString('base64').slice(0, 64)}`)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

export interface SelfcheckOptions {
  /** Mutation sweep: for every file the oracle created or changed, delete it (and separately blank it) and require the verifier to fail. */
  strict?: boolean
  /** Cap on files mutated per scenario in strict mode (default 40). */
  maxMutations?: number
  /** Container scenarios: opens the task's environment (started, untouched) for the null check and the oracle. */
  taskEnvironment?: (scenario: Scenario) => Promise<TaskEnvironment>
}

/**
 * The same two checks for a container scenario, in its own environment: the
 * benchmark's tests must fail on the untouched image (nop) and pass after the
 * reference solution (oracle). Strict mutation sweeps do not apply: the
 * artefacts live inside the container and the tests are not ours.
 */
async function selfcheckContainer(scenario: Scenario, options: SelfcheckOptions): Promise<SelfcheckResult> {
  const result: SelfcheckResult = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' }
  if (options.taskEnvironment === undefined) { result.error = `${scenario.name} is a container scenario (image ${scenario.meta.image ?? '?'}) and needs Docker to be checked`; return result }
  const timeoutMs = (scenario.meta.verifier_timeout_s ?? 900) * 1000
  let env: TaskEnvironment | undefined
  try {
    env = await options.taskEnvironment(scenario)
    const blank = await verifyInEnvironment(env, join(scenario.dir, 'tests'), timeoutMs)
    result.blankPasses = blank.ok
    if (scenario.hasOracle) {
      const solved = await solveInEnvironment(env, join(scenario.dir, 'solution'), timeoutMs)
      if (solved.code !== 0) result.detail = `solve.sh exited ${solved.code}: ${solved.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`
      const graded = await verifyInEnvironment(env, join(scenario.dir, 'tests'), timeoutMs)
      result.oraclePasses = graded.ok
      if (!graded.ok) result.detail = graded.detail.slice(0, 300)
    }
    result.ok = result.blankPasses === false && (result.oraclePasses ?? true)
    if (result.blankPasses) result.detail = 'the benchmark tests pass on the untouched image' + (result.detail ? '; ' + result.detail : '')
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (env !== undefined) { try { await env.stop() } catch { /* best effort */ } }
  }
  return result
}

export async function selfcheckScenario(scenario: Scenario, workRoot = tmpdir(), options: SelfcheckOptions = {}): Promise<SelfcheckResult> {
  if (scenario.meta.runtime === 'container') return selfcheckContainer(scenario, options)
  const workdir = mkdtempSync(join(workRoot, `dsh-eval-selfcheck-${scenario.name}-`))
  const result: SelfcheckResult = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' }
  try {
    await scenarioSetup(scenario, workdir)
    result.bytes = workspaceBytes(workdir)
    const blank = await scenarioVerify(scenario, workdir)
    result.blankPasses = blank.ok
    if (scenario.hasOracle) {
      const before = snapshot(workdir)
      await scenarioOracle(scenario, workdir)
      const solved = await scenarioVerify(scenario, workdir)
      result.oraclePasses = solved.ok
      result.detail = solved.ok ? '' : solved.detail.slice(0, 300)
      if (options.strict && solved.ok) {
        const after = snapshot(workdir)
        const ignore = new Set(scenario.meta.strict_ignore ?? [])
        const produced = [...after.keys()].filter(f => before.get(f) !== after.get(f) && !ignore.has(f)).sort().slice(0, options.maxMutations ?? 40)
        const weak: string[] = []
        for (const rel of produced) {
          const path = join(workdir, rel)
          const original = readFileSync(path)
          unlinkSync(path)
          const deleted = await scenarioVerify(scenario, workdir)
          // Blanking an intentionally empty file is a no-op, so only the deletion mutation applies there.
          let blankedOk = false
          if (original.length > 0) {
            writeFileSync(path, '')
            blankedOk = (await scenarioVerify(scenario, workdir)).ok
          }
          writeFileSync(path, original)
          if (deleted.ok || blankedOk) weak.push(`${rel}${deleted.ok ? ' (deletion unnoticed)' : ''}${blankedOk ? ' (blanking unnoticed)' : ''}`)
        }
        result.mutated = produced.length
        result.nonDiscriminating = weak
        if (weak.length > 0) result.detail = `verifier ignores ${weak.length} of ${produced.length} oracle outputs: ${weak.join(', ')}`.slice(0, 400)
      }
    }
    result.ok = result.blankPasses === false && (result.oraclePasses ?? true) && (result.nonDiscriminating?.length ?? 0) === 0
    if (result.blankPasses) result.detail = 'verifier accepts an untouched workspace' + (result.detail ? '; ' + result.detail : '')
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
  return result
}

export async function selfcheckAll(scenarios: Scenario[], concurrency = 4, options: SelfcheckOptions = {}): Promise<SelfcheckResult[]> {
  const out: SelfcheckResult[] = new Array(scenarios.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const s = scenarios[i]
      if (s === undefined) return
      out[i] = await selfcheckScenario(s, tmpdir(), options)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()))
  return out
}
