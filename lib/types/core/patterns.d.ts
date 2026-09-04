/**
 * Pattern discovery across the run archive: recurring failure signatures and
 * behaviour regimes that no single report is looking for (the gap Braintrust's
 * "Patterns" fills for hosted products, and what AutoTraceGT, 2608.30391, does
 * with grounded theory). Signatures are derived from verifier reasons and from
 * behaviour counters, never from an LLM, so the result is deterministic and free.
 */
import type { RunLedger } from './types.js';
export interface Pattern {
    kind: 'failure' | 'behaviour';
    /** Stable, human-readable signature. */
    signature: string;
    count: number;
    scenarios: string[];
    arms: string[];
    runs: string[];
    firstSeen: string;
    lastSeen: string;
    example: string;
    /** Share of the trials this pattern covers, among the trials it could apply to. */
    share: number;
    /** Arms are hit unevenly: max minus min share across arms with at least three trials (0 when even). */
    armSkew: number;
}
/** Reduce a verifier reason to a signature: drop paths, numbers and quoted values so like failures collapse. */
export declare function failureSignature(reason: string): string;
/**
 * Patterns over the archive. `minCount` keeps one-off noise out; behaviour
 * regimes use the archive's own upper quartile as the threshold, so "many tool
 * errors" means many for this project, not for a fixed number.
 */
export declare function discoverPatterns(ledgers: RunLedger[], minCount?: number): Pattern[];
