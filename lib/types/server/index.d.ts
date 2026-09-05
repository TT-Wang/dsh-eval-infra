/**
 * HTTP API + static UI. `createEvalApp` returns a request handler that both
 * the standalone `dsh-eval ui` server and the in-dsh plugin route mount; the
 * handler is prefix-agnostic so it can live at `/` or under `/eval`.
 */
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type RunRequest } from '../core/orchestrate.js';
import { type Project } from '../core/project.js';
export interface EvalAppOptions {
    project: Project;
    /** Directory holding the built UI (index.html, app.js, app.css). */
    uiDir?: string;
}
export declare class EvalApp {
    readonly project: Project;
    readonly uiDir: string;
    private readonly active;
    constructor(options: EvalAppOptions);
    /** Cancel a running run; returns false when it is not active in this process. */
    cancel(id: string): boolean;
    start(request: RunRequest): Promise<{
        id: string;
    }>;
    /** Handle one request. `prefix` is the mount path without trailing slash ('' at root). Returns false when not ours. */
    handle(req: IncomingMessage, res: ServerResponse, prefix?: string): Promise<boolean>;
    private serveStatic;
    private api;
}
export interface HistoryCell {
    runs: number;
    passes: number;
    errors: number;
    usdMean: number;
    stepsMean: number;
}
export interface HistoryPoint {
    runId: string;
    usd: number;
    ok: boolean;
}
export interface History {
    arms: string[];
    scenarios: Array<{
        name: string;
        cells: Record<string, HistoryCell>;
        runIds: string[];
        points: Record<string, HistoryPoint[]>;
        signal: {
            snr: number | null;
            withinCv: number | null;
            passSpread: number | null;
            trials: number;
        };
    }>;
    runs: Array<{
        id: string;
        createdAt: string;
        label?: string;
        arms: string[];
    }>;
    /** Scenarios that behave the same way for every arm across the archive: worth retiring or fixing rather than re-running. */
    chronic: {
        flaky: string[];
        failing: string[];
        saturated: string[];
    };
}
/** Cross-run view: every scenario × arm over every run in the archive, so chronic failures and flakes stand out. */
export declare function buildHistory(runsRoot: string): History;
export declare function createEvalApp(options: EvalAppOptions): EvalApp;
export interface ServeOptions {
    project?: Project;
    port?: number;
    host?: string;
    uiDir?: string;
}
export declare function startServer(options?: ServeOptions): Promise<{
    server: Server;
    url: string;
    app: EvalApp;
}>;
