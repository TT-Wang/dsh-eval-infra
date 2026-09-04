import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt, type ArmInfo, type History, type Meta, type ScenarioInfo } from '../api.js'
import { navigate } from '../main.js'
import { pickCandidates } from '../select-arms.js'
import { ArmDesigner } from './arm-designer.js'

export function NewRunView({ preset = {} }: { preset?: Record<string, string> }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [arms, setArms] = useState<ArmInfo[]>([])
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
  const [invalid, setInvalid] = useState<Array<{ dir: string; error: string }>>([])
  const [baseline, setBaseline] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset['scenario'] ? [preset['scenario']] : []))
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [repeats, setRepeats] = useState(3)
  const [concurrency, setConcurrency] = useState(2)
  const [label, setLabel] = useState('')
  const [allowMulti, setAllowMulti] = useState(false)
  const [aa, setAa] = useState(false)
  const [docker, setDocker] = useState(false)
  const [diff, setDiff] = useState<Array<{ candidate: string; variables: number; lines: string[] }> | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [maxUsd, setMaxUsd] = useState('')
  const [maxUsdPerTrial, setMaxUsdPerTrial] = useState('')
  const [sequential, setSequential] = useState(false)
  const [seed, setSeed] = useState('42')
  const [orderSignal, setOrderSignal] = useState(false)
  const [perturb, setPerturb] = useState(false)
  const [sandbox, setSandbox] = useState<'auto' | 'host' | 'docker'>('auto')
  const [dockerRuntime, setDockerRuntime] = useState('')
  const [keepDshSandbox, setKeepDshSandbox] = useState(false)
  const [replayRun, setReplayRun] = useState(preset['replay'] ?? '')
  const [forkAt, setForkAt] = useState(preset['forkAt'] ?? '')
  const [runsList, setRunsList] = useState<Array<{ id: string; label?: string }>>([])
  const [step, setStep] = useState(0)
  const reloadArms = (): void => { void api.arms().then(r => setArms(r.arms)) }
  useEffect(() => { api.runs().then(rs => setRunsList(rs.map(r => ({ id: r.id, ...(r.label !== undefined ? { label: r.label } : {}) })))).catch(() => { /* static */ }) }, [])

  useEffect(() => {
    api.meta().then((m) => { setMeta(m); setRepeats(m.defaults.repeats); setConcurrency(m.defaults.concurrency) }).catch(e => setError(String(e)))
    api.arms().then((r) => {
      setArms(r.arms)
      const names = r.arms.filter(a => a.spec).map(a => a.spec!.name)
      if (names.includes('baseline')) setBaseline('baseline')
      else if (names[0] !== undefined) setBaseline(names[0])
      const first = names.find(n => n !== 'baseline')
      if (first !== undefined) setCandidates([first])
    }).catch(e => setError(String(e)))
    api.scenarios().then((r) => { setScenarios(r.scenarios); setInvalid(r.invalid); setSelected(new Set(r.scenarios.map(s => s.name))) }).catch(e => setError(String(e)))
    api.history().then(setHistory).catch(() => setHistory(null))
  }, [])

  const armNames = arms.filter(a => a.spec).map(a => a.spec!.name)
  // Belt and braces: even if state goes stale, nothing downstream sees the baseline as a candidate.
  const activeCandidates = candidates.filter(n => n !== baseline)

  useEffect(() => {
    if (baseline === '' || (activeCandidates.length === 0 && !aa)) { setDiff(null); return }
    let cancelled = false
    setDiffError(null)
    api.diff(baseline, aa ? [] : activeCandidates).then((r) => { if (!cancelled) setDiff(r.diffs) }).catch((e) => { if (!cancelled) { setDiff(null); setDiffError(String(e)) } })
    return () => { cancelled = true }
  }, [baseline, activeCandidates.join(','), aa])

  const categories = useMemo(() => [...new Set(scenarios.map(s => s.meta.category ?? 'uncategorised'))].sort(), [scenarios])
  const visible = scenarios.filter(s => (category === '' || (s.meta.category ?? 'uncategorised') === category) && (query === '' || s.name.includes(query) || (s.meta.stressor ?? '').toLowerCase().includes(query.toLowerCase())))
  const trials = selected.size * repeats * (1 + (aa ? 1 : activeCandidates.length))
  // Estimate from the archive: mean cost per trial of each selected scenario (any arm), else the archive-wide mean.
  const estimate = useMemo(() => {
    if (!history) return null
    const cells = history.scenarios.flatMap(s => Object.values(s.cells))
    const overall = cells.length ? cells.reduce((a, c) => a + c.usdMean * c.runs, 0) / Math.max(1, cells.reduce((a, c) => a + c.runs, 0)) : null
    let usd = 0
    let known = 0
    let seen = 0
    for (const name of selected) {
      const row = history.scenarios.find(s => s.name === name)
      const cs = row ? Object.values(row.cells) : []
      const own = cs.length ? cs.reduce((a, c) => a + c.usdMean * c.runs, 0) / Math.max(1, cs.reduce((a, c) => a + c.runs, 0)) : null
      if (own !== null) seen += 1
      const m = own ?? overall
      if (m !== null) { usd += m; known += 1 }
    }
    if (known === 0) return null
    const perTrial = usd / known
    return { usd: perTrial * trials, seen, perTrial }
  }, [history, selected, trials])
  const multi = diff?.some(d => d.variables > 1) ?? false
  const identical = diff?.some(d => d.variables === 0) ?? false

  const toggle = (name: string): void => { const n = new Set(selected); if (n.has(name)) n.delete(name); else n.add(name); setSelected(n) }
  const start = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const cap = Number(maxUsd)
      const perTrial = Number(maxUsdPerTrial)
      const fork = Number(forkAt)
      const { id } = await api.start({
        baseline, candidates: aa ? [] : activeCandidates, scenarios: [...selected], repeats, concurrency, label: label || undefined, allowMulti, aa,
        ...(sandbox !== 'auto' ? { sandbox } : docker ? { sandbox: 'docker' } : {}),
        ...(dockerRuntime.trim() !== '' ? { dockerRuntime: dockerRuntime.trim() } : {}),
        ...(keepDshSandbox ? { dockerKeepSandbox: true } : {}),
        ...(maxUsd !== '' && Number.isFinite(cap) && cap > 0 ? { maxUsd: cap } : {}),
        ...(maxUsdPerTrial !== '' && Number.isFinite(perTrial) && perTrial > 0 ? { maxUsdPerTrial: perTrial } : {}),
        ...(sequential ? { sequential: true, seed: Number(seed) || 42, ...(orderSignal ? { order: 'signal' } : {}) } : {}),
        ...(perturb ? { perturb: true } : {}),
        ...(replayRun !== '' ? { replay: { runId: replayRun, ...(forkAt !== '' && Number.isFinite(fork) && fork >= 0 ? { forkAt: fork } : {}) } } : {}),
      })
      navigate(`/run/${id}`)
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }


  const STEPS = ['Design the arms', 'Evaluation settings', 'Scenarios'] as const
  const primaryCandidate = activeCandidates[0] ?? ''
  const canAdvance = step === 0
    ? baseline !== '' && (aa || primaryCandidate !== '') && (!multi || allowMulti)
    : step === 1 ? true : selected.size > 0

  return (
    <section class="mx-auto max-w-[1400px] px-5 py-5 flex flex-col gap-5">
      <header class="flex items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold">New evaluation</h1>
          <p class="text-sm text-muted-foreground">Two configurations, the same scenarios, interleaved and repeated.</p>
        </div>
        <ol class="flex items-center gap-2">
          {STEPS.map((title, i) => (
            <li key={title} class="flex items-center gap-2">
              <button
                class={`uk-btn uk-btn-sm ${i === step ? 'uk-btn-primary' : 'uk-btn-default'}`}
                disabled={i > step && !canAdvance}
                onClick={() => setStep(i)}
              >
                <span class="mr-1 opacity-60">{i + 1}</span>{title}
              </button>
              {i < STEPS.length - 1 && <span class="text-muted-foreground">›</span>}
            </li>
          ))}
        </ol>
      </header>

      {error !== null && <div class="uk-alert uk-alert-destructive">{error}</div>}
      {diffError !== null && step === 0 && <div class="uk-alert uk-alert-destructive">{diffError}</div>}

      {step === 0 && (
        <>
          <label class="uk-form-label flex items-center gap-2 text-sm">
            <input class="uk-checkbox" type="checkbox" checked={aa} onChange={e => setAa((e.target as HTMLInputElement).checked)} />
            A/A run: compare the baseline with a copy of itself to measure this setup's noise floor
          </label>
          {!aa && (
            <ArmDesigner
              meta={meta} arms={arms} baseline={baseline} candidate={primaryCandidate}
              onBaseline={(n) => { setBaseline(n); setCandidates(pickCandidates(candidates, n, armNames)) }}
              onCandidate={n => setCandidates([n])}
              onSaved={reloadArms}
            />
          )}
          {aa && <div class="uk-alert">Both arms will be <code>{baseline}</code>. Every difference the run reports is noise, which is what later runs are judged against.</div>}
          {multi && !aa && (
            <label class="uk-form-label flex items-center gap-2 text-sm">
              <input class="uk-checkbox" type="checkbox" checked={allowMulti} onChange={e => setAllowMulti((e.target as HTMLInputElement).checked)} />
              Run anyway, marked as a multi-variable comparison
            </label>
          )}
        </>
      )}

      {step === 1 && (
        <div class="grid gap-4 md:grid-cols-2">
          <section class="uk-card">
            <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">How many trials</h2></div>
            <div class="uk-card-body py-3 flex flex-col gap-3">
              <label class="text-sm">Repeats per scenario, per arm
                <input class="uk-input" type="number" min={1} max={30} value={repeats} onInput={e => setRepeats(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
                <span class="text-xs text-muted-foreground">Three is the floor; five is recommended for pass/fail outcomes.</span>
              </label>
              <label class="text-sm">Trials in parallel
                <input class="uk-input" type="number" min={1} max={16} value={concurrency} onInput={e => setConcurrency(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
              </label>
              <label class="text-sm">Label
                <input class="uk-input" type="text" value={label} placeholder="what this run is for" onInput={e => setLabel((e.target as HTMLInputElement).value)} />
              </label>
            </div>
          </section>

          <section class="uk-card">
            <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">Spend</h2></div>
            <div class="uk-card-body py-3 flex flex-col gap-3">
              <label class="text-sm">Budget cap for the run (USD)
                <input class="uk-input" type="text" value={maxUsd} placeholder="optional" onInput={e => setMaxUsd((e.target as HTMLInputElement).value)} />
              </label>
              <label class="text-sm">Cap per trial (USD)
                <input class="uk-input" type="text" value={maxUsdPerTrial} placeholder="optional" onInput={e => setMaxUsdPerTrial((e.target as HTMLInputElement).value)} />
                <span class="text-xs text-muted-foreground">A trial that passes its cap stops and counts as a failure.</span>
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input class="uk-checkbox" type="checkbox" checked={sequential} onChange={e => setSequential((e.target as HTMLInputElement).checked)} />
                Stop early once the result is decided
              </label>
              {sequential && (
                <div class="flex gap-2 pl-6">
                  <label class="text-sm">seed <input class="uk-input uk-form-sm" value={seed} onInput={e => setSeed((e.target as HTMLInputElement).value)} /></label>
                  <label class="flex items-center gap-2 text-sm"><input class="uk-checkbox" type="checkbox" checked={orderSignal} onChange={e => setOrderSignal((e.target as HTMLInputElement).checked)} /> strongest scenarios first</label>
                </div>
              )}
            </div>
          </section>

          <section class="uk-card">
            <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">Isolation</h2></div>
            <div class="uk-card-body py-3 flex flex-col gap-3">
              <label class="text-sm">Where each trial runs
                <select class="uk-select" value={sandbox} onChange={(e) => { const v = (e.target as HTMLSelectElement).value as 'auto' | 'host' | 'docker'; setSandbox(v); setDocker(v === 'docker') }}>
                  <option value="auto">auto — container when third-party plugins are linked and Docker is available</option>
                  <option value="host">host — dsh's own workspace sandbox, fastest</option>
                  <option value="docker">container per trial</option>
                </select>
              </label>
              <label class="text-sm">Container runtime
                <input class="uk-input" type="text" value={dockerRuntime} placeholder="default · runsc · kata" onInput={e => setDockerRuntime((e.target as HTMLInputElement).value)} />
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input class="uk-checkbox" type="checkbox" checked={keepDshSandbox} onChange={e => setKeepDshSandbox((e.target as HTMLInputElement).checked)} />
                Keep dsh's own sandbox on inside the container
              </label>
            </div>
          </section>

          <section class="uk-card">
            <div class="uk-card-header py-3"><h2 class="uk-card-title text-sm">Evidence</h2></div>
            <div class="uk-card-body py-3 flex flex-col gap-3">
              <label class="flex items-center gap-2 text-sm">
                <input class="uk-checkbox" type="checkbox" checked={perturb} onChange={e => setPerturb((e.target as HTMLInputElement).checked)} />
                Paraphrase prompts on repeats above one, identically for both arms
              </label>
              <label class="text-sm">Replay a recorded run instead of calling the provider
                <select class="uk-select" value={replayRun} onChange={e => setReplayRun((e.target as HTMLSelectElement).value)}>
                  <option value="">— live run —</option>
                  {runsList.map(r => <option value={r.id}>{r.id}{r.label ? ` · ${r.label}` : ''}</option>)}
                </select>
              </label>
              {replayRun !== '' && (
                <label class="text-sm">Fork to live calls after N recorded responses
                  <input class="uk-input" type="text" value={forkAt} placeholder="empty = pure replay, no key needed" onInput={e => setForkAt((e.target as HTMLInputElement).value)} />
                </label>
              )}
            </div>
          </section>
        </div>
      )}

      {step === 2 && (
        <section class="uk-card">
          <div class="uk-card-header flex flex-wrap items-center justify-between gap-2 py-3">
            <h2 class="uk-card-title text-sm">Scenarios <span class="text-muted-foreground font-normal">({selected.size} of {scenarios.length} selected)</span></h2>
            <div class="flex flex-wrap items-center gap-2">
              <input class="uk-input uk-form-sm" type="search" placeholder="filter" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
              <select class="uk-select uk-form-sm" value={category} onChange={e => setCategory((e.target as HTMLSelectElement).value)}>
                <option value="">all categories</option>
                {categories.map(c => <option value={c}>{c}</option>)}
              </select>
              <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setSelected(new Set([...selected, ...visible.map(s => s.name)]))}>select shown</button>
              <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => { const n = new Set(selected); for (const s of visible) n.delete(s.name); setSelected(n) }}>clear shown</button>
            </div>
          </div>
          <div class="uk-card-body py-0 table-scroll">
            <table class="uk-table uk-table-divider uk-table-sm text-sm">
              <thead><tr><th class="w-8"></th><th>scenario</th><th>category</th><th class="text-right">turns</th><th>oracle</th><th>stresses</th></tr></thead>
              <tbody>
                {visible.map(s => (
                  <tr key={s.name} class={selected.has(s.name) ? '' : 'opacity-50'}>
                    <td><input class="uk-checkbox" type="checkbox" checked={selected.has(s.name)} onChange={() => toggle(s.name)} /></td>
                    <td><code class="text-xs">{s.name}</code>{s.meta.new_session_before_turns?.length ? <span class="uk-badge uk-badge ml-1 badge-xs">multi-session</span> : null}{s.meta.network ? <span class="uk-badge ml-1 badge-xs">network</span> : null}</td>
                    <td class="text-muted-foreground">{s.meta.category ?? '—'}</td>
                    <td class="text-right">{s.turns}</td>
                    <td>{s.hasOracle ? 'yes' : <span class="text-muted-foreground">none</span>}</td>
                    <td class="text-muted-foreground text-xs">{s.meta.stressor ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invalid.length > 0 && <div class="uk-card-footer py-2 text-xs text-destructive">{invalid.length} unreadable scenario dir(s): {invalid.map(i => `${i.dir}: ${i.error}`).join('; ')}</div>}
        </section>
      )}

      <footer class="sticky bottom-0 flex items-center justify-between gap-4 border-t border-border bg-card px-4 py-3 rounded-md">
        <div class="text-sm text-muted-foreground">
          <b class="text-foreground">{selected.size}</b> scenarios × <b class="text-foreground">{repeats}</b> repeats × <b class="text-foreground">{1 + (aa ? 1 : activeCandidates.length)}</b> arms = <b class="text-foreground">{trials}</b> trials
          {estimate ? <span> · about <b class="text-foreground">{fmt.usd(estimate.usd, 2)}</b> by the archive's history</span> : <span> · no archive yet to estimate cost</span>}
        </div>
        <div class="flex items-center gap-2">
          <button class="uk-btn uk-btn-default" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          {step < 2 && <button class="uk-btn uk-btn-primary" disabled={!canAdvance} onClick={() => setStep(step + 1)}>Next</button>}
          {step === 2 && (
            <button class="uk-btn uk-btn-primary" disabled={busy || selected.size === 0 || baseline === '' || (!aa && activeCandidates.length === 0) || (multi && !allowMulti)} onClick={() => void start()}>
              {busy ? 'starting…' : 'Start evaluation'}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
