import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bandAt, priceUsage } from '../src/core/pricing.js'
import { normalizeUsage } from '../src/core/usage.js'
import { bootstrapMean, signTest, wilson, median } from '../src/core/stats.js'
import { applyRoute, parseArm, parseComposedRows, diffComposedRows } from '../src/core/arms.js'
import { parseDotenv } from '../src/core/env.js'
import { prepareArms } from '../src/core/plan.js'
import { loadProject, withPreviewArms } from '../src/core/project.js'

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
    const ledgers5 = names5.flatMap((n, i) => [mk(n, 'a', 1), mk(n, 'b', 1.15 + i * 0.02)])
    // no A/A floor on file: the interval excludes zero, but no direction is read until "no change" has been measured on this baseline
    const unfloored = buildReport(plan5, ledgers5)
    expect(unfloored.candidates[0]!.costPctCI.significant).toBe(true)
    expect(unfloored.candidates[0]!.costReading).toBe('inconclusive')
    expect(unfloored.candidates[0]!.floor).toBe('missing')
    expect(unfloored.candidates[0]!.verdict).toMatch(/no A\/A floor has been measured/)
    expect(unfloored.notes.join(' ')).toMatch(/directions .* are not read without one/)
    const tightFloor = { runId: 'aa', scenarios: 5, meanAbsPct: 2, lo: -3, hi: 3 }
    const five = buildReport(plan5, ledgers5, { noiseFloors: { a: tightFloor } })
    expect(five.candidates[0]!.costReading).toBe('more-expensive')
    expect(five.candidates[0]!.floor).toBe('ok')
    expect(five.candidates[0]!.grade).toBe('regression')
    expect(five.candidates[0]!.mdePct).toBeGreaterThan(0)
    // a floor with too few scenarios does not count as a floor
    expect(buildReport(plan5, ledgers5, { noiseFloors: { a: { ...tightFloor, scenarios: 4 } } }).candidates[0]!.floor).toBe('thin')
    // the veto band is the A/A interval: a wide mean|Δ%| with a narrow interval does not veto, a narrow mean|Δ%| with a wide interval does
    expect(buildReport(plan5, ledgers5, { noiseFloors: { a: { ...tightFloor, meanAbsPct: 30 } } }).candidates[0]!.costReading).toBe('more-expensive')
    expect(buildReport(plan5, ledgers5, { noiseFloors: { a: { ...tightFloor, meanAbsPct: 1, lo: -2, hi: 16 } } }).candidates[0]!.costReading).toBe('inconclusive')
    // drift since the floor was measured makes it stale: no direction, and CUPED is not applied either
    const stale = buildReport(plan5, ledgers5, { noiseFloors: { a: tightFloor }, priorBaselineUsd: Object.fromEntries(names5.map((n, i) => [n, 1 + i * 0.1])), drift: { scenarios: 5, current: 5, archive: 20, distance: 0.9, p: 0.001, verdict: 'drift' } })
    expect(stale.candidates[0]!.floor).toBe('stale')
    expect(stale.candidates[0]!.costReading).toBe('inconclusive')
    expect(stale.candidates[0]!.cuped).toBeNull()
    // equivalence is not a direction: it needs no floor
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
    const rep = buildReport(plan, [mk('s1', 'a', 1, true, 1), mk('s1', 'a', 2, false, 1), mk('s1', 'b', 1, true, 1), mk('s1', 'b', 2, true, 1)], { noiseFloors: { a: { runId: 'aa1', scenarios: 5, meanAbsPct: 12, lo: -15, hi: 14 } } })
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
    expect(floor!.steps).toBeDefined()                                    // the floor carries a band on steps too
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
    expect(mcnemar(0, 0)).toMatchObject({ exactP: 1, midP: 1, pWin: 0.5, inRope: 0.2 })   // flat prior: 20% inside ±0.1, not certainty of equivalence
    const even = mcnemar(3, 3)
    expect(even.pWin).toBeCloseTo(0.5, 2)
    expect(even.inRope).toBeGreaterThan(0.3)
    const r = resolution([-10, -12, -8, -11])
    expect(r.nStar).toBeLessThanOrEqual(4)
    expect(r.q).toBeGreaterThanOrEqual(1)
    const weak = resolution([-1, 12, -8, 3])
    expect(weak.q).toBeLessThan(1)
    expect(resolution([-1, 12, -8, 3], 0.025).nStar!).toBeGreaterThan(weak.nStar!)   // N* grows with a stricter alpha
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
    const ratios = Array.from({ length: 24 }, (_, i) => (0.6 + (i % 3) * 0.02) / CAP)   // candidate at ~62% of baseline cost
    const c = bettingCS(ratios)
    expect(c.hi * CAP).toBeLessThan(1)
    expect(c.lo * CAP).toBeGreaterThan(0.2)
    const early = bettingCS(ratios.slice(0, 3))
    expect(early.hi - early.lo).toBeGreaterThan(c.hi - c.lo)
    const noisy = Array.from({ length: 10 }, (_, i) => (i % 2 ? 1.3 : 0.7) / CAP)
    const n = bettingCS(noisy)
    expect(n.lo * CAP).toBeLessThan(1)
    expect(n.hi * CAP).toBeGreaterThan(1)
    const expensive = Array.from({ length: 24 }, () => 1.6 / CAP)
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

