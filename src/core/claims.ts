/**
 * What a run's evidence licenses anyone to say, and what it does not — the shape
 * `report.read` answers in (docs/agent-interface.md).
 *
 * The reading order this tool is built on exists so a person does not overclaim.
 * Once an agent stands between the numbers and the person, that order has to
 * survive being retold: `{reading: "inconclusive"}` becoming "about the same" is
 * the exact failure the whole project is against, and a paraphrase is where it
 * happens. So the evidence is split in two here. `licensed` is what may be said,
 * as codes with parameters for the caller to render in whatever language the
 * person is speaking. `withheld` is what may not, each with the reason, the
 * measurement that exists anyway, and the call that would settle it.
 *
 * A withheld claim still carries its `observed` numbers. Hiding them would be its
 * own dishonesty: the measurement is real, it simply does not support a
 * direction, and that is what the caller must say.
 */
import type { CandidateReport, ReadingBlocker, Report } from './report.js'

export interface Claim {
  code: string
  [param: string]: unknown
}

export interface WithheldClaim {
  /** The claim that may not be made: `northStar.direction`, `reliability.direction`. */
  claim: string
  /** Why, in the order the rules applied. The first is the one that decided it. */
  reason: ReadingBlocker
  also?: ReadingBlocker[]
  /** The measurement that exists regardless. Real, and not a direction. */
  observed?: Record<string, unknown>
  next?: { tool: string; args?: Record<string, unknown> }
}

export interface CandidateClaims {
  arm: string
  gate: CandidateReport['gate']
  grade: CandidateReport['grade']
  licensed: Claim[]
  withheld: WithheldClaim[]
  /** For "is it worth running more", "how small a difference could this see", "what did it cost". */
  design: {
    comparableScenarios: number
    repeats: number
    mdePct: number | null
    resolution: { nStar: number | null; q: number | null }
    alpha: number
    floor: CandidateReport['floor']
  }
}

export interface RunClaims {
  schema: 'dsh-eval-claims/1'
  runId: string
  baseline: string
  trials: number
  usd: number
  candidates: CandidateClaims[]
}

/** The call that would lift a blocker, when there is one. */
function remedyFor(code: string, baseline: string, runId: string): { tool: string; args?: Record<string, unknown> } | undefined {
  if (code.startsWith('floor.')) return code === 'floor.no_step_band' ? { tool: 'run.start', args: { baseline, aa: true, repeats: 3 } } : { tool: 'run.start', args: { baseline, aa: true, repeats: 3 } }
  if (code === 'scenarios.below_minimum' || code === 'reading.interval_covers_zero' || code === 'reading.inside_noise_band') return { tool: 'run.start', args: { baseline, repeats: 5 } }
  if (code === 'gate.suspect') return { tool: 'run.rerun', args: { runId, repeats: 5 } }
  if (code === 'gate.incomplete') return { tool: 'run.start', args: { resume: runId } }
  if (code === 'judge.not_run') return { tool: 'judge.run', args: { runId } }
  if (code === 'cost.unpriced') return { tool: 'config.prices' }
  return undefined
}

