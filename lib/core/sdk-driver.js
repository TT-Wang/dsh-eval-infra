import { TurnTimeoutError } from './runner.js';
async function loadHarness() {
    const mod = await import('@deepseek-ai/dsh-sdk-client');
    return mod.DeepSeekHarness;
}
export function sdkDriverFactory(options = {}) {
    return (input) => new SdkDriver(input, options);
}
class SdkDriver {
    input;
    options;
    harness;
    session;
    turn = 0;
    constructor(input, options) {
        this.input = input;
        this.options = options;
    }
    async ensure() {
        if (this.session !== undefined)
            return this.session;
        const Harness = await loadHarness();
        const { arm, workdir, evalHome, overlays, env } = this.input;
        const opts = {
            profile: arm.profile,
            patches: overlays,
            dshHome: evalHome,
            cwd: workdir,
            processCwd: workdir,
            provider: arm.provider,
            model: arm.model,
            env: { ...process.env, ...env },
            initializeTimeoutMs: this.options.initializeTimeoutMs ?? 60_000,
        };
        if (arm.effort !== undefined)
            opts['reasoningEffort'] = arm.effort;
        if (arm.maxTokens !== undefined)
            opts['maxTokens'] = arm.maxTokens;
        if (this.options.dshBin !== undefined)
            opts['dshBin'] = this.options.dshBin;
        this.harness = new Harness(opts);
        this.session = this.harness.session();
        return this.session;
    }
    async runTurn(prompt, options) {
        const session = await this.ensure();
        // The client observes every notification as it comes off the wire; the root
        // session's events are what a live view of the trial is made of.
        const onEvent = options.onEvent;
        const runOptions = onEvent === undefined ? undefined : {
            onNotification: (n) => {
                if (n.method === 'session.event' && n.params['sessionId'] === session.id)
                    onEvent(n.params['event']);
            },
        };
        this.turn += 1;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TurnTimeoutError(this.turn, options.timeoutMs)), options.timeoutMs);
        });
        const abort = new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        try {
            const result = await Promise.race([session.run(prompt, runOptions), timeout, abort]);
            return { events: result.events, sessionId: result.sessionId };
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    async close() {
        const h = this.harness;
        this.harness = undefined;
        this.session = undefined;
        if (h !== undefined)
            await h.close();
    }
}
