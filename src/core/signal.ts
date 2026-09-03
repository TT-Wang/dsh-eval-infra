/**
 * Scenario discriminating power across the run archive: between-arm variance
 * of mean cost over the pooled within-arm variance (signal-to-noise), the
 * within-arm coefficient of variation, and the pass-rate spread. Used by the
 * history view and by `--order signal` in sequential mode (scenarios with the
 * most signal first; the order is fixed before this run's data is seen, so the
 * confidence sequences stay valid).
 */
import { listRuns, readLedgers, runPaths } from './store.js'

export interface ScenarioSignal { snr: number | null; withinCv: number | null; passSpread: number | null; trials: number }

export function scenarioSignal(arms: Array<{ arm: string; usd: number[]; passes: number[] }>): ScenarioSignal {
  const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const varOf = (xs: number[]): number => { const m = meanOf(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) }
  const trials = arms.reduce((n, a) => n + a.usd.length, 0)
  const passRates = arms.filter(a => a.passes.length > 0).map(a => meanOf(a.passes))
  const passSpread = passRates.length >= 2 ? Math.max(...passRates) - Math.min(...passRates) : null
  const usable = arms.filter(a => a.usd.length >= 2)
  if (usable.length < 2) return { snr: null, withinCv: null, passSpread, trials }
  const means = usable.map(a => meanOf(a.usd))
  const within = meanOf(usable.map(a => varOf(a.usd)))
  const between = varOf(means)
  const grand = meanOf(means)
  return { snr: within > 0 ? between / within : null, withinCv: grand > 0 ? Math.sqrt(within) / grand : null, passSpread, trials }
}

/** Per-scenario signal over every finished run in the archive (optionally excluding one run). */
export function archiveSignal(runsRoot: string, exceptRunId?: string): Map<string, ScenarioSignal> {
  const byScenario = new Map<string, Map<string, { usd: number[]; passes: number[] }>>()
  for (const r of listRuns(runsRoot)) {
    if (r.id === exceptRunId) continue
    let ledgers
    try { ledgers = readLedgers(runPaths(runsRoot, r.id)) } catch { continue }
    for (const l of ledgers) {
      const arms = byScenario.get(l.scenario) ?? new Map()
      const cell = arms.get(l.arm) ?? { usd: [], passes: [] }
      cell.usd.push(l.totals.usd)
      cell.passes.push(l.verdict?.ok === true && l.error === undefined ? 1 : 0)
      arms.set(l.arm, cell)
      byScenario.set(l.scenario, arms)
    }
  }
  const out = new Map<string, ScenarioSignal>()
  for (const [name, arms] of byScenario) out.set(name, scenarioSignal([...arms.entries()].map(([arm, c]) => ({ arm, ...c }))))
  return out
}

/** Scenario names ordered by archive signal, strongest first; scenarios without a signal keep their archive order after the known ones. */
export function archiveSignalOrder(runsRoot: string, exceptRunId?: string): string[] {
  const sig = archiveSignal(runsRoot, exceptRunId)
  return [...sig.entries()].sort(([, a], [, b]) => (b.snr ?? -1) - (a.snr ?? -1)).map(([name]) => name)
}
