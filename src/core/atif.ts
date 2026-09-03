/**
 * Export one run ledger + trace as an ATIF v1.8 trajectory (Harbor's Agent
 * Trajectory Interchange Format), so Harbor's viewer and the ATIF trajectory
 * viewer can open dsh-eval trials. https://www.harborframework.com/docs/agents/trajectory-format
 */
import type { RunLedger } from './types.js'
import type { TraceRow } from './ledger.js'

export interface AtifStep {
  step_id: number
  timestamp: string
  source: 'user' | 'agent' | 'system'
  message: string
  model_name?: string
  reasoning_content?: string
  tool_calls?: Array<{ tool_call_id: string; function_name: string; arguments: Record<string, unknown> | { raw: string } }>
  observation?: { results: Array<{ source_call_id: string; content: string }> }
  metrics?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cost_usd?: number }
  extra?: Record<string, unknown>
}

export interface AtifTrajectory {
  schema_version: 'ATIF-v1.8'
  session_id: string
  agent: { name: string; version: string; model_name: string; extra?: Record<string, unknown> }
  steps: AtifStep[]
  final_metrics: { total_prompt_tokens: number; total_completion_tokens: number; total_cached_tokens: number; total_cost_usd: number; total_steps: number }
  extra: Record<string, unknown>
}

function parseArgs(raw: string): Record<string, unknown> | { raw: string } {
  try {
    const v = JSON.parse(raw) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : { raw }
  } catch {
    return { raw }
  }
}

export function toAtif(ledger: RunLedger, trace: TraceRow[], prompts: string[], version: string): AtifTrajectory {
  const steps: AtifStep[] = []
  let id = 0
  let lastTurn = 0
  for (const row of trace) {
    if (row.turn !== lastTurn) {
      lastTurn = row.turn
      const prompt = prompts[row.turn - 1]
      if (prompt !== undefined) steps.push({ step_id: ++id, timestamp: new Date(row.time).toISOString(), source: 'user', message: prompt })
    }
    const step: AtifStep = {
      step_id: ++id,
      timestamp: new Date(row.time).toISOString(),
      source: 'agent',
      message: row.text,
      model_name: ledger.headerModel ?? ledger.model,
      extra: { turn: row.turn, step: row.step },
    }
    if (row.reasoning !== '') step.reasoning_content = row.reasoning
    if (row.calls.length > 0) step.tool_calls = row.calls.map((c, i) => ({ tool_call_id: row.observations[i]?.callId || `t${row.turn}-s${row.step}-${i + 1}`, function_name: c.name, arguments: parseArgs(c.arguments) }))
    if (row.observations.length > 0) step.observation = { results: row.observations.map((o, i) => ({ source_call_id: o.callId || `t${row.turn}-s${row.step}-${i + 1}`, content: o.text })) }
    if (row.usage !== null) step.metrics = { prompt_tokens: row.usage.hit + row.usage.miss, completion_tokens: row.usage.output, cached_tokens: row.usage.hit, cost_usd: row.usd }
    steps.push(step)
  }
  return {
    schema_version: 'ATIF-v1.8',
    session_id: ledger.sessionId ?? `${ledger.runId}/${ledger.scenario}/${ledger.arm}/${ledger.rep}`,
    agent: { name: `dsh:${ledger.arm}`, version, model_name: ledger.headerModel ?? ledger.model, extra: { provider: ledger.provider, effort: ledger.resolvedEffort, tools: ledger.tools } },
    steps,
    final_metrics: {
      total_prompt_tokens: ledger.totals.hit + ledger.totals.miss,
      total_completion_tokens: ledger.totals.output,
      total_cached_tokens: ledger.totals.hit,
      total_cost_usd: ledger.totals.usd,
      total_steps: steps.length,
    },
    extra: { dsh_eval: { runId: ledger.runId, scenario: ledger.scenario, arm: ledger.arm, rep: ledger.rep, verdict: ledger.verdict, error: ledger.error ?? null, usdPeak: ledger.totals.usdPeak, usdOffpeak: ledger.totals.usdOffpeak } },
  }
}
