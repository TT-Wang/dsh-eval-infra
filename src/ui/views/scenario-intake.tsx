/**
 * Adding your own scenario.
 *
 * A scenario is a small directory, so the panel says exactly what that
 * directory holds, then takes one: pick the folder and the browser hands over
 * its files, or start from the template and edit in place. Either way the
 * server writes it into the project's library and immediately selfchecks it,
 * because the one mistake that quietly ruins every later comparison is a
 * verifier that says pass no matter what.
 */
import { useState } from 'preact/hooks'
import { api, type IntakeResult } from '../api.js'

const FILES: Array<{ name: string; required: boolean; what: string }> = [
  { name: 'meta.json', required: true, what: 'name, title, how many turns, category, and one line on what it stresses' },
  { name: 'prompts.json', required: true, what: 'the task as a user would type it, one string per turn' },
  { name: 'setup.py', required: false, what: 'def setup(root): build the starting workspace, same bytes every run' },
  { name: 'verify.py', required: true, what: 'def verify(root): return (ok, detail) — reads the end state only, never the transcript' },
  { name: 'oracle.py', required: false, what: 'def solve(root): the reference answer, used to prove the verifier accepts a correct one' },
]

export function ScenarioIntake({ root, onAdded }: { root: string; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [files, setFiles] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IntakeResult | null>(null)

  const takeFolder = async (list: FileList | null): Promise<void> => {
    if (list === null) return
    setError(null)
    setResult(null)
    const picked: Record<string, string> = {}
    let folder = ''
    for (const file of Array.from(list)) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name
      const parts = rel.split('/')
      folder = parts.length > 1 ? parts[0]! : folder
      const base = parts[parts.length - 1]!
      if (!FILES.some(f => f.name === base) && base !== 'prompts.variants.json') continue
      picked[base] = await file.text()
    }
    if (Object.keys(picked).length === 0) { setError('that folder holds none of the files a scenario is made of'); return }
    setFiles(picked)
    if (name === '' && folder !== '') setName(folder)
  }

  const useTemplate = async (): Promise<void> => {
    const id = name === '' ? 'my_scenario' : name
    setName(id)
    setFiles(await api.scenarioTemplate(id))
    setResult(null)
    setError(null)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.addScenario(name, files)
      setResult(r)
      onAdded()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  return (
    <section class="uk-card">
      <div class="uk-card-header py-3">
        <h2 class="uk-card-title text-sm">Add your own scenario</h2>
        <p class="text-xs text-muted-foreground">A scenario is a folder of five files. It is written into this project's own library at <code>{root === '' ? 'bench/scenarios' : root}</code>, alongside the ones that ship with the tool, and checked before it is offered.</p>
      </div>
      <div class="uk-card-body py-3 flex flex-col gap-3">
        <ul class="text-xs flex flex-col gap-1">
          {FILES.map(f => (
            <li key={f.name} class="flex gap-2">
              <code class="w-40 shrink-0">{f.name}</code>
              <span class="text-muted-foreground">{f.what}{f.required ? '' : ' · optional'}</span>
            </li>
          ))}
        </ul>

        <div class="flex flex-wrap items-center gap-3">
          <label class="uk-btn uk-btn-default uk-btn-sm cursor-pointer">
            Choose a folder
            <input class="hidden" type="file" multiple {...{ webkitdirectory: 'true', directory: 'true' }} onChange={e => void takeFolder((e.target as HTMLInputElement).files)} />
          </label>
          <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => void useTemplate()}>Start from the template</button>
          <label class="text-sm flex items-center gap-2">name <input class="uk-input uk-form-sm" value={name} placeholder="my_scenario" onInput={e => setName((e.target as HTMLInputElement).value)} /></label>
        </div>

        {Object.keys(files).length > 0 && (
          <div class="flex flex-col gap-2">
            {FILES.filter(f => files[f.name] !== undefined).map(f => (
              <label key={f.name} class="text-xs">
                <code>{f.name}</code>
                <textarea class="uk-textarea yaml mt-1" rows={f.name === 'meta.json' ? 8 : 6} value={files[f.name]} onInput={e => setFiles({ ...files, [f.name]: (e.target as HTMLTextAreaElement).value })} />
              </label>
            ))}
          </div>
        )}

        {error !== null && <div class="uk-alert uk-alert-destructive text-sm">{error}</div>}
        {result !== null && (
          <div class={`uk-alert text-sm ${result.selfcheck.ok ? '' : 'uk-alert-destructive'}`}>
            <b>{result.name}</b> written to <code>{result.dir}</code>.
            {' '}{result.selfcheck.ok ? 'Selfcheck passed: ' : 'Selfcheck failed: '}{result.selfcheck.detail}
            {!result.selfcheck.ok && ' Fix the verifier before running it, or every comparison that uses it measures nothing.'}
          </div>
        )}

        <div>
          <button class="uk-btn uk-btn-primary uk-btn-sm" disabled={busy || name === '' || Object.keys(files).length === 0} onClick={() => void submit()}>
            {busy ? 'checking…' : 'Add and selfcheck'}
          </button>
        </div>
      </div>
    </section>
  )
}
