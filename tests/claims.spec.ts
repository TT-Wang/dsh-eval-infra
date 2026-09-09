import { describe, expect, it } from 'vitest'
import { buildReport, type NoiseFloor } from '../src/core/report.js'
import { claimsOf } from '../src/core/claims.js'
import type { RunLedger, RunPlan } from '../src/core/types.js'

const led = (scenario: string, arm: string, rep: number, usd: number, ok = true, steps = 10, extra: Partial<RunLedger> = {}): RunLedger => ({
  schema: 'dsh-eval-ledger/1', runId: 'r', scenario, arm, rep, order: 0, startedAt: '', endedAt: '', wallMs: 1, provider: 'p', model: 'm', resolvedEffort: null, headerModel: null, tools: [], systemPromptSha: null, systemPromptChars: 0,
  turns: [], steps: [], totals: { hit: 0, miss: 0, output: 0, reasoning: 0, steps, turns: 1, usd, usdPeak: usd, usdOffpeak: usd, peakPrompt: 0 }, toolHistogram: {}, eventCounts: {}, verdict: { ok, detail: ok ? 'ok' : 'answer missing' }, behaviour: { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 }, sessionId: null, sessions: 1, workdir: '', eventsFile: '', traceFile: '',
  ...extra,
} as RunLedger)

const names = ['s1', 's2', 's3', 's4', 's5', 's6']
const plan = (repeats = 1, extra: Partial<RunPlan> = {}): RunPlan => ({ id: 'r', createdAt: '', baseline: { name: 'a' }, candidates: [{ name: 'b' }], scenarios: names, repeats, concurrency: 1, scenarioRoot: '', ...extra } as RunPlan)
const floor = (over: Partial<NoiseFloor> = {}) => ({ noiseFloors: { a: { runId: 'aa', scenarios: 6, meanAbsPct: 2, lo: -3, hi: 3, ...over } as NoiseFloor } })
const one = (r: ReturnType<typeof claimsOf>) => r.candidates[0]!
const codes = (xs: Array<{ code: string }>) => xs.map(x => x.code)

