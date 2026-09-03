import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/server/index.js'
import { loadProject, ensureEvalProfile } from '../src/core/project.js'
import { listScenarios } from '../src/core/scenario.js'
import { resolveArm } from '../src/core/arms.js'
import { executeRun } from '../src/core/runner.js'
import { buildReport, renderMarkdown } from '../src/core/report.js'
import { readLedgers, runPaths, writeJsonAtomic } from '../src/core/store.js'
import type { RunPlan } from '../src/core/types.js'
import { scriptedDriverFactory } from './helpers.js'
import { apply } from '../src/index.js'

const FIXTURES = join(__dirname, 'fixtures', 'scenarios')
let root: string
let url: string
let close: () => void

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-eval-server-'))
  mkdirSync(join(root, '.dsh-eval'), { recursive: true })
  writeFileSync(join(root, '.dsh-eval', 'config.json'), JSON.stringify({ profile: 'eval', repeats: 2, concurrency: 1, scenarioRoot: FIXTURES }))
  const project = loadProject(root)
  ensureEvalProfile(project.home, 'eval')
  mkdirSync(project.armsDir, { recursive: true })
  writeFileSync(join(project.armsDir, 'baseline.yml'), 'name: baseline\n')
  writeFileSync(join(project.armsDir, 'cand.yml'), 'name: cand\npatches:\n  - id: tool-web\n    disabled: true\n')
  // a finished run produced by the scripted driver
  const plan: RunPlan = { id: 'r1', createdAt: new Date().toISOString(), baseline: { name: 'baseline' }, candidates: [{ name: 'cand' }], scenarios: ['t1_write_answer'], repeats: 2, concurrency: 1, scenarioRoot: FIXTURES }
  const paths = runPaths(project.runsRoot, plan.id)
  writeJsonAtomic(paths.plan, plan)
  const { scenarios } = listScenarios(FIXTURES, { names: plan.scenarios })
  const arms = [resolveArm(plan.baseline, paths.arms), ...plan.candidates.map(c => resolveArm(c, paths.arms))]
  await executeRun(plan, scenarios, arms, { driverFactory: scriptedDriverFactory({ costScale: { cand: 0.5 } }), evalHome: project.home, paths, env: {}, workRoot: join(root, 'work') })
  const report = buildReport(plan, readLedgers(paths))
  writeJsonAtomic(paths.report, report)
  writeFileSync(paths.reportMd, renderMarkdown(report))
  const started = await startServer({ project, port: 0, uiDir: join(root, 'no-ui') })
  url = started.url
  close = () => started.server.close()
})
afterAll(() => { close(); rmSync(root, { recursive: true, force: true }) })

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const r = await fetch(url.replace(/\/$/, '') + path)
  return { status: r.status, body: await r.json() as T }
}

