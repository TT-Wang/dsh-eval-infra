import type { Project } from './project.js';
import type { SelfcheckFinding, SelfcheckResult } from './selfcheck.js';
export interface SelfcheckEntry {
    /** sha256 over the scenario directory's contents; what makes `stale` meaningful. */
    sha: string;
    ok: boolean;
    blankPasses: boolean | null;
    oraclePasses: boolean | null;
    /** Present when the check ran with `--strict`. */
    strict?: {
        mutated: number;
        nonDiscriminating: string[];
    };
    checkedAt: string;
    /** The verifier's own words on failure, kept for a caller that wants to show them. */
    detail?: string;
    /** Why it did not pass, as codes: a caller can act on the last failure without running the check again. */
    findings?: SelfcheckFinding[];
}
export interface ChecksFile {
    schema: 'dsh-eval-checks/1';
    selfcheck: Record<string, SelfcheckEntry>;
}
export type SelfcheckState = 'ok' | 'failing' | 'stale' | 'never';
/** sha256 over every file in a scenario directory, path and content, in a fixed order. */
export declare function scenarioSha(dir: string): string;
export declare function readChecks(project: Project): ChecksFile;
/** Record the outcome of a selfcheck pass. `dirs` maps scenario name to its directory. */
export declare function recordSelfcheck(project: Project, results: SelfcheckResult[], dirs: Record<string, string>, options?: {
    strict?: boolean;
}): void;
/**
 * The state of one scenario's selfcheck: never run, run and failed, run and
 * passed, or run against different bytes than the ones on disk now.
 */
export declare function selfcheckStateOf(entry: SelfcheckEntry | undefined, dir: string): SelfcheckState;
