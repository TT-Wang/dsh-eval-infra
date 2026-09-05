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
      <div class="page-head"><div><h1>Scenarios</h1><p class="muted">How each scenario has behaved across every run so far — one row per scenario, one column per arm. The Runs page is the other axis: one row per experiment.</p></div></div>
        <div class="card">
        <b>Patterns</b> <span class="muted small">Failures and behaviours that keep coming back, across every run in the archive. Most arm-skewed first: a pattern that hits one arm far more than the other points at what that arm changed, while one that hits both alike is a property of the scenario or of dsh.</span>
        {(!h.patterns || h.patterns.length === 0) && <p class="muted small">Nothing recurs at least three times yet.</p>}
        {h.patterns && h.patterns.length > 0 && (
          <div class="scroll-x">
            <table class="grid">
              <thead><tr><th>pattern</th><th>kind</th><th class="num">trials</th><th class="num" title="how unevenly this pattern falls across the arms: 0% is even, and the higher it climbs the more it is one arm's doing">arm skew</th><th>scenarios</th><th>arms</th><th>last seen</th></tr></thead>
              <tbody>
                {h.patterns.map(p => (
                  <tr key={p.signature}>
                    <td title={p.example}><code>{p.signature}</code></td>
                    <td><span class={`cls ${p.kind === 'failure' ? 'regression' : 'incomplete'}`}>{p.kind}</span></td>
                    <td class="num">{p.count}</td>
                    <td class="num">{p.armSkew > 0.2 ? <b title="this pattern hits one arm far more than another">{(p.armSkew * 100).toFixed(0)}%</b> : `${(p.armSkew * 100).toFixed(0)}%`}</td>
                    <td class="muted small">{p.scenarios.slice(0, 3).join(', ')}{p.scenarios.length > 3 ? ` +${p.scenarios.length - 3}` : ''}</td>
                    <td class="muted small">{p.arms.join(', ')}</td>
                    <td class="muted small">{p.lastSeen ? new Date(p.lastSeen).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {h.chronic && (h.chronic.flaky.length + h.chronic.failing.length + h.chronic.saturated.length) > 0 && (
      <div class="card small">
          <b>Scenarios worth knowing about</b>
          {h.chronic.saturated.length > 0 && <p><span class="cls same">always passes</span> {h.chronic.saturated.join(', ')} — every arm gets these right every time, so they can catch a regression but can never show an improvement.</p>}
          {h.chronic.failing.length > 0 && <p><span class="cls regression">never passes</span> {h.chronic.failing.join(', ')} — no arm has ever passed these, so they say nothing about either one until something does.</p>}
          {h.chronic.flaky.length > 0 && <p><span class="cls both-fail">flaky</span> {h.chronic.flaky.join(', ')} — the same arm passes sometimes and fails others, so a single failure here is noise, not a regression. More repeats, or a sharper prompt.</p>}
          <p class="muted">Counted over scenarios with four or more trials, where every arm behaves the same way.</p>
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
                        <span class={`cls ${rate === 1 ? 'same' : rate === 0 ? 'regression' : 'both-fail'}`}>{c.passes}/{c.runs} pass{flaky ? ' · flaky' : ''}</span>
                        <span class="muted small"> {fmt.usd(c.usdMean)} avg · {c.stepsMean.toFixed(0)} steps{c.errors ? ` · ${c.errors} err` : ''}</span>
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