describe('http api', () => {
  it('serves meta, runs, scenarios and arms', async () => {
    const meta = await get<{ profile: string; profileReady: boolean; defaults: { repeats: number } }>('/api/meta')
    expect(meta.status).toBe(200)
    expect(meta.body.profile).toBe('eval')
    expect(meta.body.profileReady).toBe(true)
    expect(meta.body.defaults.repeats).toBe(2)
    const runs = await get<Array<{ id: string; status: string }>>('/api/runs')
    expect(runs.body).toHaveLength(1)
    expect(runs.body[0]).toMatchObject({ id: 'r1', status: 'done' })
    const scen = await get<{ scenarios: Array<{ name: string }> }>('/api/scenarios')
    expect(scen.body.scenarios.map(s => s.name)).toEqual(['t1_write_answer', 't2_broken'])
    const arms = await get<{ arms: Array<{ spec?: { name: string } }> }>('/api/arms')
    expect(arms.body.arms.map(a => a.spec?.name)).toEqual(['baseline', 'cand'])
  })
  it('serves run detail, report, ledgers, trace, events and atif', async () => {
    const detail = await get<{ plan: { id: string }; report: { candidates: Array<{ gate: string }> } | null; active: boolean }>('/api/runs/r1')
    expect(detail.body.plan.id).toBe('r1')
    expect(detail.body.report?.candidates[0]?.gate).toBe('pass')
    expect(detail.body.active).toBe(false)
    const ledgers = await get<Array<{ arm: string; steps: Array<{ calls: string[] }> }>>('/api/runs/r1/ledgers')
    expect(ledgers.body).toHaveLength(4)
    expect(ledgers.body[0]!.steps[0]!.calls).toEqual(['read'])
    const trace = await get<Array<{ turn: number }>>('/api/runs/r1/ledgers/t1_write_answer/cand/rep1/trace')
    expect(trace.body).toHaveLength(5)
    const events = await get<Array<{ type: string }>>('/api/runs/r1/ledgers/t1_write_answer/cand/rep1/events')
    expect(events.body.some(e => e.type === 'assistant/message')).toBe(true)
    const atif = await get<{ schema_version: string; steps: Array<{ source: string }>; final_metrics: { total_steps: number } }>('/api/runs/r1/ledgers/t1_write_answer/cand/rep1/atif')
    expect(atif.body.schema_version).toBe('ATIF-v1.8')
    expect(atif.body.steps[0]!.source).toBe('user')
    expect(atif.body.final_metrics.total_steps).toBe(7)
    const missing = await get<{ error: string }>('/api/runs/nope')
    expect(missing.status).toBe(404)
  })
  it('aggregates scenario history across runs and annotates the runs list with verdicts', async () => {
    const h = await get<{ arms: string[]; scenarios: Array<{ name: string; cells: Record<string, { runs: number; passes: number }> }> }>('/api/history')
    expect(h.body.arms).toEqual(['baseline', 'cand'])
    expect(h.body.scenarios[0]!.name).toBe('t1_write_answer')
    expect(h.body.scenarios[0]!.cells['cand']).toMatchObject({ runs: 2, passes: 2 })
    const runs = await get<Array<{ verdicts?: Array<{ arm: string; gate: string }> }>>('/api/runs')
    expect(runs.body[0]!.verdicts?.[0]).toMatchObject({ arm: 'cand', gate: 'pass' })
  })
  it('stores human annotations and applies them to the report', async () => {
    const put = await fetch(url + 'api/runs/r1/annotations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 't1_write_answer', arm: 'cand', rep: 1, verdict: false, note: 'wrong sum on inspection', by: 'tester' }) })
    expect(put.status).toBe(200)
    const body = await put.json() as { report: { candidates: Array<{ scenarios: Array<{ candidate: { passes: number } }> }>; notes: string[] } }
    expect(body.report.candidates[0]!.scenarios[0]!.candidate.passes).toBe(1)
    expect(body.report.notes.join(' ')).toMatch(/overridden/)
    const ledgers = await get<Array<{ arm: string; rep: number; overridden?: boolean; verdict: { detail: string } }>>('/api/runs/r1/ledgers')
    const l = ledgers.body.find(x => x.arm === 'cand' && x.rep === 1)!
    expect(l.overridden).toBe(true)
    expect(l.verdict.detail).toMatch(/manual override/)
    const del = await fetch(url + 'api/runs/r1/annotations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 't1_write_answer', arm: 'cand', rep: 1, verdict: null, remove: true }) })
    expect(((await del.json()) as { report: { notes: string[] } }).report.notes.join(' ')).not.toMatch(/overridden/)
  })
  it('streams a finished run as a single done event', async () => {
    const r = await fetch(url + 'api/runs/r1/stream')
    const text = await r.text()
    expect(text).toContain('event: progress')
    expect(text).toContain('event: done')
  })
  it('reports a missing UI bundle instead of crashing', async () => {
    const r = await fetch(url)
    expect(r.status).toBe(404)
    expect(await r.text()).toMatch(/UI bundle not found/)
  })
})

describe('dsh plugin entry', () => {
  it('registers a prefix route and the /eval command when the services appear', async () => {
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const commands: Array<{ name: string; handler: (inv: { rawInput: string }) => { kind: string; text: string } }> = []
    const effects: Array<() => void> = []
    const scoped = {
      effect: (fn: () => () => void) => { effects.push(fn()); },
      webServer: { register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => { registered.push(route); return () => { registered.length = 0 } } },
      commands: { register: (def: { name: string; handler: (inv: { rawInput: string }) => { kind: string; text: string } }) => { commands.push(def); return () => { commands.length = 0 } } },
    }
    const ctx = { inject: (_deps: string[], cb: (c: typeof scoped) => void) => cb(scoped) }
    apply(ctx as never, { projectRoot: root, basePath: '/eval' })
    expect(registered.map(r => `${r.kind} ${r.path}`)).toEqual(['prefix /eval'])
    expect(commands.map(c => c.name)).toEqual(['eval'])
    const out = commands[0]!.handler({ rawInput: '' })
    expect(out.kind).toBe('success')
    expect(out.text).toContain('r1')
    const summary = commands[0]!.handler({ rawInput: 'r1' })
    expect(summary.text).toMatch(/cand vs baseline/)
    for (const dispose of effects) dispose()
    expect(registered).toHaveLength(0)
  })
})
