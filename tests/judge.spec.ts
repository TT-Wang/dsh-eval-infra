import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { judgeRun, readArtifacts, absoluteJudge, ppiRate, type ChatCall } from '../src/core/judge.js'
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
    const report = await judgeRun({ plan, candidate: 'cand', ledgers, specs, artifactDir: dir, judges: [{ model: 'deepseek-v4-pro', chat }], seed: 3, annotations: { 's1|cand|1': { verdict: true }, 's1|base|1': { verdict: false }, 's2|cand|1': { verdict: true }, 's2|base|1': { verdict: true } } })
    const byS = Object.fromEntries(report.judgments.map(j => [j.scenario, j]))
    expect(byS['s1']!.preference).toBe('candidate')
    expect(byS['s2']!.preference).toBe('candidate')
    expect(byS['s3']!.preference).toBe('tie')           // orders disagreed → tie
    expect(report.wins).toBe(2)
    expect(report.losses).toBe(0)
    expect(report.ties).toBe(1)
    expect(report.inconsistentShare).toBeCloseTo(1 / 3, 6)
    expect(report.humanAgreement).toEqual({ n: 2, agree: 0.5, kappa: 0 })
    expect(report.longerWinsShare).toBe(1)   // the GOOD artifact is longer and always wins
    expect(report.interJudgeKappa).toBeNull()
    expect(report.usd).toBeGreaterThan(0)
    expect(readArtifacts(join(root, 'nope'), 100).sha).toBe('none')

    // A panel: a second judge that always says "2" (position-biased) ties every pair by itself; the panel then has one decided vote
    // out of two, which is not a strict majority, so the pair is a tie — a lone judge cannot carry the panel.
    const biased: ChatCall = async () => ({ text: JSON.stringify({ winner: '2', reason: 'second' }), usage: { hit: 0, miss: 10, output: 5 } })
    const panel = await judgeRun({ plan, candidate: 'cand', ledgers, specs, artifactDir: dir, judges: [{ model: 'a', chat }, { model: 'b', chat: biased }], seed: 3 })
    expect(panel.models).toEqual(['a', 'b'])
    expect(panel.judgments.every(j => j.votes.length === 2)).toBe(true)
    expect(panel.judgments.find(j => j.scenario === 's1')!.preference).toBe('tie')
    expect(panel.panelAgreement).toBeLessThan(1)
    expect(panel.interJudgeKappa).not.toBeNull()
    // three judges, two good ones → strict majority → candidate
    const trio = await judgeRun({ plan, candidate: 'cand', ledgers, specs, artifactDir: dir, judges: [{ model: 'a', chat }, { model: 'b', chat: biased }, { model: 'c', chat }], seed: 3 })
    expect(trio.judgments.find(j => j.scenario === 's1')!.preference).toBe('candidate')
  })

  it('absolute mode grades trials and PPI++ rectifies the pass rate with human labels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-judge-abs-')); tmp.push(root)
    const dir = (s: string, a: string, r: number): string => join(root, s, a, `rep${r}`)
    const names = ['s1', 's2', 's3', 's4', 's5', 's6']
    for (const s of names) for (const a of ['base', 'cand']) { mkdirSync(dir(s, a, 1), { recursive: true }); writeFileSync(join(dir(s, a, 1), 'out.md'), `${s} ${a} ${a === 'cand' || s === 's1' ? 'GOOD' : 'meh'}`) }
    const chat: ChatCall = async (messages) => ({ text: JSON.stringify({ pass: messages[1]!.content.includes('GOOD'), score: messages[1]!.content.includes('GOOD') ? 0.9 : 0.2, reason: 'r' }), usage: { hit: 0, miss: 50, output: 5 } })
    const plan: RunPlan = { id: 'r', createdAt: '', baseline: { name: 'base' }, candidates: [{ name: 'cand' }], scenarios: names, repeats: 1, concurrency: 1, scenarioRoot: '' }
    const ledgers = names.flatMap(s => [ledger(s, 'base', 1), ledger(s, 'cand', 1)])
    const specs = Object.fromEntries(names.map(s => [s, { rubric: 'good beats meh', artifacts: ['out.md'] }]))
    // humans disagree with the judge on s1 (judge says GOOD/pass, human says fail) and agree elsewhere
    const annotations = { 's1|base|1': { verdict: false }, 's2|base|1': { verdict: false }, 's3|base|1': { verdict: false }, 's1|cand|1': { verdict: true }, 's2|cand|1': { verdict: true } }
    const abs = await absoluteJudge({ plan, ledgers, specs, artifactDir: dir, judges: [{ model: 'j', chat }], annotations })
    expect(abs.grades).toHaveLength(12)
    expect(abs.arms['cand']!.judgeOnly).toBe(1)
    expect(abs.arms['base']!.judgeOnly).toBeCloseTo(1 / 6, 6)
    expect(abs.arms['base']!.n).toBe(3)
    expect(abs.arms['base']!.estimate).toBeLessThan(abs.arms['base']!.judgeOnly + 1e-9)
    expect(abs.calibration.labelled).toBe(5)
    expect(abs.calibration.tnr).toBeCloseTo(2 / 3, 6)   // s1 base: judge pass, human fail → one false positive among three negatives
    expect(abs.calibration.tpr).toBe(1)
    const r = ppiRate([1, 1, 0, 0, 1, 0, 1, 0], [{ f: 1, y: 1 }, { f: 0, y: 0 }, { f: 1, y: 1 }, { f: 0, y: 0 }])
    expect(r.lambda).toBeGreaterThan(0)
    expect(r.estimate).toBeCloseTo(0.5, 6)
    expect(ppiRate([], []).estimate).toBe(0)
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

