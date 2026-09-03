import type { Report } from '../core/report.js'
import type { RunEnvironment, RunIndexEntry, RunLedger, RunPlan, ScenarioMeta } from '../core/types.js'
import type { Progress } from '../core/store.js'
import type { TraceRow } from '../core/ledger.js'
import type { ArmSpec } from '../core/types.js'

/** Mount prefix: '' at the root, '/eval' inside the dsh web host. Hash routing keeps the pathname stable. */
export const BASE = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '')

export interface Meta { version: string; project: string; home: string; profile: string; profileReady: boolean; plugins: string[]; scenarioRoot: string; armsDir: string; defaults: { repeats: number; concurrency: number } }
export interface ScenarioInfo { name: string; dir: string; meta: ScenarioMeta; turns: number; hasOracle: boolean; prompts: string[] }
export interface ArmInfo { file: string; path: string; spec?: ArmSpec; error?: string; text: string }
export interface RunDetail { plan: RunPlan; progress: Progress | null; report: Report | null; env: (RunEnvironment & { diffs?: Array<{ candidate: string; variables: number; rows: unknown[]; route: string[] }>; multiVariable?: boolean }) | null; active: boolean; logs: string[] }
export type LedgerLite = Omit<RunLedger, 'steps'> & { steps: Array<Omit<RunLedger['steps'][number], 'calls'> & { calls: string[] }> }

/** A self-contained export (`dsh-eval export --html`) embeds the run; every read resolves from it and writes are refused. */
interface StaticBundle { meta: Meta; runs: RunRow[]; run: RunDetail; ledgers: LedgerLite[]; full: Record<string, RunLedger>; traces: Record<string, TraceRow[]>; history: History }
declare global { interface Window { __DSH_EVAL_STATIC__?: StaticBundle } }
export const STATIC: StaticBundle | undefined = window.__DSH_EVAL_STATIC__

function fromStatic(path: string, method: string): unknown {
  const b = STATIC!
  if (method !== 'GET') throw new Error('this is a static export; open the run in dsh-eval ui to start or cancel runs')
  if (path === '/meta') return b.meta
  if (path === '/runs') return b.runs
  if (path === '/history') return b.history
  if (path === '/scenarios') return { scenarios: [], invalid: [] }
  if (path === '/arms') return { dir: '', arms: [] }
  const m = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (m && m[1] === b.run.plan.id) {
    const rest = m[2] ?? ''
    if (rest === '') return b.run
    if (rest === 'report') return b.run.report
    if (rest === 'ledgers') return b.ledgers
    const t = /^ledgers\/([^/]+)\/([^/]+)\/rep(\d+)\/(ledger|trace|events|atif)$/.exec(rest)
    if (t) {
      const key = `${t[1]}|${t[2]}|${t[3]}`
      if (t[4] === 'ledger') return b.full[key] ?? (() => { throw new Error('ledger not in export') })()
      if (t[4] === 'trace') return b.traces[key] ?? []
      throw new Error(`${t[4]} is not included in a static export`)
    }
  }
  throw new Error(`not in this export: ${path}`)
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (STATIC !== undefined) return fromStatic(path, init?.method ?? 'GET') as T
  const r = await fetch(`${BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json() as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`)
  return body
}

export interface HistoryCell { runs: number; passes: number; errors: number; usdMean: number; stepsMean: number }
export interface History { arms: string[]; scenarios: Array<{ name: string; cells: Record<string, HistoryCell>; runIds: string[] }>; runs: Array<{ id: string; createdAt: string; label?: string; arms: string[] }> }

export interface RunRow extends RunIndexEntry { verdicts?: Array<{ arm: string; gate: string; costReading: string; costPct: number; regressions: number; improvements: number }> }

export const api = {
  meta: () => req<Meta>('/meta'),
  history: () => req<History>('/history'),
  runs: () => req<RunRow[]>('/runs'),
  run: (id: string) => req<RunDetail>(`/runs/${id}`),
  ledgers: (id: string) => req<LedgerLite[]>(`/runs/${id}/ledgers`),
  ledger: (id: string, scenario: string, arm: string, rep: number) => req<RunLedger>(`/runs/${id}/ledgers/${scenario}/${arm}/rep${rep}/ledger`),
  trace: (id: string, scenario: string, arm: string, rep: number) => req<TraceRow[]>(`/runs/${id}/ledgers/${scenario}/${arm}/rep${rep}/trace`),
  scenarios: () => req<{ scenarios: ScenarioInfo[]; invalid: Array<{ dir: string; error: string }> }>('/scenarios'),
  arms: () => req<{ dir: string; arms: ArmInfo[] }>('/arms'),
  diff: (baseline: string, candidates: string[]) => req<{ diffs: Array<{ candidate: string; variables: number; lines: string[] }> }>('/arms/diff', { method: 'POST', body: JSON.stringify({ baseline, candidates }) }),
  start: (body: unknown) => req<{ id: string }>('/runs', { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string) => req<{ cancelled: boolean }>(`/runs/${id}/cancel`, { method: 'POST' }),
  atifUrl: (id: string, scenario: string, arm: string, rep: number) => `${BASE}/api/runs/${id}/ledgers/${scenario}/${arm}/rep${rep}/atif`,
}

export function stream(id: string, on: (event: string, data: unknown) => void): () => void {
  if (STATIC !== undefined) return () => { /* nothing to stream in a static export */ }
  const es = new EventSource(`${BASE}/api/runs/${id}/stream`)
  for (const ev of ['progress', 'log', 'ledger', 'done', 'error']) {
    es.addEventListener(ev, (e) => { try { on(ev, JSON.parse((e as MessageEvent).data as string)) } catch { on(ev, null) } })
  }
  es.onerror = () => { /* the browser reconnects; a finished run closes the stream server-side */ }
  return () => es.close()
}

export const fmt = {
  usd: (v: number | null | undefined, digits = 4): string => v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(digits)}`,
  pct: (v: number | null | undefined, digits = 1): string => v === null || v === undefined ? '—' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(digits)}%`,
  k: (v: number): string => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v)),
  secs: (ms: number): string => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(0)}s`,
  time: (iso: string): string => new Date(iso).toLocaleString(),
}
