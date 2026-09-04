import type { Project } from './project.js';
/** Files a scenario directory may contain; anything else is refused rather than written. */
export declare const SCENARIO_FILES: readonly ["meta.json", "prompts.json", "setup.py", "verify.py", "oracle.py", "prompts.variants.json"];
export interface IntakeResult {
    name: string;
    dir: string;
    written: string[];
    /** The selfcheck the runner would demand before using this scenario. */
    selfcheck: {
        ok: boolean;
        blankFails: boolean;
        oraclePasses: boolean;
        detail: string;
    };
}
export declare function addScenario(project: Project, name: string, files: Record<string, string>): Promise<IntakeResult>;
/** A commented starting point, so a first scenario is an edit rather than a blank page. */
export declare function scenarioTemplate(name: string): Record<string, string>;
