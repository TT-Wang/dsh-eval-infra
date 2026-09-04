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
import { projectPrices } from './project.js';
import { buildReport, noiseFloorOf, renderMarkdown } from './report.js';
import { fileSha, readReceipt, receiptSignatureValid, sealRun, signingKey, signReceipt, verifyRun, writeReceipt } from './manifest.js';
import { archiveSignalOrder } from './signal.js';
import { driftTest } from './drift.js';
import { PROBES as PROBE_LIST } from './probe.js';
import { deepseekChat } from './judge.js';
const PROBE_COUNT = PROBE_LIST.length;
import { executeRun } from './runner.js';
import { listScenarios, scenarioVerify } from './scenario.js';
import { sdkDriverFactory } from './sdk-driver.js';
import { selfcheckAll } from './selfcheck.js';
import { applyAnnotations, listRuns, newRunId, readAnnotations, readLedgers, readPlan, runPaths, runPathsAt, writeJsonAtomic, writeLedger } from './store.js';
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
    const pureReplay = request.replay !== undefined && request.replay.forkAt === undefined;
    // A pure replay never reaches the provider: the meter serves recorded responses, so a placeholder credential satisfies the adapter.
    const apiKey = resolveApiKey() ?? (pureReplay ? 'replay-no-key' : undefined);
    if (apiKey === undefined && hooks.driverFactory === undefined) {
        throw new LaunchError('DEEPSEEK_API_KEY not found (env, $DSH_HOME/.env or ~/.dsh/.env)', 'env');
    }
    // Third-party plugins default to the container path when Docker is available (the host sandbox is not a security boundary per dsh's SAFETY.md); --sandbox host overrides.
    let sandbox = request.sandbox ?? 'host';
    if (request.sandbox === undefined && hooks.driverFactory === undefined) {
        const { linkedPluginPaths, dockerAvailable } = await import('./docker.js');
        const external = linkedPluginPaths(project.home, project.config.profile).filter(p => existsSync(p));
        if (external.length > 0 && (await dockerAvailable()).ok) {
            sandbox = 'docker';
            log(`sandbox: ${external.length} linked third-party plugin(s) present and Docker available → container per trial (pass --sandbox host to run on the host)`);
        }
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
        if (sandbox === 'docker')
            plan.sandbox = 'docker';
        if (sandbox === 'docker' && request.dockerKeepSandbox)
            plan.containerSandbox = true;
        if (request.perturb)
            plan.perturb = true;
        if (request.replay)
            plan.replay = request.replay;
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
    writeJsonAtomic(paths.env, { ...env, sandbox, ...(sandbox === 'docker' ? { dockerImage: request.dockerKeepSandbox ? `dsh-eval-bwrap:${(request.dockerImage ?? 'node:22-bookworm-slim').replace(/[^a-zA-Z0-9_.-]/g, '_')}` : request.dockerImage ?? 'node:22-bookworm-slim', ...(request.dockerRuntime !== undefined ? { dockerRuntime: request.dockerRuntime } : {}), dshSandboxInContainer: request.dockerKeepSandbox === true } : {}), diffs: prepared.diffs, multiVariable: prepared.diffs.some(d => d.variables > 1) });
    for (const [arm, text] of Object.entries(prepared.composed))
        writeFileSync(join(paths.arms, `${arm}.composed.yml`), text);
    const runEnv = { DSH_TELEMETRY_DISABLED: '1' };
    if (apiKey !== undefined)
        runEnv['DEEPSEEK_API_KEY'] = apiKey;
    let driverFactory = hooks.driverFactory;
    let baseOverlayRows = [];
    if (driverFactory === undefined && sandbox === 'docker') {
        const { dockerAvailable, dockerDriverFactory, prepareNativeShims, CONTAINER_OVERLAY_ROWS, CONTAINER_OVERLAY_ROWS_KEEP_SANDBOX } = await import('./docker.js');
        const { dshSourceRoot } = await import('./env.js');
        const avail = await dockerAvailable();
        if (!avail.ok)
            throw new LaunchError(`docker sandbox requested but docker is not usable: ${avail.detail}`, 'env');
        const source = dshSourceRoot({ realpath: false });
        if (source === null)
            throw new LaunchError('docker sandbox needs a dsh source checkout (DSH_SOURCE or ~/.dsh/source/current)', 'env');
        const arch = process.arch === 'x64' ? 'x64' : 'arm64';
        const nativeShims = prepareNativeShims(project.home, source, arch, log);
        log(`docker sandbox: ${avail.detail}; image ${request.dockerImage ?? 'node:22-bookworm-slim'}; ${nativeShims.length} native shim(s)`);
        const baseImage = request.dockerImage ?? 'node:22-bookworm-slim';
        const image = request.dockerKeepSandbox ? await (await import('./docker.js')).prepareSandboxImage(baseImage, log) : baseImage;
        driverFactory = dockerDriverFactory({ dshSource: source, nativeShims, image, ...(request.dockerRuntime !== undefined ? { runtime: request.dockerRuntime } : {}), ...(request.dockerKeepSandbox ? { keepDshSandbox: true } : {}) }, paths.dir);
        baseOverlayRows = request.dockerKeepSandbox ? CONTAINER_OVERLAY_ROWS_KEEP_SANDBOX : CONTAINER_OVERLAY_ROWS;
    }
    const deps = {
        driverFactory: driverFactory ?? sdkDriverFactory(project.config.dshBin !== undefined ? { dshBin: project.config.dshBin } : {}),
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
    const prices = projectPrices(project.config);
    if (prices)
        deps.prices = prices;
    if (request.perturb)
        deps.perturb = { seed: request.seed ?? 42 };
    if (request.maxUsdPerTrial !== undefined)
        deps.maxUsdPerTrial = request.maxUsdPerTrial;
    if (request.probe) {
        const model = plan.baseline.model ?? 'deepseek-v4-flash';
        log(`probing the route for ${model} before the trials…`);
        const verdict = await probeRoute(project, { model, log: (l) => log(`  ${l}`) });
        writeJsonAtomic(join(paths.dir, 'probe.json'), verdict);
        log(`probe: ${verdict.verdict === 'no-reference' ? 'enrolled a reference (no comparison yet)' : `${verdict.verdict} (distance ${verdict.distance.toFixed(3)}, p = ${verdict.p.toFixed(3)})`} · $${verdict.usd.toFixed(4)}`);
    }
    // The meter belongs to the run, not the driver: container mode gets it too (the overlay points the container at the host gateway).
    const meterOn = request.meter ?? hooks.driverFactory === undefined;
    if (meterOn) {
        deps.meter = {
            upstream: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
            ...(sandbox === 'docker' ? { exposed: true, hostFromContainer: 'host.docker.internal' } : {}),
            ...(request.faultRate !== undefined && request.faultRate > 0 ? { faults: { rate: request.faultRate, seed: request.faultSeed ?? 7 } } : {}),
        };
        if (request.replay) {
            const source = runPaths(project.runsRoot, request.replay.runId);
            if (!existsSync(source.plan))
                throw new LaunchError(`replay source run ${request.replay.runId} not found`, 'usage');
            if (!meterOn)
                throw new LaunchError('replay needs the meter (do not pass --no-meter)', 'usage');
            deps.replay = { runId: request.replay.runId, recordingFor: (sc, arm, rep) => join(source.dir, 'meter', sc, arm, `rep${rep}.responses.jsonl`), ...(request.replay.forkAt !== undefined ? { forkAt: request.replay.forkAt } : {}), liveAllowed: request.replay.forkAt !== undefined };
        }
    }
    if (request.turnTimeoutS !== undefined)
        deps.turnTimeoutMs = request.turnTimeoutS * 1000;
    if (request.resume !== undefined)
        deps.resume = true;
    if (request.maxUsd !== undefined)
        deps.maxUsd = request.maxUsd;
    if (baseOverlayRows.length > 0)
        deps.baseOverlayRows = baseOverlayRows;
    const decisions = [];
    if (request.sequential) {
        deps.sequential = { seed: request.seed ?? 42, ...(request.order === 'signal' ? { order: archiveSignalOrder(project.runsRoot, plan.id) } : {}), onDecision: (d) => { decisions.push(d); log(`sequential: after ${d.scenarios} scenarios · cost ratio betting CS ${d.ratio ? `${d.ratio.mean.toFixed(2)} [${d.ratio.lo.toFixed(2)}, ${d.ratio.hi.toFixed(2)}]` : '—'} · Δ% asymptotic ${d.cost ? `[${d.cost.lo.toFixed(1)}, ${d.cost.hi.toFixed(1)}]` : '—'} · pass seq ${d.pass ? `[${d.pass.lo.toFixed(2)}, ${d.pass.hi.toFixed(2)}]` : '—'} · ${d.decided ? 'DECIDED: ' + d.reason : 'continue'}`); } };
        log('sequential mode: scenarios in seeded random order; the run stops once the anytime-valid sequences decide the comparison');
    }
    const done = (async () => {
        const progress = await executeRun(plan, scenarios, [prepared.baseline, ...prepared.candidates], deps);
        if (request.sequential)
            writeJsonAtomic(join(paths.dir, 'sequential.json'), { seed: request.seed ?? 42, candidate: candidateSpecs[0]?.name ?? null, decisions });
        const report = buildReport(plan, readLedgers(paths), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout: new Set(scenarios.filter(s => s.meta.holdout).map(s => s.name)), drift: baselineDrift(project, plan, readLedgers(paths)), ...probeOf(paths), ...sequencesOf(paths) });
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
        sealAndIssue(project, paths, plan, report);
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
/** Behavioural drift of this run's baseline arm against archived trials of the same arm name and model. */
export function baselineDrift(project, plan, ledgers) {
    const current = ledgers.filter(l => l.arm === plan.baseline.name && l.error === undefined);
    if (current.length < 2)
        return null;
    const archive = [];
    for (const r of listRuns(project.runsRoot)) {
        if (r.id === plan.id)
            continue;
        try {
            for (const l of readLedgers(runPaths(project.runsRoot, r.id)))
                if (l.arm === plan.baseline.name && l.model === current[0].model && l.error === undefined)
                    archive.push(l);
        }
        catch { /* unreadable run */ }
    }
    if (archive.length < 2)
        return null;
    return driftTest(current, archive);
}
/**
 * Probe the route the arms will use and compare with the enrolled reference for
 * that (model, endpoint). The first call enrols; later calls test. The result is
 * archived under the project and, for a run, written into the run directory.
 */
export async function probeRoute(project, options = {}) {
    const { collectProbes, compareWithReference, referenceKey } = await import('./probe.js');
    const model = options.model ?? 'deepseek-v4-flash';
    const baseUrl = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com';
    const chat = options.chat ?? (() => { const apiKey = resolveApiKey(); if (apiKey === undefined)
        throw new LaunchError('DEEPSEEK_API_KEY not found (env, $DSH_HOME/.env or ~/.dsh/.env)', 'env'); return deepseekChat({ model, apiKey, temperature: 1 }); })();
    const refFile = join(project.evalDir, `model-reference-${referenceKey(model, baseUrl)}.json`);
    const reference = existsSync(refFile) ? JSON.parse(readFileSync(refFile, 'utf8')) : null;
    const fresh = await collectProbes(chat, options.samples ?? 8, options.log);
    if (reference === null || options.enroll === true) {
        const ref = { schema: 'dsh-eval-probe/1', model, baseUrl, enrolledAt: new Date().toISOString(), samples: fresh.samples, usd: fresh.usd };
        writeJsonAtomic(refFile, ref);
        options.log?.(`enrolled ${PROBE_COUNT * (options.samples ?? 8)} probe answers as the reference for ${model} at ${baseUrl}`);
        return { model, distance: 0, p: 1, probes: PROBE_COUNT, samplesPerSide: options.samples ?? 8, verdict: 'no-reference', comparedAt: ref.enrolledAt, usd: fresh.usd };
    }
    return compareWithReference(fresh.samples, reference, model, fresh.usd);
}
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
            const kind = plan.perturb ? 'perturbation' : 'rerun';
            if (out[`${plan.baseline.name}|${kind}`] !== undefined)
                continue;
            const floor = noiseFloorOf(plan, readLedgers(paths));
            if (floor === null)
                continue;
            // Newest floor of each kind per baseline; the bare key stays the rerun floor (or the only one) for callers that do not ask for a kind.
            out[`${plan.baseline.name}|${kind}`] = floor;
            if (kind === 'rerun' || out[plan.baseline.name] === undefined)
                out[plan.baseline.name] = floor;
        }
        catch { /* unreadable run */ }
    }
    return out;
}
/** Model family from a model id or a configured `family` (deepseek-* → deepseek, gpt-* → openai, claude-* → anthropic, gemini-* → google). */
export function modelFamily(model, configured) {
    if (configured)
        return configured.toLowerCase();
    const m = model.toLowerCase();
    if (m.startsWith('deepseek'))
        return 'deepseek';
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4'))
        return 'openai';
    if (m.startsWith('claude'))
        return 'anthropic';
    if (m.startsWith('gemini'))
        return 'google';
    if (m.startsWith('qwen'))
        return 'alibaba';
    if (m.startsWith('llama'))
        return 'meta';
    if (m.startsWith('mistral') || m.startsWith('mixtral'))
        return 'mistral';
    return m.split(/[-_/:]/)[0] ?? m;
}
function resolveJudgeModels(project, models, chats, deepseekChat) {
    const names = models && models.length ? models : ['deepseek-v4-pro'];
    return names.map((spec) => {
        if (chats?.[spec])
            return { model: spec, chat: chats[spec] };
        const configured = (project.config.judges ?? []).find(j => j.model === spec || j.name === spec);
        const model = configured?.model ?? spec.split('@')[0];
        const baseUrl = configured?.baseUrl ?? (spec.includes('@') ? spec.slice(spec.indexOf('@') + 1) : undefined);
        const keyEnv = configured?.apiKeyEnv;
        const apiKey = keyEnv !== undefined ? process.env[keyEnv] : baseUrl === undefined ? resolveApiKey() : process.env['JUDGE_API_KEY'] ?? resolveApiKey();
        if (apiKey === undefined)
            throw new LaunchError(`no API key for judge ${spec} (set ${keyEnv ?? 'DEEPSEEK_API_KEY or JUDGE_API_KEY'})`, 'env');
        return { model, chat: deepseekChat({ model, apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}) }) };
    });
}
/**
 * Run the blinded pairwise judge over every scenario of a finished run that
 * declares `meta.judge`. Writes `judge-<candidate>.json` next to the report and
 * returns it. The judge model defaults to deepseek-v4-pro so it differs from
 * the usual v4-flash arms (same family: a stated limitation).
 */
