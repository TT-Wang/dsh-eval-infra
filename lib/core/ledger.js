/**
 * Build a RunLedger from the session events of one run. Every number the
 * report shows traces back to a session event: usage from assistant/message,
 * verdict from verify.py, end reasons from turn/end.
 */
import { createHash } from 'node:crypto';
import { bandAt, priceUsage, DEEPSEEK_PRICES } from './pricing.js';
import { addUsage, normalizeUsage, ZERO_USAGE } from './usage.js';
const OBSERVATION_MAX_CHARS = 4000;
export function buildLedger(input) {
    const prices = input.prices ?? DEEPSEEK_PRICES;
    const steps = [];
    const trace = [];
    const behaviour = { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 };
    let lastCallKey = '';
    const turnsMap = new Map();
    const toolHistogram = {};
    const eventCounts = {};
    let header;
    let peakPrompt = 0;
    let usdPeak = 0;
    let usdOffpeak = 0;
    const seenSteps = new Set();
    const invariants = [];
    const stepStart = new Map();
    for (const e of input.events) {
        eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
        const d = (e.data ?? {});
        if (e.type === 'step/start') {
            stepStart.set(`${Number(d['turn'] ?? 0)}/${Number(d['step'] ?? 0)}`, e.time ?? 0);
        }
        else if (e.type === 'step/end') {
            const key = `${Number(d['turn'] ?? 0)}/${Number(d['step'] ?? 0)}`;
            const start = stepStart.get(key);
            const row = steps.find(st => `${st.turn}/${st.step}` === key);
            if (start !== undefined && row !== undefined && e.time !== undefined)
                row.durationMs = Math.max(0, e.time - start);
        }
        else if (e.type === 'request/header' && header === undefined) {
            header = (d['header'] ?? undefined);
        }
        else if (e.type === 'tool/call') {
            const name = String(d['name'] ?? '?');
            toolHistogram[name] = (toolHistogram[name] ?? 0) + 1;
            const key = `${name}\u0000${String(d['arguments'] ?? '')}`;
            if (key === lastCallKey)
                behaviour.repeatedCalls += 1;
            lastCallKey = key;
        }
        else if (e.type === 'tool/result') {
            const message = (d['message'] ?? {});
            const block = (message.content ?? []).find(b => b.type === 'tool-result');
            const text = (block?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
            const isError = block?.isError === true || d['error'] !== undefined;
            if (isError)
                behaviour.toolErrors += 1;
            behaviour.observationChars += text.length;
            const last = trace.at(-1);
            if (last !== undefined)
                last.observations.push({ callId: String(block?.toolCallId ?? ''), chars: text.length, isError, text: text.length > OBSERVATION_MAX_CHARS ? `${text.slice(0, OBSERVATION_MAX_CHARS)}\n…[${text.length - OBSERVATION_MAX_CHARS} more chars]` : text });
        }
        else if (e.type === 'compaction/start') {
            behaviour.compactions += 1;
        }
        else if (e.type === 'assistant/message') {
            const turn = Number(d['turn'] ?? 0);
            const step = Number(d['step'] ?? 0);
            const key = `${turn}/${step}`;
            if (seenSteps.has(key))
                invariants.push(`duplicate assistant/message for turn ${turn} step ${step}: usage would be double counted`);
            seenSteps.add(key);
            const time = e.time ?? input.startedAt.getTime();
            const message = (d['message'] ?? {});
            const content = message.content ?? [];
            const calls = content.filter(b => b.type === 'tool-call').map(b => ({ name: b.name ?? '?', arguments: b.arguments ?? '' }));
            const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
            const reasoning = content.filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('');
            const usage = normalizeUsage(d['usage']);
            const band = bandAt(time, prices);
            const usd = usage ? priceUsage(input.model, band, usage, prices) : 0;
            if (usage) {
                usdPeak += priceUsage(input.model, 'peak', usage, prices);
                usdOffpeak += priceUsage(input.model, 'offpeak', usage, prices);
                peakPrompt = Math.max(peakPrompt, usage.hit + usage.miss);
            }
            if (calls.length === 0 && text.trim() === '')
                behaviour.noActionSteps += 1;
            steps.push({ ...(usage ?? ZERO_USAGE), turn, step, time, band, usd, calls: calls.map(c => ({ name: c.name, args: c.arguments.slice(0, 200) })), textChars: text.length, reasoningChars: reasoning.length });
            trace.push({ turn, step, time, calls, text, reasoning, usage: usage ?? null, usd, observations: [] });
            const row = turnsMap.get(turn) ?? { ...ZERO_USAGE, turn, steps: 0, usd: 0, wallMs: input.turnWall.get(turn) ?? 0, end: 'unknown' };
            const summed = addUsage(row, usage ?? ZERO_USAGE);
            turnsMap.set(turn, { ...row, ...summed, steps: Math.max(row.steps, step), usd: row.usd + usd });
        }
        else if (e.type === 'turn/end') {
            const turn = Number(d['turn'] ?? 0);
            const reason = (d['reason'] ?? {});
            const row = turnsMap.get(turn) ?? { ...ZERO_USAGE, turn, steps: 0, usd: 0, wallMs: input.turnWall.get(turn) ?? 0, end: 'unknown' };
            row.end = reason.kind ?? 'unknown';
            if (reason.kind === 'error')
                row.error = `${reason.error?.code ?? 'UNKNOWN'}: ${reason.error?.message ?? ''}`.slice(0, 500);
            turnsMap.set(turn, row);
        }
    }
    const turns = [...turnsMap.values()].sort((a, b) => a.turn - b.turn);
    const sum = turns.reduce((acc, t) => addUsage(acc, t), ZERO_USAGE);
    const totals = {
        ...sum,
        steps: steps.length,
        turns: turns.length,
        usd: turns.reduce((a, t) => a + t.usd, 0),
        usdPeak,
        usdOffpeak,
        peakPrompt,
    };
    const system = header?.system;
    const ledger = {
        schema: 'dsh-eval-ledger/1',
        runId: input.runId,
        scenario: input.scenario,
        arm: input.arm,
        rep: input.rep,
        order: input.order,
        startedAt: input.startedAt.toISOString(),
        endedAt: input.endedAt.toISOString(),
        wallMs: input.endedAt.getTime() - input.startedAt.getTime(),
        provider: input.provider,
        model: input.model,
        resolvedEffort: header?.config?.reasoningEffort ?? null,
        headerModel: header?.config?.model ?? null,
        tools: (header?.tools ?? []).map(t => t.name),
        systemPromptSha: system !== undefined ? createHash('sha256').update(system).digest('hex') : null,
        systemPromptChars: system?.length ?? 0,
        turns,
        steps,
        totals,
        toolHistogram,
        eventCounts,
        verdict: input.verdict,
        behaviour,
        sessionId: input.sessionId,
        workdir: input.workdir,
        eventsFile: input.eventsFile,
        traceFile: input.traceFile,
        sessions: input.sessions ?? 1,
    };
    if (input.error !== undefined)
        ledger.error = input.error;
    if (invariants.length > 0)
        ledger.invariantViolations = invariants;
    return { ledger, trace };
}
