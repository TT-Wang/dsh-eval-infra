import type { Driver, DriverTurnResult } from './runner.js';
export interface RpcLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    /** Workspace cwd as the runtime sees it (inside a container this is the mount point). */
    runtimeCwd: string;
    provider: string;
    model: string;
    effort?: string;
    maxTokens?: number;
    initializeTimeoutMs?: number;
    /** Called with stderr lines (kept short) for diagnostics. */
    onStderr?: (line: string) => void;
    /** Debug hook: every notification method and, for session events, the event type. */
    onFrame?: (summary: string) => void;
}
export declare class RpcDriver implements Driver {
    private readonly launch;
    private child;
    private nextId;
    private readonly pending;
    private readonly listeners;
    private buffer;
    private stderrTail;
    private initialized;
    private readonly sessionId;
    private exited;
    private turn;
    constructor(launch: RpcLaunch);
    private start;
    private onData;
    private onFrame;
    private request;
    runTurn(prompt: string, options: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<DriverTurnResult>;
    close(): Promise<void>;
}
