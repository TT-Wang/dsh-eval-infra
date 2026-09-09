import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProject, ensureEvalProfile } from '../src/core/project.js'
import { projectStatus, armNames, ABANDONED_AFTER_MS } from '../src/core/status.js'
import { scenarioSha, selfcheckStateOf, readChecks, recordSelfcheck } from '../src/core/checks.js'
import { writeJsonAtomic, runPaths } from '../src/core/store.js'
import type { RunPlan } from '../src/core/types.js'

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A project with its own scenario library, so the shipped 35 do not drown the fixtures. */
function project(scenarios: Array<{ name: string; container?: boolean; judge?: boolean }> = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-status-')); tmp.push(root)
  const lib = join(root, 'bench', 'scenarios')
  mkdirSync(join(root, '.dsh-eval'), { recursive: true })
  writeFileSync(join(root, '.dsh-eval', 'config.json'), JSON.stringify({ profile: 'eval', repeats: 3, concurrency: 1, scenarioRoot: lib }))
  for (const s of scenarios) {
    const dir = join(lib, s.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      name: s.name, title: s.name, turns: 1, category: 'tools', oracle: 'none',
      ...(s.container ? { runtime: 'container', image: 'x:1', platform: 'amd64' } : {}),
      ...(s.judge ? { judge: { rubric: 'better', artifacts: ['out.md'] } } : {}),
    }))
    writeFileSync(join(dir, 'prompts.json'), JSON.stringify(['do it']))
    writeFileSync(join(dir, 'verify.py'), 'def verify(root):\n    return True, "ok"\n')
  }
  return loadProject(root)
}

const arms = (p: ReturnType<typeof project>, names: string[]): void => {
  mkdirSync(p.armsDir, { recursive: true })
  for (const n of names) writeFileSync(join(p.armsDir, `${n}.yml`), `name: ${n}\n`)
}

describe('the selfcheck record', () => {
  it('is keyed by the scenario\'s bytes, so a changed scenario reads stale rather than checked', async () => {
    const p = project([{ name: 's1' }])
    const dir = join(p.scenarioRoot, 's1')
    const before = scenarioSha(dir)
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    expect(selfcheckStateOf(undefined, dir)).toBe('never')
    recordSelfcheck(p, [{ name: 's1', ok: true, blankPasses: false, oraclePasses: null, bytes: 1, turns: 1, detail: 'ok' }], { s1: dir })
    const entry = readChecks(p).selfcheck['s1']!
    expect(entry.sha).toBe(before)
    expect(selfcheckStateOf(entry, dir)).toBe('ok')
    writeFileSync(join(dir, 'verify.py'), 'def verify(root):\n    return False, "changed"\n')
    expect(scenarioSha(dir)).not.toBe(before)
    expect(selfcheckStateOf(entry, dir)).toBe('stale')          // checked, but not these bytes
    recordSelfcheck(p, [{ name: 's1', ok: false, blankPasses: true, oraclePasses: null, bytes: 1, turns: 1, detail: 'blank passes' }], { s1: dir })
    const failing = readChecks(p).selfcheck['s1']!
    expect(selfcheckStateOf(failing, dir)).toBe('failing')
    expect(failing.detail).toBe('blank passes')
    expect(scenarioSha(join(p.scenarioRoot, 'nope'))).toBe('missing')
  })
})

