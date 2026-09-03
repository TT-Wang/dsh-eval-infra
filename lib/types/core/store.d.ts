import type { RunEnvironment, RunIndexEntry, RunLedger, RunPlan } from './types.js';
export interface RunPaths {
    root: string;
    dir: string;
    plan: string;
    env: string;
    progress: string;
    report: string;
    reportMd: string;
    arms: string;
    ledgers: string;
}
export declare function runPaths(root: string, runId: string): RunPaths;
export declare function newRunId(now?: Date): string;
export declare function writeJsonAtomic(path: string, value: unknown): void;
export declare function readJson<T>(path: string): T;
export declare function ledgerPath(paths: RunPaths, scenario: string, arm: string, rep: number): string;
export declare function writeLedger(paths: RunPaths, ledger: RunLedger): string;
/** Every ledger of a run, in file order. */
export declare function readLedgers(paths: RunPaths): RunLedger[];
export interface Progress {
    status: RunIndexEntry['status'];
    total: number;
    completed: number;
    failed: number;
    usd: number;
    startedAt: string;
    updatedAt: string;
    /** Jobs currently executing. */
    active: Array<{
        scenario: string;
        arm: string;
        rep: number;
        turn: number;
        turns: number;
        startedAt: string;
    }>;
    /** Last few finished jobs. */
    recent: Array<{
        scenario: string;
        arm: string;
        rep: number;
        ok: boolean | null;
        usd: number;
        wallMs: number;
        error?: string;
    }>;
    error?: string;
}
export declare function listRuns(root: string): RunIndexEntry[];
/** A human override of one trial's verdict (or a note without override). */
export interface Annotation {
    /** `true` = mark pass, `false` = mark fail, `null` = note only. */
    verdict: boolean | null;
    note: string;
    by: string;
    at: string;
}
export type Annotations = Record<string, Annotation>;
export declare function annotationKey(scenario: string, arm: string, rep: number): string;
export declare function readAnnotations(paths: RunPaths): Annotations;
export declare function writeAnnotations(paths: RunPaths, annotations: Annotations): void;
/** Apply overrides to ledgers (a copy); the ledger keeps the machine verdict under `machineVerdict`. */
export declare function applyAnnotations(ledgers: RunLedger[], annotations: Annotations): RunLedger[];
export declare function readPlan(paths: RunPaths): RunPlan;
export declare function readEnvironment(paths: RunPaths): RunEnvironment | undefined;
