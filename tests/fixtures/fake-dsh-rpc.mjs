// A stand-in for the dsh runtime's stdio JSON-RPC peer: enough of the wire protocol for the RpcDriver tests.
// Modes (argv[2]): "ok" (default) answers every turn; "hang" never reports idle; "crash" exits mid-turn.
import { createInterface } from 'node:readline'
const mode = process.argv[2] ?? 'ok'
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let seq = 0
const event = (sessionId, type, data) => ({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq: ++seq, time: Date.now(), data } } })
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stderr.write('booted\n')
    out({ jsonrpc: '2.0', id: msg.id, result: { ok: true, cwd: msg.params.cwd, model: msg.params.model } })
    return
  }
  if (msg.method === 'shutdown') {
    out({ jsonrpc: '2.0', id: msg.id, result: {} })
    process.exit(0)
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId
    const prompt = msg.params.contentBlocks[0].text
    // A notification that outruns the prompt's own response (the receipt is emitted as the message is queued).
    out(event(sessionId, 'agent/inbox/spliced', { inserted: [{ id: 'msg-' + msg.id }] }))
    out({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'msg-' + msg.id } })
    // An event for a different session must be ignored by the driver.
    out(event('someone-else', 'assistant/message', { message: { content: [{ type: 'text', text: 'not yours' }] } }))
    if (mode === 'crash') { process.stderr.write('boom\n'); process.exit(3) }
    out(event(sessionId, 'request/header', { header: { config: { provider: 'deepseek', model: 'm' } } }))
    out(event(sessionId, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'echo: ' + prompt }] }, usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 3 } }))
    if (mode === 'hang') return
    out({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
  }
})
