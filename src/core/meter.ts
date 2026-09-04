/**
 * Independent usage meter: a local HTTP proxy between the runtime under test
 * and the provider. The runtime's own usage report comes from inside the
 * process that hosts the component being evaluated, so it is self-reported;
 * the meter records what the provider actually returned on the wire, with a
 * hash chain over the entries, and the ledger is reconciled against it.
 * It can also inject provider faults (429, stalled connections) so a
 * component's behaviour under provider trouble can be measured.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { normalizeUsage } from './usage.js'
import type { Usage } from './types.js'
import { rng } from './stats.js'

export interface MeterEntry {
  seq: number
  at: string
  method: string
  path: string
  model: string | null
  stream: boolean
  status: number | null
  durationMs: number
  usage: Usage | null
  /** Model id and system fingerprint the provider put in the response (served-model check). */
  responseModel: string | null
  fingerprint: string | null
  /** SHA-256 of the request body (the meter never stores the body or headers). */
  requestSha: string
  /** Fault injected by the meter instead of forwarding (null when forwarded). */
  fault: '429' | 'stall' | null
  /** True when the response came from a recording instead of the provider. */
  replayed?: boolean
  /** The client's declared identity (user-agent): the harness name and version on the wire. */
  harness?: string
  /** Hash chain: sha256(prev + canonical entry without `hash`). */
  prev: string
  hash: string
}

export interface MeterTotals {
  requests: number
  forwarded: number
  faults: number
  hit: number
  miss: number
  output: number
  reasoning: number
  /** Distinct model ids and fingerprints seen in responses. */
  servedModels: string[]
  fingerprints: string[]
  /** Responses served from a recording. */
  replayed: number
  /** Distinct client identities (user-agent) seen on the wire: the harness build that made the calls. */
  harnessIdentities: string[]
}

export interface RecordedResponse { seq: number; requestSha: string; status: number; contentType: string; body: string }

export interface MeterOptions {
  /** Upstream base URL, e.g. https://api.deepseek.com */
  upstream: string
  /** Append entries here (JSONL) in addition to keeping them in memory. */
  ledgerFile?: string
  /** Listen on all interfaces (container mode) instead of loopback. */
  exposed?: boolean
  /** Fault injection: share of requests answered with a fault, seeded. */
  faults?: { rate: number; seed?: number; kinds?: Array<'429' | 'stall'>; stallMs?: number }
  /** Append every forwarded response (status, content type, body) here so the trial can be replayed keylessly. */
  recordFile?: string
  /**
   * Replay: serve these recorded responses in order instead of forwarding. Requests beyond the
   * recording, or from `liveAfter` on (fork from that step), go to the upstream if `live` is set,
   * otherwise get 503.
   */
  replay?: { responses: RecordedResponse[]; liveAfter?: number; live?: boolean }
}

export interface Meter {
  baseURL: string
  port: number
  entries(): MeterEntry[]
  totals(): MeterTotals
  close(): Promise<void>
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, sortKeys((value as Record<string, unknown>)[k])]))
  return value
}

function canonical(entry: Omit<MeterEntry, 'hash'>): string {
  return JSON.stringify(sortKeys(entry))
}

export function meterTotals(entries: MeterEntry[]): MeterTotals {
  const t: MeterTotals = { requests: 0, forwarded: 0, faults: 0, hit: 0, miss: 0, output: 0, reasoning: 0, servedModels: [], fingerprints: [], replayed: 0, harnessIdentities: [] }
  const models = new Set<string>()
  const fps = new Set<string>()
  const uas = new Set<string>()
  for (const e of entries) {
    t.requests += 1
    if (e.fault) t.faults += 1
    else if (e.replayed) t.replayed += 1
    else t.forwarded += 1
    if (e.usage) { t.hit += e.usage.hit; t.miss += e.usage.miss; t.output += e.usage.output; t.reasoning += e.usage.reasoning }
    if (e.responseModel) models.add(e.responseModel)
    if (e.fingerprint) fps.add(e.fingerprint)
    if (e.harness) uas.add(e.harness)
  }
  t.servedModels = [...models].sort()
  t.fingerprints = [...fps].sort()
  t.harnessIdentities = [...uas].sort()
  return t
}

/** Verify a meter ledger's hash chain; returns the first broken sequence number or null. */
export function verifyChain(entries: MeterEntry[]): number | null {
  let prev = 'genesis'
  for (const e of entries) {
    const { hash, ...rest } = e
    if (rest.prev !== prev) return e.seq
    const expect = createHash('sha256').update(prev + canonical(rest)).digest('hex')
    if (expect !== hash) return e.seq
    prev = hash
  }
  return null
}

export interface ParsedResponse { usage: Usage | null; model: string | null; fingerprint: string | null }

/** Pull usage, the served model id and the system fingerprint out of a streamed (SSE) or plain JSON response body. */
export function parseResponseBody(body: string, stream: boolean): ParsedResponse {
  const out: ParsedResponse = { usage: null, model: null, fingerprint: null }
  const take = (j: { usage?: unknown; model?: unknown; system_fingerprint?: unknown }): void => {
    if (j.usage) out.usage = normalizeUsage(j.usage) ?? out.usage
    if (typeof j.model === 'string' && j.model) out.model = j.model
    if (typeof j.system_fingerprint === 'string' && j.system_fingerprint) out.fingerprint = j.system_fingerprint
  }
  if (!stream) {
    try { take(JSON.parse(body) as Parameters<typeof take>[0]) } catch { /* not JSON */ }
    return out
  }
  for (const line of body.split('\n')) {
    const m = /^data:\s*(\{.*\})\s*$/.exec(line)
    if (!m) continue
    try { take(JSON.parse(m[1]!) as Parameters<typeof take>[0]) } catch { /* partial or non-JSON line */ }
  }
  return out
}

