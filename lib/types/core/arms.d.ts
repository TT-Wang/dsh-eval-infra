import type { ArmSpec, ResolvedArm } from './types.js';
export declare class ArmError extends Error {
}
export declare const DEFAULT_PROFILE = "eval";
export declare const DEFAULT_PROVIDER = "deepseek-official";
export declare const DEFAULT_MODEL = "deepseek-v4-flash";
/** The model and effort a run uses; the same for every arm, since neither is a thing an arm may vary. */
export interface RunRoute {
    model?: string;
    effort?: string;
}
/**
 * Pin an arm to the run's route. The model and the reasoning effort belong to the
 * experiment, not to an arm: two arms that differ in either are not a comparison
 * of the component under test. A value the arm file declared is reported to the
 * log when the run changes it, so the override is never silent.
 */
export declare function applyRoute(spec: ArmSpec, route: RunRoute, log?: (line: string) => void): ArmSpec;
/** Parse an arm definition (YAML or JSON text). */
export declare function parseArm(text: string, sourcePath?: string): ArmSpec;
export declare function loadArmFile(path: string): ArmSpec;
/** Materialize an arm's overlay file under `outDir` and fill defaults. */
export declare function resolveArm(spec: ArmSpec, outDir: string, sourcePath?: string): ResolvedArm;
/** All overlays the runner passes for an arm, in order: patch files, then the inline overlay. */
export declare function armOverlays(arm: ResolvedArm): string[];
export interface DshInvoker {
    /** Run the dsh CLI with args and env, resolving stdout. */
    (args: string[], env: Record<string, string>): Promise<string>;
}
/** Default invoker: the `dsh` executable on PATH (or $DSH_BIN), with DSH_HOME pointed at the eval home. */
export declare const dshCli: DshInvoker;
/** The composed profile tree as dsh would mount it: `dsh --profile P --dump-config --patch …`. */
export declare function dumpComposedTree(evalHome: string, profile: string, overlays: string[], invoke?: DshInvoker): Promise<string>;
export type ComposedRows = Map<string, Record<string, unknown>>;
/** Parse a dump-config text into rows keyed by id (provenance comments stripped). */
export declare function parseComposedRows(text: string): ComposedRows;
export interface RowDiff {
    id: string;
    kind: 'added' | 'removed' | 'changed';
    /** Top-level fields that differ (`config`, `disabled`, `name`, …). */
    fields: string[];
    before?: unknown;
    after?: unknown;
}
/** Row-level diff of two composed trees. */
export declare function diffComposedRows(a: ComposedRows, b: ComposedRows): RowDiff[];
/** Differences between two arms outside the composed tree (route-level). */
export declare function diffRoute(a: ResolvedArm, b: ResolvedArm): string[];
export declare function sha256(text: string): string;
