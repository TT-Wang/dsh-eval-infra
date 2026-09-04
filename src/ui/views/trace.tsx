import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, STATIC, fmt } from '../api.js'
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
  const [blind, setBlind] = useState<boolean>(() => { try { return localStorage.getItem('dsh-eval-blind') === '1' } catch { return false } })
  const toggleBlind = (): void => { const v = !blind; setBlind(v); try { localStorage.setItem('dsh-eval-blind', v ? '1' : '0') } catch { /* ignore */ } }
  // Blind review: while on and no annotation has been saved for this trial, the arm name, machine verdict and the other arm's verdict stay hidden.
  const masked = blind && annotation === null
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

  if (error !== null) return <section class="mx-auto max-w-[1400px] px-5 py-5"><div class="uk-alert uk-alert-destructive">{error}</div></section>
  if (trial === null) return <section class="mx-auto max-w-[1400px] px-5 py-5 text-muted-foreground">loading…</section>
  const { ledger, trace } = trial
  const t = ledger.totals
  const promptMax = Math.max(1, ...trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)), ...(other?.trace.map(r => (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)) ?? []))
  const durations = new Map(ledger.steps.map(st => [`${st.turn}/${st.step}`, st.durationMs ?? 0]))
  const otherDurations = new Map((other?.ledger.steps ?? []).map(st => [`${st.turn}/${st.step}`, st.durationMs ?? 0]))
  const durMax = Math.max(1, ...durations.values(), ...otherDurations.values())
  const row = trace[selected]
  const b = ledger.behaviour
  const outcome = ledger.error !== undefined ? 'error' : ledger.verdict?.ok === true ? 'pass' : 'fail'
  const outcomeClass = outcome === 'pass' ? 'text-emerald-600' : outcome === 'fail' ? 'text-destructive' : 'text-muted-foreground'

  return (
    <section class="mx-auto max-w-[1400px] px-5 py-4 flex flex-col gap-4">
      {/* what this trial is, and how it ended */}
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs text-muted-foreground">
            <a class="hover:text-foreground" href={`#/run/${runId}`}>{runId}</a>
            <span class="mx-1">/</span><code>{scenario}</code>
            <span class="mx-1">/</span><b class="text-foreground">{masked ? 'arm ●' : arm}</b>
            <span class="mx-1">/</span>repeat {rep}
          </p>
          {masked
            ? <h1 class="text-lg font-semibold">Blind review <span class="text-sm font-normal text-muted-foreground">arm and machine verdict hidden until you save a verdict</span></h1>
            : (
              <h1 class="text-lg font-semibold flex items-baseline gap-2">
                <span class={outcomeClass}>{outcome}</span>
                <span class="text-sm font-normal text-muted-foreground truncate">{ledger.error ?? ledger.verdict?.detail}</span>
              </h1>
            )}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class={`uk-btn uk-btn-sm ${blind ? 'uk-btn-primary' : 'uk-btn-default'}`} title="hide the arm name and the machine verdict until you have recorded your own" onClick={toggleBlind}>blind review {blind ? 'on' : 'off'}</button>
          {other !== null && <button class={`uk-btn uk-btn-sm ${compare ? 'uk-btn-primary' : 'uk-btn-default'}`} onClick={() => setCompare(!compare)}>{compare ? 'hide' : 'compare with'} {masked ? 'arm ○' : otherArm}</button>}
          <a class="uk-btn uk-btn-default uk-btn-sm" href={api.atifUrl(runId, scenario, arm, rep)} target="_blank">ATIF</a>
          {STATIC === undefined && (
            <a class="uk-btn uk-btn-default uk-btn-sm" title="start a run that replays this trial up to here, then goes live from this step" href={`#/new?replay=${encodeURIComponent(runId)}&forkAt=${selected}&scenario=${encodeURIComponent(scenario)}`}>fork from step {selected + 1}</a>
          )}
        </div>
      </header>

      {/* the trial's facts, one line each */}
      <section class="uk-card">
        <div class="uk-card-body py-3 grid gap-3 md:grid-cols-3 lg:grid-cols-5 text-sm">
          <Fact label="cost" value={fmt.usd(t.usd)} hint={`peak ${fmt.usd(t.usdPeak)} · off-peak ${fmt.usd(t.usdOffpeak)}`} />
          <Fact label="steps / turns" value={`${t.steps} / ${t.turns}`} hint={`${fmt.secs(ledger.wallMs)} · ${ledger.sessions ?? 1} session${(ledger.sessions ?? 1) === 1 ? '' : 's'}`} />
          <div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">tokens</div>
            <TokenBar hit={t.hit} miss={t.miss} output={t.output} />
            <div class="text-xs text-muted-foreground">hit {fmt.k(t.hit)} · miss {fmt.k(t.miss)} · out {fmt.k(t.output)} · peak prompt {fmt.k(t.peakPrompt)}</div>
          </div>
          <Fact label="route" value={ledger.headerModel ?? ledger.model} hint={`effort ${ledger.resolvedEffort ?? 'default'} · ${ledger.tools.length} tools`} />
          <Fact
            label="behaviour"
            value={b ? `${b.toolErrors} tool error${b.toolErrors === 1 ? '' : 's'}` : '—'}
            hint={b ? `${b.repeatedCalls} repeated · ${b.noActionSteps} no-action · ${fmt.k(b.observationChars)} chars read · ${b.compactions} compactions` : ''}
          />
        </div>
        <div class="uk-card-footer py-2 text-xs text-muted-foreground">
          tools: {Object.entries(ledger.toolHistogram).map(([k, v]) => `${k}×${v}`).join(' · ') || 'none'}
          <span class="mx-2">·</span>
          <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>r</kbd> reasoning, <kbd>c</kbd> compare, <kbd>esc</kbd> back
        </div>
      </section>

      <div class={`grid gap-4 ${compare && other !== null ? 'trace-grid-compare' : 'trace-grid'}`}>
        <section class="uk-card min-w-0">
          <div class="uk-card-header py-2">
            <h2 class="uk-card-title text-sm">{masked ? 'this arm' : arm}</h2>
            <p class="text-xs text-muted-foreground">bars: prompt size, green is cache hit; the thin bar is wall time</p>
          </div>
          <div class="uk-card-body py-1">
            <StepList trace={trace} selected={selected} onSelect={setSelected} promptMax={promptMax} divergence={compare ? divergence : -1} durations={durations} durMax={durMax} />
          </div>
        </section>

        {compare && other !== null && (
          <section class="uk-card min-w-0">
            <div class="uk-card-header py-2">
              <h2 class="uk-card-title text-sm">{masked ? 'other arm' : otherArm}</h2>
              <p class="text-xs text-muted-foreground">
                {masked ? 'verdict hidden' : other.ledger.verdict?.ok === true ? 'passed' : 'failed'} · {fmt.usd(other.ledger.totals.usd)} · {other.ledger.totals.steps} steps
                {divergence >= 0 ? ` · parts from this arm at step ${divergence + 1}` : ' · same tool sequence throughout'}
              </p>
            </div>
            <div class="uk-card-body py-1">
              <StepList trace={other.trace} selected={Math.min(selected, other.trace.length - 1)} onSelect={setSelected} promptMax={promptMax} divergence={divergence} durations={otherDurations} durMax={durMax} />
            </div>
          </section>
        )}

        <section class="uk-card min-w-0">
          <div class="uk-card-header py-2 flex items-center gap-1">
            {(['step', 'verdict', 'raw'] as Tab[]).map(k => (
              <button key={k} class={`uk-btn uk-btn-sm ${tab === k ? 'uk-btn-primary' : 'uk-btn-default'}`} onClick={() => setTab(k)}>{k}</button>
            ))}
          </div>
          <div class="uk-card-body py-3 detail-pane">
            {tab === 'verdict' && (
              <div class="flex flex-col gap-3">
                {masked
                  ? <p class="text-sm text-muted-foreground">The machine verdict is hidden. Record your own below to reveal it.</p>
                  : (
                    <div>
                      <div class={`text-sm font-medium ${ledger.verdict?.ok === true ? 'text-emerald-600' : 'text-destructive'}`}>{ledger.verdict?.ok === true ? 'passed the verifier' : 'failed the verifier'}</div>
                      <pre class="mt-1 text-xs whitespace-pre-wrap">{ledger.verdict?.detail ?? '(no verdict)'}</pre>
                    </div>
                  )}
                {ledger.error !== undefined && <div class="uk-alert uk-alert-destructive text-sm">runtime error: {ledger.error}</div>}
                <p class="text-xs text-muted-foreground">turn ends: {ledger.turns.map(x => `${x.turn}:${x.end}`).join(' · ')}</p>

                <div class="rounded-md border border-border p-3 flex flex-col gap-2">
                  <h3 class="text-sm font-medium">Human review</h3>
                  {annotation !== null && (
                    <p class="text-xs">
                      <span class={`cls ${annotation.verdict === null ? 'incomplete' : annotation.verdict ? 'same' : 'regression'}`}>{annotation.verdict === null ? 'note' : annotation.verdict ? 'marked pass' : 'marked fail'}</span>
                      {' '}by {annotation.by} at {fmt.time(annotation.at)}{annotation.note !== '' ? ` — ${annotation.note}` : ''}
                    </p>
                  )}
                  <textarea class="uk-textarea text-sm" rows={2} placeholder="why — kept with the run and quoted in the report" value={note} onInput={e => setNote((e.target as HTMLTextAreaElement).value)} />
                  <div class="flex flex-wrap gap-2">
                    <button class="uk-btn uk-btn-default uk-btn-sm" disabled={saving} onClick={() => void annotate(true)}>mark pass</button>
                    <button class="uk-btn uk-btn-default uk-btn-sm" disabled={saving} onClick={() => void annotate(false)}>mark fail</button>
                    <button class="uk-btn uk-btn-default uk-btn-sm" disabled={saving} onClick={() => void annotate(null)}>note only</button>
                    {annotation !== null && <button class="uk-btn uk-btn-default uk-btn-sm" disabled={saving} onClick={() => void annotate(null, true)}>remove</button>}
                  </div>
                  <p class="text-xs text-muted-foreground">An override replaces the verdict in the report. The machine verdict stays in the ledger, and the report says how many were overridden.</p>
                </div>

                {compare && other !== null && !masked && (
                  <p class="text-xs text-muted-foreground">{otherArm}: <span class={other.ledger.verdict?.ok === true ? 'text-emerald-600' : 'text-destructive'}>{other.ledger.verdict?.ok === true ? 'passed' : 'failed'}</span> {other.ledger.verdict?.detail}</p>
                )}
              </div>
            )}

            {tab === 'raw' && <pre class="text-xs whitespace-pre-wrap">{JSON.stringify({ ...ledger, steps: `${ledger.steps.length} steps — see the step tab` }, null, 2)}</pre>}

            {tab === 'step' && (row === undefined ? <p class="text-sm text-muted-foreground">no steps</p> : (
              <div class="flex flex-col gap-3">
                <div>
                  <h2 class="text-sm font-medium">Turn {row.turn} · step {row.step}</h2>
                  <p class="text-xs text-muted-foreground">
                    {new Date(row.time).toLocaleTimeString()} · {fmt.usd(row.usd)}
                    {row.usage ? ` · hit ${fmt.k(row.usage.hit)} miss ${fmt.k(row.usage.miss)} out ${fmt.k(row.usage.output)}` : ''}
                  </p>
                </div>
                {row.reasoning !== undefined && row.reasoning !== '' && (
                  <div>
                    <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setShowReasoning(!showReasoning)}>{showReasoning ? 'hide' : 'show'} reasoning · {fmt.k(row.reasoning.length)} chars</button>
                    {showReasoning && <pre class="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">{row.reasoning}</pre>}
                  </div>
                )}
                {row.text !== undefined && row.text !== '' && <pre class="text-xs whitespace-pre-wrap rounded-md bg-muted p-2">{row.text}</pre>}
                {row.calls.map((c, i) => {
                  const obs = row.observations?.[i]
                  const open = openObs.has(i)
                  return (
                    <article key={`${c.name}-${i}`} class="rounded-md border border-border">
                      <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
                        <code class="text-xs font-medium">{c.name}</code>
                        {obs !== undefined && (
                          <span class={`text-xs ${obs.isError ? 'text-destructive' : 'text-muted-foreground'}`}>{obs.isError ? 'error · ' : ''}{fmt.k(obs.chars)} chars back</span>
                        )}
                      </div>
                      <pre class="px-2 py-1.5 text-xs whitespace-pre-wrap">{pretty(c.arguments)}</pre>
                      {obs !== undefined && (
                        <div class="border-t border-border px-2 py-1.5">
                          <button class="uk-btn uk-btn-default uk-btn-xs" onClick={() => { const n = new Set(openObs); if (open) n.delete(i); else n.add(i); setOpenObs(n) }}>{open ? 'hide' : 'show'} what came back</button>
                          {open && <pre class={`mt-2 text-xs whitespace-pre-wrap ${obs.isError ? 'text-destructive' : ''}`}>{obs.text === '' ? '(empty)' : obs.text}</pre>}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div class="font-medium">{value}</div>
      {hint !== undefined && hint !== '' && <div class="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

function StepList({ trace, selected, onSelect, promptMax, divergence, durations, durMax }: { trace: TraceRow[]; selected: number; onSelect: (i: number) => void; promptMax: number; divergence: number; durations: Map<string, number>; durMax: number }) {
  const turnStarts = new Set<number>()
  let lastTurn = 0
  trace.forEach((r, i) => { if (r.turn !== lastTurn) { turnStarts.add(i); lastTurn = r.turn } })
  return (
    <ol class="steplist">
      <VirtualRows items={trace} rowHeight={30} height={520} threshold={200} render={(r, i) => {
        const prompt = (r.usage?.hit ?? 0) + (r.usage?.miss ?? 0)
        const hitPct = prompt > 0 ? (r.usage?.hit ?? 0) / prompt * 100 : 0
        const errs = (r.observations ?? []).filter(o => o.isError).length
        const dur = durations.get(`${r.turn}/${r.step}`) ?? 0
        return (
          <>
            {turnStarts.has(i) && <li class="turn-sep">turn {r.turn}</li>}
            <li
              class={`step-row ${i === selected ? 'sel' : ''} ${i === divergence ? 'diverge' : ''}`}
              onClick={() => onSelect(i)}
              ref={(el) => { if (i === selected) el?.scrollIntoView({ block: 'nearest' }) }}
            >
              <span class="step-no">{r.step}</span>
              <span class="step-calls">
                {r.calls.length > 0
                  ? r.calls.map(c => <code key={c.name}>{c.name}</code>)
                  : <span class="text-muted-foreground">{r.text !== undefined && r.text !== '' ? r.text.slice(0, 60) : '…'}</span>}
                {errs > 0 && <span class="tag">{errs} err</span>}
              </span>
              <span class="spark" title={`prompt ${fmt.k(prompt)} tokens, ${hitPct.toFixed(0)}% from cache${dur > 0 ? `, ${(dur / 1000).toFixed(1)}s` : ''}`}>
                <i style={{ width: `${prompt / promptMax * 100}%` }}><b style={{ width: `${hitPct}%` }} /></i>
                {dur > 0 && <em style={{ width: `${dur / durMax * 100}%` }} />}
              </span>
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
  return (
    <span class="tokenbar" title={`hit ${hit} · miss ${miss} · output ${output}`}>
      <i class="hit" style={{ width: `${hit / total * 100}%` }} />
      <i class="miss" style={{ width: `${miss / total * 100}%` }} />
      <i class="out" style={{ width: `${output / total * 100}%` }} />
    </span>
  )
}

function pretty(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
}
