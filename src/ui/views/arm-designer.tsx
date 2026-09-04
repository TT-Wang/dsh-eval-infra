/**
 * Step 1 of a new run: design the two arms side by side.
 *
 * An arm is a preset, so it is shown as one: the left column is what dsh does
 * with nothing added, the right column is the candidate's list of deliberate
 * differences, and the shelf beside it holds every dsh plugin found on this
 * machine. Dragging a plugin onto the candidate adds it; dragging a card off,
 * or pressing its remove button, takes it away. The variable count under the
 * columns is the one-variable rule, live.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, type ArmInfo, type Meta, type PluginInfo, type RowInfo } from '../api.js'
import { armToYaml, describeRow, designFromSpec, variableCount, type ArmDesign, type DesignRow } from '../arm-model.js'

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
const EFFORTS = ['off', 'low', 'high', 'max']

export function ArmDesigner({ meta, arms, baseline, candidate, onBaseline, onCandidate, onSaved }: {
  meta: Meta | null
  arms: ArmInfo[]
  baseline: string
  candidate: string
  onBaseline: (name: string) => void
  onCandidate: (name: string) => void
  onSaved: () => void
}) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [rows, setRows] = useState<RowInfo[]>([])
  const [design, setDesign] = useState<ArmDesign | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [over, setOver] = useState(false)
  const [showOff, setShowOff] = useState(false)

  const armNames = arms.filter(a => a.spec).map(a => a.spec!.name)
  const baselineSpec = arms.find(a => a.spec?.name === baseline)?.spec
  const candidateSpec = arms.find(a => a.spec?.name === candidate)?.spec

  useEffect(() => { api.plugins().then(r => setPlugins(r.plugins)).catch(() => setPlugins([])) }, [])
  useEffect(() => { api.rows(baseline).then(r => setRows(r.rows)).catch(() => setRows([])) }, [baseline])
  useEffect(() => {
    if (candidateSpec === undefined) { setDesign(null); return }
    setDesign(designFromSpec(candidateSpec))
    setDirty(false)
  }, [candidate, candidateSpec?.name])

  const baselineDesign = baselineSpec === undefined ? null : designFromSpec(baselineSpec)
  const used = useMemo(() => new Set((design?.rows ?? []).flatMap(r => (r.kind === 'insert' ? [r.name] : []))), [design])
  const shelf = plugins.filter(p => !used.has(p.name) && p.name !== '@dsh-external/dsh-eval-infra'
    && (query === '' || p.name.toLowerCase().includes(query.toLowerCase()) || (p.description ?? '').toLowerCase().includes(query.toLowerCase())))

  const change = (next: ArmDesign): void => { setDesign(next); setDirty(true) }
  /** Set or clear an optional field without letting `undefined` through an exact-optional type. */
  const setField = (field: 'model' | 'effort', value: string): void => {
    if (design === null) return
    const { model, effort, ...rest } = design
    const kept = { ...rest, ...(field === 'model' ? {} : model !== undefined ? { model } : {}), ...(field === 'effort' ? {} : effort !== undefined ? { effort } : {}) }
    change(value === '' ? kept : { ...kept, [field]: value })
  }
  const addPlugin = (p: PluginInfo): void => {
    if (design === null || used.has(p.name)) return
    change({ ...design, rows: [...design.rows, { kind: 'insert', id: p.rowId, name: p.name }] })
  }
  const removeRow = (index: number): void => {
    if (design === null) return
    change({ ...design, rows: design.rows.filter((_, i) => i !== index) })
  }
  const turnOff = (id: string): void => {
    if (design === null || id === '') return
    change({ ...design, rows: [...design.rows, { kind: 'disable', id }] })
    setShowOff(false)
  }
  const save = async (): Promise<void> => {
    if (design === null) return
    setSaving(true)
    setError(null)
    try { await api.saveArm(design.name, armToYaml(design)); setDirty(false); onSaved() }
    catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }

  const variables = design === null ? 0 : variableCount(design)
  const tone = variables === 0 ? 'uk-alert' : variables === 1 ? 'uk-alert' : 'uk-alert'

  return (
    <div class="flex flex-col gap-4">
      <div class="grid gap-4 designer-grid">
        {/* A: baseline */}
        <section class="uk-card">
          <div class="uk-card-header flex items-center justify-between gap-2 py-3">
            <div>
              <div class="text-xs uppercase tracking-wide text-muted-foreground">Arm A · baseline</div>
              <select class="uk-select uk-form-sm mt-1" value={baseline} onChange={e => onBaseline((e.target as HTMLSelectElement).value)}>
                {armNames.map(n => <option value={n}>{n}</option>)}
              </select>
            </div>
            <span class="uk-badge uk-badge">reference</span>
          </div>
          <div class="uk-card-body py-3">
            <p class="text-sm text-muted-foreground">Stock dsh composes {rows.length || '…'} components. Anything below is what this arm changes on top of that.</p>
            <div class="mt-3 flex flex-col gap-2">
              {(baselineDesign?.rows ?? []).map(r => <RowCard key={describeRow(r)} row={r} />)}
              {(baselineDesign?.rows ?? []).length === 0 && (
                <div class="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">nothing added — this is dsh as it ships</div>
              )}
            </div>
          </div>
        </section>

        {/* B: candidate, the drop target */}
        <section
          class={`uk-card transition-colors ${over ? 'drop-target' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const name = e.dataTransfer?.getData('text/plain') ?? ''
            const plugin = plugins.find(p => p.name === name)
            if (plugin) addPlugin(plugin)
          }}
        >
          <div class="uk-card-header flex items-center justify-between gap-2 py-3">
            <div>
              <div class="text-xs uppercase tracking-wide text-muted-foreground">Arm B · candidate</div>
              <select class="uk-select uk-form-sm mt-1" value={candidate} onChange={e => onCandidate((e.target as HTMLSelectElement).value)}>
                {armNames.filter(n => n !== baseline).map(n => <option value={n}>{n}</option>)}
              </select>
            </div>
            {dirty && <button class="uk-btn uk-btn-primary uk-btn-sm" disabled={saving} onClick={() => void save()}>{saving ? 'saving…' : 'Save arm'}</button>}
          </div>
          <div class="uk-card-body py-3">
            <div class="flex flex-col gap-2">
              {(design?.rows ?? []).map((r, i) => <RowCard key={`${r.kind}-${i}`} row={r} onRemove={() => removeRow(i)} />)}
              {(design?.rows ?? []).length === 0 && (
                <div class="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  drag a plugin here, or turn a stock component off
                </div>
              )}
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button class="uk-btn uk-btn-default uk-btn-sm" onClick={() => setShowOff(!showOff)}>turn a component off</button>
              <label class="text-sm text-muted-foreground flex items-center gap-1">model
                <select class="uk-select uk-form-sm" value={design?.model ?? ''} onChange={e => setField('model', (e.target as HTMLSelectElement).value)}>
                  <option value="">same as baseline</option>
                  {MODELS.map(m => <option value={m}>{m}</option>)}
                </select>
              </label>
              <label class="text-sm text-muted-foreground flex items-center gap-1">effort
                <select class="uk-select uk-form-sm" value={design?.effort ?? ''} onChange={e => setField('effort', (e.target as HTMLSelectElement).value)}>
                  <option value="">same as baseline</option>
                  {EFFORTS.map(m => <option value={m}>{m}</option>)}
                </select>
              </label>
            </div>
            {showOff && (
              <select class="uk-select uk-form-sm mt-2" onChange={e => turnOff((e.target as HTMLSelectElement).value)}>
                <option value="">— pick a component of the composed tree —</option>
                {rows.map(r => <option value={r.id}>{r.id}{r.configKeys.length ? ` · ${r.configKeys.length} config field(s)` : ''}</option>)}
              </select>
            )}
            {error !== null && <p class="text-destructive text-sm mt-2">{error}</p>}
          </div>
        </section>

        {/* the shelf */}
        <section class="uk-card">
          <div class="uk-card-header py-3">
            <div class="text-xs uppercase tracking-wide text-muted-foreground">Plugins on this machine</div>
            <input class="uk-input uk-form-sm mt-2" type="search" placeholder="filter" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
          </div>
          <div class="uk-card-body py-3 shelf-scroll flex flex-col gap-2">
            {shelf.map(p => (
              <article
                key={p.name}
                class="plugin-chip rounded-md border border-border bg-background px-2 py-1.5 cursor-grab"
                draggable
                onDragStart={(e) => { e.dataTransfer?.setData('text/plain', p.name); e.dataTransfer!.effectAllowed = 'copy' }}
                onDblClick={() => addPlugin(p)}
                title={`${p.path}\ndouble-click or drag into arm B`}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium truncate">{p.rowId}</span>
                  <button class="uk-btn uk-btn-default uk-btn-xs" onClick={() => addPlugin(p)}>add</button>
                </div>
                <div class="text-xs text-muted-foreground truncate">{p.description ?? p.name}</div>
                <div class="mt-1 flex gap-1">
                  {p.installed && <span class="uk-badge uk-badge badge-xs">installed</span>}
                  {p.bundle && <span class="uk-badge badge-xs" title="a profile layer, not a single row">bundle</span>}
                  <span class="uk-badge uk-badge badge-xs">{p.source}</span>
                </div>
              </article>
            ))}
            {shelf.length === 0 && <p class="text-sm text-muted-foreground">nothing left to add</p>}
          </div>
        </section>
      </div>

      <div class={`uk-alert ${tone} py-2`}>
        {variables === 1 && <span><b>One variable.</b> Arm B differs from arm A in exactly one thing, so a difference in the result can be attributed to it.</span>}
        {variables === 0 && <span><b>No difference yet.</b> Arm B composes the same as arm A; this would be an A/A run, which measures the noise floor.</span>}
        {variables > 1 && <span><b>{variables} variables.</b> A result cannot be attributed to one change. Split them into separate candidates, or accept a multi-variable comparison in the next step.</span>}
        {dirty && <span class="text-muted-foreground"> · unsaved changes to <code>{design?.name}</code></span>}
      </div>
    </div>
  )
}

function RowCard({ row, onRemove }: { row: DesignRow; onRemove?: () => void }) {
  const tone = row.kind === 'insert' ? 'row-insert' : row.kind === 'disable' ? 'row-disable' : 'row-other'
  return (
    <article class={`rounded-md border border-border border-l-2 ${tone} bg-background px-3 py-2 flex items-start justify-between gap-2`}>
      <div class="min-w-0">
        <div class="text-sm font-medium truncate">{row.kind === 'insert' ? row.id : row.kind === 'raw' ? 'custom' : row.id}</div>
        <div class="text-xs text-muted-foreground truncate">{describeRow(row)}</div>
        {row.kind === 'insert' && row.config !== undefined && (
          <div class="text-xs text-muted-foreground">{Object.entries(row.config).map(([k, v]) => `${k} = ${String(v)}`).join(' · ')}</div>
        )}
      </div>
      {onRemove !== undefined && <button class="uk-btn uk-btn-default uk-btn-xs" title="remove from this arm" onClick={onRemove}>×</button>}
    </article>
  )
}
