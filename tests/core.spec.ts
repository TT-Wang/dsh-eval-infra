import { describe, expect, it } from 'vitest'
import { bandAt, priceUsage } from '../src/core/pricing.js'
import { normalizeUsage } from '../src/core/usage.js'
import { bootstrapMean, signTest, wilson, median } from '../src/core/stats.js'
import { parseArm, parseComposedRows, diffComposedRows } from '../src/core/arms.js'
import { parseDotenv } from '../src/core/env.js'

describe('pricing', () => {
  it('classifies peak windows in UTC on weekdays only', () => {
    expect(bandAt(Date.UTC(2026, 8, 7, 2, 0))).toBe('peak')      // Monday 02:00 UTC
    expect(bandAt(Date.UTC(2026, 8, 7, 5, 0))).toBe('offpeak')   // Monday 05:00 UTC (gap)
    expect(bandAt(Date.UTC(2026, 8, 7, 9, 59))).toBe('peak')     // Monday 09:59 UTC
    expect(bandAt(Date.UTC(2026, 8, 7, 10, 0))).toBe('offpeak')  // Monday 10:00 UTC (end exclusive)
    expect(bandAt(Date.UTC(2026, 8, 6, 2, 0))).toBe('offpeak')   // Sunday
  })
  it('prices hit, miss and output at the band rates', () => {
    const u = { hit: 1_000_000, miss: 1_000_000, output: 1_000_000, reasoning: 0 }
    expect(priceUsage('deepseek-v4-flash', 'peak', u)).toBeCloseTo(0.014 + 0.44 + 1.32, 6)
    expect(priceUsage('deepseek-v4-flash', 'offpeak', u)).toBeCloseTo((0.014 + 0.44 + 1.32) / 2, 6)
    expect(priceUsage('deepseek-v4-pro', 'peak', u)).toBeCloseTo(0.044 + 1.32 + 3.96, 6)
    expect(priceUsage('unknown-model', 'peak', u)).toBe(0)
  })
})

describe('usage normalization', () => {
  it('reads the dsh TokenUsage shape (inputTokens = miss, cacheReadTokens = hit)', () => {
    expect(normalizeUsage({ inputTokens: 94, outputTokens: 4, totalTokens: 8418, cacheReadTokens: 8320, reasoningTokens: 0 })).toEqual({ hit: 8320, miss: 94, output: 4, reasoning: 0 })
  })
  it('reads the OpenAI shape (prompt_tokens is the total)', () => {
    expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens_details: { reasoning_tokens: 3 } })).toEqual({ hit: 900, miss: 100, output: 10, reasoning: 3 })
    expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 250 } })).toEqual({ hit: 250, miss: 750, output: 10, reasoning: 0 })
  })
  it('returns undefined for nothing', () => {
    expect(normalizeUsage(undefined)).toBeUndefined()
    expect(normalizeUsage({})).toBeUndefined()
  })
})

describe('stats', () => {
  it('small-sample interval is a t-interval below ten units and normal quantiles are accurate', async () => {
    const { smallSampleCI, normalQuantile } = await import('../src/core/stats.js')
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 4)
    expect(normalQuantile(0.9875)).toBeCloseTo(2.2414, 3)
    const ci = smallSampleCI([-10, -12, -8, -11, -9])
    expect(ci.mean).toBeCloseTo(-10, 6)
    expect(ci.hi).toBeLessThan(0)
    const adj = smallSampleCI([-10, -12, -8, -11, -9], 2000, 42, 0.025)
    expect(adj.hi - adj.lo).toBeGreaterThan(ci.hi - ci.lo)
    expect(smallSampleCI([1]).significant).toBe(false)
  })
  it('bootstrap interval covers zero for noise and excludes it for a clear effect', () => {
    const noise = [0.1, -0.2, 0.05, -0.1, 0.15, -0.05, 0.02, -0.03]
    expect(bootstrapMean(noise).significant).toBe(false)
    const effect = [-1, -1.2, -0.8, -1.1, -0.9, -1.3, -1.0, -0.7]
    const ci = bootstrapMean(effect)
    expect(ci.significant).toBe(true)
    expect(ci.hi).toBeLessThan(0)
    expect(ci.mean).toBeCloseTo(-1, 1)
  })
  it('is deterministic for a seed', () => {
    const a = bootstrapMean([1, 2, 3, 4, 5], 500, 7)
    const b = bootstrapMean([1, 2, 3, 4, 5], 500, 7)
    expect(a).toEqual(b)
  })
  it('sign test and wilson behave', () => {
    expect(signTest(0, 0)).toBe(1)
    expect(signTest(5, 0)).toBeCloseTo(2 / 32, 6)
    expect(signTest(3, 3)).toBe(1)
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 0 })
    const w = wilson(3, 3)
    expect(w.lo).toBeGreaterThan(0.4)
    expect(w.hi).toBe(1)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
})

