/**
 * Scenario self-check: the verifier must reject an untouched workspace (the
 * "null arm") and must accept the oracle's answer. A scenario that fails
 * either check measures nothing and is refused by `run`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { scenarioOracle, scenarioSetup, scenarioVerify, workspaceBytes } from './scenario.js';
/** Snapshot of file → sha of a workspace (excluding .truth/.git/.spill). */
function snapshot(dir) {
    const out = new Map();
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name === '.truth' || e.name === '.git' || e.name === '.spill' || e.name === '__pycache__')
                continue;
            const p = join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.isFile())
                out.set(relative(dir, p), `${statSync(p).size}:${readFileSync(p).toString('base64').slice(0, 64)}`);
        }
    };
    if (existsSync(dir))
        walk(dir);
    return out;
}
export async function selfcheckScenario(scenario, workRoot = tmpdir(), options = {}) {
    const workdir = mkdtempSync(join(workRoot, `dsh-eval-selfcheck-${scenario.name}-`));
    const result = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' };
    try {
        await scenarioSetup(scenario, workdir);
        result.bytes = workspaceBytes(workdir);
        const blank = await scenarioVerify(scenario, workdir);
        result.blankPasses = blank.ok;
        if (scenario.hasOracle) {
            const before = snapshot(workdir);
            await scenarioOracle(scenario, workdir);
            const solved = await scenarioVerify(scenario, workdir);
            result.oraclePasses = solved.ok;
            result.detail = solved.ok ? '' : solved.detail.slice(0, 300);
            if (options.strict && solved.ok) {
                const after = snapshot(workdir);
                const ignore = new Set(scenario.meta.strict_ignore ?? []);
                const produced = [...after.keys()].filter(f => before.get(f) !== after.get(f) && !ignore.has(f)).sort().slice(0, options.maxMutations ?? 40);
                const weak = [];
                for (const rel of produced) {
                    const path = join(workdir, rel);
                    const original = readFileSync(path);
                    unlinkSync(path);
                    const deleted = await scenarioVerify(scenario, workdir);
                    // Blanking an intentionally empty file is a no-op, so only the deletion mutation applies there.
                    let blankedOk = false;
                    if (original.length > 0) {
                        writeFileSync(path, '');
                        blankedOk = (await scenarioVerify(scenario, workdir)).ok;
                    }
                    writeFileSync(path, original);
                    if (deleted.ok || blankedOk)
                        weak.push(`${rel}${deleted.ok ? ' (deletion unnoticed)' : ''}${blankedOk ? ' (blanking unnoticed)' : ''}`);
                }
                result.mutated = produced.length;
                result.nonDiscriminating = weak;
                if (weak.length > 0)
                    result.detail = `verifier ignores ${weak.length} of ${produced.length} oracle outputs: ${weak.join(', ')}`.slice(0, 400);
            }
        }
        result.ok = result.blankPasses === false && (result.oraclePasses ?? true) && (result.nonDiscriminating?.length ?? 0) === 0;
        if (result.blankPasses)
            result.detail = 'verifier accepts an untouched workspace' + (result.detail ? '; ' + result.detail : '');
    }
    catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    }
    finally {
        rmSync(workdir, { recursive: true, force: true });
    }
    return result;
}
export async function selfcheckAll(scenarios, concurrency = 4, options = {}) {
    const out = new Array(scenarios.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            const s = scenarios[i];
            if (s === undefined)
                return;
            out[i] = await selfcheckScenario(s, tmpdir(), options);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()));
    return out;
}
