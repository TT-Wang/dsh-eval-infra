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
    /** Extra rows for the shared base overlay (container mode adds its rows here). */
    baseOverlayRows?: Array<Record<string, unknown>>;
    /** Stop scheduling new trials once the run's spend exceeds this many USD (finished trials are kept). */
    maxUsd?: number;
    /** Independent usage meter: one local proxy per trial between the runtime and the provider; the ledger is reconciled against it. */
    meter?: {
        upstream: string;
        exposed?: boolean;
        /** Host name the runtime uses to reach the meter (container mode: host.docker.internal). */
        hostFromContainer?: string;
        faults?: {
            rate: number;
            seed?: number;
            kinds?: Array<'429' | 'stall'>;
            stallMs?: number;
        };
        /** Reconciliation tolerance in percent of the metered total (default 1%). */
        tolerancePct?: number;
    };
    /**
     * Anytime-valid sequential mode: scenarios run in a seeded random order; after
     * each scenario's repeats finish on all arms, the stop rule is evaluated on the
     * per-scenario paired differences and the run ends early once decided.
     */
    sequential?: {
        alpha?: number;
        seed?: number;
        minScenarios?: number;
        sesoiPct?: number;
        onDecision?: (d: SequentialDecision) => void; /** Explicit scenario order (e.g. by archive signal) instead of the seeded shuffle. */
        order?: string[];
    };
    /** Prompt perturbation: repeats above 1 run a seeded paraphrase variant of the prompts, the same variant for every arm of that repeat. */
    perturb?: {
        seed: number;
    };
    /** Per-trial spend cap in USD, checked on observed usage after every turn (scenario meta.max_usd_per_trial wins when lower). */
    maxUsdPerTrial?: number;
    /** Replay recorded provider responses (from another run's meter recordings) instead of calling the provider; forkAt = recorded responses to serve before going live. */
    replay?: {
        runId: string;
        recordingFor: (scenario: string, arm: string, rep: number) => string | null;
        forkAt?: number;
        liveAllowed: boolean;
    };
}
/** Deterministic variant choice for (scenario, rep): rep 1 always runs the original prompts. */
export declare function pickVariant(seed: number, scenario: string, rep: number, variants: number): number;
export interface SequentialDecision {
    /** Scenarios completed on every arm so far. */
    scenarios: number;
    /** Cost Δ% asymptotic confidence sequence (screening only). */
    cost: {
        mean: number;
        lo: number;
        hi: number;
    } | null;
    /** Hedged betting (finite-sample) confidence sequence on the per-scenario cost ratio candidate/baseline, winsorized at 2; this one decides. */
    ratio: {
        mean: number;
        lo: number;
        hi: number;
    } | null;
    /** Pass-difference confidence sequence over per-scenario x = (Δpass + 1) / 2; 0.5 is "no difference". */
    pass: {
        lo: number;
        hi: number;
    } | null;
    decided: boolean;
    reason: string;
}
/** Base overlays every arm shares; the scenario decides whether network tools are allowed. `extraRows` (e.g. the container rows) apply to both. */
export declare function writeBaseOverlays(armsDir: string, extraRows?: Array<Record<string, unknown>>): {
    noNetwork: string;
    network: string;
};
/** Seeded Fisher–Yates shuffle (mulberry32). */
export declare function shuffled<T>(items: T[], seed: number): T[];
export declare function executeRun(plan: RunPlan, scenarios: Scenario[], arms: ResolvedArm[], deps: RunDeps): Promise<Progress>;
