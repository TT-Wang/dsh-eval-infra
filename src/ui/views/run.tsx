import { useEffect, useState } from 'preact/hooks'
import { api, fmt, stream, STATIC, type LedgerLite, type RunDetail } from '../api.js'
import type { TraceRow } from '../../core/ledger.js'
import type { CandidateReport, PairedScenario, PairClass, Grade } from '../../core/report.js'
import type { Progress } from '../../core/store.js'

type Filter = 'all' | 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete' | 'flaky'
const ORDER: Record<PairClass, number> = { regression: 0, improvement: 1, 'both-fail': 2, incomplete: 3, same: 4, unrun: 5 }
const LABEL: Record<PairClass, string> = { regression: 'regression', improvement: 'improvement', same: 'same', 'both-fail': 'both fail', incomplete: 'incomplete', unrun: 'not run' }
const GRADE_TONE: Record<Grade, string> = { improvement: 'good', regression: 'bad', tradeoff: 'warn', tie: 'neutral', inconclusive: 'neutral' }

export function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [ledgers, setLedgers] = useState<LedgerLite[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [sortKey, setSortKey] = useState<'class' | 'cost' | 'name'>('class')

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
  const sortRows = (rows: PairedScenario[]): PairedScenario[] => [...rows].sort((a, b) => {
    if (sortKey === 'cost') return Math.abs(b.costDiffPct ?? 0) - Math.abs(a.costDiffPct ?? 0)
    if (sortKey === 'name') return a.scenario.localeCompare(b.scenario)
    return ORDER[a.class] - ORDER[b.class] || Number(b.flaky) - Number(a.flaky) || a.scenario.localeCompare(b.scenario)
  })

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
            <div class="muted small">started {fmt.time(progress.startedAt)}{progress.error ? <span class="error"> · {progress.error}</span> : null}{progress.stoppedEarly ? <span class="good"> · stopped early after {progress.stoppedEarly.after}/{progress.stoppedEarly.of} scenarios: {progress.stoppedEarly.reason}</span> : null}</div>
          </div>
          <div class="bar"><i style={{ width: `${pctDone}%` }} /></div>
          {progress.active.length > 0 && <div class="active">{progress.active.map(a => <span class="chip live">{a.scenario} / {a.arm} #{a.rep} · turn {a.turn}/{a.turns}</span>)}</div>}
        </div>
      )}

      {report && report.candidates.map(c => <Verdict key={c.arm} c={c} baseline={report.baseline} />)}

      <div class="card">
        <h2>Trials <span class="muted small">● pass ● fail ● error ○ queued · click a pip for its trace</span></h2>
        <div class="scroll-x">
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
      </div>

      {report && report.candidates.map(c => (
        <div class="card" key={c.arm}>
          <div class="row between">
            <h2>{c.arm} vs {report.baseline}</h2>
            <div class="row">
              <div class="chips">
                {(['all', 'regression', 'improvement', 'flaky', 'same', 'both-fail', 'incomplete'] as Filter[]).map(f => {
                  const n = f === 'all' ? c.scenarios.length : f === 'flaky' ? c.scenarios.filter(p => p.flaky).length : c.scenarios.filter(p => p.class === f).length
                  return <button class={`chip ${filter === f ? 'on' : ''} ${f}`} onClick={() => setFilter(f)}>{f === 'all' ? 'all' : f === 'flaky' ? 'flaky' : LABEL[f]} {n}</button>
                })}
              </div>
              <select value={sortKey} onChange={e => setSortKey((e.target as HTMLSelectElement).value as typeof sortKey)}>
                <option value="class">sort: regressions first</option>
                <option value="cost">sort: |Δ cost|</option>
                <option value="name">sort: name</option>
              </select>
            </div>
          </div>
          <div class="scroll-x">
            <table class="data paired">
              <thead><tr><th>scenario</th><th>class</th><th>{report.baseline}</th><th>{c.arm}</th><th class="num">pairs</th><th class="num">Δ cost</th><th class="num">Δ %</th><th class="num">Δ steps</th><th class="num">spread</th><th>why it fails</th></tr></thead>
              <tbody>
                {sortRows(c.scenarios.filter(p => filter === 'all' || (filter === 'flaky' ? p.flaky : p.class === filter))).map(p => (
                  <>
                    <tr key={p.scenario} class={`row-${p.class}`} onClick={() => setExpanded(expanded === `${c.arm}|${p.scenario}` ? null : `${c.arm}|${p.scenario}`)}>
                      <td><code>{p.scenario}</code>{p.flaky ? <span class="tag warn">flaky</span> : null}</td>
                      <td><span class={`cls ${p.class}`}>{LABEL[p.class]}</span></td>
                      <td><Pips id={id} scenario={p.scenario} arm={report.baseline} stats={p.baseline} /></td>
                      <td><Pips id={id} scenario={p.scenario} arm={c.arm} stats={p.candidate} /></td>
                      <td class="num">{p.costPairs}</td>
                      <td class="num">{fmt.usd(p.costDiffUsd)}</td>
                      <td class={`num ${p.costDiffPct !== null && p.costDiffPct < 0 ? 'good' : p.costDiffPct !== null && p.costDiffPct > 0 ? 'bad' : ''}`}>{fmt.pct(p.costDiffPct)}</td>
                      <td class="num">{p.stepsDiff === null ? '—' : (p.stepsDiff >= 0 ? '+' : '') + p.stepsDiff.toFixed(1)}</td>
                      <td class="num" title="baseline: (max − min) / mean cost across its repeats">{p.baselineSpreadPct === null ? '—' : `${p.baselineSpreadPct.toFixed(0)}%`}</td>
                      <td class="small muted reason">{p.failures.candidate[0] ? `${c.arm}: ${p.failures.candidate[0].reason}` : p.failures.baseline[0] ? `${report.baseline}: ${p.failures.baseline[0].reason}` : ''}</td>
                    </tr>
                    {expanded === `${c.arm}|${p.scenario}` && <tr class="expand"><td colSpan={10}><Expanded p={p} id={id} baseline={report.baseline} candidate={c.arm} /></td></tr>}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {report && report.notes.length > 0 && <div class="card notes"><h2>Notes</h2><ul>{report.notes.map(n => <li>{n}</li>)}</ul></div>}

      <div class="card">
        <h2>Environment</h2>
        <dl class="facts">
          <dt>dsh</dt><dd>{env?.dshVersion ?? '?'}{env?.dshRevision ? <span class="muted small"> @ {env.dshRevision}</span> : null} <span class="muted small">{env?.dshSource ?? ''}</span></dd>
          <dt>dsh-eval</dt><dd>{env?.evalInfraVersion ?? '?'} · node {env?.node ?? '?'} · {env?.platform ?? '?'}</dd>
          <dt>model / effort</dt><dd>{[...new Set(ledgers.map(l => `${l.headerModel ?? l.model} / ${l.resolvedEffort ?? 'default'}`))].join(', ') || '—'}</dd>
          <dt>prices</dt><dd>DeepSeek list as of {env?.priceTableAsOf ?? '?'}; bands seen: {[...new Set(ledgers.flatMap(l => l.steps.map(s => s.band)))].join(', ') || '—'}</dd>
          <dt>sandbox</dt><dd>dsh workspace-write confinement (bash denied outside the trial workspace; platform temp dirs allowed) · network tools {ledgers.some(l => l.tools.includes('web_fetch')) ? 'on' : 'off'}</dd>
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

/** Forest strip: point estimate with its interval on a shared ±axis; the SESOI band and the A/A floor are drawn behind it. */
function Forest({ c }: { c: CandidateReport }) {
  const lim = Math.max(20, Math.abs(c.costPctCI.lo), Math.abs(c.costPctCI.hi), Math.abs(c.noiseFloor?.lo ?? 0), Math.abs(c.noiseFloor?.hi ?? 0), c.mdePct ?? 0) * 1.15
  const x = (v: number): number => 50 + v / lim * 48
  const rows: Array<{ label: string; lo: number; hi: number; mean: number; tone: string }> = [
    { label: 'Δ cost % (paired)', lo: c.costPctCI.lo, hi: c.costPctCI.hi, mean: c.costPctCI.mean, tone: c.costReading === 'cheaper' ? 'good' : c.costReading === 'more-expensive' ? 'bad' : 'neutral' },
    { label: 'Δ pass (pp)', lo: c.passDiffCI.lo, hi: c.passDiffCI.hi, mean: c.passDiffCI.mean, tone: c.passDiffCI.mean > 0 ? 'good' : c.passDiffCI.mean < 0 ? 'bad' : 'neutral' },
  ]
  if (c.noiseFloor) rows.push({ label: `A/A floor (${c.noiseFloor.runId.slice(0, 15)})`, lo: c.noiseFloor.lo, hi: c.noiseFloor.hi, mean: 0, tone: 'floor' })
  const h = 22
  return (
    <svg class="forest" viewBox={`0 0 100 ${rows.length * h + 14}`} preserveAspectRatio="none" role="img" aria-label="paired estimates with 95% intervals">
      <rect x={x(-10)} y={0} width={x(10) - x(-10)} height={rows.length * h} class="sesoi" />
      {c.mdePct !== null && <><line x1={x(-c.mdePct)} x2={x(-c.mdePct)} y1={0} y2={rows.length * h} class="mde" /><line x1={x(c.mdePct)} x2={x(c.mdePct)} y1={0} y2={rows.length * h} class="mde" /></>}
      <line x1={x(0)} x2={x(0)} y1={0} y2={rows.length * h} class="zero" />
      {rows.map((r, i) => (
        <g transform={`translate(0 ${i * h + h / 2})`} class={`row ${r.tone}`}>
          <line x1={x(Math.max(-lim, r.lo))} x2={x(Math.min(lim, r.hi))} y1={0} y2={0} class="ci" />
          <circle cx={x(Math.max(-lim, Math.min(lim, r.mean)))} cy={0} r={2.2} class="pt" />
          <text x={1} y={-4} class="lbl">{r.label}</text>
          <text x={99} y={-4} class="lbl right">{fmt.pct(r.mean)} [{fmt.pct(r.lo)}, {fmt.pct(r.hi)}]</text>
        </g>
      ))}
      <text x={x(-lim)} y={rows.length * h + 10} class="axis">−{lim.toFixed(0)}%</text>
      <text x={x(0)} y={rows.length * h + 10} class="axis mid">0</text>
      <text x={x(lim)} y={rows.length * h + 10} class="axis right">+{lim.toFixed(0)}%</text>
    </svg>
  )
}

function Verdict({ c, baseline }: { c: CandidateReport; baseline: string }) {
  const s = c.summary
  return (
    <div class={`verdict ${GRADE_TONE[c.grade]}`}>
      <div class="verdict-head"><span class={`grade ${c.grade}`}>{c.grade}</span> <b>{c.arm}</b> vs {baseline}</div>
      <p class="verdict-text">{c.verdict}</p>
      <div class="verdict-grid">
        <div class="cards">
          <Stat label="pass" a={`${s.baseline.passes}/${s.baseline.runs}`} b={`${s.candidate.passes}/${s.candidate.runs}`} />
          <Stat label="pass^k" a={`${(s.baseline.passAllK * 100).toFixed(0)}%`} b={`${(s.candidate.passAllK * 100).toFixed(0)}%`} />
          <Stat label="$ / solved" a={fmt.usd(s.baseline.usdPerSolved)} b={fmt.usd(s.candidate.usdPerSolved)} />
          <Stat label="tokens / solved" a={s.baseline.tokensPerSolved === null ? '—' : fmt.k(s.baseline.tokensPerSolved)} b={s.candidate.tokensPerSolved === null ? '—' : fmt.k(s.candidate.tokensPerSolved)} />
          <Stat label="cache-hit share" a={`${(s.baseline.cacheHitShare * 100).toFixed(0)}%`} b={`${(s.candidate.cacheHitShare * 100).toFixed(0)}%`} />
          <Stat label="discordant pairs" a={`${c.wins} won`} b={`${c.losses} lost · p=${c.signTestP.toFixed(2)}`} />
          <Stat label="detectable effect" a={c.mdePct === null ? '—' : `±${c.mdePct.toFixed(0)}%`} b={c.noiseFloor ? `A/A floor ${c.noiseFloor.meanAbsPct.toFixed(0)}%` : 'no A/A run yet'} />
          <Stat label="flaky scenarios" a={String(c.flaky.length)} b={c.flaky.slice(0, 2).join(', ') || '—'} />
        </div>
        <div class="forest-wrap"><Forest c={c} /><div class="muted small">grey band ±10% (smallest effect of interest) · dashed lines: minimum detectable effect for this design</div></div>
      </div>
    </div>
  )
}

function Stat({ label, a, b }: { label: string; a: string; b: string }) {
  return <div class="stat"><div class="stat-label">{label}</div><div class="stat-vals"><span>{a}</span><span class="arrow">→</span><span>{b}</span></div></div>
}

function Pips({ id, scenario, arm, stats }: { id: string; scenario: string; arm: string; stats: PairedScenario['baseline'] }) {
  const reps = Object.keys(stats.byRep).map(Number).sort((a, b) => a - b)
  const overridden = Object.values(stats.byRep).filter(r => r.overridden).length
  return (
    <span class="pips">
      {reps.map((rep) => { const r = stats.byRep[rep]!; return <a class={`pip ${r.error ? 'err' : r.ok ? 'pass' : 'fail'}`} title={`rep ${rep}: ${r.ok ? 'pass' : 'fail'} · ${fmt.usd(r.usd)} · ${r.steps} steps`} href={`#/run/${id}/trace/${scenario}/${arm}/${rep}`} /> })}
      {overridden > 0 && <span class="tag warn" title="verdict overridden by a human annotation">✎{overridden}</span>}
      <span class="muted small"> {stats.passes}/{stats.n}</span>
    </span>
  )
}

/** Minimal line diff (LCS) for two final outputs. */
function lineDiff(a: string, b: string): Array<{ kind: ' ' | '-' | '+'; text: string }> {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  if (n * m > 250_000) return [...x.map(t => ({ kind: '-' as const, text: t })), ...y.map(t => ({ kind: '+' as const, text: t }))]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: Array<{ kind: ' ' | '-' | '+'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: ' ', text: x[i]! }); i += 1; j += 1 }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ kind: '-', text: x[i]! }); i += 1 }
    else { out.push({ kind: '+', text: y[j]! }); j += 1 }
  }
  while (i < n) { out.push({ kind: '-', text: x[i]! }); i += 1 }
  while (j < m) { out.push({ kind: '+', text: y[j]! }); j += 1 }
  return out
}

function OutputDiff({ id, scenario, baseline, candidate, rep }: { id: string; scenario: string; baseline: string; candidate: string; rep: number }) {
  const [rows, setRows] = useState<Array<{ kind: ' ' | '-' | '+'; text: string }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setRows(null)
    const last = (t: TraceRow[]): string => t.filter(r => r.text.trim() !== '').at(-1)?.text ?? '(no final text)'
    Promise.all([api.trace(id, scenario, baseline, rep), api.trace(id, scenario, candidate, rep)]).then(([a, b]) => setRows(lineDiff(last(a), last(b)))).catch(e => setError(String(e)))
  }, [id, scenario, baseline, candidate, rep])
  if (error) return <p class="error small">{error}</p>
  if (!rows) return <p class="muted small">loading final outputs…</p>
  const changed = rows.filter(r => r.kind !== ' ').length
  return (
    <div class="odiff">
      <div class="muted small">final assistant message, rep {rep}: <b>−</b> {baseline} · <b>+</b> {candidate} · {changed === 0 ? 'identical' : `${changed} changed lines`}</div>
      <pre>{rows.map(r => <span class={`d${r.kind === ' ' ? 'same' : r.kind === '-' ? 'del' : 'add'}`}>{r.kind} {r.text}{'\n'}</span>)}</pre>
    </div>
  )
}

