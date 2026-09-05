#!/usr/bin/env node
/**
 * dsh-eval — paired A/B evaluation for dsh components.
 *
 *   dsh-eval init [--plugin <path|pkg>]...   create .dsh-eval/home with the eval profile, add plugins, write starter arms
 *   dsh-eval add <path|pkg>                  add a plugin package to the eval profile
 *   dsh-eval scenarios [globs...]            list scenarios (--category, --tag)
 *   dsh-eval selfcheck [globs...]            oracle-must-pass / null-must-fail check
 *   dsh-eval diff <baseline> <candidate>...  composed-tree diff between arms (through dsh --dump-config)
 *   dsh-eval run --baseline a --arm b [--arm c] [globs...] [--repeats 3] [--concurrency 2] [--label ..]
 *   dsh-eval report <runId>                  rebuild and print the report
 *   dsh-eval runs                            list runs
 *   dsh-eval patterns                        recurring failures across the archive, most arm-skewed first
 *   dsh-eval ui [--port 4177] [--open]       local web UI
 *   dsh-eval export <runId> [--out dir]      ATIF trajectories of every trial
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchRun, LaunchError, collectScenarios, rebuildLedgers, rebuildReport, regradeRun, resolveArmPath, runJudge, verifyRunDir, verifyRunIntegrity } from './core/orchestrate.js';
import { loadArmFile } from './core/arms.js';
import { describeDiff, prepareArms } from './core/plan.js';
import { ensureEvalProfile, loadProject, profileBundles, saveProjectConfig, setProfileBundles, STARTER_BASELINE, starterCandidate, withPreviewArms } from './core/project.js';
import { fmtPct, fmtUsd, renderMarkdown } from './core/report.js';
import { selfcheckAll } from './core/selfcheck.js';
import { listRuns, readJson, readLedgers, readPlan, runPaths } from './core/store.js';
import { toAtif } from './core/atif.js';
import { evalInfraVersion, tilde } from './core/env.js';
import { discoverPatterns } from './core/patterns.js';
/** Flags that never take a value, so a following positional (a scenario glob) is not swallowed. */
const BOOLEAN_FLAGS = new Set(['aa', 'allow-multi', 'skip-selfcheck', 'keep-workdirs', 'dry-run', 'json', 'open', 'help', 'strict', 'include-holdout', 'sequential', 'rebuild-ledgers', 'allow-same-family', 'no-meter', 'perturb', 'docker-keep-sandbox', 'probe', 'enroll', 'fork', 'dry', 'activate', 'keep-paths']);
export function parseArgs(argv) {
    const [command = 'help', ...rest] = argv;
    const positional = [];
    const flags = {};
    for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
            let value;
            if (eq !== -1)
                value = a.slice(eq + 1);
            else if (BOOLEAN_FLAGS.has(key))
                value = true;
            else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
                value = rest[i + 1];
                i += 1;
            }
            else
                value = true;
            const prev = flags[key];
            if (prev === undefined)
                flags[key] = value;
            else if (Array.isArray(prev))
                prev.push(String(value));
            else
                flags[key] = [String(prev), String(value)];
        }
        else
            positional.push(a);
    }
    return { command, positional, flags };
}
function list(v) {
    if (v === undefined || v === true || v === false)
        return [];
    return Array.isArray(v) ? v : [v];
}
function num(v) {
    if (typeof v !== 'string')
        return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}
