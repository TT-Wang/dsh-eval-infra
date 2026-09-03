/**
 * DeepSeek list prices and the peak / off-peak calendar.
 * Source: https://api-docs.deepseek.com/quick_start/pricing (checked 2026-09-04).
 * Prices are USD per 1M tokens. Off-peak is exactly half of peak.
 * Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Everything else is off-peak.
 */
import type { TimeBand, Usage } from './types.js';
export interface ModelPrice {
    hit: {
        peak: number;
        offpeak: number;
    };
    miss: {
        peak: number;
        offpeak: number;
    };
    output: {
        peak: number;
        offpeak: number;
    };
}
export interface PriceTable {
    asOf: string;
    currency: 'USD';
    models: Record<string, ModelPrice>;
    /** Peak windows in UTC: weekday numbers (1 = Monday … 5 = Friday) and [startHour, endHour) pairs. */
    peak: {
        weekdays: number[];
        hours: Array<[number, number]>;
    };
}
export declare const DEEPSEEK_PRICES: PriceTable;
/** Which price band a request at `timeMs` (unix ms) falls in. */
export declare function bandAt(timeMs: number, table?: PriceTable): TimeBand;
/** Price of one call's usage in USD at the given band; unknown models price at 0 and are reported by the caller. */
export declare function priceUsage(model: string, band: TimeBand, u: Usage, table?: PriceTable): number;
export declare function knownModel(model: string, table?: PriceTable): boolean;
