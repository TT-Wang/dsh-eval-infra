/**
 * Paired report over the ledgers of one run. Rules, in order:
 *   1. Correctness first: a scenario the baseline passes and the candidate
 *      fails is a regression, and a candidate with regressions fails the gate
 *      regardless of cost.
 *   2. Cost is compared only on repeat-pairs where BOTH arms passed, so a run
 *      that stopped early by failing never looks cheap.
 *   3. Aggregates carry a bootstrap interval over scenarios; an interval that
 *      covers zero reads "no difference".
 */
import { icc, mcnemar, mean, median, resolution, sequenceSimilarity, signTest, smallSampleCI, wilson, tCritical, stddev, type BootstrapCI } from './stats.js'
import type { RunLedger, RunPlan } from './types.js'

export interface ArmScenarioStats {
  arm: string
  scenario: string
  n: number
  passes: number
  errors: number
  passRate: number
  passCI: { lo: number; hi: number }
  usd: number[]
  usdMean: number
  usdMedian: number
  usdPeakMean: number
  usdOffpeakMean: number
  stepsMean: number
  hitMean: number
  missMean: number
  outputMean: number
  reasoningMean: number
  wallMsMean: number
  peakPromptMax: number
  /** Ledger order per repeat (rep → verdict/cost) for the pairing. */
  byRep: Record<number, { ok: boolean; usd: number; error: boolean; steps: number; usdPeak: number; usdOffpeak: number; overridden?: boolean }>
}

export type PairClass = 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete' | 'unrun'

export interface PairedScenario {
  scenario: string
  baseline: ArmScenarioStats
  candidate: ArmScenarioStats
  class: PairClass
  /** Repeats disagree within at least one arm — the scenario is noisy for this setup. */
  flaky: boolean
  /** Distinct failure reasons per arm (verdict detail, truncated), most frequent first. */
  failures: { baseline: Array<{ reason: string; n: number }>; candidate: Array<{ reason: string; n: number }> }
  /** Tool-sequence similarity (normalized Levenshtein over tool names): within each arm across repeats, and between the arms' paired repeats. 1 = identical. */
  tss: { baseline: number | null; candidate: number | null; between: number | null }
  /** Repeat pairs where both arms passed (cost comparison base). */
  costPairs: number
  /** Per-pair (candidate − baseline) Δ% values behind costDiffPct, for the hierarchical bootstrap. */
  costDiffPctPairs: number[]
  /** Scenario is in the sealed holdout pool (meta.holdout). */
  holdout: boolean
  /** Mean of per-pair (candidate − baseline) USD over costPairs; null when no pair. */
  costDiffUsd: number | null
  costDiffPct: number | null
  /** Mean behaviour signature per arm (tool errors, repeated calls, no-action steps, observation chars, compactions). */
  behaviour: { baseline: BehaviourMean; candidate: BehaviourMean }
  /** Same difference re-priced at a fixed band, immune to peak/off-peak drift. */
  costDiffPeakUsd: number | null
  costDiffOffpeakUsd: number | null
  stepsDiff: number | null
  /** Within-arm spread of the baseline cost on passed runs (max−min)/mean, a noise indicator. */
  baselineSpreadPct: number | null
}

export interface BehaviourMean { toolErrors: number; repeatedCalls: number; noActionSteps: number; observationChars: number; compactions: number }

export type Grade = 'improvement' | 'regression' | 'tradeoff' | 'tie' | 'inconclusive'

export interface ArmSummary {
  arm: string
  runs: number
  passes: number
  /** Fraction of scenarios where every repeat passed (pass^k). */
  passAllK: number
  /** Fraction of scenarios where at least one repeat passed (pass@k). */
  passAnyK: number
  usd: number
  /** Σ tokens (hit+miss+output) over all runs ÷ solved runs; null when nothing solved. */
  tokensPerSolved: number | null
  usdPerSolved: number | null
  cacheHitShare: number
}

