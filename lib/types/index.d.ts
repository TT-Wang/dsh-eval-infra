/**
 * dsh-eval-infra as a dsh host plugin: mounts the eval API + web UI under a
 * prefix on the host web server (when one is composed) and registers the
 * `/eval` slash command (when the command registry is composed). Neither
 * service is required: the plugin waits for whichever appears. The CLI
 * (`dsh-eval`) and the engine (`./core/*`) work without any dsh host process.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-eval-infra";
export interface Config {
    /** Project directory holding `.dsh-eval/` and `bench/` (default: the host process cwd). */
    projectRoot?: string;
    /** URL prefix on the host web server (default `/eval`). */
    basePath?: string;
}
export { createEvalApp, startServer } from './server/index.js';
export { launchRun, rebuildReport, type RunRequest } from './core/orchestrate.js';
export { buildReport, renderMarkdown, type Report } from './core/report.js';
export { loadProject, type Project } from './core/project.js';
export { listScenarios, loadScenario } from './core/scenario.js';
export { selfcheckAll, selfcheckScenario } from './core/selfcheck.js';
export { executeRun, planJobs, type Driver, type DriverFactory } from './core/runner.js';
export { buildLedger } from './core/ledger.js';
export { toAtif } from './core/atif.js';
export { DEEPSEEK_PRICES, bandAt, priceUsage } from './core/pricing.js';
export * from './core/types.js';
export declare function apply(ctx: Context, config?: Config): void;
export default apply;
