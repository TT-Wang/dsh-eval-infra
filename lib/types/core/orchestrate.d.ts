import { prepareArms, type ArmDiff } from './plan.js';
import type { Project } from './project.js';
import { type Report } from './report.js';
import { type RunDeps } from './runner.js';
import { type SelfcheckResult } from './selfcheck.js';
import { type Progress } from './store.js';
import type { RunLedger, RunPlan, Scenario } from './types.js';
export interface RunRequest {
    /** Arm file path, or a name resolved against the project's arms dir. */
    baseline: string;
    candidates: string[];
    scenarios?: string[];
    categories?: string[];
    tags?: string[];
    repeats?: number;
    concurrency?: number;
    label?: string;
    allowMulti?: boolean;
    skipSelfcheck?: boolean;
    keepWorkdirs?: boolean;
    turnTimeoutS?: number;
    /** Resume an existing run id (skips finished jobs). */
    resume?: string;
    /** A/A: run the baseline against an identical copy of itself to measure the noise floor. */
    aa?: boolean;
}
export interface LaunchHooks {
    log?: (line: string) => void;
    onProgress?: (p: Progress) => void;
    onLedger?: (l: RunLedger) => void;
    signal?: AbortSignal;
    /** Test seam: replace the SDK driver. */
    driverFactory?: RunDeps['driverFactory'];
    /** Test seam: replace the dsh CLI used to compose trees. */
    invoke?: Parameters<typeof prepareArms>[2]['invoke'];
}
export declare class LaunchError extends Error {
    readonly code: 'usage' | 'selfcheck' | 'arms' | 'env';
    constructor(message: string, code?: 'usage' | 'selfcheck' | 'arms' | 'env');
}
export interface Launched {
    id: string;
    plan: RunPlan;
    diffs: ArmDiff[];
    scenarios: Scenario[];
    selfcheck: SelfcheckResult[];
    /** Resolves with the final report when the run ends (or is cancelled). */
    done: Promise<{
        progress: Progress;
        report: Report;
    }>;
}
export declare function resolveArmPath(project: Project, ref: string): string;
export declare function collectScenarios(project: Project, request: Pick<RunRequest, 'scenarios' | 'categories' | 'tags'>): {
    scenarios: Scenario[];
    invalid: Array<{
        dir: string;
        error: string;
    }>;
};
/** Prepare everything, then start the run in the background; `done` resolves with the report. */
export declare function launchRun(project: Project, request: RunRequest, hooks?: LaunchHooks): Promise<Launched>;
/** Rebuild the report of a finished (or partial) run from its ledgers. */
export declare function rebuildReport(project: Project, id: string): Report;
