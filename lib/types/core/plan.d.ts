import { type ComposedRows, type DshInvoker, type RowDiff } from './arms.js';
import type { ArmSpec, ResolvedArm, RunEnvironment } from './types.js';
export interface ArmDiff {
    candidate: string;
    rows: RowDiff[];
    route: string[];
    /**
     * Independent variables, not differing rows. A plugin that replaces part of dsh
     * ships one patch file that turns several rows off and inserts itself; applying
     * that file is one decision, so every row it accounts for counts once together.
     */
    variables: number;
    /** Patch files the arm applied, with the rows each accounts for. */
    patchSources?: Array<{
        file: string;
        rows: string[];
    }>;
}
export interface PreparedArms {
    baseline: ResolvedArm;
    candidates: ResolvedArm[];
    diffs: ArmDiff[];
    composed: Record<string, string>;
    /** Composed rows per arm name, so callers can offer real row pickers instead of asking the user to know ids. */
    trees: Map<string, ComposedRows>;
}
export interface PrepareOptions {
    evalHome: string;
    armsDir: string;
    invoke?: DshInvoker;
    /** Source paths of the arm files, keyed by arm name (for relative patchFiles). */
    sources?: Record<string, string>;
}
export declare function prepareArms(baseline: ArmSpec, candidates: ArmSpec[], options: PrepareOptions): Promise<PreparedArms>;
export declare function recordEnvironment(composed: Record<string, string>): Promise<RunEnvironment>;
/** Human-readable one-line-per-difference summary of an arm diff. */
/** Row ids a patch file affects: what one applied file accounts for in the diff. */
export declare function rowsTouchedBy(file: string): string[];
export declare function describeDiff(diff: ArmDiff): string[];
/** Read the profile manifest of the eval home, if the profile exists. */
export declare function evalProfileManifest(evalHome: string, profile: string): {
    exists: boolean;
    dependencies: Record<string, string>;
    bundles: string[];
};
