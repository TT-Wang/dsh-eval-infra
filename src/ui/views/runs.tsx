import { useEffect, useState } from 'preact/hooks'
import { api, fmt, type Meta } from '../api.js'
import type { RunIndexEntry } from '../../core/types.js'

export function RunsView() {
  const [runs, setRuns] = useState<RunIndexEntry[] | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.meta().then(setMeta).catch(e => setError(String(e)))
    const load = (): void => { api.runs().then(setRuns).catch(e => setError(String(e))) }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  return (
    <section>
      <div class="page-head">
        <div>
          <h1>Runs</h1>
          {meta && <p class="muted">project <code>{meta.project}</code> · profile <b>{meta.profile}</b>{meta.profileReady ? '' : ' (not initialised — run dsh-eval init)'} · plugins: {meta.plugins.length ? meta.plugins.join(', ') : 'none'} · scenarios <code>{meta.scenarioRoot}</code></p>}
        </div>
        <a class="btn primary" href="#/new">New run</a>
      </div>
      {error && <p class="error">{error}</p>}
      {runs === null ? <p class="muted">loading…</p> : runs.length === 0 ? (
        <div class="empty">
          <p>No runs yet.</p>
          <p class="muted">Start one here with <a href="#/new">New run</a> or from a shell: <code>dsh-eval run --baseline baseline --arm candidate</code></p>
        </div>
      ) : (
        <table class="data">
          <thead><tr><th>run</th><th>status</th><th>arms</th><th class="num">scenarios</th><th class="num">repeats</th><th class="num">trials</th><th class="num">cost</th><th>label</th></tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td><a href={`#/run/${r.id}`}><code>{r.id}</code></a><div class="muted small">{fmt.time(r.createdAt)}</div></td>
                <td><span class={`status ${r.status}`}>{r.status}</span></td>
                <td>{r.arms.join(' vs ')}</td>
                <td class="num">{r.scenarios}</td>
                <td class="num">{r.repeats}</td>
                <td class="num">{r.completed}/{r.total}</td>
                <td class="num">{fmt.usd(r.usd, 3)}</td>
                <td>{r.label ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
