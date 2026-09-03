/**
 * The production driver: one dsh SDK runtime process per scenario run, driven
 * over stdio JSON-RPC by `@deepseek-ai/dsh-sdk-client`. The subprocess boots
 * the arm's profile with the arm's overlays under the isolated eval home.
 */
import type { DriverFactory } from './runner.js';
export interface SdkDriverOptions {
    /** Explicit dsh CLI module for the SDK client (default: the linked same-version @deepseek-ai/dsh). */
    dshBin?: string;
    initializeTimeoutMs?: number;
}
export declare function sdkDriverFactory(options?: SdkDriverOptions): DriverFactory;
