/**
 * The production driver: one dsh SDK runtime process per scenario run, driven
 * over stdio JSON-RPC by `@deepseek-ai/dsh-sdk-client`. The subprocess boots
 * the arm's profile with the arm's overlays under the isolated eval home.
 */
import type { Driver, DriverFactory, DriverInput, DriverTurnResult, TurnOptions } from './runner.js'
import { TurnTimeoutError } from './runner.js'
import type { EventLike } from './ledger.js'

interface HarnessNotificationLike { method: string; params: Record<string, unknown> }
interface HarnessLike {
  session(id?: string): { id: string; run(input: string, options?: { onNotification?: (n: HarnessNotificationLike) => void }): Promise<{ sessionId: string; events: unknown[] }> }
  close(): Promise<void>
}

interface HarnessCtor {
  new (options: Record<string, unknown>): HarnessLike
}

export interface SdkDriverOptions {
  /** Explicit dsh CLI module for the SDK client (default: the linked same-version @deepseek-ai/dsh). */
  dshBin?: string
  initializeTimeoutMs?: number
}

async function loadHarness(): Promise<HarnessCtor> {
  const mod = await import('@deepseek-ai/dsh-sdk-client') as { DeepSeekHarness: HarnessCtor }
  return mod.DeepSeekHarness
}

export function sdkDriverFactory(options: SdkDriverOptions = {}): DriverFactory {
  return (input: DriverInput): Driver => new SdkDriver(input, options)
}

class SdkDriver implements Driver {
  private harness: HarnessLike | undefined
  private session: ReturnType<HarnessLike['session']> | undefined
  private turn = 0
  constructor(private readonly input: DriverInput, private readonly options: SdkDriverOptions) {}

  private async ensure(): Promise<ReturnType<HarnessLike['session']>> {
    if (this.session !== undefined) return this.session
    const Harness = await loadHarness()
    const { arm, workdir, evalHome, overlays, env } = this.input
    const opts: Record<string, unknown> = {
      profile: arm.profile,
      patches: overlays,
      dshHome: evalHome,
      cwd: workdir,
      processCwd: workdir,
      provider: arm.provider,
      model: arm.model,
      env: { ...process.env, ...env },
      initializeTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
    }
    if (arm.effort !== undefined) opts['reasoningEffort'] = arm.effort
    if (arm.maxTokens !== undefined) opts['maxTokens'] = arm.maxTokens
    if (this.options.dshBin !== undefined) opts['dshBin'] = this.options.dshBin
    this.harness = new Harness(opts)
    this.session = this.harness.session()
    return this.session
  }

  async runTurn(prompt: string, options: TurnOptions): Promise<DriverTurnResult> {
    const session = await this.ensure()
    // The client observes every notification as it comes off the wire; the root
    // session's events are what a live view of the trial is made of.
    const onEvent = options.onEvent
    const runOptions = onEvent === undefined ? undefined : {
      onNotification: (n: HarnessNotificationLike): void => {
        if (n.method === 'session.event' && n.params['sessionId'] === session.id) onEvent(n.params['event'] as EventLike)
      },
    }
    this.turn += 1
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TurnTimeoutError(this.turn, options.timeoutMs)), options.timeoutMs)
    })
    const abort = new Promise<never>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
    try {
      const result = await Promise.race([session.run(prompt, runOptions), timeout, abort])
      return { events: result.events as EventLike[], sessionId: result.sessionId }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    const h = this.harness
    this.harness = undefined
    this.session = undefined
    if (h !== undefined) await h.close()
  }
}
