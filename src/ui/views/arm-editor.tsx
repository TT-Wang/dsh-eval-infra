/**
 * Arm editor. An arm is one YAML file, and this panel writes that file for you:
 * pick the kind of change, pick the row or plugin from what is actually
 * installed, and the YAML below updates. The text area stays editable and is
 * what gets saved, so nothing the builder cannot express is out of reach.
 */
import { useEffect, useState } from 'preact/hooks'
import { api, type ArmInfo, type Meta, type RowInfo } from '../api.js'
import { armYaml, EFFORTS, MODELS, type Change } from '../arm-yaml.js'

export function ArmEditor({ meta, arms, baseline, editing, onClose, onSaved }: {
  meta: Meta | null
  arms: ArmInfo[]
  baseline: string
  /** Name of the arm being edited, or '' for a new one. */
  editing: string
  onClose: () => void
  onSaved: (name: string) => void
}) {
  const existing = arms.find(a => a.spec?.name === editing)
  const [name, setName] = useState(editing || 'candidate-2')
  const [description, setDescription] = useState(existing?.spec?.description ?? '')
  const [change, setChange] = useState<Change>('insert-plugin')
  const [plugin, setPlugin] = useState('')
  const [row, setRow] = useState('')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [model, setModel] = useState(MODELS[0]!)
  const [effort, setEffort] = useState('high')
  const [text, setText] = useState(existing?.text ?? '')
  const [rows, setRows] = useState<RowInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(editing !== '')

  useEffect(() => { api.rows(baseline).then(r => setRows(r.rows)).catch(() => setRows([])) }, [baseline])
  useEffect(() => {
    if (touched) return
    setText(armYaml(name, description, change, { plugin, row, key, value, model, effort }))
  }, [touched, name, description, change, plugin, row, key, value, model, effort])

  const plugins = meta?.plugins ?? []
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await api.saveArm(name, text); onSaved(name) } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!existing) return
    setBusy(true)
    try { await api.deleteArm(editing); onSaved('') } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  return (
    <div class="arm-editor">
      <div class="row between">
        <h3>{editing ? `Edit arm ${editing}` : 'New arm'}</h3>
        <div class="row">
          {existing && <button class="btn small danger" disabled={busy} onClick={() => void remove()}>delete</button>}
          <button class="btn small" onClick={onClose}>close</button>
        </div>
      </div>
      <div class="row wrap">
        <label>Name <input type="text" value={name} disabled={editing !== ''} onInput={(e) => { setName((e.target as HTMLInputElement).value); setTouched(false) }} /></label>
        <label class="grow">Description <input type="text" value={description} placeholder="what this arm changes, in one line" onInput={(e) => { setDescription((e.target as HTMLInputElement).value); setTouched(false) }} /></label>
      </div>
      <div class="row wrap">
        <label>Change
          <select value={change} onChange={(e) => { setChange((e.target as HTMLSelectElement).value as Change); setTouched(false) }}>
            <option value="insert-plugin">add a plugin</option>
            <option value="disable-row">turn a component off</option>
            <option value="config-field">change one config field</option>
            <option value="model">change the model</option>
            <option value="effort">change the reasoning effort</option>
            <option value="freeform">write the YAML myself</option>
          </select>
        </label>
        {change === 'insert-plugin' && (
          <label class="grow">Plugin
            <select value={plugin} onChange={(e) => { setPlugin((e.target as HTMLSelectElement).value); setTouched(false) }}>
              <option value="">— pick one installed in the eval profile —</option>
              {plugins.map(p => <option value={p}>{p}</option>)}
            </select>
          </label>
        )}
        {(change === 'disable-row' || change === 'config-field') && (
          <label class="grow">Component
            <select value={row} onChange={(e) => { const id = (e.target as HTMLSelectElement).value; setRow(id); const r = rows.find(x => x.id === id); if (r && r.configKeys[0] !== undefined) { setKey(r.configKeys[0]); setValue(String(r.config?.[r.configKeys[0]] ?? '')) } setTouched(false) }}>
              <option value="">— pick a row of the composed tree —</option>
              {rows.map(r => <option value={r.id}>{r.id}{r.configKeys.length ? ` · ${r.configKeys.length} config field(s)` : ''}</option>)}
            </select>
          </label>
        )}
        {change === 'config-field' && (
          <>
            <label>Field
              <select value={key} onChange={(e) => { const k = (e.target as HTMLSelectElement).value; setKey(k); const r = rows.find(x => x.id === row); setValue(String(r?.config?.[k] ?? '')); setTouched(false) }}>
                {(rows.find(r => r.id === row)?.configKeys ?? []).map(k => <option value={k}>{k}</option>)}
              </select>
            </label>
            <label>Value <input type="text" value={value} onInput={(e) => { setValue((e.target as HTMLInputElement).value); setTouched(false) }} /></label>
          </>
        )}
        {change === 'model' && <label>Model <select value={model} onChange={(e) => { setModel((e.target as HTMLSelectElement).value); setTouched(false) }}>{MODELS.map(m => <option value={m}>{m}</option>)}</select></label>}
        {change === 'effort' && <label>Effort <select value={effort} onChange={(e) => { setEffort((e.target as HTMLSelectElement).value); setTouched(false) }}>{EFFORTS.map(m => <option value={m}>{m}</option>)}</select></label>}
      </div>
      <label class="block">Arm file <span class="muted small">this text is what gets saved; edit it freely</span>
        <textarea class="yaml" rows={10} value={text} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); setTouched(true) }} />
      </label>
      {error && <p class="error small">{error}</p>}
      <div class="row">
        <button class="btn primary" disabled={busy || name.trim() === '' || text.trim() === ''} onClick={() => void save()}>{busy ? 'saving…' : 'Save arm'}</button>
        <span class="muted small">saved to {meta?.armsDir}/{name}.yml, then compared against <b>{baseline}</b></span>
      </div>
    </div>
  )
}
