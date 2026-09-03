/**
 * Tamper-evident run seal. After a run (and after every regrade) the evidence
 * files under the run directory are hashed into `manifest.json`; `verifyRun`
 * recomputes the hashes and re-derives the report from the sealed ledgers so
 * a reader can check that the report they were given follows from the
 * evidence they were given. Report, annotations and judge files are derived
 * or added later and are checked separately.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { writeJsonAtomic, type RunPaths } from './store.js'

export interface RunManifest {
  schema: 'dsh-eval-manifest/1'
  runId: string
  sealedAt: string
  /** Relative path → sha256 of every evidence file. */
  files: Record<string, string>
  count: number
  bytes: number
  /** sha256 over the sorted (path, sha) list: one id for the whole evidence set. */
  evidenceSha: string
  regrades: Array<{ at: string; changed: number; regradable: number; verifiers: Record<string, string> }>
}

export interface VerifyResult {
  ok: boolean
  sealedAt: string | null
  evidenceSha: string | null
  missing: string[]
  changed: string[]
  /** Evidence files present now that were not sealed (added after the seal). */
  added: string[]
  /** Whether report.json's readings equal a fresh derivation from the sealed ledgers (null when no report). */
  reportReproduces: boolean | null
  reportDiff: string[]
}

const DERIVED = new Set(['manifest.json', 'report.json', 'report.md', 'annotations.json'])

function isDerived(rel: string): boolean {
  if (DERIVED.has(rel)) return true
  if (rel.startsWith('judge-') && rel.endsWith('.json')) return true
  if (rel.startsWith('regrade-') && rel.endsWith('.json')) return true
  return false
}

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, root, out)
    else out.push(relative(root, p))
  }
}

export function evidenceFiles(runDir: string): string[] {
  const out: string[] = []
  walk(runDir, runDir, out)
  return out.filter(rel => !isDerived(rel) && !rel.startsWith('arms/_meter-')).sort()
}

export function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function evidenceShaOf(files: Record<string, string>): string {
  const h = createHash('sha256')
  for (const rel of Object.keys(files).sort()) h.update(rel + '\0' + files[rel] + '\n')
  return h.digest('hex')
}

export function sealRun(paths: RunPaths, runId: string, regrade?: RunManifest['regrades'][number]): RunManifest {
  const previous = readManifest(paths)
  const files: Record<string, string> = {}
  let bytes = 0
  for (const rel of evidenceFiles(paths.dir)) {
    files[rel] = fileSha(join(paths.dir, rel))
    bytes += statSync(join(paths.dir, rel)).size
  }
  const manifest: RunManifest = {
    schema: 'dsh-eval-manifest/1',
    runId,
    sealedAt: new Date().toISOString(),
    files,
    count: Object.keys(files).length,
    bytes,
    evidenceSha: evidenceShaOf(files),
    regrades: [...(previous?.regrades ?? []), ...(regrade ? [regrade] : [])],
  }
  writeJsonAtomic(join(paths.dir, 'manifest.json'), manifest)
  return manifest
}

export function readManifest(paths: RunPaths): RunManifest | null {
  const file = join(paths.dir, 'manifest.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as RunManifest } catch { return null }
}

/** Compare sealed hashes with the files on disk; `derive` re-derives the report and returns its readings for comparison. */
export function verifyRun(paths: RunPaths, derive?: () => { fresh: Record<string, unknown>; stored: Record<string, unknown> | null }): VerifyResult {
  const manifest = readManifest(paths)
  if (!manifest) return { ok: false, sealedAt: null, evidenceSha: null, missing: [], changed: [], added: [], reportReproduces: null, reportDiff: ['no manifest: this run was never sealed'] }
  const missing: string[] = []
  const changed: string[] = []
  for (const [rel, sha] of Object.entries(manifest.files)) {
    const p = join(paths.dir, rel)
    if (!existsSync(p)) { missing.push(rel); continue }
    if (fileSha(p) !== sha) changed.push(rel)
  }
  const now = new Set(evidenceFiles(paths.dir))
  const added = [...now].filter(rel => !(rel in manifest.files)).sort()
  let reportReproduces: boolean | null = null
  const reportDiff: string[] = []
  if (derive) {
    const { fresh, stored } = derive()
    if (stored === null) reportReproduces = null
    else {
      for (const key of Object.keys(fresh)) {
        const a = JSON.stringify(fresh[key])
        const b = JSON.stringify(stored[key])
        if (a !== b) reportDiff.push(`${key}: stored ${b} vs derived ${a}`)
      }
      reportReproduces = reportDiff.length === 0
    }
  }
  return { ok: missing.length === 0 && changed.length === 0 && reportReproduces !== false, sealedAt: manifest.sealedAt, evidenceSha: manifest.evidenceSha, missing, changed, added, reportReproduces, reportDiff }
}
