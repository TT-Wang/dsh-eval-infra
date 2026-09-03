import { prepareArms, type ArmDiff } from './plan.js';
import type { Project } from './project.js';
import { type NoiseFloor, type Report } from './report.js';
import { type RunDeps } from './runner.js';
import { type SelfcheckResult } from './selfcheck.js';
import { runPaths, type Progress } from './store.js';
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
    /** Budget cap in USD; the run stops scheduling trials once exceeded. */
    maxUsd?: number;
    /** Include sealed holdout scenarios (meta.holdout) in the run. */
    includeHoldout?: boolean;
    /** Anytime-valid sequential mode: shuffled scenario order, early stop once the paired comparison is decided. */
    sequential?: boolean;
    /** Where each trial's dsh runtime runs: on the host under dsh's own sandbox (default) or inside a Docker container. */
    sandbox?: 'host' | 'docker';
    /** Route the runtime's provider calls through the independent usage meter (default on for real runs). */
    meter?: boolean;
    /** Fault injection through the meter: share of provider requests answered with 429 or a stall. */
    faultRate?: number;
    faultSeed?: number;
    /** Container image for docker mode (default node:22-bookworm-slim). */
    dockerImage?: string;
    /** Seed for the sequential shuffle (default 42). */
    seed?: number;
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
export declare function collectScenarios(project: Project, request: Pick<RunRequest, 'scenarios' | 'categories' | 'tags' | 'includeHoldout'>): {
    scenarios: Scenario[];
    invalid: Array<{
        dir: string;
        error: string;
    }>;
};
/** Prepare everything, then start the run in the background; `done` resolves with the report. */
export declare function launchRun(project: Project, request: RunRequest, hooks?: LaunchHooks): Promise<Launched>;
/** Per-scenario mean cost of an arm across earlier runs (excluding `exceptRunId`) — the CUPED covariate. */
export declare function archiveBaselineCosts(project: Project, arm: string, exceptRunId?: string): Record<string, number>;
/** The most recent A/A noise floor per baseline arm found in the archive (excluding `exceptRunId`). */
export declare function archiveNoiseFloors(project: Project, exceptRunId?: string): Record<string, NoiseFloor>;
export interface JudgeOptions {
    /** Judge models; several form a panel. Each may be `model` or `model@baseUrl` with the key from `<NAME>_API_KEY` env, or a name from project config `judges`. */
    models?: string[];
    candidate?: string;
    seed?: number;
    /** pairwise (default), absolute (per-trial grades + PPI++), or both. */
    mode?: 'pairwise' | 'absolute' | 'both';
    log?: (line: string) => void;
    /** Test seam: replace the chat calls (one per model). */
    chats?: Record<string, import('./judge.js').ChatCall>;
    /** Allow judges from the same model family as the arms (refused by default: self-preference and preference leakage). */
    allowSameFamily?: boolean;
}
/** Model family from a model id or a configured `family` (deepseek-* → deepseek, gpt-* → openai, claude-* → anthropic, gemini-* → google). */
export declare function modelFamily(model: string, configured?: string): string;
/**
 * Run the blinded pairwise judge over every scenario of a finished run that
 * declares `meta.judge`. Writes `judge-<candidate>.json` next to the report and
 * returns it. The judge model defaults to deepseek-v4-pro so it differs from
 * the usual v4-flash arms (same family: a stated limitation).
 */
export declare function runJudge(project: Project, id: string, options?: JudgeOptions): Promise<import('./judge.js').JudgeReport[]>;
/** Absolute judge report stored with a run, if any. */
export declare function readAbsoluteJudge(paths: ReturnType<typeof runPaths>): import('./judge.js').AbsoluteReport | null;
/** Final confidence sequences of a sequential run, as report options (empty when the run was not sequential). */
export declare function sequencesOf(paths: ReturnType<typeof runPaths>): {
    sequences?: Record<string, {
        cost: {
            mean: number;
            lo: number;
            hi: number;
        } | null;
        pass: {
            lo: number;
            hi: number;
        } | null;
        scenarios: number;
    }>;
};
/** Judge reports stored with a run, keyed by candidate. */
export declare function readJudgeReports(paths: ReturnType<typeof runPaths>): Record<string, import('./judge.js').JudgeReport>;
/**
 * Re-derive every ledger of a run from its stored events (the ledger schema
 * evolves; the events are the durable record). Keeps verdict, timing, route
 * and error facts from the existing ledger; recomputes usage, prices, steps,
 * behaviour, observations and invariants. Then rebuilds the report.
 */
export declare function rebuildLedgers(project: Project, id: string): Promise<number>;
/** Rebuild the report of a finished (or partial) run from its ledgers. */
export declare function rebuildReport(project: Project, id: string): Report;
