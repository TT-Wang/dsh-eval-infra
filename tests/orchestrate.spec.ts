import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchRun, LaunchError } from '../src/core/orchestrate.js'
import { ensureEvalProfile, loadProject } from '../src/core/project.js'
import { runPaths, readJson } from '../src/core/store.js'
import type { DshInvoker } from '../src/core/arms.js'
import { scriptedDriverFactory } from './helpers.js'

const FIXTURES = join(__dirname, 'fixtures', 'scenarios')
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A stand-in for `dsh --dump-config`: renders a fixed base tree plus whatever the overlays patch. */
const fakeDsh: DshInvoker = async (args) => {
  const overlays = args.flatMap((a, i) => (a === '--patch' ? [args[i + 1]!] : []))
  const rows: Record<string, Record<string, unknown>> = {
    'system-prompt': { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { persona: 'stock' } },
    'tool-web': { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    'compaction-basic': { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.8 } },
  }
  const yaml = await import('js-yaml')
  for (const file of overlays) {
    const patches = yaml.default.load(readFileSync(file, 'utf8')) as Array<Record<string, unknown>> | null
    for (const p of patches ?? []) {
      if (Array.isArray(p['insert'])) for (const r of p['insert'] as Array<Record<string, unknown>>) rows[String(r['id'])] = r
      else if (typeof p['id'] === 'string' && rows[p['id']]) rows[p['id']] = { ...rows[p['id']]!, ...p }
    }
  }
  return '# == fake\n' + yaml.default.dump(Object.values(rows))
}

function project(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-orch-')); tmp.push(root)
  mkdirSync(join(root, '.dsh-eval'), { recursive: true })
  writeFileSync(join(root, '.dsh-eval', 'config.json'), JSON.stringify({ profile: 'eval', repeats: 2, concurrency: 1, scenarioRoot: FIXTURES, ...config }))
  const p = loadProject(root)
  ensureEvalProfile(p.home, 'eval')
  mkdirSync(p.armsDir, { recursive: true })
  writeFileSync(join(p.armsDir, 'baseline.yml'), 'name: baseline\n')
  writeFileSync(join(p.armsDir, 'persona.yml'), 'name: persona\npatches:\n  - id: system-prompt\n    config:\n      persona: careful\n')
  writeFileSync(join(p.armsDir, 'two.yml'), 'name: two\npatches:\n  - id: system-prompt\n    config:\n      persona: careful\n  - id: compaction-basic\n    config:\n      thresholdRatio: 0.5\n')
  writeFileSync(join(p.armsDir, 'pro.yml'), 'name: pro\nmodel: deepseek-v4-pro\n')
  return p
}

