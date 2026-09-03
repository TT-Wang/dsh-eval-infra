import type { RunLedger, RunPlan } from './types.js';
import { mean } from './stats.js';
export interface JudgeSpec {
    /** What "better" means for this scenario, in plain language. */
    rubric: string;
    /** Workspace files captured at the end of each trial and shown to the judge. */
    artifacts: string[];
    /** Optional cap per artifact in characters (default 12000). */
    maxChars?: number;
}
export interface JudgeConfig {
    model: string;
    baseUrl?: string;
    apiKey: string;
    /** Random seed for the presentation order. */
    seed?: number;
    temperature?: number;
}
export interface Judgment {
    scenario: string;
    rep: number;
    /** Panel preference: majority of decided votes when it is a strict majority of the panel; otherwise 'tie'. */
    preference: 'candidate' | 'baseline' | 'tie';
    /** One vote per judge model, each already order-swapped (inconsistent orders → tie). */
    votes: Array<{
        model: string;
        preference: 'candidate' | 'baseline' | 'tie';
        answers: [string, string];
        reasons: [string, string];
        usd: number;
        confidence?: number;
    }>;
    /** Abstention score in [0, 1]: mean self-reported confidence of order-consistent votes, halved when the panel is not unanimous. */
    score?: number;
    /** True when the conformal abstention rule withholds this judgment (score below the calibrated threshold). */
    abstained?: boolean;
    /** The two raw answers as seen by the judge ('first' | 'second' | 'tie'), for the two presentation orders. */
    answers: [string, string];
    /** Which artifact was shown first in the first call ('baseline' | 'candidate'). */
    firstShown: 'baseline' | 'candidate';
    reasons: [string, string];
    usd: number;
    model: string;
    artifactSha: {
        baseline: string;
        candidate: string;
    };
    lengths?: {
        baseline: number;
        candidate: number;
    };
}
export interface JudgeReport {
    schema: 'dsh-eval-judge/1';
    runId: string;
    candidate: string;
    baseline: string;
    /** Panel models (one entry = single judge). */
    models: string[];
    /** Kept for readers of older reports; the first panel model. */
    model: string;
    /** Share of pairs on which every judge agreed (1 for a single judge). */
    panelAgreement: number;
    generatedAt: string;
    judgments: Judgment[];
    wins: number;
    losses: number;
    ties: number;
    /** Share of pairs where the two presentation orders disagreed (position sensitivity of the judge on this data). */
    inconsistentShare: number;
    midP: number;
    pWin: number;
    usd: number;
    /** Agreement with human annotations on the same trials, when any exist. */
    humanAgreement: {
        n: number;
        agree: number;
        kappa: number | null;
    } | null;
    /** Share of decided pairs in which the preferred artifact set was the longer one (verbosity bias check; 0.5 ≈ none). */
    longerWinsShare: number | null;
    /** Cohen's κ between the first two panel members' votes (error correlation of the panel), when a panel was used. */
    interJudgeKappa: number | null;
    /** Candidate win share among decided pairs, averaged over the "candidate longer" and "candidate shorter" strata (length-balanced, AlpacaEval-LC style); null without both strata. */
    lengthBalancedWinRate: number | null;
    /** Conformal abstention (SCOPE-style): threshold calibrated on human-labelled pairs so the error rate among kept judgments is at most alpha; null without labels. */
    abstention: {
        alpha: number;
        tau: number;
        calibratedOn: number;
        abstained: number;
        of: number;
    } | null;
    /** Anchor set: archived human-labelled trials re-graded by this panel; agreement with the humans and stability vs the previous judge run on the same anchors. */
    anchors: {
        n: number;
        humanAgreement: number;
        stability: number | null;
        comparedWithPrevious: number;
        attribution: 'none' | 'judge';
    } | null;
}
/** Read the captured artifacts of one trial into a single text block (deterministic order). */
export declare function readArtifacts(dir: string, maxChars: number): {
    text: string;
    sha: string;
};
export interface ChatCall {
    (messages: Array<{
        role: 'system' | 'user';
        content: string;
    }>): Promise<{
        text: string;
        usage: {
            hit: number;
            miss: number;
            output: number;
        };
    }>;
}
/** DeepSeek chat completions over HTTPS (OpenAI-compatible); no dsh runtime needed. */
export declare function deepseekChat(config: JudgeConfig): ChatCall;
/**
 * Conformal risk control for abstention (Angelopoulos et al. 2022; SCOPE 2602.13110 applies it to judges):
 * given labelled pairs with an abstention score and whether the judge was right, return the smallest
 * score threshold whose kept-set error, with the finite-sample correction (n·R̂ + 1)/(n + 1), is ≤ alpha.
 * The empirical risk is made monotone in the threshold by taking the running maximum as the threshold
 * decreases (a kept set can only be riskier than the smaller kept sets above it), so the guarantee is
 * conservative. Returns null when no threshold satisfies the bound.
 */
