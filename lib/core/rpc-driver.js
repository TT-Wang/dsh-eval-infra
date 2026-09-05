/**
 * A minimal client for the dsh SDK wire protocol (newline-delimited JSON-RPC
 * over stdio) that can spawn *any* command — the local dsh CLI or a `docker
 * run` wrapping it. It mirrors the official client's activity interval: queue
 * the prompt, wait for its inbox receipt, collect every session event until
 * the whole agent reports idle.
 */
import { spawn } from 'node:child_process';
import { TurnTimeoutError } from './runner.js';
export class RpcDriver {
    launch;
    child;
    nextId = 1;
    pending = new Map();
    listeners = new Set();
    buffer = '';
    stderrTail = [];
    initialized;
    sessionId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    exited;
    turn = 0;
    constructor(launch) {
        this.launch = launch;
    }
    start() {
        if (this.initialized)
            return this.initialized;
        const child = spawn(this.launch.command, this.launch.args, { cwd: this.launch.cwd ?? process.cwd(), env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.onData(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            for (const line of chunk.split('\n')) {
                if (line.trim() === '' || /UNDICI|trace-warnings/.test(line))
                    continue;
                this.stderrTail.push(line.slice(0, 300));
                if (this.stderrTail.length > 40)
                    this.stderrTail.shift();
                this.launch.onStderr?.(line);
            }
        });
        child.on('exit', (code) => {
            this.exited = { code };
            const error = new Error(`dsh runtime exited (code ${code ?? 'signal'}): ${this.stderrTail.slice(-5).join(' | ')}`);
            for (const p of this.pending.values())
                p.reject(error);
            this.pending.clear();
            for (const l of this.listeners)
                l('__exit__', { code });
        });
        child.on('error', (e) => { this.exited = { code: null }; for (const p of this.pending.values())
            p.reject(e); this.pending.clear(); });
        const params = { cwd: this.launch.runtimeCwd, provider: this.launch.provider, model: this.launch.model };
        if (this.launch.effort !== undefined)
            params['reasoningEffort'] = this.launch.effort;
        if (this.launch.maxTokens !== undefined)
            params['maxTokens'] = this.launch.maxTokens;
        this.initialized = this.request('initialize', params, this.launch.initializeTimeoutMs ?? 120_000).then(() => undefined);
        return this.initialized;
    }
    onData(chunk) {
        this.buffer += chunk;
        let nl = this.buffer.indexOf('\n');
        while (nl !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line !== '')
                this.onFrame(line);
            nl = this.buffer.indexOf('\n');
        }
    }
    onFrame(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error)
                p.reject(new Error(`${msg.error.code ?? ''} ${msg.error.message ?? 'rpc error'}`.trim()));
            else
                p.resolve(msg.result);
        }
        else if (msg.method !== undefined) {
            if (this.launch.onFrame) {
                const ev = msg.params;
                this.launch.onFrame(`${msg.method}${ev?.event?.type ? ' ' + ev.event.type : ''}${ev?.status ? ' ' + ev.status : ''}`);
            }
            for (const l of this.listeners)
                l(msg.method, msg.params ?? {});
        }
    }
    request(method, params, timeoutMs) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms; stderr: ${this.stderrTail.slice(-3).join(' | ')}`)); }, timeoutMs);
            this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    async runTurn(prompt, options) {
        await this.start();
        this.turn += 1;
        const events = [];
        return new Promise((resolve, reject) => {
            let received = false;
            let done = false;
            let messageId;
            const finish = (err) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                this.listeners.delete(listener);
                options.signal?.removeEventListener('abort', onAbort);
                if (err)
                    reject(err);
                else
                    resolve({ events, sessionId: this.sessionId });
            };
            const timer = setTimeout(() => finish(new TurnTimeoutError(this.turn, options.timeoutMs)), options.timeoutMs);
            const onAbort = () => finish(new Error('cancelled'));
            options.signal?.addEventListener('abort', onAbort, { once: true });
            // Notifications can outrun the prompt's own response (the receipt is emitted as the message is queued), so frames are
            // buffered until the message id is known and then replayed in order — the same interval semantics as the official client.
            const backlog = [];
            const handle = (method, params) => {
                if (method === '__exit__') {
                    finish(new Error(`dsh runtime exited mid-turn: ${this.stderrTail.slice(-3).join(' | ')}`));
                    return;
                }
                if (params['sessionId'] !== this.sessionId)
                    return;
                if (method === 'session.event') {
                    const event = params['event'];
                    if (!received) {
                        if (event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(m => m?.id === messageId))
                            received = true;
                        else
                            return;
                    }
                    events.push(event);
                    options.onEvent?.(event);
                }
                else if (method === 'session.status' && received && params['status'] === 'idle')
                    finish();
            };
            const listener = (method, params) => {
                if (messageId === undefined) {
                    backlog.push([method, params]);
                    return;
                }
                handle(method, params);
            };
            this.listeners.add(listener);
            this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text: prompt }] }, 60_000)
                .then((r) => {
                messageId = r.messageId;
                for (const [m, p] of backlog.splice(0)) {
                    if (done)
                        break;
                    handle(m, p);
                }
            })
                .catch(finish);
        });
    }
    async close() {
        const child = this.child;
        if (!child)
            return;
        this.child = undefined;
        if (this.exited === undefined) {
            try {
                await this.request('shutdown', undefined, 3000);
            }
            catch { /* fall through to signals */ }
        }
        if (this.exited === undefined) {
            try {
                child.stdin?.end();
            }
            catch { /* ignore */ }
            await new Promise((resolve) => {
                const t = setTimeout(() => { try {
                    child.kill('SIGKILL');
                }
                catch { /* ignore */ } resolve(); }, 8000);
                child.once('exit', () => { clearTimeout(t); resolve(); });
                try {
                    child.kill('SIGTERM');
                }
                catch { /* ignore */ }
            });
        }
    }
}