describe('served-model probes', () => {
  it('separates two answer distributions and accepts a resample of the same one', async () => {
    const { collectProbes, probePermutationTest, compareWithReference, PROBES } = await import('../src/core/probe.js')
    const usage = { hit: 0, miss: 20, output: 5 }
    const mk = (answers: string[]) => { let i = 0; return async () => ({ text: JSON.stringify({ answer: answers[i++ % answers.length] }), usage }) }
    // a route that fails every call yields no samples instead of throwing
    const dead = await collectProbes(async () => { throw new Error('fetch failed') }, 2)
    expect(dead.samples).toHaveLength(0)
    expect(dead.failures.length).toBeGreaterThan(0)
    const a = await collectProbes(mk(['Blue', 'blue', 'blue', 'green']), 4)
    const b = await collectProbes(mk(['Blue', 'blue', 'blue', 'green']), 4)
    const c = await collectProbes(mk(['red', 'red', 'crimson', 'red']), 4)
    expect(a.samples).toHaveLength(PROBES.length * 4)
    expect(a.usd).toBeGreaterThan(0)
    expect(probePermutationTest(a.samples, b.samples, 200).distance).toBe(0)
    const differs = probePermutationTest(a.samples, c.samples, 200)
    expect(differs.distance).toBeGreaterThan(0.5)
    expect(differs.p).toBeLessThan(0.01)
    const { batterySha } = await import('../src/core/probe.js')
    const ref = { schema: 'dsh-eval-probe/1' as const, model: 'm', baseUrl: 'u', batterySha: batterySha(), enrolledAt: '2026-09-01T00:00:00Z', samples: a.samples, usd: 0 }
    expect(compareWithReference(b.samples, ref, 'm', 0).verdict).toBe('matches')
    // a reference built from a different battery is not comparable and must not read as a difference
    expect(compareWithReference(c.samples, { ...ref, batterySha: 'other' }, 'm', 0).verdict).toBe('no-reference')
    expect(compareWithReference(c.samples, ref, 'm', 0).verdict).toBe('differs')
    expect(compareWithReference(c.samples, null, 'm', 0).verdict).toBe('no-reference')
    // a battery that could not be collected is not evidence of a substitution
    const partial = compareWithReference(a.samples.slice(0, 3), ref, 'm', 0)
    expect(partial.verdict).toBe('not-completed')
    expect(partial.error).toMatch(/came back/)
  })

  it('withholds readings when the probe says the route differs', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const names5 = ['s1', 's2', 's3', 's4', 's5']
    const plan5 = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: names5, repeats: 1, concurrency: 1, scenarioRoot: '' }
    const ledger = (scenario: string, arm: string, usd: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep: 1, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: '' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const ledgers5 = names5.flatMap((n, i) => [ledger(n, 'a', 1), ledger(n, 'b', 1.15 + i * 0.02)])
    const floor = { noiseFloors: { a: { runId: 'aa', scenarios: 5, meanAbsPct: 2, lo: -3, hi: 3 } } }
    const clean = buildReport(plan5, ledgers5, floor)
    expect(clean.candidates[0]!.costReading).not.toBe('inconclusive')
    const gated = buildReport(plan5, ledgers5, { ...floor, probe: { model: 'deepseek-v4-flash', distance: 0.62, p: 0.001, probes: 8, samplesPerSide: 8, verdict: 'differs', comparedAt: '2026-09-04T00:00:00Z', usd: 0.01 } })
    expect(gated.candidates[0]!.costReading).toBe('inconclusive')
    expect(gated.candidates[0]!.verdict).toContain('Provider conditions not held constant')
    expect(gated.notes.some(n => n.startsWith('Served-model probe'))).toBe(true)
  })
})

