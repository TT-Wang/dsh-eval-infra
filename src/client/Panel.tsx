/**
 * The dsh-eval seat in the dsh sidebar: the state of the last comparison and
 * the two actions that follow from it. Everything heavy stays in the full page
 * at /eval/; this panel exists so a plugin author can see, without leaving the
 * agent, whether the change they just made has been measured and how it came out.
 */
// The classic JSX factory, taken from the React the shell shares. The automatic
// runtime (`react/jsx-runtime`) resolves to a different instance inside a
// third-party plugin bundle, and the elements it makes are rejected by the
// renderer as plain objects.
import { createElement, Fragment, useEffect, useState } from 'react'

void Fragment

/** Mount path of the host plugin's web route. */
const BASE = '/eval'

interface Verdict {
  arm: string
  gate: 'pass' | 'regressions' | 'incomplete'
  costReading: 'cheaper' | 'more-expensive' | 'equivalent' | 'inconclusive' | 'none'
  costPct: number | null
  regressions: number
  improvements: number
}

interface RunRow {
  id: string
  createdAt: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  label?: string
  arms: string[]
  usd?: number
  verdicts?: Verdict[]
}

const GOOD = 'var(--dsh-good, #12805c)'
const BAD = 'var(--dsh-bad, #c33)'
const MUTED = 'var(--dsh-muted, #6b7280)'

/** One line per candidate, in the same words the full report uses. */
function summarise(v: Verdict): { text: string; color: string } {
  const pct = v.costPct === null ? '' : ` ${Math.abs(v.costPct).toFixed(0)}%`
  if (v.gate === 'regressions') return { text: `${v.arm}: breaks ${v.regressions} scenario${v.regressions === 1 ? '' : 's'}`, color: BAD }
  if (v.gate === 'incomplete') return { text: `${v.arm}: run incomplete`, color: MUTED }
  if (v.costReading === 'cheaper') return { text: `${v.arm}: cheaper by${pct}`, color: GOOD }
  if (v.costReading === 'more-expensive') return { text: `${v.arm}: costs${pct} more`, color: BAD }
  if (v.costReading === 'equivalent') return { text: `${v.arm}: no real difference`, color: MUTED }
  if (v.improvements > 0) return { text: `${v.arm}: fixes ${v.improvements} scenario${v.improvements === 1 ? '' : 's'}`, color: GOOD }
  return { text: `${v.arm}: not conclusive${v.costPct === null ? '' : ` (${v.costPct < 0 ? '−' : '+'}${pct.trim()})`}`, color: MUTED }
}

export function EvalPanel({ wide }: { wide: boolean }): unknown {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      fetch(`${BASE}/api/runs`, { headers: { accept: 'application/json' } })
        .then(r => (r.ok ? r.json() as Promise<RunRow[]> : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((rs) => { if (alive) { setRuns(rs); setError(null) } })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    }
    load()
    // A running comparison changes state on the order of seconds; this is a status seat, not a live view.
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const latest = runs?.[0]
  const running = runs?.find(r => r.status === 'running')
  const open = (hash = ''): void => { window.open(`${BASE}/${hash}`, '_blank', 'noopener') }

  if (!wide) {
    return (
      <button
        type="button"
        title={latest ? `dsh-eval · last run ${latest.status}` : 'dsh-eval'}
        onClick={() => open()}
        style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--dsh-line, #e5e7eb)', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
      >
        {running ? '◐' : 'A/B'}
      </button>
    )
  }

  return (
    <div style={{ padding: '8px 10px', borderTop: '1px solid var(--dsh-line, #e5e7eb)', fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <b style={{ fontSize: 12 }}>dsh-eval</b>
        <button type="button" onClick={() => open()} style={linkStyle}>open</button>
      </div>
      {error !== null && <div style={{ color: MUTED }}>not reachable: {error}</div>}
      {error === null && runs === null && <div style={{ color: MUTED }}>loading…</div>}
      {error === null && runs !== null && runs.length === 0 && <div style={{ color: MUTED }}>no comparisons yet</div>}
      {running !== undefined && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--dsh-warn, #b26a00)' }}>◐ running</span> {running.label ?? running.id}
        </div>
      )}
      {latest !== undefined && running === undefined && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ color: MUTED }}>{latest.label ?? latest.id} · {latest.arms.join(' vs ')}</div>
          {(latest.verdicts ?? []).slice(0, 2).map((v) => {
            const line = summarise(v)
            return <div key={v.arm} style={{ color: line.color }}>{line.text}</div>
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => open('#/new')} style={linkStyle}>new comparison</button>
        {latest !== undefined && <button type="button" onClick={() => open(`#/run/${latest.id}`)} style={linkStyle}>last result</button>}
      </div>
    </div>
  )
}

const linkStyle = { border: 'none', background: 'transparent', padding: 0, color: 'var(--dsh-accent, #2563eb)', cursor: 'pointer', font: 'inherit' } as const
