import type { RunLedger, Usage, Verdict } from './types.js';
import { type PriceTable } from './pricing.js';
/** The subset of a dsh session event we read. */
export interface EventLike {
    type: string;
    seq?: number;
    time?: number;
    data?: unknown;
}
export interface LedgerInput {
    runId: string;
    scenario: string;
    arm: string;
    rep: number;
    order: number;
    startedAt: Date;
    endedAt: Date;
    provider: string;
    model: string;
    events: EventLike[];
    /** Wall time of each turn, by turn index (1-based). */
    turnWall: Map<number, number>;
    verdict: Verdict | null;
    error?: string;
    sessionId: string | null;
    workdir: string;
    eventsFile: string;
    traceFile: string;
    /** Number of runtime sessions the run used (>1 when the scenario declares session breaks). */
    sessions?: number;
    prices?: PriceTable;
}
export interface TraceRow {
    turn: number;
    step: number;
    time: number;
    calls: Array<{
        name: string;
        arguments: string;
    }>;
    text: string;
    reasoning: string;
    usage: Usage | null;
    usd: number;
    /** What the model saw back for each call this step (truncated to `observationMaxChars`). */
    observations: Array<{
        callId: string;
        chars: number;
        isError: boolean;
        text: string;
    }>;
}
export interface BehaviourMetrics {
    /** Tool results flagged as errors by the tool or the pipeline. */
    toolErrors: number;
    /** Consecutive identical tool calls (same name and arguments) — a loop signature. */
    repeatedCalls: number;
    /** Steps with neither a tool call nor final text (empty or reasoning-only turns). */
    noActionSteps: number;
    /** Total characters of tool results the model was shown. */
    observationChars: number;
    /** compaction/start events observed. */
    compactions: number;
}
export declare function buildLedger(input: LedgerInput): {
    ledger: RunLedger;
    trace: TraceRow[];
};
