/**
 * The run engine: interleaved, repeated, paired execution of scenarios across
 * arms through a driver. The production driver spawns the real dsh SDK
 * runtime (one process per run, one session per scenario run); tests inject a
 * scripted driver. Scheduling order is fixed — scenario → repeat → arm — so
 * baseline and candidate always run back to back under the same conditions.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import yaml from 'js-yaml'
import type { ResolvedArm, RunLedger, RunPlan, Scenario, Verdict } from './types.js'
import { armOverlays } from './arms.js'
import { buildLedger, type EventLike } from './ledger.js'
import type { PriceTable } from './pricing.js'
import { scenarioSetup, scenarioVerify } from './scenario.js'
import { ledgerPath, writeJsonAtomic, writeLedger, type Progress, type RunPaths } from './store.js'

export interface DriverTurnResult {
  events: EventLike[]
  sessionId: string | null
}

export interface Driver {
  runTurn(prompt: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<DriverTurnResult>
  close(): Promise<void>
}

export interface DriverInput {
  arm: ResolvedArm
  scenario: Scenario
  workdir: string
  evalHome: string
  /** Overlay files in application order. */
  overlays: string[]
  env: Record<string, string>
}

export type DriverFactory = (input: DriverInput) => Driver

export class TurnTimeoutError extends Error {
  constructor(turn: number, ms: number) {
    super(`turn ${turn} exceeded ${Math.round(ms / 1000)}s`)
  }
}

export interface JobSpec {
  order: number
  scenario: Scenario
  arm: ResolvedArm
  rep: number
}

/**
 * Fixed interleaving: scenario → repeat → arm. Odd repeats run baseline first,
 * even repeats run the arms in reverse (team-draft style), so neither arm
 * systematically enjoys a warmer server cache or a quieter minute.
 */
export function planJobs(scenarios: Scenario[], arms: ResolvedArm[], repeats: number): JobSpec[] {
  const jobs: JobSpec[] = []
  let order = 0
  for (const scenario of scenarios) {
    for (let rep = 1; rep <= repeats; rep += 1) {
      const ordered = rep % 2 === 1 ? arms : [...arms].reverse()
      for (const arm of ordered) jobs.push({ order: order++, scenario, arm, rep })
    }
  }
  return jobs
}

/**
 * Ground truth must not be readable from inside the workspace. Scenario
 * generators that keep it under `<workdir>/.truth` get it moved out after
 * setup and back in before verify; the agent never sees it.
 */
export function stashTruth(workdir: string, stashRoot: string): (() => void) | undefined {
  const truth = join(workdir, '.truth')
  if (!existsSync(truth)) return undefined
  mkdirSync(stashRoot, { recursive: true })
  const stash = join(stashRoot, 'truth-' + basename(workdir))
  renameSync(truth, stash)
  return () => { if (existsSync(stash)) renameSync(stash, truth) }
}

export interface RunDeps {
  driverFactory: DriverFactory
  evalHome: string
  paths: RunPaths
  /** Environment passed to every runtime subprocess (API key included). */
  env: Record<string, string>
  prices?: PriceTable
  signal?: AbortSignal
  keepWorkdirs?: boolean
  onProgress?: (progress: Progress) => void
  onLedger?: (ledger: RunLedger) => void
  log?: (line: string) => void
  /** Override the per-turn timeout for every scenario (ms). */
  turnTimeoutMs?: number
  /** Skip jobs whose ledger already exists (resume). */
  resume?: boolean
  workRoot?: string
  /** Stop scheduling new trials once the run's spend exceeds this many USD (finished trials are kept). */
  maxUsd?: number
}

