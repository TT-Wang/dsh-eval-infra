import { useEffect, useState } from 'preact/hooks'
import { api, type BenchDataset, type BenchTask } from '../api.js'

/**
 * Public benchmarks as a shelf: the index is a few kilobytes and is shown at
 * once; nothing else is downloaded until a task's Get is pressed, which pulls
 * that task's image and writes it into its own pool.
 */
export function PublicBench({ onChanged }: { onChanged: () => void }) {
  const [datasets, setDatasets] = useState<BenchDataset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const load = (refresh = false): void => { api.bench(refresh).then(r => setDatasets(r.datasets)).catch(e => setError(String(e))) }
  useEffect(() => { load() }, [])
  const get = async (dataset: string, task: BenchTask): Promise<void> => {
    setBusy(`${dataset}/${task.id}`); setError(null); setLog([`getting ${task.id}: pulling ${task.image} (linux/amd64${task.imageMb ? `, ${task.imageMb} MB` : ''})…`])
    try { const r = await api.benchGet(dataset, task.id); setLog(r.log); load(); onChanged() } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }
  const rm = async (dataset: string, id: string): Promise<void> => {
    setBusy(`${dataset}/${id}`)
    try { await api.benchRm(dataset, id); load(); onChanged() } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }
  return (
    <section class="uk-card">
      <div class="uk-card-header py-3 flex items-center justify-between gap-3">
        <div>
          <h2 class="uk-card-title text-sm">Public benchmarks</h2>
          <p class="text-xs text-muted-foreground">Separate pools next to the default bench. The list is an index; a task's image is downloaded only when you get it, and every task runs in its own container (linux/amd64).</p>
        </div>
        <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => load(true)}>refresh index</button>
      </div>
      <div class="uk-card-body py-3 flex flex-col gap-3">
        {error && <p class="text-sm text-destructive">{error}</p>}
        {datasets === null && <p class="text-sm text-muted-foreground">loading the index…</p>}
        {datasets?.map((d) => {
          const index = d.index
          const tasks = index !== null && 'tasks' in index ? index.tasks : []
          const err = index !== null && 'error' in index ? index.error : null
          const present = new Set(d.present)
          const isOpen = open === d.id
          return (
            <div key={d.id} class="rounded-md border border-border">
              <button class="w-full flex items-center gap-3 px-3 py-2 text-left" onClick={() => setOpen(isOpen ? null : d.id)}>
                <span class="text-muted-foreground text-xs">{isOpen ? '▾' : '▸'}</span>
                <b class="text-sm">{d.title} {d.version}</b>
                <span class="text-xs text-muted-foreground">{tasks.length} tasks · {d.license} · {present.size} in this project</span>
              </button>
              {isOpen && (
                <div class="border-t border-border">
                  {err && <p class="p-3 text-sm text-destructive">index unavailable: {err}</p>}
                  <div class="scroll-x">
                    <table class="data compact">
                      <thead><tr><th></th><th>task</th><th>category</th><th>difficulty</th><th class="num">expert time</th><th>image</th><th></th></tr></thead>
                      <tbody>
                        {tasks.map((t) => {
                          const here = present.has(t.id)
                          const key = `${d.id}/${t.id}`
                          return (
                            <tr key={t.id}>
                              <td>{here ? <span class="cls same">added</span> : null}</td>
                              <td><code>{t.id}</code></td>
                              <td class="muted small">{t.category ?? '—'}</td>
                              <td class="muted small">{t.difficulty ?? '—'}</td>
                              <td class="num muted small">{t.expertMinutes !== undefined ? `${Math.round(t.expertMinutes / 60 * 10) / 10} h` : '—'}</td>
                              <td class="muted small" title={t.image}>{t.image.replace(/^alexgshaw\//, '')}{t.imageMb ? ` · ${t.imageMb} MB` : ''}</td>
                              <td>
                                {here
                                  ? <button class="uk-btn uk-btn-default uk-btn-xs" disabled={busy !== null} onClick={() => void rm(d.id, t.id)}>{busy === key ? '…' : 'remove'}</button>
                                  : <button class="uk-btn uk-btn-primary uk-btn-xs" disabled={busy !== null} onClick={() => void get(d.id, t)}>{busy === key ? 'getting…' : 'Get'}</button>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {log.length > 0 && <pre class="text-xs text-muted-foreground whitespace-pre-wrap">{log.join('\n')}</pre>}
      </div>
    </section>
  )
}
