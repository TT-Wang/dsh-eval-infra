import { type DshInvoker, type RowDiff } from './arms.js';
import type { ArmSpec, ResolvedArm, RunEnvironment } from './types.js';
export interface ArmDiff {
    candidate: string;
    rows: RowDiff[];
    route: string[];
    /** Number of independent variables: differing rows plus differing route fields. */
    variables: number;
}
export interface PreparedArms {
    baseline: ResolvedArm;
    candidates: ResolvedArm[];
    diffs: ArmDiff[];
    composed: Record<string, string>;
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
export declare function describeDiff(diff: ArmDiff): string[];
/** Read the profile manifest of the eval home, if the profile exists. */
export declare function evalProfileManifest(evalHome: string, profile: string): {
    exists: boolean;
    dependencies: Record<string, string>;
    bundles: string[];
};
