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
import { appendFileSync } from 'node:fs'
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
  /** SHA-256 of the request body (the meter never stores the body or headers). */
  requestSha: string
  /** Fault injected by the meter instead of forwarding (null when forwarded). */
  fault: '429' | 'stall' | null
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
}

export interface MeterOptions {
  /** Upstream base URL, e.g. https://api.deepseek.com */
  upstream: string
  /** Append entries here (JSONL) in addition to keeping them in memory. */
  ledgerFile?: string
  /** Listen on all interfaces (container mode) instead of loopback. */
  exposed?: boolean
  /** Fault injection: share of requests answered with a fault, seeded. */
  faults?: { rate: number; seed?: number; kinds?: Array<'429' | 'stall'>; stallMs?: number }
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
  const t: MeterTotals = { requests: 0, forwarded: 0, faults: 0, hit: 0, miss: 0, output: 0, reasoning: 0 }
  for (const e of entries) {
    t.requests += 1
    if (e.fault) t.faults += 1
    else t.forwarded += 1
    if (e.usage) { t.hit += e.usage.hit; t.miss += e.usage.miss; t.output += e.usage.output; t.reasoning += e.usage.reasoning }
  }
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

/** Pull the usage object out of a streamed (SSE) or plain JSON response body. */
export function usageFromBody(body: string, stream: boolean): Usage | null {
  if (!stream) {
    try { const j = JSON.parse(body) as { usage?: unknown }; return j.usage ? (normalizeUsage(j.usage) ?? null) : null } catch { return null }
  }
  let last: Usage | null = null
  for (const line of body.split('\n')) {
    const m = /^data:\s*(\{.*\})\s*$/.exec(line)
    if (!m) continue
    try {
      const j = JSON.parse(m[1]!) as { usage?: unknown }
      if (j.usage) last = normalizeUsage(j.usage) ?? last
    } catch { /* partial or non-JSON line */ }
  }
  return last
}

export async function startMeter(options: MeterOptions): Promise<Meter> {
  const upstream = new URL(options.upstream)
  const entries: MeterEntry[] = []
  let prev = 'genesis'
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
      let model: string | null = null
      let stream = false
      try { const j = JSON.parse(body.toString('utf8')) as { model?: string; stream?: boolean }; model = j.model ?? null; stream = j.stream === true } catch { /* not JSON */ }
      const path = req.url ?? '/'
      const method = req.method ?? 'POST'

      if (options.faults && options.faults.rate > 0 && random() < options.faults.rate) {
        const fault = kinds[Math.floor(random() * kinds.length)] ?? '429'
        const finish = (): void => {
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: fault === '429' ? 429 : 503, durationMs: Date.now() - started, usage: null, requestSha, fault })
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
          record({ at: new Date(started).toISOString(), method, path, model, stream, status: upRes.statusCode ?? null, durationMs: Date.now() - started, usage: usageFromBody(text, stream), requestSha, fault: null })
        })
      })
      up.on('error', (err) => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `dsh-eval meter: upstream error ${err.message}` } })) }
        else res.end()
        record({ at: new Date(started).toISOString(), method, path, model, stream, status: 502, durationMs: Date.now() - started, usage: null, requestSha, fault: null })
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
