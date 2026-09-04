import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, fmt, type ArmInfo, type History, type Meta, type ScenarioInfo } from '../api.js'
import { navigate } from '../main.js'
import { pickCandidates } from '../select-arms.js'

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

  return (
    <section class="new-run">
      <div class="page-head"><h1>New run</h1>{meta && !meta.profileReady && <p class="error">The eval profile is not initialised: run <code>dsh-eval init</code> first.</p>}</div>
      {error && <p class="error">{error}</p>}
      <div class="grid2">
        <div class="card">
          <h2>Arms</h2>
          <label>Baseline
            <select value={baseline} onChange={(e) => { const next = (e.target as HTMLSelectElement).value; setBaseline(next); setCandidates(pickCandidates(candidates, next, armNames)) }}>
              {armNames.map(n => <option value={n}>{n}</option>)}
            </select>
          </label>
          <label class="check"><input type="checkbox" checked={aa} onChange={e => setAa((e.target as HTMLInputElement).checked)} /> A/A run (baseline against a copy of itself — measures the noise floor)</label>
          {!aa && (
            <fieldset>
              <legend>Candidates</legend>
              {armNames.filter(n => n !== baseline).map(n => (
                <label class="check"><input type="checkbox" checked={candidates.includes(n)} onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setCandidates(on ? [...candidates, n] : candidates.filter(c => c !== n)) }} /> {n}<span class="muted small"> {arms.find(a => a.spec?.name === n)?.spec?.description ?? ''}</span></label>
              ))}
              {armNames.length < 2 && <p class="muted small">Add arm files under <code>{meta?.armsDir}</code>.</p>}
            </fieldset>
          )}
          <div class="diff">
            <h3>What differs</h3>
            {diffError && <p class="error small">{diffError}</p>}
            {diff === null && !diffError && <p class="muted small">composing trees through <code>dsh --dump-config</code>…</p>}
            {diff?.map(d => (
              <div class={`diff-arm ${d.variables === 1 ? 'ok' : 'warn'}`}>
                <b>{d.candidate}</b> vs {baseline}: {d.variables} variable{d.variables === 1 ? '' : 's'}
                <ul>{d.lines.map(l => <li><code>{l}</code></li>)}</ul>
              </div>
            ))}
            {multi && <p class="warn-text">More than one variable differs; the result cannot be attributed to one change. <label class="check inline"><input type="checkbox" checked={allowMulti} onChange={e => setAllowMulti((e.target as HTMLInputElement).checked)} /> run anyway (marked multi-variable)</label></p>}
            {identical && !aa && <p class="warn-text">The arms compose identically — this would be an A/A run.</p>}
          </div>
        </div>
        <div class="card">
          <h2>Design</h2>
          <div class="row">
            <label>Repeats <input type="number" min={1} max={30} value={repeats} onInput={e => setRepeats(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} /></label>
            <label>Concurrency <input type="number" min={1} max={8} value={concurrency} onInput={e => setConcurrency(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} /></label>
            <label>Label <input type="text" value={label} placeholder="optional" onInput={e => setLabel((e.target as HTMLInputElement).value)} /></label>
          </div>
          <div class="row wrap">
            <label>Isolation <select value={sandbox} onChange={e => { const v = (e.target as HTMLSelectElement).value as 'auto' | 'host' | 'docker'; setSandbox(v); setDocker(v === 'docker') }}>
              <option value="auto">auto (container when third-party plugins are linked and Docker is available)</option>
              <option value="host">host (dsh workspace-write sandbox)</option>
              <option value="docker">Docker container per trial</option>
            </select></label>
            <label>Container runtime <input type="text" value={dockerRuntime} placeholder="default · runsc · kata" onInput={e => setDockerRuntime((e.target as HTMLInputElement).value)} /></label>
            <label class="check"><input type="checkbox" checked={keepDshSandbox} onChange={e => setKeepDshSandbox((e.target as HTMLInputElement).checked)} /> keep dsh's own sandbox on inside the container (defence in depth; needs Landlock or user namespaces)</label>
          </div>
          <div class="row wrap">
            <label class="check"><input type="checkbox" checked={sequential} onChange={e => setSequential((e.target as HTMLInputElement).checked)} /> Sequential (stop as soon as the anytime-valid sequences decide)</label>
            {sequential && <label>seed <input type="text" value={seed} onInput={e => setSeed((e.target as HTMLInputElement).value)} /></label>}
            {sequential && <label class="check"><input type="checkbox" checked={orderSignal} onChange={e => setOrderSignal((e.target as HTMLInputElement).checked)} /> order by archive signal (strongest scenarios first)</label>}
            <label class="check"><input type="checkbox" checked={perturb} onChange={e => setPerturb((e.target as HTMLInputElement).checked)} /> Perturb prompts on repeats above 1 (scenarios with prompts.variants.json; same variant for every arm)</label>
          </div>
          <div class="row wrap">
            <label>Replay recorded responses from <select value={replayRun} onChange={e => setReplayRun((e.target as HTMLSelectElement).value)}>
              <option value="">— live run —</option>
              {runsList.map(r => <option value={r.id}>{r.id}{r.label ? ` · ${r.label}` : ''}</option>)}
            </select></label>
            {replayRun !== '' && <label>fork after N recorded responses (empty = pure replay, no key needed) <input type="text" value={forkAt} placeholder="e.g. 3" onInput={e => setForkAt((e.target as HTMLInputElement).value)} /></label>}
            <label>Per-trial cap (USD) <input type="text" value={maxUsdPerTrial} placeholder="optional" onInput={e => setMaxUsdPerTrial((e.target as HTMLInputElement).value)} /></label>
          </div>
          <p class="muted small">Arms interleave per repeat (A B, then B A), each trial in a fresh workspace and a fresh runtime process. Three repeats is the floor; five is recommended for binary outcomes; use A/A first to learn the noise floor.</p>
          <p><b>{selected.size}</b> scenarios × <b>{repeats}</b> repeats × <b>{1 + (aa ? 1 : candidates.length)}</b> arms = <b>{trials}</b> trials{estimate ? <span class="muted"> · about {fmt.usd(estimate.usd, 2)} ({estimate.seen}/{selected.size} scenarios have archive history; the rest use the archive mean of {fmt.usd(estimate.perTrial, 4)} per trial)</span> : <span class="muted"> · no archive yet to estimate cost</span>}</p>
          <label>Budget cap (USD) <input type="text" value={maxUsd} placeholder="optional" onInput={e => setMaxUsd((e.target as HTMLInputElement).value)} /></label>
          <p class="muted small">Detectability: with {selected.size} scenarios the run can resolve a cost effect roughly of size 2.5 × (per-scenario spread) / √{selected.size}; a first A/A run tells you the spread. Fewer than 3 comparable scenarios never yields a direction.</p>
          <button class="btn primary" disabled={busy || baseline === '' || (!aa && activeCandidates.length === 0) || selected.size === 0 || (multi && !allowMulti)} onClick={() => void start()}>{busy ? 'starting…' : 'Start run'}</button>
          <p class="muted small">Every scenario is self-checked (oracle must pass, untouched workspace must fail) before the first trial.</p>
        </div>
      </div>
      <div class="card">
        <div class="row between">
          <h2>Scenarios <span class="muted">({selected.size}/{scenarios.length})</span></h2>
          <div class="row">
            <input type="search" placeholder="filter" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
            <select value={category} onChange={e => setCategory((e.target as HTMLSelectElement).value)}>
              <option value="">all categories</option>
              {categories.map(c => <option value={c}>{c}</option>)}
            </select>
            <button class="btn" onClick={() => setSelected(new Set([...selected, ...visible.map(s => s.name)]))}>select visible</button>
            <button class="btn" onClick={() => { const n = new Set(selected); for (const s of visible) n.delete(s.name); setSelected(n) }}>clear visible</button>
          </div>
        </div>
        <table class="data">
          <thead><tr><th></th><th>scenario</th><th>category</th><th class="num">turns</th><th>oracle</th><th>stresses</th></tr></thead>
          <tbody>
            {visible.map(s => (
              <tr key={s.name} class={selected.has(s.name) ? '' : 'dim'}>
                <td><input type="checkbox" checked={selected.has(s.name)} onChange={() => toggle(s.name)} /></td>
                <td><code>{s.name}</code>{s.meta.new_session_before_turns?.length ? <span class="tag">multi-session</span> : null}{s.meta.network ? <span class="tag">network</span> : null}</td>
                <td>{s.meta.category ?? '—'}</td>
                <td class="num">{s.turns}</td>
                <td>{s.hasOracle ? 'yes' : <span class="warn-text">none</span>}</td>
                <td class="muted small">{s.meta.stressor ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {invalid.length > 0 && <p class="error small">{invalid.length} invalid scenario dir(s): {invalid.map(i => `${i.dir}: ${i.error}`).join('; ')}</p>}
      </div>
    </section>
  )
}
