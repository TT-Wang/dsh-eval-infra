/**
 * What has been checked, and against which bytes. `selfcheck` runs on demand and
 * decides whether a scenario may be used at all; this records the answer beside
 * the project so `status` can tell "checked", "never checked" and "checked, but
 * the scenario has changed since" apart. It is an index of past checks, never a
 * substitute for one: every run re-runs selfcheck itself before it starts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeJsonAtomic } from './store.js';
const EMPTY = { schema: 'dsh-eval-checks/1', selfcheck: {} };
function checksPath(project) {
    return join(project.evalDir, 'checks.json');
}
/** sha256 over every file in a scenario directory, path and content, in a fixed order. */
export function scenarioSha(dir) {
    const files = [];
    const walk = (at) => {
        for (const name of readdirSync(at).sort()) {
            const p = join(at, name);
            if (statSync(p).isDirectory())
                walk(p);
            else
                files.push(p);
        }
    };
    if (!existsSync(dir))
        return 'missing';
    walk(dir);
    const h = createHash('sha256');
    for (const p of files.sort())
        h.update(relative(dir, p) + '\0' + createHash('sha256').update(readFileSync(p)).digest('hex') + '\n');
    return h.digest('hex');
}
export function readChecks(project) {
    const file = checksPath(project);
    if (!existsSync(file))
        return { ...EMPTY, selfcheck: {} };
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return { schema: 'dsh-eval-checks/1', selfcheck: parsed.selfcheck ?? {} };
    }
    catch {
        return { ...EMPTY, selfcheck: {} };
    }
}
/** Record the outcome of a selfcheck pass. `dirs` maps scenario name to its directory. */
export function recordSelfcheck(project, results, dirs, options = {}) {
    const checks = readChecks(project);
    const at = new Date().toISOString();
    for (const r of results) {
        const dir = dirs[r.name];
        if (dir === undefined)
            continue;
        const entry = {
            sha: scenarioSha(dir),
            ok: r.ok,
            blankPasses: r.blankPasses,
            oraclePasses: r.oraclePasses,
            checkedAt: at,
            ...(options.strict && r.mutated !== undefined ? { strict: { mutated: r.mutated, nonDiscriminating: r.nonDiscriminating ?? [] } } : {}),
            ...(r.ok ? {} : { detail: r.detail.slice(0, 400) }),
            ...(r.findings && r.findings.length > 0 ? { findings: r.findings } : {}),
        };
        checks.selfcheck[r.name] = entry;
    }
    writeJsonAtomic(checksPath(project), checks);
}
/**
 * The state of one scenario's selfcheck: never run, run and failed, run and
 * passed, or run against different bytes than the ones on disk now.
 */
export function selfcheckStateOf(entry, dir) {
    if (entry === undefined)
        return 'never';
    if (entry.sha !== scenarioSha(dir))
        return 'stale';
    return entry.ok ? 'ok' : 'failing';
}
