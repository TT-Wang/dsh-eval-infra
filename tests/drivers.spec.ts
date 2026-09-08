import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RpcDriver } from '../src/core/rpc-driver.js'
import { sdkDriverFactory, type HarnessCtor, type HarnessNotificationLike } from '../src/core/sdk-driver.js'
import { TurnTimeoutError, type DriverInput } from '../src/core/runner.js'
import type { EventLike } from '../src/core/ledger.js'

const FAKE = join(__dirname, 'fixtures', 'fake-dsh-rpc.mjs')
const launch = (mode: string) => ({ command: process.execPath, args: [FAKE, mode], env: { PATH: process.env['PATH'] ?? '' }, runtimeCwd: '/work', provider: 'deepseek', model: 'deepseek-v4-flash', initializeTimeoutMs: 5000 })

describe('RpcDriver against a stdio JSON-RPC peer', () => {
  it('initializes, runs turns, keeps only its own session\'s events, streams them live, and shuts the peer down', async () => {
    const stderr: string[] = []
    const frames: string[] = []
    const driver = new RpcDriver({ ...launch('ok'), onStderr: l => stderr.push(l), onFrame: f => frames.push(f) })
    const live: EventLike[] = []
    const first = await driver.runTurn('hello', { timeoutMs: 5000, onEvent: e => live.push(e) })
    expect(first.events.map(e => e.type)).toEqual(['agent/inbox/spliced', 'request/header', 'assistant/message'])
    expect(live.map(e => e.type)).toEqual(first.events.map(e => e.type))          // the live hook saw exactly the turn's events, in order
    expect(first.events.some(e => JSON.stringify(e).includes('not yours'))).toBe(false)  // another session's event is not ours
    expect((first.events[2] as { data: { message: { content: Array<{ text: string }> } } }).data.message.content[0]!.text).toBe('echo: hello')
    expect(first.sessionId).toMatch(/^eval-/)
    const second = await driver.runTurn('again', { timeoutMs: 5000 })
    expect(second.events).toHaveLength(3)
    expect(stderr).toContain('booted')
    expect(frames.some(f => f.startsWith('session.event agent/inbox/spliced'))).toBe(true)
    expect(frames.some(f => f === 'session.status idle')).toBe(true)
    await driver.close()
  })

  it('times out a turn the runtime never finishes, and reports a runtime that exits mid-turn', async () => {
    const hang = new RpcDriver(launch('hang'))
    await expect(hang.runTurn('x', { timeoutMs: 400 })).rejects.toBeInstanceOf(TurnTimeoutError)
    await hang.close()
    const crash = new RpcDriver(launch('crash'))
    await expect(crash.runTurn('x', { timeoutMs: 5000 })).rejects.toThrow(/exited/)
    await crash.close()
  })

  it('cancels a turn through its abort signal', async () => {
    const driver = new RpcDriver(launch('hang'))
    const ac = new AbortController()
    const turn = driver.runTurn('x', { timeoutMs: 5000, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(turn).rejects.toThrow(/cancelled/)
    await driver.close()
  })
})

describe('SdkDriver over the dsh SDK client', () => {
  const input = (): DriverInput => ({
    arm: { name: 'cand', profile: 'eval', provider: 'deepseek', model: 'deepseek-v4-flash', effort: 'high', overlays: [], env: {} } as unknown as DriverInput['arm'],
    scenario: { name: 's', dir: '', meta: { name: 's', turns: 1 }, prompts: ['x'], hasOracle: false, hasSetup: false } as unknown as DriverInput['scenario'],
    workdir: '/work', evalHome: '/home/eval', overlays: ['/o/a.patch.yml'], env: { DEEPSEEK_API_KEY: 'k' },
  } as unknown as DriverInput)

  it('boots the harness with the arm\'s profile, overlays and route, forwards only the root session\'s events, and closes it', async () => {
    const seen: Record<string, unknown>[] = []
    let closed = 0
    class FakeHarness {
      constructor(readonly options: Record<string, unknown>) { seen.push(options) }
      session(): { id: string; run(input: string, options?: { onNotification?: (n: HarnessNotificationLike) => void }): Promise<{ sessionId: string; events: unknown[] }> } {
        return {
          id: 'root',
          async run(prompt, options) {
            options?.onNotification?.({ method: 'session.event', params: { sessionId: 'root', event: { type: 'assistant/message', seq: 1, time: 1, data: { text: prompt } } } })
            options?.onNotification?.({ method: 'session.event', params: { sessionId: 'child', event: { type: 'assistant/message', seq: 2, time: 2, data: { text: 'sub-agent' } } } })
            options?.onNotification?.({ method: 'session.status', params: { sessionId: 'root', status: 'idle' } })
            return { sessionId: 'root', events: [{ type: 'assistant/message', seq: 1, time: 1, data: { text: prompt } }] }
          },
        }
      }
      async close(): Promise<void> { closed += 1 }
    }
    const driver = sdkDriverFactory({ harness: FakeHarness as unknown as HarnessCtor, initializeTimeoutMs: 1234 })(input())
    const live: EventLike[] = []
    const r = await driver.runTurn('hi', { timeoutMs: 5000, onEvent: e => live.push(e) })
    expect(r.sessionId).toBe('root')
    expect(r.events).toHaveLength(1)
    expect(live).toHaveLength(1)                        // the child session's event is not forwarded
    expect(seen[0]).toMatchObject({ profile: 'eval', patches: ['/o/a.patch.yml'], dshHome: '/home/eval', cwd: '/work', processCwd: '/work', provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high', initializeTimeoutMs: 1234 })
    expect((seen[0]!['env'] as Record<string, string>)['DEEPSEEK_API_KEY']).toBe('k')
    await driver.close()
    expect(closed).toBe(1)
  })

  it('times out a turn the harness never returns and cancels through the signal', async () => {
    class Stuck {
      constructor(_o: Record<string, unknown>) { void _o }
      session() { return { id: 'root', run: () => new Promise<{ sessionId: string; events: unknown[] }>(() => {}) } }
      async close(): Promise<void> {}
    }
    const factory = sdkDriverFactory({ harness: Stuck as unknown as HarnessCtor })
    await expect(factory(input()).runTurn('x', { timeoutMs: 100 })).rejects.toBeInstanceOf(TurnTimeoutError)
    const ac = new AbortController()
    const turn = factory(input()).runTurn('x', { timeoutMs: 5000, signal: ac.signal })
    setTimeout(() => ac.abort(), 30)
    await expect(turn).rejects.toThrow(/cancelled/)
  })
})