const out = (line = '') => { process.stdout.write(line + '\n'); };
const err = (line) => { process.stderr.write(line + '\n'); };
function runDsh(args, env) {
    return new Promise((resolveExit) => {
        const child = spawn(process.env['DSH_BIN'] ?? 'dsh', args, { stdio: 'inherit', env: { ...process.env, ...env } });
        child.on('exit', code => resolveExit(code ?? 1));
        child.on('error', (e) => { err(`cannot run dsh: ${e.message}`); resolveExit(127); });
    });
}
function pluginNameOf(spec) {
    const dir = resolve(spec);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
        try {
            return JSON.parse(readFileSync(manifest, 'utf8')).name;
        }
        catch {
            return undefined;
        }
    }
    return spec.startsWith('.') || spec.startsWith('/') ? undefined : spec.replace(/@[^/@]+$/, '');
}
async function cmdInit(project, args) {
    mkdirSync(project.home, { recursive: true });
    const profileDir = ensureEvalProfile(project.home, project.config.profile);
    out(`eval home: ${project.home}`);
    out(`profile:   ${profileDir} (bundles: dsh-base + dsh-sdk-app)`);
    saveProjectConfig(project);
    let firstPlugin;
    for (const spec of list(args.flags['plugin'])) {
        const target = existsSync(resolve(spec)) ? resolve(spec) : spec;
        out(`adding plugin ${target} …`);
        const code = await runDsh(['plugin', '--profile', project.config.profile, 'add', target], { DSH_HOME: project.home });
        if (code !== 0) {
            err(`dsh plugin add failed (exit ${code})`);
            return code;
        }
        firstPlugin ??= pluginNameOf(spec);
    }
    if (!existsSync(project.armsDir)) {
        mkdirSync(project.armsDir, { recursive: true });
        writeFileSync(join(project.armsDir, 'baseline.yml'), STARTER_BASELINE);
        writeFileSync(join(project.armsDir, 'candidate.yml'), starterCandidate(firstPlugin));
        out(`arms:      ${project.armsDir}/baseline.yml, candidate.yml (edit the candidate)`);
    }
    const code = await runDsh(['--profile', project.config.profile, '--dump-config'], { DSH_HOME: project.home }).then(async (c) => c);
    void code;
    out(`scenarios: ${project.scenarioRoot}${project.scenarioRoot === project.bundledScenarioRoot ? ' (bundled library; add bench/scenarios/ to the project for your own)' : ''}`);
    out('next:      dsh-eval selfcheck && dsh-eval run --baseline baseline --arm candidate');
    return 0;
}
async function cmdAdd(project, args) {
    const spec = args.positional[0];
    if (spec === undefined) {
        err('usage: dsh-eval add <path|package> [--activate]');
        return 3;
    }
    ensureEvalProfile(project.home, project.config.profile);
    const target = existsSync(resolve(spec)) ? resolve(spec) : spec;
    const before = profileBundles(project.home, project.config.profile);
    const code = await runDsh(['plugin', '--profile', project.config.profile, 'add', target], { DSH_HOME: project.home });
    if (code !== 0)
        return code;
    // A plugin that declares `dsh.bundle` becomes a profile layer the moment it is
    // installed, which puts it in *both* arms and makes it impossible to measure.
    // An evaluation project wants it installed but inert, so an arm can add it.
    const after = profileBundles(project.home, project.config.profile);
    const activated = after.filter(b => !before.includes(b));
    if (activated.length === 0)
        return 0;
    if (args.flags['activate'] === true) {
        out(`${activated.join(', ')} activated for every arm in the ${project.config.profile} profile`);
        return 0;
    }
    setProfileBundles(project.home, project.config.profile, before);
    out('');
    for (const name of activated)
        out(`${name} declares a bundle, so installing it would have switched it on for every arm.`);
    out('It is installed but left inert, which is what an A/B comparison needs: add it to one arm and the other stays without it.');
    out(`Pass --activate to make it part of the baseline instead.`);
    return 0;
}
function scenarioFilter(args) {
    return { scenarios: args.positional, categories: list(args.flags['category']), tags: list(args.flags['tag']), ...(args.flags['include-holdout'] === true ? { includeHoldout: true } : {}) };
}
async function cmdScenarioNew(project, args) {
    const name = args.positional[1];
    if (name === undefined) {
        err('usage: dsh-eval scenarios new <name>');
        return 3;
    }
    const { addScenario, scenarioTemplate } = await import('./core/intake.js');
    try {
        const r = await addScenario(project, name, scenarioTemplate(name));
        out(`${r.name} → ${r.dir}`);
        for (const f of r.written)
            out(`  ${f}`);
        out(r.selfcheck.ok ? `selfcheck: ${r.selfcheck.detail}` : `selfcheck FAILED: ${r.selfcheck.detail}`);
        out('Edit prompts.json, setup.py, verify.py and oracle.py, then run: dsh-eval selfcheck ' + name);
        return r.selfcheck.ok ? 0 : 1;
    }
    catch (e) {
        err(e instanceof Error ? e.message : String(e));
        return 2;
    }
}
function cmdScenarios(project, args) {
    const { scenarios, invalid } = collectScenarios(project, scenarioFilter(args));
    out(`root: ${project.scenarioRoot}`);
    for (const s of scenarios)
        out(`  ${s.name.padEnd(28)} turns=${String(s.prompts.length).padStart(2)} ${(s.meta.category ?? '-').padEnd(10)} oracle=${s.hasOracle ? 'yes' : 'no '}${s.meta.holdout ? ' HOLDOUT' : ''} ${s.meta.stressor ?? ''}`);
    for (const i of invalid)
        out(`  !! ${i.dir}: ${i.error}`);
    out(`${scenarios.length} scenario(s)`);
    return 0;
}
async function cmdSelfcheck(project, args) {
    const { scenarios } = collectScenarios(project, scenarioFilter(args));
    if (scenarios.length === 0) {
        err('no scenarios matched');
        return 3;
    }
    const strict = args.flags['strict'] === true;
    const results = await selfcheckAll(scenarios, 4, { strict });
    let ok = true;
    for (const r of results) {
        ok &&= r.ok;
        const mut = strict && r.mutated !== undefined ? ` mutations=${r.mutated - (r.nonDiscriminating?.length ?? 0)}/${r.mutated} caught` : '';
        out(`${r.ok ? 'OK ' : 'BAD'} ${r.name.padEnd(28)} size=${String(Math.round(r.bytes / 1000)).padStart(5)}K turns=${String(r.turns).padStart(2)} blank→${r.blankPasses === null ? '?' : r.blankPasses ? 'PASS?!' : 'fail'} oracle→${r.oraclePasses === null ? 'n/a ' : r.oraclePasses ? 'pass' : 'FAIL'}${mut} ${r.error ?? r.detail}`);
    }
    return ok ? 0 : 1;
}
async function cmdDiff(project, args) {
    const [b, ...cs] = args.positional;
    if (b === undefined || cs.length === 0) {
        err('usage: dsh-eval diff <baseline> <candidate>...');
        return 3;
    }
    const baseline = loadArmFile(resolveArmPath(project, b));
    const candidates = cs.map(c => loadArmFile(resolveArmPath(project, c)));
    // Private scratch: a UI server on the same project may be composing arms right now.
    const prepared = await withPreviewArms(project, armsDir => prepareArms(baseline, candidates, { evalHome: project.home, armsDir }));
    for (const d of prepared.diffs) {
        out(`${d.candidate} vs ${baseline.name}: ${d.variables} variable(s)`);
        for (const line of describeDiff(d))
            out(`  ${line}`);
    }
    return prepared.diffs.every(d => d.variables === 1) ? 0 : 1;
}
function printReport(report) {
    out(renderMarkdown(report));
}
async function cmdRun(project, args) {
    const baseline = typeof args.flags['baseline'] === 'string' ? args.flags['baseline'] : 'baseline';
    const candidates = list(args.flags['arm']);
    const resume = typeof args.flags['resume'] === 'string' ? args.flags['resume'] : undefined;
    const aa = args.flags['aa'] === true;
    if (candidates.length === 0 && resume === undefined && !aa) {
        err('usage: dsh-eval run --baseline <arm> --arm <arm> [--arm <arm>] [scenario globs...]  (or --aa for a noise-floor run)');
        return 3;
    }
    const request = {
        baseline,
        candidates,
        ...scenarioFilter(args),
        ...(num(args.flags['repeats']) !== undefined ? { repeats: num(args.flags['repeats']) } : {}),
        ...(num(args.flags['concurrency']) !== undefined ? { concurrency: num(args.flags['concurrency']) } : {}),
        ...(typeof args.flags['label'] === 'string' ? { label: args.flags['label'] } : {}),
        ...(args.flags['allow-multi'] === true ? { allowMulti: true } : {}),
        ...(args.flags['skip-selfcheck'] === true ? { skipSelfcheck: true } : {}),
        ...(args.flags['keep-workdirs'] === true ? { keepWorkdirs: true } : {}),
        ...(num(args.flags['turn-timeout']) !== undefined ? { turnTimeoutS: num(args.flags['turn-timeout']) } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(aa ? { aa: true } : {}),
        ...(num(args.flags['max-usd']) !== undefined ? { maxUsd: num(args.flags['max-usd']) } : {}),
        ...(args.flags['sequential'] === true ? { sequential: true } : {}),
        ...(args.flags['sandbox'] === 'docker' ? { sandbox: 'docker' } : args.flags['sandbox'] === 'host' ? { sandbox: 'host' } : {}),
        ...(typeof args.flags['docker-runtime'] === 'string' ? { dockerRuntime: args.flags['docker-runtime'] } : {}),
        ...(args.flags['docker-keep-sandbox'] === true ? { dockerKeepSandbox: true } : {}),
        ...(args.flags['no-meter'] === true ? { meter: false } : {}),
        ...(args.flags['perturb'] === true ? { perturb: true } : {}),
        ...(args.flags['probe'] === true ? { probe: true } : {}),
        ...(typeof args.flags['replay'] === 'string' ? { replay: { runId: args.flags['replay'], ...(num(args.flags['fork-at']) !== undefined ? { forkAt: num(args.flags['fork-at']) } : {}) } } : {}),
        ...(num(args.flags['max-usd-per-trial']) !== undefined ? { maxUsdPerTrial: num(args.flags['max-usd-per-trial']) } : {}),
        ...(args.flags['order'] === 'signal' ? { order: 'signal' } : {}),
        ...(num(args.flags['fault-rate']) !== undefined ? { faultRate: num(args.flags['fault-rate']) } : {}),
        ...(num(args.flags['fault-seed']) !== undefined ? { faultSeed: num(args.flags['fault-seed']) } : {}),
        ...(typeof args.flags['docker-image'] === 'string' ? { dockerImage: args.flags['docker-image'] } : {}),
        ...(num(args.flags['seed']) !== undefined ? { seed: num(args.flags['seed']) } : {}),
    };
    const controller = new AbortController();
    process.on('SIGINT', () => { err('\ncancelling… (finished trials are kept; resume with --resume <id>)'); controller.abort(); });
    const started = Date.now();
    let launched;
    try {
        launched = await launchRun(project, request, { log: out, signal: controller.signal });
    }
    catch (error) {
        if (error instanceof LaunchError) {
            err(`error: ${error.message}`);
            return 3;
        }
        throw error;
    }
    out(`run ${launched.id}: ${launched.scenarios.length} scenarios × ${launched.plan.repeats} repeats × ${1 + launched.plan.candidates.length} arms = ${launched.scenarios.length * launched.plan.repeats * (1 + launched.plan.candidates.length)} trials, concurrency ${launched.plan.concurrency}`);
    if (args.flags['dry-run'] === true) {
        controller.abort();
        await launched.done;
        out('dry run: nothing executed');
        return 0;
    }
    const { progress, report } = await launched.done;
    out('');
    printReport(report);
    out(`ledgers: ${runPaths(project.runsRoot, launched.id).dir}`);
    out(`total $${progress.usd.toFixed(4)} · ${((Date.now() - started) / 60000).toFixed(1)} min · ${progress.status}`);
    if (progress.status !== 'done')
        return 2;
    if (report.candidates.some(c => c.gate === 'regressions'))
        return 1;
    if (report.candidates.some(c => c.gate === 'incomplete'))
        return 2;
    return 0;
}
async function cmdJudge(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval judge <runId> [--model deepseek-v4-pro] [--arm <candidate>] [--seed N]');
        return 3;
    }
    try {
        const models = list(args.flags['model']);
        const mode = args.flags['mode'] === 'absolute' ? 'absolute' : args.flags['mode'] === 'both' ? 'both' : 'pairwise';
        const reports = await runJudge(project, id, { ...(models.length ? { models } : {}), mode, ...(typeof args.flags['arm'] === 'string' ? { candidate: args.flags['arm'] } : {}), ...(num(args.flags['seed']) !== undefined ? { seed: num(args.flags['seed']) } : {}), ...(args.flags['allow-same-family'] === true ? { allowSameFamily: true } : {}), log: out });
        for (const r of reports)
            out(`${r.candidate} vs ${r.baseline} · judge ${(r.models ?? [r.model]).join(' + ')}: ${r.wins} candidate / ${r.losses} baseline / ${r.ties} ties · mid-p ${r.midP.toFixed(2)} · P(candidate wins a decided pair) ${(r.pWin * 100).toFixed(0)}% · order disagreement ${(r.inconsistentShare * 100).toFixed(0)}% of votes · panel unanimous ${((r.panelAgreement ?? 1) * 100).toFixed(0)}% · ${fmtUsd(r.usd)}${r.humanAgreement ? ` · human agreement ${(r.humanAgreement.agree * 100).toFixed(0)}% on ${r.humanAgreement.n}` : ''}`);
        return 0;
    }
    catch (error) {
        if (error instanceof LaunchError) {
            err(`error: ${error.message}`);
            return 3;
        }
        throw error;
    }
}
async function cmdReport(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval report <runId> [--json] [--rebuild-ledgers]');
        return 3;
    }
    if (args.flags['rebuild-ledgers'] === true)
        out(`re-derived ${await rebuildLedgers(project, id)} ledgers from events`);
    const report = rebuildReport(project, id);
    if (args.flags['json'] === true)
        out(JSON.stringify(report, null, 2));
    else
        printReport(report);
    return report.candidates.some(c => c.gate === 'regressions') ? 1 : 0;
}
async function cmdPerturb(project, args) {
    const { generateVariants, writeVariants } = await import('./core/perturb.js');
    const { deepseekChat } = await import('./core/judge.js');
    const { resolveApiKey } = await import('./core/env.js');
    const filter = scenarioFilter(args);
    const { scenarios } = collectScenarios(project, { ...filter, includeHoldout: true });
    if (scenarios.length === 0) {
        err('usage: dsh-eval perturb <scenario globs> [--n 2] [--model deepseek-v4-flash]');
        return 3;
    }
    const apiKey = resolveApiKey();
    if (!apiKey) {
        err('no DEEPSEEK_API_KEY (env, $DSH_HOME/.env or ~/.dsh/.env)');
        return 2;
    }
    const model = typeof args.flags['model'] === 'string' ? args.flags['model'] : 'deepseek-v4-flash';
    const n = num(args.flags['n']) ?? 2;
    const chat = deepseekChat({ model, apiKey, temperature: 1 });
    let total = 0;
    for (const s of scenarios) {
        const r = await generateVariants(s, n, chat);
        total += r.usd;
        if (r.variants.length === 0) {
            out(`${s.name}: no usable variant (${r.rejected.join('; ')})`);
            continue;
        }
        const file = writeVariants(s, r.variants);
        out(`${s.name}: ${r.variants.length} variant(s) → ${file}${r.rejected.length ? ` (rejected: ${r.rejected.join('; ')})` : ''}`);
        r.variants.forEach((v, i) => v.forEach((p, t) => out(`  v${i + 1} turn ${t + 1}: ${p.replace(/\s+/g, ' ').slice(0, 160)}`)));
    }
    out(`paraphrase spend $${total.toFixed(4)} — review the variants above; a variant that changes the task must be removed by hand`);
    return 0;
}
async function cmdPreflight(project, args) {
    const arm = args.positional[0];
    if (arm === undefined) {
        err('usage: dsh-eval preflight <arm> [--scenario z0_env_smoke] [--dry]');
        return 3;
    }
    const { preflightArm } = await import('./core/preflight.js');
    const r = await preflightArm(project, arm, {
        ...(typeof args.flags['scenario'] === 'string' ? { scenario: args.flags['scenario'] } : {}),
        ...(args.flags['dry'] === true ? { dry: true } : {}),
        log: out,
    });
    out('');
    for (const s of r.stages)
        out(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name.padEnd(8)} ${s.detail}`);
    if (r.rows.length > 0)
        for (const row of r.rows)
            out(`       row ${row.id}: ${row.present ? (row.enabled ? 'mounted' : 'present but disabled') : 'MISSING from the composed tree'}${row.inBaseline ? ' · ALSO in the baseline, so it is in both arms' : ''}`);
    for (const line of r.diff)
        out(`       ${line}`);
    if (r.smoke !== undefined && r.smoke.ok)
        out(`       tools available to the agent: ${r.smoke.tools.length} (${r.smoke.tools.slice(0, 6).join(', ')}${r.smoke.tools.length > 6 ? ', …' : ''})`);
    if (r.smoke !== undefined && !r.smoke.ok)
        out(`       the full stack is in the trial's ledger under .dsh-eval/runs`);
    out(r.ok ? `${arm} loads and runs` : `${arm} is not ready`);
    return r.ok ? 0 : 1;
}
async function cmdProbe(project, args) {
    const { probeRoute } = await import('./core/orchestrate.js');
    const v = await probeRoute(project, {
        ...(typeof args.flags['model'] === 'string' ? { model: args.flags['model'] } : {}),
        ...(num(args.flags['samples']) !== undefined ? { samples: num(args.flags['samples']) } : {}),
        ...(args.flags['enroll'] === true ? { enroll: true } : {}),
        log: out,
    });
    if (v.verdict === 'no-reference') {
        out(`enrolled a reference for ${v.model} · $${v.usd.toFixed(4)}`);
        return 0;
    }
    out(`${v.model}: ${v.verdict} · probe distance ${v.distance.toFixed(3)} · permutation p ${v.p.toFixed(3)} · reference enrolled ${v.enrolledAt?.slice(0, 10)} · $${v.usd.toFixed(4)}`);
    return v.verdict === 'differs' ? 1 : 0;
}
async function cmdRerun(project, args) {
    const [id, scenario] = args.positional;
    if (id === undefined || scenario === undefined) {
        err('usage: dsh-eval rerun <runId> <scenario> [--repeats 3] [--arm <candidate>]');
        return 3;
    }
    const r = await regradeSafeRerun(project, id, scenario, args);
    out(`${r.fork ? `fork from step ${r.fork.step}` : 'rerun'} ${r.newRunId}: ${r.verdict} — ${r.original ? `${r.original.failing} failed again in ${r.failedAgain}/${r.reps}, same first divergence (call ${r.original.call}) in ${r.sameCall}/${r.reps}` : `${r.failedAgain}/${r.reps} reruns had one failing arm`}`);
    return 0;
}
async function regradeSafeRerun(project, id, scenario, args) {
    const { rerunScenario } = await import('./core/orchestrate.js');
    return rerunScenario(project, id, scenario, { ...(num(args.flags['repeats']) !== undefined ? { repeats: num(args.flags['repeats']) } : {}), ...(typeof args.flags['arm'] === 'string' ? { candidate: args.flags['arm'] } : {}), ...(args.flags['fork'] === true ? { fork: true } : {}), log: out });
}
async function cmdPublish(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval publish <runId> [--out <dir>] [--keep-paths]');
        return 3;
    }
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan)) {
        err(`run ${id} not found`);
        return 3;
    }
    const outDir = typeof args.flags['out'] === 'string' ? resolve(args.flags['out']) : join(project.evalDir, 'bundles', id);
    mkdirSync(outDir, { recursive: true });
    cpSync(paths.dir, outDir, { recursive: true });
    // A bundle goes to other people. Workspaces, checkouts and profiles are all under a home
    // directory whose name is the author's, so every text file in the copy has it replaced by
    // `~` and the bundle is sealed again over what it now contains. The original run is
    // untouched; this is a derived artifact and says so.
    const redacted = args.flags['keep-paths'] === true ? 0 : redactTree(outDir);
    const { sealRun, signingKey } = await import('./core/manifest.js');
    const { deriveReport, sealAndIssue, verifyRunDir } = await import('./core/orchestrate.js');
    const { runPathsAt, readPlan, writeJsonAtomic } = await import('./core/store.js');
    if (redacted > 0) {
        const at = runPathsAt(outDir);
        const plan = readPlan(at);
        const report = deriveReport(project, id, at);
        writeJsonAtomic(at.report, report);
        writeFileSync(at.reportMd, (await import('./core/report.js')).renderMarkdown(report));
        sealRun(at, plan.id);
        sealAndIssue(project, at, plan, report);
        void signingKey;
    }
    const html = exportHtml(project, id, join(outDir, 'report.html'));
    if (html !== 0)
        return html;
    if (redacted > 0)
        writeFileSync(join(outDir, 'report.html'), tilde(readFileSync(join(outDir, 'report.html'), 'utf8')));
    const v = verifyRunDir(project, outDir);
    writeFileSync(join(outDir, 'VERIFY.md'), [
        `# Verifying this evaluation bundle`, '',
        `Run \`${id}\`, sealed ${v.sealedAt ?? '(unsealed)'}; evidence sha256 \`${v.evidenceSha ?? '—'}\`.`, '',
        ...(redacted > 0
            ? ['This is a redacted copy: the machine\'s home directory was replaced by `~` in ' + String(redacted) + ' file(s), and the bundle was then sealed and receipted again over what it now contains. Its evidence sha therefore differs from the original run\'s, on purpose. Publish with `--keep-paths` to carry the original bytes and seal instead.', '']
            : ['This bundle carries the original bytes, including absolute paths from the machine that produced it.', '']),
        'Every evidence file (plan, environment, arms, ledgers, events, traces, meter ledgers, artifacts) is listed with its sha256 in `manifest.json`, and `report.json` / `report.md` / `report.html` are derived from those files. To check that nothing was altered and that the report follows from the evidence:', '',
        '```bash', `dsh-eval verify ${outDir.split('/').pop() ?? outDir}`, '```', '',
        'The command recomputes every hash, lists missing or changed files, re-derives the report from the ledgers, compares its readings with the stored report, and checks the signed receipt. It answers PASS (signed claims recompute from intact evidence, exit 0), INVALID (evidence, signature or derivation broken, exit 1) or INCONCLUSIVE (nothing falsified, but the run has no contract or its evidence is incomplete, exit 2).', '',
        '`receipt.json` carries the analysis contract (estimand, pairing, estimator, α, SESOI, seed, gate order), the claims, the coverage counts and an Ed25519 signature over all of it; `manifest.json` carries the same contract and every evidence hash.', '',
        'Meter ledgers under `meter/` carry a hash chain per trial (`prev`/`hash`), and `*.responses.jsonl` files hold the recorded provider responses so the run can be replayed without a key: `dsh-eval run --replay <runId> …` from a project that contains this run directory under `.dsh-eval/runs/`.', '',
    ].join('\n'));
    out(`bundle → ${outDir}`);
    if (redacted > 0)
        out(`  ${redacted} file(s) had this machine's home path replaced by ~, and the bundle was re-sealed`);
    out(`  evidence ${v.evidenceSha?.slice(0, 16) ?? '—'}… · ${v.ok ? 'verifies' : 'DOES NOT verify'} · report.html + VERIFY.md included`);
    return v.ok ? 0 : 1;
}
/** Replace this machine's home path throughout a copied run. Returns how many files changed. */
function redactTree(dir) {
    let changed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            changed += redactTree(p);
            continue;
        }
        if (!/\.(json|jsonl|md|ya?ml|txt|html|py|csv|log)$/.test(entry.name))
            continue;
        const text = readFileSync(p, 'utf8');
        const next = tilde(text);
        if (next !== text) {
            writeFileSync(p, next);
            changed += 1;
        }
    }
    return changed;
}
function cmdVerify(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval verify <runId | run directory> [--json]');
        return 3;
    }
    const v = existsSync(join(id, 'plan.json')) ? verifyRunDir(project, id) : verifyRunIntegrity(project, id);
    if (args.flags['json'] === true) {
        out(JSON.stringify(v, null, 2));
        return v.ok ? 0 : 1;
    }
    if (v.sealedAt === null) {
        out(`run ${id}: ${v.reportDiff[0] ?? 'not sealed'}`);
        return 1;
    }
    out(`run ${id}: sealed ${v.sealedAt} · evidence ${v.evidenceSha.slice(0, 16)}…`);
    if (v.missing.length)
        out(`  missing (${v.missing.length}): ${v.missing.slice(0, 8).join(', ')}${v.missing.length > 8 ? ', …' : ''}`);
    if (v.changed.length)
        out(`  CHANGED since seal (${v.changed.length}): ${v.changed.slice(0, 8).join(', ')}${v.changed.length > 8 ? ', …' : ''}`);
    if (v.added.length)
        out(`  added after seal (${v.added.length}): ${v.added.slice(0, 8).join(', ')}${v.added.length > 8 ? ', …' : ''}`);
    if (v.reportReproduces === null)
        out('  report: none stored');
    else if (v.reportReproduces)
        out('  report: reproduces from the sealed ledgers');
    else {
        out('  report: DOES NOT reproduce from the ledgers');
        for (const d of v.reportDiff)
            out(`    ${d}`);
    }
    out(`  ${v.status ?? (v.ok ? 'PASS' : 'INVALID')} — ${v.statusReason ?? ''}`);
    return v.status === 'INVALID' || !v.ok ? 1 : v.status === 'INCONCLUSIVE' ? 2 : 0;
}
async function cmdRegrade(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval regrade <runId>   (needs a run made with --keep-workdirs)');
        return 3;
    }
    const r = await regradeRun(project, id, { log: out });
    out(`regraded ${r.regradable} trial(s), ${r.skipped} skipped (workspace not kept), ${r.changed.length} verdict(s) changed; report rebuilt and evidence re-sealed`);
    for (const c of r.changed)
        out(`  ${c.scenario}/${c.arm}#${c.rep}: ${c.before} → ${c.after} · ${c.detail}`);
    return 0;
}
/**
 * Recurring failures and behaviour regimes over every archived trial, ranked by
 * how unevenly they land on the arms: a pattern that hits one arm far more than
 * the other points at what that arm changed, while one that hits both alike is
 * a property of the scenario or of dsh. Reference material, so it lives here
 * rather than on the runs page.
 */
