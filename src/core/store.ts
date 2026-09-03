/**
 * On-disk layout of a run:
 *   <root>/runs/<runId>/plan.json, env.json, progress.json, report.json, report.md
 *   <root>/runs/<runId>/arms/<arm>.patch.yml
 *   <root>/runs/<runId>/ledgers/<scenario>/<arm>/rep<N>.json (+ .events.jsonl, .trace.jsonl)
 * Everything the report shows is recomputed from the ledgers, so a run
 * directory is self-contained and can be shared or re-reported.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RunEnvironment, RunIndexEntry, RunLedger, RunPlan } from './types.js'

export interface RunPaths {
  root: string
  dir: string
  plan: string
  env: string
  progress: string
  report: string
  reportMd: string
  arms: string
  ledgers: string
}

export function runPaths(root: string, runId: string): RunPaths {
  const dir = join(resolve(root), 'runs', runId)
  return {
    root: resolve(root),
    dir,
    plan: join(dir, 'plan.json'),
    env: join(dir, 'env.json'),
    progress: join(dir, 'progress.json'),
    report: join(dir, 'report.json'),
    reportMd: join(dir, 'report.md'),
    arms: join(dir, 'arms'),
    ledgers: join(dir, 'ledgers'),
  }
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rand}`
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function ledgerPath(paths: RunPaths, scenario: string, arm: string, rep: number): string {
  return join(paths.ledgers, scenario, arm, `rep${rep}.json`)
}

export function writeLedger(paths: RunPaths, ledger: RunLedger): string {
  const path = ledgerPath(paths, ledger.scenario, ledger.arm, ledger.rep)
  writeJsonAtomic(path, ledger)
  return path
}

/** Every ledger of a run, in file order. */
export function readLedgers(paths: RunPaths): RunLedger[] {
  const out: RunLedger[] = []
  if (!existsSync(paths.ledgers)) return out
  for (const scenario of readdirSync(paths.ledgers).sort()) {
    const sdir = join(paths.ledgers, scenario)
    if (!statSync(sdir).isDirectory()) continue
    for (const arm of readdirSync(sdir).sort()) {
      const adir = join(sdir, arm)
      if (!statSync(adir).isDirectory()) continue
      for (const f of readdirSync(adir).sort()) {
        if (!/^rep\d+\.json$/.test(f)) continue
        try { out.push(readJson<RunLedger>(join(adir, f))) } catch { /* partial write in progress */ }
      }
    }
  }
  return out
}

export interface Progress {
  status: RunIndexEntry['status']
  total: number
  completed: number
  failed: number
  usd: number
  startedAt: string
  updatedAt: string
  /** Jobs currently executing. */
  active: Array<{ scenario: string; arm: string; rep: number; turn: number; turns: number; startedAt: string }>
  /** Last few finished jobs. */
  recent: Array<{ scenario: string; arm: string; rep: number; ok: boolean | null; usd: number; wallMs: number; error?: string }>
  error?: string
}

export function listRuns(root: string): RunIndexEntry[] {
  const runsDir = join(resolve(root), 'runs')
  if (!existsSync(runsDir)) return []
  const out: RunIndexEntry[] = []
  for (const id of readdirSync(runsDir).sort().reverse()) {
    const paths = runPaths(root, id)
    if (!existsSync(paths.plan)) continue
    try {
      const plan = readJson<RunPlan>(paths.plan)
      const progress = existsSync(paths.progress) ? readJson<Progress>(paths.progress) : undefined
      const entry: RunIndexEntry = {
        id,
        createdAt: plan.createdAt,
        status: progress?.status ?? 'failed',
        arms: [plan.baseline.name, ...plan.candidates.map(c => c.name)],
        scenarios: plan.scenarios.length,
        repeats: plan.repeats,
        completed: progress?.completed ?? 0,
        total: progress?.total ?? plan.scenarios.length * plan.repeats * (1 + plan.candidates.length),
        usd: progress?.usd ?? 0,
      }
      if (plan.label !== undefined) entry.label = plan.label
      out.push(entry)
    } catch { /* unreadable run */ }
  }
  return out
}

/** A human override of one trial's verdict (or a note without override). */
export interface Annotation {
  /** `true` = mark pass, `false` = mark fail, `null` = note only. */
  verdict: boolean | null
  note: string
  by: string
  at: string
}

export type Annotations = Record<string, Annotation>

export function annotationKey(scenario: string, arm: string, rep: number): string {
  return `${scenario}|${arm}|${rep}`
}

export function readAnnotations(paths: RunPaths): Annotations {
  const file = join(paths.dir, 'annotations.json')
  return existsSync(file) ? readJson<Annotations>(file) : {}
}

export function writeAnnotations(paths: RunPaths, annotations: Annotations): void {
  writeJsonAtomic(join(paths.dir, 'annotations.json'), annotations)
}

/** Apply overrides to ledgers (a copy); the ledger keeps the machine verdict under `machineVerdict`. */
export function applyAnnotations(ledgers: RunLedger[], annotations: Annotations): RunLedger[] {
  return ledgers.map((l) => {
    const a = annotations[annotationKey(l.scenario, l.arm, l.rep)]
    if (a === undefined || a.verdict === null) return l
    return { ...l, machineVerdict: l.verdict, verdict: { ok: a.verdict, detail: `manual override (${a.by}): ${a.note || (a.verdict ? 'pass' : 'fail')}` }, overridden: true }
  })
}

export function readPlan(paths: RunPaths): RunPlan {
  return readJson<RunPlan>(paths.plan)
}

export function readEnvironment(paths: RunPaths): RunEnvironment | undefined {
  return existsSync(paths.env) ? readJson<RunEnvironment>(paths.env) : undefined
}
