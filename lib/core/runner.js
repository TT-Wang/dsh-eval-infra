/**
 * The run engine: interleaved, repeated, paired execution of scenarios across
 * arms through a driver. The production driver spawns the real dsh SDK
 * runtime (one process per run, one session per scenario run); tests inject a
 * scripted driver. Scheduling order is fixed — scenario → repeat → arm — so
 * baseline and candidate always run back to back under the same conditions.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';
import { armOverlays } from './arms.js';
import { buildLedger } from './ledger.js';
import { scenarioSetup, scenarioVerify } from './scenario.js';
import { ledgerPath, writeJsonAtomic, writeLedger } from './store.js';
export class TurnTimeoutError extends Error {
    constructor(turn, ms) {
        super(`turn ${turn} exceeded ${Math.round(ms / 1000)}s`);
    }
}
/**
 * Fixed interleaving: scenario → repeat → arm. Odd repeats run baseline first,
 * even repeats run the arms in reverse (team-draft style), so neither arm
 * systematically enjoys a warmer server cache or a quieter minute.
 */
export function planJobs(scenarios, arms, repeats) {
    const jobs = [];
    let order = 0;
    for (const scenario of scenarios) {
        for (let rep = 1; rep <= repeats; rep += 1) {
            const ordered = rep % 2 === 1 ? arms : [...arms].reverse();
            for (const arm of ordered)
                jobs.push({ order: order++, scenario, arm, rep });
        }
    }
    return jobs;
}
/**
 * Ground truth must not be readable from inside the workspace. Scenario
 * generators that keep it under `<workdir>/.truth` get it moved out after
 * setup and back in before verify; the agent never sees it.
 */
export function stashTruth(workdir, stashRoot) {
    const truth = join(workdir, '.truth');
    if (!existsSync(truth))
        return undefined;
    mkdirSync(stashRoot, { recursive: true });
    const stash = join(stashRoot, 'truth-' + basename(workdir));
    renameSync(truth, stash);
    return () => { if (existsSync(stash))
        renameSync(stash, truth); };
}
/** Base overlays every arm shares; the scenario decides whether network tools are allowed. `extraRows` (e.g. the container rows) apply to both. */
export function writeBaseOverlays(armsDir, extraRows = []) {
    mkdirSync(armsDir, { recursive: true });
    const common = [
        { id: 'session-telemetry-otel', disabled: true },
        { id: 'session-title-llm', disabled: true },
        ...extraRows,
    ];
    const noNetwork = join(armsDir, '_base-no-network.patch.yml');
    const network = join(armsDir, '_base-network.patch.yml');
    writeFileSync(noNetwork, '# shared eval base: telemetry off, network tools off (scenario meta.network=false)\n' + yaml.dump([...common, { id: 'tool-web', disabled: true }]));
    writeFileSync(network, '# shared eval base: telemetry off, network tools on (scenario meta.network=true)\n' + yaml.dump(common));
    return { noNetwork, network };
}
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
function offsetTurn(e, offset) {
    const d = e.data;
    if (d !== null && typeof d === 'object' && typeof d.turn === 'number') {
        return { ...e, data: { ...d, turn: d.turn + offset } };
    }
    return e;
}
function sanitize(name) {
    return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}
