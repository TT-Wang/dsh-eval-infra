import type { ChatCall } from './judge.js';
/** Short, low-token prompts whose answer distribution is characteristic of a model build. */
export declare const PROBES: string[];
export interface ProbeSample {
    probe: number;
    answer: string;
}
export interface ProbeReference {
    schema: 'dsh-eval-probe/1';
    model: string;
    baseUrl: string;
    enrolledAt: string;
    samples: ProbeSample[];
    usd: number;
}
export interface ProbeVerdict {
    model: string;
    distance: number;
    p: number;
    probes: number;
    samplesPerSide: number;
    verdict: 'matches' | 'differs' | 'no-reference';
    enrolledAt?: string;
    comparedAt: string;
    usd: number;
}
/** Mean over probes of the total-variation distance between the two answer distributions. */
export declare function probeDistance(a: ProbeSample[], b: ProbeSample[]): number;
/** Permutation test of the probe distance under exchangeability of the two sides within each probe. */
export declare function probePermutationTest(a: ProbeSample[], b: ProbeSample[], B?: number, seed?: number): {
    distance: number;
    p: number;
};
/** Send the battery: `samples` answers per probe, at temperature 1 so the distribution is informative. */
export declare function collectProbes(chat: ChatCall, samples?: number, log?: (line: string) => void): Promise<{
    samples: ProbeSample[];
    usd: number;
}>;
export declare function referenceKey(model: string, baseUrl: string): string;
/** Compare fresh probes with an enrolled reference; alpha 0.01 keeps false alarms rare on a check that blocks verdicts. */
export declare function compareWithReference(fresh: ProbeSample[], reference: ProbeReference | null, model: string, usd: number, alpha?: number): ProbeVerdict;
