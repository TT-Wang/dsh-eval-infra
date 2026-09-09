import { type Project } from '../core/project.js';
interface Tool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
    run(project: Project, args: Record<string, unknown>): Promise<unknown>;
}
export declare const TOOLS: Tool[];
/** Serve MCP over the given streams until the input ends. Resolves when the client disconnects. */
export declare function serveMcp(options?: {
    projectRoot?: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
}): Promise<void>;
export {};