export async function runJudge(project, id, options = {}) {
    const { judgeRun, deepseekChat, absoluteJudge } = await import('./judge.js');
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
    const judges = resolveJudgeModels(project, options.models, options.chats, deepseekChat);
    const armFamilies = new Set([plan.baseline, ...plan.candidates].map(a => modelFamily(a.model ?? 'deepseek-v4-flash')));
    const sameFamily = judges.filter(j => armFamilies.has(modelFamily(j.model, (project.config.judges ?? []).find(c => c.model === j.model || c.name === j.model)?.family)));
    if (sameFamily.length > 0 && !options.allowSameFamily) {
        throw new LaunchError(`judge ${sameFamily.map(j => j.model).join(', ')} shares a model family with the arms (${[...armFamilies].join(', ')}); self-preference and preference leakage bias such judgments. Configure a judge from another family in .dsh-eval/config.json (judges: [{model, baseUrl, apiKeyEnv, family}]) or pass --allow-same-family to proceed with the bias stated in the report.`, 'usage');
    }
    const annotations = readAnnotations(paths);
    const anchors = collectAnchors(project, id);
    if (anchors.length)
        options.log?.(`judge anchors: ${anchors.length} archived human-labelled trial(s) will be re-graded for the drift check`);
    const mode = options.mode ?? 'pairwise';
    const out = [];
    const artifactDir = (scenario, arm, rep) => join(paths.ledgers, scenario, arm, `rep${rep}.artifacts`);
    if (mode === 'pairwise' || mode === 'both') {
        for (const cand of plan.candidates.filter(c => options.candidate === undefined || c.name === options.candidate)) {
            const report = await judgeRun({ plan, candidate: cand.name, ledgers, specs, artifactDir, judges, ...(options.seed !== undefined ? { seed: options.seed } : {}), annotations, ...(anchors.length ? { anchors } : {}), ...(options.log !== undefined ? { log: options.log } : {}) });
            const { anchorAnswers, ...stored } = report;
            if (anchorAnswers)
                rememberAnchorAnswers(project, anchorAnswers);
            writeJsonAtomic(join(paths.dir, `judge-${cand.name}.json`), { ...stored, sameFamilyAsArms: sameFamily.length > 0 });
            out.push(report);
        }
    }
    if (mode === 'absolute' || mode === 'both') {
        const abs = await absoluteJudge({ plan, ledgers, specs, artifactDir, judges, annotations, ...(options.log !== undefined ? { log: options.log } : {}) });
        writeJsonAtomic(join(paths.dir, 'judge-absolute.json'), abs);
    }
    rebuildReport(project, id);
    return out;
}
/** Absolute judge report stored with a run, if any. */
export function readAbsoluteJudge(paths) {
    const file = join(paths.dir, 'judge-absolute.json');
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Final confidence sequences of a sequential run, as report options (empty when the run was not sequential). */
/** The analysis contract this tool applies; fixed by the code and the plan, not chosen after seeing the data. */
export function analysisContract(plan) {
    return {
        estimand: 'per-scenario paired difference in USD cost on repeat-pairs where both arms passed, and the paired difference in pass rate',
        pairing: 'scenario x repeat, arms interleaved A B on odd repeats and B A on even ones, one process per trial',
        estimator: 'mean over scenarios with a Student-t interval below 10 scenarios and a percentile bootstrap from 10; sequential mode replaces it with a hedged betting confidence sequence on the winsorized cost ratio',
        alpha: 0.05 / (2 * Math.max(1, plan.candidates.length)),
        sesoiPct: 10,
        minScenarios: 5,
        bootstrapDraws: 2000,
        seed: 42,
        gateOrder: 'correctness gate first: any regression blocks the cost reading',
        costRule: 'cost compared only on repeat-pairs where both arms passed; a direction also needs >= 5 comparable scenarios, an interval excluding zero, and no overlap with a measured A/A floor',
    };
}
/** Seal the evidence and issue a signed receipt carrying the contract, the claims and the coverage counts. */
export function sealAndIssue(project, paths, plan, report) {
    const contract = analysisContract(plan);
    const manifest = sealRun(paths, plan.id, undefined, contract);
    const ledgers = readLedgers(paths);
    const metered = ledgers.filter(l => l.usageProvenance?.source === 'meter' || l.usageProvenance?.source === 'replay');
    const env = existsSync(paths.env) ? JSON.parse(readFileSync(paths.env, 'utf8')) : {};
    const { privateKey, publicKey } = signingKey(project.evalDir);
    const receipt = signReceipt({
        schema: 'dsh-eval-receipt/1',
        runId: plan.id,
        issuedAt: new Date().toISOString(),
        evidenceSha: manifest.evidenceSha,
        contract,
        claims: report.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, grade: c.grade, verdict: c.verdict })),
        coverage: {
            trials: ledgers.length,
            scenarios: plan.scenarios.length,
            repeats: plan.repeats,
            arms: 1 + plan.candidates.length,
            metered: metered.length,
            reconciled: metered.filter(l => l.usageProvenance.reconciled === true).length,
            unrun: Math.max(0, plan.scenarios.length * plan.repeats * (1 + plan.candidates.length) - ledgers.length),
            errors: ledgers.filter(l => l.error !== undefined).length,
        },
        environment: {
            ...(typeof env['dshVersion'] === 'string' ? { dshVersion: env['dshVersion'] } : {}),
            ...(typeof env['dshRevision'] === 'string' ? { dshRevision: env['dshRevision'] } : {}),
            ...(typeof env['evalInfraVersion'] === 'string' ? { evalInfraVersion: env['evalInfraVersion'] } : {}),
            ...(typeof env['sandbox'] === 'string' ? { sandbox: env['sandbox'] } : {}),
            ...(env['composedTreeSha'] && typeof env['composedTreeSha'] === 'object' ? { composedTreeSha: env['composedTreeSha'] } : {}),
        },
        publicKey,
    }, privateKey);
    writeReceipt(paths, receipt);
    return receipt;
}
/**
 * Status of a run's claims (ClaimReceipt semantics): INVALID when the evidence
 * or the signature is broken or the report no longer follows from the ledgers;
 * INCONCLUSIVE when nothing is falsified but there is no receipt, or the run's
 * own evidence is incomplete (unrun trials, errors, or usage that never
 * reconciled); PASS when the signed claims recompute from intact evidence.
 */
