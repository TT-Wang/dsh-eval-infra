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
/**
 * Hierarchical percentile bootstrap: resample scenarios with replacement, then
 * within each chosen scenario resample its repeat-pair values with replacement,
 * and take the mean of per-scenario means. Captures both between-scenario and
 * within-scenario (repeat) variability; with one value per scenario it reduces
 * to the scenario bootstrap.
 */
export declare function bootstrapHierarchical(groups: number[][], b?: number, seed?: number, alpha?: number): BootstrapCI;
/**
 * Interval for a mean over few units: Student-t for n < 10 (a percentile
 * bootstrap of three or four values has almost no distinct resamples and
 * understates the width), percentile bootstrap otherwise. Both are read at the
 * same alpha so multiplicity adjustment applies uniformly.
 */
export declare function smallSampleCI(values: number[], b?: number, seed?: number, alpha?: number): BootstrapCI;
/** Inverse normal CDF (Acklam's rational approximation), good to ~1e-9. */
export declare function normalQuantile(p: number): number;
/** Exact two-sided sign test p-value over discordant pairs (wins vs losses). */
export declare function signTest(wins: number, losses: number): number;
/** Wilson score interval for a pass rate. */
export declare function wilson(passes: number, n: number, z?: number): {
    lo: number;
    hi: number;
};
export declare function stddev(xs: number[]): number;
/** Two-sided 97.5% Student t quantile for small degrees of freedom (table up to 30, then normal). */
export declare function tCritical(df: number): number;
/**
 * Intraclass correlation of repeat values within scenarios (one-way ANOVA
 * estimator) and the design effect 1 + (k − 1)ρ that inflates the variance of
 * a mean over n·k correlated trials relative to n·k independent ones.
 */
export declare function icc(groups: number[][]): {
    rho: number;
    designEffect: number;
    k: number;
};
/**
 * McNemar on discordant pairs: b = candidate passed where baseline failed,
 * c = baseline passed where candidate failed. Returns the exact two-sided p,
 * the mid-p (recommended by Fagerland et al. 2013), the posterior probability
 * that the candidate wins a discordant pair (Beta(b+1, c+1)), and the share of
 * that posterior inside a region of practical equivalence around 1/2.
 */
export declare function mcnemar(b: number, c: number, ropeHalfWidth?: number): {
    b: number;
    c: number;
    exactP: number;
    midP: number;
    pWin: number;
    inRope: number;
};
/**
 * Resolution of a paired comparison: N* is the number of scenarios at which a
 * paired t-test would reach 80% power at α = 0.05 for the observed mean
 * difference and spread; q = n / N*. q ≥ 1 means the design could resolve
 * an effect of the observed size; q ≪ 1 means "inconclusive" is about the
 * design, not the effect.
 */
export declare function resolution(values: number[]): {
    nStar: number | null;
    q: number | null;
};
/** Normalized Levenshtein similarity of two sequences (1 = identical). */
export declare function sequenceSimilarity(a: string[], b: string[]): number;
/**
 * Asymptotic confidence sequence (Waudby-Smith, Arbour, Sinha, Kennedy, Ramdas
 * 2021, Theorem 2.2) for the running mean of a sequence: valid uniformly over
 * time, so a run may be stopped the moment 0 leaves the interval without
 * inflating the error rate. ρ tunes where the sequence is tightest; the
 * paper's choice for a planned first look at m units is used.
 */
export declare function asympCS(values: number[], alpha?: number, plannedN?: number): {
    mean: number;
    lo: number;
    hi: number;
    t: number;
};
/**
 * Betting confidence sequence for the mean of [0, 1] outcomes (Waudby-Smith &
 * Ramdas 2020, predictable-plug-in bets). Used on x = (d + 1) / 2 where d is
 * the per-scenario pass-rate difference in [−1, 1]; the null "no difference"
 * is the point 1/2. Returns the set of means not rejected, on a grid.
 */
export declare function bettingCS(xs: number[], alpha?: number): {
    lo: number;
    hi: number;
    t: number;
};
