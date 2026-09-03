import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startMeter, usageFromBody, verifyChain } from '../src/core/meter.js'

function fakeProvider(): Promise<{ url: string; close: () => void; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean; model?: string }
      seen.push(req.headers['authorization'] ?? '')
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
        res.write('data: {"choices":[],"usage":{"prompt_tokens":120,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":20,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 50, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50, completion_tokens: 5 } }))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), seen })))
}

describe('usage meter', () => {
  it('parses usage from streamed and plain bodies', () => {
    expect(usageFromBody('data: {"usage":{"prompt_tokens":10,"prompt_cache_hit_tokens":4,"prompt_cache_miss_tokens":6,"completion_tokens":2}}\n\ndata: [DONE]\n', true)).toMatchObject({ hit: 4, miss: 6, output: 2 })
    expect(usageFromBody('{"usage":{"prompt_tokens":10,"completion_tokens":2}}', false)).toMatchObject({ miss: 10, output: 2 })
    expect(usageFromBody('garbage', false)).toBeNull()
  })

  it('forwards requests with headers, records wire usage in a verifiable hash chain, and injects seeded faults', async () => {
    const provider = await fakeProvider()
    const meter = await startMeter({ upstream: provider.url })
    const post = (body: unknown): Promise<{ status: number; text: string }> => fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }))
    const a = await post({ model: 'deepseek-v4-flash', stream: true, messages: [] })
    expect(a.status).toBe(200)
    expect(a.text).toContain('[DONE]')
    const b = await post({ model: 'deepseek-v4-flash', stream: false, messages: [] })
    expect(b.status).toBe(200)
    await new Promise(r => setTimeout(r, 30))
    const entries = meter.entries()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ stream: true, status: 200, model: 'deepseek-v4-flash', usage: { hit: 100, miss: 20, output: 7, reasoning: 3 }, fault: null })
    expect(entries[1]!.usage).toMatchObject({ miss: 50, output: 5 })
    expect(meter.totals()).toMatchObject({ requests: 2, forwarded: 2, faults: 0, hit: 100, miss: 70, output: 12 })
    expect(provider.seen).toEqual(['Bearer secret', 'Bearer secret'])
    expect(verifyChain(entries)).toBeNull()
    const tampered = entries.map((e, i) => (i === 0 ? { ...e, usage: { ...e.usage!, miss: 1 } } : e))
    expect(verifyChain(tampered)).toBe(1)
    await meter.close()

    const faulty = await startMeter({ upstream: provider.url, faults: { rate: 1, seed: 1, kinds: ['429'] } })
    const f = await fetch(`${faulty.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) })
    expect(f.status).toBe(429)
    expect(faulty.totals()).toMatchObject({ requests: 1, faults: 1, forwarded: 0 })
    await faulty.close()
    provider.close()
  })
})
