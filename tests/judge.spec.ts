import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { judgeRun, readArtifacts, type ChatCall } from '../src/core/judge.js'
import type { RunLedger, RunPlan } from '../src/core/types.js'
import { listScenarios } from '../src/core/scenario.js'
import { resolveArm } from '../src/core/arms.js'
import { executeRun } from '../src/core/runner.js'
import { readLedgers, runPaths, writeJsonAtomic } from '../src/core/store.js'
import { scriptedDriverFactory } from './helpers.js'

const FIXTURES = join(__dirname, 'fixtures', 'scenarios')
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

function ledger(scenario: string, arm: string, rep: number): RunLedger {
  return { schema: 'dsh-eval-ledger/1', runId: 'r', scenario, arm, rep, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0, turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd: 0.01, usdPeak: 0.01, usdOffpeak: 0.01, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: '' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '' }
}

describe('blinded pairwise judge', () => {
  it('maps answers back through the random order, ties on disagreement, and measures human agreement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-judge-')); tmp.push(root)
    const dir = (s: string, a: string, r: number): string => join(root, s, a, `rep${r}`)
    for (const s of ['s1', 's2', 's3']) for (const a of ['base', 'cand']) for (const r of [1]) { mkdirSync(dir(s, a, r), { recursive: true }); writeFileSync(join(dir(s, a, r), 'out.md'), `${s} ${a} ${a === 'cand' ? 'GOOD' : 'meh'}`) }
    // A judge that prefers whichever submission contains GOOD, except on s3 where it is position-biased (always "1").
    const chat: ChatCall = async (messages) => {
      const u = messages[1]!.content
      const s3 = u.includes('s3 ')
      const first = u.slice(u.indexOf('### Submission 1'), u.indexOf('### Submission 2'))
      const winner = s3 ? '1' : first.includes('GOOD') ? '1' : '2'
      return { text: JSON.stringify({ winner, reason: 'because' }), usage: { hit: 0, miss: 100, output: 10 } }
    }
    const plan: RunPlan = { id: 'r', createdAt: '', baseline: { name: 'base' }, candidates: [{ name: 'cand' }], scenarios: ['s1', 's2', 's3'], repeats: 1, concurrency: 1, scenarioRoot: '' }
    const ledgers = ['s1', 's2', 's3'].flatMap(s => [ledger(s, 'base', 1), ledger(s, 'cand', 1)])
    const specs = Object.fromEntries(['s1', 's2', 's3'].map(s => [s, { rubric: 'good beats meh', artifacts: ['out.md'] }]))
    const report = await judgeRun({ plan, candidate: 'cand', ledgers, specs, artifactDir: dir, chat, model: 'deepseek-v4-pro', seed: 3, annotations: { 's1|cand|1': { verdict: true }, 's1|base|1': { verdict: false }, 's2|cand|1': { verdict: true }, 's2|base|1': { verdict: true } } })
    const byS = Object.fromEntries(report.judgments.map(j => [j.scenario, j]))
    expect(byS['s1']!.preference).toBe('candidate')
    expect(byS['s2']!.preference).toBe('candidate')
    expect(byS['s3']!.preference).toBe('tie')           // orders disagreed → tie
    expect(report.wins).toBe(2)
    expect(report.losses).toBe(0)
    expect(report.ties).toBe(1)
    expect(report.inconsistentShare).toBeCloseTo(1 / 3, 6)
    expect(report.humanAgreement).toEqual({ n: 2, agree: 0.5, kappa: 0 })
    expect(report.usd).toBeGreaterThan(0)
    expect(readArtifacts(join(root, 'nope'), 100).sha).toBe('none')
  })

  it('captures judge artifacts at the end of each trial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-judge-run-')); tmp.push(root)
    const { scenarios } = listScenarios(FIXTURES, { names: ['t1*'] })
    const s = scenarios[0]!
    s.meta.judge = { rubric: 'r', artifacts: ['answer.txt', 'missing.txt'] }
    const plan: RunPlan = { id: 'r', createdAt: '', baseline: { name: 'base' }, candidates: [], scenarios: [s.name], repeats: 1, concurrency: 1, scenarioRoot: FIXTURES }
    const paths = runPaths(root, plan.id)
    writeJsonAtomic(paths.plan, plan)
    await executeRun(plan, [s], [resolveArm(plan.baseline, paths.arms)], { driverFactory: scriptedDriverFactory(), evalHome: join(root, 'home'), paths, env: {}, workRoot: join(root, 'work') })
    expect(readLedgers(paths)).toHaveLength(1)
    expect(existsSync(join(paths.ledgers, s.name, 'base', 'rep1.artifacts', 'answer.txt'))).toBe(true)
    expect(existsSync(join(paths.ledgers, s.name, 'base', 'rep1.artifacts', 'missing.txt'))).toBe(false)
  })
})