describe('arms', () => {
  it('parses an arm file and rejects bad names', () => {
    const a = parseArm('name: fold\nmodel: deepseek-v4-flash\neffort: high\npatches:\n  - insert:\n      - id: fold\n        name: x\n')
    expect(a.name).toBe('fold')
    expect(a.patches).toHaveLength(1)
    expect(() => parseArm('name: "bad name"')).toThrow(/identifier/)
    expect(() => parseArm('- a\n- b')).toThrow(/mapping/)
  })
  it('diffs composed trees row by row, ignoring provenance comments and keeping !!js opaque', () => {
    const a = parseComposedRows(`# == base\n- id: tools\n  name: '@deepseek-ai/dsh-tools'\n  config:\n    mode: !!js process.env.X\n- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n`)
    const b = parseComposedRows(`# == base\n- id: tools\n  name: '@deepseek-ai/dsh-tools'\n  config:\n    mode: !!js process.env.X\n- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  disabled: true\n- id: fold\n  name: 'fold'\n`)
    const d = diffComposedRows(a, b)
    expect(d.map(x => `${x.kind}:${x.id}:${x.fields.join(',')}`)).toEqual(['changed:tool-web:disabled', 'added:fold:'])
    expect(diffComposedRows(a, a)).toEqual([])
  })
})

describe('dotenv', () => {
  it('parses quoted and exported values without executing anything', () => {
    expect(parseDotenv('# c\nexport A="x y"\nB=\'z\'\nC=plain\n')).toEqual({ A: 'x y', B: 'z', C: 'plain' })
  })
})

