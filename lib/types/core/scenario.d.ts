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
    /** Include sealed holdout scenarios (meta.holdout); default false. */
    includeHoldout?: boolean;
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
    /** Extra environment for the verifier process (a container scenario's host-side verifier gets the container's id this way). */
    env?: Record<string, string>;
}
/**
 * The environment scenario code (setup, verify, oracle) runs with: what a Python process needs to find its
 * interpreter, packages, temp dir, proxy and Docker (host-side benchmark verifiers drive `docker`), and the
 * DSH_EVAL_* variables the runner sets — never the host's secrets. Anything whose name says key, token,
 * secret or password is dropped whatever else it matches.
 */
export declare function scenarioProcessEnv(base?: Record<string, string | undefined>): Record<string, string>;
/** Run a python snippet with the scenario directory on sys.path; returns stdout. */
export declare function runScenarioPython(scenario: Scenario, code: string, options?: PythonRunOptions): Promise<string>;
export declare function scenarioSetup(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void>;
export declare function scenarioVerify(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<Verdict>;
export declare function scenarioOracle(scenario: Scenario, workdir: string, options?: PythonRunOptions): Promise<void>;
/** Total bytes of a generated workspace (diagnostic for the selfcheck table). */
export declare function workspaceBytes(dir: string): number;