describe('pattern discovery', () => {
  it('collapses like failures into one signature, thresholds behaviour on the archive, and ranks arm-skewed patterns first', async () => {
    const { discoverPatterns, failureSignature } = await import('../src/core/patterns.js')
    expect(failureSignature("answers.json missing/unreadable: [Errno 2] No such file or directory: '/tmp/x/answers.json'"))
      .toBe(failureSignature("answers.json missing/unreadable: [Errno 2] No such file or directory: '/tmp/other/answers.json'"))
    // Signatures are displayed, so an unquoted path or a file:// URL must not survive
    // into one: it is someone's home directory, and it splits one failure into two.
    for (const raw of [
      'json-rpc input closed, stderr tail: file:///Users/someone/code/dsh/packages/cli/index.js:42',
      'verifier crashed reading /Users/someone/work/out.json',
      'verifier crashed reading /home/ci/work/out.json',
    ]) expect(failureSignature(raw), raw).not.toMatch(/someone|\/home\/ci/)
    expect(failureSignature('verifier crashed reading /Users/a/out.json'))
      .toBe(failureSignature('verifier crashed reading /home/b/out.json'))
    const mk = (scenario: string, arm: string, rep: number, ok: boolean, detail: string, toolErrors = 0) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: `r${rep}`, scenario, arm, rep, order: 0, startedAt: `2026-09-0${rep}T00:00:00Z`, endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 5, turns: 1, usd: 1, usdPeak: 1, usdOffpeak: 1, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail }, behaviour: { toolErrors, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const ledgers = [
      ...[1, 2, 3].map(r => mk('s1', 'cand', r, false, `out.json missing: [Errno 2] No such file or directory: '/tmp/${r}/out.json'`, 4)),
      ...[1, 2, 3].map(r => mk('s1', 'base', r, true, 'ok')),
      ...[1, 2, 3].map(r => mk('s2', 'base', r, true, 'ok')),
      ...[1, 2, 3].map(r => mk('s2', 'cand', r, true, 'ok')),
    ]
    const patterns = discoverPatterns(ledgers)
    const failure = patterns.find(p => p.kind === 'failure')!
    expect(failure.count).toBe(3)              // three differing paths, one signature
    expect(failure.arms).toEqual(['cand'])
    expect(failure.armSkew).toBeCloseTo(0.5, 6)  // half of cand's trials, none of base's
    expect(patterns[0]!.signature).toBe(failure.signature)   // most arm-skewed first
    expect(discoverPatterns(ledgers.slice(0, 2))).toEqual([])  // nothing recurs three times
  })

  it('maps a diverging tool call to the number of provider responses to replay', async () => {
    const { forkPointForCall } = await import('../src/core/orchestrate.js')
    const ledger = { steps: [{ calls: [{ name: 'read' }] }, { calls: [{ name: 'grep' }, { name: 'read' }] }, { calls: [{ name: 'write' }] }] } as never
    expect(forkPointForCall(ledger, 1)).toEqual({ forkAt: 0, step: 1 })
    expect(forkPointForCall(ledger, 2)).toEqual({ forkAt: 1, step: 2 })
    expect(forkPointForCall(ledger, 3)).toEqual({ forkAt: 1, step: 2 })
    expect(forkPointForCall(ledger, 4)).toEqual({ forkAt: 2, step: 3 })
    expect(forkPointForCall(ledger, 99)).toEqual({ forkAt: 2, step: 3 })
  })
})

