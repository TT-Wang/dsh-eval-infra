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