export declare function conformalAbstentionThreshold(labelled: Array<{
    score: number;
    correct: boolean;
}>, alpha: number): number | null;
export declare function abstentionScore(votes: Array<{
    preference: string;
    answers: [string, string];
    confidence?: number;
}>): number;
export interface JudgeModel {
    model: string;
    chat: ChatCall;
}
export interface JudgeInput {
    plan: RunPlan;
    candidate: string;
    ledgers: RunLedger[];
    /** Scenario name → judge spec. */
    specs: Record<string, JudgeSpec>;
    /** Artifact directory for a trial. */
    artifactDir: (scenario: string, arm: string, rep: number) => string;
    /** The judge panel: one or more models; each is asked in both orders. */
    judges: JudgeModel[];
    seed?: number;
    /** Human annotations keyed "scenario|arm|rep" → verdict boolean, for agreement. */
    annotations?: Record<string, {
        verdict: boolean | null;
    }>;
    /** Error level for conformal abstention (default 0.1). */
    abstentionAlpha?: number;
    /** Archived human-labelled trials to re-grade as anchors (judge drift check). */
    anchors?: Array<{
        key: string;
        rubric: string;
        artifactDir: string;
        humanPass: boolean;
        previousJudgePass?: boolean;
    }>;
    log?: (line: string) => void;
}
/** Grade anchor trials in absolute mode; returns per-anchor judge answers for storage and the summary. */
export declare function gradeAnchors(anchors: NonNullable<JudgeInput['anchors']>, judges: JudgeModel[], log?: (line: string) => void): Promise<{
    answers: Record<string, boolean>;
    summary: JudgeReport['anchors'];
    usd: number;
}>;
export declare function judgeRun(input: JudgeInput): Promise<JudgeReport & {
    anchorAnswers?: Record<string, boolean>;
}>;
export interface AbsoluteGrade {
    scenario: string;
    arm: string;
    rep: number;
    pass: boolean;
    score: number;
    reason: string;
    model: string;
    usd: number;
}
/** PPI++ (Angelopoulos, Duchi, Zrnic 2023) estimate of a pass rate from judge grades f on all trials and human labels Y on a labelled subset. */
export declare function ppiRate(all: number[], labelled: Array<{
    f: number;
    y: number;
}>): {
    estimate: number;
    se: number;
    lambda: number;
    n: number;
    N: number;
    judgeOnly: number;
};
export interface AbsoluteReport {
    schema: 'dsh-eval-judge-absolute/1';
    runId: string;
    models: string[];
    generatedAt: string;
    grades: AbsoluteGrade[];
    /** Per arm: judge-only pass rate, PPI++ estimate with SE using human annotations as labels, and how many labels were used. */
    arms: Record<string, {
        estimate: number;
        se: number;
        lambda: number;
        n: number;
        N: number;
        judgeOnly: number;
    }>;
    /** Judge vs human labels over all labelled trials: true-positive and true-negative rates, reported separately because agreement alone misleads. */
    calibration: {
        labelled: number;
        tpr: number | null;
        tnr: number | null;
    };
    usd: number;
}
export interface AbsoluteInput {
    plan: RunPlan;
    ledgers: RunLedger[];
    specs: Record<string, JudgeSpec>;
    artifactDir: (scenario: string, arm: string, rep: number) => string;
    judges: JudgeModel[];
    annotations?: Record<string, {
        verdict: boolean | null;
    }>;
    log?: (line: string) => void;
}
/** Grade every trial of every judged scenario on its own (no pairing), then rectify per-arm pass rates with human labels via PPI++. */
export declare function absoluteJudge(input: AbsoluteInput): Promise<AbsoluteReport>;
export { mean as _mean };
