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
        res.write('data: {"model":"deepseek-v4-flash","system_fingerprint":"fp_abc","choices":[],"usage":{"prompt_tokens":120,"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":20,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n')
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
    expect(entries[0]).toMatchObject({ stream: true, status: 200, model: 'deepseek-v4-flash', usage: { hit: 100, miss: 20, output: 7, reasoning: 3 }, fault: null, responseModel: 'deepseek-v4-flash', fingerprint: 'fp_abc' })
    expect(meter.totals().servedModels).toEqual(['deepseek-v4-flash'])
    expect(meter.totals().fingerprints).toEqual(['fp_abc'])
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

describe('record, replay and fork', () => {
  it('records forwarded responses, replays them keylessly in order, refuses beyond the recording, and forks to live after N', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readRecording } = await import('../src/core/meter.js')
    const provider = await fakeProvider()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-rec-'))
    const recordFile = join(dir, 'rep1.responses.jsonl')
    const recorder = await startMeter({ upstream: provider.url, recordFile })
    const post = (base: string, body: unknown): Promise<{ status: number; text: string }> => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }))
    const a = await post(recorder.baseURL, { model: 'm', stream: true, messages: [1] })
    const b = await post(recorder.baseURL, { model: 'm', stream: false, messages: [2] })
    await new Promise(r => setTimeout(r, 30))
    await recorder.close()
    expect(existsSync(recordFile)).toBe(true)
    const rec = readRecording(recordFile)
    expect(rec).toHaveLength(2)
    expect(rec[0]!.body).toBe(a.text)
    expect(rec[1]!.body).toBe(b.text)

    // pure replay: upstream unreachable, no key needed, same bodies in order, third request refused
    const replayer = await startMeter({ upstream: 'http://127.0.0.1:9', replay: { responses: rec, live: false } })
    const r1 = await post(replayer.baseURL, { model: 'm', stream: true, messages: ['anything'] })
    const r2 = await post(replayer.baseURL, { model: 'm', stream: false, messages: ['else'] })
    const r3 = await post(replayer.baseURL, { model: 'm', stream: false, messages: ['more'] })
    expect(r1.text).toBe(a.text)
    expect(r2.text).toBe(b.text)
    expect(r3.status).toBe(503)
    await new Promise(r => setTimeout(r, 30))
    expect(replayer.totals()).toMatchObject({ requests: 3, replayed: 3, forwarded: 0, hit: 100, miss: 70 })
    expect(replayer.entries()[0]!.replayed).toBe(true)
    await replayer.close()

    // fork: one recorded response, then live against the provider
    const before = provider.seen.length
    const forker = await startMeter({ upstream: provider.url, replay: { responses: rec, liveAfter: 1, live: true } })
    const f1 = await post(forker.baseURL, { model: 'm', stream: true, messages: [] })
    const f2 = await post(forker.baseURL, { model: 'm', stream: false, messages: [] })
    expect(f1.text).toBe(a.text)
    expect(f2.status).toBe(200)
    expect(provider.seen.length).toBe(before + 1)
    await new Promise(r => setTimeout(r, 30))
    expect(forker.totals()).toMatchObject({ replayed: 1, forwarded: 1 })
    await forker.close()
    provider.close()
  })
})