function cmdPatterns(project) {
    const runs = listRuns(project.runsRoot);
    const ledgers = [];
    for (const r of runs) {
        try {
            ledgers.push(...readLedgers(runPaths(project.runsRoot, r.id)));
        }
        catch { /* unreadable run */ }
    }
    const patterns = discoverPatterns(ledgers);
    if (patterns.length === 0) {
        out(`nothing recurs at least three times across ${ledgers.length} trials`);
        return 0;
    }
    out(`${patterns.length} pattern(s) over ${ledgers.length} trials in ${runs.length} runs, most arm-skewed first`);
    for (const p of patterns) {
        const where = `${p.scenarios.slice(0, 4).join(', ')}${p.scenarios.length > 4 ? ` +${p.scenarios.length - 4}` : ''}`;
        out(`\n${p.kind.padEnd(9)} ${String(p.count).padStart(4)} trials  skew ${(p.armSkew * 100).toFixed(0).padStart(3)}%  arms ${p.arms.join(', ')}  in ${where}`);
        out(`          ${p.signature}`);
    }
    return 0;
}
function cmdRuns(project) {
    const runs = listRuns(project.runsRoot);
    if (runs.length === 0) {
        out(`no runs under ${project.runsRoot}/runs`);
        return 0;
    }
    for (const r of runs) {
        let summary = '';
        const paths = runPaths(project.runsRoot, r.id);
        if (existsSync(paths.report)) {
            const rep = readJson(paths.report);
            summary = rep.candidates.map(c => `${c.arm}: ${c.gate === 'pass' ? fmtPct(c.costPctCI.mean) + (c.costPctCI.significant ? '' : ' (n.s.)') : c.gate}`).join('; ');
        }
        out(`${r.id}  ${r.status.padEnd(9)} ${r.arms.join(' vs ').padEnd(30)} ${String(r.scenarios).padStart(3)} scen × ${r.repeats}  ${String(r.completed).padStart(3)}/${String(r.total).padEnd(3)} ${fmtUsd(r.usd).padStart(9)}  ${r.label ?? ''} ${summary}`);
    }
    return 0;
}
async function cmdUi(project, args) {
    const { startServer } = await import('./server/index.js');
    const port = num(args.flags['port']) ?? 4177;
    const { url } = await startServer({ project, port });
    out(`dsh-eval ui: ${url}  (project ${project.root})`);
    if (args.flags['open'] === true)
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    await new Promise(() => { });
    return 0;
}
function exportHtml(project, id, outFile) {
    const paths = runPaths(project.runsRoot, id);
    const uiDir = resolve(new URL('../lib/ui/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const candidates = [uiDir, resolve(new URL('./ui/', import.meta.url).pathname)];
    const dir = candidates.find(d => existsSync(join(d, 'app.js')));
    if (dir === undefined) {
        err('UI bundle not built; run: npm run build');
        return 3;
    }
    const plan = readPlan(paths);
    const ledgers = readLedgers(paths);
    const full = {};
    const traces = {};
    for (const l of ledgers) {
        const key = `${l.scenario}|${l.arm}|${l.rep}`;
        full[key] = l;
        const traceFile = join(paths.dir, l.traceFile);
        traces[key] = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
    }
    const report = existsSync(paths.report) ? readJson(paths.report) : rebuildReport(project, id);
    const progress = existsSync(paths.progress) ? readJson(paths.progress) : null;
    const env = existsSync(paths.env) ? readJson(paths.env) : null;
    const runRow = listRuns(project.runsRoot).find(r => r.id === id);
    const bundle = {
        meta: { version: evalInfraVersion(), project: project.root, home: '', profile: project.config.profile, profileReady: true, plugins: [], scenarioRoot: '', armsDir: '', defaults: { repeats: plan.repeats, concurrency: plan.concurrency } },
        runs: runRow ? [{ ...runRow, verdicts: report.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, costPct: c.costPctCI.mean, regressions: c.regressions.length, improvements: c.improvements.length })) }] : [],
        run: { plan, progress, report, env, active: false, logs: [] },
        ledgers: ledgers.map(l => ({ ...l, steps: l.steps.map(s => ({ ...s, calls: s.calls.map(c => c.name) })) })),
        full,
        traces,
        history: { arms: [], scenarios: [], runs: [] },
    };
    const css = readFileSync(join(dir, 'app.css'), 'utf8');
    const js = readFileSync(join(dir, 'app.js'), 'utf8');
    const data = JSON.stringify(bundle).replace(/<\/script/gi, '<\\/script');
    const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>dsh-eval ${id}</title><style>${css}</style></head><body><div id="app"></div><script>window.__DSH_EVAL_STATIC__=${data}</script><script type="module">${js}</script></body></html>`;
    mkdirSync(resolve(outFile, '..'), { recursive: true });
    writeFileSync(outFile, html);
    out(`${ledgers.length} trials → ${outFile} (${(html.length / 1024).toFixed(0)} KB, self-contained)`);
    return 0;
}
function cmdExport(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval export <runId> [--out <dir>] [--html <file>]');
        return 3;
    }
    const paths = runPaths(project.runsRoot, id);
    if (!existsSync(paths.plan)) {
        err(`run ${id} not found`);
        return 3;
    }
    if (typeof args.flags['html'] === 'string')
        return exportHtml(project, id, resolve(args.flags['html']));
    if (args.flags['html'] === true)
        return exportHtml(project, id, join(paths.dir, 'report.html'));
    const plan = readPlan(paths);
    const outDir = typeof args.flags['out'] === 'string' ? resolve(args.flags['out']) : join(paths.dir, 'atif');
    mkdirSync(outDir, { recursive: true });
    const { scenarios } = collectScenarios(project, { scenarios: plan.scenarios });
    const prompts = new Map(scenarios.map(s => [s.name, s.prompts]));
    let n = 0;
    for (const ledger of readLedgers(paths)) {
        const traceFile = join(paths.dir, ledger.traceFile);
        const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
        const atif = toAtif(ledger, trace, prompts.get(ledger.scenario) ?? [], evalInfraVersion());
        const file = join(outDir, `${ledger.scenario}__${ledger.arm}__rep${ledger.rep}.atif.json`);
        writeFileSync(file, JSON.stringify(atif, null, 2));
        n += 1;
    }
    out(`${n} trajectories → ${outDir}`);
    return 0;
}
function help() {
    out(`dsh-eval ${evalInfraVersion()} — paired A/B evaluation for dsh components

