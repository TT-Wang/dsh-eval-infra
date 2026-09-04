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

describe('ledger rebuild', () => {
  it('re-derives ledgers from events without losing verdicts', async () => {
    const { rebuildLedgers } = await import('../src/core/orchestrate.js')
    const project = loadProject(root)
    const n = await rebuildLedgers(project, 'r1')
    expect(n).toBe(4)
    const ledgers = readLedgers(runPaths(project.runsRoot, 'r1'))
    expect(ledgers.every(l => l.verdict?.ok === true)).toBe(true)
    expect(ledgers.every(l => l.steps.every(st => typeof st.durationMs === 'number'))).toBe(true)
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

describe('new-run arm selection', () => {
  it('never keeps the baseline in the candidate list when the baseline changes', async () => {
    const { pickCandidates } = await import('../src/ui/select-arms.js')
    const arms = ['baseline', 'candidate', 'fold']
    // the reported bug: baseline switched to the arm that was the candidate
    expect(pickCandidates(['candidate'], 'candidate', arms)).toEqual(['baseline'])
    // an unrelated candidate survives the switch
    expect(pickCandidates(['candidate', 'fold'], 'candidate', arms)).toEqual(['fold'])
    // arms that no longer exist are dropped
    expect(pickCandidates(['gone'], 'baseline', arms)).toEqual(['candidate'])
    // a single arm leaves nothing to compare, and the form must not invent one
    expect(pickCandidates(['baseline'], 'baseline', ['baseline'])).toEqual([])
  })
})

describe('arm editing over the API', () => {
  it('saves a new arm, refuses a mismatched name or bad YAML, and deletes it', async () => {
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${url.replace(/\/$/, '')}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
      return { status: res.status, json: await res.json().catch(() => null) }
    }
    const created = await call('PUT', '/arms/fold', { text: "name: fold\ndescription: baseline + folding\npatches:\n  - insert:\n      - id: fold\n        name: '@x/fold'\n" })
    expect(created.status).toBe(200)
    expect(created.json.saved).toBe('fold.yml')
    const listed = await call('GET', '/arms')
    expect(listed.json.arms.map((a: { spec?: { name: string } }) => a.spec?.name)).toContain('fold')
    // the file must name the arm it is saved as, or a rename silently produces two arms
    expect((await call('PUT', '/arms/other', { text: 'name: fold\n' })).status).toBe(400)
    expect((await call('PUT', '/arms/fold', { text: 'name: fold\npatches: not-a-list\n' })).status).toBe(400)
    expect((await call('PUT', '/arms/bad%20name', { text: 'name: x\n' })).status).toBe(400)
    expect((await call('PUT', '/arms/fold', { text: '   ' })).status).toBe(400)
    expect((await call('DELETE', '/arms/fold')).status).toBe(200)
    expect((await call('DELETE', '/arms/fold')).status).toBe(404)
  })
})

describe('arm yaml builder', () => {
  it('writes one variable per change kind', async () => {
    const { armYaml } = await import('../src/ui/arm-yaml.js')
    expect(armYaml('a', 'x', 'insert-plugin', { plugin: '@dsh-external/dsh-tool-result-fold' })).toContain("- id: tool-result-fold")
    expect(armYaml('a', '', 'disable-row', { row: 'tool-web' })).toContain('disabled: true')
    expect(armYaml('a', '', 'config-field', { row: 'compaction-basic', key: 'thresholdRatio', value: '0.6' })).toContain('thresholdRatio: 0.6')
    expect(armYaml('a', '', 'model', { model: 'deepseek-v4-pro' })).toContain('model: deepseek-v4-pro')
    expect(armYaml('a', '', 'effort', { effort: 'max' })).toContain('effort: max')
    expect(armYaml('a', 'note', 'freeform', {})).toBe('name: a\ndescription: note\npatches: []\n')
  })
})

describe('arm design model', () => {
  it('round-trips an arm file through the designer without losing anything', async () => {
    const { designFromSpec, armToYaml, variableCount, describeRow } = await import('../src/ui/arm-model.js')
    const { parseArm } = await import('../src/core/arms.js')
    const text = [
      'name: candidate',
      'description: fold plus a tighter pruner',
      'patches:',
      '  - insert:',
      '      - id: tool-result-fold',
      "        name: '@dsh-external/dsh-tool-result-fold'",
      '        config:',
      '          pinSteps: 2',
      '  - id: tool-web',
      '    disabled: true',
      '  - id: tool-result-pruner',
      '    config:',
      '      headChars: 1024',
      '',
    ].join('\n')
    const design = designFromSpec(parseArm(text))
    expect(design.rows.map(r => r.kind)).toEqual(['insert', 'disable', 'config'])
    expect(variableCount(design)).toBe(3)
    expect(describeRow(design.rows[0]!)).toBe('@dsh-external/dsh-tool-result-fold')
    expect(describeRow(design.rows[1]!)).toBe('tool-web turned off')
    // serialising and re-parsing must yield the same design
    const again = designFromSpec(parseArm(armToYaml(design)))
    expect(again).toEqual(design)
    expect(armToYaml(design)).toContain('pinSteps: 2')

    // an arm with no differences is still a valid file, and model counts as a variable
    const empty = { name: 'baseline', rows: [] }
    expect(armToYaml(empty)).toBe('name: baseline\npatches: []\n')
    expect(variableCount({ name: 'pro', rows: [], model: 'deepseek-v4-pro' })).toBe(1)
    expect(armToYaml({ name: 'pro', rows: [], model: 'deepseek-v4-pro' })).toBe('name: pro\nmodel: deepseek-v4-pro\n')

    // a hand-written row the designer does not model is carried through untouched
    const exotic = designFromSpec(parseArm('name: x\npatches:\n  - remove: [tool-web]\n'))
    expect(exotic.rows[0]!.kind).toBe('raw')
    expect(armToYaml(exotic)).toContain('{"remove":["tool-web"]}')
  })
})

describe('replacement plugins', () => {
  it('reads a plugin\'s own patch, counts it as one variable, and says which file each row came from', async () => {
    const { summarisePatch } = await import('../src/core/plugins.js')
    const { rowsTouchedBy, describeDiff } = await import('../src/core/plan.js')
    const { designFromSpec, armToYaml, variableCount } = await import('../src/ui/arm-model.js')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const patch = [
      '- id: agent-loop', '  disabled: true',
      '- id: compaction-basic', '  disabled: true',
      '- insert:', '    - id: slice-agent-loop', "      name: '@x/slice'", '',
    ].join('\n')
    expect(summarisePatch(patch)).toEqual({ replaces: ['agent-loop', 'compaction-basic'], inserts: ['slice-agent-loop'] })
    expect(summarisePatch('not: a list')).toEqual({ replaces: [], inserts: [] })

    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-patch-'))
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, patch)
    expect(rowsTouchedBy(file).sort()).toEqual(['agent-loop', 'compaction-basic', 'slice-agent-loop'])
    expect(rowsTouchedBy(join(dir, 'absent.yml'))).toEqual([])

    // three rows move, but one file did it, so the one-variable rule sees one decision
    const diff: import('../src/core/plan.js').ArmDiff = {
      candidate: 'slice',
      rows: [
        { id: 'agent-loop', kind: 'changed' as const, fields: ['disabled'] },
        { id: 'compaction-basic', kind: 'changed' as const, fields: ['disabled'] },
        { id: 'slice-agent-loop', kind: 'added' as const, fields: [], after: { name: '@x/slice' } },
      ],
      route: [],
      variables: 1,
      patchSources: [{ file, rows: ['agent-loop', 'compaction-basic', 'slice-agent-loop'] }],
    }
    const lines = describeDiff(diff)
    expect(lines.every(l => l.includes('via'))).toBe(true)

    // the designer carries the whole patch as one card and writes it back as a patch file
    const design = designFromSpec({ name: 'slice', patchFiles: [file] }, [{ name: '@x/slice', bundlePatch: file, replaces: ['agent-loop', 'compaction-basic'], inserts: ['slice-agent-loop'] }])
    expect(design.rows).toHaveLength(1)
    expect(design.rows[0]).toMatchObject({ kind: 'bundle', name: '@x/slice' })
    expect(variableCount(design)).toBe(1)
    expect(armToYaml(design)).toContain(`patchFiles:\n  - ${file}`)
  })
})

describe('profile bundles', () => {
  it('reads and rewrites the bundle list a profile activates', async () => {
    const { profileBundles, setProfileBundles, ensureEvalProfile } = await import('../src/core/project.js')
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'dsh-eval-home-'))
    ensureEvalProfile(home, 'eval')
    const manifest = join(home, 'profiles', 'eval', 'package.json')
    const base = profileBundles(home, 'eval')
    expect(base.length).toBeGreaterThan(0)

    // what installing a bundle plugin does, and what taking it back out must restore
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh: { profile: { bundles: string[]; patchReload?: string } } }
    const activated = [...base, '@x/replacement']
    setProfileBundles(home, 'eval', activated)
    expect(profileBundles(home, 'eval')).toEqual(activated)
    setProfileBundles(home, 'eval', base)
    expect(profileBundles(home, 'eval')).toEqual(base)
    // the rest of the manifest survives the rewrite
    const after = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; dsh: { profile: { patchReload?: string } } }
    expect(after.name).toBe(parsed === null ? '' : (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name)
    expect(after.dsh.profile.patchReload).toBe(parsed.dsh.profile.patchReload)
    expect(profileBundles(join(home, 'nope'), 'eval')).toEqual([])
    writeFileSync(manifest, 'not json')
    expect(profileBundles(home, 'eval')).toEqual([])
  })
})
