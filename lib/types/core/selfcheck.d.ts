import { type TaskEnvironment } from './environment.js';
import type { Scenario } from './types.js';
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
}
export interface SelfcheckOptions {
    /** Mutation sweep: for every file the oracle created or changed, delete it (and separately blank it) and require the verifier to fail. */
    strict?: boolean;
    /** Cap on files mutated per scenario in strict mode (default 40). */
    maxMutations?: number;
    /** Container scenarios: opens the task's environment (started, untouched) for the null check and the oracle. */
    taskEnvironment?: (scenario: Scenario) => Promise<TaskEnvironment>;
}
export declare function selfcheckScenario(scenario: Scenario, workRoot?: string, options?: SelfcheckOptions): Promise<SelfcheckResult>;
export declare function selfcheckAll(scenarios: Scenario[], concurrency?: number, options?: SelfcheckOptions): Promise<SelfcheckResult[]>;
