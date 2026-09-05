/**
 * Does this arm actually work?
 *
 * A composed configuration can be well-formed and still fail at runtime: a
 * plugin that replaces a service the stock one also provides, a package that
 * does not resolve, a row whose config the plugin rejects. Composing the tree
 * catches none of that. So the check has three stages, cheapest first, and
 * stops at the first one that fails:
 *
 *   1. compose  — the tree builds and the arm differs from the baseline as intended
 *   2. mounted  — the rows the arm meant to add are present and enabled in that tree
 *   3. runs     — a real runtime boots on this arm and completes one trivial turn
 *
 * The third stage costs about a cent and is the only one that proves the plugin
 * loaded rather than merely that its row was written down.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadArmFile, resolveArm, applyRoute } from './arms.js';
import { prepareArms, describeDiff } from './plan.js';
import { collectScenarios, LaunchError, resolveArmPath } from './orchestrate.js';
import { executeRun, writeBaseOverlays } from './runner.js';
import { newRunId, runPaths, readLedgers, writeJsonAtomic } from './store.js';
import { resolveApiKey } from './env.js';
import { sdkDriverFactory } from './sdk-driver.js';
import { withPreviewArms } from './project.js';
/**
 * The line of a runtime failure worth showing. dsh reports the symptom first
 * ("JSON-RPC input closed") and the cause deep in a stack trace, so the specific
 * loader complaints are preferred, then any Error line, then the first line.
 */
