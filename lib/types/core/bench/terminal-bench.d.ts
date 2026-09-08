import { type BenchAdapter } from './types.js';
/** Minimal TOML: scalars, arrays of scalars, inline tables skipped, [section] headers. Enough for a task.toml. */
export declare function parseToml(text: string): Record<string, Record<string, unknown>>;
export declare const terminalBench: BenchAdapter;
