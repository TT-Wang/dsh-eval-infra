import { useEffect, useState } from 'preact/hooks'
import { api, fmt, stream, STATIC, type LedgerLite, type RunDetail } from '../api.js'
import type { TraceRow } from '../../core/ledger.js'
import { VirtualRows } from '../virtual.js'
import { useDetail } from '../detail.js'
import { LiveRun, type StreamEvent } from './live.js'
import type { CandidateReport, PairedScenario, PairClass, Grade } from '../../core/report.js'
import type { Progress } from '../../core/store.js'

type Filter = 'all' | 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete' | 'flaky'
const ORDER: Record<PairClass, number> = { regression: 0, improvement: 1, 'both-fail': 2, incomplete: 3, same: 4, unrun: 5 }
const LABEL: Record<PairClass, string> = { regression: 'regression', improvement: 'improvement', same: 'same', 'both-fail': 'both fail', incomplete: 'incomplete', unrun: 'not run' }
const GRADE_TONE: Record<Grade, string> = { improvement: 'good', regression: 'bad', tradeoff: 'warn', tie: 'neutral', inconclusive: 'neutral' }

export function RunView({ id }: { id: string }) {
  const [detailed] = useDetail()
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [ledgers, setLedgers] = useState<LedgerLite[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [sortKey, setSortKey] = useState<'class' | 'cost' | 'name'>('class')
  const [events, setEvents] = useState<StreamEvent[]>([])

  const load = (): void => {
    api.run(id).then((d) => { setDetail(d); setLogs(d.logs) }).catch(e => setError(String(e)))
    api.ledgers(id).then(setLedgers).catch(() => { /* no ledgers yet */ })
  }
  useEffect(() => {
    load()
    // `stop` is referenced inside the handler so a finished run closes the stream; without it the
    // browser reconnects to a server that immediately replies "done", forever.
    let stop = (): void => { /* replaced below */ }
    stop = stream(id, (event, data) => {
      if (event === 'progress' && data) {
        const p = data as Progress
        setDetail(d => d ? { ...d, progress: p } : d)
        // One line per trial that starts a new turn: the stream a watcher actually reads.
        setEvents((prev) => {
          const seen = new Set(prev.map(e => e.text))
          const fresh = p.active
            .map(a => ({ at: Date.now(), kind: 'turn' as const, text: `${a.scenario} · ${a.arm} #${a.rep} · turn ${a.turn}/${a.turns}` }))
            .filter(e => !seen.has(e.text))
          return fresh.length === 0 ? prev : [...fresh.reverse(), ...prev].slice(0, 200)
        })
      }
      else if (event === 'log') setLogs(l => [...l.slice(-400), String(data)])
      else if (event === 'ledger') {
        const l = data as { scenario?: string; arm?: string; rep?: number; ok?: boolean; usd?: number } | null
        if (l?.scenario !== undefined) {
          const finished: StreamEvent = { at: Date.now(), kind: 'done', tone: l.ok === false ? 'bad' : 'good', text: `${l.ok === false ? '✗' : '✓'} ${l.scenario} · ${l.arm} #${l.rep} · ${fmt.usd(l.usd ?? 0)}` }
          setEvents(prev => [finished, ...prev].slice(0, 200))
        }
        api.ledgers(id).then(setLedgers).catch(() => { /* ignore */ })
      }
      else if (event === 'done' || event === 'error') { stop(); setTimeout(load, 300) }
    })
    return () => stop()
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

      {running && progress && (
        <LiveRun plan={plan} progress={progress} ledgers={ledgers} events={events} onCancel={() => { void api.cancel(id) }} />
      )}

      {!running && progress && (
        <div class="card progress-card">
          <div class="row between">
            <div><span class={`status ${progress.status}`}>{progress.status}</span> <b>{progress.completed}</b>/{progress.total} trials{progress.failed ? <span class="warn-text"> · {progress.failed} errors</span> : null} · spent <b>{fmt.usd(progress.usd, 3)}</b></div>
            <div class="muted small">started {fmt.time(progress.startedAt)}{progress.error ? <span class="error"> · {progress.error}</span> : null}{progress.stoppedEarly ? <span class="good"> · stopped early after {progress.stoppedEarly.after}/{progress.stoppedEarly.of} scenarios: {progress.stoppedEarly.reason}</span> : null}</div>
          </div>
          <div class="bar"><i style={{ width: `${pctDone}%` }} /></div>
          {progress.active.length > 0 && <div class="active">{progress.active.map(a => <span class="chip live">{a.scenario} / {a.arm} #{a.rep} · turn {a.turn}/{a.turns}</span>)}</div>}
        </div>
      )}

      {report && report.candidates.map(c => <Verdict key={c.arm} c={c} baseline={report.baseline} runId={id} detailed={detailed} />)}
      {detailed && detail.sequential && detail.sequential.decisions.length > 0 && (
        <div class="card">
          <h2>Sequential decisions <span class="muted small">seed {detail.sequential.seed} · anytime-valid sequences after each scenario</span></h2>
          <table class="data"><thead><tr><th class="num">scenarios</th><th>cost Δ% sequence</th><th>pass sequence (0.5 = even)</th><th>decision</th></tr></thead>
            <tbody>{detail.sequential.decisions.map(d => <tr><td class="num">{d.scenarios}</td><td>{d.cost ? `${fmt.pct(d.cost.mean)} [${fmt.pct(d.cost.lo)}, ${fmt.pct(d.cost.hi)}]` : '—'}</td><td>{d.pass ? `[${d.pass.lo.toFixed(2)}, ${d.pass.hi.toFixed(2)}]` : '—'}</td><td>{d.decided ? <b>{d.reason}</b> : 'continue'}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      <div class="card">
        <h2>Trials <span class="muted small">● pass ● fail ● error ○ queued · click a pip for its trace</span></h2>
        <div class="scroll-x">
          <table class="data matrix">
            <thead><tr><th>scenario</th>{arms.map(a => <th>{a}</th>)}</tr></thead>
            <tbody>
              <VirtualRows items={plan.scenarios} rowHeight={30} height={560} threshold={150} render={s => (
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
              )} />
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
                <VirtualRows items={sortRows(c.scenarios.filter(p => filter === 'all' || (filter === 'flaky' ? p.flaky : p.class === filter)))} rowHeight={34} height={640} threshold={150} render={p => (
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
                )} />
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {report && report.notes.length > 0 && (
        <div class="card notes">
          <h2>Notes {!detailed && <span class="muted small">warnings only · switch to detailed for all {report.notes.length}</span>}</h2>
          <ul>{(detailed ? report.notes : report.notes.filter(n => /withheld|NOT reconciled|MISMATCH|DIFFERS|WARNING|DRIFT|below the 3-repeat floor|multi-variable|flaky|Declined/i.test(n))).map(n => <li>{n}</li>)}</ul>
        </div>
      )}

      {detailed && <div class="card">
        <h2>Environment</h2>
        <dl class="facts">
          <dt>dsh</dt><dd>{env?.dshVersion ?? '?'}{env?.dshRevision ? <span class="muted small"> @ {env.dshRevision}</span> : null} <span class="muted small">{env?.dshSource ?? ''}</span></dd>
          <dt>dsh-eval</dt><dd>{env?.evalInfraVersion ?? '?'} · node {env?.node ?? '?'} · {env?.platform ?? '?'}</dd>
          <dt>model / effort</dt><dd>{[...new Set(ledgers.map(l => `${l.headerModel ?? l.model} / ${l.resolvedEffort ?? 'default'}`))].join(', ') || '—'}</dd>
          <dt>prices</dt><dd>DeepSeek list as of {env?.priceTableAsOf ?? '?'}; bands seen: {[...new Set(ledgers.flatMap(l => l.steps.map(s => s.band)))].join(', ') || '—'}</dd>
          <dt>usage provenance</dt><dd>{(() => { const m = ledgers.filter(l => l.usageProvenance?.source === 'meter'); if (m.length === 0) return 'self-reported by the runtime (no wire meter)'; const bad = m.filter(l => l.usageProvenance!.reconciled === false).length; const dev = Math.max(0, ...m.map(l => l.usageProvenance!.deviationPct ?? 0)); const faults = m.reduce((a, l) => a + (l.usageProvenance!.meter?.faults ?? 0), 0); return `${m.length - bad}/${m.length} trials reconciled against the independent wire meter (max deviation ${dev.toFixed(2)}%${faults ? `, ${faults} injected faults` : ''})${bad ? ` · ${bad} NOT reconciled` : ''}` })()}</dd>
          <dt>evidence</dt><dd>{detail.integrity ? (detail.integrity.sealedAt ? <span>sealed {new Date(detail.integrity.sealedAt).toLocaleString()} · <code title="sha256 over every evidence file">{detail.integrity.evidenceSha?.slice(0, 16)}…</code> · {detail.integrity.status === 'PASS' ? <span class="cls same" title={detail.integrity.statusReason}>PASS</span> : detail.integrity.status === 'INCONCLUSIVE' ? <span class="cls incomplete" title={detail.integrity.statusReason}>INCONCLUSIVE</span> : <span class="cls regression" title={detail.integrity.statusReason}>INVALID</span>}{detail.integrity.changed.length ? ` · changed: ${detail.integrity.changed.slice(0, 3).join(', ')}` : ''}{detail.integrity.missing.length ? ` · missing: ${detail.integrity.missing.length}` : ''}{detail.integrity.reportReproduces === false ? ' · report does not re-derive from the ledgers' : ''}</span> : 'not sealed') : 'not sealed'}</dd>
          <dt>sandbox</dt><dd>{plan.sandbox === 'docker' ? `Docker container per trial (workspace + eval home mounted rw, dsh checkout and plugins ro${(detail.env as { dockerRuntime?: string } | null)?.dockerRuntime ? `; runtime ${(detail.env as { dockerRuntime?: string }).dockerRuntime}` : ''}; ${(detail.env as { dshSandboxInContainer?: boolean } | null)?.dshSandboxInContainer ? "dsh's own sandbox kept on inside the container" : 'the container is the boundary'})` : 'dsh workspace-write confinement on the host (bash denied outside the trial workspace; platform temp dirs allowed)'} · network tools {ledgers.some(l => l.tools.includes('web_fetch')) ? 'on' : 'off'}</dd>
          {plan.replay && <><dt>replay</dt><dd>recorded provider responses from run <a href={`#/run/${plan.replay.runId}`}>{plan.replay.runId}</a>{plan.replay.forkAt !== undefined ? ` · forked to live calls after ${plan.replay.forkAt} responses per trial` : ' · no live calls (keyless)'}</dd></>}
          {plan.perturb && <><dt>prompts</dt><dd>perturbation on: repeats above 1 ran seeded paraphrase variants, identical across arms</dd></>}
          <dt>arms</dt><dd>{env?.diffs?.map(d => <div><b>{d.candidate}</b>: {d.variables} variable(s){env.multiVariable ? <span class="warn-text"> · multi-variable comparison</span> : null}</div>)}{Object.entries(env?.composedTreeSha ?? {}).map(([a, sha]) => <div class="muted small">{a}: tree {sha.slice(0, 12)}</div>)}</dd>
        </dl>
      </div>}

      {(detailed || running) && <div class="card">
        <h2 class="row between"><span>Log</span><button class="btn small" onClick={() => setShowLogs(!showLogs)}>{showLogs ? 'hide' : 'show'} ({logs.length})</button></h2>
        {showLogs && <pre class="log">{logs.join('\n')}</pre>}
      </div>}
    </section>
  )
}

/** Forest strip: point estimate with its interval on a shared ±axis; the SESOI band and the A/A floor are drawn behind it. */
function Forest({ c }: { c: CandidateReport }) {
  // A pixel-like coordinate space scaled uniformly: a percentage-width viewBox with
  // preserveAspectRatio="none" stretches the glyphs, which is what made this strip unreadable.
  const W = 1000
  const ROW = 46
  const PAD_BOTTOM = 26
  const lim = Math.max(20, Math.abs(c.costPctCI.lo), Math.abs(c.costPctCI.hi), Math.abs(c.noiseFloor?.lo ?? 0), Math.abs(c.noiseFloor?.hi ?? 0), c.mdePct ?? 0) * 1.15
  const x = (v: number): number => W / 2 + (v / lim) * (W / 2 - 24)
  const rows: Array<{ label: string; lo: number; hi: number; mean: number; tone: string }> = [
    { label: 'Δ cost % (paired)', lo: c.costPctCI.lo, hi: c.costPctCI.hi, mean: c.costPctCI.mean, tone: c.costReading === 'cheaper' ? 'good' : c.costReading === 'more-expensive' ? 'bad' : 'neutral' },
    { label: 'Δ pass (pp)', lo: c.passDiffCI.lo, hi: c.passDiffCI.hi, mean: c.passDiffCI.mean, tone: c.passDiffCI.mean > 0 ? 'good' : c.passDiffCI.mean < 0 ? 'bad' : 'neutral' },
  ]
  if (c.noiseFloor) rows.push({ label: `A/A floor · ${c.noiseFloor.runId.slice(0, 15)}`, lo: c.noiseFloor.lo, hi: c.noiseFloor.hi, mean: 0, tone: 'floor' })
  const H = rows.length * ROW + PAD_BOTTOM
  return (
    <svg class="forest" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="paired estimates with 95% intervals">
      <rect x={x(-10)} y={0} width={x(10) - x(-10)} height={rows.length * ROW} class="sesoi" />
      {c.mdePct !== null && (
        <>
          <line x1={x(-c.mdePct)} x2={x(-c.mdePct)} y1={0} y2={rows.length * ROW} class="mde" />
          <line x1={x(c.mdePct)} x2={x(c.mdePct)} y1={0} y2={rows.length * ROW} class="mde" />
        </>
      )}
      <line x1={x(0)} x2={x(0)} y1={0} y2={rows.length * ROW} class="zero" />
      {rows.map((r, i) => (
        <g key={r.label} transform={`translate(0 ${i * ROW + ROW * 0.68})`} class={`row ${r.tone}`}>
          <line x1={x(Math.max(-lim, r.lo))} x2={x(Math.min(lim, r.hi))} y1={0} y2={0} class="ci" />
          <line x1={x(Math.max(-lim, r.lo))} x2={x(Math.max(-lim, r.lo))} y1={-5} y2={5} class="ci cap" />
          <line x1={x(Math.min(lim, r.hi))} x2={x(Math.min(lim, r.hi))} y1={-5} y2={5} class="ci cap" />
          <circle cx={x(Math.max(-lim, Math.min(lim, r.mean)))} cy={0} r={5} class="pt" />
          <text x={4} y={-13} class="lbl">{r.label}</text>
          <text x={W - 4} y={-13} class="lbl right">{fmt.pct(r.mean)} [{fmt.pct(r.lo)}, {fmt.pct(r.hi)}]</text>
        </g>
      ))}
      <text x={x(-lim) + 2} y={H - 8} class="axis">−{lim.toFixed(0)}%</text>
      <text x={x(0)} y={H - 8} class="axis mid">0</text>
      <text x={x(lim) - 2} y={H - 8} class="axis right">+{lim.toFixed(0)}%</text>
    </svg>
  )
}

/** One line a reader can act on, without statistics vocabulary. */
function plainVerdict(c: CandidateReport): string {
  const pct = (x: number): string => `${Math.abs(x).toFixed(0)}%`
  const regressions = c.scenarios.filter(p => p.class === 'regression')
  if (c.gate === 'regressions') return `${c.arm} breaks ${regressions.length} scenario${regressions.length === 1 ? '' : 's'} the baseline passes. Cost is not compared until that is fixed.`
  if (c.gate === 'incomplete') return `Some trials did not finish, so there is nothing to compare yet.`
  if (c.costReading === 'cheaper') return `${c.arm} is cheaper by about ${pct(c.costPctCI.mean)} and breaks nothing.`
  if (c.costReading === 'more-expensive') return `${c.arm} costs about ${pct(c.costPctCI.mean)} more and breaks nothing.`
  if (c.costReading === 'equivalent') return `No real difference: cost is within ±10% and nothing broke.`
  if (c.costReading === 'none') return `No scenario where both arms passed, so there is nothing to price.`
  return `Not enough evidence yet. The measured difference is ${c.costPctCI.mean < 0 ? '−' : '+'}${pct(c.costPctCI.mean)}, but it could as easily be noise.`
}

/** The single most useful thing to do next, with the command that does it. */
function nextStep(c: CandidateReport, runId: string, baseline: string): { text: string; cmd?: string } {
  const comparable = c.scenarios.filter(p => p.costDiffPct !== null).length
  const regression = c.scenarios.find(p => p.class === 'regression')
  if (regression) return { text: `Look at where the two arms diverge on ${regression.scenario}, then confirm the failure is real and not luck.`, cmd: `dsh-eval rerun ${runId} ${regression.scenario} --fork` }
  if (c.costReading === 'cheaper' || c.costReading === 'more-expensive' || c.costReading === 'equivalent') return { text: 'This result is usable. Bundle it if someone else needs to check it.', cmd: `dsh-eval publish ${runId}` }
  if (comparable > 0 && comparable < 5) return { text: `Only ${comparable} scenario${comparable === 1 ? '' : 's'} could be compared; five is the minimum before any direction is stated. Run more of the library.`, cmd: `dsh-eval run --baseline ${baseline} --arm ${c.arm} 'f*' 'p*' 'x*' --repeats 3` }
  if (c.noiseFloor === null) return { text: 'Measure what "no change" looks like on your setup first; every direction is judged against that floor.', cmd: `dsh-eval run --baseline ${baseline} --aa 'f*' --repeats 3` }
  return { text: `This design can only detect a difference of about ±${c.mdePct === null ? '?' : c.mdePct.toFixed(0)}%. Add repeats or scenarios to see smaller ones.`, cmd: `dsh-eval run --baseline ${baseline} --arm ${c.arm} 'f*' 'p*' --repeats 5` }
}

function Verdict({ c, baseline, runId, detailed }: { c: CandidateReport; baseline: string; runId: string; detailed: boolean }) {
  const s = c.summary
  const step = nextStep(c, runId, baseline)
  return (
    <div class={`verdict ${GRADE_TONE[c.grade]}`}>
      <div class="verdict-head"><span class={`grade ${c.grade}`}>{c.grade}</span> <b>{c.arm}</b> vs {baseline}</div>
      <p class="verdict-text">{detailed ? c.verdict : plainVerdict(c)}</p>
      {!detailed && (
        <>
          <div class="cards simple">
            <Stat label="scenarios passed" a={`${s.baseline.passes}/${s.baseline.runs}`} b={`${s.candidate.passes}/${s.candidate.runs}`} />
            <Stat label="cost per solved task" a={fmt.usd(s.baseline.usdPerSolved)} b={fmt.usd(s.candidate.usdPerSolved)} />
            <Stat label="cost difference" a={fmt.pct(c.costPctCI.mean)} b={c.costReading === 'inconclusive' || c.costReading === 'none' ? 'not conclusive' : c.costReading} />
          </div>
          <p class="next-step"><b>Next:</b> {step.text}{step.cmd ? <><br /><code>{step.cmd}</code></> : null}</p>
        </>
      )}
      {detailed && (
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
          <Stat label="paired pass/fail" a={`${c.paired.b} won · ${c.paired.c} lost`} b={`mid-p ${c.paired.midP.toFixed(2)} · P(win) ${(c.paired.pWin * 100).toFixed(0)}%`} />
          <Stat label="design" a={`ICC ${c.icc.rho.toFixed(2)} · DE ${c.icc.designEffect.toFixed(2)}`} b={c.resolution.q === null ? 'q —' : `q = ${c.resolution.q.toFixed(2)} (N* ${c.resolution.nStar})`} />
          {c.cuped && <Stat label="CUPED-adjusted Δ cost" a={`${fmt.pct(c.cuped.ci.mean)} [${fmt.pct(c.cuped.ci.lo)}, ${fmt.pct(c.cuped.ci.hi)}]`} b={`${(c.cuped.varianceRemoved * 100).toFixed(0)}% variance removed`} />}
          {c.judge && <Stat label={`judge${(c.judge.models?.length ?? 1) > 1 ? ' panel' : ''} (${c.judge.model})`} a={`${c.judge.wins} / ${c.judge.losses} / ${c.judge.ties}`} b={`mid-p ${c.judge.midP.toFixed(2)} · orders disagree ${(c.judge.inconsistentShare * 100).toFixed(0)}%${(c.judge.models?.length ?? 1) > 1 ? ` · unanimous ${((c.judge.panelAgreement ?? 1) * 100).toFixed(0)}%` : ''}${c.judge.interJudgeKappa !== null && c.judge.interJudgeKappa !== undefined ? ` · inter-judge κ ${c.judge.interJudgeKappa.toFixed(2)}` : ''}${c.judge.longerWinsShare !== null && c.judge.longerWinsShare !== undefined ? ` · longer wins ${(c.judge.longerWinsShare * 100).toFixed(0)}%` : ''}${c.judge.humanAgreement ? ` · κ vs humans ${c.judge.humanAgreement.kappa === null ? '—' : c.judge.humanAgreement.kappa.toFixed(2)}` : ''}${c.judge.sameFamilyAsArms ? ' · SAME FAMILY AS ARMS' : ''}`} />}
          {c.judge?.abstention && <Stat label={`judge abstention (α ${c.judge.abstention.alpha})`} a={Number.isFinite(c.judge.abstention.tau) ? `threshold ${c.judge.abstention.tau.toFixed(2)}` : 'no threshold meets the bound'} b={`${c.judge.abstention.abstained} / ${c.judge.abstention.of} withheld · ${c.judge.abstention.calibratedOn} labels`} />}
          {c.judge?.anchors && <Stat label="judge anchors (drift)" a={`${(c.judge.anchors.humanAgreement * 100).toFixed(0)}% agree with humans (${c.judge.anchors.n})`} b={c.judge.anchors.stability === null ? 'first pass on these anchors' : `${(c.judge.anchors.stability * 100).toFixed(0)}% stable vs previous${c.judge.anchors.attribution === 'judge' ? ' · JUDGE DRIFT' : ''}`} />}
          {c.judge && c.judge.lengthBalancedWinRate !== null && c.judge.lengthBalancedWinRate !== undefined && <Stat label="length-controlled win rate" a={`${(c.judge.lengthBalancedWinRate * 100).toFixed(0)}% balanced${c.judge.equalLengthWinRate ? ` · ${(c.judge.equalLengthWinRate.rate * 100).toFixed(0)}% at equal length` : ''}`} b={`longer wins ${c.judge.longerWinsShare === null || c.judge.longerWinsShare === undefined ? '—' : (c.judge.longerWinsShare * 100).toFixed(0) + '%'}`} />}
          {c.judge?.effectiveJudges && <Stat label="effective judges" a={`${c.judge.effectiveJudges.nEff.toFixed(1)} of ${c.judge.effectiveJudges.k}`} b={`mean pairwise ${c.judge.effectiveJudges.basis} correlation ${c.judge.effectiveJudges.rhoBar.toFixed(2)}`} />}
          {c.rerun && <Stat label={`${c.rerun.fork ? `fork from step ${c.rerun.fork.step}` : 'rerun validation'} · ${c.rerun.scenario}`} a={c.rerun.verdict} b={c.rerun.original ? `${c.rerun.original.failing} failed again ${c.rerun.failedAgain}/${c.rerun.reps} · same call ${c.rerun.sameCall}/${c.rerun.reps}` : `${c.rerun.failedAgain}/${c.rerun.reps} with one failing arm`} />}
          {c.absolute && <Stat label={`absolute grades${c.absolute.baseline.n + c.absolute.candidate.n > 0 ? ' · PPI++' : ' · uncalibrated'}`} a={`${(c.absolute.baseline.estimate * 100).toFixed(0)}% → ${(c.absolute.candidate.estimate * 100).toFixed(0)}%`} b={`Δ ${(c.absolute.diff * 100).toFixed(0)} pp ± ${(c.absolute.diffSe * 100).toFixed(0)} · ${c.absolute.baseline.n + c.absolute.candidate.n} human labels${c.absolute.calibration && c.absolute.calibration.labelled > 0 ? ` · TPR ${c.absolute.calibration.tpr === null ? '—' : (c.absolute.calibration.tpr * 100).toFixed(0) + '%'} / TNR ${c.absolute.calibration.tnr === null ? '—' : (c.absolute.calibration.tnr * 100).toFixed(0) + '%'}` : ''}`} />}
        </div>
        <div class="forest-wrap"><Forest c={c} /><div class="muted small">grey band ±10% (smallest effect of interest) · dashed lines: minimum detectable effect for this design</div></div>
      </div>
      )}
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
