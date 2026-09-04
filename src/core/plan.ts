/**
 * Plan preparation: resolve arms into overlays, compose each arm's tree
 * through dsh itself, count the variables that differ between baseline and
 * candidate, and record the environment facts a reader needs to trust the run.
 */
import yaml from 'js-yaml'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { armOverlays, diffComposedRows, diffRoute, dumpComposedTree, parseComposedRows, resolveArm, sha256, type ComposedRows, type DshInvoker, type RowDiff } from './arms.js'
import { dshSourceRevision, dshSourceRoot, dshVersion, evalInfraVersion } from './env.js'
import { DEEPSEEK_PRICES } from './pricing.js'
import { writeBaseOverlays } from './runner.js'
import type { ArmSpec, ResolvedArm, RunEnvironment } from './types.js'

export interface ArmDiff {
  candidate: string
  rows: RowDiff[]
  route: string[]
  /**
   * Independent variables, not differing rows. A plugin that replaces part of dsh
   * ships one patch file that turns several rows off and inserts itself; applying
   * that file is one decision, so every row it accounts for counts once together.
   */
  variables: number
  /** Patch files the arm applied, with the rows each accounts for. */
  patchSources?: Array<{ file: string; rows: string[] }>
}

export interface PreparedArms {
  baseline: ResolvedArm
  candidates: ResolvedArm[]
  diffs: ArmDiff[]
  composed: Record<string, string>
  /** Composed rows per arm name, so callers can offer real row pickers instead of asking the user to know ids. */
  trees: Map<string, ComposedRows>
}

export interface PrepareOptions {
  evalHome: string
  armsDir: string
  invoke?: DshInvoker
  /** Source paths of the arm files, keyed by arm name (for relative patchFiles). */
  sources?: Record<string, string>
}

export async function prepareArms(baseline: ArmSpec, candidates: ArmSpec[], options: PrepareOptions): Promise<PreparedArms> {
  const names = new Set<string>()
  for (const a of [baseline, ...candidates]) {
    if (names.has(a.name)) throw new Error(`duplicate arm name: ${a.name}`)
    names.add(a.name)
  }
  const base = writeBaseOverlays(options.armsDir)
  const resolvedBaseline = resolveArm(baseline, options.armsDir, options.sources?.[baseline.name])
  const resolvedCandidates = candidates.map(c => resolveArm(c, options.armsDir, options.sources?.[c.name]))
  const composed: Record<string, string> = {}
  const trees = new Map<string, ReturnType<typeof parseComposedRows>>()
  for (const arm of [resolvedBaseline, ...resolvedCandidates]) {
    const text = await dumpComposedTree(options.evalHome, arm.profile, [base.noNetwork, ...armOverlays(arm)], options.invoke)
    composed[arm.name] = text
    trees.set(arm.name, parseComposedRows(text))
  }
  const diffs: ArmDiff[] = resolvedCandidates.map((cand) => {
    const rows = diffComposedRows(trees.get(resolvedBaseline.name)!, trees.get(cand.name)!)
    const route = diffRoute(resolvedBaseline, cand)
    const patchSources: Array<{ file: string; rows: string[] }> = []
    const claimed = new Set<string>()
    // Files applied by either arm: removing a plugin on the baseline side is one
    // decision that moves several rows, exactly like adding it on the other side.
    for (const file of [...resolvedBaseline.patchFilePaths, ...cand.patchFilePaths]) {
      const touched = rowsTouchedBy(file).filter(id => rows.some(r => r.id === id) && !claimed.has(id))
      for (const id of touched) claimed.add(id)
      if (touched.length > 0) patchSources.push({ file, rows: touched })
    }
    const loose = rows.filter(r => !claimed.has(r.id)).length
    return { candidate: cand.name, rows, route, variables: loose + patchSources.length + route.length, ...(patchSources.length > 0 ? { patchSources } : {}) }
  })
  return { baseline: resolvedBaseline, candidates: resolvedCandidates, diffs, composed, trees }
}

export async function recordEnvironment(composed: Record<string, string>): Promise<RunEnvironment> {
  const composedTreeSha: Record<string, string> = {}
  for (const [arm, text] of Object.entries(composed)) composedTreeSha[arm] = sha256(text.split('\n').filter(l => !l.startsWith('#')).join('\n'))
  const source = dshSourceRoot()
  return {
    dshVersion: await dshVersion(),
    dshSource: source,
    dshRevision: await dshSourceRevision(source),
    evalInfraVersion: evalInfraVersion(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    composedTreeSha,
    priceTableAsOf: DEEPSEEK_PRICES.asOf,
  }
}

/** Human-readable one-line-per-difference summary of an arm diff. */
/** Row ids a patch file affects: what one applied file accounts for in the diff. */
export function rowsTouchedBy(file: string): string[] {
  if (!existsSync(file)) return []
  let parsed: unknown
  try { parsed = yaml.load(readFileSync(file, 'utf8')) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r['id'] === 'string') ids.push(r['id'])
    if (Array.isArray(r['insert'])) {
      for (const entry of r['insert']) {
        if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['id'] === 'string') ids.push((entry as Record<string, unknown>)['id'] as string)
      }
    }
  }
  return ids
}

export function describeDiff(diff: ArmDiff): string[] {
  const out: string[] = []
  const bySource = new Map<string, string>()
  for (const source of diff.patchSources ?? []) for (const id of source.rows) bySource.set(id, source.file.split('/').slice(-2).join('/'))
  for (const r of diff.rows) {
    const via = bySource.has(r.id) ? ` · via ${bySource.get(r.id)!}` : ''
    if (r.kind === 'added') out.push(`+ row ${r.id} (${String((r.after as Record<string, unknown> | undefined)?.['name'] ?? '')})${via}`)
    else if (r.kind === 'removed') out.push(`− row ${r.id}${via}`)
    else out.push(`~ row ${r.id}: ${r.fields.join(', ')}${via}`)
  }
  for (const f of diff.route) out.push(`~ route ${f}`)
  if (out.length === 0) out.push('(identical composition — the arms do not differ)')
  return out
}

/** Read the profile manifest of the eval home, if the profile exists. */
export function evalProfileManifest(evalHome: string, profile: string): { exists: boolean; dependencies: Record<string, string>; bundles: string[] } {
  const manifest = join(evalHome, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return { exists: false, dependencies: {}, bundles: [] }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
  return { exists: true, dependencies: parsed.dependencies ?? {}, bundles: parsed.dsh?.profile?.bundles ?? [] }
}
