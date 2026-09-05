/**
 * A minimal client for the dsh SDK wire protocol (newline-delimited JSON-RPC
 * over stdio) that can spawn *any* command — the local dsh CLI or a `docker
 * run` wrapping it. It mirrors the official client's activity interval: queue
 * the prompt, wait for its inbox receipt, collect every session event until
 * the whole agent reports idle.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Driver, DriverTurnResult, TurnOptions } from './runner.js'
import { TurnTimeoutError } from './runner.js'
import type { EventLike } from './ledger.js'

export interface RpcLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** Workspace cwd as the runtime sees it (inside a container this is the mount point). */
  runtimeCwd: string
  provider: string
  model: string
  effort?: string
  maxTokens?: number
  initializeTimeoutMs?: number
  /** Called with stderr lines (kept short) for diagnostics. */
  onStderr?: (line: string) => void
  /** Debug hook: every notification method and, for session events, the event type. */
  onFrame?: (summary: string) => void
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class RpcDriver implements Driver {
  private child: ChildProcess | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  private buffer = ''
  private stderrTail: string[] = []
  private initialized: Promise<void> | undefined
  private readonly sessionId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  private exited: { code: number | null } | undefined
  private turn = 0

  constructor(private readonly launch: RpcLaunch) {}

  private start(): Promise<void> {
    if (this.initialized) return this.initialized
    const child = spawn(this.launch.command, this.launch.args, { cwd: this.launch.cwd ?? process.cwd(), env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '' || /UNDICI|trace-warnings/.test(line)) continue
        this.stderrTail.push(line.slice(0, 300))
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        this.launch.onStderr?.(line)
      }
    })
    child.on('exit', (code) => {
      this.exited = { code }
      const error = new Error(`dsh runtime exited (code ${code ?? 'signal'}): ${this.stderrTail.slice(-5).join(' | ')}`)
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
      for (const l of this.listeners) l('__exit__', { code })
    })
    child.on('error', (e) => { this.exited = { code: null }; for (const p of this.pending.values()) p.reject(e); this.pending.clear() })
    const params: Record<string, unknown> = { cwd: this.launch.runtimeCwd, provider: this.launch.provider, model: this.launch.model }
    if (this.launch.effort !== undefined) params['reasoningEffort'] = this.launch.effort
    if (this.launch.maxTokens !== undefined) params['maxTokens'] = this.launch.maxTokens
    this.initialized = this.request('initialize', params, this.launch.initializeTimeoutMs ?? 120_000).then(() => undefined)
    return this.initialized
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line !== '') this.onFrame(line)
      nl = this.buffer.indexOf('\n')
    }
  }

  private onFrame(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string; params?: Record<string, unknown> }
    try { msg = JSON.parse(line) as typeof msg } catch { return }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code ?? ''} ${msg.error.message ?? 'rpc error'}`.trim()))
      else p.resolve(msg.result)
    } else if (msg.method !== undefined) {
      if (this.launch.onFrame) {
        const ev = (msg.params as { event?: { type?: string }; status?: string } | undefined)
        this.launch.onFrame(`${msg.method}${ev?.event?.type ? ' ' + ev.event.type : ''}${ev?.status ? ' ' + ev.status : ''}`)
      }
      for (const l of this.listeners) l(msg.method, msg.params ?? {})
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms; stderr: ${this.stderrTail.slice(-3).join(' | ')}`)) }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async runTurn(prompt: string, options: TurnOptions): Promise<DriverTurnResult> {
    await this.start()
    this.turn += 1
    const events: EventLike[] = []
    return new Promise<DriverTurnResult>((resolve, reject) => {
      let received = false
      let done = false
      let messageId: string | undefined
      const finish = (err?: Error): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.listeners.delete(listener)
        options.signal?.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve({ events, sessionId: this.sessionId })
      }
      const timer = setTimeout(() => finish(new TurnTimeoutError(this.turn, options.timeoutMs)), options.timeoutMs)
      const onAbort = (): void => finish(new Error('cancelled'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // Notifications can outrun the prompt's own response (the receipt is emitted as the message is queued), so frames are
      // buffered until the message id is known and then replayed in order — the same interval semantics as the official client.
      const backlog: Array<[string, Record<string, unknown>]> = []
      const handle = (method: string, params: Record<string, unknown>): void => {
        if (method === '__exit__') { finish(new Error(`dsh runtime exited mid-turn: ${this.stderrTail.slice(-3).join(' | ')}`)); return }
        if (params['sessionId'] !== this.sessionId) return
        if (method === 'session.event') {
          const event = params['event'] as EventLike & { data?: { inserted?: Array<{ id?: string }> } }
          if (!received) {
            if (event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(m => m?.id === messageId)) received = true
            else return
          }
          events.push(event)
          options.onEvent?.(event)
        } else if (method === 'session.status' && received && params['status'] === 'idle') finish()
      }
      const listener = (method: string, params: Record<string, unknown>): void => {
        if (messageId === undefined) { backlog.push([method, params]); return }
        handle(method, params)
      }
      this.listeners.add(listener)
      this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text: prompt }] }, 60_000)
        .then((r) => {
          messageId = (r as { messageId?: string }).messageId
          for (const [m, p] of backlog.splice(0)) { if (done) break; handle(m, p) }
        })
        .catch(finish)
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    if (this.exited === undefined) {
      try { await this.request('shutdown', undefined, 3000) } catch { /* fall through to signals */ }
    }
    if (this.exited === undefined) {
      try { child.stdin?.end() } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } resolve() }, 8000)
        child.once('exit', () => { clearTimeout(t); resolve() })
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      })
    }
  }
}
