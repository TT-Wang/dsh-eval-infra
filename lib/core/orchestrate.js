/**
 * One entry point for "start a run": used by the CLI and by the web API so
 * both follow the same discipline — scenarios self-checked, arms composed and
 * diffed through dsh, environment recorded, ledgers written, report built.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadArmFile } from './arms.js';
import { resolveApiKey } from './env.js';
import { describeDiff, evalProfileManifest, prepareArms, recordEnvironment } from './plan.js';
import { buildReport, noiseFloorOf, renderMarkdown } from './report.js';
import { executeRun } from './runner.js';
import { listScenarios } from './scenario.js';
import { sdkDriverFactory } from './sdk-driver.js';
import { selfcheckAll } from './selfcheck.js';
import { applyAnnotations, listRuns, newRunId, readAnnotations, readLedgers, readPlan, runPaths, writeJsonAtomic } from './store.js';
export class LaunchError extends Error {
    code;
    constructor(message, code = 'usage') {
        super(message);
        this.code = code;
    }
}
export function resolveArmPath(project, ref) {
    const direct = resolve(project.root, ref);
    if (existsSync(direct) && /\.(ya?ml|json)$/.test(direct))
        return direct;
    for (const ext of ['.yml', '.yaml', '.json']) {
        const p = join(project.armsDir, ref + ext);
        if (existsSync(p))
            return p;
    }
    throw new LaunchError(`arm not found: ${ref} (looked for a file, then ${project.armsDir}/${ref}.yml)`, 'arms');
}
export function collectScenarios(project, request) {
    const filter = {};
    if (request.scenarios && request.scenarios.length)
        filter.names = request.scenarios;
    if (request.categories && request.categories.length)
        filter.categories = request.categories;
    if (request.tags && request.tags.length)
        filter.tags = request.tags;
    if (request.includeHoldout)
        filter.includeHoldout = true;
    const roots = [project.scenarioRoot, ...(project.config.pools ?? []).map(p => resolve(project.root, p))];
    const seen = new Set();
    const scenarios = [];
    const invalid = [];
    for (const root of roots) {
        const r = listScenarios(root, filter);
        for (const s of r.scenarios)
            if (!seen.has(s.name)) {
                seen.add(s.name);
                scenarios.push(s);
            }
        invalid.push(...r.invalid);
    }
    return { scenarios, invalid };
}
/** Prepare everything, then start the run in the background; `done` resolves with the report. */
export async function launchRun(project, request, hooks = {}) {
    const log = hooks.log ?? (() => { });
    const profile = project.config.profile;
    if (!evalProfileManifest(project.home, profile).exists) {
        throw new LaunchError(`eval profile "${profile}" is not initialised under ${project.home}; run: dsh-eval init [--plugin <path>]`, 'env');
    }
    const apiKey = resolveApiKey();
    if (apiKey === undefined && hooks.driverFactory === undefined) {
        throw new LaunchError('DEEPSEEK_API_KEY not found (env, $DSH_HOME/.env or ~/.dsh/.env)', 'env');
    }
    let plan;
    let id;
    let baselineSpec;
    let candidateSpecs;
    const sources = {};
    if (request.resume !== undefined) {
        id = request.resume;
        const paths = runPaths(project.runsRoot, id);
        if (!existsSync(paths.plan))
            throw new LaunchError(`run ${id} not found under ${paths.root}`, 'usage');
        plan = readPlan(paths);
        baselineSpec = plan.baseline;
        candidateSpecs = plan.candidates;
    }
    else {
        if (request.candidates.length === 0 && !request.aa)
            throw new LaunchError('at least one candidate arm is required', 'usage');
        const baselinePath = resolveArmPath(project, request.baseline);
        baselineSpec = loadArmFile(baselinePath);
        sources[baselineSpec.name] = baselinePath;
        if (request.aa) {
            const twin = { ...baselineSpec, name: `${baselineSpec.name}-aa`, description: `identical copy of ${baselineSpec.name} (A/A noise floor)` };
            sources[twin.name] = baselinePath;
            candidateSpecs = [twin];
        }
        else
            candidateSpecs = request.candidates.map((c) => {
                const p = resolveArmPath(project, c);
                const spec = loadArmFile(p);
                sources[spec.name] = p;
                return spec;
            });
        id = newRunId();
        plan = {
            id,
            createdAt: new Date().toISOString(),
            baseline: baselineSpec,
            candidates: candidateSpecs,
            scenarios: [],
            repeats: request.repeats ?? project.config.repeats,
            concurrency: request.concurrency ?? project.config.concurrency,
            scenarioRoot: project.scenarioRoot,
        };
        if (request.label !== undefined)
            plan.label = request.label;
    }
    if (plan.repeats < 1)
        throw new LaunchError('repeats must be at least 1', 'usage');
    const { scenarios, invalid } = request.resume !== undefined
        ? collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true })
        : collectScenarios(project, request);
    for (const i of invalid)
        log(`!! skipping invalid scenario ${i.dir}: ${i.error}`);
    if (scenarios.length === 0)
        throw new LaunchError(`no scenarios matched under ${project.scenarioRoot}`, 'usage');
    plan.scenarios = scenarios.map(s => s.name);
    let selfcheck = [];
    if (!request.skipSelfcheck) {
        log(`selfcheck: ${scenarios.length} scenario(s)…`);
        selfcheck = await selfcheckAll(scenarios);
        const broken = selfcheck.filter(r => !r.ok);
        for (const r of selfcheck)
            log(`  ${r.ok ? 'OK ' : 'BAD'} ${r.name.padEnd(28)} blank→${r.blankPasses === null ? '?' : r.blankPasses ? 'PASS?!' : 'fail'} oracle→${r.oraclePasses === null ? 'n/a' : r.oraclePasses ? 'pass' : 'FAIL'} ${r.error ?? r.detail}`);
        if (broken.length > 0)
            throw new LaunchError(`${broken.length} scenario(s) failed selfcheck: ${broken.map(b => b.name).join(', ')} (fix them or pass --skip-selfcheck)`, 'selfcheck');
    }
    const paths = runPaths(project.runsRoot, id);
    mkdirSync(paths.dir, { recursive: true });
    const prepareOptions = { evalHome: project.home, armsDir: paths.arms, sources };
    if (hooks.invoke !== undefined)
        prepareOptions.invoke = hooks.invoke;
    let prepared;
    try {
        prepared = await prepareArms(baselineSpec, candidateSpecs, prepareOptions);
    }
    catch (error) {
        throw new LaunchError(`could not compose arms through dsh: ${error.message}`, 'arms');
    }
    for (const d of prepared.diffs) {
        log(`arm ${d.candidate} vs ${prepared.baseline.name}: ${d.variables} variable(s)`);
        for (const line of describeDiff(d))
            log(`    ${line}`);
        if (d.variables === 0 && !request.aa)
            log(`!! arm ${d.candidate} is identical to the baseline; this is an A/A run in effect`);
        if (d.variables > 1 && !request.allowMulti) {
            throw new LaunchError(`arm ${d.candidate} differs from ${prepared.baseline.name} in ${d.variables} variables; a fair A/B changes one thing (pass --allow-multi to run anyway, the report will be marked multi-variable)`, 'arms');
        }
    }
    writeJsonAtomic(paths.plan, plan);
    const env = await recordEnvironment(prepared.composed);
    writeJsonAtomic(paths.env, { ...env, diffs: prepared.diffs, multiVariable: prepared.diffs.some(d => d.variables > 1) });
    for (const [arm, text] of Object.entries(prepared.composed))
        writeFileSync(join(paths.arms, `${arm}.composed.yml`), text);
    const runEnv = { DSH_TELEMETRY_DISABLED: '1' };
    if (apiKey !== undefined)
        runEnv['DEEPSEEK_API_KEY'] = apiKey;
    const deps = {
        driverFactory: hooks.driverFactory ?? sdkDriverFactory(project.config.dshBin !== undefined ? { dshBin: project.config.dshBin } : {}),
        evalHome: project.home,
        paths,
        env: runEnv,
        log,
        workRoot: join(project.evalDir, 'work'),
    };
    if (hooks.signal !== undefined)
        deps.signal = hooks.signal;
    if (hooks.onProgress !== undefined)
        deps.onProgress = hooks.onProgress;
    if (hooks.onLedger !== undefined)
        deps.onLedger = hooks.onLedger;
    if (request.keepWorkdirs)
        deps.keepWorkdirs = true;
    if (request.turnTimeoutS !== undefined)
        deps.turnTimeoutMs = request.turnTimeoutS * 1000;
    if (request.resume !== undefined)
        deps.resume = true;
    if (request.maxUsd !== undefined)
        deps.maxUsd = request.maxUsd;
    const decisions = [];
    if (request.sequential) {
        deps.sequential = { seed: request.seed ?? 42, onDecision: (d) => { decisions.push(d); log(`sequential: after ${d.scenarios} scenarios · cost Δ% ${d.cost ? `${d.cost.mean.toFixed(1)} [${d.cost.lo.toFixed(1)}, ${d.cost.hi.toFixed(1)}]` : '—'} · pass seq ${d.pass ? `[${d.pass.lo.toFixed(2)}, ${d.pass.hi.toFixed(2)}]` : '—'} · ${d.decided ? 'DECIDED: ' + d.reason : 'continue'}`); } };
        log('sequential mode: scenarios in seeded random order; the run stops once the anytime-valid sequences decide the comparison');
    }
    const done = (async () => {
        const progress = await executeRun(plan, scenarios, [prepared.baseline, ...prepared.candidates], deps);
        if (request.sequential)
            writeJsonAtomic(join(paths.dir, 'sequential.json'), { seed: request.seed ?? 42, candidate: candidateSpecs[0]?.name ?? null, decisions });
        const report = buildReport(plan, readLedgers(paths), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout: new Set(scenarios.filter(s => s.meta.holdout).map(s => s.name)), ...sequencesOf(paths) });
        if (request.sequential) {
            const last = decisions.at(-1);
            if (progress.stoppedEarly)
                report.notes.unshift(`Sequential mode stopped after ${progress.stoppedEarly.after} of ${progress.stoppedEarly.of} scenarios: ${progress.stoppedEarly.reason}. The estimate applies to the scenario pool the shuffle drew from; unrun scenarios are not "incomplete", they were not needed.`);
            else if (last)
                report.notes.unshift(`Sequential mode ran every scenario without an early decision (last sequence: cost Δ% ${last.cost ? `[${last.cost.lo.toFixed(1)}, ${last.cost.hi.toFixed(1)}]` : '—'}).`);
        }
        if (prepared.diffs.some(d => d.variables > 1))
            report.notes.unshift('Multi-variable comparison: at least one candidate differs from the baseline in more than one row; the result cannot be attributed to a single change.');
        writeJsonAtomic(paths.report, report);
        writeFileSync(paths.reportMd, renderMarkdown(report));
        return { progress, report };
    })();
    return { id, plan, diffs: prepared.diffs, scenarios, selfcheck, done };
}
/** Per-scenario mean cost of an arm across earlier runs (excluding `exceptRunId`) — the CUPED covariate. */
export function archiveBaselineCosts(project, arm, exceptRunId) {
    const sums = new Map();
    for (const r of listRuns(project.runsRoot)) {
        if (r.id === exceptRunId)
            continue;
        const paths = runPaths(project.runsRoot, r.id);
        for (const l of readLedgers(paths)) {
            if (l.arm !== arm || l.error !== undefined)
                continue;
            const e = sums.get(l.scenario) ?? { usd: 0, n: 0 };
            e.usd += l.totals.usd;
            e.n += 1;
            sums.set(l.scenario, e);
        }
    }
    return Object.fromEntries([...sums.entries()].map(([k, v]) => [k, v.usd / v.n]));
}
/** The most recent A/A noise floor per baseline arm found in the archive (excluding `exceptRunId`). */
export function archiveNoiseFloors(project, exceptRunId) {
    const out = {};
    for (const r of listRuns(project.runsRoot)) {
        if (r.id === exceptRunId || r.status !== 'done')
            continue;
        const paths = runPaths(project.runsRoot, r.id);
        if (!existsSync(paths.plan))
            continue;
        try {
            const plan = readPlan(paths);
            if (out[plan.baseline.name] !== undefined)
                continue;
            const floor = noiseFloorOf(plan, readLedgers(paths));
            if (floor !== null)
                out[plan.baseline.name] = floor;
        }
        catch { /* unreadable run */ }
    }
    return out;
}
/**
 * Run the blinded pairwise judge over every scenario of a finished run that
 * declares `meta.judge`. Writes `judge-<candidate>.json` next to the report and
 * returns it. The judge model defaults to deepseek-v4-pro so it differs from
 * the usual v4-flash arms (same family: a stated limitation).
 */
