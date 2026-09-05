import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { api, fmt, type History, type Meta, type RunRow } from '../api.js'

/**
 * The archive, both ways round: a row per run (what did I compare, what did it
 * say) and, underneath, a row per scenario across every run (is this scenario
 * even worth reading). The second is reference material, so it stays folded
 * until asked for.
 */
export function RunsView() {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.meta().then(setMeta).catch(e => setError(String(e)))
    const load = (): void => { api.runs().then(setRuns).catch(e => setError(String(e))) }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  return (
    <section>
      <div class="page-head">
        <div>
          <h1>Runs</h1>
          {meta && <p class="muted">project <code>{meta.project}</code> · profile <b>{meta.profile}</b>{meta.profileReady ? '' : ' (not initialised — run dsh-eval init)'}</p>}
        </div>
        <a class="btn primary" href="#/new">New run</a>
      </div>
      {error && <p class="error">{error}</p>}
      {runs === null ? <p class="muted">loading…</p> : runs.length === 0 ? (
        <div class="empty">
          <p>No runs yet.</p>
          <p class="muted">Start one with <a href="#/new">New run</a>, or from a shell: <code>dsh-eval run --baseline baseline --arm candidate</code></p>
        </div>
      ) : (
        <table class="data">
          <thead><tr><th>run</th><th>compared</th><th class="num">trials</th><th class="num">cost</th><th>result</th></tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td>
                  <a href={`#/run/${r.id}`}><code>{r.id}</code></a>
                  {r.status !== 'done' && <span class={`status ${r.status}`}>{r.status}</span>}
                  <div class="muted small">{fmt.time(r.createdAt)}{r.label ? ` · ${r.label}` : ''}</div>
                </td>
                <td>{r.arms.join(' vs ')}{r.sandbox === 'docker' ? <span class="tag">docker</span> : null}</td>
                <td class="num">{r.completed}/{r.total}<div class="muted small">{r.scenarios} scen × {r.repeats}</div></td>
                <td class="num">{fmt.usd(r.usd, 3)}</td>
                <td>{(r.verdicts ?? []).map(v => <div><span class={`cls ${v.gate === 'regressions' ? 'regression' : v.gate === 'incomplete' ? 'incomplete' : v.costReading === 'cheaper' ? 'improvement' : 'same'}`}>{v.arm}: {v.gate === 'regressions' ? `${v.regressions} regression${v.regressions === 1 ? '' : 's'}` : v.gate === 'incomplete' ? 'incomplete' : v.costReading === 'none' ? 'no pairs' : `${v.costReading} ${fmt.pct(v.costPct)}`}</span>{v.improvements ? <span class="muted small"> +{v.improvements} improved</span> : null}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runs !== null && runs.length > 0 && <ScenarioRecord />}
    </section>
  )
}

/** The same archive by scenario instead of by run: chronic failures, flaky scenarios and cost drift. */
function ScenarioRecord() {
  const [h, setH] = useState<History | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (open && h === null) void api.history().then(setH).catch(() => setH(null)) }, [open])
  return (
    <details class="uk-card mt-6" onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary class="uk-card-header py-3 cursor-pointer text-sm font-medium">Scenario track record <span class="font-normal text-muted-foreground">how each scenario has behaved across every run</span></summary>
      <div class="uk-card-body pt-0">{h === null ? <p class="muted small">loading…</p> : <ScenarioTable h={h} />}</div>
    </details>
  )
}

function ScenarioTable({ h }: { h: History }) {
  if (h.scenarios.length === 0) return <p class="muted small">No ledgers yet.</p>
  const chronic = h.chronic
  return (
    <>
      {chronic && (chronic.saturated.length + chronic.failing.length + chronic.flaky.length) > 0 && (
        <div class="notes small">
          {chronic.saturated.length > 0 && <p><span class="cls same">always passes</span> {chronic.saturated.join(', ')} — every arm gets these right every time, so they can catch a regression but never show an improvement.</p>}
          {chronic.failing.length > 0 && <p><span class="cls regression">never passes</span> {chronic.failing.join(', ')} — no arm has ever passed these, so they say nothing about either one.</p>}
          {chronic.flaky.length > 0 && <p><span class="cls both-fail">flaky</span> {chronic.flaky.join(', ')} — the same arm passes sometimes and fails others, so one failure here is noise, not a regression.</p>}
        </div>
      )}
      <div class="scroll-x">
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
    </>
  )
}
