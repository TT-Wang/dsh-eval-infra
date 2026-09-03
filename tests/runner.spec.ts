import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listScenarios } from '../src/core/scenario.js'
import { selfcheckAll } from '../src/core/selfcheck.js'
import { resolveArm } from '../src/core/arms.js'
import { executeRun, planJobs } from '../src/core/runner.js'
import { buildReport, renderMarkdown } from '../src/core/report.js'
import { readLedgers, runPaths, listRuns, writeJsonAtomic } from '../src/core/store.js'
import type { RunPlan } from '../src/core/types.js'
import { scriptedDriverFactory } from './helpers.js'

const FIXTURES = join(__dirname, 'fixtures', 'scenarios')
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('scenarios', () => {
  it('loads the fixture library and validates shape', () => {
    const { scenarios, invalid } = listScenarios(FIXTURES)
    expect(scenarios.map(s => s.name)).toEqual(['t1_write_answer', 't2_broken'])
    expect(invalid).toEqual([])
    expect(listScenarios(FIXTURES, { names: ['t1*'] }).scenarios).toHaveLength(1)
  })
  it('excludes holdout scenarios unless asked', () => {
    const { scenarios } = listScenarios(FIXTURES)
    const t1 = scenarios.find(s => s.name === 't1_write_answer')!
    t1.meta.holdout = true
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-holdout-')); tmp.push(dir)
    const { mkdirSync, writeFileSync, cpSync } = require('node:fs') as typeof import('node:fs')
    cpSync(join(FIXTURES, 't1_write_answer'), join(dir, 't1_write_answer'), { recursive: true })
    mkdirSync(join(dir, 't1_write_answer'), { recursive: true })
    const meta = JSON.parse(readFileSync(join(dir, 't1_write_answer', 'meta.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(dir, 't1_write_answer', 'meta.json'), JSON.stringify({ ...meta, holdout: true }))
    expect(listScenarios(dir).scenarios).toHaveLength(0)
    expect(listScenarios(dir, { includeHoldout: true }).scenarios).toHaveLength(1)
  })
  it('strict selfcheck reports oracle outputs the verifier ignores', async () => {
    const { selfcheckScenario } = await import('../src/core/selfcheck.js')
    const { scenarios } = listScenarios(FIXTURES, { names: ['t1*'] })
    const r = await selfcheckScenario(scenarios[0]!, tmpdir(), { strict: true })
    expect(r.ok).toBe(true)
    expect(r.mutated).toBe(1)
    expect(r.nonDiscriminating).toEqual([])
  })
  it('selfcheck catches a verifier that accepts an untouched workspace', async () => {
    const { scenarios } = listScenarios(FIXTURES)
    const results = await selfcheckAll(scenarios)
    const byName = Object.fromEntries(results.map(r => [r.name, r]))
    expect(byName['t1_write_answer']).toMatchObject({ ok: true, blankPasses: false, oraclePasses: true })
    expect(byName['t2_broken']).toMatchObject({ ok: false, blankPasses: true })
  })
})

function makePlan(root: string, overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    id: 'test-run',
    createdAt: new Date().toISOString(),
    baseline: { name: 'base' },
    candidates: [{ name: 'cand', patches: [{ id: 'tool-web', disabled: true }] }],
    scenarios: ['t1_write_answer'],
    repeats: 3,
    concurrency: 2,
    scenarioRoot: FIXTURES,
    ...overrides,
  }
}

describe('runner + ledger + report', () => {
  it('interleaves scenario → repeat → arm', () => {
    const { scenarios } = listScenarios(FIXTURES, { names: ['t1*'] })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(dir)
    const arms = [resolveArm({ name: 'base' }, dir), resolveArm({ name: 'cand' }, dir)]
    const jobs = planJobs(scenarios, arms, 2)
    expect(jobs.map(j => `${j.rep}:${j.arm.name}`)).toEqual(['1:base', '1:cand', '2:cand', '2:base'])
  })

  it('runs a paired plan through a scripted driver and reports a cheaper candidate with no regressions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root)
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
    const progressSeen: number[] = []
    const progress = await executeRun(plan, scenarios, arms, {
      driverFactory: scriptedDriverFactory({ costScale: { cand: 0.5 } }),
      evalHome: join(root, 'home'),
      paths,
      env: {},
      onProgress: p => progressSeen.push(p.completed),
      workRoot: join(root, 'work'),
    })
    expect(progress.status).toBe('done')
    expect(progress.total).toBe(6)
    expect(progress.completed).toBe(6)
    expect(progress.failed).toBe(0)
    expect(progressSeen.at(-1)).toBe(6)
    const ledgers = readLedgers(paths)
    expect(ledgers).toHaveLength(6)
    const base = ledgers.find(l => l.arm === 'base' && l.rep === 1)!
    expect(base.verdict).toEqual({ ok: true, detail: 'ok' })
    expect(base.totals.turns).toBe(2)
    expect(base.totals.steps).toBe(5)
    expect(base.totals.miss).toBe(5000)
    expect(base.totals.output).toBe(1000)
    expect(base.totals.hit).toBe(8000 * 3)
    expect(base.steps[0]!.band).toBe('offpeak')
    expect(base.totals.usd).toBeCloseTo(base.totals.usdOffpeak, 10)
    expect(base.totals.usdPeak).toBeCloseTo(base.totals.usdOffpeak * 2, 10)
    expect(base.resolvedEffort).toBe('high')
    expect(base.tools).toEqual(['read', 'write'])
    expect(base.toolHistogram).toEqual({ read: 2, write: 1 })
    expect(base.turns.map(t => t.end)).toEqual(['completed', 'completed'])
    expect(existsSync(join(paths.dir, base.eventsFile))).toBe(true)
    expect(readFileSync(join(paths.dir, base.traceFile), 'utf8').split('\n').filter(Boolean)).toHaveLength(5)
    // the overlay written for the candidate carries its patch rows
    expect(readFileSync(arms[1]!.overlayPath, 'utf8')).toContain('tool-web')

    const report = buildReport(plan, ledgers)
    const c = report.candidates[0]!
    expect(c.gate).toBe('pass')
    expect(c.regressions).toEqual([])
    expect(c.scenarios[0]!.class).toBe('same')
    expect(c.scenarios[0]!.costPairs).toBe(3)
    expect(c.scenarios[0]!.costDiffPct).toBeCloseTo(-50, 0)
    expect(c.costPctCI.n).toBe(1)
    expect(c.verdict).toMatch(/cost/i)
    expect(c.summary.candidate.passAllK).toBe(1)
    expect(c.summary.baseline.tokensPerSolved).toBeGreaterThan(0)
    const md = renderMarkdown(report)
    expect(md).toContain('t1_write_answer')
    expect(md).toContain('| 3/3 | 3/3 |')
    expect(listRuns(root)[0]).toMatchObject({ id: 'test-run', status: 'done', completed: 6, total: 6 })
  })

  it('flags a regression and refuses to compare cost; records runtime errors as failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root, { repeats: 2, candidates: [{ name: 'bad' }, { name: 'crash' }] })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
    const progress = await executeRun(plan, scenarios, arms, {
      driverFactory: scriptedDriverFactory({ failing: ['bad'], crashing: ['crash'] }),
      evalHome: join(root, 'home'),
      paths,
      env: {},
      workRoot: join(root, 'work'),
      keepWorkdirs: false,
    })
    expect(progress.completed).toBe(6)
    expect(progress.failed).toBe(2) // the two crash runs
    const ledgers = readLedgers(paths)
    const crash = ledgers.find(l => l.arm === 'crash')!
    expect(crash.error).toMatch(/exploded/)
    expect(crash.turns).toHaveLength(1)
    const report = buildReport(plan, ledgers)
    const bad = report.candidates.find(c => c.arm === 'bad')!
    expect(bad.gate).toBe('regressions')
    expect(bad.regressions).toEqual(['t1_write_answer'])
    expect(bad.scenarios[0]!.costPairs).toBe(0)
    expect(bad.verdict).toMatch(/REGRESSION/)
    const crashed = report.candidates.find(c => c.arm === 'crash')!
    expect(crashed.gate).toBe('regressions')
    expect(report.notes.join(' ')).toMatch(/runtime error/)
  })

  it('starts a fresh runtime before turns listed in new_session_before_turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root, { repeats: 1, candidates: [] })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const s = scenarios[0]!
    s.meta.new_session_before_turns = [2]
    const arms = [resolveArm(plan.baseline, paths.arms)]
    let created = 0
    const inner = scriptedDriverFactory()
    await executeRun(plan, [s], arms, {
      driverFactory: (input) => { created += 1; return inner(input) },
      evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work'),
    })
    expect(created).toBe(2)
    const ledger = readLedgers(paths)[0]!
    expect(ledger.sessions).toBe(2)
    expect(ledger.turns).toHaveLength(2)
    expect(ledger.verdict?.ok).toBe(true)
  })

  it('sequential mode stops early once the paired sequences decide, and reports unrun scenarios as not run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const { scenarios } = listScenarios(FIXTURES, { names: ['t1*'] })
    // eight copies of the same scenario under different names → a pool where the candidate is always 40% cheaper
    const pool = Array.from({ length: 8 }, (_, i) => ({ ...scenarios[0]!, name: `t1_copy${i}` }))
    const plan = makePlan(root, { repeats: 1, concurrency: 1, scenarios: pool.map(s => s.name) })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
    const decisions: number[] = []
    const progress = await executeRun(plan, pool, arms, {
      driverFactory: scriptedDriverFactory({ costScale: { cand: 0.6 } }),
      evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work'),
      sequential: { seed: 1, onDecision: d => decisions.push(d.scenarios) },
    })
    expect(progress.status).toBe('done')
    expect(progress.stoppedEarly).toBeDefined()
    expect(progress.stoppedEarly!.after).toBeLessThan(8)
    expect(progress.stoppedEarly!.after).toBeGreaterThanOrEqual(3)
    const report = buildReport(plan, readLedgers(paths))
    expect(report.candidates[0]!.scenarios.filter(p => p.class === 'unrun').length).toBe(8 - progress.stoppedEarly!.after)
    expect(report.candidates[0]!.gate).toBe('pass')
  })

  it('stops scheduling trials once the budget is reached and keeps finished ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root, { repeats: 3, concurrency: 1 })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
    const progress = await executeRun(plan, scenarios, arms, { driverFactory: scriptedDriverFactory(), evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work'), maxUsd: 0.005 })
    expect(progress.status).toBe('cancelled')
    expect(progress.error).toMatch(/budget/)
    expect(progress.completed).toBeGreaterThan(0)
    expect(progress.completed).toBeLessThan(6)
    expect(readLedgers(paths)).toHaveLength(progress.completed)
  })

  it('records observations and behaviour metrics from tool results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root, { repeats: 1, candidates: [] })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const arms = [resolveArm(plan.baseline, paths.arms)]
    await executeRun(plan, scenarios, arms, { driverFactory: scriptedDriverFactory(), evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work') })
    const l = readLedgers(paths)[0]!
    expect(l.behaviour).toEqual({ toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 })
    const trace = readFileSync(join(paths.dir, l.traceFile), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x) as { observations: unknown[] })
    expect(trace[0]!.observations).toHaveLength(1)
  })

  it('resumes without re-running finished jobs and honours cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-test-')); tmp.push(root)
    const plan = makePlan(root, { repeats: 2, concurrency: 1 })
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
    const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
    const ac = new AbortController()
    let runs = 0
    const counting = scriptedDriverFactory()
    const first = await executeRun(plan, scenarios, arms, {
      driverFactory: (input) => { runs += 1; if (runs === 2) ac.abort(); return counting(input) },
      evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work'), signal: ac.signal,
    })
    expect(first.status).toBe('cancelled')
    expect(readLedgers(paths).length).toBeLessThan(4)
    const before = readLedgers(paths).length
    const second = await executeRun(plan, scenarios, arms, {
      driverFactory: (input) => { runs += 1; return counting(input) }, evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work'), resume: true,
    })
    expect(second.status).toBe('done')
    expect(readLedgers(paths)).toHaveLength(4)
    expect(runs).toBe(2 + (4 - before))
  })
})
