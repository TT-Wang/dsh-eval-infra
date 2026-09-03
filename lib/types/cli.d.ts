#!/usr/bin/env node
interface Args {
    command: string;
    positional: string[];
    flags: Record<string, string | boolean | string[]>;
}
export declare function parseArgs(argv: string[]): Args;
export declare function main(argv?: string[]): Promise<number>;
export {};
