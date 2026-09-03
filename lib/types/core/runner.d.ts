import type { ResolvedArm, RunLedger, RunPlan, Scenario } from './types.js';
import { type EventLike } from './ledger.js';
import type { PriceTable } from './pricing.js';
import { type Progress, type RunPaths } from './store.js';
export interface DriverTurnResult {
    events: EventLike[];
    sessionId: string | null;
}
export interface Driver {
    runTurn(prompt: string, options: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<DriverTurnResult>;
    close(): Promise<void>;
}
export interface DriverInput {
    arm: ResolvedArm;
    scenario: Scenario;
    workdir: string;
    evalHome: string;
    /** Overlay files in application order. */
    overlays: string[];
    env: Record<string, string>;
}
export type DriverFactory = (input: DriverInput) => Driver;
export declare class TurnTimeoutError extends Error {
    constructor(turn: number, ms: number);
}
export interface JobSpec {
    order: number;
    scenario: Scenario;
    arm: ResolvedArm;
    rep: number;
}
/**
 * Fixed interleaving: scenario → repeat → arm. Odd repeats run baseline first,
 * even repeats run the arms in reverse (team-draft style), so neither arm
 * systematically enjoys a warmer server cache or a quieter minute.
 */
export declare function planJobs(scenarios: Scenario[], arms: ResolvedArm[], repeats: number): JobSpec[];
/**
 * Ground truth must not be readable from inside the workspace. Scenario
 * generators that keep it under `<workdir>/.truth` get it moved out after
 * setup and back in before verify; the agent never sees it.
 */
export declare function stashTruth(workdir: string, stashRoot: string): (() => void) | undefined;
export interface RunDeps {
    driverFactory: DriverFactory;
    evalHome: string;
    paths: RunPaths;
    /** Environment passed to every runtime subprocess (API key included). */
    env: Record<string, string>;
    prices?: PriceTable;
    signal?: AbortSignal;
    keepWorkdirs?: boolean;
    onProgress?: (progress: Progress) => void;
    onLedger?: (ledger: RunLedger) => void;
    log?: (line: string) => void;
    /** Override the per-turn timeout for every scenario (ms). */
    turnTimeoutMs?: number;
    /** Skip jobs whose ledger already exists (resume). */
    resume?: boolean;
    workRoot?: string;
}
/** Base overlays every arm shares; the scenario decides whether network tools are allowed. */
export declare function writeBaseOverlays(armsDir: string): {
    noNetwork: string;
    network: string;
};
export declare function executeRun(plan: RunPlan, scenarios: Scenario[], arms: ResolvedArm[], deps: RunDeps): Promise<Progress>;
