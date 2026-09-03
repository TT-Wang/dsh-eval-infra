export interface ScenarioSignal {
    snr: number | null;
    withinCv: number | null;
    passSpread: number | null;
    trials: number;
}
export declare function scenarioSignal(arms: Array<{
    arm: string;
    usd: number[];
    passes: number[];
}>): ScenarioSignal;
/** Per-scenario signal over every finished run in the archive (optionally excluding one run). */
export declare function archiveSignal(runsRoot: string, exceptRunId?: string): Map<string, ScenarioSignal>;
/** Scenario names ordered by archive signal, strongest first; scenarios without a signal keep their archive order after the known ones. */
export declare function archiveSignalOrder(runsRoot: string, exceptRunId?: string): string[];