describe('report claims', () => {
  it('needs at least five comparable scenarios before calling a direction', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, usd: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep: 1, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: '' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const plan = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: ['s1', 's2'], repeats: 1, concurrency: 1, scenarioRoot: '' }
    const two = buildReport(plan, [mk('s1', 'a', 1), mk('s1', 'b', 1.2), mk('s2', 'a', 1), mk('s2', 'b', 1.15)])
    expect(two.candidates[0]!.costReading).toBe('inconclusive')
    expect(two.candidates[0]!.verdict).toMatch(/Only 2 comparable scenarios/)
    const plan3 = { ...plan, scenarios: ['s1', 's2', 's3'] }
    const three = buildReport(plan3, [mk('s1', 'a', 1), mk('s1', 'b', 1.2), mk('s2', 'a', 1), mk('s2', 'b', 1.15), mk('s3', 'a', 1), mk('s3', 'b', 1.25)])
    expect(three.candidates[0]!.costReading).toBe('inconclusive')          // three scenarios never support a direction
    expect(three.candidates[0]!.verdict).toMatch(/Only 3 comparable scenarios/)
    const names5 = ['s1', 's2', 's3', 's4', 's5']
    const plan5 = { ...plan, scenarios: names5 }
    const five = buildReport(plan5, names5.flatMap((n, i) => [mk(n, 'a', 1), mk(n, 'b', 1.15 + i * 0.02)]))
    expect(five.candidates[0]!.costReading).toBe('more-expensive')
    expect(five.candidates[0]!.grade).toBe('regression')
    expect(five.candidates[0]!.mdePct).toBeGreaterThan(0)
    const flat = buildReport(plan5, names5.flatMap((n, i) => [mk(n, 'a', 1), mk(n, 'b', 1 + (i % 2 ? 0.01 : -0.01))]))
    expect(flat.candidates[0]!.costReading).toBe('equivalent')
    expect(flat.candidates[0]!.grade).toBe('tie')
    expect(flat.candidates[0]!.passDiffCI.mean).toBe(0)
    // a directional interval that reaches into a measured A/A noise band is not a call
    const noisy = buildReport(plan5, names5.flatMap((n, i) => [mk(n, 'a', 1), mk(n, 'b', 1.15 + i * 0.02)]), { noiseFloors: { a: { runId: 'aa', scenarios: 5, meanAbsPct: 16, lo: -20, hi: 20 } } })
    expect(noisy.candidates[0]!.costReading).toBe('inconclusive')
    expect(noisy.candidates[0]!.verdict).toMatch(/noise band/)
  })
  it('flags flaky scenarios, groups failure reasons, and carries an A/A noise floor into the notes', async () => {
    const { buildReport, noiseFloorOf } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, rep: number, ok: boolean, usd: number, detail = ok ? 'ok' : 'answer.txt missing') => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail }, behaviour: { toolErrors: ok ? 0 : 2, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const plan = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: ['s1'], repeats: 2, concurrency: 1, scenarioRoot: '' }
    const rep = buildReport(plan, [mk('s1', 'a', 1, true, 1), mk('s1', 'a', 2, false, 1), mk('s1', 'b', 1, true, 1), mk('s1', 'b', 2, true, 1)], { noiseFloors: { a: { runId: 'aa1', scenarios: 4, meanAbsPct: 12, lo: -15, hi: 14 } } })
    const c = rep.candidates[0]!
    expect(c.flaky).toEqual(['s1'])
    expect(c.scenarios[0]!.failures.baseline[0]).toEqual({ reason: 'answer.txt missing', n: 1 })
    expect(c.scenarios[0]!.behaviour.baseline.toolErrors).toBe(1)
    expect(c.noiseFloor?.runId).toBe('aa1')
    expect(rep.notes.join(' ')).toMatch(/A\/A run aa1/)
    const aaPlan = { ...plan, candidates: [{ name: 'a-aa' }] }
    const floor = noiseFloorOf(aaPlan, [mk('s1', 'a', 1, true, 1), mk('s1', 'a-aa', 1, true, 1.1)])
    expect(floor).toMatchObject({ runId: 'r', scenarios: 1 })
    expect(floor!.meanAbsPct).toBeCloseTo(10, 5)
  })
  it('parses boolean flags without swallowing the next positional', async () => {
    const { parseArgs } = await import('../src/cli.js')
    const a = parseArgs(['run', '--baseline', 'base', '--aa', 'm1*', '--repeats', '2', '--allow-multi', 'p1*'])
    expect(a.flags['aa']).toBe(true)
    expect(a.flags['allow-multi']).toBe(true)
    expect(a.flags['repeats']).toBe('2')
    expect(a.positional).toEqual(['m1*', 'p1*'])
  })
})

describe('paired statistics', () => {
  it('icc, mcnemar mid-p, resolution and sequence similarity behave', async () => {
    const { icc, mcnemar, resolution, sequenceSimilarity } = await import('../src/core/stats.js')
    expect(icc([[1, 1.1], [5, 5.2], [9, 9.1]]).rho).toBeGreaterThan(0.9)
    expect(icc([[1, 9], [5, 1], [9, 5]]).rho).toBe(0)
    expect(icc([[1], [2]]).designEffect).toBe(1)
    const m = mcnemar(8, 1)
    expect(m.midP).toBeLessThan(0.05)
    expect(m.pWin).toBeGreaterThan(0.95)
    expect(mcnemar(0, 0)).toMatchObject({ exactP: 1, midP: 1, pWin: 0.5 })
    const even = mcnemar(3, 3)
    expect(even.pWin).toBeCloseTo(0.5, 2)
    expect(even.inRope).toBeGreaterThan(0.3)
    const r = resolution([-10, -12, -8, -11])
    expect(r.nStar).toBeLessThanOrEqual(4)
    expect(r.q).toBeGreaterThanOrEqual(1)
    const weak = resolution([-1, 12, -8, 3])
    expect(weak.q).toBeLessThan(1)
    expect(sequenceSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1)
    expect(sequenceSimilarity(['a', 'b', 'c'], ['a', 'x', 'c'])).toBeCloseTo(2 / 3, 6)
    expect(sequenceSimilarity([], [])).toBe(1)
  })
})

