/**
 * The production driver: one dsh SDK runtime process per scenario run, driven
 * over stdio JSON-RPC by `@deepseek-ai/dsh-sdk-client`. The subprocess boots
 * the arm's profile with the arm's overlays under the isolated eval home.
 */
import type { DriverFactory } from './runner.js';
interface HarnessNotificationLike {
    method: string;
    params: Record<string, unknown>;
}
interface HarnessLike {
    session(id?: string): {
        id: string;
        run(input: string, options?: {
            onNotification?: (n: HarnessNotificationLike) => void;
        }): Promise<{
            sessionId: string;
            events: unknown[];
        }>;
    };
    close(): Promise<void>;
}
interface HarnessCtor {
    new (options: Record<string, unknown>): HarnessLike;
}
export interface SdkDriverOptions {
    /** Explicit dsh CLI module for the SDK client (default: the linked same-version @deepseek-ai/dsh). */
    dshBin?: string;
    initializeTimeoutMs?: number;
    /** Test seam: the harness constructor to use instead of loading @deepseek-ai/dsh-sdk-client. */
    harness?: HarnessCtor;
}
export type { HarnessCtor, HarnessLike, HarnessNotificationLike };
export declare function sdkDriverFactory(options?: SdkDriverOptions): DriverFactory;