describe('arm previews', () => {
  it('compose in private scratch directories, so concurrent previews cannot clobber one another', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-preview-'))
    const project = loadProject(root)
    // dsh reads the overlay files back; echo the arm's own overlay as the composed
    // tree, after a yield, so the calls interleave the way two browser requests do.
    const invoke = async (args: string[]): Promise<string> => {
      const overlay = args[args.length - 1]!
      await new Promise(resolve => setTimeout(resolve, 5))
      return readFileSync(overlay, 'utf8')
    }
    const compose = (rowId: string): Promise<string[]> => withPreviewArms(project, async (armsDir) => {
      const prepared = await prepareArms({ name: 'candidate', patches: [{ id: rowId, disabled: true }] }, [], { evalHome: project.home, armsDir, invoke })
      return [...(prepared.trees.get('candidate') ?? new Map()).keys()]
    })
    const ids = ['row-a', 'row-b', 'row-c', 'row-d']
    expect(await Promise.all(ids.map(compose))).toEqual(ids.map(id => [id]))
    // and each directory is removed when its preview is done
    expect(readdirSync(project.evalDir).filter(e => e.startsWith('tmp-arms'))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})


describe('run route', () => {
  it('pins every arm to the run\'s model and effort, and says so when an arm declared its own', () => {
    const lines: string[] = []
    const log = (l: string): void => { lines.push(l) }
    const a = applyRoute({ name: 'baseline' }, { model: 'deepseek-v4-pro', effort: 'high' }, log)
    const b = applyRoute({ name: 'cand', model: 'deepseek-v4-flash', effort: 'low' }, { model: 'deepseek-v4-pro', effort: 'high' }, log)
    expect([a.model, a.effort]).toEqual(['deepseek-v4-pro', 'high'])
    expect([b.model, b.effort]).toEqual(['deepseek-v4-pro', 'high'])   // the arm's own choice does not survive
    expect(lines).toEqual([
      'arm cand declares model deepseek-v4-flash; the run uses deepseek-v4-pro for every arm',
      'arm cand declares effort low; the run uses high for every arm',
    ])
    // '' effort means the adapter default, and clears a declared one
    expect(applyRoute({ name: 'x', effort: 'max' }, { effort: '' }).effort).toBeUndefined()
    // no route at all leaves the arm alone
    expect(applyRoute({ name: 'x', model: 'm', effort: 'e' }, {})).toEqual({ name: 'x', model: 'm', effort: 'e' })
  })
})

describe('reliability first, then the north star', () => {
  it('estimates pass^j without bias and reads reliability from the scenarios where only one arm is reliable', async () => {
    const { passPow } = await import('../src/core/stats.js')
    expect(passPow(2, 3, 1)).toBeCloseTo(2 / 3, 6)   // pass rate
    expect(passPow(2, 3, 2)).toBeCloseTo(1 / 3, 6)   // one of the three pairs is all-pass
    expect(passPow(2, 3, 3)).toBe(0)                 // not every repeat passed
    expect(passPow(3, 3, 3)).toBe(1)
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, rep: number, ok: boolean, usd = 1, steps = 10) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep, order: 0, startedAt: '2026-09-05T00:00:00Z', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail: ok ? 'ok' : 'wrong' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const scenarios = ['s1', 's2', 's3', 's4', 's5', 's6']
    const plan = { id: 'r', createdAt: '', baseline: { name: 'base' }, candidates: [{ name: 'cand' }], scenarios, repeats: 3, concurrency: 1, scenarioRoot: '' }
    // The baseline passes two of three repeats everywhere (flaky); the candidate passes all three everywhere.
    const ledgers = scenarios.flatMap(s => [1, 2, 3].flatMap(rep => [mk(s, 'base', rep, rep !== 3), mk(s, 'cand', rep, true)]))
    const r = buildReport(plan, ledgers).candidates[0]!
    expect(r.reliability).toMatchObject({ k: 3, scenarios: 6, baseline: 0, candidate: 1, b: 6, c: 0, reading: 'more-reliable' })
    expect(r.reliability.decay.baseline.map(v => Number(v.toFixed(3)))).toEqual([0.667, 0.333, 0])
    expect(r.reliability.decay.candidate).toEqual([1, 1, 1])
    // No regression: the baseline's third repeat failing where the candidate passes is an improvement, not a break.
    expect(r.gate).toBe('pass')
    // Identical arms read "same" — no scenario is reliable on one side only.
    const same = buildReport(plan, scenarios.flatMap(s => [1, 2, 3].flatMap(rep => [mk(s, 'base', rep, true), mk(s, 'cand', rep, true)]))).candidates[0]!
    expect(same.reliability).toMatchObject({ b: 0, c: 0, reading: 'same' })
    // Fewer than five complete scenarios cannot support a direction.
    const few = buildReport({ ...plan, scenarios: scenarios.slice(0, 3) }, ledgers.filter(l => scenarios.slice(0, 3).includes(l.scenario))).candidates[0]!
    expect(few.reliability.reading).toBe('inconclusive')
  })

  it('reads the north star the plan registered: efficiency on steps, cost by default, and grades from it', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, rep: number, usd: number, steps: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep, order: 0, startedAt: '2026-09-05T00:00:00Z', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: 'ok' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const scenarios = ['s1', 's2', 's3', 's4', 's5', 's6']
    // Same cost, the candidate takes 40% fewer steps on every scenario (with a little spread so an interval exists).
    const ledgers = scenarios.flatMap((s, i) => [1, 2].flatMap(rep => [mk(s, 'base', rep, 1, 20 + i), mk(s, 'cand', rep, 1, Math.round((20 + i) * 0.6) + (rep === 1 ? 0 : 1))]))
    const base = { id: 'r', createdAt: '', baseline: { name: 'base' }, candidates: [{ name: 'cand' }], scenarios, repeats: 2, concurrency: 1, scenarioRoot: '' }
    const cost = buildReport(base, ledgers).candidates[0]!
    expect(cost.northStar.metric).toBe('cost')
    expect(cost.northStar.reading).toBe('same')          // identical cost reads equivalent
    expect(cost.grade).toBe('tie')
    const noFloor = buildReport({ ...base, northStar: 'efficiency' as const }, ledgers).candidates[0]!
    expect(noFloor.northStar.reading).toBe('inconclusive')   // a direction on steps needs the A/A band on steps as much as cost does
    expect(noFloor.northStar.text).toMatch(/no A\/A floor/)
    const stepFloor = { noiseFloors: { base: { runId: 'aa', scenarios: 6, meanAbsPct: 1, lo: -2, hi: 2, steps: { lo: -4, hi: 4, scenarios: 6 } } } }
    const eff = buildReport({ ...base, northStar: 'efficiency' as const }, ledgers, stepFloor).candidates[0]!
    expect(eff.northStar.metric).toBe('efficiency')
    expect(eff.northStar.reading).toBe('better')
    expect(buildReport({ ...base, northStar: 'efficiency' as const }, ledgers, { noiseFloors: { base: { ...stepFloor.noiseFloors.base, steps: { lo: -50, hi: 5, scenarios: 6 } } } }).candidates[0]!.northStar.reading).toBe('inconclusive')
    expect(eff.northStar.ci!.mean).toBeLessThan(-30)
    expect(eff.grade).toBe('improvement')
    expect(eff.verdict).toMatch(/^Fewer steps by/)
    expect(eff.reliability.reading).toBe('same')
    // quality needs the judge; without one the reading is "none" and the grade does not pretend otherwise
    const q = buildReport({ ...base, northStar: 'quality' as const }, ledgers).candidates[0]!
    expect(q.northStar).toMatchObject({ metric: 'quality', reading: 'none' })
    expect(q.grade).toBe('inconclusive')
  })
})

