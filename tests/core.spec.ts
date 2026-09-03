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
  it('needs at least three comparable scenarios before calling a direction', async () => {
    const { buildReport } = await import('../src/core/report.js')
    const mk = (scenario: string, arm: string, usd: number) => ({
      schema: 'dsh-eval-ledger/1' as const, runId: 'r', scenario, arm, rep: 1, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
      turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps: 1, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok: true, detail: '' }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
    })
    const plan = { id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: ['s1', 's2'], repeats: 1, concurrency: 1, scenarioRoot: '' }
    const two = buildReport(plan, [mk('s1', 'a', 1), mk('s1', 'b', 1.2), mk('s2', 'a', 1), mk('s2', 'b', 1.15)])
    expect(two.candidates[0]!.costReading).toBe('inconclusive')
    expect(two.candidates[0]!.verdict).toMatch(/Only 2 comparable scenarios/)
    const plan3 = { ...plan, scenarios: ['s1', 's2', 's3'] }
    const three = buildReport(plan3, [mk('s1', 'a', 1), mk('s1', 'b', 1.2), mk('s2', 'a', 1), mk('s2', 'b', 1.15), mk('s3', 'a', 1), mk('s3', 'b', 1.25)])
    expect(three.candidates[0]!.costReading).toBe('more-expensive')
    const flat = buildReport(plan3, [mk('s1', 'a', 1), mk('s1', 'b', 1.01), mk('s2', 'a', 1), mk('s2', 'b', 0.99), mk('s3', 'a', 1), mk('s3', 'b', 1.02)])
    expect(flat.candidates[0]!.costReading).toBe('equivalent')
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