describe('abstention, length balance and anchors', () => {
  it('calibrates a conformal threshold on labelled pairs and abstains below it', async () => {
    const { conformalAbstentionThreshold, abstentionScore } = await import('../src/core/judge.js')
    // high-score pairs are right, low-score pairs are wrong: a threshold between them keeps the error at 0
    const labelled = [
      ...Array.from({ length: 12 }, () => ({ score: 0.9, correct: true })),
      ...Array.from({ length: 6 }, () => ({ score: 0.3, correct: false })),
    ]
    const tau = conformalAbstentionThreshold(labelled, 0.1)
    expect(tau).toBe(0.9)
    expect(conformalAbstentionThreshold([{ score: 0.9, correct: false }], 0.1)).toBeNull()   // one wrong label cannot meet the bound
    // both judges answer consistently for the same arm in both orders → certainty 1, score = mean confidence
    expect(abstentionScore([{ preference: 'candidate', answers: ['1', '2'], confidence: 0.8 }, { preference: 'candidate', answers: ['1', '2'], confidence: 0.6 }], 'candidate')).toBeCloseTo(0.7, 6)
    // one judge flips between orders → the pooled answers spread, so the score falls well below the mean confidence
    expect(abstentionScore([{ preference: 'candidate', answers: ['1', '2'], confidence: 0.8 }, { preference: 'tie', answers: ['1', '1'], confidence: 0.6 }], 'candidate')).toBeLessThan(0.45)
  })

  it('reports the length-balanced win rate and grades anchors for drift', async () => {
    const { gradeAnchors } = await import('../src/core/judge.js')
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-anchor-'))
    const dirA = join(root, 'a'); mkdirSync(dirA); writeFileSync(join(dirA, 'out.md'), 'GOOD work')
    const dirB = join(root, 'b'); mkdirSync(dirB); writeFileSync(join(dirB, 'out.md'), 'BAD work')
    const chat = async (messages: Array<{ content: string }>): Promise<{ text: string; usage: { hit: number; miss: number; output: number } }> => ({ text: JSON.stringify({ pass: messages[1]!.content.includes('GOOD'), score: 1, reason: 'x' }), usage: { hit: 0, miss: 10, output: 5 } })
    const g = await gradeAnchors([
      { key: 'r1|s|a|1', rubric: 'good', artifactDir: dirA, humanPass: true, previousJudgePass: true },
      { key: 'r1|s|b|1', rubric: 'good', artifactDir: dirB, humanPass: false, previousJudgePass: true },
    ], [{ model: 'deepseek-v4-flash', chat }])
    expect(g.answers).toEqual({ 'r1|s|a|1': true, 'r1|s|b|1': false })
    expect(g.summary).toMatchObject({ n: 2, humanAgreement: 1, stability: 0.5, comparedWithPrevious: 2, attribution: 'judge' })
  })
})

describe('entropy abstention, effective judges and length control', () => {
  it('scores certainty from both orderings, counts effective judges, and reads the win rate at equal length', async () => {
    const { bidirectionalPreferenceEntropy, abstentionScore, effectiveJudges, equalLengthWinRate } = await import('../src/core/judge.js')
    // both orders, both judges pick the candidate → zero entropy; a spread of answers → high entropy
    const agree = [{ answers: ['2', '1'] as [string, string] }, { answers: ['2', '1'] as [string, string] }]
    expect(bidirectionalPreferenceEntropy(agree, 'baseline')).toBeCloseTo(0, 6)
    const spread = [{ answers: ['1', '1'] as [string, string] }, { answers: ['tie', '2'] as [string, string] }]
    expect(bidirectionalPreferenceEntropy(spread, 'baseline')).toBeGreaterThan(0.9)
    expect(abstentionScore(agree.map(v => ({ ...v, preference: 'candidate', confidence: 0.8 })), 'baseline')).toBeCloseTo(0.8, 6)
    expect(abstentionScore(spread.map(v => ({ ...v, preference: 'tie', confidence: 0.8 })), 'baseline')).toBeLessThan(0.1)

    // two judges that always agree carry one effective vote; independent ones carry two
    const same = Array.from({ length: 6 }, (_, i) => [i % 2 ? 'candidate' : 'baseline', i % 2 ? 'candidate' : 'baseline'])
    const eSame = effectiveJudges(same)!
    expect(eSame.k).toBe(2)
    expect(eSame.nEff).toBeCloseTo(1, 1)
    const mixed = [['candidate', 'baseline'], ['baseline', 'candidate'], ['candidate', 'candidate'], ['baseline', 'baseline'], ['candidate', 'baseline'], ['baseline', 'candidate']]
    expect(effectiveJudges(mixed)!.nEff).toBeGreaterThan(1.5)
    expect(effectiveJudges([['a', 'b']])).toBeNull()

    // when only long submissions win, the equal-length rate falls below the raw win rate
    const biased = [
      ...Array.from({ length: 8 }, () => ({ won: true, lengthDiff: 4000 })),
      ...Array.from({ length: 8 }, () => ({ won: false, lengthDiff: -4000 })),
    ]
    const lc = equalLengthWinRate(biased)!
    expect(lc.slope).toBeGreaterThan(0)
    expect(lc.rate).toBeCloseTo(0.5, 1)
    expect(equalLengthWinRate([{ won: true, lengthDiff: 1 }])).toBeNull()
  })
})
