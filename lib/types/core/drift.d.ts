/**
 * Behavioural drift check for the baseline arm: does this run's baseline use
 * tools the way the archived runs of the same arm and model did? A silently
 * substituted served model or a changed harness shows up here even when the
 * declared model id does not change (the idea behind AgentProv, 2609.00052,
 * reduced to tool-call frequency vectors and a permutation test).
 */
import type { RunLedger } from './types.js';
export interface DriftResult {
    scenarios: number;
    current: number;
    archive: number;
    /** Mean over scenarios of the L1 distance between mean tool-frequency vectors (0 = identical, 2 = disjoint). */
    distance: number;
    /** Permutation p-value of that distance under label exchange within scenario. */
    p: number;
    verdict: 'no-drift' | 'drift' | 'insufficient';
}
export declare function toolFrequency(l: RunLedger): Map<string, number>;
/**
 * Current vs archived ledgers of the same arm; both sides need at least two
 * trials on at least one common scenario. Alpha 0.05, B permutations.
 */
export declare function driftTest(current: RunLedger[], archive: RunLedger[], seed?: number, B?: number, alpha?: number): DriftResult;
