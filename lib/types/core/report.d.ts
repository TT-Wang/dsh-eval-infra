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
import type { RunLedger, RunPlan, NorthStar } from './types.js';
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
    /** Trials that failed the safety gate (wrote outside the scope, ran a destructive command, obeyed an injection). */
    unsafe: number;
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
/** suspected: the baseline passes at least half its repeats and the candidate fails at least half, but neither arm is consistent — screened, not called. */
export type PairClass = 'unsafe' | 'regression' | 'suspected' | 'improvement' | 'same' | 'both-fail' | 'incomplete' | 'unrun';
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
    /** For the first repeat where exactly one arm failed: the first tool call at which the two arms' tool sequences diverge. */
    divergence: {
        rep: number;
        call: number;
        baseline: string;
        candidate: string;
        failing: string;
    } | null;
    /** Repeat pairs where both arms passed (cost comparison base). */
    costPairs: number;
    /** Per-pair (candidate − baseline) Δ% values behind costDiffPct, for the hierarchical bootstrap. */
    costDiffPctPairs: number[];
    /** Scenario is in the sealed holdout pool (meta.holdout). */
    holdout: boolean;
    /** Safety-gate findings per arm, first evidence per arm for the row. */
    violations: {
        baseline: number;
        candidate: number;
        evidence: string | null;
    };
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
    /** Mean of per-pair (candidate − baseline) steps as a percent of the baseline's steps, over pairs where both passed; null when no pair. */
    stepsDiffPct: number | null;
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
/**
 * Reliability, read before anything else: pass^k per arm and the paired
 * comparison of "reliable on this scenario" between the arms. A component that
 * makes the agent pass sometimes instead of always has changed something,
 * whatever it did to the cost.
 */
