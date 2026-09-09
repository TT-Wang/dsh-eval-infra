import { type TaskEnvironment } from './environment.js';
import type { Scenario } from './types.js';
/**
 * Why a scenario did not pass its check, as a code an agent can act on. The
 * whole point of the intake loop is that the target is machine-checkable: write
 * a verifier, run the check, read these, fix, repeat. `detail` inside a finding
 * is the verifier's own words, which are the scenario author's to read — not a
 * sentence this tool composed.
 */
export type SelfcheckFinding = 
/** The verifier accepted a workspace the agent never touched: it would pass every trial. */
{
    code: 'blank.accepted';
    detail: string;
}
/** The verifier rejected the reference answer: it asks for something the oracle does not produce. */
 | {
    code: 'oracle.rejected';
    detail: string;
}
/** Strict mode: files the oracle produced whose deletion or blanking the verifier does not notice. */
 | {
    code: 'strict.blind_to_output';
    files: string[];
    mutated: number;
}
/** The scenario's own code raised: setup, verify or the oracle. */
 | {
    code: 'scenario.threw';
    phase: 'setup' | 'verify' | 'oracle' | 'environment';
    message: string;
};
export interface SelfcheckResult {
    name: string;
    ok: boolean;
    /** The verifier accepted an untouched workspace — the scenario is broken. */
    blankPasses: boolean | null;
    /** The verifier accepted the oracle; null when the scenario has no oracle. */
    oraclePasses: boolean | null;
    bytes: number;
    turns: number;
    detail: string;
    error?: string;
    /** Strict mode: files the oracle produced whose removal or blanking the verifier does NOT notice. */
    nonDiscriminating?: string[];
    /** Strict mode: number of oracle-produced files checked. */
    mutated?: number;
    /** Machine-readable reasons this scenario did not pass, empty when it did. */
    findings?: SelfcheckFinding[];
}
export interface SelfcheckOptions {
    /** Mutation sweep: for every file the oracle created or changed, delete it (and separately blank it) and require the verifier to fail. */
    strict?: boolean;
    /** Cap on files mutated per scenario in strict mode (default 40). */
    maxMutations?: number;
    /** Container scenarios: opens the task's environment (started, untouched) for the null check and the oracle. */
    taskEnvironment?: (scenario: Scenario) => Promise<TaskEnvironment>;
    /** Cap on a container scenario's verifier, in seconds, over the scenario's own (a benchmark's tests can hang on a third-party host). */
    verifierTimeoutS?: number;
}
export declare function selfcheckScenario(scenario: Scenario, workRoot?: string, options?: SelfcheckOptions): Promise<SelfcheckResult>;
export declare function selfcheckAll(scenarios: Scenario[], concurrency?: number, options?: SelfcheckOptions): Promise<SelfcheckResult[]>;
