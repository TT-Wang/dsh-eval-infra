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
 *   dsh-eval ui [--port 4177] [--open]       local web UI
 *   dsh-eval export <runId> [--out dir]      ATIF trajectories of every trial
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchRun, LaunchError, collectScenarios, rebuildReport, resolveArmPath } from './core/orchestrate.js';
import { loadArmFile } from './core/arms.js';
import { describeDiff, prepareArms } from './core/plan.js';
import { ensureEvalProfile, loadProject, saveProjectConfig, STARTER_BASELINE, starterCandidate } from './core/project.js';
import { fmtPct, fmtUsd, renderMarkdown } from './core/report.js';
import { selfcheckAll } from './core/selfcheck.js';
import { listRuns, readJson, readLedgers, readPlan, runPaths } from './core/store.js';
import { toAtif } from './core/atif.js';
import { evalInfraVersion } from './core/env.js';
function parseArgs(argv) {
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
        err('usage: dsh-eval add <path|package>');
        return 3;
    }
    ensureEvalProfile(project.home, project.config.profile);
    const target = existsSync(resolve(spec)) ? resolve(spec) : spec;
    return runDsh(['plugin', '--profile', project.config.profile, 'add', target], { DSH_HOME: project.home });
}
function scenarioFilter(args) {
    return { scenarios: args.positional, categories: list(args.flags['category']), tags: list(args.flags['tag']) };
}
function cmdScenarios(project, args) {
    const { scenarios, invalid } = collectScenarios(project, scenarioFilter(args));
    out(`root: ${project.scenarioRoot}`);
    for (const s of scenarios)
        out(`  ${s.name.padEnd(28)} turns=${String(s.prompts.length).padStart(2)} ${(s.meta.category ?? '-').padEnd(10)} oracle=${s.hasOracle ? 'yes' : 'no '} ${s.meta.stressor ?? ''}`);
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
    const results = await selfcheckAll(scenarios);
    let ok = true;
    for (const r of results) {
        ok &&= r.ok;
        out(`${r.ok ? 'OK ' : 'BAD'} ${r.name.padEnd(28)} size=${String(Math.round(r.bytes / 1000)).padStart(5)}K turns=${String(r.turns).padStart(2)} blank→${r.blankPasses === null ? '?' : r.blankPasses ? 'PASS?!' : 'fail'} oracle→${r.oraclePasses === null ? 'n/a ' : r.oraclePasses ? 'pass' : 'FAIL'} ${r.error ?? r.detail}`);
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
    const prepared = await prepareArms(baseline, candidates, { evalHome: project.home, armsDir: join(project.evalDir, 'tmp-arms') });
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
function cmdReport(project, args) {
    const id = args.positional[0];
    if (id === undefined) {
        err('usage: dsh-eval report <runId> [--json]');
        return 3;
    }
    const report = rebuildReport(project, id);
    if (args.flags['json'] === true)
        out(JSON.stringify(report, null, 2));
    else
        printReport(report);
    return report.candidates.some(c => c.gate === 'regressions') ? 1 : 0;
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

  init [--plugin <path|pkg>]...       create .dsh-eval/home + eval profile, add plugins, write starter arms
  add <path|pkg>                      add a plugin to the eval profile
  scenarios [globs] [--category c]    list scenarios
  selfcheck [globs]                   oracle must pass, untouched workspace must fail
  diff <baseline> <candidate>...      composed-tree diff between arms
  run --baseline <arm> --arm <arm>... [globs] [--repeats N] [--concurrency N] [--label L]
      [--allow-multi] [--skip-selfcheck] [--keep-workdirs] [--turn-timeout S] [--resume <id>] [--dry-run] [--aa]
  report <runId> [--json]             rebuild the report from ledgers
  runs                                list runs
  ui [--port 4177] [--open]           local web UI
  export <runId> [--out dir]          ATIF v1.8 trajectories
  export <runId> --html [file]        self-contained HTML of the run (report, matrix, traces) for sharing

exit codes for run: 0 no regressions · 1 regressions · 2 incomplete/cancelled/errors · 3 usage`);
    return 0;
}
export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const project = loadProject(typeof args.flags['project'] === 'string' ? args.flags['project'] : process.cwd());
    switch (args.command) {
        case 'init': return cmdInit(project, args);
        case 'add': return cmdAdd(project, args);
        case 'scenarios': return cmdScenarios(project, args);
        case 'selfcheck': return cmdSelfcheck(project, args);
        case 'diff': return cmdDiff(project, args);
        case 'run': return cmdRun(project, args);
        case 'report': return cmdReport(project, args);
        case 'runs': return cmdRuns(project);
        case 'ui': return cmdUi(project, args);
        case 'export': return cmdExport(project, args);
        case 'version':
            out(evalInfraVersion());
            return 0;
        default: return help();
    }
}
const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
    main().then((code) => { process.exitCode = code; }).catch((error) => { err(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
}