describe('statistics review (H14–H19 and the medium findings)', () => {
  const led = (scenario: string, arm: string, rep: number, usd: number, ok = true, extra: Record<string, unknown> = {}) => ({
    schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
    turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 10, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail: ok ? 'ok' : 'answer.txt missing' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    ...extra,
  })
  const names = ['s1', 's2', 's3', 's4', 's5', 's6']
  const floor = { noiseFloors: { a: { runId: 'aa', scenarios: 6, meanAbsPct: 2, lo: -3, hi: 3 } } }
  const plan = (repeats: number, extra: Record<string, unknown> = {}) => ({ id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: names, repeats, concurrency: 1, scenarioRoot: '', ...extra })

  it('uses exact Student-t quantiles at the reading alpha (H3) and the planned-claim alpha per mode', async () => {
    const { tQuantile, tCritical, smallSampleCI } = await import('../src/core/stats.js')
    const { readingAlpha } = await import('../src/core/report.js')
    expect(tQuantile(0.9875, 4)).toBeCloseTo(3.4954, 3)     // n = 5 at alpha 0.025: the old table-times-normal-ratio gave 3.175
    expect(tQuantile(0.975, 1)).toBeCloseTo(12.706, 2)
    expect(tQuantile(0.975, 29)).toBeCloseTo(2.045, 3)
    expect(tCritical(4, 0.025)).toBeCloseTo(3.4954, 3)
    const ci = smallSampleCI([10, 12, 8, 11, 9], 2000, 42, 0.025)
    const s = Math.sqrt([10, 12, 8, 11, 9].map(v => (v - 10) ** 2).reduce((x, y) => x + y, 0) / 4)
    expect(ci.hi - ci.mean).toBeCloseTo(3.4954 * s / Math.sqrt(5), 3)
    expect(readingAlpha({ candidates: [{ name: 'b' }] })).toBeCloseTo(0.025, 10)
    expect(readingAlpha({ candidates: [{ name: 'b' }, { name: 'c' }] })).toBeCloseTo(0.0125, 10)
    expect(readingAlpha({ candidates: [{ name: 'b' }], sequential: true })).toBeCloseTo(0.05 / 3, 10)
  })

  it('calls a regression only when it is consistent, holds a majority-fail as suspected, and states the gate\'s chance level (H16)', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const p3 = plan(3)
    const rows = (candPasses: Record<string, number>, basePasses: Record<string, number> = {}) => names.flatMap(n => [1, 2, 3].flatMap(rep => [led(n, 'a', rep, 1, rep <= (basePasses[n] ?? 3)), led(n, 'b', rep, 1, rep <= (candPasses[n] ?? 3))]))
    // 3/3 vs 0/3: consistent, called
    const consistent = buildReport(p3, rows({ s1: 0 }), floor).candidates[0]!
    expect(consistent.gate).toBe('regressions')
    expect(consistent.regressions).toEqual(['s1'])
    expect(consistent.suspected).toEqual([])
    expect(consistent.regressionChance).toBeCloseTo(0.5 ** 6, 6)   // pooled p̂ = 1/2 on s1, 1 elsewhere
    expect(consistent.grade).toBe('regression')
    // 3/3 vs 1/3: majority-fail but not consistent — suspected, blocks the readings, is not called
    const susReport = buildReport(p3, rows({ s1: 1 }), floor)
    const sus = susReport.candidates[0]!
    expect(sus.gate).toBe('suspect')
    expect(sus.regressions).toEqual([])
    expect(sus.suspected).toEqual(['s1'])
    expect(sus.grade).toBe('inconclusive')
    expect(sus.verdict).toMatch(/^Suspected regression on 1 scenario \(s1: baseline 3\/3, b 1\/3\)/)
    expect(susReport.notes.join(' ')).toMatch(/screening rule/)
    // 2/3 vs 0/3: the baseline is flaky too — still suspected, never a call
    expect(buildReport(p3, rows({ s1: 0 }, { s1: 2 }), floor).candidates[0]!.gate).toBe('suspect')
    // 3/3 vs 2/3 is one discordant pair: same, flagged flaky
    const one = buildReport(p3, rows({ s1: 2 }), floor).candidates[0]!
    expect(one.gate).toBe('pass')
    expect(one.scenarios.find(s => s.scenario === 's1')!.class).toBe('same')
    expect(one.flaky).toEqual(['s1'])
    // improvements are held to the same bar: 0/3 → 3/3 is one, 1/3 → 3/3 is not
    expect(buildReport(p3, rows({}, { s1: 0 }), floor).candidates[0]!.improvements).toEqual(['s1'])
    expect(buildReport(p3, rows({}, { s1: 1 }), floor).candidates[0]!.improvements).toEqual([])
    // a flaky pool makes a consistent regression cheap to get by chance, and the verdict says so
    const flakyPool = names.flatMap(n => [1, 2, 3].flatMap(rep => [led(n, 'a', rep, 1, n === 's1' ? true : rep !== 2), led(n, 'b', rep, 1, n === 's1' ? false : rep !== 3)]))
    const noisy = buildReport(p3, flakyPool, floor).candidates[0]!
    expect(noisy.gate).toBe('regressions')
    expect(noisy.regressionChance!).toBeGreaterThan(0.05)
    expect(noisy.verdict).toMatch(/arises by chance with probability \d+%/)
  })

  it('withholds cost on unreconciled replayed trials too (H19)', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const ledgers = names.flatMap((n, i) => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.8 + i * 0.01, true, { usageProvenance: { source: 'replay', reconciled: i === 0 ? false : true, replay: { runId: 'old', replayed: 3, live: 0 } } })])
    const c = buildReport(plan(1), ledgers, floor).candidates[0]!
    expect(c.costReading).toBe('inconclusive')
    expect(c.verdict).toMatch(/withheld/)
  })

  it('does not treat one metered arm as a shared served model', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const meter = (model: string) => ({ usageProvenance: { source: 'meter', reconciled: true, meter: { requests: 1, forwarded: 1, faults: 0, hit: 0, miss: 0, output: 0, reasoning: 0, servedModels: [model] } } })
    const ok = buildReport(plan(1), names.flatMap((n, i) => [led(n, 'a', 1, 1, true, meter('m')), led(n, 'b', 1, 0.8 + i * 0.01, true, meter('m'))]), floor).candidates[0]!
    expect(ok.costReading).toBe('cheaper')
    const oneSided = buildReport(plan(1), names.flatMap((n, i) => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.8 + i * 0.01, true, meter('m'))]), floor).candidates[0]!
    expect(oneSided.costReading).toBe('inconclusive')
    expect(oneSided.verdict).toMatch(/no served-model record on a's comparable trials/)
  })

  it('reads pass^k over scenarios with every repeat, and every cost estimand over the same pairs', async () => {
    const { buildReport } = await import('../src/core/report.js')
    // s6 has only one of three repeats on each arm: it is neither reliable nor unreliable, it is incomplete
    const ledgers = names.flatMap(n => (n === 's6' ? [1] : [1, 2, 3]).flatMap(rep => [led(n, 'a', rep, 1), led(n, 'b', rep, 0.9)]))
    const c = buildReport(plan(3), ledgers, floor).candidates[0]!
    expect(c.summary.candidate.passAllK).toBe(1)
    expect(c.reliability.scenarios).toBe(5)
    expect(c.incomplete).toEqual(['s6'])
    // a pair whose baseline cost is 0 contributes to no cost estimand (Δ$ included), so Δ$ and Δ% describe the same pairs
    const zero = names.flatMap((n, i) => [led(n, 'a', 1, i === 0 ? 0 : 1), led(n, 'b', 1, 0.5)])
    const z = buildReport(plan(1), zero, floor).candidates[0]!
    expect(z.costCI.n).toBe(5)
    expect(z.costPctCI.n).toBe(5)
    expect(z.scenarios.find(s => s.scenario === 's1')!.costDiffUsd).toBeNull()
  })

  it('withholds cost for an unpriced model instead of reading 0 as equivalent', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const ledgers = names.flatMap(n => [led(n, 'a', 1, 0, true, { unpriced: true, model: 'other/unknown' }), led(n, 'b', 1, 0, true, { unpriced: true, model: 'other/unknown' })])
    const c = buildReport(plan(1), ledgers, floor).candidates[0]!
    expect(c.unpriced).toBe(12)
    expect(c.costReading).toBe('none')
    expect(c.verdict).toMatch(/^Cost not priced: 12 trials ran a model with no entry in the price table \(other\/unknown\)/)
    expect(c.grade).toBe('inconclusive')
  })

  it('declines a dev-pool direction only when the sealed pool reverses it, not when it is flat', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const dev = ['s1', 's2', 's3', 's4', 's5', 's6']
    const held = ['h1', 'h2', 'h3']
    const p = plan(3, { scenarios: [...dev, ...held] })
    // dev pool: the candidate turns 0/3 into 3/3 everywhere (+100 pp); sealed pool: the baseline passes 1/3, the candidate 1/3 (flat) or 0/3 (reversal, both-fail so no gate)
    const rows = (holdoutCandPasses: number) => [...dev.flatMap(n => [1, 2, 3].flatMap(rep => [led(n, 'a', rep, 1, false), led(n, 'b', rep, 0.9, true)])), ...held.flatMap(h => [1, 2, 3].flatMap(rep => [led(h, 'a', rep, 1, rep === 1), led(h, 'b', rep, 0.9, rep <= holdoutCandPasses)]))]
    const flat = buildReport(p, rows(1), { ...floor, holdout: new Set(held) }).candidates[0]!
    expect(flat.gate).toBe('pass')
    expect(flat.holdoutGap!.holdout).toBe(0)
    expect(flat.verdict).not.toMatch(/^Declined/)
    const reversed = buildReport(p, rows(0), { ...floor, holdout: new Set(held) }).candidates[0]!
    expect(reversed.gate).toBe('pass')
    expect(reversed.holdoutGap!.holdout).toBeLessThan(0)
    expect(reversed.verdict).toMatch(/^Declined/)
  })

  it('keeps degenerate sequences undecided: an empty betting set and a constant asymptotic sequence', async () => {
    const { bettingCS, asympCS } = await import('../src/core/stats.js')
    const constant = asympCS([1, 1, 1, 1], 0.05, 10)
    expect(constant.lo).toBe(-Infinity)
    expect(constant.hi).toBe(Infinity)
    // a near-constant sequence collapses the betting set below the coarse grid; the fine scan still finds it around the mean
    const tight = bettingCS(Array.from({ length: 60 }, (_, i) => 0.4567 + (i % 2 ? 1e-6 : -1e-6)))
    expect(tight.empty).not.toBe(true)
    expect(tight.lo).toBeLessThanOrEqual(0.4567)
    expect(tight.hi).toBeGreaterThanOrEqual(0.4567)
    expect(tight.hi - tight.lo).toBeLessThan(0.3)
  })
})

