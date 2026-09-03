import { createEvalApp } from './server/index.js';
import { loadProject } from './core/project.js';
import { listRuns, readJson, runPaths } from './core/store.js';
import { existsSync } from 'node:fs';
export const name = 'dsh-eval-infra';
export { createEvalApp, startServer } from './server/index.js';
export { launchRun, rebuildReport } from './core/orchestrate.js';
export { buildReport, renderMarkdown } from './core/report.js';
export { loadProject } from './core/project.js';
export { listScenarios, loadScenario } from './core/scenario.js';
export { selfcheckAll, selfcheckScenario } from './core/selfcheck.js';
export { executeRun, planJobs } from './core/runner.js';
export { buildLedger } from './core/ledger.js';
export { toAtif } from './core/atif.js';
export { DEEPSEEK_PRICES, bandAt, priceUsage } from './core/pricing.js';
export * from './core/types.js';
export function apply(ctx, config = {}) {
    const project = loadProject(config.projectRoot ?? process.cwd());
    const basePath = (config.basePath ?? '/eval').replace(/\/+$/, '') || '/eval';
    const app = createEvalApp({ project });
    ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => scoped.webServer.register({
            kind: 'prefix',
            path: basePath,
            handler: async (req, res) => {
                const handled = await app.handle(req, res, basePath);
                if (!handled) {
                    res.writeHead(404);
                    res.end();
                }
            },
        }), 'dsh-eval-infra: web routes');
    });
    ctx.inject(['commands'], (scoped) => {
        scoped.effect(() => scoped.commands.register({
            name: 'eval',
            description: 'dsh-eval: list A/B runs or show a run summary (open the UI at <host>/eval)',
            input: { hint: '[runs | <runId>]' },
            handler: ({ rawInput }) => {
                const arg = rawInput.trim();
                if (arg === '' || arg === 'runs') {
                    const runs = listRuns(project.runsRoot).slice(0, 12);
                    if (runs.length === 0)
                        return { kind: 'success', text: `No runs yet under ${project.runsRoot}/runs. Start one with: dsh-eval run --baseline baseline --arm candidate` };
                    const lines = runs.map(r => `${r.id}  ${r.status}  ${r.arms.join(' vs ')}  ${r.completed}/${r.total}  $${r.usd.toFixed(3)}${r.label ? '  ' + r.label : ''}`);
                    return { kind: 'success', text: `Runs (newest first), UI at ${basePath}/:\n${lines.join('\n')}` };
                }
                const paths = runPaths(project.runsRoot, arg);
                if (!existsSync(paths.report))
                    return { kind: 'error', text: `no report for run ${arg}` };
                const report = readJson(paths.report);
                return { kind: 'success', text: report.candidates.map(c => `${c.arm} vs ${report.baseline}: ${c.verdict}`).join('\n') };
            },
        }), 'dsh-eval-infra: /eval command');
    });
}
export default apply;
