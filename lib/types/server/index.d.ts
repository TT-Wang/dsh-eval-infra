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