describe('cuped', () => {
  it('removes variance explained by the archived baseline cost and reports the adjusted interval', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, usd: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep: 1, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: '' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const names = ['s1', 's2', 's3', 's4', 's5', 's6']
    const plan = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: names, repeats: 1, concurrency: 1, scenarioRoot: '' }
    // Δ% grows with the scenario's historical cost (expensive scenarios drift more), plus a constant −10% effect.
    const prior = Object.fromEntries(names.map((n, i) => [n, 1 + i]))
    const ledgers = names.flatMap((n, i) => [mk(n, 'a', 1), mk(n, 'b', 1 + (-0.10 + 0.05 * (i - 2.5)))])
    const raw = buildReport(plan, ledgers)
    const adj = buildReport(plan, ledgers, { priorBaselineUsd: prior })
    expect(adj.candidates[0]!.cuped).not.toBeNull()
    expect(adj.candidates[0]!.cuped!.varianceRemoved).toBeGreaterThan(0.9)
    expect(adj.candidates[0]!.cuped!.ci.hi - adj.candidates[0]!.cuped!.ci.lo).toBeLessThan(raw.candidates[0]!.costPctCI.hi - raw.candidates[0]!.costPctCI.lo)
    expect(adj.candidates[0]!.cuped!.ci.mean).toBeCloseTo(-10, 0)
    expect(adj.notes.join(' ')).toMatch(/CUPED/)
  })
})

describe('anytime-valid sequences', () => {
  it('asymptotic CS shrinks with t and excludes zero for a clear effect; betting CS keeps 1/2 under the null', async () => {
    const { asympCS, bettingCS } = await import('../src/core/stats.js')
    const clear = Array.from({ length: 12 }, (_, i) => -20 + (i % 3) * 2)
    const a = asympCS(clear, 0.05, 12)
    expect(a.hi).toBeLessThan(0)
    const early = asympCS(clear.slice(0, 3), 0.05, 12)
    expect(early.hi - early.lo).toBeGreaterThan(a.hi - a.lo)
    const noise = [3, -4, 2, -1, 5, -6, 1, -2, 4, -3]
    const n = asympCS(noise, 0.05, 10)
    expect(n.lo).toBeLessThan(0)
    expect(n.hi).toBeGreaterThan(0)
    const nullX = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.5 : 0.5))
    const bnull = bettingCS(nullX)
    expect(bnull.lo).toBeLessThanOrEqual(0.5)
    expect(bnull.hi).toBeGreaterThanOrEqual(0.5)
    const wins = Array.from({ length: 20 }, () => 1)
    const bw = bettingCS(wins)
    expect(bw.lo).toBeGreaterThan(0.5)
  })
})

describe('hedged betting sequence', () => {
  it('is two-sided, valid at every t, shrinks, and excludes the null for a clear bounded effect', async () => {
    const { bettingCS } = await import('../src/core/stats.js')
    const CAP = 2
    const ratios = Array.from({ length: 12 }, (_, i) => (0.6 + (i % 3) * 0.02) / CAP)   // candidate at ~62% of baseline cost
    const c = bettingCS(ratios)
    expect(c.hi * CAP).toBeLessThan(1)
    expect(c.lo * CAP).toBeGreaterThan(0.2)
    const early = bettingCS(ratios.slice(0, 3))
    expect(early.hi - early.lo).toBeGreaterThan(c.hi - c.lo)
    const noisy = Array.from({ length: 10 }, (_, i) => (i % 2 ? 1.3 : 0.7) / CAP)
    const n = bettingCS(noisy)
    expect(n.lo * CAP).toBeLessThan(1)
    expect(n.hi * CAP).toBeGreaterThan(1)
    const expensive = Array.from({ length: 12 }, () => 1.6 / CAP)
    expect(bettingCS(expensive).lo * CAP).toBeGreaterThan(1)
    expect(bettingCS([]).t).toBe(0)
  })
})