SET UP
  init [--plugin <path|pkg>]...       create .dsh-eval/home + eval profile, add plugins, write starter arms
  add <path|pkg> [--activate]         install a plugin into the eval profile; a bundle plugin is left inert so an arm can be the thing that adds it (--activate puts it in every arm)
  scenarios [globs] [--category c]    list scenarios
  scenarios new <name>                write a working scenario from the template into the project's own library and selfcheck it
  selfcheck [globs] [--strict]        oracle must pass, untouched workspace must fail; --strict also deletes/blanks each oracle output
  diff <baseline> <candidate>...      composed-tree diff between arms
  perturb <globs> [--n N]             draft paraphrases of a scenario's prompts (prompts.variants.json) for --perturb
  preflight <arm> [--scenario S] [--dry]   compose the arm, check its rows mounted, then boot a runtime and run one turn (--dry stops before spending)
  probe [--model M] [--samples N] [--enroll]   fingerprint the route's served model against an enrolled reference (exit 1 when it differs)

RUN
  run --baseline <arm> --arm <arm>... [globs]
      [--repeats N] [--concurrency N] [--label L] [--allow-multi] [--skip-selfcheck] [--keep-workdirs]
      [--turn-timeout S] [--resume <id>] [--dry-run] [--aa] [--include-holdout]
    budget      [--max-usd N] [--max-usd-per-trial X]        stop scheduling / stop a trial once observed spend passes the cap
    statistics  [--sequential [--seed N]] [--order signal]   anytime-valid early stopping; order scenarios by archive signal
                [--perturb]                                  paraphrase variants on repeats above 1, identical across arms
    provenance  [--no-meter] [--probe] [--fault-rate P] [--fault-seed N]
                                                             the wire meter is on by default; --probe checks the served model first
    isolation   [--sandbox host|docker] [--docker-image IMG] [--docker-runtime runsc|kata] [--docker-keep-sandbox]
                                                             a container per trial is the default when third-party plugins are linked and Docker is available
    replay      [--replay <runId> [--fork-at N]]             re-execute a recorded run keylessly; fork to live calls after N responses

