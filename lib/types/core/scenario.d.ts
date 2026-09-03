import type { Scenario, Verdict } from './types.js';
export declare class ScenarioError extends Error {
}
/** Load one scenario directory and validate its shape. */
export declare function loadScenario(dir: string): Scenario;
export interface ScenarioFilter {
    /** Exact names or simple globs (`f*`, `*_amnesia`). */
    names?: string[];
    categories?: string[];
    tags?: string[];
}
/** List scenarios under a root directory (one level deep), optionally filtered. Invalid scenarios are reported, not thrown. */
export declare function listScenarios(root: string, filter?: ScenarioFilter): {
    scenarios: Scenario[];
    invalid: Array<{
        dir: string;
        error: string;
    }>;
};
export interface PythonRunOptions {
    timeoutMs?: number;
    python?: string;
}
/** Run a python snippet with the scenario directory on sys.path; returns stdout. */
export declare function runScenarioPython(scenario: Scenario, code: string, options?: PythonRunOptions): Promise<string>;
export declare function scenarioSetup(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void>;
export declare function scenarioVerify(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<Verdict>;
export declare function scenarioOracle(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void>;
/** Total bytes of a generated workspace (diagnostic for the selfcheck table). */
export declare function workspaceBytes(dir: string): number;
