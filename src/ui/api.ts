import type { Report } from '../core/report.js'
import type { RunEnvironment, RunIndexEntry, RunLedger, RunPlan, ScenarioMeta } from '../core/types.js'
import type { Progress } from '../core/store.js'
import type { TraceRow } from '../core/ledger.js'
import type { ArmSpec } from '../core/types.js'

/** Mount prefix: '' at the root, '/eval' inside the dsh web host. Hash routing keeps the pathname stable. */
export const BASE = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '')

export interface Meta { version: string; project: string; home: string; profile: string; profileReady: boolean; plugins: string[]; scenarioRoot: string; ownScenarioRoot?: string; armsDir: string; docker?: { available: boolean; detail: string }; defaults: { repeats: number; concurrency: number; model: string; models: string[]; efforts: string[] } }
export interface ScenarioInfo { name: string; dir: string; meta: ScenarioMeta; turns: number; hasOracle: boolean; variants?: number; prompts: string[] }
export interface ArmInfo { file: string; path: string; spec?: ArmSpec; error?: string; text: string }
export interface RunDetail { plan: RunPlan; progress: Progress | null; report: Report | null; env: (RunEnvironment & { diffs?: Array<{ candidate: string; variables: number; rows: unknown[]; route: string[] }>; multiVariable?: boolean }) | null; active: boolean; logs: string[]; sequential?: { seed: number; candidate: string | null; decisions: Array<{ scenarios: number; cost: { mean: number; lo: number; hi: number } | null; pass: { lo: number; hi: number } | null; decided: boolean; reason: string }> } | null; integrity?: RunIntegrity | null }
export interface RunIntegrity { ok: boolean; status?: 'PASS' | 'INVALID' | 'INCONCLUSIVE'; statusReason?: string; sealedAt: string | null; evidenceSha: string | null; missing: string[]; changed: string[]; added: string[]; reportReproduces: boolean | null; reportDiff: string[] }
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
  if (/\/annotations$/.test(path)) return {}
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
export interface HistoryPoint { runId: string; usd: number; ok: boolean }
export interface PluginInfo { name: string; version?: string; description?: string; path: string; displayPath?: string; source: 'profile' | 'local' | 'global'; installed: boolean; bundle: boolean; bundlePatch?: string; replaces?: string[]; inserts?: string[]; client: boolean; rowId: string; duplicates?: string[] }
export interface IntakeResult { name: string; dir: string; written: string[]; selfcheck: { ok: boolean; blankFails: boolean; oraclePasses: boolean; detail: string } }
export interface Preflight {
  arm: string; baseline: string; ok: boolean
  stages: Array<{ name: 'compose' | 'mounted' | 'runs'; ok: boolean; detail: string }>
  rows: Array<{ id: string; name?: string; present: boolean; enabled: boolean; inBaseline: boolean }>
  diff: string[]; variables: number
  smoke?: { scenario: string; ok: boolean; usd: number; steps: number; tools: string[]; error?: string; wallMs: number }
}
/** The run's model and effort, shared by every arm. */
export interface Route { model?: string; effort?: string }
export interface RowInfo { id: string; name?: string; disabled: boolean; configKeys: string[]; config?: Record<string, unknown> }
export interface HistorySignal { snr: number | null; withinCv: number | null; passSpread: number | null; trials: number }
export interface History { arms: string[]; scenarios: Array<{ name: string; cells: Record<string, HistoryCell>; runIds: string[]; points: Record<string, HistoryPoint[]>; signal?: HistorySignal }>; runs: Array<{ id: string; createdAt: string; label?: string; arms: string[] }>; chronic?: { flaky: string[]; failing: string[]; saturated: string[] } }

export interface RunRow extends RunIndexEntry { sandbox?: 'host' | 'docker'; verdicts?: Array<{ arm: string; gate: string; costReading: string; costPct: number; regressions: number; improvements: number }> }

export const api = {
  meta: () => req<Meta>('/meta'),
  history: () => req<History>('/history'),
  runs: () => req<RunRow[]>('/runs'),
  plugins: () => req<{ plugins: PluginInfo[] }>('/plugins'),
  addScenario: (name: string, files: Record<string, string>) => req<IntakeResult>('/scenarios', { method: 'POST', body: JSON.stringify({ name, files }) }),
  scenarioTemplate: (name: string) => req<Record<string, string>>(`/scenarios/template?name=${encodeURIComponent(name)}`),
  preflight: (arm: string, dry: boolean, route: Route = {}) => req<Preflight>('/preflight', { method: 'POST', body: JSON.stringify({ arm, dry, ...route }) }),
  rows: (arm: string) => req<{ arm: string; rows: RowInfo[] }>(`/rows?arm=${encodeURIComponent(arm)}`),
  savePatch: (name: string, text: string) => req<{ saved: string }>(`/patch/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ text }) }),
  saveArm: (name: string, text: string) => req<{ saved: string; spec: unknown }>(`/arms/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ text }) }),
  deleteArm: (name: string) => req<{ deleted: string }>(`/arms/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  run: (id: string) => req<RunDetail>(`/runs/${id}`),
  ledgers: (id: string) => req<LedgerLite[]>(`/runs/${id}/ledgers`),
  ledger: (id: string, scenario: string, arm: string, rep: number) => req<RunLedger>(`/runs/${id}/ledgers/${scenario}/${arm}/rep${rep}/ledger`),
  trace: (id: string, scenario: string, arm: string, rep: number) => req<TraceRow[]>(`/runs/${id}/ledgers/${scenario}/${arm}/rep${rep}/trace`),
  scenarios: () => req<{ scenarios: ScenarioInfo[]; invalid: Array<{ dir: string; error: string }> }>('/scenarios'),
  arms: () => req<{ dir: string; arms: ArmInfo[] }>('/arms'),
  diff: (baseline: string, candidates: string[], route: Route = {}) => req<{ diffs: Array<{ candidate: string; variables: number; lines: string[] }> }>('/arms/diff', { method: 'POST', body: JSON.stringify({ baseline, candidates, ...route }) }),
  start: (body: unknown) => req<{ id: string }>('/runs', { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string) => req<{ cancelled: boolean }>(`/runs/${id}/cancel`, { method: 'POST' }),
  annotations: (id: string) => req<Record<string, { verdict: boolean | null; note: string; by: string; at: string }>>(`/runs/${id}/annotations`),
  annotate: (id: string, body: { scenario: string; arm: string; rep: number; verdict: boolean | null; note?: string; by?: string; remove?: boolean }) => req<{ annotations: Record<string, unknown> }>(`/runs/${id}/annotations`, { method: 'PUT', body: JSON.stringify(body) }),
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