/** Base overlays every arm shares; the scenario decides whether network tools are allowed. */
export function writeBaseOverlays(armsDir: string): { noNetwork: string; network: string } {
  mkdirSync(armsDir, { recursive: true })
  const common = [
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-title-llm', disabled: true },
  ]
  const noNetwork = join(armsDir, '_base-no-network.patch.yml')
  const network = join(armsDir, '_base-network.patch.yml')
  writeFileSync(noNetwork, '# shared eval base: telemetry off, network tools off (scenario meta.network=false)\n' + yaml.dump([...common, { id: 'tool-web', disabled: true }]))
  writeFileSync(network, '# shared eval base: telemetry off, network tools on (scenario meta.network=true)\n' + yaml.dump(common))
  return { noNetwork, network }
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000

function offsetTurn(e: EventLike, offset: number): EventLike {
  const d = e.data
  if (d !== null && typeof d === 'object' && typeof (d as { turn?: unknown }).turn === 'number') {
    return { ...e, data: { ...(d as Record<string, unknown>), turn: (d as { turn: number }).turn + offset } }
  }
  return e
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)
}

export async function executeRun(plan: RunPlan, scenarios: Scenario[], arms: ResolvedArm[], deps: RunDeps): Promise<Progress> {
  const { paths } = deps
  const jobs = planJobs(scenarios, arms, plan.repeats)
  const base = writeBaseOverlays(paths.arms)
  const started = new Date()
  const progress: Progress = {
    status: 'running',
    total: jobs.length,
    completed: 0,
    failed: 0,
    usd: 0,
    startedAt: started.toISOString(),
    updatedAt: started.toISOString(),
    active: [],
    recent: [],
  }
  const publish = (): void => {
    progress.updatedAt = new Date().toISOString()
    writeJsonAtomic(paths.progress, progress)
    deps.onProgress?.(structuredClone(progress))
  }
  publish()

  let next = 0
  let overBudget = false
  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal?.aborted) return
      if (deps.maxUsd !== undefined && progress.usd >= deps.maxUsd) { overBudget = true; return }
      const job = jobs[next++]
      if (job === undefined) return
      if (deps.resume && existsSync(ledgerPath(paths, job.scenario.name, job.arm.name, job.rep))) {
        progress.completed += 1
        publish()
        continue
      }
      const active = { scenario: job.scenario.name, arm: job.arm.name, rep: job.rep, turn: 0, turns: job.scenario.prompts.length, startedAt: new Date().toISOString() }
      progress.active.push(active)
      publish()
      let ledger: RunLedger | undefined
      try {
        ledger = await runJob(job, plan, deps, base, (turn) => { active.turn = turn; publish() })
      } catch (error) {
        deps.log?.(`!! ${job.scenario.name}/${job.arm.name}#${job.rep}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        progress.active = progress.active.filter(a => a !== active)
      }
      progress.completed += 1
      if (ledger === undefined || ledger.error !== undefined) progress.failed += 1
      if (ledger !== undefined) {
        progress.usd += ledger.totals.usd
        const entry: Progress['recent'][number] = { scenario: ledger.scenario, arm: ledger.arm, rep: ledger.rep, ok: ledger.verdict?.ok ?? null, usd: ledger.totals.usd, wallMs: ledger.wallMs }
        if (ledger.error !== undefined) entry.error = ledger.error
        progress.recent = [entry, ...progress.recent].slice(0, 12)
        deps.onLedger?.(ledger)
      }
      publish()
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(plan.concurrency, jobs.length)) }, () => worker())
  await Promise.all(workers)
  progress.status = deps.signal?.aborted || overBudget ? 'cancelled' : 'done'
  if (overBudget) progress.error = `budget of $${deps.maxUsd!.toFixed(2)} reached after ${progress.completed}/${progress.total} trials`
  publish()
  return progress
}

async function runJob(job: JobSpec, plan: RunPlan, deps: RunDeps, base: { noNetwork: string; network: string }, onTurn: (turn: number) => void): Promise<RunLedger> {
  const { scenario, arm } = job
  const workRoot = deps.workRoot ?? tmpdir()
  mkdirSync(workRoot, { recursive: true })
  const workdir = mkdtempSync(join(workRoot, `dsh-eval-${sanitize(scenario.name)}-${sanitize(arm.name)}-`))
  const startedAt = new Date()
  const events: EventLike[] = []
  const turnWall = new Map<number, number>()
  let sessionId: string | null = null
  let sessions = 1
  let error: string | undefined
  let verdict: Verdict | null = null
  const timeoutMs = deps.turnTimeoutMs ?? (scenario.meta.turn_timeout_s !== undefined ? scenario.meta.turn_timeout_s * 1000 : DEFAULT_TURN_TIMEOUT_MS)
  let restoreTruth: (() => void) | undefined
  try {
    await scenarioSetup(scenario, workdir)
    restoreTruth = stashTruth(workdir, join(workRoot, '.truth-stash'))
    const overlays = [scenario.meta.network ? base.network : base.noNetwork, ...armOverlays(arm)]
    const breaks = new Set(scenario.meta.new_session_before_turns ?? [])
    const makeDriver = (): Driver => deps.driverFactory({ arm, scenario, workdir, evalHome: deps.evalHome, overlays, env: { ...deps.env, ...(arm.env ?? {}) } })
    let driver = makeDriver()
    // A fresh session numbers its turns from 1 again; the ledger keeps one global turn axis.
    let turnOffset = 0
    try {
      for (let i = 0; i < scenario.prompts.length; i += 1) {
        if (i > 0 && breaks.has(i + 1)) {
          await driver.close()
          sessions += 1
          turnOffset = i
          driver = makeDriver()
        }
        onTurn(i + 1)
        const t0 = Date.now()
        const options: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs }
        if (deps.signal !== undefined) options.signal = deps.signal
        const result = await driver.runTurn(scenario.prompts[i]!, options)
        turnWall.set(i + 1, Date.now() - t0)
        events.push(...(turnOffset === 0 ? result.events : result.events.map(e => offsetTurn(e, turnOffset))))
        if (result.sessionId !== null) sessionId = sessionId === null || sessionId === result.sessionId ? result.sessionId : `${sessionId},${result.sessionId}`
      }
    } finally {
      await driver.close()
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  try {
    restoreTruth?.()
    verdict = await scenarioVerify(scenario, workdir)
  } catch (e) {
    verdict = { ok: false, detail: `verify failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  const endedAt = new Date()
  const eventsFile = join('ledgers', scenario.name, arm.name, `rep${job.rep}.events.jsonl`)
  const traceFile = join('ledgers', scenario.name, arm.name, `rep${job.rep}.trace.jsonl`)
  const input = {
    runId: plan.id,
    scenario: scenario.name,
    arm: arm.name,
    rep: job.rep,
    order: job.order,
    startedAt,
    endedAt,
    provider: arm.provider,
    model: arm.model,
    events,
    turnWall,
    verdict,
    sessionId,
    workdir,
    eventsFile,
    traceFile,
    sessions,
    ...(deps.prices !== undefined ? { prices: deps.prices } : {}),
    ...(error !== undefined ? { error } : {}),
  }
  const { ledger, trace } = buildLedger(input)
  mkdirSync(join(deps.paths.dir, 'ledgers', scenario.name, arm.name), { recursive: true })
  writeFileSync(join(deps.paths.dir, eventsFile), events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''))
  writeFileSync(join(deps.paths.dir, traceFile), trace.map(t => JSON.stringify(t)).join('\n') + (trace.length ? '\n' : ''))
  writeLedger(deps.paths, ledger)
  deps.log?.(`${ledger.verdict?.ok ? '✓' : '✗'} ${scenario.name}/${arm.name}#${job.rep} · $${ledger.totals.usd.toFixed(4)} · ${ledger.totals.steps} steps · ${(ledger.wallMs / 1000).toFixed(0)}s${error !== undefined ? ` · ERROR ${error}` : ''}`)
  if (!deps.keepWorkdirs && error === undefined) rmSync(workdir, { recursive: true, force: true })
  return ledger
}