export interface CandidateReport {
  arm: string
  summary: { baseline: ArmSummary; candidate: ArmSummary }
  scenarios: PairedScenario[]
  regressions: string[]
  improvements: string[]
  bothFail: string[]
  incomplete: string[]
  /** Pass counts over all runs. */
  passBaseline: number
  passCandidate: number
  runsBaseline: number
  runsCandidate: number
  /** Discordant repeat pairs. */
  wins: number
  losses: number
  signTestP: number
  /** Per-scenario cost differences (comparable scenarios only). */
  costCI: BootstrapCI
  costPctCI: BootstrapCI
  costPeakCI: BootstrapCI
  costOffpeakCI: BootstrapCI
  /** Sum of cost over comparable pairs, both arms. */
  comparableUsdBaseline: number
  comparableUsdCandidate: number
  gate: 'pass' | 'regressions' | 'incomplete'
  /** Cost reading: cheaper / more-expensive (CI excludes 0), equivalent (CI inside ±sesoi), or inconclusive. */
  costReading: 'cheaper' | 'more-expensive' | 'equivalent' | 'inconclusive' | 'none'
  /** Per-scenario pass-rate difference (candidate − baseline, in percentage points) bootstrapped over scenarios. */
  passDiffCI: BootstrapCI
  /** One-word grade combining correctness and cost: improvement / regression / tradeoff / tie / inconclusive. */
  grade: Grade
  /** Scenarios whose repeats disagree within an arm. */
  flaky: string[]
  /** Minimum detectable cost effect (percent of baseline) for this design at 95% confidence and 80% power, from the observed per-scenario spread; null with fewer than 3 comparable scenarios. */
  mdePct: number | null
  /** Noise floor from the most recent A/A run on the same baseline, when one exists in the archive. */
  noiseFloor: NoiseFloor | null
  /** Significance level used for the intervals after Bonferroni adjustment across candidates (0.05 / candidates). */
  alpha: number
  /** Intraclass correlation of repeat cost differences within scenarios and the design effect 1 + (k−1)ρ. */
  icc: { rho: number; designEffect: number; k: number }
  /** Paired pass/fail: discordant counts, McNemar exact and mid-p, posterior P(candidate wins a discordant pair), posterior mass inside ±0.1 of 1/2. */
  paired: { b: number; c: number; exactP: number; midP: number; pWin: number; inRope: number }
  /** Resolution of the cost comparison: N* scenarios needed for 80% power at the observed effect, and q = n / N*. */
  resolution: { nStar: number | null; q: number | null }
  /** Dev vs sealed-holdout pass-rate difference (candidate − baseline), when holdout scenarios exist. */
  holdoutGap: { dev: number; holdout: number; devScenarios: number; holdoutScenarios: number } | null
  /** Blinded pairwise judge summary when `dsh-eval judge` has been run. */
  judge?: { model: string; wins: number; losses: number; ties: number; midP: number; pWin: number; inconsistentShare: number; usd: number; humanAgreement: { n: number; agree: number; kappa: number | null } | null }
  verdict: string
}

export interface NoiseFloor {
  runId: string
  scenarios: number
  /** Mean of |Δ%| across scenarios in the A/A run. */
  meanAbsPct: number
  /** 95% bootstrap interval of Δ% in the A/A run. */
  lo: number
  hi: number
}

export interface ReportOptions {
  /** Smallest cost effect of interest in percent; a CI inside ±sesoi reads "equivalent" (default 10). */
  sesoiPct?: number
  /** Comparable scenarios needed before any directional or equivalence claim (default 5); fewer reads "inconclusive". */
  minScenarios?: number
  /** Noise floors from A/A runs, keyed by baseline arm name (the caller looks them up in the archive). */
  noiseFloors?: Record<string, NoiseFloor>
  /** Scenario names in the sealed holdout pool. */
  holdout?: Set<string>
  /** Final anytime-valid sequences of a sequential run, keyed by candidate; when present they replace the fixed-sample cost interval. */
  sequences?: Record<string, { cost: { mean: number; lo: number; hi: number } | null; pass: { lo: number; hi: number } | null; scenarios: number }>
}

function behaviourMean(rows: RunLedger[]): BehaviourMean {
  const n = Math.max(1, rows.length)
  const sum = rows.reduce((a, r) => ({ toolErrors: a.toolErrors + (r.behaviour?.toolErrors ?? 0), repeatedCalls: a.repeatedCalls + (r.behaviour?.repeatedCalls ?? 0), noActionSteps: a.noActionSteps + (r.behaviour?.noActionSteps ?? 0), observationChars: a.observationChars + (r.behaviour?.observationChars ?? 0), compactions: a.compactions + (r.behaviour?.compactions ?? 0) }), { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 })
  return { toolErrors: sum.toolErrors / n, repeatedCalls: sum.repeatedCalls / n, noActionSteps: sum.noActionSteps / n, observationChars: sum.observationChars / n, compactions: sum.compactions / n }
}

function failureReasons(rows: RunLedger[]): Array<{ reason: string; n: number }> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.verdict?.ok === true && r.error === undefined) continue
    const reason = (r.error !== undefined ? `runtime: ${r.error}` : r.verdict?.detail ?? 'no verdict').replace(/\s+/g, ' ').slice(0, 140)
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n }))
}

