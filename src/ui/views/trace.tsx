import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt } from '../api.js'
import type { RunLedger } from '../../core/types.js'
import type { TraceRow } from '../../core/ledger.js'

interface Trial { ledger: RunLedger; trace: TraceRow[] }

export function TraceView({ runId, scenario, arm, rep }: { runId: string; scenario: string; arm: string; rep: number }) {
  const [trial, setTrial] = useState<Trial | null>(null)
  const [other, setOther] = useState<Trial | null>(null)
  const [otherArm, setOtherArm] = useState<string | null>(null)
  const [compare, setCompare] = useState(false)
  const [selected, setSelected] = useState(0)
  const [showReasoning, setShowReasoning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTrial(null); setOther(null); setSelected(0)
    Promise.all([api.ledger(runId, scenario, arm, rep), api.trace(runId, scenario, arm, rep)]).then(([ledger, trace]) => setTrial({ ledger, trace })).catch(e => setError(String(e)))
    api.run(runId).then((d) => {
      const arms = [d.plan.baseline.name, ...d.plan.candidates.map(c => c.name)]
      const o = arms.find(a => a !== arm) ?? null
      setOtherArm(o)
      if (o !== null) Promise.all([api.ledger(runId, scenario, o, rep), api.trace(runId, scenario, o, rep)]).then(([ledger, trace]) => setOther({ ledger, trace })).catch(() => setOther(null))
    }).catch(() => { /* ignore */ })
  }, [runId, scenario, arm, rep])

  const divergence = useMemo(() => {
    if (!trial || !other) return -1
    const a = trial.trace.map(r => r.calls.map(c => c.name).join(','))
    const b = other.trace.map(r => r.calls.map(c => c.name).join(','))
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i
    return a.length === b.length ? -1 : n
  }, [trial, other])

  if (error) return <p class="error">{error}</p>
  if (!trial) return <p class="muted">loading…</p>
  const { ledger, trace } = trial
  const t = ledger.totals
  const promptMax = Math.max(1, ...trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)))
  const row = trace[selected]

  return (
    <section class="trace">
      <div class="page-head">
        <div>
          <p class="crumbs"><a href={`#/run/${runId}`}>{runId}</a> / <code>{scenario}</code> / <b>{arm}</b> / rep {rep}</p>
          <h1><span class={`cls ${ledger.error ? 'incomplete' : ledger.verdict?.ok ? 'same' : 'regression'}`}>{ledger.error ? 'error' : ledger.verdict?.ok ? 'pass' : 'fail'}</span> <span class="muted small">{ledger.error ?? ledger.verdict?.detail}</span></h1>
        </div>
        <div class="row">
          {other && <button class={`btn ${compare ? 'primary' : ''}`} onClick={() => setCompare(!compare)}>{compare ? 'hide' : 'compare'} with {otherArm}</button>}
          <a class="btn" href={api.atifUrl(runId, scenario, arm, rep)} target="_blank">ATIF</a>
        </div>
      </div>
      <div class="card">
        <div class="cards">
          <div class="stat"><div class="stat-label">cost</div><div class="stat-vals"><span>{fmt.usd(t.usd)}</span><span class="muted small">peak {fmt.usd(t.usdPeak)} · off-peak {fmt.usd(t.usdOffpeak)}</span></div></div>
          <div class="stat"><div class="stat-label">steps / turns</div><div class="stat-vals"><span>{t.steps} / {t.turns}</span><span class="muted small">{fmt.secs(ledger.wallMs)} · {ledger.sessions ?? 1} session{(ledger.sessions ?? 1) === 1 ? '' : 's'}</span></div></div>
          <div class="stat"><div class="stat-label">tokens</div><div class="stat-vals"><TokenBar hit={t.hit} miss={t.miss} output={t.output} /></div><div class="muted small">hit {fmt.k(t.hit)} · miss {fmt.k(t.miss)} · out {fmt.k(t.output)} (reasoning {fmt.k(t.reasoning)}) · peak prompt {fmt.k(t.peakPrompt)}</div></div>
          <div class="stat"><div class="stat-label">route</div><div class="stat-vals"><span>{ledger.headerModel ?? ledger.model}</span><span class="muted small">effort {ledger.resolvedEffort ?? 'default'} · {ledger.tools.length} tools · system prompt {fmt.k(ledger.systemPromptChars)} chars</span></div></div>
        </div>
        <div class="muted small">tools used: {Object.entries(ledger.toolHistogram).map(([k, v]) => `${k}×${v}`).join(' · ') || 'none'}{Object.entries(ledger.eventCounts).filter(([k]) => k.startsWith('compaction/')).map(([k, v]) => ` · ${k}×${v}`).join('')}</div>
      </div>

      <div class={`trace-grid ${compare && other ? 'compare' : ''}`}>
        <div class="card steps">
          <h2>Steps <span class="muted small">prompt size per step</span></h2>
          <StepList trace={trace} selected={selected} onSelect={setSelected} promptMax={promptMax} divergence={compare ? divergence : -1} />
        </div>
        {compare && other && (
          <div class="card steps">
            <h2>{otherArm} <span class="muted small">{other.ledger.verdict?.ok ? 'pass' : 'fail'} · {fmt.usd(other.ledger.totals.usd)} · {other.ledger.totals.steps} steps{divergence >= 0 ? ` · diverges at step ${divergence + 1}` : ' · same tool sequence'}</span></h2>
            <StepList trace={other.trace} selected={-1} onSelect={() => { /* read-only */ }} promptMax={Math.max(promptMax, ...other.trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)))} divergence={divergence} />
          </div>
        )}
        <div class="card detail">
          {row ? (
            <>
              <h2>Turn {row.turn} · step {row.step} <span class="muted small">{new Date(row.time).toLocaleTimeString()} · {fmt.usd(row.usd)}{row.usage ? ` · hit ${fmt.k(row.usage.hit)} miss ${fmt.k(row.usage.miss)} out ${fmt.k(row.usage.output)}` : ''}</span></h2>
              {row.reasoning && <div class="reasoning"><button class="btn small" onClick={() => setShowReasoning(!showReasoning)}>{showReasoning ? 'hide' : 'show'} reasoning ({fmt.k(row.reasoning.length)} chars)</button>{showReasoning && <pre>{row.reasoning}</pre>}</div>}
              {row.text && <pre class="assistant">{row.text}</pre>}
              {row.calls.map(c => <div class="call"><div class="call-head"><code>{c.name}</code></div><pre>{pretty(c.arguments)}</pre></div>)}
            </>
          ) : <p class="muted">no steps</p>}
        </div>
      </div>
    </section>
  )
}

