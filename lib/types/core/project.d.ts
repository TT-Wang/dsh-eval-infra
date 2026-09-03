export interface ProjectConfig {
    profile: string;
    scenarioRoot?: string;
    armsDir?: string;
    dshBin?: string;
    repeats: number;
    concurrency: number;
    /** Extra scenario roots (pools) searched after the project's own. */
    pools?: string[];
}
export interface Project {
    root: string;
    evalDir: string;
    home: string;
    runsRoot: string;
    config: ProjectConfig;
    configPath: string;
    armsDir: string;
    scenarioRoot: string;
    bundledScenarioRoot: string;
}
export declare const DEFAULT_CONFIG: ProjectConfig;
/** The scenario library shipped with this package. */
export declare function bundledScenarioRoot(): string;
export declare function loadProject(root?: string): Project;
export declare function saveProjectConfig(project: Project): void;
/** Files of the eval profile inside the isolated home (same shape dsh's own initProfile writes). */
export declare function ensureEvalProfile(home: string, profile: string): string;
export declare const STARTER_BASELINE = "# Baseline arm: the stock dsh composition (dsh-base + sdk-app) with no changes.\nname: baseline\ndescription: stock dsh, nothing added\n# model: deepseek-v4-flash\n# effort: high\n";
export declare function starterCandidate(pluginName: string | undefined): string;
