import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt, type ArmInfo, type History, type Meta, type ScenarioInfo } from '../api.js'
import { navigate } from '../main.js'
import { pickCandidates } from '../select-arms.js'
import { ArmDesigner } from './arm-designer.js'
import { ScenarioIntake } from './scenario-intake.js'
import { CATEGORIES, categoryInfo } from '../../core/categories.js'

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
  const [advanced, setAdvanced] = useState(false)
  const [budgetTouched, setBudgetTouched] = useState(false)
  const [openBuckets, setOpenBuckets] = useState<Set<string>>(new Set())
  const [showAdd, setShowAdd] = useState(false)
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
  // What `auto` will pick, said in the same terms the server decides it.
  const thirdParty = (meta?.plugins ?? []).length
  const dockerReady = meta?.docker?.available === true
  const autoIsolation = thirdParty > 0 && dockerReady
    ? { container: true, reason: `${thirdParty} third-party plugin${thirdParty === 1 ? ' is' : 's are'} linked into this profile and Docker is running` }
    : { container: false, reason: thirdParty === 0 ? 'no third-party plugin is linked into this profile' : 'Docker is not available here' }
  const variantScenarios = scenarios.filter(s => selected.has(s.name) && (s.variants ?? 0) > 0).length
  // Scenarios grouped by what they measure, in the order a reader meets them.
  const buckets = useMemo(() => {
    const byKey = new Map<string, ScenarioInfo[]>()
    for (const sc of visible) {
      const key = sc.meta.category ?? 'uncategorised'
      byKey.set(key, [...(byKey.get(key) ?? []), sc])
    }
    const known = CATEGORIES.filter(c => byKey.has(c.key)).map(c => ({ info: c, rows: byKey.get(c.key)!.sort((a, b) => a.name.localeCompare(b.name)) }))
    const rest = [...byKey.keys()].filter(k => !CATEGORIES.some(c => c.key === k)).map(k => ({ info: categoryInfo(k), rows: byKey.get(k)!.sort((a, b) => a.name.localeCompare(b.name)) }))
    return [...known, ...rest]
  }, [visible])
  // Prefill the cap from the archive's estimate, once, and only while the field is untouched.
  useEffect(() => {
    if (budgetTouched || maxUsd !== '' || estimate === null) return
    setMaxUsd((Math.ceil(estimate.usd * 1.5 * 100) / 100).toFixed(2))
  }, [estimate, budgetTouched, maxUsd])
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
          {!aa && (
            <ArmDesigner
              meta={meta} arms={arms} baseline={baseline} candidate={primaryCandidate}
              onBaseline={(n) => { setBaseline(n); setCandidates(pickCandidates(candidates, n, armNames)) }}
              onCandidate={n => setCandidates([n])}
              onSaved={reloadArms}
            />
          )}
          {aa && <div class="uk-alert">Both arms will be <code>{baseline}</code>. Every difference the run reports is noise, which is what later runs are judged against.</div>}
          <label class="flex items-center gap-2 text-sm text-muted-foreground">
            <input class="uk-checkbox" type="checkbox" checked={aa} onChange={e => setAa((e.target as HTMLInputElement).checked)} />
            Instead, run the baseline against itself to measure this setup's noise
          </label>
          {multi && !aa && (
            <label class="uk-form-label flex items-center gap-2 text-sm">
              <input class="uk-checkbox" type="checkbox" checked={allowMulti} onChange={e => setAllowMulti((e.target as HTMLInputElement).checked)} />
              Run anyway, marked as a multi-variable comparison
            </label>
          )}
        </>
      )}

      {step === 1 && (
        <div class="flex flex-col gap-4">
          <section class="uk-card">
            <div class="uk-card-body py-4 flex flex-col gap-5">
              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">Repeats per scenario, per arm</span>
                <input class="uk-input max-w-32" type="number" min={1} max={30} value={repeats} onInput={e => setRepeats(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
                <span class="text-xs text-muted-foreground">
                  {repeats < 3
                    ? 'Below three, single-run noise is around ±30% on cost, and the report will refuse to state a direction.'
                    : repeats < 5
                      ? 'Three is the floor. Five is recommended when the outcome is pass or fail.'
                      : 'Enough repeats to see through single-run noise.'}
                </span>
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">Budget cap for this run (USD)</span>
                <input class="uk-input max-w-32" type="text" value={maxUsd} placeholder="no cap" onInput={(e) => { setBudgetTouched(true); setMaxUsd((e.target as HTMLInputElement).value) }} />
                <span class="text-xs text-muted-foreground">
                  Scheduling stops once spending passes the cap; trials already finished are kept and the report is built from them.
                  {estimate ? ` This run is estimated at ${fmt.usd(estimate.usd, 2)}.` : ''}
                </span>
              </label>

              <div class="flex flex-col gap-1">
                <span class="text-sm font-medium">Isolation</span>
                <p class="text-sm text-muted-foreground">
                  {sandbox === 'auto'
                    ? autoIsolation.container
                      ? <>Each trial runs in its own container, because {autoIsolation.reason}. Slower by twenty seconds or so per trial, and the safe default for code you did not write.</>
                      : <>Each trial runs on this machine under dsh's own workspace sandbox, because {autoIsolation.reason}.</>
                    : sandbox === 'docker'
                      ? <>Forced to a container per trial.</>
                      : <>Forced to this machine, under dsh's own workspace sandbox.</>}
                  {' '}
                  <button class="underline" onClick={() => setAdvanced(true)}>change</button>
                </p>
              </div>
            </div>
          </section>

          <details class="uk-card" open={advanced} onToggle={e => setAdvanced((e.target as HTMLDetailsElement).open)}>
            <summary class="uk-card-header py-3 cursor-pointer text-sm font-medium">Advanced <span class="font-normal text-muted-foreground">defaults are right for almost every run</span></summary>
            <div class="uk-card-body py-3 grid gap-4 md:grid-cols-2">
              <label class="text-sm">Trials in parallel
                <input class="uk-input" type="number" min={1} max={16} value={concurrency} onInput={e => setConcurrency(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
                <span class="text-xs text-muted-foreground">Speed only. Raising it can trip the provider's rate limit.</span>
              </label>
              <label class="text-sm">Label
                <input class="uk-input" type="text" value={label} placeholder="what this run is for" onInput={e => setLabel((e.target as HTMLInputElement).value)} />
              </label>
              <label class="text-sm">Cap per trial (USD)
                <input class="uk-input" type="text" value={maxUsdPerTrial} placeholder="no cap" onInput={e => setMaxUsdPerTrial((e.target as HTMLInputElement).value)} />
                <span class="text-xs text-muted-foreground">A trial that passes its cap stops and counts as a failure.</span>
              </label>
              <label class="text-sm">Where each trial runs
                <select class="uk-select" value={sandbox} onChange={(e) => { const v = (e.target as HTMLSelectElement).value as 'auto' | 'host' | 'docker'; setSandbox(v); setDocker(v === 'docker') }}>
                  <option value="auto">auto — decide from what is linked and available</option>
                  <option value="host">host — dsh's own workspace sandbox, fastest</option>
                  <option value="docker">container per trial</option>
                </select>
              </label>
              <label class="text-sm">Container runtime
                <input class="uk-input" type="text" value={dockerRuntime} placeholder="default · runsc · kata" onInput={e => setDockerRuntime((e.target as HTMLInputElement).value)} />
                <span class="text-xs text-muted-foreground">gVisor or a Kata microVM, when this host provides one.</span>
              </label>
              <label class="flex items-start gap-2 text-sm">
                <input class="uk-checkbox mt-1" type="checkbox" checked={keepDshSandbox} onChange={e => setKeepDshSandbox((e.target as HTMLInputElement).checked)} />
                <span>Keep dsh's own sandbox on inside the container<br /><span class="text-xs text-muted-foreground">Defence in depth; needs a kernel with Landlock or user namespaces.</span></span>
              </label>
              <label class="flex items-start gap-2 text-sm">
                <input class="uk-checkbox mt-1" type="checkbox" checked={sequential} onChange={e => setSequential((e.target as HTMLInputElement).checked)} />
                <span>Stop early once the result is decided<br /><span class="text-xs text-muted-foreground">Saves money on a clear result, but the sequence that decides is wider than a fixed-sample interval, so an unclear one needs more scenarios.</span></span>
              </label>
              {sequential && (
                <div class="flex flex-wrap gap-3 text-sm">
                  <label>seed <input class="uk-input uk-form-sm max-w-24" value={seed} onInput={e => setSeed((e.target as HTMLInputElement).value)} /></label>
                  <label class="flex items-center gap-2"><input class="uk-checkbox" type="checkbox" checked={orderSignal} onChange={e => setOrderSignal((e.target as HTMLInputElement).checked)} /> strongest scenarios first</label>
                </div>
              )}
              {variantScenarios > 0 && (
                <label class="flex items-start gap-2 text-sm">
                  <input class="uk-checkbox mt-1" type="checkbox" checked={perturb} onChange={e => setPerturb((e.target as HTMLInputElement).checked)} />
                  <span>Paraphrase prompts on repeats above one<br /><span class="text-xs text-muted-foreground">{variantScenarios} of the selected scenarios have paraphrases; both arms see the same wording, so the spread includes wording sensitivity.</span></span>
                </label>
              )}
            </div>
          </details>

          {replayRun !== '' && (
            <div class="uk-alert py-2 text-sm">
              This run will replay the recorded responses of <code>{replayRun}</code>{forkAt !== '' ? <> and go live after {forkAt} responses per trial</> : <> with no live calls, so it costs nothing</>}.
              {' '}<button class="underline" onClick={() => { setReplayRun(''); setForkAt('') }}>run live instead</button>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-muted-foreground">
              <b class="text-foreground">{selected.size}</b> of {scenarios.length} selected
              {' · '}<b class="text-foreground">{trials}</b> trials at {repeats} repeat{repeats === 1 ? '' : 's'} across {1 + (aa ? 1 : activeCandidates.length)} arms
              {estimate ? <> · about <b class="text-foreground">{fmt.usd(estimate.usd, 2)}</b> by the archive's history</> : <> · no archive yet to estimate cost</>}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <input class="uk-input uk-form-sm" type="search" placeholder="filter by name or what it stresses" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
              <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setSelected(new Set(visible.map(s => s.name)))}>select all shown</button>
              <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setSelected(new Set())}>clear</button>
              <button class={`uk-btn uk-btn-sm ${showAdd ? 'uk-btn-primary' : 'uk-btn-default'}`} onClick={() => setShowAdd(!showAdd)}>Add your own</button>
            </div>
          </div>

          {showAdd && <ScenarioIntake root={meta?.ownScenarioRoot ?? meta?.scenarioRoot ?? ''} onAdded={() => { setShowAdd(false); void api.scenarios().then(r => { setScenarios(r.scenarios); setInvalid(r.invalid) }) }} />}

          {buckets.map(({ info, rows }) => {
            const chosen = rows.filter(r => selected.has(r.name)).length
            const open = openBuckets.has(info.key) || query !== ''
            return (
              <section class="uk-card" key={info.key}>
                <div class="uk-card-header py-2 flex flex-wrap items-center justify-between gap-2">
                  <button class="flex items-center gap-2 text-left" onClick={() => { const n = new Set(openBuckets); if (n.has(info.key)) n.delete(info.key); else n.add(info.key); setOpenBuckets(n) }}>
                    <span class="text-muted-foreground">{open ? '▾' : '▸'}</span>
                    <span>
                      <span class="text-sm font-medium">{info.title}</span>
                      <span class="text-xs text-muted-foreground"> · {chosen}/{rows.length} selected</span>
                      <span class="block text-xs text-muted-foreground">{info.what}</span>
                    </span>
                  </button>
                  <div class="flex items-center gap-2">
                    <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setSelected(new Set([...selected, ...rows.map(r => r.name)]))}>all</button>
                    <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => { const n = new Set(selected); for (const r of rows) n.delete(r.name); setSelected(n) }}>none</button>
                  </div>
                </div>
                {open && (
                  <div class="uk-card-body py-0">
                    {info.useFor !== '' && <p class="py-2 text-xs text-muted-foreground">Worth running when the change touches {info.useFor}.</p>}
                    <ul class="flex flex-col divide-y divide-border">
                      {rows.map(sc => (
                        <li key={sc.name} class={`flex items-start gap-3 py-2 ${selected.has(sc.name) ? '' : 'opacity-60'}`}>
                          <input class="uk-checkbox mt-1" type="checkbox" checked={selected.has(sc.name)} onChange={() => toggle(sc.name)} />
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-baseline gap-2">
                              <span class="text-sm font-medium">{sc.meta.title ?? sc.name}</span>
                              <code class="text-xs text-muted-foreground">{sc.name}</code>
                              <span class="text-xs text-muted-foreground">{sc.turns} turn{sc.turns === 1 ? '' : 's'}</span>
                              {!sc.hasOracle && <span class="uk-badge badge-xs" title="no reference answer, so selfcheck cannot prove the verifier discriminates">no oracle</span>}
                              {sc.meta.network ? <span class="uk-badge badge-xs">network</span> : null}
                              {sc.meta.judge && <span class="uk-badge badge-xs">judged</span>}
                            </div>
                            <p class="text-xs text-muted-foreground">{sc.meta.stressor ?? ''}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )
          })}
          {invalid.length > 0 && <div class="uk-alert uk-alert-destructive text-sm">{invalid.length} unreadable scenario director{invalid.length === 1 ? 'y' : 'ies'}: {invalid.map(i => `${i.dir}: ${i.error}`).join('; ')}</div>}
        </div>
      )}

      <footer class="sticky bottom-0 flex items-center justify-end gap-4 border-t border-border bg-card px-4 py-3 rounded-md">
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