export async function runJudge(project, id, options = {}) {
    const { judgeRun, deepseekChat } = await import('./judge.js');
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    const plan = readPlan(paths);
    const ledgers = readLedgers(paths);
    const { scenarios } = collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true });
    const specs = {};
    for (const s of scenarios)
        if (s.meta.judge)
            specs[s.name] = s.meta.judge;
    if (Object.keys(specs).length === 0)
        throw new LaunchError('no scenario in this run declares meta.judge', 'usage');
    const model = options.model ?? 'deepseek-v4-pro';
    let chat = options.chat;
    if (chat === undefined) {
        const apiKey = resolveApiKey();
        if (apiKey === undefined)
            throw new LaunchError('DEEPSEEK_API_KEY not found for the judge', 'env');
        chat = deepseekChat({ model, apiKey, ...(options.seed !== undefined ? { seed: options.seed } : {}) });
    }
    const annotations = readAnnotations(paths);
    const out = [];
    for (const cand of plan.candidates.filter(c => options.candidate === undefined || c.name === options.candidate)) {
        const report = await judgeRun({
            plan,
            candidate: cand.name,
            ledgers,
            specs,
            artifactDir: (scenario, arm, rep) => join(paths.ledgers, scenario, arm, `rep${rep}.artifacts`),
            chat,
            model,
            ...(options.seed !== undefined ? { seed: options.seed } : {}),
            annotations,
            ...(options.log !== undefined ? { log: options.log } : {}),
        });
        writeJsonAtomic(join(paths.dir, `judge-${cand.name}.json`), report);
        out.push(report);
    }
    rebuildReport(project, id);
    return out;
}
/** Final confidence sequences of a sequential run, as report options (empty when the run was not sequential). */
export function sequencesOf(paths) {
    const file = join(paths.dir, 'sequential.json');
    if (!existsSync(file))
        return {};
    try {
        const seqFile = JSON.parse(readFileSync(file, 'utf8'));
        const last = seqFile.decisions.at(-1);
        if (!last || !seqFile.candidate)
            return {};
        return { sequences: { [seqFile.candidate]: { cost: last.cost, pass: last.pass, scenarios: last.scenarios } } };
    }
    catch {
        return {};
    }
}
/** Judge reports stored with a run, keyed by candidate. */
export function readJudgeReports(paths) {
    const out = {};
    if (!existsSync(paths.dir))
        return out;
    for (const f of readdirSync(paths.dir)) {
        const m = /^judge-(.+)\.json$/.exec(f);
        if (m) {
            try {
                out[m[1]] = JSON.parse(readFileSync(join(paths.dir, f), 'utf8'));
            }
            catch { /* skip */ }
        }
    }
    return out;
}
/** Rebuild the report of a finished (or partial) run from its ledgers. */
export function rebuildReport(project, id) {
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    const plan = readPlan(paths);
    const holdout = new Set(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.filter(s => s.meta.holdout).map(s => s.name));
    const report = buildReport(plan, applyAnnotations(readLedgers(paths), readAnnotations(paths)), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout, ...sequencesOf(paths) });
    const judges = readJudgeReports(paths);
    for (const c of report.candidates) {
        const j = judges[c.arm];
        if (!j)
            continue;
        c.judge = { model: j.model, wins: j.wins, losses: j.losses, ties: j.ties, midP: j.midP, pWin: j.pWin, inconsistentShare: j.inconsistentShare, usd: j.usd, humanAgreement: j.humanAgreement };
        report.notes.push(`${c.arm}: blinded pairwise judge (${j.model}, both orders, inconsistent answers count as ties) prefers the candidate on ${j.wins}, the baseline on ${j.losses}, ties ${j.ties} (mid-p ${j.midP.toFixed(2)}); order disagreement ${(j.inconsistentShare * 100).toFixed(0)}%${j.humanAgreement ? `; agreement with ${j.humanAgreement.n} human-reviewed pairs ${(j.humanAgreement.agree * 100).toFixed(0)}% (κ ${j.humanAgreement.kappa === null ? '—' : j.humanAgreement.kappa.toFixed(2)})` : '; no human labels to calibrate against yet'}.`);
    }
    writeJsonAtomic(paths.report, report);
    writeFileSync(paths.reportMd, renderMarkdown(report));
    return report;
}
