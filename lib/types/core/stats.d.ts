/**
 * Paired statistics for A/B runs. Small-sample honest: repeats pair by index
 * (baseline rep i ↔ candidate rep i, launched back to back), scenarios are the
 * resampling unit of the bootstrap, and "no difference" is the default verdict
 * whenever the interval covers zero.
 */
export declare function mean(xs: number[]): number;
export declare function median(xs: number[]): number;
export declare function quantile(xs: number[], q: number): number;
/** Deterministic PRNG (mulberry32) so reports are reproducible. */
export declare function rng(seed: number): () => number;
export interface BootstrapCI {
    mean: number;
    lo: number;
    hi: number;
    n: number;
    /** True when the interval excludes zero. */
    significant: boolean;
}
/**
 * Percentile bootstrap of the mean of `values` (one value per scenario, e.g. the
 * per-scenario paired cost difference). B resamples with replacement.
 */
export declare function bootstrapMean(values: number[], b?: number, seed?: number, alpha?: number): BootstrapCI;
/** Exact two-sided sign test p-value over discordant pairs (wins vs losses). */
export declare function signTest(wins: number, losses: number): number;
/** Wilson score interval for a pass rate. */
export declare function wilson(passes: number, n: number, z?: number): {
    lo: number;
    hi: number;
};
