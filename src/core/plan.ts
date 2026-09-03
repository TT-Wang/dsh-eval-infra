/**
 * Plan preparation: resolve arms into overlays, compose each arm's tree
 * through dsh itself, count the variables that differ between baseline and
 * candidate, and record the environment facts a reader needs to trust the run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { armOverlays, diffComposedRows, diffRoute, dumpComposedTree, parseComposedRows, resolveArm, sha256, type DshInvoker, type RowDiff } from './arms.js'
import { dshSourceRevision, dshSourceRoot, dshVersion, evalInfraVersion } from './env.js'
import { DEEPSEEK_PRICES } from './pricing.js'
import { writeBaseOverlays } from './runner.js'
import type { ArmSpec, ResolvedArm, RunEnvironment } from './types.js'

export interface ArmDiff {
  candidate: string
  rows: RowDiff[]
  route: string[]
  /** Number of independent variables: differing rows plus differing route fields. */
  variables: number
}

export interface PreparedArms {
  baseline: ResolvedArm
  candidates: ResolvedArm[]
  diffs: ArmDiff[]
  composed: Record<string, string>
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
    return { candidate: cand.name, rows, route, variables: rows.length + route.length }
  })
  return { baseline: resolvedBaseline, candidates: resolvedCandidates, diffs, composed }
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
export function describeDiff(diff: ArmDiff): string[] {
  const out: string[] = []
  for (const r of diff.rows) {
    if (r.kind === 'added') out.push(`+ row ${r.id} (${String((r.after as Record<string, unknown> | undefined)?.['name'] ?? '')})`)
    else if (r.kind === 'removed') out.push(`− row ${r.id}`)
    else out.push(`~ row ${r.id}: ${r.fields.join(', ')}`)
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
