/**
 * Scenario self-check: the verifier must reject an untouched workspace (the
 * "null arm") and must accept the oracle's answer. A scenario that fails
 * either check measures nothing and is refused by `run`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarioOracle, scenarioSetup, scenarioVerify, workspaceBytes } from './scenario.js';
export async function selfcheckScenario(scenario, workRoot = tmpdir()) {
    const workdir = mkdtempSync(join(workRoot, `dsh-eval-selfcheck-${scenario.name}-`));
    const result = { name: scenario.name, ok: false, blankPasses: null, oraclePasses: null, bytes: 0, turns: scenario.prompts.length, detail: '' };
    try {
        await scenarioSetup(scenario, workdir);
        result.bytes = workspaceBytes(workdir);
        const blank = await scenarioVerify(scenario, workdir);
        result.blankPasses = blank.ok;
        if (scenario.hasOracle) {
            await scenarioOracle(scenario, workdir);
            const solved = await scenarioVerify(scenario, workdir);
            result.oraclePasses = solved.ok;
            result.detail = solved.ok ? '' : solved.detail.slice(0, 300);
        }
        result.ok = result.blankPasses === false && (result.oraclePasses ?? true);
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
export async function selfcheckAll(scenarios, concurrency = 4) {
    const out = new Array(scenarios.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            const s = scenarios[i];
            if (s === undefined)
                return;
            out[i] = await selfcheckScenario(s);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()));
    return out;
}