/** Seeded Fisher–Yates shuffle (mulberry32). */
export function shuffled(items, seed) {
    const out = [...items];
    let a = seed >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
export async function executeRun(plan, scenarios, arms, deps) {
    const { paths } = deps;
    const ordered = deps.sequential ? shuffled(scenarios, deps.sequential.seed ?? 42) : scenarios;
    const jobs = planJobs(ordered, arms, plan.repeats);
    const base = writeBaseOverlays(paths.arms, deps.baseOverlayRows ?? []);
    const started = new Date();
    const progress = {
        status: 'running',
        total: jobs.length,
        completed: 0,
        failed: 0,
        usd: 0,
        startedAt: started.toISOString(),
        updatedAt: started.toISOString(),
        active: [],
        recent: [],
    };
    const publish = () => {
        progress.updatedAt = new Date().toISOString();
        writeJsonAtomic(paths.progress, progress);
        deps.onProgress?.(structuredClone(progress));
    };
    publish();
    let next = 0;
    let overBudget = false;
    let decidedEarly;
    const finished = new Map();
    const perScenarioDone = (scenario) => (finished.get(scenario)?.length ?? 0) >= arms.length * plan.repeats;
    const evaluateStop = async () => {
        if (!deps.sequential || arms.length < 2)
            return;
        const { asympCS, bettingCS, mean } = await import('./stats.js');
        const baseline = arms[0].name;
        const cand = arms[1].name;
        const done = ordered.filter(s => perScenarioDone(s.name));
        const costDiffs = [];
        const passX = [];
        for (const s of done) {
            const rows = finished.get(s.name) ?? [];
            const b = rows.filter(r => r.arm === baseline);
            const c = rows.filter(r => r.arm === cand);
            const pct = [];
            for (const rb of b) {
                const rc = c.find(x => x.rep === rb.rep);
                if (rc && rb.verdict?.ok && rc.verdict?.ok && rb.totals.usd > 0)
                    pct.push((rc.totals.usd - rb.totals.usd) / rb.totals.usd * 100);
            }
            if (pct.length)
                costDiffs.push(mean(pct));
            const pb = b.length ? b.filter(r => r.verdict?.ok && r.error === undefined).length / b.length : 0;
            const pc = c.length ? c.filter(r => r.verdict?.ok && r.error === undefined).length / c.length : 0;
            passX.push(((pc - pb) + 1) / 2);
        }
        const alpha = deps.sequential.alpha ?? 0.05;
        const minS = deps.sequential.minScenarios ?? 3;
        const sesoi = deps.sequential.sesoiPct ?? 10;
        const cost = costDiffs.length >= 2 ? asympCS(costDiffs, alpha, ordered.length) : null;
        const pass = passX.length >= 2 ? bettingCS(passX, alpha) : null;
        let decided = false;
        let reason = 'undecided';
        if (done.length >= minS && cost !== null) {
            const passDecided = pass !== null && (pass.lo > 0.5 || pass.hi < 0.5);
            const passNull = pass !== null && pass.lo <= 0.5 && pass.hi >= 0.5;
            if (passDecided) {
                decided = true;
                reason = pass.lo > 0.5 ? 'candidate passes more scenarios (pass-difference sequence excludes 0)' : 'candidate passes fewer scenarios (pass-difference sequence excludes 0)';
            }
            else if (passNull && (cost.lo > 0 || cost.hi < 0)) {
                decided = true;
                reason = `${cost.hi < 0 ? 'cheaper' : 'more expensive'}: cost Δ% sequence excludes 0 (${cost.lo.toFixed(1)} to ${cost.hi.toFixed(1)})`;
            }
            else if (passNull && cost.lo > -sesoi && cost.hi < sesoi) {
                decided = true;
                reason = `equivalent within ±${sesoi}%: cost Δ% sequence inside the band (${cost.lo.toFixed(1)} to ${cost.hi.toFixed(1)})`;
            }
        }
        const decision = { scenarios: done.length, cost: cost ? { mean: cost.mean, lo: cost.lo, hi: cost.hi } : null, pass: pass ? { lo: pass.lo, hi: pass.hi } : null, decided, reason };
        deps.sequential.onDecision?.(decision);
        if (decided)
            decidedEarly = decision;
    };
    const worker = async () => {
        for (;;) {
            if (deps.signal?.aborted)
                return;
            if (deps.maxUsd !== undefined && progress.usd >= deps.maxUsd) {
                overBudget = true;
                return;
            }
            if (decidedEarly !== undefined)
                return;
            const job = jobs[next++];
            if (job === undefined)
                return;
            if (deps.resume && existsSync(ledgerPath(paths, job.scenario.name, job.arm.name, job.rep))) {
                progress.completed += 1;
                publish();
                continue;
            }
            const active = { scenario: job.scenario.name, arm: job.arm.name, rep: job.rep, turn: 0, turns: job.scenario.prompts.length, startedAt: new Date().toISOString() };
            progress.active.push(active);
            publish();
            let ledger;
            try {
                ledger = await runJob(job, plan, deps, base, (turn) => { active.turn = turn; publish(); });
            }
            catch (error) {
                deps.log?.(`!! ${job.scenario.name}/${job.arm.name}#${job.rep}: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                progress.active = progress.active.filter(a => a !== active);
            }
            progress.completed += 1;
            if (ledger === undefined || ledger.error !== undefined)
                progress.failed += 1;
            if (ledger !== undefined) {
                finished.set(ledger.scenario, [...(finished.get(ledger.scenario) ?? []), ledger]);
                if (deps.sequential && perScenarioDone(ledger.scenario))
                    await evaluateStop();
                progress.usd += ledger.totals.usd;
                const entry = { scenario: ledger.scenario, arm: ledger.arm, rep: ledger.rep, ok: ledger.verdict?.ok ?? null, usd: ledger.totals.usd, wallMs: ledger.wallMs };
                if (ledger.error !== undefined)
                    entry.error = ledger.error;
                progress.recent = [entry, ...progress.recent].slice(0, 12);
                deps.onLedger?.(ledger);
            }
            publish();
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(plan.concurrency, jobs.length)) }, () => worker());
    await Promise.all(workers);
    progress.status = deps.signal?.aborted || overBudget ? 'cancelled' : 'done';
    if (overBudget)
        progress.error = `budget of $${deps.maxUsd.toFixed(2)} reached after ${progress.completed}/${progress.total} trials`;
    if (decidedEarly !== undefined) {
        progress.status = 'done';
        progress.stoppedEarly = { after: decidedEarly.scenarios, of: ordered.length, reason: decidedEarly.reason };
    }
    publish();
    return progress;
}
async function runJob(job, plan, deps, base, onTurn) {
    const { scenario, arm } = job;
    const workRoot = deps.workRoot ?? tmpdir();
    mkdirSync(workRoot, { recursive: true });
    const workdir = mkdtempSync(join(workRoot, `dsh-eval-${sanitize(scenario.name)}-${sanitize(arm.name)}-`));
    const startedAt = new Date();
    const events = [];
    const turnWall = new Map();
    let sessionId = null;
    let sessions = 1;
    let error;
    let verdict = null;
    const timeoutMs = deps.turnTimeoutMs ?? (scenario.meta.turn_timeout_s !== undefined ? scenario.meta.turn_timeout_s * 1000 : DEFAULT_TURN_TIMEOUT_MS);
    let restoreTruth;
    try {
        await scenarioSetup(scenario, workdir);
        restoreTruth = stashTruth(workdir, join(workRoot, '.truth-stash'));
        const overlays = [scenario.meta.network ? base.network : base.noNetwork, ...armOverlays(arm)];
        const breaks = new Set(scenario.meta.new_session_before_turns ?? []);
        const makeDriver = () => deps.driverFactory({ arm, scenario, workdir, evalHome: deps.evalHome, overlays, env: { ...deps.env, ...(arm.env ?? {}) } });
        let driver = makeDriver();
        // A fresh session numbers its turns from 1 again; the ledger keeps one global turn axis.
        let turnOffset = 0;
        try {
            for (let i = 0; i < scenario.prompts.length; i += 1) {
                if (i > 0 && breaks.has(i + 1)) {
                    await driver.close();
                    sessions += 1;
                    turnOffset = i;
                    driver = makeDriver();
                }
                onTurn(i + 1);
                const t0 = Date.now();
                const options = { timeoutMs };
                if (deps.signal !== undefined)
                    options.signal = deps.signal;
                const result = await driver.runTurn(scenario.prompts[i], options);
                turnWall.set(i + 1, Date.now() - t0);
                events.push(...(turnOffset === 0 ? result.events : result.events.map(e => offsetTurn(e, turnOffset))));
                if (result.sessionId !== null)
                    sessionId = sessionId === null || sessionId === result.sessionId ? result.sessionId : `${sessionId},${result.sessionId}`;
            }
        }
        finally {
            await driver.close();
        }
    }
    catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }
    try {
        restoreTruth?.();
        verdict = await scenarioVerify(scenario, workdir);
        // Judge artifacts: copy the listed files out before the workspace is discarded.
        if (scenario.meta.judge && scenario.meta.judge.artifacts.length > 0) {
            const dest = join(deps.paths.dir, 'ledgers', scenario.name, arm.name, `rep${job.rep}.artifacts`);
            mkdirSync(dest, { recursive: true });
            for (const rel of scenario.meta.judge.artifacts) {
                const src = join(workdir, rel);
                if (existsSync(src))
                    cpSync(src, join(dest, rel), { recursive: true });
            }
        }
    }
    catch (e) {
        verdict = { ok: false, detail: `verify failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const endedAt = new Date();
    const eventsFile = join('ledgers', scenario.name, arm.name, `rep${job.rep}.events.jsonl`);
    const traceFile = join('ledgers', scenario.name, arm.name, `rep${job.rep}.trace.jsonl`);
    const input = {
        runId: plan.id,
        scenario: scenario.name,
        arm: arm.name,
        rep: job.rep,
        order: job.order,
        startedAt,
        endedAt,
        provider: arm.provider,
        model: arm.model,
        events,
        turnWall,
        verdict,
        sessionId,
        workdir,
        eventsFile,
        traceFile,
        sessions,
        ...(deps.prices !== undefined ? { prices: deps.prices } : {}),
        ...(error !== undefined ? { error } : {}),
    };
    const { ledger, trace } = buildLedger(input);
    mkdirSync(join(deps.paths.dir, 'ledgers', scenario.name, arm.name), { recursive: true });
    writeFileSync(join(deps.paths.dir, eventsFile), events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    writeFileSync(join(deps.paths.dir, traceFile), trace.map(t => JSON.stringify(t)).join('\n') + (trace.length ? '\n' : ''));
    writeLedger(deps.paths, ledger);
    deps.log?.(`${ledger.verdict?.ok ? '✓' : '✗'} ${scenario.name}/${arm.name}#${job.rep} · $${ledger.totals.usd.toFixed(4)} · ${ledger.totals.steps} steps · ${(ledger.wallMs / 1000).toFixed(0)}s${error !== undefined ? ` · ERROR ${error}` : ''}`);
    if (!deps.keepWorkdirs && error === undefined)
        rmSync(workdir, { recursive: true, force: true });
    return ledger;
}
