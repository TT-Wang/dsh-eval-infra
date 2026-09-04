/**
 * HTTP API + static UI. `createEvalApp` returns a request handler that both
 * the standalone `dsh-eval ui` server and the in-dsh plugin route mount; the
 * handler is prefix-agnostic so it can live at `/` or under `/eval`.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { loadArmFile, parseArm } from '../core/arms.js';
import { load as parseYaml } from 'js-yaml';
import { toAtif } from '../core/atif.js';
import { evalInfraVersion, tilde } from '../core/env.js';
import { collectScenarios, launchRun, LaunchError, rebuildReport, resolveArmPath, verifyRunIntegrity } from '../core/orchestrate.js';
import { scenarioSignal } from '../core/signal.js';
import { discoverPatterns } from '../core/patterns.js';
import { describeDiff, evalProfileManifest, prepareArms } from '../core/plan.js';
import { loadProject } from '../core/project.js';
import { selfcheckAll } from '../core/selfcheck.js';
import { annotationKey, applyAnnotations, listRuns, readAnnotations, readEnvironment, readJson, readLedgers, readPlan, runPaths, writeAnnotations } from '../core/store.js';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function defaultUiDir() {
    // lib/server → ../ui holds the built bundle; src/server (tsx dev runs) must still use lib/ui, never the sources.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, '..', 'ui'), resolve(here, '..', '..', 'lib', 'ui')]) {
        if (existsSync(join(candidate, 'app.js')) && existsSync(join(candidate, 'index.html')))
            return candidate;
    }
    return resolve(here, '..', '..', 'lib', 'ui');
}
function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
}
async function readBody(req) {
    const chunks = [];
    for await (const c of req)
        chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : JSON.parse(text);
}
function readJsonl(path) {
    if (!existsSync(path))
        return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
export class EvalApp {
    project;
    uiDir;
    active = new Map();
    constructor(options) {
        this.project = options.project;
        this.uiDir = options.uiDir ?? defaultUiDir();
    }
    /** Cancel a running run; returns false when it is not active in this process. */
    cancel(id) {
        const run = this.active.get(id);
        if (run === undefined)
            return false;
        run.controller.abort();
        return true;
    }
    async start(request) {
        const listeners = new Set();
        const controller = new AbortController();
        const logs = [];
        const emit = (event, data) => { for (const l of listeners)
            l(event, data); };
        const entry = { id: '', controller, progress: undefined, listeners, logs };
        const launched = await launchRun(this.project, request, {
            signal: controller.signal,
            log: (line) => { logs.push(line); if (logs.length > 500)
                logs.shift(); emit('log', line); },
            onProgress: (p) => { entry.progress = p; emit('progress', p); },
            onLedger: (l) => emit('ledger', { scenario: l.scenario, arm: l.arm, rep: l.rep, ok: l.verdict?.ok ?? null, usd: l.totals.usd, error: l.error ?? null }),
        });
        entry.id = launched.id;
        this.active.set(launched.id, entry);
        void launched.done.then(({ report }) => {
            emit('done', { report });
        }).catch((error) => {
            emit('error', { message: error instanceof Error ? error.message : String(error) });
        }).finally(() => {
            setTimeout(() => this.active.delete(launched.id), 60_000);
        });
        return { id: launched.id };
    }
    /** Handle one request. `prefix` is the mount path without trailing slash ('' at root). Returns false when not ours. */
    async handle(req, res, prefix = '') {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let path = url.pathname;
        if (prefix !== '') {
            if (path !== prefix && !path.startsWith(prefix + '/'))
                return false;
            path = path.slice(prefix.length) || '/';
        }
        try {
            if (path.startsWith('/api/')) {
                await this.api(req, res, path.slice(4), url);
                return true;
            }
            return this.serveStatic(res, path);
        }
        catch (error) {
            const status = error instanceof LaunchError ? 400 : 500;
            json(res, status, { error: error instanceof Error ? error.message : String(error), code: error instanceof LaunchError ? error.code : 'internal' });
            return true;
        }
    }
    serveStatic(res, path) {
        let file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        if (file.includes('..')) {
            res.writeHead(400);
            res.end();
            return true;
        }
        let full = join(this.uiDir, file);
        if (!existsSync(full) || statSync(full).isDirectory()) {
            // SPA fallback for client routes
            file = 'index.html';
            full = join(this.uiDir, file);
        }
        if (!existsSync(full)) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end(`UI bundle not found at ${this.uiDir}; run "npm run build:ui"`);
            return true;
        }
        res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        createReadStream(full).pipe(res);
        return true;
    }
    async api(req, res, path, url) {
        const method = req.method ?? 'GET';
        const seg = path.split('/').filter(Boolean);
        const project = this.project;
        if (method === 'GET' && path === '/meta') {
            const profile = evalProfileManifest(project.home, project.config.profile);
            // The wizard states which isolation the run will use rather than asking; it needs to know
            // whether Docker is actually there, and whether any third-party plugin is linked.
            const { dockerAvailable } = await import('../core/docker.js');
            const docker = await dockerAvailable();
            // Paths here are shown in the UI and embedded in exported pages, so they carry `~`
            // rather than whoever's home directory this happens to be.
            json(res, 200, {
                version: evalInfraVersion(), project: tilde(project.root), home: tilde(project.home),
                profile: project.config.profile, profileReady: profile.exists,
                plugins: Object.keys(profile.dependencies),
                scenarioRoot: tilde(project.scenarioRoot), ownScenarioRoot: tilde(project.ownScenarioRoot), armsDir: tilde(project.armsDir),
                docker: { available: docker.ok, detail: docker.detail },
                defaults: { repeats: project.config.repeats, concurrency: project.config.concurrency },
            });
            return;
        }
        if (method === 'GET' && path === '/runs') {
            json(res, 200, listRuns(project.runsRoot).map((r) => {
                const reportPath = runPaths(project.runsRoot, r.id).report;
                if (!existsSync(reportPath))
                    return r;
                try {
                    const rep = readJson(reportPath);
                    return { ...r, verdicts: rep.candidates.map(c => ({ arm: c.arm, gate: c.gate, costReading: c.costReading, costPct: c.costPctCI.mean, regressions: c.regressions.length, improvements: c.improvements.length })) };
                }
                catch {
                    return r;
                }
            }));
            return;
        }
        if (method === 'GET' && path === '/history') {
            json(res, 200, buildHistory(project.runsRoot));
            return;
        }
        if (method === 'GET' && path === '/scenarios') {
            const { scenarios, invalid } = collectScenarios(project, {});
            json(res, 200, { scenarios: scenarios.map(s => ({ name: s.name, dir: s.dir, meta: s.meta, turns: s.prompts.length, hasOracle: s.hasOracle, variants: s.variants?.length ?? 0, prompts: s.prompts })), invalid });
            return;
        }
        if (method === 'GET' && path === '/scenarios/template') {
            const { scenarioTemplate } = await import('../core/intake.js');
            json(res, 200, scenarioTemplate(url.searchParams.get('name') ?? 'my_scenario'));
            return;
        }
        // Take in a scenario directory the user assembled: validate it, write it into the
        // project's own library, and selfcheck it, because a scenario nobody checked is a
        // grader nobody checked.
        if (method === 'POST' && path === '/scenarios') {
            const body = await readBody(req);
            const { addScenario } = await import('../core/intake.js');
            try {
                json(res, 200, await addScenario(project, body.name ?? '', body.files ?? {}));
            }
            catch (e) {
                json(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        if (method === 'GET' && path === '/arms') {
            const files = existsSync(project.armsDir) ? readdirSync(project.armsDir).filter(f => /\.(ya?ml|json)$/.test(f)).sort() : [];
            const arms = files.map((f) => {
                const p = join(project.armsDir, f);
                try {
                    const spec = loadArmFile(p);
                    return { file: f, path: p, spec, text: readFileSync(p, 'utf8') };
                }
                catch (e) {
                    return { file: f, path: p, error: e instanceof Error ? e.message : String(e), text: readFileSync(p, 'utf8') };
                }
            });
            json(res, 200, { dir: project.armsDir, arms });
            return;
        }
        if (method === 'POST' && path === '/preflight') {
            const body = await readBody(req);
            const { preflightArm } = await import('../core/preflight.js');
            json(res, 200, await preflightArm(project, body.arm, { ...(body.dry === true ? { dry: true } : {}), ...(typeof body.scenario === 'string' ? { scenario: body.scenario } : {}) }));
            return;
        }
        // Plugins on this machine an arm can insert, so the designer offers real choices.
        if (method === 'GET' && path === '/plugins') {
            const { discoverPlugins } = await import('../core/plugins.js');
            const found = discoverPlugins({ evalHome: project.home, profile: project.config.profile, ...(project.config.pluginRoots !== undefined ? { roots: project.config.pluginRoots } : {}) });
            // `path` and `bundlePatch` are shown in the UI; the arm file keeps the real path.
            json(res, 200, { plugins: found.map(p => ({ ...p, displayPath: tilde(p.path), ...(p.duplicates ? { duplicates: p.duplicates.map(tilde) } : {}) })) });
            return;
        }
        // The composed rows of one arm: what a "disable a row" or "change a config field" picker offers.
        if (method === 'GET' && path === '/rows') {
            const armName = url.searchParams.get('arm') ?? 'baseline';
            const spec = loadArmFile(resolveArmPath(project, armName));
            const prepared = await prepareArms(spec, [], { evalHome: project.home, armsDir: join(project.evalDir, 'tmp-arms') });
            const tree = prepared.trees.get(spec.name);
            json(res, 200, {
                arm: spec.name,
                rows: [...(tree ?? new Map()).entries()].map(([id, row]) => ({
                    id,
                    name: typeof row['name'] === 'string' ? row['name'] : undefined,
                    disabled: row['disabled'] === true,
                    configKeys: row['config'] !== null && typeof row['config'] === 'object' ? Object.keys(row['config']).sort() : [],
                    config: row['config'] !== null && typeof row['config'] === 'object' ? row['config'] : undefined,
                })),
            });
            return;
        }
        // Create or replace an arm file from the editor. The body is the YAML the user sees, so what is
        // saved is exactly what was reviewed; parsing it here is the validation.
        if ((method === 'PUT' || method === 'POST') && path.startsWith('/arms/') && path !== '/arms/diff') {
            const name = decodeURIComponent(path.slice('/arms/'.length));
            if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
                json(res, 400, { error: 'arm name must be letters, digits, . _ or -' });
                return;
            }
            const body = await readBody(req);
            if (typeof body.text !== 'string' || body.text.trim() === '') {
                json(res, 400, { error: 'empty arm file' });
                return;
            }
            let spec;
            try {
                spec = parseArm(body.text, `${name}.yml`);
            }
            catch (e) {
                json(res, 400, { error: e instanceof Error ? e.message : String(e) });
                return;
            }
            if (spec.name !== name) {
                json(res, 400, { error: `the file names the arm "${spec.name}" but it is being saved as "${name}"` });
                return;
            }
            mkdirSync(project.armsDir, { recursive: true });
            writeFileSync(join(project.armsDir, `${name}.yml`), body.text.endsWith('\n') ? body.text : `${body.text}\n`);
            json(res, 200, { saved: `${name}.yml`, spec });
            return;
        }
        // A generated patch file: several rows that express one decision, so the
        // one-variable rule can attribute them to a single source.
        if (method === 'PUT' && path.startsWith('/patch/')) {
            const name = decodeURIComponent(path.slice('/patch/'.length));
            if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
                json(res, 400, { error: 'patch name must be letters, digits, . _ or -' });
                return;
            }
            const body = await readBody(req);
            if (typeof body.text !== 'string' || body.text.trim() === '') {
                json(res, 400, { error: 'empty patch file' });
                return;
            }
            try {
                const rows = parseYaml(body.text);
                if (!Array.isArray(rows))
                    throw new Error('a patch file must be a list of loader rows');
            }
            catch (e) {
                json(res, 400, { error: e instanceof Error ? e.message : String(e) });
                return;
            }
            mkdirSync(project.armsDir, { recursive: true });
            const file = join(project.armsDir, `${name}.patch.yml`);
            writeFileSync(file, body.text.endsWith('\n') ? body.text : `${body.text}\n`);
            json(res, 200, { saved: file });
            return;
        }
        if (method === 'DELETE' && path.startsWith('/arms/')) {
            const name = decodeURIComponent(path.slice('/arms/'.length));
            const file = join(project.armsDir, `${name}.yml`);
            if (!existsSync(file)) {
                json(res, 404, { error: `no arm file ${name}.yml` });
                return;
            }
            rmSync(file);
            json(res, 200, { deleted: `${name}.yml` });
            return;
        }
        if (method === 'POST' && path === '/arms/diff') {
            const body = await readBody(req);
            const baseline = loadArmFile(resolveArmPath(project, body.baseline));
            const candidates = (body.candidates ?? []).map(c => loadArmFile(resolveArmPath(project, c)));
            const prepared = await prepareArms(baseline, candidates, { evalHome: project.home, armsDir: join(project.evalDir, 'tmp-arms') });
            json(res, 200, { diffs: prepared.diffs.map(d => ({ ...d, lines: describeDiff(d) })) });
            return;
        }
        if (method === 'POST' && path === '/selfcheck') {
            const body = await readBody(req);
            const { scenarios } = collectScenarios(project, { scenarios: body.scenarios ?? [] });
            json(res, 200, await selfcheckAll(scenarios));
            return;
        }
        if (method === 'POST' && path === '/runs') {
            const body = await readBody(req);
            json(res, 201, await this.start(body));
            return;
        }
        if (seg[0] === 'runs' && seg[1] !== undefined) {
            const id = seg[1];
            const paths = runPaths(project.runsRoot, id);
            if (!existsSync(paths.plan)) {
                json(res, 404, { error: `run ${id} not found` });
                return;
            }
            if (method === 'GET' && seg.length === 2) {
                const plan = readPlan(paths);
                const progress = existsSync(paths.progress) ? readJson(paths.progress) : null;
                const report = existsSync(paths.report) ? readJson(paths.report) : null;
                const env = readEnvironment(paths) ?? null;
                const active = this.active.get(id);
                const seqFile = join(paths.dir, 'sequential.json');
                const sequential = existsSync(seqFile) ? readJson(seqFile) : null;
                let integrity = null;
                if (existsSync(join(paths.dir, 'manifest.json')) && active === undefined) {
                    try {
                        integrity = verifyRunIntegrity(this.project, id);
                    }
                    catch (e) {
                        integrity = { ok: false, reportDiff: [e instanceof Error ? e.message : String(e)] };
                    }
                }
                json(res, 200, { plan, progress: active?.progress ?? progress, report, env, active: active !== undefined, logs: active?.logs ?? [], sequential, integrity });
                return;
            }
            if (method === 'GET' && seg[2] === 'report') {
                json(res, 200, existsSync(paths.report) ? readJson(paths.report) : rebuildReport(project, id));
                return;
            }
            if (method === 'POST' && seg[2] === 'report') {
                json(res, 200, rebuildReport(project, id));
                return;
            }
            if (seg[2] === 'annotations') {
                if (method === 'GET') {
                    json(res, 200, readAnnotations(paths));
                    return;
                }
                if (method === 'PUT') {
                    const body = await readBody(req);
                    const all = readAnnotations(paths);
                    const key = annotationKey(body.scenario, body.arm, Number(body.rep));
                    if (body.remove)
                        delete all[key];
                    else {
                        const a = { verdict: body.verdict ?? null, note: (body.note ?? '').slice(0, 2000), by: (body.by ?? 'reviewer').slice(0, 80), at: new Date().toISOString() };
                        all[key] = a;
                    }
                    writeAnnotations(paths, all);
                    const report = rebuildReport(project, id);
                    json(res, 200, { annotations: all, report });
                    return;
                }
            }
            if (method === 'GET' && seg[2] === 'ledgers' && seg.length === 3) {
                json(res, 200, applyAnnotations(readLedgers(paths), readAnnotations(paths)).map(l => ({ ...l, steps: l.steps.map(s => ({ ...s, calls: s.calls.map(c => c.name) })) })));
                return;
            }
            if (method === 'GET' && seg[2] === 'ledgers' && seg.length === 7) {
                const [scenario, arm, rep, what] = [seg[3], seg[4], Number(seg[5].replace(/^rep/, '')), seg[6]];
                const ledgerFile = join(paths.ledgers, scenario, arm, `rep${rep}.json`);
                if (!existsSync(ledgerFile)) {
                    json(res, 404, { error: 'ledger not found' });
                    return;
                }
                const ledger = readJson(ledgerFile);
                if (what === 'ledger') {
                    json(res, 200, ledger);
                    return;
                }
                if (what === 'trace') {
                    json(res, 200, readJsonl(join(paths.dir, ledger.traceFile)));
                    return;
                }
                if (what === 'events') {
                    json(res, 200, readJsonl(join(paths.dir, ledger.eventsFile)));
                    return;
                }
                if (what === 'atif') {
                    const plan = readPlan(paths);
                    const { scenarios } = collectScenarios(project, { scenarios: [scenario] });
                    const prompts = scenarios[0]?.prompts ?? [];
                    void plan;
                    json(res, 200, toAtif(ledger, readJsonl(join(paths.dir, ledger.traceFile)), prompts, evalInfraVersion()));
                    return;
                }
            }
            if (method === 'POST' && seg[2] === 'cancel') {
                json(res, 200, { cancelled: this.cancel(id) });
                return;
            }
            if (method === 'GET' && seg[2] === 'stream') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
                const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                const active = this.active.get(id);
                send('progress', active?.progress ?? (existsSync(paths.progress) ? readJson(paths.progress) : null));
                for (const line of active?.logs ?? [])
                    send('log', line);
                if (active === undefined) {
                    // A run started from the CLI has no in-process entry, so follow its progress file
                    // instead. Without this the page only updates because the browser keeps reconnecting.
                    const onDisk = existsSync(paths.progress) ? readJson(paths.progress) : null;
                    if (onDisk === null || onDisk.status !== 'running') {
                        send('done', { report: existsSync(paths.report) ? readJson(paths.report) : null });
                        res.end();
                        return;
                    }
                    let lastSeen = onDisk.updatedAt;
                    const follow = setInterval(() => {
                        let current = null;
                        try {
                            current = existsSync(paths.progress) ? readJson(paths.progress) : null;
                        }
                        catch {
                            return;
                        }
                        if (current === null)
                            return;
                        if (current.updatedAt !== lastSeen) {
                            lastSeen = current.updatedAt;
                            send('progress', current);
                            send('ledger', {});
                        }
                        if (current.status !== 'running') {
                            clearInterval(follow);
                            send('done', { report: existsSync(paths.report) ? readJson(paths.report) : null });
                            res.end();
                        }
                    }, 1000);
                    const followPing = setInterval(() => res.write(': ping\n\n'), 15_000);
                    req.on('close', () => { clearInterval(follow); clearInterval(followPing); });
                    return;
                }
                const listener = (event, data) => { send(event, data); if (event === 'done' || event === 'error')
                    res.end(); };
                active.listeners.add(listener);
                const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
                req.on('close', () => { active.listeners.delete(listener); clearInterval(ping); });
                return;
            }
        }
        void url;
        json(res, 404, { error: `no route ${method} ${path}` });
    }
}
/** Cross-run view: every scenario × arm over every run in the archive, so chronic failures and flakes stand out. */
export function buildHistory(runsRoot) {
    const runs = listRuns(runsRoot);
    const arms = new Set();
    const byScenario = new Map();
    for (const r of [...runs].reverse()) {
        const paths = runPaths(runsRoot, r.id);
        for (const l of readLedgers(paths)) {
            arms.add(l.arm);
            const entry = byScenario.get(l.scenario) ?? { cells: new Map(), runIds: new Set(), points: new Map() };
            entry.points.set(l.arm, [...(entry.points.get(l.arm) ?? []), { runId: r.id, usd: l.totals.usd, ok: l.verdict?.ok === true && l.error === undefined }]);
            const cell = entry.cells.get(l.arm) ?? { runs: 0, passes: 0, errors: 0, usd: 0, steps: 0 };
            cell.runs += 1;
            if (l.verdict?.ok && l.error === undefined)
                cell.passes += 1;
            if (l.error !== undefined)
                cell.errors += 1;
            cell.usd += l.totals.usd;
            cell.steps += l.totals.steps;
            entry.cells.set(l.arm, cell);
            entry.runIds.add(r.id);
            byScenario.set(l.scenario, entry);
        }
    }
    const allLedgers = [];
    for (const r of runs) {
        try {
            allLedgers.push(...readLedgers(runPaths(runsRoot, r.id)));
        }
        catch { /* unreadable */ }
    }
    const patterns = discoverPatterns(allLedgers);
    const chronic = { flaky: [], failing: [], saturated: [] };
    for (const [name, e] of byScenario) {
        const cells = [...e.cells.values()];
        const runs = cells.reduce((a, c) => a + c.runs, 0);
        const passes = cells.reduce((a, c) => a + c.passes, 0);
        if (runs < 4)
            continue;
        if (passes === 0)
            chronic.failing.push(name);
        else if (passes === runs)
            chronic.saturated.push(name);
        else if (cells.every(c => c.runs < 2 || (c.passes > 0 && c.passes < c.runs)))
            chronic.flaky.push(name);
    }
    return {
        chronic,
        patterns,
        arms: [...arms].sort(),
        scenarios: [...byScenario.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, e]) => ({
            name,
            cells: Object.fromEntries([...e.cells.entries()].map(([arm, c]) => [arm, { runs: c.runs, passes: c.passes, errors: c.errors, usdMean: c.runs ? c.usd / c.runs : 0, stepsMean: c.runs ? c.steps / c.runs : 0 }])),
            runIds: [...e.runIds],
            points: Object.fromEntries([...e.points.entries()]),
            signal: scenarioSignal([...e.points.entries()].map(([arm, pts]) => ({ arm, usd: pts.map(p => p.usd), passes: pts.map(p => (p.ok ? 1 : 0)) }))),
        })),
        runs: runs.map(r => ({ id: r.id, createdAt: r.createdAt, ...(r.label !== undefined ? { label: r.label } : {}), arms: r.arms })),
    };
}
export function createEvalApp(options) {
    return new EvalApp(options);
}
export async function startServer(options = {}) {
    const project = options.project ?? loadProject();
    const appOptions = { project };
    if (options.uiDir !== undefined)
        appOptions.uiDir = options.uiDir;
    const app = createEvalApp(appOptions);
    const server = createServer((req, res) => {
        void app.handle(req, res, '').then((handled) => { if (!handled) {
            res.writeHead(404);
            res.end();
        } });
    });
    const host = options.host ?? '127.0.0.1';
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4177, host, () => resolveListen());
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port ?? 4177;
    return { server, url: `http://${host}:${port}/`, app };
}