describe('status: where the project is and what to do next', () => {
  it('walks the phases in order and names the first unmet one, with the call that meets it', async () => {
    const bare = project()
    const s0 = await projectStatus(bare)
    expect(s0.schema).toBe('dsh-eval-status/1')
    expect(s0.blocked).toBe('profile')
    expect(s0.next).toMatchObject({ tool: 'init', reason: { code: 'profile.missing' } })

    ensureEvalProfile(bare.home, 'eval')
    expect((await projectStatus(bare)).next).toMatchObject({ tool: 'arms.write', reason: { code: 'arms.no_baseline' } })
    arms(bare, ['baseline'])
    expect((await projectStatus(bare)).next.reason.code).toBe('arms.no_candidate')
    arms(bare, ['baseline', 'cand'])
    const noScenarios = await projectStatus(bare)
    expect(noScenarios.blocked).toBe('scenarios')
    expect(noScenarios.next).toMatchObject({ tool: 'scenarios.add' })
    expect(armNames(bare)).toEqual(['baseline', 'cand'])
  })

  it('holds container scenarios back from the next step, because checking one pulls an image', async () => {
    const p = project([{ name: 'plain1' }, { name: 'plain2' }, { name: 'task1', container: true }])
    ensureEvalProfile(p.home, 'eval')
    arms(p, ['baseline', 'cand'])
    const st = await projectStatus(p)
    expect(st.blocked).toBe('selfcheck')
    const phase = st.phases.find(x => x.code === 'selfcheck')!
    expect(phase.state).toBe('stale')
    expect(phase['never']).toEqual(['plain1', 'plain2', 'task1'])
    expect(phase['needsDocker']).toEqual(['task1'])
    expect(st.next.args).toEqual({ scenarios: ['plain1', 'plain2'] })            // the cheap ones
    expect(st.next.reason['deferred']).toEqual(['task1'])
    expect(st.next.reason['deferredReason']).toBe('selfcheck.needs_docker')
  })

  it('says which readings are out of reach and why, before anything has run', async () => {
    const p = project([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    ensureEvalProfile(p.home, 'eval')
    arms(p, ['baseline', 'cand'])
    const st = await projectStatus(p)
    // three scenarios is below the five a direction needs, and there is no floor either
    expect(st.readings['reliability']).toEqual({ attainable: false, missing: [{ code: 'scenarios.below_minimum', have: 3, need: 5 }] })
    expect(st.readings['northStar.cost']!.missing!.map(m => m.code)).toEqual(['scenarios.below_minimum', 'floor.missing'])
    expect(st.readings['northStar.quality']!.missing!.map(m => m.code)).toEqual(['scenario.no_judge_rubric', 'judge.unconfigured'])
    // a scenario carrying a rubric removes half of the quality blockers
    const withJudge = project([{ name: 'a', judge: true }])
    ensureEvalProfile(withJudge.home, 'eval')
    arms(withJudge, ['baseline', 'cand'])
    expect((await projectStatus(withJudge)).readings['northStar.quality']!.missing!.map(m => m.code)).toEqual(['judge.unconfigured'])
  })

  it('does not report a dead run as running, and does not tell the caller to poll it', async () => {
    const p = project([{ name: 'a' }])
    ensureEvalProfile(p.home, 'eval')
    arms(p, ['baseline', 'cand'])
    recordSelfcheck(p, [{ name: 'a', ok: true, blankPasses: false, oraclePasses: null, bytes: 1, turns: 1, detail: 'ok' }], { a: join(p.scenarioRoot, 'a') })
    const plan: RunPlan = { id: 'r1', createdAt: new Date().toISOString(), baseline: { name: 'baseline' }, candidates: [{ name: 'cand' }], scenarios: ['a'], repeats: 3, concurrency: 1, scenarioRoot: p.scenarioRoot }
    const paths = runPaths(p.runsRoot, 'r1')
    mkdirSync(paths.dir, { recursive: true })
    writeJsonAtomic(paths.plan, plan)
    writeJsonAtomic(paths.progress, { status: 'running', completed: 5, total: 6, failed: 0, usd: 0.1, active: [], recent: [] })

    const live = await projectStatus(p)
    expect(live.phases.find(x => x.code === 'run')!.state).toBe('running')
    expect(live.next).toMatchObject({ tool: 'run.status', reason: { code: 'run.in_progress', id: 'r1' } })

    // the process dies: the progress file stops being written, and an hour later it is not a running run
    const old = (Date.now() - ABANDONED_AFTER_MS - 60_000) / 1000
    utimesSync(paths.progress, old, old)
    const dead = await projectStatus(p)
    const phase = dead.phases.find(x => x.code === 'run')!
    expect(phase.state).toBe('none')
    expect((phase['abandoned'] as Array<{ id: string }>)[0]!.id).toBe('r1')
    expect(dead.next.tool).not.toBe('run.status')
  })

  it('asks for the A/A floor once everything before it is in place', async () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const p = project(names.map(n => ({ name: n })))
    ensureEvalProfile(p.home, 'eval')
    arms(p, ['baseline', 'cand'])
    recordSelfcheck(p, names.map(n => ({ name: n, ok: true, blankPasses: false, oraclePasses: null, bytes: 1, turns: 1, detail: 'ok' })), Object.fromEntries(names.map(n => [n, join(p.scenarioRoot, n)])))
    const st = await projectStatus(p)
    expect(st.blocked).toBe('floor')
    expect(st.next).toMatchObject({ tool: 'run.start', args: { baseline: 'baseline', aa: true, repeats: 3 }, reason: { code: 'floor.missing' } })
    expect(st.readings['reliability']).toEqual({ attainable: true })            // five scenarios is enough for reliability
    expect(st.readings['northStar.cost']!.attainable).toBe(false)               // but a direction still needs the floor
  })
})
