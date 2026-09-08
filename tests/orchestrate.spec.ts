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

  it('applies the run\'s model and effort to every arm, so an arm cannot differ in either', async () => {
    const p = project()
    const logs: string[] = []
    // `pro` declares its own model; the run names one for both arms, and that is what runs.
    const run = await launchRun(p, { baseline: 'baseline', candidates: ['pro'], scenarios: ['t1*'], repeats: 1, model: 'deepseek-v4-flash', effort: 'high' }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh, log: l => logs.push(l) })
    expect(run.diffs[0]!.route).toEqual([])                       // no route variable left between the arms
    expect([run.plan.baseline.model, run.plan.baseline.effort]).toEqual(['deepseek-v4-flash', 'high'])
    expect([run.plan.candidates[0]!.model, run.plan.candidates[0]!.effort]).toEqual(['deepseek-v4-flash', 'high'])
    expect(logs).toContain('arm pro declares model deepseek-v4-pro; the run uses deepseek-v4-flash for every arm')
    await run.done
  })

  it('hands every runtime event to a watcher as the trial runs, reduced to what a live view needs', async () => {
    const { activityOf } = await import('../src/core/ledger.js')
    const p = project()
    const seen: Array<{ trial: string; kind: string; name?: string }> = []
    const run = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, {
      driverFactory: scriptedDriverFactory(), invoke: fakeDsh,
      // The scripted driver hands its events over at the end of each turn; the runner forwards them then.
      onEvent: (trial, e) => { const a = activityOf(trial, e); if (a !== null) seen.push({ trial: `${trial.arm}#${trial.rep}`, kind: a.kind, ...(a.name !== undefined ? { name: a.name } : {}) }) },
    })
    await run.done
    expect(new Set(seen.map(x => x.trial))).toEqual(new Set(['baseline#1', 'persona#1']))   // both arms were watched
    expect(seen.some(x => x.kind === 'message' && x.name === 'read')).toBe(true)          // a tool request reads as one
    expect(seen.some(x => x.kind === 'message' && x.name === undefined)).toBe(true)       // and the final reply as a reply
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

describe('signed receipts', () => {
  it('issues a signed receipt with the contract and answers PASS, INVALID or INCONCLUSIVE', async () => {
    const { verifyRunIntegrity } = await import('../src/core/orchestrate.js')
    const { readReceipt, receiptSignatureValid } = await import('../src/core/manifest.js')
    const { runPaths } = await import('../src/core/store.js')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = project()
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await launched.done
    const paths = runPaths(p.runsRoot, launched.id)
    const receipt = readReceipt(paths)!
    expect(receipt.schema).toBe('dsh-eval-receipt/1')
    expect(receipt.contract.minScenarios).toBe(5)
    expect(receipt.contract.alpha).toBeCloseTo(0.025, 6)
    expect(receipt.claims[0]!.arm).toBe('persona')
    expect(receipt.coverage).toMatchObject({ trials: 2, arms: 2, unrun: 0, errors: 0 })
    expect(receiptSignatureValid(receipt)).toBe(true)
    const clean = verifyRunIntegrity(p, launched.id)
    expect(clean.status).toBe('PASS')
    expect(clean.ok).toBe(true)

    // a forged claim in the receipt is caught even though every evidence hash still matches
    const forged = { ...receipt, claims: [{ ...receipt.claims[0]!, grade: 'improvement', costReading: 'cheaper' }] }
    writeFileSync(join(paths.dir, 'receipt.json'), JSON.stringify(forged))
    const tampered = verifyRunIntegrity(p, launched.id)
    expect(tampered.status).toBe('INVALID')
    expect(tampered.statusReason).toMatch(/signature/)
    // removing the receipt entirely is not a falsified claim, it is an uncontracted one
    writeFileSync(join(paths.dir, 'receipt.json'), JSON.stringify({ ...receipt, schema: 'nope' }).slice(0, 10))
    expect(verifyRunIntegrity(p, launched.id).status).toBe('INCONCLUSIVE')
  })
})

describe('cli entry point', () => {
  it('runs when invoked through a symlinked global bin, not only by its own filename', async () => {
    const { execFile } = await import('node:child_process')
    const { mkdtempSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, resolve } = await import('node:path')
    const cli = resolve('lib/cli.js')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-bin-'))
    const link = join(dir, 'dsh-eval')          // what `npm link` creates: a differently named symlink
    symlinkSync(cli, link)
    const run = (path: string): Promise<string> => new Promise((res, rej) => execFile(process.execPath, [path, 'version'], (e, stdout) => (e ? rej(e) : res(stdout.trim()))))
    expect(await run(link)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(await run(cli)).toBe(await run(link))
  })
})

describe('preflight', () => {
  it('checks composition and mounting, then boots a runtime, and names the cause when one refuses', async () => {
    const { preflightArm, explainRuntimeFailure } = await import('../src/core/preflight.js')
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = project()
    // an arm that inserts a row and then turns it off: it never reaches the agent, and no run is spent finding out
    writeFileSync(join(p.armsDir, 'ghost.yml'), "name: ghost\npatches:\n  - insert:\n      - id: ghost-row\n        name: '@x/ghost'\n  - id: ghost-row\n    disabled: true\n")
    const ghost = await preflightArm(p, 'ghost', { dry: true, invoke: fakeDsh })
    expect(ghost.stages.map(s => s.name)).toEqual(['compose', 'mounted'])
    expect(ghost.stages[1]!.ok).toBe(false)
    expect(ghost.stages[1]!.detail).toContain('present but disabled')
    expect(ghost.rows[0]).toMatchObject({ id: 'ghost-row', present: true, enabled: false, inBaseline: false })
    expect(ghost.ok).toBe(false)

    // the real candidate composes and mounts; --dry stops before the live turn
    const dry = await preflightArm(p, 'persona', { dry: true, invoke: fakeDsh })
    expect(dry.ok).toBe(true)
    expect(dry.smoke).toBeUndefined()
    expect(dry.stages.find(s => s.name === 'compose')!.detail).toContain('variable')

    // the live stage runs a scenario through the driver and reports what it cost
    const live = await preflightArm(p, 'persona', { invoke: fakeDsh, driverFactory: scriptedDriverFactory(), scenario: 't1_write_answer' })
    expect(live.stages.map(s => s.name)).toEqual(['compose', 'mounted', 'runs'])
    expect(live.ok).toBe(true)
    expect(live.smoke?.scenario).toBe('t1_write_answer')
    expect(live.smoke!.usd).toBeGreaterThan(0)

    // a crashing runtime fails the third stage, and the cause is pulled out of the trace
    const crashing = await preflightArm(p, 'persona', { invoke: fakeDsh, driverFactory: scriptedDriverFactory({ crashing: ['persona'] }), scenario: 't1_write_answer' })
    expect(crashing.ok).toBe(false)
    expect(crashing.stages.find(s => s.name === 'runs')!.ok).toBe(false)

    expect(explainRuntimeFailure('dsh profile "eval": JSON-RPC input closed\nexit code: 1\nstderr tail:\nError: dsh: plugin tree failed to load: duplicate loader entry id: slice-agent-loop\n    at Foo'))
      .toBe('dsh: plugin tree failed to load: duplicate loader entry id: slice-agent-loop')
    expect(explainRuntimeFailure('something odd\nTypeError: deps.driverFactory is not a function')).toBe('deps.driverFactory is not a function')
    expect(explainRuntimeFailure('just one line')).toBe('just one line')
  })
})

describe('sequential mode guards', () => {
  it('refuses more than one candidate or a non-cost north star (H18)', async () => {
    const p = project()
    writeFileSync(join(p.armsDir, 'other.yml'), 'name: other\npatches:\n  - id: system-prompt\n    config:\n      persona: terse\n')
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['persona', 'other'], scenarios: ['t1*'], sequential: true, allowMulti: true }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toMatchObject({ code: 'arms' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], sequential: true, northStar: 'efficiency' }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })).rejects.toMatchObject({ code: 'arms' })
  })
})

