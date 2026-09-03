import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Driver, DriverFactory, DriverInput } from '../src/core/runner.js'
import type { EventLike } from '../src/core/ledger.js'

export interface ScriptedBehaviour {
  /** Cost multiplier per arm name (default 1). */
  costScale?: Record<string, number>
  /** Arms that fail the task (never write the answer). */
  failing?: string[]
  /** Arms whose second turn throws (runtime error). */
  crashing?: string[]
  /** Fixed time for events (unix ms) so the price band is deterministic. */
  time?: number
}

/** A driver that fakes a dsh session: emits realistic events and writes the answer file so verify.py passes. */
export function scriptedDriverFactory(b: ScriptedBehaviour = {}): DriverFactory {
  return (input: DriverInput): Driver => {
    let turn = 0
    const scale = b.costScale?.[input.arm.name] ?? 1
    const time = b.time ?? Date.UTC(2026, 8, 6, 12, 0, 0) // a Sunday: off-peak
    return {
      async runTurn(prompt: string): Promise<{ events: EventLike[]; sessionId: string }> {
        turn += 1
        if (b.crashing?.includes(input.arm.name) && turn === 2) throw new Error('runtime exploded')
        const events: EventLike[] = []
        const push = (type: string, data: unknown): void => { events.push({ type, seq: events.length + 1, time: time + turn * 1000 + events.length, data }) }
        push('turn/start', { turn })
        const stepsPlanned = turn === 1 ? 3 : 2
        void stepsPlanned
        push('request/header', { header: { config: { provider: input.arm.provider, model: input.arm.model, reasoningEffort: input.arm.effort ?? 'high' }, system: `system prompt for ${input.arm.name}`, tools: [{ name: 'read' }, { name: 'write' }] }, reason: 'initial' })
        const steps = turn === 1 ? 3 : 2
        for (let step = 1; step <= steps; step += 1) {
          const last = step === steps
          push('step/start', { turn, step })
          push('assistant/message', {
            turn,
            step,
            message: { content: last ? [{ type: 'text', text: 'Done.' }] : [{ type: 'reasoning', text: 'thinking about ' + prompt.slice(0, 10) }, { type: 'tool-call', name: step === 1 ? 'read' : 'write', arguments: JSON.stringify({ path: 'numbers.txt' }) }] },
            usage: { inputTokens: Math.round(1000 * scale), outputTokens: Math.round(200 * scale), cacheReadTokens: step === 1 ? 0 : Math.round(8000 * scale), reasoningTokens: Math.round(50 * scale) },
          })
          if (!last) {
            push('tool/call', { turn, step, callId: `c${turn}-${step}`, name: step === 1 ? 'read' : 'write', arguments: '{}' })
            push('tool/result', { turn, step, message: { role: 'user', content: [] } })
          }
          push('step/end', { turn, step })
        }
        push('turn/end', { turn, reason: { kind: 'completed' } })
        if (!b.failing?.includes(input.arm.name)) {
          const p = join(input.workdir, 'answer.txt')
          writeFileSync(p, /DONE/.test(prompt) ? '6\nDONE\n' : '6\n')
        }
        return { events, sessionId: `fake-${input.arm.name}` }
      },
      async close(): Promise<void> { /* nothing */ },
    }
  }
}
