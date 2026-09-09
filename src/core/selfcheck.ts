/**
 * Scenario self-check: the verifier must reject an untouched workspace (the
 * "null arm") and must accept the oracle's answer. A scenario that fails
 * either check measures nothing and is refused by `run`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { scenarioOracle, scenarioSetup, scenarioVerify, workspaceBytes } from './scenario.js'
import { hostVerifierEnvWithTimeout, INFRA_PREFIX, solveInEnvironment, verifyInEnvironment, type TaskEnvironment } from './environment.js'
import type { Scenario } from './types.js'

/**
 * Why a scenario did not pass its check, as a code an agent can act on. The
 * whole point of the intake loop is that the target is machine-checkable: write
 * a verifier, run the check, read these, fix, repeat. `detail` inside a finding
 * is the verifier's own words, which are the scenario author's to read — not a
 * sentence this tool composed.
 */
export type SelfcheckFinding =
  /** The verifier accepted a workspace the agent never touched: it would pass every trial. */
  | { code: 'blank.accepted'; detail: string }
  /** The verifier rejected the reference answer: it asks for something the oracle does not produce. */
  | { code: 'oracle.rejected'; detail: string }
  /** Strict mode: files the oracle produced whose deletion or blanking the verifier does not notice. */
  | { code: 'strict.blind_to_output'; files: string[]; mutated: number }
  /** The scenario's own code raised: setup, verify or the oracle. */
  | { code: 'scenario.threw'; phase: 'setup' | 'verify' | 'oracle' | 'environment'; message: string }

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
  /** Machine-readable reasons this scenario did not pass, empty when it did. */
  findings?: SelfcheckFinding[]
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
  /** Cap on a container scenario's verifier, in seconds, over the scenario's own (a benchmark's tests can hang on a third-party host). */
  verifierTimeoutS?: number
}

/**
 * The same two checks for a container scenario, in its own environment: the
 * benchmark's tests must fail on the untouched image (nop) and pass after the
 * reference solution (oracle). Strict mutation sweeps do not apply: the
 * artefacts live inside the container and the tests are not ours.
 */
async function selfcheckContainer(scenario: Scenario, options: SelfcheckOptions): Promise<SelfcheckResult> {
  const result: SelfcheckResult = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' }
  const findings: SelfcheckFinding[] = []
  let blankDetail = ''
  if (options.taskEnvironment === undefined) { result.error = `${scenario.name} is a container scenario (image ${scenario.meta.image ?? '?'}) and needs Docker to be checked`; result.findings = [{ code: 'scenario.threw', phase: 'environment', message: result.error }]; return result }
  const verifierTimeoutS = options.verifierTimeoutS !== undefined ? Math.min(options.verifierTimeoutS, scenario.meta.verifier_timeout_s ?? Infinity) : (scenario.meta.verifier_timeout_s ?? 900)
  const timeoutMs = verifierTimeoutS * 1000
  const hostSide = existsSync(join(scenario.dir, 'verify.py'))
  let env: TaskEnvironment | undefined
  // The grade, made the way the run makes it: the benchmark's tests inside the container, or the host-side verifier handed the container.
  const grade = async (e: TaskEnvironment): Promise<{ ok: boolean; detail: string }> => {
    if (!hostSide) return verifyInEnvironment(e, join(scenario.dir, 'tests'), timeoutMs)
    const scratch = mkdtempSync(join(tmpdir(), `dsh-eval-selfcheck-${scenario.name}-`))
    const v = await scenarioVerify(scenario, scratch, { env: hostVerifierEnvWithTimeout(e, verifierTimeoutS), timeoutMs: timeoutMs + 120_000, ...(scenario.meta.verifier_python !== undefined ? { python: scenario.meta.verifier_python } : {}) })
    if (!v.ok && v.detail.startsWith(INFRA_PREFIX)) throw new Error(v.detail)
    return v
  }
  try {
    env = await options.taskEnvironment(scenario)
    const blank = await grade(env)
    result.blankPasses = blank.ok
    blankDetail = blank.detail
    if (scenario.hasOracle) {
      const solved = await solveInEnvironment(env, join(scenario.dir, 'solution'), timeoutMs)
      const solveDetail = solved.code === 0 ? '' : `solve.sh exited ${solved.code}${solved.code === 124 ? ' (timed out)' : ''}: ${(solved.stderr.trim() || solved.stdout.trim()).split('\n').slice(-3).join(' | ').slice(0, 300)}`
      const graded = await grade(env)
      result.oraclePasses = graded.ok
      // A reference solution that could not even run is the reason, not the tests it then fails.
      if (!graded.ok) {
        result.detail = [solveDetail, graded.detail.slice(0, 300)].filter(Boolean).join(' · ')
        findings.push({ code: 'oracle.rejected', detail: result.detail.slice(0, 400) })
      }
    }
    result.ok = result.blankPasses === false && (result.oraclePasses ?? true)
    if (result.blankPasses) {
      result.detail = 'the benchmark tests pass on the untouched image' + (result.detail ? '; ' + result.detail : '')
      findings.unshift({ code: 'blank.accepted', detail: blankDetail.slice(0, 400) })
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    findings.push({ code: 'scenario.threw', phase: 'environment', message: result.error.slice(0, 600) })
  } finally {
    if (env !== undefined) { try { await env.stop() } catch { /* best effort */ } }
  }
  if (findings.length > 0) result.findings = findings
  return result
}

export async function selfcheckScenario(scenario: Scenario, workRoot = tmpdir(), options: SelfcheckOptions = {}): Promise<SelfcheckResult> {
  if (scenario.meta.runtime === 'container') return selfcheckContainer(scenario, options)
  const workdir = mkdtempSync(join(workRoot, `dsh-eval-selfcheck-${scenario.name}-`))
  const result: SelfcheckResult = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' }
  const findings: SelfcheckFinding[] = []
  let phase: 'setup' | 'verify' | 'oracle' = 'setup'
  let blankDetail = ''
  try {
    await scenarioSetup(scenario, workdir)
    result.bytes = workspaceBytes(workdir)
    phase = 'verify'
    const blank = await scenarioVerify(scenario, workdir)
    result.blankPasses = blank.ok
    blankDetail = blank.detail
    if (scenario.hasOracle) {
      const before = snapshot(workdir)
      phase = 'oracle'
      await scenarioOracle(scenario, workdir)
      phase = 'verify'
      const solved = await scenarioVerify(scenario, workdir)
      result.oraclePasses = solved.ok
      result.detail = solved.ok ? '' : solved.detail.slice(0, 300)
      if (!solved.ok) findings.push({ code: 'oracle.rejected', detail: solved.detail.slice(0, 400) })
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
        if (weak.length > 0) {
          result.detail = `verifier ignores ${weak.length} of ${produced.length} oracle outputs: ${weak.join(', ')}`.slice(0, 400)
          findings.push({ code: 'strict.blind_to_output', files: weak, mutated: produced.length })
        }
      }
    }
    result.ok = result.blankPasses === false && (result.oraclePasses ?? true) && (result.nonDiscriminating?.length ?? 0) === 0
    if (result.blankPasses) {
      result.detail = 'verifier accepts an untouched workspace' + (result.detail ? '; ' + result.detail : '')
      findings.unshift({ code: 'blank.accepted', detail: blankDetail.slice(0, 400) })
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    findings.push({ code: 'scenario.threw', phase, message: result.error.slice(0, 600) })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
  if (findings.length > 0) result.findings = findings
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
