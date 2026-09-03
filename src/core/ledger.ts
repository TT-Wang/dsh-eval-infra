/**
 * Build a RunLedger from the session events of one run. Every number the
 * report shows traces back to a session event: usage from assistant/message,
 * verdict from verify.py, end reasons from turn/end.
 */
import { createHash } from 'node:crypto'
import type { RunLedger, StepRow, Totals, TurnRow, Usage, Verdict } from './types.js'
import { bandAt, priceUsage, type PriceTable, DEEPSEEK_PRICES } from './pricing.js'
import { addUsage, normalizeUsage, ZERO_USAGE } from './usage.js'

/** The subset of a dsh session event we read. */
export interface EventLike {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

interface Block { type: string; text?: string; name?: string; arguments?: string }

export interface LedgerInput {
  runId: string
  scenario: string
  arm: string
  rep: number
  order: number
  startedAt: Date
  endedAt: Date
  provider: string
  model: string
  events: EventLike[]
  /** Wall time of each turn, by turn index (1-based). */
  turnWall: Map<number, number>
  verdict: Verdict | null
  error?: string
  sessionId: string | null
  workdir: string
  eventsFile: string
  traceFile: string
  /** Number of runtime sessions the run used (>1 when the scenario declares session breaks). */
  sessions?: number
  prices?: PriceTable
}

export interface TraceRow {
  turn: number
  step: number
  time: number
  calls: Array<{ name: string; arguments: string }>
  text: string
  reasoning: string
  usage: Usage | null
  usd: number
}

export function buildLedger(input: LedgerInput): { ledger: RunLedger; trace: TraceRow[] } {
  const prices = input.prices ?? DEEPSEEK_PRICES
  const steps: StepRow[] = []
  const trace: TraceRow[] = []
  const turnsMap = new Map<number, TurnRow>()
  const toolHistogram: Record<string, number> = {}
  const eventCounts: Record<string, number> = {}
  let header: { config?: { reasoningEffort?: string; model?: string }; system?: string; tools?: Array<{ name: string }> } | undefined
  let peakPrompt = 0
  let usdPeak = 0
  let usdOffpeak = 0

  for (const e of input.events) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1
    const d = (e.data ?? {}) as Record<string, unknown>
    if (e.type === 'request/header' && header === undefined) {
      header = (d['header'] ?? undefined) as typeof header
    } else if (e.type === 'tool/call') {
      const name = String(d['name'] ?? '?')
      toolHistogram[name] = (toolHistogram[name] ?? 0) + 1
    } else if (e.type === 'assistant/message') {
      const turn = Number(d['turn'] ?? 0)
      const step = Number(d['step'] ?? 0)
      const time = e.time ?? input.startedAt.getTime()
      const message = (d['message'] ?? {}) as { content?: Block[] }
      const content = message.content ?? []
      const calls = content.filter(b => b.type === 'tool-call').map(b => ({ name: b.name ?? '?', arguments: b.arguments ?? '' }))
      const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      const reasoning = content.filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('')
      const usage = normalizeUsage(d['usage'])
      const band = bandAt(time, prices)
      const usd = usage ? priceUsage(input.model, band, usage, prices) : 0
      if (usage) {
        usdPeak += priceUsage(input.model, 'peak', usage, prices)
        usdOffpeak += priceUsage(input.model, 'offpeak', usage, prices)
        peakPrompt = Math.max(peakPrompt, usage.hit + usage.miss)
      }
      steps.push({ ...(usage ?? ZERO_USAGE), turn, step, time, band, usd, calls: calls.map(c => ({ name: c.name, args: c.arguments.slice(0, 200) })), textChars: text.length, reasoningChars: reasoning.length })
      trace.push({ turn, step, time, calls, text, reasoning, usage: usage ?? null, usd })
      const row = turnsMap.get(turn) ?? { ...ZERO_USAGE, turn, steps: 0, usd: 0, wallMs: input.turnWall.get(turn) ?? 0, end: 'unknown' }
      const summed = addUsage(row, usage ?? ZERO_USAGE)
      turnsMap.set(turn, { ...row, ...summed, steps: Math.max(row.steps, step), usd: row.usd + usd })
    } else if (e.type === 'turn/end') {
      const turn = Number(d['turn'] ?? 0)
      const reason = (d['reason'] ?? {}) as { kind?: string; error?: { message?: string; code?: string } }
      const row = turnsMap.get(turn) ?? { ...ZERO_USAGE, turn, steps: 0, usd: 0, wallMs: input.turnWall.get(turn) ?? 0, end: 'unknown' }
      row.end = reason.kind ?? 'unknown'
      if (reason.kind === 'error') row.error = `${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? ''}`.slice(0, 500)
      turnsMap.set(turn, row)
    }
  }

  const turns = [...turnsMap.values()].sort((a, b) => a.turn - b.turn)
  const sum = turns.reduce<Usage>((acc, t) => addUsage(acc, t), ZERO_USAGE)
  const totals: Totals = {
    ...sum,
    steps: steps.length,
    turns: turns.length,
    usd: turns.reduce((a, t) => a + t.usd, 0),
    usdPeak,
    usdOffpeak,
    peakPrompt,
  }
  const system = header?.system
  const ledger: RunLedger = {
    schema: 'dsh-eval-ledger/1',
    runId: input.runId,
    scenario: input.scenario,
    arm: input.arm,
    rep: input.rep,
    order: input.order,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    wallMs: input.endedAt.getTime() - input.startedAt.getTime(),
    provider: input.provider,
    model: input.model,
    resolvedEffort: header?.config?.reasoningEffort ?? null,
    headerModel: header?.config?.model ?? null,
    tools: (header?.tools ?? []).map(t => t.name),
    systemPromptSha: system !== undefined ? createHash('sha256').update(system).digest('hex') : null,
    systemPromptChars: system?.length ?? 0,
    turns,
    steps,
    totals,
    toolHistogram,
    eventCounts,
    verdict: input.verdict,
    sessionId: input.sessionId,
    workdir: input.workdir,
    eventsFile: input.eventsFile,
    traceFile: input.traceFile,
    sessions: input.sessions ?? 1,
  }
  if (input.error !== undefined) ledger.error = input.error
  return { ledger, trace }
}
