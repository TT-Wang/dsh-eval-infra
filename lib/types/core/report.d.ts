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
        overridden?: boolean;
    }>;
}
export type PairClass = 'regression' | 'improvement' | 'same' | 'both-fail' | 'incomplete' | 'unrun';
export interface PairedScenario {
    scenario: string;
    baseline: ArmScenarioStats;
    candidate: ArmScenarioStats;
    class: PairClass;
    /** Repeats disagree within at least one arm — the scenario is noisy for this setup. */
    flaky: boolean;
    /** Distinct failure reasons per arm (verdict detail, truncated), most frequent first. */
    failures: {
        baseline: Array<{
            reason: string;
            n: number;
        }>;
        candidate: Array<{
            reason: string;
            n: number;
        }>;
    };
    /** Tool-sequence similarity (normalized Levenshtein over tool names): within each arm across repeats, and between the arms' paired repeats. 1 = identical. */
    tss: {
        baseline: number | null;
        candidate: number | null;
        between: number | null;
    };
    /** Repeat pairs where both arms passed (cost comparison base). */
    costPairs: number;
    /** Per-pair (candidate − baseline) Δ% values behind costDiffPct, for the hierarchical bootstrap. */
    costDiffPctPairs: number[];
    /** Scenario is in the sealed holdout pool (meta.holdout). */
    holdout: boolean;
    /** Mean of per-pair (candidate − baseline) USD over costPairs; null when no pair. */
    costDiffUsd: number | null;
    costDiffPct: number | null;
    /** Mean behaviour signature per arm (tool errors, repeated calls, no-action steps, observation chars, compactions). */
    behaviour: {
        baseline: BehaviourMean;
        candidate: BehaviourMean;
    };
    /** Same difference re-priced at a fixed band, immune to peak/off-peak drift. */
    costDiffPeakUsd: number | null;
    costDiffOffpeakUsd: number | null;
    stepsDiff: number | null;
    /** Within-arm spread of the baseline cost on passed runs (max−min)/mean, a noise indicator. */
    baselineSpreadPct: number | null;
}
export interface BehaviourMean {
    toolErrors: number;
    repeatedCalls: number;
    noActionSteps: number;
    observationChars: number;
    compactions: number;
}
export type Grade = 'improvement' | 'regression' | 'tradeoff' | 'tie' | 'inconclusive';
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
    /** Per-scenario pass-rate difference (candidate − baseline, in percentage points) bootstrapped over scenarios. */
    passDiffCI: BootstrapCI;
    /** One-word grade combining correctness and cost: improvement / regression / tradeoff / tie / inconclusive. */
    grade: Grade;
    /** Scenarios whose repeats disagree within an arm. */
    flaky: string[];
    /** Minimum detectable cost effect (percent of baseline) for this design at 95% confidence and 80% power, from the observed per-scenario spread; null with fewer than 3 comparable scenarios. */
    mdePct: number | null;
    /** Noise floor from the most recent A/A run on the same baseline, when one exists in the archive. */
    noiseFloor: NoiseFloor | null;
    /** Significance level used for the intervals after Bonferroni adjustment across candidates (0.05 / candidates). */
    alpha: number;
    /** Intraclass correlation of repeat cost differences within scenarios and the design effect 1 + (k−1)ρ. */
    icc: {
        rho: number;
        designEffect: number;
        k: number;
    };
    /** Paired pass/fail: discordant counts, McNemar exact and mid-p, posterior P(candidate wins a discordant pair), posterior mass inside ±0.1 of 1/2. */
    paired: {
        b: number;
        c: number;
        exactP: number;
        midP: number;
        pWin: number;
        inRope: number;
    };
    /** Resolution of the cost comparison: N* scenarios needed for 80% power at the observed effect, and q = n / N*. */
    resolution: {
        nStar: number | null;
        q: number | null;
    };
    /** Dev vs sealed-holdout pass-rate difference (candidate − baseline), when holdout scenarios exist. */
    holdoutGap: {
        dev: number;
        holdout: number;
        devScenarios: number;
        holdoutScenarios: number;
    } | null;
    /** Blinded pairwise judge summary when `dsh-eval judge` has been run. */
    judge?: {
        model: string;
        wins: number;
        losses: number;
        ties: number;
        midP: number;
        pWin: number;
        inconsistentShare: number;
        usd: number;
        humanAgreement: {
            n: number;
            agree: number;
            kappa: number | null;
        } | null;
    };
    verdict: string;
}
export interface NoiseFloor {
    runId: string;
    scenarios: number;
    /** Mean of |Δ%| across scenarios in the A/A run. */
    meanAbsPct: number;
    /** 95% bootstrap interval of Δ% in the A/A run. */
    lo: number;
    hi: number;
}
export interface ReportOptions {
    /** Smallest cost effect of interest in percent; a CI inside ±sesoi reads "equivalent" (default 10). */
    sesoiPct?: number;
    /** Comparable scenarios needed before any directional or equivalence claim (default 3); fewer reads "inconclusive". */
    minScenarios?: number;
    /** Noise floors from A/A runs, keyed by baseline arm name (the caller looks them up in the archive). */
    noiseFloors?: Record<string, NoiseFloor>;
    /** Scenario names in the sealed holdout pool. */
    holdout?: Set<string>;
    /** Final anytime-valid sequences of a sequential run, keyed by candidate; when present they replace the fixed-sample cost interval. */
    sequences?: Record<string, {
        cost: {
            mean: number;
            lo: number;
            hi: number;
        } | null;
        pass: {
            lo: number;
            hi: number;
        } | null;
        scenarios: number;
    }>;
}
/** Noise floor of an A/A run: the same statistics the candidate report uses, applied to two copies of one arm. */
export declare function noiseFloorOf(plan: RunPlan, ledgers: RunLedger[]): NoiseFloor | null;
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