describe('security and validity review (C1–C4, H1, H8, H10, H13)', () => {
  it('the hedged betting sequence keeps its level under optional stopping (H1)', async () => {
    const { bettingRejectsAt, bettingCS } = await import('../src/core/stats.js')
    // seeded Bernoulli(1/2) sequences: the true mean is 1/2; count the runs where 1/2 is ever rejected within 40 looks
    let state = 20260909
    const rnd = (): number => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 }
    const sims = 1500
    let falseExclusions = 0
    for (let s = 0; s < sims; s += 1) {
      const xs = Array.from({ length: 40 }, () => (rnd() < 0.5 ? 0 : 1))
      if (bettingRejectsAt(xs, 0.5, 0.05) !== null) falseExclusions += 1
    }
    const rate = falseExclusions / sims
    expect(rate).toBeLessThan(0.06)             // the max(K+, K−) rule ran at 6.5–8%; the hedged average sits near 3–4%
    expect(rate).toBeGreaterThan(0.005)         // and it is not vacuous
    // and a real effect is still found: a 0.8-mean sequence excludes 1/2 well within 40 looks
    expect(bettingRejectsAt(Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 0 : 1)), 0.5, 0.05)).not.toBeNull()
    const cs = bettingCS(Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 0 : 1)), 0.05)
    expect(cs.lo).toBeGreaterThan(0.5)
  })

  it('scenario code gets an allowlisted environment without the host\'s secrets (H10)', async () => {
    const { scenarioProcessEnv } = await import('../src/core/scenario.js')
    const env = scenarioProcessEnv({ PATH: '/usr/bin', HOME: '/home/u', DEEPSEEK_API_KEY: 'sk-1', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 't', HTTPS_PROXY: 'http://127.0.0.1:7890', DOCKER_HOST: 'unix:///var/run/docker.sock', DSH_EVAL_CONTAINER: 'cid', PYTHONPATH: '/p', DSH_EVAL_API_KEY_HINT: 'nope', RANDOM_THING: '1', LC_ALL: 'C' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', HTTPS_PROXY: 'http://127.0.0.1:7890', DOCKER_HOST: 'unix:///var/run/docker.sock', DSH_EVAL_CONTAINER: 'cid', PYTHONPATH: '/p', LC_ALL: 'C' })
  })

  it('stashes ground truth in a private directory away from the workspace and restores it (C4)', async () => {
    const { stashTruth } = await import('../src/core/runner.js')
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, dirname } = await import('node:path')
    const workRoot = mkdtempSync(join(tmpdir(), 'dsh-eval-c4-'))
    const workdir = join(workRoot, 'trial-1')
    mkdirSync(join(workdir, '.truth'), { recursive: true })
    writeFileSync(join(workdir, '.truth', 'answer'), '42')
    const restore = stashTruth(workdir)!
    expect(existsSync(join(workdir, '.truth'))).toBe(false)
    // nothing truth-like beside the workspace (the old sibling stash), and nothing under the work root at all
    expect(readdirSync(workRoot)).toEqual(['trial-1'])
    expect(readdirSync(workdir)).toEqual([])
    restore()
    expect(readFileSync(join(workdir, '.truth', 'answer'), 'utf8')).toBe('42')
    // an explicit stash root is private (0700) as well
    const explicit = join(workRoot, 'stash')
    const restore2 = stashTruth(workdir, explicit)!
    expect((statSync(explicit).mode & 0o777)).toBe(0o700)
    expect(dirname(explicit)).toBe(workRoot)
    restore2()
  })

  it('keeps benchmark task ids inside their pool (C2)', async () => {
    const { taskDir } = await import('../src/core/bench/types.js')
    const { validTaskId } = await import('../src/server/index.js')
    expect(taskDir('/pool/tb', 'fix-git')).toBe('/pool/tb/fix-git')
    expect(taskDir('/pool/tb', 'django__django-13406')).toBe('/pool/tb/django__django-13406')
    for (const bad of ['../../tmp', '..', 'a/b', '/etc', '', '.hidden/../x', 'x'.repeat(200)]) {
      expect(() => taskDir('/pool/tb', bad), bad).toThrow(/invalid task id|outside the pool/)
      expect(validTaskId(bad), bad).toBe(false)
    }
    expect(validTaskId('psf__requests-2317')).toBe(true)
  })

  it('identifies receipt keys by fingerprint, compares them by content, and digests a report without its timestamp (C1)', async () => {
    const { keyFingerprint, sameKey, reportDigest, signReceipt, receiptSignatureValid } = await import('../src/core/manifest.js')
    const { generateKeyPairSync } = await import('node:crypto')
    const pem = (): { privateKey: string; publicKey: string } => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
    const a = pem()
    const b = pem()
    expect(keyFingerprint(a.publicKey)).toMatch(/^[0-9a-f]{16}$/)
    expect(keyFingerprint(a.publicKey)).not.toBe(keyFingerprint(b.publicKey))
    expect(sameKey(a.publicKey, a.publicKey.replace(/\n/g, '\r\n'))).toBe(true)
    expect(sameKey(a.publicKey, b.publicKey)).toBe(false)
    expect(reportDigest({ generatedAt: '1', x: 1, y: [2] })).toBe(reportDigest({ y: [2], x: 1, generatedAt: '2' }))
    expect(reportDigest({ x: 1 })).not.toBe(reportDigest({ x: 2 }))
    const receipt = signReceipt({ schema: 'dsh-eval-receipt/1', runId: 'r', issuedAt: '', evidenceSha: 'e', contract: {} as never, claims: [], coverage: { trials: 0, scenarios: 0, repeats: 0, arms: 0, reconciled: 0, metered: 0, unrun: 0, errors: 0 }, environment: {}, publicKey: a.publicKey }, a.privateKey)
    expect(receiptSignatureValid(receipt)).toBe(true)                 // self-consistent
    expect(receiptSignatureValid(receipt, a.publicKey)).toBe(true)    // and under the trusted key
    expect(receiptSignatureValid(receipt, b.publicKey)).toBe(false)   // but not under another
  })

  it('pins the sandbox image by digest and the Node runtime by checksum (H13)', async () => {
    const { DEFAULT_IMAGE } = await import('../src/core/docker.js')
    const { NODE_SHA256, NODE_VERSION } = await import('../src/core/environment.js')
    expect(DEFAULT_IMAGE).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/)
    expect(NODE_VERSION).toBe('v22.23.2')
    expect(NODE_SHA256.x64).toMatch(/^[0-9a-f]{64}$/)
    expect(NODE_SHA256.arm64).toMatch(/^[0-9a-f]{64}$/)
  })
})
