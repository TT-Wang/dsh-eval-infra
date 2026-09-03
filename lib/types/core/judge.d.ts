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
    /** Preference after both orders: 'candidate', 'baseline', or 'tie' (including inconsistent answers). */
    preference: 'candidate' | 'baseline' | 'tie';
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
}
export interface JudgeReport {
    schema: 'dsh-eval-judge/1';
    runId: string;
    candidate: string;
    baseline: string;
    model: string;
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
export interface JudgeInput {
    plan: RunPlan;
    candidate: string;
    ledgers: RunLedger[];
    /** Scenario name → judge spec. */
    specs: Record<string, JudgeSpec>;
    /** Artifact directory for a trial. */
    artifactDir: (scenario: string, arm: string, rep: number) => string;
    chat: ChatCall;
    model: string;
    seed?: number;
    /** Human annotations keyed "scenario|arm|rep" → verdict boolean, for agreement. */
    annotations?: Record<string, {
        verdict: boolean | null;
    }>;
    log?: (line: string) => void;
}
export declare function judgeRun(input: JudgeInput): Promise<JudgeReport>;
export { mean as _mean };