export function usageFromBody(body: string, stream: boolean): Usage | null {
  return parseResponseBody(body, stream).usage
}

/** Read a recording written through `recordFile`. */
export function readRecording(file: string): RecordedResponse[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RecordedResponse)
}

export async function startMeter(options: MeterOptions): Promise<Meter> {
  const upstream = new URL(options.upstream)
  const entries: MeterEntry[] = []
  let prev = 'genesis'
  let replayIndex = 0
  const random = rng(options.faults?.seed ?? 7)
  const kinds = options.faults?.kinds ?? ['429', 'stall']

  const record = (partial: Omit<MeterEntry, 'seq' | 'prev' | 'hash'>): void => {
    const base = { seq: entries.length + 1, ...partial, prev }
    const hash = createHash('sha256').update(prev + canonical(base)).digest('hex')
    const entry: MeterEntry = { ...base, hash }
    entries.push(entry)
    prev = hash
    if (options.ledgerFile) appendFileSync(options.ledgerFile, JSON.stringify(entry) + '\n')
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const requestSha = createHash('sha256').update(body).digest('hex')
      const harness = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
      let model: string | null = null
      let stream = false
      try { const j = JSON.parse(body.toString('utf8')) as { model?: string; stream?: boolean }; model = j.model ?? null; stream = j.stream === true } catch { /* not JSON */ }
      const path = req.url ?? '/'
      const method = req.method ?? 'POST'

      if (options.replay) {
        const n = replayIndex
        replayIndex += 1
        const live = options.replay.liveAfter !== undefined && n >= options.replay.liveAfter
        const recorded = live ? undefined : options.replay.responses[n]
        if (recorded) {
          res.writeHead(recorded.status, { 'content-type': recorded.contentType })
          res.end(recorded.body)
          const parsed = parseResponseBody(recorded.body, stream)
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: recorded.status, durationMs: Date.now() - started, usage: parsed.usage, responseModel: parsed.model, fingerprint: parsed.fingerprint, requestSha, fault: null, replayed: true, ...(harness !== undefined ? { harness } : {}) })
          return
        }
        if (!options.replay.live) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `dsh-eval meter: recording exhausted at request ${n + 1} and live forwarding is off`, type: 'server_error' } }))
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: 503, durationMs: Date.now() - started, usage: null, responseModel: null, fingerprint: null, requestSha, fault: null, replayed: true, ...(harness !== undefined ? { harness } : {}) })
          return
        }
        // fork: fall through to a live request
      }

      if (options.faults && options.faults.rate > 0 && random() < options.faults.rate) {
        const fault = kinds[Math.floor(random() * kinds.length)] ?? '429'
        const finish = (): void => {
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: fault === '429' ? 429 : 503, durationMs: Date.now() - started, usage: null, responseModel: null, fingerprint: null, requestSha, fault, ...(harness !== undefined ? { harness } : {}) })
        }
        if (fault === '429') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
          res.end(JSON.stringify({ error: { message: 'dsh-eval meter: injected rate limit', type: 'rate_limit_error' } }))
          finish()
        } else {
          setTimeout(() => {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'dsh-eval meter: injected stall', type: 'server_error' } }))
            finish()
          }, options.faults.stallMs ?? 5000)
        }
        return
      }

      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue
        if (k === 'host' || k === 'connection' || k === 'content-length') continue
        headers[k] = v
      }
      headers['host'] = upstream.host
      headers['content-length'] = String(body.length)
      const make = upstream.protocol === 'https:' ? httpsRequest : httpRequest
      const up = make({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, path: upstream.pathname.replace(/\/$/, '') + path, method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        const collected: Buffer[] = []
        upRes.on('data', (c: Buffer) => { collected.push(c); res.write(c) })
        upRes.on('end', () => {
          res.end()
          const text = Buffer.concat(collected).toString('utf8')
          const parsed = parseResponseBody(text, stream)
          if (options.recordFile) appendFileSync(options.recordFile, JSON.stringify({ seq: entries.length + 1, requestSha, status: upRes.statusCode ?? 0, contentType: String(upRes.headers['content-type'] ?? 'application/json'), body: text } satisfies RecordedResponse) + '\n')
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: upRes.statusCode ?? null, durationMs: Date.now() - started, usage: parsed.usage, responseModel: parsed.model, fingerprint: parsed.fingerprint, requestSha, fault: null, ...(harness !== undefined ? { harness } : {}) })
        })
      })
      up.on('error', (err) => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `dsh-eval meter: upstream error ${err.message}` } })) }
        else res.end()
        record({ at: new Date(started).toISOString(), method, path, model, stream, status: 502, durationMs: Date.now() - started, usage: null, responseModel: null, fingerprint: null, requestSha, fault: null, ...(harness !== undefined ? { harness } : {}) })
      })
      up.end(body)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.exposed ? '0.0.0.0' : '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    baseURL: `http://127.0.0.1:${port}`,
    port,
    entries: () => entries.slice(),
    totals: () => meterTotals(entries),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