describe('launchRun', () => {
  it('refuses a run when the profile is missing, a scenario fails selfcheck, or arms differ in two variables', async () => {
    const p = project()
    rmSync(join(p.home, 'profiles'), { recursive: true, force: true })
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['persona'] }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toMatchObject({ code: 'env' })
    ensureEvalProfile(p.home, 'eval')
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t2*'] }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toMatchObject({ code: 'selfcheck' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['two'], scenarios: ['t1*'] }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toMatchObject({ code: 'arms' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['nope'], scenarios: ['t1*'] }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toBeInstanceOf(LaunchError)
  })

  it('runs a one-variable comparison end to end and records plan, environment, composed trees and the report', async () => {
    const p = project()
    const logs: string[] = []
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], label: 'persona-test' }, { driverFactory: scriptedDriverFactory({ costScale: { persona: 0.8 } }), invoke: fakeDsh, log: l => logs.push(l) })
    expect(launched.diffs[0]).toMatchObject({ candidate: 'persona', variables: 1 })
    expect(launched.selfcheck.map(s => s.ok)).toEqual([true])
    const { progress, report } = await launched.done
    expect(progress.status).toBe('done')
    expect(progress.total).toBe(4)
    const paths = runPaths(p.runsRoot, launched.id)
    expect(existsSync(paths.report)).toBe(true)
    expect(existsSync(paths.reportMd)).toBe(true)
    expect(existsSync(join(paths.arms, 'persona.composed.yml'))).toBe(true)
    const env = readJson<{ composedTreeSha: Record<string, string>; multiVariable: boolean; priceTableAsOf: string }>(paths.env)
    expect(Object.keys(env.composedTreeSha).sort()).toEqual(['baseline', 'persona'])
    expect(env.composedTreeSha['baseline']).not.toBe(env.composedTreeSha['persona'])
    expect(env.multiVariable).toBe(false)
    expect(env.priceTableAsOf).toBe('2026-09-04')
    expect(report.candidates[0]!.gate).toBe('pass')
    expect(report.candidates[0]!.scenarios[0]!.costDiffPct).toBeCloseTo(-20, 0)
    expect(logs.some(l => /~ row system-prompt: config/.test(l))).toBe(true)
    expect(readFileSync(paths.reportMd, 'utf8')).toContain('persona vs baseline')
  })

  it('treats a route change (model) as the one variable, runs A/A on request, and marks multi-variable runs', async () => {
    const p = project()
    const pro = await launchRun(p, { baseline: 'baseline', candidates: ['pro'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    expect(pro.diffs[0]).toMatchObject({ variables: 1, route: ['model'] })
    await pro.done
    const aa = await launchRun(p, { baseline: 'baseline', candidates: [], aa: true, scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    expect(aa.plan.candidates[0]!.name).toBe('baseline-aa')
    const { report } = await aa.done
    expect(report.notes.join(' ')).toMatch(/A\/A run/)
    const multi = await launchRun(p, { baseline: 'baseline', candidates: ['two'], scenarios: ['t1*'], repeats: 1, allowMulti: true }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    const done = await multi.done
    expect(done.report.notes[0]).toMatch(/Multi-variable/)
  })

  it('resumes a cancelled run without redoing finished trials', async () => {
    const p = project()
    const ac = new AbortController()
    let created = 0
    const inner = scriptedDriverFactory()
    const first = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'] }, { driverFactory: (i) => { created += 1; if (created === 1) ac.abort(); return inner(i) }, invoke: fakeDsh, signal: ac.signal })
    const r1 = await first.done
    expect(r1.progress.status).toBe('cancelled')
    const second = await launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id }, { driverFactory: (i) => { created += 1; return inner(i) }, invoke: fakeDsh })
    const r2 = await second.done
    expect(r2.progress.status).toBe('done')
    expect(r2.progress.completed).toBe(4)
    expect(created).toBe(4)
  })
})

describe('judge family rule', () => {
  it('refuses a judge from the arms\' model family unless allowed', async () => {
    const { modelFamily, runJudge } = await import('../src/core/orchestrate.js')
    expect(modelFamily('deepseek-v4-pro')).toBe('deepseek')
    expect(modelFamily('gpt-5.2')).toBe('openai')
    expect(modelFamily('claude-fable-5')).toBe('anthropic')
    expect(modelFamily('whatever-1', 'custom')).toBe('custom')
    const p = project()
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await launched.done
    await expect(runJudge(p, launched.id, { models: ['deepseek-v4-pro'], chats: { 'deepseek-v4-pro': async () => ({ text: '{}', usage: { hit: 0, miss: 0, output: 0 } }) } })).rejects.toMatchObject({ code: 'usage' })
  })
})

describe('sealed evidence, verify and regrade', () => {
  it('seals a finished run, detects tampering, and regrades kept workspaces without re-running agents', async () => {
    const { verifyRunIntegrity, regradeRun } = await import('../src/core/orchestrate.js')
    const { readManifest } = await import('../src/core/manifest.js')
    const { runPaths } = await import('../src/core/store.js')
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = project()
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1, keepWorkdirs: true }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await launched.done
    const paths = runPaths(p.runsRoot, launched.id)
    const manifest = readManifest(paths)
    expect(manifest).not.toBeNull()
    expect(manifest!.count).toBeGreaterThan(4)
    expect(Object.keys(manifest!.files).some(f => f.startsWith('ledgers/'))).toBe(true)
    const clean = verifyRunIntegrity(p, launched.id)
    expect(clean.ok).toBe(true)
    expect(clean.reportReproduces).toBe(true)
    expect(clean.changed).toEqual([])

    // regrade: every trial kept its workspace, the verifier gives the same verdicts, the manifest records the regrade
    const rg = await regradeRun(p, launched.id)
    expect(rg.regradable).toBe(2)
    expect(rg.skipped).toBe(0)
    expect(rg.changed).toEqual([])
    expect(Object.keys(rg.verifiers)).toEqual(['t1_write_answer'])
    expect(readManifest(paths)!.regrades).toHaveLength(1)
    expect(verifyRunIntegrity(p, launched.id).ok).toBe(true)

    // tamper with a ledger's cost: the seal catches it and the stored report no longer follows from the evidence
    const ledgerFile = Object.keys(readManifest(paths)!.files).find(f => f.startsWith('ledgers/') && f.endsWith('.json'))!
    const abs = join(paths.dir, ledgerFile)
    const ledger = JSON.parse(readFileSync(abs, 'utf8')) as { totals: { usd: number } }
    ledger.totals.usd *= 10
    writeFileSync(abs, JSON.stringify(ledger))
    const tampered = verifyRunIntegrity(p, launched.id)
    expect(tampered.ok).toBe(false)
    expect(tampered.changed).toEqual([ledgerFile])
    expect(tampered.reportReproduces).toBe(false)
    expect(existsSync(join(paths.dir, 'manifest.json'))).toBe(true)
  })
})

describe('rerun validation and bundles', () => {
  it('reruns a failing scenario, records whether the failure and divergence recur, and verifies a published copy', async () => {
    const { rerunScenario, verifyRunDir } = await import('../src/core/orchestrate.js')
    const { runPaths } = await import('../src/core/store.js')
    const { cpSync, mkdtempSync, existsSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const p = project()
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory({ failing: ['persona'] }), invoke: fakeDsh })
    await launched.done
    const r = await rerunScenario(p, launched.id, 't1_write_answer', { repeats: 2, hooks: { driverFactory: scriptedDriverFactory({ failing: ['persona'] }), invoke: fakeDsh } })
    expect(r.original?.failing).toBe('persona')
    expect(r.reps).toBe(2)
    expect(r.failedAgain).toBe(2)
    expect(r.sameCall).toBe(2)
    expect(r.verdict).toBe('reproduced')
    const paths = runPaths(p.runsRoot, launched.id)
    expect(existsSync(join(paths.dir, 'rerun-t1_write_answer.json'))).toBe(true)
    const report = JSON.parse(readFileSync(paths.report, 'utf8')) as { candidates: Array<{ rerun?: { verdict: string } }>; notes: string[] }
    expect(report.candidates[0]!.rerun?.verdict).toBe('reproduced')
    expect(report.notes.some(n => n.includes('rerun validation'))).toBe(true)
    // the rerun file is derived, so the original seal still verifies; a copied bundle verifies too
    const { verifyRunIntegrity } = await import('../src/core/orchestrate.js')
    expect(verifyRunIntegrity(p, launched.id).ok).toBe(true)
    const bundle = join(mkdtempSync(join(tmpdir(), 'dsh-eval-bundle-')), launched.id)
    cpSync(paths.dir, bundle, { recursive: true })
    const v = verifyRunDir(p, bundle)
    expect(v.ok).toBe(true)
    expect(v.reportReproduces).toBe(true)
  })
})
