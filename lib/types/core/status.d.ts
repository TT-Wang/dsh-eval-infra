import type { Project } from './project.js';
import type { NorthStar, RunIndexEntry } from './types.js';
export type PhaseCode = 'profile' | 'arms' | 'one_variable' | 'scenarios' | 'selfcheck' | 'floor' | 'run';
/**
 * A run publishes progress on every turn, so a progress file this old belongs to
 * a process that is gone: the run reads `abandoned`, not `running`. Without this
 * a crashed run tells every later caller to keep polling it, forever.
 */
export declare const ABANDONED_AFTER_MS: number;
/** A reason, as a code the caller renders. `gloss` is for logs, never for the user. */
export interface Reason {
    code: string;
    gloss?: string;
    [param: string]: unknown;
}
export interface Phase {
    code: PhaseCode;
    state: string;
    [detail: string]: unknown;
}
export interface ReadingAvailability {
    /** Nothing determinable blocks this reading. Not a promise that the data will support it. */
    attainable: boolean;
    missing?: Reason[];
}
export interface NextStep {
    reason: Reason;
    tool: string;
    args?: Record<string, unknown>;
}
export interface ProjectStatus {
    schema: 'dsh-eval-status/1';
    project: {
        root: string;
        profile: string;
        scenarioRoot: string;
    };
    phases: Phase[];
    /** The first phase that is not `ok`, or null when the project is ready to run. */
    blocked: PhaseCode | null;
    readings: Record<string, ReadingAvailability>;
    runs: Array<RunIndexEntry & {
        sealed?: boolean;
        gate?: string;
    }>;
    next: NextStep;
}
export interface StatusOptions {
    /** Most recent runs to describe (default 5). */
    runs?: number;
}
/** Arm files in the project: `<name>.yml`, excluding patch files and the composed records a run writes. */
export declare function armNames(project: Project): string[];
export declare function projectStatus(project: Project, options?: StatusOptions): Promise<ProjectStatus>;
/** The north stars a caller may register, for a tool listing them. */
export declare const NORTH_STAR_READINGS: ReadonlyArray<`northStar.${NorthStar}`>;