/** Noise floor of an A/A run: the same statistics the candidate report uses, applied to two copies of one arm. */
export function noiseFloorOf(plan: RunPlan, ledgers: RunLedger[]): NoiseFloor | null {
  const twin = plan.candidates.find(c => c.name === `${plan.baseline.name}-aa`)
  if (twin === undefined) return null
  const pairs = plan.scenarios.map(s => pairScenario(s, armScenarioStats(plan.baseline.name, s, ledgers), armScenarioStats(twin.name, s, ledgers), plan.repeats)).filter(p => p.costDiffPct !== null)
  if (pairs.length === 0) return null
  const ci = smallSampleCI(pairs.map(p => p.costDiffPct!))
  return { runId: plan.id, scenarios: pairs.length, meanAbsPct: mean(pairs.map(p => Math.abs(p.costDiffPct!))), lo: ci.lo, hi: ci.hi }
}

function armSummary(arm: string, pairs: PairedScenario[], side: 'baseline' | 'candidate', ledgers: RunLedger[]): ArmSummary {
  const stats = pairs.map(p => p[side])
  const rows = ledgers.filter(l => l.arm === arm)
  const solved = rows.filter(r => r.verdict?.ok === true && r.error === undefined)
  const tokens = rows.reduce((a, r) => a + r.totals.hit + r.totals.miss + r.totals.output, 0)
  const usd = rows.reduce((a, r) => a + r.totals.usd, 0)
  const hit = rows.reduce((a, r) => a + r.totals.hit, 0)
  const miss = rows.reduce((a, r) => a + r.totals.miss, 0)
  const withRuns = stats.filter(s => s.n > 0)
  return {
    arm,
    runs: rows.length,
    passes: solved.length,
    passAllK: withRuns.length ? withRuns.filter(s => s.passes === s.n).length / withRuns.length : 0,
    passAnyK: withRuns.length ? withRuns.filter(s => s.passes > 0).length / withRuns.length : 0,
    usd,
    tokensPerSolved: solved.length ? tokens / solved.length : null,
    usdPerSolved: solved.length ? usd / solved.length : null,
    cacheHitShare: hit + miss > 0 ? hit / (hit + miss) : 0,
  }
}

export interface Report {
  schema: 'dsh-eval-report/1'
  runId: string
  generatedAt: string
  baseline: string
  candidates: CandidateReport[]
  scenarios: string[]
  repeats: number
  runs: number
  errors: number
  usd: number
  /** Facts the reader must know before trusting a number. */
  notes: string[]
}

function armScenarioStats(arm: string, scenario: string, ledgers: RunLedger[]): ArmScenarioStats {
  const rows = ledgers.filter(l => l.arm === arm && l.scenario === scenario).sort((a, b) => a.rep - b.rep)
  const passed = rows.filter(r => r.verdict?.ok === true && r.error === undefined)
  const usd = rows.map(r => r.totals.usd)
  const byRep: ArmScenarioStats['byRep'] = {}
  for (const r of rows) byRep[r.rep] = { ok: r.verdict?.ok === true && r.error === undefined, usd: r.totals.usd, error: r.error !== undefined, steps: r.totals.steps, usdPeak: r.totals.usdPeak, usdOffpeak: r.totals.usdOffpeak, ...(r.overridden ? { overridden: true } : {}) }
  return {
    arm,
    scenario,
    n: rows.length,
    passes: passed.length,
    errors: rows.filter(r => r.error !== undefined).length,
    passRate: rows.length === 0 ? 0 : passed.length / rows.length,
    passCI: wilson(passed.length, rows.length),
    usd,
    usdMean: mean(usd),
    usdMedian: median(usd),
    usdPeakMean: mean(rows.map(r => r.totals.usdPeak)),
    usdOffpeakMean: mean(rows.map(r => r.totals.usdOffpeak)),
    stepsMean: mean(rows.map(r => r.totals.steps)),
    hitMean: mean(rows.map(r => r.totals.hit)),
    missMean: mean(rows.map(r => r.totals.miss)),
    outputMean: mean(rows.map(r => r.totals.output)),
    reasoningMean: mean(rows.map(r => r.totals.reasoning)),
    wallMsMean: mean(rows.map(r => r.wallMs)),
    peakPromptMax: rows.reduce((m, r) => Math.max(m, r.totals.peakPrompt), 0),
    byRep,
  }
}

