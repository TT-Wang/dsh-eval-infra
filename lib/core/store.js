/**
 * On-disk layout of a run:
 *   <root>/runs/<runId>/plan.json, env.json, progress.json, report.json, report.md
 *   <root>/runs/<runId>/arms/<arm>.patch.yml
 *   <root>/runs/<runId>/ledgers/<scenario>/<arm>/rep<N>.json (+ .events.jsonl, .trace.jsonl)
 * Everything the report shows is recomputed from the ledgers, so a run
 * directory is self-contained and can be shared or re-reported.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function runPaths(root, runId) {
    const dir = join(resolve(root), 'runs', runId);
    return {
        root: resolve(root),
        dir,
        plan: join(dir, 'plan.json'),
        env: join(dir, 'env.json'),
        progress: join(dir, 'progress.json'),
        report: join(dir, 'report.json'),
        reportMd: join(dir, 'report.md'),
        arms: join(dir, 'arms'),
        ledgers: join(dir, 'ledgers'),
    };
}
export function newRunId(now = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-${rand}`;
}
export function writeJsonAtomic(path, value) {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, path);
}
export function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
export function ledgerPath(paths, scenario, arm, rep) {
    return join(paths.ledgers, scenario, arm, `rep${rep}.json`);
}
export function writeLedger(paths, ledger) {
    const path = ledgerPath(paths, ledger.scenario, ledger.arm, ledger.rep);
    writeJsonAtomic(path, ledger);
    return path;
}
/** Every ledger of a run, in file order. */
export function readLedgers(paths) {
    const out = [];
    if (!existsSync(paths.ledgers))
        return out;
    for (const scenario of readdirSync(paths.ledgers).sort()) {
        const sdir = join(paths.ledgers, scenario);
        if (!statSync(sdir).isDirectory())
            continue;
        for (const arm of readdirSync(sdir).sort()) {
            const adir = join(sdir, arm);
            if (!statSync(adir).isDirectory())
                continue;
            for (const f of readdirSync(adir).sort()) {
                if (!/^rep\d+\.json$/.test(f))
                    continue;
                try {
                    out.push(readJson(join(adir, f)));
                }
                catch { /* partial write in progress */ }
            }
        }
    }
    return out;
}
export function listRuns(root) {
    const runsDir = join(resolve(root), 'runs');
    if (!existsSync(runsDir))
        return [];
    const out = [];
    for (const id of readdirSync(runsDir).sort().reverse()) {
        const paths = runPaths(root, id);
        if (!existsSync(paths.plan))
            continue;
        try {
            const plan = readJson(paths.plan);
            const progress = existsSync(paths.progress) ? readJson(paths.progress) : undefined;
            const entry = {
                id,
                createdAt: plan.createdAt,
                status: progress?.status ?? 'failed',
                arms: [plan.baseline.name, ...plan.candidates.map(c => c.name)],
                scenarios: plan.scenarios.length,
                repeats: plan.repeats,
                completed: progress?.completed ?? 0,
                total: progress?.total ?? plan.scenarios.length * plan.repeats * (1 + plan.candidates.length),
                usd: progress?.usd ?? 0,
            };
            if (plan.label !== undefined)
                entry.label = plan.label;
            out.push(entry);
        }
        catch { /* unreadable run */ }
    }
    return out;
}
export function readPlan(paths) {
    return readJson(paths.plan);
}
export function readEnvironment(paths) {
    return existsSync(paths.env) ? readJson(paths.env) : undefined;
}
