import type { Scenario } from './types.js';
import type { ChatCall } from './judge.js';
export declare const PARAPHRASE_SYSTEM: string;
export interface VariantResult {
    variants: string[][];
    usd: number;
    rejected: string[];
}
export declare function generateVariants(scenario: Scenario, n: number, chat: ChatCall, seed?: number): Promise<VariantResult>;
export declare function writeVariants(scenario: Scenario, variants: string[][]): string;
