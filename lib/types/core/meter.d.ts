import type { Usage } from './types.js';
export interface MeterEntry {
    seq: number;
    at: string;
    method: string;
    path: string;
    model: string | null;
    stream: boolean;
    status: number | null;
    durationMs: number;
    usage: Usage | null;
    /** Model id and system fingerprint the provider put in the response (served-model check). */
    responseModel: string | null;
    fingerprint: string | null;
    /** SHA-256 of the request body (the meter never stores the body or headers). */
    requestSha: string;
    /** Fault injected by the meter instead of forwarding (null when forwarded). */
    fault: '429' | 'stall' | null;
    /** Hash chain: sha256(prev + canonical entry without `hash`). */
    prev: string;
    hash: string;
}
export interface MeterTotals {
    requests: number;
    forwarded: number;
    faults: number;
    hit: number;
    miss: number;
    output: number;
    reasoning: number;
    /** Distinct model ids and fingerprints seen in responses. */
    servedModels: string[];
    fingerprints: string[];
}
export interface MeterOptions {
    /** Upstream base URL, e.g. https://api.deepseek.com */
    upstream: string;
    /** Append entries here (JSONL) in addition to keeping them in memory. */
    ledgerFile?: string;
    /** Listen on all interfaces (container mode) instead of loopback. */
    exposed?: boolean;
    /** Fault injection: share of requests answered with a fault, seeded. */
    faults?: {
        rate: number;
        seed?: number;
        kinds?: Array<'429' | 'stall'>;
        stallMs?: number;
    };
}
export interface Meter {
    baseURL: string;
    port: number;
    entries(): MeterEntry[];
    totals(): MeterTotals;
    close(): Promise<void>;
}
export declare function meterTotals(entries: MeterEntry[]): MeterTotals;
/** Verify a meter ledger's hash chain; returns the first broken sequence number or null. */
export declare function verifyChain(entries: MeterEntry[]): number | null;
export interface ParsedResponse {
    usage: Usage | null;
    model: string | null;
    fingerprint: string | null;
}
/** Pull usage, the served model id and the system fingerprint out of a streamed (SSE) or plain JSON response body. */
export declare function parseResponseBody(body: string, stream: boolean): ParsedResponse;
export declare function usageFromBody(body: string, stream: boolean): Usage | null;
export declare function startMeter(options: MeterOptions): Promise<Meter>;
