/**
 * Where the project is, what it may claim, and what to do next — the entry point
 * for the agent driving an evaluation (docs/agent-interface.md).
 *
 * Every state here is read off the disk. Nothing in this module runs a model,
 * starts a container or spends money, so an agent arriving with no context can
 * call it first and freely. Anything that would cost something to determine is
 * reported as unknown rather than guessed: `one_variable` needs both arms
 * composed through dsh, and a floor goes stale only against a run's observed
 * behaviour, which status has no way to compare.
 *
 * Codes and parameters, never sentences: the caller renders them in whatever
 * language the person is speaking.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { evalProfileManifest } from './plan.js'
import { readChecks, selfcheckStateOf, type SelfcheckState } from './checks.js'
import { MIN_SCENARIOS } from './report.js'
import { listRuns, readJson } from './store.js'
import type { Project } from './project.js'
import type { NorthStar, RunIndexEntry } from './types.js'

export type PhaseCode = 'profile' | 'arms' | 'one_variable' | 'scenarios' | 'selfcheck' | 'floor' | 'run'

/**
 * A run publishes progress on every turn, so a progress file this old belongs to
 * a process that is gone: the run reads `abandoned`, not `running`. Without this
 * a crashed run tells every later caller to keep polling it, forever.
 */
export const ABANDONED_AFTER_MS = 30 * 60 * 1000

/** A reason, as a code the caller renders. `gloss` is for logs, never for the user. */
export interface Reason {
  code: string
  gloss?: string
  [param: string]: unknown
}

export interface Phase {
  code: PhaseCode
  state: string
  [detail: string]: unknown
}

export interface ReadingAvailability {
  /** Nothing determinable blocks this reading. Not a promise that the data will support it. */
  attainable: boolean
  missing?: Reason[]
}

export interface NextStep {
  reason: Reason
  tool: string
  args?: Record<string, unknown>
}

export interface ProjectStatus {
  schema: 'dsh-eval-status/1'
  project: { root: string; profile: string; scenarioRoot: string }
  phases: Phase[]
  /** The first phase that is not `ok`, or null when the project is ready to run. */
  blocked: PhaseCode | null
  readings: Record<string, ReadingAvailability>
  runs: Array<RunIndexEntry & { sealed?: boolean; gate?: string }>
  next: NextStep
}

export interface StatusOptions {
  /** Most recent runs to describe (default 5). */
  runs?: number
}

/** Arm files in the project: `<name>.yml`, excluding patch files and the composed records a run writes. */
export function armNames(project: Project): string[] {
  if (!existsSync(project.armsDir)) return []
  return readdirSync(project.armsDir)
    .filter(f => /\.ya?ml$/.test(f) && !/\.patch\.ya?ml$/.test(f) && !/\.composed\.ya?ml$/.test(f) && !f.startsWith('_'))
    .map(f => f.replace(/\.ya?ml$/, ''))
    .sort()
}