describe('hierarchical bootstrap and holdout', () => {
  it('hierarchical bootstrap widens the interval when repeats disagree and matches the scenario bootstrap with one value per scenario', async () => {
    const { bootstrapHierarchical, bootstrapMean } = await import('../src/core/stats.js')
    const single = [[-10], [-12], [-8], [-11]]
    const a = bootstrapHierarchical(single, 1000, 7)
    const b = bootstrapMean(single.map(g => g[0]!), 1000, 7)
    expect(a.mean).toBeCloseTo(b.mean, 6)
    expect(Math.abs((a.hi - a.lo) - (b.hi - b.lo))).toBeLessThan(2)
    const noisy = [[-30, 10], [-32, 8], [-28, 12], [-31, 9]]
    const c = bootstrapHierarchical(noisy, 1000, 7)
    expect(c.hi - c.lo).toBeGreaterThan(a.hi - a.lo)
    expect(c.mean).toBeCloseTo(-10.25, 2)
  })
  it('reads intervals at alpha/m with several candidates and reports the dev–holdout gap', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, ok: boolean, usd: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep: 1, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail: '' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const plan = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }, { name: 'c' }], scenarios: ['d1', 'd2', 'h1'], repeats: 1, concurrency: 1, scenarioRoot: '' }
    const ledgers = [
      mk('d1', 'a', false, 1), mk('d1', 'b', true, 1), mk('d1', 'c', true, 1),
      mk('d2', 'a', false, 1), mk('d2', 'b', true, 1), mk('d2', 'c', true, 1),
      mk('h1', 'a', true, 1), mk('h1', 'b', false, 1), mk('h1', 'c', true, 1),
    ]
    const rep = buildReport(plan, ledgers, { holdout: new Set(['h1']) })
    expect(rep.candidates[0]!.alpha).toBeCloseTo(0.0125, 6)
    expect(rep.notes.join(' ')).toMatch(/Bonferroni/)
    const b = rep.candidates[0]!
    expect(b.holdoutGap).toEqual({ dev: 100, holdout: -100, devScenarios: 2, holdoutScenarios: 1 })
    expect(rep.notes.join(' ')).toMatch(/tuned to the dev pool/)
    expect(b.scenarios.find(p => p.scenario === 'h1')!.holdout).toBe(true)
  })
})

describe('ground-truth stash', () => {
  it('moves <workdir>/.truth out during the run and restores it for verify', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { stashTruth } = await import('../src/core/runner.js')
    const work = mkdtempSync(join(tmpdir(), 'dsh-eval-truth-'))
    const stashRoot = mkdtempSync(join(tmpdir(), 'dsh-eval-stash-'))
    try {
      expect(stashTruth(work, stashRoot)).toBeUndefined()
      mkdirSync(join(work, '.truth'))
      writeFileSync(join(work, '.truth', 'answer.json'), '{"x":1}')
      const restore = stashTruth(work, stashRoot)!
      expect(existsSync(join(work, '.truth'))).toBe(false)
      restore()
      expect(existsSync(join(work, '.truth', 'answer.json'))).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(stashRoot, { recursive: true, force: true })
    }
  })
})

describe('esm hygiene', () => {
  it('never uses CommonJS require in the shipped sources', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e)) {
          const src = readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
          if (/\brequire\(/.test(src)) offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '..', 'src'))
    expect(offenders).toEqual([])
  })
})

describe('scenario signal', () => {
  it('scores between-arm over within-arm cost variance and needs two arms with two trials', async () => {
    const { scenarioSignal } = await import('../src/core/signal.js')
    expect(scenarioSignal([{ arm: 'a', usd: [1], passes: [1] }, { arm: 'b', usd: [2], passes: [0] }]).snr).toBeNull()
    const strong = scenarioSignal([{ arm: 'a', usd: [1.0, 1.02, 0.98], passes: [1, 1, 1] }, { arm: 'b', usd: [2.0, 2.02, 1.98], passes: [1, 1, 1] }])
    expect(strong.snr!).toBeGreaterThan(1)
    expect(strong.passSpread).toBe(0)
    const noisy = scenarioSignal([{ arm: 'a', usd: [1, 3, 2], passes: [1, 0, 1] }, { arm: 'b', usd: [2, 1, 3], passes: [1, 1, 1] }])
    expect(noisy.snr!).toBeLessThan(1)
    expect(noisy.passSpread).toBeCloseTo(1 / 3, 6)
  })
})