describe('what the evidence licenses, and what it does not', () => {
  it('licenses a direction only when the reading is one, and never alongside a withheld claim for it', async () => {
    // clearly cheaper, five comparable scenarios, a tight floor on file: the direction is readable
    const readable = claimsOf(buildReport(plan(), names.flatMap(n => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.6)]), floor()))
    expect(codes(one(readable).licensed)).toContain('northStar.better')
    expect(one(readable).withheld.map(w => w.claim)).not.toContain('northStar.direction')
    const claim = one(readable).licensed.find(c => c.code === 'northStar.better')!
    expect(claim['metric']).toBe('cost')
    expect(claim['mean']).toBeLessThan(-30)

    // the same data with no floor on file: the number is identical, the direction is not licensed
    const unfloored = claimsOf(buildReport(plan(), names.flatMap(n => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.6)])))
    expect(codes(one(unfloored).licensed)).not.toContain('northStar.better')
    expect(codes(one(unfloored).licensed).some(c => c.startsWith('northStar.'))).toBe(false)
    const w = one(unfloored).withheld.find(x => x.claim === 'northStar.direction')!
    expect(w.reason.code).toBe('floor.missing')
    // the measurement is still reported: withholding the claim is not hiding the number
    expect(w.observed!['mean']).toBeLessThan(-30)
    expect(w.next).toEqual({ tool: 'run.start', args: { baseline: 'a', aa: true, repeats: 3 } })
  })

  it('leads with the gate when the gate is closed, and never licenses a direction behind it', async () => {
    const rows = names.flatMap(n => [1, 2, 3].flatMap(rep => [led(n, 'a', rep, 1, true), led(n, 'b', rep, 0.6, n !== 's1')]))
    const c = one(claimsOf(buildReport(plan(3), rows, floor())))
    expect(c.gate).toBe('regressions')
    expect(codes(c.licensed)).toContain('gate.regression')
    expect(c.licensed.find(x => x.code === 'gate.regression')!['scenarios']).toEqual(['s1'])
    expect(codes(c.licensed).some(x => x.startsWith('northStar.'))).toBe(false)
    const wn = c.withheld.find(x => x.claim === 'northStar.direction')!
    expect(wn.reason.code).toBe('gate.regressions')           // the gate is the reason, before any statistics
    expect(wn.observed!['reading']).toBeDefined()             // what it computed to is still on the record
    expect(c.grade).toBe('regression')
  })

  it('says a suspected regression is suspected, not a regression, and asks for the rerun', async () => {
    // baseline 3/3, candidate 1/3 on s1: majority-fail without consistency
    const rows = names.flatMap(n => [1, 2, 3].flatMap(rep => [led(n, 'a', rep, 1, true), led(n, 'b', rep, 0.6, n !== 's1' || rep === 1)]))
    const c = one(claimsOf(buildReport(plan(3), rows, floor())))
    expect(c.gate).toBe('suspect')
    expect(codes(c.licensed)).toContain('gate.suspected')
    expect(codes(c.licensed)).not.toContain('gate.regression')
    const w = c.withheld.find(x => x.claim === 'northStar.direction')!
    expect(w.reason.code).toBe('gate.suspect')
    expect(w.next).toMatchObject({ tool: 'run.rerun' })
    // the reliability reading is behind the same gate, and its numbers are still reported
    expect(c.withheld.find(x => x.claim === 'reliability.direction')!.reason.code).toBe('gate.suspect')
  })

  it('names the rule that stopped a direction, in the order the rules applied', async () => {
    const cheap = names.flatMap(n => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.6)])
    // inside the A/A band: a real interval, not a real difference
    const noisy = one(claimsOf(buildReport(plan(), cheap, floor({ lo: -80, hi: 80 }))))
    expect(noisy.withheld[0]!.reason.code).toBe('reading.inside_noise_band')
    expect(noisy.withheld[0]!.reason['band']).toEqual([-80, 80])
    // usage that never reconciled outranks the floor: figures that cannot be trusted are withheld first
    const unreconciled = names.flatMap(n => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.6, true, 10, { usageProvenance: { source: 'meter', reconciled: false } } as Partial<RunLedger>)])
    const bad = one(claimsOf(buildReport(plan(), unreconciled, floor())))
    expect(bad.withheld[0]!.reason.code).toBe('provenance.unreconciled')
    // an unpriced model is said, not read as equivalence
    const unpriced = names.flatMap(n => [led(n, 'a', 1, 0, true, 10, { unpriced: true, model: 'other/x' } as Partial<RunLedger>), led(n, 'b', 1, 0, true, 10, { unpriced: true, model: 'other/x' } as Partial<RunLedger>)])
    const none = one(claimsOf(buildReport(plan(), unpriced, floor())))
    expect(none.withheld[0]!.reason.code).toBe('cost.unpriced')
    expect(none.withheld[0]!.next).toEqual({ tool: 'config.prices' })
  })

  it('carries the design facts a "should I run more" question needs', async () => {
    const r = claimsOf(buildReport(plan(), names.flatMap((n, i) => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.58 + i * 0.01)]), floor()))
    const d = one(r).design
    expect(d).toMatchObject({ comparableScenarios: 6, repeats: 1, floor: 'ok' })
    expect(d.mdePct).toBeGreaterThan(0)
    expect(d.alpha).toBeCloseTo(0.025, 6)
    expect(r.trials).toBe(12)
    expect(r.usd).toBeGreaterThan(9)
  })

  it('withholds the reliability direction with the numbers, when the scenarios cannot decide it', async () => {
    const r = claimsOf(buildReport(plan(), names.slice(0, 2).flatMap(n => [led(n, 'a', 1, 1), led(n, 'b', 1, 0.6)]), floor()))
    const w = one(r).withheld.find(x => x.claim === 'reliability.direction')!
    expect(w.reason.code).toBe('scenarios.below_minimum')
    expect(w.observed).toMatchObject({ k: 1, scenarios: 2 })
    expect(w.next).toMatchObject({ tool: 'run.start' })
  })
})
