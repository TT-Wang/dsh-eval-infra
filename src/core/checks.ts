/**
 * What has been checked, and against which bytes. `selfcheck` runs on demand and
 * decides whether a scenario may be used at all; this records the answer beside
 * the project so `status` can tell "checked", "never checked" and "checked, but
 * the scenario has changed since" apart. It is an index of past checks, never a
 * substitute for one: every run re-runs selfcheck itself before it starts.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Project } from './project.js'
import type { SelfcheckFinding, SelfcheckResult } from './selfcheck.js'
import { writeJsonAtomic } from './store.js'

export interface SelfcheckEntry {
  /** sha256 over the scenario directory's contents; what makes `stale` meaningful. */
  sha: string
  ok: boolean
  blankPasses: boolean | null
  oraclePasses: boolean | null
  /** Present when the check ran with `--strict`. */
  strict?: { mutated: number; nonDiscriminating: string[] }
  checkedAt: string
  /** The verifier's own words on failure, kept for a caller that wants to show them. */
  detail?: string
  /** Why it did not pass, as codes: a caller can act on the last failure without running the check again. */
  findings?: SelfcheckFinding[]
}

export interface ChecksFile {
  schema: 'dsh-eval-checks/1'
  selfcheck: Record<string, SelfcheckEntry>
}

export type SelfcheckState = 'ok' | 'failing' | 'stale' | 'never'

const EMPTY: ChecksFile = { schema: 'dsh-eval-checks/1', selfcheck: {} }

function checksPath(project: Project): string {
  return join(project.evalDir, 'checks.json')
}

/** sha256 over every file in a scenario directory, path and content, in a fixed order. */
export function scenarioSha(dir: string): string {
  const files: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const p = join(at, name)
      if (statSync(p).isDirectory()) walk(p)
      else files.push(p)
    }
  }
  if (!existsSync(dir)) return 'missing'
  walk(dir)
  const h = createHash('sha256')
  for (const p of files.sort()) h.update(relative(dir, p) + '\0' + createHash('sha256').update(readFileSync(p)).digest('hex') + '\n')
  return h.digest('hex')
}

export function readChecks(project: Project): ChecksFile {
  const file = checksPath(project)
  if (!existsSync(file)) return { ...EMPTY, selfcheck: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ChecksFile>
    return { schema: 'dsh-eval-checks/1', selfcheck: parsed.selfcheck ?? {} }
  } catch {
    return { ...EMPTY, selfcheck: {} }
  }
}

/** Record the outcome of a selfcheck pass. `dirs` maps scenario name to its directory. */
export function recordSelfcheck(project: Project, results: SelfcheckResult[], dirs: Record<string, string>, options: { strict?: boolean } = {}): void {
  const checks = readChecks(project)
  const at = new Date().toISOString()
  for (const r of results) {
    const dir = dirs[r.name]
    if (dir === undefined) continue
    const entry: SelfcheckEntry = {
      sha: scenarioSha(dir),
      ok: r.ok,
      blankPasses: r.blankPasses,
      oraclePasses: r.oraclePasses,
      checkedAt: at,
      ...(options.strict && r.mutated !== undefined ? { strict: { mutated: r.mutated, nonDiscriminating: r.nonDiscriminating ?? [] } } : {}),
      ...(r.ok ? {} : { detail: r.detail.slice(0, 400) }),
      ...(r.findings && r.findings.length > 0 ? { findings: r.findings } : {}),
    }
    checks.selfcheck[r.name] = entry
  }
  writeJsonAtomic(checksPath(project), checks)
}

/**
 * The state of one scenario's selfcheck: never run, run and failed, run and
 * passed, or run against different bytes than the ones on disk now.
 */
export function selfcheckStateOf(entry: SelfcheckEntry | undefined, dir: string): SelfcheckState {
  if (entry === undefined) return 'never'
  if (entry.sha !== scenarioSha(dir)) return 'stale'
  return entry.ok ? 'ok' : 'failing'
}
