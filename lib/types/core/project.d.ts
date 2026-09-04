import { type ModelPrice, type PriceTable } from './pricing.js';
export interface ProjectConfig {
    profile: string;
    scenarioRoot?: string;
    armsDir?: string;
    dshBin?: string;
    repeats: number;
    concurrency: number;
    /** Extra scenario roots (pools) searched after the project's own. */
    pools?: string[];
    /** Directories scanned for local dsh plugin checkouts (defaults to ~/code and ~/src). */
    pluginRoots?: string[];
    /** Judge models available to `dsh-eval judge`: OpenAI-compatible endpoints from any provider family. */
    judges?: Array<{
        name?: string;
        model: string;
        baseUrl?: string;
        apiKeyEnv?: string;
        family?: string;
    }>;
    /** Extra or overriding prices (USD per million tokens, peak/off-peak) merged over the built-in DeepSeek table. */
    prices?: {
        asOf?: string;
        models: Record<string, ModelPrice>;
        peak?: PriceTable['peak'];
    };
}
/** The project's price table: the built-in DeepSeek table with the config's models merged over it (undefined when the config adds nothing). */
export declare function projectPrices(config: ProjectConfig): PriceTable | undefined;
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
    /** Where a scenario the user adds is written: always the project's own library. */
    ownScenarioRoot: string;
}
/**
 * Bundles a profile activates for every arm. A plugin that declares `dsh.bundle`
 * is added here the moment it is installed, which puts it in both arms of every
 * comparison and makes it impossible to measure. `setProfileBundles` is how an
 * eval project takes it back out while keeping the package installed, so an arm
 * can still reference it.
 */
export declare function profileBundles(evalHome: string, profile: string): string[];
export declare function setProfileBundles(evalHome: string, profile: string, bundles: string[]): void;
export declare const DEFAULT_CONFIG: ProjectConfig;
/** The scenario library shipped with this package. */
export declare function bundledScenarioRoot(): string;
export declare function loadProject(root?: string): Project;
export declare function saveProjectConfig(project: Project): void;
/** Files of the eval profile inside the isolated home (same shape dsh's own initProfile writes). */
export declare function ensureEvalProfile(home: string, profile: string): string;
export declare const STARTER_BASELINE = "# Baseline arm: the stock dsh composition (dsh-base + sdk-app) with no changes.\nname: baseline\ndescription: stock dsh, nothing added\n# model: deepseek-v4-flash\n# effort: high\n";
export declare function starterCandidate(pluginName: string | undefined): string;
/**
 * A scratch directory for composing arms only to read the result back — the row
 * picker, the arm diff, the preflight check. These share no state and the UI
 * fires several at once, so each needs its own directory: `resolveArm` writes
 * `<arm>.patch.yml` under a fixed name, and a second call truncating that file
 * while `dsh --dump-config` reads it makes the first one fail. The run path is
 * unaffected — a run already composes into its own archived directory.
 */
export declare function withPreviewArms<T>(project: Project, use: (armsDir: string) => Promise<T>): Promise<T>;
