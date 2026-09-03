import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, type ArmInfo, type Meta, type ScenarioInfo } from '../api.js'
import { navigate } from '../main.js'

export function NewRunView() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [arms, setArms] = useState<ArmInfo[]>([])
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
  const [invalid, setInvalid] = useState<Array<{ dir: string; error: string }>>([])
  const [baseline, setBaseline] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [repeats, setRepeats] = useState(3)
  const [concurrency, setConcurrency] = useState(2)
  const [label, setLabel] = useState('')
  const [allowMulti, setAllowMulti] = useState(false)
  const [aa, setAa] = useState(false)
  const [diff, setDiff] = useState<Array<{ candidate: string; variables: number; lines: string[] }> | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  }, [])

  useEffect(() => {
    if (baseline === '' || (candidates.length === 0 && !aa)) { setDiff(null); return }
    let cancelled = false
    setDiffError(null)
    api.diff(baseline, aa ? [] : candidates).then((r) => { if (!cancelled) setDiff(r.diffs) }).catch((e) => { if (!cancelled) { setDiff(null); setDiffError(String(e)) } })
    return () => { cancelled = true }
  }, [baseline, candidates.join(','), aa])

  const armNames = arms.filter(a => a.spec).map(a => a.spec!.name)
  const categories = useMemo(() => [...new Set(scenarios.map(s => s.meta.category ?? 'uncategorised'))].sort(), [scenarios])
  const visible = scenarios.filter(s => (category === '' || (s.meta.category ?? 'uncategorised') === category) && (query === '' || s.name.includes(query) || (s.meta.stressor ?? '').toLowerCase().includes(query.toLowerCase())))
  const trials = selected.size * repeats * (1 + (aa ? 1 : candidates.length))
  const multi = diff?.some(d => d.variables > 1) ?? false
  const identical = diff?.some(d => d.variables === 0) ?? false

  const toggle = (name: string): void => { const n = new Set(selected); if (n.has(name)) n.delete(name); else n.add(name); setSelected(n) }
  const start = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const { id } = await api.start({ baseline, candidates: aa ? [] : candidates, scenarios: [...selected], repeats, concurrency, label: label || undefined, allowMulti, aa })
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
            <select value={baseline} onChange={e => setBaseline((e.target as HTMLSelectElement).value)}>
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
          <p class="muted small">Arms interleave per repeat (A B, then B A), each trial in a fresh workspace and a fresh runtime process. Three repeats is the floor; five is recommended for binary outcomes; use A/A first to learn the noise floor.</p>
          <p><b>{selected.size}</b> scenarios × <b>{repeats}</b> repeats × <b>{1 + (aa ? 1 : candidates.length)}</b> arms = <b>{trials}</b> trials</p>
          <button class="btn primary" disabled={busy || baseline === '' || (!aa && candidates.length === 0) || selected.size === 0 || (multi && !allowMulti)} onClick={() => void start()}>{busy ? 'starting…' : 'Start run'}</button>
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