function Expanded({ p, id, baseline, candidate }: { p: PairedScenario; id: string; baseline: string; candidate: string }) {
  const reps = Object.keys(p.baseline.byRep).map(Number).sort((a, b) => a - b)
  const [diffRep, setDiffRep] = useState<number | null>(null)
  const b = p.behaviour
  const beh = (k: keyof typeof b.baseline): string => `${b.baseline[k].toFixed(1)} → ${b.candidate[k].toFixed(1)}`
  return (
    <div class="expanded">
      <table class="data inner">
        <thead><tr><th>rep</th><th>{baseline}</th><th class="num">$</th><th class="num">steps</th><th>{candidate}</th><th class="num">$</th><th class="num">steps</th><th class="num">Δ $</th><th></th></tr></thead>
        <tbody>
          {reps.map((rep) => {
            const a = p.baseline.byRep[rep]
            const c = p.candidate.byRep[rep]
            return (
              <tr>
                <td>{rep}</td>
                <td>{a ? <span class={`cls ${a.error ? 'incomplete' : a.ok ? 'same' : 'regression'}`}>{a.error ? 'error' : a.ok ? 'pass' : 'fail'}</span> : '—'}</td>
                <td class="num">{a ? fmt.usd(a.usd) : '—'}</td><td class="num">{a?.steps ?? '—'}</td>
                <td>{c ? <span class={`cls ${c.error ? 'incomplete' : c.ok ? 'same' : 'regression'}`}>{c.error ? 'error' : c.ok ? 'pass' : 'fail'}</span> : '—'}</td>
                <td class="num">{c ? fmt.usd(c.usd) : '—'}</td><td class="num">{c?.steps ?? '—'}</td>
                <td class="num">{a && c ? fmt.usd(c.usd - a.usd) : '—'}</td>
                <td><a href={`#/run/${id}/trace/${p.scenario}/${baseline}/${rep}`}>trace A</a> · <a href={`#/run/${id}/trace/${p.scenario}/${candidate}/${rep}`}>trace B</a> · <a href={`#/run/${id}/trace/${p.scenario}/${candidate}/${rep}?compare=1`}>side by side</a> · <a href="javascript:void 0" onClick={(e) => { e.preventDefault(); setDiffRep(diffRep === rep ? null : rep) }}>{diffRep === rep ? 'hide diff' : 'output diff'}</a></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {diffRep !== null && <OutputDiff id={id} scenario={p.scenario} baseline={baseline} candidate={candidate} rep={diffRep} />}
      <div class="row wrap small">
        <span class="muted">behaviour {baseline} → {candidate}:</span>
        <span>tool errors {beh('toolErrors')}</span><span>repeated calls {beh('repeatedCalls')}</span><span>no-action steps {beh('noActionSteps')}</span><span>observation chars {fmt.k(b.baseline.observationChars)} → {fmt.k(b.candidate.observationChars)}</span><span>compactions {beh('compactions')}</span>
      </div>
      {(p.failures.baseline.length > 0 || p.failures.candidate.length > 0) && (
        <div class="failures small">
          {p.failures.baseline.map(f => <div><span class="cls regression">{baseline} ×{f.n}</span> {f.reason}</div>)}
          {p.failures.candidate.map(f => <div><span class="cls regression">{candidate} ×{f.n}</span> {f.reason}</div>)}
        </div>
      )}
    </div>
  )
}
