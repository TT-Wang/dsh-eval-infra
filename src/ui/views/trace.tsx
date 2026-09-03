import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt } from '../api.js'
import { VirtualRows } from '../virtual.js'
import type { RunLedger } from '../../core/types.js'
import type { TraceRow } from '../../core/ledger.js'

interface Trial { ledger: RunLedger; trace: TraceRow[] }
type Tab = 'step' | 'verdict' | 'raw'

export function TraceView({ runId, scenario, arm, rep }: { runId: string; scenario: string; arm: string; rep: number }) {
  const [trial, setTrial] = useState<Trial | null>(null)
  const [other, setOther] = useState<Trial | null>(null)
  const [otherArm, setOtherArm] = useState<string | null>(null)
  const [compare, setCompare] = useState(location.hash.includes('compare=1'))
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<Tab>('step')
  const [showReasoning, setShowReasoning] = useState(false)
  const [openObs, setOpenObs] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [annotation, setAnnotation] = useState<{ verdict: boolean | null; note: string; by: string; at: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const annotate = async (verdict: boolean | null, remove = false): Promise<void> => {
    setSaving(true)
    try {
      await api.annotate(runId, { scenario, arm, rep, verdict, note, remove })
      const all = await api.annotations(runId)
      setAnnotation(all[`${scenario}|${arm}|${rep}`] ?? null)
      const ledger = await api.ledger(runId, scenario, arm, rep)
      setTrial(t => t ? { ...t, ledger } : t)
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }

  useEffect(() => {
    setTrial(null); setOther(null); setSelected(0); setOpenObs(new Set())
    Promise.all([api.ledger(runId, scenario, arm, rep), api.trace(runId, scenario, arm, rep)]).then(([ledger, trace]) => setTrial({ ledger, trace })).catch(e => setError(String(e)))
    api.annotations(runId).then(all => { const a = all[`${scenario}|${arm}|${rep}`] ?? null; setAnnotation(a); setNote(a?.note ?? '') }).catch(() => { /* static export */ })
    api.run(runId).then((d) => {
      const arms = [d.plan.baseline.name, ...d.plan.candidates.map(c => c.name)]
      const o = arms.find(a => a !== arm) ?? null
      setOtherArm(o)
      if (o !== null) Promise.all([api.ledger(runId, scenario, o, rep), api.trace(runId, scenario, o, rep)]).then(([ledger, trace]) => setOther({ ledger, trace })).catch(() => setOther(null))
    }).catch(() => { /* ignore */ })
  }, [runId, scenario, arm, rep])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (e.key === 'j' || e.key === 'ArrowDown') { setSelected(i => Math.min((trial?.trace.length ?? 1) - 1, i + 1)); e.preventDefault() }
      else if (e.key === 'k' || e.key === 'ArrowUp') { setSelected(i => Math.max(0, i - 1)); e.preventDefault() }
      else if (e.key === 'r') setShowReasoning(v => !v)
      else if (e.key === 'c' && other) setCompare(v => !v)
      else if (e.key === 'Escape') location.hash = `#/run/${runId}`
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trial, other, runId])

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
  const promptMax = Math.max(1, ...trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)), ...(other?.trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)) ?? []))
  const durations = new Map(ledger.steps.map(st => [`${st.turn}/${st.step}`, st.durationMs ?? 0]))
  const otherDurations = new Map((other?.ledger.steps ?? []).map(st => [`${st.turn}/${st.step}`, st.durationMs ?? 0]))
  const durMax = Math.max(1, ...durations.values(), ...otherDurations.values())
  const row = trace[selected]
  const b = ledger.behaviour

  return (
    <section class="trace">
      <div class="page-head">
        <div>
          <p class="crumbs"><a href={`#/run/${runId}`}>{runId}</a> / <code>{scenario}</code> / <b>{arm}</b> / rep {rep}</p>
          <h1><span class={`cls ${ledger.error ? 'incomplete' : ledger.verdict?.ok ? 'same' : 'regression'}`}>{ledger.error ? 'error' : ledger.verdict?.ok ? 'pass' : 'fail'}</span> <span class="muted small">{ledger.error ?? ledger.verdict?.detail}</span></h1>
        </div>
        <div class="row">
          {other && <button class={`btn ${compare ? 'primary' : ''}`} onClick={() => setCompare(!compare)}>{compare ? 'hide' : 'compare'} with {otherArm} <kbd>c</kbd></button>}
          <a class="btn" href={api.atifUrl(runId, scenario, arm, rep)} target="_blank">ATIF</a>
        </div>
      </div>
      <div class="card">
        <div class="cards">
          <div class="stat"><div class="stat-label">cost</div><div class="stat-vals"><span>{fmt.usd(t.usd)}</span><span class="muted small">peak {fmt.usd(t.usdPeak)} · off-peak {fmt.usd(t.usdOffpeak)}</span></div></div>
          <div class="stat"><div class="stat-label">steps / turns</div><div class="stat-vals"><span>{t.steps} / {t.turns}</span><span class="muted small">{fmt.secs(ledger.wallMs)} · {ledger.sessions ?? 1} session{(ledger.sessions ?? 1) === 1 ? '' : 's'}</span></div></div>
          <div class="stat"><div class="stat-label">tokens</div><div class="stat-vals"><TokenBar hit={t.hit} miss={t.miss} output={t.output} /></div><div class="muted small">hit {fmt.k(t.hit)} · miss {fmt.k(t.miss)} · out {fmt.k(t.output)} (reasoning {fmt.k(t.reasoning)}) · peak prompt {fmt.k(t.peakPrompt)}</div></div>
          <div class="stat"><div class="stat-label">behaviour</div><div class="stat-vals small"><span>{b ? `${b.toolErrors} tool errors · ${b.repeatedCalls} repeated calls · ${b.noActionSteps} no-action · ${fmt.k(b.observationChars)} chars observed · ${b.compactions} compactions` : '—'}</span></div></div>
          <div class="stat"><div class="stat-label">route</div><div class="stat-vals"><span>{ledger.headerModel ?? ledger.model}</span><span class="muted small">effort {ledger.resolvedEffort ?? 'default'} · {ledger.tools.length} tools · system prompt {fmt.k(ledger.systemPromptChars)} chars</span></div></div>
        </div>
        <div class="muted small">tools used: {Object.entries(ledger.toolHistogram).map(([k, v]) => `${k}×${v}`).join(' · ') || 'none'} · keys: <kbd>j</kbd>/<kbd>k</kbd> steps, <kbd>r</kbd> reasoning, <kbd>c</kbd> compare, <kbd>esc</kbd> back</div>
      </div>

      <div class={`trace-grid ${compare && other ? 'compare' : ''}`}>
        <div class="card steps">
          <h2>{arm} <span class="muted small">bars: prompt size (green = cache hit) and wall time per step</span></h2>
          <StepList trace={trace} selected={selected} onSelect={setSelected} promptMax={promptMax} divergence={compare ? divergence : -1} durations={durations} durMax={durMax} />
        </div>
        {compare && other && (
          <div class="card steps">
            <h2>{otherArm} <span class="muted small">{other.ledger.verdict?.ok ? 'pass' : 'fail'} · {fmt.usd(other.ledger.totals.usd)} · {other.ledger.totals.steps} steps{divergence >= 0 ? ` · diverges at step ${divergence + 1}` : ' · same tool sequence'}</span></h2>
            <StepList trace={other.trace} selected={compare ? Math.min(selected, other.trace.length - 1) : -1} onSelect={() => { /* mirrors the main selection */ }} promptMax={promptMax} divergence={divergence} durations={otherDurations} durMax={durMax} />
          </div>
        )}
        <div class="card detail">
          <div class="tabs">
            {(['step', 'verdict', 'raw'] as Tab[]).map(k => <button class={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{k === 'step' ? 'step' : k === 'verdict' ? 'verdict' : 'raw'}</button>)}
          </div>
          {tab === 'verdict' && (
            <div>
              <h2>Verdict</h2>
              <p><span class={`cls ${ledger.verdict?.ok ? 'same' : 'regression'}`}>{ledger.verdict?.ok ? 'pass' : 'fail'}</span></p>
              <pre>{ledger.verdict?.detail ?? '(no verdict)'}</pre>
              {ledger.error && <p class="error">runtime error: {ledger.error}</p>}
              <p class="muted small">turn ends: {ledger.turns.map(x => `${x.turn}:${x.end}`).join(' · ')}</p>
              <div class="annotate">
                <h3>Human review</h3>
                {annotation && <p class="small"><span class={`cls ${annotation.verdict === null ? 'incomplete' : annotation.verdict ? 'same' : 'regression'}`}>{annotation.verdict === null ? 'note' : annotation.verdict ? 'marked pass' : 'marked fail'}</span> by {annotation.by} at {fmt.time(annotation.at)}{annotation.note ? ` — ${annotation.note}` : ''}</p>}
                <textarea rows={2} placeholder="why (kept with the run, shown in the report)" value={note} onInput={e => setNote((e.target as HTMLTextAreaElement).value)} />
                <div class="row">
                  <button class="btn" disabled={saving} onClick={() => void annotate(true)}>mark pass</button>
                  <button class="btn" disabled={saving} onClick={() => void annotate(false)}>mark fail</button>
                  <button class="btn" disabled={saving} onClick={() => void annotate(null)}>note only</button>
                  {annotation && <button class="btn small" disabled={saving} onClick={() => void annotate(null, true)}>remove</button>}
                </div>
                <p class="muted small">Overrides replace the verdict in the report (the machine verdict stays in the ledger and the report says how many were overridden).</p>
              </div>
              {compare && other && <p class="muted small">{otherArm}: <span class={`cls ${other.ledger.verdict?.ok ? 'same' : 'regression'}`}>{other.ledger.verdict?.ok ? 'pass' : 'fail'}</span> {other.ledger.verdict?.detail}</p>}
            </div>
          )}
          {tab === 'raw' && <div><h2>Ledger</h2><pre>{JSON.stringify({ ...ledger, steps: `${ledger.steps.length} steps (see step tab)` }, null, 2)}</pre></div>}
          {tab === 'step' && (row ? (
            <>
              <h2>Turn {row.turn} · step {row.step} <span class="muted small">{new Date(row.time).toLocaleTimeString()} · {fmt.usd(row.usd)}{row.usage ? ` · hit ${fmt.k(row.usage.hit)} miss ${fmt.k(row.usage.miss)} out ${fmt.k(row.usage.output)}` : ''}</span></h2>
              {row.reasoning && <div class="reasoning"><button class="btn small" onClick={() => setShowReasoning(!showReasoning)}>{showReasoning ? 'hide' : 'show'} reasoning ({fmt.k(row.reasoning.length)} chars)</button>{showReasoning && <pre>{row.reasoning}</pre>}</div>}
              {row.text && <pre class="assistant">{row.text}</pre>}
              {row.calls.map((c, i) => {
                const obs = row.observations?.[i]
                const open = openObs.has(i)
                return (
                  <div class="call">
                    <div class="call-head"><code>{c.name}</code>{obs ? <span class={`muted small ${obs.isError ? 'error' : ''}`}> → {obs.isError ? 'error · ' : ''}{fmt.k(obs.chars)} chars</span> : null}</div>
                    <pre>{pretty(c.arguments)}</pre>
                    {obs && (
                      <div class="obs">
                        <button class="btn small" onClick={() => { const n = new Set(openObs); if (open) n.delete(i); else n.add(i); setOpenObs(n) }}>{open ? 'hide' : 'show'} result</button>
                        {open && <pre class={obs.isError ? 'obs-err' : ''}>{obs.text || '(empty)'}</pre>}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          ) : <p class="muted">no steps</p>)}
        </div>
      </div>
    </section>
  )
}

function StepList({ trace, selected, onSelect, promptMax, divergence, durations, durMax }: { trace: TraceRow[]; selected: number; onSelect: (i: number) => void; promptMax: number; divergence: number; durations: Map<string, number>; durMax: number }) {
  const turnStarts = new Set<number>()
  let lastTurn = 0
  trace.forEach((r, i) => { if (r.turn !== lastTurn) { turnStarts.add(i); lastTurn = r.turn } })
  return (
    <ol class="steplist">
      <VirtualRows items={trace} rowHeight={28} height={560} threshold={200} render={(r, i) => {
        const prompt = (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)
        const hitPct = prompt > 0 ? (r.usage?.hit ?? 0) / prompt * 100 : 0
        const turnStart = turnStarts.has(i)
        const errs = (r.observations ?? []).filter(o => o.isError).length
        return (
          <>
            {turnStart && <li class="turn-sep">turn {r.turn}</li>}
            <li class={`${i === selected ? 'sel' : ''} ${i === divergence ? 'diverge' : ''}`} onClick={() => onSelect(i)} ref={(el) => { if (i === selected) el?.scrollIntoView({ block: 'nearest' }) }}>
              <span class="step-no">{r.step}</span>
              <span class="step-calls">{r.calls.length ? r.calls.map(c => <code>{c.name}</code>) : <span class="muted">{r.text ? r.text.slice(0, 60) : '…'}</span>}{errs ? <span class="tag warn">{errs} err</span> : null}</span>
              <span class="spark" title={`prompt ${fmt.k(prompt)} tokens, ${hitPct.toFixed(0)}% cache hit`}><i style={{ width: `${prompt / promptMax * 100}%` }}><b style={{ width: `${hitPct}%` }} /></i>{(durations.get(`${r.turn}/${r.step}`) ?? 0) > 0 && <em class="dur" title={`${((durations.get(`${r.turn}/${r.step}`) ?? 0) / 1000).toFixed(1)}s wall`} style={{ width: `${(durations.get(`${r.turn}/${r.step}`) ?? 0) / durMax * 100}%` }} />}</span>
              <span class="step-cost">{fmt.usd(r.usd)}</span>
            </li>
          </>
        )
      }} />
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