function StepList({ trace, selected, onSelect, promptMax, divergence }: { trace: TraceRow[]; selected: number; onSelect: (i: number) => void; promptMax: number; divergence: number }) {
  let lastTurn = 0
  return (
    <ol class="steplist">
      {trace.map((r, i) => {
        const prompt = (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)
        const hitPct = prompt > 0 ? (r.usage?.hit ?? 0) / prompt * 100 : 0
        const turnStart = r.turn !== lastTurn
        lastTurn = r.turn
        return (
          <>
            {turnStart && <li class="turn-sep">turn {r.turn}</li>}
            <li class={`${i === selected ? 'sel' : ''} ${i === divergence ? 'diverge' : ''}`} onClick={() => onSelect(i)}>
              <span class="step-no">{r.step}</span>
              <span class="step-calls">{r.calls.length ? r.calls.map(c => <code>{c.name}</code>) : <span class="muted">{r.text ? r.text.slice(0, 60) : '…'}</span>}</span>
              <span class="spark" title={`prompt ${fmt.k(prompt)} tokens, ${hitPct.toFixed(0)}% cache hit`}><i style={{ width: `${prompt / promptMax * 100}%` }}><b style={{ width: `${hitPct}%` }} /></i></span>
              <span class="step-cost">{fmt.usd(r.usd)}</span>
            </li>
          </>
        )
      })}
    </ol>
  )
}

function TokenBar({ hit, miss, output }: { hit: number; miss: number; output: number }) {
  const total = Math.max(1, hit + miss + output)
  return <span class="tokenbar" title={`hit ${hit} · miss ${miss} · output ${output}`}><i class="hit" style={{ width: `${hit / total * 100}%` }} /><i class="miss" style={{ width: `${miss / total * 100}%` }} /><i class="out" style={{ width: `${output / total * 100}%` }} /></span>
}

function pretty(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
}