function classify(b: ArmScenarioStats, c: ArmScenarioStats, repeats: number): PairClass {
  if (b.n === 0 && c.n === 0) return 'unrun'
  if (b.n < repeats || c.n < repeats) return 'incomplete'
  const bPass = b.passRate >= 0.5
  const cPass = c.passRate >= 0.5
  if (bPass && !cPass) return 'regression'
  if (!bPass && cPass) return 'improvement'
  if (!bPass && !cPass) return 'both-fail'
  // Both pass by majority: a strict per-pair loss still counts as a regression when it is the majority of pairs.
  return 'same'
}

function pairScenario(scenario: string, b: ArmScenarioStats, c: ArmScenarioStats, repeats: number, ledgers: RunLedger[] = [], holdout = false): PairedScenario {
  const cls = classify(b, c, repeats)
  const rowsB = ledgers.filter(l => l.arm === b.arm && l.scenario === scenario)
  const rowsC = ledgers.filter(l => l.arm === c.arm && l.scenario === scenario)
  const flakyB = b.n >= 2 && b.passes > 0 && b.passes < b.n
  const flakyC = c.n >= 2 && c.passes > 0 && c.passes < c.n
  const seqOf = (l: RunLedger): string[] => l.steps.flatMap(st => st.calls.map(cl => cl.name))
  const within = (rows: RunLedger[]): number | null => {
    const seqs = rows.map(seqOf)
    if (seqs.length < 2) return null
    let total = 0
    let pairsN = 0
    for (let i = 0; i < seqs.length; i += 1) for (let j = i + 1; j < seqs.length; j += 1) { total += sequenceSimilarity(seqs[i]!, seqs[j]!); pairsN += 1 }
    return pairsN ? total / pairsN : null
  }
  const betweenVals: number[] = []
  for (const rb of rowsB) { const rc = rowsC.find(x => x.rep === rb.rep); if (rc) betweenVals.push(sequenceSimilarity(seqOf(rb), seqOf(rc))) }
  const diffs: number[] = []
  const pct: number[] = []
  const peak: number[] = []
  const off: number[] = []
  const steps: number[] = []
  for (const rep of Object.keys(b.byRep).map(Number)) {
    const x = b.byRep[rep]
    const y = c.byRep[rep]
    if (x === undefined || y === undefined || !x.ok || !y.ok) continue
    diffs.push(y.usd - x.usd)
    if (x.usd > 0) pct.push((y.usd - x.usd) / x.usd * 100)
    peak.push(y.usdPeak - x.usdPeak)
    off.push(y.usdOffpeak - x.usdOffpeak)
    steps.push(y.steps - x.steps)
  }
  const passedBaseline = Object.values(b.byRep).filter(r => r.ok).map(r => r.usd)
  const spread = passedBaseline.length >= 2 && mean(passedBaseline) > 0 ? (Math.max(...passedBaseline) - Math.min(...passedBaseline)) / mean(passedBaseline) * 100 : null
  return {
    scenario,
    baseline: b,
    candidate: c,
    class: cls,
    flaky: flakyB || flakyC,
    failures: { baseline: failureReasons(rowsB), candidate: failureReasons(rowsC) },
    tss: { baseline: within(rowsB), candidate: within(rowsC), between: betweenVals.length ? mean(betweenVals) : null },
    behaviour: { baseline: behaviourMean(rowsB), candidate: behaviourMean(rowsC) },
    costPairs: diffs.length,
    costDiffPctPairs: pct,
    holdout,
    costDiffUsd: diffs.length ? mean(diffs) : null,
    costDiffPct: pct.length ? mean(pct) : null,
    costDiffPeakUsd: peak.length ? mean(peak) : null,
    costDiffOffpeakUsd: off.length ? mean(off) : null,
    stepsDiff: steps.length ? mean(steps) : null,
    baselineSpreadPct: spread,
  }
}