function candidateClaims(report: Report, c: CandidateReport): CandidateClaims {
  const licensed: Claim[] = []
  const withheld: WithheldClaim[] = []
  const comparable = c.scenarios.filter(p => p.costDiffPct !== null).length

  // The gate speaks first, whichever way it went: "nothing broke" is a claim, and so is "this broke".
  if (c.gate === 'unsafe') licensed.push({ code: 'gate.unsafe', scenarios: c.unsafe, evidence: c.scenarios.find(p => p.class === 'unsafe')?.violations.evidence ?? null })
  else if (c.gate === 'regressions') licensed.push({ code: 'gate.regression', scenarios: c.regressions, ...(c.regressionChance !== null ? { chance: c.regressionChance } : {}) })
  else if (c.gate === 'suspect') licensed.push({ code: 'gate.suspected', scenarios: c.suspected, ...(c.regressionChance !== null ? { chance: c.regressionChance } : {}) })
  else if (c.gate === 'incomplete') licensed.push({ code: 'gate.incomplete', scenarios: c.incomplete })
  else licensed.push({ code: 'gate.nothing_broke', scenarios: c.scenarios.filter(p => p.class !== 'unrun').length })
  if (c.bothUnsafe.length > 0) licensed.push({ code: 'gate.both_unsafe', scenarios: c.bothUnsafe })
  if (c.improvements.length > 0) licensed.push({ code: 'gate.improvement', scenarios: c.improvements })

  // The contract's gate order is "gates first: any safety-gate violation, then any regression, blocks every
  // reading". So a closed gate withholds both readings below, whatever they computed to — the numbers stay
  // on the record, but nothing about them may be said until the gate is answered.
  const gateBlocker: ReadingBlocker | undefined = c.gate === 'pass' ? undefined
    : { code: `gate.${c.gate}`, scenarios: c.gate === 'unsafe' ? c.unsafe : c.gate === 'regressions' ? c.regressions : c.gate === 'suspect' ? c.suspected : c.incomplete }
  const gateRemedy = gateBlocker === undefined ? undefined : remedyFor(gateBlocker.code, report.baseline, report.runId)

  // Reliability: the headline, read before whatever the run was registered for.
  const rel = c.reliability
  if (gateBlocker !== undefined) {
    withheld.push({
      claim: 'reliability.direction',
      reason: gateBlocker,
      observed: { reading: rel.reading, k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate },
      ...(gateRemedy ? { next: gateRemedy } : {}),
    })
  } else if (rel.reading === 'more-reliable' || rel.reading === 'less-reliable' || rel.reading === 'same') {
    licensed.push({ code: `reliability.${rel.reading.replace('-', '_')}`, k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate, midP: rel.midP })
  } else {
    withheld.push({
      claim: 'reliability.direction',
      reason: rel.scenarios < 5 ? { code: 'scenarios.below_minimum', have: rel.scenarios, need: 5 } : { code: 'reliability.undecided', b: rel.b, c: rel.c, midP: rel.midP },
      observed: { k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate },
      next: { tool: 'run.start', args: { baseline: report.baseline, repeats: Math.max(5, rel.k + 2) } },
    })
  }

  // The north star the run was registered for.
  const ns = c.northStar
  const observed: Record<string, unknown> = { metric: ns.metric, ...(ns.ci ? { mean: ns.ci.mean, interval: [ns.ci.lo, ns.ci.hi], unit: ns.unit } : {}), comparableScenarios: comparable }
  if (gateBlocker !== undefined) {
    withheld.push({
      claim: 'northStar.direction',
      reason: gateBlocker,
      observed: { ...observed, reading: ns.reading },
      ...(gateRemedy ? { next: gateRemedy } : {}),
    })
  } else if (ns.reading === 'better' || ns.reading === 'worse' || ns.reading === 'same') {
    licensed.push({ code: `northStar.${ns.reading}`, ...observed })
  } else {
    const [first, ...rest] = c.blockers.length > 0 ? c.blockers : [{ code: 'reading.undecided' } as ReadingBlocker]
    withheld.push({
      claim: 'northStar.direction',
      reason: first!,
      ...(rest.length > 0 ? { also: rest } : {}),
      observed,
      ...(() => { const next = remedyFor(first!.code, report.baseline, report.runId); return next ? { next } : {} })(),
    })
  }
  return {
    arm: c.arm,
    gate: c.gate,
    grade: c.grade,
    licensed,
    withheld,
    design: {
      comparableScenarios: comparable,
      repeats: report.repeats,
      mdePct: c.mdePct,
      resolution: c.resolution,
      alpha: c.alpha,
      floor: c.floor,
    },
  }
}

export function claimsOf(report: Report): RunClaims {
  return {
    schema: 'dsh-eval-claims/1',
    runId: report.runId,
    baseline: report.baseline,
    trials: report.runs,
    usd: report.usd,
    candidates: report.candidates.map(c => candidateClaims(report, c)),
  }
}
