import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { serveMcp, TOOLS } from '../src/mcp/index.js'
import { loadProject, ensureEvalProfile } from '../src/core/project.js'

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

function project() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-mcp-')); tmp.push(root)
  const lib = join(root, 'bench', 'scenarios')
  mkdirSync(join(root, '.dsh-eval'), { recursive: true })
  writeFileSync(join(root, '.dsh-eval', 'config.json'), JSON.stringify({ profile: 'eval', repeats: 3, concurrency: 1, scenarioRoot: lib }))
  const dir = join(lib, 's1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: 's1', title: 's1', turns: 1, category: 'tools', oracle: 'none' }))
  writeFileSync(join(dir, 'prompts.json'), JSON.stringify(['do it']))
  writeFileSync(join(dir, 'verify.py'), 'def verify(root):\n    return True, "always ok"\n')
  const p = loadProject(root)
  ensureEvalProfile(p.home, 'eval')
  mkdirSync(p.armsDir, { recursive: true })
  for (const n of ['baseline', 'cand']) writeFileSync(join(p.armsDir, `${n}.yml`), `name: ${n}\n`)
  return p
}

/**
 * Drive the server the way a client does: one request at a time, each awaited
 * before the next goes out. Requests may legally be pipelined and answered out
 * of order, so a test that fires them all at once would be testing the schedule.
 */
async function talk(projectRoot: string, frames: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: Array<Record<string, unknown>> = []
  const waiting = new Map<unknown, () => void>()
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      const frame = JSON.parse(line) as Record<string, unknown>
      lines.push(frame)
      waiting.get(frame['id'])?.()
    }
  })
  const served = serveMcp({ projectRoot, input, output })
  for (const f of frames) {
    const id = f['id']
    const answered = id === undefined ? Promise.resolve() : new Promise<void>(r => waiting.set(id, r))
    input.write(JSON.stringify(f) + '\n')
    await answered
  }
  input.end()
  await served
  return lines
}
const result = (frames: Array<Record<string, unknown>>, id: number): Record<string, unknown> => frames.find(f => f['id'] === id)!['result'] as Record<string, unknown>
const payload = (frames: Array<Record<string, unknown>>, id: number): Record<string, unknown> => {
  const r = result(frames, id)
  return JSON.parse(((r['content'] as Array<{ text: string }>)[0]!).text) as Record<string, unknown>
}

describe('the MCP surface', () => {
  it('answers the handshake, lists its tools, and echoes a protocol version it knows', async () => {
    const p = project()
    const frames = await talk(p.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ])
    const init = result(frames, 1)
    expect(init['protocolVersion']).toBe('2024-11-05')                         // the version the client asked for
    expect((init['serverInfo'] as { name: string }).name).toBe('dsh-eval')
    expect(String(init['instructions'])).toMatch(/Call `status` first/)
    expect(result(frames, 2)).toEqual({})
    const tools = (result(frames, 3)['tools'] as Array<{ name: string; inputSchema: unknown }>).map(t => t.name)
    expect(tools).toEqual(TOOLS.map(t => t.name))
    expect(tools).toContain('report_read')
    // a notification draws no reply, and no tool offers a way past a gate
    expect(frames.filter(f => f['id'] === undefined)).toEqual([])
    expect(JSON.stringify(TOOLS.map(t => t.inputSchema))).not.toMatch(/force|skip|ignore|override/i)
  })

  it('answers an unknown protocol version with one it knows, and an unknown method with a JSON-RPC error', async () => {
    const p = project()
    const frames = await talk(p.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
    ])
    expect(result(frames, 1)['protocolVersion']).toBe('2025-06-18')
    expect((frames.find(f => f['id'] === 2)!['error'] as { code: number }).code).toBe(-32601)
  })

  it('carries a refusal as a normal answer, and only a fault as an error', async () => {
    const p = project()
    const frames = await talk(p.root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_start', arguments: { baseline: 'baseline' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_read', arguments: { runId: 'no-such-run' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ])
    // status: a project that is not ready is a successful call that says so
    expect(result(frames, 1)['isError']).toBe(false)
    const st = payload(frames, 1)
    expect(st['schema']).toBe('dsh-eval-status/1')
    expect(st['blocked']).toBe('selfcheck')
    // a run with no candidate and no --aa is refused as data, not as an exception
    expect(result(frames, 2)['isError']).toBe(false)
    expect((payload(frames, 2)['error'] as { code: string }).code).toBe('arms.no_candidate')
    // a run that does not exist is a fault of the caller's request: an error frame with a code
    expect(result(frames, 3)['isError']).toBe(true)
    expect(String((payload(frames, 3)['error'] as { message: string }).message)).toMatch(/not found/)
    expect((payload(frames, 4)['error'] as { code: string }).code).toBe('tool.unknown')
  })

  it('runs the selfcheck loop over the wire and records what it found', async () => {
    const p = project()
    const frames = await talk(p.root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scenarios_list', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scenarios_selfcheck', arguments: { scenarios: ['s1'] } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scenarios_list', arguments: {} } },
    ])
    expect((payload(frames, 1)['scenarios'] as Array<{ selfcheck: string }>)[0]!.selfcheck).toBe('never')
    // the fixture's verifier accepts anything, so the check fails and says exactly that
    const checked = payload(frames, 2)['scenarios'] as Array<{ name: string; ok: boolean; findings: Array<{ code: string; detail: string }> }>
    expect(checked[0]!.ok).toBe(false)
    expect(checked[0]!.findings[0]).toEqual({ code: 'blank.accepted', detail: 'always ok' })
    // and the listing now reflects it without running anything again
    expect((payload(frames, 3)['scenarios'] as Array<{ selfcheck: string }>)[0]!.selfcheck).toBe('failing')
  })
})
