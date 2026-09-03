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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json() as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`)
  return body
}

export const api = {
  meta: () => req<Meta>('/meta'),
  runs: () => req<RunIndexEntry[]>('/runs'),
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
