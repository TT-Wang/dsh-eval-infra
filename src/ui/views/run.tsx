import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt, stream, STATIC, type LedgerLite, type RunDetail } from '../api.js'
import type { CandidateReport, PairedScenario, PairClass } from '../../core/report.js'
import type { Progress } from '../../core/store.js'

type Filter = 'all' | 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete'
const ORDER: Record<PairClass, number> = { regression: 0, improvement: 1, 'both-fail': 2, incomplete: 3, same: 4 }
const LABEL: Record<PairClass, string> = { regression: 'regression', improvement: 'improvement', same: 'same', 'both-fail': 'both fail', incomplete: 'incomplete' }

export function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [ledgers, setLedgers] = useState<LedgerLite[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  const load = (): void => {
    api.run(id).then((d) => { setDetail(d); setLogs(d.logs) }).catch(e => setError(String(e)))
    api.ledgers(id).then(setLedgers).catch(() => { /* no ledgers yet */ })
  }
  useEffect(() => {
    load()
    const stop = stream(id, (event, data) => {
      if (event === 'progress' && data) setDetail(d => d ? { ...d, progress: data as Progress } : d)
      else if (event === 'log') setLogs(l => [...l.slice(-400), String(data)])
      else if (event === 'ledger') api.ledgers(id).then(setLedgers).catch(() => { /* ignore */ })
      else if (event === 'done' || event === 'error') setTimeout(load, 300)
    })
    return stop
  }, [id])

  if (error) return <p class="error">{error}</p>
  if (!detail) return <p class="muted">loading…</p>
  const { plan, progress, report, env } = detail
  const arms = [plan.baseline.name, ...plan.candidates.map(c => c.name)]
  const byCell = new Map<string, LedgerLite[]>()
  for (const l of ledgers) { const k = `${l.scenario}|${l.arm}`; byCell.set(k, [...(byCell.get(k) ?? []), l]) }
  const running = progress?.status === 'running'
  const pctDone = progress ? Math.round(progress.completed / Math.max(1, progress.total) * 100) : 0

  return (
    <section class="run">
      <div class="page-head">
        <div>
          <h1><code>{plan.id}</code>{plan.label ? <span class="muted"> · {plan.label}</span> : null}</h1>
          <p class="muted">{plan.baseline.name} vs {plan.candidates.map(c => c.name).join(', ')} · {plan.scenarios.length} scenarios × {plan.repeats} repeats · concurrency {plan.concurrency} · created {fmt.time(plan.createdAt)}</p>
        </div>
        <div class="row">
          {running && <button class="btn danger" onClick={() => { void api.cancel(id) }}>Cancel</button>}
          {STATIC === undefined && <a class="btn" href={`${location.pathname.replace(/\/?$/, '/')}api/runs/${id}/report`} target="_blank">report.json</a>}
        </div>
      </div>

      {progress && (
        <div class="card progress-card">
          <div class="row between">
            <div><span class={`status ${progress.status}`}>{progress.status}</span> <b>{progress.completed}</b>/{progress.total} trials{progress.failed ? <span class="warn-text"> · {progress.failed} errors</span> : null} · spent <b>{fmt.usd(progress.usd, 3)}</b></div>
            <div class="muted small">started {fmt.time(progress.startedAt)}{progress.error ? <span class="error"> · {progress.error}</span> : null}</div>
          </div>
          <div class="bar"><i style={{ width: `${pctDone}%` }} /></div>
          {progress.active.length > 0 && <div class="active">{progress.active.map(a => <span class="chip live">{a.scenario} / {a.arm} #{a.rep} · turn {a.turn}/{a.turns}</span>)}</div>}
        </div>
      )}

      {report && report.candidates.map(c => <Verdict key={c.arm} c={c} baseline={report.baseline} />)}

      <div class="card">
        <h2>Trials <span class="muted small">pips: ● pass ● fail ● error ○ queued</span></h2>
        <table class="data matrix">
          <thead><tr><th>scenario</th>{arms.map(a => <th>{a}</th>)}</tr></thead>
          <tbody>
            {plan.scenarios.map(s => (
              <tr key={s}>
                <td><code>{s}</code></td>
                {arms.map(a => (
                  <td>
                    {Array.from({ length: plan.repeats }, (_, i) => i + 1).map((rep) => {
                      const l = byCell.get(`${s}|${a}`)?.find(x => x.rep === rep)
                      const active = progress?.active.find(x => x.scenario === s && x.arm === a && x.rep === rep)
                      const cls = l ? (l.error ? 'err' : l.verdict?.ok ? 'pass' : 'fail') : active ? 'live' : 'queued'
                      const title = l ? `${l.verdict?.ok ? 'pass' : 'fail'} · ${fmt.usd(l.totals.usd)} · ${l.totals.steps} steps · ${fmt.secs(l.wallMs)}${l.error ? ` · ${l.error}` : ''}\n${l.verdict?.detail ?? ''}` : active ? `running turn ${active.turn}` : 'queued'
                      return l ? <a class={`pip ${cls}`} title={title} href={`#/run/${id}/trace/${s}/${a}/${rep}`} /> : <span class={`pip ${cls}`} title={title} />
                    })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report && report.candidates.map(c => (
        <div class="card" key={c.arm}>
          <div class="row between">
            <h2>{c.arm} vs {report.baseline}</h2>
            <div class="chips">
              {(['all', 'regression', 'improvement', 'same', 'both-fail', 'incomplete'] as Filter[]).map(f => {
                const n = f === 'all' ? c.scenarios.length : c.scenarios.filter(p => p.class === f).length
                return <button class={`chip ${filter === f ? 'on' : ''} ${f}`} onClick={() => setFilter(f)}>{f === 'all' ? 'all' : LABEL[f]} {n}</button>
              })}
            </div>
          </div>
          <table class="data paired">
            <thead><tr><th>scenario</th><th>class</th><th>{report.baseline}</th><th>{c.arm}</th><th class="num">cost pairs</th><th class="num">Δ cost</th><th class="num">Δ %</th><th class="num">Δ steps</th><th class="num">baseline spread</th></tr></thead>
            <tbody>
              {[...c.scenarios].filter(p => filter === 'all' || p.class === filter).sort((a, b) => ORDER[a.class] - ORDER[b.class] || a.scenario.localeCompare(b.scenario)).map(p => (
                <>
                  <tr key={p.scenario} class={`row-${p.class}`} onClick={() => setExpanded(expanded === `${c.arm}|${p.scenario}` ? null : `${c.arm}|${p.scenario}`)}>
                    <td><code>{p.scenario}</code></td>
                    <td><span class={`cls ${p.class}`}>{LABEL[p.class]}</span></td>
                    <td><Pips id={id} scenario={p.scenario} arm={report.baseline} stats={p.baseline} /></td>
                    <td><Pips id={id} scenario={p.scenario} arm={c.arm} stats={p.candidate} /></td>
                    <td class="num">{p.costPairs}</td>
                    <td class="num">{fmt.usd(p.costDiffUsd)}</td>
                    <td class={`num ${p.costDiffPct !== null && p.costDiffPct < 0 ? 'good' : p.costDiffPct !== null && p.costDiffPct > 0 ? 'bad' : ''}`}>{fmt.pct(p.costDiffPct)}</td>
                    <td class="num">{p.stepsDiff === null ? '—' : (p.stepsDiff >= 0 ? '+' : '') + p.stepsDiff.toFixed(1)}</td>
                    <td class="num">{p.baselineSpreadPct === null ? '—' : `${p.baselineSpreadPct.toFixed(0)}%`}</td>
                  </tr>
                  {expanded === `${c.arm}|${p.scenario}` && <tr class="expand"><td colSpan={9}><Expanded p={p} id={id} baseline={report.baseline} candidate={c.arm} /></td></tr>}
                </>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {report && report.notes.length > 0 && <div class="card notes"><h2>Notes</h2><ul>{report.notes.map(n => <li>{n}</li>)}</ul></div>}

      <div class="card">
        <h2>Environment</h2>
        <dl class="facts">
          <dt>dsh</dt><dd>{env?.dshVersion ?? '?'} <span class="muted small">{env?.dshSource ?? ''}</span></dd>
          <dt>dsh-eval</dt><dd>{env?.evalInfraVersion ?? '?'} · node {env?.node ?? '?'} · {env?.platform ?? '?'}</dd>
          <dt>model / effort</dt><dd>{[...new Set(ledgers.map(l => `${l.headerModel ?? l.model} / ${l.resolvedEffort ?? 'default'}`))].join(', ') || '—'}</dd>
          <dt>prices</dt><dd>DeepSeek list as of {env?.priceTableAsOf ?? '?'}; bands: {[...new Set(ledgers.flatMap(l => l.steps.map(s => s.band)))].join(', ') || '—'}</dd>
          <dt>arms</dt><dd>{env?.diffs?.map(d => <div><b>{d.candidate}</b>: {d.variables} variable(s){env.multiVariable ? <span class="warn-text"> · multi-variable comparison</span> : null}</div>)}{Object.entries(env?.composedTreeSha ?? {}).map(([a, sha]) => <div class="muted small">{a}: tree {sha.slice(0, 12)}</div>)}</dd>
        </dl>
      </div>

      <div class="card">
        <h2 class="row between"><span>Log</span><button class="btn small" onClick={() => setShowLogs(!showLogs)}>{showLogs ? 'hide' : 'show'} ({logs.length})</button></h2>
        {showLogs && <pre class="log">{logs.join('\n')}</pre>}
      </div>
    </section>
  )
}

function Verdict({ c, baseline }: { c: CandidateReport; baseline: string }) {
  const tone = c.gate === 'regressions' ? 'bad' : c.gate === 'incomplete' ? 'neutral' : c.costReading === 'cheaper' ? 'good' : c.costReading === 'more-expensive' ? 'warn' : 'neutral'
  const s = c.summary
  return (
    <div class={`verdict ${tone}`}>
      <div class="verdict-head"><b>{c.arm}</b> vs {baseline}</div>
      <p class="verdict-text">{c.verdict}</p>
      <div class="cards">
        <Stat label="pass" a={`${s.baseline.passes}/${s.baseline.runs}`} b={`${s.candidate.passes}/${s.candidate.runs}`} />
        <Stat label="pass^k" a={`${(s.baseline.passAllK * 100).toFixed(0)}%`} b={`${(s.candidate.passAllK * 100).toFixed(0)}%`} />
        <Stat label="$ / solved" a={fmt.usd(s.baseline.usdPerSolved)} b={fmt.usd(s.candidate.usdPerSolved)} />
        <Stat label="tokens / solved" a={s.baseline.tokensPerSolved === null ? '—' : fmt.k(s.baseline.tokensPerSolved)} b={s.candidate.tokensPerSolved === null ? '—' : fmt.k(s.candidate.tokensPerSolved)} />
        <Stat label="cache-hit share" a={`${(s.baseline.cacheHitShare * 100).toFixed(0)}%`} b={`${(s.candidate.cacheHitShare * 100).toFixed(0)}%`} />
        <Stat label="Δ cost (paired)" a={`${fmt.pct(c.costPctCI.mean)}`} b={`CI ${fmt.pct(c.costPctCI.lo)} … ${fmt.pct(c.costPctCI.hi)}`} />
        <Stat label="discordant pairs" a={`${c.wins} won`} b={`${c.losses} lost · p=${c.signTestP.toFixed(2)}`} />
      </div>
    </div>
  )
}

function Stat({ label, a, b }: { label: string; a: string; b: string }) {
  return <div class="stat"><div class="stat-label">{label}</div><div class="stat-vals"><span>{a}</span><span class="arrow">→</span><span>{b}</span></div></div>
}

function Pips({ id, scenario, arm, stats }: { id: string; scenario: string; arm: string; stats: PairedScenario['baseline'] }) {
  const reps = Object.keys(stats.byRep).map(Number).sort((a, b) => a - b)
  return (
    <span class="pips">
      {reps.map((rep) => { const r = stats.byRep[rep]!; return <a class={`pip ${r.error ? 'err' : r.ok ? 'pass' : 'fail'}`} title={`rep ${rep}: ${r.ok ? 'pass' : 'fail'} · ${fmt.usd(r.usd)} · ${r.steps} steps`} href={`#/run/${id}/trace/${scenario}/${arm}/${rep}`} /> })}
      <span class="muted small"> {stats.passes}/{stats.n}</span>
    </span>
  )
}

function Expanded({ p, id, baseline, candidate }: { p: PairedScenario; id: string; baseline: string; candidate: string }) {
  const reps = Object.keys(p.baseline.byRep).map(Number).sort((a, b) => a - b)
  return (
    <table class="data inner">
      <thead><tr><th>rep</th><th>{baseline}</th><th class="num">$</th><th class="num">steps</th><th>{candidate}</th><th class="num">$</th><th class="num">steps</th><th class="num">Δ $</th><th></th></tr></thead>
      <tbody>
        {reps.map((rep) => {
          const a = p.baseline.byRep[rep]
          const b = p.candidate.byRep[rep]
          return (
            <tr>
              <td>{rep}</td>
              <td>{a ? <span class={`cls ${a.error ? 'incomplete' : a.ok ? 'same' : 'regression'}`}>{a.error ? 'error' : a.ok ? 'pass' : 'fail'}</span> : '—'}</td>
              <td class="num">{a ? fmt.usd(a.usd) : '—'}</td><td class="num">{a?.steps ?? '—'}</td>
              <td>{b ? <span class={`cls ${b.error ? 'incomplete' : b.ok ? 'same' : 'regression'}`}>{b.error ? 'error' : b.ok ? 'pass' : 'fail'}</span> : '—'}</td>
              <td class="num">{b ? fmt.usd(b.usd) : '—'}</td><td class="num">{b?.steps ?? '—'}</td>
              <td class="num">{a && b ? fmt.usd(b.usd - a.usd) : '—'}</td>
              <td><a href={`#/run/${id}/trace/${p.scenario}/${baseline}/${rep}`}>trace A</a> · <a href={`#/run/${id}/trace/${p.scenario}/${candidate}/${rep}`}>trace B</a></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function useMemoOnce<T>(f: () => T): T { return useMemo(f, []) }