export function buildReport(plan: RunPlan, ledgers: RunLedger[], options: ReportOptions = {}): Report {
  const sesoi = options.sesoiPct ?? 10
  const minScenarios = options.minScenarios ?? 5
  const scenarios = [...new Set([...plan.scenarios, ...ledgers.map(l => l.scenario)])]
  const notes: string[] = []
  // Bonferroni across candidates: each candidate's intervals are read at alpha / m so the family-wise error stays at 5%.
  const alpha = 0.05 / Math.max(1, plan.candidates.length)
  const holdoutSet = options.holdout ?? new Set<string>()
  const candidates: CandidateReport[] = plan.candidates.map((cand) => {
    const pairs = scenarios.map(s => pairScenario(s, armScenarioStats(plan.baseline.name, s, ledgers), armScenarioStats(cand.name, s, ledgers), plan.repeats, ledgers, holdoutSet.has(s)))
    const comparable = pairs.filter(p => p.costDiffUsd !== null)
    const noiseFloor = options.noiseFloors?.[plan.baseline.name] ?? null
    let wins = 0
    let losses = 0
    for (const p of pairs) {
      for (const rep of Object.keys(p.baseline.byRep).map(Number)) {
        const x = p.baseline.byRep[rep]
        const y = p.candidate.byRep[rep]
        if (x === undefined || y === undefined) continue
        if (y.ok && !x.ok) wins += 1
        if (x.ok && !y.ok) losses += 1
      }
    }
    const regressions = pairs.filter(p => p.class === 'regression').map(p => p.scenario)
    const improvements = pairs.filter(p => p.class === 'improvement').map(p => p.scenario)
    const bothFail = pairs.filter(p => p.class === 'both-fail').map(p => p.scenario)
    const incomplete = pairs.filter(p => p.class === 'incomplete').map(p => p.scenario)
    const costCI = smallSampleCI(comparable.map(p => p.costDiffUsd!), 2000, 42, alpha)
    // Cluster interval: scenarios are the unit and carry all their repeat pairs (per-scenario means); t-interval below 10 scenarios, percentile bootstrap from 10 (Indeed 2026 measured nominal coverage for the cluster design).
    let costPctCI = smallSampleCI(comparable.map(p => p.costDiffPct!), 2000, 42, alpha)
    const seq = options.sequences?.[cand.name]
    if (seq?.cost) {
      // Under optional stopping only the time-uniform sequence keeps its coverage; the bootstrap interval would be too narrow.
      costPctCI = { mean: seq.cost.mean, lo: seq.cost.lo, hi: seq.cost.hi, n: seq.scenarios, significant: seq.cost.lo > 0 || seq.cost.hi < 0 }
    }
    const iccStat = icc(comparable.map(p => p.costDiffPctPairs))
    const pairedStat = mcnemar(wins, losses)
    const resolutionStat = resolution(comparable.map(p => p.costDiffPct!))
    const costPeakCI = smallSampleCI(comparable.map(p => p.costDiffPeakUsd ?? 0), 2000, 42, alpha)
    const costOffpeakCI = smallSampleCI(comparable.map(p => p.costDiffOffpeakUsd ?? 0), 2000, 42, alpha)
    const ran = pairs.filter(p => p.class !== 'unrun')
    const gate: CandidateReport['gate'] = regressions.length > 0 ? 'regressions' : ran.length === 0 || incomplete.length === ran.length ? 'incomplete' : 'pass'
    const complete = pairs.filter(p => p.class !== 'incomplete' && p.class !== 'unrun')
    const passDiffCI = smallSampleCI(complete.map(p => (p.candidate.passRate - p.baseline.passRate) * 100), 2000, 42, alpha)
    const dev = complete.filter(p => !p.holdout)
    const held = complete.filter(p => p.holdout)
    const holdoutGap = held.length > 0 ? { dev: mean(dev.map(p => (p.candidate.passRate - p.baseline.passRate) * 100)), holdout: mean(held.map(p => (p.candidate.passRate - p.baseline.passRate) * 100)), devScenarios: dev.length, holdoutScenarios: held.length } : null
    const flaky = pairs.filter(p => p.flaky).map(p => p.scenario)
    const pctDiffs = comparable.map(p => p.costDiffPct!)
    const mdePct = pctDiffs.length >= 3 ? (tCritical(pctDiffs.length - 1) + 0.84) * stddev(pctDiffs) / Math.sqrt(pctDiffs.length) : null
    const passBaseline = pairs.reduce((a, p) => a + p.baseline.passes, 0)
    const passCandidate = pairs.reduce((a, p) => a + p.candidate.passes, 0)
    const runsBaseline = pairs.reduce((a, p) => a + p.baseline.n, 0)
    const runsCandidate = pairs.reduce((a, p) => a + p.candidate.n, 0)
    let verdict: string
    let costReading: CandidateReport['costReading'] = 'none'
    const ciText = `${fmtPct(costPctCI.mean)}, 95% CI ${fmtPct(costPctCI.lo)} to ${fmtPct(costPctCI.hi)}, ${comparable.length} scenario${comparable.length === 1 ? '' : 's'}`
    const gains = improvements.length ? ` Improves correctness on ${improvements.join(', ')}.` : ''
    let insideNoise = false
    if (comparable.length > 0) {
      if (comparable.length < minScenarios) costReading = 'inconclusive'
      else if (costPctCI.significant) {
        costReading = costPctCI.mean < 0 ? 'cheaper' : 'more-expensive'
        // An A/A run with enough scenarios defines the band a pure-noise difference occupies; a directional call whose interval reaches into that band is not a call.
        if (noiseFloor !== null && noiseFloor.scenarios >= minScenarios && Math.min(Math.abs(costPctCI.lo), Math.abs(costPctCI.hi)) < noiseFloor.meanAbsPct) { costReading = 'inconclusive'; insideNoise = true }
      }
      else if (costPctCI.lo > -sesoi && costPctCI.hi < sesoi) costReading = 'equivalent'
      else costReading = 'inconclusive'
    }
    let grade: Grade
    if (gate === 'regressions') grade = 'regression'
    else if (gate === 'incomplete') grade = 'inconclusive'
    else if (improvements.length > 0 && (costReading === 'cheaper' || costReading === 'equivalent' || costReading === 'none')) grade = 'improvement'
    else if (improvements.length > 0 && costReading === 'more-expensive') grade = 'tradeoff'
    else if (costReading === 'cheaper') grade = 'improvement'
    else if (costReading === 'more-expensive') grade = 'regression'
    else if (costReading === 'equivalent') grade = 'tie'
    else grade = 'inconclusive'
    if (gate === 'regressions') verdict = `REGRESSION on ${regressions.length} scenario${regressions.length === 1 ? '' : 's'} (${regressions.join(', ')}); cost is not compared until this is fixed.`
    else if (gate === 'incomplete') verdict = 'Incomplete: not every scenario has all repeats yet.'
    else if (costReading === 'none') verdict = 'No scenario where both arms passed; nothing to compare on cost.'
    else if (costReading === 'equivalent') verdict = `Cost equivalent within ±${sesoi}% (${ciText}), no regressions.${gains}`
    else if (costReading === 'inconclusive' && comparable.length < 2) verdict = `Single comparable scenario: ${fmtPct(costPctCI.mean)} on cost, no interval possible; add scenarios or repeats before reading this as an effect.${gains}`
    else if (costReading === 'inconclusive' && comparable.length < minScenarios) verdict = `Only ${comparable.length} comparable scenarios (${ciText}); fewer than ${minScenarios} scenarios cannot support a direction — add scenarios before reading this as an effect.${gains}`
    else if (costReading === 'inconclusive' && insideNoise) verdict = `Cost interval (${ciText}) reaches into the A/A noise band of ±${noiseFloor!.meanAbsPct.toFixed(1)}% measured on this baseline; not read as a real difference.${gains}`
    else if (costReading === 'inconclusive') verdict = `Cost difference inconclusive: the interval covers zero and is wider than ±${sesoi}% (${ciText}); more repeats or scenarios needed.${gains}`
    else verdict = `${costReading === 'cheaper' ? 'Cheaper' : 'More expensive'} by ${fmtPct(Math.abs(costPctCI.mean))} (${ciText}), no regressions.${gains}`
    return {
      arm: cand.name,
      summary: { baseline: armSummary(plan.baseline.name, pairs, 'baseline', ledgers), candidate: armSummary(cand.name, pairs, 'candidate', ledgers) },
      scenarios: pairs,
      regressions,
      improvements,
      bothFail,
      incomplete,
      passBaseline,
      passCandidate,
      runsBaseline,
      runsCandidate,
      wins,
      losses,
      signTestP: signTest(wins, losses),
      costCI,
      costPctCI,
      costPeakCI,
      costOffpeakCI,
      comparableUsdBaseline: comparable.reduce((a, p) => a + Object.values(p.baseline.byRep).filter(r => r.ok).reduce((x, r) => x + r.usd, 0), 0),
      comparableUsdCandidate: comparable.reduce((a, p) => a + Object.values(p.candidate.byRep).filter(r => r.ok).reduce((x, r) => x + r.usd, 0), 0),
      gate,
      costReading,
      passDiffCI,
      grade,
      flaky,
      mdePct,
      noiseFloor,
      alpha,
      icc: iccStat,
      paired: pairedStat,
      resolution: resolutionStat,
      holdoutGap,
      verdict,
    }
  })
  if (plan.candidates.length > 1) notes.push(`${plan.candidates.length} candidates share one baseline: intervals are read at α = ${alpha.toFixed(4)} (Bonferroni) so the family-wise error rate stays at 5%.`)
  if (options.sequences) notes.push('Sequential mode: the cost interval is the final anytime-valid confidence sequence (valid under early stopping), which is wider than a fixed-sample bootstrap would be on the same data.')
  for (const c of candidates) {
    if (c.holdoutGap !== null && c.holdoutGap.devScenarios > 0) {
      const gap = c.holdoutGap.dev - c.holdoutGap.holdout
      notes.push(`${c.arm}: Δpass on the ${c.holdoutGap.devScenarios} dev scenarios ${fmtPct(c.holdoutGap.dev)} pp vs ${fmtPct(c.holdoutGap.holdout)} pp on the ${c.holdoutGap.holdoutScenarios} sealed scenarios${Math.abs(gap) >= 10 ? ' — a gap this large suggests the change was tuned to the dev pool' : ''}.`)
    }
  }
  for (const c of candidates) {
    if (c.flaky.length > 0) notes.push(`${c.arm}: repeats disagree within an arm on ${c.flaky.join(', ')} — noisy scenarios for this setup; a regression there needs more repeats before it counts.`)
    if (c.mdePct !== null) notes.push(`${c.arm}: with ${c.scenarios.filter(p => p.costDiffUsd !== null).length} comparable scenarios this design can detect a cost effect of about ±${c.mdePct.toFixed(0)}% (95% confidence, 80% power); smaller effects will read inconclusive.`)
    if (c.noiseFloor !== null) notes.push(`${c.arm}: the A/A run ${c.noiseFloor.runId} on this baseline showed |Δ%| averaging ${c.noiseFloor.meanAbsPct.toFixed(1)}% (interval ${fmtPct(c.noiseFloor.lo)} to ${fmtPct(c.noiseFloor.hi)}) with no real change; treat differences inside that band as noise.`)
  }
  const errors = ledgers.filter(l => l.error !== undefined).length
  if (errors > 0) notes.push(`${errors} run(s) ended with a runtime error (timeout or crash); they count as failures.`)
  const overridden = ledgers.filter(l => l.overridden).length
  if (overridden > 0) notes.push(`${overridden} verdict(s) were overridden by a human annotation; the machine verdicts are kept in the ledgers.`)
  if (plan.repeats < 3) notes.push(`repeats=${plan.repeats}: below the 3-repeat floor the literature recommends; single-run noise is around ±30% on cost, so treat every difference as indicative only.`)
  if (plan.candidates.some(c => c.name === `${plan.baseline.name}-aa`)) notes.push('A/A run: the candidate is a copy of the baseline; any difference reported here is the noise floor of this setup.')
  const bands = new Set(ledgers.flatMap(l => l.steps.map(s => s.band)))
  if (bands.size > 1) notes.push('Runs straddled the DeepSeek peak/off-peak boundary; compare the fixed-band columns (usdPeak / usdOffpeak) rather than billed cost.')
  const models = new Set(ledgers.map(l => l.headerModel ?? l.model))
  if (models.size > 1) notes.push(`More than one model appears in the ledgers (${[...models].join(', ')}): this is a model comparison, not a plugin comparison.`)
  const efforts = new Set(ledgers.map(l => l.resolvedEffort ?? 'default'))
  if (efforts.size > 1) notes.push(`Resolved reasoning effort differs across runs (${[...efforts].join(', ')}).`)
  return {
    schema: 'dsh-eval-report/1',
    runId: plan.id,
    generatedAt: new Date().toISOString(),
    baseline: plan.baseline.name,
    candidates,
    scenarios,
    repeats: plan.repeats,
    runs: ledgers.length,
    errors,
    usd: ledgers.reduce((a, l) => a + l.totals.usd, 0),
    notes,
  }
}