export async function projectStatus(project: Project, options: StatusOptions = {}): Promise<ProjectStatus> {
  const phases: Phase[] = []
  const readings: Record<string, ReadingAvailability> = {}

  // 1. profile
  const profile = evalProfileManifest(project.home, project.config.profile)
  phases.push({ code: 'profile', state: profile.exists ? 'ok' : 'missing', name: project.config.profile })

  // 2. arms — by convention the baseline is `baseline`; without it the first arm alphabetically stands in.
  const arms = armNames(project)
  const baseline = arms.includes('baseline') ? 'baseline' : arms[0]
  const candidates = arms.filter(a => a !== baseline)
  phases.push({
    code: 'arms',
    state: baseline === undefined ? 'no_baseline' : candidates.length === 0 ? 'no_candidate' : 'ok',
    ...(baseline !== undefined ? { baseline } : {}),
    candidates,
  })

  // 3. one variable — composing both arms through dsh costs a second or two and is a tool of its own.
  phases.push({ code: 'one_variable', state: 'unchecked', tool: 'arms.diff' })

  // 4. scenarios
  const { collectScenarios } = await import('./orchestrate.js')
  let scenarios: Array<{ name: string; dir: string; meta: { judge?: unknown; holdout?: boolean; runtime?: string } }> = []
  try { scenarios = collectScenarios(project, {}).scenarios } catch { scenarios = [] }
  phases.push({ code: 'scenarios', state: scenarios.length > 0 ? 'ok' : 'none', matched: scenarios.length })

  // 5. selfcheck — from the recorded checks, against the bytes on disk now
  const checks = readChecks(project)
  const byState: Record<SelfcheckState, string[]> = { ok: [], failing: [], stale: [], never: [] }
  // A container scenario is checked inside its own image: that needs Docker and a pull of some gigabytes,
  // so it is named apart and never put in `next` — the caller decides when to pay for it.
  const needsDocker = new Set(scenarios.filter(s => s.meta.runtime === 'container').map(s => s.name))
  for (const s of scenarios) byState[selfcheckStateOf(checks.selfcheck[s.name], s.dir)].push(s.name)
  const selfcheckState = scenarios.length === 0 ? 'none'
    : byState.failing.length > 0 ? 'failing'
    : byState.never.length > 0 || byState.stale.length > 0 ? 'stale'
    : 'ok'
  phases.push({
    code: 'selfcheck',
    state: selfcheckState,
    checked: byState.ok.length,
    ...(byState.failing.length ? { failing: byState.failing } : {}),
    ...(byState.stale.length ? { changed: byState.stale } : {}),
    ...(byState.never.length ? { never: byState.never } : {}),
    ...(needsDocker.size ? { needsDocker: [...needsDocker] } : {}),
  })

  // 6. A/A floor for this baseline. `stale` is not decided here: drift is measured against a run.
  const { archiveNoiseFloors } = await import('./orchestrate.js')
  const floors = baseline === undefined ? {} : archiveNoiseFloors(project)
  const floor = baseline === undefined ? undefined : floors[baseline]
  const floorState = floor === undefined ? 'missing' : floor.scenarios < MIN_SCENARIOS ? 'thin' : 'ok'
  phases.push({
    code: 'floor',
    state: floorState,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(floor ? { runId: floor.runId, have: floor.scenarios, band: [floor.lo, floor.hi], steps: floor.steps !== undefined } : {}),
    need: MIN_SCENARIOS,
  })

  // 7. runs
  const all = listRuns(project.runsRoot).filter(r => r.kind !== 'preflight')
  const recent = all.slice(0, options.runs ?? 5).map((r) => {
    const dir = join(project.runsRoot, 'runs', r.id)
    const sealed = existsSync(join(dir, 'manifest.json'))
    let gate: string | undefined
    const reportFile = join(dir, 'report.json')
    if (existsSync(reportFile)) {
      try { gate = readJson<{ candidates?: Array<{ gate?: string }> }>(reportFile).candidates?.[0]?.gate } catch { /* unreadable report */ }
    }
    return { ...r, sealed, ...(gate !== undefined ? { gate } : {}) }
  })
  const claimsRunning = all.filter(r => r.status === 'running')
  const ageOf = (id: string): number => {
    const f = join(project.runsRoot, 'runs', id, 'progress.json')
    try { return Date.now() - statSync(f).mtimeMs } catch { return Infinity }
  }
  const running = claimsRunning.find(r => ageOf(r.id) < ABANDONED_AFTER_MS)
  const abandoned = claimsRunning.filter(r => r !== running).map(r => ({ id: r.id, idleMs: ageOf(r.id), completed: r.completed, total: r.total }))
  phases.push({
    code: 'run',
    state: running ? 'running' : all.some(r => r.status === 'done') ? 'done' : 'none',
    ...(running ? { id: running.id } : {}),
    ...(abandoned.length ? { abandoned } : {}),
    total: all.length,
  })

  // What each reading would need. `attainable` means nothing determinable blocks it, not that the data will support it.
  const scenarioShortfall: Reason[] = scenarios.length < MIN_SCENARIOS ? [{ code: 'scenarios.below_minimum', have: scenarios.length, need: MIN_SCENARIOS }] : []
  readings['reliability'] = availability(scenarioShortfall)
  const floorMissing: Reason[] = floorState === 'ok' ? []
    : [{ code: floorState === 'missing' ? 'floor.missing' : 'floor.thin', ...(baseline !== undefined ? { baseline } : {}), ...(floor ? { have: floor.scenarios } : {}), need: MIN_SCENARIOS }]
  readings['northStar.cost'] = availability([...scenarioShortfall, ...floorMissing])
  readings['northStar.efficiency'] = availability([
    ...scenarioShortfall,
    ...floorMissing,
    ...(floorState === 'ok' && floor?.steps === undefined ? [{ code: 'floor.no_step_band', runId: floor!.runId } as Reason] : []),
  ])
  const judgeScenarios = scenarios.filter(s => s.meta.judge !== undefined).length
  readings['northStar.quality'] = availability([
    ...(judgeScenarios === 0 ? [{ code: 'scenario.no_judge_rubric' } as Reason] : []),
    ...((project.config.judges ?? []).length === 0 ? [{ code: 'judge.unconfigured' } as Reason] : []),
  ])

  const blocked = phases.find(p => p.code !== 'one_variable' && p.code !== 'run' && p.state !== 'ok')?.code ?? null
  return {
    schema: 'dsh-eval-status/1',
    project: { root: project.root, profile: project.config.profile, scenarioRoot: project.scenarioRoot },
    phases,
    blocked,
    readings,
    runs: recent,
    next: nextStep(phases, blocked, baseline, byState, needsDocker),
  }
}