describe('trust root, sealed derivations and pinned context (C1)', () => {
  const keyPair = async () => { const { generateKeyPairSync } = await import('node:crypto'); const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() } }

  it('a ledger edited together with its manifest entry, or a receipt re-signed with a fresh key, never verifies', async () => {
    const { verifyRunIntegrity } = await import('../src/core/orchestrate.js')
    const { readManifest, readReceipt, signReceipt, evidenceShaOf } = await import('../src/core/manifest.js')
    const { runPaths } = await import('../src/core/store.js')
    const { createHash } = await import('node:crypto')
    const p = project()
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory({ costScale: { persona: 0.5 } }), invoke: fakeDsh })
    await launched.done
    const paths = runPaths(p.runsRoot, launched.id)
    expect(verifyRunIntegrity(p, launched.id).status).toBe('PASS')
    expect(existsSync(join(paths.dir, 'context.json'))).toBe(true)
    expect(readManifest(paths)!.files['context.json']).toBeDefined()          // the archive context is evidence
    // 1. tamper with a ledger AND rewrite its manifest entry and the manifest's own evidence sha (the "re-hash" attack)
    const manifest = readManifest(paths)!
    const ledgerFile = Object.keys(manifest.files).find(f => f.startsWith('ledgers/') && f.endsWith('.json') && f.includes('/persona/'))!
    const abs = join(paths.dir, ledgerFile)
    const ledger = JSON.parse(readFileSync(abs, 'utf8')) as { totals: { usd: number } }
    ledger.totals.usd *= 10
    const bytes = JSON.stringify(ledger)
    writeFileSync(abs, bytes)
    manifest.files[ledgerFile] = createHash('sha256').update(bytes).digest('hex')
    manifest.evidenceSha = evidenceShaOf(manifest.files)
    writeFileSync(join(paths.dir, 'manifest.json'), JSON.stringify(manifest))
    const rehashed = verifyRunIntegrity(p, launched.id)
    expect(rehashed.changed).toEqual([])                                        // the manifest agrees with the disk…
    expect(rehashed.status).toBe('INVALID')                                     // …but the signed receipt names other bytes
    expect(rehashed.statusReason).toMatch(/evidence sha|report/)
    // a thorough attacker rebuilds the report too, so the stored report matches the tampered ledger; the receipt still does not
    const { rebuildReport } = await import('../src/core/orchestrate.js')
    rebuildReport(p, launched.id)
    const rebuilt = verifyRunIntegrity(p, launched.id)
    expect(rebuilt.reportReproduces).toBe(true)
    expect(rebuilt.status).toBe('INVALID')
    expect(rebuilt.statusReason).toMatch(/evidence sha/)
    // 2. forge the receipt too: new claims, new evidence sha, signed with a fresh key pair whose public half is embedded
    const receipt = readReceipt(paths)!
    const fresh = await keyPair()
    const { signature: _s, ...unsigned } = receipt
    void _s
    const forged = signReceipt({ ...unsigned, evidenceSha: manifest.evidenceSha, publicKey: fresh.publicKey, claims: receipt.claims.map(c => ({ ...c, costReading: 'cheaper', grade: 'improvement' })) }, fresh.privateKey)
    writeFileSync(join(paths.dir, 'receipt.json'), JSON.stringify(forged))
    const forgedResult = verifyRunIntegrity(p, launched.id)
    expect(forgedResult.status).not.toBe('PASS')
    expect(forgedResult.statusReason).toMatch(/does not trust|fingerprint/)        // self-signed by an unknown key: not verified
    // even a verifier told to trust that key finds the report digest does not match the forged claims
    const trustedAnyway = verifyRunIntegrity(p, launched.id, { keys: [fresh.publicKey] })
    expect(trustedAnyway.status).toBe('INVALID')
  })

  it('judge and annotation files are sealed evidence: a judged run verifies, an edited judge file does not', async () => {
    const { verifyRunIntegrity, runJudge } = await import('../src/core/orchestrate.js')
    const { readManifest } = await import('../src/core/manifest.js')
    const { runPaths } = await import('../src/core/store.js')
    const { cpSync } = await import('node:fs')
    // a scenario library where t1 declares a judge rubric, so the judge has artifacts to read
    const lib = mkdtempSync(join(tmpdir(), 'dsh-eval-judged-lib-')); tmp.push(lib)
    cpSync(join(FIXTURES, 't1_write_answer'), join(lib, 't1_write_answer'), { recursive: true })
    const meta = JSON.parse(readFileSync(join(lib, 't1_write_answer', 'meta.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(lib, 't1_write_answer', 'meta.json'), JSON.stringify({ ...meta, judge: { rubric: 'the answer file is present and tidy', artifacts: ['answer.txt'] } }))
    const p = project({ scenarioRoot: lib })
    const launched = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await launched.done
    const paths = runPaths(p.runsRoot, launched.id)
    const chat = async (): Promise<{ text: string; usage: { hit: number; miss: number; output: number } }> => ({ text: JSON.stringify({ winner: '1', reason: 'first', confidence: 0.9 }), usage: { hit: 0, miss: 10, output: 5 } })
    await runJudge(p, launched.id, { models: ['gpt-5.2'], chats: { 'gpt-5.2': chat } })
    expect(readManifest(paths)!.files['judge-persona.json']).toBeDefined()     // sealed
    const judged = verifyRunIntegrity(p, launched.id)
    expect(judged.status).toBe('PASS')                                          // re-sealed and re-receipted after the judge
    const file = join(paths.dir, 'judge-persona.json')
    const j = JSON.parse(readFileSync(file, 'utf8')) as { wins: number; losses: number }
    writeFileSync(file, JSON.stringify({ ...j, wins: j.wins + 5, losses: 0 }))
    const edited = verifyRunIntegrity(p, launched.id)
    expect(edited.status).toBe('INVALID')
    expect(edited.changed).toEqual(['judge-persona.json'])
  })

  it('a bundle re-derives its receipted readings in a project with no archive, given the author\'s key', async () => {
    const { verifyRunDir } = await import('../src/core/orchestrate.js')
    const { runPaths } = await import('../src/core/store.js')
    const { cpSync } = await import('node:fs')
    const author = project()
    // an A/A run first, so the archive supplies a floor the A/B reading depends on
    const aa = await launchRun(author, { baseline: 'baseline', candidates: [], aa: true, scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await aa.done
    const ab = await launchRun(author, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory({ costScale: { persona: 0.5 } }), invoke: fakeDsh })
    const { report } = await ab.done
    expect(report.candidates[0]!.floor).toBe('thin')                             // the reading saw the archive's (one-scenario) floor
    const bundle = join(mkdtempSync(join(tmpdir(), 'dsh-eval-bundle-')), ab.id)
    cpSync(runPaths(author.runsRoot, ab.id).dir, bundle, { recursive: true })
    const authorKey = (JSON.parse(readFileSync(join(author.evalDir, 'receipt-key.json'), 'utf8')) as { publicKey: string }).publicKey
    const stranger = project()                                                   // no A/A run, no archive, another signing key
    const untrusted = verifyRunDir(stranger, bundle)
    expect(untrusted.status).toBe('INCONCLUSIVE')
    expect(untrusted.statusReason).toMatch(/does not trust/)
    const trusted = verifyRunDir(stranger, bundle, { keys: [authorKey] })
    expect(trusted.reportReproduces).toBe(true)                                  // the pinned context, not the stranger's archive, fed the derivation
    expect(trusted.status).toBe('PASS')
  })
})

describe('resume keeps its conditions (H7) and the judge default is cross-family (H4)', () => {
  it('refuses a resume that names other conditions than the run started with', async () => {
    const p = project()
    const ac = new AbortController()
    let created = 0
    const inner = scriptedDriverFactory()
    const first = await launchRun(p, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 2 }, { driverFactory: (i) => { created += 1; if (created === 1) ac.abort(); return inner(i) }, invoke: fakeDsh, signal: ac.signal })
    await first.done
    await expect(launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id, perturb: true }, { driverFactory: inner, invoke: fakeDsh })).rejects.toMatchObject({ code: 'usage' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id, sandbox: 'docker' }, { driverFactory: inner, invoke: fakeDsh })).rejects.toMatchObject({ code: 'usage' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id, northStar: 'efficiency' }, { driverFactory: inner, invoke: fakeDsh })).rejects.toMatchObject({ code: 'usage' })
    await expect(launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id, repeats: 3 }, { driverFactory: inner, invoke: fakeDsh })).rejects.toMatchObject({ code: 'usage' })
    const second = await launchRun(p, { baseline: 'baseline', candidates: [], resume: first.id, repeats: 2 }, { driverFactory: inner, invoke: fakeDsh })
    const r2 = await second.done
    expect(r2.progress.status).toBe('done')
    expect(r2.progress.completed).toBe(4)
  })
  it('without a named judge, uses the configured cross-family judge and otherwise refuses instead of defaulting to the arms\' family', async () => {
    const { runJudge } = await import('../src/core/orchestrate.js')
    const { cpSync } = await import('node:fs')
    const lib = mkdtempSync(join(tmpdir(), 'dsh-eval-judged-lib-')); tmp.push(lib)
    cpSync(join(FIXTURES, 't1_write_answer'), join(lib, 't1_write_answer'), { recursive: true })
    const meta = JSON.parse(readFileSync(join(lib, 't1_write_answer', 'meta.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(lib, 't1_write_answer', 'meta.json'), JSON.stringify({ ...meta, judge: { rubric: 'tidy', artifacts: ['answer.txt'] } }))
    const chat = async (): Promise<{ text: string; usage: { hit: number; miss: number; output: number } }> => ({ text: JSON.stringify({ winner: '1', reason: 'first', confidence: 0.9 }), usage: { hit: 0, miss: 10, output: 5 } })
    const bare = project({ scenarioRoot: lib })
    const run1 = await launchRun(bare, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await run1.done
    await expect(runJudge(bare, run1.id, { chats: { 'deepseek-v4-pro': chat } })).rejects.toMatchObject({ code: 'usage' })
    const reports = await runJudge(bare, run1.id, { allowSameFamily: true, chats: { 'deepseek-v4-pro': chat } })
    expect(reports[0]!.models).toEqual(['deepseek-v4-pro'])
    const configured = project({ scenarioRoot: lib, judges: [{ name: 'gpt', model: 'gpt-5.2', baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'NOPE_KEY', family: 'openai' }] })
    const run2 = await launchRun(configured, { baseline: 'baseline', candidates: ['persona'], scenarios: ['t1*'], repeats: 1 }, { driverFactory: scriptedDriverFactory(), invoke: fakeDsh })
    await run2.done
    const viaConfig = await runJudge(configured, run2.id, { chats: { gpt: chat } })
    expect(viaConfig[0]!.models).toEqual(['gpt'])
  })
})
