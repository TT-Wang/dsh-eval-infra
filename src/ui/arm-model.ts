/**
 * An arm is a preset: a baseline plus a short list of deliberate differences.
 * The designer edits that list directly, so the shapes an arm file can hold are
 * modelled here and serialised back to YAML. Anything the designer does not
 * model is carried through untouched, so hand-written arms survive a visit.
 */

export interface InsertRow { kind: 'insert'; id: string; name: string; config?: Record<string, unknown> }
export interface DisableRow { kind: 'disable'; id: string }
export interface ConfigRow { kind: 'config'; id: string; config: Record<string, unknown> }
export interface RawRow { kind: 'raw'; row: unknown }
export type DesignRow = InsertRow | DisableRow | ConfigRow | RawRow

export interface ArmDesign {
  name: string
  description?: string
  model?: string
  effort?: string
  rows: DesignRow[]
}

interface ArmSpecLike {
  name: string
  description?: string
  model?: string
  effort?: string
  patches?: unknown[]
}

/** Read an arm file's parsed spec into the designer's model. */
export function designFromSpec(spec: ArmSpecLike): ArmDesign {
  const rows: DesignRow[] = []
  for (const patch of spec.patches ?? []) {
    if (patch === null || typeof patch !== 'object') { rows.push({ kind: 'raw', row: patch }); continue }
    const p = patch as Record<string, unknown>
    if (Array.isArray(p['insert'])) {
      let modelled = true
      for (const entry of p['insert']) {
        if (entry === null || typeof entry !== 'object') { modelled = false; break }
        const e = entry as Record<string, unknown>
        if (typeof e['id'] !== 'string' || typeof e['name'] !== 'string') { modelled = false; break }
      }
      if (modelled) {
        for (const entry of p['insert'] as Array<Record<string, unknown>>) {
          rows.push({
            kind: 'insert',
            id: entry['id'] as string,
            name: entry['name'] as string,
            ...(entry['config'] !== null && typeof entry['config'] === 'object' ? { config: entry['config'] as Record<string, unknown> } : {}),
          })
        }
        continue
      }
    }
    if (typeof p['id'] === 'string' && p['disabled'] === true) { rows.push({ kind: 'disable', id: p['id'] }); continue }
    if (typeof p['id'] === 'string' && p['config'] !== null && typeof p['config'] === 'object' && Object.keys(p).length === 2) {
      rows.push({ kind: 'config', id: p['id'], config: p['config'] as Record<string, unknown> })
      continue
    }
    rows.push({ kind: 'raw', row: patch })
  }
  return {
    name: spec.name,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    rows,
  }
}

/** How many things this arm changes: the number the one-variable rule counts. */
export function variableCount(design: ArmDesign): number {
  return design.rows.length + (design.model !== undefined ? 1 : 0) + (design.effort !== undefined ? 1 : 0)
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return /^[\w./@-]+$/.test(value) && value !== '' ? value : JSON.stringify(value)
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function configBlock(config: Record<string, unknown>, indent: string): string[] {
  return Object.entries(config).map(([k, v]) => `${indent}${k}: ${scalar(v)}`)
}

/** Serialise the design back to an arm file. The text is what gets saved and reviewed. */
export function armToYaml(design: ArmDesign): string {
  const lines: string[] = [`name: ${design.name}`]
  if (design.description !== undefined && design.description.trim() !== '') lines.push(`description: ${design.description.trim()}`)
  if (design.model !== undefined) lines.push(`model: ${design.model}`)
  if (design.effort !== undefined) lines.push(`effort: ${design.effort}`)
  const modelled = design.rows.filter(r => r.kind !== 'raw')
  const raw = design.rows.filter((r): r is RawRow => r.kind === 'raw')
  if (modelled.length === 0 && raw.length === 0) {
    if (design.model === undefined && design.effort === undefined) lines.push('patches: []')
    return lines.join('\n') + '\n'
  }
  lines.push('patches:')
  const inserts = modelled.filter((r): r is InsertRow => r.kind === 'insert')
  if (inserts.length > 0) {
    lines.push('  - insert:')
    for (const row of inserts) {
      lines.push(`      - id: ${row.id}`)
      lines.push(`        name: '${row.name}'`)
      if (row.config !== undefined && Object.keys(row.config).length > 0) {
        lines.push('        config:')
        lines.push(...configBlock(row.config, '          '))
      }
    }
  }
  for (const row of modelled) {
    if (row.kind === 'disable') lines.push(`  - id: ${row.id}`, '    disabled: true')
    if (row.kind === 'config') {
      lines.push(`  - id: ${row.id}`, '    config:')
      lines.push(...configBlock(row.config, '      '))
    }
  }
  for (const row of raw) lines.push(`  - ${JSON.stringify(row.row)}`)
  return lines.join('\n') + '\n'
}

/** A one-line, human description of a row, for the card in the designer. */
export function describeRow(row: DesignRow): string {
  switch (row.kind) {
    case 'insert': return row.name
    case 'disable': return `${row.id} turned off`
    case 'config': return `${row.id}: ${Object.entries(row.config).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`
    default: return 'custom patch row'
  }
}
