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
}
export declare function selfcheckScenario(scenario: Scenario, workRoot?: string): Promise<SelfcheckResult>;
export declare function selfcheckAll(scenarios: Scenario[], concurrency?: number): Promise<SelfcheckResult[]>;