export interface ReliabilityReading {
    /** Repeats per scenario per arm. */
    k: number;
    /** Scenarios with all k repeats on both arms: the denominator of everything below. */
    scenarios: number;
    /** pass^k per arm: share of those scenarios where every repeat passed. */
    baseline: number;
    candidate: number;
    /** Discordant scenarios: b = candidate reliable where the baseline is not, c = the reverse. */
    b: number;
    c: number;
    midP: number;
    pWin: number;
    inRope: number;
    /** Unbiased pass^j for j = 1..k per arm, mean over scenarios of C(passes, j) / C(n, j): how fast reliability decays with the bar. */
    decay: {
        baseline: number[];
        candidate: number[];
    };
    reading: 'more-reliable' | 'less-reliable' | 'same' | 'inconclusive';
}
/** The reading the run was registered for, candidate against baseline. */
export interface NorthStarReading {
    metric: NorthStar;
    /** better / worse are read from the candidate's side: cheaper, fewer steps, preferred by the judge. */
    reading: 'better' | 'worse' | 'same' | 'inconclusive' | 'none';
    /** Interval on the metric's own scale: percent for cost and steps; null for quality (the judge has its own counts). */
    ci: BootstrapCI | null;
    unit: '%' | 'wins';
    text: string;
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
    /** Consistent regressions: the baseline passed every repeat and the candidate failed every repeat. */
    regressions: string[];
    /** Suspected regressions: baseline majority-pass, candidate majority-fail, but at least one arm inconsistent across repeats; blocks the readings, is not called a regression until a rerun confirms it. */
    suspected: string[];
    /** Screening calibration of the gate: probability that at least one consistent regression would arise by chance given the pass rates observed on this run (pooled per scenario), null without complete pairs. */
    regressionChance: number | null;
    /** Trials of the two arms whose model has no price-table entry (usd recorded as 0): cost readings are withheld while any exist. */
    unpriced: number;
    /** Why the A/A floor did or did not apply: ok = applied; missing = none on file for this baseline; thin = fewer scenarios than the minimum; stale = the baseline drifted since it was measured. A direction is read only when it is ok. */
    floor: 'ok' | 'missing' | 'thin' | 'stale';
    /** Scenarios where the candidate failed the safety gate and the baseline did not. */
    unsafe: string[];
    /** Scenarios where both arms failed the safety gate: not a regression, but said. */
    bothUnsafe: string[];
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
    gate: 'pass' | 'unsafe' | 'regressions' | 'suspect' | 'incomplete';
    /** Cost reading: cheaper / more-expensive (CI excludes 0), equivalent (CI inside ±sesoi), or inconclusive. */
    costReading: 'cheaper' | 'more-expensive' | 'equivalent' | 'inconclusive' | 'none';
    /** Rerun validation of a failure (dsh-eval rerun), when one was made. */
    rerun?: {
        scenario: string;
        newRunId: string;
        reps: number;
        failedAgain: number;
        sameCall: number;
        verdict: string;
        original: {
            call: number;
            baseline: string;
            candidate: string;
            failing: string;
        } | null;
        fork?: {
            sourceRunId: string;
            forkAt: number;
            step: number;
        };
    };
    /** Per-scenario pass-rate difference (candidate − baseline, in percentage points) over scenarios: descriptive, not a planned claim (the reliability comparison is); in sequential mode the pass-difference confidence sequence. */
    passDiffCI: BootstrapCI;
    /** One-word grade combining correctness and cost: improvement / regression / tradeoff / tie / inconclusive. */
    grade: Grade;
    /** Scenarios whose repeats disagree within an arm. */
    flaky: string[];
    /** Minimum detectable cost effect (percent of baseline) for this design at the reading's alpha and 80% power, from the observed per-scenario spread; null with fewer than 3 comparable scenarios. */
    mdePct: number | null;
    /** Noise floor from the most recent A/A run on the same baseline, when one exists in the archive. */
    noiseFloor: NoiseFloor | null;
    /** Significance level of the planned claims: 0.05 / (2 × candidates) for the north-star and reliability directions; 0.05 / 3 in sequential mode (cost ratio, pass difference, reliability sequences). */
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
    /** CUPED-adjusted cost Δ% using each scenario's archived baseline cost as covariate; reported beside, never instead of, the raw interval. */
    cuped: {
        theta: number;
        varianceRemoved: number;
        ci: BootstrapCI;
        n: number;
    } | null;
    /** Read first, whatever the north star: pass^k per arm and the paired comparison of reliability. */
    reliability: ReliabilityReading;
    /** The reading this run was registered for (plan.northStar, default cost). */
    northStar: NorthStarReading;
    /** Blinded pairwise judge summary when `dsh-eval judge` has been run. */
    judge?: {
        model: string;
        models?: string[];
        panelAgreement?: number;
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
        sameFamilyAsArms?: boolean;
        longerWinsShare?: number | null;
        interJudgeKappa?: number | null;
        lengthBalancedWinRate?: number | null;
        equalLengthWinRate?: {
            rate: number;
            slope: number;
            n: number;
        } | null;
        effectiveJudges?: {
            k: number;
            rhoBar: number;
            nEff: number;
            basis: 'error' | 'vote';
        } | null;
        abstention?: {
            alpha: number;
            tau: number;
            calibratedOn: number;
            abstained: number;
            of: number;
        } | null;
        anchors?: {
            n: number;
            humanAgreement: number;
            stability: number | null;
            comparedWithPrevious: number;
            attribution: 'none' | 'judge';
        } | null;
    };
    /** Absolute judge grades with PPI++ rectification against human annotations, when `dsh-eval judge --mode absolute` has been run. */
    absolute?: {
        baseline: {
            estimate: number;
            se: number;
            lambda: number;
            n: number;
            N: number;
            judgeOnly: number;
        };
        candidate: {
            estimate: number;
            se: number;
            lambda: number;
            n: number;
            N: number;
            judgeOnly: number;
        };
        diff: number;
        diffSe: number;
        models: string[];
        calibration?: {
            labelled: number;
            tpr: number | null;
            tnr: number | null;
        };
    };
    verdict: string;
}
export interface NoiseFloor {
    runId: string;
    /** rerun: the same prompts re-run; perturbation: paraphrased prompts on repeats above 1 (wider by construction). */
    kind?: 'rerun' | 'perturbation';
    scenarios: number;
    /** Mean of |Δ%| across scenarios in the A/A run (descriptive; ≈0.8σ under pure noise, so never the veto band). */
    meanAbsPct: number;
    /** Interval of the A/A run's mean Δ% at the same alpha and estimator as a candidate's: the noise band a directional interval must stay clear of. */
    lo: number;
    hi: number;
    /** The same band on steps per solved task, for the efficiency north star. */
    steps?: {
        lo: number;
        hi: number;
        scenarios: number;
    };
}
export interface ReportOptions {
    /** Smallest cost effect of interest in percent; a CI inside ±sesoi reads "equivalent" (default 10). */
    sesoiPct?: number;
    /** Comparable scenarios needed before any directional or equivalence claim (default 5); fewer reads "inconclusive". */
    minScenarios?: number;
    /** Noise floors from A/A runs, keyed by baseline arm name (the caller looks them up in the archive). */
    noiseFloors?: Record<string, NoiseFloor>;
    /** Behavioural drift check of the baseline arm against the archive (see drift.ts). */
    drift?: import('./drift.js').DriftResult | null;
    /** Served-model probe verdict for this run's route (see probe.ts). */
    probe?: import('./probe.js').ProbeVerdict;
    /** Scenario names in the sealed holdout pool. */
    holdout?: Set<string>;
    /** Pre-experiment covariate per scenario: the baseline arm's mean cost from earlier runs in the archive (CUPED). */
    priorBaselineUsd?: Record<string, number>;
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
        reliability?: {
            lo: number;
            hi: number;
        } | null;
        scenarios: number;
    }>;
}
/** One word from the gate, the correctness improvements and the north-star reading; the same rule wherever a grade is made. */
export declare function gradeOf(gate: CandidateReport['gate'], improvements: number, ns: NorthStarReading['reading']): Grade;
/**
 * The quality reading, made once the blinded judge has run: the candidate's wins
 * against its losses over the decided pairs, read with the same rules as the
 * other north stars (five decided pairs, mid-p at alpha, equivalence by posterior).
 */
export declare function qualityReading(c: CandidateReport, wins: number, losses: number, ties: number, minScenarios?: number): NorthStarReading;
/** Noise floor of an A/A run: the same statistics the candidate report uses, applied to two copies of one arm. */
export declare function noiseFloorOf(plan: RunPlan, ledgers: RunLedger[], alpha?: number): NoiseFloor | null;
/** The alpha every planned claim is read at: two claims per candidate (north-star direction, reliability direction) share 5%; sequential mode runs three sequences. */
export declare function readingAlpha(plan: {
    candidates: Array<{
        name: string;
    }>;
    sequential?: boolean;
}): number;
/** Does the interval [lo, hi] reach into the band [bandLo, bandHi]? Two intervals of the same estimator; overlap means the difference is not distinguishable from the baseline's own noise. */
export declare function withinNoise(ci: {
    lo: number;
    hi: number;
}, band: {
    lo: number;
    hi: number;
}): boolean;
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
