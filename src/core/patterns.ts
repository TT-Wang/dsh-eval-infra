/**
 * Pattern discovery across the run archive: recurring failure signatures and
 * behaviour regimes that no single report is looking for (the gap Braintrust's
 * "Patterns" fills for hosted products, and what AutoTraceGT, 2608.30391, does
 * with grounded theory). Signatures are derived from verifier reasons and from
 * behaviour counters, never from an LLM, so the result is deterministic and free.
 */
import type { RunLedger } from './types.js'

export interface Pattern {
  kind: 'failure' | 'behaviour'
  /** Stable, human-readable signature. */
  signature: string
  count: number
  scenarios: string[]
  arms: string[]
  runs: string[]
  firstSeen: string
  lastSeen: string
  example: string
  /** Share of the trials this pattern covers, among the trials it could apply to. */
  share: number
  /** Arms are hit unevenly: max minus min share across arms with at least three trials (0 when even). */
  armSkew: number
}

/** Reduce a verifier reason to a signature: drop paths, numbers and quoted values so like failures collapse. */
export function failureSignature(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\[errno \d+\]/g, '[errno N]')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, 'X')
    // Paths and URLs are where the machine shows through: they differ between two
    // developers hitting the identical failure, which splits one pattern into many,
    // and they put someone's home directory on a screen that gets shared.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, 'URL')
    .replace(/(^|[\s(=:])(~|\.{1,2})?\/[^\s)'"`,;]+/g, '$1PATH')
    .replace(/\b[\w./-]+\.(json|csv|md|txt|py|log|yml|yaml|html)\b/g, 'FILE')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    // Cut at a word boundary: a signature is read by a person, and a message
    // sliced mid-word reads as corruption rather than as a truncation.
    .replace(/^(.{0,119}\S)(\s.*)?$/s, '$1')
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))
  return s[i]!
}

/**
 * Patterns over the archive. `minCount` keeps one-off noise out; behaviour
 * regimes use the archive's own upper quartile as the threshold, so "many tool
 * errors" means many for this project, not for a fixed number.
 */
export function discoverPatterns(ledgers: RunLedger[], minCount = 3): Pattern[] {
  const out: Pattern[] = []
  const add = (kind: Pattern['kind'], signature: string, rows: RunLedger[], example: string, denominator: number): void => {
    if (rows.length < minCount) return
    const times = rows.map(r => r.startedAt).filter(Boolean).sort()
    const byArm = new Map<string, number>()
    for (const r of rows) byArm.set(r.arm, (byArm.get(r.arm) ?? 0) + 1)
    const armTotals = new Map<string, number>()
    for (const l of ledgers) armTotals.set(l.arm, (armTotals.get(l.arm) ?? 0) + 1)
    const shares = [...armTotals.entries()].filter(([, n]) => n >= 3).map(([arm, n]) => (byArm.get(arm) ?? 0) / n)
    out.push({
      kind,
      signature,
      count: rows.length,
      scenarios: [...new Set(rows.map(r => r.scenario))].sort(),
      arms: [...new Set(rows.map(r => r.arm))].sort(),
      runs: [...new Set(rows.map(r => r.runId))].sort(),
      firstSeen: times[0] ?? '',
      lastSeen: times[times.length - 1] ?? '',
      example: example.slice(0, 200),
      share: denominator ? rows.length / denominator : 0,
      armSkew: shares.length >= 2 ? Math.max(...shares) - Math.min(...shares) : 0,
    })
  }

  // Failure signatures
  const failures = ledgers.filter(l => l.verdict?.ok === false || l.error !== undefined)
  const bySig = new Map<string, RunLedger[]>()
  for (const l of failures) {
    const sig = failureSignature(l.error ?? l.verdict?.detail ?? 'unknown failure')
    bySig.set(sig, [...(bySig.get(sig) ?? []), l])
  }
  for (const [sig, rows] of bySig) add('failure', sig, rows, rows[0]!.error ?? rows[0]!.verdict?.detail ?? '', ledgers.length)

  // Behaviour regimes, thresholded on the archive's own upper quartile
  const errQ = quantile(ledgers.map(l => l.behaviour?.toolErrors ?? 0), 0.75)
  const repQ = quantile(ledgers.map(l => l.behaviour?.repeatedCalls ?? 0), 0.75)
  const noopQ = quantile(ledgers.map(l => l.behaviour?.noActionSteps ?? 0), 0.75)
  const stepQ = quantile(ledgers.map(l => l.totals.steps), 0.9)
  const regimes: Array<[string, (l: RunLedger) => boolean]> = [
    [`tool errors above the archive's upper quartile (> ${errQ})`, l => (l.behaviour?.toolErrors ?? 0) > errQ && errQ > 0],
    [`repeated identical calls above the upper quartile (> ${repQ})`, l => (l.behaviour?.repeatedCalls ?? 0) > repQ && repQ > 0],
    [`steps with no action above the upper quartile (> ${noopQ})`, l => (l.behaviour?.noActionSteps ?? 0) > noopQ && noopQ > 0],
    [`long trials: more than ${stepQ} steps (archive's 90th percentile)`, l => l.totals.steps > stepQ && stepQ > 0],
    ['context compaction happened during the trial', l => (l.behaviour?.compactions ?? 0) > 0],
  ]
  for (const [name, test] of regimes) {
    const rows = ledgers.filter(test)
    add('behaviour', name, rows, `${rows.length} trials across ${new Set(rows.map(r => r.scenario)).size} scenarios`, ledgers.length)
  }

  // Most arm-skewed first — those are the ones an arm caused rather than the scenario — and the more frequent of two equally skewed.
  return out.sort((a, b) => (b.armSkew - a.armSkew) || (b.count - a.count)).slice(0, 20)
}