export function receiptStatus(paths, base, report) {
    if (base.missing.length || base.changed.length)
        return { status: 'INVALID', reason: `${base.missing.length} missing and ${base.changed.length} changed evidence file(s) since the seal` };
    if (base.reportReproduces === false)
        return { status: 'INVALID', reason: 'the stored report does not re-derive from the sealed ledgers' };
    const receipt = readReceipt(paths);
    if (receipt === null)
        return { status: 'INCONCLUSIVE', reason: 'no receipt: this run was sealed without an analysis contract' };
    if (!receiptSignatureValid(receipt))
        return { status: 'INVALID', reason: 'the receipt signature does not verify against its public key' };
    if (base.evidenceSha !== null && receipt.evidenceSha !== base.evidenceSha)
        return { status: 'INVALID', reason: 'the receipt was issued for a different evidence set (evidence sha mismatch)' };
    if (report !== null) {
        for (const claim of receipt.claims) {
            const c = report.candidates.find(x => x.arm === claim.arm);
            if (!c)
                return { status: 'INVALID', reason: `the receipt claims arm ${claim.arm}, which the re-derived report does not contain` };
            if (c.gate !== claim.gate || c.costReading !== claim.costReading || c.grade !== claim.grade)
                return { status: 'INVALID', reason: `re-derived readings for ${claim.arm} differ from the receipt (${claim.grade}/${claim.costReading} vs ${c.grade}/${c.costReading})` };
        }
    }
    if (receipt.coverage.unrun > 0)
        return { status: 'INCONCLUSIVE', reason: `${receipt.coverage.unrun} planned trial(s) never ran` };
    if (receipt.coverage.errors > 0)
        return { status: 'INCONCLUSIVE', reason: `${receipt.coverage.errors} trial(s) ended in a runtime error` };
    if (receipt.coverage.metered > 0 && receipt.coverage.reconciled < receipt.coverage.metered)
        return { status: 'INCONCLUSIVE', reason: `${receipt.coverage.metered - receipt.coverage.reconciled} trial(s) never reconciled against the wire meter` };
    return { status: 'PASS', reason: `signed claims recompute from ${Object.keys(base.changed).length === 0 ? 'intact' : 'the'} evidence (${receipt.coverage.trials} trials, ${receipt.coverage.reconciled}/${receipt.coverage.metered} reconciled)` };
}
export function probeOf(paths) {
    const file = join(paths.dir, 'probe.json');
    if (!existsSync(file))
        return {};
    try {
        return { probe: JSON.parse(readFileSync(file, 'utf8')) };
    }
    catch {
        return {};
    }
}
export function sequencesOf(paths) {
    const file = join(paths.dir, 'sequential.json');
    if (!existsSync(file))
        return {};
    try {
        const seqFile = JSON.parse(readFileSync(file, 'utf8'));
        const last = seqFile.decisions.at(-1);
        if (!last || !seqFile.candidate)
            return {};
        // The finite-sample ratio sequence decides; it is expressed as Δ% for the report. Older files without it fall back to the asymptotic one.
        const cost = last.ratio ? { mean: (last.ratio.mean - 1) * 100, lo: (last.ratio.lo - 1) * 100, hi: (last.ratio.hi - 1) * 100 } : last.cost;
        return { sequences: { [seqFile.candidate]: { cost, pass: last.pass, scenarios: last.scenarios } } };
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
/**
 * Re-derive every ledger of a run from its stored events (the ledger schema
 * evolves; the events are the durable record). Keeps verdict, timing, route
 * and error facts from the existing ledger; recomputes usage, prices, steps,
 * behaviour, observations and invariants. Then rebuilds the report.
 */
export async function rebuildLedgers(project, id) {
    const { buildLedger } = await import('./ledger.js');
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    let n = 0;
    for (const old of readLedgers(paths)) {
        const eventsFile = join(paths.dir, old.eventsFile);
        if (!existsSync(eventsFile))
            continue;
        const events = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const turnWall = new Map(old.turns.map(t => [t.turn, t.wallMs]));
        const { ledger, trace } = buildLedger({
            runId: old.runId, scenario: old.scenario, arm: old.arm, rep: old.rep, order: old.order,
            startedAt: new Date(old.startedAt), endedAt: new Date(old.endedAt), provider: old.provider, model: old.model,
            events, turnWall, verdict: old.machineVerdict ?? old.verdict, sessionId: old.sessionId, workdir: old.workdir,
            eventsFile: old.eventsFile, traceFile: old.traceFile, sessions: old.sessions ?? 1, ...(old.error !== undefined ? { error: old.error } : {}),
            ...(projectPrices(project.config) !== undefined ? { prices: projectPrices(project.config) } : {}),
        });
        writeFileSync(join(paths.dir, old.traceFile), trace.map(t => JSON.stringify(t)).join('\n') + (trace.length ? '\n' : ''));
        writeJsonAtomic(join(paths.ledgers, old.scenario, old.arm, `rep${old.rep}.json`), ledger);
        n += 1;
    }
    rebuildReport(project, id);
    return n;
}
/** Rebuild the report of a finished (or partial) run from its ledgers. */
/** Re-derive the report from the ledgers, annotations and judge files without writing anything. */
export function deriveReport(project, id, at) {
    const paths = at ?? runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    const plan = readPlan(paths);
    const holdout = new Set(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.filter(s => s.meta.holdout).map(s => s.name));
    const report = buildReport(plan, applyAnnotations(readLedgers(paths), readAnnotations(paths)), { noiseFloors: archiveNoiseFloors(project, plan.id), priorBaselineUsd: archiveBaselineCosts(project, plan.baseline.name, plan.id), holdout, drift: baselineDrift(project, plan, readLedgers(paths)), ...probeOf(paths), ...sequencesOf(paths) });
    const judges = readJudgeReports(paths);
    const absolute = readAbsoluteJudge(paths);
    for (const c of report.candidates) {
        const j = judges[c.arm];
        if (j) {
            const models = j.models ?? [j.model];
            const jj = j;
            c.judge = { model: models.join(' + '), models, panelAgreement: j.panelAgreement ?? 1, wins: j.wins, losses: j.losses, ties: j.ties, midP: j.midP, pWin: j.pWin, inconsistentShare: j.inconsistentShare, usd: j.usd, humanAgreement: j.humanAgreement, sameFamilyAsArms: jj.sameFamilyAsArms ?? false, longerWinsShare: jj.longerWinsShare ?? null, interJudgeKappa: jj.interJudgeKappa ?? null, lengthBalancedWinRate: jj.lengthBalancedWinRate ?? null, equalLengthWinRate: jj.equalLengthWinRate ?? null, effectiveJudges: jj.effectiveJudges ?? null, abstention: jj.abstention ?? null, anchors: jj.anchors ?? null };
            if (jj.abstention)
                report.notes.push(`${c.arm}: conformal abstention at α = ${jj.abstention.alpha} calibrated on ${jj.abstention.calibratedOn} human-labelled pair${jj.abstention.calibratedOn === 1 ? '' : 's'}: ${Number.isFinite(jj.abstention.tau) ? `threshold ${jj.abstention.tau.toFixed(2)}, ${jj.abstention.abstained} of ${jj.abstention.of} judgments withheld` : `no threshold meets the bound, all ${jj.abstention.of} judgments withheld`}.`);
            else
                report.notes.push(`${c.arm}: no human-labelled pairs on this run, so the judge cannot calibrate an abstention threshold; only order disagreement and panel splits abstain.`);
            if (jj.anchors)
                report.notes.push(`${c.arm}: judge anchors — ${jj.anchors.n} archived human-labelled trials re-graded: agreement with humans ${(jj.anchors.humanAgreement * 100).toFixed(0)}%${jj.anchors.stability !== null ? `, stability vs the previous judge run ${(jj.anchors.stability * 100).toFixed(0)}% on ${jj.anchors.comparedWithPrevious}` : ' (first run on these anchors, no previous answers yet)'}${jj.anchors.attribution === 'judge' ? ' → JUDGE DRIFT: the judge changed its mind on the anchors, so differences against earlier judge runs are attributed to the judge, not the system' : ''}.`);
            if (jj.lengthBalancedWinRate !== null && jj.lengthBalancedWinRate !== undefined)
                report.notes.push(`${c.arm}: length-balanced candidate win rate ${(jj.lengthBalancedWinRate * 100).toFixed(0)}% (average of the candidate-longer and candidate-shorter strata)${jj.equalLengthWinRate ? `; at zero length difference the logistic fit gives ${(jj.equalLengthWinRate.rate * 100).toFixed(0)}% (length slope ${jj.equalLengthWinRate.slope.toFixed(2)} on ${jj.equalLengthWinRate.n} decided pairs)` : ''}.`);
            if (jj.effectiveJudges)
                report.notes.push(`${c.arm}: the ${jj.effectiveJudges.k}-model panel carries about ${jj.effectiveJudges.nEff.toFixed(1)} independent votes (mean pairwise ${jj.effectiveJudges.basis} correlation ${jj.effectiveJudges.rhoBar.toFixed(2)}); a panel is not as many opinions as it has members.`);
            report.notes.push(`${c.arm}: blinded pairwise judge${models.length > 1 ? ` panel (${models.join(', ')}; majority of decided votes, panel unanimous on ${(j.panelAgreement * 100).toFixed(0)}% of pairs${jj.interJudgeKappa !== null && jj.interJudgeKappa !== undefined ? `, inter-judge κ ${jj.interJudgeKappa.toFixed(2)}` : ''})` : ` (${models[0]})`}, both orders, inconsistent orders count as ties: prefers the candidate on ${j.wins}, the baseline on ${j.losses}, ties ${j.ties} (mid-p ${j.midP.toFixed(2)}); order disagreement ${(j.inconsistentShare * 100).toFixed(0)}% of votes${jj.longerWinsShare !== null && jj.longerWinsShare !== undefined ? `; the longer submission won ${(jj.longerWinsShare * 100).toFixed(0)}% of decided pairs` : ''}${j.humanAgreement ? `; agreement with ${j.humanAgreement.n} human-reviewed pairs ${(j.humanAgreement.agree * 100).toFixed(0)}% (κ ${j.humanAgreement.kappa === null ? '—' : j.humanAgreement.kappa.toFixed(2)})` : '; no human labels to calibrate against yet'}${jj.sameFamilyAsArms ? '. WARNING: the judge shares a model family with the arms; self-preference bias applies' : ''}.`);
        }
        if (absolute) {
            const b = absolute.arms[plan.baseline.name];
            const a = absolute.arms[c.arm];
            if (b && a) {
                const cal = absolute.calibration;
                c.absolute = { baseline: b, candidate: a, diff: a.estimate - b.estimate, diffSe: Math.sqrt(a.se * a.se + b.se * b.se), models: absolute.models, ...(cal ? { calibration: cal } : {}) };
                report.notes.push(`${c.arm}: absolute judge grades (${absolute.models.join(' + ')}) give pass rates ${(b.estimate * 100).toFixed(0)}% → ${(a.estimate * 100).toFixed(0)}% (${b.n + a.n > 0 ? `PPI++ rectified with ${b.n}/${a.n} human labels, λ ${b.lambda.toFixed(2)}/${a.lambda.toFixed(2)}${cal ? `; judge TPR ${cal.tpr === null ? '—' : (cal.tpr * 100).toFixed(0) + '%'} / TNR ${cal.tnr === null ? '—' : (cal.tnr * 100).toFixed(0) + '%'} on ${cal.labelled} labels` : ''}` : 'judge only, no human labels — uncalibrated'}), Δ ${((a.estimate - b.estimate) * 100).toFixed(0)} pp ± ${(Math.sqrt(a.se * a.se + b.se * b.se) * 100).toFixed(0)} (1 SE).`);
            }
        }
    }
    for (const f of readdirSync(paths.dir).filter(f => f.startsWith('rerun-') && f.endsWith('.json')).sort()) {
        try {
            const r = JSON.parse(readFileSync(join(paths.dir, f), 'utf8'));
            const cand = report.candidates.find(c => c.arm === r.candidate);
            if (cand)
                cand.rerun = r;
            report.notes.push(`${r.candidate}: ${r.fork ? `fork validation of ${r.scenario} from step ${r.fork.step} (identical prefix replayed, live from the divergence)` : `rerun validation of ${r.scenario} (everything resampled)`} — run ${r.newRunId}, ${r.reps} attempts: ${r.original ? `${r.original.failing} failed again in ${r.failedAgain}/${r.reps}, first divergence at the same call (${r.original.call}: ${r.original.baseline} vs ${r.original.candidate}) in ${r.sameCall}/${r.reps}` : `no original divergence to validate; ${r.failedAgain}/${r.reps} attempts had exactly one failing arm`} → ${r.verdict}${r.fork ? '. Compare with the plain rerun to tell a cause from resampling luck.' : ''}`);
        }
        catch { /* unreadable rerun file */ }
    }
    return report;
}
/**
 * How many provider responses precede the step that holds the given tool call.
 * One assistant message is one provider response, so this is the fork point:
 * replaying that many responses reproduces the trial's prefix exactly, and the
 * next call is made live (Repair or Resample, 2608.25920: a cause only counts
 * when the failure recurs from an identical prefix more often than resampling
 * alone reproduces it).
 */
export function forkPointForCall(ledger, call) {
    let seen = 0;
    for (let i = 0; i < ledger.steps.length; i += 1) {
        const step = ledger.steps[i];
        seen += step.calls.length;
        if (seen >= call)
            return { forkAt: i, step: i + 1 };
    }
    return { forkAt: Math.max(0, ledger.steps.length - 1), step: ledger.steps.length };
}
/** First tool call at which two trials' tool sequences part, and which arm failed (null when both passed or both failed). */
export function pairDivergence(rb, rc, candidateName, baselineName) {
    const okB = rb.verdict?.ok === true && rb.error === undefined;
    const okC = rc.verdict?.ok === true && rc.error === undefined;
    if (okB === okC)
        return null;
    const seq = (l) => l.steps.flatMap(st => st.calls.map(c => c.name));
    const sb = seq(rb);
    const sc = seq(rc);
    let i = 0;
    while (i < sb.length && i < sc.length && sb[i] === sc[i])
        i += 1;
    return { call: i + 1, baseline: sb[i] ?? '(stops)', candidate: sc[i] ?? '(stops)', failing: okB ? candidateName : baselineName };
}
/**
 * Rerun validation of a failure: run one scenario again with the same arms a few
 * times and check whether the originally failing arm fails again and whether the
 * first divergence recurs at the same call. The result is stored beside the
 * original run (a derived file, so its seal stays valid) and shown in its report.
 */
export async function rerunScenario(project, runId, scenario, options = {}) {
    const paths = runPaths(project.runsRoot, runId);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${runId} not found`, 'usage');
    const plan = readPlan(paths);
    const candidate = options.candidate ?? plan.candidates[0]?.name;
    if (candidate === undefined)
        throw new LaunchError('the run has no candidate arm', 'usage');
    const original = (() => {
        const b = readLedgers(paths).filter(l => l.scenario === scenario && l.arm === plan.baseline.name).sort((x, y) => x.rep - y.rep);
        const c = readLedgers(paths).filter(l => l.scenario === scenario && l.arm === candidate);
        for (const rb of b) {
            const rc = c.find(x => x.rep === rb.rep);
            if (!rc)
                continue;
            const d = pairDivergence(rb, rc, candidate, plan.baseline.name);
            if (d)
                return { rep: rb.rep, ...d };
        }
        return null;
    })();
    const reps = options.repeats ?? 3;
    let fork;
    if (options.fork) {
        if (original === null)
            throw new LaunchError(`no failing pair on ${scenario} in run ${runId}: there is no divergence to fork from`, 'usage');
        const failingLedger = readLedgers(paths).find(l => l.scenario === scenario && l.arm === original.failing && l.rep === original.rep);
        if (!failingLedger)
            throw new LaunchError(`the failing trial of ${scenario} is missing from run ${runId}`, 'usage');
        if (!existsSync(join(paths.dir, 'meter', scenario, original.failing, `rep${original.rep}.responses.jsonl`)))
            throw new LaunchError(`run ${runId} has no recorded responses for ${scenario} (it ran without the meter), so it cannot be forked`, 'usage');
        const point = forkPointForCall(failingLedger, original.call);
        fork = { sourceRunId: runId, ...point };
        options.log?.(`forking at step ${point.step} (${point.forkAt} recorded responses replayed, then live) — the prefix is identical, only the continuation is resampled`);
    }
    const launched = await launchRun(project, { baseline: plan.baseline.name, candidates: [candidate], scenarios: [scenario], repeats: reps, concurrency: 2, label: `rerun${fork ? '-fork' : ''}:${runId}:${scenario}`, includeHoldout: true, skipSelfcheck: true, sandbox: plan.sandbox === 'docker' ? 'docker' : 'host', ...(fork ? { replay: { runId, forkAt: fork.forkAt } } : {}) }, { ...(options.hooks ?? {}), ...(options.log ? { log: options.log } : {}) });
    await launched.done;
    const fresh = readLedgers(runPaths(project.runsRoot, launched.id));
    let failedAgain = 0;
    let sameCall = 0;
    for (let rep = 1; rep <= reps; rep += 1) {
        const rb = fresh.find(l => l.scenario === scenario && l.arm === plan.baseline.name && l.rep === rep);
        const rc = fresh.find(l => l.scenario === scenario && l.arm === candidate && l.rep === rep);
        if (!rb || !rc)
            continue;
        const d = pairDivergence(rb, rc, candidate, plan.baseline.name);
        if (!d)
            continue;
        if (original === null || d.failing === original.failing)
            failedAgain += 1;
        if (original !== null && d.failing === original.failing && d.call === original.call)
            sameCall += 1;
    }
    const verdict = original === null ? 'no original failure' : failedAgain === 0 ? 'not reproduced' : failedAgain === reps ? 'reproduced' : 'partly reproduced';
    const result = { scenario, candidate, newRunId: launched.id, ...(fork ? { fork } : {}), reps, original, failedAgain, sameCall, verdict };
    writeJsonAtomic(join(paths.dir, `rerun-${fork ? 'fork-' : ''}${scenario}.json`), result);
    rebuildReport(project, runId);
    return result;
}
/** Verify a run directory that lives anywhere (a published bundle): hashes plus report re-derivation. */
export function verifyRunDir(project, dir) {
    const paths = runPathsAt(dir);
    if (!existsSync(paths.plan))
        throw new LaunchError(`${dir} is not a run directory (no plan.json)`, 'usage');
    const id = readPlan(paths).id;
    const pick = (r) => ({ candidates: r.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, grade: c.grade, verdict: c.verdict })) });
    const base = verifyRun(paths, () => ({ fresh: pick(deriveReport(project, id, paths)), stored: existsSync(paths.report) ? pick(JSON.parse(readFileSync(paths.report, 'utf8'))) : null }));
    const { status, reason } = receiptStatus(paths, base, deriveReport(project, id, paths));
    return { ...base, status, statusReason: reason, ok: base.ok && status !== 'INVALID' };
}
export function rebuildReport(project, id) {
    const paths = runPaths(project.runsRoot, id);
    const report = deriveReport(project, id);
    writeJsonAtomic(paths.report, report);
    writeFileSync(paths.reportMd, renderMarkdown(report));
    return report;
}
/** Check the sealed evidence against the files on disk and the stored report against a fresh derivation. */
export function verifyRunIntegrity(project, id) {
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    const pick = (r) => ({
        candidates: r.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, grade: c.grade, verdict: c.verdict })),
    });
    const base = verifyRun(paths, () => {
        const fresh = pick(deriveReport(project, id));
        const stored = existsSync(paths.report) ? pick(JSON.parse(readFileSync(paths.report, 'utf8'))) : null;
        return { fresh, stored };
    });
    const { status, reason } = receiptStatus(paths, base, deriveReport(project, id));
    return { ...base, status, statusReason: reason, ok: base.ok && status !== 'INVALID' };
}
/** Archived human-labelled trials with judge artifacts, newest first, for the judge drift check. */
export function collectAnchors(project, exceptRunId, limit = 20) {
    const anchorsFile = join(project.evalDir, 'judge-anchors.json');
    const previous = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, 'utf8')) : {};
    const out = [];
    for (const r of listRuns(project.runsRoot)) {
        if (r.id === exceptRunId)
            continue;
        const paths = runPaths(project.runsRoot, r.id);
        if (!existsSync(paths.plan))
            continue;
        let plan;
        try {
            plan = readPlan(paths);
        }
        catch {
            continue;
        }
        const annotations = readAnnotations(paths);
        const keys = Object.keys(annotations).filter(k => typeof annotations[k]?.verdict === 'boolean');
        if (keys.length === 0)
            continue;
        const specs = new Map(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.filter(s => s.meta.judge).map(s => [s.name, s.meta.judge]));
        for (const k of keys) {
            const [scenario, arm, rep] = k.split('|');
            const spec = scenario !== undefined ? specs.get(scenario) : undefined;
            if (!spec || scenario === undefined || arm === undefined || rep === undefined)
                continue;
            const dir = join(paths.dir, 'ledgers', scenario, arm, `rep${rep}.artifacts`);
            if (!existsSync(dir))
                continue;
            const key = `${r.id}|${k}`;
            out.push({ key, rubric: spec.rubric, artifactDir: dir, humanPass: annotations[k].verdict === true, ...(previous[key] !== undefined ? { previousJudgePass: previous[key] } : {}) });
            if (out.length >= limit)
                return out;
        }
    }
    return out;
}
export function rememberAnchorAnswers(project, answers) {
    const anchorsFile = join(project.evalDir, 'judge-anchors.json');
    const previous = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, 'utf8')) : {};
    writeJsonAtomic(anchorsFile, { ...previous, ...answers });
}
/**
 * Re-run each scenario's verifier on the kept workspace of every trial (runs
 * made with --keep-workdirs), without re-running any agent, then rebuild the
 * report and re-seal the evidence with the regrade recorded in the manifest.
 */
export async function regradeRun(project, id, options = {}) {
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan))
        throw new LaunchError(`run ${id} not found`, 'usage');
    const plan = readPlan(paths);
    const byName = new Map(collectScenarios(project, { scenarios: plan.scenarios, includeHoldout: true }).scenarios.map(s => [s.name, s]));
    const at = new Date().toISOString();
    const result = { at, regradable: 0, skipped: 0, changed: [], verifiers: {} };
    for (const ledger of readLedgers(paths)) {
        const scenario = byName.get(ledger.scenario);
        if (!scenario || !ledger.workdir || !existsSync(ledger.workdir)) {
            result.skipped += 1;
            continue;
        }
        result.regradable += 1;
        const vf = join(scenario.dir, 'verify.py');
        if (existsSync(vf))
            result.verifiers[scenario.name] = fileSha(vf);
        const before = ledger.verdict;
        const after = await scenarioVerify(scenario, ledger.workdir);
        if ((before?.ok ?? null) !== after.ok)
            result.changed.push({ scenario: ledger.scenario, arm: ledger.arm, rep: ledger.rep, before: before?.ok ?? null, after: after.ok, detail: after.detail });
        options.log?.(`${after.ok ? '✓' : '✗'} ${ledger.scenario}/${ledger.arm}#${ledger.rep}${(before?.ok ?? null) !== after.ok ? ` (was ${before?.ok ?? 'none'})` : ''}`);
        writeLedger(paths, { ...ledger, verdict: after, regrade: { at, previous: before }, ...(result.verifiers[scenario.name] !== undefined ? { verifierSha: result.verifiers[scenario.name] } : {}) });
    }
    writeJsonAtomic(join(paths.dir, `regrade-${at.replace(/[:.]/g, '-')}.json`), result);
    const rebuilt = rebuildReport(project, id);
    sealRun(paths, plan.id, { at, changed: result.changed.length, regradable: result.regradable, verifiers: result.verifiers }, analysisContract(plan));
    sealAndIssue(project, paths, plan, rebuilt);
    return result;
}