READ AND CHECK
  report <runId> [--json] [--rebuild-ledgers]   rebuild the report; --rebuild-ledgers re-derives ledgers from the stored events first
  judge <runId> [--model M]... [--mode pairwise|absolute|both] [--arm A] [--seed N] [--allow-same-family]
                                      blinded judge over scenarios that declare meta.judge; several --model form a panel, absolute mode
                                      grades each trial and rectifies pass rates with human annotations (PPI++). Same-family judges are refused
  verify <runId | dir> [--json]       recompute the sealed hashes, re-derive the report, check the signed receipt: PASS / INVALID / INCONCLUSIVE
  regrade <runId>                     re-run verifiers on kept workspaces (no agent re-run), rebuild the report, re-seal
  rerun <runId> <scenario> [--repeats N] [--fork]   re-run a failing pair to tell a cause from resampling luck (--fork replays the identical prefix)
  runs                                list runs
  patterns                            what keeps failing across the archive, most arm-skewed first (skew = one arm's doing)
  ui [--port 4177] [--open]           local web UI
  publish <runId> [--out dir]         bundle the sealed run with report.html and VERIFY.md for a third party
  export <runId> [--out dir]          ATIF v1.8 trajectories
  export <runId> --html [file]        self-contained HTML of the run (report, matrix, traces) for sharing

exit codes — run: 0 no regressions · 1 regressions · 2 incomplete/cancelled/errors · 3 usage
             verify: 0 PASS · 1 INVALID · 2 INCONCLUSIVE · probe: 0 matches · 1 differs`);
    return 0;
}
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const project = loadProject(typeof args.flags['project'] === 'string' ? args.flags['project'] : process.cwd());
    switch (args.command) {
        case 'init': return cmdInit(project, args);
        case 'add': return cmdAdd(project, args);
        case 'scenarios': return args.positional[0] === 'new' ? cmdScenarioNew(project, args) : cmdScenarios(project, args);
        case 'selfcheck': return cmdSelfcheck(project, args);
        case 'diff': return cmdDiff(project, args);
        case 'run': return cmdRun(project, args);
        case 'report': return cmdReport(project, args);
        case 'verify': return cmdVerify(project, args);
        case 'perturb': return cmdPerturb(project, args);
        case 'probe': return cmdProbe(project, args);
        case 'preflight': return cmdPreflight(project, args);
        case 'regrade': return cmdRegrade(project, args);
        case 'rerun': return cmdRerun(project, args);
        case 'publish': return cmdPublish(project, args);
        case 'judge': return cmdJudge(project, args);
        case 'runs': return cmdRuns(project);
        case 'patterns': return cmdPatterns(project);
        case 'ui': return cmdUi(project, args);
        case 'export': return cmdExport(project, args);
        case 'version':
            out(evalInfraVersion());
            return 0;
        default: return help();
    }
}
// True when this file is the process entry point. argv[1] is the path as invoked, which is a symlink
// under a global bin directory (`dsh-eval`) and the source path under tsx, so both sides are resolved.
const invokedDirectly = (() => {
    const argv1 = process.argv[1];
    if (argv1 === undefined)
        return false;
    try {
        return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return /cli\.(js|ts)$/.test(argv1);
    }
})();
if (invokedDirectly) {
    main().then((code) => { process.exitCode = code; }).catch((error) => { err(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
}
