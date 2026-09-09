/**
 * What a run's evidence licenses anyone to say, and what it does not — the shape
 * `report.read` answers in (docs/agent-interface.md).
 *
 * The reading order this tool is built on exists so a person does not overclaim.
 * Once an agent stands between the numbers and the person, that order has to
 * survive being retold: `{reading: "inconclusive"}` becoming "about the same" is
 * the exact failure the whole project is against, and a paraphrase is where it
 * happens. So the evidence is split in two here. `licensed` is what may be said,
 * as codes with parameters for the caller to render in whatever language the
 * person is speaking. `withheld` is what may not, each with the reason, the
 * measurement that exists anyway, and the call that would settle it.
 *
 * A withheld claim still carries its `observed` numbers. Hiding them would be its
 * own dishonesty: the measurement is real, it simply does not support a
 * direction, and that is what the caller must say.
 */
import type { CandidateReport, ReadingBlocker, Report } from './report.js';
export interface Claim {
    code: string;
    [param: string]: unknown;
}
export interface WithheldClaim {
    /** The claim that may not be made: `northStar.direction`, `reliability.direction`. */
    claim: string;
    /** Why, in the order the rules applied. The first is the one that decided it. */
    reason: ReadingBlocker;
    also?: ReadingBlocker[];
    /** The measurement that exists regardless. Real, and not a direction. */
    observed?: Record<string, unknown>;
    next?: {
        tool: string;
        args?: Record<string, unknown>;
    };
}
export interface CandidateClaims {
    arm: string;
    gate: CandidateReport['gate'];
    grade: CandidateReport['grade'];
    licensed: Claim[];
    withheld: WithheldClaim[];
    /** For "is it worth running more", "how small a difference could this see", "what did it cost". */
    design: {
        comparableScenarios: number;
        repeats: number;
        mdePct: number | null;
        resolution: {
            nStar: number | null;
            q: number | null;
        };
        alpha: number;
        floor: CandidateReport['floor'];
    };
}
export interface RunClaims {
    schema: 'dsh-eval-claims/1';
    runId: string;
    baseline: string;
    trials: number;
    usd: number;
    candidates: CandidateClaims[];
}
export declare function claimsOf(report: Report): RunClaims;
