import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { api, fmt, type History } from '../api.js'

/** Scenario × arm over every run: chronic failures, flaky scenarios and cost drift stand out here. */
export function HistoryView() {
  const [h, setH] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.history().then(setH).catch(e => setError(String(e))) }, [])
  if (error) return <p class="error">{error}</p>
  if (!h) return <p class="muted">loading…</p>
  return (
    <section>
      <div class="page-head"><div><h1>Scenario history</h1><p class="muted">{h.scenarios.length} scenarios × {h.arms.length} arms over {h.runs.length} runs · pass / runs, mean cost, mean steps</p></div></div>
      {h.chronic && (h.chronic.flaky.length + h.chronic.failing.length + h.chronic.saturated.length) > 0 && (
        <div class="card small">
          <b>Scenario health</b> (4+ trials, every arm alike):
          {h.chronic.flaky.length > 0 && <span> <span class="cls both-fail">chronically flaky</span> {h.chronic.flaky.join(', ')} — more repeats or a sharper prompt before trusting a regression here;</span>}
          {h.chronic.failing.length > 0 && <span> <span class="cls regression">never passes</span> {h.chronic.failing.join(', ')} — no signal until something passes;</span>}
          {h.chronic.saturated.length > 0 && <span> <span class="cls same">always passes</span> {h.chronic.saturated.join(', ')} — tracks regressions only, gives no headroom.</span>}
        </div>
      )}
      {h.scenarios.length === 0 ? <div class="empty"><p>No ledgers yet.</p></div> : (
        <div class="card">
          <table class="data">
            <thead><tr><th>scenario</th>{h.arms.map(a => <th>{a}</th>)}<th title="between-arm variance of mean cost over within-arm variance across the archive; below 1 the scenario's cost differences are mostly rerun noise">signal</th><th>runs</th></tr></thead>
            <tbody>
              {h.scenarios.map(s => (
                <tr key={s.name}>
                  <td><code>{s.name}</code></td>
                  {h.arms.map((a) => {
                    const c = s.cells[a]
                    if (!c) return <td class="muted">—</td>
                    const rate = c.runs ? c.passes / c.runs : 0
                    const flaky = c.runs >= 2 && c.passes > 0 && c.passes < c.runs
                    const pts = s.points[a] ?? []
                    const max = Math.max(1e-9, ...pts.map(p => p.usd))
                    return (
                      <td>
                        <span class={`cls ${rate === 1 ? 'same' : rate === 0 ? 'regression' : 'both-fail'}`}>{c.passes}/{c.runs}{flaky ? ' flaky' : ''}</span>
                        <span class="muted small"> {fmt.usd(c.usdMean)} · {c.stepsMean.toFixed(0)} steps{c.errors ? ` · ${c.errors} err` : ''}</span>
                        <span class="sparkbars" title="cost per trial, oldest → newest">{pts.map(p => <i class={p.ok ? 'ok' : 'ko'} style={{ height: `${Math.max(12, p.usd / max * 100)}%` }} title={`${p.runId} · ${fmt.usd(p.usd)} · ${p.ok ? 'pass' : 'fail'}`} />)}</span>
                      </td>
                    )
                  })}
                  <td>{s.signal && s.signal.snr !== null ? <span class={`cls ${s.signal.snr >= 1 ? 'same' : 'both-fail'}`} title={`SNR ${s.signal.snr.toFixed(2)} · within-arm CV ${s.signal.withinCv === null ? '—' : (s.signal.withinCv * 100).toFixed(0) + '%'} · pass spread ${s.signal.passSpread === null ? '—' : (s.signal.passSpread * 100).toFixed(0) + ' pp'} over ${s.signal.trials} trials`}>{s.signal.snr >= 1 ? 'signal' : 'noise'} {s.signal.snr.toFixed(1)}</span> : <span class="muted">—</span>}</td>
                  <td class="muted small">{s.runIds.map(id => <a href={`#/run/${id}`}>{id.slice(0, 15)}</a>).reduce<ComponentChildren[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