describe('paraphrase variants', () => {
  it('keeps well-formed paraphrases and rejects malformed or identical ones', async () => {
    const { generateVariants } = await import('../src/core/perturb.js')
    const { listScenarios } = await import('../src/core/scenario.js')
    const { scenarios } = listScenarios(new URL('./fixtures/scenarios', import.meta.url).pathname, { names: ['t1*'] })
    const s = scenarios[0]!
    let call = 0
    const chat = async (): Promise<{ text: string; usage: { hit: number; miss: number; output: number } }> => {
      call += 1
      const usage = { hit: 0, miss: 100, output: 20 }
      if (call === 1) return { text: JSON.stringify({ prompts: s.prompts.map(p => `Please ${p}`) }), usage }
      if (call === 2) return { text: 'not json', usage }
      if (call === 3) return { text: JSON.stringify({ prompts: s.prompts }), usage }
      return { text: JSON.stringify({ prompts: ['only one'] }), usage }
    }
    const r = await generateVariants(s, 4, chat)
    expect(r.variants).toHaveLength(1)
    expect(r.rejected).toEqual(['variant 2: not JSON', 'variant 3: identical to the original', 'variant 4: wrong shape'])
    expect(r.usd).toBeGreaterThan(0)
  })
})

describe('project prices', () => {
  it('merges configured models over the built-in DeepSeek table and leaves the table alone otherwise', async () => {
    const { projectPrices, DEFAULT_CONFIG } = await import('../src/core/project.js')
    const { DEEPSEEK_PRICES, priceUsage } = await import('../src/core/pricing.js')
    expect(projectPrices(DEFAULT_CONFIG)).toBeUndefined()
    const table = projectPrices({ ...DEFAULT_CONFIG, prices: { asOf: '2026-09-04', models: { 'gpt-5.2': { hit: { peak: 1, offpeak: 1 }, miss: { peak: 2, offpeak: 2 }, output: { peak: 8, offpeak: 8 } } } } })!
    expect(Object.keys(table.models)).toEqual(expect.arrayContaining(['deepseek-v4-flash', 'gpt-5.2']))
    expect(table.peak).toEqual(DEEPSEEK_PRICES.peak)
    expect(priceUsage('gpt-5.2', 'peak', { hit: 1e6, miss: 1e6, output: 1e6, reasoning: 0 }, table)).toBeCloseTo(11, 6)
  })
})

describe('behavioural drift', () => {
  it('finds no drift between like distributions and drift when the tool mix changes', async () => {
    const { driftTest } = await import('../src/core/drift.js')
    const mkL = (scenario: string, arm: string, rep: number, calls: string[]): any => ({ scenario, arm, rep, steps: calls.map(c => ({ calls: [{ name: c }] })), totals: { usd: 0 }, verdict: { ok: true } })
    const archive = [1, 2, 3, 4].flatMap(r => [mkL('s1', 'base', r, ['read', 'grep', 'bash', 'read']), mkL('s2', 'base', r, ['bash', 'bash', 'write'])])
    const same = [5, 6].flatMap(r => [mkL('s1', 'base', r, ['read', 'grep', 'bash', 'read']), mkL('s2', 'base', r, ['bash', 'bash', 'write'])])
    const changed = [5, 6].flatMap(r => [mkL('s1', 'base', r, ['todo_write', 'todo_write', 'todo_write', 'write']), mkL('s2', 'base', r, ['todo_write', 'todo_write', 'todo_write'])])
    expect(driftTest(same, archive).verdict).toBe('no-drift')
    const d = driftTest(changed, archive)
    expect(d.verdict).toBe('drift')
    expect(d.p).toBeLessThan(0.05)
    expect(driftTest([mkL('s9', 'base', 1, ['read'])], archive).verdict).toBe('insufficient')
  })
})