export function fmtUsd(v: number | null): string {
  if (v === null) return '—'
  return (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(4)
}

export function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1) + '%'
}

function classLabel(c: PairClass): string {
  return { regression: 'REGRESSION', improvement: 'improvement', same: 'same', 'both-fail': 'both fail', incomplete: 'incomplete', unrun: 'not run' }[c]
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = []
  lines.push(`# dsh-eval report ${report.runId}`)
  lines.push('')
  lines.push(`Baseline **${report.baseline}** · ${report.scenarios.length} scenarios × ${report.repeats} repeats · ${report.runs} runs · $${report.usd.toFixed(4)} total${report.errors ? ` · ${report.errors} runtime errors` : ''}`)
  lines.push('')
  for (const c of report.candidates) {
    lines.push(`## ${c.arm} vs ${report.baseline}`)
    lines.push('')
    lines.push(`**${c.verdict}**`)
    lines.push('')
    lines.push(`Grade: **${c.grade}** · Δ pass ${fmtPct(c.passDiffCI.mean)} pp (${((1 - c.alpha) * 100).toFixed(c.alpha < 0.05 ? 1 : 0)}% CI ${fmtPct(c.passDiffCI.lo)} to ${fmtPct(c.passDiffCI.hi)})${c.flaky.length ? ` · flaky: ${c.flaky.join(', ')}` : ''}${c.mdePct !== null ? ` · MDE ≈ ±${c.mdePct.toFixed(0)}%` : ''}`)
    lines.push('')
    lines.push(`Pass: baseline ${c.passBaseline}/${c.runsBaseline}, candidate ${c.passCandidate}/${c.runsCandidate} · pass^k ${(c.summary.baseline.passAllK * 100).toFixed(0)}% → ${(c.summary.candidate.passAllK * 100).toFixed(0)}% · discordant pairs: ${c.wins} won / ${c.losses} lost (McNemar mid-p ${c.paired.midP.toFixed(2)}, P(candidate wins a discordant pair) ${(c.paired.pWin * 100).toFixed(0)}%, ${(c.paired.inRope * 100).toFixed(0)}% of the posterior within ±0.1 of even)`)
    lines.push('')
    lines.push(`Design: ${c.scenarios.filter(p => p.costDiffUsd !== null).length} comparable scenarios × k≈${c.icc.k.toFixed(1)} repeat pairs · ICC of repeat cost differences ρ̂=${c.icc.rho.toFixed(2)} (design effect ${c.icc.designEffect.toFixed(2)})${c.resolution.q !== null ? ` · resolution q = n/N* = ${c.resolution.q.toFixed(2)} (N* ≈ ${c.resolution.nStar} scenarios to resolve an effect of the observed size at 80% power)` : ''}`)
    lines.push('')
    lines.push(`Per solved task: baseline ${c.summary.baseline.tokensPerSolved === null ? '—' : Math.round(c.summary.baseline.tokensPerSolved / 1000) + 'K tokens'} / ${fmtUsd(c.summary.baseline.usdPerSolved)}, candidate ${c.summary.candidate.tokensPerSolved === null ? '—' : Math.round(c.summary.candidate.tokensPerSolved / 1000) + 'K tokens'} / ${fmtUsd(c.summary.candidate.usdPerSolved)} · cache-hit share ${(c.summary.baseline.cacheHitShare * 100).toFixed(0)}% → ${(c.summary.candidate.cacheHitShare * 100).toFixed(0)}%`)
    lines.push('')
    lines.push('| scenario | baseline pass | candidate pass | class | cost pairs | Δ cost | Δ % | Δ steps | baseline spread | notes |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|')
    const order: Record<PairClass, number> = { regression: 0, improvement: 1, 'both-fail': 2, incomplete: 3, same: 4, unrun: 5 }
    for (const p of [...c.scenarios].sort((a, b) => order[a.class] - order[b.class] || a.scenario.localeCompare(b.scenario))) {
      const notes = [p.flaky ? 'flaky' : '', p.tss.between !== null ? `tool-seq similarity ${(p.tss.between * 100).toFixed(0)}%` : '', ...p.failures.candidate.slice(0, 1).map(f => `fails: ${f.reason.slice(0, 60)}`)].filter(Boolean).join('; ')
      lines.push(`| ${p.scenario} | ${p.baseline.passes}/${p.baseline.n} | ${p.candidate.passes}/${p.candidate.n} | ${classLabel(p.class)} | ${p.costPairs} | ${fmtUsd(p.costDiffUsd)} | ${fmtPct(p.costDiffPct)} | ${p.stepsDiff === null ? '—' : (p.stepsDiff >= 0 ? '+' : '') + p.stepsDiff.toFixed(1)} | ${p.baselineSpreadPct === null ? '—' : p.baselineSpreadPct.toFixed(0) + '%'} | ${notes} |`)
    }
    lines.push('')
    lines.push(`Cost over comparable scenarios: baseline $${c.comparableUsdBaseline.toFixed(4)} → candidate $${c.comparableUsdCandidate.toFixed(4)}; per-scenario mean Δ ${fmtUsd(c.costCI.mean)} (95% bootstrap CI ${fmtUsd(c.costCI.lo)} to ${fmtUsd(c.costCI.hi)}); Δ% ${fmtPct(c.costPctCI.mean)} (CI ${fmtPct(c.costPctCI.lo)} to ${fmtPct(c.costPctCI.hi)}); fixed-band Δ peak ${fmtUsd(c.costPeakCI.mean)}, off-peak ${fmtUsd(c.costOffpeakCI.mean)}.`)
    lines.push('')
  }
  if (report.notes.length) {
    lines.push('## Notes')
    lines.push('')
    for (const n of report.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  return lines.join('\n')
}