export function explainRuntimeFailure(error) {
    const lines = error.split('\n').map(l => l.trim()).filter(l => l !== '');
    const specific = lines.find(l => /duplicate loader entry|failed to apply loader entry|plugin tree failed to load|Cannot find (package|module)|is not a function|MISSING_CREDENTIAL/.test(l));
    if (specific !== undefined)
        return specific.replace(/^(Error|TypeError):\s*/, '');
    const anyError = lines.find(l => /^(Error|TypeError|RangeError):/.test(l));
    if (anyError !== undefined)
        return anyError.replace(/^\w+Error:\s*/, '').replace(/^Error:\s*/, '');
    return lines[0] ?? error;
}
/** Rows an arm intends to add: inserts from its own patches and from any patch file it applies. */
function intendedRows(project, armName) {
    const spec = loadArmFile(resolveArmPath(project, armName));
    const out = [];
    for (const patch of spec.patches ?? []) {
        const p = patch;
        if (!Array.isArray(p['insert']))
            continue;
        for (const entry of p['insert']) {
            const e = entry;
            if (typeof e['id'] === 'string')
                out.push({ id: e['id'], ...(typeof e['name'] === 'string' ? { name: e['name'] } : {}) });
        }
    }
    return out;
}
export async function preflightArm(project, armName, options = {}) {
    // Its own scratch directory, so checking one arm cannot truncate the overlays
    // another page is composing at the same time.
    return withPreviewArms(project, armsDir => preflightIn(project, armName, options, armsDir));
}
async function preflightIn(project, armName, options, armsDir) {
    const log = options.log ?? (() => { });
    const baselineName = existsSync(resolveArmPath(project, 'baseline')) ? 'baseline' : armName;
    const arm = applyRoute(loadArmFile(resolveArmPath(project, armName)), options.route ?? {});
    const baseline = baselineName === armName ? arm : applyRoute(loadArmFile(resolveArmPath(project, baselineName)), options.route ?? {});
    const result = { arm: armName, baseline: baselineName, ok: false, stages: [], rows: [], diff: [], variables: 0 };
    // 1. compose
    let prepared;
    try {
        prepared = await prepareArms(baseline, baselineName === armName ? [] : [arm], {
            evalHome: project.home,
            armsDir,
            ...(options.invoke !== undefined ? { invoke: options.invoke } : {}),
        });
    }
    catch (e) {
        result.stages.push({ name: 'compose', ok: false, detail: e instanceof Error ? e.message : String(e) });
        return result;
    }
    const diff = prepared.diffs[0];
    result.diff = diff ? describeDiff(diff) : ['(this arm is the baseline)'];
    result.variables = diff?.variables ?? 0;
    result.stages.push({
        name: 'compose',
        ok: true,
        detail: baselineName === armName
            ? 'the tree builds (this arm is the baseline, so there is nothing to diff)'
            : result.variables === 0
                ? `the tree builds, but it composes identically to ${baselineName}: a run of these two arms would measure noise, not a change`
                : `the tree builds; ${result.variables} variable(s) differ from ${baselineName}`,
    });
    log(`compose: ok · ${result.variables} variable(s)`);
    // 2. mounted
    const tree = prepared.trees.get(armName) ?? prepared.trees.get(baselineName);
    const baseTree = prepared.trees.get(baselineName);
    const wanted = intendedRows(project, armName);
    for (const w of wanted) {
        const row = tree?.get(w.id);
        const inBase = baselineName !== armName && baseTree?.get(w.id) !== undefined && baseTree.get(w.id)['disabled'] !== true;
        result.rows.push({ ...w, present: row !== undefined, enabled: row !== undefined && row['disabled'] !== true, inBaseline: inBase });
    }
    const missing = result.rows.filter(r => !r.present);
    const off = result.rows.filter(r => r.present && !r.enabled);
    const shared = result.rows.filter(r => r.inBaseline);
    const mountedOk = missing.length === 0 && off.length === 0;
    result.stages.push({
        name: 'mounted',
        ok: mountedOk,
        detail: wanted.length === 0
            ? 'this arm inserts no rows of its own'
            : mountedOk
                ? shared.length > 0
                    ? `${result.rows.length} row(s) present and enabled, but ${shared.map(r => r.id).join(', ')} ${shared.length === 1 ? 'is' : 'are'} already active in ${baselineName} too — installed into the profile rather than added by this arm, so ${shared.length === 1 ? 'it is' : 'they are'} in both arms and cannot be the thing under test`
                    : `${result.rows.length} row(s) present and enabled in the composed tree`
                : [missing.length > 0 ? `missing from the tree: ${missing.map(r => r.id).join(', ')}` : '', off.length > 0 ? `present but disabled: ${off.map(r => r.id).join(', ')}` : ''].filter(Boolean).join('; '),
    });
    log(`mounted: ${mountedOk ? 'ok' : 'FAILED'}`);
    if (!mountedOk)
        return result;
    if (options.dry === true) {
        result.ok = true;
        return result;
    }
    // 3. one real turn
    const scenarioName = options.scenario ?? 'z0_env_smoke';
    const { scenarios } = collectScenarios(project, { scenarios: [scenarioName], includeHoldout: true });
    const scenario = scenarios[0];
    if (scenario === undefined)
        throw new LaunchError(`smoke scenario ${scenarioName} not found in ${project.scenarioRoot}`, 'usage');
    if (options.driverFactory === undefined && resolveApiKey() === undefined)
        throw new LaunchError('DEEPSEEK_API_KEY not found (env, $DSH_HOME/.env or ~/.dsh/.env)', 'env');
    const id = newRunId();
    const paths = runPaths(project.runsRoot, id);
    const plan = {
        id,
        createdAt: new Date().toISOString(),
        baseline: arm,
        candidates: [],
        scenarios: [scenario.name],
        repeats: 1,
        concurrency: 1,
        scenarioRoot: project.scenarioRoot,
        label: `preflight:${armName}`,
    };
    writeJsonAtomic(paths.plan, plan);
    const resolved = [resolveArm(arm, paths.arms, resolveArmPath(project, armName))];
    writeBaseOverlays(paths.arms);
    log(`running ${scenario.name} on ${armName}…`);
    const started = Date.now();
    await executeRun(plan, [scenario], resolved, {
        driverFactory: options.driverFactory ?? sdkDriverFactory(project.config.dshBin !== undefined ? { dshBin: project.config.dshBin } : {}),
        evalHome: project.home,
        paths,
        env: { ...(resolveApiKey() !== undefined ? { DEEPSEEK_API_KEY: resolveApiKey() } : {}) },
        workRoot: join(project.evalDir, 'work'),
        log: (line) => log(line.split('\n')[0] ?? line),
    });
    const ledger = readLedgers(paths)[0];
    const smokeOk = ledger !== undefined && ledger.error === undefined;
    result.smoke = {
        scenario: scenario.name,
        ok: smokeOk,
        usd: ledger?.totals.usd ?? 0,
        steps: ledger?.totals.steps ?? 0,
        tools: ledger?.tools ?? [],
        wallMs: Date.now() - started,
        ...(ledger?.error !== undefined ? { error: ledger.error } : {}),
    };
    result.stages.push({
        name: 'runs',
        ok: smokeOk,
        detail: smokeOk
            ? `a runtime booted on this arm and finished ${scenario.name} in ${((result.smoke.wallMs) / 1000).toFixed(0)}s for $${result.smoke.usd.toFixed(4)}${ledger?.verdict?.ok === false ? ' (the scenario itself did not pass, which is a scenario result, not a loading failure)' : ''}`
            : `the runtime refused this arm: ${ledger?.error !== undefined ? explainRuntimeFailure(ledger.error) : 'no ledger was written'}`,
    });
    result.ok = smokeOk;
    return result;
}