function availability(missing: Reason[]): ReadingAvailability {
  return missing.length === 0 ? { attainable: true } : { attainable: false, missing }
}

/** The single most useful call to make now, with the reason it is that one. */
function nextStep(phases: Phase[], blocked: PhaseCode | null, baseline: string | undefined, selfcheck: Record<SelfcheckState, string[]>, needsDocker: Set<string>): NextStep {
  const phase = (code: PhaseCode): Phase => phases.find(p => p.code === code)!
  // A run in flight outranks every setup blocker: the useful call now is "how is it going", not
  // "go measure a floor" — that one belongs to the next run, and the caller cannot act on it yet.
  const live = phase('run')
  if (live.state === 'running') return { reason: { code: 'run.in_progress', id: live['id'] }, tool: 'run.status', args: { id: live['id'] } }
  if (blocked === 'profile') return { reason: { code: 'profile.missing', profile: phase('profile')['name'] }, tool: 'init' }
  if (blocked === 'arms') {
    const state = phase('arms').state
    return { reason: { code: state === 'no_baseline' ? 'arms.no_baseline' : 'arms.no_candidate' }, tool: 'arms.write' }
  }
  if (blocked === 'scenarios') return { reason: { code: 'scenarios.none' }, tool: 'scenarios.add' }
  if (blocked === 'selfcheck') {
    const all = [...selfcheck.failing, ...selfcheck.stale, ...selfcheck.never]
    const cheap = all.filter(n => !needsDocker.has(n))
    const names = cheap.length > 0 ? cheap : all
    return {
      reason: {
        code: selfcheck.failing.length > 0 ? 'selfcheck.failing' : 'selfcheck.stale',
        scenarios: names,
        ...(cheap.length > 0 && cheap.length < all.length ? { deferred: all.filter(n => needsDocker.has(n)), deferredReason: 'selfcheck.needs_docker' } : {}),
        ...(cheap.length === 0 ? { needsDocker: true } : {}),
      },
      tool: 'scenarios.selfcheck',
      args: { scenarios: names },
    }
  }
  if (blocked === 'floor') {
    const f = phase('floor')
    return {
      reason: { code: f.state === 'missing' ? 'floor.missing' : 'floor.thin', ...(baseline !== undefined ? { baseline } : {}), need: MIN_SCENARIOS, ...(f['have'] !== undefined ? { have: f['have'] } : {}) },
      tool: 'run.start',
      args: { baseline, aa: true, repeats: 3 },
    }
  }
  const run = phase('run')
  if (run.state === 'none') return { reason: { code: 'run.none' }, tool: 'run.start', args: { baseline, repeats: 3 } }
  return { reason: { code: 'run.readable' }, tool: 'report.read' }
}

/** The north stars a caller may register, for a tool listing them. */
export const NORTH_STAR_READINGS: ReadonlyArray<`northStar.${NorthStar}`> = ['northStar.cost', 'northStar.efficiency', 'northStar.quality']
