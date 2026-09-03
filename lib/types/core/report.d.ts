/**
 * Paired report over the ledgers of one run. Rules, in order:
 *   1. Correctness first: a scenario the baseline passes and the candidate
 *      fails is a regression, and a candidate with regressions fails the gate
 *      regardless of cost.
 *   2. Cost is compared only on repeat-pairs where BOTH arms passed, so a run
 *      that stopped early by failing never looks cheap.
 *   3. Aggregates carry a bootstrap interval over scenarios; an interval that
 *      covers zero reads "no difference".
 */
import { type BootstrapCI } from './stats.js';
import type { RunLedger, RunPlan } from './types.js';
export interface ArmScenarioStats {
    arm: string;
    scenario: string;
    n: number;
    passes: number;
    errors: number;
    passRate: number;
    passCI: {
        lo: number;
        hi: number;
    };
    usd: number[];
    usdMean: number;
    usdMedian: number;
    usdPeakMean: number;
    usdOffpeakMean: number;
    stepsMean: number;
    hitMean: number;
    missMean: number;
    outputMean: number;
    reasoningMean: number;
    wallMsMean: number;
    peakPromptMax: number;
    /** Ledger order per repeat (rep → verdict/cost) for the pairing. */
    byRep: Record<number, {
        ok: boolean;
        usd: number;
        error: boolean;
        steps: number;
        usdPeak: number;
        usdOffpeak: number;
    }>;
}
export type PairClass = 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete';
export interface PairedScenario {
    scenario: string;
    baseline: ArmScenarioStats;
    candidate: ArmScenarioStats;
    class: PairClass;
    /** Repeat pairs where both arms passed (cost comparison base). */
    costPairs: number;
    /** Mean of per-pair (candidate − baseline) USD over costPairs; null when no pair. */
    costDiffUsd: number | null;
    costDiffPct: number | null;
    /** Same difference re-priced at a fixed band, immune to peak/off-peak drift. */
    costDiffPeakUsd: number | null;
    costDiffOffpeakUsd: number | null;
    stepsDiff: number | null;
    /** Within-arm spread of the baseline cost on passed runs (max−min)/mean, a noise indicator. */
    baselineSpreadPct: number | null;
}
export interface ArmSummary {
    arm: string;
    runs: number;
    passes: number;
    /** Fraction of scenarios where every repeat passed (pass^k). */
    passAllK: number;
    /** Fraction of scenarios where at least one repeat passed (pass@k). */
    passAnyK: number;
    usd: number;
    /** Σ tokens (hit+miss+output) over all runs ÷ solved runs; null when nothing solved. */
    tokensPerSolved: number | null;
    usdPerSolved: number | null;
    cacheHitShare: number;
}
export interface CandidateReport {
    arm: string;
    summary: {
        baseline: ArmSummary;
        candidate: ArmSummary;
    };
    scenarios: PairedScenario[];
    regressions: string[];
    improvements: string[];
    bothFail: string[];
    incomplete: string[];
    /** Pass counts over all runs. */
    passBaseline: number;
    passCandidate: number;
    runsBaseline: number;
    runsCandidate: number;
    /** Discordant repeat pairs. */
    wins: number;
    losses: number;
    signTestP: number;
    /** Per-scenario cost differences (comparable scenarios only). */
    costCI: BootstrapCI;
    costPctCI: BootstrapCI;
    costPeakCI: BootstrapCI;
    costOffpeakCI: BootstrapCI;
    /** Sum of cost over comparable pairs, both arms. */
    comparableUsdBaseline: number;
    comparableUsdCandidate: number;
    gate: 'pass' | 'regressions' | 'incomplete';
    /** Cost reading: cheaper / more-expensive (CI excludes 0), equivalent (CI inside ±sesoi), or inconclusive. */
    costReading: 'cheaper' | 'more-expensive' | 'equivalent' | 'inconclusive' | 'none';
    verdict: string;
}
export interface ReportOptions {
    /** Smallest cost effect of interest in percent; a CI inside ±sesoi reads "equivalent" (default 10). */
    sesoiPct?: number;
    /** Comparable scenarios needed before any directional or equivalence claim (default 3); fewer reads "inconclusive". */
    minScenarios?: number;
}
export interface Report {
    schema: 'dsh-eval-report/1';
    runId: string;
    generatedAt: string;
    baseline: string;
    candidates: CandidateReport[];
    scenarios: string[];
    repeats: number;
    runs: number;
    errors: number;
    usd: number;
    /** Facts the reader must know before trusting a number. */
    notes: string[];
}
export declare function buildReport(plan: RunPlan, ledgers: RunLedger[], options?: ReportOptions): Report;
export declare function fmtUsd(v: number | null): string;
export declare function fmtPct(v: number | null): string;
export declare function renderMarkdown(report: Report): string;
